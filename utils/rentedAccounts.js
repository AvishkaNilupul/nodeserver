// ---------------------------------------------------------------------------
// Accounts in a renter's bot stack are never sellable stock.
//
// A RenterAccount is an account farming for a renter: one we rented out, a
// rent-farm window a buyer paid for, or an account the renter submitted. Its
// drops are the renter's. But an account that once farmed for us can still
// have its old BotAccount record — password kept, drops unreserved — so the
// Drop Archive counts it as sellable and any seller path (Shop, bulk orders,
// bulk packs, claim-at-delivery, the auto-lister's picker) could hand it to a
// buyer. Measured 2026-09-30: 53 of 332 renter accounts looked sellable this
// way, and a bulk pack reserved two of bulkfarmall's accounts before its own
// health check pulled them.
//
// Identity is the ClientSecret (see project memory "duplicate logins"); the
// login is a fallback for rows that carry one. The whole RenterAccount set is
// small (hundreds of rows), so it is read in one projected query and cached
// briefly. A failed read THROWS: callers already treat a failed stock read as
// "not sellable right now", never as "everything is sellable".
// ---------------------------------------------------------------------------

const CACHE_MS = 30 * 1000;

let cache = { at: 0, idx: null };
let pending = null;

function lower(v) {
  return String(v || "").trim().toLowerCase();
}

async function loadIndex() {
  const RenterAccount = require("../models/RenterAccount");
  const rows = await RenterAccount.find({}, { clientSecret: 1, login: 1 }).lean();
  const secrets = new Set();
  const logins = new Set();
  for (const r of rows || []) {
    if (r.clientSecret) secrets.add(String(r.clientSecret));
    if (r.login) logins.add(lower(r.login));
  }
  return { secrets, logins, size: (rows || []).length };
}

// { secrets:Set, logins:Set } of every account in a renter stack.
async function rentedIndex({ fresh = false } = {}) {
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

// True when this BotAccount-like object ({clientSecret?, login?}) is rented.
function isRented(idx, acc) {
  if (!idx || !acc) return false;
  if (acc.clientSecret && idx.secrets.has(String(acc.clientSecret))) return true;
  const l = lower(acc.login);
  return !!l && idx.logins.has(l);
}

// The subset of `accountIds` (BotAccount ids) that are rented — for callers
// that hold ids and logins but not the ClientSecret.
async function rentedAccountIds(accountIds) {
  const ids = [...new Set((accountIds || []).map((x) => String(x || "")).filter(Boolean))];
  const out = new Set();
  if (!ids.length) return out;
  const idx = await rentedIndex();
  if (!idx.size) return out;
  const BotAccount = require("../models/BotAccount");
  const accs = await BotAccount.find({ _id: { $in: ids } }, { clientSecret: 1, login: 1 }).lean();
  for (const a of accs || []) if (isRented(idx, a)) out.add(String(a._id));
  return out;
}

function __resetCache() {
  cache = { at: 0, idx: null };
  pending = null;
}

module.exports = { rentedIndex, isRented, rentedAccountIds, CACHE_MS, __resetCache };
