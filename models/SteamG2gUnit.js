// One Steam account loaded into a G2G offer's own stock (G2G "Auto delivery",
// shown to buyers as Instant). G2G hands the stored account form to a buyer
// the moment they pay; utils/steamG2g reads which one went out (G2G shows the
// sold item's Account ID = the Steam account name) and records the sale.
// Contract: docs/STEAM-SALES.md (v2).
//
// An account is in at most ONE offer's stock at a time (the partial unique
// index), and while it is there SteamAccount.stage is "listed", so no other
// path (an Eldorado listing, a hand edit) can sell it.
const mongoose = require("mongoose");

const steamG2gUnitSchema = new mongoose.Schema(
  {
    offerId: { type: String, required: true, index: true },
    region: { type: String, default: "" },
    steamAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "SteamAccount", required: true },
    login: { type: String, default: "", index: true }, // lowercase Steam account name = G2G's Account ID
    label: { type: String, default: "" },
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
  },
  { timestamps: true },
);

steamG2gUnitSchema.index(
  { steamAccountId: 1 },
  {
    name: "one_live_unit_per_steam_account",
    unique: true,
    partialFilterExpression: { state: { $in: ["loading", "listed"] } },
  },
);

module.exports = mongoose.models.SteamG2gUnit || mongoose.model("SteamG2gUnit", steamG2gUnitSchema);
