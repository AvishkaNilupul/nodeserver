const mongoose = require("mongoose");

// SOOP delists drop events from its public list mid-broadcast, and a campaign
// is only knowable while some account can still read the list. Keep the last
// good record for every campaign we have seen so a bot can keep farming one
// that has since disappeared from the list (the "pin a campaign by ID" flow).
const soopCampaignSchema = new mongoose.Schema(
  {
    dropsIdx: { type: String, required: true, unique: true, index: true },
    title: { type: String, default: "" },
    giveCon: { type: String, default: "" },
    cateName: { type: String, default: "" },
    cateNo: { type: String, default: "" },
    live: { type: Boolean, default: false },
    filter: { type: String, default: "" },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    broadIdList: { type: Array, default: [] },
    itemList: { type: Array, default: [] },
    seenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

module.exports = mongoose.model("SoopCampaign", soopCampaignSchema);
