# Listing brain — where stock goes, what it costs, when a price moves (TEST MODE: log only)

> Contract for `utils/listingBrain`. Written before the code (milestone 1) and kept true as it was built.
> The second half of one system: the **farm brain** (`utils/demandBrain`, `docs/DEMAND-BRAIN-PLAN.md`) says how many
> accounts each farm should hold per game; the **listing brain** says what happens to them once farmed:
>
> 1. **Where** — which marketplaces each game's stock goes on, and how many units each one holds (the *shelf*).
> 2. **How much** — the price of each offer on each marketplace.
> 3. **When it moves** — whether a live listing's price should come down, go up, or stay.
>
> It ships in **test mode**: every run logs its decisions beside what today's code does at the same moment, scores
> itself against what actually sells, and changes nothing. The publishing code — connectors, listers, delivery —
> stays exactly as it is. Wiring the brain into a publisher is a later round (§12 lists the proposed hooks).

## Status

- Built in a sandbox with **no production access** (no real data, no network to the database). Every rule below is
  covered by a test on synthetic data (§11); every number on real data still has to be checked by the owner and the
  production session — `docs/LISTING-BRAIN-HANDOFF.md` lists what to verify first.
- Ships dark: `autoFarm.listingBrain.enabled` defaults to **false**.

---

## 1. What today's code does (the "old" side), as the code says it

Read 2026-10-03 from `fix/live-defects-1003`. Where the brief and the code disagree, the code wins; the
corrections are in §1.3.

### 1.1 The claim farm (auto-farm) — five rules

| # | Rule | Exported function the brain calls for the old side | Pure? |
|---|---|---|---|
| 1 | **One price for every market.** `derivePrice(research)` reads only the game's `MarketResearch` row: Gameflip `soldRecent ≥ 3` → `avgSoldPrice` (rivals' scraped average, capped $10), `lowestOther` × 0.95, the smaller of the two; no Gameflip signal → min(GGSel/Plati `lowest`) × 0.95; nothing → $1.00. Quarter grid, clamped [0.75, 10]. Each other connector only lifts it to its own floor | `autoLister.derivePrice(research)` | yes |
| 2 | **GGSel alone translates** that price: `venuePrice("ggsel", base, {title})` = base × `pricing.venueFactor` (0.4–1.5, from a cached 180-day evidence snapshot), floored at $0.75, cents | `autoLister.venuePrice` | **reads the DB** (10-min cached snapshot) |
| 3 | **Half now, half later.** `computeSplit(n)` → `{listNow: ceil(n/2), holdBack}`; the held half is a counter, released into Gameflip at a flat +50% (`postEventPrice` = nearest quarter of price × 1.5, ≥ $0.75) when the campaign ends — and only if a live auto Gameflip row exists | `computeSplit`, `postEventPrice` | yes |
| 4 | **Fixed market order, round-robin.** `["gameflip", plati?, ggsel?, zeusx?, eldorado?, playerauctions?, g2g?]` — each only if its switch is on (`platiTakesNewStock(af)`, `ggselTakesNewStock(af)`, `zeusxAuto`, `eldoradoAuto`, `playerauctionsAuto`, `g2gAuto`) — and `dealShares` deals the accounts round-robin; `refillMarkets` tops Gameflip (its queue counter), Plati and GGSel back up to `perMarketStock` (3) | `dealShares(accounts, order, shares, null)` | yes (fills the `shares` object it is given) |
| 5 | **Nothing ever comes down.** The only automated price move on an auto row is the ×1.5 at campaign end on Gameflip. Eldorado, G2G, PlayerAuctions and ZeusX auto rows have no price path at all | — | — |

Never called by the brain: `listActivatedTask` (even dry-run it saves `task.wouldList`, may mark a row removed, and
calls Twitch, Gameflip and the GGSel/ZeusX/PlayerAuctions category lookups), `refillMarkets`, `onCampaignEnded`,
`retryMissingSecondaries`, `freshResearchForGame` (each writes, calls a marketplace, or reads unbounded).

### 1.2 The no-claim farm

- The no-claim auto-lister (`utils/unclaimedAutoList.js`, `origin: "unclaimed"`) publishes one row per item (a
  custom DropSet: one game + an exact multiset of drops) per market on **Gameflip, Digiseller (Plati) and GGSel**,
  at **one `DropSet.price` in USD on every market**. That price is `unclaimedBundles.bundlePrice({research, game,
  items, classification, pricing, soldFloorUsd})`: anchor (Gameflip avgSold if ≥ 3 sold, else lowestOther, else
  median, else min(GGSel, Plati median), else $1.00; capped $2.50) × min(itemCapMult 2.5, 1 + 15 % × (qty − 1)),
  × 1.25 for a full event (after the cap), nearest quarter, ceiling $4.50, floor (rounded up), and the 30-day
  sold floor last (the only thing allowed above the ceiling). `bundlePrice` is pure when `pricing` (with
  `gameFloors`) is passed; the brain always passes it.
- A per-game shelf cap: `unclaimedGameCaps[game]` if set, else `GAME_CAP` = 70, counted over listed ledgers per
  exact normalised label.
- Owner rows on the same pool (`noclaimStock: true`, `origin: "manual"`): vault rows on Gameflip/GGSel/Plati,
  claim-at-sale rows on Eldorado/PlayerAuctions/G2G (`noclaimStock.stockForListing` advertises a share of the
  free pool, capped at 80).
- The per-unit ledger is `UnclaimedAccount` (one document per account, overwritten on every re-list): `listedAt`,
  `soldAt`, `soldPriceUsd` (the **paid** price for claim-at-sale orders — better than the tracker's
  listing-price-now), `soldMarket` (`"manual"` = hand sale), `expiredAt`, `status`, `listingIds`, `bundleKey`,
  `drops[].campaign`.

### 1.3 Brief vs code (the code wins)

1. **Plati is `digiseller`** in listings, the tracker, venues, floors and fees; the radar and `MarketResearch` call
   it `plati`; so does the auto-lister's market order. The brain keys every cell by the tracker's seven keys
   `gameflip, digiseller, ggsel, zeusx, eldorado, playerauctions, g2g` and translates at the two edges.
2. **The tracker's listing read lacks** `units.addedAt`, `qtyRemaining`, `noclaimStock`, `autoClaimSet`,
   `accountOffer`, `rebundledAt`, `requiredDrops`, `lotSize`, `bulkPackSize`, `note`. The brain makes the one extra
   projected, limited `MarketplaceListing` read the brief allows (§2).
3. **The ledger carries no farm and no claim-at-sale flag**: the brain joins each sale to its listing row by
   `listingId`. The no-claim auto-lister's sales do reach the ledger — the GGSel/Plati check pass writes a
   `listing_sold` signal on the row whose stock dropped (`unclaimedAutoList` `recordListingSale`, one per drop, at
   the row's price), and a Gameflip unit appears as a `row` sale dated by the row's `updatedAt` — but the brain
   takes every sale of an `origin: "unclaimed"` row from `UnclaimedAccount` instead, and drops the ledger's records
   of those rows (sales and demand-only alike), so no sale is counted from both sources. What the unit ledger gives
   that the ledger does not:
   - **one record per unit, at its own moment**: `soldAt` is stamped at detection for each account
     (`spendAccount`), where a Gameflip `row` sale is dated by the row's last write;
   - **the price at the sale**: `soldPriceUsd` is the realised total when the caller knows it, else the row's price
     captured before any repricer moves it (basis `paid`); 0 falls back to the row's price (basis `row`);
   - **the hand / pack split**: `soldMarket: "manual"` (hand sales of free stock, which write no signal) and an
     operator's "manual mark sold" (`note`, read in memory only) are demand only; a unit sold off a lot or pack row
     is demand only with the per-account price in the bulk series.
   The sale belongs to the **newest** named `origin: "unclaimed"` row on the market it sold on that existed when it
   sold (`createdAt ≤ soldAt`): `listingIds` only grow (a GGSel set rebuilt into a new offer, a Gameflip successor,
   a lot the unit once sat in), so the oldest named row is usually a dead one. The pack/lot test runs on that row
   only. A unit sold on a market none of its named rows is on, and a unit with `manualListing` set (sold through an
   owner's vault or claim-at-sale listing; a reused ledger can still name a dead auto row), are left to the ledger,
   which holds that row's sale by its listing id — the paid price such owner-row units carry is not used (the
   ledger's record of the owner row is the one counted). `expiredAt` older than `listedAt` is a previous life's
   (nothing clears it on a re-list) and reads null.
4. **Claim-at-sale is wider than the brief says.** `noclaimStock` (no-claim pool), `autoClaimSet` (the claim farm's
   Drop Archive) and the retired `unclaimedGame` rows are all claim-at-sale. The G2G operator-script rows are
   `origin: "auto"` **and** `autoClaimSet: true`: auto-owned by `isAutoOwned`, but claim-at-sale. The brain checks
   claim-at-sale **before** origin: such a row is never advised and its quantity is never summed, whatever its
   origin; the script rows are counted apart (flag `script`).
5. **The ledger keeps no bulk price.** Every `demandOnly` record has `priceUsd: 0`. The per-account bulk series is
   the pack row's own price ÷ `bulkPackSize` (sold pack rows), with weekly units from `demandOnly` bulk records.
6. **Bursts are not all "set aside"**: a real-pass burst moves to `demandOnly` (`burst: true`, price zeroed) — demand,
   not price. Mass-closes and large bursts go to `ledger.suspect` and count as neither.
7. **"One price per buyer order" is not a field**: `saleGroup` names the order; the brain applies the tracker's own
   `analyze.perOrder`.
8. **Ask vs stored price.** No tracker number applies `max(price, floor)`. ZeusX and no-claim Plati rows store the
   price before the connector lifts it. The brain reads every ask as `max(row.price, floorFor(m))`.
9. **`DropSet.minPriceUsd` is a live floor on auto-lister sets** (= the launch price): the Gameflip relist chain
   lifts every relist back up to it. A brain "lower" below it on a Gameflip auto chain cannot happen through
   today's relist path — flagged `setmin` on the row and listed among the next round's hooks.
10. **Exposure ends.** `updatedAt` is "last write", never an end time. Gameflip listings expire after 30 days but
    rows stayed `active` past expiry until 2026-10-01: Gameflip exposure is capped at `createdAt + 30 d`. Eldorado
    offers die 21 days after their last activation. On claim-at-sale rows `units[].addedAt == deliveredAt` (a
    delivery record, not an exposure start).
11. **Rotation is not a rebundle.** `noclaimOfferRotation` swaps an Eldorado row's `set`, title and `requiredDrops`
    and stamps no `rebundledAt`; only `applyRebundle` stamps `rebundledAt` (title and `requiredDrops`, not the set).
    The brain can split exposure only at `rebundledAt`; rotation is a known limit (§10).
12. **No hand-set marker on `unclaimedGameCaps`.** The allocator writes entries itself when `noclaimAutoSize` is on.
    The brain treats **every** explicit entry as the owner's (`managed`): it may be wrong in the safe direction only.
13. **The no-claim "sold floor" is not a setting** — it is `soldFloorForSet` (highest Gameflip sold price of the set
    in 30 days, unbounded read). The brain computes the same quantity from the evidence it already holds.
14. **The radar has no market × size-band table and no history of rival counts.** Rivals' sold prices per market
    and band are rebuilt from the radar's `feed` (rivals only, rent-farm out); "rivals are disappearing" cannot be
    read, so a campaign end counts as `scarce` only while the radar shows at most `rivalsGoneMax` live rival sellers
    now (§4.5).
15. **`getAutoFarm()` re-reads `settings.json` on every call** (~1.5 ms): the brain reads it once per run, and
    `getUnclaimedPricing()` once, and passes them down.
16. **Eligibility without a marketplace call is wider than "Gameflip, Eldorado"**: Digiseller needs no per-game
    mapping either; G2G's mapping is a static table (`g2gGames.brandForGame`); GGSel is mapped for every game when
    `af.ggselCategoryId` is set.
17. **Not "never topped up"**: G2G gets another offer on every sweep that finds spare accounts while `g2gAuto` is on
    (`AutoFarmTask.listing` has no `g2g` field). The brain still treats G2G as not refillable (no shelf is held
    there), and says so.
18. **`suggestForNew` returns no `confidence` on an unknown market**, ignores `minPriceUsd` when the game-level
    answer wins, and has no listing-now cap; the brain logs it as the `tracker` policy as it is and never relies on
    its confidence.

---

## 2. What the brain reads (and nothing else)

All reads happen in `utils/listingBrain/inputs.js`, once per run, before any computation. Every read is projected
and limited and carries `maxTimeMS` (30 s, a find option); `$in` lists go in chunks of 500 ids; no `skip()`, no
`allowDiskUse`, no unbounded `$group`. Nothing is written, no marketplace is called. Every long pass over the rows
read (normalisation, sales, units, demand rows, the old side) breathes (`setImmediate`) at least every 50 ms, and a
listing id is hashed once per load (memoised): at production volume on Node 20 no synchronous stretch of the load
is over 200 ms (the longest left is the pure `buildEventCatalog` over 5,000 campaigns, 60–120 ms, or one tracker
call, ≤ ~150 ms).

| Read | How | Bound |
|---|---|---|
| Price-tracker report | `priceTracker.getReportSWR({timeoutMs: 120000})` — shared cache; a `null` report fails the load (nothing logged) | cached, 5 min |
| Radar report | `marketData/report.getReport({days: 30})` — the same cache entry the farm brain uses; seller fields dropped at once | cached, 10 min |
| Farm-brain rows | `DemandBrainRow.find({at ≥ now − (max(maxDemandAgeH, 6) + 1) h}, {k,f,at,live,hl,br.c,br.w,br.t,stk,est.avg30,est.avg45}).sort({at: -1}).limit(5000)`; newest per `(k, f)` kept. `maxDemandAgeH` is the model's own `readConfig` of `autoFarm.listingBrain` (a fixed 72 h read returned ~8,600 rows and hit the cap every run). A no-claim row's `k` is `settings.normGameName(keyword)` (a–z0–9); it joins the loader's keyword bucket by that rule, and is split over the bucket's games by their 30-day no-claim sales — when none sold, its games get no row (unknown), never an equal split | 5,000 |
| The extra listing read | `MarketplaceListing.find({marketplace ∈ 7 keys}, {_id, marketplace, origin, status, price, title, createdAt, updatedAt, set, noclaimStock, autoClaimSet, unclaimedGame, accountOffer, rentFarm, bulkOfferId, bulkPackSize, lotSize, qtyRemaining, qtyTarget, lastStock, rebundledAt, venueMinPriceUsd, "units.addedAt", "units.deliveredAt"}).sort({_id: -1}).limit(20000)` — the tracker's own query shape (the `{marketplace, _id}` index; an `$or` on the unindexed `updatedAt` would scan the collection) — the flags and exposure dates the tracker does not project; joined to the tracker's rows by id. The window is applied in memory: active rows and rows written in the last `saleDays` = max(refDays, fit window) + 42 (222 d by default) — as far back as sales are kept, so a no-claim sale finds its row. `title` is read **in memory only**: a row the tracker skipped is kind `farm` only when its flag or its fresh title says so (`classifyKind`) | 20,000 |
| No-claim units | `UnclaimedAccount.find({listedAt ≥ now − fitDays − 42 d − 60 d}, P).limit(50000)` and `UnclaimedAccount.find({status: "sold", soldAt ≥ now − saleDays, $or: [{listedAt < the listed read's start}, {listedAt: null}]}, P).limit(50000)` (no unit twice; never-listed hand sales included), P = `{game, market, status, listedAt, soldAt, soldPriceUsd, soldMarket, expiredAt, listingIds, bundleKey, manualListing, note, updatedAt, "drops.campaign"}` — two indexed reads, merged; no login, no account id. `manualListing` (a listing id) and `note` (free text) are read **in memory only** and never copied (§1.3 #3) | 2 × 50,000 |
| Wave ends | `TwitchCampaign.find({$or: [{endAt ≥ now − 120 d}, {endAt: null}]}, {campaignId, name, game, startAt, endAt}).sort({endAt: -1}).limit(5000)` (open-ended campaigns too, as `loadCatalog` reads them; Mongo sorts null below every date, so the cap can only drop open-ended ones) + `CampaignDrops.find({campaignId ∈ 500 ids}, {campaignId, name, game, "drops.itemKey", "drops.name"}).limit(500)` per chunk → the pure `unclaimedBundles.buildEventCatalog` (never `loadCatalog`, which reads unbounded). The waves of EVERY game in the window are kept (the claim farm's "campaign ended" reads them) | 5,000 each |
| Event-bundle sets | `DropSet.find({_id ∈ 500 set ids, sourceType: "autofarm-bundle"}, {_id, sourceType, sourceEventKey}).limit(500)` per chunk, over the set ids of the listing read's claim auto rows — which of them are today's event bundles (the tracker's set read has no `sourceType`). `sourceEventKey` is used in memory only (the event's 30-day sold floor). Unreadable → those offers keep rule 1, with a note | the listing read's set ids |
| Market research | `MarketResearch.find({}, {game, "markets.gameflip", "markets.ggsel", "markets.plati", scannedAt}).limit(2000)` — what `derivePrice` and `bundlePrice` read | 2,000 |
| Settings | `getAutoFarm()` once, `getFarmSizing(af)`, `getUnclaimedPricing()` once, `getBulkPacks(af)`, top-level `priceTracker.fees` | — |
| Old side | `derivePrice`, `computeSplit` (stock on hand clamped to 10,000), `dealShares`, `postEventPrice`, `ggselTakesNewStock` (pure); rule 4's top-up restated (`refillMarkets` is impure and never called): Gameflip, Plati and GGSel, in today's order, back up to `perMarketStock` while the total stays within the stock on hand; `platiTakesNewStock(af)` (reads settings and an in-memory flag); `pricingEvidence.snapshot()` warmed ONCE (timeout) — `venuePrice` swallows an evidence error and answers the base, so only the warm-up can tell: on failure every GGSel and event-bundle price is null with one note; then `venuePrice("ggsel", …)` per game, 3 at a time; `autoFarmBundles.priceBundle({plan: {game, items, totalQty, full: false}, marketplace: "gameflip", research, soldFloorUsd})` for a claim event-bundle offer on Gameflip/Plati (that one number, floor-lifted) and GGSel (through `venuePrice`), as `publishEventBundleFor`/`publishStackedListing` do — whether the set is the complete event is not stored, so it is priced as not complete (a note says so); `unclaimedBundles.bundlePrice`/`classifyHoldings` (pure, `pricing` passed); `priceTracker.suggestForNew(report, q)` (pure on the report, 17–150 ms a call on Node 20) asked only for each cell's main offer, ≤ 400 (cells with live system-made rows first; a note when capped), with a yield before every call; `g2gGames.brandForGame` (static table); `priceTracker/games.listedUnits` and `bulkPacks/packMath.packSizeOf` (the tracker's and bulkPacks' own counting rules, no copies) | — |

`realDeps()` loads these lazily; `require("utils/listingBrain")` loads only the model and the loader shell — no
model, no settings, no marketplace module, no timer. `autoLister` (63 modules cold; already loaded at boot by
`server.js`), `autoFarmBundles`, `pricingEvidence` (a cached read), `priceTracker/games`, `bulkPacks/packMath` and
the `DropSet` model are required only inside `realDeps()`.

A farm-brain row older than `maxDemandAgeH` (6 h; the farm brain runs hourly), or missing, makes the game
`unknown` for this run.

### 2.1 What the loader hands the model (the bundle)

`load({now})` returns a **bundle**: plain JSON (arrays, objects, millisecond timestamps — no Map, no Date), already
stripped of anything identifying. The same object is what `scripts/listing-brain-export.js` writes to a file and
`loadFromBundle(file)` reads back, so every number a run logs is reproducible offline from one file.

```
{ kind: "listing-brain-bundle", v: 1, now,
  af:      { listingBrain: {...known keys}, perMarketStock, takes: {market: bool}, mapped: {gameKey: {market: bool}},
             noClaimGames: [keyword], noclaimAutoSize, capDefault: 70, caps: {gameKey: n} },
  sizing:  { coverageDays, safetyStock, maxPerGame },
  fees:    { market: pct },                       // settings priceTracker.fees (overrides)
  pricing: { floorUsd, ceilingUsd, gameFloors, itemStepPct, itemCapMult, fullEventBonusPct },  // getUnclaimedPricing
  bulk:    { markets: [market], tiers: [{size, discountPct}], reserveSingles },
  listings:[ L ], sales: [ S ], demandOnly: [ D ], bulkPrices: [ B ],
  radar:   { at, games: [ RG ], feed: [ RF ] },
  demand:  [ DR ], noclaim: { units: [ U ], waves: [ W ] },
  old:     { games: { gameKey: OG }, offers: { offerKey: OO } },
  notes: [string], counts: {...} }
```

| Record | Fields (short keys) |
|---|---|
| `L` listing | `id` (sha1 of the listing id, 12 hex — stable across runs, not the database id), `g` gameKey, `gl` game label, `m` market, `o` origin, `f` farm, `kind` (`single`, `cas`, `bulk`, `lot`, `account`, `farm`), `script`, `ck` contentKey, `bk` bandKey, `ex` exact, `n` item count, `p` stored price USD, `vmin` venueMinPriceUsd, `smin` DropSet.minPriceUsd, `st` status, `c` createdAt, `u` updatedAt, `units` [{a, d}] (≤ 200), `qty` listed units (the tracker's `games.listedUnits`, through deps; null without it), `qr` qtyRemaining, `rb` rebundledAt, `pack` accounts per pack (`bulkPacks/packMath.packSizeOf`: a row without `bulkOfferId` is no pack, whatever its `bulkPackSize`; 0 = none), `lot` a Gameflip lot's size (0 = none) |
| `S` sale (one per unit) | `lid` listing id hash or "", `g`, `m`, `o`, `f`, `ck`, `bk`, `ex`, `n`, `p` priceUsd (0 = unpriced), `t`, `grp` order key (hashed), `basis` (`reported`/`listing-now`/`row`/`paid`), `src` (`unit`/`signal`/`row`/`hand`/`shop`/`unclaimed`) |
| `D` demand-only | `g`, `m`, `f`, `t`, `src` (`bulk`, `bulk-order`, `shop`, `burst`, `hand`) |
| `B` bulk price | `g`, `m`, `t`, `pa` per-account USD, `size` |
| `RG` radar game | `key`, `perWeek`, `rivalSellers`, `medianTtsHours`, `byMarket: {gameflip, ggsel, digiseller: {perWeek, liveSellers, sold: {n,p25,median,p75}, medianTtsHours}}` |
| `RF` radar sale | `g`, `m` (tracker key), `p`, `u` units, `n` item count, `t`, `tts` — rivals only, rent-farm out, no seller field |
| `DR` farm-brain row | `k`, `f`, `at`, `live`, `hl`, `c` class, `w` weekly forecast, `t` target, `on` stock on hand, `fl` in flight, `a30`, `a45`, `bu` the no-claim bucket it was split from, `sh` the game's share (30-day no-claim sales; a bucket with none is not split: no row) |
| `U` no-claim unit | `g`, `m`, `st` ledger status, `l` listedAt, `s` soldAt, `p` soldPriceUsd, `sm` soldMarket, `x` expiredAt of the current life (null when older than `l`), `u` updatedAt (ms; the approximate moment a unit went off sale), `lids` listing id hashes, `bk` bundleKey, `camps` [raw campaign name]. The model reads a unit with `st` neither `listed` nor `sold` and no `x` (skipped, removed, manual, a released one never expired) as **off** sale — at a backtest cut before its `u` it was still on sale; with no `u`, off at every cut. With an `x`, its dates decide (it was on sale until its expiry) |
| `W` wave (every game's, claim and no-claim) | `g` gameKey, `ev` event name, `wave` (the parsed wave label, else the raw name), `name` the raw campaign name (what a unit's `camps` hold; `waveEndFor` matches it as well as the label forms), `startAt`, `endAt` (null for an open-ended campaign) |
| `OG` old, per claim game | `base` derivePrice, `ggsel` venuePrice (null when the evidence snapshot is unreadable), `post` postEventPrice(base), `split` {listNow, holdBack}, `flat` {market: units} (dealShares over today's order, then rule 4's top-up to `perMarketStock` on the refillable markets while stock lasts), `order` [market], `rm` how the research row matched |
| `OO` old, per offer (`market|contentKey`, else `market|bandKey`) | `np` today's new-listing price (bundlePrice for a no-claim offer; priceBundle for a claim event bundle), `tracker` {price, basis, confidence} (null unless the offer is a cell's main one inside the cap), `eb` true on an event-bundle offer |

- `af.listingBrain` holds only the keys the model knows (its `DEFAULTS`), each a primitive or an array of numbers,
  raw — the model's `readConfig` validates them on read. Anything else typed into the owner's block never travels.
- Every market string on `S`, `D` and `U` (`m`, `sm`) is one of the seven keys or `unknown`, `manual`, `shop`,
  `bulk` — anything else (a hand sale's free-text market: a chat, a buyer's handle) is `other`, which the model reads
  like `unknown` (demand, never a price). A unit's `m`/`sm` may also be `""` (not attached / not sold).
  `validateBundle` enforces the set.
- `privacyScan` (run by the export before any file is written) flags forbidden keys in any case, any key whose name
  says it carries a person, an account, a credential or free text (`login`, `account`, `seller`, `buyer`, `username`,
  `token`, `secret`, `password`, `email`, `twitch`, `note`, … — except the bundle's own `notes`, `digiseller`,
  `rivalSellers`, `liveSellers`, `l_account`; a game-keyed map's keys are checked as values), and any string that holds
  an email, a link, an IPv4/IPv6 address, a 24-hex database id or a credential in its shape (`token=…`,
  `api_key: …`, `access-key=…`, `password: …`, `Bearer <8+ chars>`). A bare word is not one: a game named
  "Secret Agent Saga" or a "Golden Token Week" campaign passes.

---

## 3. Cells, offers, farms

- A **cell** is one game × one farm (`claim`/`noclaim`) × one market: key `gameKey|farm|market`.
- An **offer** is one exact item identity on one market (`contentKey` from `priceTracker/setIdentity`); two sets of
  the same game are different products. A row without exact identity falls back to its size band (`bandKey`).
- **Kind of row** (checked in this order; the first match wins):

| Kind | Test | Advised? | Its sales count as |
|---|---|---|---|
| rent-farm | `rentFarm` or `classifyKind(title) === "farm"` | never | nothing (the tracker drops them; the loader reads a skipped row's fresh title in memory only to tell a rent-farm window from a row repriced since the report) |
| bulk / lot | `bulkOfferId`, `bulkPackSize > 1`, `lotSize > 1` | never | demand only; per-account price into the bulk series |
| account listing | `accountOffer` | never | as the ledger treats them |
| claim-at-sale | `noclaimStock`, `autoClaimSet` or `unclaimedGame` | never; quantity never summed | price evidence and demand |
| system-made | `origin` `auto` (claim farm) or `unclaimed` (no-claim farm) | **yes** | everything |
| hand-made | anything else (`origin` `manual`, the default) | never | price evidence and demand; kept out of the sell-through curve unless the offer is the very same items as a system-made row on that market |

- **Farm of a row**: `unclaimed`, `noclaimStock`, `unclaimedGame` → `noclaim`; `auto`, `autoClaimSet` → `claim`;
  a hand-made row → `noclaim` when its game falls in a no-claim keyword bucket (longest keyword that is a substring
  of the normalised game, `farmDemand.bucketFor`'s rule), else `claim`.
- **Blocked market** (`VENUES[m].blocked` — Digiseller) or a switch the owner turned off: no stock, no price; its
  history never teaches another market's price.

---

## 4. The model (pure — `utils/listingBrain/model.js` and `model/*.js`)

No database, no network, no settings, no clock but the injected `now`. Every number below is a function of the
bundle and the validated config (§8). One clock read changes no output: the async run (`buildRunAsync`, and the
evidence and the fit inside it) gives the event loop back on a 40 ms budget measured with `performance.now()`
(`util.makeYielder`, the only clock in the model's files), checked every 1,024 items, and always right before the
tracker's translator — one synchronous call of 70–120 ms on Node 20 at production volume. Measured there, no synchronous
stretch of the run is over ~115 ms (P20-4); the sync `buildRun` gives the same answer.

### 4.1 Evidence

- **Priced orders**: sales with `p > 0`, source not `hand`, market known, `p ≤ $25` (the tracker's junk bound),
  inside `refDays` (180), one per order (`perOrder`). A blocked market's orders teach only that market, and each
  farm's orders teach only that farm: a no-claim order never moves a claim offer's reference, nor the reverse (H5).
- **Exposure** of a system-made row (plus hand-made rows of the very same `contentKey` on that market, and ladder
  rungs):
  - start: `createdAt`; on quantity/order-unit markets the earliest `units[].addedAt` when the row has units and is
    not claim-at-sale, never before `createdAt` (a unit moved from an older row keeps its old `addedAt` — H17);
  - end: the row's first sale (the joined sale date — never `updatedAt`) on single-unit markets; else `now` for an
    active row; else `updatedAt` (approximate — flagged `endApprox`);
  - Gameflip exposure is capped at `createdAt + 30 d` (expiry), Eldorado at 21 days after `createdAt` with no sale
    — and such an Eldorado offer is no longer live from then on, whatever its status says (H9);
  - a row with `rebundledAt` is split there: the part before belongs to contents nobody recorded and is **dropped**
    from offer-level evidence (kept for the game's demand). A row rebundled after the cut (a backtest) holds today's
    contents, not the cut's: no offer evidence and no advice at that cut (H14).
- **Units sold** on a row inside its exposure: single-unit markets 1 (sold) or 0; other markets the number of
  **orders** joined to the row (distinct order keys: a 3-unit order is one buyer arriving, and the scorer's truth
  counts buyers too — H12). In-stock days on quantity markets are the exposure days (the stock history is not
  recorded — a known limit, §10).
- **Demand off the shelves**: per game × farm, the weekly rate of the owner's hand sales (demand-only `hand` plus
  sales recorded as `hand`, last 30 days) beside bulk's (H6); and per market the sets with a live pack listing or a
  recorded pack price (C8).
- **Window**: exposure is clipped to `[now − fitDays, now]` (`fitDaysClaim` 90, `fitDaysNoclaim` 30).
- ZeusX records no sale for an auto row: its cells are `unmeasured` and never enter a fit.

### 4.2 Reference price `ref` (per offer, market, farm)

The first step that gives a price wins; each carries a confidence by the tracker's rules. Every step reads only
the farm's own orders (H5).

| # | Basis | Price | Confidence |
|---|---|---|---|
| 1 | `exact-here` — this exact offer, this market, ≥ 3 orders | median | `high`; `medium` on Eldorado/G2G/PlayerAuctions (price = listing price now) |
| 2 | `band-here` — same game and size band, this market, ≥ 3 orders | median | `medium` with ≥ 8 orders, else `low` |
| 3 | `translated` — the exact offer's orders on other non-blocked markets, each market's median through `analyze.buildTranslator(...).translate`; else the band's (≥ 2 orders per market). Either needs ≥ 3 source orders in total: one order on one market is no estimate (C10) | median of the translated prices | `medium` when the exact offer sold on ≥ 2 other markets, else `low` |
| 4 | `rivals` — rivals' sold median for the game, this market (radar feed, Gameflip/GGSel only), this size band (radar bands), ≥ 3 sale events | median | `low` |
| 5 | `venue` — this market's median over every order | median | `none` |

- The `p25` that goes with `ref` ("the lower quartile buyers demonstrably pay") is the 25th percentile of the
  orders behind step 1 or 2, else of the band's orders on this market when ≥ 3; from 1–2 orders it is never above
  `ref` (`min(p25, ref)`: two dear orders cannot set the floor of an overstock pick); with none, the floor (H15).
- **Ceiling** of the price grid: this market's observed maximum order price (≤ $25). A `translated`, `rivals` or
  `venue` anchor — a price nobody paid here for these items — is capped by what buyers paid for **this game** here
  (H11): the p75 of the game's size-band orders on this market (≥ 3), else of all its orders here (≥ 3), else
  1.5 × the median the anchor came from (before translation); this market's p75 (the farm's orders here when ≥ 10,
  else every non-blocked market's) only as the last fallback. A market-wide p75 let a cheap game borrow a dear
  game's level.
- **Floor**: `max(floorFor(m), row.venueMinPriceUsd)` for a live row; for a new GGSel listing also the highest
  `venueMinPriceUsd` seen on the game's GGSel rows (the hidden category minimum). Applied **last**.

### 4.3 Sell-through: a hazard per price ratio

For every exposure, `x = ask ÷ ref` where `ask = max(row price, floor)` (a sold row: the sale's price) and `ref` is
4.2 for that row's offer on that market. Buckets (`BUCKETS`): `≤0.80, ≤1.00, ≤1.20, ≤1.50, ≤2.00, >2.00`.

- **What is exposed is an offer, not a row (H3).** On a single-unit market (Gameflip) several rows of one offer
  are up at once and a buyer takes the cheapest: a dear row's slow sale is its rank on our own shelf, not the
  buyers' answer to its price. So an offer is in stock while any of its rows is live; between two moments where a
  row starts, sells or ends, its state is its **lowest** live ask (`x = x_min`), those days go to x_min's bucket,
  and a sale of any of its rows counts at the state just before it. On quantity and order-unit markets one row
  already is one offer.
- **Hazard, not "resolved rows"**: `h = sales ÷ days exposed`, live exposure included — offer-days on single-unit
  markets; on quantity and order-unit markets **orders** per in-stock day of an offer (H12; the cell's weekly
  orders at a price are `7 × h`). `minSales` counts the same sales.
- **Demand tier** of a game: the farm brain's weekly rate `w` (in a backtest: our own 45-day average at the cut,
  the farm brain's default estimator) in three tiers by `tierEdges` [1, 5] units a week.
- **Shrinkage**, per farm (the two farms are fitted apart), with `K = shrinkK` listing-days (30) — the same K, but
  its `K·h_m` pseudo-sales are each farm's own market rate, so it pulls the two farms toward different levels:
  - market: `h_m = S_m ÷ D_m` — with fewer than `minSales` (3) sales the market has **no estimate** at all;
  - market × bucket: `h_mb = (S_mb + K·h_m) ÷ (D_mb + K)`, then made **non-increasing in x** by pooling adjacent
    violators (weights `D_mb + K`);
  - market × bucket × tier: `h_mbt = (S_mbt + K·h_mb) ÷ (D_mbt + K)`, pooled again within each tier.
- A bucket is **evidenced** when its market × bucket holds ≥ `minSales` sales or ≥ `minBucketDays` (60)
  listing-days; otherwise it is **thin** and has **no hazard at all** (H4): it enters neither the pooling (null,
  which PAVA passes through) nor the curve. Shrunk to the market mean, a thin top bucket used to lift the top of the
  curve and push every price to the top of the evidenced range.
- **The curve** runs through the evidenced buckets' nodes, each at its exposure-weighted **mean x** (where its
  exposure actually sat; the open top bucket's "2.5" centre was nobody's price — H13), log-linear between nodes,
  flat beyond the ends — still non-increasing. A node's hazard is floored at `10⁻³ × h_m` before the log, so a
  never-sold bucket with `shrinkK = 0` does not send the curve to −∞ (H18). No price above the highest evidenced
  node is ever a candidate (§4.4).
- **`pH(x) = 1 − exp(−H · h(x))`**: the chance a unit sells within the farm's horizon `H` (`horizonDaysClaim` 7,
  `horizonDaysNoclaim` 2 — no-claim stock sells in hours to days, so a 7-day window says nothing). Logged as `p7`
  for both farms (the name of the brief); the horizon is in the run's `cfg`.
- **A live row's chance** (H3, H9): on a single-unit market buyers of the offer arrive at `h(x_min)` a day and take
  the cheapest row, so a row ranked k-th needs k buyers: `P(Poisson(h(x_min) · d) ≥ k)`. A row tied with s others
  at its price, behind c cheaper ones, is any of the ranks c+1 … c+1+s with equal chance: its chance is the mean of
  those ranks' (N2). Elsewhere `1 − exp(−d · h(x_ask))`. `d = min(H, the row's remaining life)` — a Gameflip listing
  ends 30 days after creation, an unsold Eldorado offer 21. The row's logged `rank` stays `1 + rows strictly
  cheaper + ⌊other rows at the same price ÷ 2⌋`.
- **Queue calibration** (N2): the queue is not fixed — cheaper rows of ours keep arriving and take the buyers a
  k-th row was waiting for (on the large fixture the plain queue model read 0.16 for 2nd rows that sold 0.07). So
  the fit also samples each offer's timeline once a day: every live row's queue-model chance over the horizon (cut
  by its remaining life) beside whether it sold within it, where that outcome is already known. Per single-unit
  market and queue class (alone on its offer, 1st, 2nd, 3rd+ of several) the factor `f = (sold + K·p̄) ÷
  (predicted + K·p̄)` — realised over predicted, shrunk toward 1 with `K = shrinkK` row-days at the class's mean
  chance `p̄` — scales the rank's tail, and a rank's chance is never above the rank before it (a higher rank never
  sells faster). The factors are logged with the fit (`markets[m].queue`).
- **The baseline** (H8, N1): each logged forecast carries `pb`, the market's base rate over the same days at the
  moment it was made — every LISTING selling at the market's own rate: `1 − exp(−d · h_b)`, `h_b` = sales ÷
  row-days of the fit rows. On a single-unit market that is not the curve's `h_m` (per offer-day: an offer with
  three rows up is one offer-day and three row-days); read per offer, the baseline was ~2× too high on Gameflip and
  the model's skill over it ~2× inflated.
- **No-claim time left**: a no-claim unit's horizon is `min(H, days until its stock expires)`, where expiry is the
  wave's end plus the claim window learned from the ledger (median `expiredAt − wave end` over expired units of the
  game, else over all games, else 0) — §4.7.

### 4.4 Price

For each offer in a cell, candidate prices are `ref × {0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.35, 1.5, 1.75, 2.0}`
plus the floor, the `p25` and (live) the current ask, kept inside `[floor, ceiling]`, snapped to $0.05, and only
up to the highest evidenced node's x (no extrapolation above the evidence — H4). **The curve never proposes a price above
the evidence**: no pick, raise, test unit or stale rung lands above its top node (only the owner's own rules — a
floor, the no-claim sold floor or bundle order — can lift a price there), so nothing the brain advises creates
evidence higher up: learning what a dearer price would sell at needs price experiments, a later round. Each scores

`value(p) = pH(p ÷ ref) × net(p)`, `net` = `venues.netOf(p, m, fees)` (after the market's fee).

**Regime**, per game × farm, from the farm brain's row: `cover = stock on hand ÷ weekly forecast` (weeks), target
cover `T = coverageDays ÷ 7`:

| Regime | When | Choose |
|---|---|---|
| `scarce` | `cover < scarceCover × T` (0.5), or (claim) the campaign has ended and the radar shows ≤ `rivalsGoneMax` (1) live rival sellers | the highest evidenced price with `pH ≥ minP7Scarce` (0.5); none → `balanced` |
| `balanced` | otherwise | the highest `value(p)` (ties → the higher price) |
| `overstock` | `cover > overstockCover × T` (2), or the farm brain's class is `skip`, or the game is fading (`avg30 < fadeRatio × avg45`, 0.5), or (no-claim) the stock expires within `perishHours` (48) | among prices ≥ `max(p25, floor)`, the highest `pH` (ties → higher price) |
| `unknown` | no fresh farm-brain row, or one missing its stock or its forecast (never read as 0 — M10a) | logs nothing but the reason; action `hold` |

In a backtest the demand row is our own 45-day average at the cut and has no stock: cover is unknown and the regime
comes from skip, fading or perishing only (H7).

A campaign ending is evidence for `scarce` only through the data above; no-claim stock is never held back for a
later price (scarce on the no-claim side only means "the price can go up", never "list fewer").

**Gates, in this order** (each logged when it binds):

1. **Confidence**: below `medium` the price is logged but the action is `hold`.
2. **Raise rule**: a price above the base (the live ask; for a new listing, today's price) needs `raiseMinSales` (2)
   orders on this market of this game's band at or above it, or repeated stock-outs (the cell's shelf stood empty
   ≥ `stockoutShare` (30 %) of the last 30 days while the game sold elsewhere). Otherwise it is cut to the highest
   evidenced price above the base, or the base. Never on the `venue` basis or a rival's ask.
3. **Step limit**: at most `maxStepPct` (35 %) away from the base in one move (a larger gap is taken in steps).
4. **No-claim ceiling** (`getUnclaimedPricing`, as `bundlePrice` applies it): never over it — before the floors, so
   only the sold floor may lift a price past it.
5. **GGSel raise-only**: on GGSel the price never goes below the base.
6. **No-claim bundle order** (containment: a bigger bundle of the game is never cheaper than one it contains): a
   lift only from contained offers the brain is confident about (≥ `medium`), and a lift is a raise like any other —
   never past the ceiling nor one step from the base; what it cannot reach is flagged `containment-held` and waits
   for the next move (M3).
7. **No-claim 30-day sold floor** — the owner's rule, and its own evidence (buyers paid it on Gameflip within 30
   days), so it needs no orders here. Decision (M13b): a new listing takes it in full, as `bundlePrice` does; a live
   row is moved to it within the step limit, flagged `sold-floor-steps`.
8. **Floor last**.

Every other policy's price that is logged or answered goes through the same chain (M2, §4.6).

**A live system-made row** gets an action: `hold`, `lower`, `raise` or `test`:
- `|gated − ask| ≤ max($0.10, 8 %)` → `hold`;
- **above the evidence** (N11): a row asking more than the curve's top node (`ask ÷ ref` above it) is `hold`, with
  no brain price beside it — the curve has no hazard up there and says nothing about its price, so it is never
  lowered on the curve's word — unless it is **stale**, judged at the top node's hazard (`staleFactor` × `1 ÷
  h(top)`, × its rank on a single-unit market, its age by H2's rule): then the stale rung below. A floor that lifts
  the row still lifts it (the owner's rule, not the curve);
- **stale** — rule 5's missing half: age > `staleFactor` (3) × the expected days to a sale at its ask, read only
  where the curve is evidenced (`1 ÷ h(x)`; on a single-unit market at the offer's x_min, × the row's rank — H3),
  and only when the gated price is within the agree tolerance of the ask: the stale rule never overrides a raise or
  a lower the curve gives (H2). On quantity and order-unit markets the age runs from the row's last sale, not its
  creation (H2: a steadily selling 60-day Eldorado offer is not stale). The move is one rung down **inside the
  gates** (M1): the highest candidate below the ask and at or above `max(every floor, the no-claim sold floor, the
  bundle-order lift, ask × (1 − maxStepPct))` that the evidence covers; none → `hold`; a stale GGSel row holds;
- a raise the raise rule cut back, with `value` ≥ 15 % above holding → `test` (one unit, not the row's whole stock)
  at `max(the ask moved one step toward the wanted price, every floor)`, only when that is above both the gated
  price and the ask (M1);
- cool-down: a row that was advised a different non-`hold` action less than `cooldownH` (72) ago is `hold`
  ("cool-down").
- A deliberate **ladder** (an exact offer live at ≥ 2 prices on one market with any owner row — hand-made or
  claim-at-sale; two system-made rows at two prices are drift, and advised — C4) is `ladder`, never corrected; its
  rungs are read as evidence. Decision (M13a): a ladder offer gets **no brain price at all** (`p` null, no raw on
  the page; "a deliberate test, left alone") — a number beside it would only invite a correction. That holds for
  the offer's new-listing verdict on a market where only the owner's rungs are live, too (N7).

### 4.5 Placement (the shelf)

Per game × farm with unsold stock.

**Eligibility per market** — no marketplace call:

| Class | When |
|---|---|
| `closed` | blocked; the owner's switch off (`takes[m]`, the same switches `listActivatedTask` reads); or the floor is above what the evidence says the offer sells for there (`floorFor(m) > ref` with confidence ≥ `low` — PlayerAuctions' $5) |
| `unmeasured` | ZeusX with its switch on: it records no auto sale, so it can never earn evidence — no exploration unit, shelf 0, said on the cell |
| `open` | switch on and mapped: Gameflip, Digiseller and Eldorado need no per-game mapping; GGSel with `af.ggselCategoryId`; G2G when `brandForGame` knows the game; any market where we have, or have had, an auto listing of this game |
| `unknown` | switch on, mapping unproven (today's lister would ask the marketplace; the brain may not) — logged, shelf 0 |

- **Bulk first**: `bulkTake = min(stock, round(bulk weekly units × shelfHorizonDays ÷ 7), stock − reserveSingles)`
  (the game's demand-only bulk series) is set aside before any single shelf, its own line; the owner's
  `getBulkPacks().reserveSingles` is the other half of that split — single shelves keep at least that many (C19a).
  A hand-set shelf cap and `reserveSingles` are read, never changed.
- **Packs**: a single listing's price anchors the next pack of the same **set** (`bulkPacks/pricing.pickAnchor`):
  an offer whose set has a live pack or a recorded pack price on a bulk market is flagged `bulk-anchor` (a cell
  shows the flag when any of its offers has it) and carries `packs` = `bulkPacks/pricing.tierQuote({anchor: its
  brain price, market, tiers})` — the pack maths itself, no copy; tiers are `{minQty, discountPct}`, an older
  `{size}` read as `minQty` (C8).
- **Single-shelf demand** `W_s = max(0, W − bulk weekly − hand weekly)`: the farm brain's forecast `W` counts every
  unit the game sells, bulk packs and the owner's hand sales too, and those never come off a single shelf (H6:
  bulk was counted twice, set aside and inside the split).
- **Market rate** `λ_m = W_s × share_m`, `share_m ∝` the game's shrunk in-stock rate on m (sales ÷ in-stock days
  over 30 days, shrunk toward the game's pooled rate with `shareShrinkDays` (14) days; with 0 the raw in-stock rate)
  over the **proven** open markets (a sale of the game there in the fit window) — a market that was out of stock is
  not read as one that does not sell. No sale anywhere in 30 days is **no split**, never an equal split passed off
  as evidence (M12).
- **Horizon**: `shelfHorizonDays` (14) where today's flow refills (Gameflip, Digiseller, GGSel);
  `nonRefillHorizonDays` (28) elsewhere (ZeusX, PlayerAuctions, G2G; Eldorado only by a whole new share).
- **Value of the k-th unit** on m: `P(D_m ≥ k) × net_m`, `D_m ~ Poisson(λ_m × horizon_m ÷ 7)`, `net_m` the net of the
  brain's price for the game's offer there. Units are placed greedily on the highest marginal value until stock
  runs out or the value falls under `minMarginalUsd` ($0.10). The rest is the **reserve** (today's hold-back),
  released as shelves empty.
- **Exploration**: when the reserve is positive, at most one unit on at most one open unproven market per game,
  preferring one where the radar shows rivals selling (`perWeek > 0`); never on `unmeasured` or `unknown`.
- **Platform limits** (named constants in `model/place.js` with their source): Eldorado refuses new offers once a
  category holds 100 active offers or the daily quota is spent (`autoLister` `ELD_LIMIT_RE`) and closes an offer at
  quantity 0; Gameflip expires a listing after 30 days and refuses a login it already sold; PlayerAuctions accepts
  item offers only for some games and replaces the offer (new id) on every update; GGSel cannot remove one unit (a
  shelf below today's on GGSel is flagged `noRemove`).
- A brain shelf of 0 on Gameflip is flagged `anchor` (today's path cannot do it).
- **Fees**: five fees are assumptions (`VENUES[m].verified === false`, unless overridden in settings). A fee never
  changes the best price inside one market but ranks markets: every cell whose fee is assumed is flagged
  `fee-assumed`, and the run logs the placement with all fees equal (`shEq`): each market's price netted at the open
  markets' mean fee, so the `minMarginalUsd` threshold still compares nets (H18).
- **No-claim**: placement is only the capped shelf on Gameflip, Digiseller and GGSel; the brain's total shelf for
  the game is logged beside the cap in force (`managed` when the cap is explicit, §1.3 #12). Its Eldorado,
  PlayerAuctions and G2G offers are claim-at-sale: `managed`. The rest of the stock is the free pool, which sells
  only through an **outlet**: a live claim-at-sale offer, bulk or hand sales. With none, the pool sells nothing (λ 0,
  no price borrowed for it) and every unit an open shelf can sell goes on the shelves, up to the cap in force —
  perishable stock held "for later" just expires (M9) — but only on markets where the game has demand (`λ_m > 0`):
  a market it never sold on gets at most the one exploration unit, never a heap (GGSel cannot take a unit back —
  N6).

### 4.6 Policies, logged side by side

Every run logs all of them; the score picks; the default changes only on evidence (`policyPrice`, `policyPlace`).

- **Price**: `old` (a live cell: the median live ask of its system-made rows; a new listing: rules 1–2 for a claim
  cell, `bundlePrice` for a no-claim cell), `tracker` (`suggestForNew` as it is), `curve` (§4.4, the default),
  `clear` (rivals' sold median for the size band, translated from Gameflip to the cell's market).
- Every price a policy logs (`pol.*`) or answers passes through §4.4's gates with the run's floor (M2): `clear` as
  a rival's price (it never raises), `tracker` by its own basis (an engine fallback reads "none"), `old` as its own
  base — today's price moved only by the floors, the no-claim ceiling and the sold floor (N3: gated against the main
  offer's base it moved a whole step and was no longer today's). On a blocked or switched-off market no `curve`,
  `tracker` or `clear` price is logged (N8).
- **Placement**: `flat` (rules 3–4 via `computeSplit` + `dealShares` over today's order, or the no-claim cap in
  force), `share30` (last 30 days' sales share), `instock` (raw in-stock rate share), `newsvendor` (§4.5, the
  default). Each splits the same single-shelf demand `W_s` (H6). Each policy's weekly **demand split** `λ^policy_m`
  (uncapped by any shelf; 0 where it splits nothing, null when it has no split for the game) is logged per cell as
  `pd` — what the scorer compares with units sold (H1) — and its weekly forecast `E[min(Poisson(λ^policy_m),
  shelf^policy_m)]` over 7 days as `pf`.

### 4.7 Old versus brain, same moment

Per cell: today's median live ask of the system-made rows (as `max(price, floor)`), units listed, the price today's
rule gives a new listing now, today's shelf (flat share, or the no-claim cap) — beside the brain's price (the
median over the same live rows of the brain's price for each, or its ask where the brain leaves it — like with
like, M11; none when the brain priced none of them, so a cell with no evidence is `no-evidence`, never `agree` on
asks alone — N4), shelf, regime, confidence and reasons. The claim game's `all` line also logs rule 3's old side: the
post-event price and the split's list-now / hold-back units (`old.post`, `old.now`, `old.hold` — C7).

- Price classes: `agree` (within `max($0.10, 8 %)`), `brain-lower`, `brain-higher`, `no-evidence`, `managed`, `ladder`.
- Placement classes: `agree` (within one unit), `brain-more`, `brain-fewer`, `brain-add` (today 0), `brain-drop`
  (brain 0), `closed`, `unknown`, `unmeasured`, `managed`.
- Totals compare like with like; a cell the brain has no evidence for is counted apart, never as zero.

### 4.8 Three outputs for the next round (exported; wired to nothing)

- `priceFor({ marketplace, basePriceUsd, title, game, itemCount, items }, { now })` → `{ price, confidence, basis,
  regime, reasons }` — the question `priceTracker/attach.priceForNew` asks. Answered from the newest run's fitted
  model; no run, a run older than `max(2 × intervalMin, maxDemandAgeH)` at `now` (M7), an unknown game, a blocked
  market, a no-claim offer on a claim-at-sale market (`managed`, M6), the `old`/`tracker` policy or a price below
  `medium` confidence → today's price with confidence `none`, clamped to today's limits (the floor, the learned
  GGSel minimum, the no-claim floor and ceiling — M8). An invalid base (not a positive number, or over $25) gets no
  answer at all: `{price: 0, confidence: "none", basis: "invalid base"}` — never a brain price without a base.
- `shelfFor({ game, farm, stock }, { now })` → `{ shelf: {market: units}, reserve, bulkTake, explore }` — what
  `computeSplit` and `dealShares` decide today. A stale run, an unknown game, or a no-claim game under a cap the
  owner set by hand (`managed`, M5) → no shelf advice: every unit in `reserve`.
- `valueFor(gameKey, { farm, now })` → `{ value, shares, nets, basis }`: expected net per account under the brain's
  placement and prices, each market weighted by the units it is expected to **sell** there, `E[min(D_m, shelf_m)]`
  (H18), not by the units placed — for the farm brain's "value per account" later. A stale run → null.
- Callers' answers are memoised on the run in a bounded cache (1,000 entries, oldest dropped — P20-14): a caller
  can never grow the run's own memory.

---

## 5. Scoring — how good is it, without changing a price

| Score | What it tests |
|---|---|
| **Sell-through calibration** | Every live system-made listing of either farm gets `pH` at its current ask. After the horizon: Brier score and a reliability table (10 bins of `pH`), per farm, against the baseline "every listing on this market sells at the market's base rate" (`1 − exp(−H·h_m)`, logged with each forecast as `pb` — the base rate at forecast time; a forecast logged before `pb` existed is judged against a fit made at its own sample's moment, never at another sample's). Skill = 1 − Brier ÷ baseline Brier. The model must beat the baseline before anything it says is trusted |
| **Discrimination** | Realised sell rate within the horizon of rows the brain called `lower`, `hold`, `raise`, `test` (an unknown game's hold is an abstention and a ladder is never corrected: both counted apart; ZeusX records no sale and is left out) |
| **Placement** | Each placement policy's weekly **demand split** for a market (`pd`: its forecast rate there, not capped by any shelf) against the units system-made rows sold there that week: RMSE, MAE and bias per policy. A cell-week is scored only when the market was **in stock ≥ 6 of its 7 days** (the farm brain's in-stock rule — the union of the cell's system-made rows' exposure spans, by §4.1's rules): a week out of stock says nothing about demand. Of those, it is scored when it sold or any policy expected a sale; a policy with no number on an admitted week is missing, never 0, and is ranked only on the same weeks. The shelf forecasts (`pf`, E[min(D, shelf)]) stay in the log as context only: the sales came from the shelf that was really listed, so scoring a policy's shelf against them would reward whichever policy resembles today's shelf |
| **Agreement analysis** | Realised net per listing-day for rows priced within 10 % of each price policy versus rows further away, by market. **Correlation, labelled so** |
| **Sold or expired** (no-claim) | For no-claim units live at the forecast: the share the brain expected to sell before expiry against the share that did; Brier per unit. Units of one wave on one market are one queue (a Gameflip chain shows one unit at a time, a pool sells oldest first): of k units with d days to expiry, E[min(Poisson(Σ h_row · d), k)] are expected to sell, each live row's hazard read back from its logged forecast (`h = −ln(1 − pH) ÷ H`) |
| **Decision review** | Last week's largest price and shelf disagreements (dollars at stake: price gap × units listed + shelf gap × the unit price), with what sold next |

- **Backtest from day one**: for each of the last 6 weeks, the model's own run on the bundle as it stood at the cut
  (exposure truncated at the cut, sales before it, reference prices from orders before it, demand synthesised from
  our own 45-day average), scored against the bundle's later sales. A replay cannot know the farm brain's stock at
  the cut (a replayed regime comes from skip, fading or perishing, never from cover), and still reads some fields as
  of today: a listing's price, ask, learned floor and quantity counters, the radar's game rows, a no-claim unit's
  bundle key and listing ids; today's old-side numbers stand in for the old side. The output lists these limits.
- **Forward**: the first run of each UTC day logs its per-listing forecasts (capped, `fcCap`) with their base rates;
  each is scored once its horizon has passed (claim 7 days, no-claim 2). Ranked on the same rows only; a policy
  missing on any admitted row reads "not enough history yet". The scorer runs asynchronously (`forwardScoresAsync`,
  `backtestAsync`), yielding on a time budget: no synchronous stretch over 200 ms on Node 20 at production volume.
- **What test mode cannot show**: whether a *different* price would have sold, or whether a *different shelf* would
  have sold more. Every comparison above is between what the brain would have said and what happened at the price
  that was actually asked, from the shelf that was actually listed. That needs live experiments — a later round.

---

## 6. The log

- `ListingBrainRun` (one per run): `at, v, ms, cfg, summary, counts, notes, rowsN, day, fcN, fc` — `fc` (the
  per-listing forecasts `{l, k, f, m, x, b, p, pb, h, a, ask}`: listing id hash, cell, ask/ref, bucket, sell chance,
  the market's base rate at that moment, horizon, action, ask) only on the first run of each UTC day, capped at
  `fcCap`; null otherwise.
- `ListingBrainRow` (one per cell, plus one `m: "all"` row per game × farm for its placement): `run, at, exp, k, g,
  f, m, live, hl, pc, sc, old, br, pol, pf, pd, ev, fl` — compact keys, written **sparse** (no reasons — kept in
  memory for the newest run —, no nulls, `false`s, empty lists or zero action counts; every other 0 is kept, since
  the scorer reads a missing number as missing, never as 0); rows read back are expanded to the in-memory shape.
- Write order: the run's id is made first, its rows are inserted, the run document is written **last** — a failed
  row insert leaves no run document, so a partial day is never read as that day's sample.
- Retention: runs 21 days (TTL `{at}`); rows expire per row (`exp`, TTL `{exp}`): the first run of each UTC day
  (the daily sample the forward score reads) 21 days, every other run's rows **3 days** (a cell's intraday history
  is a convenience). A `{at}` 21-day TTL on rows is the backstop. Indexes: rows `{k, f, m, at: −1}`, `{run}`,
  `{exp}`, `{at}`; runs `{at}`. Written once, never updated. A cell's history is an indexed read of its rows.
- **Size**, measured through the real schemas (`tests/listingBrainSpeed.test.js`, Node 20):
  - large fixture (150 games × 7 markets, 4,742 listings, 5,255 sales): 908 rows a run at 565 B (671 B before
    the sparse write) = 513 kB + a 3.1 kB run document; the daily forecasts at `fcCap` 5,000 = 747 kB (149 B
    each); **steady state at 8 runs a day: 10.8 MB daily rows + 10.8 MB intraday rows + 0.5 MB run documents +
    15.6 MB daily forecasts = 37.7 MB** (target 60 MB; indexes not counted);
  - production volume (the reviewers' synthetic world: 20,000 listings, 32,000 sales, 100,000 no-claim units,
    1,462 rows a run): **50.8 MB** (74 MB if intraday rows were kept 7 days).

---

## 7. Runner and safety contract

- `utils/listingBrain/index.js`, same contract as the farm brain's runner: `start`, `stop`, `status`, `loopStatus`,
  `runOnce({force, persist})`, `latest`, `cellHistory`, `accuracy`, `priceFor`, `shelfFor`, `valueFor`,
  `_setHooks`, `_reset`.
- Started from `routes/priceTrackerRoutes.real()` (one line beside the farm brain's); nothing else starts it. First
  tick 9 minutes after boot (after the farm brain's first run), then every `intervalMin` (180); while off the
  switch is re-read every 10 minutes. No timer or connection starts on `require`.
- One run at a time; a load that outlives `RUN_TIMEOUT_MS` (10 min) blocks new runs until it settles, and every
  skipped tick says so. A failed load writes nothing. A failed insert is reported as **NOT LOGGED** in the heartbeat
  and status. `runOnce` and `loopStatus` never throw. Error text that reaches the log, the status or a route is
  cleaned of hosts, paths, ids and secrets (`inputs.cleanMsg`).
- The scorer (`accuracy()`) uses the bundle the newest run left in memory, whatever its age (it says the age).
  With none: while the brain is off it answers "no run yet" **without any read**; while a run is loading it says so;
  otherwise it loads through the run's own one-at-a-time guard and timeout.
- A tick that finds the switch off drops the in-memory run and bundle (~150 MB at production volume); the three
  answers (`priceFor`, `shelfFor`, `valueFor`) abstain when the newest run is older than its own interval allows.
- **Never holds the event loop** — measured on **Node 20** (production's version; it is ~15× slower than Node 22 on
  the spread-built objects of the tracker's ledger, so Node 22 numbers hide the cost): the loader yields between
  reads and on a 50 ms budget inside every long pass, asks the tracker only for each cell's main offer (≤ 400, a
  yield per call), and hashes each id once; the model and the scorer yield on a shared time budget
  (`util.makeYielder`, the only clock the pure model reads — it changes no output). At production volume (20,000
  listings, 32,000 sales, 100,000 no-claim units) the longest synchronous stretch is ~100–160 ms in the load (the
  tracker's own `buildTranslator`, 70–120 ms, is the largest single piece and cannot be split without copying it),
  ~93–134 ms in a run, under 200 ms in the six-week backtest and the forward score. A full load takes ~17.5 s
  (it took 165 s with 1.3 s stretches before the review); a run ~1.7–1.9 s. The large fixture runs in ~0.3 s
  with a longest stretch of ~45 ms. Memory at production volume: ~140 MB retained between runs (bundle + run),
  ~340 MB peak during a run.
- **Writes only its own log** (`ListingBrainRun`, `ListingBrainRow`). No marketplace call, no setting written, no
  listing, account, reservation or task touched, no SSH. Enforced by a source scan test (§11).
- **Fail-safe direction**: whatever the brain cannot read, it abstains on (`unknown` / `hold`) and says why. A
  failure inside the brain can never stop or alter a publish (it is wired to none).
- Heartbeat: one line per run, `listingBrain: run N (model v1) — claim C cells (P priced: agree a, lower l, higher
  h, no-evidence n) shelf old S → brain B (+R reserve) | no-claim … | live rows: hold/lower/raise/test | Ns`.
- Production runs Node 20 with production dependencies only: nothing under `utils/`, `models/`, `routes/` uses a
  dev dependency or syntax newer than Node 20.

---

## 8. Settings — `autoFarm.listingBrain` (all optional)

Read through `settings.getAutoFarm()` on every tick; `model.readConfig` validates and clamps every key (a typo
reads as the default; only an explicit "on" turns it on). `utils/settings.js` needs no change: `getAutoFarm()`
passes unknown keys through.

| Key | Default | Clamp | Meaning |
|---|---|---|---|
| `enabled` | false | on/off | the switch |
| `intervalMin` | 180 | 30–1440 | minutes between runs |
| `maxDemandAgeH` | 6 | 1–72 | a farm-brain row older than this makes the game `unknown` |
| `fitDaysClaim` / `fitDaysNoclaim` | 90 / 30 | 14–180 / 7–120 | exposure window of the hazard fit |
| `refDays` | 180 | 30–365 | window of the reference-price orders |
| `horizonDaysClaim` / `horizonDaysNoclaim` | 7 / 2 | 1–28 / 0.5–14 | horizon of `pH` |
| `shrinkK` | 30 | 0–1000 | shrinkage strength, listing-days |
| `minSales` | 3 | 1–50 | sales for an estimate |
| `minBucketDays` | 60 | 1–10000 | listing-days that evidence a bucket |
| `tierEdges` | [1, 5] | two ascending positives | demand tiers, units a week |
| `scarceCover` / `overstockCover` | 0.5 / 2 | 0–10 / 1–50 | × target cover |
| `minP7Scarce` | 0.5 | 0.05–0.99 | the sell chance a scarce price must keep |
| `fadeRatio` | 0.5 | 0–1 | avg30 below this × avg45 is fading |
| `perishHours` | 48 | 0–720 | no-claim stock this close to expiry is overstock |
| `rivalsGoneMax` | 1 | 0–100 | live rival sellers at or under which an ended campaign reads scarce |
| `maxStepPct` | 35 | 5–100 | step limit per move |
| `agreeAbsUsd` / `agreeRelPct` | 0.10 / 8 | 0–5 / 0–100 | price agreement band |
| `raiseMinSales` | 2 | 1–50 | orders at or above a raise |
| `stockoutShare` | 0.3 | 0–1 | empty-shelf share that counts as repeated stock-outs |
| `cooldownH` | 72 | 0–720 | hours between advised moves on one row |
| `staleFactor` | 3 | 1–20 | age × expected days to sale that reads stale |
| `shelfHorizonDays` / `nonRefillHorizonDays` | 14 / 28 | 1–60 / 1–120 | placement horizons |
| `minMarginalUsd` | 0.10 | 0–10 | a unit worth less than this stays in reserve |
| `shareShrinkDays` | 14 | 0–365 | shrinkage of the market split |
| `explore` | true | on/off | the one-unit exploration |
| `fcCap` | 5000 | 0–20000 | per-listing forecasts kept per daily run |
| `policyPrice` | `curve` | old/tracker/curve/clear | which price `priceFor` answers with |
| `policyPlace` | `newsvendor` | flat/share30/instock/newsvendor | which shelf `shelfFor` answers with |

Read, never written, from the auto-farm's own settings: `perMarketStock`, the market switches, `platiCategoryId`,
`ggselCategoryId`, `noClaimGames`, `noclaimAutoSize`, `unclaimedGameCaps`; the farm sizing policy; the no-claim
pricing; the bulk-pack settings; top-level `priceTracker.fees`.

Off switch (no restart): `node -e 'require("./utils/settings").setAutoFarm({listingBrain:{enabled:false}},{actor:"owner"})'`.
`setAutoFarm({listingBrain: …})` replaces the whole block.

---

## 9. API and page

- `routes/listingBrainRoutes.js` → `mount(router, {guards, brain})`, read-only, under
  `/api/price-tracker/listing-brain/`: `status`, `latest` (filter by farm, market, class, live, search; sort;
  paged), `cell/:key` (`gameKey|farm|market`; the newest row with reasons and offers, plus the cell's history),
  `accuracy`. Every route goes through one guarded helper that spreads the same guards as the farm-brain routes
  (`requireSuperadmin`, `enforce2fa`); an anonymous caller is refused. Responses are **whitelisted** — no login,
  account id, seller, listing database id or external id leaves the API.
- Page: Price tracker → **"Listing brain (test)"** (`public/listing-brain.js`, plain words like the farm-brain
  tab): Overview (counts by price and placement class, today's shelf vs the brain's, weekly value old vs brain),
  Cells (sortable, filterable, live campaigns first, a cell sheet with reasons and history), Accuracy (§5 tables,
  "not enough history yet" where true). The script holds code only, never data.
- Offline: `node scripts/listing-brain-preview.js <bundle.json>` serves the tab from a bundle;
  `node scripts/listing-brain-backtest.js <bundle.json>` prints every score table and the top disagreements;
  `node scripts/listing-brain-fixture.js [--large] [--seed N] > bundle.json` writes a synthetic bundle.

---

## 10. Known limits (stated, not hidden)

- **Test mode cannot show whether a different price would have sold.** Every score compares the brain with what
  happened at the price actually asked.
- No price history on a row: a repriced row's exposure is judged at its current price (the post-event ×1.5, the
  no-claim repricer, operator scripts).
- No stock history on quantity markets: in-stock days are active days; a shelf at 0 units while active reads as
  in stock (it lowers a hazard, never raises it). Plati/GGSel sales are inferred from stock drops and lean low.
- `updatedAt` approximates the end of a delisted/removed row; sales dated by detection passes (minutes late) or by
  `updatedAt` (`row` source) are approximate.
- Rotation (`noclaimOfferRotation`) rewrites an Eldorado row's set without a timestamp: its earlier sales are
  attributed to the new contents.
- `UnclaimedAccount` keeps one document per account: an earlier listing cycle's exposure is lost when the account
  is re-listed (and a previous life's `expiredAt` is ignored, not used).
- A no-claim unit taken off sale with no date of its own (skipped, removed, manual) is dated by the ledger's last
  write (`updatedAt`), which any later write (a check pass's `lastCheckedAt`) moves: a backtest cut between the real
  moment and that write still reads the unit as on sale.
- The radar watches Gameflip, GGSel and Plati only; Eldorado, PlayerAuctions, G2G and ZeusX cells say "blind".
  Rival counts have no history, so "rivals disappearing" is "few rivals now".
- Five fees are assumed until the owner sets them.
- The demand tier of a historical listing in the live fit is the game's tier now.
- **Money is USD everywhere.** `MarketplaceListing.price` is USD on every market, GGSel included (the rouble price
  is made by the connector at publish, `usdToRub`); the brain prices, compares and applies GGSel's raise-only rule in
  USD. A rouble rate move can change what a GGSel buyer sees without any USD price changing.
- Claim event bundles: `autoFarmBundles.priceBundle` is told `full: false` (whether a bundle completes its event
  is not recorded on its set), so today's price for a full-event bundle is logged without its full-event bonus.
- The loader reads at most 20,000 listings, 2 × 50,000 no-claim units, 5,000 campaigns and 5,000 farm-brain rows a
  run (each read says so in the notes when it hits its cap); a bigger shop would be partly seen.
- Our own Gameflip offers are fitted at their cheapest live row: what a buyer of a deeper or more expensive row
  would have done differently is not modelled beyond the rank (the next buyer takes the cheapest row).

## 11. Verification

Filled in as the build lands: test counts per file, what ran and what could not (the in-memory Mongo download is
blocked in the build sandbox), the mutation pass, the backtest on the synthetic fixture, model time and log size on
the large fixture.

## 12. Not in this round

Wiring anything into a publisher, any repricing of a live listing, price experiments, bundle composition. The
proposed hooks for the next round are in `docs/LISTING-BRAIN-HANDOFF.md`, as anchored snippets, not applied.
