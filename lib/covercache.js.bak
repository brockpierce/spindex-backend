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
async function downloadToCache(id, remoteUrl) {
  const finalPath = cachePathFor(id);
  const tmpPath = finalPath + ".tmp-" + process.pid + "-" + Date.now();
  await acquire();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
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
      console.warn("cover cache: download failed", id, resp.status);
      return false;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf || buf.length === 0) return false;
    await fsp.writeFile(tmpPath, buf);
    await fsp.rename(tmpPath, finalPath);
    return true;
  } catch (e) {
    console.warn("cover cache: download error", id, e.message);
    try { await fsp.unlink(tmpPath); } catch (_) {}
    return false;
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
      res.set("Cache-Control", "public, max-age=31536000, immutable");
      return res.sendFile(cachePathFor(id));
    }

    let remoteUrl = null;
    try { remoteUrl = await remoteUrlResolver(id); } catch (e) { remoteUrl = null; }
    if (!remoteUrl) return res.status(404).send("no cover");

    // Known bad, or too many already queued: hand it straight to the archive
    // instead of adding to the backlog.
    if (isKnownBad(id) || queueDepth() >= MAX_QUEUE) {
      return res.redirect(302, remoteUrl);
    }

    let ok;
    if (inflight.has(id)) {
      ok = await inflight.get(id);
    } else {
      const p = downloadToCache(id, remoteUrl);
      inflight.set(id, p);
      try { ok = await p; } finally { inflight.delete(id); }
    }

    if (ok && (await isCachedAsync(id))) {
      res.set("Cache-Control", "public, max-age=31536000, immutable");
      return res.sendFile(cachePathFor(id));
    }

    markBad(id);
    return res.redirect(302, remoteUrl);
  };
}

module.exports = { isCached, downloadToCache, makeCoverHandler, cachePathFor, CACHE_DIR };
