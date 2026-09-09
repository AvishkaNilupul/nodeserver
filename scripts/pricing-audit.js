#!/usr/bin/env node
// Read-only: what would the shared pricing engine price everything at, and how
// far is that from what is live right now?
//
//   node scripts/pricing-audit.js                 # summary + worst offenders
//   node scripts/pricing-audit.js --all           # every row
//   node scripts/pricing-audit.js --sets          # DropSet.price instead of listings
//   node scripts/pricing-audit.js --market=gameflip
//
// Writes NOTHING. This is the evidence pass that has to run before any reprice.
require("dotenv").config();
const mongoose = require("mongoose");

const pricing = require("../utils/pricing");
const evidence = require("../utils/pricingEvidence");

const args = process.argv.slice(2);
const ALL = args.includes("--all");
const SETS = args.includes("--sets");
const ONLY = (args.find((a) => a.startsWith("--market=")) || "").split("=")[1] || "";

function categoryFor(set) {
  const items = (set && set.items) || [];
  for (const item of items) {
    const game = String(item.game || "").trim();
    if (game) return game;
  }
  return "";
}

function itemCountOf(set) {
  return ((set && set.items) || []).reduce(
    (sum, item) => sum + Math.max(1, Number(item.qty) || 1),
    0,
  );
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const DropSet = require("../models/DropSet");
  const MarketplaceListing = require("../models/MarketplaceListing");
  const MarketResearch = require("../models/MarketResearch");

  const snap = await evidence.snapshot({ force: true });
  console.log("=== evidence snapshot ===");
  console.log(
    "  priced sale signals:",
    snap.counts.signals,
    "| sold listings:",
    snap.counts.soldListings,
    "| games with evidence:",
    snap.counts.games,
    "| platforms:",
    snap.counts.platforms,
  );
  const g = snap.global.slice().sort((a, b) => a - b);
  if (g.length) {
    console.log(
      "  realised price distribution: min $" +
        g[0].toFixed(2) +
        "  median $" +
        g[Math.floor(g.length / 2)].toFixed(2) +
        "  max $" +
        g[g.length - 1].toFixed(2) +
        "  (n=" +
        g.length +
        ")",
    );
  }

  const research = await MarketResearch.find({}).lean();
  const researchByGame = new Map(
    research.map((r) => [String(r.game || "").toLowerCase(), r]),
  );

  const rows = [];

  if (SETS) {
    const sets = await DropSet.find({ price: { $gt: 0 } }).lean();
    for (const set of sets) {
      const game = categoryFor(set);
      const out = pricing.priceListing({
        evidence: await evidence.evidenceFor({
          game,
          marketplace: "",
          research: researchByGame.get(game.toLowerCase()),
        }),
        itemCount: itemCountOf(set),
        soldFloorUsd: Number(set.minPriceUsd) || 0,
      });
      rows.push({
        label: (set.sourceType || "-") + "  " + String(set.name || "").slice(0, 44),
        game,
        items: itemCountOf(set),
        current: Number(set.price) || 0,
        suggested: out.price,
        basis: out.basis,
        clamped: out.clamped,
      });
    }
  } else {
    const filter = { status: "active" };
    if (ONLY) filter.marketplace = ONLY;
    const listings = await MarketplaceListing.find(filter).lean();
    // Some rows carry no set (hand-made listings, and rows whose set was
    // removed). They have no items to price against, so they are skipped
    // rather than defaulted -- a made-up item count is a made-up price.
    const setIds = [
      ...new Set(listings.map((l) => String(l.set || "")).filter((id) => /^[a-f0-9]{24}$/i.test(id))),
    ];
    const sets = await DropSet.find({ _id: { $in: setIds } }).lean();
    const setById = new Map(sets.map((s) => [String(s._id), s]));
    for (const listing of listings) {
      const set = setById.get(String(listing.set));
      if (!set) continue;
      const game = categoryFor(set);
      const out = pricing.priceListing({
        evidence: await evidence.evidenceFor({
          game,
          marketplace: listing.marketplace,
          research: researchByGame.get(game.toLowerCase()),
        }),
        itemCount: itemCountOf(set),
        soldFloorUsd: Number(set.minPriceUsd) || 0,
        marketplace: listing.marketplace,
      });
      rows.push({
        label: listing.marketplace + "  " + String(listing.title || set.name || "").slice(0, 44),
        game,
        items: itemCountOf(set),
        current: Number(listing.price) || 0,
        suggested: out.price,
        basis: out.basis,
        clamped: out.clamped,
        origin: listing.origin,
      });
    }
  }

  for (const r of rows) {
    r.delta = r.current > 0 ? (r.suggested - r.current) / r.current : 0;
  }

  const over = rows.filter((r) => r.delta <= -0.2).sort((a, b) => a.delta - b.delta);
  const under = rows.filter((r) => r.delta >= 0.2).sort((a, b) => b.delta - a.delta);
  const ok = rows.length - over.length - under.length;

  console.log("\n=== verdict over " + rows.length + " rows ===");
  console.log("  within 20% of suggested :", ok);
  console.log("  OVERPRICED (>20% high)  :", over.length);
  console.log("  underpriced (>20% low)  :", under.length);

  const show = (title, list) => {
    if (!list.length) return;
    console.log("\n--- " + title + " ---");
    for (const r of (ALL ? list : list.slice(0, 20))) {
      console.log(
        "  $" +
          r.current.toFixed(2).padStart(8) +
          " -> $" +
          r.suggested.toFixed(2).padStart(7) +
          "  (" +
          (r.delta * 100).toFixed(0).padStart(5) +
          "%)  items=" +
          String(r.items).padStart(3) +
          "  " +
          r.basis.padEnd(13) +
          (r.clamped ? "[" + r.clamped + "] " : "") +
          r.label,
      );
    }
    if (!ALL && list.length > 20) console.log("  ... and " + (list.length - 20) + " more");
  };
  show("most OVERPRICED", over);
  show("most underpriced", under);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("pricing-audit failed:", err.message);
  process.exit(1);
});
