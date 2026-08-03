const express = require("express");
const prisma = require("../lib/prisma");
const jwt = require("jsonwebtoken");
const { JWT_SECRET, requireAuth, optionalAuth } = require("../middleware/auth");
const { validateImageDataUrl } = require("../lib/imageValidation");
const { isBlockedBetween } = require("../lib/blocks");

const router = express.Router();

const PROFILE_DRAWING_MAX_BYTES = 800 * 1024; // canvas doodle; larger than an avatar

// pageBackground/accentColor are rendered into inline CSS on every visitor's
// view of a profile. Users pick them from presets / a colour input, but the
// value is otherwise trusted — so a crafted request could inject e.g.
// `url(https://evil/x)` to load an external resource on every viewer (IP /
// tracking leak) or otherwise abuse CSS. Allow only colour + gradient syntax;
// reject url()/imports/markup and anything implausibly long.
function cssColorOrGradientOk(v, maxLen) {
  if (typeof v !== "string") return false;
  if (v.length > maxLen) return false;
  if (/url\s*\(|image-set|expression|javascript:|@import|[<>{};]/i.test(v)) return false;
  return true;
}

// Trim a free-text profile field to a sane max (defends against multi-MB blobs
// stored via a direct API call — the UI never sends anything this long).
const cap = (v, n) => (v == null || v === "" ? null : String(v).slice(0, n));

// opts.light omits the still-unbounded base64 fields — pageBackground and
// profileDrawing — from list responses, because serialising them for a list
// blocks the event loop long enough to take the whole server unresponsive.
// avatarUrl is NO LONGER gated: avatars are compressed on upload, capped at
// 200 KB server-side, and existing rows were migrated down, so they're safe in
// lists again. Lists still pass light: true to keep the two big blobs out.
function publicUser(user, followedIds = new Set(), opts = {}) {
  const light = opts.light === true;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    profileTheme: user.profileTheme || null,
    accentColor: user.accentColor || null,
    pageBackground: light ? null : (user.pageBackground || null),
    profileDrawing: light ? null : (user.profileDrawing || null),
    age: user.age || null,
    town: user.town || null,
    country: user.country || null,
    mood: user.mood || null,
    interests: user.interests || null,
    isFollowing: followedIds.has(user.id),
    followerCount: user._count?.followers || 0,
    followingCount: user._count?.following || 0,
  };
}

async function getFollowedIds(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return new Set();
  try {
    const { userId } = jwt.verify(header.slice(7), JWT_SECRET);
    const follows = await prisma.follow.findMany({ where: { followerId: userId } });
    return new Set(follows.map((f) => f.followedId));
  } catch { return new Set(); }
}

router.get("/", async (req, res, next) => {
  try {
    const search = (req.query.search || "").trim();
    if (!search) return res.json({ users: [] });
    const users = await prisma.user.findMany({
      where: { OR: [{ username: { contains: search } }, { displayName: { contains: search } }] },
      take: 20,
      include: { _count: { select: { followers: true, following: true } } },
    });
    const followedIds = await getFollowedIds(req);
    res.json({ users: users.map((u) => publicUser(u, followedIds, { light: true })) });
  } catch (e) { next(e); }
});

// PUT /api/users/profile — update the logged-in user's profile + theme + info fields
router.put("/profile", requireAuth, async (req, res, next) => {
  try {
    const { profileTheme, accentColor, pageBackground, profileDrawing, age, town, country, mood, interests, bio, displayName } = req.body;
    const data = {};
    if (profileTheme !== undefined) data.profileTheme = cap(profileTheme, 40);
    if (accentColor !== undefined) {
      if (accentColor && !cssColorOrGradientOk(accentColor, 64)) {
        return res.status(400).json({ error: "That accent colour isn't allowed." });
      }
      data.accentColor = accentColor || null;
    }
    if (pageBackground !== undefined) {
      if (pageBackground && !cssColorOrGradientOk(pageBackground, 600)) {
        return res.status(400).json({ error: "That page background isn't allowed." });
      }
      data.pageBackground = pageBackground || null;
    }
    if (profileDrawing !== undefined) {
      if (profileDrawing) {
        // Only validate a *changed* drawing, so a client re-sending an existing
        // (pre-cap) drawing on an unrelated save isn't rejected.
        const current = await prisma.user.findUnique({ where: { id: req.userId }, select: { profileDrawing: true } });
        if (!current || current.profileDrawing !== profileDrawing) {
          const err = validateImageDataUrl(profileDrawing, PROFILE_DRAWING_MAX_BYTES);
          if (err) return res.status(400).json({ error: err });
        }
      }
      data.profileDrawing = profileDrawing || null;
    }
    if (age !== undefined) data.age = cap(age, 20);
    if (town !== undefined) data.town = cap(town, 100);
    if (country !== undefined) data.country = cap(country, 100);
    if (mood !== undefined) data.mood = cap(mood, 100);
    if (interests !== undefined) data.interests = cap(interests, 500);
    if (bio !== undefined) data.bio = cap(bio, 500);
    if (displayName !== undefined && displayName.trim()) data.displayName = displayName.trim().slice(0, 60);
    const user = await prisma.user.update({ where: { id: req.userId }, data });
    res.json({ user: publicUser(user) });
  } catch (e) { next(e); }
});

router.get("/:username", optionalAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { username: req.params.username },
      include: { _count: { select: { followers: true, following: true } } },
    });
    if (!user) return res.status(404).json({ error: "User not found." });
    const followedIds = await getFollowedIds(req);
    // Profile stays reachable (so a blocked user can be found to unblock), but
    // the flag lets the client hide their content and offer unblock instead.
    const blocked = req.userId ? await isBlockedBetween(req.userId, user.id) : false;
    res.json({ user: { ...publicUser(user, followedIds), blocked } });
  } catch (e) { next(e); }
});

module.exports = router;
