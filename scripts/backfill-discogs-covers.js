/**
 * Move covers onto Discogs' fast CDN. Cover Art Archive (archive.org) is slow/
 * flaky and causes placeholder covers; for any album that already has a Discogs
 * master, fetch the master's image and replace a missing / placeholder /
 * archive.org coverArtUrl with the reliable Discogs one.
 *
 * One Discogs call per album, rate-limited, socket-safe.
 *
 * Usage (from backend/, needs DISCOGS_TOKEN):
 *   DRY=1 LIMIT=20 node scripts/backfill-discogs-covers.js   # preview + counts
 *   LIMIT=300 node scripts/backfill-discogs-covers.js
 */
require("dotenv").config();
const prisma = require("../lib/prisma");
const { fetchMasterCover, discogsAuth } = require("../lib/discogs");

const LIMIT = parseInt(process.env.LIMIT || "100", 10);
const DRY = process.env.DRY === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const albums = await prisma.album.findMany({
    where: {
      discogsMasterId: { not: null },
      OR: [
        { coverArtUrl: null },
        { coverArtUrl: "none" },
        { coverArtUrl: { contains: "archive.org" } },       // flaky Cover Art Archive
        { coverArtUrl: { contains: "st.discogs.com" } },     // Discogs placeholder
        { coverArtUrl: { contains: "spacer" } },
      ],
    },
    select: { id: true, title: true, artistName: true, discogsMasterId: true },
    orderBy: { mbRatingCount: "desc" },
    take: LIMIT,
  });
  console.log(`Processing ${albums.length} album(s). DRY=${DRY} discogs-auth=${discogsAuth() ? "set" : "MISSING"}`);

  let moved = 0, noArt = 0, i = 0;
  for (const a of albums) {
    i++;
    try {
      const img = await fetchMasterCover(a.discogsMasterId);
      await sleep(1100); // Discogs rate limit
      const status = img ? "-> Discogs cover" : "(no art on Discogs)";
      console.log(`  [${i}/${albums.length}] ${a.artistName} — ${a.title}  ::  ${status}`);
      if (!img) { noArt++; continue; }
      if (!DRY) await prisma.album.update({ where: { id: a.id }, data: { coverArtUrl: img } });
      moved++;
    } catch (e) {
      console.error(`  [${i}/${albums.length}] ${a.id} failed: ${e.message}`);
    }
  }
  console.log(`Done. Moved ${moved} cover(s) to Discogs; ${noArt} had no Discogs art.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
