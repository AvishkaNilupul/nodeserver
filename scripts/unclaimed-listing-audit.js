#!/usr/bin/env node
// Check every live no-claim listing against what its accounts can still claim,
// and fix what has gone stale.
//
// Why this exists: an event wave expires, its drops stop being claimable and
// disappear from the accounts' Twitch inventory, and the listing keeps
// advertising them. Eldorado order 99d443eb sold a two-loot-box Overwatch bundle
// from accounts that by then held one — because Week 1 had ended. Nothing in the
// system noticed, so the buyer did.
//
//   node scripts/unclaimed-listing-audit.js
//       read every backing account's LIVE inventory and report each listing as
//       ok / short / stale / empty / unknown. Reads only.
//
//   node scripts/unclaimed-listing-audit.js --refresh
//       also write what Twitch says back onto the ledger rows, so the stock
//       counters and bundle maker stop working from a stale snapshot.
//
//   node scripts/unclaimed-listing-audit.js --apply
//       push the honest quantity to each platform, and pause any offer whose
//       advertised items nothing can still supply.
//
//   node scripts/unclaimed-listing-audit.js --listing <id> \
//       --declare "Esports Loot Box x2, Boba Buddy Icon"
//       record what a listing advertises WITHOUT touching its live text, so the
//       delivery gate and this audit have a contract to check against.
//
//   node scripts/unclaimed-listing-audit.js --shop [--max 10] [--marketplace ggsel]
//       audit EVERY active listing that sells no-claim-game drops, whichever
//       pool it draws on — the no-claim ledger (by game or by set) and the Drop
//       Archive alike. Reads only; it never touches listing text or quantity.
//       --max caps how many candidate accounts are live-read per DropSet.
//
//   node scripts/unclaimed-listing-audit.js --listing <id> --retitle [--qty N] [--apply]
//       rewrite ONE listing down to the set its stock actually holds: declares
//       requiredDrops, and rewrites the live title + description to match.
//       Without --apply it only prints what it would say.
require("dotenv").config();
const mongoose = require("mongoose");
const MarketplaceListing = require("../models/MarketplaceListing");
const audit = require("../utils/unclaimedListingAudit");
const coverage = require("../utils/unclaimedCoverage");
const mp = require("../utils/marketplaces");

const has = (n) => process.argv.includes("--" + n);
function arg(n) {
  const i = process.argv.indexOf("--" + n);
  return i > 0 ? process.argv[i + 1] : null;
}

const MARK = {
  ok: "OK   ",
  short: "SHORT",
  stale: "STALE",
  empty: "EMPTY",
  unknown: "?    ",
  unreadable: "NOREAD",
  service: "farm ",
  unauditable: "n/a  ",
};

function fmtItems(items) {
  return (items || [])
    .map((i) =>
      typeof i === "string" ? i : i.name + ((i.qty || 1) > 1 ? " x" + i.qty : ""),
    )
    .join(", ");
}

// --- listing copy for a corrected bundle ---------------------------------
// Deliberately plain and checkable: the item list IS the contract, so it is
// spelled out in full rather than summarised, and nothing is promised about
// waves that have ended.
function buildTitle(game, items) {
  const n = items.length;
  const head = game + " Twitch Drops (" + n + " Item" + (n === 1 ? "" : "s") + ")";
  const tail = items.slice(0, 2).map((i) => i.name).join(" + ");
  const more = n > 2 ? " +" + (n - 2) + " more" : "";
  const full = head + " — " + tail + more;
  return full.length > 150 ? head : full;
}

function buildDescription(game, items, marketplace) {
  const support =
    {
      eldorado: "message me here on Eldorado",
      playerauctions: "message me here on PlayerAuctions",
      ggsel: "message me here on GGSel",
      gameflip: "message me here on Gameflip",
      digiseller: "message me here on Digiseller",
    }[String(marketplace || "").toLowerCase()] || "message me here";
  const lines = [game + " Twitch Drops — all items UNCLAIMED.", "", "Includes:"];
  for (const i of items) {
    lines.push("- " + ((i.qty || 1) > 1 ? i.qty + "x " : "") + i.name);
  }
  lines.push(
    "",
    "You receive a Twitch account with ALL of the above sitting unclaimed in " +
      "its drops inventory. Log in, open twitch.tv/drops/inventory, press " +
      "Connect and claim everything to YOUR OWN game account.",
    "",
    "Please check the item list carefully before buying — this listing is " +
      "exactly what the account holds, nothing more.",
    "",
    "Buying more than one? Each purchase delivers a different account — every " +
      "bundle can be claimed once per game account.",
    "",
    "Please redeem the drops soon after delivery. The account is guaranteed at " +
      "the moment of delivery.",
    "",
    "Any issue or question — " + support + " before opening a dispute. I reply " +
      "fast and always make it right.",
  );
  return lines.join("\n");
}

// Declare what a listing advertises WITHOUT touching its live text — for a row
// whose description is right but which never recorded its item list, so the
// delivery gate and the audit have nothing to check against. Once declared, an
// offer whose items have expired shows up as STALE instead of "?".
async function declare(listingId, spec) {
  const listing = await MarketplaceListing.findById(listingId);
  if (!listing) throw new Error("no listing " + listingId);
  const items = String(spec || "")
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
    });
  if (!items.length) throw new Error("--declare needs a comma-separated item list");
  listing.requiredDrops = items;
  await listing.save();
  console.log(
    "declared " + items.length + " item(s) on " + listing.marketplace + " " +
      listing.externalId + ": " + fmtItems(items),
  );
}

async function retitle(listingId, { apply }) {
  const listing = await MarketplaceListing.findById(listingId);
  if (!listing) throw new Error("no listing " + listingId);
  if (!listing.unclaimedGame) {
    throw new Error("listing " + listingId + " is not backed by the no-claim farm");
  }
  const stock = await audit.liveStockForGame(listing.unclaimedGame, { refresh: true });
  const best = audit.dominantOffer(stock);
  if (!best.count) throw new Error("no readable stock holds anything sellable");

  const items = audit.itemsToRequired(best.items);
  // Several listings can be backed by the SAME accounts (the Eldorado and
  // PlayerAuctions copies of one bundle draw on one ledger), so advertising the
  // full count on each would sell the same eleven accounts twice. --qty is how
  // the operator splits a shared pool.
  const qty = Math.max(1, parseInt(arg("qty"), 10) || best.count);
  const title = buildTitle(listing.unclaimedGame, items);
  const description = buildDescription(listing.unclaimedGame, items, listing.marketplace);

  console.log("\n=== " + listing.marketplace + " " + listing.externalId);
  console.log("OLD title: " + listing.title);
  console.log("NEW title: " + title);
  console.log("items (" + items.length + "): " + fmtItems(items));
  console.log(
    "backed by " + best.count + " account(s): " + best.logins.slice(0, 8).join(", "),
  );
  if (qty !== best.count) console.log("advertising " + qty + " (--qty override)");
  if (!apply) {
    console.log("\n--- description it would publish ---\n" + description);
    console.log("\n(dry run — pass --apply to publish)");
    return;
  }

  // The two APIs name the stock field differently, and PlayerAuctions' update
  // IS a full offer PUT — so the count rides along with the text rather than
  // costing a second round trip.
  if (listing.marketplace === "eldorado") {
    await mp.eldoradoUpdateOffer(listing.externalId, {
      title,
      description,
      quantity: qty,
    });
  } else if (listing.marketplace === "playerauctions") {
    await mp.playerauctionsUpdateOffer(listing.externalId, {
      title,
      description,
      totalUnit: qty,
    });
  } else {
    throw new Error("no edit API wired for " + listing.marketplace);
  }
  listing.title = title;
  listing.description = description;
  listing.requiredDrops = items;
  listing.lastError = "";
  await listing.save();
  console.log("published, and requiredDrops declared — delivery now verifies it");
}

// Shop-wide, read-only. Groups by verdict because the action differs per
// verdict: STALE needs the listing corrected, SHORT needs a quantity, EMPTY
// needs farming, and "?" needs its item list declared before anything can be
// said at all.
async function shopReport() {
  const max = Math.max(1, parseInt(arg("max"), 10) || audit.ARCHIVE_SAMPLE);
  const marketplace = arg("marketplace") || "";
  // Route the Twitch reads through the same host the scanners use, so a big
  // audit does not fan out from this server.
  const host = (process.env.DROP_SCAN_HOSTS || "").split(",")[0].trim() || undefined;
  console.log(
    "auditing every active no-claim listing against LIVE Twitch inventory " +
      "(sampling up to " + max + " accounts per set" +
      (host ? ", via host " + host : "") + ")\n",
  );
  const rows = await audit.auditShop({
    max,
    host,
    marketplace,
    onProgress: (k) => process.stderr.write("  reading stock for " + k + "\n"),
  });

  const order = ["stale", "empty", "unreadable", "short", "unknown", "ok", "service", "unauditable"];
  const byVerdict = new Map(order.map((v) => [v, []]));
  for (const r of rows) (byVerdict.get(r.verdict) || byVerdict.get("unauditable")).push(r);

  console.log("=".repeat(78));
  console.log("TOTAL no-claim listings audited: " + rows.length);
  for (const v of order) {
    const n = (byVerdict.get(v) || []).length;
    if (n) console.log("  " + (MARK[v] || v).trim().padEnd(12) + n);
  }
  console.log("=".repeat(78));

  for (const v of order) {
    const group = byVerdict.get(v) || [];
    if (!group.length) continue;
    console.log("\n\n##### " + v.toUpperCase() + " (" + group.length + ")");
    if (v === "stale") {
      console.log("      advertises items NO candidate account still holds unclaimed.");
    }
    if (v === "unreadable") {
      console.log("      no account could be read, so nothing is known — check tokens/host, then re-run.");
    }
    if (v === "service") {
      console.log("      rent-farm listings: they sell a farming window, not an account — nothing to check.");
    }
    if (v === "unauditable") {
      console.log("      no DropSet with items, so there is no item contract to check against.");
    }
    for (const r of group) {
      const l = r.listing;
      console.log(
        "\n  " + l.marketplace + " " + l.externalId + "  [" + r.kind + "]  $" + (l.price || 0) +
          // A row this audit already took off sale is still status:"active" in
          // our DB, so say so rather than let it read as still selling.
          (l.autoPaused ? "  (ALREADY PAUSED by the audit)" : ""),
      );
      console.log("      " + String(l.title || "").slice(0, 100));
      if (v === "service" || v === "unauditable") continue;
      console.log(
        "      advertises (" + r.advertised.source + ", " + r.advertised.items.length +
          " items): " + (fmtItems(r.advertised.items).slice(0, 150) || "NOTHING DECLARED"),
      );
      console.log(
        "      can honour it: " + r.covering + " of " + r.stock + " account(s) read" +
          (r.candidates != null ? " (of " + r.candidates + " candidate(s))" : "") +
          (r.unreadable ? ", " + r.unreadable + " unreadable" : "") +
          (r.truncated ? " [sampled — a count-based shortfall cannot be judged]" : ""),
      );
      if (r.via && r.via !== r.kind) console.log("      note: " + r.via);
      if (r.missing && r.verdict !== "ok") {
        console.log("      stock is short of: " + r.missing.slice(0, 200));
      }
      if (r.verdict === "stale" && r.suggest.count) {
        console.log(
          "      -> stock actually holds: " +
            fmtItems(audit.itemsToRequired(r.suggest.items)).slice(0, 150) +
            "  (on " + r.suggest.count + " account(s))",
        );
      }
    }
  }
  console.log(
    "\n\nNOTHING WAS CHANGED. Fixing a listing's text is a pricing/marketing " +
      "decision, so choose per row:\n" +
      "  --listing <id> --declare \"<items>\"        record what it advertises (no live edit)\n" +
      "  --listing <id> --retitle [--qty N] --apply  rewrite it to what its stock holds\n",
  );
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, {});
  const id = arg("listing");

  if (has("shop")) {
    await shopReport();
    await mongoose.disconnect();
    return;
  }

  if (has("declare")) {
    if (!id) throw new Error("--declare needs --listing <id>");
    await declare(id, arg("declare"));
    await mongoose.disconnect();
    return;
  }

  if (has("retitle")) {
    if (!id) throw new Error("--retitle needs --listing <id>");
    await retitle(id, { apply: has("apply") });
    await mongoose.disconnect();
    return;
  }

  const games = await audit.auditAll({ refresh: has("refresh") || has("apply") });
  for (const g of games) {
    const readable = g.stock.filter((s) => !s.unreadable);
    const withItems = readable.filter((s) => s.items.length);
    console.log(
      "\n########## " + g.game + " — " + withItems.length + " of " + g.stock.length +
        " sellable accounts still hold claimable drops (" +
        (g.stock.length - readable.length) + " unreadable)",
    );
    const best = audit.dominantOffer(g.stock);
    if (best.count) {
      console.log(
        "  biggest honest bundle right now: " + best.items.length + " items on " +
          best.count + " account(s) — " + fmtItems(audit.itemsToRequired(best.items)),
      );
    }
    for (const e of g.listings) {
      console.log(
        "\n  [" + MARK[e.verdict] + "] " + e.listing.marketplace + " " +
          e.listing.externalId + "  " + e.listing.title,
      );
      console.log(
        "      advertises (" + e.advertised.source + "): " +
          (fmtItems(e.advertised.items) || "NOTHING DECLARED"),
      );
      console.log("      accounts that can honour it: " + e.covering + " of " + e.stock);
      // On an OK row this would only be listing the accounts that hold nothing
      // at all, which reads like a problem and is not one.
      if (e.missing && e.verdict !== "ok") {
        console.log("      stock is short of: " + e.missing);
      }
      if (e.verdict === "stale") {
        console.log(
          "      -> EXPIRED WAVE. Sell this instead: " +
            fmtItems(audit.itemsToRequired(e.suggest.items)),
        );
        console.log(
          "      -> node scripts/unclaimed-listing-audit.js --listing " +
            e.listing._id + " --retitle --apply",
        );
      }
      if (e.verdict === "unknown") {
        console.log(
          "      -> declare it so delivery can be checked: --listing " +
            e.listing._id + " --retitle",
        );
      }
      if (has("apply")) {
        const actions = await audit.applyStock(e, { dryRun: false });
        if (actions.length) console.log("      applied: " + JSON.stringify(actions));
      }
    }
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
