const prisma = require("./prisma");

// Parse @mentions from text and create "mention" notifications for each
// real, non-self user mentioned (deduped). Never throws — mention notifs
// must not break the parent action.
async function notifyMentions(text, actorId, referenceId) {
  try {
    if (!text) return;
    const names = [...new Set((text.match(/@[a-zA-Z0-9_.]+/g) || []).map((m) => m.slice(1).toLowerCase()))];
    if (!names.length) return;
    const users = await prisma.user.findMany({ where: { username: { in: names } }, select: { id: true } });
    await Promise.all(
      users
        .filter((u) => u.id !== actorId)
        .map((u) => prisma.notification.create({
          data: { recipientId: u.id, actorId, type: "mention", referenceId: referenceId || null },
        }))
    );
  } catch (e) { /* mention notifications are best-effort */ }
}

module.exports = { notifyMentions };
