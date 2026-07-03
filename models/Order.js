const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema(
  {
    sellerId: { type: String, required: true, index: true },
    sellerName: { type: String, default: "" },
    orderId: { type: String, required: true, index: true },
    // Legacy single-account fields, kept in sync with accounts[0] so older
    // rows and older readers keep working.
    username: { type: String, default: "" },
    password: { type: String, default: "" },
    // One order can bundle several accounts (a buyer purchasing 2+ at once).
    accounts: {
      type: [
        {
          _id: false,
          username: { type: String, default: "" },
          password: { type: String, default: "" },
        },
      ],
      default: [],
    },
    used: { type: Boolean, default: false },
    gamerTag: { type: String, default: null, index: true },
    // Stable per-order chat identity ("<gamerTag> #<orderId>"). Unique per
    // order so a buyer who reuses a gamertag across orders gets a separate
    // chat instead of overlapping the previous one.
    chatId: { type: String, default: null, index: true },
    usedAt: { type: Date, default: null },
    // Per-buyer secret used to authenticate the chat socket so a gamertag
    // alone is not enough to read/send another buyer's messages.
    chatToken: { type: String, default: null },
  },
  { timestamps: true }
);

orderSchema.index({ sellerId: 1, orderId: 1 });

module.exports = mongoose.model("Order", orderSchema);
