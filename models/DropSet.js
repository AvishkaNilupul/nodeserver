const mongoose = require("mongoose");

// A user-defined bundle of drops sold together as one order. Each item stores
// the grouping itemKey plus a snapshot of name/game/image so the set still
// renders even if the underlying drops change. Fulfillment (which accounts can
// deliver the whole bundle) is computed live against DropLog.
const dropSetItemSchema = new mongoose.Schema(
  {
    itemKey: { type: String, required: true },
    name: { type: String, default: "" },
    game: { type: String, default: "" },
    image: { type: String, default: "" },
    // Exact copies of this item the bundle promises. Stock and delivery only
    // count accounts holding at least this many, so listings never lie.
    qty: { type: Number, default: 1, min: 1 },
  },
  { _id: false },
);

const dropSetSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    note: { type: String, default: "" },
    items: { type: [dropSetItemSchema], default: [] },
    // Shop listing: superadmin sets a flat price and flips `listed` to make
    // the bundle buyable by regular admins from the Shop tab.
    price: { type: Number, default: 0, min: 0 },
    listed: { type: Boolean, default: false, index: true },
    // Custom listings (game-based promo covers pushed to marketplaces) are kept
    // out of the regular Shop listings view via this flag. They still use the
    // same DropSet shape so marketplace publishing/auto-delivery is unchanged.
    custom: { type: Boolean, default: false, index: true },
    // Promo-cover settings remembered for a custom listing so its cover can be
    // regenerated identically (e.g. on relist) without re-entering them.
    coverStyle: { type: String, default: "grid" },
    coverGame: { type: String, default: "" },
    coverServiceText: { type: String, default: "" },
    coverBullets: { type: [String], default: [] },
    coverImages: { type: [String], default: [] },
  },
  { timestamps: true },
);

module.exports = mongoose.model("DropSet", dropSetSchema);
