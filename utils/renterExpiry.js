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
const hosts = require("./botHosts");
const { sendTelegram } = require("./telegram");
const { stopConfigContainer } = require("../routes/botConfigRoutes");

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

async function sweepOnce() {
  const now = new Date();

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

  // 2) Expired (lease end in the past), assigned a bot, not already stopped by
  // us: stop the bot and tell the operator it happened.
  const expired = await Renter.find({
    accessEnd: { $ne: null, $lte: now },
    botFile: { $gt: "" },
    botStoppedAt: null,
  });
  for (const r of expired) {
    const host = hosts.resolveHost(r.botHost);
    if (!host) continue;
    try {
      await stopConfigContainer(host, r.botFile);
      r.botStoppedAt = new Date();
      await r.save();
      console.log(
        "[renterExpiry] stopped bot for expired renter " + r.username,
      );
      await sendTelegram(
        "⏰ Renter lease ended: " +
          r.username +
          " — bot " +
          r.botFile +
          " on " +
          (host.label || r.botHost) +
          " was stopped.",
      );
    } catch (e) {
      // Host offline / no container — try again next tick (botStoppedAt stays
      // null so it isn't marked done prematurely).
      console.error(
        "[renterExpiry] could not stop bot for " + r.username + ":",
        e.message,
      );
    }
  }
}

function start() {
  if (timer) return;
  // First sweep one interval out, so it doesn't run during the boot storm.
  scheduleNext();
}

module.exports = { start, sweepOnce };
