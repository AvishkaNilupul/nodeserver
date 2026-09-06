# Eldorado.gg integration — feasibility + build contract

**Status:** FULLY VERIFIED LIVE 2026-09-06 against the real seller account (AkariStore).
Create / reprice / pause / resume / delete / image-upload all executed successfully and cleaned up.
**Model:** ZeusX-style private-API integration (`utils/marketplaces.js`), NOT a Z2U browser bridge.

## 0. Verified contract (the part you can build against)

Account state at time of writing: **AkariStore**, verified seller, 100% feedback (20 ratings),
41 completed orders, 11 CustomItem offers, 10% fee on gameId 235, delivery median 00:03:27.

### Create an offer — `POST /api/v1/item-management/me/offers/item` → **201**

The payload is TWO wrappers, `details` + `augmentedGame`. Flat payloads are rejected with
`"The following properties have invalid values: Details, AugmentedGame."`

```jsonc
{
  "details": {
    "offerTitle": "…",                       // max 160 chars
    "description": "…",                      // max 2000 chars, optional per UI but always send it
    "tradeEnvironmentValues": [              // REQUIRED — and must ALSO be set on augmentedGame
      { "id": "0", "name": "Game", "value": "Rust" }
    ],
    "offerAttributeIdValues": [],
    "attributes": [],
    "guaranteedDeliveryTime": "Minute20",    // Minute20 | Hour1 | Hour2 | Hour3 | Hour5 | Hour8 | Hour12 | Day1 …
    "pricing": {                             // REQUIRED nested object — NOT flat pricePerUnit
      "pricePerUnit": { "amount": 0.5, "currency": "USD" },
      "quantity": 1,
      "minQuantity": 1,
      "volumeDiscounts": []                  // [{ "quantity": 3, "percentage": 2 }, …]
    },
    "mainOfferImage": {                      // REQUIRED — "Offer main image is missing." otherwise
      "smallImage":        "<userId>_Offer_<ts>_<rand>Small.png",
      "largeImage":        "<userId>_Offer_<ts>_<rand>Large.png",
      "originalSizeImage": "<userId>_Offer_<ts>_<rand>Original.png"
    },
    "offerImages": []                        // up to 4 extra, same triple shape
  },
  "augmentedGame": {
    "gameId": "235",
    "category": "CustomItem",
    "tradeEnvironmentId": "0"                // REQUIRED, duplicates details.tradeEnvironmentValues[0].id
  }
}
```

Server fills in on create: `id`, `offerState: "Active"`, `offerVersion: 0`, and
**`expireDate` ≈ 3 weeks out (auto)** — we never send it.

### Upload the image FIRST — `POST /api/files/me/Offer` → **200**

`multipart/form-data`, single field named **`image`** (png/jpeg/heic, ≤10 MB, ~800×800 recommended).
Scope segment must be `Offer` or `offer`; anything else → `"invalid values: type"`.

```jsonc
{ "localPaths": [ "/offerimages/…Small.png", "/offerimages/…Large.png", "/offerimages/…Original.png" ] }
```

Strip the `/offerimages/` prefix — `mainOfferImage` takes **bare filenames**.

### Manage — all verified live

| call | verb + path | body | result |
|---|---|---|---|
| read back | `GET  /api/v1/item-management/me/offers/{id}/private` | — | full offer (this is the read model, NOT `/details`) |
| list mine | `GET  /api/v1/item-management/me/offers/me/search?pageIndex=1&pageSize=30` | — | POST returns 405 |
| reprice | `PUT  /api/v1/item-management/me/offers/{id}/price` | `{"amount":0.75,"currency":"USD"}` | 200, echoes new price |
| update | `PUT  /api/v1/item-management/me/offers/item/{id}/details` | same DTO as create | — |
| pause | `POST /api/v1/item-management/me/offers/{id}/pause` | — | 200, state→Paused, version+1 |
| resume | `POST /api/v1/item-management/me/offers/{id}/resume` | — | 200, state→Active, version+1 |
| delete | `DELETE /api/v1/item-management/me/offers/{id}` | — | **204**, then `/private` → 404 |
| counts | `GET /api/v1/item-management/me/offers/count` · `/state-count` | — | per-category / per-state |

`offerVersion` increments on every mutation — useful as an optimistic-concurrency check.

### Auth + CSRF (the thing that bites)

- Session lives in **httpOnly cookies**; `POST /api/authentication/refreshTokens` takes **no body**
  and renews from the cookie. That is the auto-renew lever.
- Every **mutating** call needs header **`X-XSRF-Token`** whose value is the
  **`__Host-XSRF-TOKEN`** cookie (URL-decoded, 64 chars). Note the `__Host-` prefix — reading a
  plain `XSRF-TOKEN` cookie yields nothing and every write 403s with
  `"XSRF header tokens are missing or invalid."`
- GETs work with just a cookie jar.
- `GET /api/authentication/claims` is a cheap session-health probe.

### Selling / delivery — `GET /api/orders/me/seller/orders?pageIndex=1&pageSize=N` → 200

Order fields we need: `id`, `offerId`, `buyerId`, `buyerUsername`, `purchaseQuantity`,
`totalPrice`, `state{state,createdDate}`, `stateLogs[]`, `deliveryStartedDate`,
`orderOfferDetails{offerTitle,tradeEnvironmentId,orderPricing,…}`, `isWithWarranty`, `latestDispute`.
States: `Initialized → Paid → Delivered → Completed`; also `Canceled`, `Disputed`, `Received`.

Poll: use the **v1 filtered query in §1b(b)** — `orderState=Paid` server-side, cursor-paginated.
`GET /api/orders/me/statesCount` → `{canceled, completed, delivered, disputed, paid, received}`
still works as an even cheaper "is there anything new" pre-check.

Mark delivered: `PUT /api/orders/me/{orderId}/deliver` — **no body**. Verified present; fires after
the credential has actually been handed over.

#### ⚠️ The credential hand-over is the ONE hard part — corrected 2026-09-06

An earlier draft of this doc claimed `POST /api/v1/conversation-management/me/conversations/order/
{orderId}/quick-reply` was the delivery channel. **That is wrong.** Reading the component that calls
it (`chunk-TIHPJNTN.js`): quick-reply belongs to the TalkJS **nudge** A/B experiment
(`OR_TALKJS_NUDGE_ENABLED` / `OR_TALKJS_NUDGE_QUICK_REPLY`). It is fired from a `quickReply` **URL
query param** (i.e. a link in a notification email), is guarded by a `quickReplySent` one-shot flag,
and the server returns **409 `"Message already sent."`** on a repeat. It is a canned reply to a
nudge, not a messaging API.

Real hand-over path, confirmed by inspecting a live delivered order (Paid 12:20:03 → Delivered
12:26:33, 6m30s, seller pasted `login:password` into the chat): **the credential goes through the
TalkJS chat**, which is a cross-origin iframe (`app.talkjs.com/app/49mLECOW/user/…/chatbox/…`).

What we have for it:
- `GET /api/conversations/me/authorize` → `{ token }` — a TalkJS JWT for our user.
- TalkJS appId `49mLECOW`; per-order `conversationId` comes from the order page's chat params.
- TalkJS client transport is a **websocket** plus `app.talkjs.com/api/v0` — undocumented for
  third-party server use. `cdn.talkjs.com/talk.js` exposes `sendMessage` over that transport.

Options, best first:
1. **Hybrid (ship this first).** Server detects the paid order, reserves the leanest matching
   account, renders the exact delivery text, and pushes it to Telegram for a one-tap paste. Takes
   the 6m30s median to well under a minute with zero fragile dependencies. Everything except the
   final paste is automated, and the same code path is reused by options 2/3 later.
2. **Drive TalkJS with the user token.** Replay the SDK's websocket/`api/v0` send. Fully hands-off
   and would match GosMachine's 35s median, but it is an undocumented third-party protocol that can
   change without notice — needs a real send test on a live order to validate, and a fallback.
3. **Headless-browser worker** (Playwright) that opens the order page and types into the chatbox.
   Survives protocol changes, but is a heavyweight component to host and babysit.
4. ~~Wait for the official Seller API.~~ **CHECKED AND RULED OUT** — see §1b. The full 125-path
   spec contains no messaging endpoint of any kind, and the 50-order gate only unlocks the docs.
   There is nothing coming that fixes this; do not wait on it.

Sequencing rule: **never call `/deliver` before the credential has actually reached the buyer.**

### Ruled out

- **Native auto-delivery is Roblox-only.** `POST /api/v1/item-management/me/offers/auto-delivery/
  is-eligible` → `{"isEligible": false, "canLinkMultipleAccounts": false}`, and the surrounding
  service (`chunk-SRY5POOO.js`) is an in-game Roblox bot flow: `v1/item-management/me/auto-delivery/
  {id}/session`, `/username`, `/sessions/{id}/friendship-check`, plus
  `v1/item-management/me/roblox-accounts/*` and `robloxAccountLinkIds` on the offer object.
  Eligibility keys off `itemType`/`itemName` attributes. It is a Roblox trading bot, **not** a
  credential vault, so it can never deliver a Twitch account. Chat delivery is the only path.
- **Bulk CSV**: `GET /api/offerUser/me/csvUploadExample?gameId=235&category=CustomItem`
  → 400 `"Category CustomItem is not supported."` Per-offer creates only.
- **Official Seller API**: `GET /api/orders/me/sellerApiEligibility` → `{"isEligible": false}`.
  Needs 50 completed orders; we are at **41**. Nine more and we can email api@eldorado.gg and
  drop the private-API dependency.


## 1b. The official Seller API — checked 2026-09-06. Verdict: same API, just documented.

**The full spec is readable right now with a logged-in session** (it 403s to anonymous curl):

- Swagger UI: `https://www.eldorado.gg/swagger/seller/index.html` → 200 with cookies
- Spec: **`https://www.eldorado.gg/swagger/seller/swagger.json`** → 200, ~369 KB,
  `info.title = "Eldorado Seller API"`, **125 paths**, `servers: [https://www.eldorado.gg/]`

Key conclusions:

1. **It is not a separate or better API.** Same host, same paths we already reverse-engineered.
   `components.securitySchemes` is absent; every operation is just tagged `(Auth)` and takes a
   required `swagger` header (default literal `"Swager request"` — their typo). Sending that header
   changes nothing — tested with and without, byte-identical responses.
2. **The 50-order gate unlocks the DOCS, not capability.** `GET /api/v1/orders/me/seller-api-docs`
   → **403**; `…/seller-api-eligibility` → `{"isEligible": false}`. But the v1 endpoints themselves
   already answer for us today: `GET /api/v1/item-management/me/offers/me/search?pageIndex=1&pageSize=2`
   → **200** with our 11 offers. So there is nothing to wait for — and we have the spec anyway.
3. **It does NOT solve credential delivery.** Across all 125 paths there is **no** message, chat,
   conversation or delivery-content endpoint for item orders. Order operations are only:
   `deliver`, `cancel`, `extend-delivery-time`, `delivery-details/correction`, plus reads.
   The TalkJS problem in §"credential hand-over" stands unchanged.

### Three things it did give us

**a) Restock — the most important thing we were missing.**
`PUT /api/v1/item-management/me/offers/{offerId}/quantity`, request body is a **bare JSON integer**
(`50`), not an object. Lets the farm sync stock without rewriting the offer.

**b) A proper paid-order poll (verified 200, cursor-paginated).**
```
GET /api/v1/orders/me/seller/orders
      ?displayFilter=DisplaySellingOrders
      &orderGroup=Regular          # Regular | Historical
      &orderState=Paid             # Paid|Disputed|Delivered|Received|Completed|Canceled|PendingReview
      &pageSize=50                 # max 50
      &pageDirection=Next
```
Returns `{cursor, pageDirection, previousPageCursor, nextPageCursor, pageSize, results}`.
`displayFilter` is **required** (omit it → 400 `"invalid values: DisplayFilter"`).
This replaces the `statesCount` + full-list poll — filter server-side for `Paid` and act on the rows.

**c) A real credential vault — but on the wrong category.**
`flexibleOffers` (the **Accounts** category) has full CRUD on a stored-credential collection:
`GET/POST /api/flexibleOffersUser/me/offers/{offerId}/secretDetails` (201 on add) and
`PUT/DELETE …/secretDetails/{accountDetailsId}` (200 / 204). That is exactly the ZeusX-style vault
that would give us native auto-delivery.

**It is structurally unavailable to us as things stand:** `gameId 235` exists in the library **only**
as `CustomItem`, and there is no Twitch entry anywhere under `Account`. So the vault cannot be
attached to a Twitch Drops offer.

> **Strategic option worth a decision later:** we *could* list the accounts under a specific game's
> **Accounts** category to get native vault auto-delivery. But that trades away the Twitch Drops
> category, which is where the 2,486 live offers and the actual buyers are, and puts us next to
> real game-account sellers. Probably not worth it — but it is the only path to hands-off delivery
> that does not involve TalkJS.


## 2. Category mapping (this is the good news)

Eldorado has a **dedicated Twitch Drops category** — exactly our product:

| field | value |
|---|---|
| `gameId` | `235` |
| `category` | `CustomItem` |
| `gameSeoAlias` | `twitch-drops` |
| public URL | `https://www.eldorado.gg/twitch-drops/i/235` |
| sales fee | **10%** (Items category) |
| min offer value | $0.50 USD |

`GET /api/library/235/CustomItem?locale=en-US` returns `tradeEnvironments` — the "Game" selector.
Only 13 values exist:

`0 Rust · 1 Rainbow Six Siege · 2 PUBG · 3 Delta Force · 4 Escape from Tarkov · 5 Apex Legends ·
6 Sea of Thieves · 7 Black Desert · 8 Albion Online · 9 Rocket League · 10 EVE Online ·
11 Other · 12 Warframe`

**Everything else (Overwatch 2, CoD, World of Tanks, Marvel Rivals, Fortnite, THE FINALS…) is listed
under `id: "11"` = "Other"**, with the real game name carried in the title. That is what the two
dominant sellers do. `attributes` and `offerAttributeIdValues` are empty for this category — no
extra required attributes. Nice and simple.

## 3. How the market is actually structured

Sampled 300 live offers (2,486 total in the category).

- **One offer per event/campaign wave per game**, stock = number of accounts. Exactly our
  unclaimed-bundles model (`project_unclaimed_bundles_v3`).
- Title convention: `<emoji> Twitch Drops <emoji> <Event name> <emoji> <Game> [Total N Items]`
- Description convention: `Instant Delivery` → numbered item list → `Event: <name>` → boilerplate
  warnings (7-day Twitch relink cooldown, claim within 7 days of campaign end, activate within 1h).
- `guaranteedDeliveryTime: "Minute20"` on 285/300 offers. `minQuantity: 1`. 4 images typical.
- Volume discounts common: `[{qty:3,pct:2},{qty:10,pct:3},{qty:30,pct:4},{qty:100,pct:5}]`.
- `expireDate` is set per offer (auto-expiry, ~3 weeks out).

Pricing (USD/unit, median): overall **$2.00**. Rust $0.50 · Rocket League $2.00 · Warframe $2.50 ·
EFT $2.50 · R6 $2.99 · Apex $3.99. Range $0.17–$61.

Concentration: `el9in_store` holds 211/300 offers and 119,800 units of stock; `GosMachine` 44 offers
/ 42,187 units. Everyone else is a rounding error.

**The tell:** GosMachine's `deliveryTimeMedian` for gameId 235 is **`00:00:35`** — a 35-second
median. That is a delivery bot, not a human. Their listing text says "INSTANT AUTOMATIC DELIVERY".
So the exact system we want to build is already the winning strategy on this platform, and it is
built the way described below (Eldorado has **no** native credential vault for CustomItem).

## 4. API surface (harvested from the Angular bundles)

Auth is **cookie-based** (httpOnly session cookies) + a CSRF double-submit (`X-XSRF-Token` header
against an `XSRF-TOKEN` cookie). No bearer token in JS. Requests with no cookie jar at all get
`403 {"messages":["XSRF header tokens are missing or invalid."]}`; with a jar they reach the app.

- `POST /api/authentication/authenticate` — login
- `POST /api/authentication/refreshTokens` — **no body**; refreshes from the cookie. This is the
  auto-renew lever, same role as `zeusxRefreshAccessToken()`.
- `GET  /api/authentication/claims` — session probe / health check
- `POST /api/authentication/logout`, `/signOutFromAllSessions`

**Listing (seller):**
- `POST /api/v1/item-management/me/offers/item` — create item offer ← our create call
- `POST /api/flexibleOffers/account` — account-category offer (not our path)
- `GET  /api/v1/item-management/me/offers/item/{id}/details` — read back for edit
- `PUT  /api/v1/item-management/me/offers/{id}` — update
- `PUT  /api/v1/item-management/me/offers/{id}/price` — reprice (body = pricePerUnit)
- `PUT  /api/v1/item-management/me/offers/{id}/pause` · `/resume` · `/private`
- `POST /api/v1/item-management/me/offers/delete` · `/pause` — bulk
- `POST /api/v1/item-management/me/offers/me/search` — list my offers
- `GET  /api/v1/item-management/me/offers/count` · `/state-count`
- `POST /api/v2/item-management/me/offers/delivery-time` — bulk set delivery time
- `PUT  /api/v1/item-management/me/offers/game/{gameId}/price` · `/resume` — bulk per game
- `POST /api/files/me/{offerId}` — image upload (multipart, field `image`)
- `GET  /api/fees/me/feesForGame/{gameId}` — live fee schedule
- **Bulk CSV:** `POST /api/offerUser/me/bulkUploadCsv` (multipart `csvFile`, query `category`)
  and `GET /api/offerUser/me/csvUploadExample?gameId=235&category=CustomItem` for the template.
  Worth grabbing the template once we have a session — may beat per-offer creates.

**Selling / delivery:**
- `GET  /api/orders/me/seller/orders` — poll for new paid orders
- `GET  /api/orders/me/statesCount` — cheap "is there anything new" probe
- `POST /api/v1/conversation-management/me/conversations/order/{orderId}/quick-reply`
  body `{ "message": "<credentials text>" }` ← **this is how the credential is handed over**,
  a plain server-side POST into the order chat. No TalkJS SDK needed.
- `PUT  /api/orders/me/{orderId}/deliver` — **no body**; marks delivered.
- `POST /api/orders/me/{orderId}/cancel`, `/dispute`, `/extend-delivery-time`

`GET /api/predefinedOffers/deliveryMethods` →
`["LoginMethod","GamePass","IslandDelivery","Unspecified","MailTrade","Donation","AuctionHouse","EpicGifting","RedeemCode","AutoClaim","InGameTrade"]`
→ **`LoginMethod`** is ours.

**Public read (no auth), useful for price research:**
- `GET /api/v1/item-management/offers?gameId=235&category=CustomItem&pageIndex=N&pageSize=50&includeDeliveryMedians=true`
- `GET /api/v1/item-management/offers/{offerId}`
- `GET /api/library?locale=en-US`, `GET /api/library/{gameId}/{category}?locale=en-US`
- `GET /api/appConstants`

## 5. Offer object shape

Read model (mirrors the create payload — confirm against a real create before trusting):

```jsonc
{
  "offerTitle": "🌌 Twitch Drops 👑 CAH Championship Finals 🧨 Overwatch 2 [Total 7 Items]",
  "description": "…Instant Delivery / numbered items / Event: … / boilerplate…",
  "gameId": "235",
  "category": "CustomItem",
  "tradeEnvironmentValues": [{ "name": "Game", "id": "11", "value": "Other" }],
  "offerAttributeIdValues": [],
  "attributes": [],
  "quantity": 4928,
  "minQuantity": 1,
  "maxPurchaseQuantity": null,
  "pricePerUnit": { "amount": 2.0, "currency": "USD" },
  "volumeDiscounts": [{ "quantity": 3, "percentage": 2 }],
  "guaranteedDeliveryTime": "Minute20",
  "expireDate": "2026-09-27T18:00:00Z",
  "mainOfferImage": { "smallImage": "…", "largeImage": "…", "originalSizeImage": "…" },
  "offerImages": [ /* up to 4 */ ]
}
```

## 6. Remaining unknowns

1. **Rate limits** — not probed. ZeusX limited hard; assume Eldorado does too and space calls out.
2. **`quick-reply` free text** — endpoint mapped but not fired (would need a real order).
   Confirm it accepts arbitrary text, not just canned replies, before trusting auto-delivery.
3. **Forter** — a `forterToken` cookie is present, so there is device fingerprinting on the account.
   Server-side calls from a datacentre IP may be scored differently than the browser. Ramp slowly.

## 7. Gates the operator must clear personally

- **Seller verification is a hard human gate**: government ID + a selfie matched against it.
  Cannot be automated and should not be.
- **Session bootstrap**: one manual login, then hand the server the session cookies. After that
  `POST /api/authentication/refreshTokens` keeps it alive on a timer
  (mirror `utils/zeusxTokenRefresher.js`).
- 50 completed orders unlocks the *official* Seller API — worth mailing api@eldorado.gg once we
  cross it, so we can drop the private-API dependency.

## 8. Build shape (mirrors ZeusX)

- `utils/marketplaces.js`: add `FIELDS.eldorado = ["sessionCookie", "xsrfToken"]`, plus
  `eldoradoPublish / eldoradoOffer / eldoradoUpdateOffer / eldoradoDelist / eldoradoRelist /
  eldoradoMyListings / eldoradoTest`, and an `eldoradoEnsureFreshSession()` guard on every call.
- `utils/eldoradoSessionRefresher.js`: timer calling `refreshTokens`, modelled on
  `zeusxTokenRefresher.js`.
- `utils/eldoradoFulfiller.js`: poll `orders/me/statesCount` → `orders/me/seller/orders` →
  claim an account via the existing reservation path → `quick-reply` the credential →
  `PUT …/deliver`. Sibling of `digisellerFulfiller.js` / `funpayFulfiller.js`.
- Listing copy: reuse the auto-lister house template per marketplace
  (see `project_unclaimed_autolist`). Stock = reserved account count, so this is a **multi-stock
  single listing** — strictly better than the ZeusX one-listing-per-account model.
- Settings flags: `autoFarm.eldoradoAuto`, `autoFarm.eldoradoAutoDeliver`, both **off by default**.

## 9. What is BUILT (2026-09-06) — all flags OFF by default

Implemented against the verified contract above. `npm test` = 903 pass / 1 fail, and that one
failure (`tests/dropSetsListLight.test.js`) is pre-existing: `utils/archiveExclusions.js` is missing
from this checkout and `routes/dropArchiveRoutes.js` requires it. Nothing to do with Eldorado.

| file | what it does |
|---|---|
| `utils/marketplaces.js` | `FIELDS.eldorado = ["cookie"]` + 20 `eldorado*` functions: session/CSRF transport, publish, read-back, restock, reprice, pause/resume/delete, my-listings, paid-order poll, TalkJS send, mark-delivered. |
| `utils/eldoradoSessionRefresher.js` | 6h tick; probes `authentication/claims` and only calls `refreshTokens` when the session has actually lapsed. Renewed `Set-Cookie` is folded back into the stored jar automatically. |
| `utils/eldoradoFulfiller.js` | The delivery bot. 60s tick, self-guarded on the flags. Claims accounts, restocks, delivers paid orders, stamps units. |
| `utils/autoLister.js` | `publishEldoradoShare()` + Eldorado joins the market split, description map, contact line, and the per-market result block. |
| `models/MarketplaceListing.js` | `"eldorado"` added to the marketplace enum; `units[]` gained `deliveredAt` + `orderId`. |
| `models/AutoFarmTask.js` | `listing.eldorado` / `stackedListing.eldorado` result blocks. |
| `utils/settings.js` | `eldoradoAuto`, `eldoradoAutoDeliver`, `eldoradoDeliverDryRun` (dry-run defaults **true**). |
| `server.js` | starts the session refresher and the fulfiller (both no-ops until flagged on). |
| `tests/eldorado.test.js` | pins the sha1 internal-id derivation against the real observed value. |

### The delivery model

One Eldorado offer = one `MarketplaceListing` row whose **`quantity` is the account count**
(multi-stock, so unlike ZeusX we do NOT need a listing per account). The reserved accounts ride on
the row as `units[]`. On a paid order the fulfiller takes `purchaseQuantity` undelivered units,
re-reads each password at delivery time (never ships a stale credential), posts one chat message,
marks the order delivered, stamps those units with the order id, then pushes the new stock count.

Ordering is deliberate and must not be rearranged: **send → mark delivered → burn units**. A send
that throws leaves the order untouched for the next tick; a unit carrying the order id makes a
second delivery of the same order impossible.

Accounts are reserved under claim tag `"eldorado"`, distinct from the Shop / Gameflip / GGSel /
Digiseller tags, and are filtered through `notListed(...)` so an account already attached to any
other live listing is never sold twice — the buyer receives the whole account.

### Turning it on

```
autoFarm.eldoradoAuto         = true    # start listing
autoFarm.eldoradoAutoDeliver  = true    # start delivering
autoFarm.eldoradoDeliverDryRun = false  # ONLY after watching one live order
```

Credential: paste the whole `Cookie` header from a signed-in Eldorado session into the `eldorado`
marketplace key (DevTools → Application → Cookies → eldorado.gg). One-time — the refresher keeps it
alive from then on.

### PROVEN LIVE + deployed (2026-09-06)

A real TalkJS send **has now been executed**: a normal seller follow-up posted into a completed
order's chat, HTTP 200 `{"ok":"…"}`, visible in the thread as the seller.

**The test caught a real bug before any buyer could.** TalkJS USER ids carry a trailing `_n` that
conversation ids do not:

```
nymId        = sha1(order.sellerId).hex[:20] + "_n"        <-- suffix REQUIRED
conversation = sha1(order.talkJsConversationId).hex[:20]   <-- NO suffix
```

Without the suffix the API answers `404 {"error":"Sender does not exist"}`. Fixed, covered by
`tests/eldorado.test.js`, redeployed.

**Deployed to prod** (backup `_deploy_backup_20260906_154046_eldorado`): 10 files, every one
hash-verified against what was staged, pm2 `online` / `unstable_restarts=0`. `server.js` and
`utils/autoLister.js` carried PROD-ONLY code, so those two were patched on prod's own copies rather
than overwritten from local — the other files matched local HEAD exactly.

### The one thing still blocking go-live

**The Eldorado cookie is not set on prod** — `keyStatus().eldorado.configured === false`, so nothing
lists or delivers yet. httpOnly session cookies cannot be read from `document.cookie`, and the
browser tooling redacts cookie data by design, so only the operator can supply it. Paste the whole
`Cookie` header into **Listings → keys → Eldorado.gg**, then flip `eldoradoAuto` and
`eldoradoAutoDeliver`, and `eldoradoDeliverDryRun` last.

<details><summary>superseded note</summary>

**A real TalkJS send has never been executed.** The protocol was recovered from the minified SDK and
both id derivations were verified against the live chat iframe (`userMatches: true`,
`convMatches: true`), but posting a message needs a real paid order and would message a real buyer,
so it was not tested. That is exactly what `eldoradoDeliverDryRun: true` is for: the next paid order
will log the full message it *would* have sent, with the credential resolved, and nothing is sent
until that has been eyeballed once.

</details>

Still unprobed: **rate limits**, and the `forterToken` device fingerprinting on the account — ramp
server-side call volume gradually rather than switching everything on at once.



## 10. LIVE — delivery armed on prod (2026-09-07)

Cookie installed on prod (operator-supplied; httpOnly cookies are unreadable from
`document.cookie` and the browser tooling redacts them, so there is no other source).
Prod authenticates: *"Connected as avishkanilupul55@gmail.com — 8 active offers"*.

```
eldoradoAuto          = false   # auto-LISTING still off on purpose
eldoradoAutoDeliver   = true
eldoradoDeliverDryRun = false   # delivery is REAL
```

### A third bug the live run caught

**The `X-XSRF-Token` header must be sent on EVERY request, GETs included.** Once the jar holds
`__Host-XSRF-TOKEN`, Eldorado 403s any request whose header does not match it. The code only set it
for mutations, so every GET 403'd with a real session. (Anonymous GETs with no XSRF cookie at all do
work — which is why the early curl probing never hit this.) Fixed and redeployed.

Also confirmed: `cf_clearance` issued to the operator's browser works fine from the prod host's IP —
Cloudflare does not challenge these API calls.

### Stock can now come from the no-claim farm

`MarketplaceListing.unclaimedGame` opts a listing out of the auto-farm pool: the fulfiller claims
from `UnclaimedAccount` at delivery time via `claimUnclaimedForGame()` instead of consuming a
pre-reserved `units[]` entry.

Only **`status: "released"` or `"skipped"`** rows are sellable. `"listed"` means the account is
already a stock unit on ANOTHER marketplace — shipping it here would hand the buyer that listing's
drops too. The claim is an atomic `findOneAndUpdate` with a status guard, and owners flagged
`manualSold` plus logins on any active listing are excluded.

| | |
|---|---|
| offer | `d1efe6cf-7ddd-4ade-4a9b-08df052b31c2` — Overwatch 2 CAH 2026 |
| listing row | `6a9d8db3678a9828140f32d9`, `origin:"unclaimed"`, `unclaimedGame:"Overwatch"` |
| DropSet | `6a941392df347c65b41816bd` ("Overwatch drops — unclaimed") |
| sellable stock | **30** no-claim Overwatch accounts |

Dry run picked one, resolved its credential through `credentialForLedger`, and built a 494-char
message — mutating nothing. The bot now ticks every 60s; the next paid order on that offer delivers
for real.
