# No-claim Shop listings — CONTRACT (frozen 2026-09-11)

Owner's ask: on **Listings → Shop listings**, "Pick items" can come from the
**Drop archive** (today) OR the **No-claim farm**. A listing built from no-claim
items is published to marketplaces with **automatic delivery of no-claim farm
accounts**, without ever colliding with the no-claim **auto-lister**
(`utils/unclaimedAutoList.js`), which lists the same farm on its own.

Every agent codes against THIS file, never against a sibling's output. Do not
read sibling files that are listed as "NEW" (they may not exist yet). Keep the
repo's style: CommonJS, 2-space indent, double quotes, explanatory comments
where a reader would ask "why". **Never run prettier/eslint --fix on any file.**
Never change behaviour for rows/sets that are not no-claim-backed: every new
branch is guarded by the flags below so everything else is byte-identical.

## 0. Vocabulary / invariants

* **No-claim set** = `DropSet` with `stockSource: "noclaim"`. Its items are
  no-claim drops (`itemKey` = `name.trim().toLowerCase() + "|" + game.trim().toLowerCase()`,
  exactly `sellableDropsFromNoClaimInv`'s key), `qty` = copies promised.
  Always `listed:false`, `publicCatalog:false`, `custom:false`, `sourceType:""`.
  It is NEVER sold by the internal balance Shop and NEVER claims Drop Archive
  (DropLog) stock — the archive holds only CLAIMED drops, which are worthless
  to a no-claim buyer.
* **No-claim row** = `MarketplaceListing` with `noclaimStock: true`. It keeps
  `set` = the no-claim set (UI linkage + delete guard), `origin: "manual"`
  (owner's listing, never repriced), `accountId: ""` always,
  `requiredDrops` = the set's items `[{name, qty}]`, and the delivered/attached
  logins in `units[].login`. `unclaimedGame` and `autoClaimSet` are NEVER set.
* **Free no-claim account** for set S = an account that is
  1. in a no-claim bot config right now (holding snapshot `inConfig:true`),
  2. has a pool row (`AvailableAccount`, joined by `clientSecret`, recorded as
     `poolAccountId`) with `status:"claimed"`, a password
     (`unclaimedAutoList.poolPassword` rule: `password` else `credPasswordEnc`),
     `manualSold !== true`, `listed !== true` (the no-claim console's
     "Listed" tick: the owner hand-listed it somewhere, or an engine/manual
     listing holds it), `soldGames` not containing S's normalised game
     (`settings.normGameName`), `claimedNote` not matching `/^(sold|spent)/i`,
  3. whose `UnclaimedAccount` ledger (source "noclaim", by `loginLower`) is
     absent or has status in **FREE_STATUSES = ["skipped","released","expired"]**,
  4. whose login is on NO active `MarketplaceListing` (`accountLogin` token or
     `units[].login`, case-insensitive — `utils/listedLogins.loginsOnActiveListings`),
  5. whose snapshot holds every item of S with at least the promised qty.
  "Fresh" = snapshot `readAt` within `maxAgeHours`; stock that is advertised is
  fresh-only. Every CLAIM re-reads the live Twitch inventory first.
* **Ledger status `"manual"`** (NEW) = the account is committed to an owner's
  hand-made no-claim listing (a vault unit on sale, or mid-publish). The
  auto-lister treats it like `"listed"` for skipping, but none of its passes
  (reconcile / expiry / repair / cap) ever touch it. Sale → `"sold"`.
  Release → back to `manualPriorStatus` (or the ledger row is DELETED when the
  manual layer created it, `manualPriorStatus === ""`).
* Markets:
  * **VAULT** (accounts attached at publish): `gameflip` (1 account per live
    listing, relist chain), `ggsel`, `digiseller` (N units in the product).
  * **CLAIM-AT-SALE** (account claimed when a paid order arrives):
    `eldorado`, `playerauctions`, `g2g`.
  * Everything else (`funpay`, `zeusx`, `epicnpc`, `z2u`) is REFUSED for a
    no-claim set with message
    `"<Label> is not supported for no-claim listings yet — use Gameflip, GGSel, Plati, Eldorado, PlayerAuctions or G2G"`.
* Kill switches: `settings.getNoclaimShopSettings()` (top-level `noclaimShop`
  block, NOT inside autoFarm). `enabled:false` → routes answer 503-ish
  `{success:false, message:"No-claim listings are switched off"}` for writes,
  publishing refuses, the pass does nothing. `autoDeliver:false` → every
  non-dryRun claim returns `[]` (publish refuses with a message, claim-at-sale
  deliveries skip with `"no-claim listing auto-delivery is off"`).

## 1. Models (agent: MODELS)

### 1a. `models/DropSet.js` — add after `sourceType`:
```js
    // Where this listing's delivery stock comes from. "" = the Drop Archive
    // (DropLog, claimed drops) — every set before this field existed. "noclaim"
    // = the no-claim farm's unclaimed drops (utils/noclaimStock.js): such a set
    // is never sold by the internal Shop and never claims archive stock.
    stockSource: { type: String, enum: ["", "noclaim"], default: "", index: true },
```
### 1b. `models/MarketplaceListing.js` — add after `autoClaimSet`:
```js
    // No-claim Shop listings (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md): this
    // row's stock is the no-claim farm, claimed through utils/noclaimStock.js
    // (vault markets at publish, claim-at-sale markets when an order lands).
    // The row keeps `set` (a DropSet with stockSource "noclaim") so the Listings
    // page and the delete guard still see it, but every consumer checks THIS
    // flag before `set`, `unclaimedGame` or `autoClaimSet`.
    noclaimStock: { type: Boolean, default: false, index: true },
```
### 1c. `models/UnclaimedAccount.js`
* status enum → `["listed","sold","expired","released","skipped","removed","manual"]`
  and extend the lifecycle comment: `manual` = committed to an owner's
  hand-made no-claim listing (see contract).
* add fields (after `lotId`):
```js
    // Owner-made no-claim listings (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md).
    // The MarketplaceListing _id this account is committed to ("" while the
    // publish is in flight), the status it had before the manual claim ("" =
    // this ledger row was created by the manual claim and is deleted on
    // release), when it was claimed, and when its post-sale bookkeeping
    // (bot removal + pool stamps, unclaimedAutoList.spendAccount) ran.
    manualListing: { type: String, default: "", index: true },
    manualPriorStatus: { type: String, default: "" },
    manualAt: { type: Date, default: null },
    manualSpentAt: { type: Date, default: null },
```
### 1d. NEW `models/NoclaimHolding.js`
```js
// One row per no-claim farm account: what it holds RIGHT NOW that a buyer can
// claim (in-progress drops at 100%, not claimed), from the last live read.
// Refreshed by utils/noclaimHoldings.js. Never stores credentials.
{
  loginLower: { type: String, required: true, unique: true },
  login: { type: String, default: "" },
  twitchId: { type: String, default: "" },
  poolAccountId: { type: String, default: "", index: true },
  botId: { type: String, default: "" },
  container: { type: String, default: "" },
  game: { type: String, default: "" },          // bot's FavouriteGames[0]
  items: [{ _id: false, itemKey: String, name: String, game: String,
            campaign: String, image: String, qty: { type: Number, default: 1 } }],
  sellableCount: { type: Number, default: 0 },  // sum of qty
  readAt: { type: Date, default: null, index: true }, // last SUCCESSFUL live read
  readError: { type: String, default: "" },
  seenAt: { type: Date, default: null },        // last time found in a config
  inConfig: { type: Boolean, default: true, index: true },
}, { timestamps: true }
```
### 1e. `utils/settings.js` — top-level block + accessor (mirror
`ACCOUNT_LISTING_DEFAULTS` / `getAccountListingSettings` exactly, incl. the
deep-merge + clamping rationale):
```js
const NOCLAIM_SHOP_DEFAULTS = {
  enabled: true,       // routes, UI, publishing, the lifecycle pass
  autoDeliver: true,   // kill switch over every no-claim claim
  sweep: true,         // background holding sweep
  sweepPerTick: 30,    // live inventory reads per sweep tick (1..200)
  sweepEveryMin: 10,   // (2..240)
  maxAgeHours: 8,      // snapshot older than this is "stale" (1..72)
  refreshBudget: 120,  // reads for an on-demand refresh (1..400)
  topUp: true,         // refill GGSel/Plati rows back to their quantity
  healthPerPass: 20,   // live re-checks of committed vault units per pass (0..100)
  passEveryMin: 10,    // lifecycle pass interval (2..120)
};
```
`DEFAULTS.noclaimShop = NOCLAIM_SHOP_DEFAULTS`; export
`getNoclaimShopSettings` and `NOCLAIM_SHOP_DEFAULTS`.

## 2. `utils/noclaimHoldings.js` (NEW, agent: HOLDINGS)

Requires: `../models/NoclaimHolding`, `../models/AvailableAccount`,
`../models/UnclaimedAccount`, `./listedLogins` (`loginsOnActiveListings`),
`./settings`, and LAZILY `./unclaimedAutoList` (`collectNoClaimCandidates`,
`inventoryForCandidate`, `poolPassword`) inside functions (require cycle).

Exports:
* `foldSellable(sellable)` PURE → `[{itemKey,name,game,campaign,image,qty}]`:
  input = `sellableDropsFromNoClaimInv` output (one entry per copy, fields
  name/game/campaign/imageURL/itemKey); fold by itemKey (lowercased), qty =
  copies, first-seen name/game/campaign/image kept, stable order.
* `normGame(g)` → `settings.normGameName(g)`.
* `async sweepOnce({ budget, concurrency = 2, game = "", reason = "tick" })` →
  `{ configs, accounts, read, failed, tookMs, skipped? }`. One in-process
  `sweeping` flag (second call → `{skipped:"running"}`). Steps:
  1. `cands = await ual.collectNoClaimCandidates()` (throws when the Pi is
     unreachable → return `{skipped:"pi unreachable", error}` and back off:
     the next tick waits 3× interval).
  2. Join pool rows `AvailableAccount.find({clientSecret:{$in}}, {clientSecret:1})`
     → `poolAccountId`.
  3. Bulk upsert base fields for every cand (`login`, `loginLower`, `twitchId`,
     `poolAccountId`, `botId`, `container`, `game`, `seenAt:now`,
     `inConfig:true`); `updateMany({loginLower:{$nin:seen}, inConfig:true},
     {$set:{inConfig:false}})`.
  4. Pick up to `budget` cands to read: never-read first, then oldest `readAt`;
     `game` filter (normalised substring match on the bot game) when given;
     only cands whose `readAt` is older than `maxAgeHours/2` (a refresh never
     re-reads something fresh).
  5. Read each (bounded concurrency) with `ual.inventoryForCandidate(cand)`;
     success → `items = foldSellable(inv.sellable)`, `sellableCount`, `readAt`,
     `readError:""`, and if `inv.login` differs (rename) store the new login;
     failure → `readError = e.message` (keep old items/readAt).
  6. `invalidate()` the base cache. Log one line
     `noclaimHoldings sweep (<reason>): read X/Y, failed Z in Nms`.
* `async recordRead(loginLower, { sellable, login, error })` — used by claims
  to refresh one row after their own live read (same writes as step 5).
* `async snapshotBase({ force } = {})` → cached 30 s (in-process, invalidate()
  clears):
  ```js
  { at, maxAgeMs,
    holdings,          // lean NoclaimHolding rows with inConfig:true
    ledgerByLogin,     // Map loginLower -> {_id,status,manualListing,set,market}
    activeLogins,      // Set of lowercased logins on active listings
    poolById }         // Map poolAccountId -> {status,manualSold,soldGames,claimedNote,hasPassword,clientSecret? NO}
  ```
  Pool projection: `status manualSold listed soldGames claimedNote password credPasswordEnc`
  → `hasPassword = !!ual.poolPassword(row)`; never keep the password itself.
  `freeReason` also answers `"ticked listed"` when `pool.listed === true`.
  Ledger query: `UnclaimedAccount.find({source:"noclaim", loginLower:{$in}}, {loginLower,status,manualListing,set,market})`.
* `freeReason(holding, base, gameNorm)` PURE → `""` when free (rules 1-4 of §0;
  item coverage NOT checked here) else a short reason:
  `"not in a bot"|"no pool row"|"no password"|"manual sold"|"sold for this game"|"spent"|"pool not claimed"|"on auto listing"|"on manual listing"|"sold"|"removed"|"on a listing"`.
  (`ledger.status==="listed"` → "on auto listing"; `"manual"` → "on manual listing".)
* `isFresh(holding, base)` PURE → `readAt && now - readAt <= maxAgeMs`.
* `async pickerGames()` → `[{ game, accounts, free, fresh }]` (group by the
  item's game label, folded with `normGame`, nicest label = most common).
* `async pickerItems({ game = "", search = "" })` → rows shaped like the
  archive's `/drops-archive/by-item` so the page renders them unchanged:
  `{ itemKey, name, game, image, accounts, minPerAcct, maxPerAcct, totalCount,
     onAuto, onManual, stale }` where `accounts` = FREE+FRESH holders,
  `min/maxPerAcct` over those holders, `totalCount` = sum of their qty,
  `onAuto`/`onManual` = holders committed to auto/manual listings, `stale` =
  free holders whose read is stale. Sorted by accounts desc, then name.
  Items with `accounts+stale+onAuto+onManual === 0` are omitted. Limit 2000.
* `async summary()` → `{ accounts, read, fresh, stale, neverRead, failed,
  oldestReadAt, newestReadAt, sweeping, lastSweep, settings }`.
* `start()` — timer every `sweepEveryMin` (unref'd, first run after 60 s),
  only when `enabled && sweep`; each tick `sweepOnce({budget: sweepPerTick})`.
* `invalidate()`, `isSweeping()`.

## 3. `utils/noclaimStock.js` (NEW, agent: STOCK) — the ONE claim layer

Requires: `../models/UnclaimedAccount`, `../models/AvailableAccount`,
`../models/MarketplaceListing`, `./settings`, `./systemLog` (`logEvent`),
`./noclaimHoldings`, LAZILY `./unclaimedAutoList` (`inventoryForCandidate`,
`credentialForLedger`, `activeListingsForLogin`, `markOwnerUnlisted`,
`spendAccount`), `./suppliedStock` (`shareOfShelf` only — pure).

Constants (exported): `FREE_STATUSES`, `COMMITTED_STATUSES =
["listed","sold","removed","manual"]`, `VAULT_MARKETS`, `CLAIM_AT_SALE_MARKETS`,
`SUPPORTED_MARKETS`, `ADVERTISE_MAX = 25`, `MARKET_LABELS` (gameflip "Gameflip",
digiseller "Plati", ggsel "GGSel", eldorado "Eldorado", playerauctions
"PlayerAuctions", g2g "G2G", funpay "FunPay", zeusx "ZeusX", epicnpc "EpicNPC",
z2u "Z2U").

PURE (exported, unit-tested):
* `isNoclaimSet(set)`, `isNoclaimRow(row)`.
* `itemKeyOf(name, game)`.
* `requiredFromSet(set)` → `Map<itemKey, qty>`.
* `heldCounts(items)` → Map; accepts folded `{itemKey, qty}` or raw per-copy
  sellable entries (qty missing → 1 each, summed).
* `covers(held, required)` → every required key held ≥ qty (empty required → false).
* `extraLoad(held, required)` → total held copies − required copies (≥ 0).
* `orderCandidates(cands, required)` → stable sort: `extraLoad` asc (the
  LEANEST account — a buyer gets the whole account and could claim extras),
  then `readAt` desc, then `loginLower` asc.
* `requiredDropsForSet(set)` → `[{name, qty}]`.
* `rowFields(set, market, accounts)` →
  ```js
  { set: set._id, noclaimStock: true, origin: "manual", accountId: "",
    accountLogin: market === "gameflip" && accounts.length === 1 ? accounts[0].login : "",
    requiredDrops: requiredDropsForSet(set),
    units: accounts.map(a => ({ contentId: String(a.contentId || ""), accountId: "",
      login: a.login, addedAt: new Date(), deliveredAt: null, orderId: "" })) }
  ```
* `unsupportedMessage(market)`.
* `deliveryEnabled()` → `enabled && autoDeliver`.

READS:
* `async freeCandidates(set, { fresh = true } = {})` → holdings (from
  `noclaimHoldings.snapshotBase()`) that pass `freeReason === ""`, cover the
  set per snapshot, and (when `fresh`) are fresh. Each returned object:
  `{ loginLower, login, poolAccountId, botId, container, game, twitchId, items,
     readAt, ledgerStatus }`, ordered by `orderCandidates`.
* `async stockForSet(set)` → `{ free, stale, onAuto, onManual, covering,
  snapshotAt }` — `covering` = all in-config holdings covering the set;
  `free` fresh-free; `stale` free-but-stale; `onAuto`/`onManual` covering
  holdings committed. Never throws on an empty snapshot (zeros).
* `async stockForListing(row)` → number to ADVERTISE on a claim-at-sale row:
  `shareOfShelf(min(free, ADVERTISE_MAX), String(row._id), ids)` where `ids` =
  ids of ACTIVE no-claim rows of the same `set` on CLAIM_AT_SALE_MARKETS
  (sorted). A vault row → count of its undelivered units. **Throws on a DB
  error** (callers treat a failure as "leave the offer alone"); returns 0 only
  when the stock really is 0.

WRITES:
* `async claimForSet(set, want, { market, listingId = "", orderId = "",
  mode = "fed", dryRun = false })` →
  `[{ ledgerId, login, password, email, poolAccountId }]`.
  * `mode "fed"` (vault publish/top-up) → ledger status `"manual"`;
    `mode "sold"` (claim-at-sale order) → ledger status `"sold"` directly with
    `soldAt`, `soldMarket: market`, `note: market + " order " + orderId`,
    `manualSpentAt: null`.
  * Not `deliveryEnabled()` and not dryRun → `[]`. Not a no-claim set → `[]`.
  * `mode "sold"` + `orderId`: FIRST resume — ledgers `{status:"sold",
    manualListing:listingId, note: market+" order "+orderId}` → their creds
    (idempotent retry, never burns new accounts); top up the difference.
  * Walk `freeCandidates(set)`; live budget = `max(10, want*4)` reads; for
    each candidate: build cand from the pool row (`clientSecret`), live read
    `ual.inventoryForCandidate(cand)` → `noclaimHoldings.recordRead`; skip
    unless `covers(heldCounts(inv.sellable), required)` AND
    `inv.login` (lowercased, when present) equals the holding's login.
    `dryRun` → push creds without committing (no writes except recordRead).
  * Commit (atomic compare-and-set, never an upsert on a status filter):
    1. `activeListingsForLogin(login)` must be empty.
    2. Existing ledger `{source:"noclaim", loginLower}`: if its status is not
       in FREE_STATUSES → skip. Else `updateOne({_id, status: <that status>},
       {$set: {status, set, market, manualListing: listingId,
       manualPriorStatus: <that status>, manualAt: now, listedAt: now,
       lastCheckedAt: now, drops, emptyReads:0, firstEmptyAt:null, note}})`;
       `modifiedCount===0` → skip (someone else took it).
    3. No ledger → `UnclaimedAccount.create({source:"noclaim", login,
       loginLower, twitchId, game, poolAccountId, botId, container, drops, set,
       market, status, manualListing, manualPriorStatus:"", manualAt, listedAt,
       lastCheckedAt, note})`; then if
       `countDocuments({source:"noclaim", loginLower}) > 1` → delete ours, skip.
    4. Re-check `activeListingsForLogin(login)` (excluding `listingId`): not
       empty → roll back (release) and skip.
    `drops` = one entry per copy of the live sellable drops of the set's items
    (`{name, game, campaign, itemKey}`); `note` = `"manual no-claim listing — "
    + market` (fed) or the order note (sold).
  * Creds: `ual.credentialForLedger(ledger)`; no password → roll back, skip.
  * Pool flag: fed → `AvailableAccount.updateOne({_id: poolAccountId},
    {$set:{listed:true}})` (the no-claim console's "Listed" tick, so a hand
    bulk-copy never grabs it).
  * `noclaimHoldings.invalidate()` at the end; `logEvent({category:
    "noclaim_shop", action:"claimed", actor:"noclaimStock", subject: setId,
    count, detail})`. NEVER log credentials.
* `async attachListing(ledgerIds, listingId)` → sets `manualListing` on
  `status:"manual"` ledgers; returns modified count.
* `async releaseClaim(ledgerIds, { reason = "" } = {})` → only ledgers with
  `status:"manual"`: `manualPriorStatus === ""` → `deleteOne`; else
  `updateOne({_id, status:"manual"}, {$set:{status: manualPriorStatus,
  manualListing:"", manualPriorStatus:"", manualAt:null, note: "manual listing
  released — " + reason}})`. Then `ual.markOwnerUnlisted(ledger)` (the engine
  edit makes it respect "manual"). Returns released count. Never touches
  `"sold"`.
* `async markSold(ledgerIds, { market, priceUsd = 0, reason = "", orderId = "" } = {})`
  → ledgers in `["manual","sold"]` → `$set {status:"sold", soldAt (keep if
  set), soldMarket, soldPriceUsd, note: reason || market + " sale",
  manualDeliveredAt: now (keep if set)}` — it NEVER touches `manualSpentAt`
  (a second markSold must not re-run the bookkeeping); returns count.
  Post-sale bookkeeping is deferred to `spendPending`. claimForSet
  `mode "sold"` must NOT set `manualDeliveredAt` (only a real hand-over does).
* `async spendPending({ limit = 10 } = {})` → ledgers `{status:"sold",
  manualListing:{$ne:""}, manualDeliveredAt:{$ne:null}, manualSpentAt:null}`
  (oldest first) →
  `ual.spendAccount(ledger, ledger.note || "manual listing sale",
  { priceUsd: ledger.soldPriceUsd, market: ledger.soldMarket,
    removeFromProduct:false, label: "manual no-claim listing" })` → stamp
  `manualSpentAt: now`. One failure never blocks the rest.
* `async ledgerForLogin(login)` → the no-claim ledger (lean) or null.

## 4. `utils/noclaimListings.js` (NEW, agent: LISTINGS) — row lifecycle

Requires: `../models/MarketplaceListing`, `../models/UnclaimedAccount`,
`../models/DropSet`, `../models/AvailableAccount`, `./marketplaces` (as `mp`),
`./settings`, `./systemLog`, `./noclaimStock` (as `ncs`), `./noclaimHoldings`,
`./digisellerFulfiller` (`digisellerDeliveryCode`), `./ggselFulfiller`
(`ggselDeliveryCode`), LAZILY `./gameflipFulfiller` (`publishAutoDelivery`) and
`./unclaimedAutoList` (`finalizeGgselOffer`, `credentialForLedger`,
`delistRowVerified`).

* `async publishNoclaim(name, ctx)` → the per-market result object the publish
  route stores in `results[name]`:
  `{ success:true, id, externalId, url, note }` or `{ success:false, message }`.
  `ctx = { set, body, title, description, priceUsd, gridImage, coverPath, cat, pubGame }`.
  * not `settings.enabled` → `{success:false, message:"No-claim listings are switched off"}`;
    not `ncs.deliveryEnabled()` → `"No-claim auto-delivery is switched off"`.
  * unsupported market → `ncs.unsupportedMessage(name)`.
  * **gameflip**: `const qty = max(1, int(body.gameflip.qty))`; call
    `gfFulfiller.publishAutoDelivery({ set, title, description, priceUsd,
    imagePath: gridImage || coverPath, qtyRemaining: qty - 1, origin: "manual",
    noclaim: true })`; success → `{success:true, id, externalId, url,
    note: "no-claim auto-delivery: 1 live, " + (qty-1) + " queued"}`; a thrown
    error → `{success:false, message: e.message}`.
  * **ggsel** / **digiseller**: `qty = max(1, int(body.ggsel.quantity |
    body.digiseller.quantity))`; `claimed = await ncs.claimForSet(set, qty,
    {market:name, mode:"fed"})`; none → `{success:false, message: "Out of stock
    — no free no-claim account holds this whole bundle right now (N stale
    snapshot(s) — try Refresh stock)"}`. Publish exactly like the engine's
    `publishGgselOffer` / `publishDigisellerProduct` (utils/unclaimedAutoList.js
    ~1804-1990): GGSel `mp.ggselPublish({title, description, priceUsd,
    priceRub: body.ggsel.priceRub, categoryId: body.ggsel.categoryId ||
    cat.categoryId, delivery:"auto", instructions: body.ggsel.instructions,
    coverImagePath, products: claimed.map(c => ggselDeliveryCode(c.login,
    c.password))})` → `mp.ggselEnableAutoselling` (catch) ; Digiseller
    `mp.digisellerPublish({title, description, priceUsd, categories:
    body.digiseller.categories || cat.categories})` then
    `digisellerAddContent` in CHUNKS OF 12 recording every contentId (count
    mismatch → delist product + throw), then `digisellerUploadImage` (catch).
    Any publish error → `ncs.releaseClaim(ids, {reason})` then fail.
    Row: `MarketplaceListing.create({ marketplace:name, externalId, url, title,
    description, price: r.price || priceUsd, status:"active", autoDeliver:false,
    qtyTarget: qty, qtyRemaining: 0, note: "no-claim auto-delivery: N
    account(s)", ...ncs.rowFields(set, name, claimed.map((c,i)=>({login:c.login,
    contentId: digiseller ? contentIds[i] : ""}))) })` → `ncs.attachListing` →
    GGSel: `ual.finalizeGgselOffer(externalId, row._id)` → store `lastStock`
    from `mp.ggselOfferStock` / `mp.digisellerProductStock` (catch → leave null).
    If the row create throws AFTER the platform publish, DO NOT release (the
    credentials are live in the vault) — log loudly and return
    `{success:false, message:"published on <m> but the row could not be saved — delist it by hand: " + externalId}`.
  * **eldorado** / **playerauctions** / **g2g**: `st = await ncs.stockForSet(set)`;
    `st.free === 0` → `{success:false, message:"Out of stock — no free no-claim
    account holds this whole bundle right now"}`. `quantity = min(requested,
    st.free, ADVERTISE_MAX)` (requested: eldorado `body.eldorado.quantity`,
    PA `body.playerauctions.quantity`, g2g `body.g2g.qty`, default 1).
    Publish with the SAME mp call + args the publish route uses today for that
    market (eldorado `mp.eldoradoPublish({... quantity, minQuantity, game:
    el.game || pubGame, coverImagePath, deliveryTime, volumeDiscounts})`; PA
    `mp.playerauctionsPublish({game, title, description, instruction:
    pa.instruction || require("./playerauctionsCopy").bundleInstruction(),
    priceUsd: max(mp.PA_MIN_PRICE, priceUsd), itemsPerUnit: set.items.length ||
    1, totalUnit: quantity, minUnitPerOrder:1, deliveryGuarantee:
    mp.PA_DELIVERY.min20, coverImagePath})` with `externalId: r.offerId`; g2g
    `mp.g2gPublish({...same fields as the route, qty: quantity})`). Row:
    `{ marketplace, externalId, url, title, description, price, status:"active",
    qtyTarget: quantity, autoDeliver:false, note, ...ncs.rowFields(set, name, []) }`.
* `async beforeDelist(row)` → for ggsel/digiseller no-claim rows run
  `settleQuantitySales(row)` so units the platform already sold are marked
  sold BEFORE anything is released. Returns `{ sold }`.
* `async afterDelist(row, { outcome })` — called after the route's platform
  delist. `outcome === "sold"` (Gameflip said sold) → mark the single
  undelivered unit delivered + `ncs.markSold`. Otherwise release every
  UNDELIVERED unit's ledger (`status:"manual"` only) via `ncs.releaseClaim`.
  Claim-at-sale rows have only delivered units → nothing to release. Returns
  `{ released, sold }`. Logs `noclaim_shop/delisted`.
* `async onGameflipSold(row, { priceUsd })` → the row's undelivered unit:
  `$set units.$.deliveredAt/orderId:"gameflip-sale"`, `ncs.markSold([ledger],
  {market:"gameflip", priceUsd: priceUsd || row.price, reason:"gameflip sale"})`.
* `async onGameflipRetired(row, { reason })` → release the undelivered unit
  (`status:"manual"` only; a sold ledger is never released).
* `async settleQuantitySales(row)` → read `mp.ggselOfferStock` /
  `mp.digisellerProductStock` (null → return 0); `last = row.lastStock ??
  stock`; `dropped = last - stock`; persist `lastStock = stock`; for `dropped`
  times: FIFO victim = oldest undelivered unit (`addedAt`) → stamp
  `deliveredAt`, `orderId:"qty-sale"`, `ncs.markSold` (priceUsd row.price).
  Returns sold count. (Mirror of the engine's quantity-sale detection.)
* `async removeUnit(row, login, { reason })` → take ONE undelivered unit off a
  vault row: gameflip → `ual.delistRowVerified(row, reason)` (a gameflip row
  IS its unit), then REPLACE it — the removed unit was never sold, so the
  chain still owes the same number of units — with
  `gfFulfiller.relistNoclaimSuccessor(row)` (catch + log; out of stock just
  ends the chain, it never re-uses the removed account); digiseller → `mp.digisellerRemoveContent(externalId,
  unit.contentId)` then pull the unit; ggsel → rebuild: publish a new GGSel
  offer with the remaining units' codes (creds via
  `ual.credentialForLedger(ledger)`), create the replacement row (same
  fields, new externalId, units = remaining), delist the old one with
  `ual.delistRowVerified`; when NO units remain on any vault row → delist.
  The ledger's fate is the caller's (release vs removed vs sold).
* `async removeForPoolAccount(poolAccountId, { actor })` → every
  `status:"manual"` ledger of that pool account: `removeUnit` from its row,
  ledger → `status:"removed", note:"manual sold — removed from manual
  listing"` (NOT released; the account keeps farming). Returns `{units, rows,
  errors}`.
* `async runPass({ sweep = false } = {})` — the lifecycle pass (one in-process
  `running` flag; skip when `!enabled`). In order, each step try/caught:
  1. `ncs.spendPending({limit:10})`.
  2. `settleQuantitySales` for every active ggsel/digiseller no-claim row.
  3. Manual-sold: `status:"manual"` ledgers whose pool row has
     `manualSold:true` → `removeForPoolAccount`.
  4. Conflicts: each undelivered unit of an active no-claim row whose ledger
     is not `status:"manual"` with `manualListing === String(row._id)` (or
     `""`), OR whose login sits on ANOTHER active row → `removeUnit` (never
     release a ledger that is not "manual").
  5. Unit health (budget `healthPerPass` live reads, oldest `lastCheckedAt`
     first) over `status:"manual"` ledgers with a `manualListing`: live read;
     still covers the set → `lastCheckedAt` + reset strikes; an advertised
     item now CLAIMED (inProgress entry `claimed:true` with that name) → the
     buyer claimed it → treat as sold (`markSold`, stamp the unit delivered);
     otherwise short of the set → strike (`emptyReads++`, `firstEmptyAt`);
     2 strikes ≥ 20 min apart → `removeUnit` + `ncs.releaseClaim`
     (reason "drops expired"). A failed read changes nothing.
  6. Top-up (setting `topUp`): active ggsel/digiseller no-claim rows with
     undelivered units < `qtyTarget` → claim the difference (max 5 per row
     per pass) and add them (`mp.ggselAddProducts(externalId, codes)` /
     `digisellerAddContent` recording contentIds), `ncs.attachListing`,
     append units. GGSel: re-run `ual.finalizeGgselOffer`.
  7. (Gameflip chains whose successor failed are gameflipFulfiller's own
     stalled-lane retry — nothing to do here.)
  8. If `sweep` → `noclaimHoldings.sweepOnce({budget: sweepPerTick})`.
  Returns a summary object of counts.
* `start()` — timer every `passEveryMin` (unref'd, first after 90 s),
  `runPass()`. Also calls `noclaimHoldings.start()`.
* `status()` → `{ running, lastPass }`.

## 5. Engine edits — `utils/unclaimedAutoList.js` (agent: ENGINE)

Minimal, additive; nothing else changes:
1. `scanAndListPass`: the `ledgered` query statuses
   `["listed","sold","removed"]` → add `"manual"`.
2. Same pass: `if (existing && (existing.status === "listed" || existing.status === "sold")) return;`
   → also `|| existing.status === "manual"`.
3. Same pass, the under-lock `dupLedger` probe: `status: "listed"` →
   `status: { $in: ["listed", "manual"] }`.
4. `markOwnerUnlisted`: `status: "listed"` → `status: { $in: ["listed", "manual"] }`.
5. `spendAccount`: final ledger update filter `status: "listed"` →
   `status: { $in: ["listed", "manual"] }`; new optional `opts.label`: when
   given, the pool `claimedNote` becomes `"spent — " + opts.label + " (" +
   reason + ")"`, NoclaimSpentAccount `soldWhy` `opts.label + ": " + reason`,
   Telegram header `"💰 SOLD (" + opts.label + ")"`. Without `opts.label`
   every string stays EXACTLY as today.
6. `ARCHIVE_STATUS_ZERO`: add `manual: 0` (the `status=all` rollup would add
   to `undefined` → NaN otherwise). `ARCHIVE_HELD_STATUSES` unchanged.
7. `removeManualSoldOwner`: after its loop, lazily
   `require("./noclaimListings").removeForPoolAccount(String(owner.poolAccountId),
   {actor})` in try/catch; add `out.manualUnits` (number) and push errors.
8. Export `poolPassword` (currently internal) so the holdings module can
   compute `hasPassword` with the same rule.

## 6. Guards (agent: GUARDS) — defense in depth, all inline, no new requires
* `routes/shopRoutes.js`: `availableAccountsForSet(set)` → first line
  `if (set && set.stockSource === "noclaim") return [];`;
  `stockForSetFromHoldings` → same → `{stock:0, topItems:[]}`;
  `GET /shop/listings` query adds `stockSource: { $ne: "noclaim" }`;
  `GET /shop/listings/:id` and `POST /shop/listings/:id/buy` treat a no-claim
  set as not found (404 "Listing not found").
* `utils/dropReservation.js`: `reserveSetOnAccount` → first line
  `if (set && set.stockSource === "noclaim") return false;`.
* `utils/marketplaceGuardian.js`: `runChecks` — drop `noclaimStock` rows
  exactly where `accountOffer` rows are dropped; `feedListing` → `if
  (row.noclaimStock) return 0;` at the top.
* `routes/dropArchiveRoutes.js`:
  * light + full `/drops-archive/sets` payloads and `publicSet` carry
    `stockSource: s.stockSource || ""` (add to the aggregation `$project`).
  * `GET /drops-archive/sets/:id/fulfillment`: a no-claim set →
    `const st = await require("../utils/noclaimStock").stockForSet(set)` and
    answer `{success, set:{...}, items: set.items, accounts: [],
    fullAccounts: st.covering, bundlesAvailable: st.free, bundlesHeld:
    st.onManual + st.onAuto, bundlesMissingPassword: 0, noclaim: st}` —
    never the DropLog aggregation.
  * `PUT /drops-archive/sets/:id` on a no-claim set: `listed:true` → 400
    `"A no-claim listing sells on marketplaces only — use Sell on…"`; any of
    `itemKeys/addItemKeys/removeItemKeys/itemQuantities` → 400
    `"Edit a no-claim listing's items from the No-claim picker"`. Name, note
    and price edits still work.
  * export `router.bustSetsCache = () => bustDropCache(["sets:"]);`.
* `utils/suspendedAccounts.js` (the suspended-account sweep): a
  `noclaimStock` candidate is reported and skipped exactly like the
  `accountOffer` one (its own warning text: "no-claim listing <id> carries
  <logins>, suspended in the Drop Archive — the no-claim lifecycle re-checks
  it live; left untouched"). Add `noclaimStock: 1` to that find's projection.
* `utils/listingDetach.js` `detachAccountFromListing(row, …)`: a
  `row.noclaimStock` row returns immediately `{ detached: [], warnings:
  ["no-claim listing — units are managed by utils/noclaimListings"] }` (same
  return shape the function already uses) — the archive repair/republish
  paths must never rebuild a no-claim product.

## 7. Publish + delist route — `routes/marketplaceRoutes.js` (agent: ROUTE)
* In `POST /marketplaces/publish`, after `set` is loaded:
  `const noclaimSet = !offer && !!set && set.stockSource === "noclaim";`.
  Inside the per-market loop, immediately after the category resolution block
  (so `cat` exists) and BEFORE `if (name === "gameflip")`:
  ```js
  if (noclaimSet) {
    results[name] = await noclaimListings.publishNoclaim(name, {
      set, body, title, description, priceUsd, gridImage,
      coverPath: coverImagePath(set), cat, pubGame });
    continue;
  }
  ```
  For a no-claim set, skip category resolution for markets the no-claim layer
  refuses (funpay/zeusx/z2u) — i.e. check support first:
  `if (noclaimSet && !ncs.SUPPORTED_MARKETS.includes(name)) { results[name] =
  {success:false, message: ncs.unsupportedMessage(name)}; continue; }` at the
  very top of the loop.
* `DELETE /marketplaces/listings/:id`: for `row.noclaimStock` rows call
  `await noclaimListings.beforeDelist(row)` before the platform delist, and
  `await noclaimListings.afterDelist(row, { outcome })` after it (where the
  `accountOffer` release branch runs; `outcome` = the same sold/delisted
  verdict the route already computes). The existing archive release block is
  already skipped because `accountId` is "". Include in the response
  `noclaim: { released, sold }`.
* `GET /marketplaces/listings`: add `noclaimStock: !!r.noclaimStock` to each row.
* Requires: `const noclaimListings = require("../utils/noclaimListings");`
  `const ncs = require("../utils/noclaimStock");` at the top.

## 8. Fulfillers
### 8a. `utils/gameflipFulfiller.js` (agent: GAMEFLIP)
* `publishAutoDelivery(opts)`: when `opts.noclaim || (opts.set &&
  opts.set.stockSource === "noclaim")` take a NEW branch BEFORE the archive
  claim: `const [acc] = await ncs.claimForSet(set, 1, {market:"gameflip",
  mode:"fed"})`; none → throw `new Error("Out of stock — no free no-claim
  account holds this whole bundle")`; publish with the same image/title/
  description handling the function already does and `autoDeliverCode:
  gameflipDeliveryCode(acc.login, acc.password)`; on publish failure
  `ncs.releaseClaim([acc.ledgerId], {reason:"gameflip publish failed"})` and
  rethrow; create the row with the same fields the archive path writes
  (status, autoDeliver:true, qtyRemaining, origin, note "no-claim
  auto-delivery — <login>") PLUS `...ncs.rowFields(set, "gameflip", [acc])`;
  then `ncs.attachListing([acc.ledgerId], doc._id)`. The archive path must
  never run for a no-claim set.
* `syncOnce` "sold" path: right after the atomic sold claim and before sale
  learning/relist, `if (row.noclaimStock) await
  noclaimListings().onGameflipSold(row, {priceUsd: row.price})` (lazy require
  helper). The relist then flows through `relistSource` → the DropSet →
  `publishAutoDelivery` → the no-claim branch above (successor rows inherit
  `noclaimStock` via rowFields). Out-of-stock alert text for a no-claim row:
  `"no free no-claim account holds this bundle"` instead of the farmer text.
* Retire paths (404 / expired / cancelled): where the `accountOffer` release
  runs, add `if (row.noclaimStock) await noclaimListings().onGameflipRetired(row,
  {reason})`.
* NEW export `async relistNoclaimSuccessor(row)` → REPLACE the live unit of a
  no-claim chain after `row` was taken down unsold (expired / manual-sold /
  conflict): load the set, rebuild the cover the same way the sold-path relist
  does, call `publishAutoDelivery({ set, title: row.title, description:
  row.description, priceUsd: row.price, imagePath, qtyRemaining:
  row.qtyRemaining || 0, origin: row.origin || "manual", noclaim: true })`,
  then zero `qtyRemaining` on `row` (the replacement carries it). Out of stock
  → returns null (logged), never throws.
* Requires LAZY for both no-claim modules (`./noclaimStock`,
  `./noclaimListings`) — they require this file.

### 8b. `utils/eldoradoFulfiller.js` + `utils/playerauctionsFulfiller.js` (agent: CLAIMSALE)
* `deliverOrder`: a new branch `if (listing.noclaimStock)` placed right AFTER
  the `accountOffer` branch and BEFORE the `unclaimedGame` branch (and, in PA,
  before the "resume units stamped with this order" block only if that block
  would otherwise re-send units — read it and keep its idempotency: units
  already carrying this orderId must be re-sent, never re-claimed). Body =
  the `unclaimedGame` branch's delivery code, byte-for-byte in behaviour,
  with the claim swapped to:
  ```js
  const ncs = require("./noclaimStock");
  if (!ncs.deliveryEnabled()) return { orderId, skipped: "no-claim listing auto-delivery is off" };
  const set = await DropSet.findById(listing.set).lean();
  const picked = set ? await ncs.claimForSet(set, qty, { market: "<m>",
    listingId: String(listing._id), orderId, mode: "sold" }) : [];
  ```
  `picked[i].ledgerId` goes where the unclaimed branch puts its ledger id
  (`units[].contentId`), `source: "noclaim-set:" + String(listing.set)`, and
  after a successful hand-over `await ncs.markSold(ids, { market, priceUsd:
  <order total / qty when known, else listing.price>, orderId, reason: "<m>
  order " + orderId })`. Shortfall → the same operator alert the unclaimed
  branch sends, worded "no free no-claim account holds all N advertised
  item(s)".
* Stock sync (`eldoradoFulfiller.syncBundleStock`, PA `stockFor` +
  `syncUnclaimedStock`/whatever loop pushes quantities): include active
  `noclaimStock` rows and compute their number with `await
  ncs.stockForListing(row)` FIRST (before any `autoClaimSet`/`unclaimedGame`
  /`set` branch). A throw → skip the row this pass (never push 0 on an error).

### 8c. `utils/g2gFulfiller.js` (agent: G2G)
* `pickStock`: a `noclaimStock` branch FIRST: claim with
  `ncs.claimForSet(set, qty, {market:"g2g", listingId, orderId, mode:"sold"})`
  and carry the claimed `{login, password}` straight to the hand-over — a
  no-claim row must never go through `credentialsFor` (BotAccount lookups) and
  never through the archive. After a successful hand-over `ncs.markSold`.
* `realStockFor`: `noclaimStock` branch BEFORE the generic `row.set` branch →
  `ncs.stockForListing(row)`.
* `syncStock` query `$or` gains `{ noclaimStock: true }`.

## 9. `routes/noclaimStockRoutes.js` (NEW, agent: API) + `server.js`
All routes `requireSuperadmin` (from `../middleware/auth` — use the same import
the sibling routes use), JSON `{success:true, ...}` / `{success:false,
message}`; writes refuse when `!getNoclaimShopSettings().enabled`.
* `GET  /noclaim-stock/summary` → `noclaimHoldings.summary()` + `lastPass`.
* `GET  /noclaim-stock/games` → `{ games: pickerGames() }`.
* `GET  /noclaim-stock/items?game=&search=` → `{ items: pickerItems() }`.
* `POST /noclaim-stock/refresh {game?}` → 409 when sweeping; else start
  `sweepOnce({budget: refreshBudget, game, reason:"refresh"})` WITHOUT
  awaiting; `{success:true, started:true}`.
* `POST /noclaim-stock/copy {items:[{itemKey, qty}]}` → resolve items against
  the snapshot (name/game/image), build a set-like `{items, coverGame}` and
  answer `{ title, description, price, floor }` using the engine's
  `classificationForSet`, `listingTitle(game, dropsFromSet(setLike), cls)`,
  `listingDescription(game, dropsFromSet(setLike), undefined, cls)`,
  `priceForItems({research: MarketResearch.findOne({game}), game, items,
  cls, pricing: settings.getUnclaimedPricing()})`. Never throws to the client
  (fallback title/description from the item names).
* `POST /noclaim-stock/sets {name, note, price, items:[{itemKey, qty}]}` →
  every itemKey must exist in the snapshot (else 400 naming it); name/game/
  image from the snapshot; `qty` clamped 1..max held; create
  `DropSet({name, note, price (2dp, ≥0), items, stockSource:"noclaim",
  listed:false, publicCatalog:false, custom:false, coverGame: <single game or
  first item's>})`; `dropArchiveRoutes.bustSetsCache()`; answer `{set}` in
  `publicSet` shape (id, name, note, items, itemCount, price, listed, custom,
  stockSource, coverGame, createdAt, updatedAt).
* `PUT /noclaim-stock/sets/:id` → only for a no-claim set (else 400); name/
  note/price always; items only when NO active row has `set` = this id (else
  409 "Delist it first — live listings advertise the current items");
  `bustSetsCache()`.
* `GET /noclaim-stock/sets/:id/stock` → `ncs.stockForSet(set)`.
* `GET /noclaim-stock/sets/:id/accounts` → up to 200 free covering accounts:
  `{login, botId, game, readAt, extra}` — NO passwords, NO secrets.
* `POST /noclaim-stock/run` → `await noclaimListings.runPass({sweep:false})`.
* `server.js`: `const noclaimStockRoutes = require("./routes/noclaimStockRoutes");`
  mount `app.use(enforce2fa, noclaimStockRoutes);` right AFTER
  `app.use(enforce2fa, unclaimedAutoRoutes);`; after `unclaimedAutoList.start();`
  add `require("./utils/noclaimListings").start();` with a one-line comment.

## 10. UI — `public/listings.html` (agent: UI)
* Picker card header: "Pick items" + a segmented switch
  `[Drop archive] [No-claim farm]` (buttons `#srcArchive` / `#srcNoclaim`,
  state var `pickSource = "archive" | "noclaim"`, remembered in localStorage
  key `listingsPickSource` with try/catch). Switching with items selected asks
  `confirm("Switch source? The N picked item(s) will be cleared.")`.
* No-claim mode: games from `/noclaim-stock/games` (option label
  `"<game> · <free> free"`), items from `/noclaim-stock/items?game=&search=`
  (same render as archive rows; the sub-line reads `"<game> · N free"` plus
  `" · M on auto-list"` when `onAuto`, `" · S unverified"` when `stale`). A
  status strip under the pickbar: `"Snapshot: X accounts read · updated
  <relative time> · [Refresh stock]"` (POST /noclaim-stock/refresh, then poll
  /noclaim-stock/summary every 5 s until `sweeping:false`, max 3 min, then
  reload items) and the hint "Accounts already on auto-lister listings are
  never used. Every sale re-checks the account live before it is handed over."
* Form in no-claim mode: a badge "No-claim farm" next to "Create a listing";
  auto title/description come from `POST /noclaim-stock/copy` (debounced 400
  ms after the selection changes; still only when not hand-edited), and the
  price field is pre-filled with the suggested price ONLY while it is 0.
  Primary button reads "Save listing" (no "Save as draft" button); save posts
  to `/noclaim-stock/sets` (edit → `PUT /noclaim-stock/sets/:id`). Edit of a
  no-claim set switches the picker to no-claim mode.
* Existing listings rows (`listingRow(set)`): `set.stockSource === "noclaim"`
  → badge `<span class="badge noclaim">No-claim</span>` instead of
  Draft/Listed/Out-of-stock, stock text `"N free in no-claim farm"` (+ `" · S
  unverified"`, `" · M on auto-list"`) from `/noclaim-stock/sets/:id/stock`
  (fanoutStock uses that endpoint for no-claim sets), NO Publish/Unlist
  button, NO "Account listing" copy button; Edit / Sell on… / Delete stay.
  Add a filter chip `data-lso="noclaim"` ("No-claim") in the origin group;
  "Mine" keeps including no-claim sets.
* Publish modal for a no-claim set (`mpSet.stockSource === "noclaim"`):
  a line at the top `#mpNoclaimNote`: "No-claim stock: N free account(s) hold
  this bundle — each sale hands over one of them." (from
  `/noclaim-stock/sets/:id/stock`); unsupported markets' checkboxes disabled
  with suffix " (not for no-claim)"; Gameflip auto-delivery checkbox forced
  on + disabled; GGSel/Plati delivery selects forced to "auto" + disabled;
  description defaults to `set.note` (not note + a second "Includes:" list).
  Restore every forced control on a non-no-claim open (same pattern as
  `mpApplyOfferDefaults`).
* Mobile (≤ 720px), CSS only, no layout change on desktop: `.page` padding
  `14px 12px 60px`; `.tabbar` wraps and its buttons flex 1 1 auto; cards
  padding 14px; `.pickbar` wraps (select 100%); `.listing` becomes a wrapped
  2-row card: thumbs + info on row 1 (`.info` `flex:1 1 0; min-width:0`,
  title wraps normally, description clamps to 2 lines), `.price` aligned
  right on row 1, `.ops` on row 2 full width with `flex-wrap:wrap` and
  buttons `flex:1 1 auto`; `.list-toolbar input[type=search]` full width;
  no horizontal scroll anywhere on a 375px viewport (`body{overflow-x:hidden}`
  is NOT allowed — fix the widths). The mp modal already has a 768px rule.
* Never use a native datalist element (iOS). Keep the existing Custom and
  Account listings tabs working unchanged.

## 11. Tests (each agent owns its own file; `node --test tests/<file>`; no Mongo,
no network — stub models with `Module._load` like tests/manualSoldRemoval.test.js;
set `process.env.CRED_SECRET ||= "test-secret"` when anything encrypts)
* MODELS → `tests/noclaimModels.test.js` (enum/field presence, settings clamp).
* HOLDINGS → `tests/noclaimHoldings.test.js` (foldSellable, freeReason, isFresh, picker grouping).
* STOCK → `tests/noclaimStock.test.js` (pure helpers, rowFields, commit/release/markSold flows with stubbed models).
* LISTINGS → `tests/noclaimListings.test.js` (publishNoclaim refusals, settleQuantitySales FIFO, afterDelist release rules, removeForPoolAccount).
* ENGINE → `tests/noclaimEngineStatus.test.js` (scan skips "manual", markOwnerUnlisted, spendAccount label/default strings).
* GUARDS → `tests/noclaimGuards.test.js` (availableAccountsForSet/reserveSetOnAccount refuse, shop filter, guardian skip).
* ROUTE → `tests/noclaimPublishRoute.test.js` (publish delegates per market, unsupported refusals, delist hooks).
* GAMEFLIP → `tests/noclaimGameflip.test.js`; CLAIMSALE → `tests/noclaimClaimAtSale.test.js`; G2G → `tests/noclaimG2g.test.js`.
* API → `tests/noclaimStockRoutes.test.js`; UI → `tests/noclaimListingsUi.test.js` (static checks on listings.html: switch ids, endpoints, media query, no datalist).
