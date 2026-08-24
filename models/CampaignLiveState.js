// Fast-changing liveness signal for stream-gated campaigns, owned by
// utils/streamScout.js — kept SEPARATE from TwitchCampaign on purpose. The
// campaign catalog (TwitchCampaign, refreshed every 2h by campaignWatcher) is a
// slow catalog; this is a ~3-minute "is a channel that credits this drop live
// RIGHT NOW" signal. Splitting them means the Scout's frequent writes never
// contend with the catalog, and botWaker / the auto-farm watcher can read one
// tiny keyed collection with no compute on the request path.
//
// One row per active, stream-gated campaign the Scout is tracking. Non-gated
// campaigns get no row (they are never gated — fail toward farming).
// See docs/STREAM-SCOUT-PLAN.md §3a and §13a.
const mongoose = require("mongoose");

const campaignLiveStateSchema = new mongoose.Schema(
  {
    campaignId: { type: String, required: true, unique: true, index: true },
    game: { type: String, default: "" },
    name: { type: String, default: "" },

    // Is this campaign actually acted on? True only when streamGate is on, the
    // game is opted in (streamGatedGames), and the campaign has a usable list of
    // channels to check. A campaign we decided NOT to gate (no ACL, no override)
    // records gated:false + liveNow:true so it behaves exactly like today.
    gated: { type: Boolean, default: false, index: true },
    // Where the checked channels came from: "acl" (campaign's own allow-list),
    // "override" (streamGatedGames channels), "both", or "none" (not gated).
    source: { type: String, default: "none" },

    // The channels the Scout watches for liveness (the campaign's ACL channels
    // ∪ any streamGatedGames override), and which of them are live this pass.
    channels: { type: [String], default: [] },
    liveChannels: { type: [String], default: [] },

    // The signal botWaker consumes. `liveNow` = at least one watched channel is
    // live. Hysteresis anchors: `lastLiveAt` is the last time liveNow was true
    // (the wake key for idle_no_stream parks — see §4); `darkSince` is when it
    // last went true→false (null while live), the park-side hysteresis anchor.
    liveNow: { type: Boolean, default: false, index: true },
    lastLiveAt: { type: Date, default: null },
    darkSince: { type: Date, default: null },

    // When the Scout last successfully evaluated this campaign. A stale row (the
    // Scout down/erroring) must be treated as watchable by botWaker — fail
    // toward farming.
    checkedAt: { type: Date, default: null, index: true },
    // Last error while evaluating this campaign, for the watcher UI.
    lastError: { type: String, default: "" },
  },
  { timestamps: true },
);

module.exports = mongoose.model("CampaignLiveState", campaignLiveStateSchema);
