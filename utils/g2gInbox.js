// G2G buyer chats for the complaint sweep — READ ONLY (2026-10-01).
//
// G2G was a blind spot in scripts/complaint-sweep.js ("no order/chat reader
// wired"). On 2026-10-01 eighteen G2G buyers had been waiting on a reply, one
// since June, and nothing anywhere reported them. G2G chat is SendBird (see
// utils/g2gChat.js). This lists our private DM channels and the tail of each, so
// a buyer who spoke last shows up in the sweep the way a PlayerAuctions thread
// does.
//
// Three rules, all deliberate:
//  - It never sends, never marks a channel read and never opens a channel. The
//    sweep is read-only (docs/support-notes/README.md: "the one hard rule").
//  - It never refreshes the G2G token. The access token lives 15 minutes and the
//    server renews it on its own G2G calls; a refresh from this process would
//    mint a token the server does not hold and race its settings write. The
//    stored token is used as it is, a short wait covers the renewal edge, and a
//    token G2G refuses is reported as a stale source, not healed. Same restraint
//    as the sweep's PlayerAuctions inbox.
//  - Passwords are masked before anything leaves this module. The transcripts
//    land in support-sweeps/ (latest.json, corpus.jsonl), and our own delivery
//    messages carry live credentials.
const axios = require("axios");

const G2G_SLS = "https://sls.g2g.com";
const G2G_WEB = "https://www.g2g.com";
const G2G_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const MIN_TOKEN_MS = 60 * 1000; // less than this left counts as expired
const TOKEN_POLL_MS = 15 * 1000;
const MESSAGE_CHARS = 600; // per transcript line; our hand-over text is long

// --- masking ----------------------------------------------------------------

// "Password: x", "**Password:** x", "pass = x", "PW - x" -> "Password: ***".
// The label must be followed by ":", "=" or a spaced " - ", so prose ("do not
// change the password or email") is left alone; a value already masked stays.
// Only a markdown "**" may sit between the separator and the value: a wider
// "\**" there would read an already-masked "Password: *** HOW" as the value
// "HOW" and eat the next word.
const PASSWORD_LABEL = /\b(pass(?:word)?|pwd|pw)\b\**(?:\s*[:=]|\s+-\s)\s*(?:\*\*)?\s*(\S+)/gi;
// A pasted "login:password" pair. The login must hold a digit (ours always do)
// and the right side must not be "//", so URLs and clock times survive.
const CRED_PAIR = /\b([A-Za-z][A-Za-z0-9_]*\d[A-Za-z0-9_]*):(?!\/\/)(\S{5,})/g;

function maskSecrets(text) {
  return String(text == null ? "" : text)
    .replace(PASSWORD_LABEL, (m, label, value) => (value === "***" ? m : label + ": ***"))
    .replace(CRED_PAIR, (m, login, value) => (value === "***" ? m : login + ":***"));
}

// --- classifying a thread -----------------------------------------------------

// Not a buyer: G2G's own "est. monthly sales" pitches and ban notices.
const SPAM = [
  /remove all spaces in the link/i,
  /est\. monthly sales/i,
  /weekly sales growth/i,
  /rmt\s*hub/i,
  /has been banned for policy violations/i,
];
// G2G order items look like 1790705383264O9BE-1; offers like G1788852768578HT.
const ORDER_ID = /\b\d{13}[A-Z0-9]{4}-\d{1,3}\b/g;
const OFFER_ID = /\bG\d{13}[A-Z]{2}\b/g;

const hoursBetween = (at, now) =>
  Math.round(((now - new Date(at).getTime()) / 3600e3) * 10) / 10;

// A thread where WE are the buyer (the owner buying from another seller) is not
// a complaint: the other side opened it from their SALE page, or asks us to
// confirm "your order", or we opened it from our PURCHASE page.
function weAreBuyer(messages) {
  return messages.some(
    (m) =>
      (m.who === "buyer" &&
        (/\/g2g-user\/sale\/order\/item\//.test(m.text) || /confirm your order/i.test(m.text))) ||
      (m.who === "seller" && /\/g2g-user\/purchase\/order\/item\//.test(m.text)),
  );
}

// One sweep item for a thread whose LAST word is the buyer's, or null when we
// (or the system) spoke last. Severity is by age alone: SendBird's unread count
// is almost always non-zero because nobody opens the G2G inbox, so it cannot
// say what is new the way PlayerAuctions' flag does.
function threadItem(thread, { now = Date.now() } = {}) {
  const msgs = (thread && thread.messages) || [];
  const last = msgs[msgs.length - 1];
  if (!last || last.who !== "buyer") return null;

  let i = msgs.length - 1;
  while (i >= 0 && msgs[i].who !== "seller") i--;
  const waiting = msgs.slice(i + 1).filter((m) => m.who === "buyer");
  const text = waiting.map((m) => m.text).join("\n");

  const all = msgs.map((m) => m.text).join("\n");
  const orderIds = [...new Set(all.match(ORDER_ID) || [])];
  const offerIds = [...new Set(all.match(OFFER_ID) || [])];
  const spam = SPAM.some((re) => re.test(text));
  const ours = weAreBuyer(msgs);
  const age = hoursBetween(last.at, now);
  const severity = spam || ours ? "info" : age <= 24 ? "urgent" : age <= 72 ? "warn" : "info";
  const who = thread.buyer || thread.buyerId || "?";

  return {
    // The last message id is part of the key, so a buyer writing again is new.
    key: "g2g:thread:" + thread.channelUrl + ":" + last.id,
    severity,
    platform: "g2g",
    kind: "buyer-message",
    at: last.at,
    subject:
      (spam ? "(spam?) " : ours ? "(we are the buyer) " : "") +
      "buyer waiting — " + who +
      " — order " + (orderIds[orderIds.length - 1] || "?") + " (" + age + "h)",
    body: text,
    meta: {
      channelUrl: thread.channelUrl,
      buyerId: thread.buyerId,
      buyer: thread.buyer,
      unread: thread.unread,
      orderIds,
      offerIds,
      spam,
      weAreBuyer: ours,
      // Our own hand-over is in the thread: a complaint here follows a delivery.
      afterDelivery: msgs.some((m) => m.who === "seller" && /TWITCH DROP ACCOUNT|automatic farming is now running/i.test(m.text)),
      transcript: msgs.map((m) => m.who + " @" + m.at + ": " + m.text),
    },
  };
}

// --- reading ------------------------------------------------------------------

function tokenMsLeft(token, now) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1], "base64").toString("utf8"));
    return payload.exp ? payload.exp * 1000 - now : Infinity;
  } catch {
    return Infinity;
  }
}

function storedCreds(loadSettings, decrypt) {
  const st = ((loadSettings() || {}).marketplaces || {}).g2g || {};
  return {
    token: st.accessToken ? decrypt(st.accessToken) : "",
    sellerId: st.userId ? String(decrypt(st.userId)) : "",
  };
}

function defaultSendbird() {
  const chat = require("./g2gChat");
  if (!chat.ensureWebSocket()) throw new Error("no WebSocket implementation (the `ws` package is missing)");
  const { default: SendbirdChat } = require("@sendbird/chat");
  const { GroupChannelModule } = require("@sendbird/chat/groupChannel");
  return SendbirdChat.init({
    appId: chat.G2G_SENDBIRD_APP_ID,
    modules: [new GroupChannelModule()],
    localCacheEnabled: false,
  });
}

// Only a 2-member "dm" that includes us. Our account also sits in G2G's seller
// SUPERGROUPS (~10,000 members); those are never read.
function isPrivateDm(c, sellerId) {
  if (!c || c.isSuper || c.isBroadcast) return false;
  if (String(c.customType || "") !== "dm" || Number(c.memberCount) !== 2) return false;
  const ids = (c.members || []).map((m) => String((m && m.userId) || ""));
  return ids.includes(String(sellerId));
}

function toMessage(m, sellerId) {
  const senderId = m && m.sender && m.sender.userId;
  const who = !senderId ? "system" : String(senderId) === String(sellerId) ? "seller" : "buyer";
  const raw =
    m.messageType === "file"
      ? "[file: " + (m.name || "attachment") + "]"
      : m.message || "[" + (m.messageType || "message") + "]";
  return {
    id: String(m.messageId),
    who,
    at: new Date(Number(m.createdAt)).toISOString(),
    text: maskSecrets(raw).replace(/\s+/g, " ").trim().slice(0, MESSAGE_CHARS),
  };
}

const stale = (detail) => ({ status: "stale", detail, threads: [] });

// Returns { status: "ok" | "stale", detail, threads: [{ channelUrl, buyerId,
// buyer, unread, messages: [{ id, who: buyer|seller|system, at, text }] }] }.
// Throws only on an unexpected failure; the sweep records it as an error.
async function readG2gInbox(opts = {}) {
  const lookbackDays = opts.lookbackDays || 14;
  const maxChannels = opts.maxChannels || 50;
  const perChannel = opts.perChannel || 15;
  const waitMs = opts.waitMs == null ? 90 * 1000 : opts.waitMs;
  const deps = opts.deps || {};
  const loadSettings = deps.loadSettings || require("./settings").loadSettings;
  const decrypt = deps.decrypt || require("./secretBox").decrypt;
  const http = deps.http || axios;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const clock = deps.clock || Date.now;

  // 1. The stored token, as it is. Close to expiry, wait for the server's own
  //    renewal instead of refreshing (see the header).
  let creds = storedCreds(loadSettings, decrypt);
  const deadline = clock() + waitMs;
  while (creds.token && tokenMsLeft(creds.token, clock()) < MIN_TOKEN_MS && clock() < deadline) {
    await sleep(TOKEN_POLL_MS);
    creds = storedCreds(loadSettings, decrypt);
  }
  if (!creds.token || !creds.sellerId) return stale("no stored G2G access token or seller id");
  if (tokenMsLeft(creds.token, clock()) < MIN_TOKEN_MS) {
    return stale("the stored G2G access token has expired and the server has not renewed it yet — not refreshed here on purpose");
  }

  // 2. The SendBird session token, from the same chat profile call
  //    utils/g2gChat makes, minus its refresh-on-401.
  let sessionToken = "";
  try {
    const r = await http.post(
      G2G_SLS + "/chat/user",
      { user_id: creds.sellerId },
      {
        headers: {
          authorization: creds.token, // RAW: a "Bearer " prefix is a guaranteed 401
          "Content-Type": "application/json",
          Origin: G2G_WEB,
          Referer: G2G_WEB + "/",
          "User-Agent": G2G_UA,
        },
        timeout: 30000,
      },
    );
    const body = (r && r.data) || {};
    if (body.code && Number(body.code) >= 4000) return stale("G2G chat profile refused (code " + body.code + ")");
    const tokens = (body.payload && body.payload.session_tokens) || [];
    sessionToken = (tokens[0] && tokens[0].session_token) || "";
  } catch (e) {
    const status = e && e.response && e.response.status;
    if (status === 401 || status === 403) {
      return stale("G2G refused the stored token (HTTP " + status + ") — not refreshed here on purpose");
    }
    throw e;
  }
  if (!sessionToken) return stale("G2G chat profile carried no session token");

  // 3. Our DM channels, newest first, and the tail of each recent one.
  const sb = (deps.sendbird || defaultSendbird)();
  await sb.connect(creds.sellerId, sessionToken);
  try {
    const query = sb.groupChannel.createMyGroupChannelListQuery({
      includeEmpty: false,
      customTypesFilter: ["dm"],
      order: "latest_last_message",
      limit: maxChannels,
    });
    const channels = (await query.next()) || [];
    const since = clock() - lookbackDays * 864e5;
    const threads = [];
    for (const c of channels) {
      if (!isPrivateDm(c, creds.sellerId)) continue;
      const last = c.lastMessage;
      if (!last || !(Number(last.createdAt) >= since)) continue;
      const other = (c.members || []).find((m) => String(m.userId) !== String(creds.sellerId)) || {};
      const loaded = (await c.createPreviousMessageListQuery({ limit: perChannel }).load()) || [];
      threads.push({
        channelUrl: c.url,
        buyerId: String(other.userId || ""),
        buyer: other.nickname || "",
        unread: Number(c.unreadMessageCount) || 0,
        messages: loaded.map((m) => toMessage(m, creds.sellerId)),
      });
    }
    return {
      status: "ok",
      detail: channels.length + " DM channels listed, " + threads.length + " active in " + lookbackDays + " days",
      threads,
    };
  } finally {
    try {
      await sb.disconnect();
    } catch {
      /* closing a read-only session; nothing to recover */
    }
  }
}

module.exports = { readG2gInbox, threadItem, maskSecrets, weAreBuyer, isPrivateDm };
