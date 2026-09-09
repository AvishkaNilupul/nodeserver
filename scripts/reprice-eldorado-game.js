#!/usr/bin/env node
// Reprice every LIVE Eldorado Twitch-drops listing for one game.
//
//   node scripts/reprice-eldorado-game.js --game Overwatch --price 1
//   node scripts/reprice-eldorado-game.js --game Overwatch --price 1 --apply
//
// Operator-instructed, not automatic. utils/autoLister only reprices rows whose
// `origin` is "auto" (feedback_manual_listings_never_repriced) and these are
// hand-made rows, so nothing else here would ever touch them.
//
// EVERY WRITE IS READ BACK. Eldorado's reprice endpoint returns the amount it
// was SENT, not the amount it stored, so trusting the return value proves
// nothing — and this codebase has already been bitten by exactly that shape on
// two other marketplaces (ZeusX 500s on updates it APPLIED, GGSel 504s on ones
// it did NOT; see project_live_reprice_tool). The offer is re-read afterwards
// and the run refuses to update our own row unless Eldorado agrees.
//
// Rent-farm offers ("Automatic Farming") are never touched: they sell a WINDOW,
// not drops, and their price ladder is a different product.
//
// Read-only until --apply.
require("dotenv").config();
const mongoose = require("mongoose");
const MarketplaceListing = require("../models/MarketplaceListing");
const mp = require("../utils/marketplaces");
const { logEvent } = require("../utils/systemLog");

const has = (n) => process.argv.includes("--" + n);
const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i > 0 ? process.argv[i + 1] : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, {});
  const game = String(arg("game") || "").trim();
  const price = Number(arg("price"));
  if (!game) throw new Error("--game is required");
  if (!Number.isFinite(price) || price <= 0) throw new Error("--price must be a positive number");

  const esc = game.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rows = await MarketplaceListing.find(
    { marketplace: "eldorado", status: "active", title: new RegExp("^" + esc + "\\b", "i") },
    { externalId: 1, title: 1, price: 1, origin: 1, unclaimedGame: 1 },
  ).lean();
  const targets = rows.filter((r) => !/Automatic\s+Farming/i.test(r.title || ""));

  console.log("game    " + game);
  console.log("target  $" + price.toFixed(2));
  console.log("matched " + targets.length + " live drops listing(s)" +
    (rows.length - targets.length ? "  (skipping " + (rows.length - targets.length) + " rent-farm offer(s))" : "") + "\n");
  if (!targets.length) {
    console.log("Nothing to do.\n");
    await mongoose.disconnect();
    return;
  }

  for (const r of targets) {
    const delta = price - (Number(r.price) || 0);
    console.log(
      "  " + String(r.externalId).slice(0, 12) + "  $" + String(r.price).padEnd(7) +
        " -> $" + price.toFixed(2) +
        "  (" + (delta >= 0 ? "+" : "") + delta.toFixed(2) + ")  " +
        String(r.title || "").slice(0, 52),
    );
  }

  if (!has("apply")) {
    console.log("\nDRY RUN — nothing changed. Re-run with --apply.\n");
    await mongoose.disconnect();
    return;
  }

  let done = 0;
  const failed = [];
  for (const r of targets) {
    const before = Number(r.price) || 0;
    try {
      await mp.eldoradoReprice(r.externalId, price);
    } catch (e) {
      failed.push(r.externalId + ": send failed — " + e.message);
      continue;
    }
    await sleep(400);
    // READ BACK. The only evidence that counts.
    const live = await mp.eldoradoOffer(r.externalId).catch(() => null);
    const now = live && live.pricePerUnit ? Number(live.pricePerUnit.amount) : null;
    if (now === null) {
      failed.push(r.externalId + ": repriced but could not be read back — DB left alone");
      continue;
    }
    if (Math.abs(now - price) > 0.005) {
      failed.push(
        r.externalId + ": Eldorado still shows $" + now + " after the write — DB left alone",
      );
      continue;
    }
    await MarketplaceListing.updateOne(
      { _id: r._id },
      { $set: { price: price } },
    ).catch(() => null);
    done += 1;
    console.log("  ✓ " + String(r.externalId).slice(0, 12) + "  Eldorado confirms $" + now.toFixed(2) +
      "  (was $" + before.toFixed(2) + ")");
  }

  if (failed.length) {
    console.log("\n  NOT APPLIED (" + failed.length + "):");
    for (const f of failed) console.log("    - " + f);
  }
  console.log("\nrepriced " + done + " of " + targets.length + " listing(s)");

  await logEvent({
    category: "marketplace",
    action: "listing_repriced",
    actor: "reprice-eldorado-game",
    severity: "info",
    subject: "eldorado",
    game,
    count: done,
    detail:
      "operator-instructed reprice of " + done + " eldorado " + game +
      " drops listing(s) to $" + price.toFixed(2) +
      "; previous prices " + targets.map((t) => "$" + t.price).join(", ") +
      (failed.length ? "; " + failed.length + " NOT applied" : ""),
  }).catch(() => {});

  await mongoose.disconnect();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
