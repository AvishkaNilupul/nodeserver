# Account listings + auto-picked categories — build contract

Frozen 2026-09-10. Requested by the owner:

> "the manual listing system that we already have for ggsel platimarket and
> similar ones — I need to enter which category this is. We only do Twitch
> drops, so I need a system to auto select that instead of me selecting them.
> And a whole new thing: it's like the Shop listings tab, but I need to be able
> to load a list of accounts when I'm going to list something, and those are the
> accounts which are going to deliver, and it's automatic delivery like our
> system now."

Two features. They share the publish route and the Listings page and nothing
else. **A is small and mostly already built. B is a fourth stock mode.**

Decisions the owner made when asked (2026-09-10):

| Question | Answer |
| --- | --- |
| Where do B's accounts come from? | **A pasted / uploaded raw list.** Not a pool picker. |
| How does a listing with N accounts sell? | **N units, one account per sale.** Auto-pause when dry. |
| Which marketplaces? | **All of them.** |
| How much category control stays? | **Auto-pick, with a "Change" link that reveals the old picker.** |

---

## Ground truth this contract is built on

Verified by reading the code on 2026-09-10 (six mappers + an adversarial
critic). Anything below contradicting the code is a bug in this document —
trust the code and say so.

1. **Only three markets make the owner pick a category by hand**: Plati /
   Digiseller (`#mpDsCategory` + `#mpDsAttrs`), GGSel (`#mpGgCategory`), FunPay
   (`#mpFpNode`, a bare numeric box typed from memory). ZeusX, Eldorado and
   Gameflip already resolve with zero UI.
2. **`utils/autoLister.js` already publishes to seven markets with no human.**
   That is the existence proof: `mp.ggselResolveCategoryId(game)`,
   `brandForGame(game)` (`utils/g2gGames.js:573`), `mp.zeusxResolveCategory`,
   and the two settings globals `autoFarm.platiCategoryId` (`"34187"`) +
   `autoFarm.platiAttributes`.
3. **The manual G2G publish path is dead code.** `routes/marketplaceRoutes.js`
   forwards only `productId`; `g2gPublish` throws *"G2G brand_id is required
   (the game)"* at `utils/marketplaces.js:3004`.
4. **PlayerAuctions and Z2U are offered as publish targets in the modal and
   have no branch in the route** — they hit `"Unknown marketplace"`.
5. **`DropSet` has no `game` field.** `set.game` is dead code in the zeusx
   branch, the eldorado branch and `/marketplaces/epicnpc/prepare`. "What game
   is this listing" has four spellings and no canonical one.
6. **`reserveSetOnAccount` cannot represent an account outside the Drop
   Archive.** It returns false unless the account already holds a `DropLog` row
   for every `itemKey` (`utils/dropReservation.js:44-57`). So a pasted external
   account can never be reserved, is invisible to `availableAccountsForSet`,
   and cannot use any existing claim path. **This is the load-bearing
   constraint on Feature B.** It is why B is a new mode and not
   `DropSet.accountScopeIds` plumbing.
7. **`units[]` alone is not enough either.** Every credential resolver
   (`g2gFulfiller.credentialsFor:445`, `playerauctionsFulfiller:314`,
   `eldoradoFulfiller:505-524`) looks the password up in `BotAccount` by
   accountId or login. A pasted account is in no such row. And
   `eldoradoFulfiller.undeliveredUnits:304` requires `u.accountId`, so a unit
   without one counts zero.
8. **Z2U has no `units[]` branch at all.** `utils/z2uFulfiller.js:491-513` is
   `if (row.unclaimedGame) … else if (row.set) { claimAccountsForSet } else
   { skip }`. A supplied-list row that also carried a `set` would silently
   deliver a *different* account off the Drop Archive. **The supplied branch
   must go ABOVE the `row.set` branch, and a supplied row must not carry a
   set.**
9. **Five stock counters exist and each returns 0/null for a row it does not
   recognise** — and 0 takes a live offer off sale (eldorado pause, PA hide,
   G2G delist, Z2U off_line). A mode invisible to them silently unlists itself.
10. `models/MarketplaceListing.js:86-91` records what happens when a value
    reaches the DB through a validation-skipping write before the enum learns
    it: 33 rows with `status:"removed"`, every later `doc.save()` throwing.
    **Do not use `validateBeforeSave:false`. Widen the schema instead.**

### Pre-existing breakage fixed before this work started (already landed)

- `utils/archiveExclusions.js`, `utils/archiveSnapshot.js` and
  `models/ArchiveRollup.js` were missing from the checkout while
  `routes/dropArchiveRoutes.js` required them — **the server could not boot and
  no test touching that router could run.** Restored from `cfce78b`.
- `routes/dropArchiveRoutes.js:2008` used `"$i.image"` inside a `$map` where
  Mongo needs `"$$i.image"`, so **every thumbnail on the Listings page's
  "Existing listings" rows was blank**. Fixed; `tests/dropSetsListLight.test.js`
  now passes.

Baseline after those two fixes: **`npm test` fully green.** Any new failure is
ours.

---

## Conventions every agent must follow

- Node CommonJS, 2-space indent, double quotes, trailing commas, ~80–90 cols.
  **Never run `npm run format`** — 208 files already fail `prettier --check`
  and it would bury the change.
- `node --test tests/<file>.test.js`. No jest, no supertest, no `describe()`.
  Lead each test file with a comment saying which failure it prevents.
- **No source-text tests** (`fs.readFileSync` + regex). The repo has explicitly
  repudiated them (`tests/farmProvisioning.test.js:20-22`).
- Un-stubbed Mongoose calls do not fail — they stall for 10s. Stub or use
  `mongodb-memory-server`.
- **Never spread a Mongoose sub-document.** `{...listing.units[0]}` yields
  `login: undefined`; that shipped "Username: undefined" to a paying buyer.
- DI idiom for anything doing I/O: a trailing injectable callable
  (`async function x(a, b, doIt = realDoIt)`), as
  `utils/playerauctionsFulfiller.js:421` does.
- Log through `utils/systemLog.logEvent` (best-effort, never throws).
- **Live markets are online.** No new code may make a network call at require
  time or on module load. Every new HTTP call must be bounded by a timeout.

---

# FEATURE A — the category picks itself

## A1. `utils/listingGame.js` (NEW, pure, no I/O)

The canonical answer to "what game is this listing", because there are four
spellings today and `DropSet.game` does not exist.

```js
// listingGame({ set, offer, listing, game }) -> string ("" when unknowable)
//   explicit `game` wins, then offer.game (Feature B),
//   then set.coverGame, then the first non-empty set.items[i].game,
//   then listing.title's leading game guess is NOT attempted (too lossy).
function listingGame(src) -> string
module.exports = { listingGame };
```

Pure. Takes plain objects. No requires beyond none.

## A2. `utils/listingCategory.js` (NEW)

One resolver per marketplace, one shape out. **Every network call is bounded.**

```js
const RESOLVE_TIMEOUT_MS = 8000;   // exported, overridable in tests

// resolveCategory(marketplace, game, opts?) -> Promise<Resolution>
// Resolution = {
//   ok: boolean,          // true = we have a placement to publish with
//   marketplace: string,
//   value: object,        // merged into the publish body for that market
//   label: string,        // human path, e.g. "Games > Overwatch 2 > Twitch Drops"
//   source: "history"|"search"|"settings"|"static"|"catalog"|"none",
//   reason: string,       // why not, when ok === false
// }
//
// opts = { deps }  -- deps is a factory map for tests, REAL_DEPS pattern from
//                     utils/systemHealth.js:52-94. Never values, always
//                     factories: { mp: () => require("./marketplaces"), ... }
async function resolveCategory(marketplace, game, opts = {})
module.exports = { resolveCategory, RESOLVE_TIMEOUT_MS, MARKETS_NEEDING_CATEGORY };
```

Per-market behaviour — **each "no answer" is different and must stay
different.** An "always pick something" rule recreates the
Fortnite-filed-under-Copper-Ore failure the code exists to stop.

| market | how | `value` shape | on miss |
| --- | --- | --- | --- |
| `ggsel` | `mp.ggselResolveCategoryId(game)`, bounded | `{ categoryId }` | fall back to `settings.autoFarm.ggselCategoryId`; if that is empty → `ok:false` |
| `digiseller` | `settings.autoFarm.platiCategoryId` + `platiAttributes` | `{ categories: [{ owner: 1, categoryId, attributes }] }` | `ok:false, reason:"No Plati category configured in Auto-farm settings"` |
| `funpay` | `settings.autoFarm.funpayNodes` matched on the normalised game | `{ node }` | `ok:false, reason:"No FunPay node mapped for <game>"` |
| `g2g` | `brandForGame(game)` (`utils/g2gGames.js:573`) | `{ serviceId, brandId, seoTerm }` | `null` is a **deliberate** NOT_LISTABLE (Overwatch, R6) → `ok:false, reason:"G2G does not list <game>"` |
| `zeusx` | `mp.zeusxResolveCategory(game)`, bounded | `{ serviceCategoryId, serviceCategoryBaseId, gameId }` | `ok:false` |
| `eldorado` | static — native Twitch Drops node | `{}` | never misses; `ok:true, source:"static"` |
| `gameflip` | static category enum | `{}` | never misses |
| `playerauctions` | `mp.playerauctionsResolveGame` + `playerauctionsPickItemPath`, bounded | `{ gameId, itemId, itemPath }` | `null` is deliberate → `ok:false` |
| `epicnpc` | `epicnpc.nodeForGame(game)` | `{ node }` | `ok:false` |
| `z2u` | `mp.z2uGameOptions(service, game)`, bounded | `{ gameName, service }` | `ok:false` |

**The GGSel cold-cache trap.** `ggselCategoryHistory` (`marketplaces.js:2048`)
is a *serial* loop of awaited axios calls at a 20s timeout each, up to 100
offers. Un-bounded, it blocks a superadmin HTTP request for minutes. Wrap every
resolver call in `Promise.race([call, timeout(RESOLVE_TIMEOUT_MS)])` and treat
a timeout as a miss (falling back to the settings value where one exists).
Cache resolutions in-process, keyed `marketplace + "|" + lowercased game`, with
a 30-minute TTL, and cache misses too (a shorter 5-minute TTL) so a bad game
name cannot re-trigger the serial loop on every modal open.

## A3. Route: `GET /marketplaces/suggest-category`

`routes/marketplaceRoutes.js`, `requireSuperadmin`. Modelled on the existing
`POST /marketplaces/epicnpc/prepare` (`:1040`), which is the working precedent
for the auth shape and the refusal UX.

```
GET /marketplaces/suggest-category?marketplaces=ggsel,digiseller&game=Overwatch%202
GET /marketplaces/suggest-category?marketplaces=ggsel&setId=<id>
GET /marketplaces/suggest-category?marketplaces=ggsel&offerId=<id>
->  200 { success: true, game: "Overwatch 2",
          results: { ggsel: <Resolution>, digiseller: <Resolution> } }
```

Never 500s on a resolver miss — a miss is a `Resolution` with `ok:false`.
Resolves markets **in parallel**, each already individually bounded.

## A4. Server-side fallback in `POST /marketplaces/publish` — the load-bearing half

For `ggsel`, `digiseller`, `funpay` and `g2g`: when the body omits the category
(or sends an empty one), call `resolveCategory` server-side and use the result.
A body-supplied category always wins — that is what the "Change" link produces.

When resolution fails, that marketplace's entry in `results` becomes
`{ success:false, message: reason }` and **the other marketplaces still
publish** (the loop is already per-market and must stay that way).

Also fix, in the same route, because they are the same defect:

- **G2G**: forward `serviceId` + `brandId` from the resolution alongside
  `productId`, so the manual path stops throwing. Do **not** restructure
  `g2gPublish`'s draft creation — its create is a separate empty-draft POST
  that returns the same shell on a repeat, and a half-fix leaves junk offers.
- **PlayerAuctions**: add a branch. `playerauctionsPublish` returns
  `{ offerId, id, url, raw }` — **not `{ externalId }`**. Write
  `externalId: r.offerId`, exactly as `utils/autoLister.js:1148` does.
  `externalId` is `required:true`, so the naive generic tail throws a
  ValidationError *after* a live offer exists with nothing recording it.
  Copy autoLister's **harder** guard too (`:1118-1126`): refuse the no-claim
  games (Overwatch / Rainbow Six / Call of Duty) for **DropSet-backed** rows,
  because auto-farm stock for them is claimed and the listing could never be
  honoured. A Feature-B (supplied-account) row is exempt — its stock is real.
- **Z2U**: `z2uBulkPublish` returns `{ reply, rows, gameName }` **with no offer
  id**. Do not invent one and do not write a row with an empty `externalId`.
  Return `{ success:false, message:"Z2U publishing has no offer id to record —
  use the Z2U shelf keeper" }` for now, and log it. A wrong row here is worse
  than no row.
- `GET /marketplaces/listings` writes `setId: String(r.set)` with no null
  guard, so a set-less row serialises `setId` as the literal string
  `"undefined"`. Guard it: `setId: r.set ? String(r.set) : ""`.
- `set.game` in the zeusx and eldorado branches is dead — replace with
  `listingGame({ set, game: body.game })`.

## A5. UI (`public/listings.html`)

In each placement box (`#mpDsBox`, `#mpGgselBox`, `#mpFpBox`, `#mpG2gBox`), add
above the existing picker:

```html
<div class="mp-auto" id="mpDsAuto">
  <span class="mp-auto-label">Category: <b>…</b></span>
  <a href="#" class="mp-auto-change">Change</a>
</div>
```

- On modal open and **again inside the `ensureSetItems` hydration callback**
  (`public/listings.html:3365-3379`), call `/marketplaces/suggest-category`.
  **This re-fire is mandatory**: on a light list row `set.items` is undefined
  until hydration resolves, so a call at open time sees only `coverGame` or
  `""`. The existing `epicGameForSet`/`updateEpicNote` pair has this exact bug
  today — do not copy it, fix the new code.
- `ok:true` → show the label, hide the drill-down picker, and let the publish
  body omit the category entirely (the server resolves it again).
- `ok:false` → show `reason` in the warning style and **open the picker
  automatically**, so the owner is never blocked.
- "Change" reveals the picker; once the owner picks, the body carries their
  choice and it wins.
- The existing publish guards ("Drill down to a Plati catalog category first",
  etc.) must only fire when the auto-resolution failed **and** nothing was
  picked.

---

# FEATURE B — account listings (a fourth stock mode)

An **account listing** is a product the owner defines by hand and backs with an
explicit, pasted list of accounts. Those exact accounts are the stock. One sale
hands over one account. When the list runs dry the offer pauses itself.

It is deliberately **not** a `DropSet`: it has no items, no `DropLog` rows, no
reservation, and it must never appear in the Shop tab, the public catalog, the
Drop Archive, or any archive-backed stock count.

## B1. `models/AccountOffer.js` (NEW) — the product

```js
{
  title: String (required, trim),
  description: String (default ""),
  game: String (default "", index),        // the canonical game for Feature A
  note: String (default ""),
  priceUsd: Number (default 0, min 0),
  minPriceUsd: Number (default 0, min 0),  // never publish below this
  status: enum["draft","active","archived"] (default "draft", index),
  autoDeliver: Boolean (default true),     // per-offer kill switch
  // Delivery text. Placeholders: {login} {password} {token} {email} {extra}
  // {line} {title} {game}. Empty = DEFAULT_TEMPLATE from utils/suppliedStock.
  deliveryTemplate: String (default ""),
  // Promo cover, reusing the Custom-listings cover generator verbatim.
  coverStyle: String (default "promo"),
  coverServiceText: String (default ""),
  coverBullets: [String] (default []),
  coverImages: [String] (default []),
  createdBy: String (default ""),
}
```
`timestamps: true`. **No `publicCatalog` field and no `listed` field** — an
AccountOffer can never leak onto the public storefront, which is what
`DropSet.publicCatalog` defaulting to `true` would have done.

## B2. `models/SuppliedAccount.js` (NEW) — the stock ledger

Deliberately mirrors `models/UnclaimedAccount.js`: a per-account ledger whose
status transitions are the atomic claim.

```js
{
  offer: ObjectId ref "AccountOffer" (required, index),
  login: String (required),
  loginLower: String (index),              // lowercased mirror, always written
  password: String (default ""),           // encrypted via utils/secretBox
  clientSecret: String (default ""),       // encrypted
  email: String (default ""),              // encrypted
  extra: String (default ""),              // anything past field 4, verbatim
  status: enum["available","fed","sold","removed"] (default "available", index),
  // "fed"  = handed to a platform's own vault (Digiseller content, GGSel
  //          content, FunPay secret, Gameflip code, ZeusX field). No longer
  //          sellable anywhere else; not yet known to have reached a buyer.
  // "sold" = confirmed handed to a buyer.
  market: enum["","gameflip","digiseller","ggsel","funpay","zeusx",
               "eldorado","playerauctions","g2g","z2u"] (default ""),
  listing: ObjectId ref "MarketplaceListing" (default null, index),
  contentId: String (default ""),          // Digiseller content_id when fed
  orderId: String (default "", index),
  conflict: String (default ""),           // "" | "in-archive" | "duplicate"
  fedAt / soldAt / deliveredAt: Date (default null),
  note: String (default ""),
}
```
`timestamps: true`. **Unique compound index `{ offer: 1, loginLower: 1 }`** —
the same login cannot be added to one offer twice.

**`conflict: "in-archive"`** is set at ingest when the login already exists as a
`BotAccount` or an `AvailableAccount`. Such a row is **excluded from claimable
stock** until the owner clears it, because the archive path could sell the same
account. This is the double-sell guard and it is not optional.

## B3. `models/MarketplaceListing.js` — the one schema change

```js
// Account listings (docs/ACCOUNT-LISTINGS-CONTRACT.md): this row's stock is an
// explicit, owner-supplied list of accounts held in models/SuppliedAccount,
// claimed one per sale. Mutually exclusive with `set`, `unclaimedGame` and
// `autoClaimSet`.
accountOffer: { type: ObjectId, ref: "AccountOffer", default: null, index: true },
```

and widen the `set` requirement, **properly, in the schema** — never with
`validateBeforeSave:false`:

```js
required: function () {
  return !this.unclaimedGame && !this.accountOffer;
},
```

Nothing else in this model changes. `marketplace`, `status` and `origin` enums
are untouched, so `tests/marketClaimTags.test.js` stays green.

## B4. `utils/suppliedStock.js` (NEW) — the single shared claim layer

**Every fulfiller calls this and nothing else.** No fulfiller may query
`SuppliedAccount` directly.

```js
const DEFAULT_TEMPLATE =
  "Login: {login}\nPassword: {password}\n\n" +
  "Do not change the email or the password.";

// ---- ingest ----------------------------------------------------------------
// Extends utils/parseAccountList to 2-5 colon fields. Slot 3 is disambiguated
// by "@" exactly as parseAccountList does, so an email is never stored as a
// bogus token. Leading "*"/"-" bullets tolerated. A line that cannot be split
// into >= 2 non-empty fields is REPORTED, never guessed at.
//   login:password
//   login:password:token
//   login:password:email
//   login:password:token:email
//   login:password:token:email:anything-else -> extra
parseSuppliedAccounts(text) -> { accounts: [{login,password,clientSecret,email,extra,raw}], badLines: [] }

// Encrypts password/clientSecret/email through utils/secretBox before writing.
// Skips (and reports) logins already on the offer; flags conflict:"in-archive"
// for logins that exist in BotAccount or AvailableAccount.
async addAccounts(offerId, text, opts?) -> { added, duplicates: [], conflicts: [], badLines: [] }

// ---- reading ---------------------------------------------------------------
async stockFor(listingOrOfferId) -> number   // available, conflict-free, count
async offerStats(offerId) -> { available, fed, sold, removed, conflicts, total }
isSuppliedRow(listing) -> boolean            // !!(listing && listing.accountOffer)

// ---- claiming --------------------------------------------------------------
// THE contract every fulfiller depends on. Returns the SAME shape as
// eldoradoFulfiller.claimUnclaimedForGame so call sites stay symmetrical:
//   [{ ledgerId, login, password, clientSecret, email, extra, raw }]
// - RESUMES FIRST: rows already carrying this orderId are returned before any
//   new claim, so a retry after a failed send never burns a second account.
//   (utils/playerauctionsFulfiller.js:166 is missing exactly this block and it
//   burned 25 retries of ledger on Eldorado order e69b19d3.)
// - Then claims atomically, one row at a time:
//     findOneAndUpdate({ _id, status: "available" }, { $set: {...} })
//   so two concurrent orders can never take the same row.
// - Skips conflict !== "" rows.
// - Returns FEWER than `want` when stock is short. Callers MUST check the
//   length; a short claim is not a success.
// - dryRun: counts and returns candidates without writing.
async claimForListing(listing, want, { orderId, market, dryRun }) -> Account[]

// Puts rows back. Used on every failure path. Only ever releases the ids given.
async releaseClaim(ledgerIds, { orderId }) -> number

// Marks rows as handed to a platform vault (the credential-baked-in markets).
async markFed(ledgerIds, { listing, market, contentIds }) -> number

// Marks a claimed row as actually delivered to a buyer.
async markDelivered(ledgerIds, { orderId, market }) -> number

// ---- delivery text ---------------------------------------------------------
// Decrypts, renders the offer's template (or DEFAULT_TEMPLATE), and NEVER
// spreads a Mongoose sub-document — fields are read through their getters.
deliveryText(account, offer) -> string
```

`claimForListing` returns **decrypted** credentials. Nothing may persist a
decrypted password onto `MarketplaceListing`.

## B5. Wiring — where the new branch goes, per file

**Every branch is additive and guarded by `if (row.accountOffer)`.** No
existing branch may change behaviour when the field is absent. That is what
keeps live listings safe.

Claim-at-sale markets (the branch goes **before** the existing ones):

| file | insert at | also update |
| --- | --- | --- |
| `utils/eldoradoFulfiller.js` | `deliverOrder`, beside the `unclaimedGame` branch and **before** the `"manual-delivery listing"` skip (~:414) | `syncBundleStock` — widen the `$or` (~:587) **and** the `real` computation (~:595) |
| `utils/playerauctionsFulfiller.js` | `deliverOrder`, before the skip (~:739) | `stockFor` (~:421) and the `syncUnclaimedStock` query (~:487) |
| `utils/g2gFulfiller.js` | `pickStock`, before the units fallback (~:148) | `realStockFor` (~:598), `credentialsFor` (~:445), `releaseAccounts` (~:126) |
| `utils/z2uFulfiller.js` | **ABOVE the `row.set` branch** (~:491) — see ground truth #8 | `realStockFor` (~:90), `releaseClaim` (~:400) |

Credential-baked-in markets (claim happens at **publish / feed**, not at sale):

| file | what |
| --- | --- |
| `routes/marketplaceRoutes.js` | the digiseller (~:660), ggsel (~:770) and funpay (~:855) claim sites: when the row is offer-backed, claim from `suppliedStock` instead of `claimAccountsForSet`, and release through `suppliedStock.releaseClaim` on throw |
| `utils/marketplaceGuardian.js` | `feedListing` (~:707) — top up a ggsel/digiseller quantity offer from the offer's remaining stock; `runChecks` must **SKIP** offer-backed rows (they have no `DropLog` rows, so every pass would raise a high-severity `claim-mismatch` that `guardianAutoHeal` then tries to "fix" into a reserve it cannot perform) |
| `utils/gameflipFulfiller.js` | `publishAutoDelivery` — one supplied account per listing, plus a matching release |
| `utils/listingDetach.js` | an early `accountOffer` branch that marks the matching `SuppliedAccount` `removed`, instead of falling through to the bare "remove it there manually" warning |
| `utils/suspendedAccounts.js` | its sweep must not try to detach offer-backed rows through the archive path |

**Row fields on an offer-backed listing:**

- `accountOffer` — set. `set` — **null**. `autoClaimSet` — false.
  `unclaimedGame` — "". `origin` — `"manual"`, passed **explicitly** (never
  leaning on the schema default), so no future default change can enrol
  owner-supplied stock into automatic repricing.
- `units[]` — one entry per account handed over or fed:
  `{ contentId: <SuppliedAccount _id>, accountId: "", login, addedAt,
     deliveredAt, orderId }`. The `login` matters: `utils/listedLogins.js`
  reads `units[].login`, which is what stops a supplied login also being sold
  by an archive-backed listing.
- `accountId` and `accountLogin` — **left empty on purpose.**
  `marketplaceGuardian.runChecks` indexes duplicates off exactly those two
  fields; writing them would raise a duplicate finding on every single pass.
- `requiredDrops` — **left empty on purpose.** A supplied account is
  **trusted**, not verified: there are no `DropLog` rows to check it against,
  so an enabled gate would refuse every delivery with a paid buyer waiting.
  The owner's typed description is the contract.
- **No `DropLog` reservation and no claim tag.** `utils/marketClaimTags.js` is
  not touched, so `tests/marketClaimTags.test.js` stays green. Double-selling
  is prevented by the ledger's atomic status transition plus the
  `conflict:"in-archive"` gate, not by `DropLog`.

## B6. Routes — `routes/accountListingRoutes.js` (NEW)

All `requireSuperadmin`. Mounted in `server.js` beside the other route modules.

```
GET    /account-listings                      -> { success, offers: [{...,stats}] }
POST   /account-listings                      -> { success, offer }
GET    /account-listings/:id                  -> { success, offer, stats }
PUT    /account-listings/:id                  -> { success, offer }
DELETE /account-listings/:id                  -> 409 while any listing is active
GET    /account-listings/:id/accounts?status= -> { success, accounts: [] }  // NEVER returns credentials
POST   /account-listings/:id/accounts         -> body { accounts: "<pasted text>" }
                                                 { success, added, duplicates, conflicts, badLines }
DELETE /account-listings/:id/accounts/:accId  -> marks removed (only when available)
POST   /account-listings/:id/accounts/:accId/allow  -> clears conflict, makes it claimable
POST   /account-listings/:id/cover-preview    -> reuses the custom-cover generator
```

**`GET .../accounts` must never return a password, token or email** — not even
masked-but-decryptable. It returns `{ id, login, status, market, conflict,
orderId, fedAt, soldAt, deliveredAt, hasPassword, hasToken, hasEmail }`.

`POST /marketplaces/publish` gains `offerId` as an alternative to `setId`, so
all nine marketplace branches are reused rather than duplicated. Exactly one of
the two must be present.

## B7. UI — a third tab in `public/listings.html`

Four edits, matching how `tabCustom` was added: a third `<button class="btn
tbtn" id="tabBtnAccounts">Account listings</button>` in the `.tabbar`, a third
`<div id="tabAccounts">` pane, `switchTab()` rewritten from a boolean to a
three-way, and a loader appended to the `// ---- init ----` block.

The pane mirrors the Shop tab's two-column grid:

- **Left — "Create an account listing"**: Title, Game, Description, Price,
  Delivery template (with a placeholder legend), cover subtitle/bullets, and
  Save / Save as draft.
- **Right — "Accounts in this listing"**: a paste textarea + a `.txt` file
  picker, an "Add accounts" button, and a result line
  (`added / duplicates / already in the archive / bad lines`). Below it a stock
  table: login, status chip, market, order, and Remove. Conflicts render in the
  warning style with an "Allow anyway" button explaining that the account also
  exists in the Drop Archive.
- **Full width — "Account listings"**: the existing rows list, showing per-offer
  `available / fed / sold`, where it is published, and the same
  Edit / "Sell on…" / Delist actions. "Sell on…" opens the **existing**
  `#mpPubOverlay` with `offerId` instead of `setId`.

Use only the existing classes (`card`, `field`, `row2`, `btn`, `primary`,
`fchip`, `pick`, `empty`, `sub`, `list-toolbar`, `mp-*`) and the existing
helpers (`$`, `esc`, `attr`, `toast`, `api`). No new CSS system, no framework,
no build step.

## B8. Settings + kill switch

`utils/settings.js` gains, at the top level (not inside `autoFarm`):

```js
const ACCOUNT_LISTING_DEFAULTS = {
  enabled: true,        // the tab + routes
  autoDeliver: true,    // global kill switch over every offer's own toggle
  lowStockWarnAt: 2,    // Telegram warning when an offer drops to this
};
```

Delivery is gated on `enabled && autoDeliver && offer.autoDeliver`. The owner
can stop every account-listing delivery with one live settings edit without
touching any other market.

## B9. Tests (all new files, `tests/*.test.js`)

| file | covers |
| --- | --- |
| `tests/suppliedParse.test.js` | `parseSuppliedAccounts`: 2/3/4/5 fields, the `@` disambiguation, bullets, bad lines reported not guessed, a password containing `:` |
| `tests/suppliedClaim.test.js` | `claimForListing` under `mongodb-memory-server`: two concurrent claims never take one row; a short claim returns fewer; **the resume path returns the same account for a repeated orderId and claims nothing new**; conflicts are skipped; release puts rows back |
| `tests/suppliedDelivery.test.js` | `deliveryText` renders every placeholder, decrypts correctly, and never emits `undefined` (the "Username: undefined" regression) |
| `tests/accountListingRoutes.test.js` | the routes: ingest reports duplicates/conflicts/bad lines; `GET .../accounts` **never leaks a credential**; delete is refused while a listing is active |
| `tests/listingCategory.test.js` | every market's hit and miss, the three distinct "no answer" semantics, the timeout falling back rather than hanging, and cache behaviour — all with injected deps, no network |
| `tests/listingGame.test.js` | the precedence chain, including a light set row with no `items` |
| `tests/suppliedFulfilment.test.js` | each fulfiller's new branch picks supplied stock, and **an offer-backed row on Z2U does not fall through to the archive claim** (ground truth #8) |

Every one must run with **no network and no live Mongo** unless it uses
`mongodb-memory-server`, and the full `npm test` must stay green.
