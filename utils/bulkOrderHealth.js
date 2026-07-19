// Health check + auto-replace for bulk orders.
//
// A bulk order's units are farmed accounts (BotAccount) that each hold a whole
// drop bundle. This module verifies every active unit against Twitch using the
// same probe the drop-archive scanner and account pool use
// (utils/twitchInventory.fetchInventory), then swaps any unit it can't verify
// as good for a fresh one claimed from the sellable pool — so the buyer always
// ends up with N accounts we could just confirm hold the goods.
//
// The account claim reuses the Shop's atomic `soldAt:null` guard
// (routes/shopRoutes.availableAccountsForSet), so a replacement can never be an
// account another sale already handed out.
const BotAccount = require("../models/BotAccount");
const { availableAccountsForSet } = require("../routes/shopRoutes");
const { fetchInventory } = require("./twitchInventory");

// Statuses that mean "we could not verify this unit holds a usable bundle" and
// so are eligible for auto-replacement. `error` (e.g. no token stored) and
// `unchecked` (a transient scan-host failure) are deliberately NOT swapped —
// they aren't a Twitch verdict that the account is dead.
const REPLACEABLE = new Set(["token_dead", "integrity_failed", "missing_drops"]);
// Statuses that count against health in the summary (everything but alive and
// the not-yet-known `unchecked`).
const BAD_FOR_SUMMARY = new Set([
  "token_dead",
  "integrity_failed",
  "missing_drops",
  "error",
]);

// A minimal set-shaped object good enough for availableAccountsForSet (it only
// reads items[].itemKey and items[].qty). Rebuilt from the order's snapshot so
// replacements still work even if the underlying DropSet was later deleted.
function setLikeOf(order) {
  return {
    items: (order.items || [])
      .filter((i) => i.itemKey)
      .map((i) => ({ itemKey: i.itemKey, qty: Math.max(1, Number(i.qty) || 1) })),
  };
}

function promisedKeysOf(order) {
  return [
    ...new Set((order.items || []).map((i) => i.itemKey).filter(Boolean)),
  ];
}

// Build a fresh unit from an availableAccountsForSet candidate (items are shaped
// {k,count}) plus the BotAccount we just claimed.
function unitFromCandidate(candidate, account) {
  return {
    account: account._id,
    accountLogin: account.login || account.credUsername || candidate.login || "",
    itemCounts: (candidate.items || []).map((it) => ({
      itemKey: it.k,
      count: it.count || 0,
    })),
    health: { status: "unchecked", dropCount: 0, checkedAt: null, error: "" },
    active: true,
    replacedByLogin: "",
    replacedFromLogin: "",
    replacedAt: null,
    revealedAt: null,
  };
}

// Probe one account. Returns a health sub-document; never throws.
// A promised drop that the buyer already CONNECTED still shows in the inventory
// (connected:true), so it counts as present here — only a drop that has
// vanished entirely trips `missing_drops`. That keeps a buyer's own redemptions
// from looking like a defective account.
async function checkAccountHealth(account, promisedKeys) {
  const now = new Date();
  if (!account) {
    return { status: "error", dropCount: 0, checkedAt: now, error: "account not found" };
  }
  if (!account.clientSecret) {
    return { status: "error", dropCount: 0, checkedAt: now, error: "no auth token stored" };
  }
  try {
    const { drops } = await fetchInventory(account.clientSecret);
    const present = new Set();
    for (const d of drops || []) {
      if (d && d.itemKey) present.add(d.itemKey);
    }
    const missing = promisedKeys.filter((k) => !present.has(k));
    if (promisedKeys.length && missing.length) {
      return {
        status: "missing_drops",
        dropCount: (drops || []).length,
        checkedAt: now,
        error: "missing: " + missing.slice(0, 3).join(", "),
      };
    }
    return { status: "alive", dropCount: (drops || []).length, checkedAt: now, error: "" };
  } catch (e) {
    // A scan host went down mid-check — not a Twitch verdict. Leave the unit
    // as-is (unchecked) so it's re-probed later rather than falsely condemned.
    if (e.transportFailed) {
      return { status: "unchecked", dropCount: 0, checkedAt: now, error: "scan host unreachable" };
    }
    if (e.code === "token_invalid") {
      return { status: "token_dead", dropCount: 0, checkedAt: now, error: (e.message || "").slice(0, 200) };
    }
    if (e.code === "integrity_failed") {
      return { status: "integrity_failed", dropCount: 0, checkedAt: now, error: (e.message || "").slice(0, 200) };
    }
    return { status: "error", dropCount: 0, checkedAt: now, error: (e.message || String(e)).slice(0, 200) };
  }
}

// Recompute the denormalised summary over ACTIVE units only.
function recomputeSummary(order) {
  const active = (order.units || []).filter((u) => u.active);
  let alive = 0;
  let bad = 0;
  let unchecked = 0;
  for (const u of active) {
    const s = (u.health && u.health.status) || "unchecked";
    if (s === "alive") alive++;
    else if (BAD_FOR_SUMMARY.has(s)) bad++;
    else unchecked++;
  }
  order.healthSummary = {
    total: active.length,
    alive,
    bad,
    unchecked,
    lastCheckedAt: new Date(),
  };
}

// Small concurrency limiter so a 50-unit order fans out a few Twitch calls at a
// time instead of all at once (matches the gentle one-host-at-a-time ethos of
// the archive scanner).
async function mapLimit(items, limit, fn) {
  let i = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

// Atomically claim one BotAccount for a bulk order (same guard the Shop uses).
async function claimAccount(candidate, order) {
  return BotAccount.findOneAndUpdate(
    { _id: candidate.accountId, soldAt: null },
    {
      $set: {
        soldAt: new Date(),
        soldToUsername: "bulk:" + order.orderNo,
        soldSetId: order.setId || "",
        soldBulkOrderId: order.orderNo,
      },
    },
    { new: true },
  );
}

// Reserve up to `qty` accounts for a set and return built units. Used by the
// create/topup routes. `excludeIds` are account ids already on the order.
// Runs ONE availableAccountsForSet aggregation and consumes from its candidate
// list, claiming each atomically. Returns { units, claimed, available }.
async function reserveUnits({ order, setLike, qty, excludeIds = new Set() }) {
  const candidates = await availableAccountsForSet(setLike);
  const units = [];
  let available = 0;
  for (const c of candidates) {
    if (excludeIds.has(String(c.accountId))) continue;
    available++;
  }
  for (const c of candidates) {
    if (units.length >= qty) break;
    if (excludeIds.has(String(c.accountId))) continue;
    const account = await claimAccount(c, order);
    if (!account) continue; // lost the race to another buyer — skip
    excludeIds.add(String(c.accountId));
    units.push(unitFromCandidate(c, account));
  }
  return { units, claimed: units.length, available };
}

// Verify every active unit and (optionally) auto-replace the ones we couldn't
// confirm. Mutates `order` in place; the caller saves. Returns a report.
async function runHealthCheck(order, { autoReplace = true, concurrency = 4 } = {}) {
  const promisedKeys = promisedKeysOf(order);

  // --- Phase A: probe all currently-active units. ---
  const activeUnits = (order.units || []).filter((u) => u.active);
  const ids = activeUnits.map((u) => u.account);
  const accs = await BotAccount.find({ _id: { $in: ids } }).lean();
  const accById = new Map(accs.map((a) => [String(a._id), a]));
  await mapLimit(activeUnits, concurrency, async (unit) => {
    const acc = accById.get(String(unit.account));
    unit.health = await checkAccountHealth(acc, promisedKeys);
  });

  const report = { checked: activeUnits.length, replaced: 0, unreplaced: 0, burned: 0 };

  // --- Phase B: swap out units we couldn't verify, from fresh pool stock. ---
  if (autoReplace) {
    const badUnits = activeUnits.filter(
      (u) => u.active && REPLACEABLE.has(u.health.status),
    );
    if (badUnits.length) {
      const setLike = setLikeOf(order);
      const inOrder = new Set(
        (order.units || []).map((u) => String(u.account)),
      );
      const candidates = await availableAccountsForSet(setLike);
      let ci = 0;

      // Pull the next pool account that actually verifies healthy. Any claimed
      // candidate that turns out bad is kept out of the pool and recorded as an
      // inactive "burned" unit for audit (never re-offered, never orphaned).
      const nextAlive = async () => {
        while (ci < candidates.length) {
          const c = candidates[ci++];
          if (inOrder.has(String(c.accountId))) continue;
          const account = await claimAccount(c, order);
          if (!account) continue;
          inOrder.add(String(c.accountId));
          const unit = unitFromCandidate(c, account);
          unit.health = await checkAccountHealth(account, promisedKeys);
          if (unit.health.status === "alive") return unit;
          // Claimed but not usable: keep it reserved (out of the sellable pool)
          // and file it as a burned unit rather than handing it to the buyer.
          unit.active = false;
          order.units.push(unit);
          report.burned++;
        }
        return null;
      };

      for (const bad of badUnits) {
        const repl = await nextAlive();
        if (!repl) {
          report.unreplaced++;
          continue;
        }
        repl.replacedFromLogin = bad.accountLogin;
        bad.active = false;
        bad.replacedByLogin = repl.accountLogin;
        bad.replacedAt = new Date();
        order.units.push(repl);
        report.replaced++;
      }
    }
  }

  recomputeSummary(order);
  return report;
}

module.exports = {
  runHealthCheck,
  reserveUnits,
  checkAccountHealth,
  unitFromCandidate,
  setLikeOf,
  promisedKeysOf,
  recomputeSummary,
  claimAccount,
  REPLACEABLE,
  BAD_FOR_SUMMARY,
};
