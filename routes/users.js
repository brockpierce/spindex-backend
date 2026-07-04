const express = require("express");
const prisma = require("../lib/prisma");
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../middleware/auth");

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

async function getFollowedIds(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return new Set();
  try {
    const { userId } = jwt.verify(header.slice(7), JWT_SECRET);
    const follows = await prisma.follow.findMany({ where: { followerId: userId } });
    return new Set(follows.map((f) => f.followedId));
  } catch { return new Set(); }
}

router.get("/", async (req, res, next) => {
  try {
    const search = (req.query.search || "").trim();
    if (!search) return res.json({ users: [] });
    const users = await prisma.user.findMany({
      where: { OR: [{ username: { contains: search } }, { displayName: { contains: search } }] },
      take: 20,
      include: { _count: { select: { followers: true, following: true } } },
    });
    const followedIds = await getFollowedIds(req);
    res.json({ users: users.map((u) => publicUser(u, followedIds)) });
  } catch (e) { next(e); }
});

router.get("/:username", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { username: req.params.username },
      include: { _count: { select: { followers: true, following: true } } },
    });
    if (!user) return res.status(404).json({ error: "User not found." });
    const followedIds = await getFollowedIds(req);
    res.json({ user: publicUser(user, followedIds) });
  } catch (e) { next(e); }
});

module.exports = router;
