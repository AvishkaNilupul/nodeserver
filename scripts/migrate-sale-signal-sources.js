// One-time relabel of historical SaleSignal rows.
//
// "drop_reserved" used to mean two incompatible things, because
// reserveSetOnAccount serves both a paying buyer and a fulfiller filling a
// shelf. Demand learning now counts only real sales, so the historical rows
// that WERE real sales have to be relabelled or the auto-farmer loses months of
// genuine evidence the moment the new code ships.
//
// Two kinds get promoted to "listing_sold":
//   1. dedupeKey "manual-sold:*" — the operator's hand-delivered sales.
//   2. dedupeKey "reserved:*" whose drops were stamped with a real buyer.
//      Stocking claims stamp DropLog.soldToUsername with the fulfiller's claim
//      tag ("gameflip", "ggsel", "digiseller", "funpay", "zeusx", and the
//      "-manual" variants); anything else — a Shop buyer's username, "bulk:*"
//      — is a person who paid.
//
// Everything left as "drop_reserved" is stock sitting on a shelf.
//
// Safe to re-run: it only ever moves rows in one direction and skips rows that
// are already listing_sold. Nothing is deleted.
//
//   node scripts/migrate-sale-signal-sources.js          (dry run, default)
//   node scripts/migrate-sale-signal-sources.js --apply  (writes)
require("dotenv").config();
const mongoose = require("mongoose");
const DropLog = require("../models/DropLog");
const SaleSignal = require("../models/SaleSignal");

const APPLY = process.argv.includes("--apply");

// Claim tags a fulfiller stamps when it reserves stock for a listing. A drop
// carrying one of these was never bought by anybody.
const STOCK_TAGS = new Set([
  "gameflip",
  "ggsel",
  "digiseller",
  "digiseller-manual",
  "funpay",
  "zeusx",
]);

function isStockTag(soldToUsername) {
  const s = String(soldToUsername || "")
    .trim()
    .toLowerCase();
  if (!s) return true; // no buyer recorded at all — treat as stock, the safe way to be wrong
  return STOCK_TAGS.has(s);
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 15000,
  });
  console.log(APPLY ? "APPLYING changes" : "DRY RUN (pass --apply to write)");

  const rows = await SaleSignal.find({ source: "drop_reserved" })
    .select("dedupeKey account game gameKey")
    .lean();
  console.log("drop_reserved rows to classify:", rows.length);

  // Who took each (account, set), for every reserved drop, in ONE aggregation.
  // The obvious shape — a distinct() per signal row — is 1900+ sequential
  // round trips against a shared Atlas tier that serialises queries, which
  // took over ten minutes and printed nothing while it ran. This is the same
  // answer in one trip.
  const buyerRows = await DropLog.aggregate([
    { $match: { soldAt: { $ne: null } } },
    {
      $group: {
        _id: { account: "$account", set: "$soldSetId" },
        buyers: { $addToSet: "$soldToUsername" },
      },
    },
  ]);
  const buyersOf = new Map();
  for (const r of buyerRows) {
    buyersOf.set(
      String(r._id.account) + "|" + String(r._id.set || ""),
      r.buyers,
    );
  }
  console.log("account+set groups with reserved drops:", buyersOf.size);

  const promote = [];
  let stock = 0;
  let unresolved = 0;

  for (const r of rows) {
    const key = String(r.dedupeKey || "");
    if (key.startsWith("manual-sold:")) {
      promote.push({ id: r._id, why: "manual sale", game: r.game });
      continue;
    }
    if (!key.startsWith("reserved:")) {
      unresolved++;
      continue;
    }
    // reserved:<accountId>:<setId>:<game> — ask the drops themselves who took
    // them. Any drop of this account+set stamped with a non-stock buyer means
    // this signal came from a real order.
    const setId = key.split(":")[2] || "";
    const buyers = buyersOf.get(String(r.account) + "|" + setId) || [];
    const real = buyers.filter((b) => !isStockTag(b));
    if (real.length) {
      promote.push({
        id: r._id,
        why: "buyer " + real.join("/"),
        game: r.game,
      });
    } else {
      stock++;
    }
  }

  console.log("\n-- classification --");
  console.log("  real sales to promote :", promote.length);
  console.log("  stock claims to leave :", stock);
  console.log("  unrecognised dedupeKey:", unresolved);

  const byGame = {};
  for (const p of promote) byGame[p.game] = (byGame[p.game] || 0) + 1;
  const top = Object.entries(byGame)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  if (top.length) {
    console.log("\n-- promoted sales per game (top 15) --");
    for (const [g, n] of top) console.log("  " + n + "  " + g);
  }

  if (APPLY && promote.length) {
    const r = await SaleSignal.updateMany(
      { _id: { $in: promote.map((p) => p.id) } },
      { $set: { source: "listing_sold" } },
    );
    console.log("\nupdated:", r.modifiedCount);
  } else if (promote.length) {
    console.log("\n(dry run — nothing written)");
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("migration failed:", e.message);
  process.exit(1);
});
