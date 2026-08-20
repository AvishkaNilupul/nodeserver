const mongoose = require("mongoose");

const resellerAuditSchema = new mongoose.Schema(
  {
    reseller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Reseller",
      required: true,
      index: true,
    },
    action: {
      type: String,
      enum: [
        "login",
        "reveal_creds",
        "mark_sold",
        "verify",
        "assign",
        "reclaim",
        "status_change",
        "create",
        "update",
        "suspend",
        "unsuspend",
        "password_reset",
        "delete",
      ],
      required: true,
      index: true,
    },
    accountLogin: { type: String, default: "" },
    ip: { type: String, default: "" },
    at: { type: Date, default: Date.now, index: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

module.exports = mongoose.model("ResellerAudit", resellerAuditSchema);
