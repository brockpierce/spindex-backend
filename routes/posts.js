const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();

// GET /api/posts — current user's text posts
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const posts = await prisma.textPost.findMany({
      where: { userId: req.userId },
      include: { user: { select: { username: true, displayName: true, avatarUrl: true } } },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json({ posts });
  } catch (e) { next(e); }
});

// POST /api/posts — create a text post
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Post text required." });
    }
    const post = await prisma.textPost.create({
      data: { userId: req.userId, text: text.trim() },
      include: { user: { select: { username: true, displayName: true, avatarUrl: true } } },
    });
    res.status(201).json({ post });
  } catch (e) { next(e); }
});

// DELETE /api/posts/:id — delete a text post
router.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const post = await prisma.textPost.findUnique({ where: { id: req.params.id } });
    if (!post || post.userId !== req.userId) {
      return res.status(404).json({ error: "Post not found." });
    }
    await prisma.textPost.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
