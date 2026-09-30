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
// "Room" is capped by a second wall: the holder renter's own account limit
// (Renter.maxAccounts), which farmFreshAccounts enforces before it ever looks at
// a stack. On 2026-09-28 the holder sat at 250/250 for seven hours and four paid
// Eldorado orders failed every tick while this module reported 117 free slots —
// the same "every dial said fine" failure, one layer up. totalFree is therefore
// the stacks' free slots CAPPED by what the holder may still hold, and every
// consumer (the Telegram alert, the health page, the Gameflip buffer's reserve
// floor) reads that one number.
//
// WHY IT ONLY ALERTS, AND DOES NOT TAKE OFFERS OFF SALE
// Pausing a rent-farm offer at zero capacity is the obviously "safe" move, and it
// was deliberately not built. Five of the nine live rent-farm offers are on
// Gameflip, which exposes no relist call (`g2gRelist`, `zeusxRelist`,
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
function operatorFarm() {
  return require("./operatorFarm");
}

// What room is left, per stack and in total. Read-only.
async function snapshot() {
  const { bots = [], offlineHosts = [] } = await renterAdmin().rentalStackOptions();
  // Rent-farm capacity is what the HOLDER may use: a direct renter's own bot
  // never takes a buyer (renterAdminRoutes.usableForHolder), so its free slots
  // are not ours to count. Rows from an older stack reader (no flag) count.
  const usable = renterAdmin().usableForHolder || (() => true);
  const stacks = bots.filter((b) => usable(b)).map((b) => ({
    host: b.host,
    file: b.file,
    used: Number(b.accounts) || 0,
    capacity: Number(b.capacity) || 0,
    remaining: Math.max(0, Number(b.remaining) || 0),
    // null = the host could not be asked. Only an explicit false is "dead".
    running: b.running,
  }));
  // Free slots on a STOPPED container are not capacity: an order routed there
  // is money taken for no service. They are reported SEPARATELY rather than
  // silently dropped, so the operator reads "400 slots exist but are dead"
  // instead of watching the headline total quietly shrink with no explanation.
  //
  // This module's own header says it exists because "every dial said fine".
  // Counting slots on containers that are not running is that same failure,
  // wearing a different hat.
  // Same rule the picker uses (renterBotStacks.chooseAvailableStack): a stopped
  // but EMPTY stack is merely un-started and its slots are genuinely usable —
  // the provision path writes the accounts and then starts the container. Only
  // a stopped stack that already HOLDS accounts is dead capacity.
  const live = stacks.filter((s) => s.running !== false || !s.used);
  const dead = stacks.filter((s) => s.running === false && s.used > 0);
  const stackFree = live.reduce((n, s) => n + s.remaining, 0);
  // A failed read here throws, like a failed stack read: callers already treat
  // a failed snapshot as "unknown" / "do not publish", never as a number.
  const quota = await operatorFarm().holderQuota();
  const quotaBinds = !!quota && quota.remaining < stackFree;
  return {
    stacks,
    offlineHosts: offlineHosts.map((h) => h.label || h.id),
    totalFree: quotaBinds ? quota.remaining : stackFree,
    stackFree,
    // { max, used, remaining } of the holder renter, or null before it exists.
    quota,
    limitedBy: quotaBinds ? "holder-limit" : "stacks",
    deadFree: dead.reduce((n, s) => n + s.remaining, 0),
    deadStacks: dead.map((s) => s.host + "/" + s.file),
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
    .map(
      (s) =>
        "  " + s.host + "/" + s.file + "  " + s.used + "/" + s.capacity +
        // Same split as snapshot(): stopped-and-occupied is dead, but
        // stopped-and-EMPTY is merely un-started — its slots ARE counted,
        // because the first delivery writes the accounts and starts it.
        (s.running === false
          ? s.used > 0
            ? "  (container STOPPED — these slots do not count)"
            : "  (not started yet — starts on its first delivery; counted)"
          : ""),
    );
  const q = snap.quota;
  const head =
    snap.limitedBy === "holder-limit"
      ? snap.totalFree + " usable slot(s) — capped by the rent-farm holder's account " +
        "limit (" + q.used + "/" + q.max + " used); the " + snap.readable +
        " stack(s) themselves have " + snap.stackFree + " free"
      : snap.totalFree + " free slot(s) across " + snap.readable + " stack(s)";
  return (
    head + "\n" +
    lines.join("\n") +
    (q ? "\n  holder account limit  " + q.used + "/" + q.max : "") +
    (snap.deadFree
      ? "\n\n" + snap.deadFree + " further slot(s) sit on STOPPED stacks and are " +
        "NOT counted: " + snap.deadStacks.join(", ")
      : "") +
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
    // The fix depends on WHICH wall it is: raising a stack does nothing for a
    // holder at its account limit, and vice versa.
    const fix =
      snap.limitedBy === "holder-limit"
        ? "The stacks have room — the holder renter operator-selffarm is at its " +
          "account limit. Raise its Account limit on the Renters page before the next sale."
        : "Raise a stack's capacity or register another bot config before the next sale.";
    await sendTelegram(
      head + "\n\n" + describe(snap) +
        "\n\nAn order takes one slot per account and holds it until its window " +
        "lapses (you sell 180-day and 1-year windows). " + fix,
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

// ------------------------------------------------------------------
// Dead stacks (2026-10-01). A rental stack that HOLDS accounts but whose
// container is not running — or whose config file is missing or unreadable —
// has every buyer on it farming nothing. The level alarm above only reports
// "dead" slots inside a low/empty message, the host watchdog treats a plain
// `docker stop` (exit 143) as intentional, and the health monitor only reads
// running containers, so such a stack could sit dead with nobody told.
// Latched per stack: one page when it goes dead, a reminder every
// DEAD_REMIND_MS while it stays dead, one line when it recovers.
// ------------------------------------------------------------------
const DEAD_REMIND_MS = 6 * 60 * 60 * 1000;
const deadAlerted = new Map(); // "host/file" -> last page ms

let deps = {};
const REAL = {
  rentalStackOptions: () => renterAdmin().rentalStackOptions(),
  listStacks: () => require("./renterBotStacks").listStacks(),
  gatherPoolEligibility: () => renterAdmin().gatherPoolEligibility(),
  holderId: async () => {
    const Renter = require("../models/Renter");
    const h = await Renter.findOne({ usernameLower: "operator-selffarm" }, { _id: 1 }).lean();
    return h ? h._id : null;
  },
  countRows: (q) => require("../models/RenterAccount").countDocuments(q),
  snapshot: () => snapshot(),
  now: () => Date.now(),
};
function dep(name) {
  return Object.prototype.hasOwnProperty.call(deps, name) ? deps[name] : REAL[name];
}

async function deadStacksCheck({ notify = true } = {}) {
  const { bots = [], offlineHosts = [] } = await dep("rentalStackOptions")();
  const offline = new Set((offlineHosts || []).map((h) => h.id || h));
  const registered = await dep("listStacks")();
  const now = dep("now")();
  const dead = [];
  for (const b of bots) {
    const inFile = Number(b.physical != null ? b.physical : b.accounts) || 0;
    if (b.running === false && inFile > 0) {
      dead.push({ key: b.host + "/" + b.file, accounts: inFile, why: "its container is NOT running" });
    }
  }
  const seen = new Set(bots.map((b) => b.host + "/" + b.file));
  for (const st of registered || []) {
    const key = String(st.host || "local") + "/" + st.file;
    if (offline.has(String(st.host || "local")) || seen.has(key)) continue;
    dead.push({ key, accounts: null, why: "its config file is missing or unreadable" });
  }
  const deadKeys = new Set(dead.map((d) => d.key));
  const page = [];
  for (const d of dead) {
    const last = deadAlerted.get(d.key);
    if (!last || now - last >= DEAD_REMIND_MS) {
      page.push(d);
      if (notify) deadAlerted.set(d.key, now);
    }
  }
  const recovered = [...deadAlerted.keys()].filter((k) => !deadKeys.has(k));
  if (notify) {
    if (page.length) {
      await sendTelegram(
        "🛑 Rental stack(s) holding accounts are NOT farming:\n" +
          page
            .map((d) => "• " + d.key + (d.accounts != null ? " (" + d.accounts + " accounts)" : "") + " — " + d.why)
            .join("\n") +
          "\n\nEvery buyer / renter account on it is getting nothing. Start the container " +
          "(Bots page) or find the config; this reminds every 6 h while it lasts.",
      ).catch((e) => console.error("rentFarmCapacity telegram failed:", e.message));
      logEvent({
        category: "renter",
        action: "rental_stack_dead",
        actor: "rentFarmCapacity",
        severity: "error",
        count: page.length,
        detail: page.map((d) => d.key + ": " + d.why).join(" | ").slice(0, 480),
      }).catch(() => {});
    }
    for (const k of recovered) {
      deadAlerted.delete(k);
      await sendTelegram("✅ Rental stack " + k + " is farming again.").catch(() => {});
    }
  }
  return { dead, paged: page.map((d) => d.key), recovered };
}

// ------------------------------------------------------------------
// Runway (2026-10-01). "10 slots left" was about a day of notice at ~10 sales
// a day, and the pristine pool had no push at all until an order failed
// (2026-09-21). Both are now judged in DAYS at the trailing 7-day rate: warn
// under WARN_DAYS, page under CRIT_DAYS, once per level change, and again daily
// while critical.
// ------------------------------------------------------------------
const WARN_DAYS = 10;
const CRIT_DAYS = 4;
const RUNWAY_REMIND_MS = 24 * 60 * 60 * 1000;
const runwayState = { slots: { level: "ok", at: 0 }, pool: { level: "ok", at: 0 } };

function runwayLevel(days) {
  if (days == null || !isFinite(days)) return "ok";
  if (days < CRIT_DAYS) return "critical";
  if (days < WARN_DAYS) return "warn";
  return "ok";
}

async function runwayCheck({ notify = true } = {}) {
  const now = dep("now")();
  const since = new Date(now - 7 * 86400000);
  const holder = await dep("holderId")();
  if (!holder) return null;
  const [made, ended] = await Promise.all([
    dep("countRows")({ renter: holder, createdAt: { $gte: since } }),
    dep("countRows")({ renter: holder, farmEndedAt: { $gte: since } }),
  ]);
  const takenPerDay = made / 7; // pristine accounts consumed (every sale + buffer)
  const netSlotsPerDay = (made - ended) / 7; // slots consumed net of windows ending
  const snap = await dep("snapshot")();
  const pool = await dep("gatherPoolEligibility")();
  const eligible = pool && Array.isArray(pool.eligible) ? pool.eligible.length : null;
  const out = {
    takenPerDay: Math.round(takenPerDay * 10) / 10,
    netSlotsPerDay: Math.round(netSlotsPerDay * 10) / 10,
    freeSlots: snap.totalFree,
    eligible,
    slotDays: netSlotsPerDay > 0 ? snap.totalFree / netSlotsPerDay : null,
    poolDays: takenPerDay > 0 && eligible != null ? eligible / takenPerDay : null,
  };
  const checks = [
    ["slots", out.slotDays, "rental stack slots", out.freeSlots + " free, ~" + out.netSlotsPerDay + "/day net",
      "Register another rental stack (50 slots) before they run out."],
    ["pool", out.poolDays, "pristine pool accounts", (eligible == null ? "?" : eligible) + " eligible, ~" + out.takenPerDay + "/day taken",
      "Restock the pool (or move empty no-claim accounts back) before rent-farm orders start failing."],
  ];
  for (const [kind, days, what, detail, fix] of checks) {
    const level = runwayLevel(days);
    const st = runwayState[kind];
    const changed = level !== st.level;
    const remind = level === "critical" && now - st.at >= RUNWAY_REMIND_MS;
    if (notify && level !== "ok" && (changed || remind)) {
      await sendTelegram(
        (level === "critical" ? "🛑 " : "⚠️ ") + "Rent-farm " + what + " run out in about " +
          Math.max(0, Math.floor(days)) + " day(s) (" + detail + "). " + fix,
      ).catch((e) => console.error("rentFarmCapacity telegram failed:", e.message));
      logEvent({
        category: "renter",
        action: "rent_farm_runway_" + kind,
        actor: "rentFarmCapacity",
        severity: level === "critical" ? "error" : "warn",
        count: Math.floor(days),
        detail,
      }).catch(() => {});
      st.at = now;
    } else if (notify && changed && level === "ok" && st.level !== "ok") {
      await sendTelegram("✅ Rent-farm " + what + " runway is healthy again (" + detail + ").").catch(() => {});
    }
    if (notify) st.level = level;
  }
  return out;
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
    }
    try {
      await deadStacksCheck({});
    } catch (e) {
      console.error("rentFarmCapacity dead-stack check failed:", e.message);
    }
    try {
      await runwayCheck({});
    } catch (e) {
      console.error("rentFarmCapacity runway check failed:", e.message);
    }
    try {
      // Ledger vs configs (dead tokens, not farming, farming past the end,
      // doubles, wrong game) — gated to at most hourly inside.
      await require("./renterIntegrity").checkOnce({});
    } catch (e) {
      console.error("renter integrity check failed:", e.message);
    } finally {
      const t = setTimeout(tick, TICK_MS);
      if (t.unref) t.unref();
    }
  };
  const t = setTimeout(tick, FIRST_DELAY_MS);
  if (t.unref) t.unref();
}

module.exports = { TICK_MS, LOW_WATER, snapshot, levelFor, describe, checkOnce, start,
  deadStacksCheck, runwayCheck, runwayLevel, WARN_DAYS, CRIT_DAYS,
  // testing seams: the alert-state latches, and injectable reads
  __setDeps: (d) => { deps = { ...deps, ...(d || {}) }; },
  _reset: () => {
    lastLevel = null;
    deadAlerted.clear();
    runwayState.slots = { level: "ok", at: 0 };
    runwayState.pool = { level: "ok", at: 0 };
    deps = {};
  } };
