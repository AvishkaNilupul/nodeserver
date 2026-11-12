"use strict";

// Starting prices for newly planned code products, not a live repricer.
// Owner's 2026-11-08 Overwatch tiers: skins $1.99, multi-code loot-box
// bundles $1.49, simpler rewards $1. Other games retain their $1 default.
// Use reward labels only: campaign/title text must not inflate the price.
function startingPriceUsd(gameNo, slots) {
  if (String(gameNo) !== "12") return 1;
  const labels = (Array.isArray(slots) ? slots : []).map((s) =>
    String((s && s.label) || "").trim(),
  );
  const cosmetic = /\b(?:spray|icon|avatar|name\s*card)\b/i;
  if (labels.some((s) => /\bskins?\b/i.test(s) && !cosmetic.test(s))) return 1.99;
  if (labels.length > 1 && labels.some((s) => /\bloot\s*box(?:es)?\b/i.test(s) && !cosmetic.test(s))) return 1.49;
  return 1;
}

module.exports = { startingPriceUsd };
