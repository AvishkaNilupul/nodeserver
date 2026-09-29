# Bulk packs — frozen contract (v1, 2026-09-30)

Read this file, then `MODULES.md` (exact APIs) and `API-UI.md` (routes, page, tests).
Code against these files, never against a sibling agent's output. If the contract
has a hole, pick the most conservative reading, note it in your report, and move on.

Worktree: `/Users/avishkanilupul/projects/nodeserver/.claude/worktrees/bulk-packs`
(branch `feat/bulk-packs`). Its code files are byte-identical to PRODUCTION as of
2026-09-29 (commit 70b4202), so read those files, not the main checkout.

## 1. What it is

A separate "Bulk packs" subsystem with its own dashboard. It PROPOSES bulk offers
(the "bundler"), and the owner clicks **Send** to publish one on a marketplace.
It then looks after the live offers (sales, sold-out, expiry, integrity).
Three product kinds ("sources"):

| source    | what the buyer gets | markets (v1) | stock |
|-----------|---------------------|--------------|-------|
| `dropset` | accounts holding a farmed (claimed) drop bundle — `DropSet` with `stockSource !== "noclaim"`, `custom !== true`, game NOT `settings.isNoClaimGame(game)` | eldorado, g2g, gameflip | accounts RESERVED at send (DropLog reservation, market claim tag) |
| `noclaim` | no-claim accounts (unclaimed drops; buyer claims) — `DropSet.stockSource === "noclaim"` | eldorado, g2g | claim-at-sale shared shelf (existing `utils/noclaimStock.js` layer) |
| `farm`    | fresh accounts farming one game for D days (rent-farm window) | eldorado, g2g | bot slots + pristine pool, provisioned at sale by the existing farm services |

Never: digiseller/plati, ggsel (owner BLOCK since 2026-09-28), playerauctions,
zeusx. Gameflip is not offered for `noclaim` or `farm` in v1.

## 2. Owner decisions (do not re-litigate)

- Tiers (settings, editable): `[{minQty:5, discountPct:5}, {minQty:10, discountPct:10}]`.
- **Unit semantics — no multiplier anywhere.** On eldorado/g2g one unit is ALWAYS one
  account; the tier is the offer's `minQuantity` / `minQty`. On gameflip one listing is
  ONE pack of exactly `minQty` accounts whose delivery code holds all of them. (Why:
  PlayerAuctions order 16474028 shipped 11 accounts for $5 because a quantity meant
  something else.)
- Prices are fixed when sent. The system NEVER reprices a live bulk offer.
- Send is always an owner click. The loop maintains live offers but never publishes.

## 3. Architecture

- Own model `BulkOffer`, own router `/api/bulk-packs/*`, own page `/bulk-packs.html`,
  own loop `utils/bulkPacks/loop.js`, own settings keys, all under `utils/bulkPacks/`.
- `dropset` and `noclaim` offers ALSO create a normal `MarketplaceListing` row with
  `origin: "manual"` and the new field `bulkOfferId` → the BulkOffer. Delivery, sale
  detection and (noclaim) stock sync then run through the EXISTING fulfillers unchanged:
  - eldorado dropset: `eldoradoFulfiller.deliverOrder` reserved-units tail (row has
    `units[]` with `accountId`, no `autoClaimSet`/`unclaimedGame`/`accountOffer`/`noclaimStock`).
  - g2g dropset: `g2gFulfiller` `pickStock` pre-reserved units branch.
  - gameflip dropset: native delivery (the code rides on the listing); `gameflipFulfiller.syncOnce`
    flips the row to `status:"sold"`; our loop finalises.
  - noclaim eldorado/g2g: the existing `noclaimStock` branches + `syncBundleStock` / g2g
    `syncStock` (they already share the shelf between claim-at-sale rows).
- `farm` offers have NO MarketplaceListing row. Their titles are parsed by the existing
  farm services (`/\bAutomatic\s+Farming\b/i`), which deliver `purchaseQuantity` accounts.
- Why `origin:"manual"`: existing code treats manual rows as owner-made (never repriced,
  never auto-lister property). The few AUTOMATIC sweeps that would still act on them are
  patched to skip rows with `bulkOfferId` set (hooks H5–H12, §8).

## 4. Invariants (MUST — each one has cost real money before)

- **I1 Reservations.** Reserve only with
  `require("../eldoradoFulfiller").claimAccountsForSet(set, n, { claimTag: market })`
  (it filters listed logins, reserves the set's drops with `soldToUsername = market`,
  `soldSetId = String(set._id)`, and drops accounts with unreadable passwords).
  Release only with `require("../dropReservation").releaseSetForAccounts([accountId], String(set._id), market)`
  and only after `stock.isStillOurs(...)` is true. Never call `releaseAccountsForTag`
  (tag-wide → could free a different set's SOLD drops). Never release a unit that is
  not "free" (see I2).
- **I2 A unit is FREE only if** `!deliveredAt && !messagedAt && !orderId`. Anything else
  is in flight or sold and must never be released or pulled.
- **I3 Never whole-array-save `MarketplaceListing.units`.** The fulfillers save the whole
  array concurrently. Use atomic `$push` / conditional `$pull`
  (`{$pull:{units:{accountId, deliveredAt:null, messagedAt:null, orderId:""}}}`).
  `BulkOffer.reserved[]` is our authority; the loop reconciles it with the row every pass
  and self-heals clobbers (MODULES §loop).
- **I4 Delivery gate before any publish** (`config.deliveryGate`): eldorado needs
  `autoFarm.eldoradoAutoDeliver === true && autoFarm.eldoradoDeliverDryRun === false`;
  g2g needs `g2gAutoDeliver === true && g2gDeliverDryRun === false`; gameflip is native
  (always ok when the market is enabled); `noclaim` additionally needs
  `noclaimShop.enabled && noclaimShop.autoDeliver` (`settings.getNoclaimShopSettings()`).
  Blocked markets are refused whatever the settings say.
- **I5 Farm titles round-trip through the REAL parser** before publishing:
  `eldoradoFarmService.termToDays(title) === days` and
  `canonicalGame(title.split(/\s+Twitch\s+Drops\b/i)[0].trim(), await knownFarmGames()) === game`.
  Account titles must NOT match `/\bAutomatic\s+Farming\b/i` (else the farm service
  would grab the order).
- **I6 One open offer per slot.** `slotKey = [kind, source, setId || (game + "@" + days), market, minQty].join("|")`,
  unique partial index `{slotKey:1}` where `{open:true}`. A duplicate click gets 409.
- **I7 In-process only.** Marketplace APIs are called only from the server process (router
  + loop). No script may call Eldorado/PlayerAuctions (a side process clobbers the live
  session jar). Tests inject fakes; tests never touch the network or the real
  `utils/settings.json`.
- **I8 Ship dark.** `autoFarm.bulkPacksEnabled` defaults to `false`. While false:
  send / refill / resume are refused (409 "Bulk packs are switched off"). The loop still
  runs SAFETY maintenance (reconcile, sold/expired detection, pausing short offers,
  releasing retired units) but never resumes or publishes.
- **I9 Gameflip pack rows** get `qtyRemaining: 0` and must never be relisted (hook H9).
  Withdraw order: `gameflipDelist` first; only if it succeeds, conditional
  `updateOne({_id, status:"active"}, {$set:{status:"delisted"}})`, then release.
  If the delist fails because it sold, do nothing — the Gameflip sync will mark it sold.
- **I10 Two-phase release on eldorado/g2g** (sold-out, withdraw, broken unit): phase 1
  pause/requantify the offer and `$pull` the free units, marking them `retiring` in
  `BulkOffer.reserved`; phase 2 (a later pass, ≥ 2 min after `changedAt`) re-read the row:
  unit back and free → `$pull` again and stay `retiring`; unit present and not free → it
  sold (`delivered`); unit absent → release (I1) → `released`.
- **I11 Hands off other rows.** Only rows with `bulkOfferId` equal to our offer are ever
  written. Other rows are read-only (price anchors).
- **I12 Bounded DB work.** No `allowDiskUse`; project fields; cap lists; cache proposals.
- **I13 Audit + alerts.** Every action → `utils/systemLog.logEvent({category:"bulk", action, severity, message, meta})`.
  Telegram (`utils/telegram.sendTelegram`, never awaited without `.catch`) on: send
  failure, each new sale, pause/resume state changes, integrity retirements, orphan offer.

## 5. Data model — `models/BulkOffer.js`

```
reserved[] (_id:false): accountId String, login String,
  state enum ["on_offer","retiring","released","delivered"] default "on_offer",
  orderId String "", at Date now, changedAt Date null, reason String ""
history[]  (_id:false): at Date, action String, detail String, actor String   // keep last 60 ($slice)

kind        enum ["accounts","farming"] required, index
source      enum ["dropset","noclaim","farm"] required
market      enum ["eldorado","g2g","gameflip"] required, index
set         ObjectId ref DropSet, default null, index
setName     String ""      game String ""      days Number 0
minQty      Number required            discountPct Number 0
anchorPrice Number 0       anchorBasis String ""   // "listing" | "set" | "engine" | "farm-table"
unitPrice   Number 0       packPrice   Number 0     // packPrice: gameflip only
title String ""  description String ""
listing     ObjectId ref MarketplaceListing, default null
externalId  String "", index           url String ""
state       enum ["sending","live","paused","sold_out","sold","withdrawn","expired","error"], default "sending", index
open        Boolean true   // true exactly while state ∈ {sending, live, paused}
slotKey     String required
autoPaused  Boolean false  lowStock Boolean false
reserved    [reserved]     advertisedQty Number 0
unitsDelivered Number 0    ordersCount Number 0    revenueUsd Number 0    lastOrderAt Date null
lastSyncAt Date null       lastCheckAt Date null   lastError String ""
history     [history]      createdBy String ""     closedAt Date null
timestamps: true
indexes: {slotKey:1} unique partial {open:true}; {open:1, kind:1}; {market:1, state:1}
```
Statics/helpers (in the model file): `OPEN_STATES`, `CLOSED_STATES`,
`isOpenState(s)`. Every state write must also write `open` consistently (and
`closedAt` when closing).

## 6. Settings — `utils/settings.js`

Add to `AUTO_FARM_DEFAULTS` (commented, shipped OFF):
`bulkPacksEnabled:false`, `bulkPacksMarkets:["eldorado","g2g","gameflip"]`,
`bulkPackTiers:[{minQty:5,discountPct:5},{minQty:10,discountPct:10}]`,
`bulkPackReserveSingles:5`, `bulkPackUnitsPerOffer:20`,
`bulkFarmPrices:{eldorado:{"120":3,"180":4,"365":7}, g2g:{"120":3,"180":4,"365":7}}`,
`bulkFarmDurations:[120,180,365]`, `bulkFarmReserveSlots:20`,
`bulkFarmReservePristine:20`, `bulkFarmMaxQty:20`, `bulkPacksLoopMinutes:5`,
`bulkFarmSyncMinutes:15`.

Add `getBulkPacks(afIn)` (export it). `afIn` optional (tests pass an object; default
`getAutoFarm()`). Returns a NORMALISED object:
```
{ enabled, markets, tiers, reserveSingles, unitsPerOffer, farmPrices, farmDurations,
  farmReserveSlots, farmReservePristine, farmMaxQty, loopMinutes, farmSyncMinutes }
```
Clamps: markets ⊆ ["eldorado","g2g","gameflip"] (anything else dropped, order kept,
empty → []); tiers: integer minQty 2..100, discountPct 0..60, unique minQty, sorted
ascending, max 4, invalid entries dropped (empty → defaults); reserveSingles 0..100;
unitsPerOffer 1..80; farmPrices: per market {days: price>0}, invalid dropped;
farmDurations ints 1..730 unique sorted; farmReserveSlots 0..500;
farmReservePristine 0..500; farmMaxQty 1..100; loopMinutes 2..60; farmSyncMinutes 5..120.

## 7. File ownership

| File | Agent | Kind |
|------|-------|------|
| `models/BulkOffer.js` | A1 | new |
| `models/MarketplaceListing.js` (H1: `bulkOfferId` field) | A1 | hook |
| `utils/settings.js` (§6) | A1 | hook |
| `utils/bulkPacks/config.js` | A1 | new |
| `utils/bulkPacks/pricing.js`, `utils/bulkPacks/copy.js` | A2 | new |
| `utils/bulkPacks/stock.js`, `utils/bulkPacks/farmCapacity.js` | A3 | new |
| `utils/bulkPacks/markets.js` | A4 | new |
| `utils/bulkPacks/send.js` | A5 | new |
| `utils/bulkPacks/loop.js` | A6 | new |
| `utils/bulkPacks/proposals.js` | A7 | new |
| `routes/bulkPackRoutes.js`, `server.js` (H3), `public/admin-nav.js` (H4) | A8 | new + hooks |
| `public/bulk-packs.html` | A9 | new |
| hooks H5–H12 (§8) | A10 | hooks |
| tests: `tests/bulkPacks<Area>.test.js` | the owning agent | new |

Do not edit a file you do not own. Do not read sibling agents' NEW files; use the
contract. Shared files you own: change only your hunk, keep everything else byte-exact.

## 8. Shared hooks (exact intent)

- **H1** `models/MarketplaceListing.js`: `bulkOfferId: { type: ObjectId, ref: "BulkOffer", default: null, index: true }`
  with a comment pointing here. No enum changes (bulk rows use `origin:"manual"`).
- **H3** `server.js`: page route `app.get("/bulk-packs.html", requireSuperadmin, enforce2fa, sendFile)`
  declared BEFORE the static mount (like bulk-orders); router mounted AFTER the admin
  blanket as `app.use(enforce2fa, bulkPackRoutes)`; loop `require("./utils/bulkPacks/loop").start()`
  inside the mongoose-connected block with a comment "Bulk packs maintenance (maintains
  live offers; publishing needs autoFarm.bulkPacksEnabled)".
- **H4** `public/admin-nav.js`: in the `marketplace` group right after "Bulk orders":
  `{ href: "/bulk-packs.html", label: "Bulk packs", icon: <reuse an existing icon key>, superOnly: true }`.
- **H5** `utils/marketplaceGuardian.js`: every AUTOMATIC query that selects rows to feed,
  check, heal or delist adds `bulkOfferId: null`.
- **H6** `utils/guardianFixes.js` `fixDedupe` (and any fix that picks rows by account):
  add `bulkOfferId: null` so a bulk row is never the detached "loser".
- **H7** `utils/suspendedAccounts.js` `retireFromLiveListings`: add `bulkOfferId: null`
  (our loop retires suspended members itself).
- **H8** `utils/autoFarmer.js` `backfillActiveTasks` `updateOne` filter: add `bulkOfferId: null`.
- **H9** `utils/gameflipFulfiller.js`: both relist lanes (after-sale relist and the
  stalled-relist lane) skip rows with `bulkOfferId` (query filter `bulkOfferId: null`
  and/or `if (row.bulkOfferId) continue`). Sale marking, SaleSignal and Telegram stay.
- **H10** `utils/pricingEvidence.js`: sold-price evidence excludes `bulkOfferId != null`
  rows (bulk prices are discounted and must not drag single-listing prices down).
- **H11** `routes/catalogRoutes.js` `buildPublicCatalog`: bulk rows never become public
  buy links.
- **H12** `utils/marketResearch.js`: wherever OUR OWN listing rows feed a price anchor
  (lowest/median of our rows), exclude bulk rows. Sale counts may stay.
- Verify (no change expected, add a test): eldorado `syncBundleStock` does not select a
  dropset bulk row; g2g `syncStock` does not select a dropset bulk row (origin manual, no
  accountOffer, no noclaimStock) but DOES select a noclaim bulk row (wanted).

## 9. Dependency injection (all `utils/bulkPacks/*` modules)

Lazy real dependencies behind a `deps` object; export `__setDeps(partial)` and
`__resetDeps()` for tests. Tests use `mongodb-memory-server` (pattern:
`tests/autoFarmEventLog.test.js`) and fake `mp`/fulfiller modules; settings are passed
as objects or `settings.getAutoFarm` is temporarily replaced (pattern:
`tests/farmSizingIntegration.test.js`). Run your tests with
`node --test tests/bulkPacks<Area>.test.js` from the worktree root.
