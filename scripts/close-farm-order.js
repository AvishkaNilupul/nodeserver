#!/usr/bin/env node
// Close a rent-farm order the buyer walked away from, and give its accounts back.
//
//   node scripts/close-farm-order.js --list
//   node scripts/close-farm-order.js --order e69b19d3-9204-435f-8180-08df0d9accff
//   node scripts/close-farm-order.js --order <id> --reason "buyer cancelled" --apply
//
// `FarmServiceOrder.state` has carried "cancelled" since the model was written,
// with a comment explaining exactly why it exists:
//
//   "cancelled" is the buyer walking away, and it is NOT the same as "failed".
//   A failed order is still owed and must keep alerting; a cancelled one is
//   closed and must stop, or the health check cries wolf forever over an order
//   nobody is waiting for.
//
// And no code has ever written it. Not a route, not a fulfiller, not a farm
// service, not a script — the string appears only in the enum and in the health
// check's exclusion. So a genuinely closed order keeps `orders.undelivered`
// critical and keeps farmServiceAlert paging every tenth attempt, forever.
// Eldorado order e69b19d3 (Black Desert, 1 Year) failed 25 times before the
// buyer cancelled, and had to be set by hand.
//
// WHY THIS IS A SCRIPT AND NOT AN AUTOMATIC SWEEP
//
// The obvious automation is "if the order is no longer in the marketplace's
// pending list, close it". It is a trap. That list is also empty when the API
// call fails, when the session has lapsed, and when rate limiting truncates a
// page — and this codebase has already shipped exactly that false negative once
// (a reconciler that reported "0 sold" while it was being rate limited). A
// wrong close here does not cry wolf: it ABANDONS A PAID ORDER, stops the
// retries, and tells nobody. That is strictly worse than the alarm it would
// silence, so closing stays a decision a human makes with the marketplace open
// in front of them.
//
// Read-only until --apply.
require("dotenv").config();
const mongoose = require("mongoose");
const FarmServiceOrder = require("../models/FarmServiceOrder");
const { logEvent } = require("../utils/systemLog");

const OPEN = ["claimed", "provisioned", "sent", "failed"];

const has = (n) => process.argv.includes("--" + n);
const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i > 0 ? process.argv[i + 1] : null;
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, {});

  if (has("list") || !arg("order")) {
    const rows = await FarmServiceOrder.find(
      { state: { $in: OPEN } },
      { orderId: 1, market: 1, game: 1, days: 1, quantity: 1, accounts: 1, state: 1, attempts: 1, lastError: 1, createdAt: 1 },
    )
      .sort({ createdAt: 1 })
      .limit(100)
      .lean();
    console.log("open rent-farm orders (" + rows.length + "):\n");
    for (const r of rows) {
      console.log(
        "  " + new Date(r.createdAt).toISOString().slice(0, 16) + "  " +
          String(r.market).padEnd(15) + String(r.orderId).padEnd(42) +
          " [" + r.state + "]" + " tries=" + r.attempts +
          " accts=" + (r.accounts || []).length + "/" + r.quantity,
      );
      if (r.lastError) console.log("       " + String(r.lastError).slice(0, 110));
    }
    if (!rows.length) console.log("  (none — nothing is stuck)");
    console.log("\nClose one with:  --order <orderId> --reason \"...\" --apply\n");
    await mongoose.disconnect();
    return;
  }

  const wanted = String(arg("order")).trim();
  // Accept either the raw marketplace id or the namespaced key ("pa:16474028").
  const row = await FarmServiceOrder.findOne({
    $or: [{ orderId: wanted }, { orderId: new RegExp(":" + wanted + "$") }],
  });
  if (!row) throw new Error("no FarmServiceOrder for " + wanted);

  console.log(row.market + "  " + row.orderId);
  console.log("  " + String(row.offerTitle || "").slice(0, 76));
  console.log("  " + row.game + " / " + row.days + "d / qty " + row.quantity);
  console.log("  state=" + row.state + "  attempts=" + row.attempts);
  console.log("  accounts (" + (row.accounts || []).length + "): " +
    ((row.accounts || []).map((a) => a.login).join(", ") || "none"));
  if (row.lastError) console.log("  lastError: " + String(row.lastError).slice(0, 200));

  if (row.state === "delivered") {
    console.log("\nThis order was DELIVERED. Refusing to reopen a completed sale.\n");
    await mongoose.disconnect();
    return;
  }
  if (row.state === "cancelled") {
    console.log("\nAlready cancelled — nothing to do.\n");
    await mongoose.disconnect();
    return;
  }

  // The accounts are the reason this matters beyond the alarm. They are pinned
  // to a bot with a farmUntil window for a buyer who is gone.
  if ((row.accounts || []).length) {
    console.log(
      "\n  ⚠ This order holds " + row.accounts.length + " provisioned account(s).\n" +
        "    Closing it does NOT return them to the pool — nothing in this codebase\n" +
        "    does that yet, and unpinning an account from a bot config is a live\n" +
        "    host write that must not happen from a bookkeeping script. Note them\n" +
        "    and free them from the Renters page:\n" +
        row.accounts.map((a) => "      " + a.login).join("\n"),
    );
  }

  if (!has("apply")) {
    console.log("\nDRY RUN — nothing changed. Re-run with --apply.\n");
    await mongoose.disconnect();
    return;
  }

  const reason = String(arg("reason") || "closed by the operator").slice(0, 300);
  const was = row.state;
  row.state = "cancelled";
  row.lastError = reason;
  await row.save();
  console.log("\n" + row.orderId + ": " + was + " -> cancelled");

  await logEvent({
    category: "marketplace",
    action: "farm_order_cancelled",
    actor: "close-farm-order",
    severity: "warn",
    subject: row.orderId,
    game: row.game,
    count: (row.accounts || []).length,
    detail:
      row.market + " rent-farm order closed (was " + was + " after " + row.attempts +
      " attempts): " + reason,
  }).catch(() => {});

  console.log("It will stop alerting and stop counting as undelivered.\n");
  await mongoose.disconnect();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
