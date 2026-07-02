const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function publicList(list) {
  return {
    id: list.id,
    title: list.title,
    description: list.description,
    isPublic: list.isPublic,
    owner: list.user ? { id: list.user.id, username: list.user.username } : undefined,
    albumIds: list.items ? list.items.map((item) => item.albumId) : undefined,
  };
}

// GET /api/lists/me
router.get("/me", requireAuth, async (req, res) => {
  const lists = await prisma.list.findMany({
    where: { userId: req.session.userId },
    include: { items: { orderBy: { position: "asc" } } },
    orderBy: { createdAt: "desc" },
  });
  res.json({ lists: lists.map(publicList) });
});

// GET /api/lists/saved
// "Saved lists" -- other people's public lists this user has bookmarked.
// Modeled as a SavedList join table; see note in schema if it's not
// there yet -- this route assumes prisma.savedList exists.
router.get("/saved", requireAuth, async (req, res) => {
  const saved = await prisma.savedList.findMany({
    where: { userId: req.session.userId },
    include: { list: { include: { items: true, user: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json({ lists: saved.map((s) => publicList(s.list)) });
});

// POST /api/lists/:listId/save
router.post("/:listId/save", requireAuth, async (req, res) => {
  const { listId } = req.params;
  const list = await prisma.list.findUnique({ where: { id: listId } });
  if (!list) return res.status(404).json({ error: "List not found." });
  if (list.userId === req.session.userId) {
    return res.status(400).json({ error: "That's your own list." });
  }

  await prisma.savedList.upsert({
    where: { userId_listId: { userId: req.session.userId, listId } },
    update: {},
    create: { userId: req.session.userId, listId },
  });
  res.json({ ok: true });
});

// DELETE /api/lists/:listId/save  (unsave)
router.delete("/:listId/save", requireAuth, async (req, res) => {
  await prisma.savedList.deleteMany({ where: { userId: req.session.userId, listId: req.params.listId } });
  res.json({ ok: true });
});

// POST /api/lists  { title, description }
router.post("/", requireAuth, async (req, res) => {
  const { title, description } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: "List title is required." });
  }
  const list = await prisma.list.create({
    data: { userId: req.session.userId, title: title.trim(), description: description || null },
    include: { items: true },
  });
  res.status(201).json({ list: publicList(list) });
});

// GET /api/lists/:id
router.get("/:id", async (req, res) => {
  const list = await prisma.list.findUnique({
    where: { id: req.params.id },
    include: { items: { orderBy: { position: "asc" } }, user: true },
  });
  if (!list) return res.status(404).json({ error: "List not found." });
  res.json({ list: publicList(list) });
});

// POST /api/lists/:id/items  { albumId }
// Only the list's owner can add to it -- this is enforced here, not just
// hidden in the UI, since the UI's "remove" button being absent for
// someone else's list is a display choice, not a security boundary.
router.post("/:id/items", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { albumId } = req.body;

  const list = await prisma.list.findUnique({ where: { id } });
  if (!list) return res.status(404).json({ error: "List not found." });
  if (list.userId !== req.session.userId) {
    return res.status(403).json({ error: "You can only edit your own lists." });
  }

  const existingCount = await prisma.listItem.count({ where: { listId: id } });
  const item = await prisma.listItem.upsert({
    where: { listId_albumId: { listId: id, albumId } },
    update: {},
    create: { listId: id, albumId, position: existingCount + 1 },
  });
  res.status(201).json({ item });
});

// DELETE /api/lists/:id/items/:albumId
router.delete("/:id/items/:albumId", requireAuth, async (req, res) => {
  const { id, albumId } = req.params;
  const list = await prisma.list.findUnique({ where: { id } });
  if (!list) return res.status(404).json({ error: "List not found." });
  if (list.userId !== req.session.userId) {
    return res.status(403).json({ error: "You can only edit your own lists." });
  }
  await prisma.listItem.deleteMany({ where: { listId: id, albumId } });
  res.json({ ok: true });
});

module.exports = router;
