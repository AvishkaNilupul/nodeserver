const mongoose = require("mongoose");

// A "bot" is one campaign farmed by N accounts. The watch sockets themselves
// live in memory, but the definition is persisted so that a restart of the
// redeemer process resumes the bot instead of silently dropping it.
const soopFarmTaskSchema = new mongoose.Schema(
  {
    dropsIdx: { type: String, required: true, index: true },
    label: { type: String, default: "" },
    target: { type: String, default: "all" }, // all | first
    targetMinutes: { type: Number, default: null },
    accountIds: { type: [String], default: [] },
    active: { type: Boolean, default: true, index: true },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("SoopFarmTask", soopFarmTaskSchema);
