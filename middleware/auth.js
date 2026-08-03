const jwt = require("jsonwebtoken");

// In production (Render sets RENDER=true) JWT_SECRET MUST be set explicitly —
// refuse to start rather than silently sign sessions with a public default that
// would let anyone forge a token for any user. Locally we keep a dev-only
// fallback so `npm run dev` works without setup.
const IS_PROD = process.env.NODE_ENV === "production" || !!process.env.RENDER;
const JWT_SECRET = process.env.JWT_SECRET || (IS_PROD ? null : "dev-jwt-secret-change-in-production");
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET must be set in production — refusing to start with a default secret.");
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "You need to be logged in to do that." });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Session expired — please log in again." });
  }
}

// Like requireAuth but never rejects: sets req.userId when a valid token is
// present, leaves it undefined otherwise. For routes that are public but need
// to know the caller — e.g. to let an owner view their own private resource
// while hiding it from everyone else.
function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    try { req.userId = jwt.verify(header.slice(7), JWT_SECRET).userId; } catch (_) {}
  }
  next();
}

module.exports = { requireAuth, optionalAuth, JWT_SECRET };
