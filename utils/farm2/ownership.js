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

const cache = {
  keys: new Set(),
  at: 0,
  loading: null,
};

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
    try {
      const FarmLane = require("../../models/FarmLane");
      const rows = await FarmLane.find({ mode: "live" })
        .select("gameKey")
        .lean();
      cache.keys = new Set(rows.map((r) => r.gameKey).filter(Boolean));
      cache.at = Date.now();
    } catch {
      // Fail safe: an unreadable lane table means "farm2 owns nothing", so the
      // legacy engine continues to cover every game. Deliberately does NOT
      // update cache.at, so the next call retries instead of caching the empty
      // set for a full TTL.
      cache.keys = new Set();
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
// "not owned" (the safe direction) and kicks off a background refresh, so the
// very first legacy tick after a boot behaves exactly as it does today.
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

module.exports = {
  isOwned,
  isOwnedAsync,
  ownedKeys,
  invalidate,
  refresh,
  setEngineRunning,
  killSwitchOn,
  normKey,
};
