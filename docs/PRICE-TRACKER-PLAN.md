# Price tracker — contract, findings, consolidation, rollout

Status: **LIVE on production since 2026-10-01 as a READ-ONLY viewer** at `/price-tracker.html` (superadmin + 2FA,
nav entry "Price tracker"). It is NOT wired into any publisher, repricer or the auto-farm: it changes no price anywhere.
Deployed by targeted copy: 8 new files + a 3-hunk patch to prod's own `server.js` and a 1-block patch to its
`public/admin-nav.js`; originals backed up in `_deploy_backup_20261001205354_price-tracker/` on the server.
Rollback: copy those two backups back over `server.js` and `public/admin-nav.js`, `pm2 restart redeemer`
(the new files are inert once nothing mounts them).

## What it is

One read-only system that answers four questions, from one ledger of proven sales:

1. What do we actually get on each market? (`venueSummary`)
2. Do lower prices really sell more? (`priceCurve`)
3. For the *same items*, who pays what? (`setBoard`, `buildTranslator`)
4. What should this listing cost here? (`recommend`, `advise`, `suggestForNew`)

| File | Role |
|---|---|
| `utils/priceTracker/setIdentity.js` | What *exactly* is a listing selling (content identity, not set id or title) |
| `utils/priceTracker/ledger.js` | The single sale ledger: exact listing, exact items, exact order id where one exists |
| `utils/priceTracker/analyze.js` | Pure analysis + the recommender |
| `utils/priceTracker/venues.js` | Floors, fees (verified vs assumed), reprice mechanics per market |
| `utils/priceTracker/index.js` | Bounded DB loader / snapshot loader, report cache, `suggestForNew` (the auto-farm seam) |
| `routes/priceTrackerRoutes.js` | Read-only API, superadmin + 2FA, in-memory paging |
| `public/price-tracker.html` | Overview · Price curve · Same items · Advice · Sales ledger · Suggest |
| `scripts/price-tracker-preview.js` | Serves the real page + router from a snapshot: no DB, no auth, no marketplace calls |
| `tests/priceTracker.test.js` | 30 tests, each pinning a mistake this shop already made or a stated rule |

## The rules (each one is a past mistake)

- **Exact items only.** Identity = sorted multiset of `itemKey × qty`. A dozen Gameflip rows for the same Albion
  drops point at a dozen *different* set ids; keying on the id would make every cross-market comparison impossible.
- **Titles count rewards, not distinct items.** "(7 Items) — 6× Pack + Clanker" is correct. Only a count matching
  *neither* is drift; drifted rows compare at game + size band only.
- **Prices are translated between markets, never copied.** A ratio measured on sets sold on both
  (≥3 sets), else venue medians (≥10 sales each side), else *no answer*. Clamped 0.4–1.5 like `venueFactor`.
- **Rent-farm windows, bulk packs, unpriced sales and junk prices (> $25) never enter a price.**
- **Mass-close and burst signals are not sales** (see findings): a signal whose listing was delisted within 90s in a
  burst, or any 8+ signals on one market inside five minutes (a bulk mark-sold, a mass delist). Set aside, counted,
  visible, never priced. Delivered units carry real order ids and are exempt.
- **One price per buyer order.** An Eldorado order can deliver 10 units (270 units = 168 orders). Revenue sums units;
  a price, a median and a confidence count orders.
- **A blocked market (Digiseller) never teaches another market's price.**
- **A raise or lower needs MEDIUM confidence** (≥2 distinct orders of this exact set here, or the same items sold on
  ≥2 other markets). One sale, band evidence or the engine fallback inform but never recommend a change, and
  `applicable` means only "a raise/lower on an auto row on an open market".
- **Manual / no-claim rows are never "applicable"**; neither are rows on blocked markets (Digiseller).
  A set live at ≥2 prices with any hand-made row is a deliberate ladder (the Eldorado OWCS $1/$2/$4/$5 copies) —
  reported as `ladder`, never "corrected".
- **The engine fallback never says *raise*.** A raise with no comparable sale is how GGSel got $10 asks.
- **Evidence is gross.** Fees only affect the informational "net" column, never a recommended price.
  Only G2G (9.99%) and Eldorado (10%) are documented in this repo; the rest are marked *assumed* on the page.
  Override with settings `priceTracker.fees = { market: pct }`.
- **Read-only, bounded.** No write, no marketplace call, every Mongo read projected + limited, no `skip()`,
  no `allowDiskUse` (asserted by a test that scans the source).

## Findings from the first run (production snapshot, 2026-10-01)

1. **Most of the "priced sales" on GGSel and Digiseller are not sales.** GGSel: 179 of 204 were written in one
   34-minute window on 2026-09-28 (60 offers, ~3 units each, every listing delisted within seconds). Digiseller: 45 of
   63 in bursts (35 in 3 minutes on 2026-08-16). The Listings delist route records a `listing_sold` signal for stock
   it closes. Gameflip has a 25-signal bulk mark-sold ~1s apart on 2026-09-08 (manual rows) — also set aside.
   Real evidence after removal: GGSel **25 sales, median $0.75, p75 $1.00**; Digiseller 18; Gameflip 146. `utils/pricingEvidence.js` still counts them, so GGSel's
   `venueFactor` (0.860 from n=204) rests mostly on a delist burst. *Not changed here.*
2. **Gameflip, auto listings: conversion peaks near $1.00 and falls steeply above ~$1.35.**
   resolved auto rows — ≤$0.80: 50% sold (median 1.0 d) · $0.81–1.10: 66% (4 d) · $1.11–1.35: 38% · $1.36–1.60: 26% ·
   $1.91–2.40: 17% · $2.41–3.10: 7%. The live auto ask median is **$2.00**; 138 of 220 live auto rows sit in the
   weaker ranges. This is correlation (cheap rows are partly weaker sets), so the page proposes *tests*, not a mass move.
   Including manual rows flips the picture (a few hand-priced $4.50 sets sell in hours) — that is why the curve defaults to `auto`.
3. **Asking prices are 43–75% above the realised median** on Gameflip, GGSel and Eldorado.
4. **GGSel and Digiseller sell mostly at the platform minimum** (60% / 76%), so there is no evidence about higher prices there.
5. **Eldorado/PA/G2G revenue is the listing price *now*** (nothing stamps price at delivery). The console and the old
   evidence share this limit; the tracker labels it on every figure (`priceBasis: listing-now`).
6. 24 exact sets have sold on 2+ markets (median spread ×1.34) — the only like-for-like cross-market comparisons today.
   Paired ratios measured: gameflip→ggsel ×0.55 (4 sets), gameflip→eldorado ×1.00 (15 sets).
7. 79 sold units have no priced record (their price is unknown, excluded from every average).

## Consolidation map — "one system"

The old systems are not deleted: that is the risky part, and it is a separate, verified step.

| Existing | Today | In the single system |
|---|---|---|
| `utils/pricing.js` | The engine | **Kept.** Tracker feeds it from the ledger and uses it as the last-resort fallback |
| `utils/pricingEvidence.js` | Builds realised-price buckets (own copy of the dedupe rules) | Re-point `buildSnapshot` at `buildLedger` with a parity test; the only intended difference is mass-close removal |
| `utils/marketPricing.js` | Rival bands, `classifyKind`, `parseAdvertisedCount` | **Reused** (identity depends on both). Rival scouting is not yet in the tracker (v2: rival p75 as a ceiling) |
| `utils/systemHealth.js` `realisedSales`, `listings.venuePrice` | Third copy of the rules | Read the ledger |
| `routes/marketplaceConsoleRoutes.js` revenue + Pricing tab | revenue = units × price now | Read the ledger; show basis |
| `routes/catalogRoutes.js` signals | Own signal read | Read the ledger |
| `scripts/reprice-listings.js`, `autoLister.venuePrice`, `unclaimedAutoList.repriceUnclaimedRows`, `autoFarmBundles.priceBundle` | Appliers, each with its own price | Consume `advise()` / `suggestForNew()`; one price per (offer, market) |

## Rollout

1. ~~Review locally against a snapshot~~ (done: `node scripts/price-tracker-preview.js <snapshot.json>`).
2. ~~Mount~~ (done 2026-10-01): `app.use(enforce2fa, require("./routes/priceTrackerRoutes").real());`, a page guard BEFORE `express.static`
   (`app.get("/price-tracker.html", requireSuperadmin, enforce2fa, ...sendFile)`, like `/activity.html`), and one nav entry in
   `public/admin-nav.js`.
   Verified on prod before the restart with the real router + real DB + stub session on a throwaway port: every route 200,
   every route 401 without a session.
3. Owner confirms the *assumed* fees (or enters them in settings).
4. **Shadow mode** for the auto-farm: log `suggestForNew()` next to the price the publisher actually used, for a week. No price changes.
5. Only then, behind a settings switch (default off): publishers read `suggestForNew()`. Reprice only `origin:"auto"` rows,
   canary of 3, read-back verified (ZeusX 500s may have applied; GGSel 504s may not), pacing per the GGSel rule.
6. Price **experiments** (v2): mark N comparable listings as arms at different price points and let the tracker measure
   conversion, which is the only way to turn the curve's correlation into a cause.

## Known limits (stated, not hidden)

- The curve is correlation. Thin cells (<10 resolved) are flagged and can never be "best".
- "Resolved" = sold or no longer active; rows delisted for other reasons count as unsold. Active rows are excluded (not yet resolved).
- Quantity markets (GGSel/Digiseller) have no per-listing "resolved"; their curve uses revenue per listing-day.
- `updatedAt` on a delisted row approximates when it ended.
- ZeusX records no sales at all; its advice rests on translation or the engine and is low confidence by construction.
- No rival data yet; Gameflip's research rows exist (`MarketResearch`) but are not integrated.
