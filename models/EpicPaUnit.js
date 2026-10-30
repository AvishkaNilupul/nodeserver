const mongoose = require("mongoose");
const schema = new mongoose.Schema(
  {
    epicAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EpicAccount",
      required: true,
    },
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BuyerMailSession",
      default: null,
    },
    offerId: { type: String, default: "", index: true },
    title: { type: String, default: "" },
    priceUsd: { type: Number, required: true },
    sessionDays: { type: Number, default: 14 },
    state: {
      type: String,
      enum: ["loading", "listed", "paused", "error", "sold"],
      default: "loading",
      index: true,
    },
    note: { type: String, default: "" },
    createdBy: { type: String, default: "" },
    publishAttemptedAt: { type: Date, default: null },
    orderId: { type: String, default: "" },
    soldAt: { type: Date, default: null },
    lastCheckedAt: { type: Date, default: null },
    alertedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
// Credentials are never recycled after a sale, including a refund.
schema.index({ epicAccountId: 1 }, { unique: true });
module.exports = mongoose.model("EpicPaUnit", schema);
