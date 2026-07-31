/**
 * Live MusicBrainz search fallback.
 *
 * When local FTS search returns thin results, query the live MusicBrainz API
 * for the term, insert any new release-groups into our Album table (and the
 * album_fts index), so the catalog self-heals: each album is fetched from
 * MusicBrainz at most once, then served locally forever after.
 *
 * SAFETY: every path fails soft. A slow/broken MusicBrainz never blocks or
 * breaks local search -- searchAndCache() returns [] on any error/timeout,
 * and the caller simply proceeds with whatever local results it had.
 */
const prisma = require("./prisma");

// Match the import script's contact UA convention (MB asks for a real UA).
const USER_AGENT = "noteblock/1.0 ( contact@mynoteblock.com )";
const MB_TIMEOUT_MS = 4000;

function extractArtistName(artistCredit) {
  if (!Array.isArray(artistCredit) || artistCredit.length === 0) return "Unknown Artist";
  return artistCredit.map((c) => (c.name || "") + (c.joinphrase || "")).join("").trim() || "Unknown Artist";
}

function extractYear(firstReleaseDate) {
  if (!firstReleaseDate) return null;
  const m = /^(\d{4})/.exec(firstReleaseDate);
  return m ? parseInt(m[1], 10) : null;
}

// Query MusicBrainz release-groups. Returns parsed candidate albums (or []).
async function queryMusicBrainz(term) {
  const url = `https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(term)}&fmt=json&limit=8`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MB_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, "Accept": "application/json" },
    });
    clearTimeout(timeout);
    if (!resp.ok) return [];
    const data = await resp.json();
    const groups = Array.isArray(data["release-groups"]) ? data["release-groups"] : [];
    // Keep only Album/EP primary types, mirror the import script's shape.
    return groups
      .filter((g) => {
        const pt = g["primary-type"];
        return pt === "Album" || pt === "EP";
      })
      .map((g) => ({
        musicbrainzId: g.id,
        title: g.title || "Untitled",
        artistName: extractArtistName(g["artist-credit"]),
        releaseYear: extractYear(g["first-release-date"]),
        releaseType: g["primary-type"] || "Album",
        mbRatingCount: 0,
      }))
      .filter((a) => a.musicbrainzId && a.title);
  } catch (e) {
    clearTimeout(timeout);
    console.warn("MB search failed for", JSON.stringify(term), "-", e.message);
    return [];
  }
}

// Insert new albums (skip ones already in DB by musicbrainzId), keep album_fts
// in sync, and return the rows that were actually inserted (in Album shape).
async function insertNewAlbums(candidates) {
  if (!candidates.length) return [];
  const ids = candidates.map((c) => c.musicbrainzId);
  const existing = await prisma.album.findMany({
    where: { musicbrainzId: { in: ids } },
    select: { musicbrainzId: true },
  });
  const existingSet = new Set(existing.map((e) => e.musicbrainzId));
  const toInsert = candidates.filter((c) => !existingSet.has(c.musicbrainzId));
  if (!toInsert.length) return [];

  const inserted = [];
  for (const a of toInsert) {
    try {
      const row = await prisma.album.create({
        data: {
          title: a.title,
          artistName: a.artistName,
          releaseYear: a.releaseYear,
          releaseType: a.releaseType,
          musicbrainzId: a.musicbrainzId,
          mbRatingCount: a.mbRatingCount,
        },
      });
      // Keep the FTS index in sync (standalone fts5 table, no triggers).
      await prisma.$executeRawUnsafe(
        `INSERT INTO album_fts (id, title, artistName, aliases) VALUES (?, ?, ?, ?)`,
        row.id, row.title, row.artistName, ""
      );
      inserted.push(row);
    } catch (e) {
      // Unique-constraint race or FTS hiccup -- skip this one, keep going.
      console.warn("MB insert skipped for", a.musicbrainzId, "-", e.message);
    }
  }
  return inserted;
}

// Public entry: search MB for `term`, cache new albums, return inserted rows.
// Always resolves (never throws) -- returns [] on any failure.
async function searchAndCache(term) {
  try {
    const candidates = await queryMusicBrainz(term);
    if (!candidates.length) return [];
    return await insertNewAlbums(candidates);
  } catch (e) {
    console.warn("searchAndCache failed:", e.message);
    return [];
  }
}

module.exports = { searchAndCache };
