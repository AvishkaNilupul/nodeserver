#!/usr/bin/env node
/**
 * Adds the price-tracker seam to utils/autoLister.js: one helper (`trackerPrice`) and
 * one line in each market's publisher. Idempotent, anchored, and it refuses to write
 * unless every anchor matches EXACTLY once — utils/autoLister.js on production holds
 * code that exists in no git ref (it is a union of branches), so this edits the
 * file in place instead of replacing it, the same way the allocation-forecast
 * exports were added (docs/PRICE-TRACKER-PLAN.md).
 *
 *   node scripts/apply-price-tracker-hook.js <path/to/autoLister.js>           # dry run: report only
 *   node scripts/apply-price-tracker-hook.js <path/to/autoLister.js> --write   # apply
 *
 * What it changes (and nothing else):
 *   + trackerPrice()  right after venuePrice()
 *   + `price = await trackerPrice("ggsel"|"zeusx"|"eldorado"|"g2g"|"playerauctions", ...)`
 *     in the five publishers, immediately before they reserve accounts.
 * Gameflip (the base price itself) and Digiseller (blocked) are deliberately not hooked.
 *
 * With autoFarm.priceTracker.mode "off" (the default) the helper does one settings read
 * and returns the price it was given. See utils/priceTracker/attach.js.
 */
const fs = require("fs");

const file = process.argv[2];
const write = process.argv.includes("--write");
if (!file) {
  console.error("usage: node scripts/apply-price-tracker-hook.js <autoLister.js> [--write]");
  process.exit(2);
}
let src = fs.readFileSync(file, "utf8");
const MARK = "async function trackerPrice(";
if (src.includes(MARK)) {
  console.log("already applied: " + file);
  process.exit(0);
}

const HELPER = `
// Price tracker seam (docs/PRICE-TRACKER-PLAN.md). Mode "off" — the shipped default —
// costs one settings read and returns the price it was given untouched; "shadow" logs
// what the tracker would charge beside it; only "apply", on a market the owner
// allowlisted, changes a price, and only within the guards in
// utils/priceTracker/attach.js. ANY failure returns the base price: the tracker must
// never be able to stop a listing.
async function trackerPrice(marketplace, basePriceUsd, { title = "", game = "", set = null } = {}) {
  try {
    const items =
      set && Array.isArray(set.items)
        ? set.items.map((i) => ({ itemKey: i.itemKey, game: i.game, qty: i.qty }))
        : [];
    const r = await require("./priceTracker/attach").priceForNew({
      marketplace,
      basePriceUsd,
      title,
      game: game || (items[0] && items[0].game) || "",
      itemCount: items.length,
      items,
    });
    return r && r.price > 0 ? r.price : basePriceUsd;
  } catch {
    return basePriceUsd;
  }
}
`;

function once(label, anchor, replacement) {
  const n = src.split(anchor).length - 1;
  if (n !== 1) {
    console.error("ANCHOR MISMATCH (" + n + " matches, need exactly 1): " + label);
    process.exit(1);
  }
  src = src.replace(anchor, () => replacement);
}

// 1. helper, directly after venuePrice()'s closing brace.
once(
  "helper after venuePrice",
  "    // must not stop a publish, and the Gameflip price is a defensible fallback.\n    return base;\n  }\n}\n",
  "    // must not stop a publish, and the Gameflip price is a defensible fallback.\n    return base;\n  }\n}\n" + HELPER,
);
// 2. GGSel: after the venue translation it already does.
once(
  "ggsel",
  '  price = await venuePrice("ggsel", price, { title });\n',
  '  price = await venuePrice("ggsel", price, { title });\n  price = await trackerPrice("ggsel", price, { title, set });\n',
);
// 3-6. The others: right before each reserves its accounts (after any no-claim gate).
for (const [m, tag] of [
  ["zeusx", "ZX_CLAIM_TAG"],
  ["eldorado", "ELD_CLAIM_TAG"],
  ["g2g", "G2G_CLAIM_TAG"],
  ["playerauctions", "PA_CLAIM_TAG"],
]) {
  once(
    m,
    "  accounts = await reserveAccountsForPublish(accounts, set, " + tag + ");\n",
    '  price = await trackerPrice("' + m + '", price, { title, game, set });\n  accounts = await reserveAccountsForPublish(accounts, set, ' + tag + ");\n",
  );
}

if (write) {
  fs.writeFileSync(file, src);
  console.log("applied: " + file);
} else {
  console.log("dry run OK — every anchor matched exactly once; re-run with --write to apply");
}
