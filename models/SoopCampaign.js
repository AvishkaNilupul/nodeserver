const mongoose = require("mongoose");

// SOOP delists drop events from its public list mid-broadcast, and a campaign
// is only knowable while some account can still read the list. Keep the last
// good record for every campaign we have seen so a bot can keep farming one
// that has since disappeared from the list (the "pin a campaign by ID" flow).
//
// The row keeps SOOP's raw `broadIdList` / `itemList` and raw Korean text, so
// utils/soop/campaignStore.js can re-normalise it with the current glossary.
// A v1 row has no `titleRaw` key and its dates are nine hours late (parsed as
// server time instead of Korea time); the store corrects both on read and the
// next scan that still lists the campaign rewrites the row.
const soopCampaignSchema = new mongoose.Schema(
  {
    dropsIdx: { type: String, required: true, unique: true, index: true },
    title: { type: String, default: "" }, // English where the glossary knows it
    titleRaw: { type: String, default: "" }, // as SOOP sent it
    image: { type: String, default: null },
    giveCon: { type: String, default: "" },
    gameNo: { type: String, default: null },
    cateName: { type: String, default: "" }, // raw
    cateNo: { type: String, default: "" },
    ingameGiveYn: { type: String, default: "" },
    typeNm: { type: String, default: null },
    // What SOOP reported on the last scan; false once it stops listing the row.
    live: { type: Boolean, default: false },
    lastLiveAt: { type: Date, default: null },
    filter: { type: String, default: "" },
    // Real instants (utils/soop/normalize.js parseKst).
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    broadIdList: { type: Array, default: [] },
    itemList: { type: Array, default: [] },
    seenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

module.exports = mongoose.model("SoopCampaign", soopCampaignSchema);
