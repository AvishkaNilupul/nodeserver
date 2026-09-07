#!/usr/bin/env node
// Link the offers already live on Z2U to the stock behind them.
//
//   node scripts/z2u-adopt.js            # dry run — prints what it would link
//   node scripts/z2u-adopt.js --apply
//
// The offers on Z2U were all created by hand, so the database has never known
// they exist. That is why nothing can verify their stock, nothing can deliver
// them, and the shelf keeper leaves every one of them alone: an offer with no
// listing row has no answer to "how many can we actually ship?", and guessing
// that answer is how an account ends up overselling. Measured on the real shelf
// 2026-09-08: 47 offers, 30 distinct products, 19 of which are the same product
// this site already sells elsewhere with its stock wired up.
//
// The mapping is never guessed from the title alone. A Z2U offer is adopted
// only when a listing on ANOTHER marketplace carries the same title AND names
// a stock source; that row's source is copied across. Anything else is
// reported, never invented — a wrong link delivers the wrong bundle, which
// costs more than a missed sale.
//
// THE RULE THAT MATTERS MOST is which of the two stock models a row gets:
//
//   * Overwatch, Rainbow Six and Call of Duty are NO-CLAIM games. Their drops
//     have to reach the buyer UNCLAIMED so they can connect them to their own
//     game account, and the ordinary auto-farm claims as it farms — so its Drop
//     Archive accounts are exactly the wrong stock for those games. They may
//     only ever be sold from the no-claim ledger (`unclaimedGame`).
//   * Everything else claims its exact DropSet out of the Drop Archive at
//     delivery time (`autoClaimSet`).
//
// Getting that backwards would hand a buyer an account whose drops are already
// claimed — worthless to them, and a guaranteed dispute.
require("dotenv").config();
const mongoose = require("mongoose");

const mp = require("../utils/marketplaces");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");

// Titles differ across shops by punctuation and casing far more often than by
// meaning, so compare on letters and digits alone — the same normalisation the
// fulfiller uses to match an order back to its listing.
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

async function main() {
  if (!(mp.keyStatus().z2u || {}).configured) {
    console.error("Z2U is not configured — paste the Cookie header first.");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const MarketplaceListing = require("../models/MarketplaceListing");
  const DropSet = require("../models/DropSet");
  const { isNoClaimGame } = require("../utils/settings");
  const ful = require("../utils/z2uFulfiller");

  const offers = await mp.z2uAllOffers();
  const existing = await MarketplaceListing.find({ marketplace: "z2u" }).lean();
  const havePk = new Set(existing.map((r) => String(r.externalId)));

  // Every row on any OTHER marketplace that knows where its stock comes from.
  // Newest first: an older row points at stock long since sold.
  const donors = await MarketplaceListing.find({
    marketplace: { $ne: "z2u" },
    $or: [{ set: { $ne: null } }, { unclaimedGame: { $nin: ["", null] } }],
  })
    .sort({ createdAt: -1 })
    .lean();
  const byTitle = new Map();
  for (const d of donors) {
    const k = norm(d.title);
    if (!k) continue;
    if (!byTitle.has(k)) byTitle.set(k, d);
  }

  const plan = [];
  const skipped = [];
  for (const offer of offers) {
    if (havePk.has(String(offer.pk))) {
      skipped.push([offer.title, "already linked"]);
      continue;
    }
    const donor = byTitle.get(norm(offer.title));
    if (!donor) {
      skipped.push([offer.title, "nothing on another marketplace shares this title"]);
      continue;
    }
    const set = donor.set ? await DropSet.findById(donor.set).lean() : null;
    const game =
      donor.unclaimedGame ||
      (set && (set.coverGame || ((set.items || []).find((i) => i.game) || {}).game)) ||
      "";
    if (!game) {
      skipped.push([offer.title, "cannot tell which game the donor listing is for"]);
      continue;
    }
    // The no-claim rule. Note it is decided by the GAME, not by which field the
    // donor happened to use: a donor row that sells Overwatch out of the Drop
    // Archive is itself wrong, and copying it would spread the mistake.
    const noClaim = isNoClaimGame(game);
    if (noClaim) {
      plan.push({ offer, donor, game, mode: "unclaimed", set: null });
      continue;
    }
    if (!set) {
      skipped.push([offer.title, "donor names no DropSet to claim from"]);
      continue;
    }
    plan.push({ offer, donor, game, mode: "archive", set });
  }

  // What each plan entry could actually ship today, counted the way the
  // delivery path counts it.
  for (const p of plan) {
    p.stock = await ful
      .realStockFor(
        {
          unclaimedGame: p.mode === "unclaimed" ? p.game : "",
          set: p.set ? p.set._id : null,
          externalId: p.offer.pk,
        },
        await require("../utils/listedLogins").loginsOnActiveListings(),
      )
      .catch(() => null);
  }

  console.log(
    "z2u offers=" + offers.length +
      "  already linked=" + existing.length +
      "  adoptable=" + plan.length +
      "  unmatched=" + skipped.length,
  );
  console.log("\nSTOCK  MODE       GAME            STATE    OFFER");
  for (const p of plan.sort((a, b) => (b.stock || 0) - (a.stock || 0))) {
    console.log(
      String(p.stock == null ? "?" : p.stock).padStart(5) +
        "  " + p.mode.padEnd(10) +
        String(p.game).slice(0, 15).padEnd(16) +
        String(p.offer.status).padEnd(9) +
        p.offer.title.slice(0, 46),
    );
  }
  if (skipped.length) {
    console.log("\nnot adopted (stay manual — nothing will touch them):");
    for (const [t, why] of skipped) {
      console.log("  - " + String(t).slice(0, 44).padEnd(46) + why);
    }
  }

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply.");
    await mongoose.disconnect();
    return;
  }

  let made = 0;
  for (const p of plan) {
    await MarketplaceListing.create({
      set: p.mode === "archive" ? p.set._id : undefined,
      marketplace: "z2u",
      externalId: String(p.offer.pk),
      // A Z2U offer can only be found again through its (service, game) list
      // page, so the pair has to be kept.
      externalNode: p.offer.service + ":" + p.offer.game,
      url: mp.z2uOfferUrl(p.offer.pk),
      title: p.offer.title,
      price: Number(p.offer.price) || 0,
      status: "active",
      // Hand-made on Z2U, so never repriced automatically — the same rule the
      // rest of the codebase applies to the operator's own listings.
      origin: "manual",
      autoClaimSet: p.mode === "archive",
      unclaimedGame: p.mode === "unclaimed" ? p.game : "",
      requiredDrops: p.donor.requiredDrops || [],
      note:
        "adopted from the live Z2U shelf; stock source copied from the " +
        p.donor.marketplace +
        " listing with the same title (" + p.donor.externalId + ")",
    });
    made++;
  }
  console.log("\nlinked " + made + " offer(s).");
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
