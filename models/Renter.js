const mongoose = require("mongoose");

// A "renter" is an outside seller who rents ONE bot slot (a TwitchDropsBot
// config file on a host). They are a completely separate auth realm from the
// operator admins (admins.json): a renter session is req.session.renter, never
// req.session.admin, so a renter can never reach any admin/superadmin route.
//
// Everything a renter may touch is derived server-side from THIS record — the
// assigned bot (botHost/botFile), their account quota, and their lease window.
// Renters submit accounts for the operator to approve; they never write a live
// config themselves (see RenterSubmission).
const renterSchema = new mongoose.Schema(
  {
    username: { type: String, required: true },
    // Lowercased mirror for case-insensitive uniqueness/lookup.
    usernameLower: { type: String, required: true, unique: true, index: true },
    // bcrypt hash used for login verification.
    passwordHash: { type: String, required: true },
    // The same password encrypted (secretBox / AES-GCM) so the operator can view
    // it. Renters cannot change their own password — only a superadmin sets it,
    // and only a superadmin can reveal it. Stored reversibly on purpose; matches
    // how the app already keeps account passwords/tokens recoverable.
    passwordEnc: { type: String, default: "" },
    displayName: { type: String, default: "" },

    // active = may log in (subject to lease); suspended = blocked + bot stopped.
    status: {
      type: String,
      enum: ["active", "suspended"],
      default: "active",
      index: true,
    },

    // The one bot slot this renter owns. A config file dedicated to them.
    botHost: { type: String, default: "" },
    botFile: { type: String, default: "" },

    // How many accounts they may have on their bot (config accounts + pending
    // submissions must stay at or below this).
    maxAccounts: { type: Number, default: 0, min: 0 },

    // Access period (lease). accessEnd in the past = expired (blocked). Null
    // accessEnd = open-ended.
    accessStart: { type: Date, default: null },
    accessEnd: { type: Date, default: null, index: true },

    // Bookkeeping.
    lastLoginAt: { type: Date, default: null },
    // Stamped when a suspend/expiry sweep has already stopped their bot, so the
    // sweep doesn't keep issuing stop calls every tick.
    botStoppedAt: { type: Date, default: null },
    notes: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true },
);

// One config file is never assigned to two renters (isolation guarantee). The
// partial filter (botFile greater than the empty string = any non-empty string)
// keeps unassigned renters from colliding on botFile "".
renterSchema.index(
  { botHost: 1, botFile: 1 },
  { unique: true, partialFilterExpression: { botFile: { $gt: "" } } },
);

module.exports = mongoose.model("Renter", renterSchema);
