// The farm brain's model — docs/DEMAND-BRAIN-PLAN.md.
//
// One question for both farms: "this game sells about N a week; how many accounts should be
// farming it?" — answered the same way for the auto-farm (claim farm) and the no-claim farm, from
// one counting rule, and set beside what each farm's own logic says at the same moment.
//
// TEST MODE. Nothing here is read by a farm. utils/demandBrain/index.js logs what this computes
// and scores it against what actually sold; wiring a farm to it is a later, separate decision.
//
// PURE: no database, no network, no settings read, no clock but the injected `now`. Every number
// the brain logs is reproducible from the inputs handed to buildRun().
const farmSizing = require("../farmSizing");

const DAY = 86400000;
// v2 (2026-10-03, docs/LIVE-FIXES-1003.md §A8): the intermittent-demand estimators sba and tsb, the
// no-claim feeder's burst-guarded rule v2g, and cold probes for new drops (a live campaign with no
// evidence of ours used to be "unknown").
const MODEL_VERSION = 2;
// Sales are read this far back so each one is dated by its EARLIEST evidence (a sale seen by the
// marketplace in August and by the drop scanner in September is an August sale), and so the
// backtest has six weeks to replay.
const HISTORY_DAYS = 135;
// Markets where stock is committed up front and a day without a sale is a day without a buyer
// (farmDemand.SHELF_MARKETS). Every other market sells only while matching stock exists.
const SHELF_MARKETS = new Set(["gameflip", "ggsel", "digiseller"]);
// The markets the radar reads (its "plati" is Digiseller).
const WATCHED_MARKETS = SHELF_MARKETS;
// Burst sales for the feeder's burst guard (farmDemand.isBurstSale / BURST_MARKETS): a hand sale
// (soldMarket "manual"), or a unit that went out in a bulk pack — recognised by its `pack` flag, not
// its market, which is the claim-at-sale market of any single sale.
const BURST_MARKETS = new Set(["manual"]);
const ESTIMATORS = ["avg45", "avg30", "max30_14", "v2", "v2g", "listed", "sba", "tsb"];
const DEFAULTS = Object.freeze({
  enabled: false,
  intervalMin: 60,
  // Chosen on production's own 6-week backtest (2026-10-02, 263 game-weeks, 135 days of evidence
  // including the connection flips that prove 61% of our sales): RMSE avg45 2.27 (bias +0.32),
  // avg30 2.85 (+0.41), max30_14 3.59 (+0.76), listed 3.61 (+0.82), the feeder's v2 rule 6.16
  // (+2.05 — its stock-out correction over-forecasts sporadic sellers). Same order on the 243
  // game-weeks the game was listed all week, so it is not a stock-out artefact.
  estimatorClaim: "avg45",
  // The no-claim farm keeps the feeder's own rule: its sales are censored by frequent stock-outs
  // (Eldorado offers covering 0), which a backtest against realised sales cannot see through.
  estimatorNoclaim: "v2",
  captureShare: 0.2,
  minMarketRate: 1,
  minMarketUnits: 3,
  minRate: 0.25,
  // Accounts are not the scarce input (the auto-farm is demand-bound, project_pool_burn_0929), so
  // this only screens out games whose accounts are close to worthless, not small steady sellers.
  minWeeklyUsd: 0.25,
});
const MIN_INTERVAL_MIN = 15;
// A rival's sold price is what the buyer paid; the market keeps roughly this much of it.
const RIVAL_FEE_SHARE = 0.15;
// Old and brain targets this close are the same answer (accounts, or a share of the old target).
const AGREE_ABS = 3;
const AGREE_REL = 0.2;
// "mirror" (no-claim only): the brain could not compute its own estimate and shows the feeder's.
const DIFFS = ["agree", "agree-skip", "brain-more", "brain-less", "brain-farm", "brain-skip", "brain-unknown", "old-error", "mirror"];
// Disagreements worth a person's eye in the decision review.
const REVIEW_DIFFS = new Set(["brain-more", "brain-less", "brain-farm", "brain-skip"]);

const num = (v, d = 0) => {
  if (v === null || v === undefined || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const round1 = (n) => Math.round(num(n) * 10) / 10;
const round2 = (n) => Math.round(num(n) * 100) / 100;
const lower = (s) => String(s == null ? "" : s).trim().toLowerCase();

/* ---------------------------------- config ---------------------------------- */

const ON_VALUES = new Set(["true", "1", "on", "yes", "enabled"]);
// Only an explicit "on" turns the brain on; anything else — a typo, an object, null — is off.
function isOn(v) {
  if (v === true) return true;
  if (typeof v === "number") return v === 1;
  if (typeof v !== "string") return false;
  return ON_VALUES.has(v.trim().toLowerCase());
}

function clampNum(v, d, lo, hi) {
  const n = num(v, NaN);
  if (!Number.isFinite(n)) return d;
  return Math.min(hi, Math.max(lo, n));
}

/** The auto-farm's re-probe cooldown in days, read exactly as its probe gate reads it. */
function probeCooldownDaysOf(af) {
  return Math.max(0, Number(af && af.probeCooldownDays) || 0);
}

/**
 * A new drop's cold-probe size: the owner's demandBrain.coldProbeSize when set, else half the
 * engine's own shelf floor (marketStockFloor = open shelf markets × perMarketStock × 2, so this is
 * the floor without its post-event doubling — 6 with Plati blocked). The floor already knows which
 * markets are switched on AND have keys; a floor that could not be read (0) means no cold probes.
 */
function coldProbeSizeFor(cfg, floor) {
  if (cfg && cfg.coldProbeSize != null) return Math.max(0, Math.floor(num(cfg.coldProbeSize)));
  return Math.floor(Math.max(0, num(floor)) / 2);
}

/** The brain's settings (autoFarm.demandBrain), every field validated and defaulted. */
function readConfig(af) {
  const raw = af && af.demandBrain && typeof af.demandBrain === "object" ? af.demandBrain : {};
  const est = (v, d) => (ESTIMATORS.includes(String(v)) ? String(v) : d);
  const coldSize = num(raw.coldProbeSize, NaN);
  return {
    enabled: isOn(raw.enabled),
    intervalMin: Math.round(clampNum(raw.intervalMin, DEFAULTS.intervalMin, MIN_INTERVAL_MIN, 24 * 60)),
    estimatorClaim: est(raw.estimatorClaim, DEFAULTS.estimatorClaim),
    estimatorNoclaim: est(raw.estimatorNoclaim, DEFAULTS.estimatorNoclaim),
    captureShare: clampNum(raw.captureShare, DEFAULTS.captureShare, 0, 1),
    minMarketRate: clampNum(raw.minMarketRate, DEFAULTS.minMarketRate, 0, 1e6),
    minMarketUnits: clampNum(raw.minMarketUnits, DEFAULTS.minMarketUnits, 0, 1e6),
    minRate: clampNum(raw.minRate, DEFAULTS.minRate, 0, 1e6),
    minWeeklyUsd: clampNum(raw.minWeeklyUsd, DEFAULTS.minWeeklyUsd, 0, 1e9),
    // Accounts a new drop's cold probe asks for; 0 turns cold probes off (such games read "unknown"
    // again, as in model v1). Unset (null): half the engine's shelf floor, per run (coldProbeSizeFor).
    coldProbeSize: Number.isFinite(coldSize) ? Math.floor(Math.min(250, Math.max(0, coldSize))) : null,
    // The auto-farm's cold-start switches, read as its engine reads them: the known-dud cooldown
    // applies only while probeColdStart is on (utils/farm2/steps/decide.js probeGate), and a probe
    // the stop-loss would have expired has been listed probeMaxDays (expireStaleProbes).
    probeColdStart: !!(af && af.probeColdStart),
    probeMaxDays: Math.max(1, Number(af && af.probeMaxDays) || 30),
    // The engine's two cold-start gates (2026-10-03, after staging read 54 cold probes on production
    // data): a market is UNTESTED with at most probeMaxSellers rival sellers (demandAllocation), and
    // at most probeMaxGames probes run at once (decide.probeGate's budget).
    probeMaxSellers: Math.max(0, num(af && af.probeMaxSellers, 0)),
    probeMaxGames: Math.max(0, Math.floor(num(af && af.probeMaxGames, 0))),
  };
}

/**
 * How many rivals list a game, counted as the engine's cold-start gate counts them: the market
 * research its own verdict read (`sellers`, distinct sellers on the Gameflip/GGSel/Plati pages —
 * research with no scan time is no research to demandAllocation), else the radar's live rival
 * sellers (also distinct sellers); null when neither is known.
 * @param {object|null} research inputs.oldVerdicts' { ds, sellers, at }
 */
function rivalSellersOf(research, radarRow) {
  if (research && research.at != null) return { n: Math.max(0, num(research.sellers)), from: "research" };
  const r = radarRow && radarRow.rivalSellers;
  if (r != null && r !== "" && Number.isFinite(Number(r))) return { n: Math.max(0, Number(r)), from: "radar" };
  return null;
}

/* ------------------------------ listing history ------------------------------ */

// When each game had a live drops listing: [start, end] spans from the price tracker's prepared
// listing rows. An active row runs to `now`; a sold / delisted / removed row ends at its last
// write (an over-estimate when a row is touched later, which only ever LOWERS a stock-out
// correction, never inflates it); an "error" row was never live.
function listingSpans(rows, now) {
  const out = new Map();
  for (const r of rows || []) {
    const key = r && r.id && r.id.gameKey;
    const l = r && r.l;
    if (!key || !l) continue;
    const status = lower(l.status);
    const start = l.createdAt ? new Date(l.createdAt).getTime() : NaN;
    if (!Number.isFinite(start)) continue;
    let end;
    if (status === "active") end = now;
    else if (status === "sold" || status === "delisted" || status === "removed") end = l.updatedAt ? new Date(l.updatedAt).getTime() : NaN;
    else continue;
    if (!Number.isFinite(end) || end < start) continue;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push([start, Math.min(end, now)]);
  }
  return out;
}

/** Days inside [from, to] covered by at least one span. */
function coveredDays(spans, from, to) {
  if (!spans || !spans.length || !(to > from)) return 0;
  const clipped = [];
  for (const [s, e] of spans) {
    const a = Math.max(s, from);
    const b = Math.min(e, to);
    if (b > a) clipped.push([a, b]);
  }
  clipped.sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cs = null;
  let ce = null;
  for (const [a, b] of clipped) {
    if (cs === null) {
      cs = a;
      ce = b;
    } else if (a <= ce) {
      if (b > ce) ce = b;
    } else {
      total += ce - cs;
      cs = a;
      ce = b;
    }
  }
  if (cs !== null) total += ce - cs;
  return total / DAY;
}

/* -------------------------------- estimators -------------------------------- */

// Sales dated inside (now - days, now].
function countIn(entries, now, days) {
  const from = now - days * DAY;
  let n = 0;
  for (const e of entries) if (e.t > from && e.t <= now) n++;
  return n;
}
const weekly = (n, days) => (n * 7) / days;

// Most games sell in lumps — a few weeks with sales, many without — which plain averages handle
// poorly. Two textbook forecasters for such series (model v2), both on WEEKLY sale counts of the last
// INTERMITTENT_WEEKS weeks, oldest first:
//   sba — Croston's method with the Syntetos–Boylan correction (2005). Exponential smoothing (α) of
//         the size of each selling week and of the number of weeks between selling weeks, updated
//         only in a week with a sale; forecast (1 − α/2) × size / interval. It never decays while a
//         game is silent: the known Croston blind spot TSB was built to fix.
//         The window's first week is NEVER an interval's start (review, 2026-10-03): the window
//         slides, so "weeks since the window opened" shrinks every week a lone old sale sits in it,
//         and the forecast grew with silence (0.43 → 5.55 a week over 12 silent weeks). The recursion
//         starts from the first size and the first GAP between two selling weeks; a window with a
//         single selling week reads it as one sale in the whole window (size / 13 weeks). So while no
//         sale enters or leaves the window, sliding it changes nothing.
//   tsb — Teunter–Syntetos–Babai (2011). The chance that a week sells is smoothed EVERY week (β), the
//         size of a selling week only in weeks with a sale (α); forecast chance × size, so a game
//         that stops selling fades out. Started from the window's own averages (the share of weeks
//         that sold, the average selling week): starting from the first week would put the chance
//         at exactly 0 or 1.
// α = β = 0.15 (docs/LIVE-FIXES-1003.md §A8). 13 weeks is the longest window that still fits inside
// the evidence under the oldest backtest week: 6 × 7 + 91 = 133 days ≤ HISTORY_DAYS.
const INTERMITTENT_WEEKS = 13;
const SBA_ALPHA = 0.15;
const TSB_ALPHA = 0.15;
const TSB_BETA = 0.15;

/** Sales per week over the `weeks` weeks before `now`, oldest first; the last is (now − 7 d, now]. */
function weeklyCounts(entries, now, weeks = INTERMITTENT_WEEKS) {
  const WEEK = 7 * DAY;
  const y = new Array(weeks).fill(0);
  for (const e of entries || []) {
    // countIn's window: (now − weeks × 7 d, now]
    const age = now - e.t;
    if (!(age >= 0 && age < weeks * WEEK)) continue;
    y[weeks - 1 - Math.floor(age / WEEK)]++;
  }
  return y;
}

/** Croston with the Syntetos–Boylan correction: a weekly rate from weekly counts (oldest first). */
function sbaRate(y, alpha = SBA_ALPHA) {
  const list = y || [];
  // the selling weeks, as [index, size]
  const sold = [];
  list.forEach((v, i) => {
    if (v > 0) sold.push([i, v]);
  });
  if (!sold.length) return 0;
  const c = 1 - alpha / 2;
  // One selling week: its gap to the sale before it is unknown (outside the window), not "since the
  // window opened" — read it as one sale in the whole window.
  if (sold.length === 1) return (c * sold[0][1]) / list.length;
  // Start from the first size and the first gap, then update at every later selling week.
  let size = sold[0][1];
  let interval = sold[1][0] - sold[0][0];
  for (let k = 1; k < sold.length; k++) {
    size += alpha * (sold[k][1] - size);
    interval += alpha * (sold[k][0] - sold[k - 1][0] - interval);
  }
  return (c * size) / interval;
}

/** Teunter–Syntetos–Babai: a weekly rate from weekly counts (oldest first). */
function tsbRate(y, alpha = TSB_ALPHA, beta = TSB_BETA) {
  const list = y || [];
  const sizes = list.filter((v) => v > 0);
  if (!sizes.length) return 0;
  let chance = sizes.length / list.length;
  let size = sizes.reduce((a, v) => a + v, 0) / sizes.length;
  for (const v of list) {
    const sold = v > 0;
    chance += beta * ((sold ? 1 : 0) - chance);
    if (sold) size += alpha * (v - size);
  }
  return chance * size;
}

function rateOf(id, entries, now, ctx) {
  const n30 = () => countIn(entries, now, 30);
  const n14 = () => countIn(entries, now, 14);
  switch (id) {
    case "avg45":
      return weekly(countIn(entries, now, 45), 45);
    case "avg30":
      return weekly(n30(), 30);
    case "max30_14":
      return Math.max(weekly(n30(), 30), weekly(n14(), 14));
    case "listed": {
      // Weeks the game had nothing listed are a stock-out, not a lack of buyers. Divide by the
      // days it WAS listed, floored at half the window so the correction is at most 2x. No listing
      // history at all (a game sold only by hand) falls back to max30_14.
      const spans = ctx && ctx.spans;
      if (!spans || !spans.length) return Math.max(weekly(n30(), 30), weekly(n14(), 14));
      const l30 = Math.min(30, coveredDays(spans, now - 30 * DAY, now));
      const l14 = Math.min(14, coveredDays(spans, now - 14 * DAY, now));
      return Math.max((n30() * 7) / Math.max(l30, 15), (n14() * 7) / Math.max(l14, 7));
    }
    case "sba":
      return sbaRate(weeklyCounts(entries, now));
    case "tsb":
      return tsbRate(weeklyCounts(entries, now));
    default:
      return 0;
  }
}

// The no-claim feeder's own rate rule (utils/farmDemand.js demandRates, feeder v2): shelf markets
// at their raw rate, every other market at its in-stock rate by selling days, each the larger of
// the 30-day and 14-day figure. `burstGuard` is that rule's dark switch (docs/LIVE-FIXES-1003.md §A4,
// autoFarm.noclaimBurstGuard): burst sales (isBurstSale — a hand sale or a bulk-pack unit) count
// at their raw rate in each window; the rest keep the in-stock correction over the selling days of
// ALL other-market sales (a burst's day included), and each window's guarded figure is clamped to
// its unguarded one — the guard can only remove inflation (A4's fix of 2026-10-03: dropping the
// burst-only days from the denominator had RAISED some rates). A one-day lump of 40 alone reads 20 a
// week, not 40. The brain always passes the switch EXPLICITLY — false for v2, true for v2g — so the
// owner's switch never changes what an estimator means and the feeder never reads its settings for
// a default. Each unit carries what the guard reads: its date, its market and the `pack` flag (an
// entry's `pack`, inputs.noclaimEvidence). When production's farmDemand exports demandRates it is
// called directly (a true mirror); this copy is the fallback, held equal to it on random histories
// in tests/demandBrainV2.test.js.
const isBurstSale = (u) => !!u && (u.pack === true || BURST_MARKETS.has(lower(u.market)));

function v2Rates(entries, now, demandRates, { burstGuard = false } = {}) {
  const from = now - 30 * DAY;
  const units = [];
  for (const e of entries) {
    if (!(e.t >= from && e.t <= now)) continue;
    const u = { firstAt: new Date(e.t), market: e.m };
    if (e.pack === true) u.pack = true;
    units.push(u);
  }
  if (typeof demandRates === "function") {
    const r = demandRates(units, { days: 30, shortDays: 14, now, burstGuard: !!burstGuard }) || {};
    const s = round1(r.shelfPerWeek);
    const o = round1(r.otherPerWeek);
    return { shelf: s, other: o, total: round1(s + o), source: "farmDemand" };
  }
  const shortSince = now - 14 * DAY;
  const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
  let shelf = 0;
  let shelfShort = 0;
  let other = 0;
  let otherShort = 0;
  const otherDays = new Set();
  const otherDaysShort = new Set();
  // the same other-market sales split into bursts and the steady rest, for the guarded rate
  let burst = 0;
  let burstShort = 0;
  let steady = 0;
  let steadyShort = 0;
  for (const u of units) {
    const t = u.firstAt.getTime();
    const recent = t >= shortSince;
    if (SHELF_MARKETS.has(lower(u.market))) {
      shelf++;
      if (recent) shelfShort++;
    } else {
      other++;
      otherDays.add(dayOf(t));
      if (recent) {
        otherShort++;
        otherDaysShort.add(dayOf(t));
      }
      if (isBurstSale(u)) {
        burst++;
        if (recent) burstShort++;
      } else {
        steady++;
        if (recent) steadyShort++;
      }
    }
  }
  const s = round1(Math.max(farmSizing.salesPerWeek(shelf, 30), farmSizing.salesPerWeek(shelfShort, 14)));
  // each window's unguarded figure, and the guarded one never above it
  const plain = farmSizing.inStockRate({ count: other, sellingDays: otherDays.size, windowDays: 30 });
  const plainShort = farmSizing.inStockRate({ count: otherShort, sellingDays: otherDaysShort.size, windowDays: 14 });
  const o = round1(
    burstGuard && burst > 0
      ? Math.max(
          Math.min(plain, farmSizing.inStockRate({ count: steady, sellingDays: otherDays.size, windowDays: 30 }) + farmSizing.salesPerWeek(burst, 30)),
          Math.min(plainShort, farmSizing.inStockRate({ count: steadyShort, sellingDays: otherDaysShort.size, windowDays: 14 }) + farmSizing.salesPerWeek(burstShort, 14)),
        )
      : Math.max(plain, plainShort),
  );
  return { shelf: s, other: o, total: round1(s + o), source: "brain" };
}

/**
 * One estimator's weekly rate for a game's dated sales, split shelf / other.
 * @param {string} id        one of ESTIMATORS
 * @param {Array}  entries   [{ t: epoch ms, m: market, pack?: true }] — the game's sales, any window
 * @param {number} now       the moment the forecast is made (sales after it are ignored)
 * @param {object} ctx       { spans, demandRates }
 * @returns {{ shelf:number, other:number, total:number }}
 */
function estimate(id, entries, now, ctx = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (id === "v2" || id === "v2g") {
    const r = v2Rates(list, now, ctx.demandRates, { burstGuard: id === "v2g" });
    return { shelf: r.shelf, other: r.other, total: r.total };
  }
  const shelfE = [];
  const otherE = [];
  for (const e of list) (SHELF_MARKETS.has(e.m) ? shelfE : otherE).push(e);
  return {
    shelf: round2(rateOf(id, shelfE, now, ctx)),
    other: round2(rateOf(id, otherE, now, ctx)),
    total: round2(rateOf(id, list, now, ctx)),
  };
}

/** Every estimator's total, for the log and the scores. */
function allEstimates(entries, now, ctx = {}) {
  const out = {};
  for (const id of ESTIMATORS) out[id] = estimate(id, entries, now, ctx).total;
  return out;
}

/* ----------------------------- the claim farm ------------------------------- */

/**
 * The radar's view of one game, reduced to what the verdict needs.
 * `ourWatched` is OUR rate on the three markets the radar reads, from our own dated sales.
 */
function marketView(radarRow, entries, now) {
  if (!radarRow) return null;
  const mine = (entries || []).filter((e) => WATCHED_MARKETS.has(e.m));
  return {
    rivalPerWeek: radarRow.perWeek == null ? null : num(radarRow.perWeek),
    ratePartial: !!radarRow.ratePartial,
    rivalUnits: num(radarRow.units),
    rivalSellers: num(radarRow.rivalSellers),
    rivalsLive: num(radarRow.rivalsLive),
    realisedMedian: radarRow.realised && radarRow.realised.median != null ? num(radarRow.realised.median) : null,
    medianTtsHours: radarRow.medianTtsHours == null ? null : num(radarRow.medianTtsHours),
    ourWatched: round2(Math.max(weekly(countIn(mine, now, 30), 30), weekly(countIn(mine, now, 14), 14))),
  };
}

const dayText = (t) => (Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "a recent day");

/**
 * The brain's call for one claim-farm game.
 * `live`, `dud` and `evidence.listedDays` drive the cold-start rule (model v2): a game with a live
 * campaign and no SALE of ours in HISTORY_DAYS is a new drop, listed or not (an engine probe that
 * went up two days ago has listings and no sale yet). `dud` is what inputs.expiredProbes found:
 * false = checked, no failed probe; { at, days } = a probe of this game ended with 0 sales inside
 * the auto-farm's re-probe cooldown; null = not checked. Both only count while the engine's own
 * probeColdStart is on, as in its probe gate. `rivals` (rivalSellersOf) is the engine's
 * untested-market gate: a cold probe only for a market at most probeMaxSellers rivals list. The
 * probe budget spans games, so buildRun applies it (applyProbeBudget).
 * @returns {{ c:"farm"|"probe"|"skip"|"unknown", t:number, w:number, b:"own"|"market"|"cold"|"none",
 *             own:number, mp:number, mt:number|null, sh:number|null, proof:boolean, v:number,
 *             vb:string, u:number|null, dud:null|"probe"|"listed", held:null|"tested"|"unknown",
 *             why:string[] }}
 */
function claimVerdict({ own = 0, market = null, value = 0, valueBasis = "", cfg, sizing, gameCap = 0, probeSize = 15, floor = 0, evidence = {}, live = false, dud = null, rivals = null }) {
  const why = [];
  const ownW = Math.max(0, num(own));
  let mp = 0;
  let mt = null;
  let sh = null;
  let proof = false;
  const rated = !!market && market.rivalPerWeek != null;
  if (rated) {
    mt = round2(num(market.rivalPerWeek) + num(market.ourWatched));
    sh = mt > 0 ? round2(num(market.ourWatched) / mt) : null;
    proof = num(market.rivalPerWeek) >= cfg.minMarketRate && num(market.rivalUnits) >= cfg.minMarketUnits;
    if (proof) mp = round2(cfg.captureShare * mt);
  }
  const forecast = round2(Math.max(ownW, mp));
  let basis = forecast <= 0 ? "none" : ownW >= mp ? "own" : "market";
  const v = Math.max(0, round2(value));
  const u = v > 0 ? round2(forecast * v) : null;
  // The engine's re-probe cooldown counts only while its cold-start probing is on (decide.probeGate).
  const dudKnown = !!cfg.probeColdStart && !!dud && typeof dud === "object";
  const dudAt = dudKnown ? new Date(dud.at).getTime() : NaN;
  const dudLine = () =>
    "A probe of this game ended with 0 sales on " + dayText(dudAt) +
    (dudKnown && num(dud.days) > 0 ? ", inside the auto-farm's " + num(dud.days) + "-day re-probe cooldown" : "") + ".";
  let isDud = null;
  // which cold-start gate held a new drop back: "tested" (rivals list it) or "unknown" (no count)
  let held = null;

  if (ownW > 0) why.push("We sell about " + round2(ownW) + " a week (every market, each account once).");
  if (rated) {
    why.push(
      "Rivals sell " + round2(market.rivalPerWeek) + " a week on Gameflip/GGSel/Plati" +
        (sh != null ? "; our share there " + Math.round(sh * 100) + "%" : "") +
        (proof ? "." : " — under the proof threshold, not used."),
    );
  } else if (market && market.ratePartial) {
    why.push("The market has sales but has not been watched 2 days yet: no rate.");
  }

  let c;
  let t = 0;
  let td = 0;
  const capToGame = () => {
    if (gameCap > 0 && t > gameCap) {
      t = Math.floor(gameCap);
      why.push("Held to " + t + " by your cap for this game.");
    }
  };
  if (forecast <= 0) {
    const coldSize = coldProbeSizeFor(cfg, floor);
    if (evidence.sold135 || !live || !(coldSize > 0)) {
      // Model v1's rule: a game that sold but has no forecast now, a game no live campaign is
      // deciding, or every game while cold probes are off.
      const noEvidence = !evidence.sold135 && !evidence.listed135 && !rated;
      c = noEvidence ? "unknown" : "skip";
      why.push(noEvidence ? "No sale or listing of ours in " + HISTORY_DAYS + " days and no rated market: no evidence either way." : "No recent sale of ours and no proven market.");
      if (live && !evidence.sold135) {
        why.push(cfg.coldProbeSize === 0 ? "Cold probes are off (coldProbeSize 0)." : "No cold-probe size: the auto-farm's shelf floor could not be read.");
      }
    } else {
      // NEW DROPS, model v2: a live campaign and no sale of ours in HISTORY_DAYS. Model v1 abstained
      // while the engine probes 15 accounts (17 of its 20 finished probes ended with 0 sales by
      // 2026-10-02); the brain asks only enough for each shelf market to hold its stock. A proven
      // rival market never reaches this branch: it upgrades the game to the market-led probe below.
      const none = "No sale of ours in " + HISTORY_DAYS + " days and a campaign is live";
      const listedDays = evidence.listedDays == null ? null : num(evidence.listedDays, null);
      const since = "listed since " + dayText(num(evidence.firstListedAt, NaN)) + " (" + Math.floor(num(listedDays)) + " days)";
      if (listedDays != null && listedDays > num(cfg.probeMaxDays, 30)) {
        // Listed longer than the engine's own probe window and never sold: what its stop-loss
        // calls a failed probe, whether or not one was ever stamped.
        c = "skip";
        isDud = "listed";
        why.push(none + "; " + since + ", longer than the " + num(cfg.probeMaxDays, 30) + "-day probe window, and never sold: dud-like, no probe.");
      } else if (dudKnown) {
        // The engine's own cooldown fact: this game was already probed and sold nothing.
        c = "skip";
        isDud = "probe";
        why.push(none + ".");
        why.push(dudLine() + " A known dud: no probe.");
      } else if (cfg.probeColdStart && dud !== false) {
        c = "unknown";
        why.push(none + "; the auto-farm's probe history was not readable, so a possible dud is not probed.");
      } else if (!rivals) {
        // The engine's untested-market gate needs a seller count, and none was read.
        c = "unknown";
        held = "unknown";
        why.push(none + "; how many rivals list it is unknown (no market research and no radar row), so it is not probed.");
      } else if (num(rivals.n) > num(cfg.probeMaxSellers)) {
        // A TESTED market: the engine skips these too (demandAllocation) — the market has spoken.
        c = "skip";
        held = "tested";
        why.push(
          none + "; rivals list it but it does not sell: " + num(rivals.n) + " rival seller" + (num(rivals.n) === 1 ? "" : "s") +
            " (" + (rivals.from === "research" ? "the engine's market research" : "the market radar") + "), over the untested-market limit of " +
            num(cfg.probeMaxSellers) + ".",
        );
      } else {
        c = "probe";
        basis = "cold";
        t = coldSize;
        const max = Math.floor(num(sizing && sizing.maxPerGame));
        if (max > 0 && t > max) t = max;
        why.push(
          none + ": a new drop in an untested market (" + num(rivals.n) + " rival seller" + (num(rivals.n) === 1 ? "" : "s") + ") → cold probe of " + t +
            (listedDays != null ? " (" + since + ", inside the probe window)" : "") + ".",
        );
        capToGame();
      }
    }
  } else if (forecast < cfg.minRate) {
    c = "skip";
    why.push("Forecast " + forecast + " a week is under the " + cfg.minRate + " threshold.");
  } else if (v > 0 && u < cfg.minWeeklyUsd) {
    c = "skip";
    why.push("Worth about $" + u + " a week at $" + v + " an account: under $" + cfg.minWeeklyUsd + ".");
  } else {
    td = farmSizing.coverageTarget({
      salesPerWeek: forecast,
      coverageDays: sizing.coverageDays,
      safetyStock: sizing.safetyStock,
      max: sizing.maxPerGame,
    });
    t = td;
    if (basis === "market" && ownW <= 0) {
      c = "probe";
      t = Math.min(t, Math.max(1, Math.floor(num(probeSize, 15))));
      why.push("Unproven for us; " + Math.round(cfg.captureShare * 100) + "% of that market is " + mp + " a week → probe " + t + ".");
      // Rival proof outranks the cooldown (the probe is market-led, not cold), but say so.
      if (dudKnown) why.push(dudLine());
    } else {
      c = "farm";
      // The engine's shelf floor applies to the brain too (every enabled market holds a few
      // accounts, doubled for the post-event holdback): the brain replaces the DEMAND estimate,
      // not the listing policy, so the two sides are compared on demand alone.
      const fl = Math.max(0, Math.floor(num(floor)));
      if (fl > t) t = Math.min(fl, num(sizing.maxPerGame, fl));
      why.push(
        (basis === "market" ? "Market-led: " + Math.round(cfg.captureShare * 100) + "% of it is " + mp + " a week. " : "") +
          forecast + "/wk × " + sizing.coverageDays + " days + " + sizing.safetyStock + " safety = " + td +
          (t > td ? "; the engine's shelf floor makes it " + t : "") + ".",
      );
    }
    capToGame();
    if (u != null) why.push("About $" + u + " a week at $" + v + " an account (" + (valueBasis || "our sales") + ").");
  }
  return { c, t, td, w: forecast, b: basis, own: round2(ownW), mp, mt, sh, proof, v, vb: valueBasis, u, dud: isDud, held, why };
}

// A cold-probe candidate's place in the budget queue: its oldest live campaign's start, unknown last.
const campaignStartOf = (v) => {
  const t = num(v.g.campaignStartAt, NaN);
  return Number.isFinite(t) ? t : Infinity;
};

/**
 * The engine's probe budget (decide.probeGate), across games: at most `max` probes at once, its own
 * in-flight probe tasks included (`engineProbes`, the tasks its gate counts). A cold probe on a game
 * the engine is already probing IS that probe and takes no new slot — the engine never counts a
 * game's own probe against it. The rest queue oldest campaign first: a lane held by the budget
 * retries every cycle, so the longest-waiting campaign takes a freed slot first. An unreadable task
 * count (null) holds every new probe. Mutates the held verdicts into skips.
 * @param {Array} verdicts [{ g, br }] — g.probing: the engine's probe tasks on the game;
 *                         g.campaignStartAt: when its oldest live campaign started (epoch ms)
 */
function applyProbeBudget(verdicts, { max, engineProbes }) {
  const queue = verdicts
    .filter((v) => v.br.c === "probe" && v.br.b === "cold" && !(num(v.g.probing) > 0))
    .sort((a, b) => campaignStartOf(a) - campaignStartOf(b) || String(a.g.key).localeCompare(String(b.g.key)));
  const cap = Math.max(0, Math.floor(num(max)));
  let active = engineProbes == null ? null : Math.max(0, num(engineProbes));
  for (const v of queue) {
    if (active != null && active < cap) {
      active++;
      continue;
    }
    const reason =
      active == null
        ? "Probe budget unknown: the auto-farm's probe tasks could not be read, so no new probe."
        : "Probe budget full (" + active + " active): at most " + cap + " probes at once, oldest campaigns first — this new drop waits for a slot.";
    v.br = { ...v.br, c: "skip", t: 0, b: "none", held: "budget", why: [reason].concat(v.br.why) };
  }
}

/** The first moment a game had a live listing (epoch ms), or null — from listingSpans' spans. */
function firstListedAt(spans) {
  let first = null;
  for (const s of spans || []) {
    const a = s && num(s[0], NaN);
    if (Number.isFinite(a) && (first === null || a < first)) first = a;
  }
  return first;
}

/**
 * The old engine's verdict, from `demandAllocation`'s return value and `internalSalesForGame`,
 * sized exactly as the decide step sizes it before subtracting stock (utils/farm2/steps/decide.js):
 * a farm decision asks for at least the shelf floor and at most the demand cap,
 * `min(max(target, floor), cap || maxPerGame)`; a probe asks for its own target.
 * @param {object} [o] { floor, maxPerGame, researchAt, now }
 */
function oldClaim(alloc, internalSales, o = {}) {
  const count = Math.max(0, num(internalSales && internalSales.count));
  const w = round2(farmSizing.salesPerWeek(count, farmSizing.DEFAULT_SALES_WINDOW_DAYS));
  const ra = o.researchAt && o.now ? round1((o.now - new Date(o.researchAt).getTime()) / DAY) : null;
  if (!alloc || alloc.error) return { c: "error", t: 0, w, n: count, ra, e: String((alloc && alloc.error) || "no verdict").slice(0, 120) };
  const ds = alloc.effective != null ? num(alloc.effective) : alloc.demand != null ? num(alloc.demand) : null;
  if (alloc.skip) return { c: "skip", t: 0, w, n: count, ds, ra, pb: !!alloc.probeBlocked };
  const target = Math.max(0, Math.round(num(alloc.target)));
  if (alloc.probe) return { c: "probe", t: target, w, n: count, ds, ra, cap: num(alloc.cap) };
  const ceiling = num(alloc.cap) || num(o.maxPerGame) || target;
  const t = Math.min(Math.max(target, Math.max(0, Math.floor(num(o.floor)))), ceiling);
  return { c: "farm", t, w, n: count, ds, ra, cap: num(alloc.cap) };
}

const acts = (c) => c === "farm" || c === "probe";

/** How the brain's call relates to the old one. */
function diffClass(old, br) {
  if (!br || br.c === "unknown") return "brain-unknown";
  if (!old || old.c === "error") return "old-error";
  const oa = acts(old.c);
  const ba = acts(br.c);
  if (!oa && !ba) return "agree-skip";
  if (!oa && ba) return "brain-farm";
  if (oa && !ba) return "brain-skip";
  const tol = Math.max(AGREE_ABS, Math.round(AGREE_REL * num(old.t)));
  const d = num(br.t) - num(old.t);
  if (Math.abs(d) <= tol) return "agree";
  return d > 0 ? "brain-more" : "brain-less";
}

/** Same comparison for a no-claim fleet target (both sides always "act"). */
function fleetDiff(oldT, brT) {
  const tol = Math.max(AGREE_ABS, Math.round(AGREE_REL * num(oldT)));
  const d = num(brT) - num(oldT);
  if (Math.abs(d) <= tol) return "agree";
  return d > 0 ? "brain-more" : "brain-less";
}

/* ----------------------------- the no-claim farm ---------------------------- */

/**
 * The no-claim bucket a game key belongs to: the LONGEST keyword it contains, or "" — the rule
 * utils/farmDemand.bucketFor applies, so "call of duty warzone" beside "call of duty" refines
 * rather than double-counts.
 */
function bucketOfKey(key, keywords) {
  const k = String(key || "");
  let best = "";
  for (const w of keywords || []) if (w && k.includes(w) && w.length > best.length) best = w;
  return best;
}

/** Radar rows of every game in a no-claim bucket ("rainbow six" catches "...rainbow six siege"). */
function bucketMarket(radarRows, bucket, keywords = [bucket]) {
  let rated = 0;
  let units = 0;
  let sellers = 0;
  let any = false;
  let anyRated = false;
  for (const r of radarRows || []) {
    if (!r || !r.key || bucketOfKey(r.key, keywords) !== bucket) continue;
    any = true;
    units += num(r.units);
    sellers += num(r.rivalSellers);
    if (r.perWeek != null) {
      anyRated = true;
      rated += num(r.perWeek);
    }
  }
  if (!any) return null;
  return { rivalPerWeek: anyRated ? round1(rated) : null, rivalUnits: units, rivalSellers: sellers };
}

/**
 * The brain's no-claim verdict. The feeder's own rule IS its snapshot — its evidence window, its
 * dating — so with it the brain's target equals the feeder's by construction; re-deriving the rule
 * from the brain's longer evidence read would date some sales differently (review finding M3). The
 * feeder is asked twice per run, on the same evidence and window, once per burst-guard setting
 * (inputs.noclaimInputs): `snapRow` is the rule it runs LIVE — `v2` while autoFarm.noclaimBurstGuard
 * is off (`guardLive` false, the default), `v2g` once the owner turns it on — and `altRow` the other
 * one, so v2g − v2 is the guard alone (review, 2026-10-03: v2g re-derived from the longer read
 * differed from v2 with nothing to guard). Every other estimator runs on the feeder's dated
 * evidence. `est` logs every estimator for scoring; a rule whose snapshot is missing logs null.
 * "mirror" = the configured estimator could not be computed this run.
 */
function noclaimVerdict({ snapRow, altRow = null, entries = null, now, cfg, demandRates = null, spans = null, guardLive = false }) {
  const sales = snapRow.sales || {};
  const stock = snapRow.stock || {};
  const pol = snapRow.policy || {};
  const old = { c: "fleet", t: Math.max(0, Math.round(num(snapRow.target))), w: round1(sales.perWeek), sh: round1(sales.shelfPerWeek), ot: round1(sales.otherPerWeek) };
  const snapRates = { shelf: round1(sales.shelfPerWeek), other: round1(sales.otherPerWeek), total: round1(sales.perWeek) };
  const alt = altRow && altRow.sales ? { shelf: round1(altRow.sales.shelfPerWeek), other: round1(altRow.sales.otherPerWeek), total: round1(altRow.sales.perWeek) } : null;
  const liveId = guardLive ? "v2g" : "v2";
  const byRule = guardLive ? { v2: alt, v2g: snapRates } : { v2: snapRates, v2g: alt };
  const est = entries ? { ...allEstimates(entries, now, { demandRates, spans }), v2: byRule.v2 ? byRule.v2.total : null, v2g: byRule.v2g ? byRule.v2g.total : null } : null;
  const id = cfg.estimatorNoclaim;
  const feeder = id === liveId;
  let r = null;
  if (id === "v2" || id === "v2g") r = byRule[id];
  else if (entries) r = estimate(id, entries, now, { demandRates, spans });
  if (!r) {
    const why = entries ? "The feeder's " + id + " snapshot was unreadable this run" : "The feeder's sale evidence was unreadable this run";
    return { old, br: { ...old, b: "mirror", why: [why + ": the brain shows the feeder's own number."] }, est };
  }
  const { target, parts } = farmSizing.shelfAwareTarget({
    shelfHeld: num(stock.listed),
    shelfPerWeek: r.shelf,
    otherPerWeek: r.other,
    coverageDays: num(pol.coverageDays, farmSizing.DEFAULT_COVERAGE_DAYS),
    safetyStock: num(pol.safetyStock, farmSizing.DEFAULT_SAFETY_STOCK),
    min: num(pol.min, 0),
    max: num(pol.max, farmSizing.HARD_MAX_ACCOUNTS),
  });
  const basisText = feeder ? "the feeder's own rates" : id === "v2" || id === "v2g" ? "the feeder's own rule, burst guard " + (id === "v2g" ? "on" : "off") : id;
  const why = [
    "Shelf (Gameflip/GGSel/Plati) " + r.shelf + "/wk, elsewhere " + r.other + "/wk (" + basisText + ").",
    "Target " + target + " = " + parts.shelf + " shelf + " + parts.other + " other + " + parts.safety + " safety.",
  ];
  return { old, br: { c: "fleet", t: target, w: r.total, sh: r.shelf, ot: r.other, b: feeder ? "feeder" : "own", why }, est };
}

/* ---------------------------------- a run ----------------------------------- */

const shortWhy = (list) => (list || []).slice(0, 4).map((s) => String(s).slice(0, 160));

/**
 * Every row of one run, from inputs utils/demandBrain/inputs.js loaded.
 * @param {object} p
 * @param {number} p.now
 * @param {object} p.cfg            readConfig()
 * @param {object} p.sizing         { coverageDays, safetyStock, maxPerGame, gameCaps }
 * @param {number} p.probeSize      autoFarm.probeSize
 * @param {Array}  p.claim          [{ key, label, live, hoursLeft, reuseOnly, entries, spans,
 *                                     radar, value, valueBasis, gameCap, stock, act, dud, probing,
 *                                     campaignStartAt, old:{alloc,sales,research,error} }]
 * @param {Array}  p.noclaim        [{ snapRow, altRow, entries, spans, radarRows, keywords, live }] —
 *                                   snapRow the feeder's live rule, altRow the same snapshot under the
 *                                   other burst-guard setting
 * Cold probes are sized by coldProbeSizeFor(cfg, engine.floor).
 * @param {object} [p.engine]       { floor, maxPerGame, probes } — the auto-farm's shelf floor, base
 *                                   cap and probe tasks in flight (its budget's count; null unread)
 * @param {Function} [p.demandRates]
 * @param {boolean} [p.burstGuardLive] autoFarm.noclaimBurstGuard: the feeder's snapshot is v2g, not v2
 */
function buildRun({ now, cfg, sizing, probeSize = 15, claim = [], noclaim = [], engine = {}, demandRates = null, burstGuardLive = false }) {
  const rows = [];
  const floor = Math.max(0, Math.floor(num(engine.floor)));
  // 1. every game's own verdict
  const verdicts = claim.map((g) => {
    const entries = g.entries || [];
    const ctx = { spans: g.spans || null, demandRates };
    const est = allEstimates(entries, now, ctx);
    const own = est[cfg.estimatorClaim] || 0;
    const market = marketView(g.radar || null, entries, now);
    const first = firstListedAt(g.spans);
    const evidence = {
      sold135: entries.some((e) => e.t > now - HISTORY_DAYS * DAY && e.t <= now),
      listed135: coveredDays(g.spans || [], now - HISTORY_DAYS * DAY, now) > 0,
      firstListedAt: first,
      listedDays: first == null ? null : Math.max(0, (now - first) / DAY),
    };
    // A pack without `dud` was not checked: null (only matters while probeColdStart is on).
    const dud = g.dud === undefined ? null : g.dud;
    const rivals = rivalSellersOf(g.old && g.old.research, g.radar || null);
    const br = claimVerdict({ own, market, value: g.value, valueBasis: g.valueBasis, cfg, sizing, gameCap: g.gameCap, probeSize, floor, evidence, live: !!g.live, dud, rivals });
    return { g, est, market, br };
  });
  // 2. the probe budget, which spans games
  applyProbeBudget(verdicts, { max: cfg.probeMaxGames, engineProbes: engine.probes });
  // 3. the rows, beside today's verdict
  for (const { g, est, market, br } of verdicts) {
    const old = oldClaim(g.old && g.old.alloc, g.old && g.old.sales, {
      floor,
      maxPerGame: engine.maxPerGame,
      researchAt: g.old && g.old.research ? g.old.research.at : null,
      now,
    });
    if (g.old && g.old.error) {
      old.c = "error";
      old.e = String(g.old.error).slice(0, 120);
    }
    rows.push({
      k: g.key,
      g: g.label,
      f: "claim",
      live: !!g.live,
      hl: g.hoursLeft == null ? null : round1(g.hoursLeft),
      ro: !!g.reuseOnly,
      old,
      br: {
        c: br.c,
        t: br.t,
        td: br.td,
        w: br.w,
        b: br.b,
        own: br.own,
        mp: br.mp,
        mt: br.mt,
        sh: br.sh,
        v: br.v,
        u: br.u,
        ...(br.dud ? { dud: br.dud } : {}),
        ...(br.held ? { held: br.held } : {}),
      },
      mk: market ? { rw: market.rivalPerWeek, ru: market.rivalUnits, rs: market.rivalSellers, ow: market.ourWatched, pm: market.realisedMedian, tts: market.medianTtsHours } : null,
      est,
      stk: g.stock ? { on: num(g.stock.onHand), fl: num(g.stock.inFlight) } : null,
      act: g.act || null,
      d: diffClass(old, br),
      why: shortWhy(br.why),
    });
  }
  for (const n of noclaim) {
    const v = noclaimVerdict({ snapRow: n.snapRow, altRow: n.altRow || null, entries: n.entries, now, cfg, demandRates, spans: n.spans, guardLive: !!burstGuardLive });
    const m = bucketMarket(n.radarRows, n.snapRow.key, n.keywords || [n.snapRow.key]);
    rows.push({
      k: n.snapRow.key,
      g: n.snapRow.label || n.snapRow.key,
      f: "noclaim",
      live: !!n.live,
      hl: null,
      ro: false,
      old: v.old,
      br: { c: v.br.c, t: v.br.t, w: v.br.w, b: v.br.b, sh: v.br.sh, ot: v.br.ot },
      mk: m ? { rw: m.rivalPerWeek, ru: m.rivalUnits, rs: m.rivalSellers } : null,
      est: v.est,
      stk: { on: num(n.snapRow.onHand), fl: num(n.snapRow.stock && n.snapRow.stock.inFlight) },
      act: null,
      d: v.br.b === "mirror" ? "mirror" : fleetDiff(v.old.t, v.br.t),
      why: shortWhy(v.br.why),
    });
  }
  return { rows, summary: summarize(rows) };
}

function summarize(rows) {
  const blank = () => Object.fromEntries(DIFFS.map((d) => [d, 0]));
  // Account totals compare like with like: only live games where BOTH sides have a verdict. A game
  // the brain has no evidence for is not a "0" — today's logic decides it alone, counted apart.
  // Cold probes (new drops, model v2) are verdicts and are compared; they are also counted apart,
  // with what today's logic asks for the same games, for the heartbeat's "cold probes N (old asks M)",
  // and so is every new drop a gate held back: a dud, a tested market (rivals list it, it does not
  // sell), a market nobody counted, a full probe budget.
  const s = {
    claim: {
      games: 0,
      live: 0,
      byDiff: blank(),
      byDiffLive: blank(),
      byClass: {},
      oldTargetLive: 0,
      brainTargetLive: 0,
      comparedLive: 0,
      unknownLive: 0,
      oldTargetUnknownLive: 0,
      coldProbes: 0,
      coldTarget: 0,
      oldTargetCold: 0,
      coldDuds: 0,
      coldHeldTested: 0,
      coldHeldUnknown: 0,
      coldHeldBudget: 0,
    },
    noclaim: { buckets: 0, byDiff: blank(), oldTarget: 0, brainTarget: 0 },
  };
  for (const r of rows) {
    if (r.f === "claim") {
      s.claim.games++;
      s.claim.byDiff[r.d] = (s.claim.byDiff[r.d] || 0) + 1;
      s.claim.byClass[r.br.c] = (s.claim.byClass[r.br.c] || 0) + 1;
      if (r.live) {
        s.claim.live++;
        s.claim.byDiffLive[r.d] = (s.claim.byDiffLive[r.d] || 0) + 1;
        if (r.br.c === "unknown") {
          s.claim.unknownLive++;
          s.claim.oldTargetUnknownLive += acts(r.old.c) ? num(r.old.t) : 0;
        } else if (r.old.c !== "error") {
          s.claim.comparedLive++;
          s.claim.oldTargetLive += acts(r.old.c) ? num(r.old.t) : 0;
          s.claim.brainTargetLive += acts(r.br.c) ? num(r.br.t) : 0;
        }
        if (r.br.c === "probe" && r.br.b === "cold") {
          s.claim.coldProbes++;
          s.claim.coldTarget += num(r.br.t);
          s.claim.oldTargetCold += acts(r.old.c) ? num(r.old.t) : 0;
        } else if (r.br.dud) {
          s.claim.coldDuds++;
        } else if (r.br.held === "tested") {
          s.claim.coldHeldTested++;
        } else if (r.br.held === "unknown") {
          s.claim.coldHeldUnknown++;
        } else if (r.br.held === "budget") {
          s.claim.coldHeldBudget++;
        }
      }
    } else {
      s.noclaim.buckets++;
      s.noclaim.byDiff[r.d] = (s.noclaim.byDiff[r.d] || 0) + 1;
      s.noclaim.oldTarget += num(r.old.t);
      s.noclaim.brainTarget += num(r.br.t);
    }
  }
  return s;
}

/* --------------------------------- scoring ---------------------------------- */

/** Sales dated inside [from, to). */
function actualIn(entries, from, to) {
  let n = 0;
  for (const e of entries || []) if (e.t >= from && e.t < to) n++;
  return n;
}

// Three numbers per estimator: the average miss (MAE — easy to read), the root-mean-square miss
// (RMSE) and the bias. The best estimator is picked on RMSE, NOT on MAE: MAE is minimised by the
// median, and for a game selling under ~0.7 a week the median week is ZERO, so ranking on MAE rewards
// forecasting zero for every small seller. RMSE is minimised by the mean, the number a farm needs —
// an unfarmed campaign's drops are gone for good, so a systematically low forecast costs more than
// it looks.
function newScore() {
  return { n: 0, absErr: 0, sqErr: 0, err: 0, forecast: 0, actual: 0 };
}
function addScore(s, f, a) {
  s.n++;
  s.absErr += Math.abs(f - a);
  s.sqErr += (f - a) * (f - a);
  s.err += f - a;
  s.forecast += f;
  s.actual += a;
}
function finishScore(s) {
  return {
    n: s.n,
    mae: s.n ? round2(s.absErr / s.n) : null,
    rmse: s.n ? round2(Math.sqrt(s.sqErr / s.n)) : null,
    bias: s.n ? round2(s.err / s.n) : null,
    forecast: round1(s.forecast),
    actual: s.actual,
  };
}

// A claim-farm game-week counts as IN STOCK when the game had a live listing on at least this many
// of its 7 days. Realised sales are censored by stock-outs: a week with nothing listed sells nothing
// whatever the demand, so an estimator built to see through stock-outs (`listed`, `v2`) is bound to
// look "too high" against such a week. Scoring the in-stock weeks apart is the fairer comparison.
// (Not applied to the no-claim farm: its Eldorado set offers stay listed while covering 0 accounts.)
const IN_STOCK_DAYS = 6;

// ONE admission rule for the backtest and the forward test (review, 2026-10-03): a game-week is
// scored when it sold, or when ANY estimator forecast a sale for it. All-zero game-weeks are right for
// every estimator and would only dilute the error, but a week one estimator forecast sales for and
// none came is exactly the miss that must count: the backtest used to admit a week only when the game
// had sold in the 45 days before it — avg45's own horizon — which hid every sba/tsb false alarm 46–91
// days after a game's last sale. Every estimator is scored on every admitted row, a missing forecast
// as 0, so all are compared on the same rows. An estimator a logged row does not carry at all (it was
// logged before the estimator existed) is flagged `partial` — "not enough history yet" — and is never
// ranked (bestOf).
//
// The longest look-back of any estimator (sba/tsb's 13 weeks): a game with no sale inside it before
// a week, and none during it, forecasts 0 everywhere, so the backtest skips it without computing.
const LOOKBACK_DAYS = Math.max(45, INTERMITTENT_WEEKS * 7);

// The estimators scored for a farm: every current one, plus today's own reading (`engine`, claim
// farm) where it was logged — it cannot be replayed, so the backtest has no `engine`.
const scoredIds = (farm, withEngine) => (withEngine && farm === "claim" ? ESTIMATORS.concat("engine") : ESTIMATORS);

const forecastsSale = (forecasts) => Object.values(forecasts).some((v) => num(v) > 0);

function admitRow(by, farm, forecasts, actual, ids) {
  const f = by[farm] || (by[farm] = { rows: 0, ids, s: {} });
  f.rows++;
  for (const id of ids) {
    // not in this row at all: logged before the estimator existed — no history, not a forecast of 0
    if (!Object.prototype.hasOwnProperty.call(forecasts, id)) continue;
    if (!f.s[id]) f.s[id] = newScore();
    addScore(f.s[id], num(forecasts[id], 0), actual);
  }
}

function finishAll(by) {
  const out = {};
  for (const [farm, f] of Object.entries(by)) {
    out[farm] = {};
    for (const id of f.ids) {
      const s = finishScore(f.s[id] || newScore());
      if (s.n < f.rows) s.partial = true;
      out[farm][id] = s;
    }
  }
  return out;
}

const stockedWeek = (farm, spans, from, to) => farm === "claim" && !!spans && spans.length > 0 && coveredDays(spans, from, to) >= IN_STOCK_DAYS;

/**
 * Replay the last `weeks` weeks: at each week's start every estimator forecasts the next 7 days
 * from the sales dated before it; truth is the sales dated inside it. A game-week is scored when it
 * sold or any estimator forecast a sale (admitRow).
 * @param {Array} games [{ key, farm, entries, spans }]
 * @returns {{ weeks, scores, best, scoresInStock, bestInStock }}
 */
function backtest({ games = [], now, weeks = 6, demandRates = null }) {
  const by = {}; // farm -> rows + estimator -> score
  const byStocked = {};
  const perWeek = [];
  for (let k = weeks; k >= 1; k--) {
    const T = now - k * 7 * DAY;
    const end = T + 7 * DAY;
    const wk = { from: new Date(T), to: new Date(end), games: 0, actual: 0, inStock: 0 };
    for (const g of games) {
      const entries = g.entries || [];
      const actual = actualIn(entries, T, end);
      if (!actual && !entries.some((e) => e.t > T - LOOKBACK_DAYS * DAY && e.t <= T)) continue;
      const est = allEstimates(entries, T, { spans: g.spans || null, demandRates });
      if (!actual && !forecastsSale(est)) continue;
      wk.games++;
      wk.actual += actual;
      const farm = g.farm || "claim";
      admitRow(by, farm, est, actual, scoredIds(farm, false));
      if (stockedWeek(farm, g.spans, T, end)) {
        wk.inStock++;
        admitRow(byStocked, farm, est, actual, scoredIds(farm, false));
      }
    }
    perWeek.push(wk);
  }
  const scores = finishAll(by);
  const scoresInStock = finishAll(byStocked);
  return { weeks: perWeek, scores, best: bestOf(scores), scoresInStock, bestInStock: bestOf(scoresInStock) };
}

/**
 * Score logged forecasts once their week is over, admitted and compared exactly as the backtest
 * (admitRow). Today's engine reading is scored beside the estimators on the claim farm; an errored
 * verdict forecast nothing (0).
 * @param {Array} samples [{ at, rows }] — one logged run per day
 * @param {Function} entriesFor (farm, key) -> entries, the evidence as known NOW
 * @param {Function} [spansFor] (farm, key) -> listing spans, for the in-stock split
 */
function forwardScores({ samples = [], entriesFor, spansFor = () => null, now }) {
  const by = {};
  const byStocked = {};
  let scored = 0;
  let waiting = 0;
  for (const run of samples) {
    const T = new Date(run.at).getTime();
    if (!Number.isFinite(T)) continue;
    if (T + 7 * DAY > now) {
      waiting++;
      continue;
    }
    scored++;
    for (const r of run.rows || []) {
      // a no-claim row logged without estimates (its evidence was unreadable) has nothing to score
      if (!r.est || typeof r.est !== "object") continue;
      const entries = entriesFor(r.f, r.k);
      if (!entries) continue;
      const actual = actualIn(entries, T, T + 7 * DAY);
      const forecasts = { ...r.est };
      if (r.f === "claim") forecasts.engine = r.old && r.old.c !== "error" ? num(r.old.w, 0) : 0;
      if (!actual && !forecastsSale(forecasts)) continue;
      admitRow(by, r.f, forecasts, actual, scoredIds(r.f, true));
      if (stockedWeek(r.f, spansFor(r.f, r.k), T, T + 7 * DAY)) admitRow(byStocked, r.f, forecasts, actual, scoredIds(r.f, true));
    }
  }
  const scores = finishAll(by);
  const scoresInStock = finishAll(byStocked);
  return { runsScored: scored, runsWaiting: waiting, scores, best: bestOf(scores), scoresInStock, bestInStock: bestOf(scoresInStock) };
}

// The estimator with the lowest RMSE per farm (ties: the smaller |bias|), among those scored on
// every admitted row — a `partial` one (not enough history yet) is never ranked. See newScore for
// why not MAE.
function bestOf(scores) {
  const best = {};
  for (const [farm, m] of Object.entries(scores || {})) {
    let pick = null;
    for (const [id, s] of Object.entries(m)) {
      if (!s.n || s.rmse == null || s.partial) continue;
      if (!pick || s.rmse < pick.rmse || (s.rmse === pick.rmse && Math.abs(s.bias) < Math.abs(pick.bias))) pick = { id, rmse: s.rmse, mae: s.mae, bias: s.bias };
    }
    if (pick) best[farm] = pick;
  }
  return best;
}

/**
 * Last week's disagreements and what happened next.
 * @param {Function} rivalUnitsFor (key, from, to) -> rival units sold in that span, or null
 */
function decisionReview({ samples = [], entriesFor, rivalUnitsFor = () => null, now, limit = 60 }) {
  const out = [];
  for (const run of samples) {
    const T = new Date(run.at).getTime();
    if (!Number.isFinite(T) || T + 7 * DAY > now) continue;
    for (const r of run.rows || []) {
      if (r.f !== "claim" || !r.live || !REVIEW_DIFFS.has(r.d)) continue;
      const entries = entriesFor(r.f, r.k) || [];
      out.push({
        at: run.at,
        key: r.k,
        game: r.g,
        d: r.d,
        old: { c: r.old.c, t: r.old.t },
        brain: { c: r.br.c, t: r.br.t, b: r.br.b },
        ourSales7: actualIn(entries, T, T + 7 * DAY),
        rivalUnits7: rivalUnitsFor(r.k, T, T + 7 * DAY),
      });
    }
  }
  out.sort((a, b) => new Date(b.at) - new Date(a.at));
  return out.slice(0, limit);
}

module.exports = {
  MODEL_VERSION,
  HISTORY_DAYS,
  SHELF_MARKETS,
  WATCHED_MARKETS,
  BURST_MARKETS,
  isBurstSale,
  ESTIMATORS,
  DEFAULTS,
  DIFFS,
  REVIEW_DIFFS,
  IN_STOCK_DAYS,
  MIN_INTERVAL_MIN,
  RIVAL_FEE_SHARE,
  INTERMITTENT_WEEKS,
  SBA_ALPHA,
  TSB_ALPHA,
  TSB_BETA,
  DAY,
  LOOKBACK_DAYS,
  isOn,
  readConfig,
  coldProbeSizeFor,
  rivalSellersOf,
  applyProbeBudget,
  probeCooldownDaysOf,
  listingSpans,
  coveredDays,
  firstListedAt,
  countIn,
  weeklyCounts,
  sbaRate,
  tsbRate,
  estimate,
  allEstimates,
  v2Rates,
  marketView,
  claimVerdict,
  oldClaim,
  diffClass,
  fleetDiff,
  bucketOfKey,
  bucketMarket,
  noclaimVerdict,
  buildRun,
  summarize,
  actualIn,
  backtest,
  forwardScores,
  decisionReview,
  bestOf,
};
