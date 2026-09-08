#!/usr/bin/env node
// Take the hand-made G2G shelf off sale, now that every product it carried is
// published properly with a listing row behind it.
//
//   node scripts/g2g-retire-handmade.js            # dry run
//   node scripts/g2g-retire-handmade.js --apply
//
// KEEPS exactly two things: an offer with a MarketplaceListing row (the managed
// bundles), and the rent-farm offers this system published (ids in
// /tmp/g2g-keep-farm.txt). Everything else on the account was typed in by hand,
// has no stock source and cannot be delivered by the bot.
//
// A G2G delist is a STATUS CHANGE, never a delete: the offer, its history and
// its sales count all survive, and g2gRelist is its exact inverse. Orders
// already placed against an offer are unaffected -- delisting only stops NEW
// purchases.
require("dotenv").config();
const fs = require("fs");
const mongoose = require("mongoose");
const mp = require("../utils/marketplaces");

const APPLY = process.argv.includes("--apply");
const DELAY = 1200;

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const ML = require("../models/MarketplaceListing");
  const rows = await ML.find({ marketplace: "g2g" }, { externalId: 1 }).lean();
  const keep = new Set(rows.map((r) => String(r.externalId)));
  let farmKept = 0;
  try {
    for (const line of fs.readFileSync("/tmp/g2g-keep-farm.txt", "utf8").split("\n")) {
      const id = line.trim();
      if (id) { keep.add(id); farmKept++; }
    }
  } catch { /* no keep-list: only rows are kept */ }

  const offers = await mp.g2gListOffers({ pageSize: 100, maxPages: 10 });
  const doomed = offers.filter((o) => !keep.has(String(o.offerId)));
  console.log("live offers=" + offers.length + "  keeping=" + (offers.length - doomed.length) +
    " (rows " + rows.length + " + farm " + farmKept + ")  to delist=" + doomed.length);
  const steam = doomed.filter((o) => /steam account/i.test(String(o.title || "")));
  if (steam.length) {
    console.log("\nNOTE: " + steam.length + " of these are Steam-account listings, a different");
    console.log("product line entirely. Delisting is reversible (g2gRelist).");
  }
  if (!APPLY) {
    console.log("\nDRY RUN — nothing delisted.");
    for (const o of doomed.slice(0, 10)) console.log("   would delist " + o.offerId + "  " + String(o.title).slice(0, 54));
    await mongoose.disconnect();
    return;
  }
  let ok = 0, failed = 0;
  for (const o of doomed) {
    try {
      await mp.g2gDelist(o.offerId);
      ok++;
      console.log("delisted " + o.offerId + "  " + String(o.title).slice(0, 52));
    } catch (e) {
      failed++;
      console.error("FAIL     " + o.offerId + ": " + String(e.message).slice(0, 90));
    }
    await new Promise((r) => setTimeout(r, DELAY));
  }
  console.log("\ndelisted=" + ok + " failed=" + failed);
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
