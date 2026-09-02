const mongoose = require("mongoose");

// The AI coworker's own long-term memory — durable notes it accumulates across
// sessions so it gets smarter about THIS operation over time (e.g. "plati tends
// to underprice CoD", "twitchbotx24 stalls on the Pi every few hours"). Seeded
// with a domain primer on first deploy; the coworker adds to it via save_memory.
// Deliberately small (bytes-bound Atlas) and NOT auto-expired — memory persists.
const coworkerMemorySchema = new mongoose.Schema({
  // Stable slug so a re-learned fact updates in place instead of duplicating.
  key: { type: String, required: true, unique: true, index: true },
  // Broad area: pricing | listings | bots | farming | marketplaces | pool |
  // sales | ops | code | domain | …
  topic: { type: String, default: "", index: true },
  text: { type: String, default: "" },
  // Who wrote it: "seed" (installed by an engineer), "coworker" (the AI learned
  // it), or "operator".
  source: { type: String, default: "coworker" },
  // Pinned memories are always loaded into the coworker's prompt.
  pinned: { type: Boolean, default: false },
  useCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

coworkerMemorySchema.index({ pinned: -1, updatedAt: -1 });

module.exports = mongoose.model("CoworkerMemory", coworkerMemorySchema);
