const axios = require("axios");

const { getTelegramChatId } = require("./admins");

require("dotenv").config();

// Why a send is tried more than once, and over IPv4.
//
// Every failed send in the two weeks to 2026-10-12 (nine of them) was logged as
// "Telegram error:" with nothing after it. Measured on the server that day: it
// has no IPv6 route, api.telegram.org has an address of each family, and Node
// 20 gives the first address 250 ms before moving on. So an IPv4 connect slower
// than a quarter of a second fell through to IPv6, which fails at once, and the
// result was an AggregateError whose message is empty. The alert it carried was
// gone, and no caller could tell: nothing here ever throws.
//
// Asking for IPv4 leaves one address and no race to lose — a slow connect then
// simply takes longer. The last try lets Node choose again, for a host where
// IPv4 is the family that does not work.
const TIMING = {
  tries: 3,
  // One try's deadline. Awaited inside the auto-farm's structural steps
  // (utils/farmOps): a post that never answers held up whatever awaited it.
  timeoutMs: 10000,
  // All the tries for one chat together, so a caller is never held much longer
  // than the single 15 s deadline it had before.
  budgetMs: 22000,
  pauseMs: 1500,
  // Telegram's own "retry after N seconds" is honoured up to this.
  maxRetryAfterMs: 5000,
};

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// The request URL holds the bot token, and an error can quote the URL. Nothing
// that came out of an error is logged or returned without going through this.
function scrub(text, token) {
  let out = String(text == null ? "" : text);
  if (token) out = out.split(token).join("***");
  return out.replace(/bot\d+:[\w-]+/g, "bot***").slice(0, 300);
}

// What went wrong, in words that are never empty, and whether another try can
// help. Telegram answering 4xx is a decision (chat not found, bot blocked, bad
// token): the same request gets the same answer.
function explain(err, token) {
  const res = err && err.response;
  if (res) {
    const data = res.data && typeof res.data === "object" ? res.data : {};
    const said = typeof data.description === "string" ? " " + data.description : "";
    const after = Number(data.parameters && data.parameters.retry_after);
    return {
      reason: scrub(`HTTP ${res.status}${said}`, token),
      retry: res.status === 429 || res.status >= 500,
      waitMs: res.status === 429 && Number.isFinite(after) ? after * 1000 : null,
    };
  }
  // No answer at all: the connection, DNS or the deadline.
  const inner = [err && err.cause, err].find((e) => e && Array.isArray(e.errors));
  const codes = inner ? [...new Set(inner.errors.map((e) => e && e.code).filter(Boolean))].join("+") : "";
  const parts = [err && err.name !== "Error" && err.name !== "AxiosError" ? err.name : "", err && err.code, codes ? `(${codes})` : "", err && err.message];
  return {
    reason: scrub(parts.filter(Boolean).join(" "), token) || "no answer from Telegram",
    retry: true,
    waitMs: null,
  };
}

// Low-level send to a single chat. Never throws, so a missing token or a dead
// network cannot crash a request — but it says what happened:
//   { ok, configured, tries, reason }
// `configured: false` means Telegram is not set up (no token or no chat) and
// nothing was attempted.
async function sendToChat(chatId, text) {
  const token = process.env.TG_TOKEN;
  if (!token || !chatId) return { ok: false, configured: false, tries: 0, reason: null };
  const started = Date.now();
  let reason = null;
  let tries = 0;
  for (let n = 1; n <= TIMING.tries; n++) {
    const left = TIMING.budgetMs - (Date.now() - started);
    if (n > 1 && left < 2000) break;
    tries = n;
    const config = { timeout: Math.max(1000, Math.min(TIMING.timeoutMs, left)) };
    if (n < TIMING.tries) config.family = 4;
    try {
      await axios.post(
        `https://api.telegram.org/bot${token}/sendMessage`,
        { chat_id: String(chatId).trim(), text },
        config,
      );
      if (n > 1) console.log(`Telegram: delivered on try ${n} (before that: ${reason})`);
      return { ok: true, configured: true, tries: n, reason: null };
    } catch (err) {
      const why = explain(err, token);
      reason = why.reason;
      if (!why.retry || n === TIMING.tries) break;
      const wait = why.waitMs == null ? TIMING.pauseMs : why.waitMs;
      // Told to wait longer than a caller should be held: give up, say why.
      if (wait > TIMING.maxRetryAfterMs) break;
      await pause(wait);
    }
  }
  console.error(`Telegram error: ${reason} (not delivered after ${tries} ${tries === 1 ? "try" : "tries"})`);
  return { ok: false, configured: true, tries, reason };
}

// Send the same text to a list of chat IDs, de-duplicated so a chat that is
// both a super-admin and the order's seller only gets one copy. Resolves to
//   { configured, chats, sent, failed, reasons }
// where `sent` is how many chats took the message. `sent: 0` with
// `configured: true` is an alert nobody received.
async function sendToChatIds(chatIds, text) {
  const out = { configured: false, chats: 0, sent: 0, failed: 0, reasons: [] };
  const seen = new Set();
  for (const id of chatIds) {
    const key = String(id).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const r = await sendToChat(key, text);
    if (!r.configured) continue;
    out.configured = true;
    out.chats += 1;
    if (r.ok) out.sent += 1;
    else {
      out.failed += 1;
      if (r.reason && !out.reasons.includes(r.reason)) out.reasons.push(r.reason);
    }
  }
  return out;
}

// Broadcast to every super-admin chat. Kept for any notification that isn't
// tied to a specific seller.
async function sendTelegram(text) {
  return sendToChatIds(getSuperChatIds(), text);
}

// Notify the admins who should see an order's activity: the super-admins
// (always) plus the admin who created the order (if they've linked a chat).
async function sendTelegramToSeller(sellerId, text) {
  const recipients = getSuperChatIds();
  const sellerChatId = sellerId ? getTelegramChatId(sellerId) : null;
  if (sellerChatId) {
    recipients.push(sellerChatId);
  }
  return sendToChatIds(recipients, text);
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
  TIMING,
};
