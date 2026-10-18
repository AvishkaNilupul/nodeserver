# Code shop — selling on PlayerAuctions (plan, 2026-10-18)

Status: **plan only.** Nothing is built, nothing is listed. Whether to sell on
PlayerAuctions (PA), which bundles and at what price are the owner's calls
(open questions at the end). The repository is public: the market numbers
behind this plan are kept in the operator's notes, not here.

## Why look at PA at all

A read-only market check on 2026-10-18 (public pages only, no login):

- **Eldorado:** every rival offering our Overwatch rewards sells a Twitch-drop
  ACCOUNT; none sells codes. The analyzer correctly finds no code price to beat.
- **G2G:** has no Overwatch item category at all (`utils/g2gGames.js`
  NOT_LISTABLE), and its Delta Force sellers all sell accounts.
- **PA, Overwatch Items:** sellers deliver the SAME rewards as redeem codes. One
  sells a large multi-item code bundle containing every item of our Overwatch
  bundles; another sells single esports loot box codes. Both have orders and
  recent reviews, at several times our Eldorado bundle price.
- **PA, Delta Force Items:** in-game items and raid services only; no codes.

So PA is the one market seen where buyers already pay for these rewards as
codes. Delta Force is not a PA candidate.

## What already exists and can be reused

1. **Account-listing stock on PA.** `routes/marketplaceRoutes.js` publishes an
   offer-backed row to PA (`mp.playerauctionsPublish` + a `MarketplaceListing`
   carrying `offerRowFields(offer)`, `autoClaimSet: false`). A code product owns
   exactly such an `AccountOffer` (00-OVERVIEW).
2. **Per-sale tracking.** `utils/playerauctionsFulfiller.deliverOrder` claims the
   order's units with `suppliedStock.claimForListing(row, qty, { orderId,
   market: "playerauctions" })` (atomic, stamped with the order id, resumable),
   then `markDelivered` marks them `sold`. `reconcile.js` already turns a sold
   unit into ledger rows `sold` with market, order id and `saleUsd` (newest
   listing of that market). The reason GGSel was refused (R1: it never says
   which unit it sold, units sit in its vault) does not apply: PA claims at the
   moment of sale and has no vault.
3. **Stock sync.** `syncUnclaimedStock` covers `accountOffer` rows: hides the
   offer at 0, shows it again when stock returns, sets the quantity with
   `playerauctionsSetQuantity` (an update REPLACES the offer and issues a new
   offerId; the row is rewritten in place).
4. **Quantity safety.** `paUnits` derives units from money (paid ÷ unit price)
   and falls back to one; PA's own quantity string is an item count.
5. **Proof of delivery** (`utils/playerauctionsProof.js`) never shows the
   credential, so no code ends up in an image PA staff can see.
6. **Titles** go through `paSanitizeTitle` (ASCII fold, cut at 150 characters).

## What blocks it today

- **B1. The delivery message.** PA caps one order message at 300 characters.
  `suppliedMessages` uses the offer's `deliveryTemplate` only when every
  rendered message fits; otherwise it falls back to
  `playerauctionsCopy.deliveryMessages({ kind: "bundle" })`, which is
  Twitch-account copy ("Login: … / Password: …", "Log in on Twitch …"), and it
  THROWS when one unit's text alone exceeds 300 characters. A unit is one
  `password` holding all its code lines, and six code lines are about 300
  characters before any header. Needed: a code-unit path that splits ONE unit's
  lines across messages ("Codes 1-3 of 6: …"), in code-shop wording, resumable
  like today's hand-over; the redeem guide goes in the offer's `instruction`
  field (≤ 500 characters, `playerauctionsCopy` INSTRUCTION_LIMIT).
- **B2. The price floor.** `paItemOfferBody` raises the unit price to
  `PA_MIN_PRICE` ($5) whatever `minUnitPerOrder` says, while PA's own rule is
  price × minimum units per order ≥ $5. Either a code bundle lists at $5 or more
  a unit, or the floor learns `price × minUnitPerOrder` (every PA publish caller
  passes through it; the fulfiller already reads multi-unit orders from money).
- **B3. Code-shop gates.** `publish.ALLOWED_MARKETS = ["eldorado"]`,
  `config.validatePatch` / DEFAULTS `markets`, the `CodeProduct.markets`
  validator, `publishProduct` (only the Eldorado and the dormant GGSel branch),
  `pause` (delists Eldorado rows only), `retire`, and the panel's market
  switches all know nothing of PA.
- **B4. Texts.** The guard allows 160-character titles (Eldorado); PA cuts at
  150, which would drop labels mid-word. A PA title must be built to fit (the
  same "drop labels from the end, add + more" rule as `texts.js`). PA's
  description limit is not known yet: check on the first dry run.
- **B5. One shelf, two markets.** A product's `AccountOffer` would back an
  Eldorado and a PA listing. `suppliedStock` divides one shelf between its live
  listings (S4), and claims are atomic, so a unit is never sold twice, but each
  market then advertises only a share. Alternative: a separate PA product per
  bundle, filled from the same free codes by `allocate.planUnits`.
- **B6. The PA session.** It ends about 24 h after the owner's browser sign-in
  (`docs/PLAYERAUCTIONS-INTEGRATION-PLAN.md`), and PA order intake was failing on 2026-10-17 (separate
  work in progress). While it is down nothing is delivered and the stock sync
  cannot hide anything. A unit the expiry guard pulls (`available → removed`)
  is never claimed, so an order placed on a stale PA offer fails as "only 0 of
  1 left" (a refund, not a double sale). For short-lived codes (Delta Force:
  about 14 days) PA is not worth the risk; for Overwatch (months) a longer
  expiry lead on PA is enough.
- **B7. Loot boxes.** PA's own sellers warn that an esports loot box code does
  not work for an account that already claimed that campaign's box on Twitch or
  YouTube. Any bundle with a loot box should say so in "Good to know"
  (`games.js`), on every market.

## The analyzer and PA

- PA's item listings are server-rendered pages on www.playerauctions.com,
  behind Cloudflare: a plain server request gets 403, a real browser loads them.
- `public-api.playerauctions.com` answers with no login and no challenge, but
  only counts and filters (`/api/game/<Game>/offers/Count?PTypes=item`,
  `/api/game/<Game>/Item?DisplayFileds=Categorys`). The list call the site's
  script names for other product types (`POST /api/game/<Game>/Item/offers`)
  answers 404 for items.
- So there is no automatic PA scan from the server. Options: a hand-entered
  "PA price to beat" on the product (reviewed when the owner looks), or a scan
  run from a real browser by the operator. A headless browser on the server is
  not worth it.
- `deliveryForm` reads PA-style code sellers correctly since R11.

## Proposed build order (small chunks, each tested, all dark by default)

1. B1: code-unit delivery for PA, with tests for a six-code unit (no message
   over 300 characters, resume after a failed send, never the Twitch copy).
2. B3: PA in the market gates (default off), `publishProduct` PA branch on
   the account-listing publish path (dry run first), pause / resume / retire
   for PA rows (hide, delist).
3. B4: a PA title builder (≤ 150) and per-market text checks.
4. B2 and B5 as the owner decides them; B6 expiry lead for PA.
5. First listing by the owner's go: one Overwatch bundle, small quantity.

## Open questions for the owner

1. **Price on PA.** At least $5 a bundle, or (after B2) a lower unit price
   sold in packs (e.g. 5 × $1)?
2. **Which bundles.** The four-spray bundle, the six-code one with the loot box,
   the five-code one with the name card?
3. **Stock.** Share each bundle's stock between Eldorado and PA, or keep a
   separate PA allotment?
4. **Loot boxes.** Sell them on PA despite the "already claimed on Twitch"
   caveat (and add that warning everywhere)?
5. **Delta Force.** Leave it off PA (no code market there, short code life)?
