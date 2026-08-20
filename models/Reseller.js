const mongoose = require("mongoose");

// Resellers are a separate tenant/auth realm from operator admins and renters.
const resellerSchema = new mongoose.Schema(
  {
    username: { type: String, required: true },
    usernameLower: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
    passwordEnc: { type: String, default: "" },
    displayName: { type: String, default: "" },
    notes: { type: String, default: "" },
    status: {
      type: String,
      enum: ["active", "suspended"],
      default: "active",
      index: true,
    },
    accessStart: { type: Date, default: null },
    accessEnd: { type: Date, default: null, index: true },
    // Zero means unlimited; assignment enforces a cap only when this is > 0.
    maxAccounts: { type: Number, default: 0, min: 0 },
    lastLoginAt: { type: Date, default: null },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Reseller", resellerSchema);
