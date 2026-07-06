const mongoose = require("mongoose");

// One row per Prime Gaming offer (free game claim or in-game loot) seen by the
// Prime watcher. Rows are upserted by itemId on every pass; offers that
// disappear from Amazon's catalog are kept but marked inactive so the history
// stays browsable.
const primeOfferSchema = new mongoose.Schema(
  {
    itemId: { type: String, required: true, unique: true, index: true },
    title: { type: String, default: "" },
    description: { type: String, default: "" },
    // FULL_GAME | LOOT (Amazon's category for the item)
    category: { type: String, default: "", index: true },
    // Where the claim ends up: gog | epic | legacy | amazon | link | code…
    // Parsed from the claim link's vanity slug; "code" platforms hand out a
    // resellable key, others link to an external account.
    platform: { type: String, default: "" },
    grantsCode: { type: Boolean, default: false },
    claimLink: { type: String, default: "" },
    image: { type: String, default: "" },
    game: { type: String, default: "" },
    startTime: { type: Date, default: null },
    endTime: { type: Date, default: null, index: true },
    active: { type: Boolean, default: true, index: true },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    // Set when the "new offer" alert has been sent so restarts don't re-ping.
    notifiedAt: { type: Date, default: null },
    // Set when the "ending soon" alert has been sent.
    endingNotifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("PrimeOffer", primeOfferSchema);
