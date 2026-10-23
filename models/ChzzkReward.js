const mongoose = require("mongoose");

// One row per (account, reward) that this account has EARNED from CHZZK
// (docs/CHZZK-FARM.md §7). A reward's coupon code — once we have read it — is
// stored encrypted in codeEnc (utils/secretBox). Never log or return codeEnc.
//
// INVARIANT: a row with hasCode: true is never deleted, and its codeEnc is
// never overwritten. codes.js enforces this structurally with a
// { hasCode: { $ne: true } } filter on every code write; A5's deletion routes
// honour the same rule at a higher level.
const chzzkRewardSchema = new mongoose.Schema(
  {
    // The owning ChzzkAccount _id, as a string for consistency with other
    // CHZZK rows (and so a test that uses string ids does not need to cast).
    accountId: { type: String, required: true, index: true },
    // Copied from the account so a report can group by login without a join.
    userIdHash: { type: String, default: "" },
    campaignNo: { type: Number, required: true, index: true },
    rewardNo: { type: Number, required: true },
    title: { type: String, default: "" },
    rewardType: { type: String, default: "" },
    categoryId: { type: String, default: "" },
    campaignTitle: { type: String, default: "" },
    // From the claim: when the account earned the reward (KST wall clock parsed
    // to a UTC Date), and when the code expires.
    earnedAt: { type: Date, default: null },
    codeEndAt: { type: Date, default: null },
    // "earned"  — a code is owed but not read yet
    // "stored"  — codeEnc holds the code
    // "in_app"  — the reward was an in-app grant, no code to fetch
    state: { type: String, default: "earned" },
    codeEnc: { type: String, default: "" },
    hasCode: { type: Boolean, default: false, index: true },
    codeNo: { type: String, default: "" },
    codeAt: { type: Date, default: null },
    tries: { type: Number, default: 0 },
    nextTryAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
    revealedAt: { type: Date, default: null },
    revealedBy: { type: String, default: "" },
  },
  { timestamps: true, minimize: false },
);

// One row per (account, reward) — the collector upserts on this pair.
chzzkRewardSchema.index({ accountId: 1, rewardNo: 1 }, { unique: true });

module.exports = mongoose.model("ChzzkReward", chzzkRewardSchema);
