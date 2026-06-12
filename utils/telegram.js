const axios = require("axios");

require("dotenv").config();

// Sends a plain-text alert to every configured Telegram chat. No-ops when
// Telegram isn't configured so missing env vars never crash a request.
async function sendTelegram(text) {
  const token = process.env.TG_TOKEN;
  const chatIds = process.env.TG_CHAT_IDS;
  if (!token || !chatIds) return;

  for (const chatId of chatIds.split(",")) {
    try {
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId.trim(),
        text,
      });
    } catch (err) {
      console.error("Telegram error:", err.response?.data || err.message);
    }
  }
}

module.exports = { sendTelegram };