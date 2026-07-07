const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();

// GET /api/notifications — list current user's notifications (newest first)
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const notifications = await prisma.notification.findMany({
      where: { recipientId: req.userId },
      include: {
        actor: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const shaped = notifications.map((n) => ({
      id: n.id,
      type: n.type,
      actorUsername: n.actor.username,
      actorDisplayName: n.actor.displayName,
      referenceId: n.referenceId,
      read: n.read,
      createdAt: n.createdAt,
    }));

    const unreadCount = await prisma.notification.count({
      where: { recipientId: req.userId, read: false },
    });

    res.json({ notifications: shaped, unreadCount });
  } catch (e) { next(e); }
});

// PUT /api/notifications/read — mark all as read
router.put("/read", requireAuth, async (req, res, next) => {
  try {
    await prisma.notification.updateMany({
      where: { recipientId: req.userId, read: false },
      data: { read: true },
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// PUT /api/notifications/:id/read — mark one as read
router.put("/:id/read", requireAuth, async (req, res, next) => {
  try {
    await prisma.notification.updateMany({
      where: { id: req.params.id, recipientId: req.userId },
      data: { read: true },
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
