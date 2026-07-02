// Checks that the request came from a logged-in user (via express-session,
// configured in server.js). If not logged in, responds with 401 instead of
// letting the route run. Any route that needs "the current user" uses this.
//
// Usage: router.post("/reviews", requireAuth, (req, res) => { ... })
// Inside the handler, req.session.userId is guaranteed to be set.
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "You need to be logged in to do that." });
  }
  next();
}

module.exports = { requireAuth };
