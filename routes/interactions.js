const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();

// ============================================================
// REACTIONS
// ============================================================

// GET /api/interactions/reactions/:reviewId
// Returns { heart: [username, ...], frown: [username, ...] }
router.get("/reactions/:reviewId", async (req, res, next) => {
  try {
    const reactions = await prisma.reviewReaction.findMany({
      where: { reviewId: req.params.reviewId },
      include: { user: { select: { username: true } } },
    });
    const heart = reactions.filter((r) => r.kind === "heart").map((r) => r.user.username);
    const frown = reactions.filter((r) => r.kind === "frown").map((r) => r.user.username);
    res.json({ heart, frown });
  } catch (e) { next(e); }
});

// PUT /api/interactions/reactions/:reviewId
// Body: { kind: "heart" | "frown" }
// Toggles: if same kind exists, removes it. If different kind, switches.
router.put("/reactions/:reviewId", requireAuth, async (req, res, next) => {
  try {
    const { reviewId } = req.params;
    const { kind } = req.body;
    if (!["heart", "frown"].includes(kind)) {
      return res.status(400).json({ error: "kind must be 'heart' or 'frown'" });
    }

    const existing = await prisma.reviewReaction.findUnique({
      where: { reviewId_userId: { reviewId, userId: req.userId } },
    });

    if (existing) {
      if (existing.kind === kind) {
        // Same reaction — remove it (toggle off)
        await prisma.reviewReaction.delete({ where: { id: existing.id } });
      } else {
        // Different reaction — switch
        await prisma.reviewReaction.update({ where: { id: existing.id }, data: { kind } });
      }
    } else {
      // No existing reaction — create
      await prisma.reviewReaction.create({ data: { reviewId, userId: req.userId, kind } });
    }

    // Return updated state
    const reactions = await prisma.reviewReaction.findMany({
      where: { reviewId },
      include: { user: { select: { username: true } } },
    });
    const heart = reactions.filter((r) => r.kind === "heart").map((r) => r.user.username);
    const frown = reactions.filter((r) => r.kind === "frown").map((r) => r.user.username);
    res.json({ heart, frown });
  } catch (e) { next(e); }
});

// ============================================================
// COMMENTS
// ============================================================

// Helper: build a nested tree from flat comment rows
function buildCommentTree(comments) {
  const map = {};
  const roots = [];
  comments.forEach((c) => {
    map[c.id] = {
      id: c.id,
      username: c.user.username,
      text: c.text,
      date: c.createdAt,
      parentId: c.parentId,
      replies: [],
    };
  });
  comments.forEach((c) => {
    if (c.parentId && map[c.parentId]) {
      map[c.parentId].replies.push(map[c.id]);
    } else {
      roots.push(map[c.id]);
    }
  });
  return roots;
}

// GET /api/interactions/comments/:reviewId
// Returns nested comment tree
router.get("/comments/:reviewId", async (req, res, next) => {
  try {
    const comments = await prisma.reviewComment.findMany({
      where: { reviewId: req.params.reviewId },
      include: { user: { select: { username: true } } },
      orderBy: { createdAt: "asc" },
    });
    res.json({ comments: buildCommentTree(comments) });
  } catch (e) { next(e); }
});

// POST /api/interactions/comments/:reviewId
// Body: { text, parentId? }
// Creates a top-level comment (parentId omitted) or a reply (parentId set).
router.post("/comments/:reviewId", requireAuth, async (req, res, next) => {
  try {
    const { reviewId } = req.params;
    const { text, parentId } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Comment text required." });
    }

    // Verify review exists
    const review = await prisma.review.findUnique({ where: { id: reviewId } });
    if (!review) return res.status(404).json({ error: "Review not found." });

    // If parentId is provided, verify parent comment exists and belongs to same review
    if (parentId) {
      const parent = await prisma.reviewComment.findUnique({ where: { id: parentId } });
      if (!parent || parent.reviewId !== reviewId) {
        return res.status(400).json({ error: "Invalid parent comment." });
      }
    }

    const comment = await prisma.reviewComment.create({
      data: {
        reviewId,
        userId: req.userId,
        text: text.trim(),
        parentId: parentId || null,
      },
      include: { user: { select: { username: true } } },
    });

    res.status(201).json({
      comment: {
        id: comment.id,
        username: comment.user.username,
        text: comment.text,
        date: comment.createdAt,
        parentId: comment.parentId,
        replies: [],
      },
    });
  } catch (e) { next(e); }
});

module.exports = router;
