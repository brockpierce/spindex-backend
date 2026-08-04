/**
 * Fill covers for albums that matched a Discogs master but have no real cover
 * (or got a placeholder from the old code). Fetches the master's actual image
 * and stores it as coverArtUrl. One Discogs call per album (we already know the
 * master id), rate-limited, socket-safe.
 *
 * Usage (from backend/, needs DISCOGS_TOKEN):
 *   DRY=1 LIMIT=20 node scripts/backfill-discogs-covers.js   # preview
 *   LIMIT=200 node scripts/backfill-discogs-covers.js
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
        { coverArtUrl: { contains: "st.discogs.com" } },
        { coverArtUrl: { contains: "spacer" } },
      ],
    },
    select: { id: true, title: true, artistName: true, discogsMasterId: true },
    orderBy: { mbRatingCount: "desc" },
    take: LIMIT,
  });
  console.log(`Processing ${albums.length} album(s) missing covers. DRY=${DRY} discogs-auth=${discogsAuth() ? "set" : "MISSING"}`);

  let filled = 0, noArt = 0;
  for (const a of albums) {
    try {
      const img = await fetchMasterCover(a.discogsMasterId);
      await sleep(1100); // Discogs rate limit
      if (!img) { noArt++; if (DRY) console.log(`  ${a.artistName} — ${a.title}  ::  (no art on Discogs)`); continue; }
      if (DRY) { console.log(`  ${a.artistName} — ${a.title}  ::  cover found`); continue; }
      await prisma.album.update({ where: { id: a.id }, data: { coverArtUrl: img } });
      filled++;
    } catch (e) {
      console.error(`  ${a.id} failed: ${e.message}`);
    }
  }
  console.log(`Done. Filled ${filled} cover(s); ${noArt} had no art on Discogs.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
