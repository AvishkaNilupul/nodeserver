const mongoose = require("mongoose");

const twitchCampaignSchema = new mongoose.Schema(
  {
    campaignId: { type: String, required: true, unique: true, index: true },
    name: { type: String, default: "" },
    game: { type: String, default: "" },
    owner: { type: String, default: "" },
    status: { type: String, default: "", index: true },
    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null, index: true },
    detailsURL: { type: String, default: "" },
    accountLinkURL: { type: String, default: "" },
    image: { type: String, default: "" },
    boxArt: { type: String, default: "" },
    accountConnected: { type: Boolean, default: false },
    active: { type: Boolean, default: true, index: true },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    notifiedAt: { type: Date, default: null },
    startedNotifiedAt: { type: Date, default: null },
    // Static drop facts, filled lazily by the allocation forecast the first time
    // it reads this campaign's live details (utils/twitchInventory.fetchCampaignDetails)
    // and cached here so repeat forecast loads stay DB-only. requiredMinutesWatched
    // is the full watch time to earn EVERY time-based drop (the max threshold);
    // dropItemCount is how many time-based drops the campaign grants. Null = not
    // yet fetched (forecast falls back to DB-only for that row).
    requiredMinutesWatched: { type: Number, default: null },
    dropItemCount: { type: Number, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("TwitchCampaign", twitchCampaignSchema);
