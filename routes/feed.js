const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();

function cardFromReview(review) {
  return {
    itemType: "review",
    id: review.id,
    username: review.user.username,
    albumId: review.albumId,
    rating: review.rating,
    text: review.reviewText,
    date: review.createdAt,
  };
}

function cardFromTextPost(post) {
  return {
    itemType: "textpost",
    id: post.id,
    username: post.user.username,
    text: post.text,
    date: post.createdAt,
  };
}

function cardFromMixShare(share) {
  return {
    itemType: "sharemix",
    id: share.id,
    username: share.user.username,
    mixId: share.mixId,
    mixType: share.mixType,
    date: share.createdAt,
  };
}

// GET /api/feed — personal feed (reviews + text posts from people you follow)
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const userId = req.userId;
    const follows = await prisma.follow.findMany({ where: { followerId: userId } });
    const followedIds = follows.map((f) => f.followedId);

    const [reviews, textPosts, mixShares] = await Promise.all([
      followedIds.length
        ? prisma.review.findMany({ where: { userId: { in: followedIds } }, include: { user: true }, orderBy: { createdAt: "desc" }, take: 50 })
        : [],
      followedIds.length
        ? prisma.textPost.findMany({ where: { userId: { in: followedIds } }, include: { user: true }, orderBy: { createdAt: "desc" }, take: 50 })
        : [],
      followedIds.length
        ? prisma.mixShare.findMany({ where: { userId: { in: followedIds } }, include: { user: true }, orderBy: { createdAt: "desc" }, take: 20 })
        : [],
    ]);

    const feed = [
      ...reviews.map(cardFromReview),
      ...textPosts.map(cardFromTextPost),
      ...mixShares.map(cardFromMixShare),
    ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 50);

    res.json({ feed });
  } catch (e) { next(e); }
});

// GET /api/feed/public — everyone feed (reviews + text posts from anyone)
router.get("/public", requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 100);

    const [reviews, textPosts, mixShares] = await Promise.all([
      prisma.review.findMany({
        where: { reviewText: { not: null } },
        include: { user: true },
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      prisma.textPost.findMany({
        include: { user: true },
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      prisma.mixShare.findMany({
        include: { user: true },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
    ]);

    const feed = [
      ...reviews.map(cardFromReview),
      ...textPosts.map(cardFromTextPost),
      ...mixShares.map(cardFromMixShare),
    ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, limit);

    res.json({ feed });
  } catch (e) { next(e); }
});

module.exports = router;
