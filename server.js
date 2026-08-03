require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");

const authRoutes = require("./routes/auth");
const albumRoutes = require("./routes/albums");
const reviewRoutes = require("./routes/reviews");
const listenStatusRoutes = require("./routes/listenStatus");
const favoriteRoutes = require("./routes/favorites");
const listRoutes = require("./routes/lists");
const followRoutes = require("./routes/follows");
const feedRoutes = require("./routes/feed");
const userRoutes = require("./routes/users");
const guestbookRoutes = require("./routes/guestbook");

const app = express();
const PORT = process.env.PORT || 3001;

const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  "https://spindex-frontend.vercel.app",
  "https://www.mynoteblock.com",
  "https://mynoteblock.com",
  "http://localhost:5173",
].filter(Boolean);

// Security headers. This API serves JSON and cover images (no HTML), so CSP is
// left off; crossOriginResourcePolicy is set to cross-origin so the Vercel
// frontend can load cover images served from this backend.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

// Gzip responses — the feed and album payloads are large JSON, so this cuts
// response bandwidth ~60-80%. Cheapest high-traffic win there is.
app.use(compression());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));
// Text posts can carry up to 3 compressed images, so that ONE route gets a
// larger body allowance. Registered before the global 1mb parser — express.json
// skips a request whose body another parser already read, so /api/posts uses
// 3mb and every other route stays at 1mb.
app.use("/api/posts", express.json({ limit: "3mb" }));
// 1mb is safe now that every image upload is compressed client-side (avatars
// <=200KB, covers ~a few hundred KB) and capped server-side. It also acts as the
// backstop for any client that tries to bypass those caps.
app.use(express.json({ limit: "1mb" }));

// Trust Render's proxy so rate limiting sees real client IPs
app.set("trust proxy", 1);

// Strict limiter on auth (brute-force / spam-signup protection)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 20,                  // 20 auth attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  // Only throttle POSTs. Login, signup, forgot- and reset-password are the
  // brute-force targets. GET /api/auth/me is the session check that runs on
  // EVERY page load — limiting it to 20 per 15 minutes was logging users out
  // after ~20 page loads. It stays covered by apiLimiter below.
  skip: (req) => req.method === "GET",
  message: { error: "Too many attempts. Please try again in a few minutes." },
});

// General API limiter (abuse safety net)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // 500 was roughly a dozen page loads back when each one fired 40+ requests.
  // Album fetching is batched now, but 500 is still far too tight for an
  // active session. This remains an abuse ceiling, not a usage cap.
  max: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down and try again shortly." },
});
app.use("/api/", apiLimiter);

app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/albums", albumRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/listen-status", listenStatusRoutes);
app.use("/api/favorites", favoriteRoutes);
app.use("/api/lists", listRoutes);
app.use("/api/follows", followRoutes);
app.use("/api/feed", feedRoutes);
app.use("/api/users", userRoutes);
app.use("/api/guestbook", guestbookRoutes);
app.use("/api/song-reviews", require("./routes/songReviews"));
app.use("/api/tags", require("./routes/tags"));
app.use("/api/interactions", require("./routes/interactions"));
app.use("/api/mixes", require("./routes/mixes"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api/posts", require("./routes/posts"));
app.use("/api/mix-shares", require("./routes/mixShares"));
app.use("/api/messages", require("./routes/messages"));
app.use("/api/news", require("./routes/news"));
app.use("/api/qotd", require("./routes/qotd"));
app.use("/api/activity", require("./routes/activity"));

app.get("/api/health", (req, res) => res.json({ ok: true }));

// Catch all errors including unhandled async errors -- returns JSON
// instead of crashing the process
app.use((err, req, res, next) => {
  console.error("Route error:", err.message);
  // Body-parser rejects an over-limit request with a 413 — surface that clearly
  // instead of masking it as a generic 500.
  if (err.type === "entity.too.large" || err.status === 413 || err.statusCode === 413) {
    return res.status(413).json({ error: "That upload is too large. Please use a smaller image." });
  }
  res.status(500).json({ error: "Something went wrong on our end." });
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log("Port in use, waiting for restart");
    process.exit(0);
  }
  console.error("Uncaught exception:", err);
  // Don't exit -- log and continue so the server stays up
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
