// The listing brain's runner — docs/LISTING-BRAIN-PLAN.md §7.
//
// TEST MODE. Each run works out, per game × farm × marketplace, where the farmed stock should go, what
// each offer should cost and whether each live system-made listing's price should move — and logs it
// beside what today's listing code does at the same moment, to be scored later against what actually
// sold. It never changes a price, a listing, a setting, an account, a reservation or a task, and makes
// no marketplace call: its ONLY writes are its own log — one ListingBrainRun document and its
// ListingBrainRow rows per run (Mongoose also creates those two collections' indexes on first use).
//
// Started from routes/priceTrackerRoutes.real(), which server.js calls once at boot; nothing else
// starts it, so tests and the preview never run it. Switch: autoFarm.listingBrain.enabled (default
// off), read on every tick, so turning it on or off needs no restart.
const model = require("./model");
const inputs = require("./inputs");

const DAY = 86400000;
// First tick a while after boot, and after the farm brain's first run (6 min): the brain reads the
// farm brain's newest rows, and the report caches are warm by then.
const BOOT_DELAY_MS = 9 * 60000;
// While switched off, how often the switch is re-read.
const OFF_RECHECK_MS = 10 * 60000;
// A run that cannot gather its inputs in this long is abandoned (it logs nothing).
const RUN_TIMEOUT_MS = 10 * 60000;
const ACCURACY_TTL_MS = 10 * 60000;
// The scorer reuses the last run's bundle while it is this fresh.
const EVIDENCE_TTL_MS = 2 * 3600000;
const HISTORY_LIMIT = 72;
const SAMPLE_DAYS = 21;
const BACKTEST_WEEKS = 6;
// Cells one run can hold (150 games × 2 farms × 7 markets plus the per-game rows is ~2,400).
const MAX_ROWS_PER_RUN = 6000;
// Advised moves read back after a restart, for the cool-down (one bounded read of the newest daily forecasts).
const PRIOR_CAP = 20000;

const blankState = () => ({
  started: false,
  // when the loop last began waiting to run (loopStatus)
  since: null,
  timer: null,
  nextRunAt: null,
  running: false,
  pendingLoad: null,
  pendingSince: null,
  runs: 0,
  // bumped by every successful run: a score computed from older evidence is never cached over it
  gen: 0,
  lastRunAt: null,
  lastMs: null,
  lastError: "",
  lastSummary: null,
  lastPersisted: null,
  // the newest run, in memory only: its rows WITH reasons, its offers and its fitted model (ctx)
  latest: null,
  run: null,
  bundle: null,
  bundleAt: 0,
  // UTC day whose per-listing forecasts have been written (one daily sample for the forward score)
  fcDay: "",
  // listing id hash -> { a, at }: the last advised non-hold action per listing (the cool-down)
  prior: new Map(),
  priorLoaded: false,
  offLogged: false,
  accuracy: null,
  accuracyInflight: null,
});
const state = blankState();

const defaultHooks = () => ({
  load: (o) => inputs.load(o),
  Run: () => require("../../models/ListingBrainRun"),
  Row: () => require("../../models/ListingBrainRow"),
  settings: () => require("../settings"),
  log: (...a) => console.log(...a),
  logErr: (...a) => console.error(...a),
});
let hooks = defaultHooks();

/** Tests swap the loader, the models, the logger, the clock. */
function _setHooks(h) {
  hooks = { ...hooks, ...(h || {}) };
}
function _reset() {
  stop();
  hooks = defaultHooks();
  Object.assign(state, blankState());
}

const clock = () => (typeof hooks.now === "function" ? hooks.now() : Date.now());
const msg = (e) => (e && e.message ? e.message : String(e));
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

function readConfig() {
  try {
    return model.readConfig(hooks.settings().getAutoFarm() || {});
  } catch {
    return model.readConfig({});
  }
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(what)), ms);
      if (timer.unref) timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

// Rows of the first run of each UTC day (the daily sample the forward score reads) are kept as long
// as runs; every other run's rows only a week — a cell's intraday history is a convenience, and at
// the 150-game scale keeping them all 21 days would cost ~105 MB (docs/LISTING-BRAIN-PLAN.md §6).
const ROW_KEEP_DAYS_DAILY = 21;
const ROW_KEEP_DAYS_OTHER = 7;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);

// Sparse copy of a value: nulls, `false`, empty lists and empty objects are dropped at any depth, and
// so are the zero entries of the action counts (`br.a`). Every OTHER zero is kept: a forecast of 0
// or a shelf of 0 is a number, and the scorer reads a missing number as missing, never as 0.
function sparse(v, zeroDrops = false) {
  if (v === null || v === undefined || v === false) return undefined;
  if (Array.isArray(v)) return v.length ? v : undefined;
  if (!isPlainObject(v)) return zeroDrops && v === 0 ? undefined : v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    const y = sparse(x, false);
    if (y !== undefined) out[k] = y;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * The persisted row: everything but the reasons (kept for the newest run, in memory), sparse.
 * Readers of logged rows treat an absent field as null / false / none.
 */
function compact(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (k === "why") continue;
    let y;
    if (k === "br" && isPlainObject(v)) {
      const br = {};
      for (const [bk, bv] of Object.entries(v)) {
        const z = bk === "a" && isPlainObject(bv) ? sparse(Object.fromEntries(Object.entries(bv).filter(([, n]) => n !== 0))) : sparse(bv);
        if (z !== undefined) br[bk] = z;
      }
      y = br;
    } else {
      y = sparse(v);
    }
    // The identity fields are always written, even when empty.
    if (y !== undefined || k === "k" || k === "f" || k === "m") out[k] = y === undefined ? v : y;
  }
  return out;
}

const ACTION_KEYS = ["hold", "lower", "raise", "test", "ladder"];

/**
 * A row read back from the log, in the shape of a row kept in memory (minus its reasons): the
 * sub-objects and the action counts the sparse write left out are put back, so the page, the routes
 * and the scorer read logged and in-memory rows the same way. Absent numbers stay absent (null-like).
 */
function expand(row) {
  if (!row || typeof row !== "object") return row;
  const out = { ...row };
  for (const k of ["old", "br", "pol", "pf", "ev"]) out[k] = isPlainObject(out[k]) ? { ...out[k] } : {};
  if (out.m !== "all") {
    const a = isPlainObject(out.br.a) ? out.br.a : {};
    out.br.a = Object.fromEntries(ACTION_KEYS.map((x) => [x, Number(a[x]) || 0]));
  }
  if (!Array.isArray(out.fl)) out.fl = [];
  if (out.live === undefined) out.live = false;
  if (out.hl === undefined) out.hl = null;
  if (out.pc === undefined) out.pc = "";
  if (out.sc === undefined) out.sc = "";
  if (out.g === undefined) out.g = "";
  return out;
}

function heartbeat(doc, run, persisted) {
  try {
    return model.heartbeatText(doc, run, persisted, { runs: state.runs });
  } catch (e) {
    return "listingBrain: run " + state.runs + " — (heartbeat unavailable: " + msg(e) + ")" + (persisted ? "" : " | NOT LOGGED (write failed)");
  }
}

/**
 * After a restart the in-memory cool-down map is empty: read the advised actions of the newest daily
 * forecasts once (one bounded, projected read of one run document). A failure only means no cool-down
 * this run, which can make a row's advice repeat sooner — never a move (the brain moves nothing).
 */
async function loadPrior(now, notes) {
  if (state.priorLoaded) return;
  state.priorLoaded = true;
  try {
    const cfg = readConfig();
    const since = new Date(now - Math.max(1, cfg.cooldownH) * 3600000);
    const doc = await hooks
      .Run()
      .findOne({ at: { $gte: since }, fcN: { $gt: 0 } }, { at: 1, "fc.l": 1, "fc.a": 1 })
      .sort({ at: -1 })
      .lean();
    if (!doc || !Array.isArray(doc.fc)) return;
    const at = new Date(doc.at).getTime();
    for (const f of doc.fc.slice(0, PRIOR_CAP)) {
      if (!f || !f.l || !f.a || f.a === "hold" || f.a === "new" || f.a === "none" || f.a === "ladder") continue;
      if (!state.prior.has(f.l)) state.prior.set(f.l, { a: f.a, at });
    }
  } catch (e) {
    notes.push("The cool-down history could not be read back after a restart (" + msg(e) + "): no cool-down this run.");
  }
}

// Remember each live row's newest advised move for the cool-down; drop entries that are long past it.
function rememberActions(fc, now, cooldownH) {
  for (const f of fc || []) {
    if (!f || !f.l) continue;
    if (f.a === "lower" || f.a === "raise" || f.a === "test") {
      const prev = state.prior.get(f.l);
      if (!prev || prev.a !== f.a) state.prior.set(f.l, { a: f.a, at: now });
    }
  }
  const keep = Math.max(1, cooldownH) * 3600000 * 2;
  for (const [k, v] of state.prior) if (now - v.at > keep) state.prior.delete(k);
}

/**
 * Whether this run carries its UTC day's per-listing forecasts: the first run of each day does. A
 * process restart in the middle of a day checks the log (one indexed read) so a second sample of the
 * same day is never written.
 */
async function firstOfDay(day) {
  if (state.fcDay === day) return false;
  try {
    const seen = await hooks.Run().findOne({ day, fcN: { $gt: 0 } }, { _id: 1 }).lean();
    if (seen) {
      state.fcDay = day;
      return false;
    }
  } catch {
    // Unreadable: write the sample (a duplicate daily sample is harmless; the scorer keeps the first).
  }
  return true;
}

/**
 * One run: gather, compute, log. Never throws.
 * @param {object} [o]
 * @param {boolean} [o.force]   run even while switched off (the staging check; never the scheduler)
 * @param {boolean} [o.persist] write the log (default true); false = compute and keep in memory only
 */
async function runOnce({ force = false, persist = true } = {}) {
  if (state.running || state.pendingLoad) return { skipped: "already running" };
  const cfg = readConfig();
  if (!cfg.enabled && !force) return { skipped: "off" };
  state.running = true;
  const t0 = clock();
  try {
    const now = clock();
    // A load that outlives its timeout keeps running (it cannot be cancelled); until it settles no
    // new run starts, so two loads never overlap.
    const load = Promise.resolve().then(() => hooks.load({ now }));
    state.pendingLoad = load;
    state.pendingSince = new Date(now);
    load.then(
      () => {},
      () => {},
    ).then(() => {
      if (state.pendingLoad === load) {
        state.pendingLoad = null;
        state.pendingSince = null;
      }
    });
    const limitMs = hooks.runTimeoutMs || RUN_TIMEOUT_MS;
    const bundle = await withTimeout(load, limitMs, "inputs took longer than " + Math.round(limitMs / 1000) + " s");
    if (!bundle || bundle.kind !== "listing-brain-bundle") throw new Error("the loader returned no bundle");
    const notes = (bundle.notes || []).slice();
    if (persist) await loadPrior(now, notes);
    const run = await model.buildRunAsync(bundle, { cfg, prior: state.prior });
    notes.push(...(run.notes || []));
    let rows = run.rows || [];
    if (rows.length > MAX_ROWS_PER_RUN) {
      notes.push(rows.length + " cells; only the first " + MAX_ROWS_PER_RUN + " were logged.");
      rows = rows.slice(0, MAX_ROWS_PER_RUN);
    }
    const day = dayOf(now);
    const daily = persist ? await firstOfDay(day) : false;
    const fc = daily ? (run.fc || []).slice(0, cfg.fcCap) : null;
    if (daily && (run.fc || []).length > cfg.fcCap) notes.push("Per-listing forecasts capped at " + cfg.fcCap + " of " + run.fc.length + ".");
    const ms = clock() - t0;
    const doc = {
      at: new Date(now),
      v: model.MODEL_VERSION,
      ms,
      cfg,
      summary: run.summary,
      counts: bundle.counts || {},
      notes: notes.slice(0, 30).map((n) => String(n).slice(0, 300)),
      rowsN: rows.length,
      day,
      fcN: fc ? fc.length : 0,
      fc: fc && fc.length ? fc : null,
    };
    let persisted = false;
    let runId = null;
    if (persist) {
      persisted = true;
      try {
        const created = await hooks.Run().create(doc);
        runId = created && created._id;
        const exp = new Date(now + (fc && fc.length ? ROW_KEEP_DAYS_DAILY : ROW_KEEP_DAYS_OTHER) * DAY);
        if (rows.length) await hooks.Row().insertMany(rows.map((r) => ({ ...compact(r), run: runId, at: doc.at, exp })), { ordered: false });
        if (fc && fc.length) state.fcDay = day;
      } catch (e) {
        persisted = false;
        state.lastError = "log write failed: " + msg(e);
        hooks.logErr("listingBrain: log write failed —", msg(e));
      }
    }
    rememberActions(run.fc, now, cfg.cooldownH);
    const docMem = { ...doc };
    delete docMem.fc;
    state.latest = { ...docMem, _id: runId, rows, offers: run.offers || [], persisted, logged: persist };
    state.run = run;
    state.bundle = bundle;
    state.bundleAt = now;
    state.gen++;
    state.accuracy = null;
    state.runs++;
    state.lastRunAt = doc.at;
    state.lastMs = ms;
    state.lastSummary = run.summary;
    state.lastPersisted = persist ? persisted : null;
    if (persist && persisted) state.lastError = "";
    hooks.log(heartbeat(doc, run, persist ? persisted : true) + (persist ? "" : " | not logged (persist off)"));
    return { ok: true, persisted, summary: run.summary, ms, rows: rows.length, fc: doc.fcN };
  } catch (e) {
    state.lastError = msg(e);
    hooks.logErr("listingBrain: run failed —", state.lastError);
    return { error: state.lastError };
  } finally {
    state.running = false;
  }
}

/* --------------------------------- scheduler --------------------------------- */

function arm(ms) {
  if (!state.started) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(tick, ms);
  if (state.timer.unref) state.timer.unref();
  state.nextRunAt = new Date(Date.now() + ms);
}

async function tick() {
  state.timer = null;
  const cfg = readConfig();
  if (cfg.enabled) {
    state.offLogged = false;
    try {
      const r = await runOnce();
      // A load that never settles would otherwise stop the log silently, one skipped tick at a time.
      if (r && r.skipped === "already running" && state.pendingSince) {
        hooks.log("listingBrain: skipped — the previous run's data load has been pending for " + Math.round((Date.now() - state.pendingSince.getTime()) / 60000) + " min");
      }
    } catch {
      /* runOnce never throws; belt and braces for the loop */
    }
  } else {
    // Switched off: a run is not due, so the wait for the next one starts again from here.
    state.since = new Date();
    if (!state.offLogged) {
      state.offLogged = true;
      hooks.log("listingBrain: off — autoFarm.listingBrain.enabled is not set; nothing is computed or logged");
    }
  }
  arm(cfg.enabled ? cfg.intervalMin * 60000 : OFF_RECHECK_MS);
}

/** Start the loop. Idempotent; returns false when it was already started. */
function start() {
  if (state.started) return false;
  state.started = true;
  state.since = new Date();
  arm(BOOT_DELAY_MS);
  return true;
}

function stop() {
  state.started = false;
  state.since = null;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.nextRunAt = null;
}

function status() {
  return {
    config: readConfig(),
    model: model.MODEL_VERSION,
    started: state.started,
    running: state.running || !!state.pendingLoad,
    loadPendingSince: state.pendingSince,
    runs: state.runs,
    lastRunAt: state.lastRunAt,
    lastMs: state.lastMs,
    lastError: state.lastError,
    // false = the newest run computed but its log write failed (NOT LOGGED); null = not written by choice
    lastPersisted: state.lastPersisted,
    nextRunAt: state.nextRunAt,
    summary: state.lastSummary,
  };
}

/**
 * The health page's view of this loop: synchronous, never throws. `lastRunAt` moves only when a run
 * computed (a failed or timed-out load leaves it, so a stuck brain shows as late); `enabled` is the
 * live switch (unreadable settings read as off); `since` is when the loop last began waiting to run.
 */
function loopStatus() {
  const since = state.since || null;
  try {
    const cfg = readConfig();
    return { lastRunAt: state.lastRunAt || null, intervalMin: cfg.intervalMin, enabled: cfg.enabled, since };
  } catch {
    return { lastRunAt: state.lastRunAt || null, intervalMin: model.DEFAULTS.intervalMin, enabled: false, since };
  }
}

/* ---------------------------------- reading ---------------------------------- */

/** The newest run: from memory (with reasons and offers) or, after a restart, from the log (without). */
async function latest() {
  if (state.latest) return state.latest;
  const run = await hooks.Run().findOne({}, { fc: 0 }).sort({ at: -1 }).lean();
  if (!run) return null;
  const rows = await hooks.Row().find({ run: run._id }, { run: 0, exp: 0 }).limit(MAX_ROWS_PER_RUN).lean();
  return { ...run, rows: rows.map(expand), offers: [], persisted: true, logged: true };
}

/** One cell's rows over the last `limit` runs, newest first (an indexed read of small rows). */
async function cellHistory(key, limit = HISTORY_LIMIT) {
  const parts = String(key || "").split("|");
  if (parts.length < 3) return [];
  const m = parts.pop();
  const f = parts.pop() === "noclaim" ? "noclaim" : "claim";
  const k = parts.join("|");
  const n = Math.max(1, Math.min(HISTORY_LIMIT * 4, Math.floor(Number(limit) || HISTORY_LIMIT)));
  const rows = await hooks.Row().find({ k, f, m }, { run: 0, _id: 0, exp: 0 }).sort({ at: -1 }).limit(n).lean();
  return rows.map(expand);
}

// The first logged run of each UTC day in the last SAMPLE_DAYS that carries forecasts, with its rows'
// scoring fields: runs every few hours are near-copies, so scoring each would count a forecast many times.
async function dailySamples(now) {
  const heads = await hooks
    .Run()
    .find({ at: { $gte: new Date(now - SAMPLE_DAYS * DAY) }, fcN: { $gt: 0 } }, { at: 1, day: 1 })
    .sort({ at: 1 })
    .limit(SAMPLE_DAYS * 4)
    .lean();
  const firstOfDayRuns = new Map();
  for (const h of heads) {
    const d = h.day || dayOf(new Date(h.at).getTime());
    if (!firstOfDayRuns.has(d)) firstOfDayRuns.set(d, h);
  }
  const out = [];
  for (const head of firstOfDayRuns.values()) {
    // One run document at a time (its forecasts are the bulk of it), then its rows' scoring fields.
    const doc = await hooks.Run().findOne({ _id: head._id }, { at: 1, fc: 1 }).lean();
    const rows = await hooks
      .Row()
      .find({ run: head._id }, { k: 1, g: 1, f: 1, m: 1, live: 1, pc: 1, sc: 1, old: 1, br: 1, pol: 1, pf: 1 })
      .limit(MAX_ROWS_PER_RUN)
      .lean();
    out.push({ at: new Date(head.at).getTime(), fc: (doc && doc.fc) || [], rows: rows.map(expand) });
    await new Promise((r) => setImmediate(r));
  }
  return out;
}

async function computeAccuracy(now) {
  const gen = state.gen;
  let bundle = state.bundle;
  if (!bundle || now - state.bundleAt > EVIDENCE_TTL_MS) {
    bundle = await hooks.load({ now });
    state.bundle = bundle;
    state.bundleAt = now;
  }
  const cfg = readConfig();
  const backtest = await model.backtestAsync(bundle, { cfg, weeks: BACKTEST_WEEKS });
  const samples = await dailySamples(now);
  const forward = model.forwardScores({ samples, bundle, cfg, now });
  const review = model.decisionReview({ samples, bundle, now });
  const value = {
    at: new Date(now),
    evidenceAt: new Date(bundle.now),
    model: model.MODEL_VERSION,
    samples: samples.length,
    backtest,
    forward,
    review,
  };
  // A run that landed while this was computing has newer evidence: answer, but do not cache.
  if (state.gen === gen) state.accuracy = { at: now, gen, value };
  return value;
}

/**
 * How good is it? A six-week backtest (works from day one), forward scores of logged forecasts once
 * their horizon is over, and last week's largest disagreements with what happened next. Cached ten
 * minutes (dropped by every run); concurrent callers share one computation.
 */
async function accuracy({ force = false } = {}) {
  const now = clock();
  if (!force && state.accuracy && state.accuracy.gen === state.gen && now - state.accuracy.at < ACCURACY_TTL_MS) return state.accuracy.value;
  if (state.accuracyInflight) return state.accuracyInflight;
  const p = computeAccuracy(now);
  // Cleared only once settled, and only if it is still the current one.
  state.accuracyInflight = p;
  p.then(
    () => {},
    () => {},
  ).then(() => {
    if (state.accuracyInflight === p) state.accuracyInflight = null;
  });
  return p;
}

/* ------------------------- the three answers for later ------------------------- */
// Shaped for the next round's wiring (plan §4.8), wired to nothing now. Synchronous, never throw: with
// no run in memory, or anything the brain cannot answer, the answer is today's (the base price, an
// empty shelf, an unknown value) with confidence "none" and the reason.

function priceFor(q = {}) {
  try {
    return model.priceForRun(state.run, q);
  } catch (e) {
    const base = Number(q && q.basePriceUsd) || 0;
    return { price: base, confidence: "none", basis: "error", regime: null, reasons: ["listing brain error: " + msg(e)] };
  }
}

function shelfFor(q = {}) {
  try {
    return model.shelfForRun(state.run, q);
  } catch (e) {
    return { shelf: {}, reserve: Math.max(0, Math.floor(Number(q && q.stock) || 0)), bulkTake: 0, explore: null, basis: "error", reasons: ["listing brain error: " + msg(e)] };
  }
}

function valueFor(gameKey) {
  try {
    return model.valueForRun(state.run, gameKey);
  } catch (e) {
    return { value: null, shares: {}, nets: {}, basis: "error", reasons: ["listing brain error: " + msg(e)] };
  }
}

module.exports = {
  start,
  stop,
  status,
  loopStatus,
  runOnce,
  latest,
  cellHistory,
  accuracy,
  priceFor,
  shelfFor,
  valueFor,
  readConfig,
  heartbeat,
  dailySamples,
  compact,
  expand,
  ROW_KEEP_DAYS_DAILY,
  ROW_KEEP_DAYS_OTHER,
  _setHooks,
  _reset,
  _tick: tick,
  _state: state,
  BOOT_DELAY_MS,
  OFF_RECHECK_MS,
  RUN_TIMEOUT_MS,
  HISTORY_LIMIT,
  SAMPLE_DAYS,
  BACKTEST_WEEKS,
  MAX_ROWS_PER_RUN,
};
