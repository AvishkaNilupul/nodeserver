// Persisted "expected drops" manifest for a drop campaign, refreshed by
// utils/campaignWatcher.js (read-only, ~6h TTL) from the same
// `currentUser.dropCampaign` details the auto-lister uses.
//
// WHY THIS EXISTS
// The "finished" park verdict must not just ask "did the account earn ANY
// drop" — it must confirm the account holds THIS campaign's drops before the
// bot is stopped (the owner's "check everyone farmed correctly before
// sleeping"; docs/STREAM-SCOUT-PLAN.md §9 Phase 3 / §13a #4). Twitch only
// reports a campaign as in-progress once watching has begun, and the DropLog
// archive is keyed by benefitId — so the server needs the campaign's own drop
// list to know what "fully farmed" means. Keeping it in its own collection
// (like CampaignLiveState) means the park decision reads one tiny keyed set
// with no network and no compute on the request path.
//
// Matched to DropLog rows by benefitId (benefit.id || drop.id, the same
// identifier buildDrops stores), with itemKey (normalised name|game) as the
// fallback when Twitch supplies no benefit id.
const mongoose = require("mongoose");

const campaignDropsSchema = new mongoose.Schema(
  {
    campaignId: { type: String, required: true, unique: true, index: true },
    game: { type: String, default: "" },
    name: { type: String, default: "" },
    // The campaign's expected rewards, one entry per timeBasedDrop.
    drops: {
      type: [
        {
          benefitId: { type: String, default: "" },
          dropId: { type: String, default: "" },
          name: { type: String, default: "" },
          itemKey: { type: String, default: "" },
        },
      ],
      default: [],
    },
    // When the manifest was last fetched from Twitch.
    fetchedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("CampaignDrops", campaignDropsSchema);
