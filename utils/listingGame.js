// The canonical answer to "what game is this listing".
//
// docs/ACCOUNT-LISTINGS-CONTRACT.md A1. Today that question has four spellings
// scattered across the publish route and the auto-lister, and `DropSet` has no
// `game` field at all — so `set.game` in the zeusx and eldorado publish
// branches (routes/marketplaceRoutes.js:936, :957) is dead code that has always
// evaluated to undefined. Every caller then re-invented the rest of the chain
// slightly differently, which is how a listing can be filed under the wrong
// marketplace category: the resolver was handed "" and picked whatever the
// market's search returned first.
//
// This module is the one chain. It is pure: plain objects in, string out, no
// I/O and no Mongoose. Callers may pass lean objects, hydrated documents, or
// half-hydrated "light" list rows whose `items` have not loaded yet — the last
// case is why the resolution must be re-run after hydration rather than cached
// by the caller (A5).
//
// The one thing it deliberately does NOT do is guess a game out of
// `listing.title`. Titles are marketing copy ("5x Twitch Drops Bundle — instant
// delivery"); a leading-token guess there is lossy in both directions and a
// wrong game is worse than no game, because "no game" is a visible refusal
// while a wrong one silently publishes into a wrong category.

// Re-exported, NOT re-implemented: utils/gameLabel.js already owns game-label
// canonicalisation for the drop archive, and a second normaliser that drifted
// from it would reintroduce exactly the silent misses it was written to stop.
const { normGame, sameGame } = require("./gameLabel");

function clean(v) {
  return typeof v === "string" ? v.trim() : "";
}

// listingGame({ set, offer, listing, game }) -> string ("" when unknowable)
//
// Precedence, most authoritative first:
//   1. an explicit `game` — the caller (or the owner's own form field) said so
//   2. offer.game        — Feature B: an account listing states its own game
//   3. set.game          — the dead spelling, kept so replacing the existing
//                          `set.game || set.coverGame || items…` chains with
//                          this function is provably a no-op rather than a
//                          reordering
//   4. set.coverGame     — what the custom-listing cover was generated for
//   5. the first non-empty set.items[i].game
//   6. listing.unclaimedGame / listing.rentFarmGame — the only two fields on a
//      MarketplaceListing that name a game outright (models/MarketplaceListing
//      .js:135, :244). A set-backed row carries neither, so this tail only
//      fires for rows that have no set to ask.
function listingGame(src) {
  const s = src && typeof src === "object" ? src : {};

  const explicit = clean(s.game);
  if (explicit) return explicit;

  const offer = s.offer && typeof s.offer === "object" ? s.offer : null;
  if (offer) {
    const g = clean(offer.game);
    if (g) return g;
  }

  const set = s.set && typeof s.set === "object" ? s.set : null;
  if (set) {
    const dead = clean(set.game);
    if (dead) return dead;
    const cover = clean(set.coverGame);
    if (cover) return cover;
    // A light list row has no `items` until ensureSetItems() hydrates it, so an
    // empty result here is "not known YET", not "not known".
    const items = Array.isArray(set.items) ? set.items : [];
    for (const it of items) {
      // Never spread a Mongoose sub-document — {...item} yields undefined for
      // every schema-declared field. Read through the getter.
      const g = it && typeof it === "object" ? clean(it.game) : "";
      if (g) return g;
    }
  }

  const listing = s.listing && typeof s.listing === "object" ? s.listing : null;
  if (listing) {
    const unclaimed = clean(listing.unclaimedGame);
    if (unclaimed) return unclaimed;
    const rent = clean(listing.rentFarmGame);
    if (rent) return rent;
  }

  return "";
}

// Lookup over a settings map keyed by game name (autoFarm.funpayNodes and
// friends are owner-typed objects, so their keys carry the same trademark /
// spacing drift the drop archive already tolerates). Exact key first — an
// operator who typed a key deliberately gets it verbatim — then the
// canonicalised match. Returns undefined when nothing matches, so a caller can
// tell "mapped to an empty value" from "not mapped", which is the difference
// between publishing with a blank node and refusing.
function gameMapLookup(map, game) {
  if (!map || typeof map !== "object") return undefined;
  const want = clean(game);
  if (!want) return undefined;
  if (Object.prototype.hasOwnProperty.call(map, want)) return map[want];
  const key = normGame(want);
  if (!key) return undefined;
  for (const k of Object.keys(map)) {
    if (normGame(k) === key) return map[k];
  }
  return undefined;
}

module.exports = { listingGame, gameMapLookup, normGame, sameGame };
