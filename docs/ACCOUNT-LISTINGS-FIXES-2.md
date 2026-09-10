# Account listings — second review round

Found by re-reviewing the build *after* the first seven fixes landed (see
`docs/ACCOUNT-LISTINGS-FIXES.md`). Same house rules as
`docs/ACCOUNT-LISTINGS-CONTRACT.md`. Suite is green at **1712 pass / 0 fail** —
keep it that way, and add a regression test for each fix.

---

## G1 (high) — `routes/marketplaceRoutes.js`: an empty delivery template burns the whole claim on GGSel / Plati

The first round added a "delivery text rendered empty" refusal to
`utils/g2gFulfiller.js` (~:362, ~:484), matching `utils/eldoradoFulfiller.js:409`
and `utils/gameflipFulfiller.js:423`. The two OTHER sites that render
`suppliedStock.deliveryText` — the **ggsel** (~:1072) and **digiseller** (~:900)
auto-delivery publish — have no such check, and both downstream helpers
`.filter(Boolean)` the unit list.

Failure: the owner's `deliveryTemplate` renders empty (a template of only
placeholders the account has none of — e.g. `{token}` on a `login:password`
paste). `claimForListing` has already taken N accounts and `markFed` has already
moved them to `fed`, so they are out of sellable stock — and the offer goes live
advertising N units with **fewer, or zero,** delivery units behind it. The
accounts are burned and the buyer gets nothing.

Fix: refuse before publishing, exactly as G2G/Eldorado/Gameflip now do —
release the claim and return a `{ success: false, message }` for that
marketplace, leaving the other marketplaces in the loop unaffected.

## G2 (high) — `public/listings.html`: the pre-publish stock guard counts accounts the claim layer refuses

The "This listing has no available accounts. Publish it anyway?" guard (~:6658)
and the "N available" figure on each row (~:6481) both read `stats.available`,
which counts `SuppliedAccount` rows whose `conflict` is set. Those are exactly
the rows `claimForListing` skips (`conflict:"in-archive"` is the double-sell
gate). An offer whose entire shelf is held back therefore reads as fully
stocked and publishes with no warning.

Fix: the number the owner is shown, and the number the guard tests, must be the
**claimable** count — the same one `suppliedStock.stockFor` returns. Prefer
surfacing a claimable figure from the server (`offerStats` already computes
`conflicts`) over recomputing it in the browser. Where both matter, show
"N available · M held back" so the held-back stock is visible rather than
silently missing.

## G3 (medium) — `public/listings.html`: F3 missed the two G2G fields F4 made load-bearing

`mpResetPickerSelections()` (~:3844) clears `dsSelected`, `ggSelected`,
`#mpGgCategory`, `#mpDsCategory`, `#mpFpNode` and `#mpG2gProduct` — but not
`#mpG2gService`, `#mpG2gBrand` or `#mpG2gBrandFilter`. F4 made `brandId` the
field that decides ownership (`bodyCategoryGiven("g2g")` is
`!!(body.g2g && body.g2g.brandId)`). Those selects are populated once per page
load and keep their value, so this is the **same incident F3 fixed**, in the
fields that now decide whether the owner's pick beats the auto resolution.

Fix: clear them too. Same rule as F3 — clear the *selection*, leave the loaded
option lists alone.

## G4 (medium) — `public/listings.html`: a category picked before the suggest reply lands is discarded

`mpAutoRevealed[name]` is set only by the "Change" click handler (~:3898), but
`renderMpAuto` leaves every picker **visible** until a suggest-category reply
arrives (`r === null` → ~:3870 `picker.style.display = ""`). Anything the owner
picks in that window is never marked revealed, so when an `ok:true` reply lands
the picker is hidden (~:3890) and `mpPickWins` returns false — the owner's
deliberate pick is thrown away and the auto category is published instead.

Fix: a pick is a pick whenever it happens. Mark the market as owner-chosen at
the moment a selection is made (the ggsel/digiseller leaf handlers, the FunPay
node input, the G2G product change), not only when "Change" is clicked, and
keep the picker revealed for a market the owner has already chosen in.

## G5 (medium) — `public/listings.html`: a large paste 413s with an unreadable error

"Add accounts" always POSTs the whole paste as JSON, so it hits the app-wide
`express.json({ limit: "100kb" })` (`server.js:184`). `routes/accountListingRoutes.js`
was deliberately built to also accept the paste as raw `text/plain` (5mb) and
the page never sends that content type. Any list over roughly 2,000 accounts is
refused, and because the 413 body is HTML, `api()`'s `r.json()` throws a
SyntaxError — so the owner sees a parse error, not "too big", and nothing is
added.

Fix: send the paste as `text/plain` (the route already accepts it), or chunk it.
Whichever you choose, a paste that is too large must produce a clear message,
never a SyntaxError. Check `api()` handles a non-JSON error body without
throwing something meaningless.

## G6 (low) — `utils/systemLog.js`: the redaction ate the item count

`middleware/auditRequest.js:38` collapses an array body value to the string
`"[N]"` *before* `logEvent` sees it. The new `PASTE_KEY` redaction (~:99) then
hits its `typeof value === "string"` branch and returns `"[redacted]"`, so the
array/number branches written specifically to preserve a count never run on any
pre-existing route that POSTs `accounts` as an array. The audit row loses "how
many", which is the whole point of the summary.

Fix: keep the count. `"[N]"` is not a credential and must survive; only a value
that could carry credential text is redacted.

## G7 (low) — `routes/marketplaceRoutes.js`: a paused offer reports "Out of stock"

F1d moved the `deliveryEnabled` check inside `claimForListing`, which now
returns `[]` when a kill switch is off. Every other caller says so; the three
publish sites (~:881, ~:1017, ~:1131) still report *"Out of stock — this account
listing has no available accounts left"* for an offer with a full shelf, sending
the owner hunting for accounts they already added.

Fix: distinguish paused from empty (a `dryRun` claim reports stock regardless of
the switch — that is what its exemption is for) and say which.
