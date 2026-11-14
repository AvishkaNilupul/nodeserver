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
const SkinAccount = require("../models/SkinAccount");

// Aggregation/query fragment for a drop that is available to sell: not redeemed
// and not reserved. Spread into a $match alongside the itemKey filter.
const AVAILABLE_DROP = { connected: { $ne: true }, soldAt: null };

// Resolve by all Twitch identity keys, including a duplicate bot row. A linked
// whole-account sale owns every game on that Twitch identity for its lifetime.
async function withoutSkinAccounts(accountIds) {
  const ids = [...new Set((accountIds || []).map(String))];
  if (!ids.length) return [];
  const [botRows, poolRows] = await Promise.all([
    BotAccount.find({ _id: { $in: ids } }).select("login twitchId").lean(),
    require("../models/AvailableAccount").find({ _id: { $in: ids } }).select("username twitchId").lean(),
  ]);
  const bots = [...botRows, ...poolRows.map(p => ({ ...p, login: p.username }))];
  const logins = [...new Set(bots.map(b => String(b.login || "").trim().toLowerCase()).filter(Boolean))];
  const twitchIds = [...new Set(bots.map(b => b.twitchId).filter(Boolean))];
  const held = await SkinAccount.find({ $or: [
    { botAccountId: { $in: ids } }, { twitchLogin: { $in: logins } }, { twitchId: { $in: twitchIds } },
  ] }).select("botAccountId twitchLogin twitchId").lean();
  const heldIds = new Set(held.map(h => String(h.botAccountId)));
  const heldLogins = new Set(held.map(h => h.twitchLogin));
  const heldTwitchIds = new Set(held.map(h => h.twitchId));
  for (const bot of bots) {
    if (heldLogins.has(String(bot.login || "").trim().toLowerCase()) || (bot.twitchId && heldTwitchIds.has(bot.twitchId))) heldIds.add(String(bot._id));
  }
  return ids.filter(id => !heldIds.has(id));
}

function withStockLock(fn) {
  // Skin enrollment uses this same lock and stamps its own hold directly;
  // it never calls these wrappers recursively.
  return (...args) => require("./epicSales")._internals.withLock(() => fn(...args));
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
async function reserveSetOnAccount(accountId, set, opts = {}) {
  // A no-claim set's stock is the no-claim farm (utils/noclaimStock.js), never
  // the archive: reserving its items here would freeze claimed DropLog copies
  // its buyer cannot use (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §6).
  if (set && set.stockSource === "noclaim") return false;
  const keys = setKeys(set);
  if (!keys.length) return false;
  if (!(await withoutSkinAccounts([accountId])).length) return false;
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
  const stillAvailable = (await withoutSkinAccounts([accountId])).length > 0;
  if (!won || !stillAvailable) {
    await DropLog.updateMany(
      { account: accountId, itemKey: { $in: keys }, ...stamp },
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
  for (const id of await withoutSkinAccounts(accountIds)) {
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
  const ids = await withoutSkinAccounts((Array.isArray(accountIds) ? accountIds : [accountIds])
    .map((x) => String(x || "").trim())
    .filter(Boolean));
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
  const ids = await withoutSkinAccounts((Array.isArray(accountIds) ? accountIds : [accountIds])
    .map((x) => String(x || "").trim())
    .filter(Boolean));
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
  const affected = await withoutSkinAccounts(await DropLog.distinct("account", q));
  if (!affected.length) return;
  await DropLog.updateMany({ ...q, account: { $in: affected } }, { $set: emptyReservation() }).catch(() => {});
  await clearEmptyShadows(affected);
}

// Release every drop reserved by a bulk order (order cancel / rollback).
async function releaseByBulkOrder(soldBulkOrderId) {
  if (!soldBulkOrderId) return;
  const q = { soldBulkOrderId: String(soldBulkOrderId) };
  const affected = await withoutSkinAccounts(await DropLog.distinct("account", q));
  if (!affected.length) return;
  await DropLog.updateMany({ ...q, account: { $in: affected } }, { $set: emptyReservation() }).catch(() => {});
  await clearEmptyShadows(affected);
}

module.exports = {
  AVAILABLE_DROP,
  setKeys,
  reserveSetOnAccount: withStockLock(reserveSetOnAccount),
  releaseAccountsForTag: withStockLock(releaseAccountsForTag),
  releaseSetForAccounts: withStockLock(releaseSetForAccounts),
  releaseBySet: withStockLock(releaseBySet),
  releaseByBulkOrder: withStockLock(releaseByBulkOrder),
  emptyReservation,
};
