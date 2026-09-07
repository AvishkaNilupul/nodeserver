# PlayerAuctions integration — feasibility + build contract

**Status:** contract VERIFIED LIVE 2026-09-07 against the real seller account (`avishkarex2`,
memberId 6423186). Create / update / hide / cancel all executed against the live API and cleaned up.
**Model:** private-API integration in `utils/marketplaces.js`, same shape as
[Eldorado](./ELDORADO-INTEGRATION-PLAN.md) — cookie session + refresh, no browser bridge.

## 0. Why this target is different from every other one

**We are already selling here.** The account has **72 lifetime orders** and 4 live offers, all
Twitch Drops, all hand-delivered. This is not a greenfield market test — it is an existing manual
business with a measurable delivery problem:

> Order 16458589 — paid `11:50:30`, delivered `19:17:37`. **7h27m on a 6-hour guarantee.**
> The event log records `Seller delivery guarantee expired - first notice`.

Late delivery on PlayerAuctions costs money directly: the offer form warns
*"Late delivery may result in a penalty fee and your offers being hidden."* Of the 72 orders,
51 completed, 8 never paid, 7 were cancelled, **1 went to dispute for delivery not completed**.
Automating the hand-over is worth real revenue here on day one, which is not true of a cold target.

Both of our product lines already exist on the account, so the Eldorado build maps over 1:1:
- **bundles** — `Overwatch Twitch Drops (26 Items) OWWC Groups 2026 …` (18 orders)
- **rent-farm** — `Overwatch Twitch Drops Automatic farming 180 days …` (6 orders)

## 1. Hosts, auth and the session model

Five API hosts, all read from the Angular bundle's `environment` block
(`https://member.playerauctions.com/main-*.js`):

| binding | host |
|---|---|
| `base_api_url` | `https://user-api.playerauctions.com/api` |
| `base_order_api_url` | `https://order-api.playerauctions.com/api` |
| `base_offer_api_url` | `https://offer-api.playerauctions.com/api` |
| `base_account_api_url` | `https://account-api.playerauctions.com/api` |
| `base_public_api_url` | `https://public-api.playerauctions.com/api` |

Auth is **cookie-only**. The HTTP interceptor sets `withCredentials:true` on everything except
`public-api`, and adds **no** `Authorization` header.

- **There is NO CSRF token.** Angular's built-in XSRF names appear in the bundle but PA never sets
  an `XSRF-TOKEN` cookie, so the interceptor adds no header. This is the one place PlayerAuctions is
  *easier* than Eldorado — do not go hunting for a `__Host-` prefixed token that does not exist.
- Session cookies are **httpOnly** (`Production_access_token` + refresh). They cannot be read from
  `document.cookie` and browser tooling redacts them, so — exactly as with Eldorado — **the operator
  is the only source**: paste the whole `Cookie:` request header from a signed-in session once.
- Renew with **`POST account-api/api/SignIn/RefreshToken`, body `{}`**. The client's own interceptor
  does refresh-then-replay on 401, which is the pattern `paRequest` mirrors.

Interceptor status handling worth copying: `403` → account suspended, `402` → registration
incomplete, `429` → rate limited.

### ⚠️ Errors come back as HTTP 200

Every endpoint answers `200 OK` with an envelope:

```jsonc
{ "isSuccess": false, "code": 400, "message": "The ItemPath field is required." }
```

**Never branch on the HTTP status.** `isSuccess === false` is the only reliable failure signal, and
`message` is a `;`-joined list of validation errors. A naive `res.ok` check reports every rejected
create as a success.

## 2. Offers — verified live

`productType` path segment is **`Item`** (singular, capitalised) for offer CRUD, but **`Items`**
(plural) for the category tree. Both spellings are load-bearing and neither is interchangeable —
`/games/7097/Item/categories` is a 404, `/games/7097/Items/categories` is the tree.

| call | verb + path | notes |
|---|---|---|
| create | `POST offer-api/api/offers/Item` | → new offer, **immediately `Active`, no review queue** |
| update | `PUT offer-api/api/offers/Item` | same DTO **plus `offerId`** |
| read | `GET offer-api/api/offers/Item/{offerId}` | the full DTO below |
| list mine | `GET offer-api/api/Offer/Offers?pageIndex=1&pageSize=50&sortField=null&sortOrder=null` | |
| hide/show | `POST offer-api/api/Offer/HideOrDisplay` | `{flag:"hide", offerIds, isAll, parameters}` |
| cancel | `POST offer-api/api/Offer/Cancel` | `{offerIds, isAll:false, parameters}` |
| image | `POST offer-api/api/media/images` | multipart `file` + `gameId` (+ `type=title`) |

`Cancel` and `HideOrDisplay` **both require a `parameters` object** carrying the seller-search form,
or they 400 with `The keywords field is required.;The ProductType field is required.;The
ListingStatus field is required.` Send `{keywords:"", productType:"All", listingStatus:"Active"}`.

### The Item offer DTO (read back from live offer 294684983)

```jsonc
{
  "gameId": 7097,             // PA game id — see §3
  "itemPath": "1653|8305",    // "<rootItem>|<itemId>", REQUIRED, validated first
  "rootItem": 1653,           // item category   ("Skins")
  "itemId": 8305,             // leaf item       ("Other Skins")
  "categoryId": 7098,         // platform/server node ("PC")
  "serverId": 0,              // 0 = All Servers
  "title": "…",               // max 150 chars
  "offerDesc": "<p>…</p>",    // HTML
  "instruction": "",          // buyer-facing pre-delivery instructions — SEE §5, this matters
  "price": 5,                 // price PER UNIT
  "itemsPerUnit": 26,         // drops per account
  "totalUnit": 100,           // STOCK = number of accounts behind the offer
  "minUnitPerOrder": 1,
  "offerDuration": 30,        // days
  "deliveryGuarantee": 106,   // enum, see below
  "discounts": [],            // volume discounts
  "otherItem": "", "deliveryTime": 0,
  "screenShot": "https://…", "blobName": "….jpeg",   // OPTIONAL — create succeeds without an image
  "isAgree": true, "agreeCheck": true                 // REQUIRED on create, see below
}
```

Server adds on create: `offerId`, `memberId`, `state:1`, `productType:"item"`.

### The five traps in that DTO

1. **`isAgree` + `agreeCheck` must both be `true` on create.** Otherwise:
   `"Please select the Secure Seller Delivery Agreement."` They read back as `false`, so a
   naive read-modify-write **loses them** and the update fails. Always force them true.
2. **Minimum trade price is $5.00**, checked as `price × minUnitPerOrder`. Not $0.50 like Eldorado.
   `"The minimum trade price can't be lower than $5"`.
3. **`totalUnit` is stock in ACCOUNTS, not items.** `itemsPerUnit` is the drop count. A buyer
   ordering 1 unit gets 1 account holding `itemsPerUnit` drops — identical to the Eldorado
   bundle model, so `MarketplaceListing.units[]` maps straight across.
4. **An update REPLACES the offer and issues a NEW `offerId`.** `PUT` with `offerId` cancels the
   old row and returns a fresh id; reading the old id afterwards returns null. **Any stored
   `externalId` goes stale on every reprice/restock** — re-read and persist the new id in the same
   breath, or the fulfiller ends up delivering against an offer that no longer exists. This is the
   same class of bug as the stale `task.listing.externalId` in the auto-farm listing gaps.
5. **Mutations are rate-limited.** Two writes ~1s apart returned
   `{code:1, message:"Operated too frequent, please try again later"}`. ~25s of spacing was
   reliably accepted. Bulk publishing must pace itself; treat `code === 1` as retryable.

### `deliveryGuarantee` enum — `GET offer-api/api/games/{gameId}/item/deliveryTimes`

`5`=20 Minutes · `101`=1 Hour · `4`=2 Hours · `106`=6 Hours · `12`=12 Hours · `3`=24 Hours ·
`6`=48 Hours · `1`=7 Days · `102`=10 Days

The live offers all sit at `106` (6 Hours) because delivery is manual. **A working delivery bot
should advertise `5` (20 Minutes)** — verified accepted on create — which is the single biggest
conversion lever available on this marketplace and is what the bot exists to earn.

## 3. Game + item taxonomy — anonymous, no auth needed

`GET offer-api/api/games` answers **plain server-side curl with no Cloudflare challenge**
(same as Eldorado's API). 398 games.

Each row carries `productType: "currency,item,account,powerleveling,topup"` — **the allowed product
types for that game.**

> **Only 149 of 398 games allow `item` at all.** Several games we farm are `account`-only:
> Rainbow Six Siege, Apex Legends, Rocket League, Dead by Daylight, The Finals, Counter-Strike 2,
> Genshin Impact, Enlisted, Smite 2, Brawlhalla, NARAKA. For those, an Item offer is impossible and
> the bundle must either be skipped or listed under **Accounts** (§6).

Verified mappings for games we farm (36 of 38 candidates resolve):

| our game | PA gameId | item? |
|---|---|---|
| Overwatch | 7097 | yes |
| Call of Duty - Warzone / BO7 & All Legacy Versions | 7313 | yes |
| Halo Infinite | 10588 | yes |
| Escape From Tarkov | 7510 | yes |
| Albion Online | 6664 | yes |
| Fortnite | 7876 | yes |
| RUST | 6141 | yes |
| Delta Force | 13907 | yes |
| Sea of Thieves | 8132 | yes |
| Black Desert | 6662 | yes |
| EVE Online | 8 | yes |
| Warframe | 5655 | yes |
| World of Tanks | 4100 | yes |
| Marvel Rivals | 14147 | yes |
| League of Legends | 3637 | yes |
| War Thunder | 6143 | yes |
| Destiny 2 | 7942 | yes |
| Valorant | 9078 | yes |
| Tom Clancys Rainbow Six Siege | 7773 | **NO — account only** |
| Apex Legends | 8534 | **NO — account only** |
| Rocket League | 7476 | **NO — account only** |
| Dead by Daylight | 8735 | **NO — account only** |
| The Finals | 13536 | **NO — account only** |

PUBG and Diablo IV did not resolve by name and need a manual alias.

Supporting taxonomy:
- item tree: `GET offer-api/api/games/{gameId}/Items/categories` → `[{id, name, subCategorys:[…]}]`
  where the top id is `rootItem` and the child id is `itemId`. Prefer the generic
  `Other …` leaf (Overwatch: `1653 Skins` → `8305 Other Skins`).
- servers/platforms: `GET offer-api/api/games/{gameId}/Item/servers` → `0 = All Servers`,
  `7098 = PC`, …

## 4. Orders

`GET order-api/api/Order/SellerOrders?pageIndex=1&pageSize=100&sortField=null&sortOrder=null`
→ `{count, items:[{orderId, orderTitle, name /* buyer */, price, quantity, productType, status, createTime, isViewdetails}]}`
(`BuyerOrders` is the buy-side twin.)

`GET order-api/api/orderdetail/{orderId}` → `{status:{current, orderStatus}, orderInfo, deliveryInfo,
gameAccount, eventLogs:[{content,dateTime}], …}`.

Two different status fields, and the distinction matters:
- `status.orderStatus` — coarse machine bucket: `Pending payment` · `Pending Delivery` ·
  `Pending Buyer Confirmation` · `Pending Buyer Inspection` · `Pending Feedback` · `Completed` ·
  `Disputed` · `Order Canceled` · `Payment Failed` · `Delivery Expired`
- `status.current` — the fine-grained display string, e.g. `Delivery Fully Completed`,
  `Delivery Pending Buyer Confirmation`, `Buyer Cancelled Early`.

**`orderStatus === "Pending Delivery"` still reads `Pending Delivery` after the seller has claimed
delivery**, so it is NOT sufficient on its own to decide "needs shipping". Gate on the pair, and
persist our own `deliveredAt` — never re-ship an order we have already shipped.

Lifecycle from a real order's `eventLogs`:
`Order created → Verifying Payment → Payment settlement completed → [deliver here] → Full delivery
claimed by seller → …`. **`Payment settlement completed` is the trigger.**

## 5. Delivery — the hand-over

`deliveryInfo.deliveryMethod` on our Item orders is **`"Face to Face"`**, and `gameAccount` is
`null`. So, exactly like Eldorado, **there is no credential vault for this product type** and the
credential must travel as a message. The difference is that PlayerAuctions has a **first-class,
documented-in-the-bundle messaging API** — no TalkJS reverse-engineering, no websocket, no
`_n` suffix. This is the easiest hand-over of any marketplace we have integrated.

```
POST user-api/api/messages        { objectIdType: "Order", objectId: <orderId>, content: "<text>" }
POST user-api/api/messages/reply  { id: <messageId>, content: "<text>" }
GET  user-api/api/messages/detail?id={id}&isFromSystem={bool}
```

### ⚠️ The message body is capped at 300 characters

`maxCharacterCount` is **300** for a normal member and **50** for `role === NewUser`. Our role is
`Completed ID Document Check`, so 300. The Eldorado hand-over text is 494 characters and **will not
fit.**

The fix is a design win rather than a workaround: **the long claim guide belongs in the offer's
`instruction` field**, which PA shows the buyer up front ("Provide instructions or details to your
buyer in advance to ensure a smooth delivery"). The per-order message then only has to carry the
credential and a pointer, which fits in ~150 characters. Splitting the credential across two
messages would be worse — it races, and a half-delivered credential is a dispute.

Related validator to respect: PA strips `@domain.tld` and `http(s)://…` from *feedback* replies via
`excludeNumberEmailValidator`. It is **not** applied to order messages, but a URL in a delivery
message is exactly the kind of thing a marketplace filters server-side, so keep the twitch.tv link
in `instruction` (rendered on their own page) rather than in the message.

### Marking it delivered — `POST order-api/api/order/confirmdelivery/{orderId}`

**This is `multipart/form-data`, not JSON**, with an `images` field, and from the client:

```js
if ((data.sellerLevel === 0 || data.isNeedEvidence === true) && fileList.length <= 0) {
  formError = "Please submit 1-2 screenshots as proof of delivery."; return;
}
```

> **`User/status` reports `level: 0` for this account, so proof-of-delivery screenshots are
> MANDATORY for us.** An empty `confirmdelivery` will be rejected. The fulfiller must attach 1–2
> generated images. We already generate listing cover art (`utils/setImage.js`), so rendering a
> delivery-proof card (order id, title, timestamp, "credential sent via PlayerAuctions message")
> is the natural source.

**Order is load-bearing, same rule as Eldorado: send the message → confirm delivery → burn units.**
Never confirm delivery before the buyer actually has the credential.

## 6. The official API — gated, do not wait for it

`member.playerauctions.com/account/api-key-management` exists and is wired to
`GET/POST user-api/api/APIKey/application` + `POST/PUT/DELETE user-api/api/APIKey/key`, but the page
renders **"Apply for API Access — Seller Level 2 or Higher Required to Apply"** and our
`User/status` says `level: 0`. Same story as Eldorado's 50-order gate: build on the private API now,
revisit if the level ever clears. Nothing about the private API suggests it will be turned off.

## 7. Strategic notes

- **Accounts product type buys a real credential vault.** `GET order-api/api/Order/QueryAccount/{id}`
  and `PUT order-api/api/Order/ModifyAccount/` back a structured `gameAccount {loginName, password,
  characterName, …}` on the order. That is genuine native auto-delivery, but it means listing under
  each game's **Accounts** category instead of **Items** — abandoning the exact market where our 72
  orders came from. Not a default. It *is* the answer for the `account`-only games in §3.
- **Stock honesty.** Live offer 294684983 advertises `totalUnit: 100`; the no-claim ledger held ~30
  sellable Overwatch accounts. Same oversell exposure as Eldorado, and here it is worse because
  late/failed delivery carries an explicit penalty. Sync `totalUnit` to real sellable stock.
- **No per-category active-offer cap was observed** (Eldorado's hard 100/category). The limits seen
  here are the $5 floor and the write throttle.

---

## 8. What was built (2026-09-07)

All flags ship **OFF**, and the delivery dry-run defaults **true**, matching the Eldorado rollout.

| file | what it is |
|---|---|
| `utils/marketplaces.js` | `FIELDS.playerauctions = ["cookie"]` + 35 `playerauctions*` functions: session/refresh, taxonomy, offer CRUD, orders, messaging, delivery |
| `utils/playerauctionsCopy.js` | the 300-char split — hand-over messages, chunking, and the long `instruction` guides |
| `utils/playerauctionsProof.js` | renders the proof-of-delivery image `confirmdelivery` requires at seller level 0 |
| `utils/playerauctionsFulfiller.js` | the 60s delivery tick (bundles), three stock sources, resume-on-partial-failure |
| `utils/playerauctionsFarmService.js` | rent-farm order provisioning, sharing `FarmServiceOrder` with Eldorado |
| `utils/playerauctionsSessionRefresher.js` | 6-hourly cookie keep-alive |
| `scripts/pa-selfcheck.js` | read-only end-to-end verification — **run this first** |
| `scripts/pa-bundle-listings.js` | proven-seller bundles from the Drop Archive |
| `scripts/pa-farm-listings.js` | rent-farm service listings, one per game per term |
| `tests/playerauctions.test.js` | 22 tests |

Also wired: `publishPlayerAuctionsShare()` + a per-game gate in `utils/autoLister.js`, the
`playerauctions` enum on `MarketplaceListing` / `UnclaimedAccount` / `AutoFarmTask`, a `market` field
on `FarmServiceOrder`, the test + delist branches in `routes/marketplaceRoutes.js`, the credential
field in `public/listings.html`, and both start-ups in `server.js`.

Flags: `playerauctionsAuto`, `playerauctionsAutoDeliver`, `playerauctionsDeliverDryRun` (**default
true**), `playerauctionsSyncStock`.

### Design decisions worth not re-litigating

- **The long guide lives in `offer.instruction`, not the message.** Forced by the 300-char cap, but
  it is also simply better: the buyer sees the claim steps before they order.
- **Accounts are reserved onto the listing row *before* the first message is sent.** A hand-over can
  now be several HTTP calls, so a failure part-way through is a real state. Units carry the order id
  with `deliveredAt` still null, and a retry reuses them. Without this, a send that failed on
  message 2 of 3 would spend a *second* set of accounts on the next tick.
- **Taxonomy calls bypass the credential entirely** (`paPublicGet`). They answer anonymously, and
  the auto-lister's per-game gate treats a thrown error as "not supported" — so routing them through
  the authenticated path would quietly disable PlayerAuctions listing for every game the moment the
  cookie lapsed.
- **Delivery detection reads the order's event log, not its status string.** See §4: the coarse
  status does not change when the seller delivers, and no paid-but-unshipped order existed while
  this was mapped, so the label for that state is still unobserved. The log is factual.
  Relatedly, the "already finished" guard deliberately does **not** match a bare `completed` —
  a paid order labelled something like "Payment Completed" would otherwise stop every delivery.

### Verified so far, and what is not

**Verified live against the real account:** create (→ Active immediately, no review, no image
required), update (→ **new offerId**), hide, cancel, the $5 floor, the write throttle, the
`isAgree`/`agreeCheck` requirement, the taxonomy from plain server-side Node with no cookie and no
Cloudflare challenge, and the item leaf for Overwatch resolving to exactly the `1653|8305` the live
offers use. The test offer was created and removed; the account is back to its original 4 offers.

**Not yet verified, and it needs the operator:** every authenticated call from the *server* — the
session cookie is httpOnly, browser tooling redacts it, so the operator is the only source. Paste
the Cookie header into the listings keys modal, then run `node scripts/pa-selfcheck.js`.

**Deliberately not done unattended:** sending a message to a real buyer and confirming a real
delivery. Those reach a third party, and there was no test order to use — the two orders in a
non-final state belong to real buyers. The code path is built and dry-runnable; the first live send
should be watched.

### Open risks

- **Oversell.** Live offer 294684983 advertises `totalUnit: 100` against ~30 sellable no-claim
  Overwatch accounts. `playerauctionsSyncStock` corrects stock *after* each delivery, but the
  initial figure is whatever was published by hand. PlayerAuctions penalises failed delivery
  directly, so this is worth a one-off reconciliation pass.
- **The account is seller level 0.** That forces proof images on every confirm-delivery and locks
  the official API. Level 2 would unlock `APIKey/application`.
- **Item-only games.** Rainbow Six, Apex, Rocket League, Dead by Daylight, The Finals and several
  others cannot take an Item offer at all. The publishers skip them with a reason; selling those
  bundles here would mean the Accounts category (§7) and a different delivery path.

---

## 9. Deployed to prod 2026-09-07 — and one session destroyed on the way

**Deployed.** Backup `_deploy_backup_20260907_033447_playerauctions` (9 files). The 9 modified
files were **patched onto prod's own copies** (`patch -p1`, clean, offsets only) rather than
overwritten, because prod runs a mix of branch tips; the 8 new files were copied and hash-verified
against local. Every module load-tested before restart. `pm2 restart redeemer` → online,
`unstable_restarts: 0`, "MongoDB connected" / "Server started", no PlayerAuctions errors.

### ⚠ ONLY ONE MACHINE MAY EVER HOLD A GIVEN PLAYERAUCTIONS COOKIE

This was learned by breaking it. **PlayerAuctions rotates the entire session on refresh**: a
successful `POST /SignIn/RefreshToken` mints a new session id (the `sid` claim changes) and
invalidates every other copy of that jar. Presenting an already-spent refresh token then reads as
**token reuse and revokes the whole family — including the operator's browser session.**

What happened: the cookie was installed on a laptop and self-checked (the self-check called
`playerauctionsRefreshSession()` as a "does refresh work?" test, which *spent* the token), then the
same original paste was installed on prod, whose first call refreshed with the now-spent token.
Result: 401 everywhere, and the operator was signed out of PlayerAuctions in their own browser.

Fixed so it cannot recur:
- `scripts/pa-selfcheck.js` **no longer refreshes**. It reports the JWT's own expiry via
  `playerauctionsTokenExpiry()`, which decodes the stored jar and calls nothing.
- Both the script and `playerauctionsRefreshSession()` carry the single-owner rule in a banner.

**The install procedure is therefore:** sign in, copy the `Cookie` header, install it on **prod
only**, and run the self-check **on prod**. Never install the same paste twice, and never run the
authenticated half of the self-check from a second machine.

The dead cookie has been cleared from both hosts, so nothing is running against a revoked session.

## 10. The publication plan (dry-run against prod, 2026-09-07)

Everything below is staged and verified; each is one command away once a cookie is installed.

### `scripts/pa-mirror-eldorado.js` — the Eldorado shelf → **14 of 23 bundles**

Carries each row's stock source across (`unclaimedGame` / `autoClaimSet`), so a mirrored listing is
wired to auto-deliver from the same place its Eldorado twin is. Prices lift to the **$5 floor**
(Eldorado runs $0.75–$3.00 here) — which is not a guess: all four existing PlayerAuctions offers on
this account sit at exactly $5.00 and 51 orders have completed at it. Stock is **real claimable
stock**, never Eldorado's advertised number.

The 9 that cannot be mirrored are genuine, not bugs: **eight games are account-only on
PlayerAuctions** (Rainbow Six, Rocket League ×2, Metin 2, Phasmophobia, Brawlhalla, Marvel Contest
of Champions, Hunt: Showdown) and **Assassin's Creed Black Flag Resynced is not in their catalogue
at all**. Selling those here would mean the Accounts category (§7) and a different delivery path.

> The first dry run said only 11. The other 3 were a **resolver bug**, not a limit: our game names
> come from Twitch campaign data and are consistently *more specific* than the storefront's, so
> `NBA 2K27`, `Call of Duty: Modern Warfare 4` and `Call of Duty: Black Ops 7` all reported "no such
> game" — including Call of Duty, which is a proven seller on this account.
> `playerauctionsResolveGame` now also tries the part before a colon through the alias map, and
> **their** name as a prefix of **ours**, longest-match-wins.

### `scripts/pa-farm-listings.js` — rent-farm → **78 offers** (26 games × 3 terms)

Tiers are **$5 / $6 / $9** for 120 days / 180 days / 1 year, not Eldorado's $3/$4/$7 — the cheap
tier would be refused outright under the $5 floor.

**Stock defaults to 5 per listing, not Eldorado's 1000.** The pool is the ceiling: prod has **147
eligible pristine accounts** and the holder renter caps at **200 concurrent**, and each sale burns
one for 120–365 days. 78 × 1000 would advertise 78,000 units against 147. Override with `--stock`
once the pool is deeper.

### No breadth cap to worry about

Eldorado enforces max 100 *active* offers per game category, with everything outside its 12 named
games sharing one "Other" bucket that fills instantly. **Nothing equivalent was observed on
PlayerAuctions** — the limits here are the $5 floor and the write throttle, so the whole shelf can
go up. Pacing is ~26s between creates.


---

## 11. Five more create-time rules, all found by publishing for real (2026-09-07)

None of these showed up in the original probing, because **each sits behind a check that fails
earlier** — the validator returns one message at a time, so you only ever see the next rule after
satisfying the last. Publishing for real is the only way to reach them.

| rule | error | fix |
|---|---|---|
| `instruction` < 500 chars | `Delivery instructions should less than 500 characters.` | Both guides rewritten to fit (465 / 449). It is a **second budget**, not the unlimited home for what would not fit in the 300-char message. |
| Titles must be plain ASCII | `Title format error.` (no detail) | `paSanitizeTitle` folds em dashes, `…`, curly quotes and `|` down to ASCII. Our own listing copy introduces all of them. |
| `deliveryGuarantee` is **per game** | `Delivery time can't be empty or error delivery time.` | Marvel Rivals and Palia have **no 20-minute tier**. `playerauctionsResolveDelivery` checks the game's own list and falls back to its fastest. |
| A root with `id: -1` is a sentinel | `Invalid Item Name` | Fortnite's tree ends in `{id:-1,"Others",no subs}`. Non-positive ids are skipped. |
| **Some games have no honest category at all** | *(none — the API accepts it)* | The dangerous one. See below. |

### The rule with no error message

The first run filed **Fortnite under "Ore > Copper Ore"** and **NBA 2K under "VC > 15000 VC"**.
Both were **accepted**. Both are wrong — a buyer browsing NBA 2K currency should not find a Twitch
drops bundle, and that is exactly the kind of thing that becomes a dispute on a marketplace that
penalises them.

`playerauctionsPickItemPath` now scores roots by preference rather than scanning in tree order
(Fortnite lists `Weapons` before `Skins`), denies currency and raw-material roots outright, takes a
literal **"Twitch Drops"** category when a game has one (Marvel Rivals: root 2010 — the ideal
placement), and **refuses** when a game has no cosmetic root at all. Both publishers resolve the
item path up front, so an unlistable game is reported rather than costing a 26s throttled write.

Verified against the placements the operator's own hand-made offers already use: Overwatch
`Skins > Other Skins`, Call of Duty `Bundle > Other Bundles`, Halo `Armor Coatings`.

That refusal is why the farm run publishes **45 offers across 15 games, not 78 across 26**: eleven
games accept Item offers but have nowhere to file a cosmetics bundle.

### Also fixed

The media upload answers `{blobName, sasUri, created, length, verified}` — **`sasUri`, not `url`**.
The publisher was reading `url`/`imageUrl`/`path`, so every offer got a blob name with no image URL
beside it and rendered without a cover.

## 12. Live state

**Session:** installed on **prod only** this time, and the self-check no longer refreshes, so the
rotation trap in §9 cannot repeat. `pa-selfcheck.js` → **11/11 pass**.

**Published:** 12 bundle mirrors + the 4 pre-existing hand-made offers, plus the rent-farm shelf.
Every new listing advertises a **20-minute delivery guarantee** where the game allows it (the
hand-made ones sit at 6–12 hours), which is the single biggest conversion lever on this marketplace
and the whole point of having a delivery bot.

**Withdrawn:** the NBA 2K mirror, published under `VC > 15000 VC` before the category rule existed.
Cancelled on PlayerAuctions and its row marked `delisted`.

**Not mirrored, and correctly so:** eight games are account-only on PlayerAuctions (Rainbow Six,
Rocket League ×2, Metin 2, Phasmophobia, Brawlhalla, Marvel Contest of Champions, Hunt: Showdown),
NBA 2K and Palia have no cosmetic category, and Assassin's Creed Black Flag Resynced is not in the
catalogue at all.

**Message and confirm-delivery endpoints** were probed against a deliberately invalid order id, so
auth and payload shape are proven without touching a real buyer: the message API answers
`code 3: "…your Offer ID / Order ID is invalid or you are not the seller/buyer of this order."`
and confirm-delivery answers `403` — both are the correct rejections, from the right endpoints.

---

## 13. The two rules that cost real damage

### A concurrent refresh revokes the whole session — and "one machine" was the wrong diagnosis

§9 said only one *machine* may hold a cookie. That was **insufficient**, and the session died a
second time proving it — entirely server-side, with the cookie installed in exactly one place.

The pm2 fulfiller ticks every 60s while a publishing script runs for an hour **in its own process**,
both reading the same jar from `utils/settings.json`. When the 30-minute access token expires they
401 moments apart, both call `SignIn/RefreshToken`, and the second presents an already-spent refresh
token. PlayerAuctions reads that as reuse and revokes the family.

**The real rule: exactly one PROCESS may refresh at a time.**

`paRefreshOnce()` now serialises across processes with an atomic lock file
(`utils/.playerauctions-refresh.lock`, gitignored). The load-bearing half is not the lock but the
**re-check under it**: if `paStoredAccessToken()` has moved, another process already refreshed and
we use its result instead of spending ours. A 15s cool-down (`.playerauctions-refresh.stamp`) covers
the case where a refresh does not change the token.

PlayerAuctions' own web client solves the cross-tab version of this identically — its HTTP
interceptor carries `refreshTokenLock`, `LOCK_TIMEOUT` and `COOL_DOWN_PERIOD`. That was visible in
the bundle from the very first read and should have been taken as a design hint, not a curiosity.

Tested with 10 concurrent callers: exactly 1 refresh, lock released.

**Procedure for a long publishing run:** park `playerauctionsAutoDeliver=false` so the pm2 tick
cannot touch the session, run the script as sole owner, re-enable afterwards. The lock makes this
belt-and-braces rather than mandatory, but it costs nothing.

### No-claim games can never be sold from the claimed Drop Archive

**Overwatch, Rainbow Six and Call of Duty** (`settings.noClaimGames`, matched as a substring so
"Overwatch 2" and "Tom Clancy's Rainbow Six Siege" both hit) drops must reach the buyer
**UNCLAIMED**, so they can press Connect and claim to their own game account. The regular auto-farm
claims as it farms, so its Drop Archive accounts are exactly the wrong stock for those games — which
is the entire reason the no-claim farm exists.

Eldorado already guarded this (commit `5f77f4c`). The PlayerAuctions mirror did not, and published
four such listings (2 Overwatch, 2 Call of Duty) from the claimed archive before they were caught
and withdrawn. Two guards now, mirroring Eldorado:

- **Publishers** skip a no-claim game unless the row is `unclaimedGame`-backed.
- **Fulfiller** `unclaimedOnly()` refuses **per account** to hand over a drop already marked
  `DropLog.claimed` — worthless whatever the game, since it has gone to whoever the farm account
  was linked to.

Those games are still sellable here, but only from an `unclaimedGame`-backed listing fed by the
no-claim farm. The live CAH Overwatch offer is exactly that shape and is unaffected.

---

## 14. The session, finally understood

Four deaths, three different causes, and the first two diagnoses were both incomplete.

1. **The self-check refreshed as a "test"** and spent the token; the same paste then went to prod.
   → the check no longer refreshes (§9).
2. **Two processes on prod refreshed at once** — the 60s fulfiller tick and an hour-long publishing
   script. → cross-process lock (§13).
3. **The operator's browser rotated the session.** PlayerAuctions allows ONE session per account;
   signing in anywhere invalidates every other copy. Proven by the `sid` claim changing between two
   pastes (`…e288` → `…e929`) while prod sat idle and refreshed nothing — the refresh endpoint then
   answered 401 **with logout cookies** (all three session cookies expired to 1900), which is a
   terminated session, not a rejected token. **Not preventable from the server.**
4. **A pre-flight probe inside our own fulfiller.** `deliverPendingOrders` opened every tick with
   `playerauctionsEnsureFreshSession()`, which called `playerauctionsRefreshSession()` *directly*,
   bypassing the lock. Prod logged a 401 per tick while a standalone process on the same host read
   the account fine. This is the trap the Eldorado plan already documents — *"a pre-flight liveness
   probe races that and loses"* — reintroduced despite the note. Removed; `ensureFreshSession` now
   goes through `paRequest`, so **no unlocked refresh path remains**.

### What this means operationally

- The server keeps the session alive indefinitely **on its own**, as long as nothing else signs in.
- **Opening PlayerAuctions in a browser kills it.** That is inherent to the marketplace.
- `utils/playerauctionsSessionWatch.js` checks every 5 minutes and Telegrams once when it breaks
  (with the recovery steps) and once when it recovers. Recovery is one paste into the keys modal.
- For a long publishing run, park `playerauctionsAutoDeliver=false` first so the tick cannot
  compete, then re-enable. Belt and braces on top of the lock.
