const mongoose = require("mongoose");

// One drop sitting in one SOOP account's inventory, as last read by
// utils/soop/inventory.js. Shape = the normalised InventoryItem
// (utils/soop/normalize.js) minus `code`: a reward code is only ever stored
// encrypted in `codeEnc` (utils/secretBox), and `raw` arrives with the code
// fields already removed. Never log or return `codeEnc`.
const soopInventoryItemSchema = new mongoose.Schema(
  {
    loginId: { type: String, required: true, index: true },
    key: { type: String, required: true }, // stable per account + item
    division: { type: String, default: "available", index: true }, // available | acquired | expired
    name: { type: String, default: "" },
    nameRaw: { type: String, default: "" },
    kind: { type: String, default: "other" }, // code | link | ingame | other
    gameNo: { type: String, default: null, index: true },
    gameName: { type: String, default: "" },
    image: { type: String, default: null },
    expiresAt: { type: Date, default: null, index: true },
    sentAt: { type: Date, default: null },
    receivedAt: { type: Date, default: null },
    needsLink: { type: Boolean, default: false },
    linkPath: { type: String, default: null },
    used: { type: Boolean, default: false },
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
    hasCode: { type: Boolean, default: false },
    codeEnc: { type: String, default: "" },
    syncedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

soopInventoryItemSchema.index({ loginId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model("SoopInventoryItem", soopInventoryItemSchema);
