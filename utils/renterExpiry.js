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
const hosts = require("./botHosts");
const { sendTelegram } = require("./telegram");
const { logEvent } = require("./systemLog");
const { removeAccountFromConfig } = require("../routes/botConfigRoutes");
const { stopRenterFarming, restartIfRunning } = require("./renterBotOps");
const { OPERATOR_HOLDER_USERNAME } = require("./renters");

const INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
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
// out of the renter's config and leave the rest of the bot farming. The row is
// kept (disabled, stamped) so the operator still sees it in the roster with its
// drops, rather than it silently vanishing.
async function sweepAccounts(now) {
  const due = await RenterAccount.find({
    farmUntil: { $ne: null, $lte: now },
    farmEndedAt: null,
  });
  const touchedBots = new Map();
  for (const a of due) {
    const host = hosts.resolveHost(a.host);
    if (a.configFile && host) {
      try {
        const removed = await removeAccountFromConfig(host, a.configFile, {
          clientSecret: a.clientSecret,
          login: a.login,
        });
        if (removed) touchedBots.set(host.id + "|" + a.configFile, { host, file: a.configFile });
      } catch (e) {
        // Host offline — leave farmEndedAt null and retry next tick.
        console.error(
          "[renterExpiry] could not pull " + (a.login || a._id) + ":",
          e.message,
        );
        continue;
      }
    }
    a.farmEndedAt = new Date();
    a.enabled = false;
    a.configFile = "";
    a.container = "";
    await a.save();
    const renter = await Renter.findById(a.renter, { username: 1 }).lean();
    console.log(
      "[renterExpiry] farming window ended for " + (a.login || a._id),
    );
    await sendTelegram(
      "⌛ Account farming window ended: " +
        (a.login || String(a._id)) +
        (renter ? " (renter " + renter.username + ")" : "") +
        " — pulled off the bot.",
    );
  }
  // One restart per affected bot, after all its accounts are out — and only
  // for a bot that is RUNNING. `docker restart` starts a stopped container,
  // which is how a stopped (expired) renter's bot used to come back to life.
  for (const b of touchedBots.values()) {
    try {
      await restartIfRunning(b.host, b.file);
    } catch (e) {
      console.error(
        "[renterExpiry] could not restart " + b.file + ":",
        e.message,
      );
    }
  }
}

async function sweepOnce() {
  const now = new Date();
  await sweepAccounts(now).catch((e) =>
    console.error("[renterExpiry] account sweep error:", e.message),
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

module.exports = { start, sweepOnce, sweepAccounts, describeStop };
