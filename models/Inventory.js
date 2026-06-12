const mongoose = require("mongoose");

const inventorySchema = new mongoose.Schema(
  {
    category: { type: String, required: true, index: true },
    username: { type: String, required: true },
    password: { type: String, required: true },
    used: { type: Boolean, default: false },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Inventory", inventorySchema);