#!/usr/bin/env node
// Make our `status` agree with what the marketplace actually shows.
//
//   node scripts/reconcile-listing-status.js --market ggsel
//   node scripts/reconcile-listing-status.js --market ggsel --apply
//
// Found 2026-09-09: three GGSel "Automatic Farming" offers read `status:
// "active"` in our database while GGSel itself reported `paused` with 0 stock.
// They were paused on purpose — GGSel has no farm service, so a sale there
// cannot be delivered — but the ad-hoc script that paused them wrote only a
// `lastError` note. Nothing was at risk (they genuinely are off sale), yet every
// count we render, and the health page, called them live.
//
// Why the drift could not correct itself: `unclaimedAutoList.reconcileRowsPass`
// is the only thing that reads GGSel status back, and it is scoped to
// `origin: "unclaimed"`. These rows are `origin: "manual"`, so no sweep has ever
// looked at them. That is also what makes them safe to correct here — the same
// scoping means nothing will try to re-activate them afterwards.
//
// MarketplaceListing.status has no "paused": the enum is
// ["active", "sold", "delisted", "error"]. Anything the marketplace does not
// call live is therefore recorded as `delisted` — off sale — with the live word
// kept in the note so the distinction is not lost.
//
// Read-only until --apply. Never publishes, relists, prices or deletes anything;
// the only field written is `status` (plus an appended note).
require("dotenv").config();
const mongoose = require("mongoose");
const MarketplaceListing = require("../models/MarketplaceListing");
const mp = require("../utils/marketplaces");
const { logEvent } = require("../utils/systemLog");

// One reader per marketplace. Each returns the marketplace's own word for the
// offer's state, lowercased, or "" when it could not be read.
const READERS = {
  ggsel: async (row) => String(await mp.ggselOfferStatus(row.externalId) || "").toLowerCase(),
  // Eldorado puts the state on the offer itself. "Active" is the only value a
  // buyer can purchase from; Paused / Deleted / Expired are all off sale.
  eldorado: async (row) => {
    const offer = await mp.eldoradoOffer(row.externalId);
    return String((offer && offer.offerState) || "").toLowerCase();
  },
};

// Which live words mean "a buyer can purchase this right now".
const LIVE = new Set(["active", "onsale", "on_sale", "live", "published"]);

const has = (n) => process.argv.includes("--" + n);
const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i > 0 ? process.argv[i + 1] : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, {});
  const market = String(arg("market") || "").trim().toLowerCase();
  const read = READERS[market];
  if (!read) {
    throw new Error(
      "--market must be one of: " + Object.keys(READERS).join(", ") +
        " (add a reader above for others)",
    );
  }

  // Only rows we believe are live. A row we already call delisted needs no
  // check, and re-reading every historical row would be a lot of API calls for
  // nothing.
  const rows = await MarketplaceListing.find(
    { marketplace: market, status: "active" },
    { externalId: 1, title: 1, price: 1, status: 1, origin: 1, lastError: 1 },
  ).lean();
  console.log(market + ": " + rows.length + " row(s) we call active\n");

  const drift = [];
  const unreadable = [];
  for (const row of rows) {
    let live = "";
    try {
      live = await read(row);
    } catch (e) {
      unreadable.push({ row, why: e.message });
      console.log("  ? " + String(row.externalId).padEnd(12) + " could not read: " + e.message);
      continue;
    }
    await sleep(250);
    const ok = LIVE.has(live);
    console.log(
      (ok ? "  = " : "  ! ") + String(row.externalId).padEnd(12) +
        " we:active  they:" + (live || "unknown").padEnd(10) +
        " " + String(row.title || "").slice(0, 46),
    );
    if (!ok) drift.push({ row, live });
  }

  console.log(
    "\n" + drift.length + " row(s) drifted, " + unreadable.length + " unreadable, " +
      (rows.length - drift.length - unreadable.length) + " agree",
  );
  // An unreadable status is not evidence of anything. Saying so is the point:
  // silently treating it as agreement is how the original drift went unnoticed.
  if (unreadable.length) {
    console.log("  (unreadable rows are left ALONE — not proof of either state)");
  }
  if (!drift.length || !has("apply")) {
    if (drift.length) console.log("\nDRY RUN — nothing changed. Re-run with --apply.\n");
    await mongoose.disconnect();
    return;
  }

  let fixed = 0;
  for (const { row, live } of drift) {
    const note =
      "status reconciled " + new Date().toISOString().slice(0, 10) +
      ": " + market + " reports \"" + (live || "unknown") + "\"";
    const res = await MarketplaceListing.updateOne(
      { _id: row._id, status: "active" },
      {
        $set: {
          status: "delisted",
          lastError: row.lastError ? row.lastError + " | " + note : note,
        },
      },
    ).catch(() => null);
    if (res && (res.modifiedCount || res.nModified)) fixed += 1;
  }
  console.log("\nmarked " + fixed + " row(s) delisted to match " + market);

  await logEvent({
    category: "marketplace",
    action: "listing_status_reconciled",
    actor: "reconcile-listing-status",
    severity: "warn",
    subject: market,
    count: fixed,
    detail:
      fixed + " " + market + " listing(s) we called active are not live there: " +
      drift.map((d) => d.row.externalId + "=" + (d.live || "unknown")).join(", "),
  }).catch(() => {});

  await mongoose.disconnect();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
