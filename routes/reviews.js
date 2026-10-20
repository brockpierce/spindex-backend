const express = require("express");
const prisma = require("../lib/prisma");
const { notifyMentions } = require("../lib/notifyMentions");
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

// Build the ratings that count toward an average. Each user contributes a
// single vote per album: their LATEST rated listen. A re-listen with a rating
// overrides that user's original rating (re-listens are not summed in as extra
// votes); a re-listen with no rating leaves the previous one in place.
async function effectiveRatings(where) {
  const [reviews, relistens] = await Promise.all([
    prisma.review.findMany({ where, select: { userId: true, albumId: true, rating: true } }),
    prisma.relisten.findMany({
      where: { ...where, rating: { not: null } },
      select: { userId: true, albumId: true, rating: true },
      orderBy: { number: "asc" },
    }),
  ]);
  // Highest-numbered rated re-listen per user+album wins (asc order → last set).
  const override = new Map();
  for (const r of relistens) override.set(r.userId + "|" + r.albumId, r.rating);
  const ratings = [];
  for (const rv of reviews) {
    if (rv.rating == null) continue;
    const key = rv.userId + "|" + rv.albumId;
    ratings.push(override.has(key) ? override.get(key) : rv.rating);
  }
  return ratings;
}

function summarize(ratings) {
  const count = ratings.length;
  const average = count ? ratings.reduce((a, b) => a + b, 0) / count : null;
  return { average, count };
}

// GET /api/reviews/community-average — site-wide average (latest rating per user+album).
router.get("/community-average", async (req, res, next) => {
  try {
    res.json(summarize(await effectiveRatings({})));
  } catch (e) { res.json({ average: null, count: 0 }); }
});

// GET /api/reviews/album-average/:albumId — average rating for one album.
// Declared before the "/:albumId" routes below so "album-average" isn't
// matched as an album id.
router.get("/album-average/:albumId", async (req, res) => {
  try {
    res.json(summarize(await effectiveRatings({ albumId: req.params.albumId })));
  } catch (e) { res.json({ average: null, count: 0 }); }
});

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
      // Keep the original listen date on edit so editing never reposts the
      // review to the feed or the top of the profile. Only re-listens repost.
      update: { rating, reviewText, favTrack, leastFavTrack },
      create: { userId: req.userId, albumId, rating, reviewText, favTrack, leastFavTrack },
    });
    await prisma.listenStatus.upsert({
      where: { userId_albumId: { userId: req.userId, albumId } },
      update: { status: "listened" },
      create: { userId: req.userId, albumId, status: "listened" },
    });
    await notifyMentions(reviewText, req.userId, review.id);
    res.json({ review: publicReview(review) });
  } catch (e) { next(e); }
});

router.delete("/:albumId", requireAuth, async (req, res, next) => {
  try {
    const { albumId } = req.params;
    // deleteMany so no-op is fine if the review doesn't exist
    await prisma.review.deleteMany({
      where: { userId: req.userId, albumId },
    });
    res.json({ ok: true });
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
