// Per-game demand and stock, measured from what actually happened.
//
// WHY THIS EXISTS
//
// Two farming systems needed the same facts and neither could get them.
//
// The auto-farmer reads `internalSalesForGame` (SaleSignal, 45 days, sources
// "connected" + "listing_sold") and nothing else — no stock level, no
// sell-through, no time-to-sale. The no-claim / unclaimed farm read NOTHING: it
// had no demand input of any kind, because the operator typed the account count
// into a form.
//
// Worse, for the no-claim games the sale evidence is scattered across five
// places that do not agree, and an audit on 2026-09-08 found three of them
// silently unrecorded:
//
//   UnclaimedAccount  status "sold"     — every automated channel funnels here
//                                         through spendAccount, so this is the
//                                         most complete unit count we have
//   SaleSignal        "listing_sold"    — Gameflip + Digiseller/GGSel only.
//                                         Eldorado / PlayerAuctions / Z2U / G2G
//                                         write no signal at all
//   SaleSignal        "connected"       — the drop scanner saw a buyer link the
//                                         account. Proves a sale but names no
//                                         price, and covers accounts sold long
//                                         before the ledger existed
//   NoclaimSpentAccount               — what the operator swept out of a bot as
//                                         sold/connected
//   AvailableAccount.manualSold       — the hand-sold tick
//
// Measured on prod: 176 distinct Overwatch logins connected in 30 days, of which
// only 58 have a ledger row. Sizing off the ledger alone would have read
// Overwatch as a 9-sales-a-month game when it is a ~35-a-week game. So this
// module unions every source and DEDUPES BY LOGIN — an account sells exactly
// once, whoever noticed.
//
// Everything here is READ-ONLY. It writes nothing, claims nothing and starts no
// loop; it is the evidence layer under utils/unclaimedAllocator.js and the
// sizing panels.

const AvailableAccount = require("../models/AvailableAccount");
const NoclaimSpentAccount = require("../models/NoclaimSpentAccount");
const SaleSignal = require("../models/SaleSignal");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const MarketplaceListing = require("../models/MarketplaceListing");
const settings = require("./settings");
const sizing = require("./farmSizing");

const DAY_MS = 86400000;

// Sources that mean a buyer paid. Same two the auto-farmer trusts, and for the
// same reason: "drop_reserved" is stamped when stock is CLAIMED for a listing,
// which is shelf-filling, not selling. Counting it once closed a loop where
// farming was its own proof of demand (see utils/saleLearning.js).
const REAL_SALE_SOURCES = ["connected", "listing_sold"];

const lower = (s) => String(s || "").trim().toLowerCase();

// ---------------------------------------------------------------------------
// Game buckets
// ---------------------------------------------------------------------------

// A no-claim "game" is a keyword, not a label: `noClaimGames` holds "overwatch"
// and "rainbow six", which have to catch "Overwatch", "Overwatch 2" and "Tom
// Clancy's Rainbow Six Siege" alike. Every count in this module is bucketed by
// that keyword, so the three spellings of Overwatch sitting in the ledger right
// now (197 "Overwatch" rows + 50 "overwatch" rows) roll into one number instead
// of reading as two half-sized games.
//
// Matching is EXACTLY settings.isNoClaimGame's rule — substring of the
// normalised label — so a game can never be in a different bucket here than the
// one the farming engines put it in.
function noClaimKeys() {
  const list = settings.getAutoFarm().noClaimGames || [];
  return [...new Set(list.map((g) => settings.normGameName(g)).filter(Boolean))];
}

// Which no-claim bucket a raw game label belongs to, or "" for a label that is
// not a no-claim game at all. When two keywords both match (they should not, but
// the list is operator-editable) the LONGEST wins, so adding "call of duty
// warzone" beside "call of duty" would refine rather than collide.
function bucketFor(game, keys = noClaimKeys()) {
  const g = settings.normGameName(game);
  if (!g) return "";
  let best = "";
  for (const k of keys) {
    if (k && g.includes(k) && k.length > best.length) best = k;
  }
  return best;
}

// Human label for a bucket key, for UI. Title-cases the keyword because the
// keyword itself is the only name a bucket has ("rainbow six" -> "Rainbow Six").
function bucketLabel(key) {
  return String(key || "")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Sold units — the union, deduped by login
// ---------------------------------------------------------------------------

// One entry per account we can prove was sold in the window, keyed by lowercased
// login. `sources` records every place that noticed, which is what makes the
// coverage gaps visible in the UI instead of silently shrinking the number.
//
// A row with no login is still counted (quantity listings hand out a unit
// without naming the account) under a synthetic key, so anonymous unit sales are
// not collapsed into one.
async function soldUnitsByBucket({ days = 30 } = {}) {
  const keys = noClaimKeys();
  const since = new Date(Date.now() - Math.max(1, days) * DAY_MS);
  const out = new Map(); // bucket -> Map(loginKey -> { sources:Set, price, market, at })

  const add = (game, login, source, extra = {}) => {
    const bucket = bucketFor(game, keys);
    if (!bucket) return;
    const inner = out.get(bucket) || out.set(bucket, new Map()).get(bucket);
    const id = lower(login) || `anon:${source}:${extra.dedupe || inner.size}`;
    const cur = inner.get(id) || { sources: new Set(), priceUsd: 0, market: "", at: null };
    cur.sources.add(source);
    // Keep the best price any source names — a connection flip proves the sale
    // but carries no price, so taking the max is how a sale keeps its money when
    // only one of its two witnesses saw it.
    if (extra.priceUsd > cur.priceUsd) cur.priceUsd = extra.priceUsd;
    if (!cur.market && extra.market) cur.market = extra.market;
    if (extra.at && (!cur.at || extra.at > cur.at)) cur.at = extra.at;
    inner.set(id, cur);
  };

  // 1. The unclaimed ledger — every automated channel, including the four
  //    (Eldorado, PlayerAuctions, Z2U, G2G) that write no SaleSignal.
  const ledgers = await UnclaimedAccount.find(
    { status: "sold", soldAt: { $gte: since } },
    { login: 1, game: 1, market: 1, soldAt: 1, set: 1, soldPriceUsd: 1, soldMarket: 1 },
  ).lean();
  // Rows sold since `soldPriceUsd` shipped carry the price they ACTUALLY sold
  // at. Older rows carry nothing, so their price is reconstructed from the set's
  // live listings — the CURRENT price, not the price at sale, which is good
  // enough to weight a sizing decision and not good enough to call revenue.
  // Only the rows that need it are looked up.
  const setIds = [
    ...new Set(
      ledgers
        .filter((l) => !(Number(l.soldPriceUsd) > 0))
        .map((l) => l.set)
        .filter(Boolean)
        .map(String),
    ),
  ];
  const priceBySet = new Map();
  if (setIds.length) {
    const rows = await MarketplaceListing.find(
      { set: { $in: setIds }, origin: "unclaimed" },
      { set: 1, price: 1 },
    ).lean();
    for (const r of rows) {
      const k = String(r.set);
      const p = Number(r.price) || 0;
      if (p > (priceBySet.get(k) || 0)) priceBySet.set(k, p);
    }
  }
  for (const l of ledgers) {
    const recorded = Math.max(0, Number(l.soldPriceUsd) || 0);
    add(l.game, l.login, "ledger", {
      priceUsd: recorded || priceBySet.get(String(l.set)) || 0,
      market: l.soldMarket || l.market || "",
      at: l.soldAt,
      dedupe: String(l._id),
    });
  }

  // 2. SaleSignal — the marketplace pollers and the drop scanner.
  //
  //    PERFORMANCE, measured on prod 2026-09-08. The obvious version — fetch
  //    every real sale signal in the window and bucket them in JS — took 60
  //    seconds, because it dragged 14,096 documents across the wire (the Atlas
  //    bound here is BYTES RETURNED, not query time). A regex prefilter on
  //    gameKey only got it to 37s: an unanchored regex cannot seek the
  //    { gameKey: 1, at: -1 } index, it can only scan it.
  //
  //    So: resolve the EXACT gameKeys that belong to a no-claim bucket first
  //    (a cheap index-covered distinct over a handful of values), then let the
  //    database do the deduping in an aggregation. What comes back is one row
  //    per (game, login) — a few hundred — instead of fourteen thousand.
  //    `bucketFor` still decides which bucket a key lands in, so the answer is
  //    identical; only the volume changed.
  const allKeys = await SaleSignal.distinct("gameKey");
  const mineKeys = (allKeys || []).filter((k) => bucketFor(k, keys));
  if (mineKeys.length) {
    const grouped = await SaleSignal.aggregate([
      {
        $match: {
          gameKey: { $in: mineKeys },
          at: { $gte: since },
          source: { $in: REAL_SALE_SOURCES },
        },
      },
      {
        $group: {
          // An account sells once. Anonymous quantity-listing units carry no
          // login, so they fall back to their dedupeKey — collapsing those onto
          // one row would read a hundred unit sales as a single sale.
          //
          // The test is `login > ""`, NOT $ifNull. SaleSignal.login is declared
          // `default: ""` (models/SaleSignal.js:27), so it is an empty STRING
          // and never null — $ifNull would pass it straight through and every
          // anonymous unit sale on every listing would group under "", reading
          // a whole quantity listing's sales as one.
          _id: {
            g: "$gameKey",
            who: {
              $cond: [
                { $gt: ["$login", ""] },
                "$login",
                { $concat: ["anon:", { $ifNull: ["$dedupeKey", "?"] }] },
              ],
            },
          },
          sources: { $addToSet: "$source" },
          markets: { $addToSet: "$marketplace" },
          // The best price any witness named: a connection flip proves the sale
          // but carries no price, so taking the max is how a sale keeps its
          // money when only one of its two witnesses saw it.
          priceUsd: { $max: { $ifNull: ["$priceUsd", 0] } },
          at: { $max: "$at" },
        },
      },
    ]);
    for (const row of grouped) {
      const login = String(row._id.who || "");
      for (const source of row.sources || []) {
        add(row._id.g, login.startsWith("anon:") ? "" : login, source, {
          priceUsd: Number(row.priceUsd) || 0,
          market: (row.markets || []).find(Boolean) || "",
          at: row.at,
          dedupe: login,
        });
      }
    }
  }

  // 3. What the operator swept out of a no-claim bot as sold or connected. This
  //    is the only witness for an account hand-sold in bulk that the buyer has
  //    not linked yet.
  const spent = await NoclaimSpentAccount.find(
    { sweptAt: { $gte: since }, $or: [{ sold: true }, { connected: true }] },
    { loginLower: 1, login: 1, game: 1, sweptAt: 1 },
  ).lean();
  for (const s of spent) {
    add(s.game, s.loginLower || s.login, "swept", { at: s.sweptAt });
  }

  // 4. The hand-sold tick on the pool row. `manualSold` carries no date, so it
  //    can only be attributed to a window through the pool row's own updatedAt —
  //    approximate, and marked as such by its source name.
  const manual = await AvailableAccount.find(
    { manualSold: true, updatedAt: { $gte: since } },
    { usernameLower: 1, username: 1, soldGames: 1, claimedNote: 1, updatedAt: 1 },
  ).lean();
  for (const m of manual) {
    // A hand-sold pool row names its game either in soldGames or in the
    // "noclaim-farm:<game>" claim note it still carries.
    const games = Array.isArray(m.soldGames) && m.soldGames.length
      ? m.soldGames
      : [String(m.claimedNote || "").replace(/^noclaim-farm:/i, "")];
    for (const g of games) {
      add(g, m.usernameLower || m.username, "manual_sold", { at: m.updatedAt });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Stock on hand
// ---------------------------------------------------------------------------

// Sellable stock, split by where it is sitting:
//
//   listed   — on an auto-listing right now
//   held     — status "skipped": holds its drops, deliberately on no listing
//              (over the per-game cap, or freed for manual bulk sale)
//   inFlight — claimed out of the pool for this game but not yet sellable, i.e.
//              still farming. Counting it is what stops the allocator ordering
//              the whole gap again every cycle while the last batch is still
//              working.
//
// `expired`/`released` are NOT stock: their drops are gone.
async function stockByBucket() {
  const keys = noClaimKeys();
  const out = new Map();
  const bump = (bucket, field, n = 1) => {
    if (!bucket) return;
    const cur =
      out.get(bucket) ||
      out.set(bucket, { listed: 0, held: 0, inFlight: 0, sold: 0, expired: 0 }).get(bucket);
    cur[field] += n;
  };

  const rows = await UnclaimedAccount.aggregate([
    { $group: { _id: { g: "$game", s: "$status" }, n: { $sum: 1 } } },
  ]);
  for (const r of rows) {
    const bucket = bucketFor(r._id.g, keys);
    if (!bucket) continue;
    if (r._id.s === "listed") bump(bucket, "listed", r.n);
    else if (r._id.s === "skipped") bump(bucket, "held", r.n);
    else if (r._id.s === "sold") bump(bucket, "sold", r.n);
    else if (r._id.s === "expired" || r._id.s === "released") bump(bucket, "expired", r.n);
  }

  // In flight: pool rows this system claimed, minus the ones that already have a
  // ledger row (those are counted above under their real status).
  const claimed = await AvailableAccount.find(
    { status: "claimed", claimedNote: /^noclaim-farm:/i, manualSold: { $ne: true } },
    { usernameLower: 1, claimedNote: 1 },
  ).lean();
  if (claimed.length) {
    const logins = claimed.map((c) => c.usernameLower).filter(Boolean);
    const known = new Set(
      (
        await UnclaimedAccount.find({ loginLower: { $in: logins } }, { loginLower: 1 }).lean()
      ).map((l) => l.loginLower),
    );
    for (const c of claimed) {
      if (known.has(c.usernameLower)) continue;
      bump(bucketFor(String(c.claimedNote || "").replace(/^noclaim-farm:/i, ""), keys), "inFlight");
    }
  }

  return out;
}

// Median hours from listing to sale, per bucket. The median, not the mean: a
// single account that sat unsold for a fortnight before a relist drags a mean
// far enough to hide that Rainbow Six clears in under two days.
async function timeToSaleByBucket({ days = 90 } = {}) {
  const keys = noClaimKeys();
  const since = new Date(Date.now() - Math.max(1, days) * DAY_MS);
  const rows = await UnclaimedAccount.find(
    { status: "sold", soldAt: { $gte: since }, listedAt: { $ne: null } },
    { game: 1, listedAt: 1, soldAt: 1 },
  ).lean();
  const buckets = new Map();
  for (const r of rows) {
    const b = bucketFor(r.game, keys);
    if (!b) continue;
    const hrs = (new Date(r.soldAt) - new Date(r.listedAt)) / 3600000;
    if (!Number.isFinite(hrs) || hrs < 0) continue;
    (buckets.get(b) || buckets.set(b, []).get(b)).push(hrs);
  }
  const out = new Map();
  for (const [b, list] of buckets) {
    list.sort((a, c) => a - c);
    const mid = Math.floor(list.length / 2);
    out.set(b, {
      n: list.length,
      medianHours:
        list.length % 2 ? list[mid] : Math.round(((list[mid - 1] + list[mid]) / 2) * 10) / 10,
      minHours: list[0],
      maxHours: list[list.length - 1],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The snapshot the allocator and the UI both read
// ---------------------------------------------------------------------------

// One row per no-claim game: what it sells, what it holds, how long that lasts,
// and what the sizing model says it should hold. Deliberately returns the
// EVIDENCE alongside the number — an operator has to be able to see why a game
// is being told to grow before they let anything act on it.
async function unclaimedDemandSnapshot({ days = 30, ttsDays = 90 } = {}) {
  const [sold, stock, tts] = await Promise.all([
    soldUnitsByBucket({ days }),
    stockByBucket(),
    timeToSaleByBucket({ days: ttsDays }),
  ]);
  const cfg = settings.getNoclaimSizing ? settings.getNoclaimSizing() : {};
  const keys = noClaimKeys();
  const rows = [];

  for (const key of keys) {
    const units = sold.get(key) || new Map();
    const st = stock.get(key) || { listed: 0, held: 0, inFlight: 0, sold: 0, expired: 0 };
    const t = tts.get(key) || null;

    let revenue = 0;
    let priced = 0;
    const bySource = {};
    const byMarket = {};
    for (const u of units.values()) {
      if (u.priceUsd > 0) {
        revenue += u.priceUsd;
        priced++;
      }
      for (const s of u.sources) bySource[s] = (bySource[s] || 0) + 1;
      if (u.market) byMarket[u.market] = (byMarket[u.market] || 0) + 1;
    }
    const count = units.size;
    const avgPrice = priced ? Math.round((revenue / priced) * 100) / 100 : 0;
    const perWeek = Math.round(sizing.salesPerWeek(count, days) * 10) / 10;

    const coverageDays = numOr(cfg.coverageDaysFor && cfg.coverageDaysFor(key), cfg.coverageDays);
    const safetyStock = numOr(cfg.safetyStockFor && cfg.safetyStockFor(key), cfg.safetyStock);
    const min = numOr(cfg.minFor && cfg.minFor(key), 0);
    const max = numOr(cfg.maxFor && cfg.maxFor(key), sizing.HARD_MAX_ACCOUNTS);

    const target = sizing.coverageTarget({
      salesPerWeek: perWeek,
      coverageDays,
      safetyStock,
      min,
      max,
    });
    const onHand = st.listed + st.held;
    const gap = sizing.stockGap({ target, onHand, inFlight: st.inFlight });
    const cover = sizing.daysOfCover({ onHand, salesPerWeek: perWeek });

    rows.push({
      key,
      label: bucketLabel(key),
      windowDays: days,
      sales: { count, perWeek, revenue: Math.round(revenue * 100) / 100, avgPrice, priced, bySource, byMarket },
      stock: st,
      onHand,
      timeToSale: t,
      daysOfCover: Number.isFinite(cover) ? Math.round(cover * 10) / 10 : null,
      policy: { coverageDays, safetyStock, min, max },
      ...gap,
      weight: sizing.revenueWeight({ salesPerWeek: perWeek, avgPrice }),
    });
  }

  rows.sort((a, b) => b.sales.perWeek - a.sales.perWeek || b.need - a.need);
  return rows;
}

function numOr(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : Number(dflt) || 0;
}

// ---------------------------------------------------------------------------
// The auto-farm side: the same weekly rate, for any game
// ---------------------------------------------------------------------------

// Sales per week for ONE game, over `days`, deduped the way the auto-farmer
// dedupes: by account when there is one, by dedupeKey when there is not.
// Matched on the normalised label so "Overwatch 2" and "Overwatch" agree, which
// the auto-farmer's raw `gameKey` equality does not.
async function salesRateForGame(game, { days = sizing.DEFAULT_SALES_WINDOW_DAYS } = {}) {
  const want = settings.normGameName(game);
  if (!want) return { count: 0, perWeek: 0, avgPrice: 0, revenue: 0 };
  const since = new Date(Date.now() - Math.max(1, days) * DAY_MS);
  const rows = await SaleSignal.aggregate([
    { $match: { at: { $gte: since }, source: { $in: REAL_SALE_SOURCES } } },
    {
      $group: {
        _id: { g: "$gameKey", k: { $ifNull: ["$account", "$dedupeKey"] } },
        priceUsd: { $max: { $ifNull: ["$priceUsd", 0] } },
      },
    },
  ]);
  let count = 0;
  let revenue = 0;
  let priced = 0;
  for (const r of rows) {
    if (settings.normGameName(r._id.g) !== want) continue;
    count++;
    if (r.priceUsd > 0) {
      revenue += r.priceUsd;
      priced++;
    }
  }
  return {
    count,
    perWeek: Math.round(sizing.salesPerWeek(count, days) * 10) / 10,
    revenue: Math.round(revenue * 100) / 100,
    avgPrice: priced ? Math.round((revenue / priced) * 100) / 100 : 0,
  };
}

module.exports = {
  REAL_SALE_SOURCES,
  noClaimKeys,
  bucketFor,
  bucketLabel,
  soldUnitsByBucket,
  stockByBucket,
  timeToSaleByBucket,
  unclaimedDemandSnapshot,
  salesRateForGame,
};
