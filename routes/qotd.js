const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();

// Shape a row the way the feed expects it.
function shape(r) {
  return {
    id: r.id,
    username: r.user ? r.user.username : null,
    albumId: r.albumId,
    questionText: r.questionText,
    date: r.createdAt,
    album: r.album || null,
  };
}

// GET /api/qotd?question=...  — answers, newest first.
// Without ?question returns the most recent across all questions.
router.get("/", async (req, res, next) => {
  try {
    const question = req.query.question;
    const items = await prisma.qotdResponse.findMany({
      where: question ? { questionText: question } : {},
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { user: { select: { username: true } }, album: true },
    });
    res.json({ items: items.map(shape) });
  } catch (e) { next(e); }
});

// POST /api/qotd  { albumId, questionText }
// One answer per user per question: answering again replaces the album
// rather than stacking duplicates, matching the unique index.
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const { albumId, questionText } = req.body;
    if (!albumId || !questionText) {
      return res.status(400).json({ error: "albumId and questionText required." });
    }
    const album = await prisma.album.findUnique({ where: { id: albumId } });
    if (!album) return res.status(404).json({ error: "Album not found." });

    const existing = await prisma.qotdResponse.findUnique({
      where: { userId_questionText: { userId: req.userId, questionText } },
    });

    const row = existing
      ? await prisma.qotdResponse.update({
          where: { id: existing.id },
          data: { albumId },
          include: { user: { select: { username: true } }, album: true },
        })
      : await prisma.qotdResponse.create({
          data: { userId: req.userId, albumId, questionText },
          include: { user: { select: { username: true } }, album: true },
        });

    res.status(201).json({ item: shape(row) });
  } catch (e) { next(e); }
});

// DELETE /api/qotd/:id — own answers only.
router.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const row = await prisma.qotdResponse.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: "Not found." });
    if (row.userId !== req.userId) return res.status(403).json({ error: "Not yours." });
    await prisma.qotdResponse.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
