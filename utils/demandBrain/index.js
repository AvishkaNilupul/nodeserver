// The farm brain's runner — docs/DEMAND-BRAIN-PLAN.md.
//
// TEST MODE. Each run works out what the brain would tell each farm, per game, logs it beside
// what each farm's own logic says at the same moment, and later scores both against what actually
// sold. It never changes a farm decision, a setting, a listing or an account: its ONLY writes are
// its own log — one DemandBrainRun document and its DemandBrainRow rows per run (Mongoose also
// creates those two collections' indexes the first time they are used).
//
// Started from routes/priceTrackerRoutes.real(), which server.js calls once at boot; nothing else
// starts it, so tests and the preview never run it. Switch: autoFarm.demandBrain.enabled (default
// off), read on every tick, so turning it on or off needs no restart.
const model = require("./model");
const inputs = require("./inputs");

const DAY = model.DAY;
// First tick a while after boot: the allocator, the scanners and the report caches warm up first.
const BOOT_DELAY_MS = 6 * 60000;
// While switched off, how often the switch is re-read.
const OFF_RECHECK_MS = 10 * 60000;
// A run that cannot gather its inputs in this long is abandoned (it logs nothing).
const RUN_TIMEOUT_MS = 10 * 60000;
const ACCURACY_TTL_MS = 10 * 60000;
// The scorer reuses the last run's evidence while it is this fresh.
const EVIDENCE_TTL_MS = 2 * 3600000;
const HISTORY_LIMIT = 72;
const SAMPLE_DAYS = 21;
const BACKTEST_WEEKS = 6;
// Rows one run can hold (~120 today; the candidate cap is 250 claim games + the no-claim buckets).
const MAX_ROWS_PER_RUN = 1000;

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
  latest: null,
  evidence: null,
  offLogged: false,
  accuracy: null,
  accuracyInflight: null,
});
const state = blankState();

const defaultHooks = () => ({
  load: (o) => inputs.load(o),
  loadEvidence: (o) => inputs.loadEvidence(o),
  Run: () => require("../../models/DemandBrainRun"),
  Row: () => require("../../models/DemandBrainRow"),
  settings: () => require("../settings"),
  log: (...a) => console.log(...a),
  logErr: (...a) => console.error(...a),
});
let hooks = defaultHooks();

/** Tests swap the loaders, the models, the logger. */
function _setHooks(h) {
  hooks = { ...hooks, ...(h || {}) };
}
function _reset() {
  stop();
  hooks = defaultHooks();
  Object.assign(state, blankState());
}

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

// The persisted row: everything but the reasons (kept for the newest run, in memory).
function compact(row) {
  const rest = { ...row };
  delete rest.why;
  return rest;
}

const msg = (e) => (e && e.message ? e.message : String(e));

function heartbeat(doc, rows, persisted) {
  const s = doc.summary;
  const L = s.claim.byDiffLive;
  const parts = [
    "agree " + L.agree,
    "agree-skip " + L["agree-skip"],
    "brain-more " + L["brain-more"],
    "brain-less " + L["brain-less"],
    "brain-farm " + L["brain-farm"],
    "brain-skip " + L["brain-skip"],
    "unknown " + L["brain-unknown"],
  ];
  if (L["old-error"]) parts.push("old-error " + L["old-error"]);
  const nc = rows
    .filter((r) => r.f === "noclaim")
    .map((r) => r.g + " " + r.old.t + "→" + r.br.t + (r.d === "mirror" ? " (mirror)" : ""))
    .join(", ");
  return (
    "demandBrain: run " + state.runs + " (model v" + doc.v + ", " + doc.cfg.estimatorClaim + ") — claim " + s.claim.games + " games, " + s.claim.live + " live: " +
    parts.join(", ") + " | live targets old " + s.claim.oldTargetLive + " → brain " + s.claim.brainTargetLive + " over " + s.claim.comparedLive + " games" +
    (s.claim.unknownLive ? " (+" + s.claim.unknownLive + " without brain evidence, old asks " + s.claim.oldTargetUnknownLive + ")" : "") +
    // New drops (model v2): live games with no sale of ours, what today's logic asks there, and how
    // many each gate held back (the engine's own: untested market, probe budget; and known duds).
    " | cold probes " + (s.claim.coldProbes || 0) + " (old asks " + (s.claim.oldTargetCold || 0) + ")" +
    ", held: " + (s.claim.coldHeldTested || 0) + " tested market, " + (s.claim.coldHeldUnknown || 0) + " market unknown, " +
    (s.claim.coldHeldBudget || 0) + " budget full, " + (s.claim.coldDuds || 0) + " duds" +
    (nc ? " | no-claim " + nc : "") + " | " + (doc.ms / 1000).toFixed(1) + "s" + (persisted ? "" : " | NOT LOGGED (write failed)")
  );
}

/**
 * One run: gather, compute, log. Never throws.
 * @param {object} [o]
 * @param {boolean} [o.force] run even while switched off (the staging check; never the scheduler)
 */
async function runOnce({ force = false } = {}) {
  if (state.running || state.pendingLoad) return { skipped: "already running" };
  const cfg = readConfig();
  if (!cfg.enabled && !force) return { skipped: "off" };
  state.running = true;
  const t0 = Date.now();
  try {
    const now = Date.now();
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
    const pack = await withTimeout(load, limitMs, "inputs took longer than " + Math.round(limitMs / 1000) + " s");
    const run = model.buildRun({
      now,
      cfg,
      sizing: pack.sizing,
      probeSize: pack.probeSize,
      engine: pack.engine || {},
      claim: pack.claim,
      noclaim: pack.noclaim,
      demandRates: pack.demandRates,
      burstGuardLive: !!pack.burstGuardLive,
    });
    const rows = run.rows.slice(0, MAX_ROWS_PER_RUN);
    const ms = Date.now() - t0;
    const doc = {
      at: new Date(now),
      v: model.MODEL_VERSION,
      ms,
      cfg: {
        ...cfg,
        // the size this run's cold probes asked for (unset in settings = half the engine's shelf floor)
        coldProbeSize: model.coldProbeSizeFor(cfg, (pack.engine || {}).floor),
        sizing: pack.sizing,
        probeSize: pack.probeSize,
        probeCooldownDays: pack.probeCooldownDays,
        engine: pack.engine || {},
        v2: pack.demandRates ? "farmDemand" : "brain",
        noclaimBurstGuard: !!pack.burstGuardLive,
      },
      summary: run.summary,
      counts: pack.counts || {},
      notes: (pack.notes || []).slice(0, 20).map((n) => String(n).slice(0, 300)),
      rowsN: rows.length,
    };
    let persisted = true;
    let runId = null;
    try {
      const created = await hooks.Run().create(doc);
      runId = created && created._id;
      if (rows.length) await hooks.Row().insertMany(rows.map((r) => ({ ...compact(r), run: runId, at: doc.at })), { ordered: false });
    } catch (e) {
      persisted = false;
      state.lastError = "log write failed: " + msg(e);
      hooks.logErr("demandBrain: log write failed —", msg(e));
    }
    state.latest = { ...doc, _id: runId, rows, persisted };
    state.evidence = pack.evidence || null;
    state.gen++;
    state.accuracy = null;
    state.runs++;
    state.lastRunAt = doc.at;
    state.lastMs = ms;
    state.lastSummary = run.summary;
    if (persisted) state.lastError = "";
    hooks.log(heartbeat(doc, rows, persisted));
    return { ok: true, persisted, summary: run.summary, ms };
  } catch (e) {
    state.lastError = msg(e);
    hooks.logErr("demandBrain: run failed —", state.lastError);
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
        hooks.log("demandBrain: skipped — the previous run's data load has been pending for " + Math.round((Date.now() - state.pendingSince.getTime()) / 60000) + " min");
      }
    } catch {
      /* runOnce never throws; belt and braces for the loop */
    }
  } else {
    // Switched off: a run is not due, so the wait for the next one starts again from here.
    state.since = new Date();
    if (!state.offLogged) {
      state.offLogged = true;
      hooks.log("demandBrain: off — autoFarm.demandBrain.enabled is not set; nothing is computed or logged");
    }
  }
  arm(cfg.enabled ? cfg.intervalMin * 60000 : OFF_RECHECK_MS);
}

/** Start the hourly loop. Idempotent; returns false when it was already started. */
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
    nextRunAt: state.nextRunAt,
    summary: state.lastSummary,
  };
}

/**
 * The health page's view of this loop (docs/LIVE-FIXES-1003.md §3): synchronous, never throws.
 * `lastRunAt` is the last run that computed (a run whose inputs failed or timed out leaves it
 * alone, so a stuck brain shows as late); `enabled` is the live switch, read like every tick reads it.
 * `since` is when the loop last began waiting to run — start(), or its latest tick that found the
 * switch off — or null when it is not started: a brain switched on hours after boot is due one tick
 * (≤ 10 min) after `since`, not since the process started, while a dead scheduler's `since` stops
 * moving and it ages into "late" like any other loop.
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

/** The newest run: from memory (with reasons) or, after a restart, from the log (without). */
async function latest() {
  if (state.latest) return state.latest;
  const run = await hooks.Run().findOne({}).sort({ at: -1 }).lean();
  if (!run) return null;
  const rows = await hooks.Row().find({ run: run._id }, { run: 0 }).limit(MAX_ROWS_PER_RUN).lean();
  return { ...run, rows, persisted: true };
}

/** One game's rows over the last `limit` runs, newest first (an indexed read of small rows). */
async function gameHistory(key, farm = "claim", limit = HISTORY_LIMIT) {
  const n = Math.max(1, Math.min(HISTORY_LIMIT * 4, Math.floor(Number(limit) || HISTORY_LIMIT)));
  return hooks
    .Row()
    .find({ k: String(key), f: farm === "noclaim" ? "noclaim" : "claim" }, { run: 0, _id: 0 })
    .sort({ at: -1 })
    .limit(n)
    .lean();
}

// The first logged run of each UTC day in the last SAMPLE_DAYS, with its rows: hourly runs are
// near-copies of each other, so scoring every one would count the same forecast 24 times.
async function dailySamples(now) {
  const heads = await hooks
    .Run()
    .find({ at: { $gte: new Date(now - SAMPLE_DAYS * DAY) } }, { at: 1 })
    .sort({ at: 1 })
    .limit(24 * SAMPLE_DAYS * 4)
    .lean();
  const firstOfDay = new Map();
  for (const h of heads) {
    const day = new Date(h.at).toISOString().slice(0, 10);
    if (!firstOfDay.has(day)) firstOfDay.set(day, h);
  }
  const runs = [...firstOfDay.values()];
  if (!runs.length) return [];
  const rows = await hooks
    .Row()
    .find({ run: { $in: runs.map((r) => r._id) } }, { run: 1, k: 1, g: 1, f: 1, live: 1, d: 1, old: 1, br: 1, est: 1 })
    .limit(runs.length * MAX_ROWS_PER_RUN)
    .lean();
  const byRun = new Map(runs.map((r) => [String(r._id), []]));
  for (const row of rows) {
    const list = byRun.get(String(row.run));
    if (list) list.push(row);
  }
  return runs.map((r) => ({ at: r.at, rows: byRun.get(String(r._id)) || [] }));
}

/**
 * Rivals' units sold for one game in [from, to), from the radar's slimmed sale feed. Null when the
 * radar does not watch the game at all — "no data" is not "rivals sold nothing".
 */
function rivalUnits(feed, radarKeys, key, from, to) {
  if (radarKeys && !radarKeys.has(key)) return null;
  let n = 0;
  for (const s of feed || []) {
    if (s.g !== key) continue;
    if (s.t >= from && s.t < to) n += s.u;
  }
  return n;
}

async function computeAccuracy(now) {
  const gen = state.gen;
  let ev = state.evidence;
  if (!ev || now - ev.at > EVIDENCE_TTL_MS) ev = await hooks.loadEvidence({ now });
  const ncKeys = ev.noclaimKeys || [];
  const games = [];
  for (const [key, entries] of ev.claim || new Map()) {
    if (model.bucketOfKey(key, ncKeys)) continue;
    games.push({ key, farm: "claim", entries, spans: (ev.spans && ev.spans.get(key)) || [] });
  }
  if (ev.noclaim) {
    for (const [key, entries] of ev.noclaim) {
      const spans = [];
      if (ev.spans) for (const [k, list] of ev.spans) if (model.bucketOfKey(k, ncKeys) === key) spans.push(...list);
      games.push({ key, farm: "noclaim", entries, spans });
    }
  }
  const backtest = model.backtest({ games, now, weeks: BACKTEST_WEEKS, demandRates: ev.demandRates || null });
  const samples = await dailySamples(now);
  const entriesFor = (farm, key) => (farm === "noclaim" ? (ev.noclaim ? ev.noclaim.get(key) || [] : null) : (ev.claim && ev.claim.get(key)) || []);
  const spansFor = (farm, key) => (farm === "claim" && ev.spans ? ev.spans.get(key) || null : null);
  const forward = model.forwardScores({ samples, entriesFor, spansFor, now });
  const review = model.decisionReview({ samples, entriesFor, rivalUnitsFor: (key, from, to) => rivalUnits(ev.feed, ev.radarKeys, key, from, to), now });
  const value = {
    at: new Date(now),
    evidenceAt: new Date(ev.at),
    model: model.MODEL_VERSION,
    estimators: model.ESTIMATORS,
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
 * How good is each estimator? Backtest over the last six weeks (works from day one), forward
 * scores of logged runs once their week is over, and last week's disagreements with outcomes.
 * Cached ten minutes (dropped by every run); concurrent callers share one computation.
 */
async function accuracy({ force = false } = {}) {
  const now = Date.now();
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

module.exports = {
  start,
  stop,
  status,
  loopStatus,
  runOnce,
  latest,
  gameHistory,
  accuracy,
  readConfig,
  rivalUnits,
  dailySamples,
  heartbeat,
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
