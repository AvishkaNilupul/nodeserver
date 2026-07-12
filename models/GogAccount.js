const mongoose = require("mongoose");

// A dedicated GOG.com account used as a fallback home for Prime Gaming codes
// that are about to expire unsold — the operator creates and provides these
// manually (account creation isn't something this app does on its own), then
// redeems an expiring key onto one by hand when the watcher flags it. Games
// held by an account are looked up from PrimeKey.redeemedAccount rather than
// duplicated here.
const gogAccountSchema = new mongoose.Schema(
  {
    label: { type: String, required: true },
    login: { type: String, required: true },
    // Encrypted at rest via utils/secretBox, same treatment as bot account
    // passwords and vault key codes.
    password: { type: String, required: true },
    note: { type: String, default: "" },
    status: {
      type: String,
      enum: ["active", "retired"],
      default: "active",
      index: true,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("GogAccount", gogAccountSchema);
