const prisma = require("./prisma");

// Permanently delete a user and ALL of their data in one atomic transaction.
// Children are deleted before parents so SQLite FK enforcement never trips; if
// any step fails the whole thing rolls back, so an account is never left
// half-deleted. Throws on failure (err.code === "USER_NOT_FOUND" if no user).
//
// Required by App Store guideline 5.1.1(v).
async function deleteUserCompletely(userId) {
  const U = userId;
  const me = await prisma.user.findUnique({ where: { id: U }, select: { username: true } });
  if (!me) {
    const e = new Error("User not found");
    e.code = "USER_NOT_FOUND";
    throw e;
  }
  const UN = me.username;

  // Ids of the user's own content, to clean up rows that reference it without a
  // cascade FK (reactions/comments key off a generic item id; saved lists/mixes
  // point at the user's lists/mixes; conversations cascade from their id).
  const [reviews, posts, mixes, lists, parts] = await Promise.all([
    prisma.review.findMany({ where: { userId: U }, select: { id: true } }),
    prisma.textPost.findMany({ where: { userId: U }, select: { id: true } }),
    prisma.albumMix.findMany({ where: { userId: U }, select: { id: true } }),
    prisma.list.findMany({ where: { userId: U }, select: { id: true } }),
    prisma.conversationParticipant.findMany({ where: { userId: U }, select: { conversationId: true } }),
  ]);
  const listIds = lists.map((l) => l.id);
  const mixIds = mixes.map((m) => m.id);
  const convIds = parts.map((p) => p.conversationId);
  const itemIds = [...reviews.map((r) => r.id), ...posts.map((p) => p.id)];

  await prisma.$transaction([
    // interactions: the user's own, plus everyone's on the user's content
    prisma.reviewReaction.deleteMany({ where: { OR: [{ userId: U }, { reviewId: { in: itemIds } }] } }),
    prisma.reviewComment.deleteMany({ where: { OR: [{ userId: U }, { reviewId: { in: itemIds } }] } }),
    // notifications to AND about the user (recipientId + actorId are both FKs)
    prisma.notification.deleteMany({ where: { OR: [{ recipientId: U }, { actorId: U }] } }),
    prisma.favorite.deleteMany({ where: { userId: U } }),
    prisma.listenStatus.deleteMany({ where: { userId: U } }),
    prisma.qotdResponse.deleteMany({ where: { userId: U } }),
    prisma.songReview.deleteMany({ where: { userId: U } }),
    prisma.albumTag.deleteMany({ where: { createdByUserId: U } }),
    prisma.guestbookEntry.deleteMany({ where: { OR: [{ authorId: U }, { profileUsername: UN }] } }),
    prisma.albumOfTheDay.deleteMany({ where: { authorId: U } }),
    prisma.interview.deleteMany({ where: { authorId: U } }),
    prisma.follow.deleteMany({ where: { OR: [{ followerId: U }, { followedId: U }] } }),
    // conversations cascade to participants + messages (incl. the other party's)
    prisma.conversation.deleteMany({ where: { id: { in: convIds } } }),
    // lists: children, saves (the user's + saves of the user's lists), then lists
    prisma.listItem.deleteMany({ where: { listId: { in: listIds } } }),
    prisma.savedList.deleteMany({ where: { OR: [{ userId: U }, { listId: { in: listIds } }] } }),
    prisma.list.deleteMany({ where: { userId: U } }),
    // mixes: saves + shares (the user's + of the user's mixes), then mixes (items cascade)
    prisma.savedMix.deleteMany({ where: { OR: [{ userId: U }, { mixId: { in: mixIds } }] } }),
    prisma.mixShare.deleteMany({ where: { OR: [{ userId: U }, { mixId: { in: mixIds } }] } }),
    prisma.albumMix.deleteMany({ where: { userId: U } }),
    // the user's own content (TextPostImage / ReviewComment cascade on delete)
    prisma.textPost.deleteMany({ where: { userId: U } }),
    prisma.review.deleteMany({ where: { userId: U } }),
    // keep community albums the user added — just drop the attribution (no FK)
    prisma.album.updateMany({ where: { createdByUserId: U }, data: { createdByUserId: null } }),
    // finally the account itself
    prisma.user.delete({ where: { id: U } }),
  ]);
}

module.exports = { deleteUserCompletely };
