const mongoose = require("mongoose");

// One document per unit of work performed by the new farm engine
// (utils/farm2/*). This is the single biggest structural difference from the
// legacy utils/autoFarmer.js.
//
// The legacy engine keeps ALL of its run state in module memory (`state` and
// `progressLog` in autoFarmer.js): a restart mid-tick loses the trail entirely,
// a half-applied phase leaves DB rows in limbo with nothing recording why, and
// the only visibility is an in-process array of strings that no operator ever
// reads. That is the concrete mechanism behind "it gets bugged and I can't tell
// what happened".
//
// Here every step is a durable row with its own attempt counter, its own retry
// clock and its own error. Consequences:
//   * a crash resumes cleanly — queued/running jobs are re-driven on boot
//   * a failure retries on ITS own schedule without blocking anything else
//   * the new tab is a thin renderer over these rows; no separate log plumbing
//   * "why didn't this list?" is answerable weeks later
const farmJobSchema = new mongoose.Schema(
  {
    // Owning lane (the game label) + its normalised key, denormalised so the
    // tab can page a lane's jobs without a join.
    lane: { type: String, required: true, index: true },
    laneKey: { type: String, required: true, index: true },

    // The pipeline stage this job represents. These map 1:1 to the boxes in the
    // architecture sketch: the lane runs decide -> execute -> monitor, and the
    // drop-checker/lister stage runs verify -> publish.
    //
    //   decide  — research + demand + allocation for one campaign; writes an
    //             AutoFarmTask decision (or, in shadow mode, only a preview)
    //   execute — claim pool accounts and create/reuse bots on the host
    //   monitor — progress, backfill and completion for an active task
    //   verify  — the drop checker: confirm the assigned accounts ACTUALLY hold
    //             the campaign's drops before anything is offered for sale
    //   publish — publishing, split into independently-retrying rows (see the
    //             `market` field below for where that boundary actually falls)
    kind: {
      type: String,
      enum: ["decide", "execute", "monitor", "verify", "publish"],
      required: true,
      index: true,
    },

    // For kind: "publish" — which publishing stage this row owns. Empty for
    // every other kind.
    //
    // WHY THIS IS NOT ONE ROW PER MARKETPLACE. The original intent was a job
    // per marketplace, so a Plati failure could not affect GGSel. The real
    // autoLister API does not support that split: publishPlatiShare and
    // publishGgselShare take a fully-prepared payload (resolved DropSet, grid
    // image, price, computed split, and reserved accounts) that is assembled
    // inside retryMissingSecondaries — including reserveAccountsForPublish,
    // the stock-reservation path with the already-fixed double-claim bugs.
    // Driving them directly would mean reimplementing that assembly, i.e.
    // exactly the second source of truth this engine exists to avoid.
    //
    // So the boundary is drawn where the API actually allows one:
    //   primary     — the Gameflip listing (autoLister.listActivatedTask),
    //                 which also makes the first attempt at the secondaries
    //   secondaries — Plati / GGSel / ZeusX retry as a group
    //                 (autoLister.retryMissingSecondaries), on their OWN retry
    //                 clock, so a secondary-market outage can never block or
    //                 delay the primary listing and vice versa.
    // That is a genuine failure boundary, just a coarser one than per-market.
    // A true per-marketplace split needs autoLister reworked first.
    market: {
      type: String,
      enum: ["", "primary", "secondaries"],
      default: "",
    },

    // What this job is about. campaignId + taskId are the join back into the
    // EXISTING data model — farm2 deliberately reuses AutoFarmTask rather than
    // inventing a parallel task store, so the Auto-farm page, the archive, the
    // fulfiller and the allocation forecast all keep working untouched.
    campaignId: { type: String, default: "", index: true },
    taskId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

    status: {
      type: String,
      enum: ["queued", "running", "done", "failed", "skipped", "cancelled"],
      default: "queued",
      index: true,
    },

    // True when this job ran in a shadow-mode lane: it computed a real decision
    // but performed NO side effect. Shadow rows are what the UI diffs against
    // the legacy engine's actual behaviour, so they must be distinguishable
    // from real work forever, not just while the lane is in shadow.
    shadow: { type: Boolean, default: false, index: true },

    // Retry bookkeeping. nextAttemptAt is the retry clock; a failed job simply
    // becomes due again later rather than being lost or hot-looping.
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    nextAttemptAt: { type: Date, default: null, index: true },

    // Inputs and outputs, kept verbatim so a decision can be re-read later
    // exactly as it was made. Mixed because each kind carries a different
    // shape and pinning a schema here would fight every future step type.
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    result: { type: mongoose.Schema.Types.Mixed, default: {} },

    error: { type: String, default: "" },
    errorAt: { type: Date, default: null },

    // Per-job step log. Bounded in the writer (utils/farm2/jobs.js) so a job
    // that retries for a week cannot grow an unbounded document.
    log: {
      type: [
        {
          _id: false,
          at: { type: Date, default: Date.now },
          level: { type: String, default: "info" },
          msg: { type: String, default: "" },
        },
      ],
      default: [],
    },

    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// The dispatcher's hot query: what is due to run right now?
farmJobSchema.index({ status: 1, nextAttemptAt: 1 });
// The tab's per-lane feed.
farmJobSchema.index({ lane: 1, createdAt: -1 });
// Idempotency guard: one live job per (lane, kind, campaign, market). Partial
// so completed/failed history is unconstrained and can accumulate freely —
// only the in-flight set is deduplicated.
farmJobSchema.index(
  { laneKey: 1, kind: 1, campaignId: 1, market: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ["queued", "running"] } },
  },
);

module.exports = mongoose.model("FarmJob", farmJobSchema);
