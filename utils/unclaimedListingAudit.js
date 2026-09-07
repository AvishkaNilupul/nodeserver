// Do our no-claim listings still advertise things a buyer can actually claim?
//
// Every event we farm dies on a schedule. When a wave ends its drops stop being
// claimable and vanish from the account's Twitch inventory — the account keeps
// the newer wave and silently loses the older one. The listing text does not
// change, so a bundle published across two waves keeps advertising both long
// after only one is real.
//
// That is not a bug to fix once; it is the normal life cycle, so it needs a
// standing check. Eldorado order 99d443eb (2026-09-07) is the worked example:
// a 10-item Overwatch CAH bundle sold as "Week 1 + Week 2", delivered from
// accounts that by then held only Week 2's six items. The buyer counted his loot
// boxes — one, not two — and was right. A live read of all 15 sellable accounts
// the next day confirmed it: Week 1 was gone from every single one.
//
// This module answers, per listing, from Twitch itself: what does it advertise,
// how many accounts can still honour that, and if none can, what set COULD we
// honestly sell instead?
//
// Only the no-claim games matter here (Overwatch / Rainbow Six / Call of Duty):
// their whole point is that the drops reach the buyer UNCLAIMED so they can
// connect them to their own game account. A claimed drop is not stock at all.
const MarketplaceListing = require("../models/MarketplaceListing");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const DropSet = require("../models/DropSet");
const coverage = require("./unclaimedCoverage");

// Sellable in the ledger's sense: not spent, and not already a unit on another
// marketplace's live listing.
const SELLABLE_STATUSES = ["released", "skipped"];

// Live reads go through the Pi like every other scanner, so keep the fan-out
// modest — this runs against real Twitch GQL.
const READ_CONCURRENCY = 5;

function gameFilter(game) {
  const base = String(game || "")
    .trim()
    .replace(/\s*2$/, "");
  if (!base) return /.^/;
  return new RegExp("^" + base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch (e) {
        out[i] = { error: (e && e.message) || String(e) };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

// --- what we actually hold, right now ------------------------------------

// Live inventory for every sellable ledger row of one game.
//
// `refresh` writes what Twitch says back onto the ledger row. That matters
// beyond this audit: `drops[]` is what the stock counters, the bundle maker and
// the archive views all read, and it had drifted far enough that an account
// holding six claimable items was recorded as holding three.
async function liveStockForGame(game, { refresh = false } = {}) {
  const rows = await UnclaimedAccount.find({
    source: "noclaim",
    game: gameFilter(game),
    status: { $in: SELLABLE_STATUSES },
    soldAt: null,
  }).lean();

  const read = await mapLimit(rows, READ_CONCURRENCY, async (row) => {
    const sellable = await coverage.liveHeld(row);
    return { row, sellable, unreadable: sellable === null };
  });

  const stock = [];
  for (const r of read) {
    if (!r || r.error || r.unreadable || !r.sellable) {
      stock.push({ row: (r && r.row) || null, items: [], unreadable: true });
      continue;
    }
    stock.push({ row: r.row, items: r.sellable, unreadable: false });
    if (refresh) {
      // Same shape the no-claim scan writes, so every other reader sees no
      // difference except that it is now true.
      await UnclaimedAccount.updateOne(
        { _id: r.row._id },
        {
          $set: {
            drops: r.sellable.map((d) => ({
              name: d.name,
              game: d.game || game,
              campaign: d.campaign || "",
              itemKey: d.itemKey || "",
            })),
            lastCheckedAt: new Date(),
          },
        },
      ).catch(() => {});
    }
  }
  return stock;
}

// The largest set of items that some group of accounts ALL still hold — i.e. the
// biggest bundle we could honestly advertise today, and how many accounts back
// it.
//
// Accounts of an event cohort hold identical inventories, so grouping by exact
// item signature finds the real cohorts rather than inventing an intersection no
// single account satisfies. Ties break toward the bigger bundle: with equal
// stock, more items is the better listing.
function dominantOffer(stock) {
  const groups = new Map();
  for (const s of stock) {
    if (s.unreadable || !s.items.length) continue;
    const names = s.items.map((i) => i.name).sort();
    const key = names.map(coverage.normName).join(" ");
    const g = groups.get(key) || { items: names, count: 0, logins: [] };
    g.count += 1;
    if (s.row) g.logins.push(s.row.login);
    groups.set(key, g);
  }
  const best = [...groups.values()].sort(
    (a, b) => b.count - a.count || b.items.length - a.items.length,
  )[0];
  return best || { items: [], count: 0, logins: [] };
}

// Collapse a cohort's item names into an advertised list with counts, which is
// what a listing declares and what the delivery gate checks against.
function itemsToRequired(names) {
  const counts = new Map();
  for (const n of names || []) {
    const key = String(n || "").trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([name, qty]) => ({ name, qty }));
}

// --- per-listing verdict --------------------------------------------------

// What a listing claims to sell. `requiredDrops` is the declared contract; a
// DropSet is the fallback for rows published before it existed.
async function advertisedItems(listing) {
  if ((listing.requiredDrops || []).length) {
    return { items: listing.requiredDrops, source: "requiredDrops" };
  }
  if (listing.set) {
    const set = await DropSet.findById(listing.set).lean();
    if (set && (set.items || []).length) {
      return {
        items: itemsToRequired((set.items || []).map((i) => i.name)),
        source: "dropSet",
      };
    }
  }
  return { items: [], source: "none" };
}

// One listing, judged against live stock.
//
//   ok       - enough accounts still hold everything it advertises
//   short    - some do, but fewer than the quantity on sale
//   stale    - NONE do, yet stock exists holding a different set (an expired
//              wave, almost always); `suggest` is what to sell instead
//   empty    - no sellable stock for this game at all
//   unknown  - the listing never declared what it sells, so nothing can be
//              checked; declare it and this becomes answerable
function judge(listing, advertised, stock) {
  const req = coverage.requiredCounts(advertised.items);
  const readable = stock.filter((s) => !s.unreadable);
  const withItems = readable.filter((s) => s.items.length);
  const suggestion = dominantOffer(stock);

  if (!req.size) {
    return {
      verdict: "unknown",
      covering: 0,
      stock: withItems.length,
      unreadable: stock.length - readable.length,
      suggest: suggestion,
      missing: "",
    };
  }
  const covering = [];
  const missLists = [];
  for (const s of readable) {
    const missing = coverage.shortOf(coverage.countLogNames(s.items), req);
    if (missing.length) missLists.push(missing);
    else covering.push(s);
  }
  const onSale = Math.max(0, parseInt(listing.qtyTarget, 10) || 0);
  let verdict = "ok";
  if (!covering.length) verdict = withItems.length ? "stale" : "empty";
  else if (onSale && covering.length < onSale) verdict = "short";
  return {
    verdict,
    covering: covering.length,
    stock: withItems.length,
    unreadable: stock.length - readable.length,
    suggest: suggestion,
    missing: coverage.summarizeMissing(missLists),
  };
}

// Audit every active listing that draws on the no-claim farm for `game`.
// Live stock is read ONCE per game and shared, because the expensive part is
// Twitch, not the comparison.
async function auditGame(game, { refresh = false } = {}) {
  const stock = await liveStockForGame(game, { refresh });
  const listings = await MarketplaceListing.find({
    status: "active",
    unclaimedGame: gameFilter(game),
  }).lean();
  const out = [];
  for (const listing of listings) {
    const advertised = await advertisedItems(listing);
    out.push({ listing, advertised, ...judge(listing, advertised, stock) });
  }
  return { game, stock, listings: out };
}

// Every no-claim game that has at least one active listing behind it.
async function auditAll({ refresh = false } = {}) {
  const games = await MarketplaceListing.distinct("unclaimedGame", {
    status: "active",
    unclaimedGame: { $nin: ["", null] },
  });
  const out = [];
  for (const game of games) out.push(await auditGame(game, { refresh }));
  return out;
}

// --- the fix --------------------------------------------------------------

// Push the honest number onto the platform, and take the offer down when that
// number is zero. Text is NOT rewritten here: correcting an item list changes
// what the listing promises, which is the operator's call, so the audit reports
// the suggestion and the script's --retitle applies it.
// How many live offers draw on the SAME ledger. Every listing for a game shares
// one pool of accounts — the Eldorado and PlayerAuctions copies of a bundle are
// two shop windows onto the same eleven accounts — so advertising the full count
// on each promises the pool twice over. Splitting it is the honest number, and
// it is the same rule the PlayerAuctions fulfiller already applies within its
// own marketplace, widened to all of them.
async function sharersForGame(game) {
  try {
    const n = await MarketplaceListing.countDocuments({
      status: "active",
      autoPaused: { $ne: true },
      unclaimedGame: gameFilter(game),
    });
    return Math.max(1, n);
  } catch {
    // Never let a bookkeeping lookup inflate stock: falling back to "one
    // listing" would advertise MORE, so fall back to what we were asked about.
    return 1;
  }
}

async function applyStock(entry, { dryRun = true } = {}) {
  const mp = require("./marketplaces");
  const { listing, covering, verdict } = entry;
  const id = listing.externalId;
  const actions = [];

  const setQty = {
    eldorado: (n) => mp.eldoradoSetQuantity(id, n),
    playerauctions: (n) => mp.playerauctionsSetQuantity(id, n),
  }[listing.marketplace];
  const pause = {
    eldorado: () => mp.eldoradoDelist(id),
    playerauctions: () => mp.playerauctionsHide(id),
  }[listing.marketplace];

  if (!setQty) return [{ note: "no stock API for " + listing.marketplace }];

  if (covering <= 0 && (verdict === "stale" || verdict === "empty")) {
    actions.push("pause (" + verdict + ": nothing on sale is still claimable)");
    if (!dryRun && pause) {
      await pause().catch((e) => actions.push("pause failed: " + e.message));
      await MarketplaceListing.updateOne(
        { _id: listing._id },
        {
          $set: {
            autoPaused: true,
            lastError:
              "paused: advertised items are no longer claimable on any account",
          },
        },
      ).catch(() => {});
    }
    return actions;
  }
  if (covering > 0) {
    const sharers = await sharersForGame(listing.unclaimedGame);
    const share = sharers > 1 ? Math.floor(covering / sharers) : covering;
    if (share < 1) {
      // More shop windows than accounts: leave the quantity alone rather than
      // set 0, which on some platforms reads as "delisted" rather than "one
      // left". The operator can pause the surplus listings.
      actions.push(
        "not enough stock to split " + covering + " across " + sharers +
          " live listing(s) — left as is",
      );
      return actions;
    }
    actions.push(
      "quantity to " + share +
        (sharers > 1 ? " (" + covering + " split across " + sharers + " listings)" : ""),
    );
    if (!dryRun) {
      await setQty(share).catch((e) =>
        actions.push("quantity failed: " + e.message),
      );
    }
  }
  return actions;
}

module.exports = {
  SELLABLE_STATUSES,
  gameFilter,
  liveStockForGame,
  dominantOffer,
  itemsToRequired,
  advertisedItems,
  judge,
  sharersForGame,
  auditGame,
  auditAll,
  applyStock,
};
