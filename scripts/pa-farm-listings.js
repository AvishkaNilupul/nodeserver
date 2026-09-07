#!/usr/bin/env node
// Publish the "Twitch Drops Automatic Farming" service listings on
// PlayerAuctions — one offer per game per term (120 / 180 / 365 days).
//
// Sibling of scripts/eldorado-farm-listings.js, with three PlayerAuctions
// differences that are not cosmetic:
//
//  1. **$5 price floor.** PlayerAuctions rejects any trade under $5, so the
//     Eldorado ladder ($3 / $4 / $7) cannot be reused as-is — the 120-day tier
//     would be refused outright. The tiers here start at the floor.
//  2. **Per-game Item support.** Only 149 of ~400 PlayerAuctions games accept
//     Item offers; Rainbow Six, Apex, Rocket League, Dead by Daylight and The
//     Finals are account-only. Those games are reported and skipped, not
//     failed one call at a time.
//  3. **A write throttle.** Two writes a second apart come back "Operated too
//     frequent"; ~25s apart is reliably accepted, so the default pacing is much
//     slower than Eldorado's.
//
//   node scripts/pa-farm-listings.js                    # dry run, default set
//   node scripts/pa-farm-listings.js --apply
//   node scripts/pa-farm-listings.js --games="Overwatch,Rust" --apply
//   node scripts/pa-farm-listings.js --all --min-tasks=1 --apply
//
// Idempotent: an offer whose title already exists on the account is skipped, so
// a re-run only fills gaps.
require("dotenv").config();
const fsp = require("fs/promises");
const mongoose = require("mongoose");

const mp = require("../utils/marketplaces");
const copy = require("../utils/playerauctionsCopy");
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
// The write throttle is the binding constraint, not politeness.
const DELAY_MS = parseInt(val("--delay", "26000"), 10) || 26000;

// Terms and their prices. Title term and description term both come from here,
// so they cannot drift apart — a live Eldorado R6 listing once sold a 180-day
// term while its description promised 120.
//
// $5 is PlayerAuctions' hard floor, so the cheap tier sits on it and the rest
// keep the Eldorado shape above it.
const TIERS = [
  { days: 120, label: "120 Days", price: 5 },
  { days: 180, label: "180 Days", price: 6 },
  { days: 365, label: "1 Year", price: 9 },
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
  return (game + " Twitch Drops Automatic Farming " + tier.label).slice(0, 150);
}

// The house template, with the game and the term substituted from one place.
function description(game, tier) {
  return `<p>Automatic Farm on our Twitch for the game ${game}</p>
<p><b>Activation &amp; Timing:</b> After purchasing, link the received account to your own and start receiving new Drops every day 15 hours during GMT. Farming begins the moment you purchase the account. Time counting starts from the moment the account is transferred.</p>
<p><b>Manual Pickup:</b> If our program does not activate any of the items, you can pick up the items manually on the inventory page.</p>
<p><b>Bot Guarantee:</b> We guarantee that you will receive an automatic farm account, and all events during this period will be automatically collected by our bot within the specified period [${tier.days} days].</p>
<p><b>Account Status:</b> The account provided to you may already include some items on the account Twitch.</p>
<p><b>Exclusivity:</b> Each Twitch is transferred strictly to one buyer.</p>
<p><b>Important Warning:</b> Do not change any data on the account you received, otherwise the automatic farm will stop working, and in this case you will not receive a refund.</p>
<p><b>Event Restrictions:</b> Items are guaranteed for events that last at least 24 hours. If the event lasts less than that, we don't guarantee receipt. Farming also only occurs if there are active events.</p>`;
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

  // Resolve every game once, up front: a game PlayerAuctions files as
  // account-only can never take an Item offer, and finding that out one failed
  // create at a time wastes the write budget.
  const resolved = [];
  const unusable = [];
  for (const g of games) {
    const row = await mp.playerauctionsResolveGame(g).catch(() => null);
    if (!row) {
      unusable.push([g, "no PlayerAuctions game by that name"]);
      continue;
    }
    const types = String(row.productType || "").toLowerCase().split(",");
    if (!types.includes("item")) {
      unusable.push([g, "account-only on PlayerAuctions (" + row.productType + ")"]);
      continue;
    }
    resolved.push({ game: g, pa: row });
  }

  // Existing titles on the account — this is what makes re-runs safe.
  const existing = new Set();
  for (let page = 1; page <= 20; page++) {
    const r = await mp.playerauctionsMyListings(page, 50);
    const items = (r && r.items) || [];
    for (const o of items) {
      if (o && o.title) existing.add(o.title.trim().toLowerCase());
    }
    if (items.length < 50) break;
  }

  const plan = [];
  for (const r of resolved) {
    for (const t of TIERS) {
      const ti = title(r.game, t);
      plan.push({
        game: r.game,
        pa: r.pa,
        tier: t,
        title: ti,
        skip: existing.has(ti.trim().toLowerCase()),
      });
    }
  }
  const todo = plan.filter((p) => !p.skip);
  console.log(
    `games=${games.length} usable=${resolved.length} skipped-game=${unusable.length}  ` +
      `planned=${plan.length}  already-live=${plan.length - todo.length}  ` +
      `to-create=${todo.length}`,
  );
  console.log(
    `stock=${STOCK}  prices=${TIERS.map((t) => t.label + " $" + t.price).join(", ")}  ` +
      `pacing=${DELAY_MS}ms`,
  );
  for (const [g, why] of unusable.slice(0, 15)) console.log(`  skip ${g}: ${why}`);
  if (unusable.length > 15) console.log(`  … and ${unusable.length - 15} more skipped`);

  if (!APPLY) {
    console.log("\nDRY RUN — nothing published. Re-run with --apply.\n");
    for (const p of todo.slice(0, 12)) {
      console.log("  would create:", p.title, "$" + p.tier.price);
    }
    if (todo.length > 12) console.log("  … and " + (todo.length - 12) + " more");
    await mongoose.disconnect();
    return;
  }

  let ok = 0;
  let failed = 0;
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
      const r = await mp.playerauctionsPublish({
        gameId: p.pa.gameId,
        title: p.title,
        description: description(p.game, p.tier),
        instruction: copy.farmInstruction(p.tier.days, p.game),
        priceUsd: p.tier.price,
        itemsPerUnit: 1,
        totalUnit: STOCK,
        minUnitPerOrder: 1,
        deliveryGuarantee: mp.PA_DELIVERY.min20,
        coverImagePath: cover,
      });
      ok++;
      console.log(`ok   ${p.title}  $${p.tier.price}  ${r.offerId}`);
    } catch (e) {
      failed++;
      console.error(`FAIL ${p.title}: ${e.message}`);
    } finally {
      if (cover) await fsp.unlink(cover).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  console.log(`\ncreated=${ok} failed=${failed}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
