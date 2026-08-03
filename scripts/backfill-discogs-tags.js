/**
 * OPTIONAL off-peak pre-warm for Discogs enrichment.
 *
 * The always-on mechanism is lazy (albums enrich the first time they're viewed —
 * see lib/discogs.js). This script just bulk-processes the most-popular albums
 * so they're already tagged/covered before anyone opens them. Run it when
 * traffic is low; it shares the exact same enrichment logic as the live path.
 *
 * ENRICHMENT ONLY — never creates an album (no duplicates). Marks each album
 * checked so re-runs advance to the next batch.
 *
 * Usage (from backend/, needs DISCOGS_TOKEN in the environment):
 *   DRY=1 LIMIT=20 node scripts/backfill-discogs-tags.js   # preview, writes nothing
 *   LIMIT=200 node scripts/backfill-discogs-tags.js
 */
require("dotenv").config();
const prisma = require("../lib/prisma");
const { resolveDiscogs, discogsAuth } = require("../lib/discogs");

const LIMIT = parseInt(process.env.LIMIT || "50", 10);
const DRY = process.env.DRY === "1";

async function main() {
  const albums = await prisma.album.findMany({
    where: { musicbrainzId: { not: null }, discogsCheckedAt: null },
    select: { id: true, title: true, artistName: true, releaseYear: true, musicbrainzId: true, coverArtUrl: true },
    // Most-popular first: better hit rate and the albums people actually browse.
    orderBy: { mbRatingCount: "desc" },
    take: LIMIT,
  });
  console.log(`Processing ${albums.length} album(s). DRY=${DRY} discogs-auth=${discogsAuth() ? "set" : "MISSING"}`);

  let linked = 0, tagsAdded = 0, covers = 0;
  for (const a of albums) {
    try {
      const result = await resolveDiscogs(a); // handles both tiers + rate-limit pacing
      const needsCover = result && result.imageUrl && (!a.coverArtUrl || a.coverArtUrl === "none");

      if (DRY) {
        const desc = result ? (result.tags.join(", ") || "(matched, no styles)") : "(no match)";
        console.log(`  ${a.artistName} — ${a.title}  ::  ${desc}${needsCover ? "  [+cover]" : ""}`);
        continue;
      }

      const data = { discogsCheckedAt: new Date() };
      if (result && result.masterId) {
        const clash = await prisma.album.findUnique({ where: { discogsMasterId: result.masterId }, select: { id: true } });
        if (!clash) data.discogsMasterId = result.masterId;
      }
      if (needsCover) { data.coverArtUrl = result.imageUrl; covers++; }
      await prisma.album.update({ where: { id: a.id }, data });

      if (result && result.masterId) linked++;
      if (result) {
        for (const tag of result.tags) {
          await prisma.albumTag.upsert({
            where: { albumId_tag: { albumId: a.id, tag } },
            update: {},
            create: { albumId: a.id, tag, createdByUserId: "system" },
          });
          tagsAdded++;
        }
      }
    } catch (e) {
      console.error(`  ${a.id} failed: ${e.message}`);
    }
  }
  console.log(`Done. Linked ${linked} to Discogs, added ${tagsAdded} tag(s), filled ${covers} cover(s).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
