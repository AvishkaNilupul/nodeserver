const mongoose = require("mongoose");

// One unit bought (or being bought) on FunPay — utils/funpayResale.js.
//
// A row exists BEFORE any money is spent, and its state says how far the purchase
// got, so a crash or restart can never buy the same unit twice:
//   new → waiting_chat → buying → bought → received → delivered
// with failed / needs_review as stops. A row left in "buying" (we cannot tell
// whether FunPay took the money) is never bought again automatically.
const STATES = ["new", "waiting_chat", "buying", "bought", "received", "delivered", "failed", "needs_review"];

const funpayPurchaseSchema = new mongoose.Schema(
  {
    source: { type: mongoose.Schema.Types.ObjectId, ref: "FunpaySource", index: true },
    offerId: { type: String, default: "" },
    // "order" = bought for an Eldorado order; "manual" = the owner's "Buy 1 now".
    kind: { type: String, enum: ["order", "manual"], default: "order" },
    eldoradoOrderId: { type: String, default: "" },
    unit: { type: Number, default: 0 },
    listing: { type: mongoose.Schema.Types.ObjectId, ref: "MarketplaceListing", default: null },
    state: { type: String, enum: STATES, default: "new" },
    funpayOrderId: { type: String, default: "" },
    chargedUsd: { type: Number, default: 0 },
    // The ceiling this attempt was allowed to pay; an attempt whose outcome is
    // unknown counts against the 24 h cap at this amount.
    maxPriceUsd: { type: Number, default: 0 },
    // Plain Twitch login (the same thing listing units[].login holds).
    login: { type: String, default: "" },
    // secretBox(JSON {username, password, token?}) — never logged or returned in lists.
    credentials: { type: String, default: "" },
    reason: { type: String, default: "" },
    // The last buy attempt's sanitized steps (paths, status codes, field names).
    trace: { type: [mongoose.Schema.Types.Mixed], default: [] },
    // Alert keys already sent for this row (once each, survives restarts).
    alerted: { type: [String], default: [] },
    buyingAt: { type: Date, default: null },
    boughtAt: { type: Date, default: null },
    receivedAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

// One purchase per ordered unit: the hard stop against buying an order twice.
funpayPurchaseSchema.index(
  { eldoradoOrderId: 1, unit: 1 },
  { unique: true, partialFilterExpression: { eldoradoOrderId: { $gt: "" } } },
);
funpayPurchaseSchema.index({ state: 1 });
funpayPurchaseSchema.index({ boughtAt: -1 });

module.exports = mongoose.model("FunpayPurchase", funpayPurchaseSchema);
module.exports.STATES = STATES;
