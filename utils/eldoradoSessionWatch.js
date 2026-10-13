// Eldorado login reminder.
//
// Eldorado ends a seller login 30 days after the SIGN-IN it came from, and
// nothing the server does can move that: POST /authentication/refreshTokens
// renews the short id token, never the 30-day limit. On 2026-10-02 the stored
// login reached exactly 30.00 days, every call began answering 403, and orders
// stopped being delivered until the owner pasted a fresh cookie. Nothing had
// said the day was coming. The outage itself is paged (utils/intakeWatch);
// this is the part before it.
//
// The sign-in time is inside the stored cookie: the `__Host-EldoradoIdToken`
// value is a JWT whose payload carries `auth_time`. Reading it is a local
// decode. This module NEVER calls Eldorado, so it can run as often as it likes
// and can never spend, rotate or overwrite the session.
//
// What it sends: one Telegram message at each stage before the limit (5 days,
// 2 days, 1 day, 6 hours), one when the limit has passed, and one line when a
// fresh cookie is pasted saying how long THAT one lasts — a cookie copied from
// a browser that signed in two weeks ago has two weeks left, not thirty days.
//
// A stage is remembered as a SystemEvent keyed by the sign-in time, not in
// memory: this server restarts several times a day, and a latch in memory
// would send "5 days left" again after every restart. A message Telegram did
// not take is not recorded, so the next tick sends it again.
//
// Kill switch (no restart): autoFarm.eldoradoLoginReminder = false.

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Measured: the login signed in 2026-09-02T00:29:39Z died at 2026-10-02 ~00:30Z.
const SESSION_LIFE_MS = 30 * DAY_MS;

// Most patient first. Only the most urgent stage reached is ever sent, so a
// server that was down across two of them sends one message, not two.
const STAGES = [
  { key: "5d", ms: 5 * DAY_MS },
  { key: "2d", ms: 2 * DAY_MS },
  { key: "1d", ms: 1 * DAY_MS },
  { key: "6h", ms: 6 * HOUR_MS },
];
const EXPIRED = { key: "expired", ms: 0 };

// A freshly pasted login with less than this left gets the "sign in again"
// hint: it came from a browser session that is already old.
const SHORT_PASTE_MS = 20 * DAY_MS;

const TICK_MS = 30 * 60 * 1000;
const FIRST_DELAY_MS = 2 * 60 * 1000;

const EVENT_CATEGORY = "marketplace";
const REMINDER_ACTION = "eldorado_login_reminder";
const SEEN_ACTION = "eldorado_login_seen";
const UNREADABLE_ACTION = "eldorado_login_unreadable";
// A stored cookie whose sign-in time cannot be read is said at most this often.
const UNREADABLE_REMIND_MS = 7 * DAY_MS;

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

// The sign-in time (ms) inside a stored Cookie header, or null when the header
// has no readable id token. Never throws.
function authTimeMs(cookie) {
  try {
    const m = String(cookie || "").match(/(?:^|;\s*)__Host-EldoradoIdToken=([^;\s]+)/);
    if (!m) return null;
    const parts = m[1].split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const sec = Number(payload && payload.auth_time);
    if (!Number.isFinite(sec) || sec <= 0) return null;
    return Math.round(sec * 1000);
  } catch {
    return null;
  }
}

function limitMs(authMs) {
  return authMs + SESSION_LIFE_MS;
}

// The stage a login with `leftMs` to go is in: null while more than the first
// stage is left, otherwise the most urgent stage reached.
function stageFor(leftMs) {
  if (!Number.isFinite(leftMs)) return null;
  if (leftMs <= 0) return EXPIRED;
  let hit = null;
  for (const s of STAGES) if (leftMs <= s.ms) hit = s;
  return hit;
}

// The owner works in JST. Falls back to ISO if the runtime has no ICU.
function fmtJst(ms) {
  try {
    return (
      new Date(ms).toLocaleString("en-GB", {
        timeZone: "Asia/Tokyo",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }) + " JST"
    );
  } catch {
    return new Date(ms).toISOString();
  }
}

// "5 days", "47 hours", "40 minutes" — to the nearest unit, and in hours
// under two days: "1 day" for 47 hours would read as half of what is left.
function human(ms) {
  const left = Math.max(0, ms);
  if (left >= 2 * DAY_MS) return Math.round(left / DAY_MS) + " days";
  if (left >= 90 * 60 * 1000) return Math.round(left / HOUR_MS) + " hours";
  const m = Math.max(1, Math.round(left / 60000));
  return m + (m === 1 ? " minute" : " minutes");
}

const HOW_TO_FIX =
  "To fix (2 minutes): sign in at eldorado.gg, copy the whole Cookie request header " +
  "and paste it in Listings → Marketplace keys → Eldorado.\n" +
  "Tip: a cookie from a browser that signed in long ago expires sooner. Signing in " +
  "again first (a private window works) gives the full 30 days.";

function reminderText(stage, authMs, now) {
  const limit = limitMs(authMs);
  if (stage.key === EXPIRED.key) {
    return (
      "🛑 Eldorado login reached its 30-day limit (" + fmtJst(limit) + "). " +
      "Eldorado orders are not delivered and offers are not renewed until a fresh " +
      "cookie is pasted.\n\n" + HOW_TO_FIX
    );
  }
  return (
    "⏰ Eldorado login expires in " + human(limit - now) + " — " + fmtJst(limit) + ".\n\n" +
    "Eldorado ends a login 30 days after sign-in and the server cannot renew it. " +
    "After that time no Eldorado order is delivered and no offer is renewed.\n\n" +
    HOW_TO_FIX
  );
}

// A cookie is stored but its sign-in time cannot be read, so no reminder can
// ever fire: the owner has to know he is NOT being watched over.
const UNREADABLE_TEXT =
  "⚠️ Eldorado login reminder: the stored cookie has no readable sign-in time, so " +
  "nothing can warn before the 30-day limit.\n\n" +
  "If Eldorado orders are still being delivered, the login itself works. Paste a " +
  "fresh, complete Cookie request header (Listings → Marketplace keys → Eldorado). " +
  "If this message comes back after that, Eldorado has changed its cookie and the " +
  "reminder needs a fix.";

function newLoginText(authMs, now) {
  const limit = limitMs(authMs);
  const left = limit - now;
  if (left <= 0) {
    return (
      "🛑 The Eldorado cookie that was just pasted is already past its 30-day limit " +
      "(signed in " + fmtJst(authMs) + "). Sign in again at eldorado.gg and paste that cookie."
    );
  }
  if (left < SHORT_PASTE_MS) {
    return (
      "⚠️ Eldorado login updated, but it only lasts until " + fmtJst(limit) + " (" +
      human(left) + "): that cookie comes from a browser that signed in on " +
      fmtJst(authMs) + ". For a full 30 days, sign in again (a private window works) " +
      "and paste that cookie."
    );
  }
  return (
    "✅ Eldorado login updated — good until " + fmtJst(limit) + " (" + human(left) + ")."
  );
}

// ---------------------------------------------------------------------------
// Reads and writes (injectable)
// ---------------------------------------------------------------------------

let deps = {};
const REAL = {
  now: () => Date.now(),
  autoFarm: () => {
    try {
      return require("./settings").getAutoFarm() || {};
    } catch {
      return {};
    }
  },
  // The same read as marketplaces.getKeys("eldorado"). Kept here so this
  // watch depends on neither that file's exports nor its HTTP client.
  cookie: () => {
    const s = require("./settings").loadSettings();
    const stored = ((s && s.marketplaces) || {}).eldorado || {};
    return stored.cookie ? require("./secretBox").decrypt(stored.cookie) : "";
  },
  // Stage keys already sent for this sign-in.
  sentStages: async (authMs) => {
    const SystemEvent = require("../models/SystemEvent");
    const rows = await SystemEvent.find(
      { category: EVENT_CATEGORY, action: REMINDER_ACTION, "meta.authTime": authMs },
      { meta: 1 },
    ).lean();
    return new Set(rows.map((r) => r.meta && r.meta.stage).filter(Boolean));
  },
  // The sign-in time of the login this watch last recorded, or null before any.
  lastSeenAuth: async () => {
    const SystemEvent = require("../models/SystemEvent");
    const row = await SystemEvent.findOne(
      { category: EVENT_CATEGORY, action: { $in: [REMINDER_ACTION, SEEN_ACTION] } },
      { meta: 1 },
    )
      .sort({ at: -1 })
      .lean();
    const t = row && row.meta && Number(row.meta.authTime);
    return Number.isFinite(t) && t > 0 ? t : null;
  },
  // Written directly (not through systemLog.logEvent, which swallows a failed
  // write): a stage that was sent but not recorded would be sent again.
  record: async (action, authMs, stage, detail, severity) => {
    const SystemEvent = require("../models/SystemEvent");
    await SystemEvent.create({
      category: EVENT_CATEGORY,
      action,
      actor: "eldoradoSessionWatch",
      severity: severity || "info",
      subject: "Eldorado",
      detail: String(detail || "").slice(0, 300),
      meta: { authTime: authMs, stage: stage || "", limit: limitMs(authMs) },
    });
  },
  // When the "sign-in time cannot be read" line was last sent (0 = never).
  lastUnreadableAt: async () => {
    const SystemEvent = require("../models/SystemEvent");
    const row = await SystemEvent.findOne({ category: EVENT_CATEGORY, action: UNREADABLE_ACTION }, { at: 1 })
      .sort({ at: -1 })
      .lean();
    return row && row.at ? new Date(row.at).getTime() : 0;
  },
  recordUnreadable: async () => {
    const SystemEvent = require("../models/SystemEvent");
    await SystemEvent.create({
      category: EVENT_CATEGORY,
      action: UNREADABLE_ACTION,
      actor: "eldoradoSessionWatch",
      severity: "warn",
      subject: "Eldorado",
      detail: "the stored cookie has no readable __Host-EldoradoIdToken; the 30-day limit cannot be predicted",
    });
  },
  send: (text) => require("./telegram").sendTelegram(text),
};
function dep(name) {
  return Object.prototype.hasOwnProperty.call(deps, name) ? deps[name] : REAL[name];
}

// true = the message reached at least one chat, or there is no chat to reach
// (Telegram not set up: nothing to retry). false = try again next tick.
async function deliver(text) {
  try {
    const r = await dep("send")(text);
    if (r && r.configured === false) return true;
    if (r && typeof r.sent === "number") return r.sent > 0;
    return true; // a helper that reports nothing: assume it went
  } catch (e) {
    console.error("eldorado login reminder: telegram failed:", (e && e.message) || e);
    return false;
  }
}

// What THIS process already sent: if the event cannot be written, the same
// message must still not repeat every tick.
let lastAnnounced = null; // the sign-in whose "login updated" line went last
const sentHere = new Set(); // "<sign-in>|<stage>" of every reminder sent
let noTokenLogged = false;
let unreadableSaidAt = 0;

// A cookie without a readable sign-in time: said once a week, restarts included.
async function sayUnreadable(now) {
  if (unreadableSaidAt && now - unreadableSaidAt < UNREADABLE_REMIND_MS) return false;
  let last = 0;
  try {
    last = (await dep("lastUnreadableAt")()) || 0;
  } catch {
    last = 0;
  }
  if (last && now - last < UNREADABLE_REMIND_MS) {
    unreadableSaidAt = last;
    return false;
  }
  if (!(await deliver(UNREADABLE_TEXT))) return false; // not taken: next tick
  unreadableSaidAt = now;
  try {
    await dep("recordUnreadable")();
  } catch (e) {
    console.error("eldorado login reminder: could not record the unreadable-cookie notice:", (e && e.message) || e);
  }
  return true;
}

async function check() {
  const af = dep("autoFarm")();
  if (af && af.eldoradoLoginReminder === false) return { skipped: "off" };

  let cookie = "";
  try {
    cookie = dep("cookie")() || "";
  } catch (e) {
    return { skipped: "the stored cookie could not be read: " + ((e && e.message) || e) };
  }
  if (!cookie) return { skipped: "not configured" };

  const authMs = authTimeMs(cookie);
  if (!authMs) {
    if (!noTokenLogged) {
      noTokenLogged = true;
      console.error(
        "eldorado login reminder: the stored cookie has no readable __Host-EldoradoIdToken — " +
          "the 30-day limit cannot be predicted",
      );
    }
    const said = await sayUnreadable(dep("now")());
    return { skipped: "no sign-in time in the stored cookie", ...(said ? { sent: ["unreadable"] } : {}) };
  }
  noTokenLogged = false;

  const now = dep("now")();
  const limit = limitMs(authMs);
  const left = limit - now;
  const stage = stageFor(left);
  const out = { ok: true, authTime: authMs, limit, left, stage: stage ? stage.key : null, sent: [] };

  // A fresh paste: say how long this login lasts. The very first run only
  // records what it found.
  const prev = await dep("lastSeenAuth")();
  if (prev === null) {
    await dep("record")(SEEN_ACTION, authMs, "", "first look: signed in " + new Date(authMs).toISOString());
  } else if (prev !== authMs && lastAnnounced !== authMs) {
    // Only the LAST one announced is remembered: going back to an older
    // cookie and forward again is confirmed each time.
    if (await deliver(newLoginText(authMs, now))) {
      lastAnnounced = authMs;
      out.sent.push("new-login");
      await dep("record")(
        SEEN_ACTION,
        authMs,
        "",
        "new login: signed in " + new Date(authMs).toISOString() + ", good until " + new Date(limit).toISOString(),
      );
      // That line already said when it ends: the stage it is in is covered.
      if (stage) {
        await dep("record")(REMINDER_ACTION, authMs, stage.key, "covered by the new-login message", "info");
        return out;
      }
    }
    // Not delivered: nothing was remembered, so the next tick tries again.
  }

  if (!stage) return out;
  const hereKey = authMs + "|" + stage.key;
  if (sentHere.has(hereKey)) return out;
  const already = await dep("sentStages")(authMs);
  if (already.has(stage.key)) return out;

  if (await deliver(reminderText(stage, authMs, now))) {
    sentHere.add(hereKey);
    out.sent.push(stage.key);
    await dep("record")(
      REMINDER_ACTION,
      authMs,
      stage.key,
      stage.key === EXPIRED.key
        ? "30-day limit reached " + new Date(limit).toISOString()
        : "expires " + new Date(limit).toISOString() + " (" + human(left) + " left)",
      stage.key === EXPIRED.key ? "error" : "warn",
    );
  }
  return out;
}

let started = false;

function start() {
  if (started) return;
  started = true;
  const tick = async () => {
    try {
      await check();
    } catch (e) {
      console.error("eldorado login reminder:", (e && e.message) || e);
    }
    const t = setTimeout(tick, TICK_MS);
    if (t.unref) t.unref();
  };
  const t = setTimeout(tick, FIRST_DELAY_MS);
  if (t.unref) t.unref();
}

module.exports = {
  start,
  check,
  authTimeMs,
  limitMs,
  stageFor,
  reminderText,
  newLoginText,
  STAGES,
  SESSION_LIFE_MS,
  TICK_MS,
  // testing seams
  __setDeps: (d) => {
    deps = { ...deps, ...(d || {}) };
  },
  _reset: () => {
    deps = {};
    lastAnnounced = null;
    sentHere.clear();
    noTokenLogged = false;
    unreadableSaidAt = 0;
  },
};
