const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();

const PAGE = 25;

// Resolve a batch of target ids across every post type they might belong to.
// reviewId on reactions/comments is unconstrained — it can be a Review,
// TextPost, MixShare or SongReview — so all four are checked. One query per
// type, not per row.
async function resolveTargets(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return {};

  const [reviews, textPosts, mixShares] = await Promise.all([
    prisma.review.findMany({
      where: { id: { in: unique } },
      include: { user: { select: { username: true } }, album: true },
    }),
    prisma.textPost.findMany({
      where: { id: { in: unique } },
      include: { user: { select: { username: true } } },
    }),
    prisma.mixShare.findMany({
      where: { id: { in: unique } },
      include: { user: { select: { username: true } } },
    }).catch(() => []),
  ]);

  const map = {};
  for (const r of reviews) {
    map[r.id] = {
      kind: "review",
      username: r.user ? r.user.username : null,
      rating: r.rating,
      text: r.reviewText || "",
      albumId: r.albumId,
      albumTitle: r.album ? r.album.title : null,
      albumArtist: r.album ? r.album.artistName : null,
      // Whatever is already stored. No lookup is triggered here.
      coverArtUrl: r.album && r.album.coverArtUrl !== "none" ? r.album.coverArtUrl : null,
    };
  }
  for (const p of textPosts) {
    map[p.id] = {
      kind: "textpost",
      username: p.user ? p.user.username : null,
      text: p.text || "",
    };
  }
  for (const s of mixShares) {
    map[s.id] = {
      kind: "sharemix",
      username: s.user ? s.user.username : null,
      mixId: s.mixId,
      text: s.caption || "",
    };
  }
  return map;
}

// GET /api/activity/:username
router.get("/:username", requireAuth, async (req, res, next) => {
  try {
    const username = String(req.params.username || "").toLowerCase();
    const user = await prisma.user.findUnique({
      where: { username },
      select: { id: true, username: true },
    });
    if (!user) return res.status(404).json({ error: "User not found." });

    const filter = ["reviews", "posts", "likes", "comments"].includes(req.query.filter)
      ? req.query.filter
      : "all";

    const beforeRaw = req.query.before;
    const before = beforeRaw && !isNaN(new Date(beforeRaw)) ? new Date(beforeRaw) : null;
    const olderThan = before ? { createdAt: { lt: before } } : {};

    const wantReviews = filter === "all" || filter === "reviews";
    const wantLikes = filter === "all" || filter === "likes";
    const wantComments = filter === "all" || filter === "comments";
    const wantPosts = filter === "all" || filter === "posts";

    const [reviews, likes, comments, posts, reviewCount, likeCount, commentCount, postCount] = await Promise.all([
      wantReviews
        ? prisma.review.findMany({
            where: { userId: user.id, ...olderThan },
            orderBy: { createdAt: "desc" },
            take: PAGE + 1,
            // Stored album fields only — no Cover Art Archive lookup here.
            include: { album: { select: { title: true, artistName: true, coverArtUrl: true } } },
          })
        : [],
      wantLikes
        ? prisma.reviewReaction.findMany({
            where: { userId: user.id, kind: "heart", ...olderThan },
            orderBy: { createdAt: "desc" },
            take: PAGE + 1,
          })
        : [],
      wantComments
        ? prisma.reviewComment.findMany({
            where: { userId: user.id, ...olderThan },
            orderBy: { createdAt: "desc" },
            take: PAGE + 1,
          })
        : [],
      wantPosts
        ? prisma.textPost.findMany({
            where: { userId: user.id, ...olderThan },
            orderBy: { createdAt: "desc" },
            take: PAGE + 1,
          })
        : [],
      prisma.review.count({ where: { userId: user.id } }),
      prisma.reviewReaction.count({ where: { userId: user.id, kind: "heart" } }),
      prisma.reviewComment.count({ where: { userId: user.id } }),
      prisma.textPost.count({ where: { userId: user.id } }),
    ]);

    const targetIds = [
      ...likes.map((l) => l.reviewId),
      ...comments.map((c) => c.reviewId),
    ];
    const targets = await resolveTargets(targetIds);

    const rows = [];

    for (const rv of reviews) {
      rows.push({
        type: "review",
        id: rv.id,
        date: rv.createdAt,
        rating: rv.rating,
        text: rv.reviewText || "",
        albumId: rv.albumId,
        albumTitle: rv.album ? rv.album.title : null,
        albumArtist: rv.album ? rv.album.artistName : null,
        // Whatever is already stored. No lookup is triggered here.
        coverArtUrl: rv.album && rv.album.coverArtUrl !== "none" ? rv.album.coverArtUrl : null,
      });
    }

    for (const l of likes) {
      const t = targets[l.reviewId];
      if (!t) continue; // target deleted — drop the row
      rows.push({
        type: "like",
        id: l.id,
        date: l.createdAt,
        targetId: l.reviewId,
        target: t,
      });
    }

    for (const c of comments) {
      const t = targets[c.reviewId];
      if (!t) continue;
      rows.push({
        type: "comment",
        id: c.id,
        date: c.createdAt,
        text: c.text,
        targetId: c.reviewId,
        target: t,
      });
    }

    for (const p of posts) {
      rows.push({
        type: "post",
        id: p.id,
        date: p.createdAt,
        text: p.text,
      });
    }

    rows.sort((a, b) => new Date(b.date) - new Date(a.date));
    const page = rows.slice(0, PAGE);
    // "Has more" is based on the raw fetched arrays (each capped at PAGE+1),
    // not on `rows`: rows whose target was deleted get dropped above, which
    // can pull the merged length below PAGE and kill pagination early.
    const hasMore =
      reviews.length > PAGE ||
      likes.length > PAGE ||
      comments.length > PAGE ||
      posts.length > PAGE ||
      rows.length > PAGE;
    const nextCursor = hasMore && page.length
      ? page[page.length - 1].date
      : null;

    res.json({
      username: user.username,
      items: page,
      nextCursor,
      counts: { reviews: reviewCount, posts: postCount, likes: likeCount, comments: commentCount },
    });
  } catch (e) { next(e); }
});

module.exports = router;
