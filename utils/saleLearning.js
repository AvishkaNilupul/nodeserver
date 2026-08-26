// Records REAL sales — a buyer paid — as SaleSignal rows, which are the
// auto-farmer's training data for "does this game actually sell?".
//
// This exists because the system had no such record. The only sale-shaped
// signal being written was "drop_reserved", stamped by reserveSetOnAccount
// whenever stock was CLAIMED for a listing (auto-lister publish, guardian
// restock) — that is shelf-filling, not selling, and it happens before any
// buyer exists. Demand learning counted it, so farming a game produced its own
// evidence that the game was in demand: farm -> stock across N markets -> N
// "sales" -> more demand -> farm more. A game that never sold a unit could hold
// itself at full allocation and raise its own account cap.
//
// Meanwhile the actual purchases were being thrown away. Gameflip's poller
// flipped listings to sold without recording anything, and Plati/GGSel sell
// natively out of a stock pile — the guardian saw the pile shrink, topped it
// back up, and told nobody.
//
// Every path that learns a listing was bought comes here instead.
const MarketplaceListing = require("../models/MarketplaceListing");
const SaleSignal = require("../models/SaleSignal");
const { logEvent } = require("./systemLog");

// Distinct games a drop set sells. A bundle covering three games is three
// games' worth of demand evidence when it sells, one per game — never one
// signal per drop, which is what made a 50-item bundle read as 50 sales.
function gamesForSet(set) {
  if (!set || !Array.isArray(set.items)) return [];
  return [...new Set(set.items.map((i) => i && i.game).filter(Boolean))];
}

// Write one signal per (game, unit) for a listing that sold `units` units.
//
// The unit index comes from an atomic $inc on the listing, so two overlapping
// guardian passes can never mint the same dedupeKey and a retried pass cannot
// double-count: whoever increments first owns that range of unit numbers.
//
// `account` is set when we know which account the buyer received (Gameflip
// auto-delivery pins one account per listing). Quantity listings hand out
// whichever unit the platform picks, so it stays null there — which is why
// internalSalesForGame falls back to the dedupeKey when grouping, or every
// anonymous unit sale would collapse into a single "sale".
async function recordListingSale({
  listing,
  set,
  units = 1,
  at = new Date(),
  priceUsd = 0,
} = {}) {
  const n = Math.max(0, Math.floor(Number(units) || 0));
  if (!listing || !listing._id || !n) return 0;
  const games = gamesForSet(set);
  if (!games.length) return 0;

  const bumped = await MarketplaceListing.findOneAndUpdate(
    { _id: listing._id },
    { $inc: { unitsSold: n } },
    { new: true, projection: { unitsSold: 1 } },
  ).catch(() => null);
  // No row (deleted mid-pass) means no stable sequence to number units with,
  // so there is no safe dedupeKey — skip rather than risk double counting.
  if (!bumped) return 0;
  const end = Number(bumped.unitsSold) || n;
  const start = Math.max(0, end - n);

  let written = 0;
  for (let seq = start; seq < end; seq++) {
    for (const game of games) {
      const gameKey = String(game).toLowerCase();
      try {
        const r = await SaleSignal.updateOne(
          {
            dedupeKey:
              "sold:" + String(listing._id) + ":" + gameKey + ":" + seq,
          },
          {
            $setOnInsert: {
              game,
              gameKey,
              itemKey: "",
              name: listing.title || "",
              login: listing.accountLogin || "",
              account: listing.accountId || null,
              source: "listing_sold",
              marketplace: listing.marketplace || "",
              priceUsd: Number(priceUsd) || Number(listing.price) || 0,
              at,
            },
          },
          { upsert: true },
        );
        if (r.upsertedCount) written++;
      } catch {
        // Duplicate key (a racing pass got there first) or a transient write
        // error. Demand learning is best-effort by design — it must never be
        // able to fail a sale, a restock or a delist.
      }
    }
  }
  // Central audit of a real marketplace SALE — one place that covers every
  // platform (gameflip + Plati/GGSel quantity), since both funnel through here.
  logEvent({
    category: "sales",
    action: "sold",
    actor: "fulfiller",
    subject: listing.marketplace || "",
    count: n,
    game: games[0] || "",
    detail:
      "sold " +
      n +
      " unit(s) of " +
      (listing.title || "listing") +
      " on " +
      (listing.marketplace || "?") +
      (priceUsd ? " @ $" + priceUsd : ""),
    meta: {
      marketplace: listing.marketplace || "",
      games,
      units: n,
      priceUsd: Number(priceUsd) || Number(listing.price) || 0,
      listingId: String(listing._id),
      login: listing.accountLogin || "",
    },
  });
  return written;
}

// Quantity listings (Plati / GGSel) never announce a sale; the stock pile just
// gets smaller. Given what we left on the platform last pass and what is there
// now, the difference is what buyers took.
//
// Returns the number of units inferred as sold, so the caller can log it.
function unitsSoldSince(lastStock, remaining) {
  if (lastStock == null || remaining == null) return 0;
  const gone = Number(lastStock) - Number(remaining);
  return gone > 0 ? Math.floor(gone) : 0;
}

module.exports = { recordListingSale, unitsSoldSince, gamesForSet };
