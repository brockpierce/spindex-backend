const prisma = require("./prisma");

// Reactions, comments and notifications point at a feed item by a bare id with
// no FK (one id column serves reviews, text posts, mix shares, song reviews and
// QOTD answers), so deleting the item leaves them behind: inflated like/comment
// counts and notifications that link nowhere. Run these in the same
// $transaction as the item delete.
function itemTraceDeletes(ids) {
  return [
    prisma.reviewReaction.deleteMany({ where: { reviewId: { in: ids } } }),
    prisma.reviewComment.deleteMany({ where: { reviewId: { in: ids } } }),
    prisma.notification.deleteMany({ where: { referenceId: { in: ids } } }),
  ];
}

module.exports = { itemTraceDeletes };
