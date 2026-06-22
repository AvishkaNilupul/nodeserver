const mongoose = require("mongoose");

// Append-only ledger of every balance change so top-ups and spends leave an
// audit trail (admins.json only holds the current balance, not its history).
// `delta` is signed: positive = credit (top-up / refund), negative = debit
// (purchase). `balanceAfter` snapshots the wallet right after the change.
const balanceLogSchema = new mongoose.Schema(
  {
    adminId: { type: String, required: true, index: true },
    username: { type: String, default: "" },
    // topup | set | purchase | refund
    kind: { type: String, default: "topup", index: true },
    delta: { type: Number, default: 0 },
    balanceAfter: { type: Number, default: 0 },
    note: { type: String, default: "" },
    // Who made the change (superadmin id for top-ups, buyer id for purchases).
    byAdminId: { type: String, default: "" },
    byUsername: { type: String, default: "" },
    // Optional links to the related purchase / bundle.
    purchaseId: { type: String, default: "" },
    setId: { type: String, default: "" },
  },
  { timestamps: true },
);

module.exports = mongoose.model("BalanceLog", balanceLogSchema);
