const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function publicUser(user) {
  return { id: user.id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl };
}

// POST /api/follows/:userId  -- follow someone
router.post("/:userId", requireAuth, async (req, res) => {
  const { userId } = req.params;
  if (userId === req.session.userId) {
    return res.status(400).json({ error: "You can't follow yourself." });
  }
  const targetUser = await prisma.user.findUnique({ where: { id: userId } });
  if (!targetUser) return res.status(404).json({ error: "User not found." });

  await prisma.follow.upsert({
    where: { followerId_followedId: { followerId: req.session.userId, followedId: userId } },
    update: {},
    create: { followerId: req.session.userId, followedId: userId },
  });
  res.json({ ok: true });
});

// DELETE /api/follows/:userId  -- unfollow (blocked for locked follows)
router.delete("/:userId", requireAuth, async (req, res) => {
  const follow = await prisma.follow.findUnique({
    where: { followerId_followedId: { followerId: req.session.userId, followedId: req.params.userId } },
  });
  if (follow?.locked) {
    return res.status(403).json({ error: "You cannot unfollow this account." });
  }
  await prisma.follow.deleteMany({ where: { followerId: req.session.userId, followedId: req.params.userId } });
  res.json({ ok: true });
});

// GET /api/follows/:userId/followers
router.get("/:userId/followers", async (req, res) => {
  const follows = await prisma.follow.findMany({
    where: { followedId: req.params.userId },
    include: { follower: true },
  });
  res.json({ users: follows.map((f) => publicUser(f.follower)) });
});

// GET /api/follows/:userId/following
router.get("/:userId/following", async (req, res) => {
  const follows = await prisma.follow.findMany({
    where: { followerId: req.params.userId },
    include: { followed: true },
  });
  res.json({ users: follows.map((f) => publicUser(f.followed)) });
});

module.exports = router;
