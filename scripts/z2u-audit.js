#!/usr/bin/env node
// What is actually for sale on Z2U right now, and what it would take to fix.
//
//   node scripts/z2u-audit.js            # the whole shelf
//   node scripts/z2u-audit.js --orders   # + every sold order, not just pending
//   node scripts/z2u-audit.js --plan     # + exactly what the shelf keeper would do
//
// Read-only: it never changes an offer. Run it before turning the shelf keeper
// loose, and after, to see what moved.
//
// Z2U offers expire on a duration (7/14/30 days) and the site pulls them off
// sale without telling you, so "how many of my offers are actually visible" is
// a question the seller panel makes surprisingly hard to answer — it shows one
// game at a time. This answers it in one shot.
require("dotenv").config();
const mongoose = require("mongoose");

const mp = require("../utils/marketplaces");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

function bar(n, total, width = 22) {
  if (!total) return "";
  const on = Math.round((n / total) * width);
  return "#".repeat(on) + ".".repeat(width - on);
}

async function main() {
  if (!(mp.keyStatus().z2u || {}).configured) {
    console.error(
      "Z2U is not configured. Paste the Cookie header from a signed-in\n" +
        "z2u.com session under Listings -> Marketplace keys -> Z2U.",
    );
    process.exit(1);
  }
  const probe = await mp.z2uTest();
  console.log(probe.ok ? "z2u: " + probe.detail : "z2u: " + probe.detail);
  if (!probe.ok) process.exit(1);

  // The DB half is optional: without it the shelf still reports, it just
  // cannot say what is really claimable behind each offer.
  let ful = null;
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (uri) {
    try {
      await mongoose.connect(uri);
      ful = require("../utils/z2uFulfiller");
    } catch (e) {
      console.log("(no database — stock column omitted: " + e.message + ")");
    }
  }

  const entries = ful
    ? await ful.shelf()
    : (await mp.z2uAllOffers()).map((offer) => ({
        offer,
        row: null,
        linked: false,
        realStock: null,
        daysLeft: null,
      }));

  // ---- per game ----
  const games = new Map();
  for (const e of entries) {
    const k = e.offer.groupLabel || e.offer.game;
    if (!games.has(k)) games.set(k, []);
    games.get(k).push(e);
  }
  console.log("\n" + "GAME".padEnd(34) + "LIVE  DARK  EMPTY  UNLINKED");
  let live = 0;
  let dark = 0;
  let darkWithStock = 0;
  for (const [game, list] of [...games.entries()].sort()) {
    const on = list.filter((e) => e.offer.online).length;
    const off = list.length - on;
    const empty = list.filter((e) => (e.offer.stock || 0) === 0).length;
    const unlinked = list.filter((e) => !e.linked).length;
    live += on;
    dark += off;
    darkWithStock += list.filter((e) => !e.offer.online && e.offer.stock > 0).length;
    console.log(
      String(game).slice(0, 33).padEnd(34) +
        String(on).padStart(4) +
        String(off).padStart(6) +
        String(empty).padStart(7) +
        String(unlinked).padStart(10) +
        (off ? "   <-- " + bar(on, list.length, 10) : ""),
    );
  }
  console.log(
    "\n" +
      entries.length +
      " offers: " +
      live +
      " on sale, " +
      dark +
      " off sale (" +
      darkWithStock +
      " of those still hold stock).",
  );

  // ---- expiring ----
  const soon = entries
    .filter((e) => e.offer.online && e.daysLeft != null && e.daysLeft <= 7)
    .sort((a, b) => a.daysLeft - b.daysLeft);
  if (soon.length) {
    console.log("\nEXPIRING WITHIN 7 DAYS (Z2U pulls these off sale silently):");
    for (const e of soon) {
      console.log(
        "  " +
          String(e.daysLeft + "d").padStart(4) +
          "  $" +
          String(e.offer.price).padEnd(6) +
          "x" +
          String(e.offer.stock).padEnd(4) +
          " " +
          e.offer.title.slice(0, 60),
      );
    }
  }

  // ---- stock disagreements ----
  const wrong = entries.filter(
    (e) => e.realStock != null && e.realStock !== e.offer.stock,
  );
  if (wrong.length) {
    console.log("\nADVERTISED STOCK != CLAIMABLE STOCK:");
    for (const e of wrong.slice(0, 25)) {
      console.log(
        "  " +
          String(e.offer.stock).padStart(4) +
          " -> " +
          String(e.realStock).padEnd(5) +
          " " +
          e.offer.title.slice(0, 60),
      );
    }
    const over = wrong.filter((e) => e.realStock < e.offer.stock).length;
    console.log(
      "  (" + over + " of " + wrong.length + " advertise MORE than we can ship)",
    );
  }

  const unlinked = entries.filter((e) => !e.linked);
  if (unlinked.length) {
    console.log(
      "\n" +
        unlinked.length +
        " offer(s) are not linked to any listing row, so nothing can verify\n" +
        "their stock or deliver them automatically. Link them with:\n" +
        "  node scripts/z2u-adopt.js",
    );
  }

  if (has("--plan") && ful) {
    console.log("\nWHAT THE SHELF KEEPER WOULD DO (dry run):");
    const plan = await ful.keepShelfAlive({ dryRun: true });
    const acts = plan.filter((p) => p.action);
    if (!acts.length) console.log("  nothing — the shelf is already correct.");
    for (const a of acts) {
      console.log("  " + a.action.padEnd(12) + a.pk.padEnd(10) + a.why + "  |  " + String(a.title).slice(0, 44));
    }
  }

  // ---- orders ----
  const pending = await mp.z2uOrders("WAIT_DELIVERY");
  console.log("\nORDERS AWAITING DELIVERY: " + pending.length);
  for (const o of pending) {
    console.log(
      "  " + o.orderId + "  " + o.date + "  " + o.currency + o.amount + "  " + o.title.slice(0, 50),
    );
  }
  if (has("--orders")) {
    const all = await mp.z2uAllOrders("ALL", { maxPages: 6 });
    console.log("\nALL ORDERS (" + all.length + "):");
    for (const o of all) {
      console.log(
        "  " +
          o.date.slice(0, 10) +
          "  " +
          o.orderId +
          "  " +
          (o.state || "-").padEnd(13) +
          o.currency +
          String(o.amount).padEnd(6) +
          o.title.slice(0, 46),
      );
    }
  }
  if (mongoose.connection.readyState) await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
