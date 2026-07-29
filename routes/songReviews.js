const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// POST /api/song-reviews — create a song review (body text REQUIRED)
router.post("/", requireAuth, async (req, res) => {
  try {
    const { albumId, songTitle, rating, reviewText } = req.body;
    if (!albumId || !songTitle || !String(songTitle).trim()) {
      return res.status(400).json({ error: "Album and song title are required." });
    }
    const body = (reviewText || "").trim();
    if (!body) {
      return res.status(400).json({ error: "A written review is required for song reviews." });
    }
    if (body.length > 2000) {
      return res.status(400).json({ error: "Review is too long (max 2000 characters)." });
    }
    let r = null;
    if (rating !== undefined && rating !== null && rating !== "") {
      r = parseInt(rating, 10);
      if (isNaN(r) || r < 1 || r > 10) return res.status(400).json({ error: "Rating must be 1–10." });
    }

    // Verify album exists
    const album = await prisma.album.findUnique({ where: { id: albumId } });
    if (!album) return res.status(404).json({ error: "Album not found." });

    const review = await prisma.songReview.create({
      data: {
        userId: req.userId,
        albumId,
        songTitle: String(songTitle).trim(),
        rating: r,
        reviewText: body,
      },
    });
    res.json({ songReview: review });
  } catch (e) {
    console.error("song review create error", e);
    res.status(500).json({ error: "Failed to create song review." });
  }
});

// GET /api/song-reviews/user/:username — a user's song reviews
router.get("/user/:username", async (req, res) => {
  try {
    const user = await prisma.user.findFirst({
      where: { username: { equals: req.params.username } },
      select: { id: true },
    });
    if (!user) return res.json({ songReviews: [] });
    const rows = await prisma.songReview.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json({ songReviews: rows });
  } catch (e) {
    console.error("song review list error", e);
    res.json({ songReviews: [] });
  }
});

// GET /api/song-reviews/album/:albumId — song reviews for an album
router.get("/album/:albumId", async (req, res) => {
  try {
    const rows = await prisma.songReview.findMany({
      where: { albumId: req.params.albumId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json({ songReviews: rows });
  } catch (e) {
    console.error("song review album list error", e);
    res.json({ songReviews: [] });
  }
});

// DELETE /api/song-reviews/:id — delete own song review
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const row = await prisma.songReview.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: "Not found." });
    if (row.userId !== req.userId) return res.status(403).json({ error: "Not authorized." });
    await prisma.songReview.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    console.error("song review delete error", e);
    res.status(500).json({ error: "Failed to delete." });
  }
});

module.exports = router;
