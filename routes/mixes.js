const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();

// GET /api/mixes — list current user's album mixes
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const mixes = await prisma.albumMix.findMany({
      where: { userId: req.userId },
      include: {
        items: { orderBy: { position: "asc" } },
      },
      orderBy: { createdAt: "desc" },
    });
    // Shape to match frontend expectations: { id, title, description, albums: [{ albumId, note }] }
    const shaped = mixes.map((m) => ({
      id: m.id,
      title: m.title,
      description: m.description || "",
      albums: m.items.map((item) => ({ albumId: item.albumId, note: item.note || "" })),
    }));
    res.json({ mixes: shaped });
  } catch (e) { next(e); }
});

// POST /api/mixes — create a new album mix
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const { title } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: "Title required." });
    }
    const mix = await prisma.albumMix.create({
      data: { userId: req.userId, title: title.trim() },
    });
    res.status(201).json({ mix: { id: mix.id, title: mix.title, description: "", albums: [] } });
  } catch (e) { next(e); }
});

// DELETE /api/mixes/:id — delete an album mix
router.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const mix = await prisma.albumMix.findUnique({ where: { id: req.params.id } });
    if (!mix || mix.userId !== req.userId) {
      return res.status(404).json({ error: "Mix not found." });
    }
    await prisma.albumMix.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// PUT /api/mixes/:id — update title/description
router.put("/:id", requireAuth, async (req, res, next) => {
  try {
    const mix = await prisma.albumMix.findUnique({ where: { id: req.params.id } });
    if (!mix || mix.userId !== req.userId) {
      return res.status(404).json({ error: "Mix not found." });
    }
    const { title, description } = req.body;
    const updated = await prisma.albumMix.update({
      where: { id: req.params.id },
      data: {
        title: title !== undefined ? title.trim() : mix.title,
        description: description !== undefined ? description : mix.description,
      },
    });
    res.json({ mix: { id: updated.id, title: updated.title, description: updated.description || "" } });
  } catch (e) { next(e); }
});

// POST /api/mixes/:id/albums — add an album to a mix
router.post("/:id/albums", requireAuth, async (req, res, next) => {
  try {
    const mix = await prisma.albumMix.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });
    if (!mix || mix.userId !== req.userId) {
      return res.status(404).json({ error: "Mix not found." });
    }
    const { albumId, note } = req.body;
    if (!albumId) return res.status(400).json({ error: "albumId required." });
    // Check for duplicates
    if (mix.items.some((i) => i.albumId === albumId)) {
      return res.status(409).json({ error: "Album already in mix." });
    }
    const position = mix.items.length + 1;
    await prisma.albumMixItem.create({
      data: { mixId: req.params.id, albumId, position, note: note || null },
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// DELETE /api/mixes/:id/albums/:albumId — remove an album from a mix
router.delete("/:id/albums/:albumId", requireAuth, async (req, res, next) => {
  try {
    await prisma.albumMixItem.deleteMany({
      where: { mixId: req.params.id, albumId: req.params.albumId },
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
