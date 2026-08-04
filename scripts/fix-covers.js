/**
 * The ONE cover script. For every album whose cover is uncertain — "none", a
 * Discogs image (possibly a wrong earlier swap), or a placeholder — ask Cover
 * Art Archive directly (with retries, because archive.org throws transient
 * 500s) and:
 *   - CAA has art (200)  -> use the MB cover (restores anything wrongly swapped)
 *   - CAA definitively 404 -> Discogs fallback (release-aware) + tags
 *   - CAA unknown (5xx/timeout after retries) -> skip, leave as-is, re-run later
 *
 * MusicBrainz art is canonical; Discogs is only ever a fallback for a confirmed
 * 404. Never touches an album whose cover is already a plain archive.org URL.
 *
 * Usage (from backend/, needs DISCOGS_TOKEN):
 *   DRY=1 LIMIT=40 node scripts/fix-covers.js
 *   nohup env LIMIT=1000 node scripts/fix-covers.js > /tmp/covers.log 2>&1 &
 */
require("dotenv").config();
const fs = require("fs");
const prisma = require("../lib/prisma");
const { resolveDiscogs, discogsAuth } = require("../lib/discogs");
const { cachePathFor } = require("../lib/covercache");

const LIMIT = parseInt(process.env.LIMIT || "300", 10);
const DRY = process.env.DRY === "1";
const UA = "noteblock/1.0 ( contact@mynoteblock.com )";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// true = has art, false = definitive 404, null = unknown after retries.
async function caaHasArt(mbid) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`https://coverartarchive.org/release-group/${mbid}/front-500`, {
        method: "HEAD", redirect: "follow", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000),
      });
      if (r.ok) return true;
      if (r.status === 404) return false;
      // 5xx / 429 — transient, retry
    } catch (e) { /* timeout / network — retry */ }
    await sleep(2000);
  }
  return null;
}

async function main() {
  const albums = await prisma.album.findMany({
    where: {
      musicbrainzId: { not: null },
      OR: [
        { coverArtUrl: "none" },
        { coverArtUrl: { contains: "i.discogs.com" } },
        { coverArtUrl: { contains: "st.discogs.com" } },
        { coverArtUrl: { contains: "spacer" } },
      ],
    },
    select: { id: true, title: true, artistName: true, releaseYear: true, musicbrainzId: true, coverArtUrl: true },
    orderBy: { mbRatingCount: "desc" },
    take: LIMIT,
  });
  console.log(`Processing ${albums.length}. DRY=${DRY} discogs-auth=${discogsAuth() ? "set" : "MISSING"}`);

  let mb = 0, discogs = 0, none = 0, skip = 0, i = 0;
  for (const a of albums) {
    i++;
    const dropCache = () => { try { fs.unlinkSync(cachePathFor(a.musicbrainzId)); } catch (_) {} };
    try {
      const has = await caaHasArt(a.musicbrainzId);
      await sleep(600);

      if (has === true) {
        // MB has art — canonical. Point coverArtUrl at CAA (restores a wrong swap).
        const caaUrl = `https://coverartarchive.org/release-group/${a.musicbrainzId}/front-500`;
        console.log(`  [${i}/${albums.length}] ${a.artistName} — ${a.title}  ::  MB cover`);
        if (!DRY && a.coverArtUrl !== caaUrl) { await prisma.album.update({ where: { id: a.id }, data: { coverArtUrl: caaUrl } }); dropCache(); }
        mb++;
      } else if (has === false) {
        // No MB art — Discogs fallback.
        const r = await resolveDiscogs(a);
        const got = r && r.imageUrl;
        console.log(`  [${i}/${albums.length}] ${a.artistName} — ${a.title}  ::  ${got ? "-> Discogs fallback" : "(no art anywhere)"}`);
        if (!DRY && got) {
          const data = { coverArtUrl: r.imageUrl, discogsCheckedAt: new Date() };
          if (r.masterId) { const clash = await prisma.album.findUnique({ where: { discogsMasterId: r.masterId }, select: { id: true } }); if (!clash) data.discogsMasterId = r.masterId; }
          await prisma.album.update({ where: { id: a.id }, data });
          dropCache();
          for (const tag of (r.tags || [])) await prisma.albumTag.upsert({ where: { albumId_tag: { albumId: a.id, tag } }, update: {}, create: { albumId: a.id, tag, createdByUserId: "system" } }).catch(() => {});
        }
        got ? discogs++ : none++;
      } else {
        console.log(`  [${i}/${albums.length}] ${a.artistName} — ${a.title}  ::  (CAA unknown — skip)`);
        skip++;
      }
    } catch (e) {
      console.error(`  [${i}/${albums.length}] ${a.id} failed: ${e.message}`);
    }
  }
  console.log(`Done. MB kept/restored: ${mb}, Discogs fallback: ${discogs}, no art anywhere: ${none}, skipped(unknown): ${skip}.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
