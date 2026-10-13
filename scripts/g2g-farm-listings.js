#!/usr/bin/env node
// Publish the "Twitch Drops Automatic Farming" service listings on G2G —
// one offer per game per term (30 days to 2 years; see TIERS and tiersFor).
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
//     game is reported instead of costing three failed writes. A game with a
//     hand-checked shelf (utils/g2gFarmShelves) uses that; any other game
//     copies one of our own offers, and has none to copy until we list it once.
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
const { farmShelfForBrand } = require("../utils/g2gFarmShelves");
const { connectFirstOffer, GUARANTEE_ONCE_CONNECTED } = require("../utils/farmHandover");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const hit = args.find((a) => a.startsWith(f + "="));
  return hit ? hit.slice(f.length + 1) : d;
};

const APPLY = has("--apply");
// Every rent-farm sale burns a PRISTINE pool account for the whole term, and the
// pool is the hard ceiling — those accounts do not come back quickly. Advertise
// a real number, not a vanity one. Nothing refills a farm offer on G2G (it has
// no listing row for the stock sync to follow), so the number set here only
// goes down with sales: 5 left a selling offer two sales from empty.
const STOCK = parseInt(val("--stock", "20"), 10) || 20;
const MIN_TASKS = parseInt(val("--min-tasks", "3"), 10) || 3;
const DAYS_BACK = parseInt(val("--days-back", "90"), 10) || 90;
const LIMIT = parseInt(val("--limit", "0"), 10) || 0;
const DELAY_MS = parseInt(val("--delay", "4000"), 10) || 4000;

// Terms and prices. The title term and the description term both come from
// here so they cannot drift apart — a live Eldorado R6 listing once sold a
// 180-day term while its description promised 120. The prices are the
// Eldorado ladder (scripts/eldorado-farm-listings.js): the same window should
// not be cheaper on one market than the other. Was 3 / 4 / 7 until 2026-10-13;
// offers already on sale are moved with scripts/reprice-g2g-farm.js.
const TIERS = [
  { days: 30, label: "30 Days", price: 2.49 },
  { days: 120, label: "120 Days", price: 3.99 },
  { days: 180, label: "180 Days", price: 4.99 },
  { days: 365, label: "1 Year", price: 8.99 },
  { days: 730, label: "2 Years", price: 13.99 },
];

// A 30-day window is only sold where the game's campaigns come close enough
// together that the buyer sees one. A buyer who logs in to an empty account
// opens a dispute within the hour: Rocket League (2-5 hour campaigns, up to 39
// days apart) was 5 of 9 rent-farm disputes in one week on Eldorado. These are
// the games whose longest gap between campaigns was 24 days or less in our
// scanner's records (2026-07-06 to 2026-10-13). A game that is not named here
// gets the longer terms only — the safe way to be wrong.
const SHORT_TERM_GAMES = new Set(
  [
    "Marvel Rivals",
    "Brawlhalla",
    "Warframe",
    "Albion Online",
    "Black Desert",
    "Dead by Daylight",
    "THE FINALS",
    "Halo Infinite",
  ].map((g) => g.toLowerCase()),
);
const SHORT_TERM_DAYS = 120;

function tiersFor(game) {
  const short = SHORT_TERM_GAMES.has(String(game || "").trim().toLowerCase());
  return TIERS.filter((t) => short || t.days >= SHORT_TERM_DAYS);
}

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
<p><b>Activation &amp; Timing:</b> ${connectFirstOffer(game)} Farming begins the moment you purchase the account, and our bot then collects every Twitch Drops campaign ${game} runs. Time counting starts from the moment the account is transferred.</p>
<p><b>Manual Pickup:</b> If our program does not activate any of the items, you can pick up the items manually on the inventory page.</p>
<p><b>Bot Guarantee:</b> We guarantee that you will receive an automatic farm account, and ${GUARANTEE_ONCE_CONNECTED}, all events during this period will be automatically collected by our bot within the specified period [${tier.days} days].</p>
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

// Pure. One row per game per term it may be sold for; `skip` when that title
// is already on the account (`existing`: lower-cased titles).
function planFor(resolved, existing) {
  const plan = [];
  for (const r of resolved) {
    for (const t of tiersFor(r.game)) {
      const ti = title(r.game, t);
      plan.push({ ...r, tier: t, title: ti, skip: existing.has(ti.trim().toLowerCase()) });
    }
  }
  return plan;
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
      const shelf = farmShelfForBrand(brand.brandId);
      shapeCache.set(
        brand.brandId,
        shelf
          ? { ok: true, shape: shelf }
          : await mp
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

  const plan = planFor(resolved, existing);
  const todo = plan.filter((p) => !p.skip);
  console.log(
    "games=" + games.length + "  usable=" + resolved.length +
      "  skipped-game=" + unusable.length + "  planned=" + plan.length +
      "  already-live=" + (plan.length - todo.length) + "  to-create=" + todo.length,
  );
  console.log(
    "stock=" + STOCK + "  prices=" + TIERS.map((t) => t.label + " $" + t.price).join(", "),
  );
  for (const r of resolved) {
    console.log(
      "  " + r.game + ": " + tiersFor(r.game).map((t) => t.label).join(", ") + " — filed under " +
        (r.shape.text || "the shelf of our own offer " + (r.shape.learnedFrom || "?")),
    );
  }
  for (const [g, why] of unusable.slice(0, 15)) console.log("  skip " + g + ": " + why);
  if (unusable.length > 15) console.log("  … and " + (unusable.length - 15) + " more skipped");

  if (!APPLY) {
    console.log("\nDRY RUN — nothing published. Re-run with --apply.\n");
    for (const p of todo) console.log("  would create: " + p.title + "  $" + p.tier.price);
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

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { TIERS, SHORT_TERM_GAMES, tiersFor, title, description, planFor };
