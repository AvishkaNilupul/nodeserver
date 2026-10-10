// The seam between the price tracker and the auto-farm's PUBLISHERS.
//
// utils/autoLister.js decides ONE price per auto-farmed set (`derivePrice`, anchored
// on Gameflip's order book) and hands it to every market's publisher, with GGSel the
// only one that translates it (`venuePrice`). This module lets a publisher ask the
// tracker "what should this exact set cost on THIS market" instead — and it is built
// so that asking can never hurt a publish:
//
//   mode "off"     (the default) — returns the base price after one settings read.
//                  No database, no report, no log. This is what ships.
//   mode "shadow"  — computes the tracker's price, LOGS it beside the base price (and
//                  keeps the last 300 comparisons for the page), and still returns
//                  the BASE price. Run this for a week to see where they differ.
//   mode "apply"   — returns the tracker's price, but only when ALL of these hold:
//                    the market is on the owner's allowlist (default: none), the
//                    suggestion is at least `minConfidence` (default medium), it is
//                    NOT the engine fallback, and the change from the base price is
//                    within `maxDeviationPct` (default 35%; a larger move is clamped
//                    to that step, never skipped silently). Never below the market's
//                    floor (or a `minPriceUsd` the caller passes; the auto-lister's hook
//                    passes none, because an auto-farmed set's own minimum merely mirrors
//                    the GAMEFLIP price, which every other market deliberately undercuts).
//                    On GGSel it may only RAISE a price: GGSel enforces a per-category
//                    minimum price that is published nowhere, a refused price fails the
//                    publish, and a retry would reapply the same price.
//                    Never for a rent-farm title, never for a blocked market.
//
// EVERY failure returns the base price: a missing report, a slow database, a thrown
// error, a malformed answer. A tracker problem must never stop a listing.
//
// Config lives in settings `autoFarm.priceTracker` (settings.setAutoFarm audits the
// change):  { mode, markets: ["eldorado", ...], minConfidence, maxDeviationPct }
const { classifyKind } = require("../marketPricing");
const { VENUES, floorFor } = require("./venues");

const DEFAULTS = Object.freeze({
  mode: "off",
  markets: [],
  minConfidence: "medium",
  maxDeviationPct: 35,
});
const MODES = ["off", "shadow", "apply"];
const RANK = { none: 0, low: 1, medium: 2, high: 3 };
const RING_MAX = 300;

let ring = [];
const stats = { total: 0, applied: 0, byMarket: {} };

/** Normalise whatever is in settings into a safe config. Unknown values fall back. */
function normalise(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const mode = MODES.includes(String(r.mode)) ? String(r.mode) : DEFAULTS.mode;
  const markets = Array.isArray(r.markets)
    ? [...new Set(r.markets.map((m) => String(m).toLowerCase()).filter((m) => VENUES[m]))]
    : [];
  const minConfidence = RANK[String(r.minConfidence)] >= 2 ? String(r.minConfidence) : DEFAULTS.minConfidence;
  const dev = Number(r.maxDeviationPct);
  const maxDeviationPct = Number.isFinite(dev) && dev > 0 && dev <= 100 ? dev : DEFAULTS.maxDeviationPct;
  return { mode, markets, minConfidence, maxDeviationPct };
}

function readConfig() {
  try {
    const af = require("../settings").getAutoFarm() || {};
    return normalise(af.priceTracker);
  } catch {
    return { ...DEFAULTS, markets: [] };
  }
}

function record(entry) {
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();
  stats.total += 1;
  if (entry.applied) stats.applied += 1;
  const m = (stats.byMarket[entry.market] = stats.byMarket[entry.market] || { n: 0, applied: 0, higher: 0, lower: 0, same: 0, sumDeltaPct: 0, measured: 0 });
  m.n += 1;
  if (entry.applied) m.applied += 1;
  if (entry.tracker > 0 && entry.base > 0) {
    const d = ((entry.tracker - entry.base) / entry.base) * 100;
    m.measured += 1;
    m.sumDeltaPct += d;
    if (d > 3) m.higher += 1;
    else if (d < -3) m.lower += 1;
    else m.same += 1;
  }
}

function shadowSnapshot() {
  return {
    stats: {
      total: stats.total,
      applied: stats.applied,
      byMarket: Object.fromEntries(
        Object.entries(stats.byMarket).map(([k, v]) => [k, { ...v, avgDeltaPct: v.measured ? Math.round((v.sumDeltaPct / v.measured) * 10) / 10 : null }]),
      ),
    },
    recent: ring.slice(-100).reverse(),
  };
}

function reset() {
  ring = [];
  stats.total = 0;
  stats.applied = 0;
  stats.byMarket = {};
}

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {object} q { marketplace, basePriceUsd, title, game, itemCount, items, minPriceUsd }
 * @param {object} [deps] test seams: { getConfig, getReport, log }
 * @returns {Promise<{price:number, applied:boolean, mode:string, tracker:object|null, reason:string}>}
 */
async function priceForNew(q, deps = {}) {
  const base = Number(q && q.basePriceUsd) || 0;
  const market = String((q && q.marketplace) || "").toLowerCase();
  const out = { price: base, applied: false, mode: "off", tracker: null, reason: "" };
  try {
    const cfg = deps.getConfig ? deps.getConfig() : readConfig();
    out.mode = cfg.mode;
    if (cfg.mode === "off") return out;
    if (!(base > 0) || !VENUES[market]) {
      out.reason = "no base price or unknown market";
      return out;
    }
    if (VENUES[market].blocked) {
      out.reason = "market blocked by the owner";
      return out;
    }
    if (classifyKind(q.title) === "farm") {
      out.reason = "rent-farm listing (a different product)";
      return out;
    }
    const idx = require("./index");
    const report = deps.getReport ? await deps.getReport() : await idx.getReportSWR({ timeoutMs: 2500 });
    if (!report) {
      out.reason = "tracker still loading";
      record({ at: new Date().toISOString(), mode: cfg.mode, market, game: String(q.game || ""), title: String(q.title || "").slice(0, 90), base, tracker: 0, confidence: "none", basis: "tracker still loading", applied: false });
      return out;
    }
    const items = Array.isArray(q.items)
      ? q.items.map((i) => ({ itemKey: String((i && i.itemKey) || ""), game: String((i && i.game) || ""), qty: Number(i && i.qty) || 1 })).filter((i) => i.itemKey)
      : [];
    const sug = idx.suggestForNew(report, {
      market,
      game: q.game,
      title: q.title,
      itemCount: Number(q.itemCount) || items.length || 0,
      items,
      minPriceUsd: Number(q.minPriceUsd) || 0,
    });
    out.tracker = sug && sug.price > 0 ? { price: sug.price, confidence: sug.confidence, basis: sug.basis, source: sug.source, position: sug.position || "" } : null;

    let applied = false;
    let price = base;
    let why = "";
    if (cfg.mode === "apply") {
      if (!cfg.markets.includes(market)) why = "market not on the allowlist";
      else if (!out.tracker) why = "no tracker price";
      else if ((RANK[out.tracker.confidence] || 0) < RANK[cfg.minConfidence]) why = "confidence " + out.tracker.confidence + " is below " + cfg.minConfidence;
      else if (String(out.tracker.basis).indexOf("engine") === 0) why = "engine fallback is never applied";
      else {
        const lo = r2(base * (1 - cfg.maxDeviationPct / 100));
        const hi = r2(base * (1 + cfg.maxDeviationPct / 100));
        let p = out.tracker.price;
        if (p < lo) p = lo;
        if (p > hi) p = hi;
        const floor = Math.max(floorFor(market), Number(q.minPriceUsd) || 0);
        if (p < floor) p = floor;
        if (market === "ggsel" && p < base) p = base;
        p = r2(p);
        if (p > 0 && Math.abs(p - base) >= 0.005) {
          price = p;
          applied = true;
        } else why = market === "ggsel" && out.tracker.price < base ? "GGSel prices are never lowered (undisclosed category minimum)" : "already at the tracker's price";
      }
    }
    out.price = price;
    out.applied = applied;
    out.reason = why;
    const entry = { at: new Date().toISOString(), mode: cfg.mode, market, game: String(q.game || ""), title: String(q.title || "").slice(0, 90), base, tracker: out.tracker ? out.tracker.price : 0, confidence: out.tracker ? out.tracker.confidence : "none", basis: out.tracker ? out.tracker.basis : "", position: out.tracker ? out.tracker.position : "", applied, used: price, why };
    record(entry);
    (deps.log || console.log)(
      "[priceTracker:" + cfg.mode + "] " + market + " " + (q.game || "?") + " base $" + base.toFixed(2) + " tracker " + (out.tracker ? "$" + out.tracker.price.toFixed(2) + " (" + out.tracker.confidence + ", " + out.tracker.basis + ")" : "none") + (applied ? " -> APPLIED $" + price.toFixed(2) : " -> base kept" + (why ? " (" + why + ")" : "")),
    );
    return out;
  } catch (e) {
    out.price = base;
    out.applied = false;
    out.reason = "tracker error: " + (e && e.message ? e.message : e);
    return out;
  }
}

module.exports = { DEFAULTS, MODES, normalise, readConfig, priceForNew, shadowSnapshot, reset };
