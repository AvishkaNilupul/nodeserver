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
const MODEL_VERSION = 1;
// Sales are read this far back so each one is dated by its EARLIEST evidence (a sale seen by the
// marketplace in August and by the drop scanner in September is an August sale), and so the
// backtest has six weeks to replay.
const HISTORY_DAYS = 135;
// Markets where stock is committed up front and a day without a sale is a day without a buyer
// (farmDemand.SHELF_MARKETS). Every other market sells only while matching stock exists.
const SHELF_MARKETS = new Set(["gameflip", "ggsel", "digiseller"]);
// The markets the radar reads (its "plati" is Digiseller).
const WATCHED_MARKETS = SHELF_MARKETS;
const ESTIMATORS = ["avg45", "avg30", "max30_14", "v2", "listed"];
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

/** The brain's settings (autoFarm.demandBrain), every field validated and defaulted. */
function readConfig(af) {
  const raw = af && af.demandBrain && typeof af.demandBrain === "object" ? af.demandBrain : {};
  const est = (v, d) => (ESTIMATORS.includes(String(v)) ? String(v) : d);
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
  };
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
    default:
      return 0;
  }
}

// The no-claim feeder's own rate rule (utils/farmDemand.js demandRates, feeder v2): shelf markets
// at their raw rate, every other market at its in-stock rate by selling days, each the larger of
// the 30-day and 14-day figure. When production's farmDemand exports demandRates it is called
// directly (a true mirror); this copy is the fallback and is checked against it on real data.
function v2Rates(entries, now, demandRates) {
  const from = now - 30 * DAY;
  const units = [];
  for (const e of entries) if (e.t >= from && e.t <= now) units.push({ firstAt: new Date(e.t), market: e.m });
  if (typeof demandRates === "function") {
    const r = demandRates(units, { days: 30, shortDays: 14, now }) || {};
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
    }
  }
  const s = round1(Math.max(farmSizing.salesPerWeek(shelf, 30), farmSizing.salesPerWeek(shelfShort, 14)));
  const o = round1(
    Math.max(
      farmSizing.inStockRate({ count: other, sellingDays: otherDays.size, windowDays: 30 }),
      farmSizing.inStockRate({ count: otherShort, sellingDays: otherDaysShort.size, windowDays: 14 }),
    ),
  );
  return { shelf: s, other: o, total: round1(s + o), source: "brain" };
}

/**
 * One estimator's weekly rate for a game's dated sales, split shelf / other.
 * @param {string} id        one of ESTIMATORS
 * @param {Array}  entries   [{ t: epoch ms, m: market }] — the game's sales, any window
 * @param {number} now       the moment the forecast is made (sales after it are ignored)
 * @param {object} ctx       { spans, demandRates }
 * @returns {{ shelf:number, other:number, total:number }}
 */
function estimate(id, entries, now, ctx = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (id === "v2") {
    const r = v2Rates(list, now, ctx.demandRates);
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

/**
 * The brain's call for one claim-farm game.
 * @returns {{ c:"farm"|"probe"|"skip"|"unknown", t:number, w:number, b:"own"|"market"|"none",
 *             own:number, mp:number, mt:number|null, sh:number|null, proof:boolean, v:number,
 *             vb:string, u:number|null, why:string[] }}
 */
function claimVerdict({ own = 0, market = null, value = 0, valueBasis = "", cfg, sizing, gameCap = 0, probeSize = 15, floor = 0, evidence = {} }) {
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
  const basis = forecast <= 0 ? "none" : ownW >= mp ? "own" : "market";
  const v = Math.max(0, round2(value));
  const u = v > 0 ? round2(forecast * v) : null;

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
  if (forecast <= 0) {
    const noEvidence = !evidence.sold135 && !evidence.listed135 && !rated;
    c = noEvidence ? "unknown" : "skip";
    why.push(noEvidence ? "No sale or listing of ours in " + HISTORY_DAYS + " days and no rated market: no evidence either way." : "No recent sale of ours and no proven market.");
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
    const capped = gameCap > 0 && t > gameCap;
    if (capped) {
      t = Math.floor(gameCap);
      why.push("Held to " + t + " by your cap for this game.");
    }
    if (u != null) why.push("About $" + u + " a week at $" + v + " an account (" + (valueBasis || "our sales") + ").");
  }
  return { c, t, td, w: forecast, b: basis, own: round2(ownW), mp, mt, sh, proof, v, vb: valueBasis, u, why };
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
 * The brain's no-claim verdict. With the feeder's own rule (`v2`) the rates ARE the feeder's snapshot
 * rates — its evidence window, its dating — so the brain's target equals the feeder's by
 * construction; re-deriving them from the brain's longer evidence read could drift (a sale whose
 * oldest evidence falls between the two look-backs dates differently). Any other estimator runs on
 * the feeder's dated evidence. `est` logs every estimator for scoring, `v2` being the snapshot's own
 * weekly rate. "mirror" = the configured estimator could not be computed this run.
 */
function noclaimVerdict({ snapRow, entries = null, now, cfg, demandRates = null, spans = null }) {
  const sales = snapRow.sales || {};
  const stock = snapRow.stock || {};
  const pol = snapRow.policy || {};
  const old = { c: "fleet", t: Math.max(0, Math.round(num(snapRow.target))), w: round1(sales.perWeek), sh: round1(sales.shelfPerWeek), ot: round1(sales.otherPerWeek) };
  const snapRates = { shelf: round1(sales.shelfPerWeek), other: round1(sales.otherPerWeek), total: round1(sales.perWeek) };
  const est = entries ? { ...allEstimates(entries, now, { demandRates, spans }), v2: snapRates.total } : null;
  let r;
  if (cfg.estimatorNoclaim === "v2") r = snapRates;
  else if (entries) r = estimate(cfg.estimatorNoclaim, entries, now, { demandRates, spans });
  else return { old, br: { ...old, b: "mirror", why: ["The feeder's sale evidence was unreadable this run: the brain shows the feeder's own number."] }, est: null };
  const { target, parts } = farmSizing.shelfAwareTarget({
    shelfHeld: num(stock.listed),
    shelfPerWeek: r.shelf,
    otherPerWeek: r.other,
    coverageDays: num(pol.coverageDays, farmSizing.DEFAULT_COVERAGE_DAYS),
    safetyStock: num(pol.safetyStock, farmSizing.DEFAULT_SAFETY_STOCK),
    min: num(pol.min, 0),
    max: num(pol.max, farmSizing.HARD_MAX_ACCOUNTS),
  });
  const why = [
    "Shelf (Gameflip/GGSel/Plati) " + r.shelf + "/wk, elsewhere " + r.other + "/wk (" + (cfg.estimatorNoclaim === "v2" ? "the feeder's own rates" : cfg.estimatorNoclaim) + ").",
    "Target " + target + " = " + parts.shelf + " shelf + " + parts.other + " other + " + parts.safety + " safety.",
  ];
  return { old, br: { c: "fleet", t: target, w: r.total, sh: r.shelf, ot: r.other, b: cfg.estimatorNoclaim === "v2" ? "feeder" : "own", why }, est };
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
 *                                     radar, value, valueBasis, gameCap, stock, act, old:{alloc,sales,error} }]
 * @param {Array}  p.noclaim        [{ snapRow, entries, spans, radarRows, keywords, live }]
 * @param {object} [p.engine]       { floor, maxPerGame } — the auto-farm's shelf floor and base cap
 * @param {Function} [p.demandRates]
 */
function buildRun({ now, cfg, sizing, probeSize = 15, claim = [], noclaim = [], engine = {}, demandRates = null }) {
  const rows = [];
  const floor = Math.max(0, Math.floor(num(engine.floor)));
  for (const g of claim) {
    const entries = g.entries || [];
    const ctx = { spans: g.spans || null, demandRates };
    const est = allEstimates(entries, now, ctx);
    const own = est[cfg.estimatorClaim] || 0;
    const market = marketView(g.radar || null, entries, now);
    const evidence = {
      sold135: entries.some((e) => e.t > now - HISTORY_DAYS * DAY && e.t <= now),
      listed135: coveredDays(g.spans || [], now - HISTORY_DAYS * DAY, now) > 0,
    };
    const br = claimVerdict({ own, market, value: g.value, valueBasis: g.valueBasis, cfg, sizing, gameCap: g.gameCap, probeSize, floor, evidence });
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
      br: { c: br.c, t: br.t, td: br.td, w: br.w, b: br.b, own: br.own, mp: br.mp, mt: br.mt, sh: br.sh, v: br.v, u: br.u },
      mk: market ? { rw: market.rivalPerWeek, ru: market.rivalUnits, rs: market.rivalSellers, ow: market.ourWatched, pm: market.realisedMedian, tts: market.medianTtsHours } : null,
      est,
      stk: g.stock ? { on: num(g.stock.onHand), fl: num(g.stock.inFlight) } : null,
      act: g.act || null,
      d: diffClass(old, br),
      why: shortWhy(br.why),
    });
  }
  for (const n of noclaim) {
    const v = noclaimVerdict({ snapRow: n.snapRow, entries: n.entries, now, cfg, demandRates, spans: n.spans });
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
  const s = {
    claim: { games: 0, live: 0, byDiff: blank(), byDiffLive: blank(), byClass: {}, oldTargetLive: 0, brainTargetLive: 0, comparedLive: 0, unknownLive: 0, oldTargetUnknownLive: 0 },
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

function finishAll(by) {
  const out = {};
  for (const [farm, m] of Object.entries(by)) out[farm] = Object.fromEntries(Object.entries(m).map(([id, s]) => [id, finishScore(s)]));
  return out;
}

function addAll(by, farm, forecasts, actual) {
  if (!by[farm]) by[farm] = {};
  for (const [id, f] of Object.entries(forecasts)) {
    if (f == null) continue;
    if (!by[farm][id]) by[farm][id] = newScore();
    addScore(by[farm][id], num(f), actual);
  }
}

const stockedWeek = (farm, spans, from, to) => farm === "claim" && !!spans && spans.length > 0 && coveredDays(spans, from, to) >= IN_STOCK_DAYS;

/**
 * Replay the last `weeks` weeks: at each week's start every estimator forecasts the next 7 days
 * from the sales dated before it; truth is the sales dated inside it. A game counts in a week only
 * when it sold something in the 45 days before or the 7 days of it (all-zero games are trivially
 * right for every estimator and would only dilute the error).
 * @param {Array} games [{ key, farm, entries, spans }]
 * @returns {{ weeks, scores, best, scoresInStock, bestInStock }}
 */
function backtest({ games = [], now, weeks = 6, demandRates = null }) {
  const by = {}; // farm -> estimator -> score
  const byStocked = {};
  const perWeek = [];
  for (let k = weeks; k >= 1; k--) {
    const T = now - k * 7 * DAY;
    const end = T + 7 * DAY;
    const wk = { from: new Date(T), to: new Date(end), games: 0, actual: 0, inStock: 0 };
    for (const g of games) {
      const entries = g.entries || [];
      const actual = actualIn(entries, T, end);
      const before = actualIn(entries, T - 45 * DAY, T);
      if (!actual && !before) continue;
      wk.games++;
      wk.actual += actual;
      const est = allEstimates(entries, T, { spans: g.spans || null, demandRates });
      const farm = g.farm || "claim";
      addAll(by, farm, est, actual);
      if (stockedWeek(farm, g.spans, T, end)) {
        wk.inStock++;
        addAll(byStocked, farm, est, actual);
      }
    }
    perWeek.push(wk);
  }
  const scores = finishAll(by);
  const scoresInStock = finishAll(byStocked);
  return { weeks: perWeek, scores, best: bestOf(scores), scoresInStock, bestInStock: bestOf(scoresInStock) };
}

/**
 * Score logged forecasts once their week is over.
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
      const entries = entriesFor(r.f, r.k);
      if (!entries) continue;
      const actual = actualIn(entries, T, T + 7 * DAY);
      const forecasts = { ...(r.est || {}) };
      if (r.f === "claim" && r.old && r.old.w != null && r.old.c !== "error") forecasts.engine = num(r.old.w);
      if (!actual && !Object.values(forecasts).some((v) => num(v) > 0)) continue;
      addAll(by, r.f, forecasts, actual);
      if (stockedWeek(r.f, spansFor(r.f, r.k), T, T + 7 * DAY)) addAll(byStocked, r.f, forecasts, actual);
    }
  }
  const scores = finishAll(by);
  const scoresInStock = finishAll(byStocked);
  return { runsScored: scored, runsWaiting: waiting, scores, best: bestOf(scores), scoresInStock, bestInStock: bestOf(scoresInStock) };
}

// The estimator with the lowest RMSE per farm (ties: the smaller |bias|). See newScore for why not MAE.
function bestOf(scores) {
  const best = {};
  for (const [farm, m] of Object.entries(scores || {})) {
    let pick = null;
    for (const [id, s] of Object.entries(m)) {
      if (!s.n || s.rmse == null) continue;
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
  ESTIMATORS,
  DEFAULTS,
  DIFFS,
  REVIEW_DIFFS,
  IN_STOCK_DAYS,
  MIN_INTERVAL_MIN,
  RIVAL_FEE_SHARE,
  DAY,
  isOn,
  readConfig,
  listingSpans,
  coveredDays,
  countIn,
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
