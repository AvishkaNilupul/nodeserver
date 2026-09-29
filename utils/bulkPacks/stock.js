// Bulk packs — account stock for the "dropset" and "noclaim" sources
// (docs/bulk-packs/CONTRACT.md §1 + §4 I1/I2, MODULES.md "stock.js").
//
// Nothing here is a new reservation path. Every write goes through the ONE
// existing implementation, because a second copy drifts and a drifted copy
// double-sells an account:
//   reserve -> eldoradoFulfiller.claimAccountsForSet (listed-login filter,
//              per-set DropLog reservation, drops unreadable passwords)
//   release -> dropReservation.releaseSetForAccounts, scoped to ONE set and ONE
//              market tag, and only after isStillOurs() has re-read the drops.
// Reads wrap routes/shopRoutes.availableAccountsForSet + utils/listedLogins
// (dropset) and utils/noclaimStock (noclaim, the shared claim-at-sale shelf).
//
// Dependencies are lazy and injectable (CONTRACT §9): tests swap them with
// __setDeps() and never touch a marketplace, a host or utils/settings.json.

// The markets a bulk dropset reservation may be tagged with (CONTRACT §1). The
// tag is written into DropLog.soldToUsername, so it must be one of
// utils/marketClaimTags or the archive reads a listed drop as really sold.
// Blocked markets (plati/digiseller/ggsel) are deliberately absent.
const RESERVE_MARKETS = ["eldorado", "g2g", "gameflip"];
// Claim-at-sale markets a no-claim bulk offer can live on (CONTRACT §1).
const NOCLAIM_MARKETS = ["eldorado", "g2g"];
// Ceiling on one reserve() call. A short claim is recoverable; accounts taken
// by mistake are not (same reasoning as noclaimStock.MAX_CLAIM).
const MAX_RESERVE = 100;
// Ceiling on dropsetFreeCounts: each set costs a DropLog aggregation.
const MAX_COUNT_SETS = 200;
// unitHealth reads BotAccount in batches of this many ids.
const HEALTH_BATCH = 500;

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

const REAL = {
  shopRoutes: () => require("../../routes/shopRoutes"),
  listedLogins: () => require("../listedLogins"),
  eldoradoFulfiller: () => require("../eldoradoFulfiller"),
  dropReservation: () => require("../dropReservation"),
  noclaimStock: () => require("../noclaimStock"),
  secretBox: () => require("../secretBox"),
  DropLog: () => require("../../models/DropLog"),
  DropSet: () => require("../../models/DropSet"),
  BotAccount: () => require("../../models/BotAccount"),
  RenterAccount: () => require("../../models/RenterAccount"),
  telegram: () => require("../telegram"),
  systemLog: () => require("../systemLog"),
};

// Test overrides; anything not overridden resolves to the real module lazily.
let deps = {};

function dep(name) {
  if (Object.prototype.hasOwnProperty.call(deps, name)) return deps[name];
  return REAL[name]();
}

function __setDeps(partial) {
  for (const key of Object.keys(partial || {})) {
    if (!Object.prototype.hasOwnProperty.call(REAL, key)) {
      throw new Error("bulkPacks/stock: unknown dependency '" + key + "'");
    }
  }
  deps = { ...deps, ...(partial || {}) };
}

function __resetDeps() {
  deps = {};
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function normMarket(market) {
  return String(market == null ? "" : market)
    .trim()
    .toLowerCase();
}

function idString(v) {
  if (v == null) return "";
  if (typeof v === "object" && typeof v.toHexString === "function") {
    return v.toHexString();
  }
  if (typeof v === "object" && v._id != null) return idString(v._id);
  return String(v).trim();
}

function uniqueIds(accountIds) {
  const list = Array.isArray(accountIds)
    ? accountIds
    : accountIds == null
      ? []
      : [accountIds];
  return [...new Set(list.map(idString).filter(Boolean))];
}

function toCount(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// A custom set (promo cover) and a no-claim set are never dropset stock
// (CONTRACT §1: dropset = stockSource !== "noclaim" && custom !== true).
function isDropsetSet(set) {
  return !!set && set.stockSource !== "noclaim" && set.custom !== true;
}

// Only the fields callers may see: never a password.
function shapeUnits(list) {
  return (list || [])
    .filter(Boolean)
    .map((c) => ({ accountId: idString(c.accountId), login: String(c.login || "") }));
}

// Accept a DropSet (lean or doc) or just its id. A set without `items` in hand
// is re-read, because isStillOurs needs the set's itemKeys.
async function resolveSet(set) {
  if (!set) return null;
  if (
    typeof set === "object" &&
    typeof set.toHexString !== "function" &&
    set._id != null &&
    Array.isArray(set.items)
  ) {
    return set;
  }
  const id = idString(set);
  if (!OBJECT_ID_RE.test(id)) return null;
  return dep("DropSet")
    .findById(id, { items: 1, stockSource: 1, custom: 1, name: 1 })
    .lean();
}

// ---------------------------------------------------------------------------
// dropset reads
// ---------------------------------------------------------------------------

// Accounts that could go on a new dropset offer right now: hold the whole
// bundle, sellable, and not attached to ANY active listing. Leanest first (the
// order availableAccountsForSet sorts in is kept).
async function freeDropsetAccounts(set) {
  if (!isDropsetSet(set)) return [];
  const { availableAccountsForSet } = dep("shopRoutes");
  const { loginsOnActiveListings, notListed } = dep("listedLogins");
  const candidates = await availableAccountsForSet(set);
  const listed = await loginsOnActiveListings();
  return shapeUnits(notListed(candidates, listed));
}

// Free counts for many sets, one set at a time (bounded: at most `limit`
// sets). The listed-login snapshot is read ONCE per call instead of once per
// set — it is the same whole-collection read every time, and these counts are
// proposals only (send re-checks with freeDropsetAccounts + a real claim).
// Returns Map<String(setId), number>. A DB error propagates.
async function dropsetFreeCounts(sets, opts) {
  const out = new Map();
  const raw = opts && opts.limit != null ? Math.floor(Number(opts.limit)) : 60;
  const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), MAX_COUNT_SETS) : 60;
  const seen = new Set();
  const list = [];
  for (const s of Array.isArray(sets) ? sets : []) {
    if (!s || s._id == null) continue;
    const id = idString(s._id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    list.push(s);
  }
  const todo = list.slice(0, limit);
  if (!todo.length) return out;
  const { availableAccountsForSet } = dep("shopRoutes");
  const { loginsOnActiveListings, notListed } = dep("listedLogins");
  const listed = await loginsOnActiveListings();
  for (const set of todo) {
    const id = idString(set._id);
    if (!isDropsetSet(set)) {
      out.set(id, 0);
      continue;
    }
    const candidates = await availableAccountsForSet(set);
    out.set(id, notListed(candidates, listed).length);
  }
  return out;
}

// ---------------------------------------------------------------------------
// noclaim reads
// ---------------------------------------------------------------------------

// The shared no-claim shelf for one set: `free` accounts in the farm, and the
// share a NEW claim-at-sale offer would be allowed to advertise on each market
// (a row with no _id takes the last share — utils/suppliedStock.shareOfShelf).
// Errors propagate: a failed read must never look like an empty shelf.
async function noclaimCounts(set) {
  const ncs = dep("noclaimStock");
  const stock = await ncs.stockForSet(set);
  const share = {};
  for (const market of NOCLAIM_MARKETS) {
    share[market] = toCount(
      await ncs.stockForListing({
        noclaimStock: true,
        marketplace: market,
        set: set ? set._id : undefined,
      }),
    );
  }
  return { free: toCount(stock && stock.free), share };
}

// ---------------------------------------------------------------------------
// reservation (CONTRACT I1)
// ---------------------------------------------------------------------------

// Reserve up to `n` accounts for `set` under the market's claim tag. Returns
// [{accountId, login}] (passwords stripped), possibly FEWER than asked — the
// caller must refuse, and release, when short.
//
// n < 1 returns [] without claiming: claimAccountsForSet coerces 0 to 1.
async function reserve(opts) {
  const set = opts && opts.set;
  const market = normMarket(opts && opts.market);
  if (!RESERVE_MARKETS.includes(market)) {
    throw new Error(
      "bulkPacks/stock.reserve: market must be one of " + RESERVE_MARKETS.join(", "),
    );
  }
  if (!set || set._id == null) {
    throw new Error("bulkPacks/stock.reserve: a DropSet is required");
  }
  if (!isDropsetSet(set)) return [];
  const want = Math.min(MAX_RESERVE, Math.floor(Number(opts && opts.n)));
  if (!(want >= 1)) return [];
  const startedAt = new Date();
  let got;
  try {
    got = await dep("eldoradoFulfiller").claimAccountsForSet(set, want, {
      claimTag: market,
    });
  } catch (e) {
    // claimAccountsForSet reserves one account at a time and only answers the
    // list at the end, so a throw part-way leaves reservations nobody holds.
    // That is the SAFE direction (nothing can be sold twice), but they would be
    // stranded silently: say exactly where to look, then fail the send.
    const where =
      "set " + String(set._id) + " (" + String(set.name || "") + "), tag " +
      market + ", reserved at or after " + startedAt.toISOString();
    try {
      const p = dep("telegram").sendTelegram(
        "⚠️ Bulk packs: reserving accounts failed part-way — some DropLog " +
          "reservations may be held by no listing.\n\n" + where +
          "\n\nError: " + errText(e),
      );
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      /* alerts never break the caller */
    }
    try {
      const p = dep("systemLog").logEvent({
        category: "bulk",
        action: "reserve_failed_partway",
        severity: "error",
        detail: where + " — " + errText(e),
        meta: { set: String(set._id), market, startedAt },
      });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      /* logging never breaks the caller */
    }
    throw e;
  }
  return shapeUnits(got);
}

// True iff this account's drops for `set` are still held by OUR reservation:
// at least one row matches, and EVERY matching row carries soldAt != null,
// soldToUsername === market and soldSetId === String(set._id).
//
// "Matching" is exactly the selection dropReservation.reserveSetOnAccount
// stamps (utils/dropReservation.js:46): this account, itemKey in
// setKeys(set), not connected — minus its `soldAt: null` clause, which is the
// very thing the reservation flips. A connected (redeemed) row is never
// stamped by a reservation, so it is not evidence either way; an account whose
// set rows are ALL connected has nothing left to release and reads false.
//
// Anything else — a row reserved by another owner, set or tag, or a brand-new
// unreserved copy of one of the items — reads false. A false costs a leaked
// reservation (fixable by hand); a wrong true frees somebody else's drops.
async function isStillOurs(opts) {
  const accountId = idString(opts && opts.accountId);
  const market = normMarket(opts && opts.market);
  if (!OBJECT_ID_RE.test(accountId)) return false;
  if (!RESERVE_MARKETS.includes(market)) return false;
  const set = await resolveSet(opts && opts.set);
  if (!set || set.stockSource === "noclaim") return false;
  const keys = dep("dropReservation").setKeys(set);
  if (!keys.length) return false;
  const DropLog = dep("DropLog");
  const setId = idString(set._id);
  const rows = { account: accountId, itemKey: { $in: keys }, connected: { $ne: true } };
  const total = await DropLog.countDocuments(rows);
  if (!total) return false;
  const foreign = await DropLog.countDocuments({
    ...rows,
    $or: [
      { soldAt: null },
      { soldToUsername: { $ne: market } },
      { soldSetId: { $ne: setId } },
    ],
  });
  return foreign === 0;
}

// Release our reservation of `set` on each account, one at a time, and only
// where isStillOurs() holds. Returns:
//   released — ids whose reservation was released
//   skipped  — [{accountId, reason}] not released and NOT to be retried
//              ("not ours", "unsupported market", "set missing", or a release
//              that threw part-way: it may have taken, and a retry could free
//              a reservation somebody else made since)
//   failed   — [{accountId, reason}] ownership could not be read (DB error);
//              nothing was written, so a later pass may safely retry them.
async function releaseUnits(opts) {
  const ids = uniqueIds(opts && opts.accountIds);
  const market = normMarket(opts && opts.market);
  const released = [];
  const skipped = [];
  const failed = [];
  if (!ids.length) return { released, skipped, failed };
  if (!RESERVE_MARKETS.includes(market)) {
    for (const id of ids) skipped.push({ accountId: id, reason: "unsupported market" });
    return { released, skipped, failed };
  }
  let set;
  try {
    set = await resolveSet(opts && opts.set);
  } catch (e) {
    for (const id of ids) failed.push({ accountId: id, reason: errText(e) });
    return { released, skipped, failed };
  }
  if (!set) {
    for (const id of ids) skipped.push({ accountId: id, reason: "set missing" });
    return { released, skipped, failed };
  }
  const setId = idString(set._id);
  const { releaseSetForAccounts } = dep("dropReservation");
  for (const id of ids) {
    let ours;
    try {
      ours = await isStillOurs({ accountId: id, set, market });
    } catch (e) {
      failed.push({ accountId: id, reason: errText(e) });
      continue;
    }
    if (!ours) {
      skipped.push({ accountId: id, reason: "not ours" });
      continue;
    }
    try {
      await releaseSetForAccounts([id], setId, market);
      released.push(id);
    } catch (e) {
      skipped.push({ accountId: id, reason: "release error: " + errText(e) });
    }
  }
  return { released, skipped, failed };
}

function errText(e) {
  return String((e && e.message) || e || "error").slice(0, 300);
}

// ---------------------------------------------------------------------------
// unit health
// ---------------------------------------------------------------------------

// Per account: {ok:true, reason:""} or {ok:false, reason} with reason
//   "account missing" — no BotAccount with that id
//   "suspended"       — lastScanStatus === "suspended", the one test
//                       utils/suspendedAccounts.js applies to a BotAccount
//                       (suspendedLoginSet :66 and retireFromLiveListings
//                       :404 at 70b4202; not exported as a predicate, so
//                       replicated here). token_invalid is NOT it: that
//                       account is re-authable and keeps its drops.
//   "no password"     — no stored password, or one that does not decrypt
//                       (the same readability test claimAccountsForSet uses)
// Returns Map<String(accountId), {ok, reason}>. A DB error propagates: an
// unreadable account must never read as a bad one (that would retire it).
async function unitHealth(accountIds) {
  const ids = uniqueIds(accountIds);
  const out = new Map();
  if (!ids.length) return out;
  const valid = ids.filter((id) => OBJECT_ID_RE.test(id));
  const BotAccount = dep("BotAccount");
  const byId = new Map();
  for (let i = 0; i < valid.length; i += HEALTH_BATCH) {
    const chunk = valid.slice(i, i + HEALTH_BATCH);
    const docs = await BotAccount.find(
      { _id: { $in: chunk } },
      { login: 1, credPassword: 1, lastScanStatus: 1, clientSecret: 1 },
    ).lean();
    for (const d of docs || []) byId.set(idString(d._id), d);
  }
  // Rented out (a RenterAccount holds the same token or login): the account
  // farms for a renter now, so it must leave the pack — with its reservation
  // KEPT (keepReserved), never handed back to other sellers mid-lease.
  const rented = new Set();
  const secrets = [];
  const logins = [];
  for (const acc of byId.values()) {
    if (acc.clientSecret) secrets.push(String(acc.clientSecret));
    if (acc.login) {
      logins.push(String(acc.login));
      logins.push(String(acc.login).toLowerCase());
    }
  }
  if (secrets.length || logins.length) {
    const hits = await dep("RenterAccount")
      .find(
        {
          $or: [
            ...(secrets.length ? [{ clientSecret: { $in: secrets } }] : []),
            ...(logins.length ? [{ login: { $in: [...new Set(logins)] } }] : []),
          ],
        },
        { clientSecret: 1, login: 1 },
      )
      .lean();
    for (const h of hits || []) {
      if (h.clientSecret) rented.add("s:" + String(h.clientSecret));
      if (h.login) rented.add("l:" + String(h.login).toLowerCase());
    }
  }
  const { decrypt } = dep("secretBox");
  for (const id of ids) {
    const acc = byId.get(id);
    if (!acc) {
      out.set(id, { ok: false, reason: "account missing" });
    } else if (acc.lastScanStatus === "suspended") {
      out.set(id, { ok: false, reason: "suspended" });
    } else if (
      (acc.clientSecret && rented.has("s:" + String(acc.clientSecret))) ||
      (acc.login && rented.has("l:" + String(acc.login).toLowerCase()))
    ) {
      out.set(id, { ok: false, reason: "rented out", keepReserved: true });
    } else if (!acc.credPassword || !decrypt(acc.credPassword)) {
      out.set(id, { ok: false, reason: "no password" });
    } else {
      out.set(id, { ok: true, reason: "" });
    }
  }
  return out;
}

module.exports = {
  RESERVE_MARKETS,
  NOCLAIM_MARKETS,
  MAX_RESERVE,
  freeDropsetAccounts,
  dropsetFreeCounts,
  noclaimCounts,
  reserve,
  isStillOurs,
  releaseUnits,
  unitHealth,
  __setDeps,
  __resetDeps,
};
