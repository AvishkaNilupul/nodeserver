// Market radar — the bounded loader and the report cache behind the "Market radar" tab.
// Read-only: every query is projected, limited and served by an index (no skip, no allowDiskUse),
// and a truncated read is reported on the page instead of silently passing for the whole market.
const { buildMarketReport } = require("./analyze");

const DAY = 86400000;
const SALES_HORIZON_DAYS = 120;
const RIVALS_HORIZON_DAYS = 45;
const MAX_SALES = 40000;
const MAX_RIVALS = 40000;
const MAX_OWN = 5000;
const TTL_MS = 10 * 60 * 1000;
const WINDOWS = [7, 30, 90];

const SALE_PROJ = {
  market: 1, listingId: 1, game: 1, gameKey: 1, title: 1, itemCount: 1, kind: 1, priceUsd: 1, units: 1, seller: 1,
  sellerName: 1, sellerScore: 1, sellerRatings: 1, soldAt: 1, prevObservedAt: 1, ttsHours: 1, source: 1, ours: 1, firstSeenAt: 1,
};
const RIVAL_PROJ = {
  market: 1, listingId: 1, game: 1, gameKey: 1, title: 1, itemCount: 1, kind: 1, seller: 1, sellerName: 1, sellerScore: 1,
  sellerRatings: 1, priceUsd: 1, priceHistory: { $slice: -2 }, counter: 1, ours: 1, firstSeenAt: 1, lastSeenAt: 1, goneAt: 1, outcome: 1,
};

async function loadFromDb({ now = Date.now(), models } = {}) {
  const M = models || {
    MarketSale: require("../../models/MarketSale"),
    MarketRival: require("../../models/MarketRival"),
    MarketplaceListing: require("../../models/MarketplaceListing"),
    MarketResearch: require("../../models/MarketResearch"),
  };
  const [sales, rivals, ownListings, research] = await Promise.all([
    M.MarketSale.find({ soldAt: { $gte: new Date(now - SALES_HORIZON_DAYS * DAY) } }, SALE_PROJ).sort({ soldAt: -1 }).limit(MAX_SALES).lean(),
    M.MarketRival.find({ lastSeenAt: { $gte: new Date(now - RIVALS_HORIZON_DAYS * DAY) } }, RIVAL_PROJ).sort({ lastSeenAt: -1 }).limit(MAX_RIVALS).lean(),
    M.MarketplaceListing.find({ status: "active", marketplace: { $in: ["gameflip", "ggsel"] } }, { marketplace: 1, externalId: 1, title: 1, price: 1, origin: 1, bulkOfferId: 1, rentFarm: 1 }).limit(MAX_OWN).lean(),
    M.MarketResearch.find({}, { game: 1, scannedAt: 1 }).limit(2000).lean(),
  ]);
  return {
    sales,
    rivals,
    ownListings,
    research,
    truncated: { sales: sales.length >= MAX_SALES, rivals: rivals.length >= MAX_RIVALS, own: ownListings.length >= MAX_OWN },
  };
}

const cache = new Map(); // windowDays -> { at, report, inflight }
// ONE database read serves all three windows (each window is only a different cut of it).
const inputCache = { at: 0, input: null, inflight: null };

function windowOf(days) {
  const n = parseInt(days, 10);
  return WINDOWS.includes(n) ? n : 30;
}

function getInput(loader, force) {
  if (!force && inputCache.input && Date.now() - inputCache.at < TTL_MS) return Promise.resolve(inputCache.input);
  if (!inputCache.inflight) {
    inputCache.inflight = Promise.resolve()
      .then(() => loader({}))
      .then((input) => {
        inputCache.input = input;
        inputCache.at = Date.now();
        return input;
      })
      .finally(() => {
        inputCache.inflight = null;
      });
    inputCache.inflight.catch(() => {});
  }
  return inputCache.inflight;
}

async function build(windowDays, loader, statusFn, force) {
  const input = await getInput(loader, force);
  // Let anything queued run between the database reads and the CPU work.
  await new Promise((r) => setImmediate(r));
  const report = buildMarketReport(input, { windowDays });
  report.truncated = input.truncated || {};
  report.status = statusFn ? statusFn() : null;
  return report;
}

/**
 * The report for a window (7 / 30 / 90 days). Stale-while-revalidate: a cached report older than
 * TTL is returned at once while ONE rebuild runs in the background; the very first call waits.
 */
async function getReport({ force = false, days = 30, loader = loadFromDb, statusFn = () => require("./index").status() } = {}) {
  const windowDays = windowOf(days);
  const c = cache.get(windowDays) || { at: 0, report: null, inflight: null };
  cache.set(windowDays, c);
  const stale = !c.report || Date.now() - c.at >= TTL_MS;
  if (!stale && !force) return c.report;
  if (!c.inflight) {
    c.inflight = build(windowDays, loader, statusFn, force)
      .then((report) => {
        c.report = report;
        c.at = Date.now();
        return report;
      })
      .finally(() => {
        c.inflight = null;
      });
    // A background rebuild that fails must not surface as an unhandled rejection.
    c.inflight.catch(() => {});
  }
  if (c.report && !force) return c.report;
  return c.inflight;
}

function invalidate() {
  cache.clear();
  inputCache.at = 0;
  inputCache.input = null;
  inputCache.inflight = null;
}

module.exports = { loadFromDb, getReport, invalidate, windowOf, SALE_PROJ, RIVAL_PROJ, MAX_SALES, MAX_RIVALS, TTL_MS, WINDOWS };
