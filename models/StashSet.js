const mongoose = require("mongoose");

// A named holding folder for Twitch accounts you're NOT ready to put to work
// yet — a staging area that sits completely apart from the Account Pool
// (models/AvailableAccount.js). Nothing in the bot / drop-scanner / pool code
// ever reads StashSet or StashAccount, so accounts parked here are invisible to
// everything until you explicitly "Move set -> Account Pool" (see
// routes/stashRoutes.js). That isolation is the whole point: you can hoard,
// group, and live-check accounts over time without any of them leaking into a
// live bot config the way a pool account can.
const stashSetSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // Lowercased mirror for case-insensitive uniqueness (no two sets named
    // "Prime" / "prime").
    nameLower: { type: String, required: true, unique: true, index: true },
    note: { type: String, default: "" },
  },
  { timestamps: true },
);

module.exports = mongoose.model("StashSet", stashSetSchema);
