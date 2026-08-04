/**
 * Fill covers for albums that have TAGS (so they show up on tag pages) but no
 * real cover. If the album already has a Discogs master, fetch its image; if
 * not, fully re-resolve (MB link -> Discogs search -> master) to find one.
 * Rate-limited, socket-safe, one call at a time.
 *
 * Usage (from backend/, needs DISCOGS_TOKEN):
 *   DRY=1 LIMIT=20 node scripts/backfill-discogs-covers.js   # preview + counts
 *   LIMIT=200 node scripts/backfill-discogs-covers.js
 */
require("dotenv").config();
const prisma = require("../lib/prisma");
const { resolveDiscogs, fetchMasterCover, discogsAuth } = require("../lib/discogs");

const LIMIT = parseInt(process.env.LIMIT || "100", 10);
const DRY = process.env.DRY === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const albums = await prisma.album.findMany({
    where: {
      albumTags: { some: {} }, // has at least one tag → appears on a tag page
      OR: [
        { coverArtUrl: null },
        { coverArtUrl: "none" },
        { coverArtUrl: { contains: "st.discogs.com" } },
        { coverArtUrl: { contains: "spacer" } },
      ],
    },
    select: { id: true, title: true, artistName: true, releaseYear: true, musicbrainzId: true, discogsMasterId: true },
    orderBy: { mbRatingCount: "desc" },
    take: LIMIT,
  });
  console.log(`Processing ${albums.length} tagged album(s) missing covers. DRY=${DRY} discogs-auth=${discogsAuth() ? "set" : "MISSING"}`);

  let filled = 0, noArt = 0;
  for (const a of albums) {
    try {
      let img = null;
      let masterId = a.discogsMasterId;
      if (a.discogsMasterId) {
        img = await fetchMasterCover(a.discogsMasterId);
        await sleep(1100);
      } else {
        const r = await resolveDiscogs(a); // MB link -> search -> master (paces itself)
        if (r) { img = r.imageUrl; masterId = r.masterId; }
      }

      if (DRY) { console.log(`  ${a.artistName} — ${a.title}  ::  ${img ? "cover found" : "no art on Discogs"}`); continue; }

      const data = {};
      if (img) data.coverArtUrl = img;
      if (masterId && !a.discogsMasterId) {
        const clash = await prisma.album.findUnique({ where: { discogsMasterId: masterId }, select: { id: true } });
        if (!clash) data.discogsMasterId = masterId;
      }
      if (Object.keys(data).length) await prisma.album.update({ where: { id: a.id }, data });
      if (img) filled++; else noArt++;
    } catch (e) {
      console.error(`  ${a.id} failed: ${e.message}`);
    }
  }
  console.log(`Done. Filled ${filled} cover(s); ${noArt} had no art on Discogs.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
