const mongoose = require("mongoose");

// Privacy-light public catalog analytics. The browser identifier is hashed
// before storage and the unique dedupe key limits one visitor to one count per
// event/target/day. Raw IPs, user agents, and account data are never stored.
const catalogEventSchema = new mongoose.Schema(
  {
    event: {
      type: String,
      enum: ["catalog_view", "category_view", "listing_view", "inquiry_click"],
      required: true,
      index: true,
    },
    category: { type: String, default: "", index: true },
    listingId: { type: String, default: "", index: true },
    visitorHash: { type: String, required: true },
    dedupeKey: { type: String, required: true, unique: true },
    at: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

catalogEventSchema.index({ at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 120 });

module.exports = mongoose.model("CatalogEvent", catalogEventSchema);
