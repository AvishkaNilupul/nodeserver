// Price tracker API. READ-ONLY, never calls a marketplace, never writes.
//
// Not mounted by server.js yet: this is the build-and-verify stage. To mount it
// (the deploy step, after the owner has checked the page against real listings):
//   app.use(enforce2fa, require("./routes/priceTrackerRoutes").real());
//
// Everything is served from ONE in-memory report (utils/priceTracker), cached
// five minutes, so paging and filtering cost nothing against Mongo — offset
// paging is exact and free on an in-memory array, which is why this file does
// not use the keyset cursors the console needs for its Mongo-backed tabs.
const express = require("express");
const T = require("../utils/priceTracker");
const G = require("../utils/priceTracker/games");
const { VENUES, MARKETS, feeFor } = require("../utils/priceTracker/venues");

const FORCE_COOLDOWN_MS = 60 * 1000;
let lastForce = 0;

function clamp(n, lo, hi, d) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return d;
  return Math.min(hi, Math.max(lo, v));
}

function page(rows, q, def = 50) {
  const limit = clamp(q.limit, 1, 200, def);
  const offset = clamp(q.offset, 0, 1e6, 0);
  return { total: rows.length, offset, limit, rows: rows.slice(offset, offset + limit) };
}

const CONF_W = { high: 3, medium: 2, low: 1, none: 0 };

// What a sale looks like on the wire. The ledger carries identity fields (login,
// logins, account, dedupeKey) that the analysis needs; the page does not, and a
// listing's `logins` is its whole delivery pool, which can include unsold stock.
// Whitelist instead of deleting, so a field added to the ledger later is private by
// default.
const SALE_FIELDS = [
  "key", "market", "listingId", "externalId", "orderId", "source", "confidence", "at", "priceUsd",
  "priceBasis", "priced", "title", "game", "gameKey", "itemCount", "exact", "titleMismatch", "origin",
];
function publicSale(s) {
  const o = {};
  for (const k of SALE_FIELDS) if (s[k] !== undefined) o[k] = s[k];
  return o;
}

function createRouter({ getReport = T.getReport, guards = [], settingsInputs = () => ({}), getMarketReport = null, marketStatus = null } = {}) {
  const router = express.Router();
  const wrap = (fn) => async (req, res) => {
    try {
      let force = false;
      if (req.query.force === "1" && Date.now() - lastForce > FORCE_COOLDOWN_MS) {
        lastForce = Date.now();
        force = true;
      }
      const report = await getReport({ force, ...settingsInputs() });
      await fn(req, res, report);
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  };
  const get = (path, fn) => router.get(path, ...guards, wrap(fn));

  get("/api/price-tracker/overview", (req, res, r) => {
    const suspect = r.ledger.suspect || [];
    res.json({
      success: true,
      at: r.at,
      venues: r.venues,
      insights: r.insights,
      quality: r.ledger.quality,
      excluded: r.ledger.excluded,
      skipped: r.prepared.skipped,
      suspect: {
        total: suspect.length,
        byMarket: suspect.reduce((m, s) => ((m[s.market] = (m[s.market] || 0) + 1), m), {}),
      },
      fees: Object.fromEntries(MARKETS.map((m) => [m, { ...feeFor(m, r.fees), label: VENUES[m].label, note: VENUES[m].note, repriceMode: VENUES[m].repriceMode }])),
      counts: {
        games: (r.games || []).filter((g) => g.own).length,
        sets: r.board.length,
        crossMarketSets: r.board.filter((b) => b.marketsWithSales >= 2).length,
        liveAdvised: r.advice.length,
      },
    });
  });

  get("/api/price-tracker/curve/:market", (req, res, r) => {
    const market = String(req.params.market || "").toLowerCase();
    if (!VENUES[market]) return res.status(400).json({ success: false, message: "unknown market" });
    const A = require("../utils/priceTracker/analyze");
    const origin = req.query.origin === "all" ? "" : req.query.origin === "manual" ? "manual" : "auto";
    const curve = origin === "auto" ? r.curves[market] : A.priceCurve({ market, prepared: r.prepared, now: r.ctx.now, origin });
    res.json({ success: true, curve, origin: origin || "all" });
  });

  get("/api/price-tracker/sets", (req, res, r) => {
    const market = String(req.query.market || "").toLowerCase();
    const q = String(req.query.q || "").toLowerCase().trim();
    const ev = String(req.query.evidence || "sold");
    let rows = r.board;
    if (market) rows = rows.filter((b) => b.markets[market]);
    if (q) rows = rows.filter((b) => (b.title + " " + b.game).toLowerCase().includes(q));
    if (ev === "cross") rows = rows.filter((b) => b.marketsWithSales >= 2);
    else if (ev === "sold") rows = rows.filter((b) => b.soldTotal > 0);
    else if (ev === "live") rows = rows.filter((b) => b.liveTotal > 0);
    // Light rows: counts and prices, not every live listing.
    const light = rows.map((b) => ({
      key: b.key,
      tier: b.tier,
      game: b.game,
      itemCount: b.itemCount,
      title: b.title,
      soldTotal: b.soldTotal,
      liveTotal: b.liveTotal,
      marketsWithSales: b.marketsWithSales,
      bestVenue: b.bestVenue,
      spread: b.spread,
      markets: Object.fromEntries(
        Object.entries(b.markets).map(([m, c]) => [m, { liveN: c.liveN, sold: c.sold, soldMedian: c.soldMedian, askMin: c.live.length ? c.live[0].price : 0, askMax: c.live.length ? c.live[c.live.length - 1].price : 0 }]),
      ),
    }));
    res.json({ success: true, ...page(light, req.query, 40) });
  });

  get("/api/price-tracker/set/:key", (req, res, r) => {
    const key = String(req.params.key || "");
    const g = r.board.find((b) => b.key === key);
    if (!g) return res.status(404).json({ success: false, message: "no such set" });
    const sales = r.ledger.sales
      .filter((s) => (s.exact ? s.contentKey : s.bandKey) === key)
      .sort((a, b) => b.at - a.at)
      .slice(0, 200)
      .map(publicSale);
    const advice = r.advice.filter((a) => (a.exact ? a.contentKey : "") === key);
    res.json({ success: true, set: g, sales, advice });
  });

  get("/api/price-tracker/advice", (req, res, r) => {
    const market = String(req.query.market || "").toLowerCase();
    const action = String(req.query.action || "");
    const conf = String(req.query.conf || "");
    const q = String(req.query.q || "").toLowerCase().trim();
    let rows = r.advice;
    if (market) rows = rows.filter((a) => a.market === market);
    if (action) rows = rows.filter((a) => a.action === action);
    else rows = rows.filter((a) => a.action === "raise" || a.action === "lower");
    if (conf) rows = rows.filter((a) => CONF_W[a.confidence] >= (CONF_W[conf] || 0));
    if (req.query.applicable === "1") rows = rows.filter((a) => a.applicable);
    if (q) rows = rows.filter((a) => (a.title + " " + a.game).toLowerCase().includes(q));
    rows = [...rows].sort((a, b) => CONF_W[b.confidence] * Math.abs(b.delta) - CONF_W[a.confidence] * Math.abs(a.delta));
    res.json({ success: true, ...page(rows, req.query, 40) });
  });

  get("/api/price-tracker/sales", (req, res, r) => {
    const market = String(req.query.market || "").toLowerCase();
    const source = String(req.query.source || "");
    const q = String(req.query.q || "").toLowerCase().trim();
    let rows = r.ledger.sales;
    if (market) rows = rows.filter((s) => s.market === market);
    if (source) rows = rows.filter((s) => s.source === source);
    if (q) rows = rows.filter((s) => (s.title + " " + s.orderId + " " + s.externalId).toLowerCase().includes(q));
    rows = [...rows].sort((a, b) => b.at - a.at).map(publicSale);
    const suspect = req.query.suspect === "1";
    if (suspect) {
      const sus = (r.ledger.suspect || []).filter((s) => !market || s.market === market).sort((a, b) => b.at - a.at);
      return res.json({ success: true, suspect: true, ...page(sus, req.query, 50) });
    }
    res.json({ success: true, ...page(rows, req.query, 50) });
  });

  get("/api/price-tracker/games", (req, res, r) => {
    const scope = String(req.query.scope || "own");
    const q = String(req.query.q || "").toLowerCase().trim();
    const direction = String(req.query.direction || "");
    const flag = String(req.query.flag || "");
    const sort = String(req.query.sort || "revenue");
    let rows = r.games || [];
    if (scope === "own") rows = rows.filter((g) => g.own);
    else if (scope === "market") rows = rows.filter((g) => !g.own && g.demand.market);
    if (q) rows = rows.filter((g) => g.game.toLowerCase().includes(q));
    if (direction) rows = rows.filter((g) => g.farm.direction === direction);
    if (flag) rows = rows.filter((g) => g.flags.some((f) => f.id === flag));
    const summary = {
      games: rows.length,
      weeklyRevenueUsd: Math.round(rows.reduce((a, g) => a + g.farm.weeklyRevenueUsd, 0) * 100) / 100,
      unitsPerWeek: Math.round(rows.reduce((a, g) => a + g.demand.perWeek, 0) * 10) / 10,
      byDirection: rows.reduce((m, g) => ((m[g.farm.direction] = (m[g.farm.direction] || 0) + 1), m), {}),
      inflated: rows.filter((g) => g.flags.some((f) => f.id === "inflated-demand")).length,
      sizing: rows.length ? rows[0].farm.sizing : null,
    };
    // A game the no-claim allocator or the reuse-only rule manages gets no farm
    // instruction, so it must not lead a shortfall / over-stock ranking either.
    const instructed = (g) => (g.farm.managed ? 0 : 1);
    const SORTS = {
      revenue: (g) => g.farm.weeklyRevenueUsd,
      demand: (g) => g.demand.units45,
      need: (g) => g.farm.need * instructed(g),
      spare: (g) => g.farm.spare * instructed(g),
      opportunity: (g) => (g.demand.market ? g.demand.market.opportunityScore : 0),
      market: (g) => (g.demand.market && g.demand.market.perWeek) || 0,
      gap: (g) => g.demand.engine.count45 - g.demand.units45,
      // Least stock cover first; a game with no sales (cover unknown) goes last.
      cover: (g) => (g.farm.daysCover == null ? -1e9 : -g.farm.daysCover),
    };
    const keyOf = Object.prototype.hasOwnProperty.call(SORTS, sort) ? SORTS[sort] : SORTS.revenue;
    rows = [...rows].sort((a, b) => keyOf(b) - keyOf(a));
    res.json({ success: true, summary, ...page(rows.map(G.lightRow), req.query, 30) });
  });

  get("/api/price-tracker/game/:key", (req, res, r) => {
    const key = String(req.params.key || "");
    const g = (r.games || []).find((x) => x.key === key);
    if (!g) return res.status(404).json({ success: false, message: "no such game" });
    const sets = r.advice
      .filter((a) => a.gameKey === key)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 15);
    const sales = r.ledger.sales
      .filter((s) => s.gameKey === key)
      .sort((a, b) => b.at - a.at)
      .slice(0, 15)
      .map(publicSale);
    res.json({ success: true, game: g, sets, sales, history: (r.taskHistory && r.taskHistory.get(key)) || [] });
  });

  // The auto-farm link: the current mode (from settings) and what the tracker has
  // said next to what the publishers actually used, since the last restart.
  get("/api/price-tracker/link", (req, res) => {
    const attach = require("../utils/priceTracker/attach");
    res.json({ success: true, config: attach.readConfig(), ...attach.shadowSnapshot() });
  });

  get("/api/price-tracker/suggest", (req, res, r) => {
    const out = T.suggestForNew(r, {
      market: req.query.market,
      game: req.query.game,
      itemCount: clamp(req.query.items, 1, 200, null),
      minPriceUsd: Number(req.query.minPriceUsd) || 0,
    });
    res.json({ success: true, suggestion: out });
  });

  mountMarketRadar(router, { guards, getMarketReport, marketStatus });
  return router;
}

// --------------------------------------------------------------------------------------------
// Market radar (utils/marketData, docs/MARKET-RADAR-PLAN.md): what OTHER sellers' buyers pay,
// who the rivals are, and which of our live listings have a cheaper comparable rival. Its own
// report and cache, the same guards, read-only like everything else in this file.
// --------------------------------------------------------------------------------------------
const MARKET_SORTS = {
  units: (g) => g.units,
  perWeek: (g) => g.perWeek,
  price: (g) => (g.realised && g.realised.median) || 0,
  // fastest first; a game with no time-to-sell goes last
  fast: (g) => (g.medianTtsHours == null ? -1e9 : -g.medianTtsHours),
  rivals: (g) => g.rivalsLive,
  undercut: (g) => g.undercut,
};

function lightMarketGame(g) {
  const byMarket = {};
  for (const [m, v] of Object.entries(g.byMarket || {})) {
    if (!(v.units || v.live || v.oursLive || v.oursSold)) continue;
    byMarket[m] = {
      units: v.units,
      perWeek: v.perWeek,
      soldMedian: v.sold && v.sold.n ? v.sold.median : null,
      soldN: (v.sold && v.sold.n) || 0,
      medianTtsHours: v.medianTtsHours,
      live: v.live,
      liveSellers: v.liveSellers,
      farmLive: v.farmLive || 0,
      askMedian: v.asking && v.asking.n ? v.asking.median : null,
      oursLive: v.oursLive,
      oursSold: v.oursSold,
    };
  }
  return {
    key: g.key,
    game: g.game,
    units: g.units,
    orders: g.orders,
    perWeek: g.perWeek,
    ratePartial: g.ratePartial,
    realised: g.realised,
    medianTtsHours: g.medianTtsHours,
    rivalsLive: g.rivalsLive,
    rivalSellers: g.rivalSellers,
    oursLive: g.oursLive,
    oursListed: g.oursListed,
    oursSold: g.oursSold,
    gameflipShare: g.gameflipShare,
    undercut: g.undercut,
    researchScannedAt: g.researchScannedAt || null,
    flags: g.flags,
    bands: g.bands,
    byMarket,
  };
}

function mountMarketRadar(router, { guards = [], getMarketReport, marketStatus } = {}) {
  const report = getMarketReport || ((o) => require("../utils/marketData/report").getReport(o));
  const radarStatus =
    marketStatus ||
    (() => {
      const radar = require("../utils/marketData");
      return { config: radar.readConfig(), status: radar.status() };
    });
  let lastForceM = 0;
  const wrapM = (fn) => async (req, res) => {
    try {
      let force = false;
      if (req.query.force === "1" && Date.now() - lastForceM > FORCE_COOLDOWN_MS) {
        lastForceM = Date.now();
        force = true;
      }
      const r = await report({ force, days: req.query.days });
      await fn(req, res, r);
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  };
  // Every market route is registered through one of these two helpers, both of which spread the
  // guards, so no route can be added without them (tests/priceTracker.test.js scans for it).
  const getM = (path, fn) => router.get(path, ...guards, wrapM(fn));
  const getPlain = (path, fn) =>
    router.get(path, ...guards, (req, res) => {
      try {
        fn(req, res);
      } catch (e) {
        res.status(500).json({ success: false, message: e.message });
      }
    });
  const q = (v) => String(v == null ? "" : v).toLowerCase().trim();

  getPlain("/api/price-tracker/market/status", (req, res) => {
    res.json({ success: true, ...radarStatus() });
  });

  getM("/api/price-tracker/market/overview", (req, res, r) => {
    res.json({
      success: true,
      generatedAt: r.generatedAt,
      windowDays: r.windowDays,
      coverage: r.coverage,
      truncated: r.truncated || {},
      markets: r.markets,
      radar: radarStatus(),
      topGames: r.games.slice(0, 8).map(lightMarketGame),
      topUndercuts: r.undercuts.slice(0, 5),
      topSellers: r.sellers.slice(0, 8),
      recentMoves: r.priceMoves.slice(0, 8),
      counts: { games: r.games.length, undercuts: r.undercuts.length, sellers: r.sellers.length, sales: r.feed.length, moves: r.priceMoves.length },
    });
  });

  getM("/api/price-tracker/market/games", (req, res, r) => {
    let rows = r.games;
    const s = q(req.query.q);
    const flag = String(req.query.flag || "");
    if (s) rows = rows.filter((g) => String(g.game).toLowerCase().includes(s));
    if (flag) rows = rows.filter((g) => g.flags.some((f) => f.id === flag));
    const key = Object.prototype.hasOwnProperty.call(MARKET_SORTS, req.query.sort) ? MARKET_SORTS[req.query.sort] : MARKET_SORTS.units;
    rows = [...rows].sort((a, b) => key(b) - key(a) || String(a.game).localeCompare(String(b.game)));
    res.json({ success: true, windowDays: r.windowDays, ...page(rows.map(lightMarketGame), req.query, 30) });
  });

  getM("/api/price-tracker/market/game/:key", (req, res, r) => {
    const key = String(req.params.key || "");
    const g = r.games.find((x) => x.key === key);
    if (!g) return res.status(404).json({ success: false, message: "no market data for this game" });
    const live = ((r.liveByGame && r.liveByGame.get(key)) || []).slice(0, 150);
    const allSales = r.feed.filter((x) => x.gameKey === key);
    const sales = allSales.slice(0, 40);
    // The rivals in THIS game: sales in the window and live listings, by market + seller.
    const by = new Map();
    const agg = (market, seller) => {
      const k = market + ":" + seller;
      if (!by.has(k)) by.set(k, { market, seller, units: 0, prices: [], live: 0 });
      return by.get(k);
    };
    // Every sale in the window counts toward a rival's units, not only the 40 shown.
    for (const x of allSales) if (!x.ours && x.kind !== "farm") {
      const a = agg(x.market, x.seller);
      a.units += x.units;
      a.prices.push(x.priceUsd);
    }
    for (const l of live) if (!l.ours && l.kind !== "farm") agg(l.market, l.seller).live++;
    const med = (a) => {
      const s2 = [...a].sort((x, y) => x - y);
      if (!s2.length) return null;
      const m = s2.length >> 1;
      return Math.round((s2.length % 2 ? s2[m] : (s2[m - 1] + s2[m]) / 2) * 100) / 100;
    };
    const sellers = [...by.values()]
      .map((a) => ({ market: a.market, seller: a.seller, units: a.units, medianPrice: med(a.prices), live: a.live }))
      .sort((a, b) => b.units - a.units || b.live - a.live)
      .slice(0, 20);
    res.json({
      success: true,
      windowDays: r.windowDays,
      game: g,
      live,
      sales,
      sellers,
      moves: r.priceMoves.filter((p) => p.gameKey === key).slice(0, 20),
      undercuts: r.undercuts.filter((u) => u.gameKey === key).slice(0, 50),
    });
  });

  getM("/api/price-tracker/market/rivals", (req, res, r) => {
    let rows = r.sellers;
    const market = String(req.query.market || "");
    const s = q(req.query.q);
    if (market) rows = rows.filter((x) => x.market === market);
    if (s) rows = rows.filter((x) => String(x.label).toLowerCase().includes(s));
    res.json({ success: true, windowDays: r.windowDays, ...page(rows, req.query, 50) });
  });

  getM("/api/price-tracker/market/sales", (req, res, r) => {
    let rows = r.feed;
    const market = String(req.query.market || "");
    const game = String(req.query.game || "");
    const s = q(req.query.q);
    if (market) rows = rows.filter((x) => x.market === market);
    if (game) rows = rows.filter((x) => x.gameKey === game);
    if (req.query.ours === "1") rows = rows.filter((x) => x.ours);
    else if (req.query.ours === "0") rows = rows.filter((x) => !x.ours);
    if (req.query.kind) rows = rows.filter((x) => x.kind === String(req.query.kind));
    if (s) rows = rows.filter((x) => (String(x.title) + " " + x.game + " " + x.seller).toLowerCase().includes(s));
    res.json({ success: true, windowDays: r.windowDays, ...page(rows, req.query, 50) });
  });

  getM("/api/price-tracker/market/undercuts", (req, res, r) => {
    let rows = r.undercuts;
    const market = String(req.query.market || "");
    const origin = String(req.query.origin || "");
    const s = q(req.query.q);
    if (market) rows = rows.filter((x) => x.market === market);
    if (origin) rows = rows.filter((x) => x.origin === origin);
    if (s) rows = rows.filter((x) => (String(x.title) + " " + x.game).toLowerCase().includes(s));
    res.json({ success: true, windowDays: r.windowDays, ...page(rows, req.query, 50) });
  });
}

module.exports = createRouter;
module.exports.createRouter = createRouter;
// The real, guarded router. Lazy so requiring this file never loads the auth
// stack (the preview harness and the tests run without it).
module.exports.real = () => {
  const { requireSuperadmin, enforce2fa } = require("../middleware/auth");
  // Settings (fees, farm sizing, per-game caps, no-claim and reuse-only games) are read
  // by utils/priceTracker itself on every rebuild, so a rebuild triggered anywhere —
  // this page or a publisher — sees the same ones.
  return createRouter({ guards: [requireSuperadmin, enforce2fa] });
};
