const mongoose = require("mongoose");

// A record of every coworker investigation: the question, which tools it ran,
// and the answer it gave. So the coworker can review its own past work (via the
// read_log tool) and an engineer can audit what it's been doing. Kept ~180 days.
const coworkerLogSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  question: { type: String, default: "" },
  mode: { type: String, default: "analyst" },
  actor: { type: String, default: "" }, // admin:<id> who asked
  tools: { type: [String], default: [] }, // tool names used, in order
  toolCount: { type: Number, default: 0 },
  answer: { type: String, default: "" },
  proposalCount: { type: Number, default: 0 },
  durationMs: { type: Number, default: 0 },
  error: { type: String, default: "" },
});

coworkerLogSchema.index({ at: -1 });
coworkerLogSchema.index({ at: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = mongoose.model("CoworkerLog", coworkerLogSchema);
