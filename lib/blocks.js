const prisma = require("./prisma");

// All user ids that should be mutually hidden from `userId`: everyone they have
// blocked PLUS everyone who has blocked them (blocking hides content in both
// directions). Returns an array of ids (empty if none). Use to filter feeds,
// comments, and message lists.
async function getBlockedIds(userId) {
  if (!userId) return [];
  const rows = await prisma.block.findMany({
    where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
    select: { blockerId: true, blockedId: true },
  });
  const ids = new Set();
  for (const r of rows) ids.add(r.blockerId === userId ? r.blockedId : r.blockerId);
  return [...ids];
}

// True if a and b have a block in EITHER direction.
async function isBlockedBetween(a, b) {
  if (!a || !b || a === b) return false;
  const row = await prisma.block.findFirst({
    where: { OR: [
      { blockerId: a, blockedId: b },
      { blockerId: b, blockedId: a },
    ] },
    select: { id: true },
  });
  return !!row;
}

module.exports = { getBlockedIds, isBlockedBetween };
