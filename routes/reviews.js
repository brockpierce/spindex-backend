const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function publicReview(review) {
  return {
    id: review.id,
    albumId: review.albumId,
    rating: review.rating,
    reviewText: review.reviewText,
    favTrack: review.favTrack,
    leastFavTrack: review.leastFavTrack,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    username: review.user?.username,
    user: review.user
      ? { id: review.user.id, username: review.user.username, displayName: review.user.displayName }
      : undefined,
  };
}

router.put("/:albumId", requireAuth, async (req, res, next) => {
  try {
    const { albumId } = req.params;
    const { rating, reviewText, favTrack, leastFavTrack } = req.body;
    if (!rating || rating < 1 || rating > 10) {
      return res.status(400).json({ error: "Rating must be 1-10." });
    }
    const album = await prisma.album.findUnique({ where: { id: albumId } });
    if (!album) return res.status(404).json({ error: "Album not found." });
    const review = await prisma.review.upsert({
      where: { userId_albumId: { userId: req.userId, albumId } },
      update: { rating, reviewText, favTrack, leastFavTrack },
      create: { userId: req.userId, albumId, rating, reviewText, favTrack, leastFavTrack },
    });
    await prisma.listenStatus.upsert({
      where: { userId_albumId: { userId: req.userId, albumId } },
      update: { status: "listened" },
      create: { userId: req.userId, albumId, status: "listened" },
    });
    res.json({ review: publicReview(review) });
  } catch (e) { next(e); }
});

router.get("/album/:albumId", async (req, res, next) => {
  try {
    const reviews = await prisma.review.findMany({
      where: { albumId: req.params.albumId },
      include: { user: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json({ reviews: reviews.map(publicReview) });
  } catch (e) { next(e); }
});

router.get("/user/:userId", async (req, res, next) => {
  try {
    const reviews = await prisma.review.findMany({
      where: { userId: req.params.userId },
      include: { user: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ reviews: reviews.map(publicReview) });
  } catch (e) { next(e); }
});

module.exports = router;
