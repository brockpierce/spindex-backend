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

// --- download -------------------------------------------------------------
// Temp file then rename, so a partial download never leaves a corrupt file.
// Returns "ok" | "notfound" (404 — genuinely no cover) | "transient" (slow/
// timeout/5xx — worth retrying). Only "notfound" should be negative-cached; a
// slow Cover Art Archive (archive.org) must keep retrying until it caches,
// otherwise a working MB cover degrades into a permanent placeholder.
async function downloadToCache(id, remoteUrl) {
  const finalPath = cachePathFor(id);
  const tmpPath = finalPath + ".tmp-" + process.pid + "-" + Date.now();
  await acquire();
  try {
    const controller = new AbortController();
    // archive.org can take several seconds; give it room so the cover actually
    // caches instead of timing out into a placeholder.
    const timeout = setTimeout(() => controller.abort(), 20000);
    let resp;
    try {
      resp = await fetch(remoteUrl, {
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT },
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!resp.ok) {
      // Undici holds the socket until the body is consumed or cancelled.
      try { if (resp.body && !resp.bodyUsed) await resp.body.cancel(); } catch (_) {}
      return resp.status === 404 ? "notfound" : "transient";
    }
    const buf = Buffer.from(await resp.arrayBuffer());
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
function makeCoverHandler(remoteUrlResolver) {
  const inflight = new Map();

  return async function coverHandler(req, res) {
    const id = req.params.mbid || req.params.id;
    if (!id) return res.status(400).send("missing id");

    if (await isCachedAsync(id)) {
      res.set("Cache-Control", "public, max-age=86400");
      return res.sendFile(cachePathFor(id));
    }

    let remoteUrl = null;
    try { remoteUrl = await remoteUrlResolver(id); } catch (e) { remoteUrl = null; }
    if (!remoteUrl) return res.status(404).send("no cover");

    // Kill switch. With COVER_CACHE_OFF=1 nothing is fetched or written by
    // this server — already-cached files above still serve, everything else
    // goes straight to the archive. Set it in Render's Environment tab.
    if (process.env.COVER_CACHE_OFF === "1") {
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
