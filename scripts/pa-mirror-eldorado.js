#!/usr/bin/env node
// Mirror the LIVE Eldorado bundle listings onto PlayerAuctions.
//
//   node scripts/pa-mirror-eldorado.js              # dry run — prints the plan
//   node scripts/pa-mirror-eldorado.js --apply
//   node scripts/pa-mirror-eldorado.js --limit=5 --apply
//
// Differs from scripts/pa-bundle-listings.js on purpose: that one picks sets by
// PROVEN DEMAND (sold on Gameflip/GGSel/G2G). This one takes whatever is on
// Eldorado right now and puts the same catalogue on PlayerAuctions, because the
// two shops should carry the same shelf.
//
// Each mirrored row keeps its stock source, so the PlayerAuctions listing is
// wired to auto-deliver from the same place the Eldorado one is:
//   unclaimedGame  -> the no-claim farm
//   autoClaimSet   -> the Drop Archive, claiming that exact DropSet at delivery
// A row with neither is skipped rather than published unfulfillable.
//
// Four PlayerAuctions rules this has to respect, all verified live:
//  * $5 minimum trade price. Eldorado prices here run $1.00-$2.75, so every one
//    is lifted to the floor. That is not a markup guess — all 4 existing
//    PlayerAuctions offers on this account sit at exactly $5.00 and 51 orders
//    have completed at that price, so $5 IS the going rate on this shop.
//  * Only 149 of ~400 games accept Item offers. Rainbow Six, Rocket League,
//    Apex, Dead by Daylight and The Finals are account-only there, so those
//    bundles cannot be mirrored at all and are reported, not failed one by one.
//  * Writes are throttled ("Operated too frequent"), hence ~26s pacing.
//  * There is NO per-category active-offer cap of the kind Eldorado enforces
//    (max 100 per game, "Other" shared). Nothing observed here limits breadth,
//    so the whole shelf can go up.
//
// Dedupe is by ITEM SIGNATURE, never by set id: the archive holds several
// DropSets that are the same product under different names, and an id-only
// check happily publishes the same thing twice.
require("dotenv").config();
const fsp = require("fs/promises");
const mongoose = require("mongoose");

const mp = require("../utils/marketplaces");
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

// Rent-farm listings are a different product with a different fulfiller path;
// scripts/pa-farm-listings.js owns those.
const FARM_TITLE = /\bAutomatic\s+Farming\b/i;

function itemSignature(items) {
  return (items || [])
    .map((i) => String(i.name || "").trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(" | ");
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const MarketplaceListing = require("../models/MarketplaceListing");
  const DropSet = require("../models/DropSet");
  const UnclaimedAccount = require("../models/UnclaimedAccount");
  const { availableAccountsForSet } = require("../routes/shopRoutes");
  const fulfiller = require("../utils/playerauctionsFulfiller");

  // 1. What Eldorado is selling right now.
  const eld = await MarketplaceListing.find({
    marketplace: "eldorado",
    status: "active",
  }).lean();
  const bundles = eld.filter((r) => !FARM_TITLE.test(r.title || ""));

  // 2. What PlayerAuctions already carries, by item signature AND by title.
  const paRows = await MarketplaceListing.find({
    marketplace: "playerauctions",
    status: "active",
  }).lean();
  const liveTitles = new Set(paRows.map((r) => String(r.title || "").trim().toLowerCase()));
  const liveSigs = new Set();
  for (const r of paRows) {
    if (!r.set) continue;
    const s = await DropSet.findById(r.set).lean();
    if (s) liveSigs.add(itemSignature(s.items));
  }
  // Offers made by hand on PlayerAuctions are not in the DB at all, so also
  // exclude anything already on the account by title.
  try {
    for (let page = 1; page <= 20; page++) {
      const r = await mp.playerauctionsMyListings(page, 50);
      for (const o of r.items || []) {
        if (o && o.title) liveTitles.add(o.title.trim().toLowerCase());
      }
      if ((r.items || []).length < 50) break;
    }
  } catch (e) {
    console.log("note: could not read live PlayerAuctions offers (" + e.message + ")");
    console.log("      dedupe falls back to the DB rows only.");
  }

  // 3. Resolve each Eldorado bundle: game, stock, price, and whether it can
  //    even be an Item offer.
  const plan = [];
  const skipped = [];
  const gameCache = new Map();
  const seenSig = new Set();

  for (const row of bundles) {
    const set = row.set ? await DropSet.findById(row.set).lean() : null;
    const game =
      row.unclaimedGame ||
      (set && (set.coverGame || ((set.items || []).find((i) => i.game) || {}).game)) ||
      "";
    const sig = set ? itemSignature(set.items) : "title:" + row.title;

    if (!row.unclaimedGame && !row.autoClaimSet) {
      skipped.push([row.title, "no stock source — would publish unfulfillable"]);
      continue;
    }
    if (liveTitles.has(String(row.title || "").trim().toLowerCase()) || liveSigs.has(sig)) {
      skipped.push([row.title, "already on PlayerAuctions"]);
      continue;
    }
    if (seenSig.has(sig)) {
      skipped.push([row.title, "duplicate of another Eldorado row (same items)"]);
      continue;
    }
    if (!game) {
      skipped.push([row.title, "could not tell which game this is"]);
      continue;
    }

    const key = game.toLowerCase();
    if (!gameCache.has(key)) {
      gameCache.set(key, await mp.playerauctionsResolveGame(game).catch(() => null));
    }
    const pa = gameCache.get(key);
    if (!pa) {
      skipped.push([row.title, "no PlayerAuctions game called " + JSON.stringify(game)]);
      continue;
    }
    if (!String(pa.productType || "").toLowerCase().split(",").includes("item")) {
      skipped.push([row.title, game + " is account-only on PlayerAuctions"]);
      continue;
    }

    // Real, claimable stock — never the advertised Eldorado number.
    let stock = 0;
    if (row.unclaimedGame) {
      stock = await UnclaimedAccount.countDocuments({
        source: "noclaim",
        game: fulfiller.unclaimedGameFilter(row.unclaimedGame),
        status: { $in: ["released", "skipped"] },
        soldAt: null,
      });
    } else if (set) {
      stock = (await availableAccountsForSet(set).catch(() => [])).length;
    }
    if (stock < 1) {
      skipped.push([row.title, "no claimable stock right now"]);
      continue;
    }

    seenSig.add(sig);
    plan.push({
      row,
      set,
      pa,
      game,
      sig,
      stock: Math.min(MAX_QTY, stock),
      items: (set && set.items) || [],
      listPrice: Math.max(mp.PA_MIN_PRICE, Number(row.price) || 0),
      eldPrice: Number(row.price) || 0,
    });
  }

  const todo = LIMIT ? plan.slice(0, LIMIT) : plan;

  console.log(
    "eldorado active=" + eld.length +
      "  bundles=" + bundles.length +
      "  mirrorable=" + plan.length +
      "  skipped=" + skipped.length,
  );
  console.log("\nstock | price        | game              | title");
  for (const p of todo) {
    console.log(
      "  " + String(p.stock).padStart(3) +
        " | $" + String(p.eldPrice).padEnd(5) + "-> $" + String(p.listPrice).padEnd(4) +
        " | " + p.pa.gameName.slice(0, 17).padEnd(17) +
        " | " + String(p.row.title).slice(0, 58),
    );
  }
  if (skipped.length) {
    console.log("\nskipped:");
    for (const [t, why] of skipped) console.log("  - " + String(t).slice(0, 52) + " :: " + why);
  }

  if (!APPLY) {
    console.log("\nDRY RUN — nothing published. Re-run with --apply.");
    await mongoose.disconnect();
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const p of todo) {
    let cover = "";
    try {
      if (p.set) cover = await buildSetGridImage(p.set).catch(() => "");
      const pub = await mp.playerauctionsPublish({
        gameId: p.pa.gameId,
        title: String(p.row.title).slice(0, 150),
        description: p.row.description || "",
        instruction: copy.bundleInstruction(),
        priceUsd: p.listPrice,
        itemsPerUnit: p.items.length || 1,
        totalUnit: p.stock,
        minUnitPerOrder: 1,
        deliveryGuarantee: mp.PA_DELIVERY.min20,
        coverImagePath: cover || undefined,
      });
      // Wire delivery in the same breath, carrying the stock source across.
      await MarketplaceListing.create({
        set: p.row.set,
        marketplace: "playerauctions",
        externalId: pub.offerId,
        url: pub.url || "",
        title: p.row.title,
        description: p.row.description || "",
        price: p.listPrice,
        status: "active",
        origin: "manual",
        autoClaimSet: !!p.row.autoClaimSet,
        unclaimedGame: p.row.unclaimedGame || "",
        note: "mirrored from Eldorado offer " + p.row.externalId,
      });
      ok++;
      console.log("ok   $" + p.listPrice + " x" + p.stock + "  " + p.row.title.slice(0, 58));
    } catch (e) {
      failed++;
      console.error("FAIL " + String(p.row.title).slice(0, 58) + ": " + e.message);
    } finally {
      if (cover) await fsp.unlink(cover).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  console.log("\ncreated=" + ok + " failed=" + failed);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
