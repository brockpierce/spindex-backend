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

// GET /api/albums/trending -- curated list of featured albums
const CURATED_TRENDING_IDS = [
  "cmr6y5svsiouw4tlqfgyan220", // you seem pretty sad for a girl so in love - Olivia Rodrigo
  "cmr6y4umrhw404tlqq6pozq4m", // U - underscores
  "cmr6y6xbrjn164tlqesf4mcad", // Magazine - YHWH Nailgun
  "cmr6y6sdrjir74tlqtyutyd3g", // Terrified . - fakemink
  "cmr6y6qx5jhbn4tlqj84dicy6", // Detour - Kim Petras
  "cmr6y58qmi80s4tlq4m9v9n5s", // Beauty Land - Greg Mendez
  "cmr6y5mh2ijjz4tlql558m132", // Forever - Hekt
  "cmr6xbsbisnvr4tlqi4tegfh9", // Ricky Music - Porches
  "cmr6xjgshzgi24tlqp4ryy41b", // Warm Chris - Aldous Harding
  "cmr6wi1w50xv94tlq8plkx96h", // Transatlanticism - Death Cab for Cutie
];

router.get("/trending", async (req, res, next) => {
  try {
    const albums = await prisma.album.findMany({
      where: { id: { in: CURATED_TRENDING_IDS } },
    });
    // Preserve the curated order
    const ordered = CURATED_TRENDING_IDS.map((id) => albums.find((a) => a.id === id)).filter(Boolean);
    res.json({ albums: ordered });
  } catch (e) { next(e); }
});


router.get("/", async (req, res) => {
  const search = (req.query.search || "").trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

  let raw = [];

  if (search) {
    try {
      const ftsQuery = search.replace(/['"*^]/g, " ").trim() + "*";
      const ftsResults = await prisma.$queryRawUnsafe(`
        SELECT a.id, a.title, a.artistName, a.releaseYear, a.releaseType,
               a.coverArtUrl, a.musicbrainzId, a.mbRatingCount
        FROM album_fts f
        INNER JOIN Album a ON a.id = f.id
        WHERE album_fts MATCH ?
        ORDER BY a.mbRatingCount DESC
        LIMIT ?
      `, ftsQuery, limit * 3);
      raw = ftsResults;
    } catch (ftsErr) {
      console.error("FTS search failed, falling back:", ftsErr.message);
      raw = await prisma.album.findMany({
        where: {
          OR: [
            { title: { contains: search } },
            { artistName: { contains: search } },
          ],
        },
        take: limit * 3,
        orderBy: [{ mbRatingCount: "desc" }],
      });
    }
  } else {
    raw = await prisma.album.findMany({
      take: limit,
      orderBy: [{ mbRatingCount: "desc" }],
    });
  }

  if (!search) return res.json({ albums: raw });

  const s = search.toLowerCase();
  const scored = raw
    .filter((a) => !shouldExclude(a))
    .map((a) => {
      let score = 0;
      const title = (a.title || "").toLowerCase();
      const artist = (a.artistName || "").toLowerCase();

      // Artist name matching -- by far the strongest signal
      if (artist === s) score += 300;
      else if (artist.startsWith(s)) score += 200;
      else if (artist.includes(s)) score += 100;

      // Title matching -- only boost if artist also matches
      // This prevents "The Beatles Story" outranking Abbey Road
      const artistMatches = artist.includes(s);
      if (title === s) score += artistMatches ? 80 : 20;
      else if (title.startsWith(s)) score += artistMatches ? 40 : 10;
      else if (title.includes(s)) score += artistMatches ? 20 : 5;

      // If search term is in title but artist doesn't match at all,
      // heavily penalize -- these are usually compilations or tributes
      if (!artistMatches && (title.includes(s))) score -= 60;

      if (a.releaseType === "Album") score += 20;
      else if (a.releaseType === "EP") score += 10;
      if (isDeprioritized(a)) score -= 30;
      if (a.mbRatingCount) score += Math.min(a.mbRatingCount, 200) * 0.1;
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
      createdByUserId: req.userId,
    },
  });
  res.status(201).json({ album });
});

module.exports = router;
