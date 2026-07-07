const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();

// ============================================================
// REACTIONS
// ============================================================

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
        await prisma.reviewReaction.delete({ where: { id: existing.id } });
      } else {
        await prisma.reviewReaction.update({ where: { id: existing.id }, data: { kind } });
      }
    } else {
      await prisma.reviewReaction.create({ data: { reviewId, userId: req.userId, kind } });

      // Notify review owner (only on new reaction, not toggle-off)
      try {
        const review = await prisma.review.findUnique({ where: { id: reviewId }, select: { userId: true } });
        if (review && review.userId !== req.userId) {
          await prisma.notification.create({
            data: {
              recipientId: review.userId,
              actorId: req.userId,
              type: "reaction",
              referenceId: reviewId,
            },
          });
        }
      } catch (notifErr) {
        console.error("reaction notification error:", notifErr.message);
      }
    }

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

router.post("/comments/:reviewId", requireAuth, async (req, res, next) => {
  try {
    const { reviewId } = req.params;
    const { text, parentId } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Comment text required." });
    }

    // Allow comments on both Review and TextPost — look up both
    const review = await prisma.review.findUnique({ where: { id: reviewId } });
    const textPost = !review ? await prisma.textPost.findUnique({ where: { id: reviewId }, select: { id: true, userId: true } }) : null;
    if (!review && !textPost) return res.status(404).json({ error: "Post not found." });
    const ownerId = review ? review.userId : textPost.userId;

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

    // Notify post owner
    try {
      if (ownerId !== req.userId) {
        await prisma.notification.create({
          data: {
            recipientId: ownerId,
            actorId: req.userId,
            type: parentId ? "reply" : "comment",
            referenceId: reviewId,
          },
        });
      }
      if (parentId) {
        const parentComment = await prisma.reviewComment.findUnique({ where: { id: parentId } });
        if (parentComment && parentComment.userId !== req.userId && parentComment.userId !== ownerId) {
          await prisma.notification.create({
            data: {
              recipientId: parentComment.userId,
              actorId: req.userId,
              type: "reply",
              referenceId: reviewId,
            },
          });
        }
      }
    } catch (notifErr) {
      console.error("comment notification error:", notifErr.message);
    }

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
