// Periodic sweep that stops the bots of renters whose access period has just
// lapsed. Dashboard access is already blocked the instant a lease expires (the
// requireRenter middleware checks it on every request), but that alone doesn't
// stop the farming container — this does, without the operator having to click
// "suspend" the moment a lease ends.
//
// Suspended renters have their bot stopped at suspend time; this handles the
// time-based case (accessEnd passing on its own). Idempotent: it only acts on
// renters that are past their lease, still farming (botStoppedAt not set), and
// have an assigned bot, then stamps botStoppedAt so it won't retry every tick.
//
// It also handles the renewal-revenue side of the lease: a Telegram heads-up to
// the operator when a lease is inside its last WARN_MS (once per lease — see
// Renter.expiryWarnedAt), and a Telegram notice when an expired bot is stopped,
// so a lapse is never silent.
const Renter = require("../models/Renter");
const RenterAccount = require("../models/RenterAccount");
const FarmServiceOrder = require("../models/FarmServiceOrder");
const SystemEvent = require("../models/SystemEvent");
const hosts = require("./botHosts");
const { sendTelegram } = require("./telegram");
const { logEvent } = require("./systemLog");
const {
  stopRenterFarming,
  locateSecrets,
  detachFromFile,
  settleAfterDetach,
} = require("./renterBotOps");
const { OPERATOR_HOLDER_USERNAME } = require("./renters");

const INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
// A lapsed window that could not be pulled off its bot pages after this many
// ticks (~30 min), then at most once a day while it stays stuck.
const STUCK_ALERT_ATTEMPTS = 6;
const STUCK_REALERT_MS = 24 * 60 * 60 * 1000;
// The daily "windows ending soon" digest: how far ahead, and the JST hour it
// goes out (the owner works in JST).
const ADVANCE_MS = 3 * 24 * 60 * 60 * 1000;
const DIGEST_HOUR_JST = 9;
const LIST_MAX = 20;
// How close to accessEnd the "expiring soon" heads-up fires.
const WARN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

let timer = null;

// Self-rescheduling tick (the codebase's timer convention — see
// utils/botHealthMonitor.js / utils/dropScanner.js) so a slow sweep never
// overlaps itself.
function scheduleNext() {
  timer = setTimeout(tick, INTERVAL_MS);
  if (timer.unref) timer.unref();
}

async function tick() {
  try {
    await sweepOnce();
  } catch (e) {
    console.error("[renterExpiry] sweep error:", e.message);
  }
  scheduleNext();
}

// Days (rounded up) until a date — for human-readable warnings.
function daysLeft(end, now) {
  return Math.max(1, Math.ceil((new Date(end) - now) / 86400000));
}

// Per-account leases (RenterAccount.farmUntil): pull just the lapsed account
// out of the config it is REALLY in and leave the rest of the bot farming. The
// row is kept (disabled, stamped) so the operator still sees it in the roster
// with its drops, rather than it silently vanishing.
//
// A row is stamped farmEndedAt only once the account is confirmed off every
// config on its host AND each bot it left has reloaded (or was not running).
// Before 2026-10-01 it was stamped whenever the ONE recorded file did not
// throw — a moved stack (ENOENT), an unknown host or a failed restart all
// reported "pulled off the bot" while the account kept farming.
async function sweepAccounts(now) {
  const due = await RenterAccount.find({
    farmUntil: { $ne: null, $lte: now },
    farmEndedAt: null,
  });
  if (!due.length) return { ended: [], stuck: [] };

  const byHost = new Map();
  const unknownHost = [];
  for (const a of due) {
    const host = hosts.resolveHost(a.host);
    if (!host) {
      unknownHost.push(a);
      continue;
    }
    if (!byHost.has(host.id)) byHost.set(host.id, { host, accounts: [] });
    byHost.get(host.id).accounts.push(a);
  }

  const ended = [];
  const stuck = [];
  for (const a of unknownHost) {
    stuck.push({ a, reason: "unknown bot host '" + (a.host || "") + "'" });
  }

  for (const { host, accounts } of byHost.values()) {
    const secrets = accounts.map((a) => a.clientSecret).filter(Boolean);
    const recordedFiles = new Set(accounts.map((a) => a.configFile).filter(Boolean));
    let located;
    try {
      located = await locateSecrets(host, secrets, [...recordedFiles]);
    } catch (e) {
      const reason = "could not read " + host.id + "'s configs: " + String(e.message || e).slice(0, 160);
      for (const a of accounts) stuck.push({ a, reason });
      continue;
    }
    const files = [...new Set([...recordedFiles, ...located.keys()])];
    const failedFile = new Map(); // file -> reason
    for (const file of files) {
      try {
        const det = await detachFromFile(host, file, secrets);
        if (det.missing) continue;
        await settleAfterDetach(host, file, det, { reloadOwed: recordedFiles.has(file) });
      } catch (e) {
        failedFile.set(file, String((e && e.message) || e).slice(0, 160));
      }
    }
    for (const a of accounts) {
      // Stuck only if a file THIS account was in (or is recorded in) failed —
      // the pull or the reload may not have happened there.
      const mine = new Set([a.configFile].filter(Boolean));
      for (const [f, set] of located) if (set.has(a.clientSecret)) mine.add(f);
      const bad = [...mine].find((f) => failedFile.has(f));
      if (bad) stuck.push({ a, reason: bad + ": " + failedFile.get(bad) });
      else ended.push(a);
    }
  }

  for (const a of ended) {
    a.farmEndedAt = new Date();
    a.enabled = false;
    a.configFile = "";
    a.container = "";
    a.expiryAttempts = 0;
    a.expiryLastError = "";
    await a.save();
    console.log("[renterExpiry] farming window ended for " + (a.login || a._id));
  }
  const nowMs = Date.now();
  const toAlert = [];
  for (const { a, reason } of stuck) {
    a.expiryAttempts = (Number(a.expiryAttempts) || 0) + 1;
    a.expiryLastError = reason;
    const due =
      a.expiryAttempts >= STUCK_ALERT_ATTEMPTS &&
      (!a.expiryAlertedAt || nowMs - new Date(a.expiryAlertedAt).getTime() > STUCK_REALERT_MS);
    if (due) {
      a.expiryAlertedAt = new Date();
      toAlert.push({ a, reason });
    }
    await a.save().catch((e) => console.error("[renterExpiry] save stuck row:", e.message));
    console.error(
      "[renterExpiry] could not pull " + (a.login || a._id) + " (attempt " + a.expiryAttempts + "): " + reason,
    );
  }

  if (ended.length) {
    const info = await windowInfo(ended);
    await sendTelegram(
      "⌛ " + ended.length + " farming window(s) ended — pulled off the bots:\n" +
        listLines(ended, info),
    ).catch(() => {});
    logEvent({
      category: "renting",
      action: "farm_windows_ended",
      actor: "renterExpiry",
      count: ended.length,
      detail: ended.map((a) => a.login || String(a._id)).join(", ").slice(0, 480),
    });
  }
  if (toAlert.length) {
    const info = await windowInfo(toAlert.map((x) => x.a));
    await sendTelegram(
      "🚨 " + toAlert.length + " lapsed farming window(s) could NOT be pulled off their bot — " +
        "they are still farming past the end of their term. Retrying every 5 min:\n" +
        toAlert
          .slice(0, LIST_MAX)
          .map((x) => "• " + describeAccount(x.a, info) + " — " + x.reason)
          .join("\n") +
        (toAlert.length > LIST_MAX ? "\n… and " + (toAlert.length - LIST_MAX) + " more" : ""),
    ).catch(() => {});
  }
  return { ended, stuck };
}

// Order / renter context for a batch of accounts: the rent-farm order each
// login was sold under (market, order, buyer, game, term), else its renter.
async function windowInfo(accounts) {
  const logins = [...new Set(accounts.map((a) => String(a.login || "")).filter(Boolean))];
  const lower = logins.map((l) => l.toLowerCase());
  const byLogin = new Map();
  if (logins.length) {
    const orders = await FarmServiceOrder.find(
      { "accounts.login": { $in: [...new Set([...logins, ...lower])] } },
      { orderId: 1, market: 1, buyerUsername: 1, game: 1, days: 1, "accounts.login": 1 },
    )
      .lean()
      .catch(() => []);
    for (const o of orders) {
      for (const x of o.accounts || []) byLogin.set(String(x.login || "").toLowerCase(), o);
    }
  }
  const renterIds = [...new Set(accounts.map((a) => String(a.renter)))];
  const renters = await Renter.find({ _id: { $in: renterIds } }, { username: 1 })
    .lean()
    .catch(() => []);
  const byRenter = new Map(renters.map((r) => [String(r._id), r.username]));
  return { byLogin, byRenter };
}

function describeAccount(a, info) {
  const o = info.byLogin.get(String(a.login || "").toLowerCase());
  const who = o
    ? (o.market || "?") + " order " + String(o.orderId || "").slice(0, 8) +
      (o.buyerUsername ? " (" + o.buyerUsername + ")" : "") +
      (o.game ? " — " + o.game + (o.days ? " " + o.days + "d" : "") : "")
    : "renter " + (info.byRenter.get(String(a.renter)) || "?");
  return (a.login || String(a._id)) + " — " + who;
}

function listLines(accounts, info) {
  return (
    accounts.slice(0, LIST_MAX).map((a) => "• " + describeAccount(a, info)).join("\n") +
    (accounts.length > LIST_MAX ? "\n… and " + (accounts.length - LIST_MAX) + " more" : "")
  );
}

// JST calendar day and hour for a timestamp (the owner's clock).
function jst(nowMs) {
  const d = new Date(nowMs + 9 * 3600 * 1000);
  return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

// Once a day (after DIGEST_HOUR_JST, JST): every window that will lapse in the
// next ADVANCE_MS, with its order, so a renewal can be offered before the
// account is pulled — and so the day's pulls are no surprise. Deduped by a
// SystemEvent per JST day, so a restart does not send it twice.
async function advanceDigest(now) {
  const { day, hour } = jst(now.getTime());
  if (hour < DIGEST_HOUR_JST) return false;
  const already = await SystemEvent.findOne(
    { action: "farm_windows_ending_digest", subject: day },
    { _id: 1 },
  )
    .lean()
    .catch(() => null);
  if (already) return false;
  const soon = await RenterAccount.find(
    { farmEndedAt: null, farmUntil: { $gt: now, $lte: new Date(now.getTime() + ADVANCE_MS) } },
    { login: 1, renter: 1, farmUntil: 1 },
  )
    .sort({ farmUntil: 1 })
    .lean();
  // Record the day first: a Telegram hiccup must not turn into a resend every
  // five minutes.
  await logEvent({
    category: "renting",
    action: "farm_windows_ending_digest",
    actor: "renterExpiry",
    subject: day,
    count: soon.length,
  });
  if (!soon.length) return true;
  const info = await windowInfo(soon);
  const lines = soon.slice(0, LIST_MAX).map(
    (a) => "• " + new Date(a.farmUntil).toISOString().slice(0, 10) + " " + describeAccount(a, info),
  );
  await sendTelegram(
    "📅 " + soon.length + " farming window(s) end in the next 3 days:\n" + lines.join("\n") +
      (soon.length > LIST_MAX ? "\n… and " + (soon.length - LIST_MAX) + " more" : ""),
  ).catch(() => {});
  return true;
}

async function sweepOnce() {
  const now = new Date();
  await sweepAccounts(now).catch((e) =>
    console.error("[renterExpiry] account sweep error:", e.message),
  );
  await advanceDigest(now).catch((e) =>
    console.error("[renterExpiry] ending-soon digest error:", e.message),
  );

  // 1) Leases inside their final WARN_MS: tell the operator once per lease so
  // there's time to collect a renewal before the bot gets stopped. The stamp
  // comparison (expiryWarnedAt < accessEnd - WARN_MS) re-arms the warning after
  // a lease extension: the old stamp predates the new window, the fresh one
  // doesn't.
  const expiring = await Renter.find({
    status: "active",
    accessEnd: { $gt: now, $lte: new Date(now.getTime() + WARN_MS) },
  });
  for (const r of expiring) {
    const windowStart = new Date(new Date(r.accessEnd).getTime() - WARN_MS);
    if (r.expiryWarnedAt && r.expiryWarnedAt >= windowStart) continue;
    r.expiryWarnedAt = now;
    await r.save();
    await sendTelegram(
      "⏳ Renter lease expiring: " +
        r.username +
        " ends in " +
        daysLeft(r.accessEnd, now) +
        " day(s) (" +
        new Date(r.accessEnd).toISOString().slice(0, 10) +
        "). Renew it or the bot stops automatically.",
    );
    console.log("[renterExpiry] expiry warning sent for " + r.username);
  }

  // 2) Expired (lease end in the past) OR suspended, assigned a bot, not
  // already stopped by us: pull their accounts off the bot and tell the
  // operator. Suspended renters are here so a suspend whose stop failed (host
  // offline at the time) is retried instead of being forgotten. The rent-farm
  // holder is never a renter to stop — its accounts are paid buyers.
  const expired = await Renter.find({
    botFile: { $gt: "" },
    botStoppedAt: null,
    usernameLower: { $ne: OPERATOR_HOLDER_USERNAME },
    $or: [{ accessEnd: { $ne: null, $lte: now } }, { status: "suspended" }],
  });
  for (const r of expired) {
    const host = hosts.resolveHost(r.botHost);
    if (!host) {
      console.error(
        "[renterExpiry] renter " + r.username + " has an unknown bot host '" +
          (r.botHost || "") + "' — cannot stop it",
      );
      continue;
    }
    const why =
      r.accessEnd && new Date(r.accessEnd) <= now ? "lease ended" : "suspended";
    try {
      // Only this renter's accounts are pulled, wherever they are; a bot left
      // empty is stopped for good, a bot others still farm on keeps running.
      const out = await stopRenterFarming(r, host);
      r.botStoppedAt = new Date();
      await r.save();
      const detail = describeStop(out, host);
      logEvent({
        category: "renting",
        action: why === "lease ended" ? "lease_ended" : "suspend_stop_retried",
        actor: "renterExpiry",
        subject: r.username || "",
        host: r.botHost || "",
        container: r.botFile || "",
        detail: why + " — " + detail,
      });
      console.log(
        "[renterExpiry] stopped farming for " + why + " renter " + r.username,
      );
      await sendTelegram(
        (why === "lease ended" ? "⏰ Renter lease ended: " : "⏸ Renter suspended: ") +
          r.username + " — " + detail,
      );
    } catch (e) {
      // Host offline / unreadable — try again next tick (botStoppedAt stays
      // null so it isn't marked done prematurely).
      console.error(
        "[renterExpiry] could not stop bot for " + r.username + ":",
        e.message,
      );
    }
  }
}

// One line for the operator: how many accounts came off which bots, and what
// became of each container.
function describeStop(out, host) {
  const files = (out && out.files) || [];
  const touched = files.filter((f) => f.removed > 0);
  const stopped = files.filter((f) => f.action === "stopped").map((f) => f.file);
  const kept = files
    .filter((f) => f.removed > 0 && f.action !== "stopped")
    .map((f) => f.file);
  let s =
    (out ? out.removed : 0) + " account(s) pulled off " +
    (touched.length ? touched.map((f) => f.file).join(", ") : "their bot") +
    " on " + (host.label || host.id) + ".";
  if (stopped.length) s += " Now empty and stopped: " + stopped.join(", ") + ".";
  if (kept.length) s += " Other accounts on " + kept.join(", ") + " keep farming.";
  return s;
}

function start() {
  if (timer) return;
  // First sweep one interval out, so it doesn't run during the boot storm.
  scheduleNext();
}

module.exports = {
  start,
  sweepOnce,
  sweepAccounts,
  advanceDigest,
  describeStop,
  STUCK_ALERT_ATTEMPTS,
};
