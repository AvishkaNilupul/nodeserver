const mongoose = require("mongoose");

// One row per external marketplace listing created from the site, so we can
// show where a drop set is published and delist/update it later.
const marketplaceListingSchema = new mongoose.Schema(
  {
    set: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DropSet",
      required: true,
      index: true,
    },
    marketplace: {
      type: String,
      enum: ["gameflip", "digiseller", "g2g", "ggsel", "funpay", "epicnpc"],
      required: true,
      index: true,
    },
    externalId: { type: String, required: true },
    // FunPay has no per-offer API: delisting re-saves the offer's editor form,
    // which needs the category node id. Stored here at publish time.
    externalNode: { type: String, default: "" },
    url: { type: String, default: "" },
    title: { type: String, default: "" },
    // Kept so a sold auto-delivery listing can be relisted identically.
    description: { type: String, default: "" },
    price: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    status: {
      type: String,
      enum: ["active", "sold", "delisted", "error"],
      default: "active",
      index: true,
    },
    note: { type: String, default: "" },
    lastError: { type: String, default: "" },
    // Gameflip auto-delivery: the farmed account attached to this listing as
    // an auto-delivered digital code. The account is reserved (soldAt) while
    // the listing is live and released again if the listing is delisted.
    autoDeliver: { type: Boolean, default: false },
    accountId: { type: String, default: "" },
    accountLogin: { type: String, default: "" },
    // How many more units to relist (one at a time) after this one sells.
    qtyRemaining: { type: Number, default: 0 },
    // Quantity-based auto-delivery (Plati / GGSel): how many units the
    // guardian keeps available on the platform, topping the listing up with
    // freshly claimed accounts as units sell. 0 disables auto-feeding.
    qtyTarget: { type: Number, default: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.model("MarketplaceListing", marketplaceListingSchema);
