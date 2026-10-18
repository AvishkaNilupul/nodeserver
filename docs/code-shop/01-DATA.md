# Code shop — data (models, config, events, wiring)

## `models/CodeStock.js` — the ledger (collection `codestocks`)

One row per stored code. Identity = the inventory row's `{loginId, key}`
(`SoopInventoryItem` ids can change when SOOP re-lists a row; `{loginId, key}`
does not). Timestamps on.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `loginId` | String, required, index | | farm login holding the code |
| `itemKey` | String, required | | `SoopInventoryItem.key` |
| `itemId` | ObjectId | null | current `SoopInventoryItem._id` (refreshed by ingest) |
| `gameNo` | String, index | "" | |
| `gameName` | String | "" | farm's game name |
| `groupKey` | String, index | "" | campaign group, see `slots.js` |
| `campaignIdx` | String | "" | `SoopCampaign.dropsIdx` when found |
| `campaignTitle` | String | "" | English campaign title, else the claim's `dropsName` |
| `campaignEndAt` | Date | null | |
| `slotKey` | String, index | "" | which reward of the campaign, see `slots.js` |
| `nameRaw` | String | "" | reward name as SOOP sent it |
| `name` | String | "" | glossary-translated name |
| `image` | String | "" | reward image URL |
| `codeHash` | String | "" | sha256 hex of the code (never the code) |
| `codeShape` | String | "" | e.g. `25:4-4-5-4-4` (length + dash groups) |
| `earnedAt` | Date | null | inventory `sentAt` |
| `useBy` | Date | null | last instant the code can be redeemed |
| `state` | enum `in_stock in_unit sold expiring expired held dead`, index | `in_stock` | |
| `unit` | ObjectId (SuppliedAccount), index | null | |
| `product` | ObjectId (CodeProduct), index | null | |
| `offer` | ObjectId (AccountOffer) | null | |
| `unitStatus` | String | "" | last seen `SuppliedAccount.status` |
| `wasFed` | Boolean | false | its unit was ever seen `fed` (platform vault) |
| `pulledAt` | Date | null | the expiry guard took its unit off sale |
| `soldAt` | Date | null | |
| `market` | String | "" | |
| `orderId` | String | "" | |
| `saleUsd` | Number | 0 | this code's share of the unit's sale price |
| `problem` | String | "" | why it is `held` |
| `after` | `{status, note, at, by, ref}` | `{status:""}` | after-sale: `ok dead replaced replacement` |
| `history` | `[{at, from, to, why}]` | [] | last 20 transitions (`$push` + `$slice: -20`) |

Indexes: unique `{loginId:1, itemKey:1}`; unique `{codeHash:1}` with
`partialFilterExpression: {codeHash: {$type: "string", $gt: ""}}`;
`{state:1, slotKey:1}`; `{product:1, state:1}`; `{unit:1}`.

## `models/CodeProduct.js` — a sellable bundle (collection `codeproducts`)

Timestamps on.

| Field | Type | Default |
| --- | --- | --- |
| `name` | String | "" — internal name shown in the panel |
| `gameNo` | String, index | "" |
| `gameName` | String | "" |
| `marketGame` | String | "" — what `AccountOffer.game` / Eldorado's game gets |
| `groupKeys` | [String] | [] — groups its slots come from |
| `slots` | `[{slotKey, label, image, nameRaw, campaignTitle}]` | [] — order = order in the buyer text |
| `slotSetHash` | String, index | "" — `slots.slotSetHash(slotKeys)` |
| `status` | enum `draft active paused retired`, index | `draft` |
| `origin` | enum `auto adopted manual` | `auto` |
| `kind` | enum `full leftover custom` | `full` |
| `edited` | Boolean | false — the owner changed a draft (planner keeps it) |
| `stale` | Boolean | false — planner no longer proposes this draft |
| `offer` | ObjectId (AccountOffer) | null |
| `unitSeq` | Number | 0 — label counter (`$inc`) |
| `texts` | `{title, description, deliveryTemplate, coverTitle, coverServiceText, coverBullets:[String]}` | all "" / [] |
| `pricing` | `{mode:"fixed"\|"auto", priceUsd, floorUsd, clearance:Boolean, followCompetitors:Boolean, lastChangeAt:Date, lastReason:String}` | `{mode:"fixed", priceUsd:1, floorUsd:0.5, clearance:false, followCompetitors:false}` |
| `markets` | [String] | `["eldorado"]` |
| `ggsel` | `{vaultSize:Number}` | `{vaultSize:5}` |
| `publish` | `{lastError:String, lastAttemptAt:Date}` | `{lastError:""}` |
| `competitors` | `{scannedAt, queries:[String], lowestSameSetUsd:Number\|null, offers:[{id,title,priceUsd,qty,score,sameSet,matchedIn,form}]}` | `{offers:[]}` |
| `useBy` | Date | null — earliest `useBy` of its on-sale codes |
| `proposed` | `{units:Number, at:Date}` | `{units:0}` — planner's estimate |
| `approvedAt`, `approvedBy`, `retiredAt` | | null / "" |
| `note` | String | "" |

`markets` may only contain `eldorado` and `ggsel` (schema validator).

## `models/CodeShopConfig.js` (collection `codeshopconfigs`)

`{ key: String unique (always "main"), data: Mixed, updatedBy: String, updatedAt: Date }`.
The effective config is `deepMerge(DEFAULTS, doc.data)`.

## `utils/codeShop/config.js`

```js
const DEFAULTS = {
  autoBuildUnits: true,   // grow stock of ACTIVE products from new codes
  autoDraft: true,        // planner writes draft products
  autoPublish: false,     // publish a ready draft without the owner
  expiryGuard: true,
  expiryLeadHours: 36,
  markets: { eldorado: true, ggsel: false, playerauctions: false }, // PlayerAuctions: 06-PLAYERAUCTIONS-PLAN.md
  games: {
    // gameNo -> { sell, marketGame, displayName }; unknown games do not sell
    "12": { sell: true, marketGame: "Overwatch", displayName: "Overwatch 2" },
    "200": { sell: true, marketGame: "Delta Force", displayName: "Delta Force" },
  },
  ready: { graceHours: 4, stallHours: 24, earlyListDays: 7 },
  drafts: { minUnits: 3, maxPerGroup: 2, leftovers: true },
  pricing: {
    clearanceSteps: [ { days: 7, cutPct: 0 }, { days: 3, cutPct: 25 }, { days: 1, cutPct: 50 } ],
    cooldownHours: 6,
    undercutUsd: 0.01,
    playerauctionsUsd: 5, // one fixed PlayerAuctions price for every bundle, never under 5
  },
  competitorScan: { enabled: true, everyHours: 12 },
  ownEldoradoUserIds: [],
  sourceWords: [ "soop", "afreeca", "korea", "\\bkr\\b", "translated", "official [^.\\n]*event", "stage\\s*\\d", "kakao" ],
  claimAlert: { enabled: true, leadHours: 24 },
  digest: { enabled: true, hourUtc: 3, lastSentDay: "" },
  farmPriority: { enabled: false, botIds: [], minHoursBetween: 6, lastChangeAt: null },
};
```

API: `createConfig({ model, now = Date.now, memoMs = 30000 })` →
- `get({ fresh = false })` → effective config (memoised `memoMs`; a DB error
  returns the last good value, or `DEFAULTS` if none — never throws).
- `set(patch, { actor = "" })` → validates with `validatePatch`, deep-merges
  into `data` (arrays are replaced, not merged), saves, clears the memo, returns
  the new effective config. Throws `Error` with `.status = 400` on a bad patch.
- `forget()` clears the memo.

`validatePatch(patch)` → `{ ok, errors[] }` — pure. Rules: only keys present in
`DEFAULTS` (any depth, except `games` whose keys are game numbers `^\d+$`);
booleans stay booleans, numbers are finite and ≥ 0, `hourUtc` 0–23,
`expiryLeadHours` 0–720, `cutPct` 0–90, `markets` only `eldorado`/`ggsel`,
`sourceWords` each a valid regex source. Exported: `{ DEFAULTS, createConfig, validatePatch, deepMerge }`.

## `models/CodeShopEvent.js` + `utils/codeShop/events.js`

Model: `{ at: Date (index, TTL 30 days via expires), level: "info"|"warn"|"error",
kind: String, product: ObjectId|null, msg: String (≤500), data: Mixed,
stampKey: String }` with unique partial index on `stampKey` (string, non-empty).

`createEvents({ model, now = Date.now })` →
- `log({ level = "info", kind, product = null, msg, data = null })` — never
  throws (a write error goes to `console.error`); also `console.log("[code-shop] " + msg)` for warn/error.
- `recent({ limit = 100, kind, product, level })` → newest first, lean.
- `stamp(key, { kind = "stamp", msg = "" } = {})` → `true` when this call created
  the stamp, `false` if it already existed (duplicate key error 11000).
- `has(key)` → `true` when a stamp with that key exists.

## Wiring (`service.js` builds one `deps` object)

```js
deps = {
  models: { CodeStock, CodeProduct, CodeShopConfig, CodeShopEvent,
            SoopInventoryItem, SoopCampaign, SoopAccount, SoopFarmTask,
            AccountOffer, SuppliedAccount, MarketplaceListing },
  secret: require("../secretBox"),          // { encrypt, decrypt }
  mp: () => require("../marketplaces"),       // lazy
  stock: () => require("../suppliedStock"),   // lazy
  category: () => require("../listingCategory"),
  setImage: () => require("../setImage"),
  farm: () => require("../soopFarm"),
  telegram: { send: async (text) => /* utils/telegram.sendTelegram; throws if nothing sent */ },
  fetch: globalThis.fetch,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  config,   // createConfig(...)
  events,   // createEvents(...)
}
```

Every `createX(deps)` module reads only what it needs from `deps`; tests pass
small fakes. Lazy entries (`mp`, `stock`, …) are functions so a test that never
publishes never loads `utils/marketplaces`.
