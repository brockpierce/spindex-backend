const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();

// GET /api/messages/conversations — list all conversations for current user
router.get("/conversations", requireAuth, async (req, res, next) => {
  try {
    const participants = await prisma.conversationParticipant.findMany({
      where: { userId: req.userId },
      include: {
        conversation: {
          include: {
            participants: {
              include: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true } } }
            },
            messages: {
              orderBy: { createdAt: "desc" },
              take: 1,
              include: { sender: { select: { username: true } } }
            }
          }
        }
      },
      orderBy: { conversation: { updatedAt: "desc" } }
    });

    const conversations = participants.map((p) => {
      const conv = p.conversation;
      const otherParticipant = conv.participants.find((cp) => cp.userId !== req.userId);
      const lastMessage = conv.messages[0] || null;
      const unread = lastMessage && p.lastReadAt
        ? new Date(lastMessage.createdAt) > new Date(p.lastReadAt) && lastMessage.sender?.username !== undefined && conv.participants.find(cp => cp.userId === req.userId) !== undefined
        : lastMessage && lastMessage.senderId !== req.userId && !p.lastReadAt;

      return {
        id: conv.id,
        otherUser: otherParticipant?.user || null,
        lastMessage: lastMessage ? { text: lastMessage.text, senderUsername: lastMessage.sender?.username, createdAt: lastMessage.createdAt } : null,
        unread: Boolean(lastMessage && lastMessage.senderId !== req.userId && (!p.lastReadAt || new Date(lastMessage.createdAt) > new Date(p.lastReadAt))),
        updatedAt: conv.updatedAt,
      };
    });

    const unreadCount = conversations.filter((c) => c.unread).length;
    res.json({ conversations, unreadCount });
  } catch (e) { next(e); }
});

// POST /api/messages/conversations — start or get conversation with a user
router.post("/conversations", requireAuth, async (req, res, next) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: "username required." });

    const otherUser = await prisma.user.findFirst({ where: { username }, select: { id: true, username: true, displayName: true, avatarUrl: true } });
    if (!otherUser) return res.status(404).json({ error: "User not found." });
    if (otherUser.id === req.userId) return res.status(400).json({ error: "Cannot message yourself." });

    // Check if conversation already exists
    const existing = await prisma.conversation.findFirst({
      where: {
        AND: [
          { participants: { some: { userId: req.userId } } },
          { participants: { some: { userId: otherUser.id } } },
        ]
      },
      include: { participants: { include: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true } } } } }
    });

    if (existing) return res.json({ conversation: { id: existing.id, otherUser } });

    const conv = await prisma.conversation.create({
      data: {
        participants: {
          create: [{ userId: req.userId }, { userId: otherUser.id }]
        }
      }
    });

    res.status(201).json({ conversation: { id: conv.id, otherUser } });
  } catch (e) { next(e); }
});

// GET /api/messages/conversations/:id — get messages in a conversation
router.get("/conversations/:id", requireAuth, async (req, res, next) => {
  try {
    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId: req.params.id, userId: req.userId } }
    });
    if (!participant) return res.status(403).json({ error: "Not in this conversation." });

    const messages = await prisma.directMessage.findMany({
      where: { conversationId: req.params.id },
      include: { sender: { select: { username: true, avatarUrl: true } } },
      orderBy: { createdAt: "asc" },
      take: 100,
    });

    // Get other participant
    const allParticipants = await prisma.conversationParticipant.findMany({
      where: { conversationId: req.params.id },
      include: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true } } }
    });
    const otherUser = allParticipants.find((p) => p.userId !== req.userId)?.user;

    // Mark as read
    await prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId: req.params.id, userId: req.userId } },
      data: { lastReadAt: new Date() }
    });

    res.json({ messages: messages.map((m) => ({ id: m.id, text: m.text, senderUsername: m.sender.username, createdAt: m.createdAt, isOwn: m.senderId === req.userId })), otherUser });
  } catch (e) { next(e); }
});

// POST /api/messages/conversations/:id — send a message
router.post("/conversations/:id", requireAuth, async (req, res, next) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: "Message text required." });

    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId: req.params.id, userId: req.userId } }
    });
    if (!participant) return res.status(403).json({ error: "Not in this conversation." });

    const message = await prisma.directMessage.create({
      data: { conversationId: req.params.id, senderId: req.userId, text: text.trim() },
      include: { sender: { select: { username: true } } }
    });

    // Update conversation updatedAt
    await prisma.conversation.update({ where: { id: req.params.id }, data: { updatedAt: new Date() } });

    res.status(201).json({ message: { id: message.id, text: message.text, senderUsername: message.sender.username, createdAt: message.createdAt, isOwn: true } });
  } catch (e) { next(e); }
});

// GET /api/messages/unread — unread count for nav badge
router.get("/unread", requireAuth, async (req, res, next) => {
  try {
    const participants = await prisma.conversationParticipant.findMany({
      where: { userId: req.userId },
      include: {
        conversation: {
          include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } }
        }
      }
    });

    const unreadCount = participants.filter((p) => {
      const lastMsg = p.conversation.messages[0];
      return lastMsg && lastMsg.senderId !== req.userId && (!p.lastReadAt || new Date(lastMsg.createdAt) > new Date(p.lastReadAt));
    }).length;

    res.json({ unreadCount });
  } catch (e) { next(e); }
});

module.exports = router;
