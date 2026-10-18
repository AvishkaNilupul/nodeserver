# Code shop — markets (text guard, cover, fill, publish, competitors, pricing)

## `utils/codeShop/textGuard.js` (pure)

```js
compileSourceWords(list)   // -> RegExp (case-insensitive) joining the sources with "|"; bad sources skipped
findSourceWord(text, re)   // -> the matched word or null
checkBuyerText({ title, description, deliveryTemplate, coverTitle, coverServiceText, coverBullets, labels }, { sourceWords })
  // -> problems: [String]  (empty = OK)
```

Problems (one string each, plain English, name the field): empty title; title
over 160 chars; description over 2000; delivery template without `{password}`;
an empty label; a source word in ANY field or label (say which word); a
non-ASCII character in title / description / delivery template / any label /
cover text. `coverBullets` at most 4.

## `utils/codeShop/cover.js`

`createCover(deps)` → `{ build(product) }` → local file path (caller deletes it);
pure `gridFor(n)` → `{ cols, rows }`.

- Images: each slot's `image` (an `https://` URL or a `/path` under `public/`), in slot order.
- `gridFor(n)`: n ≤ 4 → 2×2; n ≤ 12 → rows 2, cols `ceil(n/2)`; else rows 3,
  cols `min(6, ceil(n/3))`. Tiles beyond 18 images are cut.
- Spare tiles (and slots without an image) get a filler tile: a 512×512 PNG
  with the slot count big and "CODES" small (sharp + SVG, purple `#7c3aed`),
  written to `public/_tile_<random hex>.png` for the render and deleted in
  `finally` (`buildPromoCoverImage` reads tiles only from `public/` or https).
  At least one real image is required, else throw `"no item images for the cover"`.
- `deps.setImage().buildPromoCoverImage({ title: texts.coverTitle, serviceText: texts.coverServiceText, bullets: texts.coverBullets, itemImages, twitchTiles: false, cols, rows })`.

## `utils/codeShop/fill.js`

`createFill(deps)` → `{ run({ force = false, productIds } = {}) }` → `{ built, failed, byProduct: {id: n} }`.
Skips unless `config.autoBuildUnits` or `force`. Active products with an
`offer` (optionally only `productIds`) + all `in_stock` rows → `planUnits`
(lead = `expiryLeadHours`) → `units.build` per plan. One event per product that
got units ("Added N bundles to <name>").

## `utils/codeShop/publish.js`

`createPublisher(deps)` → `{ problems(product), approve(id, opts), publishProduct(id, opts), pause(id, opts), resume(id, opts), retire(id, opts) }`.
`ALLOWED_MARKETS = ["eldorado", "playerauctions"]` (GGSel refused, R1; PlayerAuctions
since 2026-10-18: publish, share of the shelf, pause/retire and delivery are in
06-PLAYERAUCTIONS-PLAN.md, "Build contract" C1–C8); `ELDORADO_MIN_USD = 0.5`.

`problems(product)` → [String]: no slots; duplicate slotKeys; `checkBuyerText`
problems (sourceWords from config); price below `ELDORADO_MIN_USD` or below
`floorUsd`; a market not in `ALLOWED_MARKETS`; no market enabled in config.

`approve(id, { actor, rebalance = false, publish = true })`:
1. product must be `draft` (or `paused` with no offer); `problems` must be empty
   → else `{ ok: false, problems }`.
2. Create the `AccountOffer`: `title, description, game: marketGame,
   note: "code shop product " + id, priceUsd, minPriceUsd: floorUsd,
   status: "active", autoDeliver: true, deliveryTemplate, coverStyle: "promo",
   coverServiceText, coverBullets, coverImages: slot images, createdBy: actor`.
3. Product → `active`, `offer`, `approvedAt`, `approvedBy`, `edited: true`.
4. `rebalance`: `units.dissolve` every OTHER active product of the same game
   that shares a slotKey with this one (reason "moved to <name>").
5. `fill.run({ force: true })` so stock is built across all products.
6. `publish` → `publishProduct(id)`. Returns `{ ok: true, product, built, publish }`.

`publishProduct(id, { actor })` → `{ results: [{ market, ok, skipped?, externalId?, url?, error? }] }`.
For each market in `product.markets` ∩ `ALLOWED_MARKETS` ∩ enabled `config.markets`:
- skip `"already live"` when a `MarketplaceListing {accountOffer, marketplace, status: "active"}` exists;
- `shelf = stock().shelfFor(offer)`; `< 1` → skip `"no stock yet"`;
- price = `max(priceUsd, floorUsd, 0.5)` rounded to cents.
- **eldorado**: `path = cover.build(product)`; `made = mp().eldoradoPublish({ game: marketGame, title, description, priceUsd: price, quantity: shelf, minQuantity: 1, coverImagePath: path })`;
  delete the file; then `MarketplaceListing.create({ set: null, accountOffer: offer, origin: "manual", accountId: "", accountLogin: "", units: [], marketplace: "eldorado", externalId: made.externalId, externalNode: "", url: made.url || "", title, description, price, status: "active", note: "code shop" })`.
  If the row create fails → `mp().eldoradoDelist(made.externalId)` (a live offer
  with no row is an order nobody delivers) and report the error.
  An error message matching `/maximum of \d+ active offers|offer creation limits/i`
  → result error `"Eldorado's offer limit for this category is full"`.
- **ggsel**: skip `"GGSel takes no new stock"` unless `mp().ggselTakesNewStock()`.
  `res = await category().resolveCategory("ggsel", marketGame)`; `!res.ok` →
  error. `qty = min(product.ggsel.vaultSize, shelf)`;
  `claimed = await stock().claimForListing(offer, qty, { market: "ggsel" })`;
  none → skip. `offerDoc = AccountOffer` lean; `texts = claimed.map(c => stock().deliveryText(c, offerDoc))`;
  any empty → `releaseClaim(ids)` + error. `made = mp().ggselPublish({ title, description, priceUsd: price, categoryId: res.value.categoryId, quantity: texts.length, delivery: "auto", instructions: guide.deliveryHelp, coverImagePath, products: texts })`;
  throws → `releaseClaim(ids)` + error. Row: as Eldorado plus `marketplace: "ggsel"`, `autoDeliver: true`,
  `qtyTarget: qty`, `units: claimed.map(c => ({ contentId: c.ledgerId, accountId: "", login: c.login, addedAt: now, deliveredAt: null, orderId: "" }))`;
  then `stock().markFed(ids, { listing: row._id, market: "ggsel" })`. Row create
  fails → `mp().ggselDelist(externalId)`, KEEP the claim (the codes are in GGSel's
  vault), mark those ledger rows `held` ("left in a GGSel vault by a failed publish").
- Always: `product.publish = { lastError, lastAttemptAt: now }`; event per market; a
  failure also sends one Telegram line.

`pause(id)`: for each active Eldorado row of the offer → `mp().eldoradoDelist(externalId)`
and set the row `status: "delisted"`. GGSel rows are NOT touched here (the
vault must be emptied from the Listings page) — the result says so. Product →
`paused` (fill skips it; its units stay on the shelf of an offer with no live listing).
`resume(id)`: product → `active`, then `publishProduct(id)`.
`retire(id)`: refuse while an active GGSel row exists; `pause`, then
`units.dissolve(product, { reason: "retired" })`; product → `retired`, `retiredAt`.

## `utils/codeShop/competitors.js`

`createCompetitors(deps)` → `{ scan(product) }`; pure `queriesFor(product, guide)`,
`scoreOffer(title, labels, description)`, `phrasesOf(label)`, `deliveryForm(title, description)`,
`countsForLowest(offer, basePriceUsd)`, `parseSearch(json)`.

- `queriesFor`: `product.competitors.queries` if set; else up to 3 queries: the
  two longest labels and `displayName` alone (the search is inside Eldorado's
  Twitch Drops category, where rivals list these items as Twitch drops).
- Request: `GET https://www.eldorado.gg/api/v1/item-management/offers?gameId=235&category=CustomItem&pageIndex=N&pageSize=50&searchQuery=<q>`
  with `accept: application/json` and a browser user-agent, through `deps.fetch`;
  pages 1..3 while a page has 50 results; `deps.sleep(1500)` between requests.
- `parseSearch(json)` → `[{ id, title, description, userId, priceUsd, qty }]` from `results[].offer`
  (`id`, `offerTitle`, `description` (capped at 5,000 characters, "" when not text),
  `userId`, `pricePerUnitInUSD.amount`, else `pricePerUnit.amount` when its currency
  is USD, `quantity`). The search answer carries each offer's full description, so
  reading it costs no extra request (checked 2026-10-16: 476–1,916 characters each).
- Exclude our own: `userId` in `config.ownEldoradoUserIds`, or `id` equal to any
  of our `MarketplaceListing.externalId`.
- `scoreOffer(title, labels, description = "")`: normalise (accents folded, so
  "Skål" = "skal"; lowercase; non-alphanumerics → space, collapse). Most rivals
  list these rewards as Twitch drops with "19 Rewards" in the title and the list
  only in the description, so a label matches:
  - in the TITLE when the normalised title contains the normalised label, or every
    word of the label that is ≥ 4 letters (and at least one such word), or by the
    phrase rule below;
  - in the DESCRIPTION by the phrase rule only. A description lists many other
    rewards, and loose words would join two of them ("Banana Cat Icon … Prost
    Spray" is not "Banana Cat Spray").
  - Phrase rule: one of `phrasesOf(label)` (the label without our "(...)" notes,
    and that again without "player" / "code" / "codes") appears in the text with
    spaces ignored ("Loot Box" = "Lootbox"); a phrase under 8 letters must appear
    as whole words ("Ana" is not in "banana"). Counts stay part of the name
    ("x3" ≠ "x1").
  Score = matches ÷ labels. `sameSet` = score ≥ 0.8. `matchedIn` = "title" when the
  title alone names every matched label, "description" when the description added
  any, "" when nothing matched.
- `deliveryForm(title, description)` → `codes | account | unknown` (05-REVIEW-FIXES R10):
  lower-case title + description; cut out negated account words first (a negation
  — no / not / without / never / don't / doesn't — followed within the clause by
  an account term, or an account term followed by "not needed / required");
  then count code words (`redeem code(s)`, `cd/game/gift/activation/digital key`,
  `code(s)`) against account words (`twitch account`, `log in`, `link…`,
  `connect…`, `claim…`, `password`, `email`, `twitch drop(s)`; "account" alone is
  not one). More code words → `codes`, more account words → `account`, a tie →
  `unknown`.
  Before counting (05-REVIEW-FIXES R11): login codes are cut out ("verification
  / 2FA / email … code", "the code sent to your email"), and an offer that says
  outright that the buyer is handed codes ("receives the codes", "codes are
  delivered / sent", "delivery of the codes", "enter the code on Battle.net / in
  game") is `codes` unless it also says the buyer is handed an account ("receive
  a Twitch account", "account details", "email and password", "log in to the
  account"). Each of these statements is read within one line.
- `countsForLowest(offer, base)`: `sameSet`, `form === "codes"`, `qty >= 1`, and
  (when `base` is known) `priceUsd >= 0.3 × base`. `lowestSameSetUsd` = the lowest
  price of the offers that count, else null.
- Store on the product: `competitors = { scannedAt, queries, offers: top 15 by score desc then price asc, lowestSameSetUsd }`,
  each offer `{ id, title, priceUsd, qty, score, sameSet, matchedIn, form }` (a
  rival's description is read, never stored). The event's `data` carries
  `byDescription` (offers named in a description only) and `byForm`
  (`{codes, account, unknown}`). A failed request → `events.log` warn, keep the
  old scan.

## `utils/codeShop/pricing.js`

Pure `decidePrice({ product, now, steps, undercutUsd, lowestSameSetUsd })` → `{ priceUsd, reasons: [String] }`:
- `base = pricing.priceUsd`, `floor = max(pricing.floorUsd, 0.5)`.
- clearance (when `pricing.clearance` and `product.useBy`): `days = (useBy − now) / 1 day`;
  among `steps` with `days <= step.days` take the one with the smallest `step.days`;
  `price = base × (1 − cutPct/100)`.
- competitors (when `pricing.followCompetitors` and `lowestSameSetUsd != null`):
  `price = min(price, lowestSameSetUsd − undercutUsd)`.
- `price = max(price, floor)`, then floored to cents.

`createPricing(deps)` → `{ run() }` → `{ checked, changed: [{ product, from, to, reasons }] }`.
Only `active` products with `pricing.mode === "auto"`. Current price = the active
Eldorado row's `price`. Change when the difference ≥ $0.01 and the last change
is older than `cooldownHours`: `mp().eldoradoReprice(externalId, price)`, then
row `price`, product `pricing.lastChangeAt / lastReason`, an event. GGSel prices
are never changed by this module. Fixed-price products are never touched.
