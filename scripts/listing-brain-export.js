#!/usr/bin/env node
// You never run this here; the owner reviews and runs it.
//
// READ-ONLY export of one real listing-brain bundle (docs/LISTING-BRAIN-PLAN.md §2.1): the exact
// object a live run of the listing brain reads, written to one JSON file so every number the brain
// logs can be reproduced offline (`loadFromBundle`, the preview, the backtest).
//
//   node scripts/listing-brain-export.js                    # writes ./listing-brain-bundle-<UTC stamp>.json
//   node scripts/listing-brain-export.js --out bundle.json
//
// What it does, and nothing else:
//   * connects with the repo's normal Mongo settings (MONGO_URI from .env), with index building and
//     collection creation switched OFF, so connecting can never write;
//   * calls utils/listingBrain/inputs.load({ now }) — the same projected, limited, lean reads the
//     brain makes (no write, no marketplace call; venuePrice reads a DB-cached snapshot);
//   * runs privacyScan and validateBundle and REFUSES to write if either finds anything;
//   * writes the file (never over an existing one), prints the counts and notes, disconnects.
// It writes nothing to the database, changes no setting and calls no marketplace.
const fs = require("fs");
const path = require("path");

function argValue(args, name) {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
  const eq = args.find((a) => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : "";
}

function defaultOut(now) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return "listing-brain-bundle-" + stamp + ".json";
}

/**
 * Load, check, write. Separate from main() so the refuse-to-write rule is testable without Mongo.
 * @param {object} o
 * @param {object} o.inputs  utils/listingBrain/inputs (or a fake with load/privacyScan/validateBundle)
 * @param {number} o.now
 * @param {string} o.out     file to create (refused if it exists)
 * @param {function} [o.log]
 * @returns {Promise<{ written: boolean, file: string, leaks: string[], problems: string[], bytes: number }>}
 */
async function exportBundle({ inputs, now, out, log = console.log }) {
  const bundle = await inputs.load({ now });
  const leaks = inputs.privacyScan(bundle);
  const problems = inputs.validateBundle(bundle);
  if (leaks.length || problems.length) {
    log("REFUSED: the bundle is not written.");
    if (leaks.length) log("  privacy: " + leaks.length + " forbidden field(s), e.g. " + leaks.slice(0, 10).join(", "));
    if (problems.length) log("  validation: " + problems.length + " problem(s), e.g. " + problems.slice(0, 10).join("; "));
    return { written: false, file: out, leaks, problems, bytes: 0 };
  }
  const text = JSON.stringify(bundle);
  // "wx": an existing file is never overwritten (a second export gets its own name).
  fs.writeFileSync(out, text, { flag: "wx" });
  log("Wrote " + out + " (" + Math.round(text.length / 1024) + " KB).");
  const c = bundle.counts || {};
  log(
    "  listings " + bundle.listings.length + ", sales " + bundle.sales.length + ", demand-only " + bundle.demandOnly.length + ", no-claim units " + bundle.noclaim.units.length +
      ", waves " + bundle.noclaim.waves.length + ", farm-brain rows " + bundle.demand.length + ", radar games " + bundle.radar.games.length +
      ", old games " + Object.keys(bundle.old.games).length + ", offers " + Object.keys(bundle.old.offers).length + (c.trackerAgeMin != null ? ", tracker report " + c.trackerAgeMin + " min old" : ""),
  );
  for (const n of bundle.notes || []) log("  note: " + n);
  return { written: true, file: out, leaks, problems, bytes: text.length };
}

async function main() {
  // Required here, not at the top: requiring this file (the tests do) must connect nothing.
  require("dotenv").config();
  const mongoose = require("mongoose");
  const args = process.argv.slice(2);
  const now = Date.now();
  const out = path.resolve(argValue(args, "--out") || defaultOut(now));
  if (fs.existsSync(out)) {
    console.error("Refusing to overwrite " + out + ": pass another --out.");
    process.exitCode = 2;
    return;
  }
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGO_URI is not set (the repo's .env provides it).");
    process.exitCode = 2;
    return;
  }
  // Read-only connection: no index builds and no collection creation on first use of a model.
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  try {
    const inputs = require("../utils/listingBrain/inputs");
    const r = await exportBundle({ inputs, now, out });
    if (!r.written) process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error("listing-brain-export failed:", e && e.message ? e.message : e);
      process.exitCode = 1;
    })
    // A cached report's background refresh may still hold a timer; nothing is left to wait for.
    .finally(() => process.exit(process.exitCode || 0));
}

module.exports = { exportBundle, argValue, defaultOut };
