#!/usr/bin/env node
// Apply the Z2U shelf keeper by hand, once, and watch what it does.
//
//   node scripts/z2u-shelf.js                    # dry run — the plan only
//   node scripts/z2u-shelf.js --apply            # act on it
//   node scripts/z2u-shelf.js --apply --revive   # ALSO put seller-paused
//                                                # offers that hold stock back
//                                                # on sale
//   node scripts/z2u-shelf.js --apply --limit=5  # ease into it
//
// The background tick does the same work, but on a 30-minute clock and only
// once the flags are on. This is the version you run while watching, which is
// how you should do it the first time.
//
// WHAT --revive IS FOR, and why it is not the default:
// Z2U tells us an offer is off sale, but not who took it off. Status 5 means
// Z2U itself pulled it for running out its duration — that is unambiguous, so
// the keeper always extends and relists those. Status 4 means a PERSON paused
// it, and "paused because it was empty" is indistinguishable from "paused on
// purpose". A background job must never quietly undo a human decision, so
// reviving those is opt-in. On the shelf as found, that is where most of the
// money was: Hunt: Showdown paused with 128 accounts in stock, Delta Force 95,
// Brawlhalla 59, Dead by Daylight 56, Dark and Darker 39.
//
// Every write is verified by reading the offer back — see keepShelfAlive.
require("dotenv").config();
const mongoose = require("mongoose");

const mp = require("../utils/marketplaces");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const hit = args.find((a) => a.startsWith(f + "="));
  return hit ? hit.slice(f.length + 1) : d;
};
const APPLY = has("--apply");
const REVIVE = has("--revive");
const LIMIT = parseInt(val("--limit", "0"), 10) || 0;
// Additive only: never take an offer off sale. Use this when the operator knows
// about stock the database does not (hand-filled from a stash), so a zero here
// is not proof the offer cannot be honoured.
const PUBLISH_ONLY = has("--publish-only");

async function main() {
  if (!(mp.keyStatus().z2u || {}).configured) {
    console.error("Z2U is not configured — paste the Cookie header first.");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const ful = require("../utils/z2uFulfiller");

  console.log(
    (APPLY ? "APPLYING" : "DRY RUN") +
      (REVIVE ? " (+revive seller-paused)" : "") +
      (PUBLISH_ONLY ? " (publish only — nothing goes off sale)" : "") +
      (LIMIT ? " limit=" + LIMIT : ""),
  );
  const done = await ful.keepShelfAlive({
    dryRun: !APPLY,
    limit: LIMIT,
    resumeSellerPaused: REVIVE,
    publishOnly: PUBLISH_ONLY,
  });

  const acts = done.filter((d) => d.action);
  if (!acts.length) {
    console.log("nothing to do — the shelf already matches what we can ship.");
  }
  for (const a of acts) {
    // verified === true is the only thing that means it really happened; the
    // status code on its own is not evidence.
    const mark = !APPLY
      ? "plan"
      : a.verified === true
        ? " ok "
        : a.verified === false
          ? "FAIL"
          : " ?? ";
    console.log(
      mark + "  " + String(a.action).padEnd(11) + String(a.pk).padEnd(10) +
        String(a.why).padEnd(30) + String(a.title).slice(0, 40),
    );
    if (a.verifyNote) console.log("        note: " + a.verifyNote);
    if (a.error) console.log("        error: " + a.error);
  }
  if (APPLY) {
    const ok = acts.filter((a) => a.verified === true).length;
    const bad = acts.filter((a) => a.verified === false).length;
    const unknown = acts.length - ok - bad;
    console.log(
      "\nverified " + ok + " / " + acts.length +
        (bad ? ", FAILED " + bad : "") +
        (unknown ? ", unverified " + unknown : ""),
    );
  } else {
    console.log("\n" + acts.length + " action(s) planned. Re-run with --apply to act.");
  }
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
