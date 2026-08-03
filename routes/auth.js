const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = rateLimit;
const prisma = require("../lib/prisma");
const { requireAuth, JWT_SECRET } = require("../middleware/auth");
const { validateImageDataUrl } = require("../lib/imageValidation");
const { deleteUserCompletely } = require("../lib/deleteUser");
const { Resend } = require("resend");

// Key code limiters on the target email; fall back to an IPv6-safe IP key when
// no email is present (ipKeyGenerator normalises IPv6 so it can't be bypassed
// by rotating within a /64).
const emailKey = (req) => (req.body && req.body.email ? String(req.body.email).toLowerCase() : ipKeyGenerator(req.ip));

// Per-EMAIL limit on code guesses. The global auth limiter is per-IP, so an
// attacker rotating IPs could otherwise brute-force a 6-digit code within its
// lifetime. Keying on the target email caps guesses regardless of source IP.
const codeGuessLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: emailKey,
  message: { error: "Too many attempts. Request a new code and try again in a few minutes." },
});

// Per-EMAIL limit on code SENDS — stops using us to spam-bomb someone's inbox
// with reset/verification emails.
const codeSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: emailKey,
  message: { error: "Too many requests for that email. Please wait a few minutes." },
});

const AVATAR_MAX_BYTES = 200 * 1024; // 200 KB — the client compresses to tens of KB

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

const MIN_AGE = 16;
// Flip to true once the signup form actually sends a birthday. Until then a
// missing birthday is allowed, so older clients keep working.
const REQUIRE_BIRTHDAY = false;

// Whole years old TODAY from a "YYYY-MM-DD" string. Returns null if the
// string is malformed or not a real calendar date. Computed from the date
// rather than stored, so it can never go stale.
function ageFromBirthday(b) {
  const m = String(b || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - y;
  const monthNow = now.getUTCMonth() + 1;
  if (monthNow < mo || (monthNow === mo && now.getUTCDate() < d)) age -= 1;
  return age;
}

// POST /api/auth/signup
router.post("/signup", async (req, res) => {
  const { email, password, username, displayName, birthday } = req.body;
  if (!email || !password || !username || !displayName) {
    return res.status(400).json({ error: "Email, password, username, and display name are all required." });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password needs to be at least 8 characters." });
  }
  if (!birthday && REQUIRE_BIRTHDAY) {
    return res.status(400).json({ error: "Date of birth is required." });
  }
  if (birthday) {
    const age = ageFromBirthday(birthday);
    if (age === null || age > 120) {
      return res.status(400).json({ error: "Please enter a valid date of birth." });
    }
    if (age < MIN_AGE) {
      return res.status(400).json({ error: "You must be at least 16 to use noteblock." });
    }
  }
  const existingEmail = await prisma.user.findUnique({ where: { email } });
  if (existingEmail) return res.status(409).json({ error: "An account with that email already exists." });
  const normalizedUsername = username.toLowerCase().trim();
  // Letters, numbers and underscore only. Anything else — @, /, ., spaces,
  // emoji — breaks profile URLs, which interpolate the username unescaped.
  if (!/^[a-z0-9_]{2,20}$/.test(normalizedUsername)) {
    return res.status(400).json({ error: "Usernames can only use letters, numbers and underscores, and must be 2-20 characters." });
  }
  const existingUsername = await prisma.user.findUnique({ where: { username: normalizedUsername } });
  if (existingUsername) return res.status(409).json({ error: "That username is already taken." });

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  // The existing-username check above and this insert are not atomic — two
  // near-simultaneous signups can both pass it. Without this catch the P2002
  // becomes an unhandled rejection and kills the process.
  let user;
  try {
    user = await prisma.user.create({ data: { email, passwordHash, username: normalizedUsername, displayName, birthday: birthday || null } });
  } catch (err) {
    if (err && err.code === "P2002") {
      const field = (err.meta && err.meta.target && err.meta.target[0]) || "";
      return res.status(409).json({
        error: field === "email"
          ? "An account with that email already exists."
          : "That username is already taken.",
      });
    }
    console.error("signup create failed:", err.message);
    return res.status(500).json({ error: "Could not create the account. Please try again." });
  }

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

  res.status(201).json({ user: publicUser(user), token: makeToken(user.id), needsVerification: true });
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: "Incorrect email or password." });
  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) return res.status(401).json({ error: "Incorrect email or password." });
  if (!user.emailVerified) {
    try { await sendVerificationCode(user); } catch (e) { console.error("resend on login failed:", e.message); }
    return res.status(403).json({ needsVerification: true, email: user.email });
  }
  res.json({ user: publicUser(user), token: makeToken(user.id) });
});

// POST /api/auth/logout -- client just deletes the token, nothing to do server-side
router.post("/logout", (req, res) => res.json({ ok: true }));

// POST /api/auth/verify-email  { email, code }
router.post("/verify-email", codeGuessLimiter, async (req, res) => {
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
router.post("/resend-verification", codeSendLimiter, async (req, res) => {
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
router.post("/forgot-password", codeSendLimiter, async (req, res) => {
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
router.post("/reset-password", codeGuessLimiter, async (req, res) => {
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
  if (avatarUrl !== undefined) {
    if (avatarUrl === null || avatarUrl === "") {
      data.avatarUrl = null;
    } else {
      // Only validate a *new* avatar. An unchanged value — e.g. an older cached
      // client re-sending the account's existing pre-compression avatar on an
      // unrelated save — is left alone, so the size limit can't break existing
      // accounts before the migration runs.
      const current = await prisma.user.findUnique({ where: { id: req.userId }, select: { avatarUrl: true } });
      if (!current || current.avatarUrl !== avatarUrl) {
        const err = validateImageDataUrl(avatarUrl, AVATAR_MAX_BYTES);
        if (err) return res.status(400).json({ error: err });
      }
      data.avatarUrl = avatarUrl;
    }
  }

  // Handle username change with uniqueness check
  if (username !== undefined) {
    const normalized = username.toLowerCase().trim();
    // Same rule as signup: letters/numbers/underscore, 2-20 chars. The change
    // route previously allowed arbitrary characters up to 30, which let a user
    // set an unsafe username (breaks URL interpolation) or a homoglyph
    // impersonation of another account.
    if (!/^[a-z0-9_]{2,20}$/.test(normalized)) {
      return res.status(400).json({ error: "Usernames can only use letters, numbers and underscores, and must be 2-20 characters." });
    }
    // Reserved names can't be claimed via a rename.
    const RESERVED = new Set(["admin", "administrator", "root", "support", "staff", "noteblock", "mod", "moderator", "system"]);
    if (RESERVED.has(normalized)) {
      return res.status(409).json({ error: "That username is reserved." });
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

// DELETE /api/auth/account — permanently delete the logged-in user and ALL of
// their data. Irreversible. Required by App Store guideline 5.1.1(v): an app
// that lets you create an account must let you delete it in-app.
router.delete("/account", requireAuth, async (req, res) => {
  try {
    await deleteUserCompletely(req.userId);
    return res.json({ ok: true });
  } catch (err) {
    if (err.code === "USER_NOT_FOUND") return res.status(404).json({ error: "Account not found." });
    console.error("account deletion failed:", err.message);
    return res.status(500).json({ error: "Could not delete the account. Please try again." });
  }
});

module.exports = router;
