const mongoose = require("mongoose");

// The SOOP farm's activity log (utils/soop/activity.js): what each account and
// bot did and why. Rows delete themselves after 14 days. `msg` and `data` must
// never carry a cookie, an AuthTicket or a reward code.
const TTL_SECONDS = 14 * 24 * 60 * 60;

const soopActivitySchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  level: { type: String, default: "info" }, // info | warn | error
  kind: { type: String, default: "" },
  accountId: { type: String, default: null },
  botId: { type: String, default: null },
  dropsIdx: { type: String, default: null },
  msg: { type: String, default: "" },
  data: { type: mongoose.Schema.Types.Mixed, default: null },
});

// Two indexes on purpose: ascending carries the TTL, descending serves
// "newest first" reads.
soopActivitySchema.index({ at: 1 }, { expireAfterSeconds: TTL_SECONDS });
soopActivitySchema.index({ at: -1 });

module.exports = mongoose.model("SoopActivity", soopActivitySchema);
