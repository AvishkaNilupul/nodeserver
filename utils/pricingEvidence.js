// Gathers the realised-sale evidence that utils/pricing.js prices against.
//
// Split from pricing.js on purpose: the math there is pure and unit-testable,
// and everything that touches Mongo lives here. That separation is the reason
// the $227 catalog bug could not have survived a test -- its math was buried
// inside a route handler with a database call in the middle of it.
//
// SHAPE OF THE READ
// Prod Mongo is an Atlas shared tier where the real cost is BYTES RETURNED
// (see the reference_atlas_no_diskuse note): concurrent queries serialise and
// large result sets dominate latency. So this does NOT query per listing.
// It builds ONE snapshot of the whole realised-price distribution, caches it,
// and answers every per-(game, marketplace) lookup from memory.
//
// SaleSignal is the primary source rather than MarketplaceListing because it
// is purpose-built for exactly this ("Training data for the auto-farmer: one
// document per observed sale evidence") and already carries gameKey +
// marketplace + priceUsd on one row, with no join. Sold MarketplaceListing
// rows are folded in as a second source for the platform/global buckets, where
// their missing game attribution does not matter.
const SaleSignal = require("../models/SaleSignal");
const MarketplaceListing = require("../models/MarketplaceListing");
// The one rent-farm classifier the repricers use (pure, no requires).
const { classifyKind } = require("./marketPricing");

// How far back a realised sale still counts as evidence of today's price.
// Long, because priced sales are scarce: only ~120 rows carry a price at all.
const WINDOW_MS = 180 * 86400000;
// Snapshot lifetime. Publishing runs in bursts, so a few minutes of staleness
// costs nothing and saves the aggregation on every listing in the burst.
const CACHE_MS = 10 * 60 * 1000;
// Hard cap on rows pulled, newest first. A safety valve on bytes returned.
const MAX_ROWS = 20000;

// Marketplaces whose fulfillers write no "listing_sold" SaleSignal at all
// (utils/farmDemand.js lists the gap). Their sales are on the books only as
// delivered units on the listing row — a unit with an orderId and a
// deliveredAt. Until 2026-10-01 they were invisible here: Eldorado's whole
// platform bucket was the 5 rows ever marked "sold", every one at $1.00, while
// more than a hundred units had sold there at up to ~$2.25 — so its venueFactor
// (and the no-claim repricer's Eldorado price) was built on five rows.
const UNIT_LEDGER_MARKETS = ["eldorado", "playerauctions", "g2g"];

// A rent-farm WINDOW is a different product from a drop bundle ($5–$8 for a
// farming term vs ~$1.25 for an account), and the owner prices it by hand. The
// "sold rows" source had no product filter, so three "… Automatic Farming 1
// Year" windows at $8.00 became Gameflip's bundle maximum — doubling the
// priceBand ceiling — and every farm sale leaned on the medians.
function isFarmSale(title) {
  return classifyKind(title) === "farm";
}

// One key per SALE for the venue-level buckets. Every writer of a priced
// "listing_sold" signal writes one per GAME the sale carried, at the full price:
//   recordListingSale (marketplaces)  "sold:<listingId>:<gameKey>:<seq>"
//   reserveSetOnAccount (Shop, bulk)  "reserved:<accountId>:<setId>:<game>"
//   a hand-recorded sale              "manual-sold:<accountId>:<game>"
// The per-game buckets want one entry per game (each game's own price);
// `platform` and `global` want one per sale, or a multi-game bundle counts once
// per game it carries.
function saleKeyOf(row, i) {
  const dk = String((row && row.dedupeKey) || "");
  const unit = /^sold:([0-9a-f]{24}):.*:(\d+)$/i.exec(dk);
  if (unit) return { key: "unit:" + unit[1].toLowerCase() + ":" + unit[2], listingId: unit[1].toLowerCase() };
  const shop = /^reserved:([0-9a-f]{24}):([0-9a-f]{24})?:/i.exec(dk);
  if (shop) return { key: "res:" + shop[1].toLowerCase() + ":" + String(shop[2] || "").toLowerCase(), listingId: "" };
  const hand = /^manual-sold:([0-9a-f]{24}):/i.exec(dk);
  if (hand) return { key: "hand:" + hand[1].toLowerCase(), listingId: "" };
  return { key: row && row._id ? "sig:" + String(row._id) : "row:" + i, listingId: "" };
}

let cache = { at: 0, snapshot: null };

function keyOf(marketplace, gameKey) {
  return String(marketplace || "").toLowerCase() + "|" + String(gameKey || "").toLowerCase();
}

function push(map, key, price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(p);
}

/**
 * Build the realised-price snapshot. Four buckets, matching pricing.js's
 * anchor ladder: platform+game, game, platform, global.
 *
 * Drop-bundle sales only. Three sources, each without rent-farm windows and
 * bulk packs (a pack is priced for N accounts):
 *   1. delivered units on Eldorado / PlayerAuctions / G2G rows, at the row's
 *      price — `platform`/`global` only. A row repriced since the sale is a
 *      small error in a level; leaving those markets out was the whole level;
 *   2. SaleSignal "listing_sold" with a price — the per-game buckets one entry
 *      per (game, unit); `platform`/`global` one per sale, unless the sale is a
 *      unit already counted in 1 (the Listings delist route records a signal
 *      for a row it closes as sold, on any market);
 *   3. rows marked "sold" — `platform`/`global` only (their game needs a
 *      DropSet join, deliberately skipped), never a row whose sale 1 or 2
 *      already counted.
 */
async function buildSnapshot() {
  const since = new Date(Date.now() - WINDOW_MS);
  const sinceMs = since.getTime();
  const platformGame = new Map();
  const game = new Map();
  const platform = new Map();
  const global = [];
  let farmSkipped = 0;

  // 1. The unit-ledger markets: one entry per delivered unit. updatedAt bounds
  // the read (a row whose unit was delivered inside the window was saved
  // inside it), newest first so the cap can only drop the oldest rows.
  const ledgerRows = await MarketplaceListing.find(
    {
      marketplace: { $in: UNIT_LEDGER_MARKETS },
      price: { $gt: 0 },
      bulkOfferId: null,
      rentFarm: { $ne: true },
      updatedAt: { $gte: since },
    },
    { marketplace: 1, price: 1, title: 1, "units.deliveredAt": 1, "units.orderId": 1 },
  )
    .sort({ _id: -1 })
    .limit(MAX_ROWS)
    .lean();

  const unitLedgerRows = new Set();
  let deliveredUnits = 0;
  for (const row of ledgerRows) {
    if (isFarmSale(row.title)) {
      farmSkipped++;
      continue;
    }
    const mkt = String(row.marketplace || "").toLowerCase();
    const price = Number(row.price) || 0;
    if (price <= 0 || !mkt) continue;
    for (const u of row.units || []) {
      if (!u || !u.orderId || !u.deliveredAt) continue;
      // This row's sales are its units, whichever side of the window they fall.
      unitLedgerRows.add(String(row._id).toLowerCase());
      if (!(new Date(u.deliveredAt).getTime() >= sinceMs)) continue;
      deliveredUnits++;
      global.push(price);
      push(platform, mkt, price);
    }
  }

  // 2. Priced sale signals.
  const signals = await SaleSignal.find(
    // bulk: discounted pack units never anchor single prices (docs/bulk-packs/CONTRACT.md)
    { source: "listing_sold", priceUsd: { $gt: 0 }, at: { $gte: since }, bulk: { $ne: true } },
    { marketplace: 1, gameKey: 1, priceUsd: 1, name: 1, dedupeKey: 1 },
  )
    .sort({ at: -1 })
    .limit(MAX_ROWS)
    .lean();

  const seenSale = new Set();
  const signalListings = new Set();
  signals.forEach((row, i) => {
    if (isFarmSale(row.name)) {
      farmSkipped++;
      return;
    }
    const mkt = String(row.marketplace || "").toLowerCase();
    const gk = String(row.gameKey || "").toLowerCase();
    const price = Number(row.priceUsd) || 0;
    if (price <= 0) return;
    if (gk) push(game, gk, price);
    if (mkt && gk) push(platformGame, keyOf(mkt, gk), price);
    const { key, listingId } = saleKeyOf(row, i);
    if (listingId) {
      signalListings.add(listingId);
      if (unitLedgerRows.has(listingId)) return;
    }
    if (seenSale.has(key)) return;
    seenSale.add(key);
    global.push(price);
    if (mkt) push(platform, mkt, price);
  });

  // 3. Sold listings carry a real transaction price and a marketplace, but
  // their game needs a DropSet join we deliberately skip. They therefore feed
  // only the two buckets that do not need a game.
  const sold = await MarketplaceListing.find(
    // bulkOfferId: bulk prices never anchor single listings (docs/bulk-packs/CONTRACT.md H10)
    {
      status: "sold",
      price: { $gt: 0 },
      updatedAt: { $gte: since },
      bulkOfferId: null,
      rentFarm: { $ne: true },
    },
    { marketplace: 1, price: 1, title: 1 },
  )
    .sort({ updatedAt: -1 })
    .limit(MAX_ROWS)
    .lean();

  let soldCounted = 0;
  for (const row of sold) {
    if (isFarmSale(row.title)) {
      farmSkipped++;
      continue;
    }
    const id = String(row._id || "").toLowerCase();
    // Its sale is already in, from its delivered units or its own signals.
    if (id && (unitLedgerRows.has(id) || signalListings.has(id))) continue;
    const mkt = String(row.marketplace || "").toLowerCase();
    const price = Number(row.price) || 0;
    if (price <= 0) continue;
    soldCounted++;
    global.push(price);
    if (mkt) push(platform, mkt, price);
  }

  return {
    at: Date.now(),
    platformGame,
    game,
    platform,
    global,
    counts: {
      signals: signals.length,
      soldListings: soldCounted,
      deliveredUnits,
      farmSkipped,
      games: game.size,
      platforms: platform.size,
    },
  };
}

/** Cached snapshot. `force` bypasses the cache (used by the audit CLI). */
async function snapshot({ force = false } = {}) {
  if (!force && cache.snapshot && Date.now() - cache.at < CACHE_MS) {
    return cache.snapshot;
  }
  const built = await buildSnapshot();
  cache = { at: Date.now(), snapshot: built };
  return built;
}

/** Drop the cache. Called after a reprice run so the next read sees new sales. */
function invalidate() {
  cache = { at: 0, snapshot: null };
}

/**
 * The evidence object utils/pricing.js expects, for one (game, marketplace).
 *
 * `research` is an optional MarketResearch row; its Gameflip signals stand in
 * as weak evidence when we have no realised sales of our own. `lowestOther`
 * is preferred over `lowest` because `lowest` is frequently OUR OWN listing --
 * anchoring on it makes the system undercut itself to the floor, which is how
 * every unclaimed row ended up pinned at $0.75.
 */
async function evidenceFor({ game = "", marketplace = "", research = null } = {}) {
  const snap = await snapshot();
  const gk = String(game || "").toLowerCase();
  const mkt = String(marketplace || "").toLowerCase();
  const markets = (research && research.markets) || {};
  const gf = markets.gameflip || {};

  // ONLY `lowestOther` may act as a rival. `gf.lowest` is the cheapest live
  // Gameflip listing INCLUDING OUR OWN, so anchoring on it means undercutting
  // ourselves by `undercutPct` on every run — a ratchet straight to the floor.
  // That is exactly how every unclaimed row ended up pinned at $0.75: the
  // cheapest live listing for the game WAS our own $0.75 row.
  //
  // `lowestOther` excludes our owner id and is deliberately 0 when every live
  // listing is ours. That 0 must fall through to the MEDIAN, never to `lowest`
  // — "we are the only seller" is an absence of competition, not a competitor
  // priced at whatever we happen to be charging today.
  //
  // AND ONLY WHEN WE ARE PRICING GAMEFLIP. `markets.gameflip` is Gameflip's
  // order book; `evidenceFor` was handing it to every caller regardless of the
  // `marketplace` argument, so a Gameflip competitor's asking price set the
  // price of a GGSel listing. Measured on prod 2026-09-09: it wanted to move a
  // live GGSel Madden NFL 27 row from $0.75 to $10.00 on the strength of a
  // Gameflip rival — on a venue whose highest realised sale ever is $3.00 and
  // whose median is $0.75. 62 of 64 GGSel rows were slated to RISE.
  //
  // The other venues do carry research (`markets.ggsel = {lowest, median, ...}`)
  // but NOT `lowestOther`, so their `lowest` includes OUR OWN rows — anchoring
  // on it is the self-undercut ratchet this very comment warns about, and their
  // `median` is contaminated the same way (our 204 live rows are in it). Until a
  // venue can exclude our own listings, its research is not rival evidence. The
  // venue's REALISED sales (the `platform` bucket below) are, and they are
  // already in the ladder.
  const onGameflip = !mkt || mkt === "gameflip";
  const rivalLowest =
    onGameflip && Number(gf.lowestOther) > 0 ? Number(gf.lowestOther) : 0;

  return {
    platformGame: snap.platformGame.get(keyOf(mkt, gk)) || [],
    game: snap.game.get(gk) || [],
    platform: snap.platform.get(mkt) || [],
    global: snap.global,
    rivalLowest,
    researchMedian:
      onGameflip && Number(gf.median) > 0 ? Number(gf.median) : 0,
    // Which venue this evidence was built for, so the pricer can tell a
    // venue-specific bucket from a cross-market one.
    marketplace: mkt,
  };
}

module.exports = {
  CACHE_MS,
  WINDOW_MS,
  UNIT_LEDGER_MARKETS,
  buildSnapshot,
  evidenceFor,
  invalidate,
  snapshot,
};
