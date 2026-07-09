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

router.get("/user/:userId", async (req, res, next) => {
  try {
    const rows = await prisma.listenStatus.findMany({ where: { userId: req.params.userId } });
    const queue = rows.filter((r) => r.status === "want_to_listen").map((r) => r.albumId);
    const listenedCount = rows.filter((r) => r.status === "listened").length;
    res.json({ queue, listenedCount });
  } catch (e) { next(e); }
});

module.exports = router;
