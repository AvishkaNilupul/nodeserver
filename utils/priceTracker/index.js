// Price tracker entry point: load evidence, build one report, serve questions.
//
// This is the ONE place that knows how to read the shop's sale evidence for
// pricing. It is READ-ONLY by construction: no function here writes to Mongo, and
// nothing calls a marketplace. Applying advice is a separate, owner-approved act
// (and, for the auto-farm, a later, deliberate wiring — see suggestForNew).
const { buildLedger } = require("./ledger");
const { identify } = require("./setIdentity");
const A = require("./analyze");
const { MARKETS, VENUES } = require("./venues");
const { median, DAY } = require("./stats");

const CACHE_MS = 5 * 60 * 1000;
const READ_CAP = 20000;
let cache = { at: 0, report: null };
let inflight = null;

/* ----------------------------------- load ---------------------------------- */

// Bounded, projected reads (Atlas shared tier: the cost is bytes returned).
// Models are required lazily so tests and the snapshot preview never need Mongo.
async function loadFromDb({ now = Date.now() } = {}) {
  const MarketplaceListing = require("../../models/MarketplaceListing");
  const SaleSignal = require("../../models/SaleSignal");
  const DropSet = require("../../models/DropSet");
  const since = new Date(now - 365 * DAY);
  const listings = await MarketplaceListing.find(
    { marketplace: { $in: MARKETS } },
    {
      marketplace: 1, externalId: 1, origin: 1, title: 1, price: 1, status: 1, set: 1,
      unclaimedGame: 1, rentFarm: 1, bulkOfferId: 1, unitsSold: 1, createdAt: 1,
      updatedAt: 1, venueMinPriceUsd: 1, "units.deliveredAt": 1, "units.orderId": 1,
    },
  )
    .sort({ _id: -1 })
    .limit(READ_CAP)
    .lean();
  const signals = await SaleSignal.find(
    { source: "listing_sold", at: { $gte: since } },
    { marketplace: 1, game: 1, gameKey: 1, name: 1, priceUsd: 1, bulk: 1, dedupeKey: 1, at: 1 },
  )
    .sort({ at: -1 })
    .limit(READ_CAP)
    .lean();
  const ids = [...new Set(listings.map((l) => l.set && String(l.set)).filter(Boolean))];
  const sets = [];
  // Chunked $in: one giant id list is a large request body on a shared tier.
  for (let i = 0; i < ids.length; i += 500) {
    const part = await DropSet.find(
      { _id: { $in: ids.slice(i, i + 500) } },
      { name: 1, price: 1, minPriceUsd: 1, "items.itemKey": 1, "items.game": 1, "items.qty": 1, "items.name": 1 },
    ).lean();
    sets.push(...part);
  }
  // A read that hits its cap silently drops the OLDEST rows; say so, on the page.
  const truncated = listings.length >= READ_CAP || signals.length >= READ_CAP;
  return { listings, signals, sets, at: new Date(now), truncated };
}

function loadFromSnapshot(file) {
  const d = JSON.parse(require("fs").readFileSync(file, "utf8"));
  return { listings: d.listings, signals: d.signals, sets: d.sets, at: new Date(d.at) };
}

/* ---------------------------------- report --------------------------------- */

function buildReport(input, { now = null, fees = {} } = {}) {
  const t = now || (input.at ? new Date(input.at).getTime() : Date.now());
  const ledger = buildLedger(input);
  const prepared = A.prepare({ listings: input.listings, sets: input.sets, sales: ledger.sales });
  const venues = A.venueSummary({ sales: ledger.sales, prepared, now: t, fees });
  const advice = A.advise({ sales: ledger.sales, prepared, now: t, fees });
  const board = A.setBoard({ sales: ledger.sales, prepared, now: t, fees });
  const curves = advice.curves;
  const report = {
    truncated: !!input.truncated,
    at: new Date(t),
    markets: MARKETS,
    ledger,
    prepared,
    venues,
    advice: advice.rows,
    board,
    curves,
    ctx: { sales: ledger.sales, now: t, tr: advice.tr, fees, curves },
    fees,
  };
  report.insights = insightsFor(report);
  return report;
}

// The headline findings, each with the evidence it stands on. Plain statements a
// person can check against the tabs, never a score.
function insightsFor(r) {
  const out = [];
  if (r.truncated) {
    out.push({
      id: "truncated",
      level: "warn",
      title: "The data read hit its row cap",
      detail: "Only the newest " + READ_CAP + " rows were read, so older history is missing and every figure here is incomplete.",
    });
  }
  const suspect = r.ledger.suspect || [];
  if (suspect.length) {
    const by = suspect.reduce((m, s) => ((m[s.market] = (m[s.market] || 0) + 1), m), {});
    out.push({
      id: "mass-close",
      level: "warn",
      title: "Some recorded “sales” are really delists",
      detail:
        suspect.length +
        " sale signals (" +
        Object.entries(by).map(([m, n]) => m + " " + n).join(", ") +
        ") were written in bursts of 8+ within five minutes, or within seconds of their listing being delisted: a mass delist or a bulk mark-sold, not purchases. They are set aside here and never enter a price. The existing pricing evidence (utils/pricingEvidence.js) still counts them.",
    });
  }
  for (const v of r.venues) {
    if (v.realised.n >= 10 && v.askVsRealisedPct != null && v.askVsRealisedPct >= 40) {
      out.push({
        id: "ask-gap:" + v.market,
        level: "info",
        title: v.label + ": we ask more than we have ever realised",
        detail:
          "Live asking median $" + v.live.askMedian.toFixed(2) + " vs realised median $" + v.realised.median.toFixed(2) +
          " over " + v.realised.n + " sales (" + v.askVsRealisedPct + "% higher). Check the price curve before assuming the market will pay it.",
      });
    }
    if (v.realised.n >= 10 && v.atFloorShare >= 0.5 && v.floorUsd > 0) {
      out.push({
        id: "at-floor:" + v.market,
        level: "info",
        title: v.label + ": most sales happen at the platform minimum",
        detail:
          Math.round(v.atFloorShare * 100) + "% of " + v.realised.n + " sales were at or within 5% of the $" + v.floorUsd.toFixed(2) +
          " floor — the floor is doing the price discovery, so there is no evidence about higher prices there.",
      });
    }
    if (v.approxShare >= 0.5 && v.realised.n) {
      out.push({
        id: "approx:" + v.market,
        level: "info",
        title: v.label + ": prices are the listing price now, not the price at sale",
        detail:
          Math.round(v.approxShare * 100) + "% of its " + v.realised.n + " sales come from delivered units, which store an order id but not a price. A repriced listing changes its past revenue.",
      });
    }
  }
  for (const m of ["gameflip", "zeusx"]) {
    const c = r.curves[m];
    if (!c || !c.best) continue;
    const best = c.bins.find((b) => b.label === c.best);
    const live = r.advice.filter((a) => a.market === m && a.origin === "auto");
    if (!best || !live.length) continue;
    const weaker = c.bins.filter((b) => !b.thin && b.expectedRevenueLow != null && b.expectedRevenueLow < best.expectedRevenueLow * 0.6);
    const inWeak = live.filter((a) => weaker.some((b) => A.BIN_LABELS.indexOf(b.label) === binIndex(a.current)));
    if (inWeak.length >= 5) {
      out.push({
        id: "curve:" + m,
        level: "opportunity",
        title: m + ": " + inWeak.length + " live auto listings sit where listings earn the least",
        detail:
          "Auto listings priced in the " + best.label + " range earned the most per listing here ($" + best.expectedRevenueLow.toFixed(2) +
          " at the conservative end vs under $" + (best.expectedRevenueLow * 0.6).toFixed(2) + " for the weaker ranges below). " +
          inWeak.length + " of " + live.length + " live auto listings are priced in those weaker ranges. This is a correlation (see the caveat on the curve), so test on a few before moving many.",
      });
    }
  }
  const multi = r.board.filter((b) => b.marketsWithSales >= 2 && b.spread);
  if (multi.length) {
    out.push({
      id: "cross-market",
      level: "info",
      title: multi.length + " exact sets have sold on 2+ markets",
      detail:
        "Median price spread between their cheapest and dearest market is ×" + median(multi.map((b) => b.spread)).toFixed(2) +
        ". These are the only like-for-like cross-market comparisons; everything else is translated.",
    });
  }
  if (r.ledger.quality.unattributedUnits) {
    out.push({
      id: "unattributed",
      level: "info",
      title: r.ledger.quality.unattributedUnits + " sold units have no priced record",
      detail: "Listings count these as sold (unitsSold) but no priced sale signal backs them, so their price is unknown and they are excluded from every average.",
    });
  }
  return out;
}

function binIndex(price) {
  const edges = [0.8, 1.1, 1.35, 1.6, 1.9, 2.4, 3.1, 4.1, Infinity];
  const i = edges.findIndex((e) => price <= e + 1e-9);
  return i < 0 ? edges.length - 1 : i;
}

/* ----------------------------------- cache --------------------------------- */

async function getReport({ force = false, loader = loadFromDb, fees = {} } = {}) {
  if (!force && cache.report && Date.now() - cache.at < CACHE_MS) return cache.report;
  // One load at a time: concurrent requests on a stale cache share it instead of
  // each reading Mongo (a bytes-bound shared tier).
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const input = await loader();
      const report = buildReport(input, { fees });
      cache = { at: Date.now(), report };
      return report;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function invalidate() {
  cache = { at: 0, report: null };
}

/* ------------------------------ for the auto-farm -------------------------- */

/**
 * What should a NEW listing cost on one market? The seam the auto-farm links to.
 *
 * NOT wired into autoLister / autoFarmBundles — wiring it is the deploy step,
 * after the owner has checked the advice against real listings. Until then this
 * is only reachable from the tracker's own API.
 *
 * @param {object} report  a buildReport()/getReport() result
 * @param {object} q       { market, game, itemCount, items:[{itemKey,game,qty}], title }
 */
function suggestForNew(report, q) {
  const market = String(q.market || "").toLowerCase();
  if (!VENUES[market]) return { price: 0, action: "insufficient", reasons: ["unknown market " + market] };
  const items = Array.isArray(q.items) ? q.items : [];
  const title =
    q.title ||
    (q.game ? q.game + " Twitch Drops" + (q.itemCount ? " (" + q.itemCount + " Items)" : "") : "");
  const id = identify({ title }, items.length ? { items } : null);
  if (VENUES[market].blocked) {
    return { price: 0, action: "blocked", confidence: "none", reasons: ["market blocked by owner"], market };
  }
  const rec = A.recommend(report.ctx, {
    market,
    id,
    currentPrice: 0,
    setMinUsd: Number(q.minPriceUsd) || 0,
    venueMinUsd: Number(q.venueMinPriceUsd) || 0,
    ageDays: 0,
  });
  return { ...rec, market, contentKey: id.contentKey, exact: id.exact };
}

module.exports = {
  buildReport,
  getReport,
  invalidate,
  loadFromDb,
  loadFromSnapshot,
  suggestForNew,
  insightsFor,
  CACHE_MS,
};
