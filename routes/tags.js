const express = require("express");
const prisma = require("../lib/prisma");
const router = express.Router();

// GET /api/tags/popular?limit=N
// Returns the N most-used tags with their album counts.
// Currently unused by the app (the browse chips are hardcoded), but
// available for future replacement.
router.get("/popular", async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const groups = await prisma.albumTag.groupBy({
      by: ["tag"],
      _count: { tag: true },
      orderBy: { _count: { tag: "desc" } },
      take: limit,
    });
    res.json({
      tags: groups.map((g) => ({ tag: g.tag, count: g._count.tag })),
    });
  } catch (e) { next(e); }
});

// GET /api/tags/:tag/albums
// Return all albums with this tag (paginated). Used by the tag results page.
router.get("/:tag/albums", async (req, res, next) => {
  try {
    const tag = (req.params.tag || "").trim().toLowerCase();
    if (!tag) return res.json({ albums: [] });

    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
    const rows = await prisma.albumTag.findMany({
      where: { tag },
      include: { album: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    // Return the album objects with a normalized shape matching /api/albums
    const albums = rows.map((r) => r.album).filter(Boolean);
    res.json({ albums });
  } catch (e) { next(e); }
});

module.exports = router;
