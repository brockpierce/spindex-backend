const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const prisma = require("../lib/prisma");
const { requireAuth, JWT_SECRET } = require("../middleware/auth");
const { Resend } = require("resend");

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
// Switch RESET_FROM to "noteblock <noreply@mynoteblock.com>" once the domain is verified in Resend.
const RESET_FROM = process.env.RESET_FROM || "noteblock <onboarding@resend.dev>";

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

// Generate a 6-digit code, save it to the user as a verify token (24h expiry), and email it.
async function sendVerificationCode(user) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
  await prisma.user.update({
    where: { id: user.id },
    data: { verifyToken: code, verifyTokenExpiry: expiry },
  });
  if (resend) {
    try {
      await resend.emails.send({
        from: RESET_FROM,
        to: user.email,
        subject: "Verify your noteblock email",
        text: `Welcome to noteblock! Your verification code is ${code}. It expires in 24 hours.`,
        html: `<p>Welcome to noteblock!</p><p>Your verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px;">${code}</p><p>It expires in 24 hours.</p>`,
      });
    } catch (mailErr) {
      console.error("verification email send error:", mailErr.message);
    }
  } else {
    console.warn("RESEND_API_KEY not set — verify code for", user.email, "is", code);
  }
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

  try { await sendVerificationCode(user); } catch (e) { console.error("send verify on signup failed:", e.message); }

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

// POST /api/auth/verify-email  { email, code }
router.post("/verify-email", async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: "Email and code are required." });
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.verifyToken || !user.verifyTokenExpiry) {
      return res.status(400).json({ error: "Invalid or expired code." });
    }
    if (user.verifyToken !== String(code)) {
      return res.status(400).json({ error: "Invalid or expired code." });
    }
    if (new Date(user.verifyTokenExpiry) < new Date()) {
      return res.status(400).json({ error: "This code has expired. Request a new one." });
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true, verifyToken: null, verifyTokenExpiry: null },
    });
    return res.json({ ok: true, verified: true });
  } catch (err) {
    console.error("verify-email error:", err.message);
    return res.status(500).json({ error: "Something went wrong." });
  }
});

// POST /api/auth/resend-verification  { email }
router.post("/resend-verification", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required." });
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && !user.emailVerified) {
      await sendVerificationCode(user);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("resend-verification error:", err.message);
    return res.status(500).json({ error: "Something went wrong." });
  }
});

// POST /api/auth/forgot-password  { email }
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required." });

    const user = await prisma.user.findUnique({ where: { email } });
    // Always respond success (do not reveal whether the email is registered)
    if (user) {
      const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
      const expiry = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
      await prisma.user.update({
        where: { id: user.id },
        data: { resetToken: code, resetTokenExpiry: expiry },
      });

      if (resend) {
        try {
          await resend.emails.send({
            from: RESET_FROM,
            to: email,
            subject: "Your noteblock password reset code",
            text: `Your password reset code is ${code}. It expires in 15 minutes. If you did not request this, you can ignore this email.`,
            html: `<p>Your password reset code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px;">${code}</p><p>It expires in 15 minutes. If you did not request this, you can ignore this email.</p>`,
          });
        } catch (mailErr) {
          console.error("reset email send error:", mailErr.message);
        }
      } else {
        console.warn("RESEND_API_KEY not set — reset code for", email, "is", code);
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("forgot-password error:", err.message);
    return res.status(500).json({ error: "Something went wrong." });
  }
});

// POST /api/auth/reset-password  { email, code, newPassword }
router.post("/reset-password", async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: "Email, code, and new password are all required." });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.resetToken || !user.resetTokenExpiry) {
      return res.status(400).json({ error: "Invalid or expired code." });
    }
    if (user.resetToken !== String(code)) {
      return res.status(400).json({ error: "Invalid or expired code." });
    }
    if (new Date(user.resetTokenExpiry) < new Date()) {
      return res.status(400).json({ error: "This code has expired. Request a new one." });
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, resetToken: null, resetTokenExpiry: null },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("reset-password error:", err.message);
    return res.status(500).json({ error: "Something went wrong." });
  }
});

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
