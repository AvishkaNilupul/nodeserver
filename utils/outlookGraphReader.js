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

// Steam sends its codes and account mail from noreply@steampowered.com
// (docs/STEAM-SALES.md). A "steam" session sees ONLY these senders.
const STEAM_SENDER_DOMAINS = ["steampowered.com"];

function senderIn(domains, address) {
  if (!address) return false;
  const addr = String(address).toLowerCase();
  return domains.some(
    (d) => addr === d || addr.endsWith("@" + d) || addr.endsWith("." + d),
  );
}

function isEpicSender(address) {
  return senderIn(EPIC_SENDER_DOMAINS, address);
}

function isSteamSender(address) {
  return senderIn(STEAM_SENDER_DOMAINS, address);
}

// The allow-list for a session kind. Anything but "steam" is Epic, so every
// row made before Steam existed keeps its exact old behaviour.
function senderCheck(kind) {
  return kind === "steam" ? isSteamSender : isEpicSender;
}

// The proxy body for a kind. Epic calls send exactly what they always sent;
// only a Steam call adds kind, which the Mac proxy needs to switch lists.
function withKind(body, kind) {
  return kind === "steam" ? { ...body, kind: "steam" } : body;
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
    // Every site on record for the inbox, its own one included (the Mac proxy
    // leaves "epic" out of sharedWith). Absent from older proxies.
    uses: Array.isArray(data.uses) ? data.uses : null,
    status: data.status || "unknown",
  };
}

// Fetch up to `top` recent messages from the kind's senders (Epic unless
// kind is "steam"), filtered to receivedDateTime >= sinceIso. The proxy
// already does this filter; we re-filter locally as defence-in-depth and to
// normalise the shape.
async function readMailFor({ inboxAddress, sinceIso, top = 20, kind = "epic" }) {
  const allowed = senderCheck(kind);
  const data = await proxyCall(
    "/list",
    withKind({ email: inboxAddress, sinceIso, top }, kind),
    { timeout: 25000 },
  );
  if (!data || data.ok !== true) {
    throw new Error(data?.error || "proxy /list failed");
  }
  const sinceMs = Date.parse(sinceIso);
  const messages = (Array.isArray(data.messages) ? data.messages : [])
    .filter((m) => allowed(m?.from))
    .filter((m) => {
      if (!Number.isFinite(sinceMs)) return true;
      const t = Date.parse(m?.receivedDateTime || "");
      return Number.isFinite(t) && t >= sinceMs;
    })
    .slice(0, top);
  return { messages, inboxAddress: data.inboxAddress || inboxAddress };
}

// The Epic-only read every existing caller uses.
async function readEpicMailFor({ inboxAddress, sinceIso, top = 20 }) {
  return readMailFor({ inboxAddress, sinceIso, top, kind: "epic" });
}

async function readOneMessage({ inboxAddress, messageId, kind = "epic" }) {
  const data = await proxyCall(
    "/message",
    withKind({ email: inboxAddress, id: messageId }, kind),
    { timeout: 20000 },
  );
  if (!data || data.ok !== true) {
    const err = new Error(data?.error || "proxy /message failed");
    if (data?.code === "not_found") err.code = "not_found";
    throw err;
  }
  // Enforce the sender allow-list even if the proxy somehow returned a
  // message of another sender by id.
  if (!senderCheck(kind)(data?.message?.from)) {
    const err = new Error("message not found");
    err.code = "not_found";
    throw err;
  }
  return data.message;
}

module.exports = {
  isEpicSender,
  isSteamSender,
  readMailFor,
  readEpicMailFor,
  readOneMessage,
  checkInbox,
  proxyHealth,
  EPIC_SENDER_DOMAINS,
  STEAM_SENDER_DOMAINS,
};
