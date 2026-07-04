const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function publicUser(user, followedIds = new Set()) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    isFollowing: followedIds.has(user.id),
    followerCount: user._count?.followers || 0,
    followingCount: user._count?.following || 0,
  };
}

// GET /api/users?search=brock
router.get("/", async (req, res) => {
  const search = (req.query.search || "").trim();
  if (!search) return res.json({ users: [] });

  const users = await prisma.user.findMany({
    where: {
      OR: [
        { username: { contains: search } },
        { displayName: { contains: search } },
      ],
    },
    take: 20,
    include: { _count: { select: { followers: true, following: true } } },
  });

  // Get who the current user follows so we can mark isFollowing
  let followedIds = new Set();
  if (req.userId) {
    const follows = await prisma.follow.findMany({ where: { followerId: req.userId } });
    followedIds = new Set(follows.map((f) => f.followedId));
  }

  res.json({ users: users.map((u) => publicUser(u, followedIds)) });
});

// GET /api/users/:username
router.get("/:username", async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { username: req.params.username },
    include: { _count: { select: { followers: true, following: true } } },
  });
  if (!user) return res.status(404).json({ error: "User not found." });

  let followedIds = new Set();
  if (req.userId) {
    const follows = await prisma.follow.findMany({ where: { followerId: req.userId } });
    followedIds = new Set(follows.map((f) => f.followedId));
  }

  res.json({ user: publicUser(user, followedIds) });
});

module.exports = router;
