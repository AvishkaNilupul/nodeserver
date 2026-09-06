# Catalog v2 — frozen contract (2026-09-07)

Public bulk catalog (`/catalog`, `public/catalog.html`, `routes/catalogRoutes.js`) and
its admin page. Base = the LIVE prod bytes, already on this branch (HEAD). Each agent
edits ONLY the file(s) in its ownership row, codes against THIS document (not against
sibling files, which may not exist yet), runs NO git commands, and reports its exact
export/registration surface when done. Tests: `node --test`, no network, no DB.

## 0. What is wrong today (measured on prod 2026-09-07)

- 147 sellable unclaimed-farm accounts (no-claim + web-token: 115 `listed` on a
  marketplace + 32 `skipped` = held for manual bulk sale) across 10 DropSets are
  invisible: those sets are `custom:true, listed:false`, which `buildPublicCatalog`
  excludes. Every sellable ledger row references its `set`.
- 660 public listings hold 339 exact duplicates (identical items×qty), e.g. 140
  identical "Mir Tankov — Июльский магазин 6\6" rows, created by
  `syncHistoricalEventSets` mirroring one `custom:true` marketplace set per orphan.
  Mirrors carry NO account scope (archive-wide stock), so duplicates show the same stock.
- All 8 preorder cards show no progress/ETA: the assigned accounts have no
  `farmingProgress` rows for the campaign. `autoLister.campaignItems()` already returns
  `requiredMinutes` per item → a schedule-based ETA is possible.
- Preorder stamping lags 1–46 h behind farm2 deploys: only the 6-hour variant sync
  calls `syncActivePreorders`. Some sets were stamped with `expectedUnits: 0`.
- Quote requests are stored silently — no Telegram, no contact link. 0 inquiries ever.
- Cold build ≈ 46 s; after a restart visitors wait for it. Persist the snapshot.
- Titles like "Plants on Fire — Plants on Fire". `tests/catalogRules.test.js` on main
  fails 4 price tests because the owner's $1.01–$2.99 clamp was never reflected in tests.
- The clamp is the OWNER's rule for farmed bundles: KEEP it for kind `bundle`/`preorder`.
  It must NOT apply to `unclaimed` (their engine price + sold floor is the owner's newer
  decision; capping at $2.99 would advertise below the marketplace price).

## 1. File ownership

| Agent | File(s) | Status |
|---|---|---|
| A | `utils/catalogPublic.js` | NEW — pure helpers, zero `require`s |
| B | `utils/catalogPreorder.js` | edit |
| C | `models/DropSet.js`, `models/CatalogInquiry.js`, `models/CatalogSnapshot.js` (new) | edit / new |
| D | `utils/settings.js` | edit, additive only |
| E | `routes/catalogRoutes.js` | edit |
| F | `public/catalog.html` | edit |
| G | `public/catalog-admin.html` | edit |
| H | `server.js` (edit the WORKING COPY as-is; it equals prod) | edit |
| T | `tests/catalogPublic.test.js` (new), `tests/catalogRules.test.js`, `tests/catalogEventSets.test.js` | tests |

## 2. Shared vocabulary

- `kind`: `"bundle"` (claimed drops on farmed accounts: `autofarm_event` instock/soldout,
  `catalog_profile`, manual sets) · `"preorder"` (`autofarm_event` with
  `catalogState:"preorder"`) · `"unclaimed"` (sets backed by `UnclaimedAccount` ledgers).
- `delivery`: `"claimed"` for bundle/preorder, `"unclaimed"` for unclaimed.
- `signature(set)` = `(set.items||[]).map(i => `${i.itemKey}x${Math.max(1,Number(i.qty)||1)}`).sort().join("|")`;
  items without `itemKey` are skipped; empty → `""`.
- `MARKETPLACE_LABELS` = `{ gameflip:"Gameflip", eldorado:"Eldorado.gg", ggsel:"GGSel", digiseller:"Plati", zeusx:"ZeusX", funpay:"FunPay", epicnpc:"EpicNPC", g2g:"G2G", z2u:"Z2U" }`.
- Privacy rule (unchanged, now enforced): a public listing never contains `login`,
  `loginLower`, `password`, `credPassword`, `clientSecret`, `twitchId`, `botId`,
  `container`, `configFile`, `accountScopeLogins`, `accountScopeIds`.

## 3. Agent A — `utils/catalogPublic.js` (pure; `module.exports = {...}`)

- `MARKETPLACE_LABELS`, `PRIVATE_KEYS` (the list above).
- `signatureFor(set) → string`.
- `deriveTitle({ set, category, kind, eventLabel }) → string` (≤140 chars, trimmed):
  1. `set.publicTitle` non-empty → it.
  2. kind `"unclaimed"` → `${category} — ${eventLabel} (unclaimed drops)` when eventLabel,
     else `${category} — ${n} unclaimed drop${n===1?"":"s"}` where n = items.length.
  3. `set.sourceType === "catalog_profile"` or no `set.sourceEventName` → `set.name`.
  4. else e = sourceEventName.trim(), g = category: `e.toLowerCase() === g.toLowerCase()`
     → `${g} Twitch Drops`; `e.toLowerCase().includes(g.toLowerCase())` → `e`;
     else `${g} — ${e}`.
- `dedupeListings(rows, { stockMode = "max" } = {}) → rows'`. `rows` = `[{ set, stock, ...any }]`.
  Group key = `${categoryLower}::${signature}` (`row.category` lowercased; caller supplies
  it). Empty signature → never grouped. Representative rank (lower wins):
  `autofarm_event` with `sourceEventKey` matching `/^autofarm:(?!set:)/` → 0;
  `/^autofarm-stack:/` → 1; `/^autofarm:set:/` → 2; `catalog_profile` → 3; else 4.
  Tie-break: higher `stock`, then newer `set.createdAt`. Output row = shallow copy of the
  representative row plus `stock` (max or sum over members per `stockMode`),
  `mergedIds` (other members' `String(set._id)`), `mergedCount`, `updatedAt` (max member
  `set.updatedAt`), `isNewAny` (any member `set.createdAt` within 24 h of `now`, where
  `now` is an optional third option `{ now }`). Output order = first appearance of each
  group in the input.
- `unclaimedSummary({ set, ledgers }) → { stock, listed, held, eventLabel, campaigns }`.
  `ledgers` are rows for THIS set with `{ status, drops:[{campaign}], bundleLabel }`.
  `listed` = count status `"listed"`; `held` = count status `"skipped"` whose
  `(drops||[]).length > 0`; `stock = listed + held`; `campaigns` = `[{ name, count }]`
  of non-empty `drops[].campaign` sorted by count desc then name; `eventLabel` = most
  common non-empty `bundleLabel` → else `set.sourceEventName` → else `campaigns[0].name`
  → else `""`.
- `buyLinksFor(rows) → [{ marketplace, label, url, price }]`: keep `status === "active"`
  and `url` matching `/^https?:\/\//i`; one row per marketplace (lowest `price`,
  `Number(price)||0`); label from `MARKETPLACE_LABELS` else capitalised key; sort by price
  asc (0-price rows last); max 5.
- `scheduleEta({ farmStartedAt, requiredWatchMinutes, now = Date.now() })`:
  `null` when `requiredWatchMinutes <= 0` or `farmStartedAt` missing/invalid.
  `elapsed = (now - farmStartedAt)/60000`. If `elapsed > required*2` →
  `{ etaSource:"schedule", overdue:true, progressPercent:100 }` (no `readyInMinutes`).
  Else `{ etaSource:"schedule", overdue:false, readyInMinutes: max(0, round(required-elapsed)), progressPercent: round(100*min(1, elapsed/required)) }`.
- `assertPublicShape(value)`: walks objects/arrays recursively; throws
  `Error("public payload leaks <key>")` on the first key in `PRIVATE_KEYS`.

## 4. Agent B — `utils/catalogPreorder.js`

- `stampPreorderSet`: doc gains `requiredWatchMinutes = max(items[].requiredMinutes)||0`
  (items from `campaignItems` carry `requiredMinutes`).
- `syncActivePreorders(opts)`: module-level in-flight guard — while a run is in progress
  every caller gets the SAME promise (no concurrent runs, no double upserts). New options
  `fillRequiredMinutes = true`, `fillLimit = 5`, `now`. After stamping (only when `apply`):
  find `{ sourceType:"autofarm_event", catalogState:"preorder", listed:true, sourceEventKey:/^autofarm:(?!set:)/, farmStartedAt:{ $gte: now-14d }, $or:[{requiredWatchMinutes:{$exists:false}},{requiredWatchMinutes:0}] }`
  limit `fillLimit`; per set: `campaignId = sourceEventKey.slice("autofarm:".length)`,
  `items = await campaignItems(campaignId, set.items?.[0]?.game || "", set.sourceEventName)`
  inside try/catch; `minutes = max(requiredMinutes)||0`;
  `updateOne({_id}, {$set:{ requiredWatchMinutes: minutes > 0 ? minutes : -1 }})`
  (-1 = looked up, unknown → never retried). Return `{ candidates, stamped, filled }`.
- `syncHistoricalEventSets`: after `usable` + `stockMap` are known, fold duplicates:
  group `usable` by `${(source.items[0]?.game||"").toLowerCase()}::${signature(source)}`
  (`signature` re-implemented locally — this file must not require catalogPublic, keep it
  dependency-free as today). In a group of >1: keep the best by kind rank
  (event 0, stack 1, orphan 2), then higher stock, then newer `source.updatedAt`. For the
  others: if their mirror (`current`) exists and is `listed`, `updateOne({_id:current._id},{$set:{listed:false}})`
  when `apply`, count `deduped`; never publish them. Return adds `deduped`.
  Everything else unchanged.

## 5. Agent C — models

- `models/DropSet.js`: add `requiredWatchMinutes: { type: Number, default: 0 }` (top-tier
  watch minutes; -1 = looked up, unknown). Declare it — strict mode drops undeclared `$set`s.
- `models/CatalogInquiry.js`: add `kind: { type:String, enum:["bundle","preorder","unclaimed"], default:"bundle", index:true }`,
  `unitPrice: { type:Number, default:0 }`, `notifiedAt: { type:Date, default:null }`.
- `models/CatalogSnapshot.js` (new): `{ key:{type:String,required:true,unique:true}, generatedAt:{type:Date,default:null}, data:{type:mongoose.Schema.Types.Mixed,default:null} }`,
  `{ timestamps:true, minimize:false }`, `mongoose.model("CatalogSnapshot", schema)`.

## 6. Agent D — `utils/settings.js` (additive)

Add to `AUTO_FARM_DEFAULTS` (with comments in the file's style):
`catalogContactTelegram: ""` (public handle, no @), `catalogContactDiscord: ""`,
`catalogReplyTime: "within a few hours"`, `catalogPreorderSyncMinutes: 10` (0 = off).
Export `getCatalogConfig() → { contactTelegram, contactDiscord, replyTime, preorderSyncMinutes }`
(telegram: strip leading `@`, keep `[A-Za-z0-9_]` only, ≤64; discord ≤80 trimmed;
replyTime ≤80 trimmed, default when empty; preorderSyncMinutes integer clamped 0..1440,
default 10 when not finite) and `setCatalogConfig(patch) → Promise<config>` that
applies ONLY those four keys through `setAutoFarm` and returns `getCatalogConfig()`.

## 7. Agent E — `routes/catalogRoutes.js`

Requires to add: `UnclaimedAccount`, `CatalogSnapshot`, `MarketResearch`, `settings`
(`getCatalogConfig`, `getUnclaimedPricing`, `gameFloorFor`), `sendTelegram` from
`../utils/telegram`, and `../utils/catalogPublic`. `../utils/unclaimedAutoList` is
required LAZILY inside a try/catch helper (never at module load).

1. `publicPriceFor(set, marketMedian = 0, opts = {})` / `publicPriceTiers(set, marketMedian = 0, opts = {})`:
   `opts.clamp` (default `true`), `opts.floor` (extra floor, default 0), `opts.retail`
   (overrides `Number(set.price)||marketMedian`). With `clamp:false` skip
   `clampPublicPrice`, round to cents, enforce `>= max(floor, 0.25)`. Default opts →
   behaviour byte-identical to today.
2. `publicListing(set, stock, marketMedian = 0, preorder = null, extra = {})`, `extra =
   { kind, delivery, eventLabel, buyLinks, mergedCount, priceOpts }`. Output adds `kind`
   (default: preorder when `catalogState==="preorder"`, else `"bundle"`), `delivery`,
   `buyLinks` (default `[]`), `mergedCount` (default 0); `title` via `deriveTitle`;
   for unclaimed `eventName = eventLabel`, `state = stock>0 ? "instock" : "soldout"`,
   `exactProfile:false`. Preorder object = `{ expectedUnits, startedAt: set.farmStartedAt, ...preorder }`
   (`preorder` may carry `progressPercent`, `readyInMinutes`, `etaSource`, `overdue`).
3. `buildPublicCatalog()`:
   a. sets + `stockForSetsBatched` as today; `t0 = Date.now()`.
   b. ONE `AutoFarmTask` query for every set with `autoFarmTaskId` (projection
      `assignedAccounts campaignName status listing.setId stackListing.setId`); accounts
      for preorder tasks as today.
   c. preorder per set: `progress = computePreorderEta(...)`; `etaSource:"progress"` when
      it yields `readyInMinutes`; otherwise merge `scheduleEta({ farmStartedAt:set.farmStartedAt, requiredWatchMinutes:set.requiredWatchMinutes })`
      (keep a progress `progressPercent` if present). `expectedUnits = task?.assignedAccounts?.length || set.expectedUnits`.
   d. buy links: source set id per set = `sourceEventKey` starts `autofarm:set:` → that id;
      starts `autofarm-stack:` → `task.stackListing.setId`; else `task.listing.setId`.
      Collect all ids (+ the unclaimed set ids from e) and run ONE
      `MarketplaceListing.find({ set:{$in:ids}, status:"active" }, { set:1, marketplace:1, url:1, price:1, status:1 }).lean()`;
      `buyLinksFor(rowsForThatSet)`.
   e. unclaimed source, wrapped in try/catch (log; on failure the catalog still builds):
      `UnclaimedAccount.find({ status:{$in:["listed","skipped"]}, set:{$ne:null} }, { set:1, status:1, game:1, "drops.campaign":1, bundleLabel:1 }).lean()`;
      group by `String(set)`; `DropSet.find({ _id:{$in:ids}, publicCatalog:{$ne:false} }).lean()`;
      per set: `summary = unclaimedSummary({ set, ledgers })`; skip when `stock === 0`;
      `category = categoryFor(set)`; if `"Other"` → `set.coverGame || ledgers[0].game || "Other"`;
      `suggested = await unclaimedSuggestedPrice(set, category)` (helper: lazy-require
      unclaimedAutoList; memoise per build `catalogForGames([category])` and
      `MarketResearch.findOne({ game: new RegExp("^"+escape(category)+"$","i") }).lean()`;
      `cls = await classificationForSet(set, catalog)`; `soldFloor = await soldFloorForSet(set._id)`;
      `priceForItems({ research, game:category, items:set.items, cls, pricing:getUnclaimedPricing(), soldFloorUsd:soldFloor }).price`;
      ANY throw → `null`); `retail = max(Number(set.price)||0, suggested||0)`;
      `floor = max(Number(set.minPriceUsd)||0, getUnclaimedPricing().floorUsd, gameFloorFor(category)||0)`;
      listing = `publicListing(set, summary.stock, 0, null, { kind:"unclaimed", delivery:"unclaimed", eventLabel:summary.eventLabel, buyLinks, priceOpts:{ clamp:false, floor, retail } })`.
      Dedupe unclaimed rows with `stockMode:"sum"`.
   f. dedupe the DropLog-backed rows with `dedupeListings(rows.map(r => ({...r, category})), { stockMode:"max" })`
      BEFORE `publicListing`; representative listing gets `mergedCount`, `updatedAt`, and
      `isNew = isNew || isNewAny`.
   g. `listings = [...bundleListings, ...unclaimedListings]`; category aggregation as
      today plus `unclaimedCount` and `unclaimedUnits` per category.
   h. `data.meta = { buildMs, setsScanned, merged, unclaimedSets, unclaimedUnits, preorders }`.
      Public routes keep sending only what they send today (plus nothing from `meta`).
   i. `assertPublicShape(listings)` in try/catch → `console.error` once, never throw.
   j. after a successful build: `savePublicSnapshot(data)` (fire-and-forget).
4. Snapshot: `savePublicSnapshot(data)` = `CatalogSnapshot.updateOne({key:"public"},{$set:{generatedAt:new Date(),data}},{upsert:true})`
   with catch+log. `restorePublicCatalog()` (exported): reads key `"public"`; when `data`
   exists → `publicCache = { at: 0, data }` (served immediately, refreshed in the
   background by the existing stale-while-revalidate path) → resolves `true`, else `false`.
5. `GET /catalog/config` (`catalogReadLimiter`): `{ success:true, contact:{ telegram, discord, replyTime } }`
   from `getCatalogConfig()`; `Cache-Control: public, max-age=60`.
6. `POST /catalog/inquiries`: find the listing in `(await loadPublicCatalog()).listings`
   by `id` (404 otherwise — this replaces the `listed/custom` DropSet gate, so unclaimed
   and merged listings work); `set = DropSet.findById(id).lean()` (404 if missing);
   `minQty = listing.minQty`; `kind = listing.kind`; `unitPrice = listing.price`;
   `preorder = kind==="preorder" && body.preorder===true` (expectedReadyAt as today).
   Create with `kind, unitPrice`. Then Telegram (never blocks the 201 on failure):
   text (plain, no markdown):
   ```
   🛒 Catalog request RQ-XXXXXXXX
   <title>
   Kind: <kind> · Category: <category>
   Qty: <quantity> × $<unitPrice> ≈ $<total>
   Contact: <contact>
   Note: <note or "-">
   Stock now: <listing.stock> (preorder: "~<expectedUnits> expected")
   Admin: <base>/catalog-admin.html
   ```
   `base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}``.
   When `process.env.TG_TOKEN && process.env.TG_CHAT_IDS` → after `await sendTelegram(text)`
   set `notifiedAt = new Date()` on the inquiry.
7. Preorder loop (exported `startPreorderSyncLoop()`, `preorderSyncStatus()`): minutes =
   `getCatalogConfig().preorderSyncMinutes`; 0 → no-op (log). First run after 60 s, then
   `setInterval(run, minutes*60000).unref()`. `run`: skip when `variantSyncJob.running`
   or a run is in progress; `syncActivePreorders({ AutoFarmTask, DropSet, campaignItems: autoLister.campaignItems, derivePrice: autoLister.derivePrice, researchForGame: (game) => MarketResearch.findOne({ game }).lean(), apply:true })`;
   status = `{ running, lastRunAt, lastResult, lastError, intervalMinutes }`;
   `invalidateCatalogCache()` when `stamped || filled`.
8. `PUT /catalog/admin/config` (superadmin + 2fa): body keys
   `contactTelegram, contactDiscord, replyTime, preorderSyncMinutes` → `setCatalogConfig`;
   `invalidateCatalogCache()`; respond `{ success:true, config }`.
9. `adminOverview()`: `adminListings` = every snapshot listing (all kinds) enriched from
   ONE `DropSet.find({_id:{$in:ids}})` (fields `visible, publicTitle, publicDescription, publicPrice, bulkDiscountPct, publicSort`) + hidden listed sets as today (kind `"bundle"`);
   rows add `kind`, `buyLinkCount`, `mergedCount`. `totals` add `unclaimedListings`,
   `unclaimedUnits`, `mergedDuplicates` (`meta.merged`), `preorders`. Response adds
   `meta`, `preorderSync: preorderSyncStatus()`, `config: getCatalogConfig()`; inquiries
   add `kind`, `unitPrice`, `notifiedAt`.
10. `PUT /catalog/admin/listings/:id`: `publicPrice` range `[0, 500]` (keep the
    `< PUBLIC_PRICE_MIN_USD` rejection for non-zero values).
11. Exports add `restorePublicCatalog`, `startPreorderSyncLoop`, `preorderSyncStatus`,
    `savePublicSnapshot`. Existing exports unchanged.

## 8. Agent F — `public/catalog.html`

- `init()` also fetches `/catalog/config` (tolerate failure → no contact links).
- New tokens in BOTH the light `:root` and the `:root[data-theme="dark"]` block:
  light `--unclaimed:#0f766e; --unclaimed-soft:#d9f4ef; --unclaimed-line:#7fd0c3`,
  dark `--unclaimed:#5eead4; --unclaimed-soft:#12302c; --unclaimed-line:#1f5c54`.
- Cards: kind `unclaimed` → `<span class="unclaimed-badge">Unclaimed drops</span>`; meta
  shows `N accounts available` instead of `N in stock`; one-line hint "You link your game
  account and claim". `mergedCount` is not shown.
- Details dialog: eyebrow "Unclaimed drops — you claim them" for unclaimed; a "How
  delivery works" paragraph by `delivery`: claimed → "Rewards are already claimed on the
  Twitch account. Log in and link your game account to receive them."; unclaimed →
  "Rewards are NOT claimed yet. Log in, link your own game account first, then claim —
  they land straight in your game account. This is the right product for Overwatch,
  Rainbow Six, Call of Duty and Marvel Rivals."; when `buyLinks.length` → "Buy a single
  unit now:" with `<a target="_blank" rel="noopener">` per link (label + price).
- Preorder rail + cards: `etaSource==="schedule"` → readyText + " (estimate)";
  `overdue` → "Finishing up — timing being confirmed"; show "Started <relativeTime(startedAt)>".
  Progress bar uses `progressPercent` when present, else hidden. Never a stock number
  or "in stock" on a preorder card.
- Filters: an "Unclaimed drops" chip (`state.kind`) shown only when any listing has
  kind `unclaimed`; category cards show an "N unclaimed" pill when `unclaimedCount>0`.
- Sort: `soldout` rows sink to the bottom in every sort.
- Quote dialog: when `config.contact.telegram` → a secondary button "Message on Telegram"
  (`https://t.me/<handle>?text=<encodeURIComponent("Hi! I'd like to order "+qty+"× "+title+" ("+category+") at "+price+"/unit. Ref: catalog")>`,
  `target="_blank" rel="noopener"`); reply-time line uses `config.contact.replyTime`.
  Footer shows Telegram/Discord when configured. The form stays.
- 375 px: the rail scrolls itself, not the body; buy-link list wraps. Both themes.

## 9. Agent G — `public/catalog-admin.html`

- Stat tiles: "Unclaimed listings / units", "Folded duplicates", "Preorder sync" (last
  run relative time, stamped/filled, or "off").
- Listings table: kind badge (Bundle / Pre-order / Unclaimed), "Links" count, folded count.
- Inquiries: kind + "✓ Telegram" when `notifiedAt`.
- New panel "Storefront contact": Telegram handle, Discord, reply time, preorder sync
  minutes → `PUT /catalog/admin/config`; prefilled from `overview.config`.
- Keep the dark theme mechanism and the existing edit dialog (allow publicPrice up to 500).

## 10. Agent H — `server.js`

In the `server.listen` callback, replace the plain `warmPublicCatalog()` chain with:
`catalogRoutes.restorePublicCatalog()` → log `[catalog] snapshot restored` when true →
then `warmPublicCatalog()` exactly as today → then `catalogRoutes.startPreorderSyncLoop()`
in try/catch (log `[catalog] preorder sync loop started`). Do not touch anything else in
the file (it carries other live, uncommitted wiring).

## 11. Agent T — tests

- `tests/catalogPublic.test.js`: every helper in §3 (title rules 1–4; dedupe rank,
  max vs sum, mergedIds, order, isNewAny; unclaimedSummary held-requires-drops and label
  precedence; buyLinksFor active/https/lowest/cap/labels; scheduleEta normal/overdue/null;
  assertPublicShape throws on a nested `login`).
- `tests/catalogRules.test.js`: make the 4 price tests match the clamp
  (`PUBLIC_PRICE_MIN_USD`/`MAX` are exported), add `clamp:false` + `floor` cases and a
  monotonic non-increasing tiers case.
- `tests/catalogEventSets.test.js`: add "historical sync folds duplicate-signature
  candidates: publishes one, retires the listed mirrors of the rest, reports `deduped`"
  and "concurrent syncActivePreorders calls share one run and stamp
  `requiredWatchMinutes`" using the file's existing fake-model style.
- `node --test tests/catalog*.test.js` must be green.

## 12. Acceptance (verified by the main session)

- [ ] Unclaimed sets with stock appear publicly with kind `unclaimed`, stock = listed+held,
      unclamped price ≥ sold floor; payload leaks nothing private.
- [ ] Public listing count drops from 660 to ≈ 320 with no unit loss on representatives.
- [ ] Preorders carry an ETA (`progress` or `schedule`), `expectedUnits` never 0 when the
      task has accounts; new farm2 tasks are stamped within ~10 min.
- [ ] A quote request raises a Telegram message and stores `kind`/`notifiedAt`.
- [ ] Restart → first request served from the persisted snapshot (no 46 s wait).
- [ ] Titles never repeat the game name twice. Both themes, 375 px clean.
