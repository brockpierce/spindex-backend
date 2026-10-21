const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { perUserLimiter } = require("../lib/rateLimit");
const { deleteUserCompletely } = require("../lib/deleteUser");
const router = express.Router();

const TYPES = new Set(["post", "comment", "review", "user", "mix"]);
const reportLimiter = perUserLimiter({ windowMs: 60 * 1000, max: 20, message: "You're reporting too fast." });

const ADMIN_USERNAME = "brock";
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || null;
async function requireAdmin(req, res, next) {
  // Prefer the immutable ADMIN_USER_ID; fall back to username only while unset.
  if (ADMIN_USER_ID) {
    if (req.userId !== ADMIN_USER_ID) return res.status(403).json({ error: "Admin only." });
    return next();
  }
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { username: true } });
  if (!user || user.username !== ADMIN_USERNAME) return res.status(403).json({ error: "Admin only." });
  next();
}

// Pull the reported content so the admin can read it in-context. Returns null
// when the target was already deleted (so the report can just be cleared).
async function resolveReportTarget(type, id) {
  try {
    if (type === "user") {
      const u = await prisma.user.findUnique({ where: { id }, select: { id: true, username: true, displayName: true } });
      return u ? { kind: "user", id: u.id, username: u.username, displayName: u.displayName } : null;
    }
    if (type === "review") {
      const rv = await prisma.review.findUnique({ where: { id }, include: { user: { select: { username: true } }, album: { select: { title: true, artistName: true } } } });
      if (rv) return { kind: "review", username: rv.user?.username, text: rv.reviewText || "", albumId: rv.albumId, album: rv.album ? `${rv.album.title} — ${rv.album.artistName}` : null };
      // A "review" report can actually point at a re-listen — the feed shows
      // re-listens as review cards, so that's what a reporter taps.
      const rl = await prisma.relisten.findUnique({ where: { id }, include: { user: { select: { username: true } }, album: { select: { title: true, artistName: true } } } });
      return rl ? { kind: "review", isRelisten: true, username: rl.user?.username, text: rl.review || "", albumId: rl.albumId, album: rl.album ? `${rl.album.title} — ${rl.album.artistName}` : null } : null;
    }
    if (type === "post") {
      const p = await prisma.textPost.findUnique({ where: { id }, include: { user: { select: { username: true } } } });
      return p ? { kind: "post", username: p.user?.username, text: p.text || "" } : null;
    }
    if (type === "mix") {
      const m = await prisma.mixShare.findUnique({ where: { id }, include: { user: { select: { username: true } } } });
      return m ? { kind: "mix", username: m.user?.username, text: m.caption || "" } : null;
    }
    if (type === "comment") {
      const c = await prisma.reviewComment.findUnique({ where: { id }, include: { user: { select: { username: true } } } });
      return c ? { kind: "comment", username: c.user?.username, text: c.text || "" } : null;
    }
  } catch (e) { /* fall through */ }
  return null;
}

// Delete the reported content. Handles a "review" id that's actually a re-listen.
async function removeReportedContent(type, id) {
  if (type === "review") {
    const r = await prisma.review.deleteMany({ where: { id } });
    if (r.count === 0) await prisma.relisten.deleteMany({ where: { id } });
  } else if (type === "post") {
    await prisma.textPost.deleteMany({ where: { id } });
  } else if (type === "mix") {
    await prisma.mixShare.deleteMany({ where: { id } });
  } else if (type === "comment") {
    await prisma.reviewComment.deleteMany({ where: { id } });
  }
  // "user": nothing to remove — use ban.
}

// The user who owns the reported content (for banning). Null if already gone.
async function reportedContentOwnerId(type, id) {
  if (type === "user") return id;
  if (type === "review") {
    const rv = await prisma.review.findUnique({ where: { id }, select: { userId: true } });
    if (rv) return rv.userId;
    const rl = await prisma.relisten.findUnique({ where: { id }, select: { userId: true } });
    return rl ? rl.userId : null;
  }
  if (type === "post") {
    const p = await prisma.textPost.findUnique({ where: { id }, select: { userId: true } });
    return p ? p.userId : null;
  }
  if (type === "mix") {
    const m = await prisma.mixShare.findUnique({ where: { id }, select: { userId: true } });
    return m ? m.userId : null;
  }
  if (type === "comment") {
    const c = await prisma.reviewComment.findUnique({ where: { id }, select: { userId: true } });
    return c ? c.userId : null;
  }
  return null;
}

// GET /api/reports — admin: the report queue, newest first, with context.
router.get("/", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const reports = await prisma.report.findMany({ orderBy: { createdAt: "desc" }, take: 300 });
    const reporterIds = [...new Set(reports.map((r) => r.reporterId))];
    const reporters = reporterIds.length
      ? await prisma.user.findMany({ where: { id: { in: reporterIds } }, select: { id: true, username: true } })
      : [];
    const reporterMap = Object.fromEntries(reporters.map((u) => [u.id, u.username]));
    const items = await Promise.all(reports.map(async (r) => ({
      id: r.id,
      targetType: r.targetType,
      targetId: r.targetId,
      reason: r.reason,
      createdAt: r.createdAt,
      reporter: reporterMap[r.reporterId] || null,
      target: await resolveReportTarget(r.targetType, r.targetId),
    })));
    res.json({ reports: items });
  } catch (e) { next(e); }
});

// DELETE /api/reports/:id — admin: clear a report once it's been handled.
router.delete("/:id", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await prisma.report.deleteMany({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/reports/:id/remove — admin: delete the reported content and clear
// every report pointing at it.
router.post("/:id/remove", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const report = await prisma.report.findUnique({ where: { id: req.params.id } });
    if (!report) return res.status(404).json({ error: "Report not found." });
    await removeReportedContent(report.targetType, report.targetId);
    await prisma.report.deleteMany({ where: { targetType: report.targetType, targetId: report.targetId } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/reports/:id/ban — admin: remove the offending user entirely (account
// + all their content) and clear reports about them or filed by them.
router.post("/:id/ban", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const report = await prisma.report.findUnique({ where: { id: req.params.id } });
    if (!report) return res.status(404).json({ error: "Report not found." });
    const ownerId = await reportedContentOwnerId(report.targetType, report.targetId);
    if (!ownerId) return res.status(404).json({ error: "User not found — the content may already be deleted." });
    if (ownerId === req.userId) return res.status(400).json({ error: "You can't ban yourself." });
    await deleteUserCompletely(ownerId);
    // Clear the triggering report plus any report about this user or filed by them.
    // (Reports on their other, now-deleted content simply show "deleted" and can
    // be dismissed.)
    await prisma.report.deleteMany({ where: { OR: [{ id: report.id }, { targetType: "user", targetId: ownerId }, { reporterId: ownerId }] } });
    res.json({ ok: true, bannedUserId: ownerId });
  } catch (e) { next(e); }
});

// POST /api/reports  { targetType, targetId, reason? } — file a report for admin review
router.post("/", requireAuth, reportLimiter, async (req, res, next) => {
  try {
    const { targetType, targetId, reason } = req.body;
    if (!TYPES.has(targetType) || !targetId) {
      return res.status(400).json({ error: "Invalid report." });
    }
    await prisma.report.create({
      data: {
        reporterId: req.userId,
        targetType,
        targetId: String(targetId),
        reason: reason ? String(reason).slice(0, 500) : null,
      },
    });
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
