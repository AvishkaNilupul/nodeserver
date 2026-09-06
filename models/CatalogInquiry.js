const mongoose = require("mongoose");

const catalogInquirySchema = new mongoose.Schema(
  {
    listing: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DropSet",
      required: true,
      index: true,
    },
    listingTitle: { type: String, default: "" },
    category: { type: String, default: "", index: true },
    // Listing kind at request time (bundle = claimed drops, preorder = still
    // farming, unclaimed = buyer links their own game account and claims).
    kind: {
      type: String,
      enum: ["bundle", "preorder", "unclaimed"],
      default: "bundle",
      index: true,
    },
    // Public per-unit price shown when the request was made.
    unitPrice: { type: Number, default: 0 },
    quantity: { type: Number, required: true, min: 1, max: 1000 },
    contact: { type: String, required: true, trim: true },
    note: { type: String, default: "" },
    preorder: { type: Boolean, default: false },
    expectedReadyAt: { type: Date, default: null },
    // Set once the Telegram alert for this request was delivered (null = not sent).
    notifiedAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ["new", "contacted", "closed", "spam"],
      default: "new",
      index: true,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("CatalogInquiry", catalogInquirySchema);
