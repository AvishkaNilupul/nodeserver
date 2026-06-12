const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema(
  {
    sellerId: { type: String, required: true, index: true },
    sellerName: { type: String, default: "" },
    orderId: { type: String, required: true, index: true },
    username: { type: String, default: "" },
    password: { type: String, default: "" },
    used: { type: Boolean, default: false },
    gamerTag: { type: String, default: null, index: true },
    usedAt: { type: Date, default: null },
    // Per-buyer secret used to authenticate the chat socket so a gamertag
    // alone is not enough to read/send another buyer's messages.
    chatToken: { type: String, default: null },
  },
  { timestamps: true }
);

orderSchema.index({ sellerId: 1, orderId: 1 });

module.exports = mongoose.model("Order", orderSchema);
