#!/usr/bin/env node
// Credit rent-farm windows for a bot outage (2026-10-01).
//
// WHY: a paid window counts farming days; when a stack was dead (container
// stopped, host offline, config broken) its buyers lost those days. The fair
// fix is to extend each affected window by the length of the outage — by hand
// this meant editing every account's farmUntil and every order's copy.
//
// WHAT IT DOES: for every LIVE, BOUNDED window (farmEndedAt null, farmUntil
// set, not already lapsed) recorded in the given stack(s), moves farmUntil
// later by the outage length, and keeps the rent-farm order's copy of that
// window (FarmServiceOrder.accounts[].farmUntil) in step. Open-ended rows and
// ended rows are left alone. One SystemEvent records the credit.
//
// USAGE (on the prod server, from the app root; DRY RUN unless --apply):
//   node scripts/credit-farm-outage.js --stack contabo/config_03.json --hours 6
//   node scripts/credit-farm-outage.js --stack contabo/config_03.json,contabo/config_04.json \
//        --from 2026-10-02T01:00Z --to 2026-10-02T07:30Z --apply
//   ... add --renter operator-selffarm to credit only the rent-farm buyers.
//
// SAFETY: never shortens a window; refuses a credit over 14 days (a typo in
// --hours / --from should not hand out months); prints every row it would move.
// It credits whoever is recorded in the stack NOW: a buyer placed there after
// the outage is credited too, and one moved elsewhere since is not — read the
// dry-run list before --apply. Run it when nothing else is moving accounts
// (it does not take the server's in-process busy marks).
const path = require("path");
const APP = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(APP, ".env"), quiet: true });
const mongoose = require("mongoose");
const RenterAccount = require(path.join(APP, "models", "RenterAccount"));
const Renter = require(path.join(APP, "models", "Renter"));
const FarmServiceOrder = require(path.join(APP, "models", "FarmServiceOrder"));
const { logEvent } = require(path.join(APP, "utils", "systemLog"));

function arg(n, d = null) {
  const i = process.argv.indexOf("--" + n);
  return i > -1 ? process.argv[i + 1] : d;
}
function die(m) {
  console.error("ABORT: " + m);
  process.exit(1);
}
const APPLY = process.argv.includes("--apply");
const MAX_CREDIT_MS = 14 * 86400000;

(async () => {
  const stacks = String(arg("stack", "") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf("/");
      if (i <= 0) die("--stack wants host/config_NN.json, got " + s);
      return { host: s.slice(0, i), file: s.slice(i + 1) };
    });
  if (!stacks.length) die("need --stack host/config_NN.json[,host/config_MM.json]");
  let creditMs;
  if (arg("hours")) {
    creditMs = Number(arg("hours")) * 3600000;
  } else if (arg("from") && arg("to")) {
    creditMs = new Date(arg("to")).getTime() - new Date(arg("from")).getTime();
  } else {
    die("need --hours N, or --from <ISO> --to <ISO>");
  }
  if (!Number.isFinite(creditMs) || creditMs <= 0) die("the outage length must be positive");
  if (creditMs > MAX_CREDIT_MS) die("a credit over 14 days is refused (check --hours / --from / --to)");

  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  let renterFilter = {};
  if (arg("renter")) {
    const r = await Renter.findOne({ usernameLower: String(arg("renter")).toLowerCase() }, { _id: 1 }).lean();
    if (!r) die("no renter " + arg("renter"));
    renterFilter = { renter: r._id };
  }
  const now = new Date();
  const rows = await RenterAccount.find({
    ...renterFilter,
    farmEndedAt: null,
    farmUntil: { $ne: null, $gt: now },
    $or: stacks.map((s) => ({
      configFile: s.file,
      host: s.host === "local" ? { $in: ["local", "", null] } : s.host,
    })),
  })
    .sort({ farmUntil: 1 })
    .lean();

  console.log(
    "\n=== credit " + (creditMs / 3600000).toFixed(2) + " h to " + rows.length + " live window(s) on " +
      stacks.map((s) => s.host + "/" + s.file).join(", ") + " ===",
  );
  console.log(APPLY ? "MODE: APPLY\n" : "MODE: DRY RUN (nothing written)\n");
  for (const a of rows) {
    const to = new Date(new Date(a.farmUntil).getTime() + creditMs);
    console.log(
      "  " + String(a.login || a._id).padEnd(24) + " " + new Date(a.farmUntil).toISOString().slice(0, 16) +
        "  ->  " + to.toISOString().slice(0, 16),
    );
  }
  if (!APPLY || !rows.length) {
    if (!APPLY) console.log("\nDRY RUN — re-run with --apply to credit.");
    await mongoose.disconnect();
    return;
  }

  let moved = 0;
  let ordersMoved = 0;
  for (const a of rows) {
    const to = new Date(new Date(a.farmUntil).getTime() + creditMs);
    // Conditional on the window being unchanged since the read: never on top
    // of a concurrent change.
    const r = await RenterAccount.updateOne(
      { _id: a._id, farmEndedAt: null, farmUntil: a.farmUntil },
      { $set: { farmUntil: to } },
    );
    if (!(r && (r.modifiedCount || r.nModified))) {
      console.log("  !! " + (a.login || a._id) + " changed meanwhile — skipped");
      continue;
    }
    moved++;
    if (a.login) {
      const esc = String(a.login).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = { $regex: "^" + esc + "$", $options: "i" };
      const o = await FarmServiceOrder.updateMany(
        { "accounts.login": re },
        { $set: { "accounts.$[x].farmUntil": to } },
        { arrayFilters: [{ "x.login": re, "x.farmUntil": a.farmUntil }] },
      ).catch(() => null);
      ordersMoved += (o && (o.modifiedCount || o.nModified)) || 0;
    }
  }
  await logEvent({
    category: "renter",
    action: "farm_outage_credited",
    actor: "credit-farm-outage",
    subject: stacks.map((s) => s.host + "/" + s.file).join(", "),
    count: moved,
    detail: "credited " + (creditMs / 3600000).toFixed(2) + " h to " + moved + " window(s); " +
      ordersMoved + " order record(s) kept in step",
  }).catch(() => {});
  console.log("\ncredited " + moved + " window(s); " + ordersMoved + " order record(s) kept in step.");
  await mongoose.disconnect();
})().catch((e) => {
  console.error("FAIL", e && e.stack);
  process.exit(1);
});
