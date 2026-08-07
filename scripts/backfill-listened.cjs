// One-time, idempotent backfill: every existing review => a "listened" status.
// Insert-only — never overwrites an existing status. Dry-run by default;
// pass --apply to write. Safe to re-run.
try { require('dotenv').config(); } catch (e) {}
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const reviews = await prisma.review.findMany({ select: { userId: true, albumId: true } });
  const pairs = [...new Map(reviews.map(r => [r.userId + '|' + r.albumId, r])).values()];
  const existing = await prisma.listenStatus.findMany({ select: { userId: true, albumId: true } });
  const existingSet = new Set(existing.map(e => e.userId + '|' + e.albumId));
  const albumIds = new Set((await prisma.album.findMany({ select: { id: true } })).map(a => a.id));
  const missingAlbum = pairs.filter(p => !albumIds.has(p.albumId));
  const toInsert = pairs.filter(p => !existingSet.has(p.userId + '|' + p.albumId) && albumIds.has(p.albumId));
  console.log(`total reviews: ${reviews.length}`);
  console.log(`distinct user+album: ${pairs.length}`);
  console.log(`already have a listen-status (skipped): ${pairs.filter(p => existingSet.has(p.userId + '|' + p.albumId)).length}`);
  console.log(`reviewed album no longer exists (skipped): ${missingAlbum.length}`);
  console.log(`>>> WILL INSERT (status=listened): ${toInsert.length}`);
  if (process.argv.includes('--apply')) {
    const res = await prisma.listenStatus.createMany({
      data: toInsert.map(p => ({ userId: p.userId, albumId: p.albumId, status: 'listened' })),
      skipDuplicates: true,
    });
    console.log(`APPLIED — inserted ${res.count} rows.`);
  } else {
    console.log('DRY RUN — nothing written. Re-run with --apply to write.');
  }
  await prisma.$disconnect();
})().catch(async (e) => { console.error('ERROR:', e.message); await prisma.$disconnect(); process.exit(1); });
