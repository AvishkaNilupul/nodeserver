// Sell-through as a function of price (docs/LISTING-BRAIN-PLAN.md §4.3): a hazard per price ratio.
//
// For every exposure x = ask ÷ ref (a sold row: the price it sold at) falls in one of six buckets;
// the hazard is units sold ÷ listing-days exposed, LIVE rows' exposure included — the tracker's curve
// counts only resolved rows, which drops every unsold live listing and flatters high prices.
//
// Thin everywhere, so it is shrunk, per farm (the farms sell different things and are fitted apart):
//   market            h_m   = S_m ÷ D_m                         (no estimate with < minSales sales)
//   market × bucket   h_mb  = (S_mb + K·h_m) ÷ (D_mb + K)        then made non-increasing in x (PAVA)
//   × demand tier     h_mbt = (S_mbt + K·h_mb) ÷ (D_mbt + K)     pooled again within each tier
// K = shrinkK listing-days. A bucket is EVIDENCED with ≥ minSales sales or ≥ minBucketDays days in
// market × bucket; a thin one is logged and never picked as a price.
//
// PURE.
const U = require("./util");
const { refFor } = require("./ref");

const { DAY, BUCKET_CENTRES, BUCKET_EDGES, num } = U;
const NB = BUCKET_EDGES.length;
const NT = 3;
// ZeusX records no sale for an auto row (delivery by hand in chat): its exposure would read as
// "never sells" at any price. Never fitted (plan §4.1).
const UNMEASURED = new Set(["zeusx"]);

const offerOf = (r) => ({ g: r.g, f: r.f, m: r.m, ck: r.ex ? r.ck : null, bk: r.bk, ex: r.ex, n: r.n, band: r.band });

/**
 * Rows whose exposure teaches the curve of `farm`: system-made rows; hand-made rows of the very same
 * items as a system-made row on that market; and the rungs of a deliberate ladder (the best price
 * evidence there is). Never a blocked market, never ZeusX.
 */
function fitRow(ev, r, farm) {
  if (r.f !== farm || r.blocked || UNMEASURED.has(r.m)) return false;
  if (r.advisable) return true;
  if (!r.ex) return false;
  const k = r.m + "|" + r.ck;
  if (r.rk === "hand" && ev.sysCk.has(k)) return true;
  return (r.rk === "hand" || r.rk === "cas" || r.rk === "system") && ev.ladders.has(k);
}

/**
 * The demand tier of a game for the fit: the farm brain's weekly rate, else our own 45-day average
 * at the cut (the farm brain's default estimator).
 */
function defaultTierFor(ev, farm) {
  const cache = new Map();
  let own = null;
  return (g) => {
    if (cache.has(g)) return cache.get(g);
    const d = ev.demand.get(g + "|" + farm);
    let w;
    if (d && d.w !== null && d.w !== undefined) w = num(d.w);
    else {
      if (!own) {
        own = new Map();
        const lo = ev.cut - 45 * DAY;
        for (const s of ev.salesBefore) {
          if ((s.f === "noclaim" ? "noclaim" : "claim") !== farm || !(s.t > lo)) continue;
          own.set(s.g, (own.get(s.g) || 0) + 1);
        }
      }
      w = ((own.get(g) || 0) * 7) / 45;
    }
    const t = U.tierOf(w, ev.cfg.tierEdges);
    cache.set(g, t);
    return t;
  };
}

/** The price a row is judged at: what it sold for when a single unit sold, else what it asks. */
function judgedPrice(r) {
  if (U.SINGLE.has(r.m) && r.expo.units > 0 && r.sales.length && num(r.sales[0].p) > 0) return num(r.sales[0].p);
  return r.ask;
}

/**
 * Fit one farm's hazard.
 * @param {object} ev
 * @param {"claim"|"noclaim"} farm
 * @param {object} [o] { tierFor: (g) => 0|1|2 }
 * @returns HZ { farm, horizon, K, minSales, minBucketDays, rows, markets: { [m]: { S, D, h, buckets } } }
 */
function fitHazard(ev, farm, { tierFor } = {}) {
  const cfg = ev.cfg;
  const K = cfg.shrinkK;
  const minSales = cfg.minSales;
  const minBucketDays = cfg.minBucketDays;
  const horizon = farm === "noclaim" ? cfg.horizonDaysNoclaim : cfg.horizonDaysClaim;
  const tf = tierFor || defaultTierFor(ev, farm);
  const acc = new Map();
  const blank = () => ({ S: 0, D: 0, b: Array.from({ length: NB }, () => ({ S: 0, D: 0, t: Array.from({ length: NT }, () => ({ S: 0, D: 0 })) })) });
  let used = 0;
  for (const r of ev.rows) {
    if (!fitRow(ev, r, farm)) continue;
    const e = r.expo;
    if (!(e.days > 0)) continue;
    const ri = refFor(ev, offerOf(r));
    if (!(ri.ref > 0)) continue;
    const x = judgedPrice(r) / ri.ref;
    const bi = U.bucketOf(x);
    const ti = U.clamp(num(tf(r.g), 0), 0, NT - 1);
    if (!acc.has(r.m)) acc.set(r.m, blank());
    const a = acc.get(r.m);
    a.S += e.units;
    a.D += e.days;
    a.b[bi].S += e.units;
    a.b[bi].D += e.days;
    a.b[bi].t[ti].S += e.units;
    a.b[bi].t[ti].D += e.days;
    used++;
  }
  const markets = {};
  for (const m of U.MARKETS) {
    const a = acc.get(m);
    if (!a) continue;
    markets[m] = shrink(a, { K, minSales, minBucketDays });
  }
  return { farm, horizon, K, minSales, minBucketDays, rows: used, markets };
}

// (S + K·prior) ÷ (D + K); with no days and no shrinkage the prior stands (nothing to say).
const shrunk = (S, D, K, prior) => (D + K > 0 ? (S + K * prior) / (D + K) : prior);

function shrink(a, { K, minSales, minBucketDays }) {
  const hm = a.S >= minSales && a.D > 0 ? a.S / a.D : null;
  const buckets = a.b.map((b) => ({
    S: b.S,
    D: U.round3(b.D),
    h: null,
    hRaw: null,
    evid: b.S >= minSales || b.D >= minBucketDays,
    tiers: b.t.map((t) => ({ S: t.S, D: U.round3(t.D), h: null })),
  }));
  if (hm === null) return { S: a.S, D: U.round3(a.D), h: null, buckets };
  const raw = a.b.map((b) => shrunk(b.S, b.D, K, hm));
  const pooled = U.pava(
    raw,
    a.b.map((b) => b.D + K),
  );
  buckets.forEach((b, i) => {
    b.hRaw = raw[i];
    b.h = pooled[i];
  });
  for (let t = 0; t < NT; t++) {
    const rawT = a.b.map((b, i) => shrunk(b.t[t].S, b.t[t].D, K, pooled[i]));
    const pooledT = U.pava(
      rawT,
      a.b.map((b) => b.t[t].D + K),
    );
    buckets.forEach((b, i) => {
      b.tiers[t].h = pooledT[i];
    });
  }
  return { S: a.S, D: U.round3(a.D), h: hm, buckets };
}

/**
 * The hazard (units a day) at ratio x: log-linear between bucket centres, flat beyond the ends — so
 * still non-increasing. Null when the market has no estimate.
 */
function hazardAt(HZ, m, tier, x) {
  const mk = HZ && HZ.markets && HZ.markets[m];
  if (!mk || mk.h === null) return null;
  const v = num(x, NaN);
  if (!Number.isFinite(v)) return null;
  const ti = tier === null || tier === undefined ? null : U.clamp(Math.round(num(tier)), 0, NT - 1);
  const hs = mk.buckets.map((b) => (ti === null ? b.h : b.tiers[ti].h));
  const c = BUCKET_CENTRES;
  if (v <= c[0]) return hs[0];
  if (v >= c[c.length - 1]) return hs[hs.length - 1];
  for (let i = 0; i < c.length - 1; i++) {
    if (v <= c[i + 1]) {
      const w = (v - c[i]) / (c[i + 1] - c[i]);
      const a = Math.log(Math.max(hs[i], 1e-12));
      const b = Math.log(Math.max(hs[i + 1], 1e-12));
      return Math.exp((1 - w) * a + w * b);
    }
  }
  return hs[hs.length - 1];
}

/** The chance a unit sells within `days` at ratio x: 1 − exp(−days·h). Null without an estimate. */
function pH(HZ, m, tier, x, days = HZ && HZ.horizon) {
  const h = hazardAt(HZ, m, tier, x);
  if (h === null) return null;
  return 1 - Math.exp(-Math.max(0, num(days)) * h);
}

/** The market's base rate — the scoring baseline: every listing sells at the market's own rate. */
function baseP(HZ, m, days = HZ && HZ.horizon) {
  const mk = HZ && HZ.markets && HZ.markets[m];
  if (!mk || mk.h === null) return null;
  return 1 - Math.exp(-Math.max(0, num(days)) * mk.h);
}

/** Is ratio x in an evidenced bucket of market m? (A thin bucket is never picked as a price.) */
function evidenced(HZ, m, x) {
  const mk = HZ && HZ.markets && HZ.markets[m];
  if (!mk || mk.h === null) return false;
  return !!mk.buckets[U.bucketOf(x)].evid;
}

/** Expected days to a sale at ratio x: 1 ÷ h (Infinity with no estimate or a zero hazard). */
function expectedDaysToSale(HZ, m, tier, x) {
  const h = hazardAt(HZ, m, tier, x);
  return h && h > 0 ? 1 / h : Infinity;
}

module.exports = {
  UNMEASURED,
  offerOf,
  fitRow,
  defaultTierFor,
  judgedPrice,
  fitHazard,
  hazardAt,
  pH,
  baseP,
  evidenced,
  expectedDaysToSale,
};
