const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const VALID_STATUSES = ["want_to_listen", "listened"];

// PUT /api/listen-status/:albumId  { status: "want_to_listen" | "listened" }
// Sets the status. To match the demo's "click again to un-set" behavior,
// send the same status twice and it clears (deletes the row) on the
// second call -- the frontend tracks current state and decides which.
router.put("/:albumId", requireAuth, async (req, res, next) => { try {
  const { albumId } = req.params;
  const { status } = req.body;

  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${VALID_STATUSES.join(", ")}` });
  }

  const existing = await prisma.listenStatus.findUnique({
    where: { userId_albumId: { userId: req.userId, albumId } },
  });

  if (existing && existing.status === status) {
    await prisma.listenStatus.delete({ where: { id: existing.id } });
    return res.json({ status: null });
  }

  await prisma.listenStatus.upsert({
    where: { userId_albumId: { userId: req.userId, albumId } },
    update: { status },
    create: { userId: req.userId, albumId, status },
  });

  res.json({ status });
});

// GET /api/listen-status/me
// All of the current user's statuses, as a simple { albumId: status } map
// -- this is the exact shape the demo's `listenStatus` state already uses,
// so swapping it in is a one-line change on the frontend.
router.get("/me", requireAuth, async (req, res, next) => { try {
  const rows = await prisma.listenStatus.findMany({ where: { userId: req.userId } });
  const map = {};
  for (const row of rows) map[row.albumId] = row.status;
  res.json({ listenStatus: map });
});

module.exports = router;
