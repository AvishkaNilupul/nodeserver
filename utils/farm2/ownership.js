// Ownership boundary between the legacy engine (utils/autoFarmer.js) and the
// new lane engine (utils/farm2/*).
//
// EXACTLY ONE engine may act on a game. This module is the single source of
// truth for which, and it is consulted from the legacy engine's hot per-campaign
// loop, so it must be cheap and it must never throw.
//
// THE FAIL-SAFE DIRECTION IS THE WHOLE POINT OF THIS FILE.
//
// There are two ways to be wrong:
//   (a) report "owned" when farm2 is not really running it  -> BOTH engines skip
//       the game. Campaigns quietly go unfarmed, live tasks are never completed
//       or listed, and accounts sit stranded. Silent, and it costs real money.
//   (b) report "not owned" when farm2 could have run it     -> the legacy engine
//       handles the game exactly as it does today. Nothing is lost; the new
//       engine simply does not get the trial.
//
// (b) is strictly safer, so every uncertainty — DB down, model missing, cache
// cold, engine stopped, kill switch thrown — resolves to NOT OWNED. A game
// falling back to the proven engine is a non-event; a game owned by nobody is
// an outage.
const settings = require("../settings");

// Cached ownership set. The legacy tick asks about every candidate campaign, so
// a DB read per question would add hundreds of round trips to a tick that is
// already slow. A 30s TTL is far below the legacy engine's 10-minute tick, so a
// mode flip in the UI is picked up long before the next decision is made.
const TTL_MS = 30 * 1000;

// How long a lane-table read may take. A find over a dead connection can hang
// without ever erroring, and the legacy tick awaits this read before it decides
// (ensureFresh): an unbounded wait froze the whole tick, and every later tick
// read "already running" (2026-10-03). maxTimeMS caps the query on the server;
// the race caps the wait on this side, where a dead socket is. A read that
// times out counts as unreadable — cold.
const LANE_READ_MAX_MS = 10 * 1000;
const REFRESH_TIMEOUT_MS = 15 * 1000;
let refreshTimeoutMs = REFRESH_TIMEOUT_MS;

const cache = {
  // Games a LIVE, not-paused lane owns.
  keys: new Set(),
  // EVERY lane, by gameKey -> { mode, state }: which games have a lane at all
  // and why it does not own (off / shadow / paused). legacyMayDecide reads it.
  lanes: new Map(),
  at: 0,
  loading: null,
};

// The timer is deliberately NOT unref'd: something is awaiting it, and an
// unref'd timer let a process with nothing else pending exit mid-await. It is
// always cleared when the read settles, so it never outlives the read.
function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("lane table read timed out after " + ms + " ms")),
      ms,
    );
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

// Set by utils/farm2/index.js start()/stop(). While false, farm2 is not running
// its loop at all, so it cannot own anything — this is what makes "engine not
// started" collapse to the safe answer instead of stranding every lane's game.
let engineRunning = false;

function setEngineRunning(v) {
  engineRunning = !!v;
  // A start or stop changes every answer; drop the cache rather than serving a
  // stale ownership set for up to TTL_MS.
  cache.at = 0;
}

// Master kill switch, read from settings so it can be thrown from the UI (or by
// hand in settings.json) without a deploy. Defaults to disabled: farm2 owns
// nothing until it is explicitly turned on.
function killSwitchOn() {
  try {
    return settings.getAutoFarm().farm2Enabled === true;
  } catch {
    return false;
  }
}

// Is the lane engine the MAIN engine? When true the supervisor creates a live
// lane for every game with a live campaign, so the legacy engine decides
// nothing and runs only its fleet-wide maintenance sweeps. Read fresh each
// time, like the kill switch, so it can be flipped from the tab.
function isMain() {
  try {
    const af = settings.getAutoFarm();
    return af.farm2Enabled === true && af.farm2Main === true;
  } catch {
    return false;
  }
}

function normKey(game) {
  try {
    return settings.normGameName(game);
  } catch {
    return String(game || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }
}

// Refresh the owned-key set from FarmLane. Only mode "live" confers ownership:
// a "shadow" lane runs its full pipeline with no side effects while the LEGACY
// engine keeps really farming the game, so shadow must leave the legacy engine
// in charge. That is what makes the trial safe to run against live games.
async function refresh() {
  if (cache.loading) return cache.loading;
  cache.loading = (async () => {
    // Yield before anything can throw. Without it, a synchronous throw (the
    // model failing to load) ran the `finally` below BEFORE this promise was
    // assigned to cache.loading, so a settled promise stayed there for good
    // and every later refresh() returned it without reading — ownership
    // stuck cold until a restart (found 2026-10-03; with the legacy engine
    // deferring to a cold cache in main mode, that would defer for ever).
    await null;
    try {
      const FarmLane = require("../../models/FarmLane");
      // EVERY lane is read (one row per game, a few dozen): legacyMayDecide
      // needs to know a game has no lane at all, not only that none owns it.
      let query = FarmLane.find({}).select("gameKey mode state");
      if (typeof query.maxTimeMS === "function") query = query.maxTimeMS(LANE_READ_MAX_MS);
      const rows = await withTimeout(query.lean(), refreshTimeoutMs);
      const lanes = new Map();
      const owned = new Set();
      for (const r of rows || []) {
        if (!r || !r.gameKey) continue;
        lanes.set(r.gameKey, { mode: r.mode, state: r.state });
        // Only mode "live" confers ownership, and a PAUSED live lane owns
        // nothing. Pausing means the lane failed PAUSE_AFTER_FAILURES cycles
        // in a row and stopped retrying; if it kept ownership, its game would
        // be farmed by nobody — the exact "owned by nobody" outage this module
        // exists to prevent. Releasing it lets the legacy engine cover the
        // game until an operator re-arms the lane.
        if (r.mode === "live" && r.state !== "paused") owned.add(r.gameKey);
      }
      cache.keys = owned;
      cache.lanes = lanes;
      cache.at = Date.now();
    } catch {
      // Fail safe: an unreadable lane table means "farm2 owns nothing", so the
      // legacy engine continues to cover every game. cache.at goes back to 0,
      // so the next call retries instead of caching the empty set for a full
      // TTL — and so isCold() can tell "the table could not be read" from "the
      // table was read and no lane is live" (2026-10-03: before, a failed read
      // after an earlier good one kept the old timestamp, so it looked warm).
      // A read that timed out lands here too.
      cache.keys = new Set();
      cache.lanes = new Map();
      cache.at = 0;
    } finally {
      cache.loading = null;
    }
  })();
  return cache.loading;
}

// Non-blocking ownership test for the legacy engine's hot loop.
//
// Synchronous by design: making autoFarmer await a DB call inside its campaign
// loop would add a round trip per candidate. A cold or stale cache answers
// "not owned" (the safe direction) and kicks off a background refresh. The
// legacy tick awaits ensureFresh() ONCE before its loop, so the loop itself
// reads a current cache (see ensureFresh and isCold below).
function isOwned(game) {
  if (!engineRunning) return false;
  if (!killSwitchOn()) return false;
  const key = normKey(game);
  if (!key) return false;
  if (Date.now() - cache.at > TTL_MS) {
    refresh().catch(() => {});
    // Stale-but-present data is still trustworthy for the brief refresh window:
    // a lane cannot go live without the operator flipping it, and the legacy
    // engine re-asks every tick. An EMPTY cache, though, is indistinguishable
    // from "never loaded", so it must answer the safe way.
    if (!cache.at) return false;
  }
  return cache.keys.has(key);
}

// Async form for callers that can afford to wait (routes, the supervisor).
// Guarantees a fresh read rather than the hot-loop's best-effort answer.
async function isOwnedAsync(game) {
  if (!engineRunning) return false;
  if (!killSwitchOn()) return false;
  const key = normKey(game);
  if (!key) return false;
  if (Date.now() - cache.at > TTL_MS) await refresh();
  return cache.keys.has(key);
}

// Current owned set, for the UI and for logging.
function ownedKeys() {
  return Array.from(cache.keys);
}

function invalidate() {
  cache.at = 0;
}

// Make the hot loop's answers current before it asks them. Never throws.
//
// isOwned() answers "not owned" from a cold cache, and the cache is cold at
// boot and after every invalidate() (a lane auto-created or paused, every lane
// route). The legacy candidate loop has no await between its isOwned() calls,
// so in that tick every game read "not owned" and the legacy engine decided
// all of them — 20 legacy decisions since main mode went on (2026-09-06), every
// one right after a restart or a lane auto-create (10-02 00:01: The Quinfall,
// +19 accounts). The legacy tick awaits this once before its loop instead.
//
// Bounded: the tick waits about REFRESH_TIMEOUT_MS here at most, whatever the
// read does, and a read that does not answer in time leaves the cache cold (in
// main mode the tick then defers its decisions and still runs its sweeps). The
// read's own timeout, inside refresh(), fires first: it also frees the
// in-flight slot, so the next refresh starts a NEW read instead of re-awaiting
// the dead one. The race here, a second later, is only the backstop.
const ENSURE_FRESH_MARGIN_MS = 1000;
async function ensureFresh() {
  try {
    if (!engineRunning) return;
    if (!killSwitchOn()) return;
    if (Date.now() - cache.at > TTL_MS) {
      await withTimeout(refresh(), refreshTimeoutMs + ENSURE_FRESH_MARGIN_MS);
    }
  } catch {
    // Only the race above can land here (refresh() never rejects): the read
    // is still out, so ownership is unknown.
    cache.at = 0;
  }
}

// May the LEGACY engine decide this game's campaigns? Synchronous, never
// throws; the legacy candidate loop asks it after ensureFresh().
//
// Outside main mode (or with the lane engine not running) this is the old
// rule: legacy decides every game no live lane owns. In MAIN mode the lane
// engine is THE engine, so legacy decides only what the lanes will never take:
//   - a game whose normalised key is empty (the supervisor cannot key a lane
//     for it, e.g. an all-non-Latin name),
//   - a game whose lane is off or shadow (the operator kept it on legacy),
//   - a game whose lane is paused (released until an operator re-arms it).
// A game with NO lane yet is deferred: the supervisor creates its lane at the
// start of its next cycle (3 min). Deciding it here raced that lane — the lane
// read legacy's still-executing "planned" row as stranded and ran a second
// executeTask on it (2026-10-03, The Quinfall shape).
// An unreadable lane table (cold) answers false in main mode as well; the
// legacy tick reports that case as "decisions deferred: lane ownership unknown".
function legacyMayDecide(game) {
  try {
    if (!engineRunning) return true;
    // One settings read for both switches: this runs once per live campaign.
    const af = settings.getAutoFarm();
    if (af.farm2Enabled !== true) return true;
    if (af.farm2Main !== true) return !isOwned(game);
    const key = normKey(game);
    if (!key) return true;
    if (Date.now() - cache.at > TTL_MS) refresh().catch(() => {});
    if (!cache.at) return false;
    if (cache.keys.has(key)) return false;
    return cache.lanes.has(key);
  } catch {
    // A bug here must not leave a game to nobody: the old answer.
    return true;
  }
}

// Is ownership UNKNOWN right now? True while the engine runs with its switch
// on but the lane table has not been read: before the first refresh lands,
// after invalidate(), and after a failed read. In that state isOwned() says
// "not owned" for every game — the safe answer for a fallback engine, and the
// wrong one when the lane engine is the MAIN engine (autoFarmer reads this to
// defer its decisions instead of taking every game).
function isCold() {
  return engineRunning && killSwitchOn() && !cache.at;
}

// Tests only: shorten the read timeout so a hung read can be exercised.
function _setRefreshTimeoutForTests(ms) {
  refreshTimeoutMs = Number(ms) > 0 ? Number(ms) : REFRESH_TIMEOUT_MS;
}

module.exports = {
  isOwned,
  isOwnedAsync,
  ownedKeys,
  invalidate,
  refresh,
  ensureFresh,
  isCold,
  legacyMayDecide,
  _setRefreshTimeoutForTests,
  setEngineRunning,
  killSwitchOn,
  isMain,
  normKey,
};
