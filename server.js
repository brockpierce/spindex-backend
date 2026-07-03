require("dotenv").config();
const express = require("express");
const session = require("express-session");
const cors = require("cors");
const SQLiteStore = require("connect-sqlite3")(session);

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

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" })); // 10mb to handle base64 avatar images

// Determine session DB path -- use persistent disk on Render, local file in dev
const SESSION_DB_DIR = process.env.NODE_ENV === "production" ? "/var/data" : ".";

app.use(
  session({
    store: new SQLiteStore({ db: "sessions.db", dir: SESSION_DB_DIR }),
    secret: process.env.SESSION_SECRET || "dev-only-secret-change-this-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
      sameSite: "none",
      secure: true,
    },
  })
);

app.use("/api/auth", authRoutes);
app.use("/api/albums", albumRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/listen-status", listenStatusRoutes);
app.use("/api/favorites", favoriteRoutes);
app.use("/api/lists", listRoutes);
app.use("/api/follows", followRoutes);
app.use("/api/feed", feedRoutes);
app.use("/api/users", userRoutes);

app.get("/api/health", (req, res) => res.json({ ok: true }));

// Catches any error thrown inside a route that wasn't already handled --
// without this, an unexpected error would crash the whole server instead
// of just failing that one request.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on our end." });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
