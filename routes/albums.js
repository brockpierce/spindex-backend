const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { getCoverArtUrl } = require("../lib/coverart");

const router = express.Router();

// Same admin check as tags.js — kept inline here so this file has no
// new dependencies. If you promote another user to admin later, edit
// both files or move this to a shared middleware.
const ADMIN_USERNAME = "brock";
async function requireAdmin(req, res, next) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { username: true } });
    if (!user || user.username !== ADMIN_USERNAME) {
      return res.status(403).json({ error: "Admin only." });
    }
    next();
  } catch (e) {
    return res.status(500).json({ error: "Auth check failed." });
  }
}

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

// GET /api/albums/by-artist/:artistName
// Returns all albums by an artist, sorted by release year.
router.get("/by-artist/:artistName", async (req, res, next) => {
  try {
    const artistName = decodeURIComponent(req.params.artistName);

    // Find albums matching this exact artistName (case-sensitive on SQLite)
    const albums = await prisma.album.findMany({
      where: { artistName },
      orderBy: [{ releaseYear: "asc" }, { title: "asc" }],
    });

    // Also fetch English aliases for this artist
    const aliases = await prisma.artistAlias.findMany({
      where: { artistName, locale: "en" },
      select: { alias: true },
      distinct: ["alias"],
      take: 5,
    });

    res.json({ albums, artistName, aliases: aliases.map((a) => a.alias) });
  } catch (e) { next(e); }
});

// GET /api/albums/trending -- curated list of featured albums
const CURATED_TRENDING_IDS = [
  "nirosta-my-skyscraper",      // MY SKYSCRAPER - Nirosta Steel
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
               a.coverArtUrl, a.musicbrainzId, a.mbRatingCount,
               (SELECT GROUP_CONCAT(al.alias, '|||') FROM ArtistAlias al WHERE al.artistName = a.artistName) as _aliases
        FROM album_fts f
        INNER JOIN Album a ON a.id = f.id
        WHERE album_fts MATCH ?
        ORDER BY a.mbRatingCount DESC
        LIMIT ?
      `, ftsQuery, limit * 3);
      raw = ftsResults;
    } catch (ftsErr) {
      console.error("FTS search failed, falling back:", ftsErr.message);
      raw = [];
    }
    // Search manually added albums directly (small table subset, fast)
    try {
      const directResults = await prisma.album.findMany({
        where: {
          createdByUserId: { not: null },
        },
        select: { id: true, title: true, artistName: true, releaseYear: true, releaseType: true, coverArtUrl: true, musicbrainzId: true, mbRatingCount: true },
      });
      const sl = search.toLowerCase();
      const matched = directResults.filter((a) =>
        a.title.toLowerCase().includes(sl) || a.artistName.toLowerCase().includes(sl)
      );
      if (matched.length > 0) {
        const existingIds = new Set(raw.map((r) => r.id));
        raw = [...raw, ...matched.filter((r) => !existingIds.has(r.id))];
      }
    } catch (e) { /* non-fatal */ }
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
      const aliases = ((a._aliases || "").toLowerCase()).split("|||").filter(Boolean);

      // Artist name matching -- by far the strongest signal
      if (artist === s) score += 300;
      else if (artist.startsWith(s)) score += 200;
      else if (artist.includes(s)) score += 100;

      // Alias matching -- treats a strong alias hit as if the artist matched,
      // but weighted a hair lower since aliases can be fuzzier.
      let bestAliasScore = 0;
      for (const al of aliases) {
        if (al === s) { bestAliasScore = Math.max(bestAliasScore, 260); break; }
        if (al.startsWith(s)) bestAliasScore = Math.max(bestAliasScore, 170);
        else if (al.includes(s)) bestAliasScore = Math.max(bestAliasScore, 80);
      }
      score += bestAliasScore;

      // Consider the artist "matching" if either the primary name or an alias
      // includes the search string -- lets the title-scoring below fire on
      // romanized queries too.
      const artistMatches = artist.includes(s) || aliases.some((al) => al.includes(s));

      // Title matching -- only boost if artist also matches
      // This prevents "The Beatles Story" outranking Abbey Road
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
  // Strip the internal fields before returning
  const results = scored.slice(0, limit).map(({ _score, _aliases, ...rest }) => rest);
  res.json({ albums: results });
});

// GET /api/albums/:id/tags -- read-only, public
// Defined BEFORE /:id so Express matches this more specific route first.
router.get("/:id/tags", async (req, res, next) => {
  try {
    const rows = await prisma.albumTag.findMany({
      where: { albumId: req.params.id },
      select: { tag: true },
      orderBy: { tag: "asc" },
    });
    res.json({ tags: rows.map((r) => r.tag) });
  } catch (e) { next(e); }
});

// PUT /api/albums/:id/tags -- replace the tag list for one album.
// Admin-only. Body: { tags: string[] }
router.put("/:id/tags", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const incoming = Array.isArray(req.body.tags) ? req.body.tags : [];

    // Normalize: trim + lowercase, drop empties, cap length at 30, dedupe
    const normalized = [...new Set(
      incoming
        .filter((t) => typeof t === "string")
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0 && t.length <= 30)
    )];

    // Confirm album exists so we return 404 instead of silently doing nothing
    const album = await prisma.album.findUnique({ where: { id }, select: { id: true } });
    if (!album) return res.status(404).json({ error: "Album not found." });

    // Replace: delete existing, insert new. In a transaction so we don't
    // end up with a half-applied list on failure.
    await prisma.$transaction([
      prisma.albumTag.deleteMany({ where: { albumId: id } }),
      ...normalized.map((tag) =>
        prisma.albumTag.create({
          data: { albumId: id, tag, createdByUserId: req.userId },
        })
      ),
    ]);

    res.json({ tags: normalized });
  } catch (e) { next(e); }
});

// GET /api/albums/:id
// Resolves cover art lazily on first view -- see lib/coverart.js for why.
router.get("/:id", async (req, res) => {
  const album = await prisma.album.findUnique({ where: { id: req.params.id } });
  if (!album) return res.status(404).json({ error: "Album not found." });

  if (!album.coverArtUrl && album.musicbrainzId) {
    const result = await getCoverArtUrl(album.musicbrainzId);
    // Only cache a definitive answer -- if CAA timed out or errored,
    // leave coverArtUrl as null so a future view retries.
    if (result.confirmed) {
      const updated = await prisma.album.update({
        where: { id: album.id },
        data: { coverArtUrl: result.url || "none" },
      });
      return res.json({ album: updated });
    }
    // Transient failure: return album as-is (null coverArtUrl), retry later.
    return res.json({ album });
  }

  res.json({ album });
});

// POST /api/albums
// Manual album creation for anything MusicBrainz doesn't have.
router.post("/", requireAuth, async (req, res, next) => {
  try {
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

    // Insert into FTS index so the album is immediately searchable.
    // Aliases are empty for manually added albums; they can be added later
    // if the artist alias import runs and finds a match.
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM album_fts WHERE id = ?`, album.id);
      await prisma.$executeRawUnsafe(
        `INSERT INTO album_fts(id, title, artistName, aliases) VALUES (?, ?, ?, '')`,
        album.id, album.title, album.artistName
      );
    } catch (ftsErr) {
      console.error("FTS insert failed for new album:", ftsErr.message);
    }

    res.status(201).json({ album });
  } catch (e) { next(e); }
});

// PUT /api/albums/:id/cover -- admin only, stores a base64 data URL as cover art
router.put("/:id/cover", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { coverDataUrl } = req.body;
    if (!coverDataUrl || !coverDataUrl.startsWith("data:image/")) {
      return res.status(400).json({ error: "Valid image data URL required." });
    }
    const album = await prisma.album.update({
      where: { id: req.params.id },
      data: { coverArtUrl: coverDataUrl },
    });
    res.json({ album });
  } catch (e) { next(e); }
});

module.exports = router;
