# Listing brain — handoff (round 1, test mode)

> For the owner and the production session that will run this against real data. The contract is
> `docs/LISTING-BRAIN-PLAN.md`; this file is what was built, what was checked and how, what was not, and what to
> verify first. Nothing here changes a price, a listing, a setting or an account: the brain only logs.

## 1. Branch and commits

- Branch **`claude/clever-cori-x0bbr6`** (the environment's name for it; the brief's `feat/listing-brain` was not
  allowed in this session), based on **`fix/live-defects-1003`** at `66178bc`. Pushed to `origin`.
- Commits: see §13 (`git log --oneline 66178bc..claude/clever-cori-x0bbr6`).
- No pull request was opened (none was asked for; none against `main`).

## 2. Files

### Created

| Path | Role |
|---|---|
| `docs/LISTING-BRAIN-PLAN.md` | the contract — what today's code does, the formulas, the log, the safety contract, settings, limits |
| `docs/LISTING-BRAIN-HANDOFF.md` | this file |
| `utils/listingBrain/index.js` | the runner (start/stop/status/loopStatus/runOnce/latest/cellHistory/accuracy/priceFor/shelfFor/valueFor) |
| `utils/listingBrain/inputs.js` | the loader: every read, the bundle, `loadFromBundle`, the privacy scan |
| `utils/listingBrain/model.js` | the pure model's entry point: config, `buildRun(Async)`, classes, summary, the three answers |
| `utils/listingBrain/model/util.js` | pure helpers and constants (PAVA, Poisson tails, buckets, the time-budget yielder) |
| `utils/listingBrain/model/evidence.js` | the bundle as of a cut: rows, exposure, orders, indexes, waves, units |
| `utils/listingBrain/model/ref.js` | the reference-price cascade |
| `utils/listingBrain/model/hazard.js` | the sell-through fit (per offer on single-unit markets), shrinkage, monotone curve, row chances |
| `utils/listingBrain/model/price.js` | regimes, the price pick, the gates, live-row actions, no-claim limits, bundle order |
| `utils/listingBrain/model/place.js` | eligibility, demand split, newsvendor shelf, bulk first, pool, exploration, placement policies |
| `utils/listingBrain/model/score.js` | calibration, discrimination, placement, agreement, sold-or-expired, decision review, backtest, forward |
| `models/ListingBrainRun.js`, `models/ListingBrainRow.js` | the log — the brain's only write targets |
| `routes/listingBrainRoutes.js` | read-only, guarded, whitelisted API under `/api/price-tracker/listing-brain/` |
| `public/listing-brain.js` | the "Listing brain (test)" tab (code only, never data) |
| `scripts/listing-brain-fixture.js` | seeded synthetic bundle with planted truths (`--large`: 150 games × 7 markets) |
| `scripts/listing-brain-backtest.js` | every score table and the top disagreements from one bundle, offline |
| `scripts/listing-brain-export.js` | read-only, bounded export of a REAL bundle — **you review and run it, never the build session** |
| `scripts/listing-brain-preview.js` | serves the tab from a bundle on 127.0.0.1, no database |
| `tests/listingBrain{Core,Model,Fixture,Inputs,Routes,Run,Safety,Score,Speed,Mongo}.test.js` | the tests (§5) |
| `tests/fixtures/listingBrain/small.json` | the default synthetic bundle (seed 1) |

### Changed — exactly these lines; every other existing file is untouched

| File | Where | Line |
|---|---|---|
| `routes/priceTrackerRoutes.js` | `createRouter`, after `mountBrain(router, { guards, brain });` | `try { require("./listingBrainRoutes").mount(router, { guards }); } catch (e) { console.error("listingBrain routes: not mounted —", e && e.message ? e.message : e); }` |
| `routes/priceTrackerRoutes.js` | `real()`, after the farm brain's start | `try { require("../utils/listingBrain").start(); } catch (e) { console.error("listingBrain: could not start —", e && e.message ? e.message : e); }` |
| `public/price-tracker.html` | before the inline script | `<script src="/listing-brain.js"></script>` |
| `public/price-tracker.html` | `TABS` | adds `["listing", "Listing brain (test)"]` after `["brain", "Farm brain (test)"]` |
| `public/price-tracker.html` | the tab dispatch | `else if (state.tab === "listing") { if (!window.ListingBrainTab) throw new Error("…did not load."); await window.ListingBrainTab.render({ api: api, shell: shell, stale: stale, esc: esc, money: money, pct: pct, ago: ago, day: day, hrs: hrs, openSheet: openSheet, page: page, state: state }); }` |
| `scripts/price-tracker-preview.js` | — | unchanged (the tab has its own preview script) |

Each shared-file line is its own try/catch: deploying the shared files before the new ones, or a broken new file,
can never stop the price-tracker routes or the boot. `/listing-brain.js` is served by the existing
`express.static(public)` like `/admin-nav.js` (code only); `tests/protectedPages.test.js` needs no change.

## 3. Deploy (dark) and switch on

1. Copy the new files (§2) and the two changed shared files. No dependency, no migration, no settings change.
2. Restart. The brain starts **off** — one boot line `listingBrain: off — autoFarm.listingBrain.enabled is not set;
   nothing is computed or logged`. The tab reads "no run yet"; every route refuses a caller without a session.
   The Accuracy view makes **no** database read while the brain is off and has never run.
3. Staging check (writes blocked, as for the farm brain): `require("./utils/listingBrain").runOnce({ force: true,
   persist: false })` computes one run in memory and writes nothing; read the heartbeat line and `latest()`.
4. Switch on: `node -e 'require("./utils/settings").setAutoFarm({listingBrain:{enabled:true}},{actor:"owner"})'`.
   First tick 9 minutes after boot (after the farm brain's first run), then every 180 minutes. Off again with
   `enabled:false` — no restart; the next tick drops the in-memory run.
5. Offline review of real data: `node scripts/listing-brain-export.js` (read-only; connects with autoIndex and
   autoCreate off; refuses to write if its privacy scan or validation finds anything; writes to the OS temp dir and
   refuses a path inside the repo) → `node scripts/listing-brain-backtest.js <bundle.json>` and
   `node scripts/listing-brain-preview.js <bundle.json>`. Suggested `.gitignore` line (not added — `.gitignore` is
   not one of the files this round could edit): `listing-brain-bundle-*.json`.
6. Health page: the brain has `loopStatus()` (`{ lastRunAt, intervalMin, enabled, since }`, synchronous, never
   throws) but is **not yet registered** in `utils/systemHealth.js` (not an editable file) — proposed hook H1 (§11).

## 4. Exported symbols

<!-- EXPORTS -->

## 5. Tests

<!-- TESTS -->

## 6. The backtest on the synthetic fixture

<!-- BACKTEST -->

## 7. Assumptions about real data that could not be checked — verify these first

Nobody in the build could see production. Each line names where to look. Items marked ✓ were checked against the
producing code by the loader review (they read right in the code; real rows may still differ).

<!-- ASSUMPTIONS -->

## 8. Old-side functions the brain calls, and whether each reads the database

| Function | Reads the database? | Notes |
|---|---|---|
| `autoLister.derivePrice(research)` | no (pure) | research = the game's `MarketResearch` row, matched like the auto-lister (exact label, then case-insensitive; `rm` logged) |
| `autoLister.computeSplit(n)` | no | fed the farm brain's stock on hand (the auto-lister feeds `task.assignedAccounts.length`) |
| `autoLister.dealShares(accounts, order, shares, null)` | no | fills the `shares` object it is given; `plati` key mapped to `digiseller` |
| `autoLister.postEventPrice(base)` | no | logged on the claim "all" row (`old.post`) |
| `autoLister.ggselTakesNewStock(af)` | no | |
| `autoLister.platiTakesNewStock(af)` | reads settings and an in-memory block flag | Digiseller is blocked anyway |
| `autoLister.venuePrice("ggsel", base, {title})` | yes — `pricingEvidence`'s 10-minute cached snapshot | the snapshot is warmed **once** per run with a timeout; on failure every GGSel old price is null with one note (never a guess) |
| `autoFarmBundles.priceBundle({plan, game, marketplace, research})` | yes — the same cached snapshot | claim event bundles (`DropSet.sourceType "autofarm-bundle"`), `full: false` (see the plan's limits) |
| `pricingEvidence` snapshot warm-up | yes (cached, ≤ 3 reads of ≤ 20,000 docs when cold) | |
| `unclaimedBundles.bundlePrice({…, pricing})`, `classifyHoldings`, `buildEventCatalog` | no (pure — `pricing` with `gameFloors` is always passed) | never `loadCatalog` (unbounded) |
| `priceTracker.suggestForNew(report, q)` | no (pure on the report) | memoises a few p75 keys onto `report.ctx` (bounded; the tracker's own attach does the same); ≤ 400 calls a run, one yield each |
| `priceTracker.getReportSWR` | yes when its 5-minute cache is cold | shared with the page |
| `marketData/report.getReport({days: 30})` | yes when its 10-minute cache is cold | the same cache entry the farm brain uses |
| `priceTracker/games.listedUnits`, `bulkPacks/packMath.packSizeOf`, `bulkPacks/pricing.tierQuote`, `g2gGames.brandForGame` | no | |
| `settings.getAutoFarm`, `getFarmSizing`, `getUnclaimedPricing`, `getBulkPacks`, `loadSettings().priceTracker.fees` | file reads (no DB) | once per run |

Never called: `listActivatedTask` (even dry-run it writes `task.wouldList`, may mark a row removed, and calls
marketplaces), `refillMarkets`, `onCampaignEnded`, `retryMissingSecondaries`, `freshResearchForGame`,
`repriceUnclaimedRows`, `soldFloorForSet`, `unclaimedBundles.loadCatalog`, anything in `unclaimedAutoList`,
`unclaimedListingAudit`, `noclaimOfferRotation` or a connector.

## 9. Modules `realDeps()` loads — scan these on production for load-time side effects

Directly, all lazily inside `inputs.realDeps()` (requiring `utils/listingBrain` itself loads only the pure model
files and the loader shell — no model, no settings, no marketplace module, no timer):

`../settings`, `../priceTracker`, `../priceTracker/games`, `../priceTracker/setIdentity`, `../priceTracker/venues`,
`../marketData/report`, `../autoLister`, `../autoFarmBundles`, `../pricingEvidence`, `../unclaimedBundles`,
`../g2gGames`, `../bulkPacks/packMath`, `./model/util`, and the models `MarketplaceListing`, `UnclaimedAccount`,
`TwitchCampaign`, `CampaignDrops`, `DropSet`, `MarketResearch`, `DemandBrainRow`.

Transitively ~80 repo modules (`autoLister` and `g2gGames` pull in `marketplaces.js`, the fulfillers,
`routes/shopRoutes.js`, `middleware/auth.js`; `autoLister` runs `dotenv.config()`). In the build sandbox none
started a timer, a connection or a listener at load; on production `autoLister` is already loaded at boot by
`server.js`, so no new module enters the process except the brain's own and `autoFarmBundles`/`g2gGames` if they
are not loaded yet.

## 10. One row, one pricer — every path that moves a live row today

The brain never becomes a second thing that moves a row. In the next round it should hand its number to the paths
that already move rows (below), not run beside them.

### Claim farm (auto rows)

<!-- ROWMOVERS_CLAIM -->

### No-claim farm

<!-- ROWMOVERS_NOCLAIM -->

## 11. Proposed hooks for the next round — anchored snippets, NOT applied

<!-- HOOKS -->

## 12. Decisions taken on the owner's behalf

<!-- DECISIONS -->

## 13. Commits

<!-- COMMITS -->
