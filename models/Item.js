const mongoose = require("mongoose");

const itemSchema = new mongoose.Schema(
  {
    category: { type: String, required: true, index: true },
    username: { type: String, required: true },
    password: { type: String, required: true },
    notes: { type: String, default: "" },
    value: { type: Number, default: 0 },
    used: { type: Boolean, default: false },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Item", itemSchema);