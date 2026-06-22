const mongoose = require("mongoose");

// A record of one Shop sale: a regular admin bought a bundle (DropSet) with
// their balance and was handed one of our accounts that holds the whole
// bundle. We snapshot the price, the bundle's items and the delivered
// account's identity so the receipt stays accurate even if the set or account
// changes later. Credentials are NOT copied here — they are revealed on demand
// by decrypting the linked BotAccount, so they live in exactly one place.
const purchaseItemSchema = new mongoose.Schema(
  {
    itemKey: { type: String, default: "" },
    name: { type: String, default: "" },
    game: { type: String, default: "" },
    image: { type: String, default: "" },
    // How many copies of this item the delivered account actually holds.
    count: { type: Number, default: 1 },
  },
  { _id: false },
);

const purchaseSchema = new mongoose.Schema(
  {
    setId: { type: String, default: "", index: true },
    setName: { type: String, default: "" },
    price: { type: Number, default: 0 },
    items: { type: [purchaseItemSchema], default: [] },

    // Buyer (a regular admin) identified by their admins.json id.
    buyerAdminId: { type: String, required: true, index: true },
    buyerUsername: { type: String, default: "" },

    // Delivered account.
    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BotAccount",
      required: true,
    },
    accountLogin: { type: String, default: "" },

    // Balance snapshot right after the debit (for the receipt).
    balanceAfter: { type: Number, default: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Purchase", purchaseSchema);
