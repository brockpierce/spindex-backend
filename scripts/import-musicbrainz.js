/**
 * Import MusicBrainz release-groups (albums) into our local database.
 *
 * WHAT THIS DOES
 * MusicBrainz publishes a "release-group" JSON dump -- one JSON object per
 * line, one line per album/single/EP ever released. We stream through that
 * file line by line (it's too big to load into memory at once), keep only
 * the ones that look like real albums, and upsert them into our own
 * Album table in batches.
 *
 * WHERE TO GET THE DUMP
 * 1. Go to https://metabrainz.org/datasets/postgres-dumps (despite the
 *    name, this page also links the JSON dumps) or directly browse
 *    https://data.metabrainz.org/pub/musicbrainz/data/json-dumps/LATEST/
 * 2. Download "release-group.tar.xz" from the latest folder.
 * 3. Extract it. On Mac/Linux: `tar -xf release-group.tar.xz`
 *    This creates a folder named `mbdump/` containing one file called
 *    `release-group` (no extension) -- that's the actual data file.
 * 4. Point this script at that file (see USAGE below).
 *
 * USAGE
 *   node scripts/import-musicbrainz.js /path/to/mbdump/release-group
 *
 * Optional flags:
 *   --limit=5000        stop after importing this many albums (good for testing)
 *   --types=Album,EP    which primary-types to keep (default: Album,EP)
 *                        Note: "Compilation" is not a primary-type in MusicBrainz --
 *                        it's a secondary tag on top of "Album", so compilations are
 *                        already included whenever "Album" is. The primary-types are
 *                        only: Album, Single, EP, Broadcast, Other.
 *   --min-year=1900     skip albums released before this year
 *
 * This script is safe to re-run -- it upserts on musicbrainzId, so running
 * it twice on the same file won't create duplicates.
 */

const fs = require("fs");
const readline = require("readline");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const BATCH_SIZE = 500;

function parseArgs(argv) {
  const filePath = argv[2];
  const flags = { limit: Infinity, types: ["Album", "EP"], minYear: 0 };
  for (const arg of argv.slice(3)) {
    if (arg.startsWith("--limit=")) flags.limit = parseInt(arg.split("=")[1], 10);
    if (arg.startsWith("--types=")) flags.types = arg.split("=")[1].split(",");
    if (arg.startsWith("--min-year=")) flags.minYear = parseInt(arg.split("=")[1], 10);
  }
  return { filePath, flags };
}

function extractYear(firstReleaseDate) {
  if (!firstReleaseDate) return null;
  const match = /^(\d{4})/.exec(firstReleaseDate);
  return match ? parseInt(match[1], 10) : null;
}

function extractArtistName(artistCredit) {
  if (!Array.isArray(artistCredit) || artistCredit.length === 0) return "Unknown Artist";
  // artist-credit is a list of { name, joinphrase, artist: {...} } objects.
  // Joining them with their joinphrase reconstructs the full credited name,
  // e.g. "Calvin" + " & " + "Hobbes" -> "Calvin & Hobbes".
  return artistCredit.map((credit) => (credit.name || "") + (credit.joinphrase || "")).join("").trim() || "Unknown Artist";
}

async function flushBatch(batch) {
  if (batch.length === 0) return;
  // SQLite via Prisma doesn't support a true bulk upsert, so we run the
  // batch as a transaction of individual upserts. This is still much
  // faster than awaiting each one outside a transaction, because Prisma
  // can pipeline them over one connection instead of round-tripping.
  await prisma.$transaction(
    batch.map((album) =>
      prisma.album.upsert({
        where: { musicbrainzId: album.musicbrainzId },
        update: {
          title: album.title,
          artistName: album.artistName,
          releaseYear: album.releaseYear,
          releaseType: album.releaseType,
          mbRatingCount: album.mbRatingCount,
        },
        create: album,
      })
    )
  );
}

async function main() {
  const { filePath, flags } = parseArgs(process.argv);

  if (!filePath) {
    console.error("Usage: node scripts/import-musicbrainz.js /path/to/mbdump/release-group [--limit=N] [--types=Album,EP] [--min-year=1900]");
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    console.error("Did you extract the .tar.xz dump first? See the comment at the top of this script.");
    process.exit(1);
  }

  console.log(`Importing from ${filePath}`);
  console.log(`Keeping primary-types: ${flags.types.join(", ")}`);
  if (flags.minYear) console.log(`Skipping releases before ${flags.minYear}`);
  if (flags.limit !== Infinity) console.log(`Stopping after ${flags.limit} albums`);

  const fileStream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let batch = [];
  let imported = 0;
  let skipped = 0;
  let lineNumber = 0;
  const startedAt = Date.now();

  for await (const line of rl) {
    lineNumber++;
    if (!line.trim()) continue;
    if (imported >= flags.limit) break;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch (err) {
      // A small number of malformed lines is expected in any large dump;
      // log and move on rather than crashing the whole import.
      console.warn(`Line ${lineNumber}: failed to parse JSON, skipping`);
      skipped++;
      continue;
    }

    const primaryType = entry["primary-type"];
    if (!flags.types.includes(primaryType)) {
      skipped++;
      continue;
    }

    const releaseYear = extractYear(entry["first-release-date"]);
    if (flags.minYear && releaseYear && releaseYear < flags.minYear) {
      skipped++;
      continue;
    }

    batch.push({
      musicbrainzId: entry.id,
      title: entry.title,
      artistName: extractArtistName(entry["artist-credit"]),
      releaseYear,
      releaseType: primaryType,
      mbRatingCount: entry.rating ? (entry.rating["votes-count"] || 0) : 0,
    });
    imported++;

    if (batch.length >= BATCH_SIZE) {
      await flushBatch(batch);
      batch = [];
      const elapsedSec = (Date.now() - startedAt) / 1000;
      const rate = Math.round(imported / elapsedSec);
      console.log(`Imported ${imported} albums so far (${rate}/sec, line ${lineNumber})`);
    }
  }

  await flushBatch(batch);

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\nDone. Imported ${imported} albums, skipped ${skipped} lines, in ${elapsedSec}s.`);
  console.log("Cover art was not imported -- see the script header for why. Fetch it lazily per-album instead.");

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Import failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
