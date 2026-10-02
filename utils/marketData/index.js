// Market radar — the runtime entry: `tap()`, called from the research scanner with the rows it
// already fetched. See docs/MARKET-RADAR-PLAN.md.
//
// Contract with the scanner (a live system that must not be disturbed):
//   * tap() returns immediately, never throws, and does no I/O of its own. With the switch off
//     (the default) it costs one settings read.
//   * The work is queued (hard cap, newest wins) and done in the background, ONE job at a time,
//     with a yield to the event loop between jobs.
//   * After BREAKER_FAILS consecutive failures it pauses itself for BREAKER_PAUSE_MS, so a sick
//     database is never hammered and the log is never flooded.
//   * It makes NO request to any marketplace: it only ever sees rows the scan already holds.
const plan = require("./plan");
const store = require("./store");

const MAX_QUEUE = 50;
const OWN_TTL_MS = 30 * 60 * 1000;
const BREAKER_FAILS = 5;
const BREAKER_PAUSE_MS = 15 * 60 * 1000;
const WARN_EVERY_MS = 60 * 1000;

const emptyTotals = () => ({
  salesInserted: 0,
  rivalsInserted: 0,
  rivalsUpdated: 0,
  counterSales: 0,
  units: 0,
  dips: 0,
  jumps: 0,
  goneMarked: 0,
  soldLinked: 0,
  gameflipSkipped: 0,
});

const state = {
  queue: [],
  running: false,
  // Bumped by _reset(): a worker from an older generation stops at its next step, so two
  // workers can never drain one queue (schedule() alone guarantees that in production).
  gen: 0,
  accepted: 0,
  skippedOff: 0,
  skippedPaused: 0,
  droppedFull: 0,
  jobsDone: 0,
  jobsFailed: 0,
  consecutiveFailures: 0,
  breakerOpens: 0,
  pausedUntil: 0,
  lastError: "",
  lastErrorAt: null,
  lastJobAt: null,
  lastWarnAt: 0,
  totals: emptyTotals(),
  own: null,
  ownLoadedAt: 0,
  // Gameflip owner ids already remembered (and their old rows corrected) by this process.
  adoptedOwners: new Set(),
};

// Only an explicit "on" turns it on: a new subsystem ships dark and is switched on by a live
// settings edit (autoFarm.marketData = { enabled: true }).
function isOnValue(v) {
  if (v === true || v === 1) return true;
  return typeof v === "string" && ["true", "1", "on", "yes", "enabled"].includes(v.trim().toLowerCase());
}

function readConfig() {
  let raw = null;
  try {
    raw = require("../settings").getAutoFarm().marketData;
  } catch {
    raw = null;
  }
  const r = raw && typeof raw === "object" ? raw : {};
  return { enabled: isOnValue(r.enabled) };
}

function isEnabled() {
  return readConfig().enabled;
}

function defaultModels() {
  return {
    MarketSale: require("../../models/MarketSale"),
    MarketRival: require("../../models/MarketRival"),
    MarketDataState: require("../../models/MarketDataState"),
    MarketplaceListing: require("../../models/MarketplaceListing"),
  };
}

function noteError(e) {
  state.lastError = String((e && e.message) || e).slice(0, 300);
  state.lastErrorAt = new Date();
  const now = Date.now();
  if (now - state.lastWarnAt >= WARN_EVERY_MS) {
    state.lastWarnAt = now;
    try {
      console.warn("[marketData] " + state.lastError);
    } catch {
      /* logging must never be able to fail anything */
    }
  }
}

const OWN_MARKET = { gameflip: "gameflip", ggsel: "ggsel", digiseller: "plati" };

/**
 * Which listing ids / seller ids are OURS, per public market. Our `externalId` is the same id the
 * public page uses (Gameflip uuid, GGSel id_goods, Plati item id), so our own offers are recognised
 * by id everywhere; GGSel / Plati seller ids are learned from them; Gameflip owner ids come from
 * the scanner and are REMEMBERED, because a throttled moment makes the scanner pass "" — and a pass
 * without our owner id would store our own Gameflip rows as rivals. With no owner id ever known,
 * Gameflip is not recorded at all (gameflipKnown: false). Cached for OWN_TTL_MS.
 */
async function ownContext(gameflipOwner, models) {
  const now = Date.now();
  if (!state.own || now - state.ownLoadedAt > OWN_TTL_MS) {
    const ids = { gameflip: new Set(), ggsel: new Set(), plati: new Set() };
    const rows = await models.MarketplaceListing.find(
      { marketplace: { $in: ["gameflip", "ggsel", "digiseller"] } },
      { marketplace: 1, externalId: 1 },
    )
      .limit(100000)
      .lean();
    for (const r of rows) {
      const id = String(r.externalId || "").trim();
      const m = OWN_MARKET[r.marketplace];
      if (id && m) ids[m].add(id);
    }
    const st = await models.MarketDataState.findById("ownSellers").lean();
    state.own = {
      ids,
      gameflipOwners: new Set((st && st.gameflip) || []),
      sellers: { ggsel: new Set((st && st.ggsel) || []), plati: new Set((st && st.plati) || []) },
    };
    state.ownLoadedAt = now;
  }
  const owner = String(gameflipOwner || "").trim();
  if (owner && !state.adoptedOwners.has(owner)) {
    if (!state.own.gameflipOwners.has(owner)) await store.adoptGameflipOwner(owner, models);
    state.own.gameflipOwners.add(owner);
    state.adoptedOwners.add(owner);
  }
  return {
    gameflipOwner: owner,
    gameflipOwners: state.own.gameflipOwners,
    gameflipKnown: state.own.gameflipOwners.size > 0,
    ids: state.own.ids,
    sellers: state.own.sellers,
  };
}

async function runJob(item, models) {
  const own = await ownContext(item.ownGf, models);
  const job = plan.buildJob(item, own, item.at instanceof Date ? item.at : new Date());
  if (!job) return null;
  const res = await store.applyJob(job, models);
  for (const [market, sellers] of Object.entries(res.learned || {})) {
    for (const s of sellers) state.own.sellers[market].add(s);
  }
  return res;
}

async function drain(deps, gen) {
  try {
    while (state.queue.length && gen === state.gen) {
      const item = state.queue.shift();
      // Switched off (or paused) while queued: drop it rather than write after the owner said stop.
      if (!isEnabled()) {
        state.skippedOff += 1 + state.queue.length;
        state.queue.length = 0;
        break;
      }
      if (Date.now() < state.pausedUntil) {
        state.skippedPaused++;
        continue;
      }
      try {
        const res = await runJob(item, deps.models());
        if (res) for (const k of Object.keys(state.totals)) state.totals[k] += res[k] || 0;
        state.consecutiveFailures = 0;
        state.jobsDone++;
        state.lastJobAt = new Date();
      } catch (e) {
        state.jobsFailed++;
        state.consecutiveFailures++;
        noteError(e);
        if (state.consecutiveFailures >= BREAKER_FAILS) {
          state.pausedUntil = Date.now() + BREAKER_PAUSE_MS;
          state.consecutiveFailures = 0;
          state.breakerOpens++;
        }
      }
      await new Promise((r) => setImmediate(r));
    }
  } finally {
    if (gen === state.gen) {
      state.running = false;
      if (state.queue.length) schedule(deps);
    }
  }
}

function schedule(deps) {
  if (state.running) return;
  state.running = true;
  const gen = state.gen;
  setImmediate(() => {
    drain(deps, gen).catch((e) => {
      if (gen === state.gen) state.running = false;
      noteError(e);
    });
  });
}

const defaultDeps = { models: defaultModels };

/**
 * Hand the rows a scan already fetched to the radar. Returns true when the job was queued.
 * @param input { game, at?, ownGf?, gfSold, gfActive, gfActiveComplete, gg, pl }  (the scanner's own row lists)
 */
function tap(input, deps = defaultDeps) {
  try {
    if (!isEnabled()) {
      state.skippedOff++;
      return false;
    }
    if (Date.now() < state.pausedUntil) {
      state.skippedPaused++;
      return false;
    }
    if (!input || !input.game) return false;
    if (state.queue.length >= MAX_QUEUE) {
      state.queue.shift();
      state.droppedFull++;
    }
    state.queue.push({
      game: input.game,
      at: input.at || new Date(),
      ownGf: input.ownGf || "",
      gfSold: input.gfSold,
      gfActive: input.gfActive,
      gfActiveComplete: !!input.gfActiveComplete,
      gg: input.gg,
      pl: input.pl,
    });
    state.accepted++;
    schedule(deps);
    return true;
  } catch (e) {
    noteError(e);
    return false;
  }
}

function status() {
  const now = Date.now();
  return {
    enabled: isEnabled(),
    queued: state.queue.length,
    running: state.running,
    accepted: state.accepted,
    skippedOff: state.skippedOff,
    skippedPaused: state.skippedPaused,
    droppedFull: state.droppedFull,
    jobsDone: state.jobsDone,
    jobsFailed: state.jobsFailed,
    breakerOpens: state.breakerOpens,
    paused: now < state.pausedUntil,
    pausedForMs: Math.max(0, state.pausedUntil - now),
    lastJobAt: state.lastJobAt,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
    totals: { ...state.totals },
  };
}

// Tests only: a clean slate (and the way to reach inside).
function _reset() {
  state.gen++;
  state.queue.length = 0;
  state.running = false;
  for (const k of ["accepted", "skippedOff", "skippedPaused", "droppedFull", "jobsDone", "jobsFailed", "consecutiveFailures", "breakerOpens", "pausedUntil", "lastWarnAt", "ownLoadedAt"]) state[k] = 0;
  state.lastError = "";
  state.lastErrorAt = null;
  state.lastJobAt = null;
  state.totals = emptyTotals();
  state.own = null;
  state.adoptedOwners = new Set();
}

module.exports = {
  MAX_QUEUE,
  BREAKER_FAILS,
  BREAKER_PAUSE_MS,
  isOnValue,
  readConfig,
  isEnabled,
  tap,
  status,
  ownContext,
  _reset,
  _state: state,
};
