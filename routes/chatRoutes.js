const express = require("express");

const router = express.Router();

const {
  getMessagesBySeller,
  clearChat,
  markRead,
  getSellerUserIds,
} = require("../utils/messages");

function requireAdmin(req, res, next) {
  if (req.session?.admin) {
    return next();
  }
  return res.status(401).json({ success: false, message: "Unauthorized" });
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

// CLEAR CHAT (only this seller's conversation with the user)
router.post("/clear-chat", requireAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    await clearChat(req.session.admin.id, userId);
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
    const { userId } = req.body;
    await markRead(req.session.admin.id, userId);
    res.json({ success: true });
  } catch (err) {
    console.error("mark-read error:", err.message);
    res.status(500).json({ success: false });
  }
});

module.exports = router;