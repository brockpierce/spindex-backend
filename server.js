require("dotenv").config();
const express = require("express");
const session = require("express-session");
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

// Lets the frontend make requests to this server and have cookies (the
// session) come along with them. `credentials: true` is what makes the
// session cookie actually work cross-origin -- without it, every request
// would look "logged out".
//
// DEV-ONLY NOTE: this allows any origin to call the API with credentials,
// which is what's needed to test against this server from a Claude
// artifact (artifacts run on Anthropic's domain, not localhost, so a
// fixed origin like "http://localhost:5173" would get blocked by the
// browser). This setting is NOT safe for a real deployment -- before
// going live, lock `origin` back down to your actual frontend's URL.
app.use(
  cors({
    origin: true, // reflects whatever origin made the request -- DEV ONLY, see note above
    credentials: true,
  })
);
app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-only-secret-change-this-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
      // DEV-ONLY NOTE: sameSite "none" + secure is required for the
      // session cookie to survive a genuinely cross-origin request (e.g.
      // from a Claude artifact, which is served over HTTPS on a
      // different domain than your localhost server). "secure: true"
      // normally means "HTTPS only", which localhost isn't -- most
      // browsers special-case localhost as an exception during dev, but
      // this combination is still meant for testing, not production.
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
