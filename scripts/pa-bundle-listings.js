#!/usr/bin/env node
// Publish PlayerAuctions bundle listings for drop sets that have ALREADY SOLD
// on another marketplace — proven demand, rather than guessing what buyers want.
//
//   node scripts/pa-bundle-listings.js            # dry run
//   node scripts/pa-bundle-listings.js --apply
//   node scripts/pa-bundle-listings.js --limit=10 --apply
//
// Sibling of scripts/eldorado-bundle-listings.js. The three things that script
// is careful about apply here unchanged:
//
//  * DEDUPE BY ITEMS, NOT BY SET. The archive holds several DropSets that are
//    the same product under different names (four separate "Stream of the Crop"
//    sets, all one item). Sets are collapsed on their sorted item signature.
//  * REAL STOCK AS totalUnit. The rent-farm listings advertise 1000 against a
//    ~100 account pool; these advertise what actually exists. That matters more
//    on PlayerAuctions than anywhere else, because a missed delivery guarantee
//    there costs a penalty fee and gets the offers hidden.
//  * EVERY LISTING IS WIRED TO DELIVER. Each publish also writes a
//    MarketplaceListing row with autoClaimSet, so the fulfiller can claim from
//    that exact set at delivery time.
//
// Plus three that are specific to PlayerAuctions:
//
//  * $5 FLOOR. Sets priced below it are lifted to $5 rather than skipped — the
//    archive's derived prices are often $1-3 and every one of those would
//    otherwise be refused.
//  * PER-GAME ITEM SUPPORT. Only 149 of ~400 games accept Item offers; the rest
//    are reported and skipped up front instead of burning a write each.
//  * THE WRITE THROTTLE. Default pacing is ~26s between creates.
require("dotenv").config();
const fsp = require("fs/promises");
const mongoose = require("mongoose");

const mp = require("../utils/marketplaces");
const { isNoClaimGame } = require("../utils/settings");
const autoLister = require("../utils/autoLister");
const copy = require("../utils/playerauctionsCopy");
const { buildSetGridImage } = require("../utils/setImage");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const hit = args.find((a) => a.startsWith(f + "="));
  return hit ? hit.slice(f.length + 1) : d;
};
const APPLY = has("--apply");
const LIMIT = parseInt(val("--limit", "0"), 10) || 0;
const DELAY_MS = parseInt(val("--delay", "26000"), 10) || 26000;
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

  // 1. Sets that have actually sold somewhere. Note only Gameflip marks rows
  //    "sold"; GGSel and G2G track sales as stock depletion, so this
  //    under-counts rather than over-counts.
  const sold = await MarketplaceListing.find(
    { marketplace: { $in: SOURCES }, status: "sold" },
    { set: 1 },
  ).lean();
  const salesBySet = new Map();
  for (const r of sold) {
    const k = String(r.set);
    salesBySet.set(k, (salesBySet.get(k) || 0) + 1);
  }

  // Products already on PlayerAuctions. Matching on set id alone is NOT enough:
  // the archive holds several sets with different ids but identical items, so an
  // id-only check happily republishes a product that is already on sale.
  const already = await MarketplaceListing.find(
    { marketplace: "playerauctions", status: { $in: ["active"] } },
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
    const sig = itemSignature(set);
    rows.push({
      set,
      setId,
      sales,
      avail,
      sig,
      alreadyLive: liveSets.has(setId) || liveSigs.has(sig),
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
  // Overwatch / Rainbow Six / Call of Duty drops have to reach the buyer
  // UNCLAIMED. Everything this script can offer comes from the CLAIMED Drop
  // Archive, so those games are simply not sellable here — they need an
  // unclaimedGame-backed listing instead.
  const noClaim = [...bySig.values()].filter((r) => isNoClaimGame(r.game));
  if (noClaim.length) {
    console.log(
      "skipping " + noClaim.length + " set(s) for no-claim games " +
        "(must come from the unclaimed farm): " +
        [...new Set(noClaim.map((r) => r.game))].join(", "),
    );
  }
  let candidates = [...bySig.values()]
    .filter((r) => !isNoClaimGame(r.game))
    .filter((r) => r.avail > 0 && !r.alreadyLive && r.price > 0 && (r.set.items || []).length)
    .sort((a, b) => b.sales - a.sales || b.avail - a.avail);

  // 4. Resolve each game against the PlayerAuctions catalogue ONCE. A game
  //    filed as account-only can never take an Item offer, and finding that out
  //    one failed create at a time wastes the write budget.
  const plan = [];
  const unusable = [];
  const gameCache = new Map();
  for (const r of candidates) {
    const key = String(r.game || "").toLowerCase();
    if (!gameCache.has(key)) {
      gameCache.set(key, await mp.playerauctionsResolveGame(r.game).catch(() => null));
    }
    const pa = gameCache.get(key);
    if (!pa) {
      unusable.push([r.game, "no PlayerAuctions game by that name"]);
      continue;
    }
    if (!String(pa.productType || "").toLowerCase().split(",").includes("item")) {
      unusable.push([r.game, "account-only on PlayerAuctions (" + pa.productType + ")"]);
      continue;
    }
    plan.push({ ...r, pa });
  }
  const limited = LIMIT ? plan.slice(0, LIMIT) : plan;

  console.log(
    "sold sets=" + salesBySet.size +
      "  after item-dedupe=" + bySig.size +
      "  publishable=" + limited.length +
      "  skipped-game=" + unusable.length,
  );
  const seenSkip = new Set();
  for (const [g, why] of unusable) {
    if (seenSkip.has(g)) continue;
    seenSkip.add(g);
    console.log("  skip " + g + ": " + why);
  }

  console.log("\nsales | stock | qty | price | title");
  for (const r of limited) {
    r.title = autoLister.buildTitle({
      game: r.game,
      items: r.set.items || [],
      campaignName: r.set.name,
    });
    r.qty = Math.max(1, Math.min(MAX_QTY, r.avail));
    // PlayerAuctions refuses anything under $5, so lift rather than skip.
    r.listPrice = Math.max(mp.PA_MIN_PRICE, r.price);
    console.log(
      "  " + String(r.sales).padStart(3) + " | " + String(r.avail).padStart(5) +
        " | " + String(r.qty).padStart(3) + " | $" + String(r.listPrice).padStart(4) +
        " | " + r.title.slice(0, 66) +
        (r.listPrice !== r.price ? "   (lifted from $" + r.price + ")" : ""),
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
    let cover = "";
    try {
      cover = await buildSetGridImage(r.set);
      const description = autoLister.buildDescription({
        game: r.game,
        items: r.set.items || [],
        campaignName: r.set.name,
        postEvent: false,
        marketplace: "playerauctions",
      });
      const pub = await mp.playerauctionsPublish({
        gameId: r.pa.gameId,
        title: r.title,
        description,
        instruction: copy.bundleInstruction(),
        priceUsd: r.listPrice,
        itemsPerUnit: (r.set.items || []).length || 1,
        totalUnit: r.qty,
        minUnitPerOrder: 1,
        deliveryGuarantee: mp.PA_DELIVERY.min20,
        coverImagePath: cover,
      });
      // Wire delivery in the same breath as the listing.
      await MarketplaceListing.create({
        set: r.setId,
        marketplace: "playerauctions",
        externalId: pub.offerId,
        url: pub.url || "",
        title: r.title,
        description,
        price: r.listPrice,
        status: "active",
        origin: "manual",
        autoClaimSet: true,
        note:
          "proven seller (" + r.sales + " sales elsewhere); claims from the Drop Archive",
      });
      ok++;
      console.log("ok   " + r.title.slice(0, 60) + "  $" + r.listPrice + " x" + r.qty);
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
  console.error(e);
  process.exit(1);
});
