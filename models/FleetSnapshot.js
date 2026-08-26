const mongoose = require("mongoose");

// Periodic point-in-time snapshot of fleet / pool / marketplace counts — the
// time series that was MISSING when the Drops Archive account count dropped ~500
// and nothing could reconstruct it (ArchiveRollup / AutoFarmSnapshot are
// single-doc and overwritten). Tiny rows, captured every ~20 min by
// utils/fleetSnapshot.js and kept ~13 months (TTL) so trends stay explainable.
const fleetSnapshotSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  // Flexible bag so new counts can be added without a migration, e.g.
  // { botTotal, botOk, botSuspended, botTokenInvalid, botUndeployed,
  //   poolTotal, poolAvailable, poolClaimed, dropLogEntries, listingsTotal }.
  metrics: { type: mongoose.Schema.Types.Mixed, default: {} },
});

fleetSnapshotSchema.index({ at: -1 });
// Keep ~13 months (this {at:1} index doubles as the ascending index).
fleetSnapshotSchema.index({ at: 1 }, { expireAfterSeconds: 400 * 24 * 60 * 60 });

module.exports = mongoose.model("FleetSnapshot", fleetSnapshotSchema);
