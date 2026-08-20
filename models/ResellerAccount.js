const mongoose = require("mongoose");

const connectSummarySchema = new mongoose.Schema(
  {
    game: { type: String, default: "" },
    requiredAccountLink: { type: String, default: "" },
    total: { type: Number, default: 0, min: 0 },
    connected: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const resellerAccountSchema = new mongoose.Schema(
  {
    reseller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Reseller",
      required: true,
      index: true,
    },
    botAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BotAccount",
      required: true,
      index: true,
    },
    clientSecret: { type: String, required: true, unique: true, index: true },
    login: { type: String, default: "", index: true },
    game: { type: String, default: "", index: true },
    receivedAt: { type: Date, default: Date.now },
    resellerStatus: {
      type: String,
      enum: ["received", "listed", "sold", "returned"],
      default: "received",
      index: true,
    },
    resellerSoldAt: { type: Date, default: null },
    resellerNote: { type: String, default: "" },
    needsConnect: { type: Boolean, default: false, index: true },
    connectSummary: { type: [connectSummarySchema], default: [] },
    lastVerifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

resellerAccountSchema.index({ reseller: 1, botAccount: 1 }, { unique: true });

module.exports = mongoose.model("ResellerAccount", resellerAccountSchema);
