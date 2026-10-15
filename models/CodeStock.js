const mongoose = require("mongoose");

// The code shop ledger (docs/code-shop/01-DATA.md): one row per reward code the
// SOOP farm has stored. It is the ONLY place that knows which code sits in
// which unit (a SuppliedAccount row of the product's AccountOffer), and the
// atomic in_stock -> in_unit update on this row is what stops one code being
// sold twice.
//
// Identity is the inventory row's { loginId, key }: SoopInventoryItem ids can
// change when SOOP re-lists a row, that pair does not.
//
// Never store the code itself here. `codeHash` (sha256 hex) catches the same
// code stored twice; `codeShape` is a masked shape for logs and the panel.
const STATES = [
  "in_stock",
  "in_unit",
  "sold",
  "expiring",
  "expired",
  "held",
  "dead",
];
const AFTER_STATUSES = ["", "ok", "dead", "replaced", "replacement"];

const historySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    from: { type: String, default: "" },
    to: { type: String, default: "" },
    why: { type: String, default: "" },
  },
  { _id: false },
);

const codeStockSchema = new mongoose.Schema(
  {
    loginId: { type: String, required: true, index: true },
    itemKey: { type: String, required: true },
    // Refreshed by ingest; only a pointer, never the identity.
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SoopInventoryItem",
      default: null,
    },
    gameNo: { type: String, default: "", index: true },
    gameName: { type: String, default: "" },
    groupKey: { type: String, default: "", index: true },
    campaignIdx: { type: String, default: "" },
    campaignTitle: { type: String, default: "" },
    campaignEndAt: { type: Date, default: null },
    slotKey: { type: String, default: "", index: true },
    nameRaw: { type: String, default: "" },
    name: { type: String, default: "" },
    image: { type: String, default: "" },
    codeHash: { type: String, default: "" },
    codeShape: { type: String, default: "" },
    earnedAt: { type: Date, default: null },
    useBy: { type: Date, default: null },

    // in_stock -> in_unit -> sold is the happy path. Nothing ever comes back
    // from sold / held / dead: a code that might have reached a buyer is never
    // put back on sale.
    state: { type: String, enum: STATES, default: "in_stock", index: true },
    unit: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SuppliedAccount",
      default: null,
      index: true,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CodeProduct",
      default: null,
      index: true,
    },
    offer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountOffer",
      default: null,
    },
    unitStatus: { type: String, default: "" },
    // Once a unit went into a platform vault (GGSel) the platform can hand it
    // out without calling us, so a vault release can never prove it unsold.
    wasFed: { type: Boolean, default: false },
    pulledAt: { type: Date, default: null },
    soldAt: { type: Date, default: null },
    market: { type: String, default: "" },
    orderId: { type: String, default: "" },
    saleUsd: { type: Number, default: 0 },
    problem: { type: String, default: "" },

    after: {
      status: { type: String, enum: AFTER_STATUSES, default: "" },
      note: { type: String, default: "" },
      at: { type: Date, default: null },
      by: { type: String, default: "" },
      ref: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "CodeStock",
        default: null,
      },
    },

    // Last 20 transitions; writers use $push with $slice: -20.
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true },
);

codeStockSchema.index({ loginId: 1, itemKey: 1 }, { unique: true });
// Only a real hash is unique: rows ingested before their code was read carry
// "" and must not collide with each other.
codeStockSchema.index(
  { codeHash: 1 },
  {
    unique: true,
    partialFilterExpression: { codeHash: { $type: "string", $gt: "" } },
  },
);
codeStockSchema.index({ state: 1, slotKey: 1 });
codeStockSchema.index({ product: 1, state: 1 });

module.exports = mongoose.model("CodeStock", codeStockSchema);
