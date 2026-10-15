# Code shop — review fixes (2026-10-15, before the first deploy)

Three independent reviews (code integrity, live-market safety, security) ran
over the finished branch. These are the decisions taken; they override the
earlier contract where they differ.

## R1. GGSel is not used for codes (this release)

GGSel never says which unit it sold (sold units stay `fed` for ever), the
Listings-page delist of an offer-backed GGSel row releases every `fed` unit
back to `available` and wipes its vault marks (`suppliedStock.releaseClaim`),
and the guardian tops the vault up without the shop seeing it. Any of these can
hand an already-sold code to the next Eldorado buyer. Until GGSel has per-sale
tracking, the code shop sells on Eldorado only:
- `publish.ALLOWED_MARKETS = ["eldorado"]`; a product or config naming `ggsel`
  is refused with: "GGSel is not used for codes yet: it never reports which code
  it sold, so a code could be sold twice".
- `config.validatePatch` refuses `markets.ggsel: true`; DEFAULTS keep `ggsel: false`.
- adopt refuses an offer that has an active (or paused) listing on ANY market
  other than Eldorado ("also listed on <market>").
- The panel hides GGSel switches (Settings, product editor).

## R2. The scheduler never re-creates a listing

`publishPending` publishes a market of an active product only when the product
has NEVER had a `MarketplaceListing` for that market (any status), the product is
not `origin: "adopted"`, and `publish.lastError` is empty. Everything else
(a delisted row, a failed attempt, a timeout) waits for the owner's Publish
button. A failure whose outcome is unknown (timeout, network error, an answer
without an id) says in its error: "check Eldorado for an offer with this title
before publishing again".

## R3. Owner actions run the foreign-stock guard first, inside the tick queue

- `service.exclusive(fn)` runs `fn()` in the same queue as ticks and `runStep`
  (never overlapping), and resolves/rejects with `fn`'s result.
- The routes for approve, publish, resume, retire, adopt (apply) and held-release
  go through `service.exclusive`.
- `publisher.approve` runs `deps.foreign.run()` before it fills; if the guard
  throws, the product is still approved but nothing is filled (the next tick
  does it), and the result says so. Approve fills ONLY the approved product
  (`fill.run({ force: true, productIds: [id] })`).
- Rebalance never dissolves units of `origin: "adopted"` products.

## R4. Covers and texts

- `textGuard.checkBuyerText` refuses an empty `coverTitle` and an empty
  `coverServiceText` ("the cover would fall back to the farming-service text").
- `cover.build` throws when `coverTitle` or `coverServiceText` is empty.
- adopt fills empty cover texts from the defaults (`defaultTexts` with the
  offer's labels and `guideFor`), keeps the offer's own cover texts when set.
- A publish failure sends Telegram only when its error text differs from the
  product's previous `publish.lastError`.

## R5. Product edits never move a price by accident

The edit route updates the `AccountOffer` and the live Eldorado offers only with
the fields that are present in the body AND differ from what is stored. A
price is pushed to Eldorado only when `pricing.priceUsd` changed. An adopted
product cannot switch to `pricing.mode: "auto"` (400).

## R6. Held codes can be released by the owner

New `utils/codeShop/held.js`: `createHeld(deps)` → `{ release(rowId, { actor }) }`.
Releasable problems only: "stored code is missing or changed", "its stock row is
gone", "its code was shown in the farm panel" (R9). The code is re-read and its
hash re-checked first; a row whose code is in any SuppliedAccount (run the
foreign guard's check for that one hash) stays held. Route
`POST /api/code-shop/held/:id/release`; a "Release" button in the Stock tab's
held list (with a confirm saying what the owner is vouching for).

## R7. Replacements

`afterSale.replace` only for a row in state `dead` (mark it dead first), never
hands out a code of a sold farm login, and at most 30 replacements an hour per
process (429 after). The Sold tab enables "Get replacement code" only on dead codes.

## R8. Hardening

- `slots.hashCode` = HMAC-SHA256 with a key derived from `CRED_SECRET`
  (`sha256("code-shop:" + CRED_SECRET)`); never a bare sha256.
- `CODE_SHOP=0` also turns the API off (503 on every route).
- A route error carrying 401/403 from a marketplace is answered as 502 (a 401 to
  the browser would log the owner out).
- `POST /products/:id/scan` at most once per product per 10 minutes (429).
- Competitor price: only offers with `qty >= 1` and a price of at least 30 % of
  our base price count towards `lowestSameSetUsd`.
- The foreign guard also scans `removed` stock rows that carry any market mark,
  tokenises `login`, `email` and `clientSecret` as well, and caps its Telegram
  message at 15 lines + "+ N more".
- `config.get` with no good read yet returns SAFE defaults: every switch that
  writes stock or talks to a market is off (`autoBuildUnits`, `autoDraft`,
  `autoPublish`, `markets.*`, `farmPriority.enabled`, `digest.enabled`,
  `claimAlert.enabled` false; `expiryGuard` stays true).
- The planner stamps new drafts by `draft:<slotSetHash>` (no repeat Telegram when
  a draft is deleted and proposed again).

## R9. Ingest corrections

- A row whose stored code changed (the farm re-claimed a re-issued reward):
  `in_stock` → new hash; `in_unit` with an `available` unit → pull the unit
  (rows of the other codes back to `in_stock`), then the new hash; `sold`/`dead`
  → only an event.
- `expiring` / `expired` rows whose `useBy` moved beyond the lead → `in_stock`.
- An `in_stock` row whose inventory item was revealed in the farm panel
  (`SoopActivity {kind: "reveal", "data.itemId": <item id>}`) → `held` with
  problem "its code was shown in the farm panel".
