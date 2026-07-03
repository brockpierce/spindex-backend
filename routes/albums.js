const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { getCoverArtUrl } = require("../lib/coverart");

const router = express.Router();

// Words/patterns in titles that indicate a release we want to exclude
// entirely from search results -- bootlegs, live recordings, unofficial
// releases, date-stamped recordings, etc.
const EXCLUDE_TITLE_PATTERNS = [
  /\bbootleg\b/i,
  /\blive\b/i,
  /\brehearsal\b/i,
  /\bconcert\b/i,
  /\bin concert\b/i,
  /\bat the\b/i,
  /\bat [a-z]/i,
  /\bkaraoke\b/i,
  /^\d{4}[-/.]\d{2}[-/.]\d{2}/,
  /^\d{2}[-/.]\d{2}[-/.]\d{4}/,
  /\d{4}-\d{2}-\d{2}/,
  /:\s+[A-Z][a-z]+.*,/,
  /\bunofficial\b/i,
  /\bpirate\b/i,
  /\bdemo tape\b/i,
  /\bpromo\b/i,
  /\blive recording\b/i,
  /\blive at\b/i,
  /\blive in\b/i,
  /\blive from\b/i,
  /\brecorded live\b/i,
];

const EXCLUDE_TYPES = new Set(["Live", "Bootleg"]);

function shouldExclude(album) {
  if (EXCLUDE_TYPES.has(album.releaseType)) return true;
  return EXCLUDE_TITLE_PATTERNS.some((p) => p.test(album.title));
}

// Words in titles that suggest lower quality but we still show them,
// just deprioritised below proper studio albums and EPs.
const DEPRIORITIZE_PATTERNS = [
  /\bcompilation\b/i,
  /\btribute\b/i,
  /\bsampler\b/i,
  /\bcollection\b/i,
  /\bbest of\b/i,
  /\bgreatest hits\b/i,
  /\binstrumental version\b/i,
  /\bacoustic version\b/i,
  /various artists/i,
  /\banthology\b/i,
  /\bsingles\b/i,
  /\brarities\b/i,
];

function isDeprioritized(album) {
  if (album.releaseType === "Compilation") return true;
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

  // Fetch more than needed so we can filter and sort by relevance
  const raw = await prisma.album.findMany({
    where,
    take: limit * 3,
    orderBy: [{ mbRatingCount: "desc" }],
  });

  const s = search.toLowerCase();
  const scored = raw
    .filter((a) => !shouldExclude(a))
    .map((a) => {
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
      if (isDeprioritized(a)) score -= 30;
      // Boost by MusicBrainz rating vote count -- more votes = more well-known
      if (a.mbRatingCount) score += Math.min(a.mbRatingCount, 500) * 0.1;
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
