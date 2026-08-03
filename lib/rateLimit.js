const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = rateLimit;

// Per-USER action limiter, keyed on req.userId (with an IPv6-safe IP fallback).
// Mount AFTER requireAuth so req.userId is set. The global apiLimiter in
// server.js is a coarse per-IP safety net; these cap individual abusive actions
// (spamming DMs, follow-churn, reaction floods) that a shared office/CGNAT IP
// limit can't catch per-person.
function perUserLimiter({ windowMs = 60 * 1000, max, message } = {}) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.userId || ipKeyGenerator(req.ip),
    message: { error: message || "You're doing that too fast — please slow down." },
  });
}

module.exports = { perUserLimiter };
