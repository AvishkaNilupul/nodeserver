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


---

# Part 2 — the per-game board and the auto-farm link (built 2026-10-01, NOT yet deployed)

The owner asked for "for each game: the pricing, how much we should farm, and a better system to
attach to the auto-farm for future listings, with pricing against other sellers". This is it, built
ON TOP of what already exists instead of beside it:

| Need | Existing system it reads | What the board adds |
|---|---|---|
| Other sellers' prices, market-wide demand | `MarketResearch` (266 games: Gameflip `lowestOther`/median/sold, GGSel + Plati median/lifetime sold, `salesPerWeek`, sellers/offers) | Sits beside OUR realised prices; labels which rival numbers include our own rows |
| How many accounts a game deserves | `utils/farmSizing.js` (`coverageTarget`, `stockGap`, `daysOfCover`, `revenueWeight`), `settings.getFarmSizing` (28 days cover, 6 safety, your per-game caps) | The same arithmetic fed with CLEAN demand, vs listed stock, vs the engine's latest decision |
| What the engine decided | `AutoFarmTask` (30 days, only a COUNT of assigned accounts ever leaves the DB) | Decision + reason + 14-day counts next to the advice |
| No-claim games | `utils/unclaimedAllocator.js` + `farmDemand.js` | Marked **managed**: shown for information, no farm instruction |

## The finding that matters most: the farm engine's sales count is not the real count

`utils/autoFarmer.js internalSalesForGame` (45 days, `connected` + `listing_sold`, grouped by `account`
else `dedupeKey`) drives `demandAllocation` and `capForGame`. Replayed exactly on production data
(`engineCounts`), it differs from "each sold account counted once" in four ways:

1. **Duplicate-login twins count twice.** Brawlhalla's connection flips come from **82 account ids but only
   45 distinct Twitch logins** (a re-minted token is a second record). The engine reads 107 sales; the
   clean count is 60.
2. **Mass-delist and bulk mark-sold signals count as sales** (the Part 1 finding): the 09-28 GGSel wipe keeps
   feeding games' demand until the 45-day window rolls past it (~11-12).
3. **Delivered Eldorado / G2G / PlayerAuctions units are invisible** (their fulfillers write no signal), so
   Rainbow Six reads 58 where 116 accounts sold.
4. A quantity unit's `login` field is the listing's whole delivery pool, copied onto every unit; only a
   single login identifies an account.

Totals over our games: **the engine counts 1,045 sales in its window; the clean count is 869.** 16 games are
over-counted by 5 or more (Brawlhalla 107 vs 60, Fortnite 57 vs 39, Rocket League 79 vs 47, Halo Infinite 43 vs 18,
Albion Online 32 vs 14, ...). The board shows both numbers per game and flags the gap. **Not changed in the
engine** — that is the owner's call (see "Engine integration" below).

## What the Games tab shows (all read-only)

Per game: accounts sold (45d / 7 / 14 / 30), per week, net value per account, weekly revenue; by market: what
sold (n, median, p25-p75, last sale), our live asks (all rows, and the auto-priced ones separately), the other
sellers' page median / cheapest other seller / seller and offer counts, our suggested price with its evidence and
confidence, and a TEST rung when buyers demonstrably pay our price (>= 5 sales) while other sellers ask much more.
Market: units/week on GGSel+Plati, our share, opportunity score; "games the market buys that we do not sell".

### How many accounts to farm — the rules (each pinned by a test)

* **Target** = the engine's own `farmSizing.coverageTarget` (cover days + safety stock, your per-game cap on top —
  matched by substring like `settings.gameAccountCapFor`), fed with CLEAN weekly demand.
* **Stock on hand** = the LARGER of units listed and the engine's `archiveHolders` (unsold accounts holding the game's
  drops, trusted only while its decision is under a week old) — never the sum. **In flight** = accounts assigned to a
  live campaign minus those already holding the drops (the assigned roster is the same pool that is later listed).
* **Farm more** only when ALL hold: a campaign is running (research can lag, so its end date is checked) or an engine
  task is live; the shortfall is at least 3 accounts AND 15% of the target; the game sells at least 2 a week; the
  engine did not just skip it for `skip_ends_soon`. Otherwise a shortfall is **wait** ("short, but no campaign to farm
  until the next one") or, on a tiny game, **hold** (the 6-account safety stock alone would make every small game look
  short: 18 of the 21 games first marked "farm more" sold under 1.3 a week).
* **Over-stocked** = surplus of at least 5 accounts and half the target.
* **Managed elsewhere**: no-claim games (research flag or `autoFarm.noClaimGames`, substring rule like
  `farmDemand.bucketFor`) and the engine's reuse-only games (`autoFarm.reuseOnlyGames`, exact label): information only,
  no instruction. Overwatch and Rainbow Six are sized by the allocator with a shelf cap and a fleet as two levers.

### Price per market — the safeguards (each pinned by a test)

Own sales anchor; other markets' sales are translated, never copied; the shared engine is the weakest evidence and
can never raise. Other sellers are a ceiling (1.5x their page median, waived once buyers paid our price 3+ times) and
a reason to test, **and only when the page is not mostly our own rows**: every research number describes a search
page that includes our rows (Brawlhalla on Gameflip: 6 rows, 4 ours), except Gameflip's `lowestOther`. The platform
floor is applied LAST. Caps round DOWN. Prices on Eldorado/G2G/PlayerAuctions are the listing's price NOW (nothing
stamps price at delivery), so that evidence is medium at best and never waives a cap. A blocked market never teaches
a price. No suggestion is ever below a floor (checked over all 265 games x 7 markets).

## The auto-farm link (`utils/priceTracker/attach.js`) — off by default

`autoLister.derivePrice` makes ONE Gameflip-anchored price per set and hands it to every market's publisher;
only GGSel translates it (`venuePrice`). The seam lets a publisher ask the tracker for the price of THIS exact set
on THIS market. Config: `autoFarm.priceTracker = { mode, markets, minConfidence, maxDeviationPct }`
(`settings.setAutoFarm` audits the change).

| mode | what happens |
|---|---|
| `off` (default) | one settings read, returns the base price. No DB, no report, no log. |
| `shadow` | asks the tracker, **logs** its price beside the base price (last 300 kept for the page), returns the BASE price. Run this for a week. |
| `apply` | returns the tracker's price only when: market is on the allowlist (default none) AND confidence >= medium AND not the engine fallback AND within `maxDeviationPct` (default 35%; a bigger move is clamped to the step) AND >= the market floor. Never a rent-farm title, never a blocked market. |

Every failure (no report yet, a throw, a malformed answer, missing module) returns the base price. A report
that is not loaded yet is waited for at most 2.5 s on the first call and never again (stale-while-revalidate).

**Hooking it up** is `node scripts/apply-price-tracker-hook.js <utils/autoLister.js> --write`: an idempotent,
anchored patch (one helper + one line in each of GGSel / ZeusX / Eldorado / G2G / PlayerAuctions; Gameflip is
the base price and Digiseller is blocked). It must be applied to PRODUCTION's copy of `autoLister.js` (it holds
code in no git ref). Not applied yet. Recommended order: apply with mode `off`, then `shadow` for a week, read the
Suggest tab's "Auto-farm link" panel, then allowlist ONE market in `apply`.

## A bug found on the way, and the guard that goes with it (`utils/saleLearning.js`, `utils/marketplaceGuardian.js`)

### 1. Sale signals dropped on multi-account listings (fixed)

`recordListingSale` falls back to `listing.accountId` for the signal's `account` (an ObjectId). On a GGSel /
Digiseller listing that carries several accounts, `accountId` is a comma-joined list; the cast threw and the
surrounding `catch` swallowed it, so NO signal was written while `unitsSold` still incremented. **65 of the 79
live GGSel offers are of this kind, so without the fix every real GGSel sale would be invisible** to the farm
engine and to every price-evidence reader. The fix stores only a value that is exactly one ObjectId (else null: the
login pool stays in `login`, and the engine counts an account-less unit by its dedupeKey), and any write failure
other than the harmless duplicate-key race now logs one throttled warning line. `tests/saleLearningRecord.test.js`
(11) reproduces the bug on the old code. `scripts/sale-signal-gap.js` (read-only) lists listings whose `unitsSold`
is ahead of their signals: run it after a deploy, the gap must stop growing.

### 2. What the historical gap really was, and why a guard was needed (built)

The 31 listings / 78 units the gap script shows are **mostly not lost real sales**: 66 of them are the 09-28 GGSel
block. The audit log holds 236 "sold" units logged in that one hour (78 events, all `origin:"auto"` rows written by
the guardian: ONE 5-minute pass saw 77 listings / 233 units) against a normal pass of 1 listing / 3 units on GGSel
or 2 listings / 4 units on Digiseller. The owner's cleanup (`free-ggsel-accounts.js`) was archiving 3,290 codes
while a guardian pass was running; the guardian reads "the pile is smaller than we left it" as "units sold"
(`unitsSoldSince(lastStock, remaining)`), and its row list is loaded ONCE at the start of a pass, so rows already
marked delisted were still read. On single- or no-account listings those closeouts became the 179 phantom signals
Part 1 sets aside; on multi-account listings the cast error happened to erase them. **Fixing the cast alone would
therefore have let the next closeout record fake sales on 82% more listings.** The same shape recurred on
Digiseller (08-14, 08-16: 9 listings / 30 units in one pass).

**The mass stock-drop guard** (`utils/marketplaceGuardian.js`, `tests/guardianMassDrop.test.js`: 32 scenario tests
through the real `runOnce`/`feedOne`, an exact-clock harness for the hourly rules, and a mutation run that breaks
the guard 38 ways with every mutant failing a test). An independent adversarial review found real problems in the
first draft (the alert was awaited inside the pass; inactive rows were counted toward the verdict; a drain spread
across passes slipped through; one failing step of the report could cost the others); all are fixed and tested.

* A pass no longer records inferred sales as it reads them. It COLLECTS them and `flushPendingSales` records them
  after the whole pass has been read:
  1. a listing that is no longer `active` by then (delisted / removed while the pass was reading) cannot have sold
     the codes that vanished: not recorded, and set aside BEFORE the marketplace is judged (six delisted rows must
     neither sink one real sale beside them nor make an ordinary pass look like a closeout);
  2. if ONE marketplace shows inferred sales on **>= 5 listings or >= 12 units in one pass**, or on **>= 8 distinct
     listings or >= 20 units across the last hour** (a cleanup that outlasts one pass; a normal pass is one listing
     and a few units), that is a closeout or an outage: NOTHING from that marketplace is recorded this pass, and a
     high `mass-stock-drop` finding (one per marketplace per hour; not auto-resolved), its own Telegram message (a
     real closeout also raises one restock finding per listing, which would bury it in the digest), a log line and a
     `guardian/mass_stock_drop_ignored` audit event (severity warn) say so. The hour remembers every inferred drop,
     recorded or not, so a drain that keeps going stays suppressed instead of leaking through a few listings at a
     time. It lives in memory: a restart forgets it.
* The baseline (`lastStock`) is advanced when the drop is read, exactly as before, so a dropped drop is never read as
  a sale again on the next pass. Deferring the record (baseline first, record at the end of the pass) means a crash
  between the two loses a sale instead of double-counting one: the module's stated bias ("under-reporting, never
  inventing sales that did not happen").
* The report can never stall or fail the pass. The Telegram call is NOT awaited (`utils/telegram.js` sets no request
  timeout, so an awaited send on a hung connection would freeze the guardian); the finding, the Telegram message and
  the audit line are independent steps, each isolated; if the findings store itself is down the alert is still sent,
  once per hour. A failed "is this row still active" read is retried once and then every row counts as active (the
  breaker does not depend on it).
* Kill switch and tuning without a deploy, re-read every pass: settings
  `autoFarm.saleOutageGuard = { enabled, rows, units, windowRows, windowUnits }`. `enabled:false` (or `0`, `"off"`,
  `"false"`, `"no"`, or the whole value `false`) restores record-as-you-read exactly; a threshold below 2 is ignored
  (it would drop an ordinary sale) and the hourly limits are never tighter than the pass limits. `feedOne` (the
  Integrity tab's single-listing retry) still records at once. From the production checkout:
  `node -e 'require("./utils/settings").setAutoFarm({saleOutageGuard:{enabled:false}},{actor:"owner"})'`.
* Adds NO marketplace call and NO new write on the normal path (one bounded `_id`-keyed status read in a pass that
  inferred a sale). If real purchases are ever held back by it (a catch-up pass after a long outage could look like a
  burst), the finding says exactly how to raise the limits.

Known limits, stated: a slow trickle below the hourly limits still records (the tracker's ledger sets bursts aside
for prices; the farm engine's own count does not); a real surge above them (20+ units an hour on one marketplace) is
held back and alerted, which is the intended trade at this shop's volume (GGSel 1-3 units a day); the hour's memory
is per process. `utils/unclaimedAutoList.js` has its OWN copy of the stock-drop inference for no-claim rows
(`expirySalePass`, part A) that also marks no-claim accounts spent. It was not involved on 09-28 (all 78 events were
auto rows), it touches account ownership, it lives in a file other sessions are editing, and it was deliberately left
alone. On production it covers ONE active GGSel quantity listing (a single account id, so the sale-signal fix does
not change it either). If that engine grows, give it the same breaker.

## Engine integration — proposals, none done

1. `internalSalesForGame` -> count each sold account once (login identity) and ignore set-aside signals. Lowers
   demand for ~16 games, which changes how many accounts the engine farms; deliberately the owner's decision.
2. `T.farmFor(report, game)` returns `{ target, need, spare, direction, ... }` for an engine that wants clean
   advice. Unused.
3. Persist row-level rivals in `marketResearch.scanGame` (it already holds the rows when it computes the
   aggregates): like-for-like rival prices by item count, using `marketPricing.comparableRivals`. Additive but
   touches a live scanner (prod-ahead file), and fills in only as games are re-scanned (weekly). Not done.

## Known limits of the Games board (stated, not hidden)

- Steady-state target, not an event plan: it ignores campaign calendars (the engine's `skip_ends_soon` etc.).
- Listed units are an estimate (Gameflip/ZeusX 1 per row, GGSel/Digiseller `lastStock`, Eldorado/G2G/PA undelivered
  unit rows); unlisted pool holders are only known through the engine's `archiveHolders` as of its last decision.
- Rival numbers are game-wide aggregates (not size-matched) and GGSel/Plati's include our own rows.
- Anonymous quantity units are matched to buyer connections heuristically; a sale seen only by the marketplace is
  counted once, but one that is never connected could be matched to the wrong login (symmetric, small).
- The 45-day demand window matches the engine's so numbers are comparable; trend is shown (7/14/30d), not modelled.


## Second review (2026-10-01): what an independent reviewer found, and what changed

A second adversarial review of Part 2 found 10 groups of problems; all were verified and fixed, each with a test:
"farm more" ignored campaign state and was mostly the safety stock; a publisher's background refresh rebuilt the
shared report with default settings (dropping fees, caps and no-claim games); the in-flight count double-counted the
roster that is later listed; bulk-pack deliveries and pooled quantity units were undercounted as demand; Gameflip's
page median was treated as rival-only when it includes our rows; the rival ceiling could push a price below the
platform floor; apply mode could cross GGSel's undisclosed category minimum (now raise-only there) and trusted
listing-now prices as proof; the report build stalled the event loop up to ~0.9 s (now ~0.4 s total in phases, longest
~0.2 s); logins / login pools / account ids leaked into API responses (now whitelisted); sort and refresh bugs.
