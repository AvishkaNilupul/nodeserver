const mongoose = require("mongoose");

// One document per game owned by the new farm engine (utils/farm2/*).
//
// A "lane" is the unit of ISOLATION that the old engine never had: the legacy
// utils/autoFarmer.js runs every game through a single ~900-line runOnce()
// under one global mutex, so a slow SSH probe or one game's exception stalls
// the entire fleet for a 10-minute tick. Here each game gets its own row, its
// own clock (nextRunAt), its own failure counter and its own error — one lane
// failing cannot touch another.
//
// OWNERSHIP CONTRACT (the rule that keeps both engines from fighting):
//   A game is owned by farm2 when a FarmLane row exists for it with
//   mode !== "off". utils/autoFarmer.js consults farm2Ownership.isOwned() and
//   SKIPS any owned game, so exactly one engine ever acts on a game.
//   `mode: "shadow"` is the exception and is deliberately NOT ownership —
//   see the mode docs below.
const farmLaneSchema = new mongoose.Schema(
  {
    // Display label, exactly as it appears on TwitchCampaign/AutoFarmTask
    // ("Albion Online"). Matching is done on the normalised key below so
    // spacing/case drift can never split a lane in two.
    game: { type: String, required: true, unique: true },
    // settings.normGameName(game) — the join key. Stored rather than computed
    // per query so the ownership lookup is a plain indexed equality match.
    gameKey: { type: String, required: true, index: true },

    // How much authority this lane has. The whole migration is a walk from
    // "off" to "live", one game at a time, and it is reversible at every step.
    //
    //   off    — inert. Row kept for history; the legacy engine owns the game.
    //   shadow — the lane runs its FULL decision pipeline and records what it
    //            WOULD do, but performs no side effects: no pool claims, no
    //            host writes, no marketplace calls. The legacy engine still
    //            really farms this game. This is the comparison mode: two
    //            engines, one truth, and a diff between them in the UI.
    //            Shadow does NOT take ownership — that is the point.
    //   live   — the lane acts for real and the legacy engine skips the game.
    mode: {
      type: String,
      enum: ["off", "shadow", "live"],
      default: "shadow",
      index: true,
    },

    // Runtime state of the lane's own loop. `running` is advisory only — the
    // authoritative guard is the in-process lane mutex; this exists so the UI
    // and a post-crash restart can tell what was in flight.
    state: {
      type: String,
      enum: ["idle", "running", "error", "paused"],
      default: "idle",
      index: true,
    },

    // Per-lane clock. The supervisor dispatches a lane only when now >=
    // nextRunAt, so a lane that is failing backs off on its OWN schedule
    // without slowing the healthy lanes down.
    nextRunAt: { type: Date, default: null, index: true },
    lastRunAt: { type: Date, default: null },
    lastOkAt: { type: Date, default: null },
    lastDurationMs: { type: Number, default: 0 },

    // Error isolation. consecutiveFailures drives exponential backoff and, past
    // a threshold, trips the lane to "paused" so a permanently broken game
    // stops burning ticks instead of retrying forever (the legacy engine's
    // behaviour, which is why the same failure could repeat for days unseen).
    lastError: { type: String, default: "" },
    lastErrorAt: { type: Date, default: null },
    consecutiveFailures: { type: Number, default: 0 },

    // Last budget the arbiter granted this lane (utils/farm2/budget.js).
    // Recorded for the UI so "why did this lane only take 4 accounts?" is
    // answerable after the fact rather than being invisible tick-local state.
    lastBudget: {
      accounts: { type: Number, default: 0 },
      seats: { type: Number, default: 0 },
      grantedAt: { type: Date, default: null },
      reason: { type: String, default: "" },
    },

    // Cumulative counters, for the tab's per-lane health strip.
    counters: {
      runs: { type: Number, default: 0 },
      decisions: { type: Number, default: 0 },
      executions: { type: Number, default: 0 },
      listings: { type: Number, default: 0 },
      failures: { type: Number, default: 0 },
    },

    // Free-text operator note ("trial lane, do not flip to live yet").
    note: { type: String, default: "" },
  },
  { timestamps: true },
);

// The supervisor's dispatch query: due lanes that are allowed to act.
farmLaneSchema.index({ mode: 1, state: 1, nextRunAt: 1 });

module.exports = mongoose.model("FarmLane", farmLaneSchema);
