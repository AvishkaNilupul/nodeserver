// A bot config that CHANGED while its container was running and has not been
// reloaded since (bots read their config only at startup).
//
// utils/renterBotOps records one the moment it takes accounts out of a file a
// container may be running, and deletes it once that container has restarted
// (or is known not to be running). A reload that fails therefore stays owed —
// retried by the next stop / expiry sweep — instead of being lost, and a stop
// that removed nothing and owes nothing restarts nothing. Before this, "owed"
// was guessed from ledger pointers, which restarted a 49-buyer stack on every
// repeated Stop press and every 5 minutes while an unrelated host was offline.
const mongoose = require("mongoose");

const pendingReloadSchema = new mongoose.Schema(
  {
    host: { type: String, required: true },
    file: { type: String, required: true },
    since: { type: Date, default: Date.now },
    reason: { type: String, default: "" },
  },
  { timestamps: true },
);

pendingReloadSchema.index({ host: 1, file: 1 }, { unique: true, name: "pending_reload_host_file" });

module.exports = mongoose.model("PendingReload", pendingReloadSchema);
