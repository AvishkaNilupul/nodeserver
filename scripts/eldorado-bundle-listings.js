#!/usr/bin/env node
// Publish Eldorado bundle listings for drop sets that have ALREADY SOLD on
// another marketplace — proven demand, rather than guessing what buyers want.
//
//   node scripts/eldorado-bundle-listings.js            # dry run
//   node scripts/eldorado-bundle-listings.js --apply
//   node scripts/eldorado-bundle-listings.js --limit=10 --apply
//
// Three things this is careful about:
//
//  * DEDUPE BY ITEMS, NOT BY SET. The archive holds several DropSets that are
//    the same product under different names (four separate "Stream of the Crop"
//    sets, all one item). Publishing per set would put four identical listings
//    in the shop. Sets are collapsed on their sorted item signature, keeping the
//    one with the most sales.
//  * REAL STOCK AS QUANTITY. The rent-farm listings advertise 1000 against a
//    ~100 account pool; these advertise what actually exists, so a sale can
//    always be honoured.
//  * EVERY LISTING IS WIRED TO DELIVER. Each publish also writes a
//    MarketplaceListing row with autoClaimSet, so the fulfiller can claim from
//    that exact set at delivery time. A listing nobody can fulfil is worse than
//    no listing.
require("dotenv").config();
const fsp = require("fs/promises");
const mongoose = require("mongoose");

const mp = require("../utils/marketplaces");
const autoLister = require("../utils/autoLister");
const { buildSetGridImage } = require("../utils/setImage");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const hit = args.find((a) => a.startsWith(f + "="));
  return hit ? hit.slice(f.length + 1) : d;
};
const APPLY = has("--apply");
const LIMIT = parseInt(val("--limit", "0"), 10) || 0;
const DELAY_MS = parseInt(val("--delay", "2500"), 10) || 2500;
const MAX_QTY = parseInt(val("--max-qty", "200"), 10) || 200;

const SOURCES = ["gameflip", "ggsel", "g2g"];

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

  // 1. Sets that have actually sold somewhere.
  const sold = await MarketplaceListing.find(
    { marketplace: { $in: SOURCES }, status: "sold" },
    { set: 1 },
  ).lean();
  const salesBySet = new Map();
  for (const r of sold) {
    const k = String(r.set);
    salesBySet.set(k, (salesBySet.get(k) || 0) + 1);
  }

  // Products already on Eldorado. Matching on set id alone is NOT enough: the
  // archive holds several sets with different ids but identical items, so an
  // id-only check happily republishes a product that is already on sale (it let
  // a second "Reload Championship Spray" through in testing). Exclude by item
  // signature too.
  const already = await MarketplaceListing.find(
    // Only rows still on sale block a re-publish: offers auto-expire after ~3
    // weeks and cannot be renewed, so an expired row must read as absent to let
    // a re-run rebuild the catalogue.
    { marketplace: "eldorado", status: { $in: ["active"] } },
    { set: 1 },
  ).lean();
  const liveSets = new Set(already.map((r) => String(r.set)));
  const liveSigs = new Set();
  for (const r of already) {
    const s = await DropSet.findById(r.set).lean();
    if (s) liveSigs.add(itemSignature(s));
  }

  // 2. Resolve, price and stock-check each.
  const rows = [];
  for (const [setId, sales] of salesBySet) {
    const set = await DropSet.findById(setId).lean();
    if (!set) continue;
    let avail = 0;
    try {
      avail = (await availableAccountsForSet(set)).length;
    } catch {
      avail = 0;
    }
    rows.push({
      set,
      setId,
      sales,
      avail,
      sig: itemSignature(set),
      alreadyLive: liveSets.has(setId) || liveSigs.has(itemSignature(set)),
      game:
        set.coverGame || ((set.items || []).find((i) => i.game) || {}).game || "",
      price: Number(set.price) || Number(set.minPriceUsd) || 0,
    });
  }

  // 3. Collapse duplicates: same items = same product.
  const bySig = new Map();
  for (const r of rows) {
    if (!r.sig) continue;
    const cur = bySig.get(r.sig);
    if (!cur || r.sales > cur.sales || (r.sales === cur.sales && r.avail > cur.avail)) {
      bySig.set(r.sig, { ...r, dupes: (cur ? cur.dupes : 0) + (cur ? 1 : 0) });
    }
  }
  let plan = [...bySig.values()]
    .filter((r) => r.avail > 0 && !r.alreadyLive && r.price > 0 && (r.set.items || []).length)
    .sort((a, b) => b.sales - a.sales || b.avail - a.avail);
  if (LIMIT) plan = plan.slice(0, LIMIT);

  // Eldorado caps ACTIVE offers at 100 per game category, and almost everything
  // that is not one of its 12 named games shares the "Other" bucket.
  const envs = await mp.eldoradoTradeEnvironments();
  const mapped = new Set(envs.map((e) => String(e.value).toLowerCase()));
  for (const r of plan) r.category = mapped.has(String(r.game).toLowerCase()) ? r.game : "Other";
  const otherCount = plan.filter((r) => r.category === "Other").length;

  console.log(
    "sold sets=" + salesBySet.size +
      "  after item-dedupe=" + bySig.size +
      "  publishable=" + plan.length +
      "  (Other slots needed: " + otherCount + ")",
  );
  console.log("sales | stock | qty | cat        | title");
  for (const r of plan) {
    const title = autoLister.buildTitle({
      game: r.game,
      items: r.set.items || [],
      campaignName: r.set.name,
    });
    r.title = title;
    r.qty = Math.max(1, Math.min(MAX_QTY, r.avail));
    console.log(
      "  " + String(r.sales).padStart(3) + " | " + String(r.avail).padStart(5) +
        " | " + String(r.qty).padStart(3) + " | " + r.category.slice(0, 10).padEnd(10) +
        " | $" + r.price + "  " + title.slice(0, 62),
    );
  }
  if (!APPLY) {
    console.log("\nDRY RUN — nothing published. Re-run with --apply.");
    await mongoose.disconnect();
    return;
  }

  let ok = 0,
    failed = 0;
  for (const r of plan) {
    let cover = "";
    try {
      cover = await buildSetGridImage(r.set);
      const description = autoLister.buildDescription({
        game: r.game,
        items: r.set.items || [],
        campaignName: r.set.name,
        postEvent: false,
        marketplace: "eldorado",
      });
      const pub = await mp.eldoradoPublish({
        game: r.game,
        title: r.title,
        description,
        priceUsd: r.price,
        quantity: r.qty,
        coverImagePath: cover,
        deliveryTime: "Minute20",
      });
      // Wire delivery in the same breath as the listing.
      await MarketplaceListing.create({
        set: r.setId,
        marketplace: "eldorado",
        externalId: pub.externalId,
        url: pub.url || "",
        title: r.title,
        description,
        price: r.price,
        status: "active",
        origin: "manual",
        autoClaimSet: true,
        note: "proven seller (" + r.sales + " sales elsewhere); claims from the Drop Archive",
      });
      ok++;
      console.log("ok   " + r.title.slice(0, 60) + "  $" + r.price + " x" + r.qty);
    } catch (e) {
      failed++;
      console.error("FAIL " + r.title.slice(0, 60) + ": " + e.message);
    } finally {
      if (cover) await fsp.unlink(cover).catch(() => {});
    }
    await new Promise((res) => setTimeout(res, DELAY_MS));
  }
  console.log("\ncreated=" + ok + " failed=" + failed);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
