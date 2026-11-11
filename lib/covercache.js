/**
 * Cover image disk cache.
 *
 * Downloads cover bytes once to /var/data/covers and serves them from our own
 * backend, so rendering doesn't depend on archive.org being fast.
 *
 * Every failure path falls back to the original remote URL, so a cache miss
 * never means a broken cover.
 *
 * Three things matter for stability here:
 *  - outbound downloads are capped, or a feed of 30 albums opens 30 sockets
 *  - failures are remembered, or missing covers are refetched forever
 *  - file I/O is async, or writing image bytes blocks the whole event loop
 *    and stalls unrelated requests (and Render's health check)
 */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const CACHE_DIR = process.env.COVER_CACHE_DIR || "/var/data/covers";

try {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
} catch (e) {
  console.warn("cover cache: could not create dir", CACHE_DIR, e.message);
}

const USER_AGENT = "noteblock/1.0 ( contact@mynoteblock.com )";

// --- outbound concurrency -------------------------------------------------
// Cap simultaneous downloads. Past MAX_QUEUE waiting requests we stop queueing
// and just redirect to the archive — a slow cover is better than a backlog.
const MAX_CONCURRENT = 4;
const MAX_QUEUE = 20;
let active = 0;
const waiting = [];

function queueDepth() {
  return waiting.length;
}

function acquire() {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else active -= 1;
}

// --- negative cache -------------------------------------------------------
// Remember failures so a missing cover isn't refetched on every request.
const NEGATIVE_TTL_MS = 60 * 60 * 1000;

// The cache shares Render's disk with the SQLite database, so it must never be
// able to fill it: refuse files over MAX_COVER_BYTES, and stop caching (serve a
// redirect instead) once free space drops under MIN_FREE_BYTES.
const MAX_COVER_BYTES = 5 * 1024 * 1024;
const MIN_FREE_BYTES = 1024 * 1024 * 1024;
let diskCheck = { at: 0, ok: true };
async function hasDiskRoom() {
  if (Date.now() - diskCheck.at < 60 * 1000) return diskCheck.ok;
  let ok = true;
  try {
    const st = await fsp.statfs(CACHE_DIR);
    ok = st.bavail * st.bsize > MIN_FREE_BYTES;
    if (!ok) console.warn("cover cache: low disk space, caching paused");
  } catch (_) { /* statfs unsupported -- don't block caching on it */ }
  diskCheck = { at: Date.now(), ok };
  return ok;
}
const failed = new Map();

function isKnownBad(id) {
  const until = failed.get(id);
  if (!until) return false;
  if (Date.now() > until) { failed.delete(id); return false; }
  return true;
}

function markBad(id) {
  failed.set(id, Date.now() + NEGATIVE_TTL_MS);
  if (failed.size > 5000) {
    const now = Date.now();
    for (const [k, v] of failed) if (v < now) failed.delete(k);
    if (failed.size > 5000) failed.clear();
  }
}

// --- paths ----------------------------------------------------------------
function safeName(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "");
}

function cachePathFor(id) {
  return path.join(CACHE_DIR, safeName(id) + ".jpg");
}

// Sync version kept for callers outside this module.
function isCached(id) {
  try {
    const st = fs.statSync(cachePathFor(id));
    return st.isFile() && st.size > 0;
  } catch (e) {
    return false;
  }
}

async function isCachedAsync(id) {
  try {
    const st = await fsp.stat(cachePathFor(id));
    return st.isFile() && st.size > 0;
  } catch (e) {
    return false;
  }
}

// --- SSRF guard ------------------------------------------------------------
// Covers are only ever fetched or redirected to known cover-art hosts.
// Album.coverArtUrl is normally system- or admin-set (Cover Art Archive, its
// archive.org storage nodes, or i.discogs.com), but this ensures the server can
// never be pointed at an internal/arbitrary address regardless of how that value
// was written.
const ALLOWED_COVER_HOSTS = new Set(["coverartarchive.org", "i.discogs.com"]);
function isAllowedCoverHost(url) {
  let u;
  try { u = new URL(url); } catch (e) { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const h = u.hostname.toLowerCase();
  if (ALLOWED_COVER_HOSTS.has(h)) return true;
  // Cover Art Archive 307-redirects to archive.org storage nodes, and
  // getCoverArtUrl stores that resolved URL (e.g. ia600000.us.archive.org).
  if (h === "archive.org" || h.endsWith(".archive.org")) return true;
  return false;
}

// --- download -------------------------------------------------------------
// Temp file then rename, so a partial download never leaves a corrupt file.
// Returns "ok" | "notfound" (404 — genuinely no cover) | "transient" (slow/
// timeout/5xx — worth retrying). Only "notfound" should be negative-cached; a
// slow Cover Art Archive (archive.org) must keep retrying until it caches,
// otherwise a working MB cover degrades into a permanent placeholder.
async function downloadToCache(id, remoteUrl) {
  // SSRF guard — refuse anything that isn't a known cover-art host.
  if (!isAllowedCoverHost(remoteUrl)) return "notfound";
  const finalPath = cachePathFor(id);
  const tmpPath = finalPath + ".tmp-" + process.pid + "-" + Date.now();
  await acquire();
  try {
    const controller = new AbortController();
    // archive.org can take several seconds; give it room so the cover actually
    // caches instead of timing out into a placeholder. The timer covers the
    // body too -- clearing it once headers arrived let a stalled body hold a
    // download slot for minutes.
    const timeout = setTimeout(() => controller.abort(), 20000);
    let buf;
    try {
      const resp = await fetch(remoteUrl, {
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT },
      });
      const type = resp.headers.get("content-type") || "";
      const declared = Number(resp.headers.get("content-length") || 0);
      // Reject error pages (HTML/JSON served with a 200) without being strict
      // about the image type -- some storage nodes send a generic one.
      const notImage = /^(text\/|application\/(json|xml))/i.test(type);
      if (!resp.ok || notImage || declared > MAX_COVER_BYTES) {
        // Undici holds the socket until the body is consumed or cancelled.
        try { if (resp.body && !resp.bodyUsed) await resp.body.cancel(); } catch (_) {}
        if (resp.status === 404) return "notfound";
        // An HTML error page or an oversized original is never going to cache.
        return resp.ok ? "notfound" : "transient";
      }
      // Count bytes as they arrive: content-length can be absent or wrong.
      const chunks = [];
      let size = 0;
      for await (const chunk of resp.body) {
        size += chunk.length;
        if (size > MAX_COVER_BYTES) { controller.abort(); return "notfound"; }
        chunks.push(chunk);
      }
      buf = Buffer.concat(chunks);
    } finally {
      clearTimeout(timeout);
    }
    if (!buf || buf.length === 0) return "transient";
    await fsp.writeFile(tmpPath, buf);
    await fsp.rename(tmpPath, finalPath);
    return "ok";
  } catch (e) {
    // timeout / network error — transient, don't negative-cache it
    try { await fsp.unlink(tmpPath); } catch (_) {}
    return "transient";
  } finally {
    release();
  }
}

// --- handler --------------------------------------------------------------
// The resolver returns the remote URL for an id, or { url, cache: false } to
// serve a redirect without storing the file.
const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function makeCoverHandler(remoteUrlResolver) {
  const inflight = new Map();

  return async function coverHandler(req, res) {
    const id = req.params.mbid || req.params.id;
    if (!id) return res.status(400).send("missing id");
    // Only real MusicBrainz ids. Express decodes the param, so an encoded "/"
    // or "?" could otherwise steer the Cover Art Archive path, and every
    // distinct junk string became its own cache file.
    if (!MBID_RE.test(id)) return res.status(404).send("no cover");

    if (await isCachedAsync(id)) {
      res.set("Cache-Control", "public, max-age=86400");
      return res.sendFile(cachePathFor(id));
    }

    let remoteUrl = null;
    let cacheable = true;
    try {
      const r = await remoteUrlResolver(id);
      if (r && typeof r === "object") { remoteUrl = r.url; cacheable = r.cache !== false; } else remoteUrl = r;
    } catch (e) { remoteUrl = null; }
    if (!remoteUrl) return res.status(404).send("no cover");
    // SSRF guard: never fetch or 302-redirect to a non-cover-art host, whatever
    // is stored in coverArtUrl. Covers the download AND every redirect below.
    if (!isAllowedCoverHost(remoteUrl)) return res.status(404).send("no cover");

    // Kill switch. With COVER_CACHE_OFF=1 nothing is fetched or written by
    // this server — already-cached files above still serve, everything else
    // goes straight to the archive. Set it in Render's Environment tab.
    if (process.env.COVER_CACHE_OFF === "1" || !cacheable || !(await hasDiskRoom())) {
      return res.redirect(302, remoteUrl);
    }

    // Known bad, or too many already queued: hand it straight to the archive
    // instead of adding to the backlog.
    if (isKnownBad(id) || queueDepth() >= MAX_QUEUE) {
      return res.redirect(302, remoteUrl);
    }

    let status;
    if (inflight.has(id)) {
      status = await inflight.get(id);
    } else {
      const p = downloadToCache(id, remoteUrl);
      inflight.set(id, p);
      try { status = await p; } finally { inflight.delete(id); }
    }

    if (status === "ok" && (await isCachedAsync(id))) {
      res.set("Cache-Control", "public, max-age=86400");
      return res.sendFile(cachePathFor(id));
    }

    // Only remember genuine "no cover" (404). Transient failures (slow archive.org,
    // 5xx) are NOT cached, so the next request retries and eventually caches.
    if (status === "notfound") markBad(id);
    return res.redirect(302, remoteUrl);
  };
}

// Rewrite an album's coverArtUrl to our own disk-cached cover endpoint, so the
// image is served reliably from our backend instead of straight from the flaky
// source (archive.org) or a hotlink-protected CDN. Any route that returns
// albums to the client should pass them through this.
const COVER_BASE = process.env.PUBLIC_BACKEND_URL || "https://spindex-backend.onrender.com";
function withCachedCover(album) {
  if (!album || !album.musicbrainzId) return album;
  const c = album.coverArtUrl;
  // Never override a manually-uploaded (base64) cover.
  if (typeof c === "string" && c.startsWith("data:")) return album;
  // "none" = Cover Art Archive confirmed there is genuinely no art. Nothing to
  // serve, so don't spend a lookup on it every render.
  if (c === "none") return album;
  // Everything else — a resolved URL, OR a not-yet-resolved null — is served
  // through our mbid cover endpoint. It checks the disk cache FIRST, so a
  // prewarmed MB cover shows instantly even while coverArtUrl is still null,
  // and only falls back to Cover Art Archive on a cache miss. Routing null is
  // the fix for MB-art albums that showed placeholders because a null cover
  // skipped the cache endpoint entirely and the disk-cached art went unused.
  return { ...album, coverArtUrl: `${COVER_BASE}/api/albums/covers/${album.musicbrainzId}` };
}

module.exports = { isCached, downloadToCache, makeCoverHandler, cachePathFor, CACHE_DIR, withCachedCover };
