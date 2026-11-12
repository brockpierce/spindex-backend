const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { itemTraceDeletes } = require("../lib/itemCleanup");
const router = express.Router();

// POST /api/mix-shares — share a mix to the feed
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const { mixId, mixType } = req.body;
    if (typeof mixId !== "string" || !mixId || !["album", "song"].includes(mixType)) {
      return res.status(400).json({ error: "mixId and mixType required." });
    }
    // Album mixes live on the server: only your own, public mix can be shared.
    if (mixType === "album") {
      const mix = await prisma.albumMix.findUnique({ where: { id: mixId }, select: { userId: true, isPublic: true } });
      if (!mix || mix.userId !== req.userId) return res.status(404).json({ error: "Mix not found." });
      // Others couldn't open a private mix from the feed card.
      if (mix.isPublic === false) return res.status(400).json({ error: "Make this mix public to share it." });
    }
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
    await prisma.$transaction([
      ...itemTraceDeletes([req.params.id]),
      prisma.mixShare.deleteMany({ where: { id: req.params.id } }),
    ]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
