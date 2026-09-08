#!/usr/bin/env node
// Publish the "Twitch Drops Automatic Farming" service listings on G2G —
// one offer per game per term (120 / 180 / 365 days).
//
//   node scripts/g2g-farm-listings.js                    # dry run
//   node scripts/g2g-farm-listings.js --apply
//   node scripts/g2g-farm-listings.js --games="Rust,Warframe" --apply
//   node scripts/g2g-farm-listings.js --limit=5 --apply
//
// Sibling of scripts/pa-farm-listings.js and eldorado-farm-listings.js. Two
// things are specific to G2G:
//
//  1. **The brand IS the game.** There is no universal "Twitch Drops" bucket
//     the way Eldorado has one, so a game with no hand-checked G2G brand is
//     SKIPPED rather than approximated — the account is already carrying nine
//     Rainbow Six bundles filed under "Rainbow Six Mobile" from one such guess.
//  2. **The shape gate.** Some products demand attributes (Platform, Server,
//     Item Type) that cannot be inferred, and a create without them is
//     rejected. Each brand's shape is resolved ONCE up front so an unlistable
//     game is reported instead of costing three failed writes.
//
// These offers deliberately carry NO MarketplaceListing row: a rent-farm sale
// is fulfilled by provisioning a pool account, not from stock, and
// utils/g2gFarmService matches the order by its TITLE. That is why the title
// format here is a contract — parseFarmOrder reads the game and the term back
// out of it.
//
// Idempotent: an offer whose title already exists on the account is skipped, so
// a re-run only fills gaps.
require("dotenv").config();
const mongoose = require("mongoose");

const mp = require("../utils/marketplaces");
const { brandForGame } = require("../utils/g2gGames");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const hit = args.find((a) => a.startsWith(f + "="));
  return hit ? hit.slice(f.length + 1) : d;
};

const APPLY = has("--apply");
// Every rent-farm sale burns a PRISTINE pool account for 120-365 days, and the
// pool is the hard ceiling — those accounts do not come back quickly. Advertise
// a real number, not a vanity one; raise it with --stock once the pool deepens.
const STOCK = parseInt(val("--stock", "5"), 10) || 5;
const MIN_TASKS = parseInt(val("--min-tasks", "3"), 10) || 3;
const DAYS_BACK = parseInt(val("--days-back", "90"), 10) || 90;
const LIMIT = parseInt(val("--limit", "0"), 10) || 0;
const DELAY_MS = parseInt(val("--delay", "4000"), 10) || 4000;

// Terms and prices. The title term and the description term both come from
// here so they cannot drift apart — a live Eldorado R6 listing once sold a
// 180-day term while its description promised 120.
const TIERS = [
  { days: 120, label: "120 Days", price: 3 },
  { days: 180, label: "180 Days", price: 4 },
  { days: 365, label: "1 Year", price: 7 },
];

// Twitch-native stream gimmicks and non-games: farmable, but nobody buys a
// farming service for them and they make the shop look padded.
const DENY =
  /marbles on stream|hunt club on stream|special events|coin pusher|coin cascade|marble racing|zevent|^test|drops? test/i;

// The title is parsed back by g2gFarmService.parseFarmOrder — "<Game> Twitch
// Drops Automatic Farming <term>". Changing this format breaks delivery.
function title(game, tier) {
  return (game + " Twitch Drops Automatic Farming " + tier.label).slice(0, 150);
}

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

  // Resolve every game's brand AND its offer shape once, up front.
  const resolved = [];
  const unusable = [];
  const shapeCache = new Map();
  for (const g of games) {
    const brand = brandForGame(g);
    if (!brand) {
      unusable.push([g, "no hand-checked G2G brand — never approximated"]);
      continue;
    }
    if (!shapeCache.has(brand.brandId)) {
      shapeCache.set(
        brand.brandId,
        await mp
          .g2gResolveOfferShape({ brandId: brand.brandId })
          .then((s) => ({ ok: true, shape: s }))
          .catch((e) => ({ ok: false, why: e.message })),
      );
    }
    const s = shapeCache.get(brand.brandId);
    if (!s.ok) {
      unusable.push([g, String(s.why).slice(0, 90)]);
      continue;
    }
    resolved.push({ game: g, brand, shape: s.shape });
  }

  // Existing titles on the account — this is what makes re-runs safe.
  const existing = new Set();
  try {
    const offers = await mp.g2gListOffers({ pageSize: 50, maxPages: 6 });
    for (const o of offers) {
      if (o && o.title) existing.add(String(o.title).trim().toLowerCase());
    }
  } catch (e) {
    console.log("note: could not read live G2G offers (" + e.message + ")");
    console.log("      the plan below assumes none of these titles exist yet.");
    if (APPLY) throw e;
  }

  const plan = [];
  for (const r of resolved) {
    for (const t of TIERS) {
      const ti = title(r.game, t);
      plan.push({ ...r, tier: t, title: ti, skip: existing.has(ti.trim().toLowerCase()) });
    }
  }
  const todo = plan.filter((p) => !p.skip);
  console.log(
    "games=" + games.length + "  usable=" + resolved.length +
      "  skipped-game=" + unusable.length + "  planned=" + plan.length +
      "  already-live=" + (plan.length - todo.length) + "  to-create=" + todo.length,
  );
  console.log(
    "stock=" + STOCK + "  prices=" + TIERS.map((t) => t.label + " $" + t.price).join(", "),
  );
  for (const [g, why] of unusable.slice(0, 15)) console.log("  skip " + g + ": " + why);
  if (unusable.length > 15) console.log("  … and " + (unusable.length - 15) + " more skipped");

  if (!APPLY) {
    console.log("\nDRY RUN — nothing published. Re-run with --apply.\n");
    for (const p of todo.slice(0, 12)) console.log("  would create: " + p.title + "  $" + p.tier.price);
    if (todo.length > 12) console.log("  … and " + (todo.length - 12) + " more");
    await mongoose.disconnect();
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const p of todo) {
    try {
      const r = await mp.g2gPublish({
        serviceId: mp.G2G_ITEMS_SERVICE,
        brandId: p.brand.brandId,
        relationId: p.shape.relationId,
        offerAttributes: p.shape.attributes,
        collectionTree: p.shape.collectionTree,
        title: p.title,
        description: description(p.game, p.tier),
        priceUsd: p.tier.price,
        qty: STOCK,
        minQty: 1,
      });
      ok++;
      console.log("ok   " + p.title + "  $" + p.tier.price + "  " + r.externalId);
    } catch (e) {
      failed++;
      console.error("FAIL " + p.title + ": " + String(e.message).slice(0, 120));
    }
    await new Promise((res) => setTimeout(res, DELAY_MS));
  }
  console.log("\ncreated=" + ok + " failed=" + failed);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
