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
      isPublic: m.isPublic !== false,
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

// GET /api/mixes/user/:userId — another user's PUBLIC album mixes (for profile pages)
router.get("/user/:userId", async (req, res, next) => {
  try {
    const mixes = await prisma.albumMix.findMany({
      where: { userId: req.params.userId, isPublic: true },
      include: { items: { orderBy: { position: "asc" } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ mixes: mixes.map((m) => ({
      id: m.id,
      title: m.title,
      description: m.description || "",
      isPublic: true,
      albums: m.items.map((i) => ({ albumId: i.albumId, note: i.note || "" })),
    })) });
  } catch (e) { next(e); }
});

// GET /api/mixes/:id — single mix by ID (public-facing; used by editorial + feed shares)
router.get("/:id", async (req, res, next) => {
  try {
    const m = await prisma.albumMix.findUnique({
      where: { id: req.params.id },
      include: { items: { orderBy: { position: "asc" } }, user: { select: { username: true } } },
    });
    if (!m) return res.status(404).json({ error: "Mix not found." });
    res.json({ mix: {
      id: m.id,
      title: m.title,
      description: m.description || "",
      isPublic: m.isPublic !== false,
      owner: m.user ? m.user.username : null,
      albums: m.items.map((item) => ({ albumId: item.albumId, note: item.note || "" })),
    } });
  } catch (e) { next(e); }
});

// PUT /api/mixes/:id — update title/description
router.put("/:id", requireAuth, async (req, res, next) => {
  try {
    const mix = await prisma.albumMix.findUnique({ where: { id: req.params.id } });
    if (!mix || mix.userId !== req.userId) {
      return res.status(404).json({ error: "Mix not found." });
    }
    const { title, description, isPublic } = req.body;
    const updated = await prisma.albumMix.update({
      where: { id: req.params.id },
      data: {
        title: title !== undefined ? title.trim() : mix.title,
        description: description !== undefined ? description : mix.description,
        ...(isPublic !== undefined ? { isPublic: Boolean(isPublic) } : {}),
      },
    });
    res.json({ mix: { id: updated.id, title: updated.title, description: updated.description || "", isPublic: updated.isPublic !== false } });
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

// PUT /api/mixes/:id/reorder — reorder albums in a mix
router.put("/:id/reorder", requireAuth, async (req, res, next) => {
  try {
    const { albumIds } = req.body;
    if (!Array.isArray(albumIds)) return res.status(400).json({ error: "albumIds required." });
    const mix = await prisma.albumMix.findUnique({ where: { id: req.params.id } });
    if (!mix) return res.status(404).json({ error: "Mix not found." });
    if (mix.userId !== req.userId) return res.status(403).json({ error: "Not your mix." });
    // Update positions
    await Promise.all(albumIds.map((albumId, position) =>
      prisma.albumMixItem.updateMany({ where: { mixId: req.params.id, albumId }, data: { position } })
    ));
    res.json({ ok: true });
  } catch (e) { next(e); }
});
