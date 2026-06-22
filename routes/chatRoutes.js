const express = require("express");

const router = express.Router();

const {
  getMessagesBySeller,
  getMessagesByUser,
  clearChat,
  markRead,
  getSellerUserIds,
  getSellerConversations,
  getAllConversations,
} = require("../utils/messages");

function requireAdmin(req, res, next) {
  if (req.session?.admin) {
    return next();
  }
  return res.status(401).json({ success: false, message: "Unauthorized" });
}

function isSuper(req) {
  return req.session?.admin?.role === "superadmin";
}

// A superadmin may act on any seller's chat by passing that seller's id
// explicitly; everyone else is locked to their own seller id.
function sellerScope(req, explicit) {
  if (isSuper(req) && explicit) {
    return String(explicit);
  }
  return req.session.admin.id;
}

// GET ALL MESSAGES (only this seller's)
router.get("/messages", requireAdmin, async (req, res) => {
  try {
    const messages = await getMessagesBySeller(req.session.admin.id);
    res.json(messages);
  } catch (err) {
    console.error("messages error:", err.message);
    res.status(500).json({ success: false });
  }
});

// GET MESSAGES FOR ONE BUYER (so the chat view doesn't pull the full history)
router.get("/messages/:userId", requireAdmin, async (req, res) => {
  try {
    const messages = await getMessagesByUser(
      sellerScope(req, req.query.sellerId),
      req.params.userId
    );
    res.json(messages);
  } catch (err) {
    console.error("messages/:userId error:", err.message);
    res.status(500).json({ success: false });
  }
});

// CONVERSATION LIST (one row per buyer: last message + unread count).
// A superadmin gets every seller's conversations instead of just their own.
router.get("/conversations", requireAdmin, async (req, res) => {
  try {
    const conversations = isSuper(req)
      ? await getAllConversations()
      : await getSellerConversations(req.session.admin.id);
    res.json(conversations);
  } catch (err) {
    console.error("conversations error:", err.message);
    res.status(500).json({ success: false });
  }
});

// CLEAR CHAT (only this seller's conversation with the user)
router.post("/clear-chat", requireAdmin, async (req, res) => {
  try {
    const { userId, sellerId } = req.body;
    await clearChat(sellerScope(req, sellerId), userId);
    res.json({ success: true });
  } catch (err) {
    console.error("clear-chat error:", err.message);
    res.status(500).json({ success: false });
  }
});

// GET USERS (distinct users that have messaged this seller)
router.get("/users", requireAdmin, async (req, res) => {
  try {
    const users = await getSellerUserIds(req.session.admin.id);
    res.json(users);
  } catch (err) {
    console.error("users error:", err.message);
    res.status(500).json({ success: false });
  }
});

// MARK READ
router.post("/mark-read", requireAdmin, async (req, res) => {
  try {
    const { userId, sellerId } = req.body;
    await markRead(sellerScope(req, sellerId), userId);
    res.json({ success: true });
  } catch (err) {
    console.error("mark-read error:", err.message);
    res.status(500).json({ success: false });
  }
});

module.exports = router;