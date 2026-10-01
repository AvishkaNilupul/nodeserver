#!/usr/bin/env node
/**
 * READ-ONLY. Finds listings whose `unitsSold` counter is AHEAD of the sale signals
 * recorded for them: units a marketplace sold that the farm engine's demand count and
 * every price-evidence reader never saw.
 *
 *   node scripts/sale-signal-gap.js            # human summary
 *   node scripts/sale-signal-gap.js --json     # machine-readable
 *
 * Why it exists: on 2026-10-01 this showed 78 units across 31 listings, 75 of them on
 * multi-account GGSel/Digiseller listings, because utils/saleLearning.js recordListingSale
 * cast a comma-joined `accountId` into an ObjectId, the cast threw, and a bare `catch`
 * swallowed it (tests/saleLearningRecord.test.js). READ THE GAP CAREFULLY: most of those units
 * (66) are the 09-28 GGSel block, when stock read as zero and was logged as 236 "sold" units
 * in one hour, so they are phantom closeouts the bug happened to hide, not lost real
 * sales. After the fix this is a monitor: a gap that keeps GROWING on ACTIVE listings means
 * sales are being dropped again; a jump on delisted ones right after an outage means
 * closeouts are being recorded as sales. Units already missing stay missing (their dates are
 * unknown, so they are deliberately not back-filled).
 *
 * One bounded read of listings (a projection, never `units[]`) and one $group over the
 * `sold:` signals; no writes, no marketplace calls, no allowDiskUse.
 */
require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");

const json = process.argv.includes("--json");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const MarketplaceListing = require("../models/MarketplaceListing");
  const SaleSignal = require("../models/SaleSignal");

  const rows = await MarketplaceListing.find(
    { unitsSold: { $gt: 0 } },
    { marketplace: 1, origin: 1, status: 1, unitsSold: 1, accountId: 1, title: 1, updatedAt: 1 },
  )
    .limit(20000)
    .lean();
  const have = new Map(
    (
      await SaleSignal.aggregate([
        { $match: { source: "listing_sold", dedupeKey: { $regex: "^sold:" } } },
        // one signal PER GAME per unit is written, so count distinct units: <listingId>:<seq>
        { $group: { _id: { l: { $arrayElemAt: [{ $split: ["$dedupeKey", ":"] }, 1] }, s: { $arrayElemAt: [{ $split: ["$dedupeKey", ":"] }, -1] } } } },
        { $group: { _id: "$_id.l", units: { $sum: 1 } } },
      ])
    ).map((r) => [r._id, r.units]),
  );

  const gaps = [];
  for (const r of rows) {
    const gap = (Number(r.unitsSold) || 0) - (have.get(String(r._id)) || 0);
    if (gap > 0) {
      const ids = String(r.accountId || "");
      gaps.push({
        id: String(r._id),
        marketplace: r.marketplace,
        origin: r.origin,
        status: r.status,
        unitsSold: r.unitsSold,
        signals: have.get(String(r._id)) || 0,
        gap,
        accountIdShape: !ids ? "empty" : ids.includes(",") ? "several (comma-joined)" : "single",
        title: String(r.title || "").slice(0, 70),
        updatedAt: r.updatedAt,
      });
    }
  }
  const total = gaps.reduce((a, g) => a + g.gap, 0);
  const byShape = gaps.reduce((m, g) => ((m[g.accountIdShape] = (m[g.accountIdShape] || 0) + g.gap), m), {});
  const byMarket = gaps.reduce((m, g) => ((m[g.marketplace] = (m[g.marketplace] || 0) + g.gap), m), {});

  if (json) {
    console.log(JSON.stringify({ listingsWithSales: rows.length, listingsWithGap: gaps.length, unitsWithoutSignal: total, byShape, byMarket, gaps }, null, 1));
  } else {
    console.log("listings with unitsSold > 0: " + rows.length);
    console.log("listings whose units outnumber their sale signals: " + gaps.length + " (" + total + " units with no signal)");
    console.log("by accountId shape:", JSON.stringify(byShape));
    console.log("by marketplace:   ", JSON.stringify(byMarket));
    for (const g of gaps.sort((a, b) => b.gap - a.gap).slice(0, 15)) {
      console.log("  " + g.marketplace.padEnd(11) + String(g.gap).padStart(3) + " of " + String(g.unitsSold).padEnd(3) + " " + g.accountIdShape.padEnd(24) + g.status.padEnd(9) + g.title);
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
