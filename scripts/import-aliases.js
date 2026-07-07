/**
 * Import artist aliases from MusicBrainz for artists whose albums we already
 * have cover art for. This is what lets someone type "kahimi karie" and find
 * albums by "カヒミ・カリィ" (the primary MB name is native script).
 *
 * WHAT THIS DOES
 * 1. Query all unique artistNames from Album where coverArtUrl starts with http
 *    (~2-3k artists — the ones users are most likely to search for)
 * 2. For each artist name we don't already have aliases for:
 *    a. Search MB for the artist by name -> get MBID (1 API call)
 *    b. Fetch aliases for that MBID (1 API call)
 *    c. Upsert each alias into the ArtistAlias table
 * 3. Rebuild album_fts with an aliases column so search matches on aliases too
 *
 * TIMING
 * MB rate limits anonymous requests to ~1/sec. At 2 calls per artist that's
 * ~2 seconds per artist; 3k artists = ~1.5-2 hours. Resumable — if you kill
 * it and rerun, artists with existing aliases are skipped.
 *
 * USAGE (from Render shell)
 *   DATABASE_URL="file:/var/data/dev.db" node scripts/import-aliases.js
 *
 * BACKGROUND
 *   DATABASE_URL="file:/var/data/dev.db" nohup node scripts/import-aliases.js > aliases.log 2>&1 &
 *   tail -f aliases.log
 *
 * FLAGS
 *   --limit=N          only process the first N unmatched artists
 *   --skip-fts-rebuild don't rebuild album_fts at the end (do it manually later)
 */

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const MB_BASE = "https://musicbrainz.org/ws/2";
const USER_AGENT = "Spindex/1.0 ( https://spindex-frontend.vercel.app )";
const DELAY_MS = 1100; // MB asks for ~1 req/sec

function parseArgs(argv) {
  const flags = { limit: Infinity, skipFts: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--limit=")) flags.limit = parseInt(arg.split("=")[1], 10);
    if (arg === "--skip-fts-rebuild") flags.skipFts = true;
  }
  return flags;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function mbFetch(url, attempt = 1) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.status === 404) return null;
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 3) {
        await sleep(3000 * attempt);
        return mbFetch(url, attempt + 1);
      }
      return null;
    }
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    if (attempt < 3) {
      await sleep(3000 * attempt);
      return mbFetch(url, attempt + 1);
    }
    return null;
  }
}

// Escape a value for use inside a MusicBrainz Lucene-style search query.
function mbEscape(s) {
  return s.replace(/["\\]/g, (m) => "\\" + m);
}

async function findArtistMbid(artistName) {
  const q = encodeURIComponent(`artist:"${mbEscape(artistName)}"`);
  const data = await mbFetch(`${MB_BASE}/artist?query=${q}&fmt=json&limit=1`);
  if (!data || !data.artists || data.artists.length === 0) return null;
  // Only trust a very strong match to avoid mislabeling collision names
  // ("Blue" -> wrong artist). MB gives a score 0-100; accept >= 90.
  const top = data.artists[0];
  if (typeof top.score === "number" && top.score < 90) return null;
  return top.id;
}

async function fetchArtistAliases(mbid) {
  const data = await mbFetch(`${MB_BASE}/artist/${mbid}?inc=aliases&fmt=json`);
  if (!data) return null;
  return data.aliases || [];
}

async function rebuildFts() {
  console.log("Rebuilding album_fts with aliases column...");
  const start = Date.now();
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS album_fts;`);
  await prisma.$executeRawUnsafe(
    `CREATE VIRTUAL TABLE album_fts USING fts5(id UNINDEXED, title, artistName, aliases);`
  );
  // Single-pass insert with LEFT JOIN + GROUP BY -- one hash join, no
  // correlated subqueries. Still takes several minutes on 2.6M rows.
  await prisma.$executeRawUnsafe(`
    INSERT INTO album_fts (id, title, artistName, aliases)
    SELECT a.id, a.title, a.artistName,
           COALESCE(GROUP_CONCAT(al.alias, ' '), '')
    FROM Album a
    LEFT JOIN ArtistAlias al ON al.artistName = a.artistName
    GROUP BY a.id;
  `);
  const elapsed = ((Date.now() - start) / 1000).toFixed(0);
  console.log(`FTS rebuild done in ${elapsed}s.`);
}

async function main() {
  const flags = parseArgs(process.argv);

  console.log(`[${new Date().toISOString()}] Loading unique artists with covers...`);
  const rows = await prisma.album.findMany({
    where: { coverArtUrl: { startsWith: "http" } },
    select: { artistName: true },
    distinct: ["artistName"],
  });
  const allNames = rows.map((r) => r.artistName).filter(Boolean);
  console.log(`Found ${allNames.length} unique artists with covers.`);

  // Filter out ones we already have aliases for (resume support)
  const existing = await prisma.artistAlias.findMany({
    select: { artistName: true },
    distinct: ["artistName"],
  });
  const doneSet = new Set(existing.map((e) => e.artistName));
  const todo = allNames.filter((n) => !doneSet.has(n));
  console.log(`${todo.length} remaining to process (${doneSet.size} already done).`);

  const limit = Math.min(todo.length, flags.limit);
  const artistsToProcess = todo.slice(0, limit);

  let ok = 0;
  let noMbid = 0;
  let noAliases = 0;
  let errored = 0;
  let aliasesTotal = 0;
  const startedAt = Date.now();

  for (let i = 0; i < artistsToProcess.length; i++) {
    const artistName = artistsToProcess[i];
    try {
      const mbid = await findArtistMbid(artistName);
      await sleep(DELAY_MS);
      if (!mbid) {
        noMbid++;
      } else {
        const aliases = await fetchArtistAliases(mbid);
        await sleep(DELAY_MS);
        if (!aliases || aliases.length === 0) {
          noAliases++;
        } else {
          // Insert aliases. Upsert semantics via createMany with skipDuplicates
          // wouldn't work here because we have a composite unique on
          // (musicbrainzArtistId, alias), so we loop and swallow duplicate errors.
          for (const a of aliases) {
            if (!a.name) continue;
            try {
              await prisma.artistAlias.create({
                data: {
                  artistName,
                  alias: a.name,
                  locale: a.locale || null,
                  musicbrainzArtistId: mbid,
                },
              });
              aliasesTotal++;
            } catch (err) {
              // Unique constraint violation from earlier partial run — ignore
              if (!err.message.includes("Unique constraint")) {
                console.error(`  insert failed for ${artistName} / ${a.name}:`, err.message);
              }
            }
          }
          ok++;
        }
      }
    } catch (err) {
      console.error(`  errored on ${artistName}:`, err.message);
      errored++;
    }

    if ((i + 1) % 25 === 0 || i === artistsToProcess.length - 1) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
      const rate = ((i + 1) / elapsed).toFixed(2);
      console.log(
        `  ${i + 1}/${artistsToProcess.length}  ok=${ok}  noMbid=${noMbid}  noAliases=${noAliases}  errored=${errored}  aliases=${aliasesTotal}  (${rate}/s, elapsed ${elapsed}s)`
      );
    }
  }

  console.log(`\n[${new Date().toISOString()}] Alias import done.`);
  console.log(`  ${ok} artists indexed with aliases (${aliasesTotal} aliases total)`);
  console.log(`  ${noMbid} artists not found or fuzzy-matched (skipped)`);
  console.log(`  ${noAliases} artists found but have no aliases`);
  console.log(`  ${errored} errored`);

  if (!flags.skipFts) {
    await rebuildFts();
  } else {
    console.log("\nSkipping FTS rebuild (--skip-fts-rebuild). Run manually with:");
    console.log("  DATABASE_URL=\"file:/var/data/dev.db\" node scripts/import-aliases.js --limit=0");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
