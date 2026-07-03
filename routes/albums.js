const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { getCoverArtUrl } = require("../lib/coverart");

const router = express.Router();

// Words in titles that suggest a release is not a proper studio album --
// live recordings, bootlegs, demos, compilations etc. We de-prioritise
// these in search results so proper albums appear first.
const DEPRIORITIZE_PATTERNS = [
  /\blive\b/i, /\bbootleg\b/i, /\bdemo\b/i, /\brehearsal\b/i,
  /\bconcert\b/i, /\btour\b/i, /\bsampler\b/i, /\btribute\b/i,
  /\bkaraoke\b/i, /\binstrumental version\b/i, /\bacoustic version\b/i,
  /^\d{4}[-/]\d{2}[-/]\d{2}/, // date-prefixed bootleg titles like "1995-03-06: ..."
];

function isDeprioritized(album) {
  if (album.releaseType === "Live" || album.releaseType === "Compilation") return true;
  return DEPRIORITIZE_PATTERNS.some((p) => p.test(album.title));
}

// GET /api/albums?search=radiohead&limit=50
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

  // Fetch more than needed so we can sort by relevance and trim
  const raw = await prisma.album.findMany({
    where,
    take: limit * 6,
    orderBy: [{ releaseYear: "desc" }],
  });

  // Sort: exact artist match first, then exact title match, then proper
  // studio albums before live/bootleg/compilation, then by year desc.
  const s = search.toLowerCase();
  const scored = raw.map((a) => {
    let score = 0;
    const title = (a.title || "").toLowerCase();
    const artist = (a.artistName || "").toLowerCase();
    if (artist === s) score += 100;
    else if (artist.startsWith(s)) score += 60;
    else if (artist.includes(s)) score += 30;
    if (title === s) score += 80;
    else if (title.startsWith(s)) score += 40;
    if (a.releaseType === "Album") score += 20;
    else if (a.releaseType === "EP") score += 10;
    if (isDeprioritized(a)) score -= 50;
    if (a.releaseYear) score += Math.min(a.releaseYear - 1950, 50) * 0.1;
    return { ...a, _score: score };
  });

  scored.sort((a, b) => b._score - a._score);

  res.json({ albums: scored.slice(0, limit) });
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
