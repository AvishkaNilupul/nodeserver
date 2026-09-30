# Bulk packs v2 — one listing = one pack (frozen, 2026-09-30)

Owner decision (2026-09-30): a bulk listing is ONE item priced as the whole pack
("PACK OF 5 ACCOUNTS — $4.00"), on every market. No minimum-order rule. The owner
may type a custom price. This REPLACES the v1 "1 unit = 1 account + minQuantity"
model on Eldorado and G2G (CONTRACT §2). Everything else in CONTRACT.md, FIXES-1.md
and FIXES-2.md still applies (locks, two-phase release, holds, keepReserved, I1–I13).
There are zero bulk offers on prod (switch off), so there is no migration.

## 1. Semantics (all markets, all sources)
- Tier = pack size N (bp.tiers minQty, e.g. 5 / 10) + discount.
- **Eldorado / G2G:** one listing per (bundle|game+days, market, N). Listing quantity =
  number of PACKS in stock; minQuantity / minQty = 1. One unit bought = N accounts.
- **Gameflip:** unchanged (one listing = one pack of exactly N, code holds all N).
- Every bulk MarketplaceListing row carries `bulkPackSize: N` (new field, Number,
  default 0 = not a pack). Farm offers have no row; their N is the BulkOffer's `minQty`.
- **The ONE multiplier** lives in `utils/bulkPacks/packMath.js` (owner P1):
  ```
  packSizeOf(row)            -> N >= 2 when row.bulkOfferId && row.bulkPackSize >= 2, else 1
  accountsForUnits(row, u)   -> u * packSizeOf(row)          // u = units the buyer bought
  packsFor(freeAccounts, N)  -> floor(freeAccounts / N)       // what a listing may advertise
  ```
  No other code multiplies. A non-bulk row is always ×1 (existing behaviour, byte-for-byte).

## 2. Delivery (owner P1 — fulfillers + farm services + model field)
- `models/MarketplaceListing.js`: add `bulkPackSize: { type: Number, default: 0 }`.
- **eldoradoFulfiller** reserved-units tail and no-claim branch: for a bulk row, the
  accounts to hand over = `accountsForUnits(listing, qty)`; fewer free than that →
  the "bulk pack short: …" paging error (nothing sent). Message = all accounts
  ("=== ACCOUNT i of M ==="). After delivery: `setQuantity(packsFor(free, N))`.
- **g2gFulfiller** units + no-claim paths: same accounts rule. EVERYTHING reported to
  G2G (delivered qty, confirmOnG2g, resume/retry counts) is in UNITS (packs) — never
  accounts (a pack of 5 delivered = delivered_qty 1). Fix the resume path that counts
  `mine.length` so a bulk row reports `mine.length / N`.
- **Stock syncs** (eldorado syncBundleStock, g2g syncStock): a bulk row advertises
  `packsFor(real, N)` where `real` is the account count they compute today (free
  units, or the no-claim share); 0 packs → the existing autoPaused pause. Replaces
  the FIXES-1 R3-3 "below minQty" rule for rows with bulkPackSize >= 2.
- **Farm services** (eldoradoFarmService, g2gFarmService): after parsing, look up
  `BulkOffer.findOne({externalId: offerId, kind: "farming"}, {minQty:1, state:1}).lean()`;
  found → accounts to provision = `purchaseQuantity × minQty` (record the unit count
  and the pack size on the FarmServiceOrder note); not found → ×1 (unchanged). G2G
  farm delivered qty stays in UNITS. PlayerAuctions unchanged (not a bulk market).

## 3. Publish, price, copy (owner P2 — send.js, markets.js, pricing.js, copy.js, BulkOffer model)
- `pricing.packPriceFor({anchor, discountPct, size, market})`: Gameflip →
  roundQuarter; Eldorado/G2G → round2; always ≥ `MARKET_FLOORS[market]` (the floor is
  per LISTING now). `customPackPrice({unitPrice, size})` → round2(unitPrice × size).
- **Custom price** (send body `customUnitPrice`, per account, optional):
  - pack price = customPackPrice; below the market floor → 400 (hard);
  - per-account custom < 70% of the anchor, or < set.minPriceUsd (when > 0), or >
    the anchor → 409 `{code:"price_confirm", message}` unless `confirmPrice === true`;
  - stored: BulkOffer `customPrice: true`, `unitPrice` = per-account, `packPrice` = pack.
- Eldorado/G2G publish: `quantity = packs`, `minQuantity/minQty = 1`, price = pack
  price. Packs reserved at send = `min(units ? floor(units/N) : floor(bp.unitsPerOffer/N),
  floor(surplus/N))`, must be ≥ 1; accounts reserved = packs × N. Refill adds whole
  packs. Row gets `bulkPackSize: N`.
- No-claim publish: body quantity = packs (`packsFor(share, N)` ≥ 1), minQuantity 1,
  price = pack price; row gets `bulkPackSize: N` right after publish (same update
  that sets bulkOfferId).
- Farm publish: quantity = `packsFor(share, N)` ≥ 1, minQuantity 1, price = N × farm
  unit price after discount (or custom).
- Titles (copy.js), every market: accounts `"<base> — PACK OF N ACCOUNTS"`
  (append " (-D%)" only if it fits); farm `"<Game> Twitch Drops Automatic Farming
  <term> — PACK OF N ACCOUNTS"` (still round-trips through the real parser).
  Descriptions: "Each purchase is a pack of N separate accounts…"; buying 2 = 2 packs.
- Covers: `markets.coverForSet(set, {packSize, discountPct})` and
  `coverForFarm(game, days, {packSize, discountPct})` call P4's
  `setImage.buildBulkCoverImage` / `buildBulkFarmCoverImage` when present (lazy),
  else fall back to today's cover.

## 4. Loop + proposals (owner P3 — loop.js, proposals.js)
- Dropset Eldorado/G2G: advertised = `packsFor(freeOnOffer, N)`; sold-out when
  `freeOnOffer < N` (a partial pack can never sell): pause + retire the leftovers
  (two-phase, as today). Take-out: lower to `packsFor(freeAfter, N)` first, 0 → pause.
- Farm: each offer's share (accounts) → `packsFor(share, N)` packs; < 1 → pause.
- No-claim: `lowStock` = `packsFor(share, N) < 1`.
- Proposals: every market shows pack prices (`packPriceFor`) with the per-account
  equivalent; `fits` = surplus/share ≥ N; include `packsAvailable`; the G2G
  "no discount room" case disappears (the floor is per pack).

## 5. Cover template (owner P4 — utils/setImage.js)
`buildBulkCoverImage(set, {packSize, discountPct})` → temp PNG path: the set's grid
image with a bold "PACK OF N ACCOUNTS" banner and, when D > 0, a "−D%" tag;
`buildBulkFarmCoverImage(game, days, {packSize, discountPct})` → the farm promo cover
with the same banner plus the term ("1 YEAR FARMING"). Same image stack/fonts as
the existing builders; never throws (returns "" on failure).

## 6. Page + router (owner P5 — public/bulk-packs.html, routes/bulkPackRoutes.js)
Tier buttons on every market: "Pack of 5 — $5.94" (small "≈ $1.19 each"). Send
dialog: packs on this offer (Eldorado/G2G; default from the rules above), a
"Custom price per account" input showing the live pack total and the % vs the
single price, and the price_confirm flow (show the message, a checkbox "I checked
this price", resend with confirmPrice). Router passes `customUnitPrice` (number) and
`confirmPrice` (boolean) to send; validates types. Live offers / History show
"Pack of N", pack price, packs left, and a "custom" tag.
