const mongoose = require("mongoose");

// Dedicated bot configs reserved for the renting system. A stack stays in
// this registry even when no renter is assigned, so it never falls back into
// the operator's general bot inventory by accident.
const renterBotStackSchema = new mongoose.Schema(
  {
    host: { type: String, required: true, default: "local" },
    file: { type: String, required: true },
    capacity: { type: Number, required: true, default: 10, min: 1, max: 100 },
    enabled: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

renterBotStackSchema.index(
  { host: 1, file: 1 },
  { unique: true, name: "renter_stack_host_file" },
);

module.exports = mongoose.model("RenterBotStack", renterBotStackSchema);
