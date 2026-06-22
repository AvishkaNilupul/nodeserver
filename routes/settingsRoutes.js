const express = require("express");

const {
  getAdminById,
  sanitizeAdmin,
  setTelegramUsername,
  startTelegramLink,
  unlinkTelegram,
} = require("../utils/admins");
const { getMe } = require("../utils/telegram");
const telegramBot = require("../utils/telegramBot");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

// Resolve the bot's @username so the UI can build a "message the bot" link.
// Prefer the value the listener already cached; fall back to a live getMe.
async function resolveBotUsername() {
  const cached = telegramBot.getBotUsername();
  if (cached) return cached;
  const me = await getMe();
  return me?.username || null;
}

// Current admin's Telegram link status (used to render the Settings panel).
router.get("/me/telegram", requireAdmin, async (req, res) => {
  try {
    const admin = getAdminById(req.session.admin.id);
    if (!admin) {
      return res
        .status(404)
        .json({ success: false, message: "Admin not found" });
    }
    const view = sanitizeAdmin(admin);
    res.json({
      success: true,
      username: view.telegramUsername,
      linked: view.telegramLinked,
      botUsername: await resolveBotUsername(),
    });
  } catch (err) {
    console.error("me/telegram status error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Save the @username the admin typed in (display/identification only).
router.post("/me/telegram/username", requireAdmin, async (req, res) => {
  try {
    const view = await setTelegramUsername(
      req.session.admin.id,
      req.body?.username,
    );
    res.json({ success: true, username: view.telegramUsername });
  } catch (err) {
    const status = err.message === "Admin not found" ? 404 : 400;
    res.status(status).json({ success: false, message: err.message });
  }
});

// Start linking: generate a code and return everything the UI needs to send
// the admin into Telegram (a deep link plus the raw code as a fallback).
router.post("/me/telegram/link", requireAdmin, async (req, res) => {
  try {
    const code = await startTelegramLink(req.session.admin.id);
    const botUsername = await resolveBotUsername();
    res.json({
      success: true,
      code,
      botUsername,
      deepLink: botUsername
        ? `https://t.me/${botUsername}?start=${code}`
        : null,
    });
  } catch (err) {
    const status = err.message === "Admin not found" ? 404 : 400;
    res.status(status).json({ success: false, message: err.message });
  }
});

// Unlink the current admin's Telegram chat.
router.post("/me/telegram/unlink", requireAdmin, async (req, res) => {
  try {
    const view = await unlinkTelegram(req.session.admin.id);
    res.json({ success: true, linked: view.telegramLinked });
  } catch (err) {
    const status = err.message === "Admin not found" ? 404 : 400;
    res.status(status).json({ success: false, message: err.message });
  }
});

module.exports = router;
