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
    user: review.user
      ? { id: review.user.id, username: review.user.username, displayName: review.user.displayName }
      : undefined,
  };
}

// PUT /api/reviews/:albumId
// Create-or-update your own review for an album (one review per user per
// album, so this is always an upsert, never a duplicate).
router.put("/:albumId", requireAuth, async (req, res) => {
  const { albumId } = req.params;
  const { rating, reviewText, favTrack, leastFavTrack } = req.body;

  if (!rating || rating < 1 || rating > 10) {
    return res.status(400).json({ error: "Rating must be a number from 1 to 10." });
  }

  const album = await prisma.album.findUnique({ where: { id: albumId } });
  if (!album) return res.status(404).json({ error: "Album not found." });

  const review = await prisma.review.upsert({
    where: { userId_albumId: { userId: req.userId, albumId } },
    update: { rating, reviewText, favTrack, leastFavTrack },
    create: { userId: req.userId, albumId, rating, reviewText, favTrack, leastFavTrack },
  });

  // Saving a rated review implies you've listened to it -- mirrors the
  // demo's behavior where rating something marks it "listened".
  await prisma.listenStatus.upsert({
    where: { userId_albumId: { userId: req.userId, albumId } },
    update: { status: "listened" },
    create: { userId: req.userId, albumId, status: "listened" },
  });

  res.json({ review: publicReview(review) });
});

// GET /api/reviews/album/:albumId
// All reviews for one album, used for the "listened by" (when filtered to
// people you follow, client-side or via a future ?following=true) and
// "recent reviews" sections on the album page.
router.get("/album/:albumId", async (req, res) => {
  const reviews = await prisma.review.findMany({
    where: { albumId: req.params.albumId },
    include: { user: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json({ reviews: reviews.map(publicReview) });
});

// GET /api/reviews/user/:userId
// A user's review history, for their profile page.
router.get("/user/:userId", async (req, res) => {
  const reviews = await prisma.review.findMany({
    where: { userId: req.params.userId },
    include: { user: true },
    orderBy: { createdAt: "desc" },
  });
  res.json({ reviews: reviews.map(publicReview) });
});

module.exports = router;
