// The reference price of an offer on a market (docs/LISTING-BRAIN-PLAN.md §4.2): what buyers
// demonstrably pay for these items there, with the tracker's confidence rules.
//
// The cascade, first step that gives a price wins:
//   1 exact-here  this exact offer, this market, ≥ 3 orders        high (medium where price = listing now)
//   2 band-here   same game + size band, this market, ≥ 3 orders   medium with ≥ 8 orders, else low
//   3 translated  the exact offer (else the band) on other markets, each market's median scaled by the
//                 tracker's translator                             medium on ≥ 2 markets, else low
//   4 rivals      rivals' sold median, game + radar band, here (Gameflip / GGSel), ≥ 3 sales  low
//   5 venue       this market's median over every order           none
// A price earned elsewhere is TRANSLATED, never copied; a blocked market never teaches another one.
// Every step reads ONE farm's orders (H5): the claim farm sells accounts whose drops are claimed, the
// no-claim farm accounts whose drops vanish with the wave — different products, never one price pool.
// A translated, rivals' or venue anchor is capped by what buyers paid for THIS game here (H11); fewer
// than 3 orders is no estimate anywhere (C10).
//
// PURE. Memoised per run on ev._ref by farm | market | offer | band | game.
const U = require("./util");

const { MARKETS, LISTING_NOW, num, round2 } = U;

// Radar size bands (utils/marketData/plan.js RADAR_BANDS — not requirable here; same edges): the
// tracker's bands below 31, the top split so a 148-item collection never shares a median with a 40.
const RADAR_BANDS = [
  { name: "1", min: 1, max: 1 },
  { name: "2-3", min: 2, max: 3 },
  { name: "4-6", min: 4, max: 6 },
  { name: "7-12", min: 7, max: 12 },
  { name: "13-30", min: 13, max: 30 },
  { name: "31-99", min: 31, max: 99 },
  { name: "100+", min: 100, max: Infinity },
];
function radarBand(n) {
  const c = Number(n);
  if (n === null || n === undefined || n === "" || !Number.isFinite(c) || c < 1) return "?";
  const b = RADAR_BANDS.find((x) => c >= x.min && c <= x.max);
  return b ? b.name : "?";
}

// Orders needed for a step 1/2/4 estimate, and for "medium" band evidence.
const MIN_ORDERS = 3;
const BAND_MEDIUM_ORDERS = 8;
// A market needs this many band orders to be translated from (the tracker's own rule).
const BAND_TRANSLATE_MIN = 2;
// A venue p75 is the market's own when it has this many orders, else every market's.
const P75_MIN_ORDERS = 10;
// The fallback cap on an anchor no order of this game here supports: this many times its source median.
const SOURCE_CAP_MULT = 1.5;
const farmOf = (f) => (f === "noclaim" ? "noclaim" : "claim");

/**
 * { n, median, p25, p75, max } of a list of orders (or prices) — stats.band's conventions exactly
 * (positives only, nearest-rank quantiles, the median rounded to the cent), sorted once: band()
 * re-sorts for every figure, and this runs thousands of times a run.
 */
function orderStats(list) {
  const a = [];
  for (const o of list || []) {
    const p = typeof o === "number" ? o : num(o && o.p);
    if (Number.isFinite(p) && p > 0) a.push(p);
  }
  if (!a.length) return { n: 0, median: 0, p25: 0, p75: 0, max: 0 };
  a.sort((x, y) => x - y);
  const n = a.length;
  const q = (f) => a[Math.min(n - 1, Math.floor(f * n))];
  const mid = n >> 1;
  const median = round2(n % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2);
  return { n, median, p25: q(0.25), p75: q(0.75), max: a[n - 1] };
}

/**
 * The last-resort cap on a price this market has not itself paid for these items: the p75 of the
 * farm's own orders here when it has ≥ 10, else of every non-blocked market's orders of the farm (the
 * tracker's venue / global p75).
 */
function marketP75(ev, m, f = "claim") {
  const F = farmOf(f);
  const key = "p75|" + F + "|" + m;
  if (ev._memo && ev._memo.has(key)) return ev._memo.get(key);
  const own = ev.idx.byM.get(F + "|" + m) || [];
  let v;
  if (own.length >= P75_MIN_ORDERS) v = statsOf(ev, "byM", F + "|" + m).p75;
  else {
    const all = [];
    for (const mk of MARKETS) if (!ev.markets[mk].blocked) for (const o of ev.idx.byM.get(F + "|" + mk) || []) all.push(o.p);
    v = orderStats(all).p75;
  }
  const out = v > 0 ? v : null;
  if (ev._memo) ev._memo.set(key, out);
  return out;
}

/** orderStats of an index list, memoised per run (the venue list is every order on a market). */
function statsOf(ev, idxName, key) {
  const k = "st|" + idxName + "|" + key;
  if (ev._memo && ev._memo.has(k)) return ev._memo.get(k);
  const v = orderStats(ev.idx[idxName].get(key) || []);
  if (ev._memo) ev._memo.set(k, v);
  return v;
}

/** The highest order price the farm has seen on a market (≤ $25 by the junk bound), null when none. */
function marketMax(ev, m, f = "claim") {
  const F = farmOf(f);
  const key = "max|" + F + "|" + m;
  if (ev._memo && ev._memo.has(key)) return ev._memo.get(key);
  const v = statsOf(ev, "byM", F + "|" + m).max;
  const out = v > 0 ? Math.min(U.MAX_REAL_PRICE, v) : null;
  if (ev._memo) ev._memo.set(key, out);
  return out;
}

const offerTag = (q) => (q.ex && q.ck ? "exact offer" : "size band " + (q.band || "?"));

/**
 * The reference price for one offer on one market.
 * @param {object} ev  buildEvidence()
 * @param {object} q   { g, f, m, ck, bk, ex, n, band }
 * @returns {{ ref, conf, basis, n, p25, ceiling, capped, max, why }}
 */
function refFor(ev, q) {
  const m = q.m;
  const f = farmOf(q.f);
  const ck = q.ex && q.ck ? q.ck : null;
  const bk = q.bk && !String(q.bk).endsWith("|?") ? String(q.bk) : "";
  const key = f + "|" + m + "|" + (ck || "") + "|" + bk + "|" + (q.g || "") + "|" + radarBand(q.n);
  if (ev._ref.has(key)) return ev._ref.get(key);
  const out = compute(ev, { g: q.g, f, m, ck, bk, ex: !!ck, n: q.n, band: q.band });
  ev._ref.set(key, out);
  return out;
}

function compute(ev, q) {
  const m = q.m;
  const F = q.f;
  const mk = ev.markets[m];
  const why = [];
  const bandStats = q.bk ? statsOf(ev, "byMBk", F + "|" + m + "|" + q.bk) : orderStats([]);
  let ref = null;
  let conf = "none";
  let basis = "none";
  let n = 0;
  let p25 = null;
  // the median the anchor came from, before any translation (the fallback cap of H11)
  let srcMedian = null;

  // 1. this exact offer, here
  const exactHere = q.ck ? statsOf(ev, "byMCk", F + "|" + m + "|" + q.ck) : null;
  if (exactHere && exactHere.n >= MIN_ORDERS) {
    const s = exactHere;
    ref = s.median;
    n = s.n;
    p25 = s.p25;
    basis = "exact-here";
    conf = LISTING_NOW.has(m) ? "medium" : "high";
    why.push("This exact offer sold " + n + "× here (median " + U.usd(ref) + ")" + (LISTING_NOW.has(m) ? "; priced at the listing price now, so medium at best." : "."));
  }
  // 2. same game and size band, here
  if (ref === null && bandStats.n >= MIN_ORDERS) {
    ref = bandStats.median;
    n = bandStats.n;
    p25 = bandStats.p25;
    basis = "band-here";
    conf = n >= BAND_MEDIUM_ORDERS ? "medium" : "low";
    why.push(n + " orders of this game at size " + (q.band || "?") + " here (median " + U.usd(ref) + ").");
  }
  // 3. translated from other markets — never from or into a blocked one (the translator refuses
  //    those sides itself; skipping them here keeps the "markets used" count honest)
  if (ref === null && !mk.blocked) {
    const t = translated(ev, q);
    if (t) {
      ref = t.ref;
      n = t.n;
      basis = "translated";
      conf = t.conf;
      srcMedian = t.srcMedian;
      why.push(t.why);
    }
  }
  // 4. rivals' sold prices for the game and size, here (the radar watches Gameflip and GGSel)
  if (ref === null && (m === "gameflip" || m === "ggsel") && q.g) {
    const rb = radarBand(q.n);
    const events = rb === "?" ? [] : (ev.radar.feed.get(q.g + "|" + m) || []).filter((e) => radarBand(e.n) === rb && num(e.p) > 0);
    if (events.length >= MIN_ORDERS) {
      ref = orderStats(events.map((e) => num(e.p))).median;
      srcMedian = ref;
      n = events.length;
      basis = "rivals";
      conf = "low";
      why.push("Rivals sold this game at size " + rb + " here " + n + "× (median " + U.usd(ref) + ").");
    }
  }
  // 5. this market's median over every order of the farm: a level, not a price for these items
  if (ref === null) {
    const all = statsOf(ev, "byM", F + "|" + m);
    if (all.n >= MIN_ORDERS) {
      ref = all.median;
      srcMedian = ref;
      n = all.n;
      basis = "venue";
      conf = "none";
      why.push("No comparable sale: this market's median over " + n + " orders (" + U.usd(ref) + "), a level only.");
    }
  }

  // The cap on an anchor nobody paid HERE for these items (H11): what buyers paid for THIS game here —
  // the p75 of its band's orders (≥ 3), else of all its orders here (≥ 3); else 1.5 × the median the
  // anchor came from; the market-wide p75 only as the last fallback. A market-wide p75 let a cheap
  // game borrow a dear game's level.
  let capped = false;
  if (ref !== null && (basis === "translated" || basis === "rivals" || basis === "venue")) {
    let cap = null;
    let capWhy = "";
    const game = q.g ? statsOf(ev, "byGFM", q.g + "|" + F + "|" + m) : orderStats([]);
    if (bandStats.n >= MIN_ORDERS) {
      cap = bandStats.p75;
      capWhy = "the p75 of this game's size-band orders here";
    } else if (game.n >= MIN_ORDERS) {
      cap = game.p75;
      capWhy = "the p75 of this game's orders here";
    } else if (srcMedian !== null && srcMedian > 0) {
      cap = round2(SOURCE_CAP_MULT * srcMedian);
      capWhy = SOURCE_CAP_MULT + "× the median it came from";
    } else {
      cap = marketP75(ev, m, F);
      capWhy = "this market's p75";
    }
    if (cap !== null && cap > 0 && ref > cap) {
      ref = cap;
      capped = true;
      why.push("Capped at " + capWhy + " (" + U.usd(cap) + ").");
    }
  }
  // p25 — "the lower quartile buyers demonstrably pay" (H15): from ≥ 3 orders; from fewer it is never
  // above the reference (two dear orders cannot make the floor of an overstock pick); none → the floor.
  if (p25 === null && bandStats.n >= MIN_ORDERS) p25 = bandStats.p25;
  else if (p25 === null && bandStats.n > 0) p25 = ref !== null ? Math.min(bandStats.p25, ref) : null;
  const mmax = marketMax(ev, m, F);
  const ceiling = mmax !== null ? mmax : ref !== null ? Math.min(U.MAX_REAL_PRICE, round2(2 * ref)) : null;
  if (ref === null) why.push("No evidence for the " + offerTag(q) + " on " + m + ".");
  return {
    ref: ref === null ? null : round2(ref),
    conf,
    basis,
    n,
    p25: p25 === null ? null : round2(p25),
    ceiling: ceiling === null ? null : round2(ceiling),
    capped,
    max: bandStats.n ? bandStats.max : null,
    why,
  };
}

/**
 * Step 3: the exact offer's orders on every other non-blocked market, each market's median scaled
 * into this one; else the band's (≥ 2 orders per market). Either needs ≥ 3 source orders in total
 * (C10: one order on one market is no estimate). Medium only when the exact offer sold on at least two
 * other markets.
 */
function translated(ev, q) {
  const m = q.m;
  const F = q.f;
  const tryList = (getList, minPer) => {
    const prices = [];
    const meds = [];
    const used = [];
    let n = 0;
    for (const from of MARKETS) {
      if (from === m || ev.markets[from].blocked) continue;
      const st = getList(from);
      if (st.n < minPer) continue;
      const med = st.median;
      const r = ev.ratio(from, m);
      if (!(med > 0) || !(r.ratio > 0)) continue;
      prices.push(med * r.ratio);
      meds.push(med);
      used.push(from);
      n += st.n;
    }
    return { prices, meds, used, n };
  };
  const answer = (t, conf, why) => ({ ref: orderStats(t.prices).median, n: t.n, conf, srcMedian: orderStats(t.meds).median, why });
  if (q.ck) {
    const t = tryList((from) => statsOf(ev, "byMCk", F + "|" + from + "|" + q.ck), 1);
    if (t.prices.length && t.n >= MIN_ORDERS) {
      return answer(t, t.used.length >= 2 ? "medium" : "low", "The same items sold on " + t.used.join(", ") + " (" + t.n + " orders); scaled to " + m + " by the tracker's translator.");
    }
  }
  if (q.bk) {
    const t = tryList((from) => statsOf(ev, "byMBk", F + "|" + from + "|" + q.bk), BAND_TRANSLATE_MIN);
    if (t.prices.length && t.n >= MIN_ORDERS) {
      return answer(t, "low", "Same game and size sold on " + t.used.join(", ") + " (" + t.n + " orders); scaled to " + m + ".");
    }
  }
  return null;
}

/**
 * Rivals' sold median for the game and size band on Gameflip, translated to market m (the `clear`
 * policy). Null without ≥ minSales rival sales or a translation.
 */
function clearPrice(ev, g, n, m, minSales = MIN_ORDERS) {
  const rb = radarBand(n);
  if (rb === "?" || !g || ev.markets[m].blocked) return null;
  const events = (ev.radar.feed.get(g + "|gameflip") || []).filter((e) => radarBand(e.n) === rb && num(e.p) > 0);
  if (events.length < minSales) return null;
  const med = orderStats(events.map((e) => num(e.p))).median;
  if (m === "gameflip") return round2(med);
  const r = ev.ratio("gameflip", m);
  return r.ratio > 0 ? round2(med * r.ratio) : null;
}

/** How many of the farm's orders of this game's band on market m were at or above price p (the raise rule). */
function ordersAtOrAbove(ev, m, bk, p, f = "claim") {
  if (!bk) return 0;
  const F = farmOf(f);
  const key = "sorted|" + F + "|" + m + "|" + bk;
  let arr = ev._memo.get(key);
  if (!arr) {
    arr = (ev.idx.byMBk.get(F + "|" + m + "|" + bk) || []).map((o) => o.p).sort((a, b) => a - b);
    ev._memo.set(key, arr);
  }
  // binary search for the first price ≥ p (a cent of tolerance: prices are stored to the cent)
  let lo = 0;
  let hi = arr.length;
  const target = p - 0.005;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return arr.length - lo;
}

module.exports = {
  RADAR_BANDS,
  MIN_ORDERS,
  BAND_MEDIUM_ORDERS,
  P75_MIN_ORDERS,
  SOURCE_CAP_MULT,
  radarBand,
  orderStats,
  statsOf,
  marketP75,
  marketMax,
  refFor,
  clearPrice,
  ordersAtOrAbove,
};
