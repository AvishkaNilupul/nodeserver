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
// Two numbers ride along on a single-unit market, both read off the same timelines:
// - the BASE rate a row sells at, sales ÷ ROW-days (N1): the offer-level rate h_m is per offer-day, and
//   an offer with three rows up is one offer-day but three row-days — the scorer's "every listing sells
//   at the market's own rate" baseline must be per row, or it reads ~2× too high and flatters the model;
// - the QUEUE calibration (N2): a row ranked k-th needs k buyers only if nobody else joins the queue,
//   but cheaper rows of ours keep arriving and take buyers. Once a day of each offer's timeline, every
//   live row's chance from the queue model is set beside whether it sold within the horizon; per rank
//   class (alone, 1st, 2nd, 3rd+) the ratio realised ÷ predicted, shrunk toward 1 with K row-days,
//   scales the queue model (and a higher rank is never given a better chance than a lower one).
//
// PURE.
const U = require("./util");
const E = require("./evidence");
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
 * @returns HZ { farm, horizon, K, minSales, minBucketDays, rows, markets: { [m]: { S, D, h, hb, buckets, queue? } } }
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
const EVERY_SAMPLES = 4096;

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
  // single-unit markets: per market, the rows' own sales and days (the per-row base rate, N1) and the
  // daily queue samples (N2)
  const perRow = new Map();
  const samples = new Map();
  const sampleTo = (m) => {
    if (!samples.has(m)) samples.set(m, { x: [], ti: [], c: [], s: [], n: [], d: [], y: [] });
    const a = samples.get(m);
    return (x, ti, c, sm, n, d, y) => {
      a.x.push(x);
      a.ti.push(ti);
      a.c.push(c);
      a.s.push(sm);
      a.n.push(n);
      a.d.push(d);
      a.y.push(y);
    };
  };
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
      const pr = perRow.get(r.m) || { S: 0, D: 0 };
      pr.S += e.units;
      pr.D += e.days;
      perRow.set(r.m, pr);
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
    const put = sampleTo(list[0].m);
    sweepOffer(list, ri.ref, (x, S, D) => addTo(list[0].m, x, ti, S, D), {
      cut: ev.cut,
      horizon,
      sample: (x, c, sm, n, d, y) => put(x, ti, c, sm, n, d, y),
    });
  }
  yield;
  const markets = {};
  for (const m of U.MARKETS) {
    const a = acc.get(m);
    if (!a) continue;
    const mk = shrink(a, { K, minSales, minBucketDays });
    // the base rate per ROW (N1): on a single-unit market sales ÷ row-days; elsewhere a row is an offer
    const pr = perRow.get(m);
    mk.hb = mk.h === null ? null : U.SINGLE.has(m) && pr && pr.D > 0 ? pr.S / pr.D : mk.h;
    markets[m] = mk;
  }
  // the queue calibration per single-unit market (N2), once the curve is known
  for (const [m, sm] of [...samples].sort((p, q) => U.cmp(p[0], q[0]))) {
    const mk = markets[m];
    if (!mk || mk.h === null || !sm.x.length) continue;
    const nodes = [0, 1, 2].map((t) => nodesOf(mk, t));
    const agg = QUEUE_CLASSES.map(() => ({ n: 0, y: 0, p: 0 }));
    const q = { cheaper: 0, same: 0, n: 0 };
    for (let i = 0; i < sm.x.length; i++) {
      if ((i & (EVERY_SAMPLES - 1)) === EVERY_SAMPLES - 1) yield;
      const h = nodes[sm.ti[i]].length ? interp(nodes[sm.ti[i]], sm.x[i]) : mk.h;
      q.cheaper = sm.c[i];
      q.same = sm.s[i];
      q.n = sm.n[i];
      const g = agg[classOf(rankOfQueue(q), q.n)];
      g.n++;
      g.y += sm.y[i];
      g.p += queueP(h * sm.d[i], q, null);
    }
    mk.queue = agg.map((g, i) => {
      // K pseudo row-days at the model's own mean chance: realised ÷ predicted, shrunk toward 1
      const pBar = g.n ? g.p / g.n : 0;
      const f = g.p + K * pBar > 0 ? (g.y + K * pBar) / (g.p + K * pBar) : 1;
      return { cls: QUEUE_CLASSES[i], n: g.n, y: g.y, p: U.round3(g.p), f: U.round3(f) };
    });
  }
  return { farm, horizon, K, minSales, minBucketDays, rows: used, markets };
}

/**
 * One offer's timeline on a single-unit market (H3): between two moments where a row starts, sells or
 * ends, the offer's state is its LOWEST live ask; that span's days go to the bucket of x = min ask ÷
 * ref, and a sale at the end of a span (any row's) to the state just before it. Rows judged at their
 * sale price when they sold (what the buyer actually took).
 *
 * With `o.sample`, once a day (at the cut minus whole days) every live row is also a queue sample (N2):
 * the offer's x_min, the row's place in the queue (rows strictly cheaper, others at its price, live
 * rows), the days it is judged over (the horizon, cut by its remaining life) and whether it sold within
 * them — only where those days end by the cut (an outcome not yet known is no sample).
 * @param {Array} rows the offer's fit rows (each with expo.t0/t1 inside the fit window)
 * @param {Function} add (x, sales, days)
 * @param {object} [o] { cut, horizon, sample: (xMin, cheaper, same, n, days, sold01) }
 */
function sweepOffer(rows, ref, add, o = {}) {
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
  // the daily sample points, oldest first: cut − j days
  const sampling = typeof o.sample === "function" && ev.length && Number.isFinite(o.cut) && o.horizon > 0;
  // (the first at or after the offer's first event)
  let tau = sampling ? o.cut - Math.floor((o.cut - ev[0].t) / DAY) * DAY : Infinity;
  // (scratch arrays reused at every sample point: an offer is sampled up to 90 times a fit)
  const bufR = [];
  const bufP = [];
  const sampleAt = (t) => {
    if (!live.size) return;
    let n = 0;
    let pMin = Infinity;
    for (const r of live.values()) {
      bufR[n] = r;
      bufP[n] = judgedPrice(r);
      if (bufP[n] < pMin) pMin = bufP[n];
      n++;
    }
    const xMin = pMin / ref;
    for (let i = 0; i < n; i++) {
      const r = bufR[i];
      const d = Math.min(o.horizon, E.daysLeftOf(r, t));
      if (!(d > 0) || t + d * DAY > o.cut) continue;
      let cheaper = 0;
      let same = 0;
      for (let k = 0; k < n; k++) {
        if (k === i) continue;
        if (bufP[k] < bufP[i] - 1e-9) cheaper++;
        else if (Math.abs(bufP[k] - bufP[i]) <= 1e-9) same++;
      }
      const e = r.expo;
      const y = e.units > 0 && e.soldT !== null && e.soldT > t && e.soldT <= t + d * DAY ? 1 : 0;
      o.sample(xMin, cheaper, same, n, d, y);
    }
  };
  for (const e of ev) {
    // the sample points up to this event see the live set as it stood before it
    while (sampling && tau < e.t) {
      sampleAt(tau);
      tau += DAY;
    }
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

/** Log-linear between nodes, flat beyond the ends (nodes non-empty, in x order). */
function interp(nodes, v) {
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
  return interp(nodes, v);
}

/** The chance a unit sells within `days` at ratio x: 1 − exp(−days·h). Null without an estimate. */
function pH(HZ, m, tier, x, days = HZ && HZ.horizon) {
  const h = hazardAt(HZ, m, tier, x);
  if (h === null) return null;
  return 1 - Math.exp(-Math.max(0, num(days)) * h);
}

/**
 * The market's base rate — the scoring baseline: every LISTING sells at the market's own rate. On a
 * single-unit market that is sales ÷ row-days (`hb`, N1), not the offer-level h_m the curve is fitted
 * in (one offer-day with three rows up is three row-days). A fit made before `hb` existed reads h_m.
 */
function baseP(HZ, m, days = HZ && HZ.horizon) {
  const mk = HZ && HZ.markets && HZ.markets[m];
  if (!mk || mk.h === null) return null;
  const h = mk.hb !== undefined && mk.hb !== null ? mk.hb : mk.h;
  return 1 - Math.exp(-Math.max(0, num(days)) * h);
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

// The queue classes the calibration is learnt in (N2): a row alone on its offer, and the 1st, 2nd and
// 3rd-or-later of several.
const QUEUE_CLASSES = ["alone", "1", "2", "3+"];
const classOf = (rank, n) => (n === 1 ? 0 : Math.min(3, Math.max(1, rank)));

/** A row's place in its offer's queue: rows strictly cheaper, OTHER rows at its price, live rows. */
function queueOf(ask, asks) {
  let cheaper = 0;
  let same = -1; // the row itself is among `asks`
  for (const a of asks) {
    if (a < ask - 1e-9) cheaper++;
    else if (Math.abs(a - ask) <= 1e-9) same++;
  }
  return { cheaper, same: Math.max(0, same), n: asks.length };
}
const rankOfQueue = (q) => 1 + q.cheaper + Math.floor(q.same / 2);

/** A row's rank among the offer's live rows' asks (ties share): 1 + cheaper + floor(same ÷ 2). */
function rankOf(ask, asks) {
  return rankOfQueue(queueOf(ask, asks));
}

/**
 * The queue model's chance for a row (`cal` null) or the calibrated one: a row with c rows strictly
 * cheaper and s others at its price is one of the ranks c+1 … c+1+s with equal chance (who of a tie is
 * served first is not ours to know), so its chance is the mean of those ranks' tails P(Poisson(μ) ≥ k)
 * (N2). Calibrated, each rank's tail is scaled by its class's factor and never exceeds the rank before
 * it: a higher rank never sells faster.
 */
function queueP(mu, q, cal) {
  const first = q.cheaper + 1;
  const lastK = q.cheaper + 1 + q.same;
  const m = num(mu, 0);
  if (!(m > 0)) return 0;
  // P(D ≥ k) walked upward: tail_k = tail_{k−1} − pmf(k−1), pmf(j) = pmf(j−1)·μ ÷ j
  let pmf = Math.exp(-m);
  let tail = 1;
  let run = 1;
  let sum = 0;
  for (let k = 1; k <= lastK; k++) {
    tail -= pmf;
    pmf *= m / k;
    const raw = tail < 1e-12 ? 0 : tail;
    const c = cal ? cal[classOf(k, q.n)] : null;
    run = Math.min(run, (c ? num(c.f, 1) : 1) * raw);
    if (k >= first) sum += run;
    // every later rank is 0 too
    if (run === 0) break;
  }
  return U.clamp(sum / (q.same + 1), 0, 1);
}

/**
 * A ROW's chance to sell within `days` on a single-unit market (H3): buyers of the offer arrive at
 * h(x_min) a day and take the cheapest row, so a row ranked k-th needs k buyers — P(Poisson(h·days) ≥
 * k); a tie is the mean over its ranks, and the market's queue calibration (N2) scales each rank for
 * the rows that join the queue ahead of it.
 * @param {number} xMin  the offer's lowest live ask ÷ ref
 * @param {number|object} q  the row's queue (queueOf) — or a plain rank ≥ 1 (no tie)
 */
function rowPH(HZ, m, tier, xMin, q, days = HZ && HZ.horizon) {
  const h = hazardAt(HZ, m, tier, xMin);
  if (h === null) return null;
  const pos = q && typeof q === "object" ? q : { cheaper: Math.max(1, Math.floor(num(q, 1))) - 1, same: 0, n: null };
  const mk = HZ.markets[m];
  return queueP(h * Math.max(0, num(days)), pos, Array.isArray(mk.queue) ? mk.queue : null);
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
  queueOf,
  queueP,
  QUEUE_CLASSES,
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
