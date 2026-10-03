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
//
// PURE. Memoised per run on ev._ref by market | offer | band | game.
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
 * The cap on any price this market has not itself paid for these items: the p75 of its own orders
 * when it has ≥ 10, else of every non-blocked market's orders (the tracker's venue / global p75).
 */
function marketP75(ev, m) {
  const key = "p75|" + m;
  if (ev._memo && ev._memo.has(key)) return ev._memo.get(key);
  const own = ev.idx.byM.get(m) || [];
  let v;
  if (own.length >= P75_MIN_ORDERS) v = statsOf(ev, "byM", m).p75;
  else {
    const all = [];
    for (const mk of MARKETS) if (!ev.markets[mk].blocked) for (const o of ev.idx.byM.get(mk) || []) all.push(o.p);
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

/** The highest order price a market has seen (≤ $25 by the junk bound), null when none. */
function marketMax(ev, m) {
  const key = "max|" + m;
  if (ev._memo && ev._memo.has(key)) return ev._memo.get(key);
  const v = statsOf(ev, "byM", m).max;
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
  const ck = q.ex && q.ck ? q.ck : null;
  const bk = q.bk && !String(q.bk).endsWith("|?") ? String(q.bk) : "";
  const key = m + "|" + (ck || "") + "|" + bk + "|" + (q.g || "") + "|" + radarBand(q.n);
  if (ev._ref.has(key)) return ev._ref.get(key);
  const out = compute(ev, { ...q, ck, bk });
  ev._ref.set(key, out);
  return out;
}

function compute(ev, q) {
  const m = q.m;
  const mk = ev.markets[m];
  const why = [];
  const bandStats = q.bk ? statsOf(ev, "byMBk", m + "|" + q.bk) : orderStats([]);
  let ref = null;
  let conf = "none";
  let basis = "none";
  let n = 0;
  let p25 = null;

  // 1. this exact offer, here
  const exactHere = q.ck ? statsOf(ev, "byMCk", m + "|" + q.ck) : null;
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
      why.push(t.why);
    }
  }
  // 4. rivals' sold prices for the game and size, here (the radar watches Gameflip and GGSel)
  if (ref === null && (m === "gameflip" || m === "ggsel") && q.g) {
    const rb = radarBand(q.n);
    const events = rb === "?" ? [] : (ev.radar.feed.get(q.g + "|" + m) || []).filter((e) => radarBand(e.n) === rb && num(e.p) > 0);
    if (events.length >= MIN_ORDERS) {
      ref = orderStats(events.map((e) => num(e.p))).median;
      n = events.length;
      basis = "rivals";
      conf = "low";
      why.push("Rivals sold this game at size " + rb + " here " + n + "× (median " + U.usd(ref) + ").");
    }
  }
  // 5. this market's median over every order: a level, not a price for these items
  if (ref === null) {
    const all = statsOf(ev, "byM", m);
    if (all.n >= MIN_ORDERS) {
      ref = all.median;
      n = all.n;
      basis = "venue";
      conf = "none";
      why.push("No comparable sale: this market's median over " + n + " orders (" + U.usd(ref) + "), a level only.");
    }
  }

  // The p75 cap: only a price paid HERE for these items may sit in the market's top tail.
  let capped = false;
  if (ref !== null && (basis === "translated" || basis === "rivals" || basis === "venue")) {
    const cap = marketP75(ev, m);
    if (cap !== null && ref > cap) {
      ref = cap;
      capped = true;
      why.push("Capped at this market's p75 (" + U.usd(cap) + ").");
    }
  }
  if (p25 === null && bandStats.n > 0) p25 = bandStats.p25;
  const mmax = marketMax(ev, m);
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
 * into this one; else the band's (≥ 2 orders per market). Medium only when the exact offer sold on
 * at least two other markets.
 */
function translated(ev, q) {
  const m = q.m;
  const tryList = (getList, minPer) => {
    const prices = [];
    const used = [];
    for (const from of MARKETS) {
      if (from === m || ev.markets[from].blocked) continue;
      const st = getList(from);
      if (st.n < minPer) continue;
      const med = st.median;
      const r = ev.ratio(from, m);
      if (!(med > 0) || !(r.ratio > 0)) continue;
      prices.push(med * r.ratio);
      used.push(from);
    }
    return { prices, used };
  };
  if (q.ck) {
    const t = tryList((from) => statsOf(ev, "byMCk", from + "|" + q.ck), 1);
    if (t.prices.length) {
      let n = 0;
      for (const from of t.used) n += statsOf(ev, "byMCk", from + "|" + q.ck).n;
      return {
        ref: orderStats(t.prices).median,
        n,
        conf: t.used.length >= 2 ? "medium" : "low",
        why: "The same items sold on " + t.used.join(", ") + "; scaled to " + m + " by the tracker's translator.",
      };
    }
  }
  if (q.bk) {
    const t = tryList((from) => statsOf(ev, "byMBk", from + "|" + q.bk), BAND_TRANSLATE_MIN);
    if (t.prices.length) {
      let n = 0;
      for (const from of t.used) n += statsOf(ev, "byMBk", from + "|" + q.bk).n;
      return {
        ref: orderStats(t.prices).median,
        n,
        conf: "low",
        why: "Same game and size sold on " + t.used.join(", ") + "; scaled to " + m + ".",
      };
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

/** How many orders of this game's band on market m were at or above price p (the raise rule). */
function ordersAtOrAbove(ev, m, bk, p) {
  if (!bk) return 0;
  const key = "sorted|" + m + "|" + bk;
  let arr = ev._memo.get(key);
  if (!arr) {
    arr = (ev.idx.byMBk.get(m + "|" + bk) || []).map((o) => o.p).sort((a, b) => a - b);
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
  radarBand,
  orderStats,
  statsOf,
  marketP75,
  marketMax,
  refFor,
  clearPrice,
  ordersAtOrAbove,
};
