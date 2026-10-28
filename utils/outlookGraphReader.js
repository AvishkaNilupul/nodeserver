// Server-side client for the Mac-hosted Outlook mail proxy. All Outlook
// credentials (refresh tokens, client ids) live only on the owner's Mac —
// never on prod — and prod reaches them through a reverse SSH tunnel
// (project_epic_worker_on_mac_1022 pattern). This module is the client that
// talks to that proxy; the actual Microsoft Graph reads live inside
// scripts/epic-mail-proxy.js on the Mac.
//
// Env:
//   OUTLOOK_PROXY_URL     http://127.0.0.1:18124  — the reverse-forwarded port
//   OUTLOOK_PROXY_TOKEN   bearer token (shared with the Mac service)
//
// Double-defence: even though the proxy already filters to Epic senders and a
// cutoff, every message we show also passes isEpicSender locally. A compromised
// proxy still can't surface SOOP/Microsoft/outlook mail through the buyer
// viewer.

const axios = require("axios");

// Only mail from these senders is ever shown through /mail. The proxy enforces
// this too, but we repeat the check locally so a buggy or compromised proxy
// can never slip non-Epic mail onto the buyer page.
const EPIC_SENDER_DOMAINS = [
  "epicgames.com",
  "accounts.epicgames.com",
  "mail.epicgames.com",
  "e.mail.epicgames.com",
  "em.epicgames.com",
];

function isEpicSender(address) {
  if (!address) return false;
  const addr = String(address).toLowerCase();
  return EPIC_SENDER_DOMAINS.some(
    (d) => addr === d || addr.endsWith("@" + d) || addr.endsWith("." + d),
  );
}

function proxyConfig() {
  const url = (process.env.OUTLOOK_PROXY_URL || "").replace(/\/+$/, "");
  const token = process.env.OUTLOOK_PROXY_TOKEN || "";
  if (!url || !token) {
    const err = new Error(
      "OUTLOOK_PROXY_URL / OUTLOOK_PROXY_TOKEN not configured",
    );
    err.code = "proxy_unconfigured";
    throw err;
  }
  return { url, token };
}

async function proxyCall(path, body, { timeout = 20000 } = {}) {
  const { url, token } = proxyConfig();
  const { data } = await axios.post(url + path, body || {}, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    timeout,
    // The Mac proxy may be unreachable for seconds at a time (lid-close, sleep,
    // dropped tunnel). The caller already handles failure by showing a generic
    // "mailbox unavailable right now" — don't retry here.
  });
  return data;
}

// Returns true/false — never throws when the proxy is down. Used by the admin
// mint endpoint to pre-flight the inbox before a buyer session is created.
async function proxyHealth() {
  try {
    const { url, token } = proxyConfig();
    const { data } = await axios.get(url + "/health", {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 5000,
    });
    return data?.ok === true ? data : null;
  } catch (_err) {
    return null;
  }
}

// Guard an inbox is safe to hand to a buyer. The Mac holds the authoritative
// "which inbox is used by SOOP / other sites" ledger (mail-usage.json), so the
// SOOP-recovery guard that lived in the MailAccount.usedForSites check moves
// here. Returns {sellable, sharedWith, status} or throws proxy_unconfigured.
async function checkInbox(inboxAddress) {
  const data = await proxyCall("/check", { email: inboxAddress });
  if (!data || data.ok !== true) {
    throw new Error(data?.error || "proxy /check failed");
  }
  return {
    sellable: !!data.sellable,
    sharedWith: Array.isArray(data.sharedWith) ? data.sharedWith : [],
    status: data.status || "unknown",
  };
}

// Fetch up to `top` recent Epic messages, filtered to receivedDateTime >=
// sinceIso. The proxy already does this filter; we re-filter locally as
// defence-in-depth and to normalise the shape.
async function readEpicMailFor({ inboxAddress, sinceIso, top = 20 }) {
  const data = await proxyCall(
    "/list",
    { email: inboxAddress, sinceIso, top },
    { timeout: 25000 },
  );
  if (!data || data.ok !== true) {
    throw new Error(data?.error || "proxy /list failed");
  }
  const sinceMs = Date.parse(sinceIso);
  const messages = (Array.isArray(data.messages) ? data.messages : [])
    .filter((m) => isEpicSender(m?.from))
    .filter((m) => {
      if (!Number.isFinite(sinceMs)) return true;
      const t = Date.parse(m?.receivedDateTime || "");
      return Number.isFinite(t) && t >= sinceMs;
    })
    .slice(0, top);
  return { messages, inboxAddress: data.inboxAddress || inboxAddress };
}

async function readOneMessage({ inboxAddress, messageId }) {
  const data = await proxyCall(
    "/message",
    { email: inboxAddress, id: messageId },
    { timeout: 20000 },
  );
  if (!data || data.ok !== true) {
    const err = new Error(data?.error || "proxy /message failed");
    if (data?.code === "not_found") err.code = "not_found";
    throw err;
  }
  // Enforce the sender allow-list even if the proxy somehow returned a non-
  // Epic message by id.
  if (!isEpicSender(data?.message?.from)) {
    const err = new Error("message not found");
    err.code = "not_found";
    throw err;
  }
  return data.message;
}

module.exports = {
  isEpicSender,
  readEpicMailFor,
  readOneMessage,
  checkInbox,
  proxyHealth,
  EPIC_SENDER_DOMAINS,
};
