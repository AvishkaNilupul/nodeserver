// Public entry point for the lane engine.
//
// server.js requires exactly this file and calls start(). Everything else in
// utils/farm2/* is internal.
//
// SAFETY POSTURE
//
// The engine is inert until BOTH are true:
//   1. settings.autoFarm.farm2Enabled === true  (master switch, default false)
//   2. a FarmLane row exists with mode "shadow" or "live"
//
// and it only takes a game away from the legacy engine when a lane is "live".
// A fresh deploy therefore changes nothing: no lanes exist, the switch is off,
// and utils/autoFarmer.js keeps running every game exactly as it does today.

const supervisor = require("./supervisor");
const ownership = require("./ownership");
const settings = require("./../settings");

// The trial lanes, chosen from live prod data rather than picked by hand:
//
//   Albion Online  — 17 farm/reuse/probe decisions in 60 days, the highest churn
//                    of any game, so it exercises decide -> verify most often
//                    and produces comparison evidence fastest.
//   World of Tanks — a REUSE-ONLY game (settings.isReuseOnlyGame): it must never
//                    claim a fresh pool account. Deliberately included so the
//                    trial covers a genuinely different branch instead of three
//                    variations of the same happy path.
//   Black Desert   — 12 decisions in 60 days on the normal fresh-spend path, the
//                    control case against World of Tanks.
const TRIAL_GAMES = ["Albion Online", "World of Tanks", "Black Desert"];

// Create the trial lanes if they do not exist. Idempotent, and deliberately
// NON-DESTRUCTIVE: an existing lane's mode is never changed, so re-running this
// can't silently demote a lane an operator has already promoted to live.
async function seedTrialLanes({ games = TRIAL_GAMES, mode = "shadow" } = {}) {
  const FarmLane = require("../../models/FarmLane");
  const out = [];
  for (const game of games) {
    const gameKey = settings.normGameName(game);
    const existing = await FarmLane.findOne({ gameKey }).lean();
    if (existing) {
      out.push({ game, created: false, mode: existing.mode });
      continue;
    }
    await FarmLane.create({
      game,
      gameKey,
      mode,
      state: "idle",
      nextRunAt: new Date(),
      note: "trial lane",
    });
    out.push({ game, created: true, mode });
  }
  return out;
}

function start() {
  supervisor.start();
}

function stop() {
  supervisor.stop();
}

function status() {
  return supervisor.status();
}

module.exports = {
  start,
  stop,
  status,
  runCycle: supervisor.runCycle,
  seedTrialLanes,
  ownership,
  TRIAL_GAMES,
};
