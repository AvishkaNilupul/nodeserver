# Unclaimed farms v3 — bundles, bulk, webbot sellability, analytics link

Status: FROZEN contract for the build (2026-09-06). Every agent codes against
this file, never against a sibling's output. Read `docs/unclaimed-autolist-
CONTRACT.md` first for the v2 rules that still hold (no claim ever, one
account one buyer, live inventory is truth, origin `"unclaimed"`, ZeusX never).

## Why (measured on prod 2026-09-06)

1. **Pricing is flat $0.75.** Every unclaimed row except CoD ($2) sits at the
   Gameflip floor because `derivePrice` undercuts `markets.gameflip.lowest`,
   and the lowest live Gameflip listing for OW/R6/MR **is our own $0.75 row**
   (self-undercut). Meanwhile Gameflip avgSoldPrice is $2.35 (OW), $3.00 (R6),
   $4.46 (MR). A 9-item OW bundle and a 1-item Alpha Pack cost the same.
2. **Bulk is how it sells.** Digiseller orders of 3 and 7 units in one buy;
   the owner hand-sells OW/R6 in bulk daily (dozens of `manual sale` signals).
   Gameflip has no quantity, so there is no bulk path there at all.
3. **Events come in waves** and the accounts hold *event* bundles, not random
   drop sets: OW `CAH Championship Week 1` → `CAH Championship Finals`,
   `OWWC 2026 Groups Day 1 &2 / Day 3 / Day 4`, `OWCS MSC Day 1..5`; R6
   `EWC 2026 DAY 1..10`, `R6S S1 2026 9..13`, `R6S S2 2026` → `R6S S2 2026 1`;
   CoD `Modern Warfare 4 Beta W1/W2`, `CDL Championship - Day 1..4`, `Monster
   Last Chance PT. 1`. Titles today say "(3 Items) — Pachimonarch Icon + …",
   never "CAH Championship complete bundle (Week 1 + Finals)".
4. **Duplicate copies are lost.** R6 `Community Checkpoint` grants 4× Alpha
   Pack; the signature dedupes by name so the account lists as "(1 Item) —
   Alpha Pack". OW accounts hold "Battle Pass Tier Skip" from Week 1 AND
   Finals; listed as one.
5. **Expiry flaps.** `expirySalePass` treats ONE empty inventory read as
   "everything expired" → delists + pulls a webbot account off its bot
   (`botId:""`); the next scan re-lists it 10 min later (Marvel Rivals
   18:29→18:39→18:40→18:50 on 2026-09-05). Each flap re-publishes rows.
6. **Web-token farm has no sell-side tooling.** 500 WebBotAccounts (295 idle,
   all with passwords); the page has only the manual sold/listed ticks. No
   "what is ready to sell", no spent (sold/connected) scan, no bulk export.
7. **Analytics are blind to unclaimed stock.** `MarketResearch.farmedAccounts`
   counts DropLog only (no-claim/webbot accounts are not in DropLog), so the
   research page shows OW with 181 own sales but no idea 61 accounts sit
   listed. Unclaimed sales DO already feed `SaleSignal` via
   `recordListingSale` (keep that).

## Owner decisions applied

- Ship dark where money moves: **Gameflip lots** (`unclaimedGameflipLots`,
  default OFF) and **repricing existing rows** (`unclaimedRepriceExisting`,
  default OFF, plus a "Reprice now" button with dry-run). New listings get
  analytics pricing + bundle titles immediately (that is the improvement).
- Expiry needs confirmation (bug fix, ON).
- Webbot expiry does NOT scatter the bot: the account stays on its bot; only
  the ledger changes (v2 said "idle, off the bot" — reversed after the flap
  evidence; the account keeps farming the bot's game for the next wave).
- Manual listings are never repriced (origin `"manual"`/`"auto"` untouched).

## Files and ownership (one agent per file, Edit-only on existing files)

| File | Owner | Work |
|---|---|---|
| `utils/unclaimedBundles.js` (NEW) | agent B | wave parser, event catalog, holdings classifier, bundle title/description bits, analytics pricer. Pure + DB loaders. |
| `tests/unclaimedBundles.test.js` (NEW) | agent B | node:test, no Mongo/network. |
| `utils/unclaimedAutoList.js` | agent E | hunks: qty-aware signature/items/title, bundle-aware set + price at publish, expiry strikes, webbot release keeps bot, lot hooks, `repriceUnclaimedRows`, exports. |
| `tests/unclaimedAutoList.test.js` | agent E | extend for qty signature, `shouldExpire`, title with qty. |
| `utils/unclaimedLots.js` (NEW) + `tests/unclaimedLots.test.js` | agent L | Gameflip lot publishing + lifecycle (flagged). |
| `routes/webbotFarmRoutes.js` + `utils/webbotTwitch.js` | agent W | sellable scan, spent scan/remove, creds export, bulk manual-sold; add `isAccountConnected` to the Inventory query. |
| `public/webbot-farm.html` | agent WU | "Sellable stock" + "Spent accounts" panels. |
| `routes/unclaimedAutoRoutes.js` | agent R | `/bundles`, `/reprice`, `/lots` endpoints. |
| `public/unclaimed-farms.html` | agent RU | "Bundles" panel + reprice + lots controls. |
| `utils/marketResearch.js`, `public/research.html`, `utils/priceScout.js`, `utils/marketplaces.js` (gameflipOwnerId only) | agent M | unclaimed stock/sold into research; own-seller exclusion (`lowestOther`). |
| `utils/settings.js`, `models/UnclaimedAccount.js`, `models/MarketplaceListing.js`, `models/MarketResearch.js` | main session (DONE — do not edit) | new keys/fields below. |

Do NOT touch `utils/autoLister.js` (`derivePrice` behaviour for the auto-farm
is unchanged), `utils/radarEvents.js` (11 tests; the bundle parser is a
superset living in `unclaimedBundles.js`), `models/DropSet.js` (existing
fields suffice), or `server.js`.

## Settings (utils/settings.js `getAutoFarm()` defaults — already added)

```
unclaimedPriceFloorUsd: 0.75        // absolute floor for any unclaimed row
unclaimedGameFloors: {}             // { "overwatch": 1.5 } — substring key like noClaimGames (normGameName)
unclaimedItemStepPct: 15            // +15% per extra item (qty counts), capped by unclaimedItemCapMult
unclaimedItemCapMult: 2.5           // per-item scaling never exceeds 2.5× the anchor
unclaimedFullEventBonusPct: 25      // complete-event bundle bonus
unclaimedRepriceExisting: false     // periodic reprice of live rows (drift ≥ unclaimedRepriceDriftPct)
unclaimedRepriceDriftPct: 20
unclaimedGameflipLots: false        // publish N-account lot listings on Gameflip
unclaimedLotSize: 5
unclaimedLotDiscountPct: 10
unclaimedExpiryConfirmPasses: 2     // consecutive empty reads before expiry (min 20 min apart)
```

Accessor: `settings.getUnclaimedPricing()` returns
`{ floorUsd, gameFloors, itemStepPct, itemCapMult, fullEventBonusPct, repriceExisting, repriceDriftPct, lots, lotSize, lotDiscountPct, expiryConfirmPasses }`
with the defaults above merged over the live values. `settings.gameFloorFor(game)`
returns the matching `unclaimedGameFloors` value (substring match on
`normGameName(game)`, like `isNoClaimGame`) or 0.

## Model fields (already added)

`UnclaimedAccount`: `emptyReads:Number(0)`, `firstEmptyAt:Date|null`,
`bundleKey:String("")`, `bundleLabel:String("")`, `lotId:String("")`.
`MarketplaceListing`: `lotSize:Number(0)` (0 = not a lot), `lotId:String("")`.
`MarketResearch`: `unclaimedStock:Number(0)`, `unclaimedSold:Number(0)`,
`noClaim:Boolean(false)`; inside `markets.gameflip` a new `lowestOther`
(Mixed, no schema change needed).

## `utils/unclaimedBundles.js` — frozen API (agent B)

```js
// Superset of radarEvents.splitEventWave. Returns { eventName, waveLabel, order }.
// order: numeric wave order (Week 1 → 1, Day 3 → 3, W2 → 2, PT. 1 → 1,
// "Day 1 &2" → 1 with waveLabel "Day 1-2", bare trailing number after a
// season/year token ("R6S S1 2026 9" → event "R6S S1 2026", "Wave 9", 9),
// "Finals" / "Final" / "Playoffs" / "Grand Finals" → waveLabel as written,
// order 1000 (always last). No marker → { eventName: name, waveLabel: "", order: 0 }.
parseWave(name)

// campaigns: TwitchCampaign-like [{campaignId,name,game,startAt,endAt,status,active}]
// manifests: CampaignDrops-like [{campaignId,name,game,drops:[{itemKey,name,benefitId}]}]
// → Map<eventKey, { key, game, gameKey, name, waves:[{ campaignId, name, waveLabel,
//     order, startAt, endAt, items:[{itemKey,name,qty}] }], startAt, endAt }>
// eventKey = normGame + "|" + eventName.toLowerCase(). Waves sorted by order then startAt.
// A campaign with no manifest still appears as a wave with items:[] (unknown).
// An event's items qty = count of identical itemKeys in the manifest (4× Alpha Pack).
buildEventCatalog(campaigns, manifests)

// drops: sellable drops [{name,game,campaign,itemKey}] (may contain duplicates —
// duplicates ARE copies). Returns:
// { game, event: {key,name}|null, waves:[{ waveLabel, order, complete:boolean,
//   held:[itemKey], missing:[itemKey] }], wavesHeld:n, wavesTotal:n (waves that
//   have STARTED: startAt <= now or endAt in the past), full:boolean
//   (every started wave complete), items:[{itemKey,name,qty}] (qty-aware,
//   sorted by name), bundleKey, bundleLabel }
// bundleKey = eventKey + "|" + waves held labels joined "+" ; "" when no event.
// bundleLabel e.g. "CAH Championship — Week 1 + Finals (complete)",
//   "CAH Championship — Week 1 (partial)", "" when no event resolves.
// Drops are matched to a wave by their `campaign` name (parseWave → same
// eventKey + waveLabel); if the campaign name does not match any catalog wave,
// fall back to matching the drop's itemKey against wave manifests.
classifyHoldings(game, drops, catalog, now = Date.now())

// Title: qty-aware, event-aware, ≤ 120 chars.
//   full:    "Overwatch Twitch Drops — CAH Championship COMPLETE BUNDLE (Week 1 + Finals · 7 Items)"
//   partial: "Overwatch Twitch Drops — CAH Championship Week 1 (4 Items) — Pachimonarch Icon + 2× Battle Pass Tier Skip +1 more"
//   no event: autoLister.buildTitle style but qty-aware: "(5 Items) — 4× Alpha Pack + SMELLS LIKE BURNING"
//   Item count in "(N Items)" = sum of qty.
bundleTitle({ game, items, classification })

// Extra description lines (array of strings) inserted before the house
// "Includes:" list by the engine: event line ("Event: CAH Championship — Week 1 + Finals, complete bundle"),
// copies line when any qty>1, and the bulk line:
//   "Bulk: buy several units in one order — quantity is available on this page." (digiseller/ggsel)
//   "Bulk: lots of N accounts are listed separately at a discount." (gameflip when lots on)
bundleDescriptionLines({ game, items, classification, marketplace, lotsEnabled, lotSize })

// Analytics pricing. research = MarketResearch doc (may be null).
// anchor = gameflip.avgSoldPrice if soldRecent >= 3 (cap 10)
//        else gameflip.lowestOther if > 0
//        else gameflip.median if > 0
//        else min(ggsel.median, plati.median) if > 0
//        else 1.00
// perItem = anchor * min(itemCapMult, 1 + itemStepPct/100 * (totalQty - 1))
// full event bundle → * (1 + fullEventBonusPct/100)
// floor = max(floorUsd, gameFloorFor(game)); round to $0.25; never below floor.
// Returns { price, anchor, anchorSource, floor, totalQty, full }.
bundlePrice({ research, game, items, classification, pricing })

// Lot price for N units: round25(unitPrice * N * (1 - lotDiscountPct/100)), floor N*floor.
lotPrice(unitPrice, n, pricing)

// DB loaders (mongoose): catalog for one game or all no-claim + webbot games.
async loadCatalog({ games }) → catalog Map (TwitchCampaign + CampaignDrops, last 120 days)
```

Export everything above plus `eventKeyFor(game, eventName)`.

## Engine hunks (`utils/unclaimedAutoList.js`, agent E)

1. **Qty-aware identity.** `signatureFor(game, drops)` keys become
   `itemKey×qty` when qty>1 (`"alpha pack|rainbow six siege×4"`); qty = number
   of drops sharing the itemKey. `dedupeSetItems` emits `qty`. `uniqueDrops`
   returns one entry per key with `qty`. `findUnclaimedSet` must match items
   AND qty (compare full sorted `[itemKey,qty]` signature in JS after the
   `$all` prefilter). Existing qty-1 sets keep matching.
2. **Bundle-aware listing.** In `scanAndListPass`, after `pickListingGroup`:
   `const cls = unclaimedBundles.classifyHoldings(game, drops, catalog)` where
   `catalog` is loaded ONCE per pass via `loadCatalog({games: distinct games of
   the batch})`. `ensureUnclaimedSet` stores `sourceType:"unclaimed-bundle"`,
   `sourceEventKey: cls.event?.key || ""`, `sourceEventName: cls.event?.name || ""`,
   `sourceCampaignIds` (wave campaignIds held), `name = bundleTitle(...)`.
   `listingTitle(game, drops, cls)` → `bundleTitle`. `listingDescription(game,
   drops, marketplace, cls)` → `buildDescription` output with
   `bundleDescriptionLines` joined with "\n" prepended after the first line
   (keep the house template otherwise). Ledger rows get `bundleKey`/`bundleLabel`.
3. **Analytics price at publish.** Replace `derivePrice(research)` with
   `unclaimedBundles.bundlePrice({research, game, items, classification, pricing:
   settings.getUnclaimedPricing()}).price`. Set `DropSet.price` and
   `minPriceUsd = floor`.
4. **Expiry strikes.** New pure helper exported `shouldExpire(ledger, now,
   {confirmPasses, campaignEnded})`: an empty read increments `emptyReads`
   and sets `firstEmptyAt` (first time). Expire only when `emptyReads >=
   confirmPasses` AND `now - firstEmptyAt >= 20 min`, OR `campaignEnded &&
   emptyReads >= 1`. A non-empty read resets both. `campaignEnded` = every
   campaign named in `ledger.drops[].campaign` has `endAt < now - 1h` per
   TwitchCampaign (load once per pass by name+game). Apply in the check pass.
5. **Webbot release keeps bot.** `releaseToPool` webbot branch: do NOT clear
   `botId`/`pinnedGame`/`lastStatus`; only `$set:{listed:false}`. Ledger →
   `released` as before.
6. **Gameflip sale check for lots.** Match the sold row by
   `$or:[{accountLogin: ledger.login},{"units.login": ledger.login}]`.
7. **Lot hooks.** After a set's Gameflip chain is handled in the scan pass, if
   `pricing.lots` and the set has ≥ `lotSize` WAITING gameflip ledgers (listed,
   market gameflip, not live, `lotId:""`), call
   `unclaimedLots.publishLotIfReady(set, {pricing})`. In the check pass call
   `unclaimedLots.checkLots({pricing})` once. Both wrapped in try/catch.
8. **`repriceUnclaimedRows({apply=false})`** exported: for every active
   unclaimed row compute the analytics price (its set's items + classification
   rebuilt from the set's `sourceEventKey` via catalog) → plan
   `[{rowId, marketplace, externalId, title, current, target, driftPct}]`; with
   `apply`, patch rows whose |drift| ≥ `repriceDriftPct`: gameflip via
   `mp.gameflipReprice(id,{priceUsd})`, digiseller via
   `mp.digisellerRepriceProducts([{productId, priceUsd}])`, ggsel via
   `mp.ggselUpdateOffer(id,{priceRub})` (RUB via `mp.usdToRub` if it exists,
   else skip ggsel with note). Update `row.price`, `DropSet.price`, log
   `unclaimed/repriced`. `runOnce` runs it with `apply:true` only when
   `pricing.repriceExisting`.
9. Exports add: `shouldExpire`, `repriceUnclaimedRows`, `listingTitle` (new
   signature), `catalogForGames` (thin wrapper), `waitingGameflipLedgers(setId)`.

## Lots (`utils/unclaimedLots.js`, agent L) — flagged OFF

- A lot = ONE Gameflip listing delivering N accounts. Row: `origin:"unclaimed"`,
  `lotSize:N`, `lotId` (new ObjectId string), `units:[{login,accountId}]`,
  `accountLogin: logins.join(", ")`, `qtyRemaining:0`, `autoDeliver:true`,
  title = set title + ` — LOT OF ${N} ACCOUNTS`, description = house description +
  "\n\nThis lot delivers N separate accounts, each holding the full item set."
  Delivery code = N blocks of `gameflipDeliveryCode(login,password)` joined with
  "\n\n=====\n\n". Price = `lotPrice(set.price, N, pricing)`.
- Members: N waiting gameflip ledgers (oldest listedAt first) → `$set:{lotId}`.
  They stay `market:"gameflip"`, `status:"listed"`.
- `publishLotIfReady(set, {pricing})` → publishes at most ONE lot per set per
  call; never uses the live single unit; never a ledger already in a lot.
- `checkLots({pricing})`: (a) a lot row `status:"sold"` (gameflip fulfiller)
  → `spendAccount(member, "gameflip lot sale", {removeFromProduct:false})` for
  every member; (b) any member no longer `listed` (manual-sold removed /
  expired / sold elsewhere) → delist the lot row, clear `lotId` on the
  remaining members (they return to waiting), log `unclaimed/lot_broken`.
- `lotsSummary()` → `[{setId, title, lotSize, price, externalId, status}]`.
- Exports: `publishLotIfReady, checkLots, lotsSummary, buildLotCode (pure), pickLotMembers (pure)`.

## Webbot routes (agent W) — `routes/webbotFarmRoutes.js`, `utils/webbotTwitch.js`

- `webbotTwitch.fetchInventory` adds `self { isAccountConnected }` at the
  campaign level to the GQL query and returns `connected:boolean` per drop
  (campaign-level flag copied onto each drop) — same meaning as
  `twitchInventory` `inProgress[].connected`.
- `GET /api/webbot-farm/sellable?botId=<id|idle|all>&limit=60&cursor=<id>` →
  live scan (concurrency 8) of enabled non-dead accounts: per account
  `{ id, login, botId, pinnedGame, ready:[{name,game,campaign,itemKey}],
  readyCount, bundleLabel, full, connected, ledgerStatus (listed/sold/…/""),
  market, manualSold, tokenStatus }`. `bundleLabel/full` via
  `unclaimedBundles.classifyHoldings` with a catalog loaded once per call.
  Response `{ success, accounts, nextCursor, scanned }`. Sets
  `WebBotAccount.dropsReadyUnclaimed` + `lastCheckedAt` as a side effect.
- `GET /api/webbot-farm/spent/scan?botId=` → `{ spent:[{id,login,sold,soldWhy,
  connected,tokenStatus}] }`: sold = ledger `status:sold` OR `manualSold` OR
  an active/sold unclaimed row containing the login; connected from inventory.
- `POST /api/webbot-farm/spent/remove {accounts:[ids]}` → `$set:{enabled:false,
  botId:"", pinnedGame:"", lastStatusMessage:"spent: <why>"}` + SystemEvent
  `webbot/spent_removed`. Does NOT rewrite the Pi container config (the
  farmer reads Mongo-free bot configs; note in response that the bot keeps
  the account until re-created — `needsRecreate:true`).
- `POST /api/webbot-farm/manual-sold-bulk {accounts:[ids], value:true|false}`
  → reuses the single manual-sold handler's logic per id (delegates to the
  engine's `removeManualSoldOwner` exactly like the existing route).
- `POST /api/webbot-farm/export-creds {accounts:[ids]}` → `text/plain`
  `login:password` lines (decrypt via the existing helper), audited as
  SystemEvent `webbot/creds_exported` with count.
- All `requireSuperadmin`.

## Webbot page (agent WU) — `public/webbot-farm.html`

Two new panels between Bots and the accounts table, mirroring
`public/noclaim-farm.html`'s "Spent accounts" chrome:
- **Sellable stock**: bot selector (bots + Idle + All), "Scan" button, table
  Login | Bot | Game | Ready drops | Bundle | Connected | Ledger | checkbox.
  Bulk actions on checked rows: "Export creds", "Mark manual sold",
  "Unmark". Footer stats: scanned / ready / listed / full bundles.
- **Spent accounts**: bot selector, "Scan spent", table with Sold/Connected
  reasons, "Remove selected" (calls `/spent/remove`, shows `needsRecreate`
  hint).
Wire into the existing refresh cycle; keep `?embed=1` behaviour.

## Auto-list routes (agent R) — `routes/unclaimedAutoRoutes.js`

- `GET /api/unclaimed-auto/bundles` → `{ games:[{ game, noClaim, research:{
  demandScore, avgSoldPrice, lowestOther, ownSales }, events:[{ name, key,
  waves:[{waveLabel, campaignId, startAt, endAt, itemCount, ended}] }],
  sets:[{ setId, title, bundleLabel, full, eventKey, items:[{name,qty}],
  price, suggested:{price, anchorSource, floor}, listed:{gameflip:{live,waiting},
  digiseller:n, ggsel:n}, lots:n, sold:n, driftPct }] }] }`. Built from
  `UnclaimedAccount` (listed/sold), `MarketplaceListing` (active, origin
  unclaimed), `DropSet`, catalog via `unclaimedBundles.loadCatalog`, research
  via `MarketResearch`. Projected finds + JS grouping, never `$group`.
- `POST /api/unclaimed-auto/reprice {apply:boolean}` → `engine.repriceUnclaimedRows`.
- `GET /api/unclaimed-auto/lots` → `unclaimedLots.lotsSummary()` + flag state.
- `POST /api/unclaimed-auto/pricing {…partial settings}` → validates and
  `setAutoFarm` the `unclaimed*` keys listed above (numbers/booleans/object);
  `GET /api/unclaimed-auto/pricing` returns `getUnclaimedPricing()`.

## Auto-list page (agent RU) — `public/unclaimed-farms.html`

Add a **Bundles** panel at the top of `#sec-autolist` (below the stats):
table Game | Event / bundle | Waves | Items | Listed (GF live/wait · DG · GG) |
Lots | Sold | Price → Suggested (drift %) with a row chip "full" / "partial".
Header buttons: "Reprice (dry-run)" → shows the plan in a modal/table with
"Apply"; "Pricing settings" → small form for the `unclaimed*` keys (floor,
per-game floors as `game=price` lines, step %, cap ×, full bonus %, reprice
existing toggle, lots toggle, lot size, lot discount). Keep existing panels.

## Market research (agent M)

- `utils/marketResearch.js` `ownStats()` adds per game (lowercase key):
  `unclaimedStock` = `UnclaimedAccount.countDocuments({status:"listed", game})`
  grouped in JS from a projected find, `unclaimedSold` = status sold count;
  `scanGame` writes both + `noClaim: settings.isNoClaimGame(game)`.
- `utils/priceScout.js` `gameflipSearch` rows already carry `seller`;
  `marketResearch.scanGame` computes `markets.gameflip.lowestOther` = lowest
  over relevant active rows whose `seller !== ownGameflipOwnerId`, where the
  own id is resolved ONCE per scan via a new `mp.gameflipOwnerId()` in
  `utils/marketplaces.js` (GET `/api/v1/account/me` with the existing key
  helper; cache 1h; return "" on failure). Agent M owns that small addition
  in marketplaces.js. When the own id is unknown, `lowestOther = lowest`.
  `derivePrice` (auto-farm) is NOT changed.
- `public/research.html` table adds columns "Unclaimed stock" and "Own price
  floor" (lowestOther) after "Sold 30d (GF)"; no-claim games get a "no-claim"
  chip next to the name.

## Tests (node:test, `npm test`)

- `tests/unclaimedBundles.test.js`: parseWave (all forms in "Why" #3 + the
  radarEvents cases must still parse identically), buildEventCatalog (2 events,
  wave order, qty 4 Alpha Pack), classifyHoldings (full, partial, no event,
  itemKey fallback, duplicates as copies), bundleTitle ≤120 & qty prefix,
  bundlePrice (anchor selection order, floors, step cap, full bonus, rounding),
  lotPrice.
- `tests/unclaimedAutoList.test.js`: qty signature, `shouldExpire` (strikes,
  20-min gap, campaignEnded shortcut, reset), title via bundleTitle.
- `tests/unclaimedLots.test.js`: `pickLotMembers` (oldest first, skips live +
  lotted), `buildLotCode` (N blocks, separator).

Full suite must stay green (`node --test tests/*.test.js`).

## Invariants

- Preserve the dirty worktree. Edit-only on existing files; never `Write` a
  file you do not own. Do not read siblings' new files — code to this contract.
- No `$group`/`allowDiskUse` (Atlas shared tier).
- Never publish a login in a title/description.
- Report back: exported names, new routes, new settings read, and any
  contract hole you had to resolve (say how).
