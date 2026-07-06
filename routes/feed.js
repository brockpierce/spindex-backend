const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();

function cardFromReview(review) {
  return {
    id: review.id,
    username: review.user.username,
    albumId: review.albumId,
    rating: review.rating,
    text: review.reviewText,
    date: review.createdAt,
  };
}

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const userId = req.userId;
    const follows = await prisma.follow.findMany({ where: { followerId: userId } });
    const followedIds = follows.map((f) => f.followedId);
    const followingReviews = followedIds.length
      ? await prisma.review.findMany({ where: { userId: { in: followedIds } }, include: { user: true }, orderBy: { createdAt: "desc" }, take: 50 })
      : [];
    res.json({ feed: followingReviews.map(cardFromReview) });
  } catch (e) { next(e); }
});

// Public feed — recent reviews from anyone on the app.
// Used by the "everyone" tab on the home page.
router.get("/public", requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 100);
    const reviews = await prisma.review.findMany({
      // Only reviews with actual text — pure rating-only reviews would clutter the feed
      where: { reviewText: { not: null } },
      include: { user: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    res.json({ feed: reviews.map(cardFromReview) });
  } catch (e) { next(e); }
});

module.exports = router;
