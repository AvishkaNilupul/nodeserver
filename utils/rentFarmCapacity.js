// Watch the thing that actually runs out.
//
// A rent-farm order ("… Automatic Farming 180 days") is fulfilled by writing a
// pristine pool account into a bot config on a host. The binding constraint is
// therefore SLOTS IN THOSE CONFIGS — not the account pool, which is the number
// everything else reports and the number everyone looked at.
//
// On 2026-09-08 the holder's stack sat at 10/10 for nine hours. Two paid orders
// arrived in that window: one the owner shipped by hand, one the buyer cancelled
// after 25 failed attempts. Throughout, the pool showed 554 eligible accounts and
// `previewFreshAccounts` answered `willAdd: 1`. Every dial said fine.
//
// utils/operatorFarm.ensureStackWithRoom now moves the holder to whichever stack
// has room, so a single full config no longer blocks anything. This module is the
// layer above that: it says how much room is left in TOTAL, and shouts before the
// last of it goes.
//
// WHY IT ONLY ALERTS, AND DOES NOT TAKE OFFERS OFF SALE
// Pausing a rent-farm offer at zero capacity is the obviously "safe" move, and it
// was deliberately not built. Five of the nine live rent-farm offers are on
// Gameflip, which exposes no relist call (`z2uRelist`, `g2gRelist`, `zeusxRelist`,
// `eldoradoRelist` and `playerauctionsRelist` all exist; there is no Gameflip
// equivalent). An automatic pause with no tested automatic resume trades a
// visible, recoverable failure for silent, permanent lost revenue. So: warn early,
// warn loudly, and leave the decision with the operator.
const { sendTelegram } = require("./telegram");
const { logEvent } = require("./systemLog");

// Every 30 minutes. Slots only move when an order lands or a lease lapses, so a
// tighter loop would just re-read the same configs over the Pi link.
const TICK_MS = 30 * 60 * 1000;
const FIRST_DELAY_MS = 4 * 60 * 1000;

// Shout when total free slots across every readable stack falls to or below
// this. Deliberately generous: the point is to be told while there is still time
// to add a config, not to be told at zero.
const LOW_WATER = 10;

let timer = null;
// Alert state, so a persistent shortage does not re-ping every half hour. It
// re-arms as soon as capacity recovers, and on restart — a fresh reminder after
// a deploy is wanted, not noise.
let lastLevel = null;

function renterAdmin() {
  return require("../routes/renterAdminRoutes");
}

// What room is left, per stack and in total. Read-only.
async function snapshot() {
  const { bots = [], offlineHosts = [] } = await renterAdmin().rentalStackOptions();
  const stacks = bots.map((b) => ({
    host: b.host,
    file: b.file,
    used: Number(b.accounts) || 0,
    capacity: Number(b.capacity) || 0,
    remaining: Math.max(0, Number(b.remaining) || 0),
  }));
  return {
    stacks,
    offlineHosts: offlineHosts.map((h) => h.label || h.id),
    totalFree: stacks.reduce((n, s) => n + s.remaining, 0),
    totalCapacity: stacks.reduce((n, s) => n + s.capacity, 0),
    readable: stacks.length,
  };
}

// "ok" | "low" | "empty" — the three states worth telling anyone about.
function levelFor(totalFree) {
  if (totalFree <= 0) return "empty";
  if (totalFree <= LOW_WATER) return "low";
  return "ok";
}

function describe(snap) {
  const lines = snap.stacks
    .slice()
    .sort((a, b) => b.remaining - a.remaining)
    .map((s) => "  " + s.host + "/" + s.file + "  " + s.used + "/" + s.capacity);
  return (
    snap.totalFree + " free slot(s) across " + snap.readable + " stack(s)\n" +
    lines.join("\n") +
    (snap.offlineHosts.length
      ? "\n\nhost(s) offline and NOT counted: " + snap.offlineHosts.join(", ")
      : "")
  );
}

async function checkOnce({ notify = true } = {}) {
  const snap = await snapshot();
  const level = levelFor(snap.totalFree);
  const changed = level !== lastLevel;
  snap.level = level;
  snap.alerted = false;

  if (notify && changed && level !== "ok") {
    snap.alerted = true;
    const head =
      level === "empty"
        ? "🛑 Rent-farm capacity is GONE — the next 'Automatic Farming' order cannot be filled."
        : "⚠️ Rent-farm capacity is low — only " + snap.totalFree + " slot(s) left.";
    await sendTelegram(
      head + "\n\n" + describe(snap) +
        "\n\nAn order takes one slot per account and holds it until its window " +
        "lapses (you sell 180-day and 1-year windows). Raise a stack's capacity " +
        "or register another bot config before the next sale.",
    ).catch((e) => console.error("rentFarmCapacity telegram failed:", e.message));
    logEvent({
      category: "renter",
      action: "rent_farm_capacity_" + level,
      actor: "rentFarmCapacity",
      severity: level === "empty" ? "error" : "warn",
      count: snap.totalFree,
      detail: describe(snap).replace(/\n/g, " | "),
    }).catch(() => {});
  } else if (notify && changed && level === "ok" && lastLevel !== null) {
    // Recovery is worth one line: it closes the loop on the alert above.
    await sendTelegram(
      "✅ Rent-farm capacity recovered — " + snap.totalFree + " slot(s) free.",
    ).catch(() => {});
  }
  if (notify) lastLevel = level;
  return snap;
}

function start() {
  if (timer) return;
  timer = true;
  const tick = async () => {
    try {
      await checkOnce({});
    } catch (e) {
      // A host read failing is not a capacity emergency; it is a read failure.
      // Log it and try again next tick rather than crying wolf.
      console.error("rentFarmCapacity check failed:", e.message);
    } finally {
      const t = setTimeout(tick, TICK_MS);
      if (t.unref) t.unref();
    }
  };
  const t = setTimeout(tick, FIRST_DELAY_MS);
  if (t.unref) t.unref();
}

module.exports = { TICK_MS, LOW_WATER, snapshot, levelFor, describe, checkOnce, start,
  // testing seam: the alert-state latch
  _reset: () => { lastLevel = null; } };
