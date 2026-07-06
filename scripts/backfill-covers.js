// scripts/backfill-covers.js
//
// Bulk-fetches cover art from Cover Art Archive for the top 10,000 albums
// by mbRatingCount that are either missing coverArtUrl or marked "none"
// (retrying previous failures). Runs 2 concurrent workers with a 250ms
// per-worker delay — CAA has no hard rate limit but explicitly asks you not
// to hammer. Effective rate ~1.1 req/sec, total run ~2-3 hours.
//
// Run from the Render shell:
//   DATABASE_URL="file:/var/data/dev.db" node scripts/backfill-covers.js
//
// Safe to Ctrl+C and re-run — the "still missing" query on start naturally
// picks up where you left off.
//
// If you'd rather run it in the background so the shell can close:
//   DATABASE_URL="file:/var/data/dev.db" nohup node scripts/backfill-covers.js > backfill.log 2>&1 &

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const CAA_BASE = "https://coverartarchive.org/release-group";
const LIMIT = 10000;
const DELAY_MS = 250; // per-worker delay between requests
const CONCURRENCY = 2; // number of parallel workers
const USER_AGENT = "Spindex/1.0 ( https://spindex-frontend.vercel.app )";
const MAX_RETRIES_TRANSIENT = 3;

// Fetch cover art metadata for one MBID from CAA.
// Returns:
//   { url: "https://..." }  -> cover found, URL is the preferred size
//   { none: true }          -> CAA confirms no cover (404) — cache "none"
//   { transient: true }     -> network/timeout/5xx — leave DB unchanged, retry next run
async function fetchCover(mbid, attempt = 1) {
  const url = `${CAA_BASE}/${mbid}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.status === 404) return { none: true };
    if (res.status === 429 || res.status >= 500) {
      if (attempt < MAX_RETRIES_TRANSIENT) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        return fetchCover(mbid, attempt + 1);
      }
      return { transient: true };
    }
    if (!res.ok) return { transient: true };

    const json = await res.json();
    const images = json.images || [];
    if (images.length === 0) return { none: true };

    // Prefer a front image, fall back to first image
    const front = images.find((img) => img.front) || images[0];
    // Prefer the 500px thumbnail (fast to render, plenty of detail for the app),
    // fall back through the size chain to the full image
    const chosen =
      (front.thumbnails && (front.thumbnails["500"] || front.thumbnails["large"] || front.thumbnails["small"])) ||
      front.image;
    if (!chosen) return { none: true };
    return { url: chosen };
  } catch (err) {
    return { transient: true };
  }
}

async function main() {
  console.log(`[${new Date().toISOString()}] Loading top ${LIMIT} albums missing covers, ordered by mbRatingCount desc...`);

  const albums = await prisma.album.findMany({
    where: {
      OR: [{ coverArtUrl: null }, { coverArtUrl: "none" }, { coverArtUrl: "" }],
      NOT: { musicbrainzId: null },
    },
    orderBy: { mbRatingCount: "desc" },
    take: LIMIT,
    select: { id: true, title: true, artistName: true, musicbrainzId: true, mbRatingCount: true },
  });

  console.log(`Fetched ${albums.length} albums to process.`);

  let done = 0;
  let ok = 0;
  let noneCount = 0;
  let transientCount = 0;
  let nextIdx = 0;
  const startedAt = Date.now();

  // Concurrent worker pool. Each worker pulls the next album from the shared
  // queue (via nextIdx counter, safe because JS is single-threaded between
  // awaits), fetches, updates the DB, sleeps DELAY_MS, then loops. When the
  // queue is drained they all resolve and Promise.all returns.
  async function worker() {
    while (true) {
      const idx = nextIdx++;
      if (idx >= albums.length) return;
      const album = albums[idx];

      const result = await fetchCover(album.musicbrainzId);
      if (result.url) {
        await prisma.album.update({ where: { id: album.id }, data: { coverArtUrl: result.url } });
        ok++;
      } else if (result.none) {
        await prisma.album.update({ where: { id: album.id }, data: { coverArtUrl: "none" } });
        noneCount++;
      } else {
        transientCount++;
      }

      done++;
      if (done % 25 === 0 || done === albums.length) {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
        const rate = (done / elapsed).toFixed(2);
        console.log(
          `  ${done}/${albums.length}  ok=${ok}  none=${noneCount}  transient=${transientCount}  (${rate}/s, elapsed ${elapsed}s)`
        );
      }

      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const total = ((Date.now() - startedAt) / 1000).toFixed(0);
  console.log(`\n[${new Date().toISOString()}] Done in ${total}s.`);
  console.log(`  ${ok} covers fetched`);
  console.log(`  ${noneCount} confirmed no-cover (marked "none")`);
  console.log(`  ${transientCount} transient failures — re-run to retry these`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
