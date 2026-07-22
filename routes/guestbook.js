const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/guestbook/:username — list entries (public)
router.get("/:username", async (req, res) => {
  try {
    const entries = await prisma.guestbookEntry.findMany({
      where: { profileUsername: req.params.username.toLowerCase() },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ entries });
  } catch (e) {
    console.error("guestbook list error", e);
    res.status(500).json({ error: "Failed to load guestbook" });
  }
});

// POST /api/guestbook/:username — sign (requires auth)
router.post("/:username", requireAuth, async (req, res) => {
  try {
    const message = (req.body.message || "").trim();
    if (!message) return res.status(400).json({ error: "Message required" });
    if (message.length > 500) return res.status(400).json({ error: "Message too long" });

    const author = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!author) return res.status(401).json({ error: "Not authenticated" });

    const entry = await prisma.guestbookEntry.create({
      data: {
        profileUsername: req.params.username.toLowerCase(),
        authorId: author.id,
        authorName: author.displayName || author.username,
        authorUsername: author.username,
        message,
      },
    });
    res.json({ entry });
  } catch (e) {
    console.error("guestbook sign error", e);
    res.status(500).json({ error: "Failed to sign guestbook" });
  }
});

// DELETE /api/guestbook/:id — delete (only the profile owner)
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const author = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!author) return res.status(401).json({ error: "Not authenticated" });

    const entry = await prisma.guestbookEntry.findUnique({ where: { id: req.params.id } });
    if (!entry) return res.status(404).json({ error: "Not found" });
    if (entry.profileUsername !== author.username.toLowerCase()) {
      return res.status(403).json({ error: "Not authorized" });
    }
    await prisma.guestbookEntry.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    console.error("guestbook delete error", e);
    res.status(500).json({ error: "Failed to delete entry" });
  }
});

module.exports = router;
