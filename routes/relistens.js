const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function normalizeRating(v) {
  if (v === null || v === undefined || v === "" || v === 0 || v === "0") return null;
  const n = parseInt(v, 10);
  if (isNaN(n) || n < 1 || n > 10) return null;
  return n;
}
function str(v) {
  return v == null ? "" : String(v);
}

// GET /api/relistens/user/:userId — all of a user's re-listens across every album.
// Public (profiles are public), so a visitor can see whose latest listen is which.
// Declared before "/:albumId" so "user" isn't matched as an album id.
router.get("/user/:userId", async (req, res, next) => {
  try {
    const relistens = await prisma.relisten.findMany({
      where: { userId: req.params.userId },
      orderBy: { number: "asc" },
      take: 5000,
    });
    res.json({ relistens });
  } catch (e) { res.json({ relistens: [] }); }
});

// GET /api/relistens/:albumId — the current user's re-listens for an album (oldest first).
router.get("/:albumId", requireAuth, async (req, res, next) => {
  try {
    const relistens = await prisma.relisten.findMany({
      where: { userId: req.userId, albumId: req.params.albumId },
      orderBy: { number: "asc" },
    });
    res.json({ relistens });
  } catch (e) { next(e); }
});

// POST /api/relistens/:albumId — log a new re-listen. Server assigns the next number.
router.post("/:albumId", requireAuth, async (req, res, next) => {
  try {
    const albumId = req.params.albumId;
    const album = await prisma.album.findUnique({ where: { id: albumId }, select: { id: true } });
    if (!album) return res.status(404).json({ error: "Album not found." });

    const { rating, review, favoriteTrack, leastFavoriteTrack } = req.body;
    const data = {
      userId: req.userId,
      albumId,
      rating: normalizeRating(rating),
      review: str(review),
      favoriteTrack: str(favoriteTrack),
      leastFavoriteTrack: str(leastFavoriteTrack),
    };

    // Next number = max existing + 1 (not count+1, so deleting a middle
    // re-listen can't make a new one collide). Retry on the rare unique
    // clash from a double-submit.
    let created = null;
    for (let attempt = 0; attempt < 3 && !created; attempt++) {
      const last = await prisma.relisten.findFirst({
        where: { userId: req.userId, albumId },
        orderBy: { number: "desc" },
        select: { number: true },
      });
      try {
        created = await prisma.relisten.create({
          data: { ...data, number: (last?.number || 0) + 1 },
        });
      } catch (err) {
        if (err.code === "P2002") continue; // number taken; recount and retry
        throw err;
      }
    }
    if (!created) return res.status(409).json({ error: "Could not save re-listen, please try again." });
    res.status(201).json({ relisten: created });
  } catch (e) { next(e); }
});

// PATCH /api/relistens/item/:id — edit one of the current user's re-listens.
router.patch("/item/:id", requireAuth, async (req, res, next) => {
  try {
    const existing = await prisma.relisten.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.userId !== req.userId) {
      return res.status(404).json({ error: "Re-listen not found." });
    }
    const { rating, review, favoriteTrack, leastFavoriteTrack } = req.body;
    const data = {};
    if (rating !== undefined) data.rating = normalizeRating(rating);
    if (review !== undefined) data.review = str(review);
    if (favoriteTrack !== undefined) data.favoriteTrack = str(favoriteTrack);
    if (leastFavoriteTrack !== undefined) data.leastFavoriteTrack = str(leastFavoriteTrack);
    const relisten = await prisma.relisten.update({ where: { id: req.params.id }, data });
    res.json({ relisten });
  } catch (e) { next(e); }
});

// DELETE /api/relistens/item/:id — delete one of the current user's re-listens.
router.delete("/item/:id", requireAuth, async (req, res, next) => {
  try {
    const existing = await prisma.relisten.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.userId !== req.userId) {
      return res.status(404).json({ error: "Re-listen not found." });
    }
    await prisma.relisten.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
