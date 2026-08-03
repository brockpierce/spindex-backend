/**
 * Discogs enrichment — resolves genres/styles (as tags) and a fallback cover
 * for an album we ALREADY have. Never creates an album, so it can't introduce
 * duplicates.
 *
 * Two matching tiers, most-reliable first:
 *   1. MusicBrainz's stored Discogs cross-link (deterministic).
 *   2. Discogs search by artist + title (+ year), with a strict guard.
 *
 * Designed to be safe under load, mirroring the lazy cover pattern:
 *   - lazy + once-per-album: an album is attempted at most once (discogsCheckedAt),
 *     so a viral album opened by thousands triggers exactly one lookup.
 *   - one enrichment at a time (MAX_CONCURRENT), so a spike of brand-new albums
 *     can never open a storm of outbound requests — extras just skip and enrich
 *     on a later visit.
 *   - fail-soft: any error leaves the album showing normally.
 *
 * Set DISCOGS_TOKEN (or DISCOGS_KEY + DISCOGS_SECRET) to enable. Without it,
 * enrichment is a no-op.
 */
const prisma = require("./prisma");

const MB_UA = "noteblock/1.0 ( contact@mynoteblock.com )";
const DISCOGS_UA = "noteblock/1.0 +https://mynoteblock.com";

function discogsAuth() {
  if (process.env.DISCOGS_TOKEN) return `Discogs token=${process.env.DISCOGS_TOKEN}`;
  if (process.env.DISCOGS_KEY && process.env.DISCOGS_SECRET) {
    return `Discogs key=${process.env.DISCOGS_KEY}, secret=${process.env.DISCOGS_SECRET}`;
  }
  return "";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const normalizeTag = (raw) => String(raw).replace(/#/g, "").replace(/\s+/g, "-").toLowerCase().trim();

function pickImage(images) {
  if (!Array.isArray(images) || !images.length) return null;
  const primary = images.find((i) => i && i.type === "primary" && i.uri) || images.find((i) => i && i.uri);
  return primary ? primary.uri : null;
}

// Tier 1: ask MusicBrainz for the release-group's Discogs link.
async function mbDiscogsRef(musicbrainzId) {
  const res = await fetch(`https://musicbrainz.org/ws/2/release-group/${musicbrainzId}?inc=url-rels&fmt=json`, {
    headers: { "User-Agent": MB_UA },
  });
  if (!res.ok) return null;
  const data = await res.json();
  for (const rel of data.relations || []) {
    const resource = rel && rel.url && rel.url.resource;
    if (rel.type !== "discogs" || !resource) continue;
    let m = resource.match(/discogs\.com\/master\/(\d+)/);
    if (m) return { kind: "master", id: m[1] };
    m = resource.match(/discogs\.com\/release\/(\d+)/);
    if (m) return { kind: "release", id: m[1] };
  }
  return null;
}

async function discogsFetchByRef(ref, auth) {
  const path = ref.kind === "master" ? `masters/${ref.id}` : `releases/${ref.id}`;
  const res = await fetch(`https://api.discogs.com/${path}`, { headers: { "User-Agent": DISCOGS_UA, Authorization: auth } });
  if (res.status === 429) { await sleep(60000); return discogsFetchByRef(ref, auth); }
  if (!res.ok) return null;
  const data = await res.json();
  const masterId = ref.kind === "master" ? ref.id : (data.master_id ? String(data.master_id) : null);
  return { masterId, genres: data.genres || [], styles: data.styles || [], imageUrl: pickImage(data.images) };
}

// Tier 2: Discogs search by artist + title, with a strict match guard so we
// only enrich on a confident hit (this can't create duplicates — enrichment
// only tags an album we already have — worst case is a rare slightly-off tag).
async function discogsSearch(artist, title, year, auth) {
  const params = new URLSearchParams({ artist: artist || "", release_title: title || "", type: "master", per_page: "5" });
  const res = await fetch(`https://api.discogs.com/database/search?${params.toString()}`, {
    headers: { "User-Agent": DISCOGS_UA, Authorization: auth },
  });
  if (res.status === 429) { await sleep(60000); return discogsSearch(artist, title, year, auth); }
  if (!res.ok) return null;
  const data = await res.json();
  const na = norm(artist), nt = norm(title);
  if (!na || !nt) return null;
  for (const r of (data.results || []).slice(0, 5)) {
    const rt = norm(r.title || ""); // "artist - title"
    if (!rt.includes(na) || !rt.includes(nt)) continue;
    if (year && r.year && Math.abs(Number(r.year) - Number(year)) > 1) continue; // year sanity check
    return {
      masterId: r.master_id ? String(r.master_id) : (r.type === "master" ? String(r.id) : null),
      genres: r.genre || [],
      styles: r.style || [],
      imageUrl: r.cover_image || null,
    };
  }
  return null;
}

// Resolve tags + a cover for one album. Returns { masterId, tags[], imageUrl } or null.
async function resolveDiscogs(album) {
  const auth = discogsAuth();
  if (!auth) return null;

  let out = null;
  if (album.musicbrainzId) {
    const ref = await mbDiscogsRef(album.musicbrainzId);
    await sleep(1100); // MusicBrainz rate limit
    if (ref) {
      out = await discogsFetchByRef(ref, auth);
      await sleep(1100); // Discogs rate limit
    }
  }
  if (!out) {
    out = await discogsSearch(album.artistName, album.title, album.releaseYear, auth);
    await sleep(1100);
  }
  if (!out) return null;
  const tags = [...new Set([...(out.genres || []), ...(out.styles || [])].map(normalizeTag).filter(Boolean))];
  return { masterId: out.masterId, tags, imageUrl: out.imageUrl };
}

// --- lazy enrichment (one at a time, fire-and-forget) ---------------------
const MAX_CONCURRENT = 1; // one enrichment in flight server-wide — can't storm
let inFlight = 0;

// Fire-and-forget from a request handler. Never awaited, never throws. Enriches
// one not-yet-checked album; skips silently if busy (it'll be retried on a
// later visit) or if Discogs isn't configured.
function enrichInBackground(albumId) {
  if (!albumId || !discogsAuth() || inFlight >= MAX_CONCURRENT) return;
  inFlight++;
  (async () => {
    try {
      const album = await prisma.album.findUnique({
        where: { id: albumId },
        select: { id: true, title: true, artistName: true, releaseYear: true, musicbrainzId: true, coverArtUrl: true, discogsCheckedAt: true, discogsMasterId: true },
      });
      if (!album || album.discogsCheckedAt) return; // already attempted
      const result = await resolveDiscogs(album);

      const data = { discogsCheckedAt: new Date() };
      if (result && result.masterId) {
        // Respect the unique constraint: only claim the master if no one else has it.
        const clash = await prisma.album.findUnique({ where: { discogsMasterId: result.masterId }, select: { id: true } });
        if (!clash) data.discogsMasterId = result.masterId;
      }
      // Only fill a cover that's missing — never overwrite an existing one.
      if (result && result.imageUrl && (!album.coverArtUrl || album.coverArtUrl === "none")) {
        data.coverArtUrl = result.imageUrl;
      }
      await prisma.album.update({ where: { id: album.id }, data });

      if (result && result.tags && result.tags.length) {
        for (const tag of result.tags) {
          await prisma.albumTag.upsert({
            where: { albumId_tag: { albumId: album.id, tag } },
            update: {},
            create: { albumId: album.id, tag, createdByUserId: "system" },
          }).catch(() => {});
        }
      }
    } catch (e) {
      console.warn("discogs enrich failed:", albumId, e.message);
    } finally {
      inFlight--;
    }
  })();
}

module.exports = { resolveDiscogs, enrichInBackground, discogsAuth };
