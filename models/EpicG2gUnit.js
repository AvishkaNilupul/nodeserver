const mongoose = require("mongoose");

// One Epic account loaded into a G2G offer's own stock (G2G "Auto delivery",
// shown to buyers as Instant). G2G hands the stored account form to a buyer
// the moment they pay; utils/epicG2g reads which one went out (G2G shows the
// sold item's Account ID = the Epic login email) and records the sale.
//
// An account is in at most ONE offer's stock at a time (the partial unique
// index), and while it is there utils/epicSales treats it as listed, so no
// other path (an Eldorado listing, a hand delivery, "Mark sold") can sell it.
const epicG2gUnitSchema = new mongoose.Schema(
  {
    offerId: { type: String, required: true, index: true },
    epicAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "EpicAccount", required: true },
    login: { type: String, default: "", index: true }, // lowercase Epic email = G2G's Account ID
    label: { type: String, default: "" },
    // The mail-page login inside the stored row (stage "listed" until sold).
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: "BuyerMailSession", default: null },
    // loading = sent to G2G, not yet seen in its stock; listed = in stock;
    // sold = a buyer got it; removed = taken off our books (see removedReason).
    state: { type: String, enum: ["loading", "listed", "sold", "removed"], default: "loading", index: true },
    uploadedAt: { type: Date, default: null },
    listedAt: { type: Date, default: null },
    soldAt: { type: Date, default: null },
    orderId: { type: String, default: "" },
    removedAt: { type: Date, default: null },
    removedReason: { type: String, default: "" },
    alertedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

epicG2gUnitSchema.index(
  { epicAccountId: 1 },
  {
    name: "one_live_unit_per_account",
    unique: true,
    partialFilterExpression: { state: { $in: ["loading", "listed"] } },
  },
);
epicG2gUnitSchema.index({ sessionId: 1 });

module.exports = mongoose.model("EpicG2gUnit", epicG2gUnitSchema);
