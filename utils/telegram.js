const axios = require("axios");

const { getTelegramChatId } = require("./admins");

require("dotenv").config();

// The chat IDs in TG_CHAT_IDS are the "always notify" super-admin recipients:
// they receive every notification, regardless of which admin created the
// order. Individual admins link their own chat separately (see admins.js) and
// only receive notifications for the orders they created.
function getSuperChatIds() {
  return (process.env.TG_CHAT_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

// Low-level send to a single chat. No-ops (and never throws) when Telegram
// isn't configured so a missing token can't crash a request.
async function sendToChat(chatId, text) {
  const token = process.env.TG_TOKEN;
  if (!token || !chatId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: String(chatId).trim(),
      text,
    });
  } catch (err) {
    console.error("Telegram error:", err.response?.data || err.message);
  }
}

// Send the same text to a list of chat IDs, de-duplicated so a chat that is
// both a super-admin and the order's seller only gets one copy.
async function sendToChatIds(chatIds, text) {
  const seen = new Set();
  for (const id of chatIds) {
    const key = String(id).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    await sendToChat(key, text);
  }
}

// Broadcast to every super-admin chat. Kept for any notification that isn't
// tied to a specific seller.
async function sendTelegram(text) {
  await sendToChatIds(getSuperChatIds(), text);
}

// Notify the admins who should see an order's activity: the super-admins
// (always) plus the admin who created the order (if they've linked a chat).
async function sendTelegramToSeller(sellerId, text) {
  const recipients = getSuperChatIds();
  const sellerChatId = sellerId ? getTelegramChatId(sellerId) : null;
  if (sellerChatId) {
    recipients.push(sellerChatId);
  }
  await sendToChatIds(recipients, text);
}

// Fetch the bot's own info (used to show admins which bot to message when
// linking). Returns null when Telegram isn't configured or the call fails.
async function getMe() {
  const token = process.env.TG_TOKEN;
  if (!token) return null;
  try {
    const res = await axios.get(`https://api.telegram.org/bot${token}/getMe`);
    return res.data?.result || null;
  } catch (err) {
    console.error("Telegram getMe error:", err.response?.data || err.message);
    return null;
  }
}

module.exports = {
  getSuperChatIds,
  sendToChat,
  sendToChatIds,
  sendTelegram,
  sendTelegramToSeller,
  getMe,
};
