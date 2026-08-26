const FleetSnapshot = require("../models/FleetSnapshot");
const BotAccount = require("../models/BotAccount");
const AvailableAccount = require("../models/AvailableAccount");
const DropLog = require("../models/DropLog");

// Periodic metric-history capture. Runs a HANDFUL of round trips (Atlas is
// bytes-bound and serialises concurrent queries — never fan out countDocuments),
// each in its own try/catch so a partial failure still records what it got.
// See models/FleetSnapshot.js for the why.

const TICK_MS = Number(process.env.FLEET_SNAPSHOT_MS) || 20 * 60 * 1000;
let timer = null;
let running = false;

// One $group over a field → { <value>: n, …, total }. Cheaper than N counts.
async function groupCount(Model, field) {
  const rows = await Model.aggregate([
    { $group: { _id: "$" + field, n: { $sum: 1 } } },
  ]);
  const out = {};
  let total = 0;
  for (const r of rows) {
    out[String(r._id == null ? "" : r._id)] = r.n;
    total += r.n;
  }
  out.total = total;
  return out;
}

async function captureSnapshot() {
  const metrics = {};
  try {
    const b = await groupCount(BotAccount, "lastScanStatus");
    metrics.botTotal = b.total;
    metrics.botOk = b.ok || 0;
    metrics.botSuspended = b.suspended || 0;
    metrics.botTokenInvalid = b.token_invalid || 0;
    metrics.botErrorStatus = b.error || 0;
    metrics.botPending = b.pending || 0;
  } catch (e) {
    metrics.bot_err = String(e.message).slice(0, 120);
  }
  try {
    metrics.botUndeployed = await BotAccount.countDocuments({
      configFile: { $in: ["", null] },
    });
  } catch {
    /* ignore */
  }
  try {
    const p = await groupCount(AvailableAccount, "status");
    metrics.poolTotal = p.total;
    metrics.poolAvailable = p.available || 0;
    metrics.poolClaimed = p.claimed || 0;
  } catch (e) {
    metrics.pool_err = String(e.message).slice(0, 120);
  }
  try {
    metrics.dropLogEntries = await DropLog.estimatedDocumentCount();
  } catch {
    /* ignore */
  }
  try {
    const MarketplaceListing = require("../models/MarketplaceListing");
    metrics.listingsTotal = await MarketplaceListing.estimatedDocumentCount();
  } catch {
    /* ignore */
  }
  try {
    await FleetSnapshot.create({ at: new Date(), metrics });
  } catch (e) {
    console.error("fleetSnapshot save failed:", e.message);
  }
  return metrics;
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await captureSnapshot();
  } catch (e) {
    console.error("fleetSnapshot tick failed:", e.message);
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  // First capture ~60s after boot (let Mongo settle), then every TICK_MS.
  setTimeout(tick, 60 * 1000).unref?.();
  timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
}

module.exports = { start, captureSnapshot, tick };
