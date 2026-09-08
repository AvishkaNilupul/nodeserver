#!/usr/bin/env node
// Catch up on Gameflip listings that sold while nothing was watching them.
//
//   node scripts/reconcile-gameflip-sold.js            # dry run (default)
//   node scripts/reconcile-gameflip-sold.js --apply
//
// `utils/gameflipFulfiller.syncOnce` filtered its sweep to `autoDeliver: true`,
// so the owner's hand-made listings (68 with autoDeliver false, 3 with none)
// were never polled. Measured 2026-09-09: 26 had already sold — $51.80 of
// revenue with no record, the oldest unnoticed since 14 July. `status` stayed
// "active", so they also kept counting as live stock and their prices never
// reached the pricing evidence.
//
// The sweep is fixed, but it would announce this whole backlog to Telegram as if
// it had just happened — 26 "SOLD on Gameflip" pushes for sales from July and
// August. So the backlog is settled here, QUIETLY, and the fixed sweep then
// handles everything from now on with its alerts intact.
//
// This writes only to our own database. It never calls a marketplace except to
// READ each listing's real status, and it never touches a listing that Gameflip
// does not positively report as sold.
require("dotenv").config();
const mongoose = require("mongoose");
const MarketplaceListing = require("../models/MarketplaceListing");
const DropSet = require("../models/DropSet");
const mp = require("../utils/marketplaces");
const { recordListingSale } = require("../utils/saleLearning");

const has = (n) => process.argv.includes("--" + n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gameflip rate-limits silently (429). One read per listing, spaced.
const GAP_MS = 900;
const RETRY_WAIT_MS = 12000;

async function liveStatus(externalId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await mp.gameflipListingStatus(externalId);
    } catch (e) {
      const msg = String((e && e.message) || "");
      if (msg.includes("429")) {
        await sleep(RETRY_WAIT_MS);
        continue;
      }
      // A 404 is "gone from Gameflip", which is NOT a sale. Leave it alone —
      // retiring a 404 row is the watcher's job and it releases the account.
      if (msg.includes("404")) return "404-gone";
      return "error:" + msg.slice(0, 60);
    }
  }
  return "rate-limited";
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, {});
  const rows = await MarketplaceListing.find({
    marketplace: "gameflip",
    status: "active",
  })
    .select("externalId price title origin autoDeliver set createdAt")
    .lean();
  console.log("gameflip rows our database calls active: " + rows.length);
  console.log("reading each one's real status from Gameflip, serially…\n");

  const sold = [];
  const other = {};
  for (const row of rows) {
    const status = await liveStatus(row.externalId);
    if (status === "sold") sold.push(row);
    else other[status] = (other[status] || 0) + 1;
    await sleep(GAP_MS);
  }

  console.log("SOLD but still active in our DB: " + sold.length);
  console.log("everything else: " + JSON.stringify(other) + "\n");

  let value = 0;
  for (const row of sold) {
    value += Number(row.price) || 0;
    console.log(
      "  $" + String(row.price).padEnd(6) +
        String(row.origin).padEnd(10) +
        new Date(row.createdAt).toISOString().slice(0, 10) + "  " +
        String(row.title || "").slice(0, 58),
    );
  }
  console.log("\n  total unrecorded sale value: $" + value.toFixed(2));

  if (!has("apply")) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply.\n");
    await mongoose.disconnect();
    return;
  }

  let marked = 0;
  let learned = 0;
  for (const row of sold) {
    // Conditional on still being active, so this can never race the live
    // watcher into double-counting a sale.
    const claimed = await MarketplaceListing.findOneAndUpdate(
      { _id: row._id, status: "active" },
      {
        $set: {
          status: "sold",
          lastError:
            "reconciled by scripts/reconcile-gameflip-sold.js — sold on Gameflip " +
            "while the watcher's autoDeliver filter excluded this row",
        },
      },
    ).catch(() => null);
    if (!claimed) continue;
    marked += 1;
    // recordListingSale dedupes on the row's own unitsSold sequence, so a row
    // the watcher later re-reads cannot be counted twice.
    try {
      const set = row.set ? await DropSet.findById(row.set).lean() : null;
      if (set) {
        const n = await recordListingSale({
          listing: row,
          set,
          units: 1,
          priceUsd: Number(row.price) || 0,
          at: new Date(),
        });
        if (n) learned += 1;
      }
    } catch (e) {
      console.error("  sale learning failed for " + row.externalId + ": " + e.message);
    }
  }
  console.log(
    "\nmarked sold: " + marked + "   sale signals written: " + learned +
      "\n(no Telegram: this is a historical backlog, not news.)\n",
  );
  await mongoose.disconnect();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
