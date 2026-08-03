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
    favTrack: review.favTrack || null,
    leastFavTrack: review.leastFavTrack || null,
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
    // Metadata only — image bytes are never carried in the feed. The client
    // reserves layout space from these and fetches the actual images on open.
    imageCount: post.images ? post.images.length : 0,
    images: post.images || [],
  };
}

function cardFromMixShare(share) {
  return {
    itemType: "sharemix",
    id: share.id,
    username: share.user.username,
    mixId: share.mixId,
    mixType: share.mixType,
    caption: share.caption || "",
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
        ? prisma.textPost.findMany({ where: { userId: { in: followedIds } }, include: { user: true, images: { select: { position: true, width: true, height: true }, orderBy: { position: "asc" } } }, orderBy: { createdAt: "desc" }, take: 50 })
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
    const limit = Math.min(parseInt(req.query.limit || "25", 10), 100);
    // Cursor: only items strictly older than this. Ignored if unparseable, so
    // a malformed value returns the first page rather than erroring.
    const beforeRaw = req.query.before;
    const before = beforeRaw && !isNaN(new Date(beforeRaw)) ? new Date(beforeRaw) : null;
    const olderThan = before ? { createdAt: { lt: before } } : {};

    const [reviews, textPosts, mixShares] = await Promise.all([
      prisma.review.findMany({
        // Written reviews only. `not: null` alone let empty strings through,
        // so a bare rating saved as "" still showed up in the everyone feed.
        where: { AND: [{ reviewText: { not: null } }, { reviewText: { not: "" } }, olderThan] },
        include: { user: true },
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      prisma.textPost.findMany({
        where: olderThan,
        include: { user: true, images: { select: { position: true, width: true, height: true }, orderBy: { position: "asc" } } },
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      prisma.mixShare.findMany({
        where: olderThan,
        include: { user: true },
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
    ]);

    const merged = [
      ...reviews.map(cardFromReview),
      ...textPosts.map(cardFromTextPost),
      ...mixShares.map(cardFromMixShare),
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    const feed = merged.slice(0, limit);
    // A short page means we've reached the end — null tells the client to
    // stop offering "load more".
    const nextCursor = merged.length > limit && feed.length
      ? feed[feed.length - 1].date
      : null;

    res.json({ feed, nextCursor });
  } catch (e) { next(e); }
});

module.exports = router;
