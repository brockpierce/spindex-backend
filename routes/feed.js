const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function cardFromReview(review, kind, reason) {
  return {
    kind,
    reason,
    username: review.user.username,
    albumId: review.albumId,
    rating: review.rating,
    text: review.reviewText,
    date: review.createdAt,
  };
}

// GET /api/feed
// Mirrors the demo's feed logic exactly:
//   1. Every review from people you follow ("following" cards)
//   2. Reviews from anyone else, but only for albums you've reviewed or
//      queued yourself ("for_you" cards)
// Both are merged and sorted by date, newest first.
router.get("/", requireAuth, async (req, res) => {
  const userId = req.session.userId;

  const follows = await prisma.follow.findMany({ where: { followerId: userId } });
  const followedIds = follows.map((f) => f.followedId);

  const followingReviews = followedIds.length
    ? await prisma.review.findMany({
        where: { userId: { in: followedIds } },
        include: { user: true },
      })
    : [];

  const myReviews = await prisma.review.findMany({ where: { userId } });
  const myListenStatus = await prisma.listenStatus.findMany({ where: { userId } });
  const relevantAlbumIds = new Set([
    ...myReviews.map((r) => r.albumId),
    ...myListenStatus.filter((s) => s.status === "want_to_listen").map((s) => s.albumId),
  ]);
  const myReviewedAlbumIds = new Set(myReviews.map((r) => r.albumId));

  const communityReviews = relevantAlbumIds.size
    ? await prisma.review.findMany({
        where: {
          albumId: { in: Array.from(relevantAlbumIds) },
          userId: { notIn: [...followedIds, userId] }, // exclude friends (already covered above) and yourself
        },
        include: { user: true },
      })
    : [];

  const followingCards = followingReviews.map((r) => cardFromReview(r, "following", "you follow them"));
  const forYouCards = communityReviews.map((r) =>
    cardFromReview(r, "for_you", myReviewedAlbumIds.has(r.albumId) ? "you reviewed this album" : "on your queue")
  );

  const feed = [...followingCards, ...forYouCards].sort((a, b) => new Date(b.date) - new Date(a.date));

  res.json({ feed });
});

module.exports = router;
