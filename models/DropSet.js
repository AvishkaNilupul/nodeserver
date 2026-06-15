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
  },
  { _id: false },
);

const dropSetSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    note: { type: String, default: "" },
    items: { type: [dropSetItemSchema], default: [] },
  },
  { timestamps: true },
);

module.exports = mongoose.model("DropSet", dropSetSchema);
