const mongoose = require("mongoose");

// An operator's own name for a SOOP game number. It wins over the built-in
// table in utils/soop/i18n.js; an empty `name` means "no override".
const soopGameSchema = new mongoose.Schema(
  {
    gameNo: { type: String, required: true, unique: true },
    name: { type: String, default: "" },
    // Left out of the games list (campaigns of the game are still remembered).
    hidden: { type: Boolean, default: false },
  },
  { timestamps: true },
);

module.exports = mongoose.model("SoopGame", soopGameSchema);
