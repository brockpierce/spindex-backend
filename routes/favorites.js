const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();
const MAX_FAVORITES = 3;

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const favorites = await prisma.favorite.findMany({
      where: { userId: req.userId },
      orderBy: { position: "asc" },
    });
    res.json({ favorites });
  } catch (e) { next(e); }
});

router.post("/:albumId", requireAuth, async (req, res, next) => {
  try {
    const { albumId } = req.params;
    // Verify album exists first
    const album = await prisma.album.findUnique({ where: { id: albumId } });
    if (!album) return res.status(404).json({ error: "Album not found." });
    const existing = await prisma.favorite.findMany({ where: { userId: req.userId } });
    if (existing.some((f) => f.albumId === albumId)) {
      return res.status(409).json({ error: "Already favorited." });
    }
    if (existing.length >= MAX_FAVORITES) {
      return res.status(400).json({ error: `Max ${MAX_FAVORITES} favorites. Remove one first.` });
    }
    const favorite = await prisma.favorite.create({
      data: { userId: req.userId, albumId, position: existing.length + 1 },
    });
    res.status(201).json({ favorite });
  } catch (e) { next(e); }
});

router.delete("/:albumId", requireAuth, async (req, res, next) => {
  try {
    await prisma.favorite.deleteMany({ where: { userId: req.userId, albumId: req.params.albumId } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
