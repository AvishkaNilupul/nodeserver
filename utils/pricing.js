// One pricing engine for every listing this system publishes.
//
// WHY THIS FILE EXISTS
// Four independent pricing models had drifted apart, and one of them was
// producing prices ~50-180x anything that has ever sold:
//
//   utils/autoLister.js       derivePrice()            Gameflip-anchored, anchor capped $10,
//                                                      ignores bundle size entirely
//   routes/catalogRoutes.js   recommendedProfilePrice() catalogRate * rewards -- LINEAR in
//                                                      item count and UNCAPPED. A 40-reward
//                                                      World of Tanks profile priced at
//                                                      $227.86 while the same business has
//                                                      never sold anything above $4.50.
//   utils/unclaimedAutoList.js priceForItems()         anchor x (1 + 15%/extra item), cap 2.5x
//   routes/catalogRoutes.js   clampPublicPrice()       flat $1.01-$2.99 owner rule
//
// MEASURED GROUND TRUTH (prod, 2026-09-08, every priced sale on record):
//   digiseller  n=62  min $0.75  median $1.28  max $2.00
//   gameflip    n=47  min $0.75  median $1.25  max $2.75   (sold listings: 89, max $4.50)
//   ggsel       n=11  min $0.75  median $1.00  max $3.00
//   every other marketplace: ZERO priced sales
//
// So the entire realised price distribution lives in $0.75-$2.00 with rare
// outliers to $4.50. Any model that can emit $227 is not "optimistic", it is
// unanchored. This module makes that structurally impossible: every price is
// derived from observed sales and clamped to a band that observed sales define.
//
// THE THREE RULES
//   1. Anchor on what BUYERS PAID, on the platform being sold to, for this game.
//      Widen the evidence net only when narrower evidence is too thin to trust.
//   2. Bundle size raises price SUB-LINEARLY and under a hard cap. A 40-item
//      bundle is worth more than a 1-item bundle; it is not worth 40x. Linear
//      scaling is exactly the bug this replaces.
//   3. Clamp to [floor, ceiling] where the ceiling is derived from the highest
//      price that has actually been realised, times a headroom multiple -- so
//      the ceiling rises on its own as real evidence arrives, and never on
//      arithmetic alone.
//
// This module is deliberately PURE: no database, no settings file, no network.
// Callers gather evidence (see gatherEvidence in utils/pricingEvidence.js) and
// pass it in. That is what makes every rule here directly testable, and it is
// why the catalog bug was invisible for so long -- its math lived inside a
// route handler with a database call in the middle of it.

/* ----------------------------- configuration ----------------------------- */

// Defaults chosen against the measured distribution above. Every one is
// overridable per call so the owner can tune from settings without a deploy.
const DEFAULTS = {
  // Absolute floor. Gameflip clamps listings at $0.75 and nothing has ever
  // sold below it, so it is the real-world minimum, not a guess.
  floorUsd: 0.75,
  // Hard backstop ceiling, applied after every other rule. Generous next to a
  // $4.50 observed maximum precisely so it only ever catches a MODEL failure
  // (an unanchored multiply, a corrupt evidence row) rather than shaping
  // normal prices. The $227 bug would have been caught here even if every
  // other guard had been bypassed.
  maxAbsoluteUsd: 25,
  // The ceiling that actually shapes prices: highest realised sale on this
  // platform x this multiple. With Gameflip's $4.50 max that is a $9.00
  // ceiling -- room to test higher prices, no room to invent them.
  ceilingHeadroom: 2,
  // Bundle curve. `1 + step * sqrt(extraItems)`, capped at capMult.
  //   1 item  -> 1.00x     10 items -> 1.45x
  //   5 items -> 1.30x     40 items -> 1.94x  (cap 2.5x never reached)
  //
  // CALIBRATED AGAINST REALISED SALES, not assumed. Measured on prod over the
  // 89 sold listings whose bundle size is recoverable (2026-09-08):
  //
  //   items    n   min    MEDIAN   max
  //   1       33   $0.75  $1.25    $1.50
  //   2-3     17   $0.75  $1.00    $2.00
  //   4-9     21   $0.75  $1.25    $2.75
  //   10-24    8   $0.75  $1.00    $2.00
  //   25+     10   $1.00  $1.25    $4.50
  //   correlation(itemCount, price) r = 0.327
  //
  // The MEDIAN is FLAT across bundle size -- buyers pay ~$1.25 for an account
  // whether it holds 1 drop or 58. Only the upper tail rises with size
  // ($1.50 max at 1 item vs $4.50 at 25+). So bundle size is worth a modest
  // premium, not a proportional one, and anything resembling `rate * items` is
  // contradicted by every row of this table.
  //
  // sqrt, not linear: the second drop on an account adds real value, the
  // fortieth adds almost none, because the buyer is buying ONE ACCOUNT. At 40
  // items this yields $2.42 from a $1.25 anchor -- above the $1.25 median that
  // big bundles actually clear, comfortably under the $4.50 they top out at.
  bundleStepPct: 15,
  bundleCapMult: 2.5,
  // A full/complete event bundle is worth a premium over a partial one.
  fullEventBonusPct: 25,
  // How many priced sales a bucket needs before its median is trusted as an
  // anchor. Below this, one lucky bundle sale would set the price of every
  // single-account listing (Hunt: Showdown showed $28.20 over 5 sales while
  // its cheapest live listing was $0.75).
  minSamples: 3,
  // Undercut live competition by this much to be the listing that sells.
  undercutPct: 5,
};

function cfg(opts) {
  return { ...DEFAULTS, ...(opts && typeof opts === "object" ? opts : {}) };
}

// Per-marketplace hard minimums. These are PLATFORM RULES, not preferences:
// publishing under them is rejected, silently clamped, or -- on Plati/Digiseller
// -- gets the seller account BLOCKED, which took the entire marketplace feed
// offline once already (see tests/platiPriceFloor.test.js).
//
// Mirrored here rather than imported so this module stays pure and free of
// utils/marketplaces.js (a ~5,800-line module that opens sockets on require).
// tests/pricing.test.js asserts these stay identical to the connector
// constants, so the duplication cannot silently drift.
//
// PlayerAuctions' $5 minimum is why every PA listing sits at exactly $5.00.
// That is the floor doing its job, NOT the pricer overreaching -- an audit that
// reads it as "overpriced" and repricing down to a $1.25 Gameflip median would
// produce listings PA refuses to accept.
const MARKETPLACE_FLOORS = {
  digiseller: 1.28,
  playerauctions: 5,
  zeusx: 1,
  eldorado: 0.5,
  // G2G enforces "(min_qty * unit_price) >= USD 1"; our offers all carry
  // min_qty 1, so a whole dollar is the real floor. See G2G_MIN_PRICE.
  g2g: 1,
  gameflip: 0.75,
};

/** The binding floor for a marketplace, or the global default when unknown. */
function floorForMarketplace(marketplace, fallback = DEFAULTS.floorUsd) {
  const key = String(marketplace || "").toLowerCase();
  const floor = MARKETPLACE_FLOORS[key];
  return Number.isFinite(floor) ? floor : fallback;
}

/* -------------------------------- helpers -------------------------------- */

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function positives(values) {
  return (Array.isArray(values) ? values : [])
    .map(num)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
}

/** Median of the positive values, or 0 when there are none. */
function median(values) {
  const rows = positives(values);
  if (!rows.length) return 0;
  const mid = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[mid] : (rows[mid - 1] + rows[mid]) / 2;
}

/** Round to cents. Prices are money; they are never carried at full float. */
function cents(value) {
  return Math.round(num(value) * 100) / 100;
}

/**
 * How much a bundle of `itemCount` copies is worth relative to a single-item
 * listing. Sub-linear by construction and hard-capped.
 *
 * This is the single most important function here: replacing a LINEAR
 * `rate * items` with this curve is what takes a 40-reward profile from
 * $227.86 down to a price a buyer has actually paid.
 */
function bundleMultiplier(itemCount, opts) {
  const { bundleStepPct, bundleCapMult } = cfg(opts);
  const extra = Math.max(0, Math.floor(num(itemCount)) - 1);
  if (!extra) return 1;
  const step = Math.max(0, num(bundleStepPct)) / 100;
  const cap = Math.max(1, num(bundleCapMult));
  return Math.min(cap, 1 + step * Math.sqrt(extra));
}

/* ------------------------------ the anchor ------------------------------- */

// Evidence buckets, strongest first. Each is a list of realised prices.
// The first bucket with >= minSamples entries wins; a bucket that exists but
// is too thin is SKIPPED rather than blended, because blending thin evidence
// with strong evidence is how a single bundle sale poisons a whole game.
// Ordered by how well a bucket answers "what is THIS game worth", not merely by
// how strong the evidence type is. That distinction was got wrong once and is
// worth stating: realised sales beat asking prices ONLY while they are about the
// same game. A cross-game realised median is not better evidence for League of
// Legends than what a rival actually asks for League of Legends -- and because
// the `global` bucket is never empty, putting it above the rival signal meant
// the rival signal could never be reached at all. Every unproven game collapsed
// onto one business-wide number (measured: 49 of 77 live-campaign games would
// have moved to an identical $1.63, LoL down from $4.75).
//
// So: own sales for THIS game first, then the game-specific competitor, and
// only then the cross-game aggregates.
const ANCHOR_LADDER = [
  // What buyers paid, on this platform, for this game. The only bucket that
  // answers the question being asked exactly.
  ["platformGame", "own sales on this marketplace for this game"],
  // This game elsewhere: the product is right, the venue is not.
  ["game", "own sales for this game across marketplaces"],
];

// Buckets that are about OTHER games. Consulted only after the game-specific
// competitor signal, because a venue's average price across unrelated games is
// a weaker guide to this listing than this game's own market.
const FALLBACK_LADDER = [
  // This platform, any game: captures a venue's price level (PlayerAuctions
  // buyers pay more than ZeusX buyers) when the game itself is unproven.
  ["platform", "own sales on this marketplace across games"],
  // Anything we have ever sold.
  ["global", "own sales across the business"],
];

/**
 * Pick the anchor price and say WHERE it came from. The reason string is
 * returned, not logged, so callers can show the operator why a price is what
 * it is -- an unexplainable price is one nobody can sanity-check.
 */
function resolveAnchor(evidence, opts) {
  const conf = cfg(opts);
  const { minSamples, undercutPct } = conf;
  const ev = evidence && typeof evidence === "object" ? evidence : {};
  const pick = (ladder) => {
    for (const [key, label] of ladder) {
      const rows = positives(ev[key]);
      if (rows.length >= minSamples) {
        return { anchor: median(rows), basis: key, samples: rows.length, reason: label };
      }
    }
    return null;
  };

  // 1. Own sales for THIS game.
  const own = pick(ANCHOR_LADDER);
  if (own) return own;

  // 2. This game's own market. A competitor's live price is an ASKING price,
  //    so it is weaker than a realised sale of the same game -- but stronger
  //    than a realised sale of a DIFFERENT game, which is all that is left.
  //    Undercut it so we are the listing that sells.
  const rival = num(ev.rivalLowest);
  if (rival > 0) {
    return {
      anchor: rival * (1 - undercutPct / 100),
      basis: "rival",
      samples: 0,
      reason: "no own sales for this game; undercutting the cheapest live competitor",
    };
  }
  const research = num(ev.researchMedian);
  if (research > 0) {
    return {
      anchor: research,
      basis: "research",
      samples: 0,
      reason: "no own sales for this game; market research median",
    };
  }

  // 3. Cross-game aggregates: nothing game-specific exists at all.
  const fallback = pick(FALLBACK_LADDER);
  if (fallback) return fallback;

  return {
    anchor: 0,
    basis: "none",
    samples: 0,
    reason: "no evidence of any kind; holding at the floor",
  };
}

/* ------------------------------ the venue -------------------------------- */

// How far a cross-market price has to move to be a price for THIS venue.
//
// The anchor ladder falls through `platformGame` (this venue, this game) to
// `game` (this game, ANY venue) long before it reaches `platform` (this venue,
// any game). For a thin market that fallthrough is not an edge case, it is the
// normal path: measured on prod 2026-09-09, 0 of GGSel's 10 game-buckets hold
// the 3 samples the top rung needs, so EVERY GGSel row is priced off evidence
// earned somewhere else. The venues are not interchangeable — our realised
// medians are Gameflip $1.25 (n=172), Digiseller $1.28 (n=62), GGSel $0.75
// (n=13) — so "what this game fetches across the business" systematically
// overprices the cheap venue. That is how 62 of 64 live GGSel rows came to be
// slated for a RAISE on a market where we have never once been paid the median
// we were already asking.
//
// So: keep the cross-market bucket for SHAPE (which game is worth more than
// another — the venue alone can never tell us that with 13 sales) and rescale
// it to the venue's own price LEVEL. The factor is the ratio of medians, which
// is exactly the quantity being corrected for, and it needs no new inputs.
//
// Guards, because 13 samples is not many:
//   * the venue needs `minSamples` realised sales, or there is nothing to
//     measure and the factor is 1 (no adjustment, current behaviour);
//   * the factor is clamped to [0.4, 1.5]. A thin sample that says "this venue
//     pays a fifth of everywhere else" is far likelier to be a quiet run of
//     floor-priced sales than a real fifth, and a price cut that deep should be
//     a human's decision, not a median's.
const VENUE_FACTOR_MIN = 0.4;
const VENUE_FACTOR_MAX = 1.5;

function venueFactor(evidence, opts) {
  const { minSamples } = cfg(opts);
  const ev = evidence && typeof evidence === "object" ? evidence : {};
  const here = positives(ev.platform);
  const everywhere = positives(ev.global);
  if (here.length < minSamples || everywhere.length < minSamples) return 1;
  const mine = median(here);
  const all = median(everywhere);
  if (!(mine > 0) || !(all > 0)) return 1;
  const raw = mine / all;
  return Math.min(VENUE_FACTOR_MAX, Math.max(VENUE_FACTOR_MIN, raw));
}

// Which anchor bases describe a price earned somewhere OTHER than this venue,
// and therefore need rescaling to it. `platformGame` and `platform` are already
// this venue's own money. `rival` and `research` can only be reached when
// pricing Gameflip (utils/pricingEvidence.js supplies them for no other venue),
// so they are this venue's evidence too, by construction.
const CROSS_MARKET_BASES = new Set(["game", "global"]);

// Rescaling fixes the LEVEL but not the TAIL. GGSel's 13 realised sales are
// $0.75 x7, $1.00 x2, $1.50, $1.75 x2, $3.00 — a p75 of $1.50 and one lucky
// $3.00. A cross-market anchor for a dear game still landed at $2.20 after
// scaling, which asks GGSel buyers for a price GGSel has reached once in
// thirteen sales, on the strength of what the game fetches on Gameflip.
//
// So a price earned somewhere else may not claim this venue's top quartile.
// Below p75 the game's own shape still comes through (a dearer game is still
// dearer than a cheap one); above it, the claim rests entirely on other
// venues' money and the cap binds. The venue's OWN evidence — `platformGame`
// and `platform` — is never capped: if GGSel really does pay $3.00 for a game,
// that is GGSel's own answer and it stands.
function venueCap(evidence, opts) {
  const { minSamples } = cfg(opts);
  const ev = evidence && typeof evidence === "object" ? evidence : {};
  const here = positives(ev.platform).sort((a, b) => a - b);
  if (here.length < minSamples) return 0;
  return here[Math.min(here.length - 1, Math.floor(0.75 * here.length))];
}

/* ------------------------------- the ceiling ----------------------------- */

/**
 * The price band. The ceiling is derived from the highest price actually
 * realised on this platform (falling back to the business-wide maximum), so it
 * widens by itself as real sales come in and never on arithmetic alone.
 */
function priceBand(evidence, opts) {
  const { floorUsd, maxAbsoluteUsd, ceilingHeadroom, minSamples } = cfg(opts);
  const ev = evidence && typeof evidence === "object" ? evidence : {};
  const floor = Math.max(0, num(floorUsd), num(ev.floorUsd));
  // The ceiling is the most we have ever actually been paid, plus headroom.
  // Taken across ALL venues it is the most we have been paid ANYWHERE, which on
  // the cheap venues is not a ceiling at all: GGSel's own maximum is $3.00, the
  // business-wide maximum is $5.00, so a $10.00 GGSel price cleared a ceiling
  // built out of Gameflip money. When this venue has enough realised sales to
  // speak for itself, its own maximum binds; otherwise fall back to everything,
  // which is all an unproven venue has.
  const venueMax = Math.max(0, ...positives(ev.platformGame), ...positives(ev.platform));
  const anywhereMax = Math.max(
    0,
    ...positives(ev.platformGame),
    ...positives(ev.platform),
    ...positives(ev.game),
    ...positives(ev.global),
  );
  const venueSpeaks = positives(ev.platform).length >= minSamples;
  const observedMax = venueSpeaks && venueMax > 0 ? venueMax : anywhereMax;
  const absolute = Math.max(0, num(maxAbsoluteUsd));
  const evidenceCeiling = observedMax > 0 ? observedMax * Math.max(1, num(ceilingHeadroom)) : 0;
  // With no realised sale anywhere, there is nothing to scale from. Use the
  // absolute backstop rather than inventing a ceiling from the floor, which
  // would pin an unproven platform to near-floor prices forever.
  //
  // Report WHICH of the two is binding. An operator looking at a clamped price
  // needs to know whether the market capped it ("evidence") or whether the
  // model's own safety net did ("absolute") -- the second means the inputs are
  // wrong, and that is a bug report, not a pricing decision.
  const useEvidence = evidenceCeiling > 0 && evidenceCeiling <= absolute;
  const ceiling = useEvidence ? evidenceCeiling : absolute;
  return {
    floor,
    ceiling: Math.max(floor, ceiling),
    observedMax,
    ceilingSource: useEvidence ? "evidence" : "absolute",
  };
}

/* -------------------------------- the price ------------------------------ */

/**
 * Price one listing.
 *
 * @param {object} input
 * @param {object} input.evidence   realised prices by bucket + rival/research signals
 * @param {number} input.itemCount  how many drops the bundle promises (default 1)
 * @param {boolean} input.fullEvent whether this bundle completes its event
 * @param {number} input.soldFloorUsd  never price below what this exact set sold at
 * @param {object} input.opts       per-call config overrides
 * @returns {{price:number, anchor:number, basis:string, reason:string,
 *            multiplier:number, floor:number, ceiling:number, clamped:string}}
 */
function priceListing({
  evidence = {},
  itemCount = 1,
  fullEvent = false,
  soldFloorUsd = 0,
  marketplace = "",
  opts = {},
} = {}) {
  const conf = cfg(opts);
  const resolved = resolveAnchor(evidence, conf);
  const { basis, samples } = resolved;
  let { anchor, reason } = resolved;
  // Rescale a price earned on other venues to the level of THIS one. See
  // venueFactor: without it a thin market is priced entirely on the strength of
  // a rich one, which is the whole reason GGSel drifted to double its own
  // realised median.
  const crossMarket = CROSS_MARKET_BASES.has(basis);
  const vf = crossMarket ? venueFactor(evidence, conf) : 1;
  if (vf !== 1 && anchor > 0) {
    anchor = anchor * vf;
    reason +=
      " (scaled x" +
      (Math.round(vf * 100) / 100) +
      " to " +
      (evidence.marketplace || "this venue") +
      "'s own price level)";
  }
  const cap = crossMarket ? venueCap(evidence, conf) : 0;
  if (cap > 0 && anchor > cap) {
    anchor = cap;
    reason +=
      ", capped at the p75 of what " +
      (evidence.marketplace || "this venue") +
      " has actually paid ($" +
      cents(cap) +
      ")";
  }
  // The marketplace's own minimum is folded in as a floor before the band is
  // computed, so a platform whose floor sits ABOVE the evidence ceiling (as
  // PlayerAuctions' $5 does against a $4.50 observed max) still yields a legal
  // price rather than one the connector would reject.
  const marketFloor = marketplace
    ? floorForMarketplace(marketplace, conf.floorUsd)
    : conf.floorUsd;
  const band = priceBand({ ...evidence, floorUsd: Math.max(num(evidence.floorUsd), marketFloor) }, conf);

  const multiplier = bundleMultiplier(itemCount, conf);
  const eventBonus = fullEvent ? 1 + Math.max(0, num(conf.fullEventBonusPct)) / 100 : 1;

  // No evidence at all -> hold at the floor rather than emit a made-up number.
  const raw = anchor > 0 ? anchor * multiplier * eventBonus : band.floor;

  // The sold floor is the one input that may exceed the evidence ceiling: if a
  // buyer really paid $8 for THIS set, that is not a model artefact, it is the
  // strongest evidence there is. It still yields to the absolute backstop.
  const soldFloor = Math.max(0, num(soldFloorUsd));
  const floor = Math.max(band.floor, soldFloor);

  let price = cents(raw);
  let clamped = "";
  if (price > band.ceiling && soldFloor <= band.ceiling) {
    price = cents(band.ceiling);
    // Name the binding constraint, not just the fact of clamping.
    clamped = band.ceilingSource === "absolute" ? "absolute" : "ceiling";
  }
  if (price < floor) {
    price = cents(floor);
    clamped = soldFloor > band.floor ? "sold-floor" : "floor";
  }
  const absolute = Math.max(0, num(conf.maxAbsoluteUsd));
  if (absolute > 0 && price > absolute) {
    price = cents(absolute);
    clamped = "absolute";
  }

  return {
    price,
    anchor: cents(anchor),
    basis,
    samples,
    reason,
    multiplier: Math.round(multiplier * 1000) / 1000,
    venueFactor: Math.round(vf * 1000) / 1000,
    fullEvent: !!fullEvent,
    floor: cents(floor),
    marketFloor: cents(marketFloor),
    ceiling: cents(band.ceiling),
    observedMax: cents(band.observedMax),
    clamped,
  };
}

/**
 * Should an existing live listing be repriced? Only when it has drifted far
 * enough to be worth the marketplace churn -- republishing costs API calls,
 * resets listing age on some platforms, and on Digiseller is IRREVERSIBLE
 * (no edit API: utils/digisellerFulfiller.js). Small drift is noise.
 */
function shouldReprice(currentUsd, targetUsd, driftPct = 20) {
  const current = num(currentUsd);
  const target = num(targetUsd);
  if (current <= 0 || target <= 0) return false;
  const drift = Math.abs(target - current) / current;
  return drift * 100 >= Math.max(0, num(driftPct));
}

module.exports = {
  venueFactor,
  venueCap,
  VENUE_FACTOR_MIN,
  VENUE_FACTOR_MAX,
  DEFAULTS,
  MARKETPLACE_FLOORS,
  bundleMultiplier,
  floorForMarketplace,
  median,
  priceBand,
  priceListing,
  resolveAnchor,
  shouldReprice,
};
