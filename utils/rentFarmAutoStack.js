// Add a rental stack by itself before the rent-farm runs out of slots.
//
// A rent-farm order takes one slot in a rental stack (a bot config) and keeps
// it until its window ends. utils/rentFarmCapacity already says how many slots
// are left and, in days, how long they last — and for weeks the answer to its
// "register another rental stack" page was a person running the same two calls
// by hand: provisionEmptyConfig, then setStackCapacity. A stack fills in days,
// so that chore kept coming round, and an order failed whenever it was late
// (2026-09-08, 2026-09-21).
//
// This runs after the capacity and runway checks of every watchdog tick and
// makes those two calls itself, one stack a tick, while the slots are short.
// It runs inside the server, so the new config, its compose service and its
// slot number are made under the same provision lock every other bot is made
// under (routes/botConfigRoutes.provisionEmptyConfig). A new stack holds no
// accounts and no container is started: its first order writes the accounts
// and starts it (utils/operatorFarm.farmFreshAccounts).
//
// It only ever ADDS room, and refuses whenever it cannot be sure room is what
// is missing: a host that could not be read, the holder's account limit being
// the nearer wall, a host short of memory, or too many stacks added in a day.
// When it is switched on, needs a stack and may not add one, it says why
// (once a day) — the runway page alone would read as "it is being handled".
//
// Off unless autoFarm.rentFarmAutoStack is true. Settings (all autoFarm.*,
// read every tick, no restart):
//   rentFarmAutoStack              on / off
//   rentFarmAutoStackTargetDays    keep at least this many days of slots (14)
//   rentFarmAutoStackMinFree       ... and never fewer than this many slots (40)
//   rentFarmAutoStackCapacity      slots in a new stack, 1-100 (50)
//   rentFarmAutoStackMaxPerDay     stacks added per 24 h on the host, by anyone (3)
//   rentFarmAutoStackMinHostFreeMb host memory a new stack needs to see free (2000)
//   rentFarmAutoStackMaxStacks     rental stacks on the host, in all (40)
//   rentFarmAutoStackHost          host id; default = where the holder's stack is

const DAY_MS = 24 * 60 * 60 * 1000;
const HOLDER_USERNAME = "operator-selffarm";
// Under this many days of slots the day's limit on new stacks is worth the
// owner's attention (the watchdog's own runway warning starts at the same
// line, rentFarmCapacity.WARN_DAYS). Above it the limit only means "the rest
// tomorrow" and nothing is said.
const URGENT_DAYS = 10;

const DEFAULTS = {
  enabled: false,
  targetDays: 14,
  minFree: 40,
  capacity: 50,
  maxPerDay: 3,
  minHostFreeMb: 2000,
  maxStacks: 40,
  host: "",
};

function num(v, def, min, max) {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || !Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// The settings, with every missing or unusable value replaced by its default.
function config(af) {
  const a = af && typeof af === "object" ? af : {};
  return {
    enabled: a.rentFarmAutoStack === true,
    targetDays: num(a.rentFarmAutoStackTargetDays, DEFAULTS.targetDays, 1, 90),
    minFree: Math.floor(num(a.rentFarmAutoStackMinFree, DEFAULTS.minFree, 0, 1000)),
    capacity: Math.floor(num(a.rentFarmAutoStackCapacity, DEFAULTS.capacity, 1, 100)),
    maxPerDay: Math.floor(num(a.rentFarmAutoStackMaxPerDay, DEFAULTS.maxPerDay, 1, 20)),
    minHostFreeMb: Math.floor(num(a.rentFarmAutoStackMinHostFreeMb, DEFAULTS.minHostFreeMb, 0, 1000000)),
    maxStacks: Math.floor(num(a.rentFarmAutoStackMaxStacks, DEFAULTS.maxStacks, 1, 500)),
    host: String(a.rentFarmAutoStackHost || "").trim(),
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// PURE. What this tick should do.
//   { add: true, why }                    add one stack
//   { add: false, why }                   nothing to do / not safe to judge
//   { add: false, why, blocked: reason }  a stack IS needed and may not be added
// `blocked` is what gets said to the owner; a state that clears by itself (an
// unread host, unknown memory) is never one.
function decide({ cfg, snap, runway, hostId, hostStacks, addedLast24h, hostFreeMb, gate }) {
  if (!cfg || !cfg.enabled) return { add: false, why: "off" };
  if (!snap) return { add: false, why: "no capacity reading this tick" };
  if (snap.withheld || (snap.offlineHosts || []).length) {
    return { add: false, why: "a host could not be read, so the free slots are not known" };
  }
  if (snap.limitedBy === "holder-limit") {
    return { add: false, why: "the holder's account limit is the nearer wall, not the stacks" };
  }
  const free = Number(snap.stackFree != null ? snap.stackFree : snap.totalFree);
  if (!Number.isFinite(free)) return { add: false, why: "no free-slot figure" };
  const days = runway && Number.isFinite(runway.slotDays) && runway.slotDays >= 0 ? runway.slotDays : null;
  const short = free < cfg.minFree || (days !== null && days < cfg.targetDays);
  const room = free + " slot(s) free" + (days !== null ? ", about " + round1(days) + " day(s)" : "");
  if (!short) return { add: false, why: "enough room (" + room + ")" };

  if (!hostId) {
    return { add: false, why: "the rent-farm holder has no stack yet, so there is no host to add one on" };
  }
  if (String(hostId) === "local") {
    return {
      add: false,
      why: room + ", but the holder's stacks are on the web server itself",
      blocked: "the holder's stacks are on the web server itself, where a stack is not added " +
        "automatically. Add one by hand, or set rentFarmAutoStackHost to a bot host.",
    };
  }
  if (Number(hostStacks) >= cfg.maxStacks) {
    return {
      add: false,
      why: room + ", but " + hostId + " already has " + hostStacks + " rental stacks",
      blocked: hostId + " already has " + hostStacks + " rental stacks (limit " + cfg.maxStacks +
        ", rentFarmAutoStackMaxStacks).",
    };
  }
  if (Number(addedLast24h) >= cfg.maxPerDay) {
    const why = room + ", but " + addedLast24h + " stack(s) were added in the last 24 h";
    const urgent = free < cfg.minFree || (days !== null && days < Math.min(URGENT_DAYS, cfg.targetDays));
    if (!urgent) return { add: false, why: why + " — the next one waits for tomorrow" };
    return {
      add: false,
      why,
      blocked: addedLast24h + " stack(s) were already added on " + hostId + " in the last 24 h " +
        "(limit " + cfg.maxPerDay + ", rentFarmAutoStackMaxPerDay). Sales are running ahead of that.",
    };
  }
  if (gate && gate.ok === false) {
    return {
      add: false,
      why: room + ", but " + (gate.reason || "the host's memory gate refuses a new container"),
      blocked: (gate.reason || hostId + " is short of memory") + ". Another bot host is needed.",
    };
  }
  if (cfg.minHostFreeMb > 0) {
    if (hostFreeMb === null || hostFreeMb === undefined || !Number.isFinite(Number(hostFreeMb))) {
      return { add: false, why: room + ", but " + hostId + "'s free memory could not be read this tick" };
    }
    if (Number(hostFreeMb) < cfg.minHostFreeMb) {
      return {
        add: false,
        why: room + ", but " + hostId + " has only " + hostFreeMb + " MB of memory free",
        blocked: hostId + " has only " + hostFreeMb + " MB of memory free (a new stack needs " +
          cfg.minHostFreeMb + " MB, rentFarmAutoStackMinHostFreeMb). Another bot host is needed.",
      };
    }
  }
  return { add: true, why: room + " — under " + cfg.targetDays + " day(s) / " + cfg.minFree + " slot(s)" };
}

// ---------------------------------------------------------------------------
// Reads and writes (injectable)
// ---------------------------------------------------------------------------

const BLOCKED_REMIND_MS = DAY_MS;
const BLOCKED_ACTION = "rent_farm_stack_blocked";
const ADDED_ACTION = "rent_farm_stack_added";

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
  holderHost: async () => {
    const Renter = require("../models/Renter");
    const h = await Renter.findOne({ usernameLower: HOLDER_USERNAME }, { botHost: 1, botFile: 1 }).lean();
    if (!h || !h.botFile) return "";
    return String(h.botHost || "local");
  },
  // Stacks registered on the host since `since`, whoever made them: the row is
  // the thing that was created, so this cannot miss one the way an event could.
  addedSince: (hostId, since) =>
    require("../models/RenterBotStack").countDocuments({ host: hostId, createdAt: { $gte: new Date(since) } }),
  hostFreeMb: (hostId) => require("./hostCapacity").memAvailableMb(hostId),
  gate: (hostId) => require("./hostCapacity").newContainerAllowed(hostId),
  // The two calls a person made by hand. Returns { host, file, container }.
  provision: async (hostId, capacity) => {
    const host = require("./botHosts").resolveHost(hostId);
    if (!host) throw new Error("unknown bot host " + hostId);
    const made = await require("../routes/botConfigRoutes").provisionEmptyConfig(host);
    const row = await require("./renterBotStacks").setStackCapacity(made.host, made.file, capacity);
    if (!row) {
      throw new Error(
        made.host + "/" + made.file + " was created, but its capacity could not be set to " + capacity +
          " — it holds the default until that is set on the Renters page",
      );
    }
    return made;
  },
  lastBlockedAt: async () => {
    const SystemEvent = require("../models/SystemEvent");
    const row = await SystemEvent.findOne({ category: "renter", action: BLOCKED_ACTION }, { at: 1 })
      .sort({ at: -1 })
      .lean();
    return row && row.at ? new Date(row.at).getTime() : 0;
  },
  logEvent: (e) => require("./systemLog").logEvent(e),
  send: (text) => require("./telegram").sendTelegram(text),
};
function dep(name) {
  return Object.prototype.hasOwnProperty.call(deps, name) ? deps[name] : REAL[name];
}

async function say(text) {
  try {
    await dep("send")(text);
  } catch (e) {
    console.error("rentFarmAutoStack telegram failed:", (e && e.message) || e);
  }
}
async function log(event) {
  try {
    await dep("logEvent")(event);
  } catch {
    /* an event is a record, never a reason to fail */
  }
}

// When this process last said "blocked": the event behind lastBlockedAt is
// best-effort, and without this a failed write would repeat the page each tick.
let blockedSaidAt = 0;

// One pass. `snap` = this tick's rentFarmCapacity.checkOnce result, `runway` =
// its runwayCheck result (or null). Read-only unless a stack is added.
async function checkOnce({ snap = null, runway = null, notify = true } = {}) {
  const cfg = config(dep("autoFarm")());
  if (!cfg.enabled) return { added: false, why: "off" };

  const hostId = cfg.host || (await dep("holderHost")());
  const hostStacks = ((snap && snap.stacks) || []).filter((s) => String(s.host || "local") === String(hostId)).length;
  const now = dep("now")();

  // Ask the host for its memory only when a stack is wanted at all: this first
  // pass assumes plenty of it and nothing added yet.
  const first = decide({
    cfg, snap, runway, hostId, hostStacks,
    addedLast24h: 0, hostFreeMb: Number.MAX_SAFE_INTEGER, gate: null,
  });
  if (!first.add) return finish(first, { cfg, hostId, now, notify });

  const [addedLast24h, hostFreeMb, gate] = await Promise.all([
    dep("addedSince")(hostId, now - DAY_MS),
    Promise.resolve()
      .then(() => dep("hostFreeMb")(hostId))
      .catch(() => null),
    Promise.resolve()
      .then(() => dep("gate")(hostId))
      .catch(() => null),
  ]);
  const d = decide({ cfg, snap, runway, hostId, hostStacks, addedLast24h, hostFreeMb, gate });
  if (!d.add) return finish(d, { cfg, hostId, now, notify });

  let made;
  try {
    made = await dep("provision")(hostId, cfg.capacity);
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 300);
    console.error("rentFarmAutoStack: could not add a stack on " + hostId + ": " + msg);
    return finish(
      { add: false, why: "adding a stack failed: " + msg, blocked: "adding a stack on " + hostId + " failed: " + msg },
      { cfg, hostId, now, notify },
    );
  }

  const freeBefore = Number(snap.stackFree != null ? snap.stackFree : snap.totalFree) || 0;
  const days = runway && Number.isFinite(runway.slotDays) ? runway.slotDays : null;
  const rate = runway && Number.isFinite(runway.netSlotsPerDay) ? runway.netSlotsPerDay : null;
  const detail =
    made.host + "/" + made.file + " (" + cfg.capacity + " slots) — free slots were " + freeBefore +
    (days !== null ? ", about " + round1(days) + " day(s)" + (rate ? " at ~" + rate + " a day" : "") : "") +
    "; now " + (freeBefore + cfg.capacity);
  console.log("rentFarmAutoStack: added " + detail);
  await log({
    category: "renter",
    action: ADDED_ACTION,
    actor: "rentFarmAutoStack",
    subject: made.host + "/" + made.file,
    host: made.host,
    container: made.container || "",
    count: cfg.capacity,
    detail,
  });
  if (notify) {
    await say(
      "➕ Rent-farm: rental stack " + detail + ". It was added automatically and starts with " +
        "its first order. (Switch: autoFarm.rentFarmAutoStack)",
    );
  }
  return { added: true, why: d.why, host: made.host, file: made.file, container: made.container, capacity: cfg.capacity };
}

// Not added. A reason the owner has to act on is said once a day.
async function finish(d, { cfg, hostId, now, notify }) {
  const out = { added: false, why: d.why };
  if (!d.blocked) return out;
  out.blocked = d.blocked;
  if (!notify) return out;
  if (blockedSaidAt && now - blockedSaidAt < BLOCKED_REMIND_MS) return out;
  let last = 0;
  try {
    last = (await dep("lastBlockedAt")()) || 0;
  } catch {
    last = 0;
  }
  if (last && now - last < BLOCKED_REMIND_MS) {
    blockedSaidAt = last;
    return out;
  }
  blockedSaidAt = now;
  out.paged = true;
  console.error("rentFarmAutoStack: a stack is needed but was not added — " + d.blocked);
  await log({
    category: "renter",
    action: BLOCKED_ACTION,
    actor: "rentFarmAutoStack",
    severity: "warn",
    subject: String(hostId || ""),
    detail: (d.why + " | " + d.blocked).slice(0, 480),
  });
  await say(
    "⚠️ Rent-farm needs another rental stack and none was added: " + d.blocked +
      "\n\n(" + d.why + ". The automatic add keeps trying every 30 minutes and this " +
      "reminder repeats once a day while it lasts.)",
  );
  return out;
}

module.exports = {
  checkOnce,
  decide,
  config,
  DEFAULTS,
  URGENT_DAYS,
  // testing seams
  __setDeps: (d) => {
    deps = { ...deps, ...(d || {}) };
  },
  _reset: () => {
    deps = {};
    blockedSaidAt = 0;
  },
};
