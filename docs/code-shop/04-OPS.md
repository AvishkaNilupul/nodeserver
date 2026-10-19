# Code shop — operations (alerts, digest, after-sale, farm, views, service, API, panel)

## `utils/codeShop/claimAlert.js`

`createClaimAlert(deps)` → `{ run() }` → `{ due, told }`. Off when `!config.claimAlert.enabled`.
- Due = `SoopInventoryItem {division: "available", expiresAt: {$gt: now, $lte: now + leadHours}}` (every kind).
- New = due rows without the stamp `claim-due:<loginId>|<key>` (`events.has`).
- When there are new ones: ONE Telegram message — first line
  `"<n> farm reward(s) expire unclaimed within <lead> h"`, then up to 15 lines
  `"- <gameName>: <name> on <loginId> (by <YYYY-MM-DD HH:mm> UTC)"` + `"+ N more"`,
  then `"Code rewards are claimed by themselves while the login works; in-game and link rewards need a click in the farm panel."`.
  Stamp every new row ONLY after the send succeeded (a failed send retries next tick).
  (`events` gets `has(key)` → Boolean, in addition to `stamp`.)

## `utils/codeShop/digest.js`

Pure `digestText(d)`; `createDigest(deps)` → `{ run({ force = false }) }` → `{ sent, text? }`.
Runs when `config.digest.enabled`, the UTC hour ≥ `hourUtc` and
`lastSentDay !== today (UTC YYYY-MM-DD)`, or `force`. After a successful send:
`config.set({ digest: { lastSentDay: today } })`.

`d` = `{ day, earned: [{game, n}], sold: {units, usd, byProduct: [{name, units, usd}]}, onSale: {units, products}, expiring: [{name, units, useBy}], drafts, held, loginsDown, inStock }`.
Text (plain, ≤ 25 lines): title line `Code shop - <day>`, then
`Earned (24 h): …`, `Sold (24 h): N bundles, $X` (+ up to 5 product lines),
`On sale: N bundles in M products`, `Expiring within 3 days: …` (only if any),
`Drafts waiting for you: N` (only if any), `Held for checking: N` (only if any),
`Farm logins down: N` (only if any), `Free codes not in any bundle: N`.

## `utils/codeShop/afterSale.js`

`createAfterSale(deps)` → `{ sold({ limit = 100, productId }), report(unitId, { slot, status, note, actor }), replace(unitId, { slot, actor }) }`.

- `sold()` → newest first `[{ unitId, product, productName, market, orderId, soldAt, usd, codes: [{ slot, label, codeShape, state, after }] }]`
  from ledger rows in state `sold` / `dead` (slot = index in the product's slots).
- `report()`: `status` is `"dead"` or `"ok"`; the row at that slot must be `sold`
  or `dead`. `dead` → state `dead`, `after = { status: "dead", note, at, by }`;
  `ok` → state `sold`, `after.status "ok"`. Returns the row view.
- `replace()`: the row at that slot must be `sold` or `dead` and not already
  `after.status "replaced"`. Candidate = an `in_stock` row with the same `slotKey`
  (usable: `useBy` beyond the lead), else same `gameNo` + `nameRaw`, oldest
  `useBy` first. Atomic `{ _id, state: "in_stock" } → state "sold", soldAt: now, market: "replacement", after: { status: "replacement", ref: original, by, at }`.
  Read the code (inventory `codeEnc`, hash check); failure → put it back
  `in_stock`, error. Original → `after { status: "replaced", ref: replacement, by, at }`.
  Returns `{ code, label, codeShape }` — the ONLY API that returns a code. The
  event logs label + shape, never the code.

## `utils/codeShop/farmPriority.js`

`createFarmPriority(deps)` → `{ run() }` → `{ changed: [{ botId, from, to }], top, scores }`.
Off unless `config.farmPriority.enabled` and `botIds` non-empty; also waits
`minHoursBetween` after `lastChangeAt`.
- Candidate games: `SoopCampaign` with `giveCon: "term"`, an `itemList` item of
  `itemType "1"` (code), `endDate > now`, `startDate <= now + 24 h`, and
  `config.games[gameNo].sell`.
- Score = distinct units sold in the last 14 days for that gameNo (ledger) + 1.
  Highest wins; a tie keeps the bot's current priority when it is among the tied
  games, else the lower gameNo.
- For each bot id: an active `auto`-mode bot whose `priorityGameNo` differs →
  `farm().updateBot(id, { priorityGameNo: top })`. On a change:
  `config.set({ farmPriority: { lastChangeAt: now } })`, event, one Telegram line.

## `utils/codeShop/views.js`

`createViews(deps)` → `{ state(), product(id), stock(), logins(), events(q) }`. All lean, no secrets.
- `state()` → `{ config, summary, products, adoptable: n, lastTick }` where
  `summary = { inStock, onSale, inVault, sold, expiring, expired, held, dead, drafts, revenue: { d1, d7, d30, all } }`
  (onSale/inVault = rows `in_unit` by `unitStatus`; revenue = Σ `saleUsd` of
  `sold`+`dead` rows by `soldAt`), and `products` = every non-retired product:
  `{ id, name, status, origin, kind, gameNo, gameName, slots: [{label, image}], units: {available, fed, sold, removed}, freeUnits (what fill could still build now), proposed, useBy, pricing, markets, listings: [{ market, externalId, url, price, status, autoPaused, lastError }], competitors: { scannedAt, lowestSameSetUsd, count, accounts: { count, qty, lowestUsd } | null }, publish, problems }`.
- `product(id)` → the same plus `texts`, full `competitors.offers` and slot keys.
- `stock()` → by game → group → slot: `{ label, nameRaw, image, counts: {in_stock, in_unit, sold, expiring, expired, held, dead}, nextUseBy }`, plus a `held` list `[{ loginId, label, problem }]`.
- `logins()` → per loginId `{ codes, inStock, onSale, sold, usd, lastEarnedAt }`.

## `utils/codeShop/service.js`

`createService(deps?)` (missing deps filled with the real ones, `01-DATA.md`) →
`{ start(), stop(), tick(), runStep(name), modules, lastTick() }`; module export
`{ createService, service }` where `service` is the lazily-built singleton.

- `start()`: does nothing when `process.env.CODE_SHOP === "0"`. First tick after
  90 s, then every 5 min (`setInterval(...).unref()`), never two ticks at once.
- `tick()` order, each step in its own try/catch (an error is an event and the
  next step still runs): `ingest → reconcile → expiry → claimAlert → fill →
  plan → publishPending → autoPublish → pricing (hourly) → scan (one product
  per tick, when its scan is older than everyHours) → digest → farmPriority (hourly)`.
  - `publishPending`: active products with a market (allowed + enabled) that has
    no active row, a shelf ≥ 1, and `publish.lastAttemptAt` older than 30 min
    (6 h when `lastError` names the offer limit) → `publishProduct`.
  - `autoPublish` (only `config.autoPublish`): drafts with no `problems`,
    `proposed.units >= drafts.minUnits`, not `stale` → `approve(id, { actor: "auto" })`.
- `lastTick()` → `{ at, ms, steps: { name: summary | { error } } }`.
- `runStep(name)` runs one step now (`all` = a whole tick).

## `routes/codeShopRoutes.js`

`express.Router()`; every route `requireSuperadmin`, JSON, answers
`{ success: true, ... }` or `{ success: false, message }` with a 4xx/5xx. Prefix
`/api/code-shop`. The router takes the service via `createCodeShopRoutes({ service })`
and the module also exports a router built on the singleton.

| Method | Path | Body / query | Does |
| --- | --- | --- | --- |
| GET | `/state` | | `views.state()` |
| GET | `/products/:id` | | `views.product()` |
| POST | `/products` | `{ slotKeys[], name? }` | new custom draft (same game only) |
| POST | `/products/merge` | `{ ids[] }` | custom draft with the union of their slots (same game); auto drafts merged are deleted |
| POST | `/products/:id` | `{ name, texts, labels[], slotOrder[], removeSlots[], pricing, markets, ggsel, note, pushLive }` | edit. Slots (labels/order/remove) only on drafts. On an active product texts/pricing also update its `AccountOffer`; `pushLive` also edits live Eldorado offers (`mp().eldoradoUpdateOffer(id, { title, description, priceUsd })`) |
| DELETE | `/products/:id` | | drafts only |
| POST | `/products/:id/approve` | `{ rebalance, publish }` | `publisher.approve` |
| POST | `/products/:id/publish` | | `publisher.publishProduct` |
| POST | `/products/:id/pause` · `/resume` · `/retire` | | publisher |
| POST | `/products/:id/scan` | | `competitors.scan` |
| POST | `/products/:id/texts/reset` | | regenerate default texts (drafts) |
| GET | `/stock` · `/logins` | | views |
| GET | `/sold` | `?limit&product` | `afterSale.sold` |
| POST | `/units/:id/report` | `{ slot, status, note }` | `afterSale.report` |
| POST | `/units/:id/replace` | `{ slot }` | `afterSale.replace` (sets `Cache-Control: no-store`) |
| GET | `/adopt/candidates` | | `adopt.candidates` |
| POST | `/adopt` | `{ offerId, apply }` | `adopt.adopt` |
| POST | `/config` | patch | `config.set` (400 on a bad patch) |
| POST | `/run` | `{ step }` | `service.runStep` |
| GET | `/events` | `?limit&kind&product` | `events.recent` |

Wiring in `server.js`: `app.use(enforce2fa, codeShopRoutes)` next to the farm
routes, and `codeShop.start()` right after `soopCookieRefresher.start()`.

## Panel — "Sales" tab (`public/soop/`)

`soop.html` gets a seventh tab button `sales` ("Sales") + its panel root + the
script tags. Files (each small): `tab-sales.js` (registers the tab, sub-nav,
polling `/api/code-shop/state` every 20 s while visible, shared helpers on
`window.SoopSales`), `sales-products.js` (product cards + draft editor drawer +
approve/publish/pause/resume/retire), `sales-stock.js` (stock by game/campaign/slot,
"make a bundle from selected slots", held list), `sales-sold.js` (sold bundles,
mark a code dead/ok, get a replacement code once), `sales-settings.js`
(switches, games, markets, lead time, digest hour, farm priority, adopt existing
offers, run a step now, activity log). Follow `public/soop/UI-KIT.md` and the
`Soop.ui.*` helpers; the API calls use `fetch` on `/api/code-shop/...` with
`credentials: "same-origin"` (Soop.api prefixes `/api/soop`).

## Farm changes (existing files)

1. **New logins join a bot by themselves.** `SoopFarmTask.autoJoin: Boolean = false`.
   `createBot` / `updateBot` accept `autoJoin` (routes pass `flag(body.autoJoin)`),
   `botView` returns it. `soopFarm.importAccounts` ends with
   `await this._autoJoin(okIds)`: ids that are in NO bot are added to the first
   active `autoJoin` bot (oldest first) through `updateBot(id, { addIds })`, with
   one activity row. The bot wizard and bot drawer get the checkbox
   "New logins join this bot automatically".
2. **Join on time.** `farmBots.js`: `WATCH_START_MS = 30000`, `START_GRACE_MS = 600000`;
   `_cadence` looks every 30 s from 2 min before a candidate's start to 10 min
   after it. `soopFarm._parked`: inside that same window a held campaign cools
   down `timings.parkCooldownStartMs ?? PARK_COOLDOWN_START_MS (60000)` instead
   of 3 min. Outside the window nothing changes.
3. **Twitch link for cookie renewal.** `accountView` adds `twitchLogin`,
   `renewedAt`, `renewError`; the account drawer gets a "Cookie renewal" block:
   the linked Twitch login (input + Save → `POST /api/soop/accounts/twitch-link`),
   last renewal / error, and "Renew now" (`POST /api/soop/accounts/renew`).
