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
      enum: ["gameflip", "digiseller", "g2g"],
      required: true,
      index: true,
    },
    externalId: { type: String, required: true },
    url: { type: String, default: "" },
    title: { type: String, default: "" },
    price: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    status: {
      type: String,
      enum: ["active", "delisted", "error"],
      default: "active",
      index: true,
    },
    note: { type: String, default: "" },
    lastError: { type: String, default: "" },
  },
  { timestamps: true },
);

module.exports = mongoose.model(
  "MarketplaceListing",
  marketplaceListingSchema,
);
