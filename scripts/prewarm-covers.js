/**
 * Pre-cache MusicBrainz (Cover Art Archive) covers onto OUR disk, so covers
 * serve from our backend and never depend on archive.org being up at request
 * time. Scoped to "in-use" albums (reviewed / tagged / favorited / listened /
 * in a mix / in a list) so it stays bounded, most-popular first.
 *
 * Retries archive.org's transient failures, skips already-cached and
 * genuinely-artless (404) albums. Gentle: one download at a time.
 *
 * Usage (from backend/):
 *   nohup env LIMIT=8000 node scripts/prewarm-covers.js > /tmp/prewarm.log 2>&1 &
 *   tail -f /tmp/prewarm.log
 */
require("dotenv").config();
const prisma = require("../lib/prisma");
const { downloadToCache, isCached } = require("../lib/covercache");

const LIMIT = parseInt(process.env.LIMIT || "5000", 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const albums = await prisma.album.findMany({
    where: {
      musicbrainzId: { not: null },
      coverArtUrl: { not: "none" }, // skip albums CAA already confirmed have no art
      OR: [
        { reviews: { some: {} } },
        { albumTags: { some: {} } },
        { favorites: { some: {} } },
        { listenStatus: { some: {} } },
        { mixItems: { some: {} } },
        { listItems: { some: {} } },
        { songReviews: { some: {} } },
      ],
    },
    select: { musicbrainzId: true, title: true, artistName: true },
    orderBy: { mbRatingCount: "desc" },
    take: LIMIT,
  });
  console.log(`Pre-warming ${albums.length} in-use album cover(s).`);

  let cached = 0, already = 0, noart = 0, fail = 0, i = 0;
  for (const a of albums) {
    i++;
    const mbid = a.musicbrainzId;
    if (isCached(mbid)) { already++; continue; }
    const url = `https://coverartarchive.org/release-group/${mbid}/front-500`;
    let status = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      status = await downloadToCache(mbid, url); // handles concurrency + timeout + body drain
      if (status === "ok" || status === "notfound") break;
      await sleep(2500); // archive.org transient — back off and retry
    }
    if (status === "ok") cached++;
    else if (status === "notfound") noart++;
    else fail++;
    if (i % 25 === 0) console.log(`  [${i}/${albums.length}] cached ${cached}, already ${already}, no-art ${noart}, retry-later ${fail}`);
    await sleep(250);
  }
  console.log(`Done. Newly cached ${cached}, already ${already}, no-art ${noart}, failed(re-run later) ${fail}.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
