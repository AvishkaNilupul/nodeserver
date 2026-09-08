#!/usr/bin/env node
// What every live listing should cost on the market it is actually on.
//
//   node scripts/market-price-report.js                    every market, read-only
//   node scripts/market-price-report.js --marketplace ggsel
//   node scripts/market-price-report.js --game "Rainbow Six Siege"
//   node scripts/market-price-report.js --overpriced        only the rows to fix
//   node scripts/market-price-report.js --json out.json
//
// READ-ONLY: it never reprices anything. Repricing a live listing is a
// marketplace operation (delist/republish, irreversible on Digiseller), so it
// stays a separate, deliberate step.
//
// The pricing rules and the measured evidence behind them are documented at the
// top of utils/marketPricing.js. In short: our own realised price on THAT
// market is the anchor, comparable rivals are a ceiling, and bundle size is not
// a multiplier — bigger bundles measurably sell for less.
require("dotenv").config();
const mongoose = require("mongoose");
const MarketplaceListing = require("../models/MarketplaceListing");
const SaleSignal = require("../models/SaleSignal");
const mpx = require("../utils/marketPricing");
const scout = require("../utils/priceScout");
const mp = require("../utils/marketplaces");
require("../models/DropSet");

const has = (n) => process.argv.includes("--" + n);
const arg = (n) => {
  const i = process.argv.indexOf("--" + n);
  return i > 0 ? process.argv[i + 1] : null;
};

// Mirrors the connector constants. utils/pricing.js carries the same table;
// both exist because a floor breach is not a rounding error — publishing under
// Digiseller's once got the whole seller account blocked.
const FLOORS = {
  digiseller: 1.28,
  playerauctions: 5,
  zeusx: 1,
  eldorado: 0.5,
  gameflip: 0.75,
  ggsel: 0.3,
  g2g: 1,
  z2u: 1,
  epicnpc: 0.5,
  funpay: 0.3,
};

// Only these three publish a searchable rival page. ZeusX has no keyword
// search at all; Z2U, EpicNPC and FunPay sit behind bot protection a
// server-side fetch cannot pass. For the rest, our own sales are the only
// evidence there will ever be — and mostly there are none.
const SCOUTABLE = new Set(["gameflip", "ggsel", "digiseller"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Which game is this listing for?
//
// NOT `set.game` — that field is empty on every single active listing (measured
// 2026-09-08: 0 of 1184). The game lives on the set's ITEMS, and for the rest
// only in the title. Getting this wrong is silent and total: with no game there
// is no rival search, so every listing falls back to "no comparable rivals" and
// the whole competitor half of the pricing does nothing.
const TITLE_GAME_RE = /^\s*(?:[^\w]*\s*)?(.+?)\s+twitch\s+(?:drops?|bundle)/i;

function gameOf(l) {
  if (l.unclaimedGame) return String(l.unclaimedGame).trim();
  const items = (l.set && l.set.items) || [];
  for (const i of items) {
    if (i && i.game) return String(i.game).trim();
  }
  // Title prefix. Measured to resolve 1142 of the 1164 listings that carry
  // neither of the above (98%).
  const m = String(l.title || "").match(TITLE_GAME_RE);
  return m ? m[1].trim() : "";
}

function itemCountOf(l) {
  if ((l.requiredDrops || []).length) {
    return l.requiredDrops.reduce((n, d) => n + (Number(d.qty) || 1), 0);
  }
  const items = (l.set && l.set.items) || [];
  if (items.length) return items.reduce((n, i) => n + (Number(i.qty) || 1), 0);
  return mpx.parseAdvertisedCount(l.title);
}

async function main() {
  const onlyMarket = arg("marketplace");
  const onlyGame = arg("game");

  const q = { status: "active", autoPaused: { $ne: true } };
  if (onlyMarket) q.marketplace = onlyMarket;
  const listings = await MarketplaceListing.find(q)
    .populate("set", "game items name")
    .lean();
  const rows = listings.filter(
    (l) => !onlyGame || gameOf(l).toLowerCase().includes(onlyGame.toLowerCase()),
  );
  console.log("active listings in scope: " + rows.length + "\n");

  // --- our own realised price, per marketplace ------------------------------
  // Two independent trails, because neither is complete on its own: SaleSignal
  // records manual and automatic sales alike but only started carrying a
  // marketplace in Aug 2026, while a sold MarketplaceListing carries its market
  // by construction but only covers rows that were sold THROUGH a listing.
  const ownByMarket = {};
  const push = (m, p) => {
    if (!m || !(p > 0)) return;
    (ownByMarket[m] = ownByMarket[m] || []).push(p);
  };
  for (const s of await SaleSignal.find(
    { source: "listing_sold", priceUsd: { $gt: 0 }, marketplace: { $nin: ["", null] } },
    { marketplace: 1, priceUsd: 1 },
  ).lean()) {
    push(s.marketplace, s.priceUsd);
  }
  for (const l of await MarketplaceListing.find(
    { status: "sold", price: { $gt: 0 } },
    { marketplace: 1, price: 1 },
  ).lean()) {
    push(l.marketplace, l.price);
  }

  console.log("=== OUR OWN REALISED PRICES, PER MARKET ===");
  for (const [m, ps] of Object.entries(ownByMarket).sort()) {
    const b = mpx.band(ps);
    console.log(
      "  " + m.padEnd(15) + "n=" + String(b.n).padStart(4) +
        "  min $" + b.min + "  median $" + b.median + "  max $" + b.max,
    );
  }
  const silent = [...new Set(rows.map((r) => r.marketplace))].filter((m) => !ownByMarket[m]);
  if (silent.length) {
    console.log(
      "\n  NO priced sale has EVER been recorded on: " + silent.join(", ") +
        "\n  Any price there is inference, not evidence.",
    );
  }

  // --- rival prices, one game at a time -------------------------------------
  let ownerId = "";
  try {
    ownerId = await mp.gameflipOwnerId();
  } catch {
    /* falls back to "no filter", which is reported below */
  }
  console.log(
    "\ngameflip owner id: " + (ownerId || "(EMPTY — our own rows cannot be excluded from rival stats)"),
  );

  // Scout the games that actually carry listings, busiest first, and stop at a
  // budget. Each game is three scraped marketplace pages plus a politeness gap,
  // so scouting all ~60 would take the better part of an hour and hammer three
  // live sites. Whatever is not scouted is REPORTED as unscouted rather than
  // quietly scored as "no rivals" — a silent cap reads as full coverage.
  const byGameCount = new Map();
  for (const l of rows) {
    const g = gameOf(l);
    if (g) byGameCount.set(g, (byGameCount.get(g) || 0) + 1);
  }
  const budget = Math.max(1, parseInt(arg("games"), 10) || 12);
  const ranked = [...byGameCount.entries()].sort((a, b) => b[1] - a[1]);
  const games = ranked.slice(0, budget).map(([g]) => g);
  const skipped = ranked.slice(budget);
  const rivalsByGame = new Map();
  console.log(
    "\n" + byGameCount.size + " game(s) carry listings; scouting the top " +
      games.length + " by listing count, serially…",
  );
  if (skipped.length) {
    console.log(
      "  NOT scouted (" + skipped.length + " game(s), " +
        skipped.reduce((n, [, c]) => n + c, 0) + " listings): " +
        skipped.slice(0, 12).map(([g, c]) => g + " (" + c + ")").join(", ") +
        (skipped.length > 12 ? ", …" : "") +
        "\n  Raise --games N to cover more.",
    );
  }
  for (const g of games) {
    try {
      const res = await scout.competitorPrices({ term: g + " Twitch Drops" });
      const flat = [];
      for (const [m, d] of Object.entries(res || {})) {
        for (const x of d.listings || []) flat.push({ ...x, marketplace: m });
      }
      rivalsByGame.set(g, flat);
      process.stderr.write("  " + g + ": " + flat.length + " rival row(s)\n");
    } catch (e) {
      rivalsByGame.set(g, []);
      process.stderr.write("  " + g + ": scout failed (" + e.message + ")\n");
    }
    // Gameflip has a silent rate limiter and the others are scraped pages.
    // Serial with a gap is the whole politeness budget here.
    await sleep(2500);
  }

  // --- the verdicts ---------------------------------------------------------
  const out = [];
  for (const l of rows) {
    const game = gameOf(l);
    const scouted = rivalsByGame.has(game);
    const all = rivalsByGame.get(game) || [];
    const rivalRows = SCOUTABLE.has(l.marketplace)
      ? all.filter((r) => r.marketplace === l.marketplace)
      : [];
    const r = mpx.recommend({
      marketplace: l.marketplace,
      currentPrice: l.price,
      itemCount: itemCountOf(l),
      title: l.title,
      rivalRows,
      ownerId,
      ownSales: ownByMarket[l.marketplace] || [],
      floorUsd: FLOORS[l.marketplace] || 0,
    });
    out.push({
      id: String(l._id),
      externalId: l.externalId,
      marketplace: l.marketplace,
      origin: l.origin,
      game,
      title: l.title,
      items: itemCountOf(l),
      current: l.price,
      scouted,
      ...r,
    });
  }

  const shown = has("overpriced") ? out.filter((o) => o.verdict === "overpriced") : out;

  console.log("\n\n=== PER-MARKET SUMMARY ===");
  const byMarket = {};
  for (const o of out) {
    const b = (byMarket[o.marketplace] = byMarket[o.marketplace] || {
      n: 0, over: 0, under: 0, ok: 0, unpriceable: 0, delta: 0, unscouted: 0,
    });
    b.n += 1;
    b[o.verdict] = (b[o.verdict] || 0) + 1;
    if (o.basis === "unpriceable") b.unpriceable += 1;
    if (!o.scouted) b.unscouted += 1;
    if (o.verdict === "overpriced") b.delta += o.current - o.price;
  }
  for (const [m, b] of Object.entries(byMarket).sort()) {
    console.log(
      "  " + m.padEnd(15) + "listings " + String(b.n).padStart(4) +
        "   overpriced " + String(b.overpriced || 0).padStart(4) +
        "   underpriced " + String(b.underpriced || 0).padStart(4) +
        "   ok " + String(b.ok || 0).padStart(4) +
        "   no-evidence " + String(b.unpriceable).padStart(4) +
        "   rivals-unscouted " + String(b.unscouted).padStart(4) +
        (b.overpriced ? "   (asking $" + b.delta.toFixed(2) + " above the evidence)" : ""),
    );
  }

  const over = out.filter((o) => o.verdict === "overpriced").sort((a, b) => b.current - a.current);
  if (over.length) {
    console.log("\n\n=== OVERPRICED (" + over.length + ") — most expensive first ===");
    for (const o of over.slice(0, 40)) {
      console.log(
        "\n  " + o.marketplace + " " + o.externalId + "  $" + o.current +
          " -> $" + o.price + "   [" + o.origin + "]",
      );
      console.log("      " + String(o.title || "").slice(0, 92));
      console.log(
        "      " + o.reason +
          (o.rivals.n
            ? "; rivals n=" + o.rivals.n + " (" + o.rivals.scope + ") median $" +
              o.rivals.median + " p75 $" + o.rivals.p75
            : "; no comparable rivals"),
      );
    }
  }

  const jsonPath = arg("json");
  if (jsonPath) {
    require("node:fs").writeFileSync(jsonPath, JSON.stringify(shown, null, 1));
    console.log("\nwrote " + shown.length + " row(s) to " + jsonPath);
  }
  console.log(
    "\n\nNOTHING WAS REPRICED. Changing a live price is a marketplace operation " +
      "(delist/republish, irreversible on Digiseller), so it is a separate step.\n",
  );
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, {});
  try {
    await main();
  } finally {
    await mongoose.disconnect();
  }
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
