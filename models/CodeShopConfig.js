const mongoose = require("mongoose");

// The code shop's one settings document (docs/code-shop/01-DATA.md), always
// key "main". `data` holds only what the owner changed; the effective config
// is deepMerge(DEFAULTS, data) in utils/codeShop/config.js.
const codeShopConfigSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "main" },
    data: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    updatedBy: { type: String, default: "" },
    updatedAt: { type: Date, default: null },
  },
  // Keep an empty `data` as {} instead of dropping the field.
  { minimize: false },
);

module.exports = mongoose.model("CodeShopConfig", codeShopConfigSchema);
