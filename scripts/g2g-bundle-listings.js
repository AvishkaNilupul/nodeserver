#!/usr/bin/env node
// Publish G2G bundle listings for Drop Archive sets, each one wired to deliver.
//
//   node scripts/g2g-bundle-listings.js              # dry run
//   node scripts/g2g-bundle-listings.js --apply
//   node scripts/g2g-bundle-listings.js --all --limit=20 --apply
//
// Sibling of scripts/pa-bundle-listings.js and eldorado-bundle-listings.js.
// What those scripts are careful about applies here unchanged:
//
//  * DEDUPE BY ITEMS, NOT BY SET. The archive holds several DropSets that are
//    the same product under different names, so sets are collapsed on their
//    sorted item signature before anything is published.
//  * REAL STOCK AS THE QUANTITY. Advertise what we can actually ship, counted
//    the way delivery counts it, not the raw archive number.
//  * EVERY LISTING IS WIRED TO DELIVER. Each publish writes a
//    MarketplaceListing row with autoClaimSet, which is the shape
//    g2gFulfiller.pickStock claims from at delivery time. A listing without
//    that row is exactly the hand-made shelf this script replaces: it cannot
//    be stock-checked and it cannot be delivered.
//
// Plus the ones that are specific to G2G:
//
//  * NO UNIVERSAL CATEGORY. G2G files an offer under a (service, brand) pair
//    where the brand IS the game — there is no "Twitch Drops" bucket to fall
//    back on the way Eldorado has one. A game with no hand-checked brand is
//    SKIPPED, never approximated: the account is already paying for one such
//    guess, with nine Rainbow Six bundles filed under "Rainbow Six Mobile".
//  * THE SHAPE GATE. Some games (Rust, Warframe) demand attributes — Platform,
//    Server, Item Type — that cannot be inferred from the catalog alone, and a
//    create without them is rejected. g2gResolveOfferShape is checked ONCE per
//    brand up front, so an unlistable game is reported rather than costing a
//    failed write per set.
//  * $0.50 FLOOR. g2gPublish refuses anything lower, so sub-floor sets are
//    lifted rather than skipped, and the lifted price is what gets stored.
require("dotenv").config();
const mongoose = require("mongoose");

const mp = require("../utils/marketplaces");
const { isNoClaimGame } = require("../utils/settings");
const { loginsOnActiveListings, notListed } = require("../utils/listedLogins");
const autoLister = require("../utils/autoLister");
const { brandForGame } = require("../utils/g2gGames");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const hit = args.find((a) => a.startsWith(f + "="));
  return hit ? hit.slice(f.length + 1) : d;
};
const APPLY = has("--apply");
const ALL = has("--all");
const LIMIT = parseInt(val("--limit", "0"), 10) || 0;
const DELAY_MS = parseInt(val("--delay", "4000"), 10) || 4000;
const MAX_QTY = parseInt(val("--max-qty", "200"), 10) || 200;

// Sets that have already sold SOMEWHERE are the honest demand signal. G2G's own
// sales are not in this list on purpose: the whole hand-made shelf carries no
// listing row, so nothing it ever sold was recorded against a set.
const SOURCES = ["gameflip", "ggsel", "playerauctions", "eldorado"];

function itemSignature(set) {
  return (set.items || [])
    .map((i) => String(i.name || "").trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(" | ");
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const MarketplaceListing = require("../models/MarketplaceListing");
  const DropSet = require("../models/DropSet");
  const { availableAccountsForSet } = require("../routes/shopRoutes");

  const sold = await MarketplaceListing.find(
    { marketplace: { $in: SOURCES }, status: "sold" },
    { set: 1 },
  ).lean();
  const salesBySet = new Map();
  for (const r of sold) {
    const k = String(r.set);
    salesBySet.set(k, (salesBySet.get(k) || 0) + 1);
  }
  if (ALL) {
    for (const s of await DropSet.find({}, { _id: 1 }).lean()) {
      const k = String(s._id);
      if (!salesBySet.has(k)) salesBySet.set(k, 0);
    }
  }

  // What is already on G2G *from this system*. Matching on set id alone is not
  // enough — different ids can hold identical items — so the item signature is
  // carried too.
  const already = await MarketplaceListing.find(
    { marketplace: "g2g", status: "active" },
    { set: 1 },
  ).lean();
  const liveSets = new Set(already.map((r) => String(r.set)));
  const liveSigs = new Set();
  for (const r of already) {
    const s = r.set ? await DropSet.findById(r.set).lean() : null;
    if (s) liveSigs.add(itemSignature(s));
  }

  // CHEAP DISQUALIFIERS FIRST. availableAccountsForSet is one holdings query per
  // set and dwarfs everything else here; the game and brand gates are a lookup
  // against a table already in memory. Stock-checking first is what made the
  // PlayerAuctions planning run sit for 37 minutes without finishing.
  const listedLogins = await loginsOnActiveListings();
  const rows = [];
  for (const [setId, sales] of salesBySet) {
    const set = await DropSet.findById(setId).lean();
    if (!set || !(set.items || []).length) continue;
    const game =
      set.coverGame || ((set.items || []).find((i) => i.game) || {}).game || "";
    // A no-claim game can never be honoured from this (claimed) archive.
    if (isNoClaimGame(game)) continue;
    const brand = brandForGame(game);
    if (!brand) continue;
    const sig = itemSignature(set);
    if (liveSets.has(String(setId)) || liveSigs.has(sig)) continue;

    const avail = notListed(
      await availableAccountsForSet(set).catch(() => []),
      listedLogins,
    ).length;
    if (avail < 1) continue;

    rows.push({
      set,
      setId,
      sales,
      avail,
      sig,
      game,
      brand,
      price: Number(set.price) || Number(set.minPriceUsd) || 0,
    });
  }

  // Collapse same-item duplicates, keeping the best-evidenced row.
  const bySig = new Map();
  for (const r of rows) {
    if (!r.sig) continue;
    const cur = bySig.get(r.sig);
    if (!cur || r.sales > cur.sales || (r.sales === cur.sales && r.avail > cur.avail)) {
      bySig.set(r.sig, r);
    }
  }

  let candidates = [...bySig.values()].filter((r) => r.price > 0);
  candidates.sort(
    ALL
      ? (a, b) => b.avail - a.avail || b.sales - a.sales
      : (a, b) => b.sales - a.sales || b.avail - a.avail,
  );

  // Resolve each BRAND's offer shape once. A game whose product demands
  // attributes we cannot infer is reported here rather than costing one failed
  // create per set.
  const shapeCache = new Map();
  const plan = [];
  const unusable = [];
  for (const r of candidates) {
    const key = r.brand.brandId;
    if (!shapeCache.has(key)) {
      shapeCache.set(
        key,
        await mp
          .g2gResolveOfferShape({ brandId: key })
          .then((s) => ({ ok: true, shape: s }))
          .catch((e) => ({ ok: false, why: e.message })),
      );
    }
    const s = shapeCache.get(key);
    if (!s.ok) {
      unusable.push([r.game, s.why]);
      continue;
    }
    plan.push({ ...r, shape: s.shape });
  }
  const limited = LIMIT ? plan.slice(0, LIMIT) : plan;

  console.log(
    "candidate sets=" + salesBySet.size +
      "  after item-dedupe=" + bySig.size +
      "  publishable=" + limited.length +
      "  skipped-game=" + unusable.length,
  );
  const seen = new Set();
  for (const [g, why] of unusable) {
    if (seen.has(g)) continue;
    seen.add(g);
    console.log("  skip " + g + ": " + String(why).slice(0, 96));
  }

  console.log("\nsales | stock | qty | price | title");
  for (const r of limited) {
    r.title = autoLister.buildTitle({
      game: r.game,
      items: r.set.items || [],
      campaignName: r.set.name,
    });
    r.qty = Math.max(1, Math.min(MAX_QTY, r.avail));
    r.listPrice = Math.max(mp.G2G_MIN_PRICE, r.price);
    console.log(
      "  " + String(r.sales).padStart(3) + " | " + String(r.avail).padStart(5) +
        " | " + String(r.qty).padStart(3) + " | $" + String(r.listPrice).padStart(5) +
        " | " + r.title.slice(0, 62) +
        (r.listPrice !== r.price ? "  (lifted from $" + r.price + ")" : ""),
    );
  }

  if (!APPLY) {
    console.log("\nDRY RUN — nothing published. Re-run with --apply.");
    await mongoose.disconnect();
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const r of limited) {
    try {
      const description = autoLister.buildDescription({
        game: r.game,
        items: r.set.items || [],
        campaignName: r.set.name,
        postEvent: false,
        marketplace: "g2g",
      });
      const pub = await mp.g2gPublish({
        serviceId: mp.G2G_ITEMS_SERVICE,
        brandId: r.brand.brandId,
        relationId: r.shape.relationId,
        offerAttributes: r.shape.attributes,
        collectionTree: r.shape.collectionTree,
        title: r.title,
        description,
        priceUsd: r.listPrice,
        qty: r.qty,
        minQty: 1,
      });
      // Wire delivery in the same breath as the listing. Without this row the
      // offer is unmanaged and undeliverable — the exact state the hand-made
      // shelf was in.
      await MarketplaceListing.create({
        set: r.setId,
        marketplace: "g2g",
        externalId: pub.externalId,
        url: pub.url || "",
        title: r.title,
        description,
        price: r.listPrice,
        status: "active",
        // "auto", not "manual": g2gFulfiller.syncStock deliberately skips
        // manual rows (the operator's own prices are never touched), and a row
        // it skips is one whose advertised quantity drifts until it oversells.
        origin: "auto",
        autoClaimSet: true,
        qtyTarget: r.qty,
        note:
          (r.sales ? "proven seller (" + r.sales + " sales elsewhere); " : "") +
          "claims from the Drop Archive at delivery",
      });
      ok++;
      console.log("ok   " + r.title.slice(0, 60) + "  $" + r.listPrice + " x" + r.qty);
    } catch (e) {
      failed++;
      console.error("FAIL " + r.title.slice(0, 58) + ": " + String(e.message).slice(0, 130));
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
