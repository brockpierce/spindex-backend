const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { perUserLimiter } = require("../lib/rateLimit");

const followLimiter = perUserLimiter({ windowMs: 60 * 1000, max: 60, message: "You're following/unfollowing too fast." });
const router = express.Router();

function publicUser(user) {
  // avatarUrl is safe in lists again: avatars are now compressed on upload,
  // capped at 200 KB server-side, and existing rows were migrated down. (The
  // uncapped pageBackground/profileDrawing blobs are still never selected here.)
  return { id: user.id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl || null };
}

// Annotate a list of public users with whether the requesting viewer follows
// each one (for the in-list follow button) and which row is the viewer's own.
async function withFollowFlags(users, viewerId) {
  if (!viewerId) return users.map((u) => ({ ...u, isFollowing: false, isSelf: false }));
  const ids = users.map((u) => u.id);
  const rows = await prisma.follow.findMany({
    where: { followerId: viewerId, followedId: { in: ids } },
    select: { followedId: true },
  });
  const following = new Set(rows.map((r) => r.followedId));
  return users.map((u) => ({ ...u, isFollowing: following.has(u.id), isSelf: u.id === viewerId }));
}

router.post("/:userId", requireAuth, followLimiter, async (req, res, next) => {
  try {
    const { userId } = req.params;
    if (userId === req.userId) return res.status(400).json({ error: "You can't follow yourself." });
    const targetUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!targetUser) return res.status(404).json({ error: "User not found." });
    await prisma.follow.upsert({
      where: { followerId_followedId: { followerId: req.userId, followedId: userId } },
      update: {},
      create: { followerId: req.userId, followedId: userId },
    });
    // Notify the person being followed
    try {
      await prisma.notification.create({
        data: {
          recipientId: userId,
          actorId: req.userId,
          type: "follow",
        },
      });
    } catch (notifErr) {
      // Swallow — notification failure shouldn't block the follow
      console.error("follow notification error:", notifErr.message);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete("/:userId", requireAuth, followLimiter, async (req, res, next) => {
  try {
    const follow = await prisma.follow.findUnique({
      where: { followerId_followedId: { followerId: req.userId, followedId: req.params.userId } },
    });
    if (follow?.locked) return res.status(403).json({ error: "You cannot unfollow this account." });
    await prisma.follow.deleteMany({ where: { followerId: req.userId, followedId: req.params.userId } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get("/:userId/followers", optionalAuth, async (req, res, next) => {
  try {
    const follows = await prisma.follow.findMany({ where: { followedId: req.params.userId }, include: { follower: true } });
    const users = await withFollowFlags(follows.map((f) => publicUser(f.follower)), req.userId);
    res.json({ users });
  } catch (e) { next(e); }
});

router.get("/:userId/following", optionalAuth, async (req, res, next) => {
  try {
    const follows = await prisma.follow.findMany({ where: { followerId: req.params.userId }, include: { followed: true } });
    const users = await withFollowFlags(follows.map((f) => publicUser(f.followed)), req.userId);
    res.json({ users });
  } catch (e) { next(e); }
});

module.exports = router;
