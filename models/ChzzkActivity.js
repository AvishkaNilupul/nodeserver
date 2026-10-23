const mongoose = require("mongoose");

// The CHZZK farm's activity log (utils/chzzk/activity.js): what each account
// did and why. Rows delete themselves after 14 days. `msg` and `data` must
// never carry a cookie or a reward code.
const TTL_SECONDS = 14 * 24 * 60 * 60;

const chzzkActivitySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    level: { type: String, default: "info" }, // info | warn | error
    kind: { type: String, default: "" },
    accountId: { type: String, default: null },
    campaignNo: { type: Number, default: null },
    msg: { type: String, default: "" },
    data: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { minimize: false },
);

// Two indexes on purpose: ascending carries the TTL, descending serves
// "newest first" reads.
chzzkActivitySchema.index({ at: 1 }, { expireAfterSeconds: TTL_SECONDS });
chzzkActivitySchema.index({ at: -1 });

module.exports = mongoose.model("ChzzkActivity", chzzkActivitySchema);
