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

function createRouter({ getReport = T.getReport, guards = [], settingsFees = () => ({}) } = {}) {
  const router = express.Router();
  const wrap = (fn) => async (req, res) => {
    try {
      let force = false;
      if (req.query.force === "1" && Date.now() - lastForce > FORCE_COOLDOWN_MS) {
        lastForce = Date.now();
        force = true;
      }
      const report = await getReport({ force, fees: settingsFees() });
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
      .slice(0, 200);
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
    rows = [...rows].sort((a, b) => b.at - a.at);
    const suspect = req.query.suspect === "1";
    if (suspect) {
      const sus = (r.ledger.suspect || []).filter((s) => !market || s.market === market).sort((a, b) => b.at - a.at);
      return res.json({ success: true, suspect: true, ...page(sus, req.query, 50) });
    }
    res.json({ success: true, ...page(rows, req.query, 50) });
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

  return router;
}

module.exports = createRouter;
module.exports.createRouter = createRouter;
// The real, guarded router. Lazy so requiring this file never loads the auth
// stack (the preview harness and the tests run without it).
module.exports.real = () => {
  const { requireSuperadmin, enforce2fa } = require("../middleware/auth");
  return createRouter({
    guards: [requireSuperadmin, enforce2fa],
    settingsFees: () => {
      try {
        const s = require("../utils/settings").loadSettings();
        return (s && s.priceTracker && s.priceTracker.fees) || {};
      } catch {
        return {};
      }
    },
  });
};
