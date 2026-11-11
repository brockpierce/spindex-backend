const prisma = require("./prisma");
const { getBlockedIds } = require("./blocks");

// Parse @mentions from text and create "mention" notifications for each
// real, non-self user mentioned (deduped). With { once: true }, anyone already
// notified about this item is skipped — for edits, so re-saving a review doesn't
// re-ping everyone it mentions. Never throws — mention notifs must not break
// the parent action.
async function notifyMentions(text, actorId, referenceId, { once = false } = {}) {
  try {
    if (!text) return;
    if (typeof text !== "string") return;
    // Same charset as usernames, so a trailing "." ("thanks @bob.") isn't swallowed.
    const names = [...new Set((text.match(/@[a-zA-Z0-9_]{2,20}/g) || []).map((m) => m.slice(1).toLowerCase()))];
    if (!names.length) return;
    const users = await prisma.user.findMany({ where: { username: { in: names } }, select: { id: true } });
    // Don't let a blocked user reach someone by @mentioning them (either direction).
    const blocked = new Set(await getBlockedIds(actorId));
    const already = once && referenceId
      ? new Set((await prisma.notification.findMany({
          where: { actorId, type: "mention", referenceId, recipientId: { in: users.map((u) => u.id) } },
          select: { recipientId: true },
        })).map((n) => n.recipientId))
      : new Set();
    await Promise.all(
      users
        .filter((u) => u.id !== actorId && !blocked.has(u.id) && !already.has(u.id))
        .map((u) => prisma.notification.create({
          data: { recipientId: u.id, actorId, type: "mention", referenceId: referenceId || null },
        }))
    );
  } catch (e) { /* mention notifications are best-effort */ }
}

module.exports = { notifyMentions };
