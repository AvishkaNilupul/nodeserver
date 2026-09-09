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

// Optional per-market warm-up, run once before the row loop. Gameflip needs one:
// asking it 238 times in a row earns HTTP 429 "Too many attempts", and a 429
// reads exactly like "this listing is gone" unless something distinguishes them.
// So the bulk state comes from ONE paged query and only the leftovers are asked
// about individually.
const PREPARE = {
  gameflip: async () => {
    const onsale = await mp.gameflipListingIdsByStatus("onsale");
    const sold = await mp.gameflipListingIdsByStatus("sold");
    return { onsale, sold };
  },
};

// Per-market pacing. Gameflip's rate limiter is silent and unforgiving: at 180ms
// between calls it returned 429 for 25 of 55 rows; at 1200ms, 4 of 55. Measured,
// not guessed.
const PACE_MS = { gameflip: 1200, eldorado: 250, ggsel: 250 };

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
  // The paged search is NOT authoritative: it omitted 48 of 244 genuinely
  // onsale listings when measured. So a row it does not list is a SUSPECT, not
  // a corpse — it gets one direct read, and only that answer counts.
  gameflip: async (row, ready) => {
    const id = String(row.externalId);
    if (ready && ready.onsale && ready.onsale.has(id)) return "onsale";
    if (ready && ready.sold && ready.sold.has(id)) return "sold";
    return String((await mp.gameflipListingStatus(id)) || "").toLowerCase();
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
  const ready = PREPARE[market] ? await PREPARE[market]() : null;
  const pace = PACE_MS[market] || 250;

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
      live = await read(row, ready);
    } catch (e) {
      unreadable.push({ row, why: e.message });
      console.log("  ? " + String(row.externalId).padEnd(12) + " could not read: " + e.message);
      continue;
    }
    await sleep(pace);
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
    // "sold" is a real terminal state and is recorded as such — writing it as
    // `delisted` would lose the fact that it earned money.
    const nextStatus = live === "sold" ? "sold" : "delisted";
    const res = await MarketplaceListing.updateOne(
      { _id: row._id, status: "active" },
      {
        $set: {
          status: nextStatus,
          lastError: row.lastError ? row.lastError + " | " + note : note,
        },
      },
    ).catch(() => null);
    if (res && (res.modifiedCount || res.nModified)) fixed += 1;
  }
  console.log("\nmarked " + fixed + " row(s) to match " + market);

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
