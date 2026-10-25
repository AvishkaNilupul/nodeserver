// Per-game reservation of drops.
//
// An "everything" account holds drops for many games and is sold once PER GAME.
// So a sale/reservation commits only the sold set's drops on the account, never
// the whole account — reserving its Overwatch drops leaves its Rainbow Six
// drops sellable. A drop is unavailable when it's connected (redeemed) OR
// reserved (soldAt !== null); see models/DropLog.js.
//
// The matching BotAccount.sold* fields are still written as a shadow (for the
// account-list display and a safe read-side rollback), but they no longer gate
// stock — that gate is now per drop.
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const SaleSignal = require("../models/SaleSignal");

// Lazy: soldGameGuard loads accountTwins and models on first use only.
function soldGameGuard() {
  return require("./soldGameGuard");
}

// Twitch drops EXPIRE. A claimed drop leaves the account's inventory 180-184
// days after it was awarded (measured on prod 2026-10-16: 229 vanished drops,
// min 180 d, max 184 d; no visible drop older than 183 d). The scanner never
// deletes a row, so a vanished drop stays `state: "connect"` in the archive
// forever. Selling it ships an account whose items the buyer cannot connect:
// G2G order 1791908798608A036-1 got a 35-item Sea of Thieves bundle whose last
// drops had gone 11 h before the sale ("already redeemed, only other games").
//
// So a drop is only sellable while it is younger than the cutoff below, which
// leaves the buyer time to connect it before Twitch removes it. Configurable as
// autoFarm.dropSellableMaxAgeDays (clamped 30..175). A drop with no awardedAt
// is kept: `$not: {$lt}` matches null/missing, so an unknown age never removes
// stock silently.
const DEFAULT_SELLABLE_MAX_AGE_DAYS = 170;
const SELLABLE_AGE_CACHE_MS = 60 * 1000;
let sellableAgeCache = { at: 0, days: DEFAULT_SELLABLE_MAX_AGE_DAYS };

function sellableMaxAgeDays() {
  const now = Date.now();
  if (now - sellableAgeCache.at < SELLABLE_AGE_CACHE_MS) {
    return sellableAgeCache.days;
  }
  let days = DEFAULT_SELLABLE_MAX_AGE_DAYS;
  try {
    // Lazy: settings.js is large and must not load at require time here.
    const raw = Number(
      require("./settings").getAutoFarm().dropSellableMaxAgeDays,
    );
    if (Number.isFinite(raw) && raw > 0) {
      days = Math.min(175, Math.max(30, Math.floor(raw)));
    }
  } catch {
    /* unreadable settings: keep the default, never stop selling outright */
  }
  sellableAgeCache = { at: now, days };
  return days;
}

// The same condition as an aggregation EXPRESSION, for $cond tallies that
// count every row but must not call an expired drop "available".
function notExpiredExpr() {
  return {
    $and: [
      {
        $or: [
          { $eq: [{ $ifNull: ["$awardedAt", null] }, null] },
          { $gte: ["$awardedAt", sellableAwardCutoff()] },
        ],
      },
      {
        $not: [
          {
            $regexMatch: {
              input: { $ifNull: ["$name", ""] },
              regex: EXPIRED_NAME.source,
              options: "i",
            },
          },
        ],
      },
    ],
  };
}

// Tests only: forget the cached setting so the next read sees a new value.
function _resetSellableAgeCache() {
  sellableAgeCache = { at: 0, days: DEFAULT_SELLABLE_MAX_AGE_DAYS };
}

// The oldest awardedAt that is still sellable.
function sellableAwardCutoff(nowMs = Date.now()) {
  return new Date(nowMs - sellableMaxAgeDays() * 86400000);
}

// Plain-JS twin of the age part of AVAILABLE_DROP, for code that already has
// the row in hand.
function isExpiredDrop(drop, nowMs = Date.now()) {
  if (drop && EXPIRED_NAME.test(String(drop.name || ""))) return true;
  const at = drop && drop.awardedAt ? new Date(drop.awardedAt).getTime() : NaN;
  if (!Number.isFinite(at)) return false;
  return at < sellableAwardCutoff(nowMs).getTime();
}

// A publisher can also kill a reward early by renaming the drop on Twitch: NBA
// 2K27's "NBA 2K27 x Nike Ja 4" became "Nike Ja Expired" two weeks after it
// was awarded (72 copies in the archive on 2026-10-16), and an Eldorado unit
// was still offering it. The scanner re-keys a renamed drop, so the set stops
// matching it and nothing noticed. A drop Twitch shows as expired is never
// sellable, whatever its age.
const EXPIRED_NAME = /\bexpired\b/i;

// Aggregation/query fragment for a drop that is available to sell: not redeemed,
// not reserved, not past the expiry cutoff and not renamed "Expired". Spread into a $match alongside
// the itemKey filter. `awardedAt` is a GETTER, so every spread
// ({ ...AVAILABLE_DROP }) takes the cutoff as of that moment; a plain value
// would freeze the cutoff at process start.
const AVAILABLE_DROP = {
  connected: { $ne: true },
  soldAt: null,
  name: { $not: EXPIRED_NAME },
};
Object.defineProperty(AVAILABLE_DROP, "awardedAt", {
  enumerable: true,
  get() {
    return { $not: { $lt: sellableAwardCutoff() } };
  },
});
Object.freeze(AVAILABLE_DROP);

// The same age condition on its own, for hand-written matches that cannot
// spread AVAILABLE_DROP (they filter `connected` differently).
function notExpiredMatch() {
  return {
    awardedAt: { $not: { $lt: sellableAwardCutoff() } },
    name: { $not: EXPIRED_NAME },
  };
}

function setKeys(set) {
  return [...new Set((set.items || []).map((i) => i.itemKey).filter(Boolean))];
}

// Atomically reserve every one of `set`'s drops on one account. Marks only the
// unconnected + unreserved rows for the set's itemKeys. If a concurrent claim
// leaves any of the set's keys unreserved-by-us, the partial reservation is
// rolled back and this returns false so the caller tries the next account —
// preserving the "no two buyers get the same drops" guarantee at drop grain.
// Returns true when the whole set is now reserved on the account.
//
// One sale per game per account (utils/soldGameGuard.js): an account whose
// drops of one of the set's games are already committed elsewhere is refused,
// so the caller moves on to its next candidate. opts.alreadyCommitted skips
// that guard. Pass it ONLY when the call records a commitment that already
// exists (a guardian re-reserve of an account already on its listing, a
// delivery that already happened, accounts the owner listed by hand), never
// for a new sale or listing.
async function reserveSetOnAccount(accountId, set, opts = {}) {
  // A no-claim set's stock is the no-claim farm (utils/noclaimStock.js), never
  // the archive: reserving its items here would freeze claimed DropLog copies
  // its buyer cannot use (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §6).
  if (set && set.stockSource === "noclaim") return false;
  const keys = setKeys(set);
  if (!keys.length) return false;
  const guardGame = !opts.alreadyCommitted;
  if (guardGame) {
    const taken = await soldGameGuard().sameGameTakenAccounts([accountId], set);
    if (taken.size) return false;
  }
  const now = new Date();
  const stamp = {
    soldAt: now,
    soldToUsername: opts.soldToUsername || "",
    soldToAdminId: opts.soldToAdminId || "",
    soldSetId: String(opts.soldSetId || set._id || ""),
    soldBulkOrderId: opts.soldBulkOrderId || "",
  };
  await DropLog.updateMany(
    { account: accountId, itemKey: { $in: keys }, ...AVAILABLE_DROP },
    { $set: stamp },
  );
  // Did we win every key? (soldAt === now uniquely tags this batch.)
  const reserved = await DropLog.distinct("itemKey", {
    account: accountId,
    itemKey: { $in: keys },
    soldAt: now,
  });
  const won = keys.every((k) => reserved.includes(k));
  if (!won) {
    await DropLog.updateMany(
      { account: accountId, itemKey: { $in: keys }, soldAt: now },
      { $set: emptyReservation() },
    );
    return false;
  }
  // Did a concurrent claim commit ANOTHER set of the same game on this account
  // between the check above and our stamp? Our own rows carry `now`; anything
  // else of the game is foreign. Both sides of such a race may back out, and
  // that is the safe direction: a lost sale, never a second buyer.
  // An unreadable check is not a pass: undo the stamp, then report the error.
  if (guardGame) {
    let raced = null;
    let raceErr = null;
    try {
      raced = await soldGameGuard().sameGameTakenAccounts([accountId], set, {
        ignoreSoldAt: now,
      });
    } catch (e) {
      raceErr = e;
    }
    if (raceErr || raced.size) {
      await DropLog.updateMany(
        { account: accountId, itemKey: { $in: keys }, soldAt: now },
        { $set: emptyReservation() },
      );
      if (raceErr) throw raceErr;
      return false;
    }
  }
  // Shadow onto the account (first reservation wins) for display + rollback.
  await BotAccount.updateOne(
    { _id: accountId, soldAt: null },
    { $set: stamp },
  ).catch(() => {});
  // Sale training data for the auto-farmer: one signal per game in the sold
  // set. Deduped per (account, set, game) so refund + re-sell of the same
  // set doesn't double count. Best-effort — never blocks the sale.
  //
  // This function serves two very different callers and the signal has to say
  // which one it was. A Shop order or a bulk order is a real purchase
  // ("listing_sold"); a fulfiller or the auto-lister claiming stock to put on a
  // shelf is not ("drop_reserved"), and only the former may count as demand.
  // Callers that represent a paying buyer pass opts.realSale.
  try {
    const games = [
      ...new Set((set.items || []).map((i) => i.game).filter(Boolean)),
    ];
    for (const game of games) {
      await SaleSignal.updateOne(
        {
          dedupeKey:
            "reserved:" +
            accountId +
            ":" +
            String(set._id || "") +
            ":" +
            game.toLowerCase(),
        },
        {
          $setOnInsert: {
            game,
            gameKey: game.toLowerCase(),
            itemKey: "",
            name: set.name || "",
            login: "",
            account: accountId,
            source: opts.realSale ? "listing_sold" : "drop_reserved",
            marketplace: opts.realSale ? opts.marketplace || "shop" : "",
            priceUsd: Number(opts.priceUsd) || 0,
            at: now,
          },
        },
        { upsert: true },
      );
    }
  } catch {
    /* ignore */
  }
  return true;
}

// Pre-reserved units (an auto-lister share's units[]) are handed over later
// without going back through a claim, so the expiry cutoff above never sees
// them. This answers, for a set, which of these accounts can no longer deliver
// it BECAUSE OF EXPIRY: some item of the set has copies on the account, none of
// them is both unconnected and younger than the cutoff, and at least one is an
// unconnected copy that aged out. Deliberately narrow — an item with no archive
// row at all (renamed key, no-claim stock) or only redeemed copies is NOT
// judged here: that is not proof of expiry, and refusing those units would
// stop deliveries this check knows nothing about. Reservation (soldAt) is
// ignored on purpose — a unit's drops are reserved by design. Returns a Set of
// String(accountId). A DB error propagates: an unreadable account must never
// read as a bad one.
async function expiredUnitAccounts(accountIds, set) {
  const keys = setKeys(set || {});
  const ids = [
    ...new Set(
      (accountIds || [])
        .map((x) => String(x || ""))
        .filter((x) => /^[a-f0-9]{24}$/i.test(x)),
    ),
  ];
  const out = new Set();
  if (!keys.length || !ids.length) return out;
  const cutoff = sellableAwardCutoff();
  const fresh = {
    $or: [
      { $eq: [{ $ifNull: ["$awardedAt", null] }, null] },
      { $gte: ["$awardedAt", cutoff] },
    ],
  };
  // Only a copy this unit could actually ship counts as live: reserved for
  // THIS set, or not reserved at all. A fresh copy held for another buyer must
  // not vouch for an expired one. Expired copies count whoever holds them —
  // a unit reserved under an older set id (the row was rewritten) is still
  // this unit.
  const mine = set && set._id
    ? {
        $or: [
          { $eq: [{ $ifNull: ["$soldAt", null] }, null] },
          { $eq: ["$soldSetId", String(set._id)] },
        ],
      }
    : true;
  const rows = await DropLog.aggregate([
    {
      $match: {
        account: { $in: ids.map((x) => new DropLog.base.Types.ObjectId(x)) },
        itemKey: { $in: keys },
        connected: { $ne: true },
      },
    },
    {
      $group: {
        _id: { a: "$account", k: "$itemKey" },
        live: { $sum: { $cond: [{ $and: [fresh, mine] }, 1, 0] } },
        aged: { $sum: { $cond: [fresh, 0, 1] } },
      },
    },
    // an item with no live copy, where at least one copy aged out
    { $match: { live: 0, aged: { $gt: 0 } } },
    { $group: { _id: "$_id.a" } },
  ]);
  for (const r of rows) out.add(String(r._id));
  // A drop reserved for THIS set that Twitch now shows as "Expired". Its key
  // changed with the rename, so the item match above cannot see it.
  if (set && set._id) {
    const renamed = await DropLog.distinct("account", {
      account: { $in: ids.map((x) => new DropLog.base.Types.ObjectId(x)) },
      soldSetId: String(set._id),
      connected: { $ne: true },
      name: EXPIRED_NAME,
    });
    for (const a of renamed) out.add(String(a));
  }
  return out;
}

// The units of a row that can still deliver its set: everything but the
// expired ones (expiredUnitAccounts). A row with no set, or whose set is gone,
// is returned unchanged — nothing here can judge it.
//
// Nor the ones whose game another market already sold or holds on the account
// (utils/soldGameGuard.js, one sale per game per account): a unit reserved at
// publish is handed over later without a new claim, so the commit-point guard
// in reserveSetOnAccount never sees it again. An Eldorado offer held two units
// whose game Gameflip had already delivered weeks earlier.
async function liveUnits(units, setId) {
  const list = units || [];
  if (!list.length || !setId) return list;
  const set = await require("../models/DropSet").findById(setId).lean();
  if (!set) return list;
  const ids = list.map((u) => u.accountId);
  const bad = await expiredUnitAccounts(ids, set);
  for (const id of await soldGameGuard().foreignHeldUnitAccounts(ids, set)) bad.add(id);
  if (!bad.size) return list;
  return list.filter((u) => !bad.has(String(u.accountId)));
}

function emptyReservation() {
  return {
    soldAt: null,
    soldToUsername: "",
    soldToAdminId: "",
    soldSetId: "",
    soldBulkOrderId: "",
  };
}

// Clear the account shadow for any of `accountIds` that no longer hold a single
// reserved drop (so a fully-released account reads as unsold again).
async function clearEmptyShadows(accountIds) {
  for (const id of accountIds) {
    const still = await DropLog.countDocuments({
      account: id,
      soldAt: { $ne: null },
    });
    if (!still) {
      await BotAccount.updateOne(
        { _id: id },
        { $set: emptyReservation() },
      ).catch(() => {});
    }
  }
}

// Release drop reservations held by a marketplace/tag on the given accounts
// (e.g. delisting a GGSel listing frees its accounts' drops for that set).
async function releaseAccountsForTag(accountIds, tag) {
  const ids = (Array.isArray(accountIds) ? accountIds : [accountIds])
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  if (!ids.length) return;
  const q = { account: { $in: ids } };
  if (tag) q.soldToUsername = tag;
  await DropLog.updateMany(q, { $set: emptyReservation() }).catch(() => {});
  await clearEmptyShadows(ids);
}

// Release one set's reservation from specific accounts (e.g. a Shop refund
// frees only the refunded set's drops, leaving the buyer's other games on the
// same account untouched). An optional `tag` narrows the release to rows
// reserved by that claim owner, so e.g. a guardian fix on a listing
// can't free drops a Shop buyer paid for.
async function releaseSetForAccounts(accountIds, soldSetId, tag) {
  const ids = (Array.isArray(accountIds) ? accountIds : [accountIds])
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  if (!ids.length || !soldSetId) return;
  const q = { account: { $in: ids }, soldSetId: String(soldSetId) };
  if (tag) q.soldToUsername = tag;
  await DropLog.updateMany(q, { $set: emptyReservation() }).catch(() => {});
  await clearEmptyShadows(ids);
}

// Release every drop reserved for a given set + tag (used when a whole listing
// is torn down and we don't have the account ids handy).
async function releaseBySet(soldSetId, tag) {
  if (!soldSetId) return;
  const q = { soldSetId: String(soldSetId) };
  if (tag) q.soldToUsername = tag;
  const affected = await DropLog.distinct("account", q);
  await DropLog.updateMany(q, { $set: emptyReservation() }).catch(() => {});
  await clearEmptyShadows(affected.map(String));
}

// Release every drop reserved by a bulk order (order cancel / rollback).
async function releaseByBulkOrder(soldBulkOrderId) {
  if (!soldBulkOrderId) return;
  const q = { soldBulkOrderId: String(soldBulkOrderId) };
  const affected = await DropLog.distinct("account", q);
  await DropLog.updateMany(q, { $set: emptyReservation() }).catch(() => {});
  await clearEmptyShadows(affected.map(String));
}

module.exports = {
  AVAILABLE_DROP,
  DEFAULT_SELLABLE_MAX_AGE_DAYS,
  sellableMaxAgeDays,
  sellableAwardCutoff,
  isExpiredDrop,
  notExpiredMatch,
  notExpiredExpr,
  expiredUnitAccounts,
  liveUnits,
  _resetSellableAgeCache,
  setKeys,
  reserveSetOnAccount,
  releaseAccountsForTag,
  releaseSetForAccounts,
  releaseBySet,
  releaseByBulkOrder,
  emptyReservation,
};
