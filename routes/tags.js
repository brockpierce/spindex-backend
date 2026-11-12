const express = require("express");
const prisma = require("../lib/prisma");
const { withCachedCover } = require("../lib/covercache");
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

// GET /api/tags/search?q=... — tags matching a query, most-used first. Powers
// searching by tag from the browse search box.
router.get("/search", async (req, res, next) => {
  try {
    const q = (req.query.q || "").trim().toLowerCase();
    if (q.length < 2) return res.json({ tags: [] });
    const groups = await prisma.albumTag.groupBy({
      by: ["tag"],
      where: { tag: { contains: q } },
      _count: { tag: true },
      orderBy: { _count: { tag: "desc" } },
      take: 12,
    });
    res.json({ tags: groups.map((g) => g.tag) });
  } catch (e) { next(e); }
});

// GET /api/tags/:tag/albums?offset=0&limit=48&decade=1990
// One page of albums with this tag, newest-tagged first. The tag page loads the
// next page on "show more", so a tag can hold any number of albums without one
// request loading them all into memory.
//   -> { albums, total, nextOffset (null at the end), decades (first page only) }
const TAG_PAGE_DEFAULT = 48;
const TAG_PAGE_MAX = 100;
router.get("/:tag/albums", async (req, res, next) => {
  try {
    const tag = (req.params.tag || "").trim().toLowerCase();
    if (!tag) return res.json({ albums: [], total: 0, nextOffset: null, decades: [] });

    const n = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(n) && n > 0 ? Math.min(n, TAG_PAGE_MAX) : TAG_PAGE_DEFAULT;
    const o = parseInt(req.query.offset, 10);
    const offset = Number.isFinite(o) && o > 0 ? o : 0;
    // Decade filter runs here (not in the client) since the client only holds
    // the pages it has loaded.
    const d = parseInt(req.query.decade, 10);
    const decade = Number.isFinite(d) && d % 10 === 0 ? d : null;
    const where = decade ? { tag, album: { releaseYear: { gte: decade, lte: decade + 9 } } } : { tag };

    const [rows, total, decadeRows] = await Promise.all([
      prisma.albumTag.findMany({
        where,
        include: { album: true },
        // id breaks createdAt ties so pages never overlap or skip.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: offset,
        take: limit,
      }),
      prisma.albumTag.count({ where }),
      // Decade chips come from every album with the tag, not just this page.
      offset === 0
        ? prisma.$queryRaw`SELECT DISTINCT (a."releaseYear" / 10) * 10 AS d FROM "AlbumTag" t JOIN "Album" a ON a.id = t."albumId" WHERE t.tag = ${tag} AND a."releaseYear" IS NOT NULL ORDER BY d`
        : null,
    ]);

    // Route covers through our disk cache (like /api/albums) so the tag grid
    // loads them reliably instead of hitting flaky archive.org / hotlinked CDNs.
    const albums = rows.map((r) => r.album).filter(Boolean).map(withCachedCover);
    const nextOffset = offset + rows.length < total ? offset + rows.length : null;
    res.json({
      albums,
      total,
      nextOffset,
      ...(decadeRows ? { decades: decadeRows.map((r) => Number(r.d)) } : {}),
    });
  } catch (e) { next(e); }
});

module.exports = router;
