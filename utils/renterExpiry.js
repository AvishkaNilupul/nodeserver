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
  sweepPendingReloads,
} = require("./renterBotOps");
const { OPERATOR_HOLDER_USERNAME } = require("./renters");
const busy = require("./renterAccountBusy");

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
// config on its host AND each bot it left has reloaded (or was not running) —
// including a bot an EARLIER attempt pulled it from whose reload failed
// (expiryOwedFiles: the account is no longer found there, but that bot still
// has it loaded). Before 2026-10-01 it was stamped whenever the ONE recorded
// file did not throw — a moved stack (ENOENT), an unknown host or a failed
// restart all reported "pulled off the bot" while the account kept farming.
//
// Each row is marked busy (utils/renterAccountBusy) while it is worked on and
// re-read once marked, so a "Farm days" that re-arms the window at the same
// moment is either seen (the row is no longer due) or waits; the final stamp
// is conditional on the window being unchanged all the same.
async function sweepAccounts(now) {
  const dueIds = await RenterAccount.find(
    { farmUntil: { $ne: null, $lte: now }, farmEndedAt: null },
    { _id: 1 },
  ).lean();
  if (!dueIds.length) return { ended: [], stuck: [], busy: 0 };
  const releases = [];
  const held = [];
  let busyCount = 0;
  for (const { _id } of dueIds) {
    const release = busy.tryAcquire([_id]);
    if (!release) {
      busyCount++;
      continue;
    }
    releases.push(release);
    held.push(_id);
  }
  let out;
  try {
    const due = held.length
      ? await RenterAccount.find({
          _id: { $in: held },
          farmUntil: { $ne: null, $lte: now },
          farmEndedAt: null,
        })
      : [];
    out = await pullDue(due);
  } finally {
    for (const release of releases) release();
  }
  out.busy = busyCount;
  await reportSweep(out);
  return out;
}

async function pullDue(due) {
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
  const gamesBySecret = new Map();
  for (const a of unknownHost) {
    stuck.push({ a, reason: "unknown bot host '" + (a.host || "") + "'", files: a.expiryOwedFiles || [] });
  }

  for (const { host, accounts } of byHost.values()) {
    const secrets = accounts.map((a) => a.clientSecret).filter(Boolean);
    const recordedFiles = new Set(accounts.map((a) => a.configFile).filter(Boolean));
    const owedFiles = new Set(accounts.flatMap((a) => a.expiryOwedFiles || []));
    // Unreadable stacks / recorded files are collected, not thrown: every
    // readable file is still pulled, and the accounts stay "stuck" (retried,
    // paged) until the host can be read whole.
    const problems = [];
    let located;
    try {
      located = await locateSecrets(host, secrets, { mustRead: [...recordedFiles], problems });
    } catch (e) {
      const reason = "could not read " + host.id + "'s configs: " + String(e.message || e).slice(0, 160);
      for (const a of accounts) stuck.push({ a, reason, files: a.expiryOwedFiles || [] });
      continue;
    }
    const files = [...new Set([...recordedFiles, ...located.keys(), ...owedFiles])];
    const failedFile = new Map(); // file -> reason
    for (const file of files) {
      try {
        const det = await detachFromFile(host, file, secrets);
        if (det.missing) continue;
        // Each pulled account's own games, so a renewal ("Farm days") puts it
        // back farming exactly what it farmed.
        for (const [sec, g] of det.games || []) if (g && g.length) gamesBySecret.set(sec, g);
        // Reloads the bot when something was removed now, or a reload failed
        // on an earlier tick (PendingReload) — never otherwise.
        await settleAfterDetach(host, file, det);
      } catch (e) {
        failedFile.set(file, String((e && e.message) || e).slice(0, 160));
      }
    }
    const hostProblem = problems.length ? problems.join("; ").slice(0, 200) : "";
    for (const a of accounts) {
      // Stuck if a file THIS account was in, is recorded in, or was pulled
      // from on an earlier failed attempt failed now — the pull or the reload
      // may not have happened there. Or if part of the host could not be
      // read: the account might sit in the part that was not.
      const mine = new Set([a.configFile, ...(a.expiryOwedFiles || [])].filter(Boolean));
      for (const [f, set] of located) if (set.has(a.clientSecret)) mine.add(f);
      const bad = [...mine].filter((f) => failedFile.has(f));
      if (bad.length) stuck.push({ a, reason: bad[0] + ": " + failedFile.get(bad[0]), files: bad });
      else if (hostProblem) stuck.push({ a, reason: hostProblem, files: [] });
      else ended.push(a);
    }
  }

  // Stamp only a window that is still the one that lapsed: a writer that does
  // not take the busy mark (none should) re-arming it mid-sweep is reported,
  // never overwritten.
  const endedOk = [];
  const raced = [];
  for (const a of ended) {
    const r = await RenterAccount.updateOne(
      { _id: a._id, farmEndedAt: null, farmUntil: a.farmUntil },
      {
        $set: {
          farmEndedAt: new Date(),
          enabled: false,
          configFile: "",
          container: "",
          expiryAttempts: 0,
          expiryLastError: "",
          ...(gamesBySecret.has(a.clientSecret) ? { favouriteGames: gamesBySecret.get(a.clientSecret) } : {}),
        },
        $unset: { expiryOwedFiles: "" },
      },
    );
    if (r && (r.matchedCount || r.n)) {
      endedOk.push(a);
      console.log("[renterExpiry] farming window ended for " + (a.login || a._id));
    } else {
      raced.push(a);
    }
  }
  if (raced.length) {
    // The account WAS pulled; its row now says so, so "Farm days" (which
    // re-places a row that is on no bot) can put it back.
    await RenterAccount.updateMany(
      { _id: { $in: raced.map((a) => a._id) }, farmEndedAt: null },
      { $set: { configFile: "", container: "" } },
    ).catch(() => {});
  }
  const nowMs = Date.now();
  const toAlert = [];
  for (const { a, reason, files } of stuck) {
    a.expiryAttempts = (Number(a.expiryAttempts) || 0) + 1;
    a.expiryLastError = reason;
    a.expiryOwedFiles = files && files.length ? [...new Set(files)] : undefined;
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
  return { ended: endedOk, stuck, raced, toAlert };
}

async function reportSweep({ ended, raced, toAlert }) {
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
  if (raced && raced.length) {
    const info = await windowInfo(raced);
    await sendTelegram(
      "⚠️ " + raced.length + " farming window(s) were changed WHILE their lapsed term was being " +
        "pulled — the accounts are now on no bot. Use \"Farm days\" on each to put it back:\n" +
        listLines(raced, info),
    ).catch(() => {});
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
  // Every reload still owed — by a stop, a lapsed window or a start that
  // failed after writing — is retried here, not only when something happens
  // to touch the same file again (and pages when one stays owed).
  await sweepPendingReloads().catch((e) =>
    console.error("[renterExpiry] owed-reload sweep error:", e.message),
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
  const dueFilter = {
    botFile: { $gt: "" },
    botStoppedAt: null,
    usernameLower: { $ne: OPERATOR_HOLDER_USERNAME },
    $or: [{ accessEnd: { $ne: null, $lte: now } }, { status: "suspended" }],
  };
  const expired = await Renter.find(dueFilter, { _id: 1 }).lean();
  for (const { _id } of expired) {
    // Marked busy while it is stopped, and re-read once marked: a lease
    // renewal or unsuspend (which take the same mark) either lands first and
    // is seen here, or waits for the stop to finish and then resumes it.
    const release = busy.tryAcquire(["renter:" + String(_id)]);
    if (!release) continue; // an operator action on this renter is running: next tick
    try {
      const r = await Renter.findOne({ _id, ...dueFilter });
      if (r) await stopExpiredRenter(r, now);
    } finally {
      release();
    }
  }
}

async function stopExpiredRenter(r, now) {
  const host = hosts.resolveHost(r.botHost);
  if (!host) {
    console.error(
      "[renterExpiry] renter " + r.username + " has an unknown bot host '" +
        (r.botHost || "") + "' — cannot stop it",
    );
    return;
  }
  const why =
    r.accessEnd && new Date(r.accessEnd) <= now ? "lease ended" : "suspended";
  try {
    // Only this renter's accounts are pulled, wherever they are; a bot left
    // empty is stopped for good, a bot others still farm on keeps running.
    const out = await stopRenterFarming(r, host);
    stopFailures.delete(String(r._id));
    // Stamped only while the lease / status is still the one that was
    // stopped for (every writer of those takes the busy mark; this is the
    // belt to its braces).
    const stamped = await Renter.updateOne(
      { _id: r._id, botStoppedAt: null, accessEnd: r.accessEnd, status: r.status },
      { $set: { botStoppedAt: new Date(), botStopReason: why === "lease ended" ? "lease" : "suspend" } },
    );
    if (!(stamped && (stamped.matchedCount || stamped.n))) {
      await sendTelegram(
        "⚠️ Renter " + r.username + " was renewed or unsuspended WHILE its " + why +
          " stop ran — its accounts were pulled. Press Start on its bot to put them back.",
      ).catch(() => {});
      return;
    }
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
    // null so it isn't marked done prematurely). A renter whose stop keeps
    // failing is farming past its lease: page once it has for ~30 minutes,
    // then at most daily.
    console.error(
      "[renterExpiry] could not stop bot for " + r.username + ":",
      e.message,
    );
    const key = String(r._id);
    const f = stopFailures.get(key) || { n: 0, alertedAt: 0 };
    f.n += 1;
    if (f.n >= STUCK_ALERT_ATTEMPTS && Date.now() - f.alertedAt > STUCK_REALERT_MS) {
      f.alertedAt = Date.now();
      await sendTelegram(
        "🚨 Renter " + r.username + " (" + why + ") could NOT be stopped after " + f.n +
          " attempts — their accounts may still be farming. Last error: " +
          String(e.message || e).slice(0, 200),
      ).catch(() => {});
    }
    stopFailures.set(key, f);
  }
}

// Per-renter count of consecutive failed lease-end / suspend stops (in memory:
// a restart re-arms the page, which is the wanted direction).
const stopFailures = new Map();

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
