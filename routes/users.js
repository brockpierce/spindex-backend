const express = require("express");
const prisma = require("../lib/prisma");
const jwt = require("jsonwebtoken");
const { JWT_SECRET, requireAuth } = require("../middleware/auth");

const router = express.Router();

function publicUser(user, followedIds = new Set()) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    profileTheme: user.profileTheme || null,
    accentColor: user.accentColor || null,
    pageBackground: user.pageBackground || null,
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
    res.json({ users: users.map((u) => publicUser(u, followedIds)) });
  } catch (e) { next(e); }
});

// PUT /api/users/profile — update the logged-in user's profile + theme + info fields
router.put("/profile", requireAuth, async (req, res, next) => {
  try {
    const { profileTheme, accentColor, pageBackground, age, town, country, mood, interests, bio, displayName } = req.body;
    const data = {};
    if (profileTheme !== undefined) data.profileTheme = profileTheme || null;
    if (accentColor !== undefined) data.accentColor = accentColor || null;
    if (pageBackground !== undefined) data.pageBackground = pageBackground || null;
    if (age !== undefined) data.age = age || null;
    if (town !== undefined) data.town = town || null;
    if (country !== undefined) data.country = country || null;
    if (mood !== undefined) data.mood = mood || null;
    if (interests !== undefined) data.interests = interests || null;
    if (bio !== undefined) data.bio = bio || null;
    if (displayName !== undefined && displayName.trim()) data.displayName = displayName.trim();
    const user = await prisma.user.update({ where: { id: req.userId }, data });
    res.json({ user: publicUser(user) });
  } catch (e) { next(e); }
});

router.get("/:username", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { username: req.params.username },
      include: { _count: { select: { followers: true, following: true } } },
    });
    if (!user) return res.status(404).json({ error: "User not found." });
    const followedIds = await getFollowedIds(req);
    res.json({ user: publicUser(user, followedIds) });
  } catch (e) { next(e); }
});

module.exports = router;
