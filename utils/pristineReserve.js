// ---------------------------------------------------------------------------
// The pristine reserve: pool accounts the FARMS must leave for paid rent-farm
// orders.
//
// A pristine account — verified ok, has a password, holds no drops (claimed or
// farmed-but-unclaimed) — is the only kind a rent-farm buyer can be handed, and
// rent-farm consumption is permanent: the buyer keeps the account. The farms
// draw from the same pool, first come, freshest-checked first, and the only
// shared floor (`poolReserve`) is counted over their looser "ready" set, so it
// protected nothing pristine. On 2026-09-21 a paid order failed with "No
// eligible pristine pool accounts" while the farms kept claiming.
//
// Every FARM claimer — the auto-farm (claimPoolAccounts: legacy decide,
// Approve, farm2 fresh + top-up, backfill) and the no-claim feeder
// (noclaimFleet.claimForGame) — ANDs farmClaimFilter() into its claim query and
// reports each claim through noteClaimed(). While more than `pristineReserve`
// pristine accounts are ready nothing changes; at the reserve the farms skip
// pristine rows and take the rest of the pool. Rent-farm, renters, the
// coworker act, the Gameflip buffer, operator routes and the stock hold are
// NOT farms and never call this — the reserve exists for them.
//
// The count is one countDocuments, cached 60 s per process and shared by every
// claimer; noteClaimed() spends it down between refreshes, so a burst of
// claims cannot dig under the reserve before the next count. A count that
// cannot be read FAILS SAFE: the guard answers "at the reserve", so the farms
// skip pristine rows rather than spend one a paid order needs on a guess.
//
// The rule is DB-only. The rent-farm picker also checks the BotAccount index,
// listings, farm tasks and that the password decrypts
// (routes/renterAdminRoutes.gatherPoolEligibility), so this count is an upper
// bound on what a buyer can actually be handed.
// ---------------------------------------------------------------------------

const AvailableAccount = require("../models/AvailableAccount");
const settings = require("./settings");

const CACHE_MS = 60 * 1000;
// A failed count is logged at most this often (every claim would ask again).
const ERROR_LOG_MS = 60 * 1000;

// The extra conditions that make a READY row pristine. A fresh object per call:
// Mongoose casts query objects in place, so a constant handed to it must not be
// shared (or frozen — a cast into a frozen object throws in strict mode).
function pristineConditions() {
  return {
    lastCheckStatus: "ok",
    hasPassword: true,
    // Absent / null count as 0, as in every other pool query.
    dropCount: { $not: { $gt: 0 } },
    unclaimedDropCount: { $not: { $gt: 0 } },
  };
}

const PRISTINE_CONDITIONS = pristineConditions();

// Ready = claimable right now with a working token — the same rule as
// utils/autoFarmer.js readyPoolQuery() (not required from there: the auto-farm
// requires this module).
function readyQuery() {
  return {
    status: "available",
    clientSecret: { $gt: "" },
    lastCheckStatus: { $in: ["", "ok"] },
    manualSold: { $ne: true },
    unclaimedDropCount: { $not: { $gt: 0 } },
  };
}

// Mongo's `$not: { $gt: 0 }` read on a fetched value: only a real positive
// number disqualifies.
function positive(v) {
  return typeof v === "number" && v > 0;
}

// The PRISTINE_CONDITIONS rule on a fetched pool doc (lean or Mongoose). Status,
// token and manualSold are deliberately not re-checked: noteClaimed() is handed
// the doc a claim just flipped to "claimed".
function isPristine(doc) {
  if (!doc || typeof doc !== "object") return false;
  return (
    doc.lastCheckStatus === "ok" &&
    doc.hasPassword === true &&
    !positive(doc.dropCount) &&
    !positive(doc.unclaimedDropCount)
  );
}

function reserveSetting() {
  const n = Math.floor(Number(settings.getAutoFarm().pristineReserve));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const state = {
  pristine: null, // last count, spent down by noteClaimed()
  at: 0, // when that count started (ms); 0 = none
  pending: null, // the in-flight count, shared by concurrent callers
  notedWhilePending: 0, // pristine claims reported while a count was running
  errorLoggedAt: 0,
};

function fresh() {
  return state.at > 0 && Date.now() - state.at < CACHE_MS && typeof state.pristine === "number";
}

async function pristineCount() {
  if (fresh()) return state.pristine;
  if (!state.pending) {
    const startedAt = Date.now();
    state.notedWhilePending = 0;
    state.pending = Promise.resolve()
      .then(() => AvailableAccount.countDocuments({ $and: [readyQuery(), pristineConditions()] }))
      .then((n) => {
        if (!Number.isFinite(n) || n < 0) throw new Error("pristine count returned " + n);
        // A claim reported while the count ran may or may not be in it; taking
        // it off anyway errs toward fewer farm claims, never more.
        state.pristine = Math.max(0, n - state.notedWhilePending);
        state.at = startedAt;
        return state.pristine;
      })
      .finally(() => {
        state.pending = null;
        state.notedWhilePending = 0;
      });
  }
  return state.pending;
}

// { reserve, pristine, headroom, protect }:
//   reserve   the pristineReserve setting (0 = off)
//   pristine  READY rows that are pristine (null when off or unreadable)
//   headroom  pristine − reserve: how many more pristine rows the farms may take
//   protect   min(pristine, reserve): ready rows a farm budget must leave alone
async function farmGuard() {
  const reserve = reserveSetting();
  if (reserve === 0) return { reserve: 0, pristine: null, headroom: Infinity, protect: 0 };
  try {
    const pristine = await pristineCount();
    return { reserve, pristine, headroom: pristine - reserve, protect: Math.min(pristine, reserve) };
  } catch (err) {
    if (Date.now() - state.errorLoggedAt >= ERROR_LOG_MS) {
      state.errorLoggedAt = Date.now();
      console.error(
        "pristine reserve: count failed — farms skip pristine accounts until it reads again:",
        (err && err.message) || err,
      );
    }
    return { reserve, pristine: null, headroom: 0, protect: reserve };
  }
}

// What a farm ANDs into its claim query: { $and: [query, await farmClaimFilter()] }.
// Never throws — anything unexpected answers "skip pristine rows".
async function farmClaimFilter() {
  try {
    const guard = await farmGuard();
    if (guard.headroom > 0) return {};
  } catch (err) {
    // fall through to the safe filter
  }
  return { $nor: [pristineConditions()] };
}

// Call after EVERY successful farm claim with the claimed doc (it must carry
// lastCheckStatus, hasPassword, dropCount and unclaimedDropCount). Synchronous
// and never throws: a bookkeeping slip must not fail a claim that landed.
function noteClaimed(doc) {
  try {
    if (!isPristine(doc)) return;
    if (state.pending) state.notedWhilePending += 1;
    if (fresh()) state.pristine = Math.max(0, state.pristine - 1);
  } catch (err) {
    // ignore
  }
}

function _resetForTests() {
  state.pristine = null;
  state.at = 0;
  state.pending = null;
  state.notedWhilePending = 0;
  state.errorLoggedAt = 0;
}

module.exports = {
  PRISTINE_CONDITIONS,
  isPristine,
  farmGuard,
  farmClaimFilter,
  noteClaimed,
  _resetForTests,
};
