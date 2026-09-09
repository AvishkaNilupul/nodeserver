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

// How far back a realised sale still counts as evidence of today's price.
// Long, because priced sales are scarce: only ~120 rows carry a price at all.
const WINDOW_MS = 180 * 86400000;
// Snapshot lifetime. Publishing runs in bursts, so a few minutes of staleness
// costs nothing and saves the aggregation on every listing in the burst.
const CACHE_MS = 10 * 60 * 1000;
// Hard cap on rows pulled, newest first. A safety valve on bytes returned.
const MAX_ROWS = 20000;

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
 */
async function buildSnapshot() {
  const since = new Date(Date.now() - WINDOW_MS);
  const platformGame = new Map();
  const game = new Map();
  const platform = new Map();
  const global = [];

  const signals = await SaleSignal.find(
    { source: "listing_sold", priceUsd: { $gt: 0 }, at: { $gte: since } },
    { marketplace: 1, gameKey: 1, priceUsd: 1 },
  )
    .sort({ at: -1 })
    .limit(MAX_ROWS)
    .lean();

  for (const row of signals) {
    const mkt = String(row.marketplace || "").toLowerCase();
    const gk = String(row.gameKey || "").toLowerCase();
    const price = Number(row.priceUsd) || 0;
    if (price <= 0) continue;
    global.push(price);
    if (gk) push(game, gk, price);
    if (mkt) push(platform, mkt, price);
    if (mkt && gk) push(platformGame, keyOf(mkt, gk), price);
  }

  // Sold listings carry a real transaction price and a marketplace, but their
  // game needs a DropSet join we deliberately skip. They therefore feed only
  // the two buckets that do not need a game.
  const sold = await MarketplaceListing.find(
    { status: "sold", price: { $gt: 0 }, updatedAt: { $gte: since } },
    { marketplace: 1, price: 1 },
  )
    .sort({ updatedAt: -1 })
    .limit(MAX_ROWS)
    .lean();

  for (const row of sold) {
    const mkt = String(row.marketplace || "").toLowerCase();
    const price = Number(row.price) || 0;
    if (price <= 0) continue;
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
      soldListings: sold.length,
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
  buildSnapshot,
  evidenceFor,
  invalidate,
  snapshot,
};
