const mongoose = require("mongoose");

// One document per CHZZK drops campaign we have seen or been handed by number
// (docs/CHZZK-FARM.md §7). Fields mirror normalize.campaignFromApi() so the
// worker, routes and UI share one shape.
//
// CHZZK can delist a running campaign from the public category list before it
// ends, so we keep the last good copy and refresh it on every scan. A row
// stays usable while its endAt is in the future, even if discovery stops
// listing it: that is what the "Add campaign #" input is for.
const rewardSchema = new mongoose.Schema(
  {
    rewardNo: { type: Number, default: 0 },
    title: { type: String, default: "" },
    rewardType: { type: String, default: "" },
    minutes: { type: Number, default: 0 },
    remaining: { type: Number, default: null },
    imageUrl: { type: String, default: null },
  },
  { _id: false, minimize: false },
);

const chzzkCampaignSchema = new mongoose.Schema(
  {
    campaignNo: { type: Number, required: true, unique: true, index: true },
    title: { type: String, default: "" },
    categoryType: { type: String, default: "" },
    categoryId: { type: String, default: "" },
    categoryValue: { type: String, default: "" },
    imageUrl: { type: String, default: null },
    state: { type: String, default: "" },
    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },
    needsLink: { type: Boolean, default: false },
    guide: { type: String, default: "" },
    rewards: { type: [rewardSchema], default: () => [] },
    // Operator switch: a disabled campaign is left out of farming.
    enabled: { type: Boolean, default: true },
    // "scan" (discovery saw it) | "manual" (added by number).
    source: { type: String, default: "scan" },
    lastSeenAt: { type: Date, default: null },
    refreshedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);

module.exports = mongoose.model("ChzzkCampaign", chzzkCampaignSchema);
