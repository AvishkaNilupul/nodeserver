#!/usr/bin/env node
// Audit every live listing for the no-claim rule, across ALL marketplaces.
//
//   node scripts/noclaim-listing-audit.js              # report only
//   node scripts/noclaim-listing-audit.js --apply      # delist the unfulfillable
//   node scripts/noclaim-listing-audit.js --apply --market=gameflip
//
// THE RULE: Overwatch, Rainbow Six and Call of Duty drops must reach the buyer
// UNCLAIMED, so they can press Connect and claim to their OWN game account. The
// regular auto-farm CLAIMS as it farms, so its Drop Archive accounts are the
// wrong stock for those games — that is the whole reason the no-claim farm
// exists. Eldorado and PlayerAuctions guard this at publish and at delivery;
// Gameflip, GGSel, Digiseller, ZeusX, EpicNPC and FunPay do not.
//
// WHY THIS DOES NOT DELIST ON GAME NAME ALONE
// A listing for a no-claim game is only broken if it cannot actually be
// honoured. Some may still be backed by accounts whose drops happen to be
// unclaimed. So each candidate is tested the way DELIVERY tests it — do any
// accounts still hold the advertised set UNCLAIMED? — and only a listing with
// ZERO deliverable accounts is proposed for delisting. Anything still
// fulfillable is reported and left alone.
//
// EpicNPC has no delist API (it is a browser bridge), so those are reported for
// the operator to remove by hand rather than silently marked done.
require("dotenv").config();
const mongoose = require("mongoose");

const mp = require("../utils/marketplaces");
const { isNoClaimGame } = require("../utils/settings");
const { unclaimedOnly } = require("../utils/playerauctionsFulfiller");
const { loginsOnActiveListings, notListed } = require("../utils/listedLogins");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ONLY = (args.find((a) => a.startsWith("--market=")) || "").split("=")[1] || "";
const DELAY_MS = parseInt(
  (args.find((a) => a.startsWith("--delay=")) || "").split("=")[1] || "1500",
  10,
);

// Markets we can take a listing down on programmatically.
const DELISTERS = {
  gameflip: (r) => mp.gameflipDelist(r.externalId),
  ggsel: (r) => mp.ggselDelist(r.externalId),
  zeusx: (r) => mp.zeusxDelist(r.externalId),
  eldorado: (r) => mp.eldoradoDelist(r.externalId),
  funpay: (r) => mp.funpayDelist(r.externalId, r.externalNode),
  playerauctions: (r) => mp.playerauctionsDelist(r.externalId),
};

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const MarketplaceListing = require("../models/MarketplaceListing");
  const DropSet = require("../models/DropSet");
  const { availableAccountsForSet } = require("../routes/shopRoutes");

  const q = { status: "active" };
  if (ONLY) q.marketplace = ONLY;
  const rows = await MarketplaceListing.find(q).lean();

  const listedLogins = await loginsOnActiveListings();
  const findings = [];

  for (const row of rows) {
    // A row fed by the no-claim farm is correct by construction.
    if (row.unclaimedGame) continue;
    const set = row.set ? await DropSet.findById(row.set).lean() : null;
    const game =
      (set && (set.coverGame || ((set.items || []).find((i) => i.game) || {}).game)) || "";
    if (!isNoClaimGame(game)) continue;

    // The delivery question, asked exactly as delivery asks it.
    let deliverable = 0;
    if (set) {
      const cands = notListed(
        await availableAccountsForSet(set).catch(() => []),
        listedLogins,
      ).slice(0, 60);
      deliverable = (await unclaimedOnly(set, cands)).length;
    }
    findings.push({
      row,
      game,
      title: row.title || (set && set.name) || "",
      deliverable,
      broken: deliverable === 0,
    });
  }

  const broken = findings.filter((f) => f.broken);
  const ok = findings.filter((f) => !f.broken);

  const byMarket = {};
  for (const f of findings) {
    const m = (byMarket[f.row.marketplace] = byMarket[f.row.marketplace] || { broken: 0, ok: 0 });
    m[f.broken ? "broken" : "ok"]++;
  }

  console.log("no-claim listings found: " + findings.length);
  console.log("  UNFULFILLABLE (0 accounts hold the set unclaimed): " + broken.length);
  console.log("  still fulfillable, leaving alone:                  " + ok.length);
  console.log("\nmarket        unfulfillable   fulfillable");
  for (const [m, v] of Object.entries(byMarket)) {
    console.log("  " + m.padEnd(14) + String(v.broken).padStart(8) + String(v.ok).padStart(14));
  }

  if (ok.length) {
    console.log("\nLEFT ALONE — these can still be honoured:");
    for (const f of ok.slice(0, 20)) {
      console.log(
        "  " + f.row.marketplace.padEnd(12) + String(f.deliverable).padStart(4) +
          " deliverable  " + String(f.title).slice(0, 52),
      );
    }
  }

  console.log("\nUNFULFILLABLE:");
  for (const f of broken) {
    const can = DELISTERS[f.row.marketplace] ? "" : "   (no delist API — remove by hand)";
    console.log(
      "  " + f.row.marketplace.padEnd(12) + f.game.padEnd(20) +
        String(f.title).slice(0, 44) + can,
    );
  }

  if (!APPLY) {
    console.log("\nDRY RUN — nothing delisted. Re-run with --apply.");
    await mongoose.disconnect();
    return;
  }

  let done = 0;
  let manual = 0;
  let failed = 0;
  for (const f of broken) {
    const fn = DELISTERS[f.row.marketplace];
    const row = await MarketplaceListing.findById(f.row._id);
    if (!fn) {
      manual++;
      row.lastError =
        "no-claim game (" + f.game + ") with no unclaimed stock — needs removing by hand";
      await row.save();
      continue;
    }
    try {
      await fn(f.row);
      row.status = "delisted";
      row.lastError =
        "delisted: " + f.game + " is a no-claim game and no account still holds this set unclaimed";
      await row.save();
      done++;
      console.log("delisted  " + f.row.marketplace.padEnd(12) + String(f.title).slice(0, 50));
    } catch (e) {
      // "already gone / already sold" is not a failure: the listing is off sale,
      // which is what was asked.
      const outcome = mp.delistOutcome(e.message);
      if (outcome) {
        row.status = outcome === "sold" ? "sold" : "delisted";
        row.lastError = "";
        await row.save();
        done++;
        continue;
      }
      failed++;
      console.error("FAIL      " + f.row.marketplace + " " + f.row.externalId + ": " + e.message);
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  console.log(
    "\ndelisted=" + done + "  needs-manual-removal=" + manual + "  failed=" + failed,
  );
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
