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
const { fetchMasterCover, resolveDiscogs, discogsAuth } = require("../lib/discogs");

const LIMIT = parseInt(process.env.LIMIT || "100", 10);
const DRY = process.env.DRY === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const albums = await prisma.album.findMany({
    where: {
      albumTags: { some: {} }, // tagged → shows on a tag page; worth a cover
      // FALLBACK ONLY — albums with NO cover (or a broken Discogs placeholder).
      // Never archive.org / MusicBrainz covers: those are canonical, keep them.
      OR: [
        { coverArtUrl: null },
        { coverArtUrl: "none" },
        { coverArtUrl: { contains: "st.discogs.com" } },     // broken Discogs placeholder
        { coverArtUrl: { contains: "spacer" } },
      ],
    },
    select: { id: true, title: true, artistName: true, releaseYear: true, musicbrainzId: true, discogsMasterId: true },
    orderBy: { mbRatingCount: "desc" },
    take: LIMIT,
  });
  console.log(`Processing ${albums.length} album(s). DRY=${DRY} discogs-auth=${discogsAuth() ? "set" : "MISSING"}`);

  let moved = 0, fixed = 0, noArt = 0, i = 0;
  for (const a of albums) {
    i++;
    try {
      let img = await fetchMasterCover(a.discogsMasterId);
      await sleep(1100); // Discogs rate limit
      let newMasterId = null;
      // Stored master returned no art — usually a wrong/fuzzy match. Re-resolve
      // fresh (MB cross-link first, then a strict artist+title+year search) to
      // find the correct master and its cover.
      if (!img) {
        const r = await resolveDiscogs(a); // paces itself
        if (r && r.imageUrl) { img = r.imageUrl; newMasterId = r.masterId; }
      }
      const status = !img ? "(no art on Discogs)" : (newMasterId ? "-> re-matched + cover" : "-> Discogs cover");
      console.log(`  [${i}/${albums.length}] ${a.artistName} — ${a.title}  ::  ${status}`);
      if (!img) { noArt++; continue; }
      if (!DRY) {
        const data = { coverArtUrl: img };
        if (newMasterId && newMasterId !== a.discogsMasterId) {
          const clash = await prisma.album.findUnique({ where: { discogsMasterId: newMasterId }, select: { id: true } });
          if (!clash) data.discogsMasterId = newMasterId;
        }
        await prisma.album.update({ where: { id: a.id }, data });
      }
      if (newMasterId) fixed++; else moved++;
    } catch (e) {
      console.error(`  [${i}/${albums.length}] ${a.id} failed: ${e.message}`);
    }
  }
  console.log(`Done. Moved ${moved}, re-matched ${fixed}, ${noArt} with no art.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
