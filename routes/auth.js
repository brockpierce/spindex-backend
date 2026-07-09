const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const prisma = require("../lib/prisma");
const { requireAuth, JWT_SECRET } = require("../middleware/auth");

const router = express.Router();
const BCRYPT_ROUNDS = 12;
const FOUNDER_USERNAME = "brock";

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
  };
}

function makeToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "30d" });
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
  if (existingEmail) return res.status(409).json({ error: "An account with that email already exists." });
  const normalizedUsername = username.toLowerCase().trim();
  const existingUsername = await prisma.user.findUnique({ where: { username: normalizedUsername } });
  if (existingUsername) return res.status(409).json({ error: "That username is already taken." });

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await prisma.user.create({ data: { email, passwordHash, username: normalizedUsername, displayName } });

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
    console.error("Auto-follow founder failed:", err.message);
  }

  res.status(201).json({ user: publicUser(user), token: makeToken(user.id) });
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: "Incorrect email or password." });
  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) return res.status(401).json({ error: "Incorrect email or password." });
  res.json({ user: publicUser(user), token: makeToken(user.id) });
});

// POST /api/auth/logout -- client just deletes the token, nothing to do server-side
router.post("/logout", (req, res) => res.json({ ok: true }));

// GET /api/auth/me
router.get("/me", async (req, res) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return res.json({ user: null });
  try {
    const { userId } = jwt.verify(header.slice(7), JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.json({ user: null });
    res.json({ user: publicUser(user) });
  } catch {
    res.json({ user: null });
  }
});

// PUT /api/auth/profile
router.put("/profile", requireAuth, async (req, res) => {
  const { displayName, username, bio, avatarUrl } = req.body;
  const data = {};
  if (displayName !== undefined) data.displayName = displayName.trim().slice(0, 60);
  if (bio !== undefined) data.bio = bio.trim().slice(0, 30);
  if (avatarUrl !== undefined) data.avatarUrl = avatarUrl;

  // Handle username change with uniqueness check
  if (username !== undefined) {
    const normalized = username.toLowerCase().trim().slice(0, 30);
    if (normalized.length < 1) {
      return res.status(400).json({ error: "Username can't be empty." });
    }
    // Check if someone else already has this username
    const existing = await prisma.user.findUnique({ where: { username: normalized } });
    if (existing && existing.id !== req.userId) {
      return res.status(409).json({ error: "That username is already taken." });
    }
    data.username = normalized;
  }

  const user = await prisma.user.update({ where: { id: req.userId }, data });
  res.json({ user: publicUser(user) });
});

module.exports = router;
