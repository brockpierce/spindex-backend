const express = require("express");
const bcrypt = require("bcrypt");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const BCRYPT_ROUNDS = 12;

// The founder account that every new user automatically follows and
// cannot unfollow -- the MySpace Tom pattern. Change this to your
// actual Spindex username once you've created your account.
const FOUNDER_USERNAME = "brockpierce";

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
  };
}

// POST /api/auth/signup
router.post("/signup", async (req, res) => {
  const { email, password, username, displayName } = req.body;

  if (!email || !password || !username || !displayName) {
    return res.status(400).json({ error: "Email, password, username, and display name are all required." });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password needs to be at least 8 characters." });
  }

  const existingEmail = await prisma.user.findUnique({ where: { email } });
  if (existingEmail) {
    return res.status(409).json({ error: "An account with that email already exists." });
  }
  const existingUsername = await prisma.user.findUnique({ where: { username } });
  if (existingUsername) {
    return res.status(409).json({ error: "That username is already taken." });
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const user = await prisma.user.create({
    data: { email, passwordHash, username, displayName },
  });

  // Auto-follow the founder account. We do this silently -- if the
  // founder account doesn't exist yet (e.g. you're signing up for the
  // first time as the founder), we just skip it rather than erroring.
  try {
    const founder = await prisma.user.findUnique({ where: { username: FOUNDER_USERNAME } });
    if (founder && founder.id !== user.id) {
      await prisma.follow.upsert({
        where: { followerId_followedId: { followerId: user.id, followedId: founder.id } },
        update: {},
        create: { followerId: user.id, followedId: founder.id, locked: true },
      });
    }
  } catch (err) {
    // Don't fail signup if the auto-follow errors -- just log it
    console.error("Auto-follow founder failed:", err.message);
  }

  req.session.userId = user.id;
  res.status(201).json({ user: publicUser(user) });
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  // Intentionally vague error message for both "no such email" and "wrong
  // password" -- being specific here would let an attacker check which
  // emails have accounts on the site.
  if (!user) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }

  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
});

// POST /api/auth/logout
router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// GET /api/auth/me
// Lets the frontend check "is anyone logged in, and who" on page load.
router.get("/me", async (req, res) => {
  if (!req.session.userId) {
    return res.json({ user: null });
  }
  const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
  if (!user) {
    req.session.destroy(() => {});
    return res.json({ user: null });
  }
  res.json({ user: publicUser(user) });
});

// PUT /api/auth/profile
// Saves display name, bio, and avatar (stored as base64 data URL).
// Username and email changes are not supported here -- those need
// extra validation (uniqueness checks, re-auth) and can be added later.
router.put("/profile", requireAuth, async (req, res) => {
  const { displayName, bio, avatarUrl } = req.body;
  const data = {};
  if (displayName !== undefined) data.displayName = displayName.trim().slice(0, 60);
  if (bio !== undefined) data.bio = bio.trim().slice(0, 300);
  if (avatarUrl !== undefined) data.avatarUrl = avatarUrl; // base64 data URL or null
  const user = await prisma.user.update({ where: { id: req.session.userId }, data });
  res.json({ user: publicUser(user) });
});

module.exports = router;
