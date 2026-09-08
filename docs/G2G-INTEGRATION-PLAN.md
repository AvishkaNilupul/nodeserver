# G2G.com integration — verified contract + build notes

**Status:** BUILT 2026-09-08 on `feat/eldorado-marketplace`. **All flags OFF, delivery dry-run ON.**
Every API fact below was executed live against the real seller account (Avishka_ReX, id 5700688)
from a signed-in session, read-only unless stated. Nothing was created, repriced or delisted.

> **Correction worth reading first.** An earlier pass recorded the Open API as "documented Gift
> Card & Top Up only". That is wrong in its detail: the string is an **Apidog folder label** and
> appears in no description, guide or error table across all 548 doc pages. The Open API is still
> unusable for Game Items, but for structural reasons, each fatal on its own:
> `delivery_method_code` is an enum of exactly `{instant_inventory, direct_top_up}`;
> `POST /v2/orders/{id}/delivery` needs a `delivery_id` that only arrives in an `order.api_delivery`
> **webhook** (this server has no webhook receiver); deliver-code `content` is validated against the
> offer's `code_label` columns, so a multi-line credential is rejected; **no screenshot-upload
> endpoint exists anywhere in the API**, and Game Items loses disputes without one; `PATCH` cannot
> change title/description/status, so there is no API delist (DELETE is permanent); and the account
> has no API key at all.
> Docs tip: docs.g2g.com is Apidog — append `.md` to any page slug for that endpoint's full OpenAPI
> YAML; `docs.g2g.com/llms.txt` indexes all 276 pages. Do not scrape the HTML, it is client-rendered.

**Model:** a session-driven *internal* API integration, like Z2U / Eldorado / PlayerAuctions —
**not** the public Open API. Read §1 before proposing the Open API again.

## Account
- Seller **Avishka_ReX**, G2G user/seller id **5700688**, Level 41, balance 33,955 JPY.
- Seller UI: https://www.g2g.com/offers/list (Manage offer), /offers/sell (create), /offers/api (API Integration).
- **78 LIVE offers, 32 delisted.** Almost all are Twitch Drops.

## Category — CONFIRMED, this is the "Items section" the operator meant
- Every Twitch Drops offer sits in `Digital Products - Gaming - Game Items - <Game>`.
- **Game Items service_id = `0765978e-3fdf-48b4-bed3-184823aa439e`** (744 products in the public catalog).
- Public catalog map: `https://assets.g2g.com/offer/categories.json` (6.8MB, no auth) —
  keyed by seo_term -> {service_id, brand_id, cat_path, marketing_title}.
  e.g. `albion-online-global-item` -> service `0765978e-…439e`, brand `lgc_game_21695`,
  cat_path `c508fb9f-a58e-4819-b815-c4684d8a2e70`.
  Sibling services on the same brand: `-account` (f6a1aba5-…), `-top-up` (90015a0f-…),
  `-boosting-service` (lgc_service_18), `-gold` (lgc_service_1).
- Two distinct products already sold there (same split as Eldorado):
  1. **bundles** — "<Game> Twitch Drops (N items) — <item names>", stock = account count
  2. **rent-farm** — "<Game> Twitch Drops Automatic farming 180 days", stock ~997

## G2G Open API (open-api.g2g.com) — what EXISTS
Probed from prod read-only. Routing answers **403 "invalid endpoint"** for unknown paths and
**400 "Missing Header 'g2g-api-key'"** for real ones, so path existence is enumerable with no auth.
EXISTS: `GET /v2/store`, `GET /v2/services`, `GET /v2/products`, `POST /v2/offers`,
`POST /v2/offers/search`, `GET /v2/offers/{id}`, **`POST /v2/orders/search`**,
**`GET /v2/orders/{id}`**, **`POST /v2/orders/{id}/delivery`**, **`GET /v2/orders/{id}/delivery`**,
`GET /v1/store`, `GET /v3/store`.
NOT present: /v2/orders (GET), PATCH /v2/orders/{id}, /v2/orders/{id}/deliver, /v2/deliver,
any /v2/store/webhook*, /v2/categories, /v2/brands, /v2/transactions, /v2/offers/batch|bulk.

- Docs: **https://docs.g2g.com/** (Apidog, server-rendered HTML — plain curl works).
  Endpoint pages: create-offer-18583484e0, get-offer-18583485e0, update-offer-18583486e0,
  delete-offer-18583487e0, search-offers-18583488e0, post-pricing-18583483e0,
  get-services-18583479e0, get-brands-18583480e0, get-products-18583481e0,
  get-attributes-18583482e0, get-order-18583489e0, get-deliveries-18583490e0,
  deliver-code-18583491e0, get-delivery-status-18583492e0, patch-delivery-18583493e0,
  upload-code-18583494e0, view-code-info-18583495e0, delete-code-18583496e0,
  view-store-settings-18583497e0, search-webhook-logs-18583498e0.
  Webhook events: order-created/confirmed/delivery_status/api_delivery/cancelled/refunded/
  completed/rollback_cancelled/rollback_completed/case_opened, offer-low_stock.
  Guides: authentication-intro-1237152m0, setup-api-key-1237153m0, verifying-signatures-1237154m0,
  create-offer-flow-1237155m0, upload-code-flow-1237156m0, order-delivery-flow-1237157m0,
  order-status-flow-1237158m0, error-handling/status-code/error-code, how-webhooks-work-1237165m0,
  setup-webhooks-1237166m0, webhook-resend-policy-1237167m0, message-signature-1237168m0,
  event-overview-1237169m0, migrate-to-v2-1237171m0, api-versions-1237162m0.
- **The docs sidebar heading over Product/Offer/Order/Inventory reads
  "APIS (Support Gift Card & Top Up Only)"** — the central open question is whether that is a hard
  server-side restriction for Game Items offers or only a documentation scope note.
- Signature (as implemented today in utils/marketplaces.js g2gHeaders): HMAC-SHA256 over
  `pathWithoutQuery + apiKey + userId + timestamp`, secret = apiSecret; headers g2g-api-key,
  g2g-userid, g2g-signature, g2g-timestamp.

## BLOCKER discovered
- **The G2G API-keys table at /offers/api is EMPTY** — no key exists on the account any more.
  Prod's stored g2g keys (userId 7ch / apiKey 32ch / apiSecret 43ch, in utils/settings.json)
  now return **HTTP 401 40100001** on every call. A key must be regenerated by the operator
  before ANY Open API path can be used or re-tested.
- /offers/api also exposes a **Webhooks** section (developer contact + event selector) — so
  webhook push is configurable from that page, not via the API.

## Game Items delivery model — CONFIRMED from the create-offer form
Selecting Digital Products -> Gaming / Game Items shows this notice:
> "Seller must upload delivery screenshots via order page once delivery is completed or when
>  confirming delivered quantity. If delivery screenshot is not uploaded, payment will be put on
>  hold and we will favor the buyer in the event of a dispute."
So Game Items is a **manual-delivery category with screenshot proof**, not a code-vault category.
Note localStorage carries `g2g_inventory_mfa_session_f6a1aba5-473a-4044-836a-8968bbab16d7` —
the inventory/code vault is bound to the **Game Accounts** service (f6a1aba5-…), not Game Items.

## Internal seller API (the route Z2U/Eldorado/PlayerAuctions-style integration would use)
- Host **`sls.g2g.com`**. Observed paths: `/v3/offer/seller/5700688/my_offers`,
  `/v3/offer/seller/5700688/my_offer_stats`, `/v3/offer/seller/5700688/my_offer_count`,
  `/v3/offer/seller/5700688/brands`, `/v3/offer/category`, `/offer/keyword_relation/service`,
  `/user/5700688`, `/user/5700688/notification_count`, `/user/5700688/wsc_balance`,
  `/notification/channel`, `/store-credit/get-balance`, `/wor/balance`, `/locale/languages`.
- Auth is **Firebase Auth** (`identitytoolkit.googleapis.com/v1/accounts:lookup` on load;
  `firebase:host:g2g-sls-firebase-default-rtdb.asia-southeast1.firebasedatabase.app` in
  localStorage; a JWT in `localStorage.accessToken`, 255 chars, "eyJ" prefix).
  `Authorization: Bearer <localStorage.accessToken>` on my_offers returned **401**, so that is
  NOT the live credential — the ID token the app really sends almost certainly comes from the
  Firebase SDK (IndexedDB `firebaseLocalStorageDb`), which is credential storage and was
  deliberately NOT read.
  Implication if this route is chosen: hold the Firebase **refresh token** and mint ID tokens
  server-side via `securetoken.googleapis.com/v1/token` (grant_type=refresh_token) — the same
  never-re-paste shape as zeusxRefreshAccessToken. NOT yet verified.
- `forterToken` is present in localStorage — Forter fingerprinting, same caution as Eldorado.

## Existing code in this repo
- `utils/marketplaces.js`: FIELDS.g2g = ["userId","apiKey","apiSecret"]; g2gHeaders, g2gRequest,
  g2gTest, g2gServices, g2gBrands, g2gProducts, g2gAttributes, g2gPublish, g2gDelist,
  g2gUpdateOffer, g2gGetOffer, g2gListOffers (all exported). Lines ~2305-2545.
- `utils/g2gBulk.js` — xlsx bulk file generator (currently emits the 19-col UPDATE format).
- Prior finding (2026-07-21, memory project_g2g_bulk_import_blocked): bulk **file** CREATE works
  via "Create offer in batch" with the 18-col template `assets.g2g.com/offer/product/{pid}/{pid}.xlsx`;
  `POST /v2/offers` rejected non-instant delivery_speed; `PATCH /v2/offers/{id}` price update worked
  on a Game Items offer. All of that predates the key being deleted and must be re-verified.


(interactive, logged-in, read-only, 2026-09-08 — ground truth, do not contradict without evidence)

## SPA routes (from https://www.g2g.com/js/app.506dced5.js)
offers/list · offers/sell · offers/create · offers/api · offers/invalid-offers ·
**offers/:offerId/edit** · **offers/:offerId/stock/manage** · **offers/:offerId/stock/upload** ·
g2g-user/sale · **g2g-user/sale/order/item/:item_id** · g2g-user/sale/order/case/:case_id/:item_id ·
g2g-user/purchase/… · seller · store · dashboard/:tab?

## Internal seller API — host `sls.g2g.com` (recovered from the same bundle)
Offers:
- `POST /offer` (create) · `/offer/{id}` (get/update) · `/offer/{id}/report_offer`
- `/offer/seller/{sellerId}/my_offers` · `/my_offer_count` · `/brands` · **`/create_access`**
- **`/offer/seller/{sellerId}/bulk_import`** · `/bulk_import/error` · **`/bulk_update`** · `/bulk_export`
  · `/exported_offers/{jobId}`
- **`/offer/product_settings/service/{serviceId}/brand/{brandId}/product_settings`** ← the required
  attributes/fields for a (service, brand) pair. This is the map g2gPublish needs.
- `/offer/keyword_relation/{search,detail,region,collection,attributes/search,group_attribute_settings,service}`
- `/offer/upload_url` (presigned media upload) · `/offer/product_pricing` · `/offer/adv_settings`
- `/offer/task_status` (async job polling) · `/v3/offer/category` · `/offer/search`, `/offer/search_v2`

Orders (seller side):
- `GET /order/list_my_order` · `/order/count-my-orders` · `/order/seller/report` · `/order/generate/report`
- `GET /order/item/{itemId}` · `/order/{orderId}` · `/order/{orderId}/summary`
- **`/order/item/{itemId}/start_deliver`** ← "View delivery details / View now"
- **`/order/item/{itemId}/mark_as_delivering`**
- **`/order/item/{itemId}/delivered_qty`** ← declare N delivered
- **`/order/item/{itemId}/delivery_proof`** and `/delivery_proofs` ← the mandatory screenshot
- **`/order/upload_url`** ← presigned upload for that proof image
- `/order/item/{itemId}/deliveries` · `/mark_as_complete` · `/cancel_delivery` · `/redeliver`
  · `/remarks` · `/mark_order_as_read` · `/report_case` · `/report_reasons`
- `/order/item/{itemId}/buyer/view_code` ← buyer reveals a delivered CODE
- Cases/disputes: `/order/item/{id}/case/{caseId}{,/appeal,/resolve,/respond,/redeliver,…}`

Inventory / code vault:
- `/inventory` · `/inventory/bulk` · `/inventory/softpin` · `/inventory/upload_url` · `/inventory/update`
  · `/inventory/count` · `/inventory/job/{id}` · `/inventory/failed/{id}` · `/inventory/my_inv_stats`
- **`/inventory/{invId}/offer/{offerId}`** ← bind stock to an offer
- **`/inventory/offer/{offerId}/order/{orderId}`** ← hand inventory to an order (native auto-delivery)
- localStorage holds `g2g_inventory_mfa_session_f6a1aba5-473a-4044-836a-8968bbab16d7`, i.e. the
  inventory vault is gated behind an **MFA session** and is bound to the **Game Accounts** service.
  Whether Game Items (0765978e-…) offers can carry inventory is THE open question for auto-delivery.

Chat: `/chat/{id}/unread`; the chat UI lives at https://www.g2g.com/chat/#/.

## The Game Items offer model — read off the real edit form (offer G1785763694173IQ)
Fields: Service · Brand (Albion Online) · **Server** (attribute, e.g. "Albion Asia") · Title (≤128)
· Description (≤5000, URLs stripped) · Media gallery (≤10 images/videos, one Primary; third-party
hosts allowed) · Default unit price + currency · **Delivery method** (per-product enum — for Albion:
Face to face trade / Island / Auction House) · Stock · low-stock alert qty · Minimum purchase qty
· **Delivery speed tiers** (qty range → duration, e.g. "0 hour / 10 mins") · Wholesale (optional)
· Country/region targeting (Global / include / exclude).
**There is NO instant-delivery or code option on a Game Items offer form.** Commission is **9.99%**
(a $5.00 order earns $4.50).

## The real delivery lifecycle — read off a COMPLETED order (1788750070103EDWX-1, 9 min end to end)
1. Buyer pays → order item status **Preparing**, banner "To begin delivery, you must view the
   delivery details / View now" → `start_deliver`
2. "You have viewed the delivery details."
3. "Delivery in progress." → `mark_as_delivering`
4. "You delivered 1 quantity." → `delivered_qty` (id shown as `#1788750619902-`)
5. "Awaiting buyer's confirmation on the receipt of item."
6. "Receipt of the item has been confirmed." → **Completed**
A **Proof gallery** tab exists on the order and the page warns:
> "Payment will only be released after you have uploaded correct and valid proof of delivery. Order
>  may be cancelled if seller did not upload correct and valid proof upon completion of order, or is
>  found to provide fake or incorrect proof."
And the safety banner says:
> "To ensure security and avoid scams, only deliver or replace account or product info through the
>  order page using our secure system. **Do not share sensitive details in chat.**"
So credentials are supposed to travel through the order page's secure mechanism (the code /
`buyer/view_code` path), NOT through chat — unlike the Eldorado TalkJS design.

## Live order state at recon time (2026-09-08 ~12:00 JST)
Sold Orders tabs: All · Verify payment · **Preparing (1)** · **Delivering (4)** · Completed ·
Cancelled · Resolution · Unpaid.
**UNDELIVERED RIGHT NOW: order `1788804161980Y02Q-1`, placed 08 Sep 2026 02:02 AM, "Albion Online
Twitch Drops (125 Chests) — Radiant Wilds Chest, Noble Community Chest", ×1, $5.00, buyer Mahit0,
status Paid / Preparing / "To Deliver".** Nothing was clicked on it.
Recent sales run ~$1.00–$5.00; Albion 125-Chests at $5.00 is the best seller (25 sales).


(2026-09-08, executed against the real logged-in seller session. All 200s below are REAL responses.)

## DECISION TAKEN BY THE OPERATOR
The G2G **Open API is NOT the route** — it only accepts pushes for the *account* section, not the
Game Items category where all the Twitch Drops live. Build our own connector against the internal
seller API, exactly like Z2U / Eldorado / PlayerAuctions. **No Open API key will be generated.**
Delivery: the fulfiller auto-delivers (start_deliver -> hand over -> delivered_qty) and then pings
the operator to upload the proof screenshot by hand. Do NOT auto-generate proof images.
The live undelivered order 1788804161980Y02Q-1 is the OPERATOR's to deliver — never touch it.

## AUTH — SOLVED, and it is NOT a cookie
From `https://www.g2g.com/js/app.506dced5.js`:
```js
axios.interceptors.request.use(e => {
  localStorage.getItem("accessToken") && (e.headers.authorization = localStorage.getItem("accessToken"));
  …
})
```
So every sls.g2g.com call carries **`authorization: <raw token>`** — a bare JWT with **NO
"Bearer " prefix**. Sending `Bearer <tok>` returns `401 {"message":"Unauthorized"}`; sending the
raw token returns 200. This is the single most important detail in the whole integration and it
cost one wrong probe to find.

Public Firebase web config found in the same bundle (public values, safe to hardcode):
- apiKey `AIzaSyBks-Ly5gJWSVbE_1S0BYi_FzstW9vlBT8`
- authDomain `g2g-sls-firebase.firebaseapp.com`
- projectId `g2g-sls-firebase`
- databaseURL `https://g2g-sls-firebase-default-rtdb.asia-southeast1.firebasedatabase.app`
=> auth is **Firebase Auth**, so the durable credential to store is the Firebase **refresh token**,
and the server mints fresh ID tokens via
`POST https://securetoken.googleapis.com/v1/token?key=<apiKey>` with
`grant_type=refresh_token&refresh_token=<RT>` (returns id_token + refresh_token + expires_in).
Same never-re-paste shape as `zeusxRefreshAccessToken`. The refresh token lives in the browser's
IndexedDB `firebaseLocalStorageDb` (credential storage — deliberately NOT read by Claude; the
operator must copy it once). **The refresh path is NOT yet verified end to end.**

## VERIFIED LIVE — internal API calls that returned 200
Base `https://sls.g2g.com`, header `authorization: <raw id token>`.

1) `GET /offer/seller/5700688/my_offers?page=1&limit=N&status=live` -> 200 `{code:2000, payload:{results:[…]}}`
2) `GET /offer/{offerId}` -> 200, the full offer object (fields below)
3) `GET /order/list_my_order?seller_id=5700688&page=1&limit=N` -> 200. NOTE: omitting seller_id
   gives `4001 "Missing mandatory parameter: buyer_id"` — pass **seller_id** for the sell side.
   Row shape (real):
   ```json
   {"order_type":"","offer_title":"Albion Online Twitch Drops (125 Chests) — …","seller_id":"5700688",
    "buyer_id":"5443030","service_id":"0765978e-3fdf-48b4-bed3-184823aa439e",
    "order_item_id":"1788804161980Y02Q-1","purchased_qty":1,"delivered_qty":0,"refunded_qty":0,
    "defected_qty":0,"compensated_qty":0,"offer_currency":"USD","offer_id":"G1785763694173IQ",
    "checkout_currency":"USD","amount":"5.00","order_id":"1788804161980Y02Q",
    "order_item_status":"preparing","buyer_sub_status":"preparing","seller_sub_status":"to_deliver",
    "unit_price":5,"report_case":"", …}
   ```
4) `GET /order/count-my-orders?seller_id=5700688` -> 200
   `{to_pay:0, verifying_payment:0, preparing:1, delivering:4, issues:0, last_order_completed_a…}`
   **This is the cheap poll** — one tiny call per tick; only fetch the list when `preparing > 0`.

## The Game Items offer object (live, offer G1785763694173IQ) — the create-payload template
```
offer_id, offer_group (== offer_id for a standalone offer), lgc_offer_id:""
service_id  "0765978e-3fdf-48b4-bed3-184823aa439e"      (Game Items)
brand_id    "lgc_game_21695"                            (Albion Online)
relation_id "baebc0d0-3cfb-42aa-ba91-6a7df6354ba0"      (product/keyword relation — per game)
region_id   ""            offer_type "public"           status "live"
title (<=128)   description (<=5000, URLs stripped)
offer_title_collection_tree ["lgc_21695_faction"]
offer_attributes [ {dataset_id:"lgc_21695_faction_47885", collection_id:"lgc_21695_faction",
                    value:"Albion Asia"} ]          <-- the "Server" field, per-brand
offer_group_attributes {}   primary_img_attributes []
actual_qty 5   available_qty 4   reserved_qty 1   api_qty 0   low_stock_alert_qty 3   min_qty 1
unit_name ""   unit_quantity 1   unit_price 5   unit_price_in_usd 5   formatted_unit_price "5.000000"
other_pricing []   cost_pricing {}
delivery_mode ["face_to_face_trade"]
delivery_method_ids ["cbca0f2e-d35e-4624-8e07-c77ca2a5867e"]
delivery_method_details [{delivery_method_code, delivery_method_id, label{en,…}}, …]
inventory_label_settings [] , inventory_csv_filename "" , inventory_csv_header ""   <-- PRESENT but
    empty on a Game Items offer: the code vault may be reachable here. WORTH ONE PROBE.
commission_rates [{seller_ranking_id:"1", name:"Normal Seller", commission_rates:9.99},
                  {"2","Common Seller",8.99}, …]      <-- our effective fee is 9.99%
seller_id "5700688", username "Avishka_ReX", user_level 41
```
`available_qty = actual_qty - reserved_qty` (5 - 1 = 4), so **stock is managed as `actual_qty`** and
G2G reserves against it during checkout — matching the "5 (1 reserved)" shown in Manage offer.

## Still to verify before/while building
- The exact **create** call: method + body for `POST /offer` (only the GET shape is confirmed).
  Get required fields from `/offer/product_settings/service/{serviceId}/brand/{brandId}/product_settings`
  and `/offer/keyword_relation/*` rather than guessing.
- Whether `PUT/PATCH /offer/{id}` is the update verb, and whether `actual_qty` is directly settable
  (this is how the stock-sync/pause loop will work).
- Whether prod's IP can reach sls.g2g.com unchallenged (Cloudflare/Forter) — Eldorado and Z2U both
  could; G2G is unproven. THIS IS THE BUILD'S BIGGEST UNKNOWN.
- The Firebase refresh-token mint, end to end.
- Whether `/inventory/*` accepts a Game Items offer (would upgrade delivery from
  "hand over + operator screenshot" to fully native).

## PROD REACHABILITY — VERIFIED 2026-09-08, the build's biggest risk is GONE
From the prod host (202.92.214.91), plain curl with a desktop UA:
- `https://sls.g2g.com/offer/seller/5700688/my_offers` -> **401 `{"message":"Unauthorized"}`** (26 bytes,
  clean JSON — NOT a Cloudflare interstitial, NOT a Forter block). Auth is the only gate.
- `https://sls.g2g.com/order/count-my-orders?seller_id=5700688` -> 401 JSON, same.
- `https://www.g2g.com/offers/list` -> 200 HTML.
- `https://securetoken.googleapis.com/v1/token?key=<g2g web key>` -> 400 for a bogus refresh token
  (endpoint reachable and behaving).
So prod can drive G2G directly, exactly as it does Eldorado and Z2U. No browser bridge needed.

## FULL VERB-LEVEL API MAP (decoded from the app bundle's own API tables — authoritative)
OFFER
  POST   /offer                                            CREATE_OFFER
  PUT    /offer/{offerId}                                  UPDATE
  GET    /offer/{offerId}                                  VIEW
  GET    /v3/offer/seller/{sellerId}/my_offers             LIST_OFFER
  GET    /v3/offer/seller/{sellerId}/my_offer_count        LIST_OFFER_COUNT
  GET    /v3/offer/seller/{sellerId}/my_offer_stats
  GET    /v3/offer/seller/{sellerId}/brands
  PUT    /offer/seller/{sellerId}/bulk_update              UPDATE_OFFER (bulk price/stock)
  POST   /offer/seller/{sellerId}/bulk_import              BULK_IMPORT (bulk create)
  GET    /offer/seller/{sellerId}/bulk_import/error
  POST   /offer/seller/{sellerId}/bulk_export
  GET    /offer/seller/{sellerId}/create_access            FETCH_SELLING_ACCESSES
  GET    /offer/product_settings/service/{s}/brand/{b}/product_settings
  GET    /offer/keyword_relation/search | /collection/ | /group_attribute_settings
  POST   /offer/keyword_relation/attributes/search
  GET    /offer/upload_url                                 (presigned media upload)
  GET    /offer/task_status                                (async job polling)
  GET    /offer/product_pricing | /offer/keyword_info | /offer/adv_settings
ORDER  (all the delivery verbs are PUT, except the proof POST)
  GET    /order/list_my_order?seller_id={id}&page&limit    LIST_ORDER
  GET    /order/count-my-orders?seller_id={id}             COUNT_MY_ORDERS  <- cheap poll
  GET    /order/item/{orderItemId}                         VIEW_ORDER_ITEM
  PUT    /order/item/{orderItemId}/start_deliver           START_DELIVER
  PUT    /order/item/{orderItemId}/mark_as_delivering      MARK_AS_DELIVERING
  PUT    /order/item/{orderItemId}/delivered_qty           UPDATE_DELIVERED_QTY
  POST   /order/item/{orderItemId}/delivery_proof          UPLOAD_DELIVERY_PROOF
  GET    /order/item/{orderItemId}/delivery_proofs | /deliveries
  PUT    /order/item/{orderItemId}/mark_as_complete | /cancel_delivery | /redeliver
  GET    /order/upload_url                                 (presigned proof upload)
  GET    /order/item/{orderItemId}/buyer/view_code         (buyer reveals delivered inventory)
  GET    /order/item/{orderItemId}/download_inv
  cases: GET/PUT /order/item/{i}/case/{c}{,/resolve,/appeal,/respond,/redeliver,/redeliver_status}
  GET    /order/seller/{sellerId}/completion_rate
INVENTORY (the code vault)
  POST   /inventory                                        CREATE
  GET    /inventory/offer/{offerId}/order/{orderId}        LIST_ORDER_INV
  GET    /inventory | /inventory/count | /inventory/my_inv_stats
  GET    /inventory/{invId}/offer/{offerId}                VIEW_INVENTORY
  PUT    /inventory/update | PUT /inventory/bulk (delete)
  POST   /inventory/softpin (CSV upload) | POST /inventory/job | GET /inventory/upload_url

## Per-(service,brand) product settings — VERIFIED for Albion Online
`GET /offer/product_settings/service/0765978e-…439e/brand/lgc_game_21695/product_settings` -> 200:
- `delivery_method`: 3 options — Face to face trade `cbca0f2e-d35e-4624-8e07-c77ca2a5867e`,
  Island `78f0508b-c05e-4d39-943e-8a4e02d0ea32`, Auction House `e91b6af1-2131-4835-8c00-0f157801e6c0`.
  Tooltip for Face to face trade: "Use the built-in chat system (located at order page) for
  delivery arrangement with seller."
- `purchase_form`: **0 items** for Albion (so the buyer supplies no structured delivery details;
  other games may differ — always read this per brand before publishing).



## CORRECTION to FACTS-3
Firebase Auth is present on g2g.com but it is **NOT** what authenticates the seller API. It backs
the realtime/chat layer. The seller API uses **G2G's own token trio**, and there is a first-party
refresh endpoint. Ignore the `securetoken.googleapis.com` idea entirely.

## The real contract (decoded from the app bundle's AUTH map)
```
POST  https://sls.g2g.com/user/refresh_access
body  { user_id, refresh_token, active_device_token, long_lived_token }
->    { access_token, refresh_token, long_lived_token, active_device_token, refresh_token_exp, … }
```
The bundle's own call site:
```js
const e = await API.AUTH.REFRESH({
  user_id: getUserId(),
  refresh_token: get("refresh_token"),
  active_device_token: get("active_device_token"),
  long_lived_token: get("long_lived_token"),
});
```
and its storage writer `setStorageToken({access_token, refresh_token, long_lived_token,
active_device_token, refresh_token_exp, …})`.

localStorage key names in play: `accessToken`, `refresh_token`, `active_device_token`,
`long_lived_token`, `S3ID`, `S3RM`, `G2GSES…`.

**Every seller-API request carries `authorization: <access_token>` RAW — no "Bearer ".**
(Verified live: raw -> 200, `Bearer …` -> 401.)

## What this means for the build — this is the ZeusX shape, not the Eldorado shape
`FIELDS.g2g` becomes a session credential set, pasted ONCE by the operator from a signed-in
browser (DevTools -> Application -> Local Storage -> www.g2g.com):
  `userId` (already known: **5700688**), `refreshToken`, `activeDeviceToken`, `longLivedToken`
and the server mints its own short-lived `access_token` forever via `/user/refresh_access` —
exactly like `zeusxRefreshAccessToken` / `zeusxEnsureFreshToken` + `utils/zeusxTokenRefresher.js`.
No cookie header, no httpOnly problem, no browser bridge. These values are in **localStorage**, so
the operator can copy them directly; Claude did not read them (credential storage).
UNVERIFIED until a real refresh token exists: whether `refresh_token` rotates on each refresh
(ZeusX's does not; if G2G's does, the stored value must be written back every time — build for
rotation, it is safe either way).

## Bonus found in the same AUTH map — the Open API can be managed programmatically
`GET open/api_keys`, `POST open/api_key`, `PUT open/api_key`, `DELETE open/api_key`,
`POST open/application`, `GET open/webhook_events`, `GET/PUT open/developer_settings`.
So the empty API-key table could be filled without the UI. **Not being used** — the operator has
decided the Open API is the wrong route (it only accepts pushes for the account section, not the
Game Items category where the Twitch Drops live). Recorded only so nobody re-investigates.

## Other AUTH facts worth keeping
- MFA: `POST /user/{id}/security-session` (VERIFY_MFA_SESSION) is what mints the
  `g2g_inventory_mfa_session_*` value — i.e. touching the **inventory/code vault requires an MFA
  session**, which is a real obstacle to unattended native code delivery.
- `POST user/log_in` exists but logging in with a password is out of scope and prohibited.



## The delivery record carries NO content
`GET /order/item/{id}/deliveries?seller_id=5700688` on the COMPLETED order 1788750070103EDWX-1 -> 200:
```json
{"results":[{"order_item_id":"1788750070103EDWX-1","delivery_id":"1788750619902",
  "delivery_status":"delivered","delivery_qty":1,"created_role":"seller","updated_role":"",
  "created_at":1788750619902}]}
```
Quantity only — no credential, no text, no attachment. So `delivered_qty` is a COUNTER, not a
hand-over channel.

## The proof screenshot is a DISPUTE FALLBACK, not a gate — important, it relaxes the design
`GET /order/item/1788750070103EDWX-1/delivery_proofs?seller_id=5700688` ->
**404 `4041 "Could not find any uploaded delivery proof."`**
That order nevertheless reached **Completed** (buyer confirmed receipt 1 minute after delivery).
So the scary banner ("payment will be put on hold… we will favor the buyer") bites only when the
buyer does NOT confirm, or opens a case. A normal confirmed sale needs no proof at all.
=> The operator's choice (fulfiller auto-delivers, operator uploads proof) is even cheaper than it
looked: the proof is only needed for the minority of orders that stall or dispute. The fulfiller
should therefore **ping the operator only when an order it delivered has not been confirmed after
N hours, or when a case opens** — not on every sale.

## Inventory / the "secure system" is NOT available for Game Items — VERIFIED
- `GET /inventory/count?seller_id=5700688&offer_id=G1785763694173IQ` -> **404 4041 Data was not found**
- `GET /inventory?seller_id=…&offer_id=…` -> **404 4041**
- Navigating to the SPA route `offers/G1785763694173IQ/stock/manage` **redirects to the homepage**.
- The Game Items create/edit form offers no code/instant option, and `inventory_label_settings` /
  `inventory_csv_filename` / `inventory_csv_header` are present-but-empty on the offer object.
- The vault's MFA session key in localStorage is scoped to the **Game Accounts** service
  (`g2g_inventory_mfa_session_f6a1aba5-473a-4044-836a-8968bbab16d7`).
CONCLUSION: native code delivery is a Game Accounts / gift-card feature. Twitch Drops offers live
in Game Items and cannot use it. (Filing under Game Accounts instead would buy native delivery but
would leave the Game Items market where every Twitch-Drops buyer actually is — the same trade-off
Eldorado had with flexibleOffers. Not recommended, recorded for completeness.)

## Therefore the transport is G2G CHAT — and chat is Firebase Realtime Database
From the bundle: the chat unread counter subscribes to an RTDB ref `/chat/{id}/unread` off
`store.state.firebase`, and the app's Firebase config points at
`https://g2g-sls-firebase-default-rtdb.asia-southeast1.firebasedatabase.app`.
The only REST-ish chat endpoint in the API map is `POST /chat/ai_agent` (the support bot) —
buyer/seller messaging is **not** a REST call, it is RTDB traffic. Firebase RTDB does expose a REST
interface (`PUT/POST https://<db>.firebasedatabase.app/<path>.json?auth=<ID_TOKEN>`), so a
server-side send is feasible, but it needs a **Firebase ID token** (a second credential, distinct
from the G2G `access_token`) and the exact chat document shape. NEITHER IS YET ESTABLISHED.
This mirrors Eldorado's TalkJS problem exactly, and Eldorado's answer applies here too:
**ship the hybrid first** — the server reserves the account, does start_deliver ->
mark_as_delivering -> delivered_qty, renders the credential text and Telegram-pushes it for a
one-tap paste into G2G chat — and only then attempt driving RTDB directly.

## Also found: a real-time order socket (would replace polling later)
`connectOrderWebSocket()` builds `wss://order-ws.…` and reacts to a `"paid"` event.
Polling `GET /order/count-my-orders?seller_id=…` is cheap enough to ship first.



## CORRECTION to FACTS-5
G2G chat is **NOT** Firebase Realtime Database. The RTDB is only an unread-badge counter on the
main site. The real chat, at https://www.g2g.com/chat/#/, is **SendBird** — an official, fully
documented product with a supported Node SDK. This makes unattended credential hand-over genuinely
achievable, unlike Eldorado's TalkJS.

## VERIFIED LIVE
- Chat SPA bundle: `www.g2g.com/chat/js/app.0fc6a348.js` (+ vendor).
- SendBird **appId `34201740-152E-401E-AD8F-5C72EEABA386`**, API host
  `https://api-34201740-152e-401e-ad8f-5c72eeaba386.sendbird.com`.
- The bundle's own init:
  ```js
  const {data:h} = yield API.AUTH.CREATE_CHAT_PROFILE({user_id:n});
  const {session_token:p} = h.payload.session_tokens[0];
  yield sendbird.connect(n, p);
  ```
- **`POST https://sls.g2g.com/chat/user`** body `{user_id:"5700688"}`, header
  `authorization: <g2g access_token>` (raw) -> **200**:
  ```json
  {"payload":{"nickname":"Avishka_ReX","preferred_languages":["en"],"user_id":"5700688",
    "user_timezone":"Asia/Colombo",
    "session_tokens":[{"session_token":"<40 chars>","expires_at":1789010661822}]}}
  ```
  So the server can mint a SendBird session token on demand from the SAME G2G session credential —
  no second credential for the operator to paste. Token life ~2 days; mint per use.
  (`GET /chat/user/{id}` returns the profile WITHOUT session_tokens — it must be the POST.)

## What does NOT work — do not waste time on it again
SendBird's REST API will not accept the session TOKEN directly. All of these were tried against
`GET /v3/users/5700688/my_group_channels`:
| header | result |
|---|---|
| `Session-Key: <session_token>` | 400 400303 "Session key is invalid." |
| `Access-Token: <session_token>` | 400 400401 "Api-Token is missing." |
| `Api-Token: <session_token>` | 400 400401 "No such application." |
| `Authorization: <session_token>` | 400 400401 "Api-Token is missing." |
A **session key** is what REST wants, and a session key is only issued by the SDK's
`connect(userId, sessionToken)` handshake. We have no SendBird master `Api-Token` and must not try
to obtain one — it is an application-wide admin credential that belongs to G2G, not to us.

## Therefore: the supported path is the official SDK, server-side
`npm i @sendbird/chat`, then in Node:
```js
const sb = SendbirdChat.init({ appId: G2G_SENDBIRD_APP_ID, modules: [new GroupChannelModule()] });
await sb.connect(sellerId, sessionToken);          // sessionToken from POST /chat/user
const q = sb.groupChannel.createMyGroupChannelListQuery({
  userIdsFilter: { userIds: [buyerId], includeMode: true, queryType: "OR" },
});
const [channel] = await q.next();
await channel.sendUserMessage({ message: text });
```
The channel is a **buyer<->seller DM, one per counterparty — NOT one per order** (the bundle
derives the other party with `getUserIdsFromChannelUrl` and filters by user id). The order row
already gives us `buyer_id`, so no extra lookup is needed. Messages must therefore name the order
they belong to, since a repeat buyer shares one channel across orders.

## Status
NOT built and NOT tested. Sending a message reaches a real paying customer, so it must not be
switched on without the operator's explicit go-ahead and a dry run first. The fulfiller shipped in
this pass therefore does the whole G2G state machine automatically and pushes the rendered
credential to the operator over Telegram for a one-tap paste (the same hybrid Eldorado shipped
first, which took its median hand-over from 6m30s to under a minute). `utils/g2gChat.js` is the
seam where the SendBird sender drops in.

---

# What was built (2026-09-08)

| file | role |
|---|---|
| `utils/marketplaces.js` | the connector: `g2gRequest` (raw-token auth, refresh-and-retry-once on 401), `g2gRefreshAccess`/`g2gEnsureFreshToken`, offers CRUD, `g2gDelist`/`g2gRelist` as reversible status changes, orders, the delivery verbs, `g2gChatProfile`. Legacy Open API survives only as the catalog pickers. |
| `utils/g2gGames.js` | farm game name -> G2G Game Items brand. **89 games mapped**; returns `null`, never a guess. |
| `utils/g2gFulfiller.js` | order poll -> claim stock -> `start_deliver` -> `mark_as_delivering` -> hand over -> `delivered_qty`; plus `syncStock`. Two-phase `messagedAt`/`deliveredAt`. |
| `utils/g2gChat.js` | the SendBird seam. Optional `@sendbird/chat`; without it the fulfiller hands off to the operator. |
| `utils/g2gSessionRefresher.js` | 30-minute tick keeping the pasted session alive. |
| `utils/autoLister.js` | `publishG2gShare` + the five `listActivatedTask` wiring points + `retryMissingSecondaries`. |
| `models/AutoFarmTask.js` | `g2g` sub-block on `listing` and `stackListing`. |
| `models/UnclaimedAccount.js` | `"g2g"` added to the `market` enum. |
| `utils/settings.js` | `g2gAuto`, `g2gAutoDeliver`, `g2gDeliverDryRun`, `g2gSyncStock`. |
| `utils/pricing.js` | `MARKETPLACE_FLOORS.g2g = 0.5`. |
| `scripts/g2g-shelf.js` | operator audit tool; dry-run by default, only reversible writes, never touches an unmanaged offer. |
| `tests/g2g.test.js` | 21 tests, including the raw-token assertion. |

Suite: **1209 pass, 1 pre-existing failure** (`dropSetsListLight` — `utils/archiveExclusions.js` is
absent from this checkout and lives only on prod).

# Turning it on

1. **Paste the session** (Marketplace keys -> G2G). Sign in on g2g.com, then
   DevTools -> Application -> Local Storage -> `www.g2g.com`, and copy `accessToken`,
   `refresh_token`, `active_device_token` and, if present, `long_lived_token`. Seller id is `5700688`.
   Press Test — it should report the order counts.
2. **Watch it dry-run.** `g2gAutoDeliver: true` with `g2gDeliverDryRun: true` (the default) logs
   exactly what it would ship, and touches nothing.
3. **Let it deliver.** `g2gDeliverDryRun: false`. Without `@sendbird/chat` installed, each paid
   order arrives on Telegram with the credential rendered for a one-tap paste, and the bot does the
   rest of G2G's state machine. Confirm the order on G2G after pasting; the next tick catches the
   records up from G2G's own delivered quantity.
4. **Unattended hand-over (optional).** `npm i @sendbird/chat` — then `utils/g2gChat.js` sends the
   credential itself. Do ONE supervised order first: the recipient is a paying customer.
5. **Auto-listing last.** `g2gAuto: true` publishes farmed bundles as new Game Items offers.
   Leave this off until delivery has been proven, exactly as Eldorado was staged.

# Known limits and open risks

- **78 of the account's offers were made by hand and have no `MarketplaceListing` row.** The
  fulfiller cannot know what stock backs them, so it skips them and Telegrams the operator. Adopting
  them (a `scripts/g2g-adopt.js`, like `scripts/z2u-adopt.js`) is the obvious next job.
- **`POST /offer` has never been executed.** Every other verb was verified live; create was not,
  because it would put a real offer on the account. The payload is built from a live offer's own
  read-back, so the field names are right, but the first publish should be a single cheap canary.
- **Creating an offer needs more than a brand.** Every live offer carries a per-game
  `relation_id` plus 1-2 REQUIRED dropdown attributes (Server / Item Type / Platform).
  `GET /offer/keyword_relation/search?service_id&brand_id` gives the relation;
  `GET /offer/keyword_relation/collection/?relation_id` gives the required collections and their
  allowed values. `g2gPublish` resolves both, and takes the attribute VALUES from one of our own
  existing offers for that game — never from the dropdown's first entry, which is routinely wrong
  (Albion's first server is "Albion Americas"; every offer we run is "Albion Asia"). For a game we
  have never listed, it refuses with a message naming the field and its options, so the operator
  lists one by hand and every later publish copies it. Marvel Rivals' Item Type even has a literal
  "Twitch Drops" value.
- **10 of the 89 mapped games have no creatable Game Items product** and are in
  `NOT_LISTABLE`: Overwatch, Rainbow Six Siege, Borderlands 4, Star Citizen, VALORANT,
  EA Sports FC 26, Apex Legends, Hearthstone, GTA V, League of Legends. Verified by probing all 86
  brands live — the public catalog lists more than a seller may actually use, so this cannot be
  derived from categories.json.
- **The Rainbow Six Siege bundles under "Rainbow Six Mobile" are NOT a mis-filing.** Siege has no
  Game Items product at all, so Mobile was the only shelf. Do not "fix" them.
- The delivery-proof screenshot is never uploaded automatically, by the operator's decision.
