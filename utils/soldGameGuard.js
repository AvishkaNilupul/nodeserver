// ---------------------------------------------------------------------------
// One sale per game per account (docs/SOLD-GAME-GUARD.md).
//
// Reservation is per drop: a sale stamps `soldAt` on the sold set's drops
// only. That leaves the same account's drops for ANOTHER set of the SAME game
// reading as free stock, and a second buyer can be sold the game the first
// buyer already owns. The first buyer's game link takes every drop of that
// game on the account. On 2026-09-29 the auto-lister put an account on ZeusX
// for one MCOC set six minutes after Gameflip delivered it for another MCOC
// set, and the Gameflip buyer connected MCOC the next day.
//
// The rule: once ANY drop of game G on an account is committed (soldAt set,
// whatever the tag or set), the account is not committed to anything else of
// game G. Other games are untouched: one buyer's Overwatch and another
// buyer's Rainbow Six on one account is the owner's accepted model.
//
// The ONE implementation. dropReservation.reserveSetOnAccount (the commit
// point), shopRoutes.availableAccountsForSet (stock and picks) and
// autoLister.pickDeliveryAccounts all ask this module. A failed read THROWS,
// like every other stock read: an unreadable account is never sold.
// ---------------------------------------------------------------------------

// The game part of an itemKey ("name|game", lowercased by
// twitchInventory.itemKeyFor). The name may itself contain "|", so take the
// last one.
function gameKeyOfItemKey(itemKey) {
  const s = String(itemKey || "");
  const i = s.lastIndexOf("|");
  return i >= 0 ? s.slice(i + 1).trim().toLowerCase() : "";
}

function normGame(game) {
  return String(game || "").trim().toLowerCase();
}

// The game of one DropLog row: its itemKey, else its `game` field.
function gameKeyOfRow(row) {
  return gameKeyOfItemKey(row && row.itemKey) || normGame(row && row.game);
}

// The games a set (or any { items: [{ itemKey, game }] }) sells.
function setGameKeys(set) {
  const out = new Set();
  for (const it of (set && set.items) || []) {
    const g = gameKeyOfItemKey(it && it.itemKey) || normGame(it && it.game);
    if (g) out.add(g);
  }
  return out;
}

function msOf(v) {
  if (v == null) return NaN;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
}

// Pure, the decision itself. `rows` are committed DropLog rows (soldAt set) of
// the accounts in question. Returns the Set of account id strings the rule
// refuses.
//   games          Set of game keys being committed now
//   ownerOf        Map<rowAccountId, [requested account ids]>: a twin
//                  record's rows count against the record that was asked
//                  about. Absent → a row counts against its own account.
//   ignoreSoldAt   Date: rows stamped at exactly this moment are the caller's
//                  own just-written reservation, not a foreign one.
function takenFromRows(rows, games, { ownerOf = null, ignoreSoldAt = null } = {}) {
  const out = new Set();
  if (!games || !games.size) return out;
  const own = msOf(ignoreSoldAt);
  for (const r of rows || []) {
    if (!r || r.soldAt == null) continue;
    if (!games.has(gameKeyOfRow(r))) continue;
    if (Number.isFinite(own) && msOf(r.soldAt) === own) continue;
    const a = String(r.account);
    const owners = (ownerOf && ownerOf.get(a)) || [a];
    for (const o of owners) out.add(String(o));
  }
  return out;
}

// Pure, for PRE-RESERVED units (an auto-lister share's units[], handed over
// later without a new claim, so reserveSetOnAccount never sees them again).
// A unit's own reservation is its rows for `setId`; their tags are its market.
// The unit is foreign-held when a row of the same game carries any OTHER tag:
// another market sold or holds that game on the account. When none of the
// account's rows are for `setId` (a row rewritten to a new set keeps its old
// reservation), its own tag is unknown and the unit is NOT judged: refusing a
// unit on a guess would stop deliveries this check knows nothing about.
function foreignHeldFromRows(rows, games, setId, { ownerOf = null } = {}) {
  const out = new Set();
  if (!games || !games.size) return out;
  const sid = String(setId || "");
  const ownTags = new Map(); // requested id -> Set(tag)
  const byOwner = new Map(); // requested id -> [rows of the game]
  for (const r of rows || []) {
    if (!r || r.soldAt == null || !games.has(gameKeyOfRow(r))) continue;
    const a = String(r.account);
    for (const o of (ownerOf && ownerOf.get(a)) || [a]) {
      if (!byOwner.has(o)) byOwner.set(o, []);
      byOwner.get(o).push(r);
      if (o === a && sid && String(r.soldSetId || "") === sid) {
        if (!ownTags.has(o)) ownTags.set(o, new Set());
        ownTags.get(o).add(String(r.soldToUsername || ""));
      }
    }
  }
  for (const [o, list] of byOwner) {
    const tags = ownTags.get(o);
    if (!tags || !tags.size) continue;
    if (list.some((r) => !tags.has(String(r.soldToUsername || "")))) out.add(o);
  }
  return out;
}

function escapeRx(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The committed rows (soldAt set) of `accountIds` and their twin records, for
// the set's games. { ids, games, ownerOf, rows }; rows is empty when there is
// nothing to ask.
async function committedGameRows(accountIds, set) {
  const games = setGameKeys(set);
  const mongoose = require("mongoose");
  const ids = [
    ...new Set(
      (accountIds || [])
        .map((x) => String(x || ""))
        .filter((x) => mongoose.Types.ObjectId.isValid(x) && /^[a-f0-9]{24}$/i.test(x)),
    ),
  ];
  const ownerOf = new Map(ids.map((id) => [id, [id]]));
  if (!games.size || !ids.length) return { ids, games, ownerOf, rows: [] };

  // Twins: one Twitch login, two BotAccount records (utils/accountTwins.js).
  // A sale through either record is a sale of the account.
  const queryIds = new Set(ids);
  const twins = require("./accountTwins");
  const idx = await twins.twinIndex();
  if (idx.size) {
    const BotAccount = require("../models/BotAccount");
    const accs = await BotAccount.find({ _id: { $in: ids } }, { login: 1 }).lean();
    for (const a of accs) {
      const me = String(a._id);
      for (const sib of idx.get(twins.loginKey(a.login)) || []) {
        if (sib === me || !/^[a-f0-9]{24}$/i.test(sib)) continue;
        queryIds.add(sib);
        if (!ownerOf.has(sib)) ownerOf.set(sib, [sib]);
        if (!ownerOf.get(sib).includes(me)) ownerOf.get(sib).push(me);
      }
    }
  }

  const DropLog = require("../models/DropLog");
  const list = [...games];
  const rows = await DropLog.find(
    {
      account: { $in: [...queryIds].map((x) => new mongoose.Types.ObjectId(x)) },
      soldAt: { $ne: null },
      $or: [
        // itemKey is stored lowercased, so an anchored suffix is exact.
        { itemKey: { $in: list.map((g) => new RegExp("\\|" + escapeRx(g) + "$")) } },
        {
          itemKey: { $in: ["", null] },
          game: { $in: list.map((g) => new RegExp("^\\s*" + escapeRx(g) + "\\s*$", "i")) },
        },
      ],
    },
    { account: 1, itemKey: 1, game: 1, soldAt: 1, soldSetId: 1, soldToUsername: 1 },
  ).lean();
  return { ids, games, ownerOf, rows };
}

// Only answer about the accounts that were asked about.
function onlyAsked(found, ids) {
  const asked = new Set(ids);
  return new Set([...found].filter((id) => asked.has(id)));
}

// Account ids (of `accountIds`) that may NOT be committed to `set`, because
// some drop of one of the set's games on the account (or on its twin record)
// is already committed. Set<String(accountId)>.
//
// opts.ignoreSoldAt: see takenFromRows (the post-stamp check in
// reserveSetOnAccount passes its own stamp).
async function sameGameTakenAccounts(accountIds, set, opts = {}) {
  const { ids, games, ownerOf, rows } = await committedGameRows(accountIds, set);
  if (!rows.length) return new Set();
  return onlyAsked(takenFromRows(rows, games, { ownerOf, ignoreSoldAt: opts.ignoreSoldAt }), ids);
}

// Account ids of pre-reserved units for `set` that another market's tag also
// holds the game on (see foreignHeldFromRows). Set<String(accountId)>.
async function foreignHeldUnitAccounts(accountIds, set) {
  const { ids, games, ownerOf, rows } = await committedGameRows(accountIds, set);
  if (!rows.length) return new Set();
  return onlyAsked(foreignHeldFromRows(rows, games, set && set._id, { ownerOf }), ids);
}

module.exports = {
  gameKeyOfItemKey,
  gameKeyOfRow,
  setGameKeys,
  takenFromRows,
  foreignHeldFromRows,
  sameGameTakenAccounts,
  foreignHeldUnitAccounts,
};
