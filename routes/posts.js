const express = require("express");
const rateLimit = require("express-rate-limit");
const prisma = require("../lib/prisma");
const { notifyMentions } = require("../lib/notifyMentions");
const { requireAuth } = require("../middleware/auth");
const { validateImageDataUrl } = require("../lib/imageValidation");
const router = express.Router();

const MAX_IMAGES = 3;
const POST_IMAGE_MAX_BYTES = 500 * 1024; // 500 KB per image (client compresses to less)

// Image metadata only — never the `data` blob. Used by list responses.
const IMAGE_META_SELECT = { position: true, width: true, height: true };

// Per-user throttle on post creation (images make each one expensive). Mounted
// after requireAuth so req.userId is set for the key.
const postCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId || req.ip,
  message: { error: "You're posting too fast. Please wait a bit and try again." },
});

// GET /api/posts — current user's text posts (metadata only, no image bytes)
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const posts = await prisma.textPost.findMany({
      where: { userId: req.userId },
      include: {
        user: { select: { username: true, displayName: true, avatarUrl: true } },
        images: { select: IMAGE_META_SELECT, orderBy: { position: "asc" } },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json({ posts: posts.map((p) => ({ ...p, imageCount: p.images.length })) });
  } catch (e) { next(e); }
});

// POST /api/posts — create a text post with 0-3 optional images
router.post("/", requireAuth, postCreateLimiter, async (req, res, next) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Post text required." });
    }

    // Validate images: optional, max 3, each an allowed image data URL under cap.
    // Accepts either a bare data-URL string or { data, width, height }.
    const rawImages = Array.isArray(req.body.images) ? req.body.images : [];
    if (rawImages.length > MAX_IMAGES) {
      return res.status(400).json({ error: `A post can have at most ${MAX_IMAGES} images.` });
    }
    const images = [];
    for (let i = 0; i < rawImages.length; i++) {
      const img = rawImages[i];
      const data = typeof img === "string" ? img : (img && img.data);
      const err = validateImageDataUrl(data, POST_IMAGE_MAX_BYTES);
      if (err) return res.status(400).json({ error: err });
      images.push({
        position: i,
        data,
        width: img && Number.isInteger(img.width) ? img.width : null,
        height: img && Number.isInteger(img.height) ? img.height : null,
      });
    }

    const post = await prisma.textPost.create({
      data: {
        userId: req.userId,
        text: text.trim(),
        images: images.length ? { create: images } : undefined,
      },
      include: {
        user: { select: { username: true, displayName: true, avatarUrl: true } },
        images: { select: IMAGE_META_SELECT, orderBy: { position: "asc" } },
      },
    });
    await notifyMentions(post.text, req.userId, post.id);
    // Return metadata only; the client already holds the images it just uploaded.
    res.status(201).json({ post: { ...post, imageCount: post.images.length } });
  } catch (e) { next(e); }
});

// DELETE /api/posts/:id — delete a text post (and its images)
router.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const post = await prisma.textPost.findUnique({ where: { id: req.params.id } });
    if (!post || post.userId !== req.userId) {
      return res.status(404).json({ error: "Post not found." });
    }
    // Explicit image delete in addition to the onDelete: Cascade FK — the manual
    // schema apply means we don't want to rely on FK enforcement being on.
    await prisma.textPostImage.deleteMany({ where: { textPostId: req.params.id } });
    await prisma.textPost.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/posts/:id — single text post WITH full image data (post detail view).
// The only route that returns image bytes.
router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const post = await prisma.textPost.findUnique({
      where: { id: req.params.id },
      include: {
        user: { select: { username: true } },
        images: { select: { id: true, position: true, data: true, width: true, height: true }, orderBy: { position: "asc" } },
      },
    });
    if (!post) return res.status(404).json({ error: "Post not found." });
    res.json({ post: {
      id: post.id,
      username: post.user ? post.user.username : null,
      text: post.text,
      date: post.createdAt,
      images: post.images,
    } });
  } catch (e) { next(e); }
});

module.exports = router;
