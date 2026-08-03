// One-time migration: stamp every marketplace listing with its `origin`
// ("auto" | "manual") so automatic repricing can be scoped by ownership.
//
// The post-event scarcity markup now only touches origin:"auto" rows, which
// keeps the owner's hand-listed stock at the price they gave it. Existing rows
// predate the field, so without this backfill the markup would find nothing and
// silently stop working for the auto-farmer's own listings.
//
//   node scripts/migrate-listing-origin.js            # dry run
//   node scripts/migrate-listing-origin.js --apply     # write
//   node scripts/migrate-listing-origin.js --revert --apply   # unset the field
//
// Classification rule: a listing is auto if and only if its `set` is a set an
// AutoFarmTask created for itself (task.listing.setId). That is stronger than
// matching the task's recorded externalId, because after the first sale the
// relist chain publishes a successor under a brand-new id — the successor is
// still auto stock and must still be repriceable. Everything else is the
// owner's, and the model's default ("manual") means a row this script somehow
// misses is treated as the owner's and left alone rather than repriced.
//
// Uses the RAW MongoDB driver so it can run BEFORE the new code is deployed.
// Idempotent: only writes rows that have no origin yet.
require("dotenv").config();
const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const listings = db.collection("marketplacelistings");
  const tasks = db.collection("autofarmtasks");

  if (REVERT) {
    const n = await listings.countDocuments({ origin: { $exists: true } });
    console.log("rows with origin set: " + n);
    if (!APPLY) {
      console.log("\nDRY RUN — pass --apply to unset origin on all of them.");
    } else {
      const r = await listings.updateMany({}, { $unset: { origin: "" } });
      console.log("unset origin on " + r.modifiedCount + " row(s).");
    }
    await mongoose.disconnect();
    return;
  }

  // Sets the auto-farmer created for its own listings.
  const autoSetIds = new Set();
  for (const t of await tasks
    .find(
      { "listing.setId": { $nin: ["", null] } },
      { projection: { listing: 1 } },
    )
    .toArray()) {
    autoSetIds.add(String(t.listing.setId));
  }
  console.log("auto-farm sets: " + autoSetIds.size);

  const rows = await listings
    .find({}, { projection: { set: 1, marketplace: 1, status: 1, origin: 1 } })
    .toArray();
  const autoIds = [];
  const manualIds = [];
  const already = { auto: 0, manual: 0 };
  for (const r of rows) {
    if (r.origin === "auto" || r.origin === "manual") {
      already[r.origin]++;
      continue;
    }
    (autoSetIds.has(String(r.set)) ? autoIds : manualIds).push(r._id);
  }

  const tally = (ids) => {
    const byKey = {};
    const set = new Set(ids.map(String));
    for (const r of rows) {
      if (!set.has(String(r._id))) continue;
      const k = r.marketplace + "/" + r.status;
      byKey[k] = (byKey[k] || 0) + 1;
    }
    return byKey;
  };

  console.log("total rows: " + rows.length);
  console.log(
    "already stamped: auto=" + already.auto + " manual=" + already.manual,
  );
  console.log("\nto stamp AUTO   (" + autoIds.length + "): ", tally(autoIds));
  console.log("to stamp MANUAL (" + manualIds.length + "): ", tally(manualIds));

  if (!APPLY) {
    console.log("\nDRY RUN — pass --apply to write.");
    await mongoose.disconnect();
    return;
  }

  let wrote = 0;
  if (autoIds.length) {
    const r = await listings.updateMany(
      { _id: { $in: autoIds } },
      { $set: { origin: "auto" } },
    );
    wrote += r.modifiedCount;
    console.log("stamped auto: " + r.modifiedCount);
  }
  if (manualIds.length) {
    const r = await listings.updateMany(
      { _id: { $in: manualIds } },
      { $set: { origin: "manual" } },
    );
    wrote += r.modifiedCount;
    console.log("stamped manual: " + r.modifiedCount);
  }
  console.log("done — " + wrote + " row(s) written.");
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
