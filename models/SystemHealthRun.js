const mongoose = require("mongoose");

// One document per system-health run (docs/SYSTEM-HEALTH-CONTRACT.md, PART B).
//
// This collection exists because two paid "Automatic Farming" orders were lost
// to silent failures — order e69b19d3 and one after it — and nothing on disk
// could answer "when did this last look fine?". The 8 live gameflip/ggsel
// offers measured on 2026-09-09 had carried DropSets of 12-44 items with 0
// accounts holding the full set for an unknown number of days, because no
// record of any earlier state existed to compare against. Storing every run is
// what turns the page from a live dial into "it went bad between 04:00 and
// 05:00", which is the only form of the answer that is actionable.
//
// Writing this row is the ONE mutation the whole health system is allowed to
// make; every check itself is read-only by construction.
const systemHealthRunSchema = new mongoose.Schema(
  {
    // Wall-clock start of the run. Doubles as the natural key: the API upserts
    // on it so a run can never be stored twice (the runner and the route both
    // have a reason to persist, and neither should produce a duplicate).
    startedAt: { type: Date, default: Date.now },
    // How long the whole run took, milliseconds. Worth keeping: this runs
    // hourly and a run that suddenly takes 40 s instead of 3 s is itself the
    // early warning that a marketplace has started timing out.
    ms: { type: Number, default: 0 },
    // Roll-up of the checks below, so /history can chart trend WITHOUT ever
    // loading the checks array. The four statuses are frozen by the contract.
    counts: {
      ok: { type: Number, default: 0 },
      warn: { type: Number, default: 0 },
      fail: { type: Number, default: 0 },
      unknown: { type: Number, default: 0 },
    },
    // The frozen check shape:
    //   { id, title, group, status, severity, summary, measured, threshold,
    //     detail, items, ms, checkedAt }
    // Deliberately Mixed, not a typed sub-schema — `measured` and `threshold`
    // are polymorphic on purpose (a count, a price, a date, a host name), and a
    // typed path would either cast them wrong or silently DROP a field a new
    // check adds. Same reasoning as FleetSnapshot.metrics; the price of a wrong
    // schema here is losing the evidence the contract exists to preserve.
    checks: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { minimize: false },
);

systemHealthRunSchema.index({ startedAt: -1 });
// Auto-expire after 30 days (this {startedAt:1} index doubles as the ascending
// index). Hourly runs are ~720 rows per month with ~11 checks each, which is
// small, but prod Mongo is a bytes-bound Atlas shared tier — nothing here is
// allowed to grow forever. 30 days is the window an operator actually reasons
// about ("did this break before or after the weekend?"); the audit trail in
// SystemEvent keeps the 90-day view.
systemHealthRunSchema.index(
  { startedAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 },
);

module.exports = mongoose.model("SystemHealthRun", systemHealthRunSchema);
