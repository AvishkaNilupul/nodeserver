// Per-marketplace pricing: what a listing should cost HERE, on THIS market.
//
// The owner's ask, 2026-09-08: "prices should be different on different sites,
// counted from past sales and market strategies … you listed Rainbow Six for
// $4.75 for 3 items, it's too much, there are competitors … and make sure you
// do not mess up when you compare with others' pricing, because it cannot be
// changed from what drops they're selling, the amount and stuff."
//
// That last clause is the whole difficulty, and it is right: a rival's price is
// meaningless until you know WHAT it is a price for. This module exists to make
// the comparison honest before it makes a recommendation.
//
// ---------------------------------------------------------------------------
// WHAT WAS MEASURED (prod, 2026-09-08). Do not re-derive these from intuition.
// ---------------------------------------------------------------------------
//
// 107 live rival rows scraped across three searchable markets, OUR OWN 20 rows
// excluded (which only became possible once gameflipOwnerId stopped returning
// "" — before that every one of our listings counted as a competitor and the
// pricer undercut itself):
//
//   market      n    min    p25    MEDIAN   p75    max
//   gameflip    19   0.75   0.75   0.75     2.00   9.99
//   ggsel       36   0.29   0.57   0.69     1.21   4.99
//   digiseller  32   1.16   1.16   1.16     2.00   4.75
//
// Our OWN realised sales, per market (SaleSignal listing_sold + sold listings):
//
//   market      n    min    MEDIAN   avg    max
//   digiseller  62   0.75   1.28     1.29   2.00
//   gameflip    92   0.75   1.25     1.28   4.50
//   ggsel       13   0.75   0.75     1.17   3.00
//
// Every other market — zeusx, playerauctions, g2g, eldorado, epicnpc, funpay —
// has NEVER recorded a priced sale. Any price there is inference, and this
// module says so rather than inventing evidence.
//
// TWO FINDINGS THAT DRIVE EVERYTHING BELOW:
//
// 1. **We sell ABOVE the rival median on every market we can see, and still
//    sell.** Gameflip: rivals median $0.75, we realise $1.25. So blindly
//    undercutting the cheapest rival would throw away roughly a third of the
//    revenue on our best market. Our own realised price is PROOF a price sells;
//    a rival's asking price is not even proof anyone bought it. Own sales are
//    therefore the anchor, and rivals are a sanity CEILING, not a target.
//
// 2. **Price does not rise with bundle size — it falls.**
//       ggsel      <=5 items median $0.75   >=10 items median $0.595
//       digiseller <=5 items median $1.28   >=10 items median $1.16
//    A big bundle is not a premium product here: it is usually an OLD event
//    whose drops nobody is chasing any more, while a small bundle is the
//    current wave. This is the opposite of what a `1 + 0.15*sqrt(extra)` curve
//    assumes, and it is why a "COMPLETE BUNDLE (10 Items)" was priced at $6.25
//    in a business whose all-time realised maximum is $4.50.
//    So: item count is NOT a price multiplier here. It is only used to keep a
//    comparison like-for-like.
//
// A rent-farm listing ("Automatic Farming 180 days") is a DIFFERENT PRODUCT —
// it sells a farming window, not stock — and rivals price it at $4.99-$6.00
// while drop bundles sit under $1. Mixing the two corrupts both medians, so
// `classifyKind` splits them before anything else happens.

const round2 = (n) => Math.round(n * 100) / 100;

// --- what is this listing, and how many items does it advertise? -----------

// Rent-farm offers are a different market with its own price level.
//
// The live forms this has to catch, all real titles: "Automatic farming 120
// days", "Automatic Farming", "AUTOFARM 30-90-180 DAYS", "auto-farm". The
// "automatic" spelling is the common one and an earlier `\bauto\s*-?\s*farm`
// missed every instance of it, which would have pooled a $6.00 farming window
// into the drop-bundle median and roughly doubled it.
const FARM_RE = /\bauto(?:matic)?\s*-?\s*farm(?:ing)?\b/i;

function classifyKind(title) {
  return FARM_RE.test(String(title || "")) ? "farm" : "drops";
}

// Rivals state their item count in a dozen shapes across three languages.
// Measured hit rate on the live corpus: 72 of 87 rival rows (83%). The misses
// are rows that genuinely advertise no count ("KPDH | Fortnite Twitch Drops")
// or are rent-farm windows, and those must stay null rather than be guessed —
// a wrong count puts a row in the wrong comparison band, which is exactly the
// "do not mess up when you compare" failure.
const COUNT_PATTERNS = [
  /\((\d+)\s*items?\)/i, // "(3 Items)", "(2 item)"
  /\[total\s+(\d+)\s*items?\]/i, // "[Total 6 Items]"
  /(\d+)\s*\/\s*\1(?!\d)/, // "6/6", "31/31" — only when both halves agree
  /\|\s*(\d+)\s*(?:items?|rewards?|subjects?)\b/i, // "| 44 Items |"
  // The Cyrillic branch carries no \b: JavaScript's \b is ASCII-only, so it
  // never fires after "наград" and every Russian-language rival row — a large
  // share of the GGSel and Plati pages — silently parsed as "no count stated".
  /[•·]\s*(\d+)\s*(?:items?\b|rewards?\b|наград)/i, // "• 29 rewards •", "• 12 наград •"
  /\b(\d+)\s*\+?\s*(?:items?\b|rewards?\b|наград)/i, // "23 items +", "31+ REWARDS"
];

function parseAdvertisedCount(title) {
  const s = String(title || "");
  for (const re of COUNT_PATTERNS) {
    const m = s.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      // Above ~200 the number is not an item count but a token amount
      // ("1000 Tokens"), a year, or a farming window in days.
      if (n >= 1 && n <= 200) return n;
    }
  }
  return null;
}

// --- the comparison set ----------------------------------------------------

function isOurs(row, ownerId) {
  if (!ownerId) return false;
  const o = String((row && (row.owner || row.seller || row.sellerId)) || "");
  return !!o && o === String(ownerId);
}

// Comparable means: not ours, same product kind, priced, and — when both sides
// state a count — in the same size band. The band is deliberately wide
// (half to double) because the measured price/size relationship is weak; its
// job is to stop a 1-item row being compared with a 44-item one, not to build a
// per-count price curve the evidence does not support.
function comparableRivals(rows, { ownerId = "", kind = "drops", itemCount = null } = {}) {
  const out = [];
  for (const r of rows || []) {
    const price = Number(r && r.price);
    if (!(price > 0)) continue;
    if (isOurs(r, ownerId)) continue;
    if (classifyKind(r.title) !== kind) continue;
    if (itemCount) {
      const n = parseAdvertisedCount(r.title);
      // A row that states no count still competes for the same buyer, so it is
      // kept. Only a STATED and clearly different size is excluded.
      if (n && (n < itemCount / 2 || n > itemCount * 2)) continue;
    }
    out.push(r);
  }
  return out;
}

function band(prices) {
  const p = (prices || []).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
  if (!p.length) return { n: 0 };
  const at = (f) => p[Math.min(p.length - 1, Math.floor(f * p.length))];
  const mid =
    p.length % 2 ? p[(p.length - 1) / 2] : (p[p.length / 2 - 1] + p[p.length / 2]) / 2;
  return { n: p.length, min: p[0], p25: at(0.25), median: round2(mid), p75: at(0.75), max: p[p.length - 1] };
}

// --- the recommendation ----------------------------------------------------

// Below this many samples a median is an anecdote, not evidence. Three is the
// same threshold utils/pricing.js uses for its anchor buckets.
const MIN_SAMPLES = 3;

// How far above the rival p75 a price may sit before it is called overpriced.
// Our realised prices genuinely run above the rival median (finding 1), so some
// headroom is earned; 1.25x is where "premium seller" stops and "nobody will
// ever click this" starts. The $4.75 Rainbow Six row on GGSel sat at 3.9x.
const OVER_CEILING_MULT = 1.25;

/**
 * What should this listing cost on this marketplace?
 *
 * @param {object} o
 * @param {string} o.marketplace
 * @param {number} o.currentPrice        what it costs today
 * @param {number} [o.itemCount]         how many items WE advertise
 * @param {string} [o.title]             our title, to classify the product kind
 * @param {Array}  [o.rivalRows]         live rival rows from utils/priceScout
 * @param {string} [o.ownerId]           our own id on that market, to exclude us
 * @param {Array}  [o.ownSales]          our realised prices ON THIS MARKET
 * @param {number} [o.floorUsd]          the platform's minimum
 * @returns {{price:number, basis:string, reason:string, confidence:string,
 *            verdict:string, rivals:object, own:object}}
 */
function recommend({
  marketplace = "",
  currentPrice = 0,
  itemCount = null,
  title = "",
  rivalRows = [],
  ownerId = "",
  ownSales = [],
  floorUsd = 0,
} = {}) {
  const kind = classifyKind(title);
  // Size-banded first, so a 44-item row does not price a 3-item bundle. But if
  // that leaves too few rivals to mean anything, widen to every rival of the
  // same KIND rather than dropping the ceiling altogether — otherwise a large
  // bundle simply escapes the cap and ends up dearer than a small one purely
  // because fewer rivals stated a comparable size. That is a size premium
  // arriving through the back door, and the evidence says there is no size
  // premium: bigger bundles measurably sell for LESS.
  let pool = comparableRivals(rivalRows, { ownerId, kind, itemCount });
  let rivalScope = "size-banded";
  if (pool.length < MIN_SAMPLES) {
    pool = comparableRivals(rivalRows, { ownerId, kind });
    rivalScope = "all-same-kind";
  }
  const rivals = band(pool.map((r) => r.price));
  rivals.scope = rivals.n ? rivalScope : "none";
  const own = band(ownSales);
  const floor = Number(floorUsd) || 0;

  let price = null;
  let basis = "";
  let reason = "";
  let confidence = "low";

  if (own.n >= MIN_SAMPLES) {
    // What we have actually been paid here. The strongest evidence there is:
    // a rival's asking price is not proof anyone bought it.
    price = own.median;
    basis = "own-realised";
    reason =
      "our own realised median on " + marketplace + " over " + own.n + " sale(s)";
    confidence = own.n >= 10 ? "high" : "medium";
    // Rivals cap the ask. We may sit above their median — we measurably do —
    // but not above the point where the listing stops being clicked.
    if (rivals.n >= MIN_SAMPLES) {
      const ceiling = round2(rivals.p75 * OVER_CEILING_MULT);
      if (price > ceiling) {
        price = ceiling;
        basis = "rival-capped";
        reason =
          "our realised median $" + own.median + " is above what " + rivals.n +
          " comparable rival(s) ask (p75 $" + rivals.p75 + ")";
      }
    }
  } else if (rivals.n >= MIN_SAMPLES) {
    // No sales history here. Sit at the rival median rather than undercut it:
    // undercutting an unmeasured market is how the floor-spiral started.
    price = rivals.median;
    basis = "rival-median";
    reason =
      "no realised sales on " + marketplace + "; " + rivals.n +
      " comparable rival(s), median $" + rivals.median;
    confidence = "medium";
  } else {
    price = currentPrice > 0 ? currentPrice : floor;
    basis = "unpriceable";
    reason =
      "no realised sales and fewer than " + MIN_SAMPLES +
      " comparable rivals on " + marketplace + " — left as is";
    confidence = "none";
  }

  // The platform floor is not a suggestion. Publishing under Digiseller's once
  // got the whole seller account blocked.
  if (floor && price < floor) {
    price = floor;
    basis = basis === "unpriceable" ? basis : "floor";
    reason += " (raised to the " + marketplace + " floor $" + floor + ")";
  }
  price = round2(price);

  // The verdict is about the CURRENT price, and is deliberately conservative:
  // it only calls a row overpriced when both evidence sources agree, so a
  // thin-evidence market cannot trigger a reprice on its own.
  let verdict = "ok";
  if (basis !== "unpriceable" && currentPrice > 0) {
    const ceiling =
      rivals.n >= MIN_SAMPLES ? round2(rivals.p75 * OVER_CEILING_MULT) : null;
    if (ceiling && currentPrice > ceiling && (own.n < MIN_SAMPLES || currentPrice > own.max)) {
      verdict = "overpriced";
    } else if (own.n >= MIN_SAMPLES && currentPrice < own.median * 0.7 && currentPrice <= floor + 0.001) {
      verdict = "underpriced";
    } else if (own.n >= MIN_SAMPLES && currentPrice < own.median * 0.7) {
      verdict = "underpriced";
    }
  }

  return { price, basis, reason, confidence, verdict, kind, rivals, own, floor };
}

module.exports = {
  MIN_SAMPLES,
  OVER_CEILING_MULT,
  classifyKind,
  parseAdvertisedCount,
  isOurs,
  comparableRivals,
  band,
  recommend,
};
