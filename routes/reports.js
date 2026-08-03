const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { perUserLimiter } = require("../lib/rateLimit");
const router = express.Router();

const TYPES = new Set(["post", "comment", "review", "user"]);
const reportLimiter = perUserLimiter({ windowMs: 60 * 1000, max: 20, message: "You're reporting too fast." });

// POST /api/reports  { targetType, targetId, reason? } — file a report for admin review
router.post("/", requireAuth, reportLimiter, async (req, res, next) => {
  try {
    const { targetType, targetId, reason } = req.body;
    if (!TYPES.has(targetType) || !targetId) {
      return res.status(400).json({ error: "Invalid report." });
    }
    await prisma.report.create({
      data: {
        reporterId: req.userId,
        targetType,
        targetId: String(targetId),
        reason: reason ? String(reason).slice(0, 500) : null,
      },
    });
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
