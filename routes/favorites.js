const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const MAX_FAVORITES = 4;

// GET /api/favorites/me
router.get("/me", requireAuth, async (req, res) => {
  const favorites = await prisma.favorite.findMany({
    where: { userId: req.userId },
    orderBy: { position: "asc" },
  });
  res.json({ favorites });
});

// POST /api/favorites/:albumId
// Enforces the 4-favorite limit server-side too -- the frontend already
// checks this for a snappy UI, but the server is the real gatekeeper,
// since a client check alone can always be bypassed.
router.post("/:albumId", requireAuth, async (req, res) => {
  const { albumId } = req.params;

  const existing = await prisma.favorite.findMany({ where: { userId: req.userId } });
  if (existing.some((f) => f.albumId === albumId)) {
    return res.status(409).json({ error: "Already favorited." });
  }
  if (existing.length >= MAX_FAVORITES) {
    return res.status(400).json({ error: `You can only have ${MAX_FAVORITES} favorite albums. Remove one first.` });
  }

  const favorite = await prisma.favorite.create({
    data: { userId: req.userId, albumId, position: existing.length + 1 },
  });
  res.status(201).json({ favorite });
});

// DELETE /api/favorites/:albumId
router.delete("/:albumId", requireAuth, async (req, res) => {
  await prisma.favorite.deleteMany({ where: { userId: req.userId, albumId: req.params.albumId } });
  res.json({ ok: true });
});

module.exports = router;
