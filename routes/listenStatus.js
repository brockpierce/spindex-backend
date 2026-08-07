const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();

router.put("/:albumId", requireAuth, async (req, res, next) => {
  try {
    const { albumId } = req.params;
    const { status } = req.body;
    const validStatuses = ["listened", "want_to_listen"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status." });
    }
    // The album must exist or the upsert violates the foreign key. Happens
    // when an id comes from a search result that was never persisted.
    const albumRow = await prisma.album.findUnique({ where: { id: albumId }, select: { id: true } });
    if (!albumRow) return res.status(404).json({ error: "Album not found." });

    const ls = await prisma.listenStatus.upsert({
      where: { userId_albumId: { userId: req.userId, albumId } },
      update: { status },
      create: { userId: req.userId, albumId, status },
    });
    res.json({ listenStatus: ls });
  } catch (e) { next(e); }
});

router.delete("/:albumId", requireAuth, async (req, res, next) => {
  try {
    await prisma.listenStatus.deleteMany({ where: { userId: req.userId, albumId: req.params.albumId } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const rows = await prisma.listenStatus.findMany({ where: { userId: req.userId } });
    const listenStatus = {};
    rows.forEach((r) => { listenStatus[r.albumId] = r.status; });
    res.json({ listenStatus });
  } catch (e) { next(e); }
});

// GET /api/listen-status/user/:userId — public listened/queue lists + count for
// another user's profile. Returns the album-id lists so the profile can render
// the listened grid and the "queued" section, plus the count for the stat.
router.get("/user/:userId", async (req, res, next) => {
  try {
    const rows = await prisma.listenStatus.findMany({
      where: { userId: req.params.userId },
      select: { albumId: true, status: true },
    });
    const listened = rows.filter((r) => r.status === "listened").map((r) => r.albumId);
    const queue = rows.filter((r) => r.status === "want_to_listen").map((r) => r.albumId);
    res.json({ listenedCount: listened.length, listened, queue });
  } catch (e) { next(e); }
});

module.exports = router;
