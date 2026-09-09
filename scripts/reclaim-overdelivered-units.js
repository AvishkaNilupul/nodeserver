#!/usr/bin/env node
// Take back accounts handed to a buyer by mistake.
//
//   node scripts/reclaim-overdelivered-units.js --order 16474028 --keep bpznq821f
//   node scripts/reclaim-overdelivered-units.js --order 16474028 --keep bpznq821f --apply
//
// PlayerAuctions order 16474028 ("Sea of Thieves Twitch Drops (11 Items)",
// $5.00) shipped ELEVEN accounts. PA reports quantity in the OFFER'S unit —
// `purchased: {amount: 11, suffix: "Ship Skins"}` is eleven ship skins, i.e. ONE
// account holding eleven drops — and the fulfiller read that 11 as a unit count.
// See utils/playerauctionsFulfiller.paQuantity, now fixed and covered by
// tests/paQuantity.test.js. The buyer keeps the one account they paid for; the
// other ten come back.
//
// Reversing the sale means undoing a DROP RESERVATION, not writing fields by
// hand. claimAccountsForSet reserved each account with
//   reserveSetOnAccount(id, set, { soldToUsername: "playerauctions", soldSetId })
// which stamps the per-game DropLog rows and shadows the result onto
// BotAccount.soldAt/soldToUsername. utils/dropReservation.releaseSetForAccounts
// is its exact inverse, narrowed to THIS set and THIS tag, so an account that
// also backs another game's sale keeps that reservation intact.
//
// Then the safety catch. These accounts cannot be resold, and `soldGames` is the
// wrong tool for saying so — autoFarmer.readyPoolQuery spells out why:
//
//   "the buyer holds the login AND password, so farming it again just re-sells
//    an account somebody already owns outright (the soldGames block can't help
//    — the buyer can sign in and take whatever the next campaign farms)"
//
// The marker for that is `manualSold`, whose documented meaning is exactly this
// situation: keep farming, never auto-sell, surface for an operator review. None
// of these eleven has a stored email, so the password can never be rotated and
// the buyer's access is permanent. To let one back into supply deliberately:
//
//   POST /api/noclaim-farm/accounts/<clientSecret>/manual-sold  {"sold": false}
//
// Read-only until --apply.
require("dotenv").config();
const mongoose = require("mongoose");
const MarketplaceListing = require("../models/MarketplaceListing");
const AvailableAccount = require("../models/AvailableAccount");
const BotAccount = require("../models/BotAccount");
const DropSet = require("../models/DropSet");
const { releaseSetForAccounts } = require("../utils/dropReservation");
const { logEvent } = require("../utils/systemLog");

const PA_CLAIM_TAG = "playerauctions";

const has = (n) => process.argv.includes("--" + n);
const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i > 0 ? process.argv[i + 1] : null;
};
const low = (v) => String(v || "").trim().toLowerCase();

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, {});
  const order = String(arg("order") || "").trim();
  const keep = low(arg("keep"));
  if (!order) throw new Error("--order <orderId> is required");

  const row = await MarketplaceListing.findOne({ "units.orderId": order });
  if (!row) throw new Error("no listing carries units for order " + order);

  const mine = (row.units || []).filter((u) => String(u.orderId || "") === order);
  const kept = mine.filter((u) => low(u.login) === keep);
  const back = mine.filter((u) => low(u.login) !== keep);
  if (keep && !kept.length) {
    throw new Error(
      "--keep " + keep + " is not on order " + order + "; refusing to guess which " +
        "account the buyer keeps",
    );
  }
  if (!back.length) throw new Error("nothing to reclaim on order " + order);

  const set = row.set ? await DropSet.findById(row.set).lean() : null;
  console.log(row.marketplace + " " + row.externalId + "  $" + row.price + "  [" + row.status + "]");
  console.log("  " + String(row.title || "").slice(0, 76));
  console.log("  set     " + (set ? set.name : "(none)") + "  (" + ((set && set.items) || []).length + " items)");
  console.log("  order   " + order + "   units on it: " + mine.length);
  console.log("  keeping " + (kept.length ? kept.map((u) => u.login).join(", ") : "(none)"));
  console.log("  reclaim " + back.length + "\n");

  // An account with no id cannot have its reservation released, and releasing
  // the others while silently skipping it would leave a half-reversed sale.
  const ids = [];
  const problems = [];
  for (const u of back) {
    let id = String(u.accountId || "").trim();
    if (!id) {
      const bot = await BotAccount.findOne({ login: u.login }, { _id: 1 }).lean();
      id = bot ? String(bot._id) : "";
    }
    if (!id) problems.push(u.login + ": no BotAccount to release");
    else ids.push(id);
  }

  for (const u of back) {
    const pool = await AvailableAccount.findOne(
      { usernameLower: low(u.login) },
      { status: 1, manualSold: 1, clientSecret: 1, email: 1 },
    ).lean();
    const bot = await BotAccount.findOne(
      { login: u.login },
      { soldAt: 1, soldToUsername: 1, container: 1 },
    ).lean();
    if (!pool) problems.push(u.login + ": no pool row");
    else if (!pool.clientSecret)
      problems.push(u.login + ": no clientSecret, so the manual-sold toggle cannot reach it");
    console.log(
      "  " + String(u.login).padEnd(24) +
        " pool[" + String((pool && pool.status) || "none").padEnd(9) + "]" +
        " manualSold=" + String(!!(pool && pool.manualSold)).padEnd(5) +
        " soldAt=" + ((bot && bot.soldAt) ? new Date(bot.soldAt).toISOString().slice(0, 10) : "-").padEnd(11) +
        " tag=" + JSON.stringify((bot && bot.soldToUsername) || "").padEnd(17) +
        " bot=" + String((bot && bot.container) || "-"),
    );
  }
  if (problems.length) {
    console.log("\n  PROBLEMS:");
    for (const p of problems) console.log("    - " + p);
  }

  if (!has("apply")) {
    console.log("\nDRY RUN — nothing changed. Re-run with --apply.\n");
    await mongoose.disconnect();
    return;
  }
  if (problems.some((p) => /no BotAccount|no pool row/.test(p))) {
    throw new Error("refusing to half-reverse the sale — resolve the problems above first");
  }

  // 1. Release the drop reservations this order took: THIS set, THIS tag only.
  //    clearEmptyShadows() inside then clears BotAccount.soldAt/soldToUsername
  //    for any account left holding no reserved drop at all.
  await releaseSetForAccounts(ids, String(row.set), PA_CLAIM_TAG);
  console.log("\nreleased the set reservation on " + ids.length + " account(s)");

  // 2. Detach the units, so the listing stops counting them as stock it spent.
  const drop = new Set(back.map((u) => low(u.login)));
  row.units = (row.units || []).filter(
    (u) => !(String(u.orderId || "") === order && drop.has(low(u.login))),
  );
  row.markModified("units");
  await row.save();
  console.log("detached " + back.length + " unit(s) from " + row.externalId);

  // 3. The safety catch. The buyer holds these logins and passwords for good.
  let flagged = 0;
  for (const u of back) {
    const res = await AvailableAccount.updateOne(
      { usernameLower: low(u.login) },
      {
        $set: { manualSold: true },
        $push: {
          usageHistory: {
            at: new Date(),
            event: "returned",
            game: (set && (set.items || [])[0] && set.items[0].game) || "",
            actor: "reclaim-overdelivered-units",
            note:
              "over-delivered on " + row.marketplace + " order " + order +
              " and taken back; the buyer still holds this login and password",
          },
        },
      },
    ).catch(() => null);
    if (res && (res.modifiedCount || res.nModified)) flagged += 1;
  }
  console.log("flagged manualSold=true on " + flagged + " pool row(s)");

  await logEvent({
    category: "marketplace",
    action: "overdelivery_reclaimed",
    actor: "reclaim-overdelivered-units",
    severity: "warn",
    subject: order,
    count: back.length,
    detail:
      "reclaimed " + back.length + " account(s) over-delivered on " + row.marketplace +
      " order " + order + " (buyer keeps " + (kept[0] ? kept[0].login : "none") +
      "); set reservation released and manualSold set — the buyer still holds " +
      "these logins, and none has a stored email so no password can be rotated",
  }).catch(() => {});

  console.log(
    "\nDone. The ten are off the order and no longer written off as sold.\n" +
      "They keep farming; they will NOT be auto-listed or auto-sold.\n",
  );
  await mongoose.disconnect();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
