const mongoose = require("mongoose");

// A change the coworker RECOMMENDS but is not allowed to make itself
// (propose-only mode). The operator reviews these and applies them by hand. This
// is how the coworker "does" things: it investigates, then files a concrete,
// reviewable proposal instead of touching prod. Not auto-expired.
const coworkerProposalSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  // code | pricing | listings | bots | ops | marketing | other
  kind: { type: String, default: "other", index: true },
  title: { type: String, default: "" },
  // The full recommendation: what to change, why, and (for code) the exact
  // file(s) + a diff or before/after.
  detail: { type: String, default: "" },
  // Optional pointers the operator will need to act: file paths, logins, ids,
  // marketplace names — short labels only, never secrets.
  targets: { type: [String], default: [] },
  severity: { type: String, enum: ["low", "medium", "high"], default: "medium" },
  status: {
    type: String,
    enum: ["open", "applied", "dismissed"],
    default: "open",
    index: true,
  },
  fromQuestion: { type: String, default: "" }, // what the operator asked
  actor: { type: String, default: "" }, // admin:<id> in that session
});

coworkerProposalSchema.index({ status: 1, at: -1 });

module.exports = mongoose.model("CoworkerProposal", coworkerProposalSchema);
