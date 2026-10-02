// ---------------------------------------------------------------------------
// One Twitch account, two BotAccount records ("twins").
//
// Re-minting a token and redeploying creates a SECOND BotAccount for the same
// Twitch login — identity is the ClientSecret and `login` is not unique (see
// project memory "duplicate logins"). Both records carry DropLog rows for the
// SAME real drops, and every seller path lists its candidates per RECORD, so:
//   - one claim could pick both records of one account. Eldorado order
//     c8650c3c (2026-09-27) paid for 5 accounts and was sent marolw93x7w
//     twice; G2G order 1790705383264O9BE-1 (2026-09-29) paid for 2 and was
//     sent maroly2pq28 twice.
//   - a twin's rows stay FREE after the other record's copy of the same drops
//     was reserved, sold or claimed, so the same drops could be sold again
//     once the first listing is gone.
// 128 logins had twins on 2026-09-30. Nothing is deleted — the owner chose
// masking over deleting records (2026-07-25) — so every candidate list is
// filtered instead:
//   - at most one record per login (the caller's best-ranked one), and
//   - a twin login whose records hold ANY of the set's items reserved, sold or
//     connected is not a candidate for that set: those drops are gone.
// A failed read THROWS, like every other stock read: never "sell anyway".
// ---------------------------------------------------------------------------

const CACHE_MS = 30 * 1000;

let cache = { at: 0, idx: null };
let pending = null;

function loginKey(v) {
  return String(v || "").trim().toLowerCase();
}

async function loadIndex() {
  const BotAccount = require("../models/BotAccount");
  const rows = await BotAccount.aggregate([
    { $match: { login: { $type: "string", $ne: "" } } },
    {
      $group: {
        _id: { $toLower: { $trim: { input: "$login" } } },
        ids: { $push: "$_id" },
        n: { $sum: 1 },
      },
    },
    { $match: { n: { $gt: 1 } } },
  ]);
  const idx = new Map();
  for (const r of rows || []) {
    const l = loginKey(r._id);
    if (l) idx.set(l, (r.ids || []).map(String));
  }
  return idx;
}

// Map<loginKey, [BotAccount id strings]> of every login with 2+ records.
async function twinIndex({ fresh = false } = {}) {
  if (!fresh && cache.idx && Date.now() - cache.at < CACHE_MS) return cache.idx;
  if (pending) return pending;
  pending = loadIndex()
    .then((idx) => {
      cache = { at: Date.now(), idx };
      return idx;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

// For the twin logins among `logins`: which of `itemKeys` are gone — reserved,
// sold or connected on ANY of that login's records. Map<loginKey, Set<itemKey>>;
// a login that is not a twin, or has nothing gone, is absent.
async function goneKeysFor(logins, itemKeys) {
  const out = new Map();
  const keys = [...new Set((itemKeys || []).filter(Boolean).map(String))];
  if (!keys.length) return out;
  const idx = await twinIndex();
  if (!idx.size) return out;
  const want = [
    ...new Set((logins || []).map(loginKey).filter((l) => l && idx.has(l))),
  ];
  if (!want.length) return out;
  const mongoose = require("mongoose");
  const DropLog = require("../models/DropLog");
  const loginOf = new Map();
  const ids = [];
  for (const l of want) {
    for (const id of idx.get(l)) {
      if (!mongoose.Types.ObjectId.isValid(id)) continue;
      loginOf.set(String(id), l);
      ids.push(new mongoose.Types.ObjectId(id));
    }
  }
  if (!ids.length) return out;
  const rows = await DropLog.aggregate([
    {
      $match: {
        account: { $in: ids },
        itemKey: { $in: keys },
        $or: [{ soldAt: { $ne: null } }, { connected: true }],
      },
    },
    { $group: { _id: { a: "$account", k: "$itemKey" } } },
  ]);
  for (const r of rows || []) {
    const l = loginOf.get(String(r._id && r._id.a));
    if (!l) continue;
    if (!out.has(l)) out.set(l, new Set());
    out.get(l).add(String(r._id.k));
  }
  return out;
}

// True when any of `keys` is in the gone set (a missing set means none gone).
function hitsAny(gone, keys) {
  if (!gone || !gone.size) return false;
  for (const k of keys || []) if (gone.has(String(k))) return true;
  return false;
}

// Keep the first entry per login — callers pass a ranked list, so the one kept
// is their best record. Entries without a login cannot collide and are kept.
function onePerLogin(list, loginOf = (x) => x && x.login) {
  const seen = new Set();
  const out = [];
  for (const x of list || []) {
    const l = loginKey(loginOf(x));
    if (l) {
      if (seen.has(l)) continue;
      seen.add(l);
    }
    out.push(x);
  }
  return out;
}

function __resetCache() {
  cache = { at: 0, idx: null };
  pending = null;
}

module.exports = {
  twinIndex,
  goneKeysFor,
  hitsAny,
  onePerLogin,
  loginKey,
  CACHE_MS,
  __resetCache,
};
