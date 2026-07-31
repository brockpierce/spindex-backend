const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();

function publicUser(user) {
  return { id: user.id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl };
}

router.post("/:userId", requireAuth, async (req, res, next) => {
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

router.delete("/:userId", requireAuth, async (req, res, next) => {
  try {
    const follow = await prisma.follow.findUnique({
      where: { followerId_followedId: { followerId: req.userId, followedId: req.params.userId } },
    });
    if (follow?.locked) return res.status(403).json({ error: "You cannot unfollow this account." });
    await prisma.follow.deleteMany({ where: { followerId: req.userId, followedId: req.params.userId } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get("/:userId/followers", async (req, res, next) => {
  try {
    const follows = await prisma.follow.findMany({ where: { followedId: req.params.userId }, include: { follower: true } });
    res.json({ users: follows.map((f) => publicUser(f.follower)) });
  } catch (e) { next(e); }
});

router.get("/:userId/following", async (req, res, next) => {
  try {
    const follows = await prisma.follow.findMany({ where: { followerId: req.params.userId }, include: { followed: true } });
    res.json({ users: follows.map((f) => publicUser(f.followed)) });
  } catch (e) { next(e); }
});

module.exports = router;
