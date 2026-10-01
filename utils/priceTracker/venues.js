// What each marketplace is, for pricing purposes.
//
// Three different things get called "the price" and they must not be mixed:
//   gross   what the BUYER paid          <- all evidence, all comparisons use this
//   net     what we keep after fees      <- informational, "where should stock go"
//   floor   the lowest legal price       <- a hard rule, see pricing.js
//
// Evidence is gross because that is what a sale record holds. Translating a
// price between markets is done on gross-to-gross ratios (what buyers on THAT
// market pay), never through a fee guess — so a wrong fee rate can change the
// net column but can never change a recommended price.
//
// FEES. Only two are written down anywhere in this repo (G2G docs: Normal Seller
// 9.99%; Eldorado plan: "10% fee on gameId 235"). The rest are the platforms'
// published headline rates as the owner last knew them and are flagged
// `verified: false` so the page says "assumed" next to them. Override them
// without a deploy via settings `priceTracker.fees` ({ market: pct }).
const { floorForMarketplace } = require("../pricing");

const VENUES = {
  gameflip: {
    label: "Gameflip",
    feePct: 8,
    verified: false,
    // Quantity: one unit per listing row (relist chain), sale ends the row.
    saleModel: "single-unit",
    repriceMode: "in-place (off-sale, patch, restore)",
    note: "Price cannot change while onsale; reprice takes it off sale, patches, restores.",
  },
  digiseller: {
    label: "Digiseller (Plati)",
    feePct: 10,
    verified: false,
    saleModel: "quantity",
    repriceMode: "in-place price API; text needs republish",
    note: "BLOCKED by owner since 2026-09-28 — never list or feed. Evidence is history only.",
    blocked: true,
  },
  ggsel: {
    label: "GGSel",
    feePct: 10,
    verified: false,
    saleModel: "quantity",
    repriceMode: "in-place PATCH, prices in roubles",
    note: "Per-category minimum price; prices in RUB (usdToRub). Pace reads: a 7,500-read sweep got the server cut off ~10h.",
  },
  zeusx: {
    label: "ZeusX",
    feePct: 8,
    verified: false,
    saleModel: "single-unit",
    repriceMode: "read-modify-write; 500s may have applied — verify by read-back",
    note: "No sale evidence is ever recorded here today.",
  },
  eldorado: {
    label: "Eldorado",
    feePct: 10,
    verified: true,
    saleModel: "order-units",
    repriceMode: "in-place (eldoradoReprice)",
    note: "Sales are delivered units with a real order id; price is the row's price now.",
  },
  playerauctions: {
    label: "PlayerAuctions",
    feePct: 10,
    verified: false,
    saleModel: "order-units",
    repriceMode: "floor $5 — every row sits at the platform minimum",
    note: "$5 is the platform floor, not overpricing.",
  },
  g2g: {
    label: "G2G",
    feePct: 9.99,
    verified: true,
    saleModel: "order-units",
    repriceMode: "offer update",
    note: "Commission 9.99% for a Normal Seller (docs/G2G-INTEGRATION-PLAN.md).",
  },
};

const MARKETS = Object.keys(VENUES);

function feeFor(market, overrides) {
  const o = overrides && overrides[market];
  if (Number.isFinite(Number(o)) && Number(o) >= 0 && Number(o) < 60) {
    return { feePct: Number(o), verified: true, source: "settings" };
  }
  const v = VENUES[market];
  if (!v) return { feePct: 0, verified: false, source: "unknown" };
  return { feePct: v.feePct, verified: !!v.verified, source: v.verified ? "docs" : "assumed" };
}

/** What we keep from a gross price. */
function netOf(grossUsd, market, overrides) {
  const { feePct } = feeFor(market, overrides);
  return Math.round(Number(grossUsd) * (1 - feePct / 100) * 100) / 100;
}

function floorFor(market) {
  return floorForMarketplace(market);
}

module.exports = { VENUES, MARKETS, feeFor, netOf, floorFor };
