#!/usr/bin/env node
// Read-only: which auto-farm EVENTS could be sold as one bundle right now, and
// what would each be titled, backed by and priced at?
//
//   node scripts/autofarm-bundle-plan.js                       # every game
//   node scripts/autofarm-bundle-plan.js --game="Overwatch 2"
//   node scripts/autofarm-bundle-plan.js --verbose             # + item lists
//   node scripts/autofarm-bundle-plan.js --no-stock            # skip holder counts (fast)
//
// Writes NOTHING — no DropSet, no listing, no settings. This is the evidence
// pass to run before trusting the sweep (docs/AUTOFARM-BUNDLES-CONTRACT.md).
require("dotenv").config();
const mongoose = require("mongoose");

const bundles = require("../utils/autoFarmBundles");

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const NO_STOCK = args.includes("--no-stock");
const ONLY_GAME =
  (args.find((a) => a.startsWith("--game=")) || "")
    .split("=")
    .slice(1)
    .join("=") || "";

function usd(n) {
  return "$" + (Math.round(Number(n) * 100) / 100).toFixed(2);
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const AutoFarmTask = require("../models/AutoFarmTask");
  const MarketResearch = require("../models/MarketResearch");
  const autoLister = require("../utils/autoLister");

  const games = ONLY_GAME
    ? [ONLY_GAME]
    : (
        await AutoFarmTask.distinct("game", {
          status: { $in: [...bundles.STOCK_STATUSES] },
        })
      ).filter(Boolean);

  console.log(
    "Auto-farm event bundles — " +
      games.length +
      " game(s) with farmed stock\n" +
      "=".repeat(72),
  );

  let totalPlans = 0;
  let sellable = 0;
  let alreadyLive = 0;

  for (const game of games.sort()) {
    let plans = [];
    try {
      plans = await bundles.plansForGame(game);
    } catch (err) {
      console.log("\n" + game + "\n  ! plan failed: " + err.message);
      continue;
    }
    if (!plans.length) continue;
    totalPlans += plans.length;

    const research = await MarketResearch.findOne({ game }).lean();
    console.log("\n" + game);
    for (const plan of plans) {
      const live = await bundles.liveBundleForEvent(plan.key);
      const soldFloorUsd = await bundles.soldFloorForEvent(plan.key);
      const priced = await bundles.priceBundle({
        plan,
        game,
        marketplace: "gameflip",
        research,
        soldFloorUsd,
      });

      // The same gate the publisher uses: accounts that provably hold every
      // item at the promised copy count and are not already on a live listing.
      let holders = null;
      if (!NO_STOCK) {
        try {
          holders = (
            await autoLister.pickDeliveryAccounts(
              { assignedAccounts: plan.logins },
              plan.logins.length,
              plan.items,
            )
          ).length;
        } catch (err) {
          holders = "err:" + err.message;
        }
      }

      const state = live
        ? "LIVE (" + live.marketplace + " " + live.externalId + ")"
        : holders === null
          ? "plan only"
          : holders > 0
            ? "READY " + holders + " account(s)"
            : "waiting — no free holder";
      if (live) alreadyLive += 1;
      else if (typeof holders === "number" && holders > 0) sellable += 1;

      console.log(
        "  " +
          (plan.full ? "[COMPLETE]" : "[partial ]") +
          " " +
          plan.eventName +
          "  " +
          plan.wavesHeld +
          "/" +
          plan.wavesTotal +
          " waves · " +
          plan.items.length +
          " items (" +
          plan.totalQty +
          " copies) · " +
          plan.logins.length +
          " assigned",
      );
      console.log(
        "      waves : " + (plan.labels.join(" + ") || "(unlabelled)"),
      );
      console.log("      title : " + bundles.bundleTitleFor(plan));
      console.log(
        "      price : " +
          (priced ? usd(priced.price) : "engine unavailable") +
          (priced
            ? "  [" +
              priced.basis +
              (priced.samples ? " n=" + priced.samples : "") +
              (priced.fullEvent ? " +full-event" : "") +
              (priced.clamped ? " clamped:" + priced.clamped : "") +
              "]"
            : "") +
          (soldFloorUsd ? "  sold-floor " + usd(soldFloorUsd) : ""),
      );
      console.log("      state : " + state);
      if (plan.wavesUnresolved) {
        console.log(
          "      note  : " +
            plan.wavesUnresolved +
            " farmed wave(s) have unknown contents — excluded, and the bundle " +
            "cannot claim to be complete",
        );
      }
      if (VERBOSE) {
        for (const item of plan.items) {
          console.log(
            "        - " + (item.qty > 1 ? item.qty + "× " : "") + item.name,
          );
        }
      }
    }
  }

  console.log(
    "\n" +
      "=".repeat(72) +
      "\n" +
      totalPlans +
      " event bundle(s) found · " +
      sellable +
      " ready to publish · " +
      alreadyLive +
      " already live\nNothing was written.",
  );
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
