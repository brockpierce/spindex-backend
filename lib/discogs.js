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
const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
// "Funk / Soul" -> "funk-soul", "Rhythm & Blues" -> "rhythm-and-blues".
const normalizeTag = (raw) => String(raw)
  .toLowerCase()
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

// Timeout-bounded JSON fetch that ALWAYS drains/cancels the response body.
// Undici holds the socket open until the body is consumed or cancelled — a
// hung or unconsumed request leaks the connection, and enough leaks exhaust the
// fd pool and take all outbound requests (and the server) down. Returns
// { ok, data } | { rateLimited } | { ok:false }.
async function fetchJson(url, headers, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { headers, redirect: "follow", signal: ctrl.signal });
  } catch (e) {
    clearTimeout(t);
    return { ok: false }; // timeout/network error
  }
  clearTimeout(t);
  if (res.status === 429) {
    try { if (res.body && !res.bodyUsed) await res.body.cancel(); } catch (_) {}
    return { rateLimited: true };
  }
  if (!res.ok) {
    try { if (res.body && !res.bodyUsed) await res.body.cancel(); } catch (_) {}
    return { ok: false };
  }
  try {
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false };
  }
}

// Only real cover images (i.discogs.com). Discogs returns a placeholder spacer
// on st.discogs.com when an entry has no art — never store that as a cover.
function realImage(url) {
  if (!url || typeof url !== "string") return null;
  if (/spacer\.gif|st\.discogs\.com|\/spacer/i.test(url)) return null;
  return url;
}

function pickImage(images) {
  if (!Array.isArray(images) || !images.length) return null;
  const primary = images.find((i) => i && i.type === "primary" && i.uri) || images.find((i) => i && i.uri);
  return primary ? realImage(primary.uri) : null;
}

// Tier 1: ask MusicBrainz for the release-group's Discogs link.
async function mbDiscogsRef(musicbrainzId) {
  const r = await fetchJson(`https://musicbrainz.org/ws/2/release-group/${musicbrainzId}?inc=url-rels&fmt=json`, { "User-Agent": MB_UA });
  if (!r.ok) return null;
  const data = r.data;
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
  const r = await fetchJson(`https://api.discogs.com/${path}`, { "User-Agent": DISCOGS_UA, Authorization: auth });
  if (r.rateLimited) { await sleep(60000); return discogsFetchByRef(ref, auth); }
  if (!r.ok) return null;
  const data = r.data;
  const masterId = ref.kind === "master" ? ref.id : (data.master_id ? String(data.master_id) : null);
  return { masterId, genres: data.genres || [], styles: data.styles || [], imageUrl: pickImage(data.images) };
}

// Tier 2: Discogs search. Searches RELEASES (many niche albums have no master),
// requires the title to appear (Discogs already filters by the artist param, so
// this also works when the artist is stored in a different script), then prefers
// the master when the release belongs to one, else uses the release itself.
// Returns a { kind, id } ref, or null.
async function discogsSearchRef(artist, title, year, auth) {
  const params = new URLSearchParams({ artist: artist || "", release_title: title || "", type: "release", per_page: "12" });
  const r = await fetchJson(`https://api.discogs.com/database/search?${params.toString()}`, { "User-Agent": DISCOGS_UA, Authorization: auth });
  if (r.rateLimited) { await sleep(60000); return discogsSearchRef(artist, title, year, auth); }
  if (!r.ok) return null;
  const nt = norm(title);
  if (!nt) return null;
  let firstRelease = null;
  for (const res of (r.data.results || []).slice(0, 12)) {
    const rt = norm(res.title || ""); // "artist - title"
    if (!rt.includes(nt)) continue;
    // Gross-mismatch guard only — release years vary with reissues, so keep it wide.
    if (year && res.year && Math.abs(Number(res.year) - Number(year)) > 8) continue;
    if (res.master_id && Number(res.master_id) > 0) return { kind: "master", id: String(res.master_id) };
    if (!firstRelease && res.id) firstRelease = { kind: "release", id: String(res.id) };
  }
  return firstRelease;
}

// Resolve tags + a cover for one album. Returns { masterId, tags[], imageUrl } or null.
async function resolveDiscogs(album) {
  const auth = discogsAuth();
  if (!auth) return null;

  // Find a Discogs ref: MusicBrainz cross-link first (deterministic), else search.
  let ref = null;
  if (album.musicbrainzId) {
    ref = await mbDiscogsRef(album.musicbrainzId);
    await sleep(1100); // MusicBrainz rate limit
  }
  if (!ref) {
    ref = await discogsSearchRef(album.artistName, album.title, album.releaseYear, auth);
    await sleep(1100); // Discogs rate limit
  }
  if (!ref) return null;

  // Fetch the master/release for real cover art + full genres/styles.
  const out = await discogsFetchByRef(ref, auth);
  await sleep(1100);
  if (!out) return null;
  const tags = [...new Set([...(out.genres || []), ...(out.styles || [])].map(normalizeTag).filter(Boolean))];
  return { masterId: out.masterId, tags, imageUrl: realImage(out.imageUrl) };
}

// --- lazy enrichment (one at a time, fire-and-forget) ---------------------
const MAX_CONCURRENT = 1; // one enrichment in flight server-wide — can't storm
let inFlight = 0;

// Fire-and-forget from a request handler. Never awaited, never throws. Enriches
// one not-yet-checked album; skips silently if busy (it'll be retried on a
// later visit) or if Discogs isn't configured.
function enrichInBackground(albumId) {
  // Kill switch: set DISCOGS_ENRICH_OFF=1 in Render to instantly stop all
  // background enrichment without a deploy.
  if (process.env.DISCOGS_ENRICH_OFF === "1") return;
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
      // Discogs is a FALLBACK ONLY, and only when Cover Art Archive has
      // DEFINITIVELY confirmed there's no MB art (coverArtUrl === "none"). A
      // null cover means "not resolved yet" — never pre-empt it with Discogs,
      // or an album that actually has MB art gets the wrong cover.
      if (result && result.imageUrl && album.coverArtUrl === "none") {
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

// Fetch just the cover image for a known Discogs master id (used by the
// cover-refill script for albums already matched to a master).
async function fetchMasterCover(masterId) {
  const auth = discogsAuth();
  if (!auth || !masterId) return null;
  const m = await discogsFetchByRef({ kind: "master", id: String(masterId) }, auth);
  return m ? m.imageUrl : null;
}

module.exports = { resolveDiscogs, enrichInBackground, discogsAuth, fetchMasterCover };
