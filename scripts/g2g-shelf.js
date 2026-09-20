#!/usr/bin/env node
// What is really on the G2G shelf, and the one correction it is safe to make
// by hand.
//
//   node scripts/g2g-shelf.js                     # read-only — the shelf and the plan
//   node scripts/g2g-shelf.js --apply             # act on the plan
//   node scripts/g2g-shelf.js --apply --limit=3   # ease into it
//   node scripts/g2g-shelf.js --help
//
// G2G is the odd one out among the shops this site sells on: the account is
// already carrying dozens of offers and the database made none of them. Every
// one was typed into the seller panel by hand, so nothing here knows what stock
// stands behind them. That is why the census below separates MANAGED offers (a
// MarketplaceListing row names their stock source) from UNMANAGED ones, and why
// the unmanaged pile is reported as information rather than as a fault: an
// offer with no row has no answer to "how many can we actually ship?", and
// inventing one is how an account starts overselling.
//
// The only writes it will ever make are the two reversible ones:
//   * sync a managed offer's advertised quantity DOWN to what we could claim;
//   * take a managed offer off sale when we could claim nothing at all.
// G2G's delist is a STATUS change — the offer, its history and its sales count
// all survive it, and g2gRelist is its exact inverse. Nothing here deletes an
// offer, raises a quantity, or touches an offer with no listing row.
//
// Both writes are verified by reading the offer back, and the listing row is
// only updated once G2G has agreed: a 200 is not evidence that anything
// changed (ZeusX answers 500 on updates it applied and GGSel 504 on ones it did
// not), and a row that claims a change the platform did not make is worse than
// no row at all — the next run would report it as correct.
require("dotenv").config();
const mongoose = require("mongoose");

const mp = require("../utils/marketplaces");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const hit = args.find((a) => a.startsWith(f + "="));
  return hit ? hit.slice(f.length + 1) : d;
};
const APPLY = has("--apply");
const LIMIT = parseInt(val("--limit", "0"), 10) || 0;

// Distinct from every other platform's tag so one account can never be handed
// out twice across shops. Already present in utils/marketClaimTags.
const G2G_CLAIM_TAG = "g2g";

// The deepest slice of the no-claim ledger worth counting for one offer — the
// same ceiling the Eldorado bundles and the Z2U shelf use.
const STOCK_MAX = 200;

// One GET per managed row whose offer did not come back in the list. Bounded so
// a database full of stale rows can never turn a read-only audit into hundreds
// of calls against the live account.
const MAX_PROBES = 60;

const USAGE = [
  "g2g-shelf — audit the live G2G shelf against what we can actually ship.",
  "",
  "  node scripts/g2g-shelf.js                     read-only: the shelf + the plan",
  "  node scripts/g2g-shelf.js --apply             carry the plan out",
  "  node scripts/g2g-shelf.js --apply --limit=3   cap how many actions are taken",
  "  node scripts/g2g-shelf.js --limit=3           cap how many are planned",
  "",
  "Reads: seller identity + order counts, every offer on the account, and the",
  "MarketplaceListing rows whose marketplace is g2g.",
  "",
  "Writes (only with --apply, only on offers that HAVE a listing row):",
  "  set-qty   lower a managed offer's advertised quantity to real stock",
  "  delist    take a managed offer off sale when real stock is 0 (reversible)",
  "",
  "It never deletes an offer, never raises a quantity, and never touches an",
  "offer that no MarketplaceListing row manages.",
].join("\n");

function money(offer) {
  const price = Number(offer.unitPrice);
  return (
    (Number.isFinite(price) ? price.toFixed(2) : "-") +
    " " +
    String(offer.currency || "USD")
  );
}

function num(v) {
  return Number.isFinite(Number(v)) ? String(Number(v)) : "-";
}

// Why a managed row's offer did not come back. "Gone" and "unreadable" must
// stay separate: the first is a fact about G2G, the second is a fact about this
// run, and only one of them says anything about the row.
function missingOfferState(e) {
  const status = e && e.status;
  const msg = String((e && e.message) || "");
  if (status === 404 || /4041|not found|could not find/i.test(msg)) {
    return "gone from G2G";
  }
  return "unreadable (" + (msg.slice(0, 60) || "unknown") + ")";
}

// What the delivery path would actually be able to claim for one row right now.
//
// Returns null — NOT 0 — for a row with no stock source, because "we do not
// know" and "there is none" must lead to different actions: the first is left
// alone, the second comes off sale.
//
// The counting itself belongs to the fulfiller, so use its version when it is
// there; the fallback is the same composition the Z2U shelf uses — Eldorado's
// claim helpers run dry, stamped with the g2g tag — never a second copy of the
// claim logic, which is precisely what oversells accounts when it drifts.
function makeStockCounter(ful) {
  if (ful && typeof ful.realStockFor === "function") {
    return (row, listedElsewhere) => ful.realStockFor(row, listedElsewhere);
  }
  const DropSet = require("../models/DropSet");
  const { availableAccountsForSet } = require("../routes/shopRoutes");
  const { notListed } = require("../utils/listedLogins");
  const eld = require("../utils/eldoradoFulfiller");
  return async function realStockFor(row, listedElsewhere) {
    if (!row) return null;
    if (row.unclaimedGame) {
      const picked = await eld
        .claimUnclaimedForGame(row.unclaimedGame, STOCK_MAX, {
          dryRun: true,
          offerId: row.externalId,
          requiredDrops: row.requiredDrops,
          market: G2G_CLAIM_TAG,
        })
        .catch(() => []);
      return picked.length;
    }
    if (row.set) {
      const set = await DropSet.findById(row.set).lean();
      if (!set) return null;
      const avail = await availableAccountsForSet(set).catch(() => []);
      return notListed(avail, listedElsewhere || new Set()).length;
    }
    return null;
  };
}

async function main() {
  if (has("--help") || has("-h")) {
    console.log(USAGE);
    return;
  }
  if (!(mp.keyStatus().g2g || {}).configured) {
    console.error(
      "G2G is not configured. Paste the seller session (userId, accessToken,\n" +
        "refreshToken, activeDeviceToken) from a signed-in www.g2g.com tab under\n" +
        "Listings -> Marketplace keys -> G2G.",
    );
    process.exit(1);
  }
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error(
      "No MONGO_URI — this tool exists to compare the shelf with the listing\n" +
        "rows behind it, and without the database it can only reprint G2G.",
    );
    process.exit(1);
  }

  // ---- 1. who we are ----
  const probe = await mp.g2gTest();
  console.log("g2g: " + probe.detail);
  const counts = probe.data || (await mp.g2gOrderCounts()) || {};
  const shown = [
    "to_pay",
    "verifying_payment",
    "preparing",
    "delivering",
    "issues",
  ].filter((k) => counts[k] != null);
  if (shown.length) {
    console.log("orders: " + shown.map((k) => k + "=" + counts[k]).join("  "));
  }
  // preparing is paid-and-waiting. It is the operator's to deliver — this tool
  // has no delivery path and must not imply one.
  if (Number(counts.preparing) > 0) {
    console.log(
      "        " +
        counts.preparing +
        " order(s) are waiting on a hand delivery; nothing here delivers them.",
    );
  }

  await mongoose.connect(uri);
  const MarketplaceListing = require("../models/MarketplaceListing");
  let ful = null;
  try {
    ful = require("../utils/g2gFulfiller");
  } catch {
    // Not built yet, or not requireable — the fallback counter covers it.
  }
  const realStockFor = makeStockCounter(ful);

  // ---- 2. the shelf ----
  const offers = await mp.g2gListOffers({});
  const rows = await MarketplaceListing.find({ marketplace: "g2g" }).lean();
  // Any row at all means the offer is managed, whatever state the row is in: a
  // sold or delisted row still names the stock behind that offer.
  const byOfferId = new Map(rows.map((r) => [String(r.externalId), r]));
  const seenOfferIds = new Set(offers.map((o) => String(o.offerId)));

  // Group the shelf by game, so an account with many offers per brand reads as
  // the brand-by-brand list the seller panel refuses to give in one page.
  const shelfKey = (e) =>
    String(e.offer.brandId || "") + " " + String(e.offer.title || "");
  const entries = offers
    .map((offer) => ({
      offer,
      row: byOfferId.get(String(offer.offerId)) || null,
      realStock: null,
    }))
    .sort((a, b) => shelfKey(a).localeCompare(shelfKey(b)));

  console.log(
    "\n   " +
      "OFFER ID".padEnd(18) +
      "BRAND".padEnd(18) +
      "PRICE".padStart(11) +
      "QTY".padStart(5) +
      "RSV".padStart(5) +
      "  " +
      "STATUS".padEnd(10) +
      "TITLE",
  );
  for (const e of entries) {
    const o = e.offer;
    console.log(
      (e.row ? " * " : "   ") +
        String(o.offerId || "-").slice(0, 17).padEnd(18) +
        String(o.brandId || "-").slice(0, 17).padEnd(18) +
        money(o).padStart(11) +
        num(o.actualQty).padStart(5) +
        num(o.reservedQty).padStart(5) +
        "  " +
        String(o.status || "-").padEnd(10) +
        String(o.title || "").slice(0, 52),
    );
  }
  const live = entries.filter((e) => e.offer.status === mp.G2G_STATUS.LIVE);
  const managed = entries.filter((e) => e.row);
  console.log(
    "\n" +
      entries.length +
      " offer(s): " +
      live.length +
      " live, " +
      (entries.length - live.length) +
      " not live. " +
      managed.length +
      " managed (*), " +
      (entries.length - managed.length) +
      " unmanaged. " +
      rows.length +
      " listing row(s) on file.",
  );

  // ---- 3a. unmanaged: expected, and deliberately untouchable ----
  const unmanagedLive = live.filter((e) => !e.row);
  if (unmanagedLive.length) {
    console.log(
      "\n" +
        unmanagedLive.length +
        " LIVE offer(s) have no listing row. This is EXPECTED on this account —\n" +
        "the whole shelf was made by hand — and it is information, not an error.\n" +
        "Nothing can verify their stock or deliver them, and nothing in this tool\n" +
        "will ever change one:",
    );
    for (const e of unmanagedLive.slice(0, 40)) {
      console.log(
        "  " +
          String(e.offer.offerId).padEnd(18) +
          num(e.offer.actualQty).padStart(4) +
          "x  " +
          String(e.offer.title || "").slice(0, 58),
      );
    }
    if (unmanagedLive.length > 40) {
      console.log("  … and " + (unmanagedLive.length - 40) + " more");
    }
  }

  // ---- 3b. rows that say active but whose offer is not on sale ----
  const activeRows = rows.filter((r) => r.status === "active");
  const stale = [];
  let probes = 0;
  for (const r of activeRows) {
    const id = String(r.externalId);
    if (seenOfferIds.has(id)) {
      const e = entries.find((x) => String(x.offer.offerId) === id);
      if (e && e.offer.status !== mp.G2G_STATUS.LIVE) {
        stale.push({ row: r, state: "G2G status " + (e.offer.status || "?") });
      }
      continue;
    }
    // The offer did not come back in the list. That can mean deleted, or just
    // filtered out of the listing, so ask G2G about this one offer directly
    // rather than reporting a guess.
    if (probes >= MAX_PROBES) {
      stale.push({ row: r, state: "not in the list (not probed — cap reached)" });
      continue;
    }
    probes++;
    try {
      const back = await mp.g2gGetOffer(id);
      const st = String((back && back.status) || "?");
      if (st !== mp.G2G_STATUS.LIVE) {
        stale.push({ row: r, state: "G2G status " + st });
      }
    } catch (e) {
      stale.push({ row: r, state: missingOfferState(e) });
    }
  }
  if (stale.length) {
    console.log(
      "\nLISTING ROWS MARKED ACTIVE WHOSE OFFER IS NOT ON SALE (" +
        stale.length +
        "):",
    );
    for (const s of stale) {
      console.log(
        "  " +
          String(s.row.externalId).padEnd(18) +
          s.state.padEnd(34) +
          String(s.row.title || "").slice(0, 44),
      );
    }
    console.log(
      "  Reported only. An offer can be off sale because it was pulled by hand,\n" +
        "  because it sold out, or because the id is wrong — three causes with\n" +
        "  three different fixes, so relisting or resolving these is the\n" +
        "  operator's call, not this tool's.",
    );
  }

  // ---- 3c. what each managed offer could really ship ----
  //
  // The set of logins already on a live listing is read ONCE: it is a full scan
  // of every active listing on every marketplace, and asking for it inside the
  // loop makes a shared-tier Atlas re-run that scan per offer.
  const listedElsewhere = managed.length
    ? await require("../utils/listedLogins").loginsOnActiveListings()
    : new Set();
  for (const e of managed) {
    e.realStock = await realStockFor(e.row, listedElsewhere).catch(() => null);
  }

  const unknown = managed.filter((e) => e.realStock == null);
  if (unknown.length) {
    console.log(
      "\n" +
        unknown.length +
        " managed offer(s) name no stock source, so their real stock is unknown\n" +
        "and they are left exactly as they are:",
    );
    for (const e of unknown) {
      console.log(
        "  " +
          String(e.offer.offerId).padEnd(18) +
          String(e.offer.title || "").slice(0, 58),
      );
    }
  }

  const oversold = managed.filter(
    (e) =>
      e.realStock != null &&
      Number.isFinite(Number(e.offer.actualQty)) &&
      Number(e.offer.actualQty) > e.realStock,
  );
  if (oversold.length) {
    console.log("\nADVERTISED QTY > CLAIMABLE STOCK (" + oversold.length + "):");
    for (const e of oversold) {
      console.log(
        "  " +
          num(e.offer.actualQty).padStart(4) +
          " -> " +
          String(e.realStock).padEnd(5) +
          String(e.offer.offerId).padEnd(18) +
          String(e.offer.title || "").slice(0, 44),
      );
    }
  }

  // ---- 4. the plan ----
  //
  // Order is the policy: an offer we cannot back at all comes DOWN first. An
  // oversold offer costs a dispute; a dark one only costs a sale.
  const plan = [];
  for (const e of managed) {
    if (e.realStock == null) continue;
    if (e.offer.status !== mp.G2G_STATUS.LIVE) continue;
    if (e.realStock === 0) {
      plan.push({
        action: "delist",
        offerId: String(e.offer.offerId),
        rowId: e.row._id,
        title: e.offer.title || "",
        why: "nothing claimable left",
        reserved: Number(e.offer.reservedQty) || 0,
        to: 0,
      });
    } else if (Number(e.offer.actualQty) > e.realStock) {
      plan.push({
        action: "set-qty",
        offerId: String(e.offer.offerId),
        rowId: e.row._id,
        title: e.offer.title || "",
        why: e.offer.actualQty + " advertised, " + e.realStock + " claimable",
        reserved: Number(e.offer.reservedQty) || 0,
        to: e.realStock,
      });
    }
  }
  const rank = (a) => (a.action === "delist" ? 0 : 1);
  plan.sort((a, b) => rank(a) - rank(b));
  const todo = LIMIT ? plan.slice(0, LIMIT) : plan;

  console.log(
    "\n" +
      (APPLY ? "APPLYING" : "DRY RUN") +
      (LIMIT ? " limit=" + LIMIT : "") +
      " — " +
      plan.length +
      " action(s)" +
      (todo.length < plan.length
        ? ", " + (plan.length - todo.length) + " held back by the limit"
        : ""),
  );
  if (!plan.length) {
    console.log("nothing to do — every managed offer matches what we can ship.");
  }

  for (const a of todo) {
    // Belt and braces around the rule that matters most: a plan entry without a
    // listing row must never reach a write, however it got into the list.
    if (!a.rowId) {
      a.error = "no listing row — refused";
      continue;
    }
    if (!APPLY) continue;
    try {
      if (a.action === "delist") await mp.g2gDelist(a.offerId);
      else await mp.g2gSetQuantity(a.offerId, a.to);
    } catch (e) {
      a.error = e.message || String(e);
      a.verified = false;
      continue;
    }
    // Read it back. Anything short of the offer itself agreeing leaves the
    // listing row alone, so the next run reports the mismatch instead of
    // trusting a write nobody confirmed.
    let back = null;
    try {
      back = await mp.g2gGetOffer(a.offerId);
    } catch (e) {
      a.verifyNote = "read-back failed: " + (e.message || e);
    }
    if (!back) {
      a.verified = null;
    } else if (a.action === "delist") {
      a.verified = String(back.status) === mp.G2G_STATUS.DELISTED;
      if (!a.verified) a.verifyNote = "status is still " + back.status;
    } else {
      a.verified = Number(back.actual_qty) === a.to;
      if (!a.verified) a.verifyNote = "actual_qty is " + back.actual_qty;
    }
    if (a.verified !== true) continue;
    // autoPaused marks a row as paused for lack of stock rather than by an
    // operator's decision — the only kind a stock sync may ever put back on
    // sale by itself. lastStock records what we actually left on the platform,
    // so a later pass reading that number does not mistake our own correction
    // for units the buyers took.
    const $set =
      a.action === "delist"
        ? { status: "delisted", autoPaused: true, lastStock: 0 }
        : { lastStock: a.to };
    await MarketplaceListing.updateOne({ _id: a.rowId }, { $set });
  }

  // ---- 5. what it would do vs what it did ----
  for (const a of todo) {
    const mark = !APPLY
      ? "plan"
      : a.verified === true
        ? " ok "
        : a.verified === false
          ? "FAIL"
          : " ?? ";
    console.log(
      mark +
        "  " +
        a.action.padEnd(9) +
        String(a.offerId).padEnd(18) +
        String(a.why).padEnd(34) +
        String(a.title).slice(0, 40),
    );
    if (a.reserved > 0) {
      console.log(
        "        note: " +
          a.reserved +
          " unit(s) are reserved by a checkout in flight — that order still has" +
          " to be honoured by hand.",
      );
    }
    if (a.verifyNote) console.log("        note: " + a.verifyNote);
    if (a.error) console.log("        error: " + a.error);
  }

  if (APPLY) {
    const ok = todo.filter((a) => a.verified === true).length;
    const bad = todo.filter((a) => a.verified === false).length;
    const unverified = todo.length - ok - bad;
    console.log(
      "\nverified " +
        ok +
        " / " +
        todo.length +
        (bad ? ", FAILED " + bad : "") +
        (unverified ? ", unverified " + unverified : "") +
        ". No offer was deleted and no unmanaged offer was touched.",
    );
  } else if (todo.length) {
    console.log("\nNothing was written. Re-run with --apply to act.");
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
