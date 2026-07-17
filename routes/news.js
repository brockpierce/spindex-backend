const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();

const ADMIN_USERNAME = "brock";

async function requireAdmin(req, res, next) {
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { username: true } });
  if (!user || user.username !== ADMIN_USERNAME) return res.status(403).json({ error: "Admin only." });
  next();
}

// GET /api/news — latest album of the day + recent interviews
router.get("/", async (req, res, next) => {
  try {
    const [aotd, interviews] = await Promise.all([
      prisma.albumOfTheDay.findFirst({
        orderBy: { date: "desc" },
        include: { album: true, author: { select: { username: true } } },
      }),
      prisma.interview.findMany({
        orderBy: { publishedAt: "desc" },
        take: 10,
        include: { author: { select: { username: true } } },
      }),
    ]);
    res.json({ aotd: aotd || null, interviews });
  } catch (e) { next(e); }
});

// GET /api/news/aotd — all albums of the day
router.get("/aotd", async (req, res, next) => {
  try {
    const items = await prisma.albumOfTheDay.findMany({
      orderBy: { date: "desc" },
      take: 30,
      include: { album: true, author: { select: { username: true } } },
    });
    res.json({ items });
  } catch (e) { next(e); }
});

// POST /api/news/aotd — create album of the day (admin)
router.post("/aotd", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { albumId, staffRating, pullQuote, body, date } = req.body;
    if (!albumId || !staffRating || !pullQuote || !body || !date) {
      return res.status(400).json({ error: "All fields required." });
    }
    const item = await prisma.albumOfTheDay.create({
      data: { albumId, staffRating: parseInt(staffRating), pullQuote, body, date, authorId: req.userId },
      include: { album: true },
    });
    res.status(201).json({ item });
  } catch (e) { next(e); }
});

// PUT /api/news/aotd/:id — edit (admin)
router.put("/aotd/:id", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { staffRating, pullQuote, body, date } = req.body;
    const item = await prisma.albumOfTheDay.update({
      where: { id: req.params.id },
      data: { staffRating: parseInt(staffRating), pullQuote, body, date },
      include: { album: true },
    });
    res.json({ item });
  } catch (e) { next(e); }
});

// DELETE /api/news/aotd/:id (admin)
router.delete("/aotd/:id", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await prisma.albumOfTheDay.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/news/interviews — create interview (admin)
router.post("/interviews", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { title, body, albumIds } = req.body;
    if (!title || !body) return res.status(400).json({ error: "Title and body required." });
    const item = await prisma.interview.create({
      data: { title, body, albumIds: (albumIds || []).join(","), authorId: req.userId },
    });
    res.status(201).json({ item });
  } catch (e) { next(e); }
});

// PUT /api/news/interviews/:id (admin)
router.put("/interviews/:id", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { title, body, albumIds } = req.body;
    const item = await prisma.interview.update({
      where: { id: req.params.id },
      data: { title, body, albumIds: (albumIds || []).join(",") },
    });
    res.json({ item });
  } catch (e) { next(e); }
});

// DELETE /api/news/interviews/:id (admin)
router.delete("/interviews/:id", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await prisma.interview.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
