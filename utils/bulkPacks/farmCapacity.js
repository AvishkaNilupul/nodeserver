// Bulk packs — how much rent-farm ("farm" source) a bulk offer may advertise
// (docs/bulk-packs/CONTRACT.md §1, MODULES.md "farmCapacity.js").
//
// A farm bulk offer is fulfilled at sale by the existing farm services, which
// put pristine pool accounts into rental bot stacks. So what it may advertise
// is bounded by the same walls those services hit: free slots on a LIVE stack
// (one order lands in one stack), total usable slots (already capped by the
// holder renter's account limit), and pristine pool accounts.
//
// READ-ONLY. Slots come from utils/rentFarmCapacity.snapshot(), pool supply
// from utils/operatorFarm.previewFreshAccounts(). The operatorFarm provisioning
// call is never made from here, nor is anything that writes a bot config.
//
// Dependencies are lazy and injectable (CONTRACT §9) so tests never read a host.

// A good reading is reused for 10 minutes (MODULES.md); a FAILED one only for a
// minute — long enough not to hammer a blinking Pi link, short enough that a
// transient read failure does not hold every farm offer at 0 for 10 minutes.
const CACHE_MS = 10 * 60 * 1000;
const ERROR_CACHE_MS = 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;
// demand(): rows read (newest first) and groups returned, at most.
const DEMAND_ROW_CAP = 3000;
const DEMAND_GROUP_CAP = 200;

const REAL = {
  rentFarmCapacity: () => require("../rentFarmCapacity"),
  operatorFarm: () => require("../operatorFarm"),
  FarmServiceOrder: () => require("../../models/FarmServiceOrder"),
  suppliedStock: () => require("../suppliedStock"),
  now: () => Date.now,
};

// Test overrides; anything not overridden resolves to the real module lazily.
let deps = {};
let cache = null; // { atMs, ttl, value }
let inflight = null;
// Bumped by __resetDeps so a read started before a reset can neither write the
// cache nor clear a newer in-flight read.
let generation = 0;

function dep(name) {
  if (Object.prototype.hasOwnProperty.call(deps, name)) return deps[name];
  return REAL[name]();
}

function __setDeps(partial) {
  for (const key of Object.keys(partial || {})) {
    if (!Object.prototype.hasOwnProperty.call(REAL, key)) {
      throw new Error("bulkPacks/farmCapacity: unknown dependency '" + key + "'");
    }
  }
  deps = { ...deps, ...(partial || {}) };
}

// Also forgets the cached reading, so every test starts cold.
function __resetDeps() {
  deps = {};
  cache = null;
  inflight = null;
  generation += 1;
}

function nowMs() {
  return Number(dep("now")());
}

function count(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function errText(e) {
  return String((e && e.message) || e || "capacity read failed").slice(0, 300);
}

// bestStackRoom / totalFree out of a rentFarmCapacity.snapshot().
// Live stacks use the snapshot's own rule (utils/rentFarmCapacity.js:85): a
// stopped stack that already holds accounts is dead capacity, a stopped EMPTY
// one is merely un-started and counts. Offline hosts never appear in `stacks`.
// bestStackRoom is also capped by totalFree: when the holder's account limit
// binds, no single stack can take more than the holder may still hold.
function slotsFromSnapshot(snap) {
  if (!snap || typeof snap !== "object") {
    throw new Error("rent-farm capacity snapshot was empty");
  }
  const stacks = Array.isArray(snap.stacks) ? snap.stacks : [];
  const live = stacks.filter((s) => s && (s.running !== false || !s.used));
  const totalFree = count(snap.totalFree);
  let best = 0;
  for (const s of live) best = Math.max(best, count(s.remaining));
  return { bestStackRoom: Math.min(best, totalFree), totalFree };
}

async function readNow(atMs) {
  const gen = generation;
  const remember = (entry) => {
    if (gen === generation) cache = entry;
  };
  let value;
  try {
    const snap = await dep("rentFarmCapacity").snapshot();
    const slots = slotsFromSnapshot(snap);
    // Sequential on purpose: both reads go over the host links, and a second
    // simultaneous SSH round trip to the Pi buys nothing here.
    const preview = await dep("operatorFarm").previewFreshAccounts({ count: 1 });
    value = {
      bestStackRoom: slots.bestStackRoom,
      totalFree: slots.totalFree,
      pristine: count(preview && preview.eligibleTotal),
      at: new Date(atMs),
      error: "",
    };
    remember({ atMs, ttl: CACHE_MS, value });
  } catch (e) {
    value = {
      bestStackRoom: 0,
      totalFree: 0,
      pristine: 0,
      at: new Date(atMs),
      error: errText(e),
    };
    remember({ atMs, ttl: ERROR_CACHE_MS, value });
  }
  return value;
}

function copy(value) {
  return { ...value, at: value.at instanceof Date ? new Date(value.at) : value.at };
}

// {bestStackRoom, totalFree, pristine, at, error}. Cached (see CACHE_MS);
// `force` bypasses the cache. Concurrent callers share one read. NEVER throws:
// a failed read returns zeros plus the error text.
async function read(opts) {
  const force = !!(opts && opts.force);
  let at;
  try {
    at = nowMs();
    if (!Number.isFinite(at)) at = Date.now();
  } catch {
    at = Date.now();
  }
  if (!force && cache && at >= cache.atMs && at - cache.atMs < cache.ttl) {
    return copy(cache.value);
  }
  if (!inflight) {
    const p = readNow(at).finally(() => {
      if (inflight === p) inflight = null;
    });
    inflight = p;
  }
  try {
    return copy(await inflight);
  } catch (e) {
    // readNow catches everything; this is belt and braces for "never throws".
    return { bestStackRoom: 0, totalFree: 0, pristine: 0, at: new Date(at), error: errText(e) };
  }
}

// How many accounts a farm bulk offer may advertise right now (an integer
// >= 0). Anything unreadable or malformed reads 0 — never "plenty".
function advertisable(cap, bp) {
  if (!cap || cap.error) return 0;
  const b = bp || {};
  const v = Math.min(
    Number(b.farmMaxQty),
    Number(cap.bestStackRoom),
    Number(cap.totalFree) - Number(b.farmReserveSlots),
    Number(cap.pristine) - Number(b.farmReservePristine),
  );
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.floor(v));
}

function idOf(v) {
  if (v == null) return "";
  if (typeof v === "object" && typeof v.toHexString === "function") return v.toHexString();
  if (typeof v === "object" && v._id != null) return idOf(v._id);
  return String(v).trim();
}

// One open farm offer's share of `available` (docs/bulk-packs/FIXES-1.md S1).
// The capacity is ONE pool — every open farm offer is filled from the same
// stacks and the same pristine accounts — so each advertises its share, never
// the whole of it (three offers each advertising all 20 is 60 on sale).
//
// The split is utils/suppliedStock.js shareOfShelf, the codebase's one rule for
// dividing a shelf between the offers that sell it: floor(available / n) each,
// the remainder one apiece to the lowest-sorting ids, so the shares sum to
// EXACTLY `available` and an offer keeps its rank between passes. `selfId` is
// counted as a sharer whether or not `ids` lists it; ids are deduplicated
// (shareOfShelf counts a repeat twice); a missing selfId takes the last share.
// Returns an integer >= 0; an unreadable `available` is 0.
function shareFor(selfId, ids, available) {
  const total = Math.floor(Number(available));
  if (!Number.isFinite(total) || total <= 0) return 0;
  const list = ids instanceof Set ? [...ids] : Array.isArray(ids) ? ids : [];
  const unique = [...new Set(list.map(idOf).filter(Boolean))];
  const share = Math.floor(Number(dep("suppliedStock").shareOfShelf(total, idOf(selfId), unique)));
  return Number.isFinite(share) && share > 0 ? Math.min(share, total) : 0;
}

// Rent-farm demand: FarmServiceOrder rows created in the last `days` days
// (default 60, 1..365), excluding cancelled ones, grouped by (game, days),
// most orders first. accounts = accounts handed over (accounts.length), or the
// ordered quantity for an order that has none recorded yet. markets = orders
// per marketplace (a row older than the `market` field counts as eldorado,
// the only service that relied on the schema default). A DB error propagates.
async function demand(opts) {
  const rawDays = opts && opts.days != null ? Math.floor(Number(opts.days)) : 60;
  const windowDays = Number.isFinite(rawDays) ? Math.min(Math.max(rawDays, 1), 365) : 60;
  const since = new Date(nowMs() - windowDays * DAY_MS);
  const rows = await dep("FarmServiceOrder")
    .find(
      { createdAt: { $gte: since }, state: { $ne: "cancelled" } },
      { game: 1, days: 1, market: 1, quantity: 1, "accounts.login": 1 },
    )
    .sort({ _id: -1 })
    .limit(DEMAND_ROW_CAP)
    .lean();
  const groups = new Map();
  for (const r of rows || []) {
    const game = String((r && r.game) || "").trim();
    const days = Math.floor(Number(r && r.days));
    if (!game || !(days > 0)) continue;
    const key = game.toLowerCase() + "|" + days;
    let g = groups.get(key);
    if (!g) {
      g = { game, days, orders: 0, accounts: 0, markets: {} };
      groups.set(key, g);
    }
    g.orders += 1;
    const handed = Array.isArray(r.accounts) ? r.accounts.length : 0;
    g.accounts += handed > 0 ? handed : r.quantity == null ? 1 : count(r.quantity);
    const market = String(r.market || "").trim().toLowerCase() || "eldorado";
    g.markets[market] = (g.markets[market] || 0) + 1;
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        b.orders - a.orders ||
        b.accounts - a.accounts ||
        a.game.localeCompare(b.game) ||
        a.days - b.days,
    )
    .slice(0, DEMAND_GROUP_CAP);
}

module.exports = {
  CACHE_MS,
  ERROR_CACHE_MS,
  read,
  advertisable,
  shareFor,
  demand,
  __setDeps,
  __resetDeps,
};
