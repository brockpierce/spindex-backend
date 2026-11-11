const jwt = require("jsonwebtoken");
const prisma = require("../lib/prisma");

// In production (Render sets RENDER=true) JWT_SECRET MUST be set explicitly —
// refuse to start rather than silently sign sessions with a public default that
// would let anyone forge a token for any user. Locally we keep a dev-only
// fallback so `npm run dev` works without setup.
const IS_PROD = process.env.NODE_ENV === "production" || !!process.env.RENDER;
const JWT_SECRET = process.env.JWT_SECRET || (IS_PROD ? null : "dev-jwt-secret-change-in-production");
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET must be set in production — refusing to start with a default secret.");
}

// Resolve an "Authorization: Bearer <jwt>" header to a user id, or null. A
// valid signature isn't enough: the account must still exist (deleted and
// banned users are removed), have a verified email, and the token must carry
// the account's current tokenVersion -- a password reset bumps it, ending every
// session issued before the reset. Tokens from before tokenVersion existed have
// no `tv` and count as version 0, so existing sessions stay valid.
async function userIdFromHeader(header) {
  if (!header || !header.startsWith("Bearer ")) return null;
  let payload;
  try {
    payload = jwt.verify(header.slice(7), JWT_SECRET);
  } catch (_) {
    return null;
  }
  const user = await prisma.user.findUnique({
    where: { id: String(payload.userId) },
    select: { emailVerified: true, tokenVersion: true },
  });
  if (!user || !user.emailVerified || (payload.tv || 0) !== user.tokenVersion) return null;
  return payload.userId;
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "You need to be logged in to do that." });
  }
  let userId;
  try {
    userId = await userIdFromHeader(header);
  } catch (err) {
    return next(err);
  }
  if (!userId) return res.status(401).json({ error: "Session expired — please log in again." });
  req.userId = userId;
  next();
}

// Like requireAuth but never rejects: sets req.userId when a valid token is
// present, leaves it undefined otherwise. For routes that are public but need
// to know the caller — e.g. to let an owner view their own private resource
// while hiding it from everyone else.
async function optionalAuth(req, res, next) {
  let userId;
  try {
    userId = await userIdFromHeader(req.headers.authorization);
  } catch (err) {
    return next(err);
  }
  if (userId) req.userId = userId;
  next();
}

module.exports = { requireAuth, optionalAuth, userIdFromHeader, JWT_SECRET };
