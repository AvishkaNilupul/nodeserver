// Bulk packs — pure price maths (docs/bulk-packs/PACKS-2.md §3, CONTRACT.md
// §2, MODULES.md §pricing.js).
//
// PURE: no DB, no network, no settings read. Callers hand in the anchor rows,
// the set, the tier list and the farm price table (bp = settings.getBulkPacks()).
//
// Money rules this file carries (owner decisions, PACKS-2 §1/§3, 2026-09-30):
//   - One bulk listing is ONE item priced as the WHOLE pack of N accounts, on
//     every market ("PACK OF 5 ACCOUNTS — $5.94"). The tier's discount comes
//     off the single-account anchor: pack = N x anchor x (1 - d/100), on
//     Gameflip's $0.25 grid there and to the cent on Eldorado / G2G.
//   - The market floor (config.MARKET_FLOORS) applies to the LISTING — the
//     pack — not to each account inside it.
//   - The owner may type a custom price per account: the pack is then
//     round2(price x N), refused below the floor, and flagged for a confirm
//     when it is far from the anchor (reviewCustomPrice).
//   - Prices are fixed when an offer is sent. Nothing here is ever used to
//     reprice a live bulk offer.
//   - A missing or unusable anchor prices at 0 — which every caller reads as
//     "no price reference", never as "free".
const { MARKET_FLOORS } = require("./config");

// The settings clamp every tier discount to 0..60 (CONTRACT §6; DropSet's own
// bulkDiscountPct has the same max). Out-of-range values cannot come from the
// settings, so a caller passing one is a bug — and the SAFE side of that bug is
// a higher price: an absent/garbled discount is 0%, anything above 60% is 60%.
// Without this, discountPct 100 (or a NaN that slipped through) would price a
// $10 bundle at the market floor.
const MAX_DISCOUNT_PCT = 60;

// A number, or a non-blank numeric string; anything else (null, booleans,
// arrays, "") is NaN rather than the 0/1 that Number() would make of it.
function toNum(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim()) return Number(v);
  return NaN;
}

function hasOwn(obj, key) {
  return (
    !!obj &&
    typeof obj === "object" &&
    typeof key === "string" &&
    Object.prototype.hasOwnProperty.call(obj, key)
  );
}

// ObjectId, hex string or populated doc -> hex string; "" when absent. (A
// mongoose ObjectId's `_id` getter returns the ObjectId itself, hence the guard
// against recursing into the same object.)
function idOf(v) {
  if (v == null || v === "") return "";
  if (typeof v === "object" && v._id != null && v._id !== v) return idOf(v._id);
  return String(v);
}

// Round half away from zero on the DECIMAL value a human reads, for `scale`
// steps per unit (100 = cents, 4 = quarters). toPrecision(15) first removes the
// binary noise of the multiply: 1.005 * 100 is 100.49999999999999 in floating
// point, and a bare Math.round would give 1.00 where the owner expects 1.01.
// Exact for anything money-sized (below ~1e12).
function roundTo(n, scale) {
  const sign = n < 0 ? -1 : 1;
  const r = (sign * Math.round(Number((Math.abs(n) * scale).toPrecision(15)))) / scale;
  return r === 0 ? 0 : r; // never -0
}

// Two decimal places; NaN / non-numeric / ±Infinity -> 0.
function round2(x) {
  const n = toNum(x);
  if (!Number.isFinite(n)) return 0;
  return roundTo(n, 100);
}

// Nearest $0.25, as a 2-dp number; NaN / non-numeric / ±Infinity -> 0.
function roundQuarter(x) {
  const n = toNum(x);
  if (!Number.isFinite(n)) return 0;
  return round2(roundTo(n, 4));
}

// The discount a price is actually built with: 0 when absent, invalid or
// negative, capped at MAX_DISCOUNT_PCT. Exported so copy.js prints the SAME
// "(N% off)" the price was computed with.
function effectiveDiscount(discountPct) {
  const d = toNum(discountPct);
  if (!Number.isFinite(d) || d <= 0) return 0;
  return Math.min(MAX_DISCOUNT_PCT, d);
}

function validAnchor(anchor) {
  const a = toNum(anchor);
  return Number.isFinite(a) && a > 0 ? a : 0;
}

function validSize(size) {
  const n = toNum(size);
  return Number.isInteger(n) && n >= 1 ? n : 0;
}

// The discounted single-account price, floored PER ACCOUNT:
// max(MARKET_FLOORS[market], round2(anchor * (1 - d/100))). 0 when there is no
// usable anchor, or when the market has no floor (it is not a bulk-pack market,
// so there is nothing to price). v1's per-account price; a v2 listing is priced
// by packPriceFor (the floor is per listing) — this stays for callers that show
// a discounted single price.
function unitPrice({ anchor, discountPct, market } = {}) {
  const a = validAnchor(anchor);
  if (!a) return 0;
  if (!hasOwn(MARKET_FLOORS, market)) return 0;
  const d = effectiveDiscount(discountPct);
  return Math.max(MARKET_FLOORS[market], round2(a * (1 - d / 100)));
}

// PACKS-2 §3: the price of ONE bulk listing = one pack of `size` accounts.
//   raw = size * anchor * (1 - d/100)
//   gameflip        -> roundQuarter(raw)   (Gameflip's $0.25 grid)
//   eldorado / g2g  -> round2(raw)
// and never below MARKET_FLOORS[market] — the floor is per LISTING now, so a
// pack of cheap accounts is lifted as a whole, never account by account. 0 when
// the anchor is unusable, the size is not a whole number >= 1, or the market is
// not a bulk-pack market.
function packPriceFor({ anchor, discountPct, size, market } = {}) {
  const a = validAnchor(anchor);
  const n = validSize(size);
  if (!a || !n) return 0;
  if (!hasOwn(MARKET_FLOORS, market)) return 0;
  const d = effectiveDiscount(discountPct);
  const raw = n * a * (1 - d / 100);
  const priced = market === "gameflip" ? roundQuarter(raw) : round2(raw);
  return Math.max(MARKET_FLOORS[market], priced);
}

// The Gameflip pack price (v1's name for packPriceFor on Gameflip):
// max(0.75, roundQuarter(size * anchor * (1 - d/100))).
function packPrice({ anchor, discountPct, size } = {}) {
  return packPriceFor({ anchor, discountPct, size, market: "gameflip" });
}

// PACKS-2 §3: the pack price for an owner-typed price PER ACCOUNT:
// round2(unitPrice * size). 0 for anything that is not a price above $0 or a
// whole size >= 1. No floor here — a custom pack below the market floor is
// REFUSED (reviewCustomPrice / send.js answer 400), never lifted silently.
function customPackPrice({ unitPrice: u, size } = {}) {
  const p = toNum(u);
  const n = validSize(size);
  if (!Number.isFinite(p) || p <= 0 || !n) return 0;
  return round2(p * n);
}

// What one account of a pack costs the buyer: round2(packPrice / size). The
// figure shown beside a pack price ("≈ $1.19 each") and stored as an offer's
// unitPrice; 0 when either input is unusable.
function perAccountPrice({ packPrice: p, size } = {}) {
  const v = toNum(p);
  const n = validSize(size);
  if (!Number.isFinite(v) || v <= 0 || !n) return 0;
  return round2(v / n);
}

// The owner's farm price table (bp.farmPrices = {eldorado: {"120": 3, ...},
// g2g: {...}}): the single-account price of `days` of farming on `market`, or
// 0 when the market, the duration or its price is missing.
function farmAnchor({ farmPrices, market, days } = {}) {
  const table = hasOwn(farmPrices, market) ? farmPrices[market] : null;
  const dn = toNum(days);
  // 120, "120" and " 120 " all read the "120" column.
  const key = Number.isFinite(dn) ? String(dn) : String(days);
  return validAnchor(hasOwn(table, key) ? table[key] : NaN);
}

// Farming anchored on the farm price table, priced like a unit (per account,
// floored per account). A missing market or duration -> 0.
function farmUnitPrice({ farmPrices, market, days, discountPct } = {}) {
  const anchor = farmAnchor({ farmPrices, market, days });
  return unitPrice({ anchor, discountPct, market });
}

// A farming pack of `size` accounts: packPriceFor on the farm table's price —
// N x the discounted farm price, floored per listing. 0 when unpriced.
function farmPackPrice({ farmPrices, market, days, discountPct, size } = {}) {
  const anchor = farmAnchor({ farmPrices, market, days });
  return packPriceFor({ anchor, discountPct, size, market });
}

// ---------------------------------------------------------------------------
// Custom prices (PACKS-2 §3)
// ---------------------------------------------------------------------------

// Below this share of the single price a custom per-account price needs the
// owner's explicit confirm (more than 30% off).
const CUSTOM_CONFIRM_BELOW_SHARE = 0.7;
// Comparisons in dollars carry binary noise (0.7 * 1.1 is 0.77000000000000002):
// a price exactly at a limit is AT it, not past it.
const EPS = 1e-9;

function usd(x) {
  return "$" + round2(x).toFixed(2);
}

// The checks an owner-typed price per account goes through before anything is
// published. Returns
//   { valid, unitPrice, packPrice, floor, belowFloor, warnings[],
//     pctOfAnchor, impliedDiscountPct, error }
//   valid        false when the price, the size or the market is unusable
//                (`error` says which) — the caller answers 400;
//   belowFloor   the pack is under MARKET_FLOORS[market] — a HARD refusal
//                (400): the floor is the market's own minimum per listing;
//   warnings     plain-English reasons the owner must confirm the price
//                (the caller answers 409 price_confirm unless confirmed):
//                  under 70% of the anchor, under the set's minPriceUsd (when
//                  > 0), or above the anchor (a buyer pays less buying singly);
//   impliedDiscountPct  the discount the price really gives off the anchor,
//                rounded DOWN to a whole percent (never overstated in a title
//                or on a cover), 0 when it is no discount.
function reviewCustomPrice({ unitPrice: u, anchor, minPriceUsd, market, size } = {}) {
  const out = {
    valid: false,
    unitPrice: 0,
    packPrice: 0,
    floor: hasOwn(MARKET_FLOORS, market) ? MARKET_FLOORS[market] : 0,
    belowFloor: false,
    warnings: [],
    pctOfAnchor: 0,
    impliedDiscountPct: 0,
    error: "",
  };
  const price = toNum(u);
  const n = validSize(size);
  if (!Number.isFinite(price) || price <= 0) {
    out.error = "the custom price per account must be a price above $0";
    return out;
  }
  if (!n) {
    out.error = "the pack size must be a whole number of 1 or more";
    return out;
  }
  if (!out.floor) {
    out.error = "that market has no bulk-pack price floor";
    return out;
  }
  out.valid = true;
  out.unitPrice = price;
  out.packPrice = customPackPrice({ unitPrice: price, size: n });
  out.belowFloor = !(out.packPrice >= out.floor - EPS);
  const a = validAnchor(anchor);
  const min = validAnchor(minPriceUsd);
  if (a) {
    out.pctOfAnchor = round2((price / a) * 100);
    out.impliedDiscountPct = Math.max(0, Math.floor((1 - price / a) * 100 + EPS));
    if (price < CUSTOM_CONFIRM_BELOW_SHARE * a - EPS) {
      out.warnings.push(
        usd(price) + " per account is " + Math.round((1 - price / a) * 100) +
          "% below the single price of " + usd(a) + " (more than " +
          Math.round((1 - CUSTOM_CONFIRM_BELOW_SHARE) * 100) + "% off)",
      );
    }
    if (price > a + EPS) {
      out.warnings.push(
        usd(price) + " per account is above the single price of " + usd(a) +
          " — a buyer pays less buying the accounts one by one",
      );
    }
  }
  if (min && price < min - EPS) {
    out.warnings.push(
      usd(price) + " per account is below this bundle's minimum price of " + usd(min),
    );
  }
  return out;
}

// The single-account price a bulk offer is discounted FROM.
//   1. Our own LOWEST live single listing of this set on this market: lean
//      MarketplaceListing rows with marketplace === market, status "active",
//      no bulkOfferId (a bulk row is already discounted — anchoring on it
//      would compound the discount), same set, price > 0 -> basis "listing".
//   2. Else the set's own price (DropSet.price > 0) -> basis "set".
//   3. Else nothing: {anchor: 0, basis: "none", listingId: ""}.
// A found anchor is then lifted to the set's minPriceUsd — the owner's "never
// below this" for the bundle; the basis stays where the number came from.
function pickAnchor({ rows, set, market } = {}) {
  const none = { anchor: 0, basis: "none", listingId: "" };
  if (!set || typeof set !== "object") return none;
  const setId = idOf(set._id);

  let best = null;
  if (setId && Array.isArray(rows)) {
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      if (row.marketplace !== market) continue;
      if (row.status !== "active") continue;
      if (row.bulkOfferId) continue;
      if (idOf(row.set) !== setId) continue;
      const price = validAnchor(row.price);
      if (!price) continue;
      // Strictly lower: on a tie the first row seen keeps it (deterministic).
      if (!best || price < best.price) best = { price, id: idOf(row._id) };
    }
  }

  let out;
  if (best) {
    out = { anchor: best.price, basis: "listing", listingId: best.id };
  } else {
    const setPrice = validAnchor(set.price);
    if (!setPrice) return none;
    out = { anchor: setPrice, basis: "set", listingId: "" };
  }
  const minPrice = validAnchor(set.minPriceUsd);
  if (minPrice > out.anchor) out.anchor = minPrice;
  return out;
}

// One quote per configured tier, in the order given (the settings keep them
// sorted ascending). PACKS-2: every market sells the tier as ONE pack of
// minQty accounts, so every quote carries the pack price (packPriceFor) and its
// per-account equivalent (packPrice / minQty) as unitPrice. discountPct is
// echoed as the EFFECTIVE discount, so a label built from it always matches the
// price beside it. Entries without a whole minQty >= 1 are skipped rather than
// quoted.
function tierQuote({ anchor, market, tiers } = {}) {
  const out = [];
  for (const t of Array.isArray(tiers) ? tiers : []) {
    if (!t || typeof t !== "object") continue;
    const minQty = toNum(t.minQty);
    if (!Number.isInteger(minQty) || minQty < 1) continue;
    const discountPct = effectiveDiscount(t.discountPct);
    const pack = packPriceFor({ anchor, discountPct, size: minQty, market });
    out.push({
      minQty,
      discountPct,
      unitPrice: perAccountPrice({ packPrice: pack, size: minQty }),
      packPrice: pack,
    });
  }
  return out;
}

// CONTRACT §9 asks every utils/bulkPacks module for this pair. This one is
// pure — there is nothing to inject — so both are deliberate no-ops.
function __setDeps() {}
function __resetDeps() {}

module.exports = {
  MAX_DISCOUNT_PCT,
  CUSTOM_CONFIRM_BELOW_SHARE,
  round2,
  roundQuarter,
  effectiveDiscount,
  unitPrice,
  packPriceFor,
  packPrice,
  customPackPrice,
  perAccountPrice,
  reviewCustomPrice,
  farmAnchor,
  farmUnitPrice,
  farmPackPrice,
  pickAnchor,
  tierQuote,
  __setDeps,
  __resetDeps,
};
