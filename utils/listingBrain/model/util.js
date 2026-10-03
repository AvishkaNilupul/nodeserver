// The listing brain's shared constants and small pure helpers (docs/LISTING-BRAIN-PLAN.md).
//
// PURE: no database, no network, no settings, no clock. The one timer here is yieldNow(), used only
// by the async wrappers so a run never holds the event loop; nothing in a computation reads it. The one
// clock is makeYielder's performance.now(): it decides only WHEN the async wrappers let the loop
// breathe, never what is computed (the sync and async runs give identical output).
const { performance } = require("node:perf_hooks");
const stats = require("../../priceTracker/stats");
const venues = require("../../priceTracker/venues");

const DAY = 86400000;
const HOUR = 3600000;
// The tracker's seven market keys (venues.MARKETS). Plati is "digiseller" everywhere in the brain.
const MARKETS = ["gameflip", "digiseller", "ggsel", "zeusx", "eldorado", "playerauctions", "g2g"];
// VENUES[m].saleModel === "single-unit": one row is one unit, a sale ends the row.
const SINGLE = new Set(["gameflip", "zeusx"]);
// Nothing stamps the price at delivery on these: a sale's price is the listing's price now, so their
// evidence is "medium" at best (the tracker's gamePrice rule).
const LISTING_NOW = new Set(["eldorado", "playerauctions", "g2g"]);
// Markets today's flow tops back up (refillMarkets, the guardian). The rest get one share and keep it.
const REFILLABLE = new Set(["gameflip", "digiseller", "ggsel"]);
// Markets that need no per-game category mapping to take a listing (plan §1.3 #16).
const NO_MAPPING = new Set(["gameflip", "digiseller", "eldorado"]);
// The no-claim auto-lister's markets (unclaimedAutoList.enabledMarketsForGame); its other offers are
// claim-at-sale rows the owner runs.
const NOCLAIM_SHELF = new Set(["gameflip", "digiseller", "ggsel"]);
// The radar watches three markets; it calls Digiseller "plati".
const RADAR_MARKETS = { gameflip: "gameflip", ggsel: "ggsel", digiseller: "plati" };
const BUCKET_EDGES = [0.8, 1.0, 1.2, 1.5, 2.0, Infinity];
const BUCKET_LABELS = ["≤0.80", "≤1.00", "≤1.20", "≤1.50", "≤2.00", ">2.00"];
const BUCKET_CENTRES = [0.7, 0.9, 1.1, 1.35, 1.75, 2.5];
// Candidate prices as multiples of the reference price (plan §4.4).
const GRID = [0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.35, 1.5, 1.75, 2.0];
const GAMEFLIP_EXPIRY_DAYS = 30; // utils/marketplaces.js publishes with expire_in_days: 30
const ELDORADO_OFFER_LIFE_DAYS = 21; // eldoradoFulfiller: an offer dies 21 days after its last activation
// eldoradoFulfiller's offer keep-alive (on unless autoFarm.eldoradoKeepAlive is false) pauses and resumes an
// ACTIVE offer within 5 days of its expiry, which restarts the 21 days ("verified live 2026-09-23"). An
// unsold offer whose 21 days ran out before then really died; one whose life ended on or after it was
// renewed while the keep-alive was on.
const ELDORADO_KEEPALIVE_SINCE = Date.UTC(2026, 8, 23);

/**
 * Has an unsold Eldorado offer created at `c` died by `t`? Only by the 21-day life, and only when the
 * keep-alive could not have renewed it: switched off (`keepAlive` false), or its life ended before the
 * keep-alive existed.
 */
function eldoradoDead(c, t, keepAlive) {
  const end = c + ELDORADO_OFFER_LIFE_DAYS * DAY;
  if (!(t > end)) return false;
  return !keepAlive || end < ELDORADO_KEEPALIVE_SINCE;
}
const ELDORADO_MAX_ACTIVE_OFFERS = 100; // autoLister ELD_LIMIT_RE "maximum of N active offers" (per category)
const MAX_REAL_PRICE = 25; // analyze.MAX_REAL_PRICE: anything above is a placeholder, never a price point
const CONF_RANK = { none: 0, low: 1, medium: 2, high: 3 };
// A reason line the log keeps: at most six, 160 characters each (the farm brain's rule).
const WHY_LINES = 6;
const WHY_CHARS = 160;

const num = (v, d = 0) => {
  if (v === null || v === undefined || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const round2 = (n) => Math.round(num(n) * 100) / 100;
const round3 = (n) => Math.round(num(n) * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lower = (s) => String(s == null ? "" : s).trim().toLowerCase();
const usd = (p) => "$" + num(p).toFixed(2);
// Plain code-unit order: the same on every machine (localeCompare follows the host's locale).
const cmp = (a, b) => {
  const x = String(a == null ? "" : a);
  const y = String(b == null ? "" : b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Nearest $0.05, never 0 for a positive price (a 3-cent ask is not "free"). */
function snap05(p) {
  const n = num(p, 0);
  if (!(n > 0)) return 0;
  return Math.max(0.05, round2(Math.round(n * 20) / 20));
}
/** Down / up to the $0.05 grid: a step limit must never be overshot by its rounding. */
const floor05 = (p) => round2(Math.floor(num(p) * 20 + 1e-9) / 20);
const ceil05 = (p) => round2(Math.ceil(num(p) * 20 - 1e-9) / 20);

/* ---------------------------------- config ---------------------------------- */

const ON_VALUES = new Set(["true", "1", "on", "yes", "enabled"]);
const OFF_VALUES = new Set(["false", "0", "off", "no", "disabled"]);
// Only an explicit "on" turns a switch on (same rule as demandBrain.model.isOn).
function isOn(v) {
  if (v === true) return true;
  if (typeof v === "number") return v === 1;
  if (typeof v !== "string") return false;
  return ON_VALUES.has(v.trim().toLowerCase());
}
// A default-on switch: only an explicit "off" turns it off; a typo reads as the default.
function onOff(v, d) {
  if (v === true || v === false) return v;
  if (typeof v === "number") return v === 1 ? true : v === 0 ? false : d;
  if (typeof v !== "string") return d;
  const s = v.trim().toLowerCase();
  if (ON_VALUES.has(s)) return true;
  if (OFF_VALUES.has(s)) return false;
  return d;
}
function clampNum(v, d, lo, hi) {
  const n = num(v, NaN);
  if (!Number.isFinite(n)) return d;
  return Math.min(hi, Math.max(lo, n));
}

const PRICE_POLICIES = ["old", "tracker", "curve", "clear"];
const PLACE_POLICIES = ["flat", "share30", "instock", "newsvendor"];

// Plan §8. Frozen: readConfig copies it, nothing mutates it.
const DEFAULTS = Object.freeze({
  enabled: false,
  intervalMin: 180,
  maxDemandAgeH: 6,
  fitDaysClaim: 90,
  fitDaysNoclaim: 30,
  refDays: 180,
  horizonDaysClaim: 7,
  // No-claim stock sells in hours to days: a 7-day window would call almost everything "sells".
  horizonDaysNoclaim: 2,
  shrinkK: 30,
  minSales: 3,
  minBucketDays: 60,
  tierEdges: Object.freeze([1, 5]),
  scarceCover: 0.5,
  overstockCover: 2,
  minP7Scarce: 0.5,
  fadeRatio: 0.5,
  perishHours: 48,
  rivalsGoneMax: 1,
  maxStepPct: 35,
  agreeAbsUsd: 0.1,
  agreeRelPct: 8,
  raiseMinSales: 2,
  stockoutShare: 0.3,
  cooldownH: 72,
  staleFactor: 3,
  shelfHorizonDays: 14,
  nonRefillHorizonDays: 28,
  minMarginalUsd: 0.1,
  shareShrinkDays: 14,
  explore: true,
  fcCap: 5000,
  policyPrice: "curve",
  policyPlace: "newsvendor",
});

function tierEdgesOf(v) {
  if (!Array.isArray(v) || v.length !== 2) return DEFAULTS.tierEdges.slice();
  const a = num(v[0], NaN);
  const b = num(v[1], NaN);
  if (!(a > 0) || !(b > a)) return DEFAULTS.tierEdges.slice();
  return [a, b];
}

/** autoFarm.listingBrain, every key validated and clamped; a typo reads as the default. */
function readConfig(af) {
  const raw = af && af.listingBrain && typeof af.listingBrain === "object" ? af.listingBrain : {};
  const d = DEFAULTS;
  const c = (k, lo, hi) => clampNum(raw[k], d[k], lo, hi);
  const ci = (k, lo, hi) => Math.round(c(k, lo, hi));
  const pick = (k, list) => (list.includes(String(raw[k])) ? String(raw[k]) : d[k]);
  return {
    enabled: isOn(raw.enabled),
    intervalMin: ci("intervalMin", 30, 1440),
    maxDemandAgeH: c("maxDemandAgeH", 1, 72),
    fitDaysClaim: c("fitDaysClaim", 14, 180),
    fitDaysNoclaim: c("fitDaysNoclaim", 7, 120),
    refDays: c("refDays", 30, 365),
    horizonDaysClaim: c("horizonDaysClaim", 1, 28),
    horizonDaysNoclaim: c("horizonDaysNoclaim", 0.5, 14),
    shrinkK: c("shrinkK", 0, 1000),
    minSales: ci("minSales", 1, 50),
    minBucketDays: c("minBucketDays", 1, 10000),
    tierEdges: tierEdgesOf(raw.tierEdges),
    scarceCover: c("scarceCover", 0, 10),
    overstockCover: c("overstockCover", 1, 50),
    minP7Scarce: c("minP7Scarce", 0.05, 0.99),
    fadeRatio: c("fadeRatio", 0, 1),
    perishHours: c("perishHours", 0, 720),
    rivalsGoneMax: c("rivalsGoneMax", 0, 100),
    maxStepPct: c("maxStepPct", 5, 100),
    agreeAbsUsd: c("agreeAbsUsd", 0, 5),
    agreeRelPct: c("agreeRelPct", 0, 100),
    raiseMinSales: ci("raiseMinSales", 1, 50),
    stockoutShare: c("stockoutShare", 0, 1),
    cooldownH: c("cooldownH", 0, 720),
    staleFactor: c("staleFactor", 1, 20),
    shelfHorizonDays: c("shelfHorizonDays", 1, 60),
    nonRefillHorizonDays: c("nonRefillHorizonDays", 1, 120),
    minMarginalUsd: c("minMarginalUsd", 0, 10),
    shareShrinkDays: c("shareShrinkDays", 0, 365),
    explore: onOff(raw.explore, d.explore),
    fcCap: ci("fcCap", 0, 20000),
    policyPrice: pick("policyPrice", PRICE_POLICIES),
    policyPlace: pick("policyPlace", PLACE_POLICIES),
  };
}

/* ---------------------------------- numbers --------------------------------- */

/** Ratio bucket 0..5 of x = ask ÷ ref (BUCKET_EDGES, upper edges inclusive). */
function bucketOf(x) {
  const v = num(x, NaN);
  if (!Number.isFinite(v)) return BUCKET_EDGES.length - 1;
  for (let i = 0; i < BUCKET_EDGES.length; i++) if (v <= BUCKET_EDGES[i] + 1e-9) return i;
  return BUCKET_EDGES.length - 1;
}

/** Demand tier 0|1|2 of a weekly rate: under edges[0], under edges[1], the rest. */
function tierOf(w, edges = DEFAULTS.tierEdges) {
  const v = num(w, 0);
  if (v < edges[0]) return 0;
  if (v < edges[1]) return 1;
  return 2;
}

/**
 * Pool adjacent violators: the closest NON-INCREASING sequence (weighted least squares). A null
 * value is "no constraint": it stays null and the fit runs through it. Returns a new array.
 */
function pava(values, weights) {
  const idx = [];
  for (let i = 0; i < values.length; i++) if (values[i] !== null && values[i] !== undefined && Number.isFinite(Number(values[i]))) idx.push(i);
  // blocks of [sum w·v, sum w, member indices]
  const blocks = [];
  for (const i of idx) {
    const w = Math.max(1e-12, num(weights && weights[i], 1));
    blocks.push({ s: w * Number(values[i]), w, members: [i] });
    // a later value ABOVE the block before it violates "non-increasing": pool them
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.s / a.w >= b.s / b.w - 1e-15) break;
      a.s += b.s;
      a.w += b.w;
      a.members = a.members.concat(b.members);
      blocks.pop();
    }
  }
  const out = values.map((v) => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null));
  for (const b of blocks) for (const i of b.members) out[i] = b.s / b.w;
  return out;
}

/**
 * P(D ≥ k) for D ~ Poisson(mu), in O(k). Summed in log space so a large mean (pmf(0) = e^−800
 * underflows to 0) still gives the right tail. k ≤ 0 → 1; mu ≤ 0 → 0.
 */
function poissonTail(mu, k) {
  const kk = Math.ceil(num(k, 0));
  if (kk <= 0) return 1;
  const m = num(mu, 0);
  if (!(m > 0)) return 0;
  const lm = Math.log(m);
  let lp = -m; // log pmf(0)
  let cdf = 0;
  for (let j = 0; j < kk; j++) {
    if (j > 0) lp += lm - Math.log(j);
    cdf += Math.exp(lp);
  }
  return clamp(1 - cdf, 0, 1);
}

/**
 * The same tail one k at a time: next() returns P(D ≥ 1), then P(D ≥ 2), … in O(1) each. The
 * greedy shelf and the policy forecasts walk k upward, so this keeps them linear in the stock.
 */
function poissonTailer(mu) {
  const m = num(mu, 0);
  let k = 0;
  let lp = -m;
  let tail = 1;
  const lm = m > 0 ? Math.log(m) : 0;
  return {
    next() {
      if (!(m > 0)) return 0;
      // P(D ≥ k+1) = P(D ≥ k) − pmf(k)
      if (k > 0) lp += lm - Math.log(k);
      tail -= Math.exp(lp);
      k++;
      if (tail < 1e-12) tail = 0;
      return clamp(tail, 0, 1);
    },
  };
}

/** E[min(D, shelf)] for D ~ Poisson(mu) = Σ_{k=1..shelf} P(D ≥ k): expected units sold. */
function expectedSold(mu, shelf) {
  const n = Math.max(0, Math.floor(num(shelf, 0)));
  if (!n || !(num(mu) > 0)) return 0;
  const t = poissonTailer(mu);
  let s = 0;
  for (let k = 1; k <= n; k++) {
    const v = t.next();
    s += v;
    if (v === 0) break;
  }
  return s;
}

/* -------------------------------- re-exports -------------------------------- */

const floorFor = (m) => venues.floorFor(m);
const netOf = (p, m, fees) => venues.netOf(p, m, fees);
const feeInfo = (m, fees) => venues.feeFor(m, fees);

/** A Promise that resolves on the next turn of the event loop (async wrappers only). */
const yieldNow = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A time-budget yielder for the async wrappers: `due()` is true once `ms` have passed since the last
 * yield; `maybe()` yields then (a Promise) and returns null otherwise, so a hot loop pays one clock read
 * per check and an await only when due. Production runs Node 20, where the same loop can be many times
 * slower than on a developer's Node 22: a fixed chunk size cannot hold a ~200 ms bound on both. Output
 * never depends on it.
 */
function makeYielder(ms = 40) {
  let last = performance.now();
  const y = {
    due: () => performance.now() - last >= ms,
    async now() {
      await yieldNow();
      last = performance.now();
    },
    maybe: () => (performance.now() - last >= ms ? y.now() : null),
  };
  return y;
}

const cellKey = (g, f, m) => g + "|" + f + "|" + m;
/** "game key|farm|market" → { g, f, m }; the game key itself never holds a "|" (setIdentity.normGame). */
function parseCellKey(s) {
  const parts = String(s == null ? "" : s).split("|");
  if (parts.length < 3) return null;
  const m = parts.pop();
  const f = parts.pop();
  return { g: parts.join("|"), f, m };
}

/** At most six reasons, each at most 160 characters. */
const shortWhy = (list) =>
  (list || [])
    .filter((s) => s !== null && s !== undefined && s !== "")
    .slice(0, WHY_LINES)
    .map((s) => String(s).slice(0, WHY_CHARS));

/** The median of positive values (stats.median drops ≤ 0), null when there are none. */
function medianOrNull(list) {
  const v = stats.median(list || []);
  return v > 0 ? v : null;
}

module.exports = {
  DAY,
  HOUR,
  MARKETS,
  SINGLE,
  LISTING_NOW,
  REFILLABLE,
  NO_MAPPING,
  NOCLAIM_SHELF,
  RADAR_MARKETS,
  BUCKET_EDGES,
  BUCKET_LABELS,
  BUCKET_CENTRES,
  GRID,
  GAMEFLIP_EXPIRY_DAYS,
  ELDORADO_OFFER_LIFE_DAYS,
  ELDORADO_KEEPALIVE_SINCE,
  eldoradoDead,
  ELDORADO_MAX_ACTIVE_OFFERS,
  MAX_REAL_PRICE,
  CONF_RANK,
  WHY_LINES,
  WHY_CHARS,
  DEFAULTS,
  PRICE_POLICIES,
  PLACE_POLICIES,
  num,
  round2,
  round3,
  clamp,
  lower,
  usd,
  cmp,
  snap05,
  floor05,
  ceil05,
  isOn,
  onOff,
  clampNum,
  readConfig,
  bucketOf,
  tierOf,
  median: stats.median,
  quantile: stats.quantile,
  band: stats.band,
  medianOrNull,
  pava,
  poissonTail,
  poissonTailer,
  expectedSold,
  floorFor,
  netOf,
  feeInfo,
  yieldNow,
  makeYielder,
  cellKey,
  parseCellKey,
  shortWhy,
};
