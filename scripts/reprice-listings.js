#!/usr/bin/env node
// Reprice LIVE auto-farmed marketplace listings against the shared pricing
// engine (utils/pricing.js).
//
//   node scripts/reprice-listings.js                        # dry run (default)
//   node scripts/reprice-listings.js --market=ggsel          # scope to one market
//   node scripts/reprice-listings.js --direction=up          # only raise prices
//   node scripts/reprice-listings.js --apply --limit=50      # write, capped
//   node scripts/reprice-listings.js --apply --titles        # also fix over-claiming titles
//
// This moves REAL prices on REAL marketplaces, so every guard below is load
// bearing. Read them before widening anything.
//
// RENT-FARM ROWS ARE NEVER REPRICED
// The owner's rule, 2026-09-09: "ggsell market is so cheap so we have to be as
// well BUT renter listings are same price." An "Automatic Farming 180 days" row
// sells a farming WINDOW, not stock; it has its own price level (rivals ask
// $4.99-$6.00 where drop bundles sit under $1), and the engine's evidence
// buckets are full of drop-bundle money that would drag it to a fraction of what
// it is worth. Today every farm row happens to be origin:"manual" and delisted,
// so the owner boundary below already covers them — that is luck, not a rule,
// and the next auto-published farm row would have been repriced. So the kind is
// checked explicitly, on top of the origin filter.
//
// THE OWNER BOUNDARY — origin:"auto" ONLY
// The owner's hand-made listings are their own stock at their own price and are
// NEVER touched, even when they sit on the same DropSet as an auto row. Rows
// with origin "unclaimed" are excluded too: the unclaimed farm has its own
// pricer with a sold-floor rule (utils/unclaimedAutoList.js repriceUnclaimedRows)
// and its own settings, and must not be driven from two engines at once.
// The filter enforces this, and it is RE-CHECKED per row at the point of use --
// the same belt-and-braces pattern utils/autoLister.js uses for its markup,
// because a later refactor that widens the query must not silently widen this.
//
// PER-PLATFORM DELIVERY
//   gameflip    gameflipReprice          PATCH, in place
//   digiseller  digisellerRepriceProducts bulk price API (its *text* has no edit
//                                         API, but price does -- no republish)
//   ggsel       ggselUpdateOffer          PATCH, and it takes ROUBLES
//   zeusx       zeusxUpdateOffer          read-modify-write of the whole offer
// Nothing here delists or republishes: every path is an in-place update, so a
// wrong price is correctable by running again rather than being irreversible.
//
// TITLES (--titles) are only ever corrected when the live title claims MORE
// items than the account actually holds. Those over-promise and are a genuine
// dispute risk. Titles that UNDER-claim are safe for the buyer and are left
// alone -- rewriting ~114 of them would be churn for no protection.
require("dotenv").config();
const mongoose = require("mongoose");

const mp = require("../utils/marketplaces");
const pricing = require("../utils/pricing");
const { classifyKind } = require("../utils/marketPricing");
const evidence = require("../utils/pricingEvidence");
const { logEvent } = require("../utils/systemLog");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const TITLES = args.includes("--titles");
const ONLY = (args.find((a) => a.startsWith("--market=")) || "").split("=")[1] || "";
const DIRECTION = (args.find((a) => a.startsWith("--direction=")) || "").split("=")[1] || "both";
const LIMIT = Number((args.find((a) => a.startsWith("--limit=")) || "").split("=")[1]) || 0;
const DRIFT_PCT = Number((args.find((a) => a.startsWith("--drift=")) || "").split("=")[1]) || 20;
// Pace against every marketplace's rate limiter. Gameflip has a silent one.
const DELAY_MS = Number((args.find((a) => a.startsWith("--delay=")) || "").split("=")[1]) || 1200;
// Stop the run if this many consecutive writes fail — a systemic problem
// (expired token, rate-limit wall) must not burn through 700 listings.
const MAX_CONSECUTIVE_FAILURES = 8;

const SUPPORTED = new Set(["gameflip", "digiseller", "ggsel", "zeusx"]);

// GGSel refuses a price below its per-CATEGORY minimum, which it publishes
// nowhere — not on the offer, not on /categories. The refusal is the only way to
// learn it. Treated as a FACT ABOUT THE PLATFORM rather than as a failure: the
// row is fine, the price we asked for simply does not exist here, and retrying
// it every run would leave a healthy listing permanently carrying an error.
const CATEGORY_MIN_RE = /less than the category minimum price/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function categoryFor(set) {
  for (const item of (set && set.items) || []) {
    const game = String(item.game || "").trim();
    if (game) return game;
  }
  return "";
}

function itemCounts(set) {
  const items = (set && set.items) || [];
  return {
    distinct: items.length,
    total: items.reduce((sum, i) => sum + Math.max(1, Number(i.qty) || 1), 0),
  };
}

/** True only when the row is an auto-farmed listing we are allowed to move. */
function isAutoOwned(row) {
  return !!row && row.origin === "auto";
}

/**
 * Does the title claim MORE items than the set holds? Only those are corrected.
 * A title matching either convention (distinct or qty-summed) is honest.
 */
function overClaims(title, set) {
  const m = String(title || "").match(/\((\d+)\s*Items?\s*\+?\)/i);
  if (!m) return null;
  const claimed = Number(m[1]);
  const { distinct, total } = itemCounts(set);
  if (claimed === distinct || claimed === total) return null;
  if (claimed <= Math.max(distinct, total)) return null; // under-claims: leave it
  return { claimed, distinct, total };
}

function correctedTitle(title, set) {
  const { total } = itemCounts(set);
  return String(title || "").replace(
    /\((\d+)\s*(Items?)\s*\+?\)/i,
    (_all, _n, word) => "(" + total + " " + word + ")",
  );
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const DropSet = require("../models/DropSet");
  const MarketplaceListing = require("../models/MarketplaceListing");
  const MarketResearch = require("../models/MarketResearch");

  const filter = {
    status: "active",
    origin: "auto", // the owner boundary — see the header
    marketplace: ONLY ? ONLY : { $in: [...SUPPORTED] },
  };
  const rows = await MarketplaceListing.find(filter).lean();
  const setIds = [
    ...new Set(rows.map((r) => String(r.set || "")).filter((id) => /^[a-f0-9]{24}$/i.test(id))),
  ];
  const sets = await DropSet.find({ _id: { $in: setIds } }).lean();
  const setById = new Map(sets.map((s) => [String(s._id), s]));
  const research = await MarketResearch.find({}).lean();
  const researchByGame = new Map(research.map((r) => [String(r.game || "").toLowerCase(), r]));

  const snap = await evidence.snapshot({ force: true });
  console.log(
    "evidence: " +
      snap.counts.signals +
      " priced signals, " +
      snap.counts.soldListings +
      " sold listings, " +
      snap.counts.games +
      " games",
  );
  console.log(
    "candidates: " +
      rows.length +
      " active auto rows" +
      (ONLY ? " on " + ONLY : "") +
      "  |  drift>=" +
      DRIFT_PCT +
      "%  |  direction=" +
      DIRECTION +
      (APPLY ? "  |  APPLYING" : "  |  dry run"),
  );

  // GGSel prices in roubles. Resolve the rate ONCE; without it, GGSel rows are
  // skipped rather than sent a USD number that would read as ~90x too cheap.
  let rubRate = 0;
  if (rows.some((r) => r.marketplace === "ggsel")) {
    try {
      rubRate = Number(await mp.usdToRub()) || 0;
    } catch {
      rubRate = 0;
    }
    console.log(
      rubRate
        ? "ggsel: USD→RUB rate " + rubRate.toFixed(2) + "₽/$"
        : "ggsel: NO RUB RATE — ggsel rows will be skipped",
    );
  }

  const plan = [];
  let farmSkipped = 0;
  for (const row of rows) {
    const set = setById.get(String(row.set || ""));
    if (!set) continue;
    // A farming window is a different product at a different price level, and
    // its price is the owner's to set. See the header.
    if (classifyKind(row.title) === "farm") {
      farmSkipped++;
      continue;
    }
    // Already told no at or above this price — see CATEGORY_MIN_RE. Asking
    // again cannot succeed and only re-stamps an error on a healthy row.
    const venueMin = Number(row.venueMinPriceUsd) || 0;
    const game = categoryFor(set);
    const { total } = itemCounts(set);
    const out = pricing.priceListing({
      evidence: await evidence.evidenceFor({
        game,
        marketplace: row.marketplace,
        research: researchByGame.get(game.toLowerCase()),
      }),
      itemCount: total,
      soldFloorUsd: Number(set.minPriceUsd) || 0,
      marketplace: row.marketplace,
    });
    const current = Number(row.price) || 0;
    let target = out.price;
    if (venueMin > 0 && target < venueMin) {
      // Hold at the lowest price the platform has actually accepted rather than
      // skipping the row outright: if the engine now wants LESS than the venue
      // allows, the venue floor is the answer, and it may still be below what
      // the row costs today.
      target = venueMin;
    }
    const driftPct = current > 0 ? ((target - current) / current) * 100 : 0;
    const wants =
      pricing.shouldReprice(current, target, DRIFT_PCT) &&
      Math.abs(target - current) >= 0.01 &&
      (DIRECTION === "both" ||
        (DIRECTION === "up" && target > current) ||
        (DIRECTION === "down" && target < current));
    const badTitle = TITLES ? overClaims(row.title, set) : null;
    if (!wants && !badTitle) continue;
    plan.push({
      row,
      set,
      game,
      current,
      target,
      driftPct,
      basis: out.basis,
      clamped: out.clamped,
      reprice: wants,
      badTitle,
      newTitle: badTitle ? correctedTitle(row.title, set) : "",
    });
  }

  plan.sort((a, b) => Math.abs(b.driftPct) - Math.abs(a.driftPct));
  const work = LIMIT ? plan.slice(0, LIMIT) : plan;

  const byMarket = {};
  for (const p of work) {
    const k = p.row.marketplace;
    byMarket[k] = byMarket[k] || { n: 0, up: 0, down: 0, titles: 0 };
    byMarket[k].n++;
    if (p.reprice && p.target > p.current) byMarket[k].up++;
    if (p.reprice && p.target < p.current) byMarket[k].down++;
    if (p.badTitle) byMarket[k].titles++;
  }
  console.log("\n=== plan ===");
  for (const [m, v] of Object.entries(byMarket)) {
    console.log(
      "  " + m.padEnd(12) + " " + String(v.n).padStart(4) + " rows" +
        "   raise " + String(v.up).padStart(3) +
        "   lower " + String(v.down).padStart(3) +
        (v.titles ? "   titles " + v.titles : ""),
    );
  }
  console.log("  " + "TOTAL".padEnd(12) + " " + String(work.length).padStart(4) + " rows");
  if (farmSkipped) {
    console.log(
      "  " + "(skipped".padEnd(12) + " " + String(farmSkipped).padStart(4) +
        " rent-farm row(s) — priced by hand, never by the engine)",
    );
  }

  console.log("\n--- 25 largest moves ---");
  for (const p of work.slice(0, 25)) {
    console.log(
      "  " + p.row.marketplace.padEnd(11) +
        "$" + p.current.toFixed(2).padStart(7) +
        " -> $" + p.target.toFixed(2).padStart(6) +
        " (" + (p.driftPct >= 0 ? "+" : "") + p.driftPct.toFixed(0).padStart(4) + "%)" +
        "  " + p.basis.padEnd(13) +
        (p.badTitle ? "[title " + p.badTitle.claimed + "->" + p.badTitle.total + "] " : "") +
        String(p.row.title || p.set.name || "").slice(0, 42),
    );
  }

  if (!APPLY) {
    console.log("\n  dry run — nothing written. Re-run with --apply.");
    await mongoose.disconnect();
    return;
  }

  let ok = 0;
  let failed = 0;
  let skipped = 0;
  let consecutive = 0;
  // How many ZeusX updates reported failure but had actually been applied.
  let zeusxLyingErrors = 0;
  // GGSel updates that errored but read back at the intended price.
  let ggselUnverifiedOk = 0;
  // Rows whose target sat below GGSel's undisclosed per-category minimum.
  let categoryFloored = 0;
  const errors = [];

  for (const p of work) {
    const row = p.row;
    // Re-check the owner boundary at the point of use. The query already
    // enforced it; this catches a future refactor that widens the filter.
    if (!isAutoOwned(row)) {
      skipped++;
      continue;
    }
    const price = p.reprice ? p.target : Number(row.price) || 0;
    const title = p.badTitle ? p.newTitle : null;
    try {
      if (row.marketplace === "gameflip") {
        const patch = {};
        if (p.reprice) patch.priceUsd = price;
        if (title) patch.title = title;
        await mp.gameflipReprice(row.externalId, patch);
      } else if (row.marketplace === "digiseller") {
        if (p.reprice) {
          const r = await mp.digisellerRepriceProducts([
            { productId: row.externalId, priceUsd: price },
          ]);
          if (r && r.failed) {
            throw new Error((r.errors && r.errors[0]) || "digiseller reprice failed");
          }
        }
        // Digiseller has no edit-text API; a title fix there needs a republish,
        // which would churn contentIds and the per-unit bookkeeping. Reported,
        // not attempted.
        if (title) {
          errors.push(row.externalId + " (digiseller): title needs manual fix — no edit-text API");
        }
      } else if (row.marketplace === "ggsel") {
        if (!rubRate) {
          skipped++;
          continue;
        }
        const wantRub = Math.ceil(price * rubRate);
        const patch = {};
        if (p.reprice) patch.priceRub = wantRub;
        if (title) patch.title = title;
        // GGSel is unreliable about reporting success too, but differently from
        // ZeusX: the canary got a raw nginx `504 Gateway Time-out`, where the
        // update genuinely may or may not have landed. Guessing either way is
        // wrong — recording success would risk a DB price the offer does not
        // have, and recording failure would leave a real price change untracked.
        // So read the price back and let GGSel's own state decide.
        try {
          await mp.ggselUpdateOffer(row.externalId, patch);
          } catch (gerr) {
          if (CATEGORY_MIN_RE.test(String((gerr && gerr.message) || gerr))) {
            // Learn the floor and move on. The row keeps the price it has, which
            // the platform has already accepted, and no error is stamped on it.
            await MarketplaceListing.updateOne(
              { _id: row._id },
              { $set: { venueMinPriceUsd: p.current, lastError: "" } },
            ).catch(() => {});
            categoryFloored++;
            continue;
          }
          const live = await mp.ggselOfferPrice(row.externalId).catch(() => null);
          // Compare in roubles, with a 1₽ tolerance for their rounding.
          if (!(p.reprice && live != null && Math.abs(live - wantRub) <= 1)) throw gerr;
          ggselUnverifiedOk++;
        }
      } else if (row.marketplace === "zeusx") {
        const patch = {};
        if (p.reprice) patch.priceUsd = price;
        if (title) patch.title = title;
        // ZeusX LIES ABOUT FAILURE. It returns "Internal server error" for
        // updates it has actually applied — the same shape as its create-offer
        // path, which 500s and still creates the offer. Caught on the very
        // first canary here: three updates all reported failure and all three
        // offers read back at the new price.
        //
        // Trusting the status code would have written lastError onto rows that
        // were fine and left MarketplaceListing.price disagreeing with the live
        // offer — the DB saying $0.75 while ZeusX charged $1.84. So on ANY
        // error, read the offer back and let the marketplace's own state decide.
        try {
          await mp.zeusxUpdateOffer(row.externalId, patch);
        } catch (zerr) {
          const applied = await mp
            .zeusxOffer(row.externalId)
            .then((o) => Math.abs((Number(o && o.listed_price) || 0) - price) < 0.01)
            .catch(() => false);
          if (!applied) throw zerr;
          zeusxLyingErrors++;
        }
      } else {
        skipped++;
        continue;
      }

      const set$ = { lastError: "" };
      if (p.reprice) set$.price = price;
      if (title && row.marketplace !== "digiseller") set$.title = title;
      await MarketplaceListing.updateOne({ _id: row._id }, { $set: set$ }).catch(() => {});
      ok++;
      consecutive = 0;
      logEvent({
        category: "listings",
        action: "repriced",
        actor: "reprice-listings",
        subject: String(row.externalId || row._id),
        game: p.game,
        detail:
          row.marketplace +
          (p.reprice
            ? " $" + p.current.toFixed(2) + " → $" + price.toFixed(2) +
              " (" + (p.driftPct >= 0 ? "+" : "") + p.driftPct.toFixed(0) + "%, " + p.basis + ")"
            : "") +
          (title ? " title " + p.badTitle.claimed + "→" + p.badTitle.total + " items" : ""),
      });
    } catch (e) {
      failed++;
      consecutive++;
      errors.push(row.marketplace + " " + row.externalId + ": " + e.message);
      await MarketplaceListing.updateOne(
        { _id: row._id },
        { $set: { lastError: "reprice: " + e.message } },
      ).catch(() => {});
      if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
        console.error(
          "\n!! " + consecutive + " consecutive failures — stopping. " +
            "This looks systemic (expired token or a rate-limit wall), not per-listing.",
        );
        break;
      }
    }
    await sleep(DELAY_MS);
  }

  console.log("\n=== result ===");
  console.log("  repriced/updated:", ok);
  console.log("  failed          :", failed);
  console.log("  skipped         :", skipped);
  if (categoryFloored) {
    console.log(
      "  ggsel floors   :", categoryFloored,
      "row(s) sat below GGSel's per-category minimum — floor recorded, price left as is",
    );
  }
  if (ggselUnverifiedOk) {
    console.log(
      "  ggsel timeouts  :", ggselUnverifiedOk,
      "(errored, but the offer read back at the intended price)",
    );
  }
  if (zeusxLyingErrors) {
    console.log(
      "  zeusx false-fails:", zeusxLyingErrors,
      "(reported an error, but the offer read back at the new price)",
    );
  }
  if (errors.length) {
    console.log("\n  first errors:");
    for (const e of errors.slice(0, 15)) console.log("   ", e);
    if (errors.length > 15) console.log("    ... and " + (errors.length - 15) + " more");
  }
  evidence.invalidate();
  await mongoose.disconnect();
}

// The guards that decide WHICH live listings get touched are the risky part, so
// they are exported and unit-tested (tests/repriceListings.test.js) rather than
// buried in the run. Only execute when invoked directly.
module.exports = { isAutoOwned, overClaims, correctedTitle, itemCounts, categoryFor };

if (require.main === module) {
  main().catch((err) => {
    console.error("reprice failed:", err.message);
    process.exit(1);
  });
}
