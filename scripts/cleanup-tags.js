/**
 * One-time cleanup: re-normalize existing AlbumTag values to the current rule
 * ("Funk / Soul" -> "funk-soul", etc). Pure DB — no network calls, runs in
 * seconds. Safe to run more than once (idempotent).
 *
 *   node scripts/cleanup-tags.js
 */
require("dotenv").config();
const prisma = require("../lib/prisma");

const normalizeTag = (raw) => String(raw)
  .toLowerCase()
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

(async () => {
  const rows = await prisma.albumTag.findMany({ select: { id: true, albumId: true, tag: true } });
  let fixed = 0, removed = 0;
  for (const r of rows) {
    const norm = normalizeTag(r.tag);
    if (norm === r.tag) continue;
    if (!norm) { await prisma.albumTag.delete({ where: { id: r.id } }); removed++; continue; }
    // If the album already has the normalized tag, drop this duplicate; else rename.
    const existing = await prisma.albumTag.findUnique({
      where: { albumId_tag: { albumId: r.albumId, tag: norm } },
      select: { id: true },
    });
    if (existing) { await prisma.albumTag.delete({ where: { id: r.id } }); removed++; }
    else { await prisma.albumTag.update({ where: { id: r.id }, data: { tag: norm } }); fixed++; }
  }
  console.log(`Done. Renamed ${fixed}, removed ${removed} duplicate/empty.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
