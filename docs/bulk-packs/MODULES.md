# Bulk packs — module APIs (frozen)

All paths are relative to the worktree root. All async functions return promises.
"Unit is FREE" = `!u.deliveredAt && !u.messagedAt && !u.orderId` (CONTRACT I2).
`bp` = the object returned by `settings.getBulkPacks()`.

## utils/bulkPacks/config.js (A1) — pure except `currentGate`
```
SUPPORTED_MARKETS = ["eldorado","g2g","gameflip"]
BLOCKED_MARKETS   = ["digiseller","plati","ggsel"]
SOURCE_MARKETS    = { dropset:["eldorado","g2g","gameflip"], noclaim:["eldorado","g2g"], farm:["eldorado","g2g"] }
KIND_OF_SOURCE    = { dropset:"accounts", noclaim:"accounts", farm:"farming" }
MARKET_FLOORS     = { eldorado:0.5, g2g:1, gameflip:0.75 }
TITLE_MAX         = { eldorado:160, g2g:128, gameflip:120 }
DESC_MAX          = { eldorado:2000, g2g:5000, gameflip:5000 }
FARM_TITLE_RE     = /\bAutomatic\s+Farming\b/i
OPEN_STATES       = ["sending","live","paused"]
CLOSED_STATES     = ["sold_out","sold","withdrawn","expired","error"]
slotKey({kind, source, setId, game, days, market, minQty}) -> string   // CONTRACT I6
isMarketAllowed(market, bp) -> boolean   // supported, not blocked, in bp.markets
tierFor(bp, minQty) -> {minQty, discountPct} | null
deliveryGate({market, source, af, noclaimShop}) -> {ok:boolean, reason:string}   // CONTRACT I4
currentGate(market, source) -> {ok, reason}   // reads settings.getAutoFarm() + settings.getNoclaimShopSettings()
```
`models/BulkOffer.js` requires OPEN_STATES/CLOSED_STATES from here (config must stay
dependency-free at top level: require settings lazily inside `currentGate`).

## utils/bulkPacks/pricing.js (A2) — pure
```
round2(x) -> number                 // NaN -> 0
roundQuarter(x) -> number           // to $0.25, 2 dp
unitPrice({anchor, discountPct, market}) -> number
    // 0 when !(anchor > 0); else max(MARKET_FLOORS[market], round2(anchor * (1 - d/100)))
packPrice({anchor, discountPct, size}) -> number
    // gameflip pack: 0 when invalid; else max(0.75, roundQuarter(size * anchor * (1 - d/100)))
farmUnitPrice({farmPrices, market, days, discountPct}) -> number
    // anchor = Number(farmPrices?.[market]?.[String(days)]); then unitPrice(...)
pickAnchor({rows, set, market}) -> {anchor, basis, listingId}
    // rows: lean MarketplaceListing rows. Candidates: marketplace === market,
    // status === "active", !bulkOfferId, String(row.set) === String(set._id), price > 0
    // -> LOWEST price, basis "listing". Else Number(set.price) > 0 -> basis "set".
    // Else {anchor:0, basis:"none", listingId:""}. If anchor > 0:
    // anchor = max(anchor, Number(set.minPriceUsd) || 0).
tierQuote({anchor, market, tiers}) -> [{minQty, discountPct, unitPrice, packPrice}]
    // packPrice only for gameflip (0 elsewhere)
```

## utils/bulkPacks/copy.js (A2) — pure
```
stripBulkSuffix(title) -> string   // removes any suffix this module adds
accountsTitle({baseTitle, market, minQty, discountPct}) -> string
    // eldorado/g2g: `${base} — BULK ${minQty}+ accounts (${d}% off)`  (omit "(0% off)")
    // gameflip:     `${base} — PACK OF ${minQty} ACCOUNTS`
    // base truncated with "…" so the whole title <= TITLE_MAX[market].
    // THROWS if the result matches FARM_TITLE_RE (CONTRACT I5).
accountsDescription({setName, items, game, market, minQty, source}) -> string
    // items: [{name, qty}]. Plain buyer copy, <= DESC_MAX[market]. Must say: each account
    // holds the whole bundle; minimum order `minQty` accounts (eldorado/g2g) or "you
    // receive `minQty` separate accounts" (gameflip); for source "noclaim": the buyer logs
    // in, links their own game account and claims the rewards. Never a login/password.
farmTerm(days) -> "1 Year" when 365, else `${days} Days`
farmTitle({game, days, minQty, market}) -> string
    // `${game} Twitch Drops Automatic Farming ${farmTerm(days)} — Bulk ${minQty}+ Accounts`
    // if too long drop " Accounts"; still too long -> THROW.
farmDescription({game, days, minQty}) -> string
    // bulk version of the existing farm copy (read scripts/eldorado-farm-listings.js
    // description()): minimum order, each account farms `game` for the whole window,
    // credentials arrive in the order chat, keep it linked, don't change the password.
baseTitleForSet({set, anchorRow}) -> string
    // stripBulkSuffix(anchorRow.title) if anchorRow has a title, else set.name, else
    // "Twitch Drops bundle".
```

## utils/bulkPacks/stock.js (A3)
```
freeDropsetAccounts(set) -> [{accountId, login}]
    // notListed(await shopRoutes.availableAccountsForSet(set), await listedLogins.loginsOnActiveListings())
    // leanest-first order kept; accountId as String.
dropsetFreeCounts(sets, {limit = 60} = {}) -> Map<setId, number>   // sequential, bounded
noclaimCounts(set) -> {free, share:{eldorado, g2g}}
    // free = (await noclaimStock.stockForSet(set)).free
    // share[m] = await noclaimStock.stockForListing({noclaimStock:true, marketplace:m, set:set._id})
    // (the share a NEW offer would get). Errors propagate.
reserve({set, n, market}) -> [{accountId, login}]
    // eldoradoFulfiller.claimAccountsForSet(set, n, {claimTag: market}); passwords stripped.
isStillOurs({accountId, set, market}) -> boolean
    // true iff >= 1 DropLog row exists for this account on the set's itemKeys and EVERY such
    // row has soldAt != null && soldToUsername === market && soldSetId === String(set._id).
    // Match rows exactly the way dropReservation.reserveSetOnAccount selects them (read it).
releaseUnits({set, market, accountIds}) -> {released:[id], skipped:[{accountId, reason}]}
    // per id: isStillOurs ? releaseSetForAccounts([id], String(set._id), market) : skip "not ours"
unitHealth(accountIds) -> Map<accountId, {ok, reason}>
    // BotAccount projection. "account missing" | "no password" | suspended/banned per the
    // SAME test utils/suspendedAccounts.js applies (reuse it; if not exported, replicate it
    // exactly and cite file:line). ok otherwise.
```

## utils/bulkPacks/farmCapacity.js (A3)
```
read({force = false} = {}) -> {bestStackRoom, totalFree, pristine, at, error}
    // slots from utils/rentFarmCapacity.js snapshot() (running/empty stacks, offline excluded):
    // bestStackRoom = largest single-stack free; totalFree = its total. pristine =
    // operatorFarm.previewFreshAccounts({count:1}).eligibleTotal (READ-ONLY — never call
    // farmFreshAccounts). Module cache 10 min; force bypasses. Never throws: a failed read
    // returns zeros + error text.
advertisable(cap, bp) -> integer
    // cap.error ? 0 : max(0, floor(min(bp.farmMaxQty, cap.bestStackRoom,
    //   cap.totalFree - bp.farmReserveSlots, cap.pristine - bp.farmReservePristine)))
demand({days = 60} = {}) -> [{game, days, orders, accounts, markets:{[market]:n}}]
    // FarmServiceOrder since now-days, state !== "cancelled", grouped by (game, days),
    // orders desc. Bounded, projected. accounts = sum of accounts.length (or quantity).
```

## utils/bulkPacks/markets.js (A4) — the ONLY module that calls `mp.*` or publishes
```
PACK_SEPARATOR = "\n\n=====\n\n"
GAMEFLIP_CODE_MAX    // verify what Gameflip accepts; if unknown use 10000 and refuse above it
gameOfSet(set) -> string            // reuse the auto-lister's own set->game helper
coverForSet(set) -> path            // utils/setImage.buildSetGridImage(set)
coverForFarm(game) -> path          // mirror scripts/eldorado-farm-listings.js (buildPromoCoverImage)
publishAccounts({market, set, game, title, description, unitPrice, packPrice, minQty, units, coverPath})
    -> {externalId, url, price}
    // units: [{accountId, login}]
    // eldorado: mp.eldoradoPublish({game, title, description, priceUsd:unitPrice,
    //   quantity:units.length, minQuantity:minQty, coverImagePath:coverPath, ...same extras as
    //   autoLister.publishEldoradoShare})
    // g2g: brand = g2gGames.brandForGame(game) (throw if none); mp.g2gPublish({serviceId:
    //   mp.G2G_ITEMS_SERVICE, brandId, title, description, priceUsd:max(mp.G2G_MIN_PRICE,
    //   unitPrice), qty:units.length, minQty}) — mirror autoLister.publishG2gShare
    // gameflip: passwords read from BotAccount (decrypt); code = units.map((u,i) =>
    //   "ACCOUNT " + (i+1) + " of " + n + "\n" + gameflipDeliveryCode(login, password))
    //   .join(PACK_SEPARATOR); refuse on any unreadable password or code > GAMEFLIP_CODE_MAX;
    //   mp.gameflipPublish({title, description, priceUsd:packPrice, imagePath:coverPath,
    //   autoDeliverCode:code})
publishNoclaim({market, set, game, title, description, unitPrice, quantity, minQty, coverPath})
    -> {rowId, externalId, url, price}
    // noclaimListings.publishNoclaim(market, ctx) with ctx built EXACTLY as the existing
    // Shop-listings publish route builds it (find it; mirror cat/pubGame/gridImage and
    // body.eldorado.{quantity, minQuantity, game} / body.g2g.{qty, minQty}).
    // {success:false} -> throw Error(message).
publishFarm({market, game, days, title, description, unitPrice, quantity, minQty})
    -> {externalId, url, price}
    // eldorado: mirror scripts/eldorado-farm-listings.js publish, plus quantity/minQuantity.
    // g2g: mirror scripts/g2g-farm-listings.js (brand + shape: relationId, offerAttributes,
    //   collectionTree), plus qty/minQty. If the shape resolver lives only in the script,
    //   re-implement it here faithfully and cite the script lines.
pause(market, externalId)    // eldorado: mp.eldoradoDelist (a pause); g2g: its delist; gameflip: throws
resume(market, externalId)   // eldorado: mp.eldoradoRelist; g2g: its relist; gameflip: throws
setQuantity(market, externalId, n)   // eldorado: mp.eldoradoSetQuantity; g2g: mp.g2gSetQuantity; gameflip: throws
withdraw(market, externalId) // gameflip: mp.gameflipDelist; eldorado/g2g: pause
readOffer(market, externalId) -> {state, quantity}
    // state: "active" | "paused" | "expired" | "gone" | "unknown"
    // eldorado: mp.eldoradoOffer; map the real offerState strings used elsewhere in the code.
    // A failed/empty read is "unknown", NEVER "gone"/"expired". g2g: a read fn if one exists,
    // else "unknown". gameflip: always "unknown" (the Gameflip sync owns row status).
```

## utils/bulkPacks/send.js (A5)
Every function returns `{success, status, message?, offer?}`; `status` is the HTTP code
the router should use (200, 400, 404, 409, 500, 502). Never throws to the caller.
```
sendOffer({source, setId, game, days, market, minQty, units, actor})
refillOffer({offerId, add, actor})      // dropset eldorado/g2g only
pauseOffer({offerId, actor})            // manual pause: autoPaused=false
resumeOffer({offerId, actor})           // needs bp.enabled + gate + stock/capacity >= minQty
withdrawOffer({offerId, actor})
withdrawAll({actor}) -> {success, status, results:[...]}
```
**sendOffer steps**
1. `bp.enabled` else 409 "Bulk packs are switched off". Validate source/market
   (`SOURCE_MARKETS`, `isMarketAllowed`), `tierFor(bp, minQty)` else 400;
   `currentGate(market, source)` closed → 409 with its reason.
2. Product. dropset/noclaim: `DropSet.findById(setId).lean()` (404); `custom` → 409;
   `stockSource === "noclaim"` must equal `source === "noclaim"` (409);
   `game = markets.gameOfSet(set)`; dropset + `settings.isNoClaimGame(game)` → 409.
   farm: `days ∈ bp.farmDurations` (400), game non-empty (400).
3. Price. dropset/noclaim: anchor = `pricing.pickAnchor({rows, set, market})` with rows =
   `MarketplaceListing.find({set:set._id, marketplace:market, status:"active", bulkOfferId:null},
   {price:1, set:1, marketplace:1, status:1, bulkOfferId:1, title:1}).lean()`; anchor 0 →
   409 "no price reference". unitPrice / packPrice via pricing. farm: `farmUnitPrice` (0 → 409).
4. Copy via copy.js (farm: build title, then CONTRACT I5 round-trip; mismatch → 409).
5. `BulkOffer.create({... state:"sending", open:true, slotKey})`; E11000 → 409 "already live".
6. Branch (any failure below closes the offer: state "error", open false, lastError,
   history; plus Telegram for 5xx):
   - **dropset eldorado/g2g**: `free = (await stock.freeDropsetAccounts(set)).length`;
     `surplus = free - bp.reserveSingles`; `n = min(units || bp.unitsPerOffer, surplus)`;
     `n < minQty` → 409 "only F free (keeping R for single listings)". `got = stock.reserve`;
     `got.length < minQty` → releaseUnits(got) → 409. Record `reserved[]` (on_offer).
     `publishAccounts` → throw → releaseUnits → 502. Create the row (shape below) → throw →
     `markets.pause` best effort + releaseUnits + Telegram "orphan offer paused" → 500.
   - **dropset gameflip**: n = minQty exactly (surplus >= minQty else 409); reserve; short →
     release → 409; publish with packPrice; row create failure → `markets.withdraw` +
     release + Telegram → 500.
   - **noclaim**: `c = stock.noclaimCounts(set)`; `c.share[market] < minQty` → 409;
     `quantity = min(units || bp.unitsPerOffer, c.share[market])`; `publishNoclaim` → throw →
     502; then `MarketplaceListing.updateOne({_id: rowId}, {$set:{bulkOfferId: offer._id}})`.
   - **farm**: `cap = farmCapacity.read({force:true})`; `q = min(advertisable(cap,bp), units || Infinity)`;
     `q < minQty` → 409 naming room/free/pristine; `publishFarm` → throw → 502.
7. Offer → state "live", listing/externalId/url/advertisedQty/prices, history "sent";
   logEvent; Telegram "Bulk offer live: <title> — <market>, <unit or pack price>".
   `proposals.invalidate()` (require lazily).

**Row shapes (dropset)** — common: `{set, marketplace, externalId, url, title, description,
price, status:"active", origin:"manual", bulkOfferId, note:"bulk pack: min N (d% off), M reserved"}`.
eldorado/g2g add `{autoDeliver:false, qtyTarget:M, units:[{contentId:"", accountId, login,
addedAt, deliveredAt:null, orderId:"", messagedAt:null}]}` (mirror the row fields of
autoLister.publishEldoradoShare / publishG2gShare). gameflip adds `{autoDeliver:true,
qtyRemaining:0, accountLogin: logins.join(", "), units:[...]}` (mirror unclaimedLots' row,
minus lot fields).

**withdrawOffer**: eldorado/g2g dropset → `markets.withdraw`, conditional row
`active → delisted`, phase-1 retire all free units (loop helper semantics, CONTRACT I10),
state "withdrawn", open false (the loop keeps processing `retiring` units after close).
gameflip → CONTRACT I9. noclaim → the SAME delist path the Listings page uses for a
no-claim row (find it: noclaimListings.beforeDelist/afterDelist + mp delist), state
"withdrawn". farm → `markets.withdraw`, state "withdrawn".
**refillOffer**: enabled + gate; open dropset eldorado/g2g; surplus check; reserve; per unit
atomic `$push` to row.units + reserved[] on_offer; re-read → `setQuantity(freeCount)`.

## utils/bulkPacks/loop.js (A6)
```
start() / stop() / status() -> {running, lastRunAt, lastSummary, lastError, passes}
runOnce({now = new Date()} = {}) -> summary {open, accounts, farming, sold, paused, retiring, released, errors}
retireUnits(offer, row, accountIds, reason) -> void   // exported: phase 1 of CONTRACT I10
reconcileUnits(offer, row, now) -> {delivered, released, readded, repulled}   // exported
```
- `start`: idempotent; first pass 120 s after start; next pass every `bp.loopMinutes`
  (re-read each pass); `setTimeout(...).unref()`; `state.running` guard; one heartbeat
  line per pass, including idle passes:
  `bulkPacks: pass — open N (acct A, farm F) | sold +S | paused P | retiring R | released X | errors E`
- `runOnce` loads `BulkOffer.find({$or:[{open:true}, {"reserved.state":"retiring"}]}).limit(500)`
  and handles each offer in its own try/catch (lastError, errors++):
  - **reconcileUnits** (dropset rows): for each reserved entry —
    on_offer: row unit present & not FREE → delivered (orderId); absent & row active & offer
    open → re-`$push` the unit (clobber heal, history); absent otherwise → retiring.
    retiring: present & FREE → `$pull` again (stay retiring, changedAt now); present & not
    FREE → delivered; absent & now-changedAt ≥ 2 min → `stock.releaseUnits` → released
    (skipped → released with reason "not ours").
    Row missing entirely → units cannot sell: release directly after isStillOurs.
  - **dropset eldorado/g2g** (after reconcile): row not active → retire free units, state
    "expired" (row.status "removed") or "withdrawn". Health: `stock.unitHealth` on free
    on_offer units → retire the bad ones (+ Telegram). Sales: delivered = units with
    deliveredAt or messagedAt; ordersCount = distinct orderId; revenue = unitsDelivered ×
    unitPrice; increases → Telegram "Bulk sale …" + logEvent. `free < minQty` while
    live/paused → `markets.pause` → retire free units → "sold_out" (+ Telegram). Else
    `advertisedQty !== free` → `markets.setQuantity(free)`. Every 30 min
    `markets.readOffer`: "expired" → conditional row `active → removed` → retire → "expired".
  - **dropset gameflip**: row "sold" → on_offer → delivered (orderId "gf:"+externalId),
    counters (1 order, n units, packPrice) → "sold" + Telegram. Row removed/delisted →
    retire all → "expired"/"withdrawn". Active → unitHealth; any bad → `markets.withdraw`;
    success → conditional `active → delisted` → retire all → "withdrawn" + Telegram;
    failure → leave it (it may have sold).
  - **noclaim**: row not active → "withdrawn"/"expired" (open false). Counters from the
    row's delivery records (units with deliveredAt or orderId). `lowStock = share < minQty`
    via `noclaimStock.stockForListing(row)` (display only; never act).
  - **farm** (every `bp.farmSyncMinutes`): `q = advertisable(await farmCapacity.read(), bp)`.
    `q < minQty` & live → `markets.pause`, autoPaused true, "paused" + Telegram.
    `q >= minQty` & paused & autoPaused & bp.enabled → `markets.resume`, "live" + Telegram.
    live & q !== advertisedQty → `markets.setQuantity(q)`. Sales from FarmServiceOrder
    matched by the offer id the farm services record (find the field; fall back to
    `offerTitle === offer.title` + market) → counters + Telegram on increase. Expiry via
    readOffer every 30 min.
  - `bp.enabled === false`: never resume; everything else still runs (CONTRACT I8).
- Alerts fire on STATE CHANGES only (never every pass).

## utils/bulkPacks/proposals.js (A7)
```
accountProposals({refresh = false, limit = 40} = {}) -> {at, items}
farmProposals({refresh = false} = {}) -> {at, capacity, advertisable, items}
invalidate() -> void
```
- Cache 5 min per function (`refresh` bypasses).
- accountProposals: sets = `DropSet.find({custom:{$ne:true}, "items.0":{$exists:true}}, projection).lean().limit(600)`.
  dropset sets (stockSource !== "noclaim" and not `isNoClaimGame(game)`): one cheap upper
  bound via `shopRoutes.stockForSets(sets)`, then precise `stock.dropsetFreeCounts` for the top
  `limit`. noclaim sets: `stock.noclaimCounts` (at most `limit`).
  Item: `{source, set:{id, name, game, items:[{name, image, qty}], image}, free, reserve, surplus,
  markets:[{market, gate, anchor, basis, tiers:[{minQty, discountPct, unitPrice, packPrice,
  fits, liveOfferId}]}]}` — markets = `SOURCE_MARKETS[source] ∩ bp.markets`; dropset
  surplus = free − bp.reserveSingles, noclaim surplus = free; a tier `fits` when (dropset)
  surplus ≥ minQty or (noclaim) share[market] ≥ minQty; `liveOfferId` = id of the OPEN
  BulkOffer with that slotKey. Keep items with at least one fitting tier OR a live offer.
  Sort by surplus desc.
- farmProposals: `farmCapacity.demand({days:60})` filtered to `bp.farmDurations`, top 30;
  per item markets (farm markets ∩ bp.markets) with gate, farm-table anchor and tier
  unitPrices + liveOfferId; plus the capacity read and `advertisable`.
