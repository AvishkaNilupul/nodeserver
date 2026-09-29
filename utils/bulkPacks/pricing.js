// Bulk packs — pure price maths (docs/bulk-packs/CONTRACT.md §2, MODULES.md
// §pricing.js).
//
// PURE: no DB, no network, no settings read. Callers hand in the anchor rows,
// the set, the tier list and the farm price table (bp = settings.getBulkPacks()).
//
// Money rules this file carries (owner decisions, CONTRACT §2):
//   - eldorado / g2g: one unit is ALWAYS one account. The tier's discount comes
//     off the single-account anchor and the result is the PER-ACCOUNT price;
//     the tier itself only becomes the offer's minimum quantity.
//   - gameflip: one listing is ONE pack of exactly minQty accounts, so its
//     price is the WHOLE pack, on Gameflip's $0.25 grid.
//   - Prices are fixed when an offer is sent. Nothing here is ever used to
//     reprice a live bulk offer.
//   - No price is ever below the market's floor (config.MARKET_FLOORS), and a
//     missing or unusable anchor prices at 0 — which every caller reads as "no
//     price reference", never as "free".
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

// Per-account price on eldorado / g2g (and the per-account figure shown for a
// gameflip pack): max(MARKET_FLOORS[market], round2(anchor * (1 - d/100))).
// 0 when there is no usable anchor, or when the market has no floor (it is not
// a bulk-pack market, so there is nothing to price).
function unitPrice({ anchor, discountPct, market } = {}) {
  const a = validAnchor(anchor);
  if (!a) return 0;
  if (!hasOwn(MARKET_FLOORS, market)) return 0;
  const d = effectiveDiscount(discountPct);
  return Math.max(MARKET_FLOORS[market], round2(a * (1 - d / 100)));
}

// Whole-pack price for a gameflip pack of `size` accounts:
// max(0.75, roundQuarter(size * anchor * (1 - d/100))). 0 when the anchor is
// unusable or size is not a whole number >= 1.
function packPrice({ anchor, discountPct, size } = {}) {
  const a = validAnchor(anchor);
  const n = toNum(size);
  if (!a || !Number.isInteger(n) || n < 1) return 0;
  const d = effectiveDiscount(discountPct);
  return Math.max(MARKET_FLOORS.gameflip, roundQuarter(n * a * (1 - d / 100)));
}

// Farming packs are anchored on the owner's farm price table
// (bp.farmPrices = {eldorado: {"120": 3, ...}, g2g: {...}}), then priced like
// any other unit. A missing market or duration -> 0 (send.js answers 409).
function farmUnitPrice({ farmPrices, market, days, discountPct } = {}) {
  const table = hasOwn(farmPrices, market) ? farmPrices[market] : null;
  const dn = toNum(days);
  // 120, "120" and " 120 " all read the "120" column.
  const key = Number.isFinite(dn) ? String(dn) : String(days);
  const anchor = hasOwn(table, key) ? toNum(table[key]) : NaN;
  return unitPrice({ anchor, discountPct, market });
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
// sorted ascending). packPrice is only filled on gameflip (0 elsewhere).
// discountPct is echoed as the EFFECTIVE discount, so a label built from it
// always matches the price beside it. Entries without a whole minQty >= 1 are
// skipped rather than quoted.
function tierQuote({ anchor, market, tiers } = {}) {
  const out = [];
  for (const t of Array.isArray(tiers) ? tiers : []) {
    if (!t || typeof t !== "object") continue;
    const minQty = toNum(t.minQty);
    if (!Number.isInteger(minQty) || minQty < 1) continue;
    const discountPct = effectiveDiscount(t.discountPct);
    out.push({
      minQty,
      discountPct,
      unitPrice: unitPrice({ anchor, discountPct, market }),
      packPrice:
        market === "gameflip"
          ? packPrice({ anchor, discountPct, size: minQty })
          : 0,
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
  round2,
  roundQuarter,
  effectiveDiscount,
  unitPrice,
  packPrice,
  farmUnitPrice,
  pickAnchor,
  tierQuote,
  __setDeps,
  __resetDeps,
};
