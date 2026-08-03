const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();

// GET /api/blocks — users the current user has blocked (for a manage list)
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const rows = await prisma.block.findMany({ where: { blockerId: req.userId }, orderBy: { createdAt: "desc" } });
    const ids = rows.map((r) => r.blockedId);
    const users = ids.length
      ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, username: true, displayName: true, avatarUrl: true } })
      : [];
    res.json({ blocked: users });
  } catch (e) { next(e); }
});

// POST /api/blocks/:userId — block a user
router.post("/:userId", requireAuth, async (req, res, next) => {
  try {
    const targetId = req.params.userId;
    if (targetId === req.userId) return res.status(400).json({ error: "You can't block yourself." });
    const target = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
    if (!target) return res.status(404).json({ error: "User not found." });
    await prisma.block.upsert({
      where: { blockerId_blockedId: { blockerId: req.userId, blockedId: targetId } },
      update: {},
      create: { blockerId: req.userId, blockedId: targetId },
    });
    // Sever any follow relationship in both directions.
    await prisma.follow.deleteMany({ where: { OR: [
      { followerId: req.userId, followedId: targetId },
      { followerId: targetId, followedId: req.userId },
    ] } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// DELETE /api/blocks/:userId — unblock
router.delete("/:userId", requireAuth, async (req, res, next) => {
  try {
    await prisma.block.deleteMany({ where: { blockerId: req.userId, blockedId: req.params.userId } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
