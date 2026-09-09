#!/usr/bin/env node
// Put a paused Eldorado offer back on sale — but only if we can actually fill it.
//
//   node scripts/relist-eldorado-offer.js --offer <id>
//   node scripts/relist-eldorado-offer.js --offer <id> --apply
//
// Found during the 2026-09-09 Eldorado audit: two offers were sitting Paused
// with real, deliverable stock behind them — Rainbow Six (4 Items) $1.00 with 10
// accounts, and Overwatch (3 Items) $0.75 with 8. Neither had any audit row
// explaining the pause, and our own rows still read `status: "active"`, so
// nothing had ever noticed they were off sale. They were simply making no money.
//
// THE STOCK GATE IS THE POINT. Resuming an offer we cannot fill is strictly
// worse than leaving it paused: it takes money and starts the delivery guarantee
// running on an order nobody can ship — which is how order e69b19d3 was lost.
// So this refuses unless the SAME stock query the delivery path uses comes back
// with at least one deliverable account.
//
// Read-only until --apply, and every write is read back.
require("dotenv").config();
const mongoose = require("mongoose");
const MarketplaceListing = require("../models/MarketplaceListing");
const DropSet = require("../models/DropSet");
const mp = require("../utils/marketplaces");
const eld = require("../utils/eldoradoFulfiller");
const { logEvent } = require("../utils/systemLog");

const has = (n) => process.argv.includes("--" + n);
const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i > 0 ? process.argv[i + 1] : null;
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, {});
  const id = String(arg("offer") || "").trim();
  if (!id) throw new Error("--offer <externalId> is required");

  const row = await MarketplaceListing.findOne({ marketplace: "eldorado", externalId: id });
  if (!row) throw new Error("no eldorado listing row for " + id);

  const live = await mp.eldoradoOffer(id);
  console.log(String(row.title || "").slice(0, 72));
  console.log("  our status  " + row.status + "   $" + row.price);
  console.log("  eldorado    " + live.offerState + "   qty " + live.quantity +
    "   $" + (live.pricePerUnit && live.pricePerUnit.amount) +
    "   expires " + live.expireDate);

  if (live.offerState === "Active") {
    console.log("\n  Already Active on Eldorado — only our row was stale.");
    if (has("apply") && row.status !== "active") {
      row.status = "active";
      await row.save();
      console.log("  row corrected to active.");
    }
    await mongoose.disconnect();
    return;
  }

  // The stock gate: exactly what the delivery path would ask.
  const { availableAccountsForSet } = require("../routes/shopRoutes");
  const { loginsOnActiveListings, notListed } = require("../utils/listedLogins");
  let stock = 0;
  let how = "";
  if (row.unclaimedGame) {
    how = "no-claim ledger (" + row.unclaimedGame + ")";
    stock = (
      await eld.claimUnclaimedForGame(row.unclaimedGame, 20, {
        dryRun: true,
        offerId: row.externalId,
        requiredDrops: row.requiredDrops,
      }).catch(() => [])
    ).length;
  } else if (row.set) {
    how = "drop archive";
    const set = await DropSet.findById(row.set).lean();
    if (set) {
      stock = notListed(
        await availableAccountsForSet(set).catch(() => []),
        await loginsOnActiveListings(),
      ).length;
    }
  } else {
    how = "no set and no unclaimedGame";
  }
  const reserved = (row.units || []).filter((u) => !u.deliveredAt).length;
  console.log("  deliverable " + (stock + reserved) + "  (" + how +
    (reserved ? ", +" + reserved + " reserved" : "") + ")");

  if (stock + reserved < 1) {
    console.log(
      "\n  REFUSING. Nothing can fill this offer, so resuming it would take money\n" +
        "  for something we cannot ship. Leave it paused until it has stock.\n",
    );
    await mongoose.disconnect();
    return;
  }

  if (!has("apply")) {
    console.log("\nDRY RUN — nothing changed. Re-run with --apply.\n");
    await mongoose.disconnect();
    return;
  }

  await mp.eldoradoRelist(id);
  await new Promise((r) => setTimeout(r, 800));
  const after = await mp.eldoradoOffer(id).catch(() => null);
  if (!after || after.offerState !== "Active") {
    console.log(
      "\n  Eldorado still reports " + (after ? after.offerState : "unreadable") +
        " after the resume — our row is left alone rather than claiming a state\n" +
        "  the marketplace does not agree with.\n",
    );
    await mongoose.disconnect();
    return;
  }
  row.status = "active";
  row.lastError = "";
  await row.save();
  console.log("\n  ✓ Eldorado confirms Active (qty " + after.quantity + "). Row set to active.");

  await logEvent({
    category: "marketplace",
    action: "listing_relisted",
    actor: "relist-eldorado-offer",
    severity: "info",
    subject: id,
    count: stock + reserved,
    detail:
      "resumed paused eldorado offer " + String(row.title || "").slice(0, 80) +
      " at $" + row.price + " with " + (stock + reserved) + " deliverable account(s)",
  }).catch(() => {});

  await mongoose.disconnect();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
