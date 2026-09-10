# Account listings — third review round (final sweep)

Found by a money-path / regression / operability sweep after two fix rounds
(`docs/ACCOUNT-LISTINGS-FIXES.md`, `-2.md`). Two of these were raised
independently by two reviewers. Suite is green at **1736 pass / 0 fail** — keep
it there, and add a regression test per fix.

Same house rules as `docs/ACCOUNT-LISTINGS-CONTRACT.md`.

---

## S1 (high) — `routes/marketplaceRoutes.js`: delisting an offer-backed listing strands every fed account

*Raised independently by two reviewers.*

`DELETE /marketplaces/listings/:id` (~:1753) releases reserved stock only under
`if (row.autoDeliver && row.accountId)`. Contract B5 deliberately leaves
`accountId` / `accountLogin` empty on every account-listing row, so that block
is **unreachable** for supplied stock and `suppliedStock.releaseClaim` is never
called. Round 1 (F1e) widened `releaseClaim` to accept `fed` rows precisely so
this could work — nothing calls it here.

Failure: the owner publishes 20 accounts to GGSel, then delists. All 20 stay
`fed` forever: excluded from `stockFor`, no UI control (the `×` renders only for
`available`), and no other path ever moves them back. The stock is silently
destroyed.

Fix: add an `accountOffer` branch to the delist release that hands back every
undelivered ledger row behind the row (`units[].contentId` → `releaseClaim`,
which already refuses anything with `deliveredAt` set). Say how many were
returned in the response.

## S2 (high) — `utils/marketplaceGuardian.js`: the top-up burns accounts on an empty render

Round 2's G1 added the empty-render guard at the two **publish** sites in
`routes/marketplaceRoutes.js` (`suppliedUnitsOrRefuse`). The guardian's GGSel /
Plati **top-up** path (~:1073) renders each claimed account through
`AccountOffer.deliveryTemplate` and never checks the result;
`mp.ggselAddProducts` drops empty strings. So the same burn happens on every
restock tick: accounts claimed and `markFed`, fewer (or zero) units actually
added, and — as G1's own fix note records — GGSel flips `autoselling` to false
when the content list empties out, turning an auto-delivery offer into a manual
one while the row still says `autoDeliver: true`.

Fix: use the same guard. Prefer sharing one helper with the publish route over
writing a third copy — a third copy is how `utils/marketClaimTags.js` drifted.

## S3 (high) — `utils/eldoradoFulfiller.js`: a paid order on a switched-off listing is skipped in total silence

Round 1's F7 fixed exactly this for PlayerAuctions and only for PlayerAuctions.
Eldorado's `deliverOrder` (~:364) returns a `skipped` reason nothing consumes:
no Telegram, no console line, no `SystemEvent`, no `lastError` on the row, no
guardian finding, no health check — while the Eldorado offer stays Active at
full quantity so **more buyers keep paying**.

Fix: make the skip visible the way F7 did for PA, using the mechanisms this file
already has. Then check Z2U and G2G for the same hole and fix them too — F7's
mistake was fixing one fulfiller when four share the shape.

## S4 (high) — one shelf is advertised in full on every market it is published to

Every claim-at-sale stock counter for an offer-backed row reports
`suppliedStock.stockFor(row)` — the **whole** free shelf — and pushes that
number onto its own live offer. Publish one 50-account offer to Eldorado,
PlayerAuctions, G2G and Z2U and the world sees 200 accounts for sale. The first
50 sales are honoured; every sale after that finds an empty shelf, with buyers
already paid.

`utils/playerauctionsFulfiller.js` has the only guard written for this
(`sharersOfAccountOffer`), and it is per-file rather than shared.

Fix: make the sharing the **claim layer's** job so no counter can forget it —
have `suppliedStock.stockFor(listing)` return this listing's *share* of the
shelf when several active listings sit on the same offer, so every existing
caller is fixed by one change. Then remove PlayerAuctions' own division so the
shelf is not divided twice. Be explicit about the rounding rule and make sure
the shares can never sum to more than the shelf.

## S5 (high) — `routes/marketplaceRoutes.js`: the new PlayerAuctions branch publishes a DropSet listing with no stock

The `else if (name === "playerauctions")` branch added in round 1 (~:1426)
publishes a live PlayerAuctions Item offer for a **DropSet-backed** listing,
then writes a `MarketplaceListing` with no `units[]`, no `autoClaimSet: true`
and no account reservation — neither of the two stock modes the PA fulfiller
understands for an archive-backed row. Every order against it is skipped
undelivered.

This one is ours: it did not exist before this change. Fix it or refuse the
combination. Refusing is acceptable and is what the Z2U branch already does —
a clear "not supported yet" beats a live offer that cannot be filled. An
offer-backed PA publish is fine and must keep working.

## S6 (medium) — `utils/marketplaceGuardian.js`: switching auto-deliver off silently resolves the "shelf is empty" warning

`claimSupplied` (~:763) returns at the `deliveryEnabled` gate without seeding
`seenKeys` with its `restock-empty` dedupe key, so `autoResolveStale` marks an
already-open `restock-failed` finding *"auto-resolved: condition no longer
detected"*. The warning disappears while the condition is unchanged and the
GGSel/Plati offer is still short.

Fix: seed the dedupe key (or otherwise keep the finding open) when the gate
returns, so pausing delivery never erases an unrelated standing warning.

## S7 (medium) — `utils/suppliedStock.js` + `routes/accountListingRoutes.js`: `offerStats` has no claimable figure

`offerStats` (~:367) groups by status, so `available` **includes** conflicted
rows, and `conflicts` is summed across **every** status including `removed`.
The browser therefore cannot compute claimable: round 2's `alClaimable` falls
back to `available − conflicts`, which under-counts as soon as the owner removes
a conflicted row — the obvious response to the "Also in the Drop Archive"
warning — and can make a fully stocked offer read as empty forever.

`stockFor` (~:342) already computes the right number
(`status:"available", conflict:""`).

Fix: return `claimable` and `heldBack` (= `available` ∧ `conflict !== ""`) from
`offerStats`, and expose both through `routes/accountListingRoutes.js`. The
browser already prefers them when present (`public/listings.html:6172`), so no
further UI change is needed.

## S8 (medium) — `routes/accountListingRoutes.js`: a paused marketplace row renders as live

`listingsForOffers` (~:203) never returns `autoPaused` or `lastError`, and both
stock syncs pause an offer-backed row while leaving `status: "active"`. So the
only page that lists account listings shows a marketplace the offer is
**hidden** on as a green live chip, and the reason never leaves the server.

Fix: return `autoPaused` and `lastError`, and render a paused/errored chip
distinctly in `public/listings.html` — the owner finds problems by looking at
pages, not by reading logs.
