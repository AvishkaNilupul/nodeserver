#!/usr/bin/env node
// Can the no-claim farm actually honour what our no-claim-backed listings
// advertise?
//
// These rows (`MarketplaceListing.unclaimedGame`) pick their stock by GAME at
// delivery time, so before `requiredDrops` existed nothing compared the account
// we shipped against the item list the buyer paid for. Eldorado order 99d443eb
// (2026-09-07) is what this script exists for: a 10-item Overwatch CAH bundle
// filled with a 7-item account carrying ONE of the two advertised Esports Loot
// Boxes — and every one of that offer's six deliveries had the same shape.
//
//   node scripts/unclaimed-listing-coverage.js
//       audit every no-claim-backed listing: what it declares, how much stock
//       can honour it, and what the stock is short of.
//
//   node scripts/unclaimed-listing-coverage.js --listing <id> --suggest
//       propose an item list by matching the listing's own description text
//       against the item names the ledger has actually seen for that game.
//       Prints only — the operator decides.
//
//   node scripts/unclaimed-listing-coverage.js --listing <id> \
//       --set "Battle Pass Tier Skip x2, Esports Loot Box x2, Crown Jewels Spray"
//       declare the advertised list. From then on the fulfillers refuse any
//       account that does not hold all of it unclaimed, and the stock sync
//       advertises only the accounts that do (pausing the offer at zero).
require("dotenv").config();
const mongoose = require("mongoose");
const MarketplaceListing = require("../models/MarketplaceListing");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const coverage = require("../utils/unclaimedCoverage");

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : null;
}
const has = (name) => process.argv.includes("--" + name);

// "Esports Loot Box x2, Crown Jewels Spray" -> [{name, qty}]
function parseItems(spec) {
  return String(spec || "")
    .split(/\s*,\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      // The multiplier must be whitespace-separated: item names really do end
      // in a number ("Esports Loot Box 41"), and a greedy match turned that one
      // into "Esports Loot Bo" times 41.
      const m = s.match(/^(.*?)\s+[x*]\s*(\d+)$/i);
      return m
        ? { name: m[1].trim(), qty: Math.max(1, parseInt(m[2], 10) || 1) }
        : { name: s, qty: 1 };
    })
    .filter((i) => i.name);
}

function fmt(list) {
  return (list || [])
    .map((i) => i.name + ((i.qty || 1) > 1 ? " x" + (i.qty || 1) : ""))
    .join(", ");
}

// Every item name the ledger has recorded for this game, with how many sellable
// accounts hold it — the vocabulary a suggestion is allowed to use.
async function ledgerVocabulary(game) {
  const rows = await UnclaimedAccount.find(
    {
      source: "noclaim",
      game: coverage.normName(game)
        ? new RegExp("^" + String(game).trim().replace(/\s*2$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
        : /.^/,
    },
    { drops: 1, status: 1, soldAt: 1 },
  ).lean();
  const sellable = rows.filter(
    (r) => ["released", "skipped"].includes(r.status) && !r.soldAt,
  );
  const names = new Map();
  for (const r of rows) {
    for (const d of r.drops || []) {
      const n = String((d && d.name) || "").trim();
      if (n) names.set(n, (names.get(n) || 0) + 1);
    }
  }
  return { rows, sellable, names };
}

async function auditOne(row) {
  const { rows, sellable, names } = await ledgerVocabulary(row.unclaimedGame);
  const req = coverage.listingRequirements(row);
  const delivered = (row.units || []).filter((u) => u.deliveredAt).length;

  console.log("\n=== " + row.marketplace + " / " + row.status + " — " + row.title);
  console.log("    id " + row._id + "  ext " + row.externalId);
  console.log("    game: " + row.unclaimedGame + "   delivered so far: " + delivered);
  console.log(
    "    declares: " +
      (req.size
        ? fmt(row.requiredDrops) + "  (" + req.size + " distinct)"
        : "NOTHING — delivery is UNVERIFIED, any account for this game ships"),
  );
  console.log(
    "    ledger: " + rows.length + " rows for this game, " + sellable.length + " sellable",
  );
  if (!req.size) {
    console.log("    → run with --listing " + row._id + " --suggest to draft its item list");
    return;
  }
  const { covering, short } = coverage.partitionByCoverage(sellable, req);
  console.log("    CAN HONOUR IT: " + covering.length + " of " + sellable.length + " sellable accounts");
  if (short.length) {
    console.log("    short of: " + coverage.shortfallSummary(short, req));
  }
  // An item the ledger has never once recorded is not "rare stock", it is an
  // item we never farmed — the listing cannot be honoured at any quantity.
  const known = new Map([...names].map(([n, c]) => [coverage.normName(n), c]));
  const never = [...req.keys()].filter((n) => !known.has(n));
  if (never.length) {
    console.log("    ⚠ NEVER SEEN in this game's ledger: " + never.join(", "));
  }
  if (!covering.length) {
    console.log("    ⚠ this offer cannot be filled from current stock — pause it or fix the item list");
  }
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, {});
  const id = arg("listing");

  if (id && has("set")) {
    const items = parseItems(arg("set"));
    if (!items.length) throw new Error("--set needs a comma-separated item list");
    const row = await MarketplaceListing.findById(id);
    if (!row) throw new Error("no listing " + id);
    row.requiredDrops = items;
    await row.save();
    console.log("set requiredDrops on " + row.title + ":\n  " + fmt(items));
    await auditOne(row.toObject());
    await mongoose.disconnect();
    return;
  }

  if (id && has("suggest")) {
    const row = await MarketplaceListing.findById(id).lean();
    if (!row) throw new Error("no listing " + id);
    const { names } = await ledgerVocabulary(row.unclaimedGame);
    const text = String(row.description || "") + "\n" + String(row.title || "");
    const hay = coverage.normName(text.replace(/<[^>]+>/g, " "));
    const hits = [];
    for (const [name] of names) {
      const needle = coverage.normName(name);
      let n = 0;
      let from = 0;
      for (;;) {
        const at = hay.indexOf(needle, from);
        if (at < 0) break;
        n += 1;
        from = at + needle.length;
      }
      if (n) hits.push({ name, qty: n });
    }
    console.log("=== " + row.title);
    console.log("description mentions these ledger-known items:\n  " + (fmt(hits) || "(none)"));
    console.log(
      "\nNOTE: matching is literal, so an abbreviation the operator wrote " +
        '("BP Tier Skip" for "Battle Pass Tier Skip") will NOT show up here — ' +
        "read the description and pass the real names to --set.",
    );
    console.log("\n--- description ---\n" + String(row.description || "").replace(/<[^>]+>/g, ""));
    await mongoose.disconnect();
    return;
  }

  const q = id
    ? { _id: id }
    : { unclaimedGame: { $nin: ["", null] } };
  const rows = await MarketplaceListing.find(q).lean();
  console.log("no-claim-backed listings: " + rows.length);
  for (const row of rows) await auditOne(row);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
