/**
 * Live MusicBrainz search fallback (v2 - smarter trigger).
 *
 * Fires when the local catalog has no STRONG TITLE MATCH for the search term,
 * even if other albums by the same artist exist. Inserts new release-groups
 * into Album + album_fts so the catalog self-heals (MB hit once per album).
 *
 * SAFETY: every path fails soft -> returns [] on any error/timeout. A slow or
 * broken MusicBrainz never blocks or breaks local search.
 */
const prisma = require("./prisma");

const USER_AGENT = "noteblock/1.0 ( contact@mynoteblock.com )";
const MB_TIMEOUT_MS = 7000;

function extractArtistName(artistCredit) {
  if (!Array.isArray(artistCredit) || artistCredit.length === 0) return "Unknown Artist";
  return artistCredit.map((c) => (c.name || "") + (c.joinphrase || "")).join("").trim() || "Unknown Artist";
}
function extractYear(d) {
  if (!d) return null;
  const m = /^(\d{4})/.exec(d);
  return m ? parseInt(m[1], 10) : null;
}
function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

// Decide whether local results already satisfy the search. Returns true if
// some local album's title (or "artist title") is a strong match for the term.
function hasStrongLocalMatch(term, localRows) {
  const t = norm(term);
  if (!t) return true; // empty search -> don't fire MB
  for (const r of (localRows || [])) {
    const title = norm(r.title);
    const combo = norm((r.artistName || "") + " " + (r.title || ""));
    // Strong match: the search term is essentially the album title, or the
    // title is contained in the term, or the "artist title" combo matches.
    if (title && (title === t || t.includes(title) || title.includes(t))) return true;
    if (combo && (combo.includes(t) || t.includes(combo))) return true;
  }
  return false;
}

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
    return groups
      .filter((g) => { const pt = g["primary-type"]; return pt === "Album" || pt === "EP"; })
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
    console.warn("MB query failed for", JSON.stringify(term), "-", e.message);
    return [];
  }
}

async function insertNewAlbums(candidates) {
  if (!candidates.length) return [];
  const ids = candidates.map((c) => c.musicbrainzId);
  const existing = await prisma.album.findMany({
    where: { musicbrainzId: { in: ids } },
    select: { musicbrainzId: true },
  });
  const have = new Set(existing.map((e) => e.musicbrainzId));
  const toInsert = candidates.filter((c) => !have.has(c.musicbrainzId));
  const inserted = [];
  for (const a of toInsert) {
    try {
      const row = await prisma.album.create({
        data: {
          title: a.title, artistName: a.artistName, releaseYear: a.releaseYear,
          releaseType: a.releaseType, musicbrainzId: a.musicbrainzId, mbRatingCount: a.mbRatingCount,
        },
      });
      await prisma.$executeRawUnsafe(
        `INSERT INTO album_fts (id, title, artistName, aliases) VALUES (?, ?, ?, ?)`,
        row.id, row.title, row.artistName, ""
      );
      inserted.push(row);
    } catch (e) {
      console.warn("MB insert skipped for", a.musicbrainzId, "-", e.message);
    }
  }
  return inserted;
}

// Public entry. Given the search term + the local rows already found, decide
// whether to hit MB, and if so fetch + cache. Always resolves ([] on failure).
async function maybeFetch(term, localRows) {
  try {
    if (hasStrongLocalMatch(term, localRows)) return [];   // local already covers it
    const candidates = await queryMusicBrainz(term);
    if (!candidates.length) return [];
    return await insertNewAlbums(candidates);
  } catch (e) {
    console.warn("maybeFetch failed:", e.message);
    return [];
  }
}

module.exports = { maybeFetch };
