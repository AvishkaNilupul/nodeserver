// Sell-through as a function of price (docs/LISTING-BRAIN-PLAN.md §4.3): a hazard per price ratio.
//
// For every exposure x = ask ÷ ref falls in one of six buckets; the hazard is sales ÷ days exposed, LIVE
// exposure included — the tracker's curve counts only resolved rows, which drops every unsold live
// listing and flatters high prices.
//
// What is exposed is an OFFER, not a row (H3). On a single-unit market (Gameflip) we keep several rows
// of one offer up at once and a buyer takes the cheapest: a dear row's slow sale is its RANK on our own
// shelf, not the buyers' answer to its price. So an offer is in stock while any of its rows is live, its
// state is its lowest live ask (x = min ask ÷ ref), and every sale of any of its rows counts for the
// offer at that moment. A row's own chance then follows from its rank (rowPH). On quantity and
// order-unit markets one row already is one offer; their sales count ORDERS (H12).
//
// Thin everywhere, so it is shrunk, per farm (the farms sell different things and are fitted apart):
//   market            h_m   = S_m ÷ D_m                         (no estimate with < minSales sales)
//   market × bucket   h_mb  = (S_mb + K·h_m) ÷ (D_mb + K)        then made non-increasing in x (PAVA)
//   × demand tier     h_mbt = (S_mbt + K·h_mb) ÷ (D_mbt + K)     pooled again within each tier
// K = shrinkK days. A bucket is EVIDENCED with ≥ minSales sales or ≥ minBucketDays days in market ×
// bucket; a THIN or empty one has no hazard at all (H4): it neither enters the pooling nor the curve —
// shrunk to the market mean it used to lift the top of the curve and push every price to the top of
// the evidenced range. The curve runs through the evidenced buckets' exposure-weighted mean x (not the
// bucket centres: the open top bucket's "2.5" was nobody's price), log-linear between them, flat below
// the lowest; no price above the highest is ever a candidate.
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
  // rebundled after the cut: today's contents, not the ones it held then (H14)
  if (r.offerEv === false) return false;
  if (r.advisable) return true;
  if (!r.ex) return false;
  const k = r.m + "|" + r.ck;
  if (r.rk === "hand" && ev.sysCk.has(k)) return true;
  return (r.rk === "hand" || r.rk === "cas" || r.rk === "system") && ev.ladders.has(k);
}

/**
 * The demand tier of a game for the fit: the farm brain's weekly rate, else our own 45-day average
 * at the cut (the farm brain's default estimator) — never counting a blocked market's sales (M4b:
 * history-only markets describe only themselves).
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
          const mk = ev.markets[String(s.m || "").toLowerCase()];
          if (mk && mk.blocked) continue;
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

// The offer a row belongs to on its market: its exact items, else its size band (the run's own identity).
const offerKeyOf = (r) => r.g + "|" + r.f + "|" + r.m + "|" + (r.ex && r.ck ? "c:" + r.ck : "b:" + r.bk);

/**
 * Fit one farm's hazard.
 * @param {object} ev
 * @param {"claim"|"noclaim"} farm
 * @param {object} [o] { tierFor: (g) => 0|1|2 }
 * @returns HZ { farm, horizon, K, minSales, minBucketDays, rows, markets: { [m]: { S, D, h, buckets, nodes } } }
 */
function fitHazard(ev, farm, o = {}) {
  const it = fitSteps(ev, farm, o);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

/**
 * The same fit, letting the event loop breathe on a time budget (P20-4): `o.yielder` (util.makeYielder)
 * is the caller's, so the run's phases share one budget. The output is identical to fitHazard's.
 */
async function fitHazardAsync(ev, farm, o = {}) {
  const y = o.yielder || U.makeYielder(YIELD_MS);
  const it = fitSteps(ev, farm, o);
  let r = it.next();
  while (!r.done) {
    if (y.due()) await y.now();
    r = it.next();
  }
  return r.value;
}

// Milliseconds of work between two yields when fitHazardAsync makes its own yielder (the run passes its).
const YIELD_MS = 40;
// Rows / offers between two possible yields: each check costs one clock read in the async fit.
const EVERY_ROWS = 1024;
const EVERY_OFFERS = 64;

// The body, as a generator: each `yield` marks a point where the async fit may let the loop breathe.
function* fitSteps(ev, farm, { tierFor } = {}) {
  const cfg = ev.cfg;
  const K = cfg.shrinkK;
  const minSales = cfg.minSales;
  const minBucketDays = cfg.minBucketDays;
  const horizon = farm === "noclaim" ? cfg.horizonDaysNoclaim : cfg.horizonDaysClaim;
  const tf = tierFor || defaultTierFor(ev, farm);
  const acc = new Map();
  const blank = () => ({ S: 0, D: 0, b: Array.from({ length: NB }, () => ({ S: 0, D: 0, xD: 0, t: Array.from({ length: NT }, () => ({ S: 0, D: 0 })) })) });
  const addTo = (m, x, tier, S, D) => {
    if (!(D > 0) && !(S > 0)) return;
    const bi = U.bucketOf(x);
    if (!acc.has(m)) acc.set(m, blank());
    const a = acc.get(m);
    a.S += S;
    a.D += D;
    a.b[bi].S += S;
    a.b[bi].D += D;
    a.b[bi].xD += x * D;
    a.b[bi].t[tier].S += S;
    a.b[bi].t[tier].D += D;
  };
  let used = 0;
  let tick = 0;
  // single-unit markets: gather each offer's rows, then sweep its timeline
  const offers = new Map();
  for (const r of ev.rows) {
    if ((++tick & (EVERY_ROWS - 1)) === 0) yield;
    if (!fitRow(ev, r, farm)) continue;
    const e = r.expo;
    if (!(e.days > 0)) continue;
    if (U.SINGLE.has(r.m)) {
      const k = offerKeyOf(r);
      if (!offers.has(k)) offers.set(k, []);
      offers.get(k).push(r);
      used++;
      continue;
    }
    const ri = refFor(ev, offerOf(r));
    if (!(ri.ref > 0)) continue;
    const ti = U.clamp(num(tf(r.g), 0), 0, NT - 1);
    addTo(r.m, judgedPrice(r) / ri.ref, ti, e.units, e.days);
    used++;
  }
  yield;
  tick = 0;
  for (const k of [...offers.keys()].sort(U.cmp)) {
    if ((++tick & (EVERY_OFFERS - 1)) === 0) yield;
    const list = offers.get(k);
    const ri = refFor(ev, offerOf(list[0]));
    if (!(ri.ref > 0)) continue;
    const ti = U.clamp(num(tf(list[0].g), 0), 0, NT - 1);
    sweepOffer(list, ri.ref, (x, S, D) => addTo(list[0].m, x, ti, S, D));
  }
  yield;
  const markets = {};
  for (const m of U.MARKETS) {
    const a = acc.get(m);
    if (!a) continue;
    markets[m] = shrink(a, { K, minSales, minBucketDays });
  }
  return { farm, horizon, K, minSales, minBucketDays, rows: used, markets };
}

/**
 * One offer's timeline on a single-unit market (H3): between two moments where a row starts, sells or
 * ends, the offer's state is its LOWEST live ask; that span's days go to the bucket of x = min ask ÷
 * ref, and a sale at the end of a span (any row's) to the state just before it. Rows judged at their
 * sale price when they sold (what the buyer actually took).
 * @param {Array} rows the offer's fit rows (each with expo.t0/t1 inside the fit window)
 * @param {Function} add (x, sales, days)
 */
function sweepOffer(rows, ref, add) {
  const ev = [];
  for (const r of rows) {
    const e = r.expo;
    if (!(e.t1 > e.t0)) continue;
    const sold = e.units > 0 && e.soldT !== null && e.soldT >= e.t0 && e.soldT <= e.t1;
    ev.push({ t: e.t0, open: true, r }, { t: e.t1, open: false, r, sold });
  }
  // closes before opens at one moment: a relist the minute a row sells is a new state, not two rows
  ev.sort((a, b) => a.t - b.t || (a.open === b.open ? U.cmp(a.r.id, b.r.id) : a.open ? 1 : -1));
  const live = new Map();
  let last = null;
  const minX = () => {
    let x = Infinity;
    for (const r of live.values()) x = Math.min(x, judgedPrice(r) / ref);
    return x;
  };
  for (const e of ev) {
    if (last !== null && live.size && e.t > last) add(minX(), 0, (e.t - last) / DAY);
    if (e.open) live.set(e.r.id, e.r);
    else {
      if (e.sold && live.size) add(minX(), 1, 0);
      live.delete(e.r.id);
    }
    last = e.t;
  }
}

// (S + K·prior) ÷ (D + K); with no days and no shrinkage the prior stands (nothing to say).
const shrunk = (S, D, K, prior) => (D + K > 0 ? (S + K * prior) / (D + K) : prior);

function shrink(a, { K, minSales, minBucketDays }) {
  const hm = a.S >= minSales && a.D > 0 ? a.S / a.D : null;
  const buckets = a.b.map((b, i) => ({
    S: b.S,
    D: U.round3(b.D),
    // where its exposure actually sat: the curve's node (H4, H13)
    x: b.D > 0 ? U.round3(b.xD / b.D) : BUCKET_CENTRES[i],
    h: null,
    hRaw: null,
    evid: b.S >= minSales || b.D >= minBucketDays,
    tiers: b.t.map((t) => ({ S: t.S, D: U.round3(t.D), h: null })),
  }));
  if (hm === null) return { S: a.S, D: U.round3(a.D), h: null, buckets };
  // a thin or empty bucket has no hazard: null, which pava passes through and the curve skips (H4)
  const raw = a.b.map((b, i) => (buckets[i].evid ? shrunk(b.S, b.D, K, hm) : null));
  const pooled = U.pava(
    raw,
    a.b.map((b) => b.D + K),
  );
  buckets.forEach((b, i) => {
    b.hRaw = raw[i];
    b.h = pooled[i];
  });
  for (let t = 0; t < NT; t++) {
    const rawT = a.b.map((b, i) => (pooled[i] === null ? null : shrunk(b.t[t].S, b.t[t].D, K, pooled[i])));
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

// A hazard of 0 (an evidenced bucket that never sold, with no shrinkage) would send the log-linear
// curve to −∞ between it and its neighbour; a node is floored at this share of the market's rate (H18).
const NODE_FLOOR_SHARE = 1e-3;

/** The curve's nodes for a market and tier: evidenced buckets only, at their mean x, in x order. */
function nodesOf(mk, ti) {
  const floor = NODE_FLOOR_SHARE * mk.h;
  const out = [];
  for (const b of mk.buckets) {
    if (!b.evid) continue;
    const h = ti === null ? b.h : b.tiers[ti].h;
    if (h === null || h === undefined) continue;
    out.push({ x: b.x, h: Math.max(h, floor, 1e-12) });
  }
  return out;
}

/**
 * The hazard (sales a day) at ratio x: log-linear between the evidenced buckets' nodes, flat below the
 * lowest and above the highest — so still non-increasing. With no evidenced bucket, the market's own
 * rate (an estimate of level only: no price is ever picked from it). Null when the market has none.
 */
function hazardAt(HZ, m, tier, x) {
  const mk = HZ && HZ.markets && HZ.markets[m];
  if (!mk || mk.h === null) return null;
  const v = num(x, NaN);
  if (!Number.isFinite(v)) return null;
  const ti = tier === null || tier === undefined ? null : U.clamp(Math.round(num(tier)), 0, NT - 1);
  const nodes = nodesOf(mk, ti);
  if (!nodes.length) return mk.h;
  if (v <= nodes[0].x) return nodes[0].h;
  const last = nodes[nodes.length - 1];
  if (v >= last.x) return last.h;
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    if (v <= b.x) {
      const w = b.x > a.x ? (v - a.x) / (b.x - a.x) : 1;
      return Math.exp((1 - w) * Math.log(a.h) + w * Math.log(b.h));
    }
  }
  return last.h;
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

/**
 * May a price at ratio x be picked on market m? Only inside the evidence: at or below the highest
 * evidenced node (H4 — no extrapolation above what was tried); below the lowest node the curve is flat.
 */
function evidenced(HZ, m, x) {
  const mk = HZ && HZ.markets && HZ.markets[m];
  if (!mk || mk.h === null) return false;
  const v = num(x, NaN);
  if (!Number.isFinite(v)) return false;
  const nodes = nodesOf(mk, null);
  if (!nodes.length) return false;
  return v <= nodes[nodes.length - 1].x + 1e-9;
}

/** The highest ratio a price may be picked at on market m (the top evidenced node), or null. */
function maxEvidencedX(HZ, m) {
  const mk = HZ && HZ.markets && HZ.markets[m];
  if (!mk || mk.h === null) return null;
  const nodes = nodesOf(mk, null);
  return nodes.length ? nodes[nodes.length - 1].x : null;
}

/**
 * A ROW's chance to sell within `days` on a single-unit market (H3): buyers of the offer arrive at
 * h(x_min) a day and take the cheapest row, so a row ranked k-th needs k buyers — P(Poisson(h·days) ≥
 * rank). rank = 1 + rows strictly cheaper + floor(rows at the same price ÷ 2) (ties share the buyers).
 * @param {number} xMin  the offer's lowest live ask ÷ ref
 * @param {number} rank  ≥ 1
 */
function rowPH(HZ, m, tier, xMin, rank, days = HZ && HZ.horizon) {
  const h = hazardAt(HZ, m, tier, xMin);
  if (h === null) return null;
  return U.poissonTail(h * Math.max(0, num(days)), Math.max(1, Math.floor(num(rank, 1))));
}

/** A row's rank among the offer's live rows' asks (ties share): 1 + cheaper + floor(same ÷ 2). */
function rankOf(ask, asks) {
  let cheaper = 0;
  let same = -1; // the row itself is among `asks`
  for (const a of asks) {
    if (a < ask - 1e-9) cheaper++;
    else if (Math.abs(a - ask) <= 1e-9) same++;
  }
  return 1 + cheaper + Math.floor(Math.max(0, same) / 2);
}

/** Expected days to a sale at ratio x: 1 ÷ h (Infinity with no estimate or a zero hazard). */
function expectedDaysToSale(HZ, m, tier, x) {
  const h = hazardAt(HZ, m, tier, x);
  return h && h > 0 ? 1 / h : Infinity;
}

module.exports = {
  UNMEASURED,
  NODE_FLOOR_SHARE,
  offerOf,
  offerKeyOf,
  sweepOffer,
  nodesOf,
  maxEvidencedX,
  rowPH,
  rankOf,
  fitRow,
  defaultTierFor,
  judgedPrice,
  fitHazard,
  fitHazardAsync,
  hazardAt,
  pH,
  baseP,
  evidenced,
  expectedDaysToSale,
};
