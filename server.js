require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const albumRoutes = require("./routes/albums");
const reviewRoutes = require("./routes/reviews");
const listenStatusRoutes = require("./routes/listenStatus");
const favoriteRoutes = require("./routes/favorites");
const listRoutes = require("./routes/lists");
const followRoutes = require("./routes/follows");
const feedRoutes = require("./routes/feed");
const userRoutes = require("./routes/users");

const app = express();
const PORT = process.env.PORT || 3001;

const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  "https://spindex-frontend.vercel.app",
  "http://localhost:5173",
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));
app.use(express.json({ limit: "10mb" }));

app.use("/api/auth", authRoutes);
app.use("/api/albums", albumRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/listen-status", listenStatusRoutes);
app.use("/api/favorites", favoriteRoutes);
app.use("/api/lists", listRoutes);
app.use("/api/follows", followRoutes);
app.use("/api/feed", feedRoutes);
app.use("/api/users", userRoutes);
app.use("/api/tags", require("./routes/tags"));
app.use("/api/interactions", require("./routes/interactions"));

app.get("/api/health", (req, res) => res.json({ ok: true }));

// Catch all errors including unhandled async errors -- returns JSON
// instead of crashing the process
app.use((err, req, res, next) => {
  console.error("Route error:", err.message);
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
