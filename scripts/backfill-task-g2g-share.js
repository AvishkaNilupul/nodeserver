// One-time repair for the G2G share record (run on the server, from the repo root).
//
// Until models/AutoFarmTask.js declared `listing.g2g`, a task's G2G share was
// published but never recorded, so tasks that already have a G2G offer still
// read as having none. Left alone, the first sweep after the fix would give
// each such task ONE more offer before the record finally sticks. This stamps
// the record from the offers that are already live, so it does not.
//
// It writes one field on AutoFarmTask (`listing.g2g`) and nothing else: no
// marketplace call, no listing row, no account, no reservation is touched.
// A task that already holds a G2G record is never overwritten.
//
// Run it AFTER the new model file is in place and BEFORE the restart (a
// process still on the old model keeps the stamped field on its own saves,
// but cannot read it). Safe to run again: a second run finds nothing to do.
//
//   node scripts/backfill-task-g2g-share.js            # dry run (no writes)
//   node scripts/backfill-task-g2g-share.js --apply    # write
const idOf = (v) => (v == null ? "" : String(v));

// The rows utils/autoLister.publishG2gShare creates: the auto-lister's own,
// with their accounts attached at publish. Claim-at-sale bundles
// (autoClaimSet, made by scripts/g2g-bundle-listings.js) and rent-farm windows
// are other products that happen to share origin "auto" or the marketplace.
const SHARE_ROWS = {
  marketplace: "g2g",
  origin: "auto",
  status: "active",
  autoClaimSet: { $ne: true },
  rentFarm: { $ne: true },
  externalId: { $nin: ["", null] },
};

const unitsOf = (row) => {
  const units = Array.isArray(row && row.units) ? row.units.length : 0;
  if (units) return units;
  return String((row && row.accountLogin) || "")
    .split(/[,\s]+/)
    .filter(Boolean).length;
};

const hasRecord = (task) => !!(task && task.listing && task.listing.g2g && task.listing.g2g.externalId);

/**
 * Pure: which tasks get which record.
 * @param {object[]} rows  live G2G share rows { set, externalId, url, units, accountLogin, createdAt }
 * @param {object[]} tasks tasks { _id, game, status, listing: { setId, g2g } }
 * @returns {{ sets: object[], updates: object[], recorded: number }}
 *   sets:    one line per set that has a live share (rows, units) — the sprawl, for the owner
 *   updates: { taskId, game, status, setId, offers, record } for every task still unrecorded
 */
function planBackfill(rows, tasks) {
  const bySet = new Map();
  for (const r of rows || []) {
    const key = idOf(r && r.set);
    if (!key || !(r && r.externalId)) continue;
    if (!bySet.has(key)) bySet.set(key, []);
    bySet.get(key).push(r);
  }
  const sets = [];
  const newest = new Map();
  for (const [setId, list] of bySet) {
    // The record holds ONE offer; its only reader asks "is there one at all".
    // The newest is the one the lister itself would have recorded last.
    list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    newest.set(setId, list[0]);
    sets.push({ setId, offers: list.length, units: list.reduce((n, r) => n + unitsOf(r), 0) });
  }
  sets.sort((a, b) => b.offers - a.offers || b.units - a.units);

  const updates = [];
  let recorded = 0;
  for (const t of tasks || []) {
    const setId = idOf(t && t.listing && t.listing.setId);
    const row = newest.get(setId);
    if (!row) continue;
    if (hasRecord(t)) {
      recorded += 1;
      continue;
    }
    updates.push({
      taskId: idOf(t._id),
      game: String(t.game || ""),
      status: String(t.status || ""),
      setId,
      offers: bySet.get(setId).length,
      record: { externalId: String(row.externalId), url: String(row.url || ""), qty: unitsOf(row), error: "" },
    });
  }
  return { sets, updates, recorded };
}

async function main() {
  require("dotenv").config({ quiet: true });
  const mongoose = require("mongoose");
  const AutoFarmTask = require("../models/AutoFarmTask");
  const MarketplaceListing = require("../models/MarketplaceListing");
  const apply = process.argv.includes("--apply");

  // With the old model on disk strict mode would drop this very write, silently.
  if (!AutoFarmTask.schema.path("listing.g2g.externalId")) {
    console.error("models/AutoFarmTask.js does not declare listing.g2g — deploy the model first. Nothing was read or written.");
    process.exit(2);
  }

  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
  try {
    const rows = await MarketplaceListing.find(SHARE_ROWS, { set: 1, externalId: 1, url: 1, units: 1, accountLogin: 1, createdAt: 1 })
      .limit(5000)
      .lean();
    const setIds = [...new Set(rows.map((r) => idOf(r.set)).filter(Boolean))];
    const tasks = setIds.length
      ? await AutoFarmTask.find({ "listing.setId": { $in: setIds } }, { game: 1, status: 1, "listing.setId": 1, "listing.g2g": 1 })
          .limit(5000)
          .lean()
      : [];
    const plan = planBackfill(rows, tasks);

    console.log("live G2G share offers: " + rows.length + " over " + plan.sets.length + " set(s)");
    for (const s of plan.sets) {
      console.log("  set " + s.setId + ": " + s.offers + " offer(s), " + s.units + " account(s)" + (s.offers > 1 ? "   <- more than one offer for one set" : ""));
    }
    console.log("tasks on those sets: " + tasks.length + " (" + plan.recorded + " already recorded, " + plan.updates.length + " to stamp)");

    let written = 0;
    for (const u of plan.updates) {
      console.log("  " + (apply ? "stamp" : "would stamp") + " " + u.game + " [" + u.status + "] task " + u.taskId + " -> offer " + u.record.externalId + " (" + u.record.qty + " account(s); the set has " + u.offers + " offer(s))");
      if (!apply) continue;
      // Guarded again at the write: never over a record that appeared meanwhile.
      const r = await AutoFarmTask.updateOne(
        { _id: u.taskId, "listing.setId": u.setId, "listing.g2g.externalId": { $in: ["", null] } },
        { $set: { "listing.g2g": u.record } },
      );
      written += r.modifiedCount || 0;
    }
    console.log(apply ? "stamped " + written + " of " + plan.updates.length + " task(s)" : "dry run: nothing written (pass --apply to write)");
  } finally {
    await mongoose.disconnect();
  }
}

module.exports = { planBackfill, unitsOf, hasRecord, SHARE_ROWS };

if (require.main === module) {
  main().catch((e) => {
    console.error("backfill failed: " + (e && e.message ? e.message : e));
    process.exit(1);
  });
}
