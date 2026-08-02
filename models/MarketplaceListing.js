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
      enum: [
        "gameflip",
        "digiseller",
        "g2g",
        "ggsel",
        "funpay",
        "epicnpc",
        "zeusx",
      ],
      required: true,
      index: true,
    },
    externalId: { type: String, required: true },
    // Who created this listing. "auto" = published by the auto-farmer
    // (utils/autoLister.js) or by the relist chain succeeding an auto listing;
    // "manual" = published by the owner from the Listings page.
    //
    // This is what scopes automatic price changes: the post-event scarcity
    // markup only ever touches origin:"auto" rows, so the owner's own hand-made
    // listings keep the price they were given. The default is deliberately
    // "manual" — an unmarked row is treated as the owner's and left alone,
    // which is the safe way to be wrong.
    origin: {
      type: String,
      enum: ["auto", "manual"],
      default: "manual",
      index: true,
    },
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
    // Digiseller delivery units, one row per unit we fed, so a single BAD unit
    // can be pulled later. Digiseller returns each unit's content_id on add
    // and offers no endpoint to list a product's content afterwards (verified
    // live 2026-07-29), so an id not captured here is unreachable forever —
    // which is exactly why the 36 units already on live products cannot be
    // removed individually and had to be handled by delisting.
    units: {
      type: [
        {
          _id: false,
          contentId: { type: String, default: "" },
          accountId: { type: String, default: "" },
          login: { type: String, default: "" },
          addedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
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
