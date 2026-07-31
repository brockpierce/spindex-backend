/**
 * Cover image disk cache.
 *
 * The Cover Art Archive can be slow, which makes album covers load slowly or
 * blank out even when we already know the cover URL. This module downloads the
 * actual image bytes once to the persistent disk (/var/data/covers) and serves
 * them from our own backend afterward, so cover rendering no longer depends on
 * archive.org being fast at render time.
 *
 * Safety: every failure path falls back to the original remote URL, so a cache
 * miss or download error never means a broken cover -- worst case is the same
 * "load from archive.org" behavior we had before.
 */
const fs = require("fs");
const path = require("path");

const CACHE_DIR = process.env.COVER_CACHE_DIR || "/var/data/covers";

// Ensure the cache directory exists (best-effort; if it fails we just fall back).
try {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
} catch (e) {
  console.warn("cover cache: could not create dir", CACHE_DIR, e.message);
}

const USER_AGENT = "noteblock/1.0 ( contact@mynoteblock.com )";

// Sanitize an id so it's safe as a filename (mbids are hex+hyphen, but be strict).
function safeName(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "");
}

function cachePathFor(id) {
  return path.join(CACHE_DIR, safeName(id) + ".jpg");
}

// Is this cover already on disk?
function isCached(id) {
  try {
    const p = cachePathFor(id);
    const st = fs.statSync(p);
    return st.isFile() && st.size > 0;
  } catch (e) {
    return false;
  }
}

// Download the remote cover to disk. Returns true on success, false on failure.
// Writes to a temp file first, then renames, so a partial download never
// leaves a corrupt file at the real path.
async function downloadToCache(id, remoteUrl) {
  const finalPath = cachePathFor(id);
  const tmpPath = finalPath + ".tmp-" + process.pid + "-" + Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s
    const resp = await fetch(remoteUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      console.warn("cover cache: download failed", id, resp.status);
      return false;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf || buf.length === 0) return false;
    fs.writeFileSync(tmpPath, buf);
    fs.renameSync(tmpPath, finalPath);
    return true;
  } catch (e) {
    console.warn("cover cache: download error", id, e.message);
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    return false;
  }
}

// Express handler: serve a cached cover, downloading it first if needed.
// remoteUrlResolver(id) should return the archive.org URL for this id (or null).
function makeCoverHandler(remoteUrlResolver) {
  // Track in-flight downloads so concurrent requests for the same id don't
  // all fetch at once.
  const inflight = new Map();

  return async function coverHandler(req, res) {
    const id = req.params.mbid || req.params.id;
    if (!id) return res.status(400).send("missing id");

    // 1. Already cached? Serve from disk.
    if (isCached(id)) {
      res.set("Cache-Control", "public, max-age=31536000, immutable");
      return res.sendFile(cachePathFor(id));
    }

    // 2. Resolve the remote URL for this id.
    let remoteUrl = null;
    try { remoteUrl = await remoteUrlResolver(id); } catch (e) { remoteUrl = null; }
    if (!remoteUrl) return res.status(404).send("no cover");

    // 3. Download to cache (dedupe concurrent requests for the same id).
    let ok;
    if (inflight.has(id)) {
      ok = await inflight.get(id);
    } else {
      const p = downloadToCache(id, remoteUrl);
      inflight.set(id, p);
      try { ok = await p; } finally { inflight.delete(id); }
    }

    // 4. Serve from disk if it worked; otherwise redirect to the remote URL
    //    (fallback -- covers never fully break).
    if (ok && isCached(id)) {
      res.set("Cache-Control", "public, max-age=31536000, immutable");
      return res.sendFile(cachePathFor(id));
    }
    return res.redirect(302, remoteUrl);
  };
}

module.exports = { isCached, downloadToCache, makeCoverHandler, cachePathFor, CACHE_DIR };
