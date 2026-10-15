const mongoose = require("mongoose");

// The code shop's activity log (utils/codeShop/events.js), also used for alert
// stamps: a row with a stampKey marks "this alert was already sent", and the
// unique index makes that check-and-set atomic. Rows delete themselves after
// 30 days. `msg` and `data` must never carry a code — counts, labels and
// masked shapes only.
const TTL_SECONDS = 30 * 24 * 60 * 60;
const MSG_MAX = 500;

const codeShopEventSchema = new mongoose.Schema({
  // `expires` builds the single TTL index on `at`, which also serves the
  // newest-first reads.
  at: { type: Date, default: Date.now, expires: TTL_SECONDS },
  level: { type: String, enum: ["info", "warn", "error"], default: "info" },
  kind: { type: String, default: "" },
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "CodeProduct",
    default: null,
  },
  // Cut rather than refused: a long message must not cost the event.
  msg: {
    type: String,
    default: "",
    set: (v) =>
      typeof v === "string" && v.length > MSG_MAX ? v.slice(0, MSG_MAX) : v,
  },
  data: { type: mongoose.Schema.Types.Mixed, default: null },
  stampKey: { type: String, default: "" },
});

// Only a real stamp is unique; plain log rows carry "".
codeShopEventSchema.index(
  { stampKey: 1 },
  {
    unique: true,
    partialFilterExpression: { stampKey: { $type: "string", $gt: "" } },
  },
);

module.exports = mongoose.model("CodeShopEvent", codeShopEventSchema);
