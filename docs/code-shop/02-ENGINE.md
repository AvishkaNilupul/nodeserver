# Code shop — stock engine

Facts this rests on (measured on production 2026-10-15):
- Every stored code row carries `claim.dropsName` (the campaign name SOOP
  returned when it was claimed), and it equals `SoopCampaign.titleRaw` of the
  campaign it came from (same `gameNo`). Inventory rows carry no `dropsIdx`.
- One campaign can hand out the same reward name twice (two steps), so a
  reward = campaign + name + order within that login's rewards.
- `raw.useExpDate` (Korea time, `YYYY-MM-DD HH:mm:ss`) is the code's use-by.
  On a claimed row `expiresAt` is the same instant. `raw.expDate` is the
  claim-by date on an unclaimed reward.
- Inventory rows that hold a code are never deleted by the farm.

## `utils/codeShop/slots.js` (pure)

```js
parseKst(s)                       // re-export of utils/soop/normalize.parseKst
hashCode(code)                    // sha256 hex of String(code).trim()
codeShape(code)                   // "25:4-4-5-4-4" — length, then dash-group sizes
groupKeyOf({ gameNo, campaignIdx, campaignName })
  // campaignIdx ? `${gameNo}:${campaignIdx}`
  // : campaignName ? `${gameNo}:n${sha1(campaignName).slice(0,10)}` : `${gameNo}:none`
slotKeyOf(groupKey, nameRaw, ordinal)   // `${groupKey}:${sha1(nameRaw).slice(0,10)}:${ordinal}`
assignOrdinals(rows)
  // rows: [{ loginId, itemKey, groupKey, nameRaw, earnedAt }]
  // -> Map(`${loginId}|${itemKey}` -> ordinal). Within one (loginId, groupKey, nameRaw)
  //    sort by earnedAt asc (null last), then itemKey asc; ordinals start at 1.
slotSetHash(slotKeys)             // sha1 of the sorted unique keys joined by "\n", first 16 hex
useByOf(invRow)                   // parseKst(raw.useExpDate) || (division "acquired" ? expiresAt : null)
isAsciiText(s)                    // only \t \n \r and 0x20–0x7E
```

## `utils/codeShop/ingest.js`

`createIngest(deps)` → `{ run() }` → `{ scanned, added, updated, held, skipped }`.

1. Read `SoopInventoryItem.find({ kind: "code", hasCode: true }).lean()`.
2. Skip rows of a login whose `SoopAccount` exists with `sold: true` (that
   login belongs to a buyer); an existing `in_stock` ledger row of such a login
   becomes `held` with problem `"its farm login was sold"`.
   Logins that are no longer in `SoopAccount` at all keep selling (removed
   logins' codes are kept on purpose).
3. Campaign of a row: `SoopCampaign` with the same `gameNo` and
   `titleRaw === claim.dropsName`, else `title === claim.dropsName`.
   `campaignIdx = c.dropsIdx`, `campaignTitle = c.title || dropsName`,
   `campaignEndAt = c.endDate`. No match → `campaignIdx ""`, title = dropsName.
4. `groupKey`, ordinals over ALL scanned rows, `slotKey`, `useBy = useByOf(row)`.
5. New identity (`{loginId, itemKey}` not in the ledger): decrypt `codeEnc` with
   `deps.secret.decrypt`; empty → `skipped`. Create the row with `codeHash`,
   `codeShape`, state `in_stock` (or `expired` when `useBy <= now`). A
   duplicate-key error on `codeHash` → create it `held`, `codeHash: ""`,
   problem `"same code as another stored code"`. A duplicate on the identity
   (another writer) → skip.
6. Existing identity: `$set` only what changed of `itemId, gameName, name,
   image, campaignTitle, campaignIdx, campaignEndAt, useBy`; `groupKey` and
   `slotKey` are changed only while the row is `in_stock`. Never touch
   `state`, `unit`, `codeHash` here.
7. `events.log` one line when `added > 0` ("N new codes in stock").

## `utils/codeShop/allocate.js` (pure)

```js
freeCounts(free, { now, leadMs })            // Map slotKey -> count of usable free codes
planUnits({ products, free, now, leadMs, maxUnitsPerProduct = 200 })
bestDraftSets(counts, { minUnits, maxSets = 2, fullFirst = true })
```

- `free`: `[{ id, slotKey, useBy: ms|null, earnedAt: ms|null }]` — `in_stock` rows.
  A code is usable when `useBy === null || useBy - leadMs > now`.
- `products`: `[{ id, slots: [slotKey…], createdAt: ms }]` — only ACTIVE products.
  Order: more slots first, then older first, then id.
- Within a slot, codes are taken earliest `useBy` first (null last), then
  earliest `earnedAt`, then id — so the oldest codes go first.
- Returns `{ plans: [{ productId, units: [[codeId per slot, in the product's slot order], …] }], left: Map }`.
  A product gets `min(count of each of its slots)` units (capped). Codes taken by
  one product are gone for the next.
- `bestDraftSets(counts, …)` → `[{ slotKeys, units }]`. Pass 1 with `fullFirst`:
  every slot, if its smallest count ≥ `minUnits`. Otherwise (and for every later
  pass): sort slots by count desc (ties by key); for k = 1..n, `units_k` = the
  k-th count; pick the k with the largest `units_k × k` (tie → larger k) among
  those with `units_k ≥ minUnits`; none → stop. Subtract `units` from the chosen
  slots and repeat until `maxSets` sets.

## `utils/codeShop/units.js`

`createUnits(deps)` → `{ build(product, unitPlans), dissolve(product, { reason, limit }), pull(unitId, { note }) }`;
pure exports `unitText(slots, codes)` and `labelFor(productId, seq)`.

- `unitText(slots, codes)` → `slots.map((s, i) => `${i + 1}) ${s.label} = ${codes[i]}`).join("\n")`.
- `labelFor(id, seq)` → `cs-${String(id).slice(-6)}-${seq}`.
- `build(product, unitPlans)` → `{ built, failed, unitIds }`. Requires
  `product.status === "active"` and `product.offer` (else throws). Per unit, in order:
  1. `unitId = new ObjectId()`;
  2. claim: `CodeStock.updateMany({ _id: {$in: ids}, state: "in_stock" }, { $set: { state: "in_unit", unit: unitId, product, offer, unitStatus: "available" }, $push: history })`.
     If `modifiedCount !== ids.length` → put back every row with `unit: unitId`
     to `in_stock` (clear `unit/product/offer/unitStatus`), count `failed`, next unit.
  3. read each code: inventory row by `{loginId, key: itemKey}`, `decrypt(codeEnc)`,
     `hashCode(code) === codeHash`. Missing or different → put the unit's rows
     back, then mark THAT row `held` (`"stored code is missing or changed"`).
  4. `seq` = `$inc unitSeq` on the product (`returnDocument: "after"`).
  5. `SuppliedAccount.create({ _id: unitId, offer, login: labelFor(...), password: encrypt(unitText(...)), status: "available", conflict: "", note: "code unit" })`.
     Failure → put the rows back.
- `dissolve(product, { reason, limit = Infinity })` → `{ dissolved }`: for each
  `available` unit of the product (from the ledger), atomic
  `SuppliedAccount.updateOne({ _id, status: "available" }, { $set: { status: "removed", note: "code unit — " + reason } })`;
  only when it modified, the unit's rows go back to `in_stock`.
- `pull(unitId, { note })` → `true` when the atomic `available → removed` won.
  Ledger rows are the caller's job.

## `utils/codeShop/reconcile.js`

`createReconcile(deps)` → `{ run() }` → `{ checked, sold, back, held, fed, released }`.

Rows considered: `state in ["in_unit", "sold"]` with `unit != null`. Group by
unit; read the units in one query. Per unit (status → what happens to its rows):

| Unit | Rows become |
| --- | --- |
| missing | `in_unit` rows → `held` (`"its stock row is gone"`); `sold` rows stay |
| `available`, and any row `wasFed` or `unitStatus === "fed"` | atomic unit `available → removed` (note "code unit — came back from a platform vault"); rows → `held` (`"was in a platform vault and came back; it may already be sold"`) |
| `available` | `in_unit`, `unitStatus: "available"` (a `sold` row that comes back here = a released sale) |
| `fed` | `in_unit`, `unitStatus: "fed"`, `wasFed: true` |
| `sold` | `sold`, `soldAt = deliveredAt \|\| soldAt \|\| now`, `market`, `orderId`; `saleUsd` set once = listing price ÷ slot count (listing = `MarketplaceListing {accountOffer: offer, marketplace: market}` newest; fallback product price) |
| `removed`, rows have `pulledAt` | `expiring` (or `expired` once `useBy <= now`) |
| `removed`, no `pulledAt` | `in_stock` (clear unit/product/offer/unitStatus) — or `expiring` when inside the lead time |

Every state change pushes a history entry. Afterwards set each active product's
`useBy` = earliest `useBy` of its `in_unit` rows with `unitStatus "available"`.

## `utils/codeShop/expiry.js`

`createExpiry(deps)` → `{ run() }` → `{ pulled, expiring, expired, vaultWarned }`.
Does nothing when `config.expiryGuard` is false. `lead = expiryLeadHours`.

1. Units holding a row with `useBy <= now + lead` and state `in_unit`:
   - unit `available` → `units.pull(unitId, { note: "code unit — pulled before its codes stop working" })`;
     on success every row of the unit gets `pulledAt = now`; rows inside the
     lead → `expiring`; the others → `in_stock` (free for other units).
   - unit `fed` → one warning per unit (`events.stamp("vault-expiry:" + unitId)`)
     and a Telegram line: the codes sit in a platform vault and must be taken
     down by hand. Nothing is changed.
2. `in_stock` rows inside the lead → `expiring`.
3. `in_stock` / `expiring` rows with `useBy <= now` → `expired`.
4. When anything was pulled: one event per product and ONE Telegram message
   per run ("Took N bundles of <product name> off sale: their codes stop working on <date>").

## `utils/codeShop/games.js`

`GUIDES` keyed by gameNo, plus `GUIDES.default`; `guideFor(gameNo, config)` merges
`config.games[gameNo]` (`displayName`, `marketGame`) over the guide.
A guide: `{ displayName, marketGame, accountWord, howTo: [lines], goodToKnow: [lines], deliveryHelp }`.
- `"12"`: Overwatch 2 / "Overwatch" / "Battle.net"; how-to = battle.net/redeem
  (sign in, enter each code with the dashes, confirm); good-to-know = no
  account linking, one code one account, redeem soon, message us first.
- `"200"`: Delta Force / "Delta Force" / "Delta Force"; how-to =
  playdeltaforce.com/en/cdkredeem.html (character UID + code) or in game
  Events > Other > Exchange Center; codes are case-sensitive; Garena/China
  servers redeem elsewhere; names may read differently in other languages.
- `default`: generic ("Redeem each code on the game's official redeem page or
  in game"), `accountWord: "game"`.
All lines plain ASCII and free of source words.

## `utils/codeShop/texts.js` (pure)

`defaultTexts({ slots, guide, useBy })` → `{ title, description, deliveryTemplate, coverTitle, coverServiceText, coverBullets }`;
`redeemByText(useBy)` → e.g. `"21 October 2026"` = UTC date of `useBy − 24 h`;
`defaultLabel(row)` → `row.name` when it is ASCII and has no source word, else `""`.

- n = slots, labels = slot labels.
- title: n > 1 → `${display} | ${n} Codes Bundle | ${labels.join(" + ")} | Redeem Codes | Instant Auto Delivery`;
  n = 1 → `${display} | ${label} | Redeem Code | Instant Auto Delivery`. Over 160
  chars → drop labels from the end, add `" + more"`, until it fits.
- description: `${display} - Code Bundle (${n} redeem codes)`; when `useBy` is
  within 60 days a line `REDEEM BY ${redeemBy} - the codes stop working after that date.`;
  `YOU RECEIVE ${n} UNUSED REDEEM CODES - ONE OF EACH:` + `- label` lines; the
  bundle/delivery/own-account bullets; `HOW TO REDEEM` + howTo; `GOOD TO KNOW` +
  goodToKnow. Over 2000 → drop good-to-know lines from the end.
- deliveryTemplate: `Thank you for your order! Your ${display} code bundle` +
  (redeem by → ` (redeem by ${redeemBy})`) + `:\n{password}\n\n${deliveryHelp}`.
- cover: `${display} Code Bundle`, `${n} Redeem Code${n>1?"s":""}`, bullets
  `["Instant Automatic Delivery", "${n} Codes - One of Each" (n>1) | "1 Redeem Code", "Redeem on Your Own Account"]`.

## `utils/codeShop/planner.js`

`createPlanner(deps)` → `{ run() }` → `{ groups, created, updated, staled, deleted }`. Skips when `!config.autoDraft`.

1. Ledger rows by `groupKey` (all states) give each slot's meta: label default
   (`defaultLabel`), image, nameRaw, campaignTitle, first `earnedAt`.
2. A group is considered when its game has `config.games[gameNo].sell` and it is
   READY: campaign ended `graceHours` ago, or no new code for `stallHours`, or
   the earliest free `useBy` is within `earlyListDays`.
3. `counts` = `freeCounts` of the group's `in_stock` rows;
   `bestDraftSets(counts, { minUnits, maxSets: maxPerGroup or 1 when !leftovers })`.
4. Per set: a product with the same `slotSetHash` and status ≠ `retired` exists →
   a non-edited draft gets `proposed` updated; anything else is left alone.
   Otherwise create a draft: slots ordered by first `earnedAt` (then nameRaw),
   `kind` = `full` when the set is every slot of the group else `leftover`,
   `name` = `${gameName} - ${campaignTitle} (${n} codes)`, `marketGame` and
   texts from `guideFor`/`defaultTexts`, `pricing` default, `markets: ["eldorado"]`
   filtered by `config.markets`, `proposed = { units, at }`.
   New draft → `events.stamp("draft:" + id)` + one Telegram line.
5. Drafts of a considered group that were not proposed this pass: `origin auto`,
   not `edited` → deleted; `edited` → `stale: true`.

## `utils/codeShop/adopt.js`

`createAdopt(deps)` → `{ candidates(), adopt(offerId, { apply = false, actor = "" }) }`.

A hand-made code offer's units are `SuppliedAccount` rows whose decrypted
`password` is lines `N) Label = CODE` (`/^\s*(\d+)\)\s*(.+?)\s*=\s*(\S+)\s*$/`).

- `candidates()` → active `AccountOffer`s with no product, whose first
  non-removed unit parses → `[{ offerId, title, game, priceUsd, units: {available, fed, sold, removed} }]`.
- `adopt()` runs ingest first, then for every non-removed unit: parse, hash each
  code, find its ledger row. Problems (no row / a row already in another unit /
  units disagreeing on the slot of line N / unparsable unit) → `{ ok: false, problems, report }`
  and nothing is written. `report` = `{ units, codes, slots: [{label, slotKey}], byStatus }`.
- With `apply`: create the product (`origin "adopted"`, `kind "custom"`,
  `status "active"`, `offer`, slots from line order with the offer's labels,
  texts from the offer, `pricing { mode: "fixed", priceUsd: offer.priceUsd, floorUsd: max(0.5, offer.minPriceUsd) }`,
  `markets` = marketplaces of the offer's active listings (eldorado/ggsel only),
  `approvedAt`, `approvedBy: actor`); link each code row to its unit (`state "in_unit"`,
  `unit`, `product`, `offer`), then `reconcile.run()` settles sold/fed. Idempotent:
  a product that already owns the offer is reused. Removed units are ignored.
