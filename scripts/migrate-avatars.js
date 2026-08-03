// One-off migration: shrink oversized base64 avatars in place (spec phase 1c).
//
// RUN IN THE RENDER SHELL, after a backup:
//   1) Back up (targeted dump — NOT sqlite3 .backup, which stalls the live app):
//        sqlite3 /var/data/dev.db ".dump User Review ReviewComment ReviewReaction Follow AlbumMix AlbumMixItem TextPost ListenStatus Favorite" | gzip > /var/data/userdata-$(date +%F).sql.gz
//   2) Install the resizer (native build; if it fails, see the jimp note below):
//        npm install sharp
//   3) Run:
//        node scripts/migrate-avatars.js
//
// Behavior:
//   - Processes only avatars larger than THRESHOLD, oldest account first.
//   - Resizes to 400px longest edge, JPEG q82, writes back a data URL.
//   - Logs before/after KB for every row.
//   - Resumable: re-running only touches rows still over THRESHOLD, so an
//     interrupted run is safe to restart.
//   - Skips undecodable/failed rows instead of aborting.
//   - Paces itself (SLEEP_MS between rows) — disk I/O contention on this volume
//     has taken the app down before.

const prisma = require("../lib/prisma");

let sharp;
try {
  sharp = require("sharp");
} catch (e) {
  console.error("sharp is not installed. Run:  npm install sharp");
  console.error("(If sharp won't build in the shell, swap in jimp — see the note at the bottom of this file.)");
  process.exit(1);
}

const THRESHOLD = 200 * 1024; // only rows bigger than this (bytes)
const MAX_DIM = 400;
const QUALITY = 82;
const SLEEP_MS = 150; // pause between rows so the live app stays responsive

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Decode a base64 (or percent-encoded) data URL to a Buffer. Returns null if it
// isn't a data URL we can decode.
function decodeDataUrl(s) {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(s || "");
  if (!m) return null;
  const isB64 = !!m[2];
  try {
    return isB64 ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
  } catch (e) {
    return null;
  }
}

async function main() {
  // Pull ids + lengths only — never load every blob into memory at once.
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, username, LENGTH(avatarUrl) AS len FROM "User"
     WHERE avatarUrl IS NOT NULL AND LENGTH(avatarUrl) > ${THRESHOLD}
     ORDER BY createdAt ASC`
  );
  console.log(`${rows.length} oversized avatars to process (> ${Math.round(THRESHOLD / 1024)} KB)\n`);

  let done = 0, skipped = 0, freed = 0;
  for (const row of rows) {
    const label = row.username || row.id;
    try {
      // Re-read the blob per row so memory stays flat.
      const user = await prisma.user.findUnique({ where: { id: row.id }, select: { avatarUrl: true } });
      const buf = decodeDataUrl(user && user.avatarUrl);
      if (!buf || buf.length === 0) {
        console.warn(`skip ${label}: could not decode avatar`);
        skipped++;
        continue;
      }
      const out = await sharp(buf)
        .rotate() // apply EXIF orientation, then it's dropped on re-encode
        .resize(MAX_DIM, MAX_DIM, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: QUALITY })
        .toBuffer();
      const dataUrl = "data:image/jpeg;base64," + out.toString("base64");

      // Safety: never write back something larger than what's there.
      if (dataUrl.length >= Number(row.len)) {
        console.warn(`skip ${label}: re-encode not smaller (${Math.round(Number(row.len)/1024)}KB), leaving as-is`);
        skipped++;
        continue;
      }

      await prisma.user.update({ where: { id: row.id }, data: { avatarUrl: dataUrl } });
      const beforeKB = Math.round(Number(row.len) / 1024);
      const afterKB = Math.round(dataUrl.length / 1024);
      freed += Number(row.len) - dataUrl.length;
      done++;
      console.log(`${done}/${rows.length}  ${label}: ${beforeKB} KB -> ${afterKB} KB`);
    } catch (e) {
      console.warn(`skip ${label}: ${e.message}`);
      skipped++;
    }
    await sleep(SLEEP_MS);
  }

  console.log(`\nDone. resized=${done}  skipped=${skipped}  freed=~${Math.round(freed / 1024 / 1024)} MB`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// --- jimp fallback -----------------------------------------------------------
// If `npm install sharp` fails to build in the shell, install jimp instead
// (pure JS, no native compile):  npm install jimp
// then replace the sharp block above with:
//   const Jimp = require("jimp");
//   const image = await Jimp.read(buf);
//   image.scaleToFit(MAX_DIM, MAX_DIM);       // never upscales
//   image.quality(QUALITY);
//   const out = await image.getBufferAsync(Jimp.MIME_JPEG);
