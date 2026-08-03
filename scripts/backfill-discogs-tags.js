/**
 * Backfill Discogs genres/styles as tags onto albums we ALREADY have.
 *
 * ENRICHMENT ONLY — this never creates an album, so it cannot introduce
 * duplicates. For each existing album that has a MusicBrainz id but no Discogs
 * link yet, it:
 *   1. asks MusicBrainz for that release-group's official Discogs URL
 *      (a deterministic cross-link — no fuzzy title matching), then
 *   2. fetches that Discogs master/release's genres + styles, and
 *   3. stores the discogsMasterId on the album and upserts the styles into
 *      AlbumTag.
 *
 * Requires the `discogsMasterId` column on Album (see the migration in chat).
 * Set DISCOGS_TOKEN in the environment to fetch styles (a free personal token
 * from discogs.com → Settings → Developers). Without it, the script still
 * resolves + stores the Discogs link but adds no tags.
 *
 * Usage (from backend/):
 *   DRY=1 LIMIT=20 node scripts/backfill-discogs-tags.js     # preview, writes nothing
 *   DISCOGS_TOKEN=xxx LIMIT=200 node scripts/backfill-discogs-tags.js
 *
 * Respects both APIs' rate limits (MusicBrainz ~1 req/s, Discogs ~60/min) and
 * fails soft on any single album.
 */
require("dotenv").config();
const prisma = require("../lib/prisma");

const MB_UA = "noteblock/1.0 ( contact@mynoteblock.com )";
const DISCOGS_UA = "noteblock/1.0 +https://mynoteblock.com";
const LIMIT = parseInt(process.env.LIMIT || "50", 10);
const DRY = process.env.DRY === "1";

// Discogs auth — either a personal access token (simplest: Settings →
// Developers → "Generate new token"), OR a consumer key + secret. No OAuth
// flow is needed for reading public catalog data.
function discogsAuth() {
  if (process.env.DISCOGS_TOKEN) return `Discogs token=${process.env.DISCOGS_TOKEN}`;
  if (process.env.DISCOGS_KEY && process.env.DISCOGS_SECRET) {
    return `Discogs key=${process.env.DISCOGS_KEY}, secret=${process.env.DISCOGS_SECRET}`;
  }
  return "";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeTag(raw) {
  return String(raw).replace(/#/g, "").replace(/\s+/g, "-").toLowerCase().trim();
}

// Ask MusicBrainz for the release-group's Discogs link. Returns { kind, id }
// where kind is "master" | "release", or null if MB has no Discogs relation.
async function mbDiscogsRef(musicbrainzId) {
  const url = `https://musicbrainz.org/ws/2/release-group/${musicbrainzId}?inc=url-rels&fmt=json`;
  const res = await fetch(url, { headers: { "User-Agent": MB_UA } });
  if (!res.ok) return null;
  const data = await res.json();
  for (const rel of data.relations || []) {
    const resource = rel && rel.url && rel.url.resource;
    if (rel.type !== "discogs" || !resource) continue;
    let m = resource.match(/discogs\.com\/master\/(\d+)/);
    if (m) return { kind: "master", id: m[1] };
    m = resource.match(/discogs\.com\/release\/(\d+)/);
    if (m) return { kind: "release", id: m[1] };
  }
  return null;
}

// Fetch genres+styles (and the master id) from a Discogs master or release.
async function discogsData(ref) {
  const auth = discogsAuth();
  if (!auth) return null;
  const path = ref.kind === "master" ? `masters/${ref.id}` : `releases/${ref.id}`;
  const res = await fetch(`https://api.discogs.com/${path}`, {
    headers: { "User-Agent": DISCOGS_UA, Authorization: auth },
  });
  if (res.status === 429) { await sleep(60000); return discogsData(ref); } // backoff on rate limit
  if (!res.ok) return null;
  const data = await res.json();
  const masterId = ref.kind === "master" ? ref.id : (data.master_id ? String(data.master_id) : null);
  return { masterId, genres: data.genres || [], styles: data.styles || [] };
}

async function main() {
  const albums = await prisma.album.findMany({
    where: { musicbrainzId: { not: null }, discogsMasterId: null },
    select: { id: true, title: true, artistName: true, musicbrainzId: true },
    // Most-popular first: higher Discogs-link hit rate and the albums people
    // actually browse. Each run advances through the next-most-popular batch.
    orderBy: { mbRatingCount: "desc" },
    take: LIMIT,
  });
  console.log(`Processing ${albums.length} album(s). DRY=${DRY} discogs-auth=${discogsAuth() ? "set" : "MISSING"}`);

  let linked = 0, tagsAdded = 0;
  for (const a of albums) {
    try {
      const ref = await mbDiscogsRef(a.musicbrainzId);
      await sleep(1100); // MusicBrainz rate limit
      if (!ref) continue;

      let masterId = ref.kind === "master" ? ref.id : null;
      let tags = [];
      const dd = await discogsData(ref);
      if (dd) {
        masterId = dd.masterId || masterId;
        tags = [...new Set([...dd.genres, ...dd.styles].map(normalizeTag).filter(Boolean))];
        await sleep(1100); // Discogs rate limit
      }

      if (DRY) {
        console.log(`  ${a.artistName} — ${a.title}  →  ${ref.kind} ${ref.id}  ::  ${tags.join(", ") || "(no token/styles)"}`);
        continue;
      }

      // Enrichment only: update the existing row, upsert tags. Never inserts an album.
      if (masterId) {
        // Guard the unique constraint: skip if another album already claims this master.
        const clash = await prisma.album.findUnique({ where: { discogsMasterId: masterId }, select: { id: true } });
        if (!clash) await prisma.album.update({ where: { id: a.id }, data: { discogsMasterId: masterId } });
      }
      if (masterId) linked++;
      for (const tag of tags) {
        await prisma.albumTag.upsert({
          where: { albumId_tag: { albumId: a.id, tag } },
          update: {},
          create: { albumId: a.id, tag, createdByUserId: "system" },
        });
        tagsAdded++;
      }
    } catch (e) {
      console.error(`  ${a.id} failed: ${e.message}`);
    }
  }
  console.log(`Done. Linked ${linked} album(s) to Discogs, added ${tagsAdded} tag(s).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
