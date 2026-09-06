#!/usr/bin/env node
// Publish the "Twitch Drops Automatic Farming" service listings on Eldorado —
// one offer per game per term (120 / 180 / 365 days).
//
// The description template carries TWO variables that must always agree with the
// title and the price: the game name and the term in days. Getting that wrong is
// not cosmetic — a live R6 listing sold a 180-day term while its description
// promised 120, which is a dispute waiting to happen. This script derives both
// from the same tier object so they cannot drift.
//
//   node scripts/eldorado-farm-listings.js                  # dry run, default set
//   node scripts/eldorado-farm-listings.js --apply
//   node scripts/eldorado-farm-listings.js --games="Apex Legends,Rust" --apply
//   node scripts/eldorado-farm-listings.js --all --min-tasks=1 --apply
//
// Idempotent: an offer whose title already exists on the account is skipped, so
// re-running only fills gaps.
require("dotenv").config();
const fsp = require("fs/promises");
const mongoose = require("mongoose");

const mp = require("../utils/marketplaces");
const { buildPromoCoverImage } = require("../utils/setImage");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const hit = args.find((a) => a.startsWith(f + "="));
  return hit ? hit.slice(f.length + 1) : d;
};

const APPLY = has("--apply");
const STOCK = parseInt(val("--stock", "1000"), 10) || 1000;
const MIN_TASKS = parseInt(val("--min-tasks", "3"), 10) || 3;
const DAYS_BACK = parseInt(val("--days-back", "90"), 10) || 90;
const LIMIT = parseInt(val("--limit", "0"), 10) || 0;
const DELAY_MS = parseInt(val("--delay", "2500"), 10) || 2500;

// Terms and their prices. Title term and description term both come from here.
const TIERS = [
  { days: 120, label: "120 Days", price: 3 },
  { days: 180, label: "180 Days", price: 4 },
  { days: 365, label: "1 Year", price: 7 },
];

// Twitch-native stream gimmicks and non-games: farmable, but nobody buys a
// "farming service" for them and they make the shop look padded.
const DENY =
  /marbles on stream|hunt club on stream|special events|coin pusher|coin cascade|marble racing|zevent|^test|drops? test/i;

const BULLETS = [
  "Fully Automated Farming",
  "Account-Safe and Undetectable",
  "Reliable Daily Rewards",
];

function title(game, tier) {
  return (game + " Twitch Drops Automatic Farming " + tier.label).slice(0, 160);
}

// The house template, with the game and the term substituted from one place.
function description(game, tier) {
  return `Automatic Farm on our Twitch for the game ${game}

Activation & Timing: After purchasing, link the received account to your own and start receiving new Drops every day 15 hours during GMT. Farming begins the moment you purchase the account. Time counting starts from the moment the account is transferred.

Manual Pickup: If our program does not activate any of the items, you can pick up the items manually on the inventory page.

Bot Guarantee: We guarantee that you will receive an automatic farm account, and all events during this period will be automatically collected by our bot within the specified period [${tier.days} days].

Account Status: The account provided to you may already include some items on the account Twitch.

Exclusivity: Each Twitch is transferred strictly to one buyer.

Important Warning: Do not change any data on the account you received, otherwise the automatic farm will stop working, and in this case you will not receive a refund.

Event Restrictions: Items are guaranteed for events that last at least 24 hours. If the event lasts less than that, we don't guarantee receipt. Farming also only occurs if there are active events.`;
}

async function gameDropImages(game, limit) {
  const DropLog = require("../models/DropLog");
  const re = new RegExp(
    "^" + String(game).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
    "i",
  );
  const rows = await DropLog.aggregate([
    { $match: { game: re, imageLocal: { $ne: "" } } },
    { $group: { _id: "$imageLocal", accounts: { $sum: 1 } } },
    { $sort: { accounts: -1 } },
    { $limit: Math.max(1, Math.min(60, limit || 30)) },
  ]);
  return rows.map((r) => r._id).filter(Boolean);
}

async function farmedGames() {
  const AutoFarmTask = require("../models/AutoFarmTask");
  const since = new Date(Date.now() - DAYS_BACK * 24 * 3600e3);
  const rows = await AutoFarmTask.aggregate([
    { $match: { updatedAt: { $gte: since } } },
    { $group: { _id: "$game", n: { $sum: 1 } } },
    { $match: { n: { $gte: MIN_TASKS } } },
    { $sort: { n: -1 } },
  ]);
  return rows.map((r) => r._id).filter((g) => g && !DENY.test(g));
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

  let games = String(val("--games", "") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!games.length) games = await farmedGames();
  if (LIMIT) games = games.slice(0, LIMIT);

  // Existing titles on the account — this is what makes re-runs safe.
  const existing = new Set();
  for (let page = 1; page <= 20; page++) {
    const r = await mp.eldoradoMyListings(page, 50);
    const results = (r && r.results) || [];
    for (const x of results) {
      const o = x.offer || x;
      if (o && o.offerTitle) existing.add(o.offerTitle.trim().toLowerCase());
    }
    if (!results.length || page >= (r.totalPages || 1)) break;
  }

  const plan = [];
  for (const g of games) {
    for (const t of TIERS) {
      const ti = title(g, t);
      plan.push({
        game: g,
        tier: t,
        title: ti,
        skip: existing.has(ti.trim().toLowerCase()),
      });
    }
  }
  const todo = plan.filter((p) => !p.skip);
  console.log(
    `games=${games.length}  tiers=${TIERS.length}  planned=${plan.length}  ` +
      `already-live=${plan.length - todo.length}  to-create=${todo.length}`,
  );
  console.log(`stock=${STOCK}  prices=${TIERS.map((t) => t.label + " $" + t.price).join(", ")}`);
  if (!APPLY) {
    console.log("\nDRY RUN — nothing published. Re-run with --apply.\n");
    for (const p of todo.slice(0, 12)) console.log("  would create:", p.title, "$" + p.tier.price);
    if (todo.length > 12) console.log("  … and " + (todo.length - 12) + " more");
    await mongoose.disconnect();
    return;
  }

  let ok = 0,
    failed = 0;
  const imgCache = new Map();
  for (const p of todo) {
    let cover = "";
    try {
      if (!imgCache.has(p.game)) {
        imgCache.set(p.game, await gameDropImages(p.game, 30).catch(() => []));
      }
      cover = await buildPromoCoverImage({
        title: p.game + " Twitch Drops Automatic Farming",
        serviceText: p.tier.label + " Service",
        bullets: BULLETS,
        itemImages: imgCache.get(p.game),
        twitchTiles: true,
      });
      const r = await mp.eldoradoPublish({
        game: p.game,
        title: p.title,
        description: description(p.game, p.tier),
        priceUsd: p.tier.price,
        quantity: STOCK,
        coverImagePath: cover,
        deliveryTime: "Minute20",
      });
      ok++;
      console.log(`ok   ${p.title}  $${p.tier.price}  ${r.externalId}`);
    } catch (e) {
      failed++;
      console.error(`FAIL ${p.title}: ${e.message}`);
    } finally {
      if (cover) await fsp.unlink(cover).catch(() => {});
    }
    // Eldorado's rate limits are unprobed; pace the burst.
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  console.log(`\ncreated=${ok} failed=${failed}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
