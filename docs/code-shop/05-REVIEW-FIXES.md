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

## R10. Only code sellers set our price (2026-10-16, owner's call)

Nearly every rival on Eldorado sells these rewards as a Twitch-drop ACCOUNT:
the buyer logs in, links the game account and claims within about two weeks.
We sell redeem codes that last months (Overwatch: to Feb 2027) and need no
account. The owner: "these are 2 different things". So:
- `competitors.deliveryForm(title, description)` → `codes | account | unknown`
  from the offer's own wording (negated account words such as "no Twitch
  account or account linking needed" are cut out first; code words vs account
  words, a tie is `unknown`). Measured on the live market 10-16: 69 of 71
  rivals read as `account`, the only `codes` one was a starter-pack key (not
  our set), our own three offers read as `codes`.
- `countsForLowest` also requires `form === "codes"`, so `lowestSameSetUsd`
  comes from code sellers only. Account and unknown offers stay listed with
  their `form`; the panel shows a "Sells" column.

## R11. A seller that says it hands over codes is a code seller (2026-10-18)

A real code bundle on another market (every item of our Overwatch bundles and
more, delivered as codes) said once that the buyer "receives the codes", but
also "any platform you have linked to your account", "if you already claimed
the boxes on Twitch" and "claim the items on the wrong account". Counted word
against word it read as an account offer, so it could never have been our
price to beat. Now:
- login codes ("verification / 2FA / email … code", "the code sent to your
  email") are cut out before anything is counted;
- an explicit code-delivery statement makes the offer `codes`, unless the text
  also states that an account (or its login) is handed over; then the word
  count decides as before;
- a statement is read within one line ("…FAST DELIVERY" closing the title and
  "Codes…" opening the description is not one).
Checked against 74 live offers that day (Eldorado, G2G, PlayerAuctions): that
one offer changed from `account` to `codes`; every Eldorado and G2G rival stayed
`account` and our own offers stayed `codes`.

## R12. PlayerAuctions is a code shop market (2026-10-18, owner's go)

`ALLOWED_MARKETS` = Eldorado and PlayerAuctions. PlayerAuctions claims each
order's units at the moment of sale (no vault), so R1's reason does not apply.
One fixed price for every bundle (`pricing.playerauctionsUsd`, at least $5);
the stock is shared with Eldorado (each shows half, S4); the item leaf is never
"Twitch Drops"; titles fit 150 characters; at most one PlayerAuctions publish a
tick; pause hides PlayerAuctions rows; a code unit is delivered in messages of
at most 300 characters. Contract: 06-PLAYERAUCTIONS-PLAN.md, C1–C8.

## R13. Twitch-account offers are context, never our price (2026-10-19, owner's call)

A market check found that every rival offer naming all the items of our
Overwatch bundles sold a Twitch-drop account, many of them far below our
price. The owner: codes are a different product — redeem only, no account to
link, no link cooldown, and they keep for months — so code bundles stay priced
as their own product and R10 stands: only code sellers set our price. What he
does want is to see that market, and to see when its stock runs out. So:
- `competitors.accountContext(offers)` → `{ count, qty, lowestUsd }` of the
  same-set offers whose form is `account` (stock ≥ 1, a price above 0; every
  price counts, the R8 bait rule is for prices we follow). `scan()` works it out
  over every scored offer and stores it as `competitors.accounts` (event `data`
  and message too). `lowestSameSetUsd` and `pricing.js` are unchanged.
- `CodeProduct.competitors.accounts` defaults to `null`: a product scanned
  before this change reads "not counted yet", never "none".
- The panel prints one line under Competitors and one row in the competitor
  list: "Same rewards as Twitch accounts: N offers from $X, Q in stock (another
  product, not our price)". In that list a price turns orange only for a
  same-set CODE seller under our price; before, a cheaper Twitch account did
  too, which read as "we are undercut".
- LIVE since 2026-10-19 05:22:53 UTC (targeted copy of the four runtime files,
  backup `_deploy_backup_20261019052252_code-shop-account-context` with its
  `manifest.txt`; rollback = copy them back + restart). Checked live the same
  minute: one scan of a 4-code Overwatch bundle stored the account summary,
  `lowestSameSetUsd` stayed null (no code seller) and the fixed price untouched.

## R14. Name the event, show how long the codes last (2026-10-21, owner's ask)

Buyers took two bundles of one event for one account and expected every code to
work; a reward of one event redeems once per account (loot boxes too). Owner:
show the event so a buyer can tell our bundles apart, add the expiry, and never
reveal where the codes come from. So:
- `eventDates.eventStarts` dates each product's event(s) by the campaign's
  start (fallback: the group's first earned code). Buyer texts carry the DATE
  only ("Event 11 Oct 2026"), never the campaign title.
- `texts.defaultTexts({ eventStarts })` puts the event in the title (right after
  the count, so a 150-character market keeps it), an `EVENT:` line and an
  uncuttable `ONE OF EACH REWARD PER ACCOUNT` block in the description, and the
  event in the delivery note. The use-by now always shows: `REDEEM BY` within
  60 days, `VALID UNTIL` after that (and `redeem by` in the delivery note).
- The planner, a custom draft and "reset texts" pass the dates. Live products
  keep their saved texts until they are edited (the edit route pushes title and
  description to Eldorado; PlayerAuctions offers change only by cancel + new id).
