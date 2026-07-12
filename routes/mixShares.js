const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();

// POST /api/mix-shares — share a mix to the feed
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const { mixId, mixType } = req.body;
    if (!mixId || !mixType) return res.status(400).json({ error: "mixId and mixType required." });
    const share = await prisma.mixShare.create({
      data: { userId: req.userId, mixId, mixType },
      include: { user: { select: { username: true } } },
    });
    res.status(201).json({ share: { id: share.id, username: share.user.username, mixId: share.mixId, mixType: share.mixType, date: share.createdAt } });
  } catch (e) { next(e); }
});

// DELETE /api/mix-shares/:id — remove a shared mix post
router.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const share = await prisma.mixShare.findUnique({ where: { id: req.params.id } });
    if (!share) return res.status(404).json({ error: "Not found." });
    if (share.userId !== req.userId) return res.status(403).json({ error: "Not yours." });
    await prisma.mixShare.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
