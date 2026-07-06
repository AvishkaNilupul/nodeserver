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
  },
  { timestamps: true },
);

module.exports = mongoose.model("DropSet", dropSetSchema);
