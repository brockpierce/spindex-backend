const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();

// POST /api/devices  { token, platform } — register (or move) a push token to
// the current user. Idempotent: re-registering the same token just updates it.
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const { token, platform } = req.body;
    if (!token || typeof token !== "string") return res.status(400).json({ error: "token required" });
    const device = await prisma.device.upsert({
      where: { token },
      update: { userId: req.userId, platform: platform || "ios" },
      create: { token, userId: req.userId, platform: platform || "ios" },
    });
    res.json({ ok: true, id: device.id });
  } catch (e) { next(e); }
});

// DELETE /api/devices/:token — unregister (logout / push disabled).
router.delete("/:token", requireAuth, async (req, res, next) => {
  try {
    await prisma.device.deleteMany({ where: { token: req.params.token, userId: req.userId } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
