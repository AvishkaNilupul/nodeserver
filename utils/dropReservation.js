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

// Aggregation/query fragment for a drop that is available to sell: not redeemed
// and not reserved. Spread into a $match alongside the itemKey filter.
const AVAILABLE_DROP = { connected: { $ne: true }, soldAt: null };

function setKeys(set) {
  return [...new Set((set.items || []).map((i) => i.itemKey).filter(Boolean))];
}

// Pure rule behind the guard below: may this claim take the set, given the
// reservation rows already held for it on the same credentials? Only the owner
// re-reserving its own drops (`reclaim`) may proceed through a live one.
function claimAllowed(heldRows, opts = {}) {
  if (opts.reclaim) return true;
  return !(heldRows || []).some((r) => r && r.soldAt);
}

// Every login that names the same Twitch account as `accountId`: the pool has
// been fed the same account twice in places, so one Twitch login can have more
// than one BotAccount row (and therefore its own, separate drop rows). A
// reservation only means "these credentials are committed" if it covers all of
// them.
async function twinAccountIds(accountId) {
  const me = await BotAccount.findById(accountId, { login: 1 }).lean();
  const login = String((me && me.login) || "").trim();
  if (!login) return [String(accountId)];
  const rows = await BotAccount.find(
    {
      login: new RegExp(
        "^" + login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
        "i",
      ),
    },
    { _id: 1 },
  ).lean();
  const ids = rows.map((r) => String(r._id));
  if (!ids.includes(String(accountId))) ids.push(String(accountId));
  return ids;
}

// Atomically reserve every one of `set`'s drops on one account. Marks only the
// unconnected + unreserved rows for the set's itemKeys. If a concurrent claim
// leaves any of the set's keys unreserved-by-us, the partial reservation is
// rolled back and this returns false so the caller tries the next account —
// preserving the "no two buyers get the same drops" guarantee at drop grain.
// Returns true when the whole set is now reserved on the account.
async function reserveSetOnAccount(accountId, set, opts = {}) {
  const keys = setKeys(set);
  if (!keys.length) return false;
  const now = new Date();
  const stamp = {
    soldAt: now,
    soldToUsername: opts.soldToUsername || "",
    soldToAdminId: opts.soldToAdminId || "",
    soldSetId: String(opts.soldSetId || set._id || ""),
    soldBulkOrderId: opts.soldBulkOrderId || "",
  };
  // A drop-grain check alone is not enough for a sale that hands over WHOLE
  // CREDENTIALS: a bot that keeps farming the same campaign adds fresh copies
  // of the set's items, and those unreserved copies would let a second
  // marketplace claim an account whose login is already committed to a live
  // listing for this very set — both buyers then get the same account. So one
  // set is claimable once per account (across its duplicate rows); a different
  // set on the same account stays sellable, which is the point of per-game
  // reservation. `opts.reclaim` is the one exception: the guardian's
  // claim-mismatch fix re-reserves the drops of a listing that already owns
  // them.
  if (!opts.reclaim) {
    const twins = await twinAccountIds(accountId);
    const held = await DropLog.find(
      {
        account: { $in: twins },
        soldSetId: stamp.soldSetId,
        soldAt: { $ne: null },
      },
      { soldAt: 1, soldToUsername: 1 },
    )
      .limit(1)
      .lean();
    if (!claimAllowed(held, opts)) return false;
  }
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
  // Shadow onto the account (first reservation wins) for display + rollback.
  await BotAccount.updateOne(
    { _id: accountId, soldAt: null },
    { $set: stamp },
  ).catch(() => {});
  // Sale training data for the auto-farmer: one signal per game in the sold
  // set. Deduped per (account, set, game) so refund + re-sell of the same
  // set doesn't double count. Best-effort — never blocks the sale.
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
            source: "drop_reserved",
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
// reserved by that claim owner, so e.g. a guardian fix on a FunPay listing
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
  setKeys,
  claimAllowed,
  twinAccountIds,
  reserveSetOnAccount,
  releaseAccountsForTag,
  releaseSetForAccounts,
  releaseBySet,
  releaseByBulkOrder,
  emptyReservation,
};
