#!/usr/bin/env node
// Repair the catalog-profile prices left behind by the linear pricer.
//
//   node scripts/repair-catalog-profile-prices.js            # dry run (default)
//   node scripts/repair-catalog-profile-prices.js --apply
//
// BACKGROUND
// routes/catalogRoutes.js recommendedProfilePrice() used to compute
// `catalogRate * rewards` -- linear in reward count and uncapped -- which wrote
// DropSet.price values up to $227.86 for a business whose highest realised sale
// on record is $4.50. The code is fixed (see utils/pricing.js); this repairs the
// rows that formula already wrote.
//
// SCOPE, DELIBERATELY NARROW
//   - ONLY sourceType "catalog_profile". Unclaimed-farm sets, auto-farm event
//     sets and hand-made sets are NOT touched: unclaimed rows have their own
//     engine plus a sold-floor rule, and the owner's manual pricing must never
//     be overwritten by an automated pass.
//   - `publicPrice` is left ALONE. It is already clamped to $1.01-$2.99 and is
//     what the public catalog actually displays; only `price` (the retail
//     field) carries the runaway numbers.
//   - `minPriceUsd` is honoured as a floor, so a set deliberately held above
//     the model's suggestion keeps its floor.
//   - A set that is live on ANY marketplace listing is SKIPPED and reported.
//     Repricing a published row is a marketplace operation with delist/republish
//     semantics (and on Digiseller it is irreversible), not a DB update.
require("dotenv").config();
const mongoose = require("mongoose");

const pricing = require("../utils/pricing");
const evidence = require("../utils/pricingEvidence");

const APPLY = process.argv.includes("--apply");

function categoryFor(set) {
  for (const item of (set && set.items) || []) {
    const game = String(item.game || "").trim();
    if (game) return game;
  }
  return "";
}

function rewardsOf(set) {
  return ((set && set.items) || []).reduce(
    (sum, item) => sum + Math.max(1, Number(item.qty) || 1),
    0,
  );
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const DropSet = require("../models/DropSet");
  const MarketplaceListing = require("../models/MarketplaceListing");
  const MarketResearch = require("../models/MarketResearch");

  const sets = await DropSet.find({ sourceType: "catalog_profile" }).lean();
  console.log("catalog_profile sets:", sets.length, APPLY ? "(APPLYING)" : "(dry run)");

  // Safety gate: anything published must not be silently repriced in the DB.
  const publishedSetIds = new Set(
    (
      await MarketplaceListing.distinct("set", {
        set: { $in: sets.map((s) => s._id) },
        status: { $in: ["active", "sold"] },
      })
    ).map(String),
  );
  console.log("of those, live/sold on a marketplace:", publishedSetIds.size, "(will be skipped)");

  const research = await MarketResearch.find({}).lean();
  const researchByGame = new Map(research.map((r) => [String(r.game || "").toLowerCase(), r]));

  let changed = 0;
  let skippedPublished = 0;
  let alreadyFine = 0;
  let totalBefore = 0;
  let totalAfter = 0;
  const worst = [];

  for (const set of sets) {
    if (publishedSetIds.has(String(set._id))) {
      skippedPublished++;
      continue;
    }
    const game = categoryFor(set);
    const rewards = rewardsOf(set);
    const current = Number(set.price) || 0;
    const { price: target } = pricing.priceListing({
      evidence: await evidence.evidenceFor({
        game,
        marketplace: "",
        research: researchByGame.get(game.toLowerCase()),
      }),
      itemCount: rewards,
      soldFloorUsd: Number(set.minPriceUsd) || 0,
    });

    if (Math.abs(current - target) < 0.01) {
      alreadyFine++;
      continue;
    }
    totalBefore += current;
    totalAfter += target;
    worst.push({ name: set.name, game, rewards, current, target });
    changed++;
    if (APPLY) {
      await DropSet.updateOne({ _id: set._id }, { $set: { price: target } });
    }
  }

  worst.sort((a, b) => b.current - a.current);
  console.log("\n--- the 20 worst, before -> after ---");
  for (const row of worst.slice(0, 20)) {
    console.log(
      "  $" +
        row.current.toFixed(2).padStart(8) +
        " -> $" +
        row.target.toFixed(2).padStart(6) +
        "  rewards=" +
        String(row.rewards).padStart(3) +
        "  " +
        String(row.name || "").slice(0, 50),
    );
  }

  console.log("\n=== summary ===");
  console.log("  repriced         :", changed, APPLY ? "(written)" : "(would write)");
  console.log("  already correct  :", alreadyFine);
  console.log("  skipped, published:", skippedPublished);
  console.log(
    "  catalogue value  : $" +
      totalBefore.toFixed(2) +
      " -> $" +
      totalAfter.toFixed(2),
  );
  if (!APPLY) console.log("\n  dry run — nothing written. Re-run with --apply.");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("repair failed:", err.message);
  process.exit(1);
});
