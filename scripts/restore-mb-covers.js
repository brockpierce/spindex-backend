/**
 * Undo the mistaken archive.org -> Discogs cover swaps. For every album whose
 * cover was changed to a Discogs image, check whether Cover Art Archive
 * actually has art for it: if so, restore the MB cover (set coverArtUrl = null
 * so the cover endpoint serves the reliable CAA release-group image again);
 * if CAA has nothing, leave the Discogs fallback in place.
 *
 * Usage (from backend/):
 *   DRY=1 node scripts/restore-mb-covers.js     # preview
 *   node scripts/restore-mb-covers.js
 */
require("dotenv").config();
const prisma = require("../lib/prisma");

const LIMIT = parseInt(process.env.LIMIT || "1000", 10);
const DRY = process.env.DRY === "1";
const UA = "noteblock/1.0 ( contact@mynoteblock.com )";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// true = CAA has art, false = definitively none (404), null = transient/unknown.
async function caaHasArt(mbid) {
  try {
    const r = await fetch(`https://coverartarchive.org/release-group/${mbid}/front-500`, {
      method: "HEAD", redirect: "follow", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000),
    });
    if (r.ok) return true;
    if (r.status === 404) return false;
    return null;
  } catch (e) { return null; }
}

async function main() {
  const albums = await prisma.album.findMany({
    where: { musicbrainzId: { not: null }, coverArtUrl: { contains: "i.discogs.com" } },
    select: { id: true, title: true, artistName: true, musicbrainzId: true },
    take: LIMIT,
  });
  console.log(`Checking ${albums.length} Discogs-covered album(s) for MB art. DRY=${DRY}`);

  let restored = 0, keptDiscogs = 0, unknown = 0, i = 0;
  for (const a of albums) {
    i++;
    const has = await caaHasArt(a.musicbrainzId);
    await sleep(400);
    if (has === true) {
      console.log(`  [${i}/${albums.length}] ${a.artistName} — ${a.title}  ::  restore MB cover`);
      if (!DRY) await prisma.album.update({ where: { id: a.id }, data: { coverArtUrl: null } });
      restored++;
    } else if (has === false) {
      keptDiscogs++; // no MB art — Discogs fallback stays
    } else {
      unknown++; // transient — leave alone, a re-run will recheck
    }
  }
  console.log(`Done. Restored ${restored} to MusicBrainz, kept ${keptDiscogs} on Discogs, ${unknown} unknown (re-run to recheck).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
