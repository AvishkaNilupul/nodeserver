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
const Renter = require("../models/Renter");
const hosts = require("./botHosts");
const { stopConfigContainer } = require("../routes/botConfigRoutes");

const INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

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

async function sweepOnce() {
  const now = new Date();
  // Expired (lease end in the past), assigned a bot, not already stopped by us.
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
