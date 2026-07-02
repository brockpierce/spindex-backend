const express = require("express");
const bcrypt = require("bcrypt");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// How many rounds bcrypt uses to hash passwords. Higher = slower but more
// secure against brute-force guessing. 12 is a solid, commonly used value.
const BCRYPT_ROUNDS = 12;

// Strips fields we never want to send back to the browser, like the
// password hash. Always pass user objects through this before res.json.
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
// Creates a new account and immediately logs them in (sets the session).
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
    // Session points at a user that no longer exists -- clear it.
    req.session.destroy(() => {});
    return res.json({ user: null });
  }
  res.json({ user: publicUser(user) });
});

module.exports = router;
