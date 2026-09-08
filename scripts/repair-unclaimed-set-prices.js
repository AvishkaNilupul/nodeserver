#!/usr/bin/env node
// Recompute every unclaimed-farm DropSet price with the CURRENT pricer.
//
//   node scripts/repair-unclaimed-set-prices.js            # dry run (default)
//   node scripts/repair-unclaimed-set-prices.js --apply    # write DropSet.price
//   node scripts/repair-unclaimed-set-prices.js --apply --over-ceiling-only
//   node scripts/repair-unclaimed-set-prices.js --allow-raise    # also raise
//
// Why this exists: `DropSet.price` is written ONCE, at publish time, by
// utils/unclaimedBundles.bundlePrice. Every later listing of that set — and the
// Gameflip relist chain in particular — reuses the stored number. So when the
// pricer is corrected, the sets priced by the OLD pricer keep their old price
// forever and quietly re-publish it.
//
// That is what happened on 2026-09-08. bundlePrice had floors and no ceiling,
// and anchored on `gameflip.avgSoldPrice` — an average over rival Gameflip rows
// that include "SI 2026 Doc Bundle Code | 5 Items" at $9.99 and a 15-item
// Dokkaebi bundle at $29.99. Those are redeem CODES, not farmed accounts. The
// anchor came out at $8.08, the 4-item multiplier took it to $11.75, and the
// engine published that on Gameflip, Digiseller and GGSel — in a business whose
// highest realised sale ever, across 217 sales, is $4.50.
//
// This only touches DropSet.price (a DB field). It never contacts a
// marketplace: pushing a corrected price onto a LIVE row is
// `repriceUnclaimedRows` (utils/unclaimedAutoList.js), gated by the owner's
// `unclaimedRepriceExisting` flag. Run this first, that second.
require("dotenv").config();
const mongoose = require("mongoose");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const MarketResearch = require("../models/MarketResearch");
const bundles = require("../utils/unclaimedBundles");
const settings = require("../utils/settings");

const has = (n) => process.argv.includes("--" + n);

function gameOfSet(set) {
  const items = set.items || [];
  for (const i of items) if (i && i.game) return String(i.game);
  // Set names are built as "<Game> Twitch Drops — …" by the bundle titler.
  const m = String(set.name || "").match(/^(.+?)\s+Twitch\s+(?:Drops?|bundle)/i);
  return m ? m[1].trim() : "";
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, {});
  const pricing = settings.getUnclaimedPricing();
  const ceiling = pricing.ceilingUsd;
  console.log("current ceiling: $" + ceiling + "   floor: $" + pricing.floorUsd + "\n");

  const q = { sourceType: /unclaimed/ };
  if (has("over-ceiling-only")) q.price = { $gt: ceiling };
  const sets = await DropSet.find(q).lean();
  console.log("unclaimed sets examined: " + sets.length + "\n");

  const researchCache = new Map();
  const plan = [];
  const raises = [];
  for (const set of sets) {
    const game = gameOfSet(set);
    if (!researchCache.has(game)) {
      researchCache.set(
        game,
        await MarketResearch.findOne({ game }).lean().catch(() => null),
      );
    }
    // soldFloorUsd is deliberately NOT passed: this repair is about the pricer's
    // own ceiling, and a set that genuinely sold higher keeps that price through
    // repriceUnclaimedRows, which does read the sold floor.
    const out = bundles.bundlePrice({
      research: researchCache.get(game),
      game,
      items: set.items,
      pricing,
    });
    const from = Number(set.price) || 0;
    if (Math.abs(from - out.price) < 0.01) continue;
    // LOWER ONLY by default. This is a repair for a pricer that was producing
    // numbers above anything the business has ever been paid; raising a price
    // the owner already chose is a different decision entirely, and doing it as
    // a side effect of a repair is how a "fix" becomes a surprise. Measured
    // 2026-09-08, recomputing everything would have lifted Marvel Rivals from
    // $0.75 to $4.50 off the back of a polluted rival average.
    if (out.price > from && !has("allow-raise")) {
      raises.push({ set, from, to: out.price });
      continue;
    }
    plan.push({ set, game, from, to: out.price, out });
  }

  plan.sort((a, b) => b.from - a.from);
  console.log("sets whose price would change: " + plan.length + "\n");
  let liveTotal = 0;
  for (const p of plan) {
    const live = await MarketplaceListing.countDocuments({
      set: p.set._id,
      status: "active",
      autoPaused: { $ne: true },
    });
    liveTotal += live;
    console.log(
      "  $" + String(p.from).padEnd(7) + "-> $" + String(p.to).padEnd(7) +
        (p.out.ceilingHit ? "[ceiling] " : "          ") +
        live + " live row(s)  " + String(p.set.name || "").slice(0, 62),
    );
    console.log(
      "        anchor $" + p.out.anchor + " from " + p.out.anchorSource +
        ", " + p.out.totalQty + " item(s)",
    );
  }
  console.log("\nlive listings affected: " + liveTotal);
  if (raises.length) {
    console.log(
      "\nNOT raised (" + raises.length + " set(s)) — pass --allow-raise to include them:",
    );
    for (const r of raises) {
      console.log(
        "  $" + String(r.from).padEnd(7) + "-> $" + String(r.to).padEnd(7) +
          String(r.set.name || "").slice(0, 62),
      );
    }
  }

  if (!has("apply")) {
    console.log(
      "\nDRY RUN — nothing written. Re-run with --apply to update DropSet.price.\n" +
        "Live marketplace prices are NOT changed by this script; that is\n" +
        "repriceUnclaimedRows (flag unclaimedRepriceExisting).\n",
    );
  } else {
    let n = 0;
    for (const p of plan) {
      await DropSet.updateOne(
        { _id: p.set._id },
        { $set: { price: p.to, minPriceUsd: p.out.floor } },
      );
      n += 1;
    }
    console.log("\nUPDATED " + n + " DropSet price(s). Live rows still carry their old price.\n");
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
