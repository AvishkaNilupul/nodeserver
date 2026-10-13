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
// is missing:
//   - a host that could not be read, or the holder's account limit being the
//     nearer wall;
//   - a "short" reading seen once only: a stack whose config could not be read
//     this tick is simply missing from the listing, which looks the same as a
//     full farm, so the slots must read short on two ticks in a row;
//   - a host short of memory. A stack that has not started yet uses nothing
//     until its first order, so the memory it WILL need is counted too: free
//     memory, less a share for every stack not yet started and for the new
//     one, must leave the floor.
// When it is switched on, needs a stack and may not add one, it says why —
// once a day per reason, and only counted as said once Telegram took it. The
// runway page alone would read as "it is being handled". An add that failed is
// not tried again for six hours: each try costs a slot number.
//
// Off unless autoFarm.rentFarmAutoStack is true. Settings (all autoFarm.*,
// read every tick, no restart):
//   rentFarmAutoStack              on / off
//   rentFarmAutoStackTargetDays    keep at least this many days of slots (14)
//   rentFarmAutoStackMinFree       ... and never fewer than this many slots (40)
//   rentFarmAutoStackCapacity      slots in a new stack, 1-100 (50)
//   rentFarmAutoStackMaxPerDay     stacks added per 24 h on the host, by anyone (3)
//   rentFarmAutoStackMinHostFreeMb host memory that must stay free (2000; 0 = do not look)
//   rentFarmAutoStackPerStackMb    memory one full stack is counted as (300)
//   rentFarmAutoStackMaxStacks     rental stacks on the host, in all (40)
//   rentFarmAutoStackHost          host id; default = where the holder's stack is

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const HOLDER_USERNAME = "operator-selffarm";
// Under this many days of slots the day's limit on new stacks is worth the
// owner's attention (the watchdog's own runway warning starts at the same
// line, rentFarmCapacity.WARN_DAYS). Above it the limit only means "the rest
// tomorrow" and nothing is said.
const URGENT_DAYS = 10;
// The slots must read short on this many ticks in a row before a stack is made.
const CONFIRM_TICKS = 2;
// A failed add is not tried again sooner than this.
const RETRY_AFTER_FAIL_MS = 6 * HOUR_MS;
const BLOCKED_REMIND_MS = DAY_MS;

const BLOCKED_ACTION = "rent_farm_stack_blocked";
const FAILED_ACTION = "rent_farm_stack_add_failed";
const ADDED_ACTION = "rent_farm_stack_added";

const DEFAULTS = {
  enabled: false,
  targetDays: 14,
  minFree: 40,
  capacity: 50,
  maxPerDay: 3,
  minHostFreeMb: 2000,
  perStackMb: 300,
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
    perStackMb: Math.floor(num(a.rentFarmAutoStackPerStackMb, DEFAULTS.perStackMb, 0, 5000)),
    maxStacks: Math.floor(num(a.rentFarmAutoStackMaxStacks, DEFAULTS.maxStacks, 1, 500)),
    host: String(a.rentFarmAutoStackHost || "").trim(),
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// PURE. What this tick should do.
//   { add: true, why }                            add one stack
//   { add: false, why, enough: true }             there is room: nothing to do
//   { add: false, why }                           not safe to judge this tick
//   { add: false, why, blocked, reason }          a stack IS needed and may not be added
// `blocked` is what gets said to the owner; a state that clears by itself (an
// unread host, unknown memory) is never one.
//   hostKnown  false = the host id is in no host list (null/undefined = not asked)
//   unstarted  stacks on the host that hold no accounts and run no container yet
function decide({ cfg, snap, runway, hostId, hostKnown, hostStacks, unstarted, addedLast24h, hostFreeMb, gate }) {
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
  if (!short) return { add: false, enough: true, why: "enough room (" + room + ")" };

  if (!hostId) {
    return { add: false, why: "the rent-farm holder has no stack yet, so there is no host to add one on" };
  }
  if (String(hostId) === "local") {
    return {
      add: false,
      why: room + ", but the holder's stacks are on the web server itself",
      reason: "local",
      blocked: "the holder's stacks are on the web server itself, where a stack is not added " +
        "automatically. Add one by hand, or set rentFarmAutoStackHost to a bot host.",
    };
  }
  if (hostKnown === false) {
    return {
      add: false,
      why: room + ', but "' + hostId + '" is not a bot host this server knows',
      reason: "unknown-host",
      blocked: 'the bot host "' + hostId + '" is not in this server\'s host list. Check ' +
        "rentFarmAutoStackHost: it must be a host id, not a label.",
    };
  }
  if (Number(hostStacks) >= cfg.maxStacks) {
    return {
      add: false,
      why: room + ", but " + hostId + " already has " + hostStacks + " rental stacks",
      reason: "max-stacks",
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
      reason: "daily-limit",
      blocked: addedLast24h + " stack(s) were already added on " + hostId + " in the last 24 h " +
        "(limit " + cfg.maxPerDay + ", rentFarmAutoStackMaxPerDay). Sales are running ahead of that.",
    };
  }
  if (gate && gate.ok === false) {
    return {
      add: false,
      why: room + ", but " + (gate.reason || "the host's memory gate refuses a new container"),
      reason: "memory",
      blocked: (gate.reason || hostId + " is short of memory") + ". Another bot host is needed.",
    };
  }
  if (cfg.minHostFreeMb > 0) {
    if (hostFreeMb === null || hostFreeMb === undefined || !Number.isFinite(Number(hostFreeMb))) {
      return { add: false, why: room + ", but " + hostId + "'s free memory could not be read this tick" };
    }
    // What the stacks that have not started yet will take once they fill, and
    // the new one with them.
    const waiting = Math.max(0, Math.floor(Number(unstarted) || 0));
    const promised = (waiting + 1) * cfg.perStackMb;
    if (Number(hostFreeMb) - promised < cfg.minHostFreeMb) {
      const sum =
        hostId + " has " + hostFreeMb + " MB of memory free" +
        (promised
          ? ", and " + (waiting ? waiting + " stack(s) not yet started plus " : "") +
            "the new one will need about " + promised + " MB"
          : "");
      return {
        add: false,
        why: room + ", but " + sum,
        reason: "memory",
        blocked: sum + " — that would leave less than the " + cfg.minHostFreeMb +
          " MB that must stay free (rentFarmAutoStackMinHostFreeMb). Another bot host is needed.",
      };
    }
  }
  return { add: true, why: room + " — under " + cfg.targetDays + " day(s) / " + cfg.minFree + " slot(s)" };
}

// ---------------------------------------------------------------------------
// Reads and writes (injectable)
// ---------------------------------------------------------------------------

function newestEventAt(filter) {
  const SystemEvent = require("../models/SystemEvent");
  return SystemEvent.findOne(filter, { at: 1 })
    .sort({ at: -1 })
    .lean()
    .then((row) => (row && row.at ? new Date(row.at).getTime() : 0));
}

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
  // Is this a host id the server can reach at all? No network: a table lookup.
  hostKnown: (hostId) => !!require("./botHosts").resolveHost(hostId),
  // Stacks registered on the host since `since`, whoever made them: the row is
  // the thing that was created, so this cannot miss one the way an event could.
  addedSince: (hostId, since) =>
    require("../models/RenterBotStack").countDocuments({ host: hostId, createdAt: { $gte: new Date(since) } }),
  hostFreeMb: (hostId) => require("./hostCapacity").memAvailableMb(hostId),
  gate: (hostId) => require("./hostCapacity").newContainerAllowed(hostId),
  // The two calls a person made by hand. Returns { host, file, container,
  // capacity } — `capacity` is what the stack really holds: when the second
  // call fails the stack still exists, with the registry's default.
  provision: async (hostId, capacity) => {
    const host = require("./botHosts").resolveHost(hostId);
    if (!host) throw new Error("unknown bot host " + hostId);
    const stacks = require("./renterBotStacks");
    const made = await require("../routes/botConfigRoutes").provisionEmptyConfig(host);
    let capacityError = "";
    try {
      const row = await stacks.setStackCapacity(made.host, made.file, capacity);
      if (!row) capacityError = "its registry row was not found";
    } catch (e) {
      capacityError = String((e && e.message) || e);
    }
    return {
      host: made.host,
      file: made.file,
      container: made.container,
      capacity: capacityError ? stacks.DEFAULT_CAPACITY : capacity,
      capacityError,
    };
  },
  lastBlockedAt: (reason) =>
    newestEventAt({ category: "renter", action: BLOCKED_ACTION, "meta.reason": reason }),
  lastFailedAt: () => newestEventAt({ category: "renter", action: FAILED_ACTION }),
  logEvent: (e) => require("./systemLog").logEvent(e),
  send: (text) => require("./telegram").sendTelegram(text),
};
function dep(name) {
  return Object.prototype.hasOwnProperty.call(deps, name) ? deps[name] : REAL[name];
}

// true = the message reached a chat, or there is no chat to reach (Telegram
// not set up: nothing to retry). false = it did not go; say it again later.
async function deliver(text) {
  try {
    const r = await dep("send")(text);
    if (r && r.configured === false) return true;
    if (r && typeof r.sent === "number") return r.sent > 0;
    return true; // a helper that reports nothing: assume it went
  } catch (e) {
    console.error("rentFarmAutoStack telegram failed:", (e && e.message) || e);
    return false;
  }
}
async function log(event) {
  try {
    await dep("logEvent")(event);
  } catch {
    /* an event is a record, never a reason to fail */
  }
}

// In-process memory. The events behind lastBlockedAt / lastFailedAt are
// best-effort, so a failed write must not make a page or a retry repeat every
// tick; and a restart must not lose them, which is what the events are for.
const blockedSaid = new Map(); // reason -> ms it was last said (and taken)
let failedAt = 0; // ms of this process's last failed add
let shortStreak = 0; // ticks in a row the slots read short

// One pass. `snap` = this tick's rentFarmCapacity.checkOnce result, `runway` =
// its runwayCheck result (or null). Read-only unless a stack is added.
async function checkOnce({ snap = null, runway = null, notify = true } = {}) {
  const cfg = config(dep("autoFarm")());
  if (!cfg.enabled) return { added: false, why: "off" };

  const hostId = cfg.host || (await dep("holderHost")());
  const onHost = ((snap && snap.stacks) || []).filter((s) => String(s.host || "local") === String(hostId));
  const hostStacks = onHost.length;
  const unstarted = onHost.filter((s) => s.running === false && !Number(s.used)).length;
  const now = dep("now")();
  let hostKnown = null;
  if (hostId && String(hostId) !== "local") {
    try {
      hostKnown = !!(await dep("hostKnown")(hostId));
    } catch {
      hostKnown = null;
    }
  }
  const ctx = { cfg, hostId, now, notify };

  // Ask the host for its memory only when a stack is wanted at all: this first
  // pass assumes plenty of it and nothing added yet.
  const first = decide({
    cfg, snap, runway, hostId, hostKnown, hostStacks, unstarted,
    addedLast24h: 0, hostFreeMb: Number.MAX_SAFE_INTEGER, gate: null,
  });
  if (!first.add) {
    // Only a reading that says "there is room" ends a run of short ones; a
    // tick that could not be judged neither counts nor clears it.
    if (first.enough) shortStreak = 0;
    return finish(first, ctx);
  }

  shortStreak++;
  if (shortStreak < CONFIRM_TICKS) {
    return { added: false, why: first.why + " — confirming on the next reading before adding" };
  }

  // A failed add is not tried again at once.
  let lastFail = failedAt;
  try {
    lastFail = Math.max(lastFail, (await dep("lastFailedAt")()) || 0);
  } catch {
    /* unknown: fall back to what this process remembers */
  }
  if (lastFail && now - lastFail < RETRY_AFTER_FAIL_MS) {
    return {
      added: false,
      why: "the last attempt to add a stack failed " + Math.max(1, Math.round((now - lastFail) / 60000)) +
        " min ago — the next try is " + Math.round(RETRY_AFTER_FAIL_MS / HOUR_MS) + " h after it",
    };
  }

  const [addedLast24h, hostFreeMb, gate] = await Promise.all([
    dep("addedSince")(hostId, now - DAY_MS),
    Promise.resolve()
      .then(() => dep("hostFreeMb")(hostId))
      .catch(() => null),
    Promise.resolve()
      .then(() => dep("gate")(hostId))
      .catch(() => null),
  ]);
  const d = decide({ cfg, snap, runway, hostId, hostKnown, hostStacks, unstarted, addedLast24h, hostFreeMb, gate });
  if (!d.add) return finish(d, ctx);

  let made;
  try {
    made = await dep("provision")(hostId, cfg.capacity);
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 300);
    failedAt = now;
    console.error("rentFarmAutoStack: could not add a stack on " + hostId + ": " + msg);
    await log({
      category: "renter",
      action: FAILED_ACTION,
      actor: "rentFarmAutoStack",
      severity: "warn",
      subject: String(hostId),
      detail: msg,
    });
    return finish(
      {
        add: false,
        why: "adding a stack failed: " + msg,
        reason: "add-failed",
        blocked: "adding a stack on " + hostId + " failed: " + msg + " The next try is in " +
          Math.round(RETRY_AFTER_FAIL_MS / HOUR_MS) + " h.",
      },
      ctx,
    );
  }

  const slots = Number(made.capacity) || cfg.capacity;
  const freeBefore = Number(snap.stackFree != null ? snap.stackFree : snap.totalFree) || 0;
  const days = runway && Number.isFinite(runway.slotDays) ? runway.slotDays : null;
  const rate = runway && Number.isFinite(runway.netSlotsPerDay) ? runway.netSlotsPerDay : null;
  const detail =
    made.host + "/" + made.file + " (" + slots + " slots) — free slots were " + freeBefore +
    (days !== null ? ", about " + round1(days) + " day(s)" + (rate ? " at ~" + rate + " a day" : "") : "") +
    "; now " + (freeBefore + slots);
  // The stack exists either way; a capacity that did not take is said with it.
  const capNote = made.capacityError
    ? " ⚠️ Its capacity could not be set to " + cfg.capacity + " (" + String(made.capacityError).slice(0, 120) +
      "): it holds " + slots + " until that is set on the Renters page."
    : "";
  console.log("rentFarmAutoStack: added " + detail + capNote);
  await log({
    category: "renter",
    action: ADDED_ACTION,
    actor: "rentFarmAutoStack",
    severity: made.capacityError ? "warn" : "info",
    subject: made.host + "/" + made.file,
    host: made.host,
    container: made.container || "",
    count: slots,
    detail: (detail + capNote).slice(0, 480),
  });
  if (notify) {
    await deliver(
      "➕ Rent-farm: rental stack " + detail + ". It was added automatically and starts with " +
        "its first order." + capNote + " (Switch: autoFarm.rentFarmAutoStack)",
    );
  }
  return {
    added: true,
    why: d.why,
    host: made.host,
    file: made.file,
    container: made.container,
    capacity: slots,
    ...(made.capacityError ? { capacityError: made.capacityError } : {}),
  };
}

// Not added. A reason the owner has to act on is said once a day per reason —
// and counts as said only once Telegram took it.
async function finish(d, { hostId, now, notify }) {
  const out = { added: false, why: d.why };
  if (!d.blocked) return out;
  out.blocked = d.blocked;
  const reason = d.reason || "other";
  out.reason = reason;
  if (!notify) return out;
  const here = blockedSaid.get(reason) || 0;
  if (here && now - here < BLOCKED_REMIND_MS) return out;
  let last = 0;
  try {
    last = (await dep("lastBlockedAt")(reason)) || 0;
  } catch {
    last = 0;
  }
  if (last && now - last < BLOCKED_REMIND_MS) {
    blockedSaid.set(reason, last);
    return out;
  }
  console.error("rentFarmAutoStack: a stack is needed but was not added — " + d.blocked);
  const taken = await deliver(
    "⚠️ Rent-farm needs another rental stack and none was added: " + d.blocked +
      "\n\n(" + d.why + ". The automatic add keeps checking every 30 minutes; this " +
      "reminder repeats once a day while it lasts.)",
  );
  if (!taken) return out; // not said: the next tick says it
  blockedSaid.set(reason, now);
  out.paged = true;
  await log({
    category: "renter",
    action: BLOCKED_ACTION,
    actor: "rentFarmAutoStack",
    severity: "warn",
    subject: String(hostId || ""),
    detail: (d.why + " | " + d.blocked).slice(0, 480),
    meta: { reason },
  });
  return out;
}

module.exports = {
  checkOnce,
  decide,
  config,
  DEFAULTS,
  URGENT_DAYS,
  CONFIRM_TICKS,
  RETRY_AFTER_FAIL_MS,
  // testing seams
  __setDeps: (d) => {
    deps = { ...deps, ...(d || {}) };
  },
  __real: REAL,
  _reset: () => {
    deps = {};
    blockedSaid.clear();
    failedAt = 0;
    shortStreak = 0;
  },
};
