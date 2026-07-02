const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { getCoverArtUrl } = require("../lib/coverart");

const router = express.Router();

// GET /api/albums?search=radiohead&limit=50
// Powers the Browse page. With no ?search, returns recent/trending-ish
// albums (we don't have real trending logic yet -- see note below).
router.get("/", async (req, res) => {
  const search = (req.query.search || "").trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

  const where = search
    ? {
        OR: [
          { title: { contains: search } },
          { artistName: { contains: search } },
        ],
      }
    : {};

  const albums = await prisma.album.findMany({
    where,
    take: limit,
    orderBy: search ? { title: "asc" } : { createdAt: "desc" },
  });

  res.json({ albums });
});

// GET /api/albums/:id
// Resolves cover art lazily on first view -- see lib/coverart.js for why.
router.get("/:id", async (req, res) => {
  const album = await prisma.album.findUnique({ where: { id: req.params.id } });
  if (!album) return res.status(404).json({ error: "Album not found." });

  if (!album.coverArtUrl && album.musicbrainzId) {
    const url = await getCoverArtUrl(album.musicbrainzId);
    const updated = await prisma.album.update({
      where: { id: album.id },
      // Store the literal string "none" rather than leaving it null, so we
      // remember "we checked and there isn't one" and don't re-fetch on
      // every single future view of an album with no cover art.
      data: { coverArtUrl: url || "none" },
    });
    return res.json({ album: updated });
  }

  res.json({ album });
});

// POST /api/albums
// Manual album creation for anything MusicBrainz doesn't have.
router.post("/", requireAuth, async (req, res) => {
  const { title, artistName, releaseYear, releaseType } = req.body;
  if (!title || !artistName) {
    return res.status(400).json({ error: "Title and artist name are required." });
  }

  const album = await prisma.album.create({
    data: {
      title,
      artistName,
      releaseYear: releaseYear || null,
      releaseType: releaseType || "Album",
      createdByUserId: req.session.userId,
    },
  });
  res.status(201).json({ album });
});

module.exports = router;
