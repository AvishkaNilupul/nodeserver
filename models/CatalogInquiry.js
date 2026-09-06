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
    quantity: { type: Number, required: true, min: 1, max: 1000 },
    contact: { type: String, required: true, trim: true },
    note: { type: String, default: "" },
    preorder: { type: Boolean, default: false },
    expectedReadyAt: { type: Date, default: null },
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
