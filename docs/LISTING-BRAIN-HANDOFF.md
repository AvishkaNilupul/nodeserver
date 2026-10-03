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
| `utils/listingBrain/model/hazard.js` | the sell-through fit (per offer on single-unit markets), shrinkage, monotone curve, row chances by queue place and their calibration, the per-row baseline |
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

1. First run `tests/listingBrainMongo.test.js` where `mongodb-memory-server` can download its binary (§5: it could not
   run in the build sandbox). Then copy the new files (§2) and the two changed shared files. No dependency, no
   migration, no settings change.
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

Generated by requiring each module at `2563c49` and listing `Object.keys(module.exports)`. Nothing runs on require
(the scripts run only under `require.main === module`).

**Runner and loader**

- `utils/listingBrain/index.js` (30) — `start`, `stop`, `status`, `loopStatus`, `runOnce`, `latest`, `cellHistory`,
  `accuracy`, `priceFor`, `shelfFor`, `valueFor`, `readConfig`, `heartbeat`, `dailySamples`, `guardedLoad`,
  `compact`, `expand`, `_setHooks`, `_reset`, `_tick`, `_state`; constants `ROW_KEEP_DAYS_DAILY` (21),
  `ROW_KEEP_DAYS_OTHER` (3), `BOOT_DELAY_MS`, `OFF_RECHECK_MS`, `RUN_TIMEOUT_MS`, `HISTORY_LIMIT`, `SAMPLE_DAYS`,
  `BACKTEST_WEEKS`, `MAX_ROWS_PER_RUN`.
- `utils/listingBrain/inputs.js` (89) — `realDeps`, `load`, `loadEvidence`, `loadFromBundle`, `validateBundle`,
  `privacyScan`, `hashId`, `mapLimit`, `withTimeout`, `readWindows`, `settingsBlock`, `readListings`, `readUnits`,
  `readCampaigns`, `readResearch`, `readDemandRows`, `normaliseListings`, `saleRecords`, `noclaimUnits`,
  `readEventSets`, `refillShelf`, `trackerOffers`, `takesOf`, `setItems`, `dropsFromItems`, `makeHasher`,
  `makeBreather`, `waves`, `radarSlim`, `demandRows`, `gameLabels`, `afBlock`, `oldSide`, `oldOrder`,
  `matchResearch`, `researchIndex`, `kindOf`, `farmOf`, `bucketOfKey`, `noclaimKeywords`, `trackerMarket`,
  `marketKey`, `zeusxMapped`, `cleanMsg`, `msOf`, `configBlock`, `demandLookbackH`; constants `BUNDLE_KIND`,
  `BUNDLE_V`, `MARKETS`, `OTHER_MARKETS`, `BUNDLE_MARKETS`, `KINDS`, `ORIGINS`, `FARMS`, `SALE_SOURCES`,
  `DEMAND_SOURCES`, `SALE_BASES`, `FORBIDDEN_KEYS`, `LISTING_PROJECTION`, `UNIT_PROJECTION`, `CAMPAIGN_PROJECTION`,
  `MANIFEST_PROJECTION`, `RESEARCH_PROJECTION`, `DEMAND_PROJECTION`, `LISTING_CAP`, `UNIT_CAP`, `CAMPAIGN_CAP`,
  `MANIFEST_CAP`, `RESEARCH_CAP`, `DEMAND_ROW_CAP`, `REPORT_TIMEOUT_MS`, `VENUE_TIMEOUT_MS`, `OLD_CONCURRENCY`,
  `DEMAND_LOOKBACK_MIN_H`, `DEMAND_LOOKBACK_MARGIN_H`, `BACKTEST_PAD_DAYS`, `UNIT_LISTED_PAD_DAYS`,
  `CAMPAIGN_WINDOW_DAYS`, `MAX_UNITS_PER_ROW`, `MAX_OLD_GAMES`, `MAX_OFFERS`, `MAX_TRACKER_OFFERS`, `MAX_ON_HAND`,
  `MAX_ITEM_COPIES`, `READ_MAX_TIME_MS`, `ID_CHUNK`, `YIELD_BUDGET_MS`, `CAP_DEFAULT`.

**The model**

- `utils/listingBrain/model.js` (136) — its own: `readConfig`, `isOn`, `priceClass`, `shelfClass`, `identities`,
  `newBase`, `trackerOf`, `packPrices`, `staleRun`, `buildRun`, `buildRunAsync`, `summarize`, `priceForRun`,
  `shelfForRun`, `valueForRun`, `heartbeatText`; constants `MODEL_VERSION` (1), `MAX_CELLS`, `DEFAULTS`,
  `PRICE_CLASSES`, `SHELF_CLASSES`, `PRICE_POLICIES`, `PLACE_POLICIES`, `LIVE_ACTIONS`, `REGIMES`,
  `CALLER_MEMO_MAX`; the pieces `util`, `evidence`, `ref`, `hazard`, `price`, `place`; re-exported from them `DAY`,
  `MARKETS`, `BUCKET_EDGES`, `BUCKET_LABELS`, `BUCKET_CENTRES`, `GRID`, `bucketOf`, `tierOf`, `pava`, `poissonTail`,
  `poissonTailer`, `expectedSold`, `snap05`, `cellKey`, `parseCellKey`, `buildEvidence`, `buildEvidenceAsync`,
  `makeWaveEndOf`, `daysLeftOf`, `rowKindOf`, `isAdvisable`, `exposureOf`, `perOrder`, `shelfUnits`, `activeAt`,
  `coveredDays`, `refFor`, `radarBand`, `orderStats`, `marketP75`, `clearPrice`, `ordersAtOrAbove`, `fitHazard`,
  `fitHazardAsync`, `hazardAt`, `pH`, `baseP`, `evidenced`, `expectedDaysToSale`, `rowPH`, `rankOf`,
  `maxEvidencedX`, `gameState`, `candidates`, `priceOffer`, `finishOffer`, `liveAction`, `gateChain`, `gatePolicy`,
  `rowChance`, `applyContainment`, `soldFloorOf`, `horizonFor`, `perishDaysOf`, `stockoutsOf`, `eligibility`,
  `placeGame`, `marketShares`, `greedyFill`, `provenOn`, `PLATFORM_LIMITS`; and every export of `model/score.js`.
- `utils/listingBrain/model/util.js` (55) — `num`, `round2`, `round3`, `clamp`, `lower`, `usd`, `cmp`, `snap05`,
  `floor05`, `ceil05`, `isOn`, `onOff`, `clampNum`, `readConfig`, `bucketOf`, `tierOf`, `median`, `quantile`, `band`,
  `medianOrNull`, `pava`, `poissonTail`, `poissonTailer`, `expectedSold`, `floorFor`, `netOf`, `feeInfo`,
  `yieldNow`, `makeYielder`, `cellKey`, `parseCellKey`, `shortWhy`; constants `DAY`, `HOUR`, `MARKETS`, `SINGLE`,
  `LISTING_NOW`, `REFILLABLE`, `NO_MAPPING`, `NOCLAIM_SHELF`, `RADAR_MARKETS`, `BUCKET_EDGES`, `BUCKET_LABELS`,
  `BUCKET_CENTRES`, `GRID`, `GAMEFLIP_EXPIRY_DAYS`, `ELDORADO_OFFER_LIFE_DAYS`, `ELDORADO_MAX_ACTIVE_OFFERS`,
  `MAX_REAL_PRICE`, `CONF_RANK`, `WHY_LINES`, `WHY_CHARS`, `DEFAULTS`, `PRICE_POLICIES`, `PLACE_POLICIES`.
- `utils/listingBrain/model/evidence.js` (19) — `rowKindOf`, `isAdvisable`, `perOrder`, `exposureOf`, `activeAt`,
  `shelfUnits`, `daysLeftOf`, `makeWaveEndOf`, `buildEvidence`, `buildEvidenceAsync`, `waveEndFor`, `liveWave`,
  `coveredDays`, `quantileAny`, `memo`; constants `SYSTEM_ORIGINS`, `NO_PRICE_SRC`, `BULK_SRC`, `YIELD_MS`.
- `utils/listingBrain/model/ref.js` (13) — `radarBand`, `orderStats`, `statsOf`, `marketP75`, `marketMax`, `refFor`,
  `clearPrice`, `ordersAtOrAbove`; constants `RADAR_BANDS`, `MIN_ORDERS`, `BAND_MEDIUM_ORDERS`, `P75_MIN_ORDERS`,
  `SOURCE_CAP_MULT`.
- `utils/listingBrain/model/hazard.js` (22) — `offerOf`, `offerKeyOf`, `sweepOffer`, `nodesOf`, `maxEvidencedX`,
  `rowPH`, `rankOf`, `queueOf`, `queueP`, `fitRow`, `defaultTierFor`, `judgedPrice`, `fitHazard`, `fitHazardAsync`,
  `hazardAt`, `pH`, `baseP`, `evidenced`, `expectedDaysToSale`; constants `UNMEASURED`, `NODE_FLOOR_SHARE`,
  `QUEUE_CLASSES`.
- `utils/listingBrain/model/price.js` (29) — `gameState`, `perishOf`, `perishDaysOf`, `campaignEnded`, `candidates`,
  `horizonFor`, `soldFloorOf`, `noclaimLimits`, `stockoutsOf`, `gateChain`, `gatePolicy`, `rowChance`, `offerAsks`,
  `priceOffer`, `finishOffer`, `liveAction`, `applyContainment`, `bundleKeyByLid`, `parseBundleKey`,
  `offerBundleOf`, `bundleContains`, `agrees`, `pAt`, `valueAt`; constants `EPS`, `TEST_VALUE_GAIN`,
  `MIN_HORIZON_DAYS`, `ACTIONS`, `NOCLAIM_CEILING_USD`.
- `utils/listingBrain/model/place.js` (16) — `poolPriceOf`, `poolOutlet`, `splitOf`, `provenOn`, `hadAuto`,
  `eldoradoActive`, `eligibility`, `marketShares`, `greedyFill`, `proportional`, `forecastOf`, `capInfo`,
  `placeGame`; constants `PLATFORM_LIMITS`, `TRANSLATE_MAX`, `POOL`.
- `utils/listingBrain/model/score.js` (43) — `indexBundle`, `truthSold`, `placementTruth`, `listingWindow`,
  `inStockDays`, `calibration`, `discrimination`, `newScore`, `addScore`, `finishScore`, `demandFor`, `admitRow`,
  `finishPlacement`, `bestOf`, `agreement`, `unitExpiry`, `hazardOfForecast`, `soldOrExpired`, `scoreUnits`,
  `newTables`, `scoreForecasts`, `scorePlacement`, `finishTables`, `viewAt`, `backtest`, `backtestAsync`,
  `forwardScores`, `forwardScoresAsync`, `decisionReview`, `disagreementOf`, `topDisagreements`; constants
  `RELIABILITY_BINS`, `NEAR_PCT`, `PLACE_DAYS`, `REVIEW_DAYS`, `REVIEW_LIMIT`, `IN_STOCK_DAYS`, `SCORED_ACTIONS`,
  `SCORE_NOTE`, `CANNOT_SHOW`, `AGREEMENT_NOTE`, `PLACEMENT_NOTE`, `BACKTEST_LIMITS`.

**Log, API, page**

- `models/ListingBrainRun.js` — the Mongoose model `ListingBrainRun`, plus `TTL_DAYS` (21).
- `models/ListingBrainRow.js` — the Mongoose model `ListingBrainRow`.
- `routes/listingBrainRoutes.js` (7) — `mount`, `publicRow`, `publicOffer`; constants `ROW_FIELDS`, `OFFER_FIELDS`,
  `OFFER_LIVE_FIELDS`, `FORBIDDEN_KEYS`.
- `public/listing-brain.js` (browser) — `window.ListingBrainTab = { render }`.

**Scripts**

- `scripts/listing-brain-fixture.js` (6) — `generate`, `mulberry32`, `toJson`; constants `PLANTED`, `LAWS`,
  `DEFAULT_NOW`.
- `scripts/listing-brain-backtest.js` (17) — `table`, `parseArgs`, `formatRunSummary`, `formatDisagreements`,
  `formatWeeks`, `formatCalibration`, `formatDiscrimination`, `formatPlacement`, `formatAgreement`,
  `formatSoldOrExpired`, `formatNotes`, `formatBacktest`, `formatReport`, `main`; constants `HEADERS`,
  `DEFAULT_WEEKS`, `TOP_DISAGREEMENTS`.
- `scripts/listing-brain-export.js` (5) — `exportBundle`, `argValue`, `defaultOut`, `insideRepo`, `connectFailure`.
- `scripts/listing-brain-preview.js` (2) — `previewBrain`, `args`.

## 5. Tests

Run at `2563c49` on 2026-10-03 in the build sandbox, on Node 22.22.0 and on Node 20.20.0 (production's version):

```
CRED_SECRET=x node --test $(ls tests/listingBrain*.test.js | grep -v Mongo)
CRED_SECRET=x <a Node 20 binary> --test $(ls tests/listingBrain*.test.js | grep -v Mongo)
```

**398 tests, 398 pass, 0 fail, on each Node.** Per file (each also run on its own):

| File | Tests | Node 22 | Node 20 |
|---|---|---|---|
| `tests/listingBrainCore.test.js` | 128 | 128 pass (5.6 s) | 128 pass (5.6 s) |
| `tests/listingBrainModel.test.js` — the rules suite (R1–R50 + planted truths R51–R68, with a self-check of its `RULES` table) | 76 | 76 pass | 76 pass |
| `tests/listingBrainInputs.test.js` | 71 | 71 pass | 71 pass |
| `tests/listingBrainRun.test.js` | 34 | 34 pass | 34 pass |
| `tests/listingBrainScore.test.js` | 32 | 32 pass (7.2 s) | 32 pass (7.9 s) |
| `tests/listingBrainFixture.test.js` | 26 | 26 pass | 26 pass |
| `tests/listingBrainRoutes.test.js` | 19 | 19 pass | 19 pass |
| `tests/listingBrainSafety.test.js` (the source scan) | 9 | 9 pass | 9 pass |
| `tests/listingBrainSpeed.test.js` (speed and log size; numbers in the plan §11) | 3 | 3 pass | 3 pass |
| `tests/listingBrainMongo.test.js` | 5 | **not run** | **not run** |

**What could not run, and why.** `tests/listingBrainMongo.test.js` (5 tests: the two collections' indexes and TTLs,
what one run writes, reading the newest run back after a restart, a cell's history, the daily samples) needs
`mongodb-memory-server`'s `mongod` binary, which it downloads on first use; the sandbox's network policy refuses the
download (`fastdl.mongodb.org`, HTTP 403), so all five fail in their `before` hook. Every other runner behaviour is
covered with injected models in `tests/listingBrainRun.test.js`. **Run it on production's box, or anywhere the
binary downloads, before deploying.** No test touches the network.

**Also run, unchanged by this branch:** the environment check the brief asks for — `tests/demandBrainModel.test.js`
33/33 and `tests/priceTracker.test.js` 35/35 — and every test that pins the text of the three shared files:
`demandBrainRoutes` 7/7, `demandBrainV2` 43/43, `marketRadarRoutes` 10/10, `priceTrackerGames` 61/61,
`protectedPages` 41/41, `venuePricing` 14/14, `pricing` 41/41 — all pass on both Nodes.

**Review rounds.** Six adversarial reviews, then a regression review of the fixed code. Every finding that changed
code landed with a test that names it by its id and failed on the code before the fix (as the fix commits record:
`5041eb0`, `845af7a`, `c5f8c2f`, `05355ea`, `2563c49`):

| Round | Review | Found | Fixed with a test | Documented instead |
|---|---|---|---|---|
| 1 | Loader (against every producer of the data) | 14 (3 high) | L1–L13 | L14: today's split approximated (plan §10) |
| 1 | Privacy | 9 + 1 late | P1, P2a, P2b, P2-scan, P3, P4, P7, P8; the scan narrowed to credential-shaped values | P6: unsalted id hashes (plan §10) |
| 2 | Brief completeness | 19 (6 wrong, 5 missing) | C3–C5, C7–C14, C19 | the plan, this handoff, the row-mover list, the USD statement, the push, the Node 20 runs, the mutation pass |
| 2 | Money rules (the owner's rules on every path) | 12 + 2 decisions | M1–M12 | M13a, M13b: decisions (§12) |
| 2 | Model math (simulations) | 15 (4 high) | H1–H9, H11, H12, H14, H15, H17, H18 (H13 inside H4) | — |
| 2 | Safety and speed on Node 20 at production volume | 14 (4 high) | P20-1–P20-14 (P20-5 is C5) | — |
| 2 | Rules-suite builder | 2 | S1 (= M1), S2 (a test for each of two redundant guards) | — |
| 3 | Regression review | 13 (1 high) | N1–N11, EB, LC | — |

What each round found, in plain words, and the speed and log measurements are in the plan §11.

**Mutation pass:** <filled by the coordinator>

## 6. The backtest on the synthetic fixture

`node scripts/listing-brain-backtest.js tests/fixtures/listingBrain/small.json`, at `2563c49`. The fixture is synthetic
(invented games, prices and ids — `scripts/listing-brain-fixture.js` with its defaults, seed 1), so the output is
safe to publish. The two timings on its third line vary from run to run.

```
Listing brain — offline score (test mode: nothing is changed)
bundle tests/fixtures/listingBrain/small.json | now 2026-10-03 | 26 games, 487 listings, 436 unit sales
model run 102 ms, backtest of 6 weeks 400 ms

== RUN SUMMARY (the model as of the bundle's now) ==

cells 110, game × farm groups 26, per-listing forecasts 46

Price class (cells)
              auto-farm (claim)  no-claim
------------  -----------------  --------
agree                        22         4
brain-lower                  19         0
brain-higher                 13         3
no-evidence                  39         0
managed                       4         4
ladder                        1         1

Shelf class (cells)
             auto-farm (claim)  no-claim
-----------  -----------------  --------
agree                       28         0
brain-more                  27         4
brain-fewer                  1         0
brain-add                    3         2
brain-drop                   0         0
closed                      13         3
unknown                      8         0
unmeasured                  18         0
managed                      0         3

Live system-made rows: the brain's action
        auto-farm (claim)  no-claim
------  -----------------  --------
hold                   12         3
lower                  28         0
raise                   0         1
test                    0         0
ladder                  1         1

Regime (game × farm)
           auto-farm (claim)  no-claim
---------  -----------------  --------
scarce                     2         0
balanced                  15         3
overstock                  3         1
unknown                    2         0

Shelf, today's code vs the brain (units, on cells both sides can judge)
                              auto-farm (claim)  no-claim
----------------------------  -----------------  --------
cells compared                               59         6
today's shelf                                68        12
brain's shelf                               167        58
brain's reserve / pool                       35        57
bulk set aside                                0        28
cells the brain cannot judge                  8         0
  today's shelf there                         8         0

Weekly value of the live stock, at today's asks vs at the brain's prices (expected net, on cells valued both ways)
                auto-farm (claim)  no-claim
--------------  -----------------  --------
cells compared                 21         3
today's asks               $27.97     $6.68
brain's prices             $31.50     $7.32

== TOP DISAGREEMENTS (today's code vs the brain, largest $ at stake first) ==

game          farm     market    price class   today  brain  shelf class  today  brain  $ at stake  regime     confidence
------------  -------  --------  ------------  -----  -----  -----------  -----  -----  ----------  ---------  ----------
Omega Racers  noclaim  gameflip  ladder        $1.63      —  brain-more       2     17      $24.45  balanced   high
Omega Racers  noclaim  ggsel     brain-higher  $1.25  $1.40  brain-more       5     17      $17.55  balanced   high
Alpha Quest   claim    eldorado  brain-higher  $1.50  $2.00  brain-more       1      9      $16.50  balanced   medium
Rho Galaxy    claim    gameflip  brain-lower   $4.25  $2.80  brain-more       1      6      $15.45  scarce     high
Theta Drift   claim    eldorado  ladder        $1.75      —  brain-more       1      9      $14.00  balanced   medium
Gamma Rush    claim    gameflip  brain-lower   $3.20  $2.13  brain-more       1      5      $12.80  balanced   high
Gamma Rush    claim    eldorado  brain-higher  $2.50  $2.80  brain-more       1      5      $11.50  balanced   low
Nu Frontier   claim    eldorado  brain-lower   $2.03  $1.85  brain-more       1      7      $11.28  balanced   medium
Omega Saga    noclaim  ggsel     agree         $1.50  $1.50  brain-add        0      7      $10.50  balanced   low
Beta Arena    claim    gameflip  brain-lower   $3.40  $2.25  brain-more       2      4      $10.25  balanced   high
Alpha Quest   claim    gameflip  brain-lower   $2.95  $1.95  brain-more       2      4       $9.90  balanced   high
Omega Online  noclaim  gameflip  agree         $1.75  $1.75  brain-more       1      6       $8.75  overstock  low
Iota Tactics  claim    eldorado  brain-higher  $1.50  $1.85  brain-more       1      5       $7.75  balanced   medium
Beta Arena    claim    g2g       no-evidence   $1.50      —  brain-more       1      6       $7.50  balanced   medium
Omega Saga    noclaim  gameflip  agree         $1.50  $1.50  brain-add        0      5       $7.50  balanced   high
($ at stake = price gap × units listed (a new listing counts one) + shelf gap × the unit price.)

== BACKTEST WEEKS ==

cut         live listings forecast  scored  sold within horizon  cell-weeks admitted  units sold there  no-claim units scored
----------  ----------------------  ------  -------------------  -------------------  ----------------  ---------------------
2026-08-22                      72      72                   12                   27                12                      0
2026-08-29                      73      73                   13                   30                17                      0
2026-09-05                      66      66                   12                   29                13                      1
2026-09-12                      62      62                   10                   28                20                      1
2026-09-19                      69      69                   20                   25                17                      3
2026-09-26                      60      60                   15                   22                12                      9
forecasts 402: scored 402, horizon not over 0, listing missing from the bundle 0, on ZeusX (records no sale) 10; without a sell chance (market never fitted) 3

== SELL-THROUGH CALIBRATION ==

Each live system-made listing's chance to sell within its horizon at its own ask, against the baseline: every listing on a market sells at that market's base rate. Brier = mean squared miss (lower is better); skill = 1 − Brier ÷ baseline Brier.
farm               listings  sold  mean forecast  Brier (brain)  Brier (baseline)   skill  verdict
-----------------  --------  ----  -------------  -------------  ----------------  ------  -------------------------------------------------------
auto-farm (claim)       377    78          21.0%         0.1250            0.1571  +0.205  beats the baseline
no-claim                 12     4          69.0%         0.4103            0.3905  -0.051  does not beat the baseline yet: do not trust its prices

By market
farm               market    listings  Brier (brain)  Brier (baseline)   skill
-----------------  --------  --------  -------------  ----------------  ------
auto-farm (claim)  gameflip       296         0.0940            0.1316  +0.286
auto-farm (claim)  ggsel           54         0.2317            0.2526  +0.083
auto-farm (claim)  eldorado        27         0.2509            0.2460  -0.020
no-claim           gameflip         4         0.3937            0.3345  -0.177
no-claim           ggsel            8         0.4187            0.4184  -0.001

RELIABILITY — auto-farm (claim)
forecast chance  listings  mean forecast  really sold
---------------  --------  -------------  -----------
0%–10%                180           1.7%         2.2%
10%–20%                37          14.6%        24.3%
20%–30%                22          25.2%        18.2%
30%–40%                31          35.5%        32.3%
40%–50%                52          45.2%        42.3%
50%–60%                48          54.8%        50.0%
60%–70%                 7          63.0%        71.4%

RELIABILITY — no-claim
forecast chance  listings  mean forecast  really sold
---------------  --------  -------------  -----------
20%–30%                 1          22.9%       100.0%
50%–60%                 1          53.8%         0.0%
60%–70%                 6          68.7%        16.7%
80%–90%                 4          84.9%        50.0%

== DISCRIMINATION ==

How often live listings sold within the horizon, grouped by what the brain told them. If it is informative, rows it would lower sell less often at today's price than rows it would hold.
farm               the brain said  listings  sold  sell rate
-----------------  --------------  --------  ----  ----------------------
auto-farm (claim)  hold                 158    44  27.8%
auto-farm (claim)  lower                207    30  14.5%
auto-farm (claim)  raise                 11     3  27.3%
auto-farm (claim)  test                   2     0  0.0%
auto-farm (claim)  ladder                 2     1  50.0%
no-claim           hold                  10     4  40.0%
no-claim           lower                  0     0  not enough history yet
no-claim           raise                  2     0  0.0%
no-claim           test                   0     0  not enough history yet

== PLACEMENT FORECAST (each policy's weekly demand split, in-stock weeks) ==

Each placement policy's weekly demand split for a market (its forecast rate there, not capped by any shelf) against the units system-made rows sold there that week — scored only on cell-weeks the market was in stock at least 6 of the 7 days, because a week out of stock says nothing about demand. A different shelf's sales cannot be seen in test mode.
A cell-week is scored when it sold or any policy expected a sale; a policy with no number on a scored cell-week is missing there (never 0) and is not ranked; the best is picked by RMSE among policies scored on the very same cell-weeks.

auto-farm (claim): 156 in-stock cell-weeks scored, 74 units sold there
policy       RMSE    MAE    bias  cell-weeks  forecast  sold
----------  -----  -----  ------  ----------  --------  ----  ---------------------------------------------------
flat        0.707  0.521  -0.224         156      39.0    74  ✓ best
share30     0.759  0.586  -0.029         151      69.7    74  not enough history yet (missing on some cell-weeks)
instock     0.748  0.564  -0.089         151      60.6    74  not enough history yet (missing on some cell-weeks)
newsvendor  0.714  0.565  -0.057         156      65.2    74
not scored: 264 cell-weeks out of stock more than a day (46 units); 108 ZeusX cell-weeks not scored (ZeusX records no sale for an auto row).

no-claim: 5 in-stock cell-weeks scored, 17 units sold there
policy       RMSE    MAE    bias  cell-weeks  forecast  sold
----------  -----  -----  ------  ----------  --------  ----  ------
flat        3.460  2.558  -2.444           5       4.8    17
share30     3.250  2.472  -2.073           5       6.6    17  ✓ best
instock     3.564  2.700  -2.507           5       4.5    17
newsvendor  3.469  2.531  -2.515           5       4.4    17
not scored: 28 cell-weeks out of stock more than a day (43 units); 10 units on cells first listed after the forecast.

== AGREEMENT ANALYSIS (correlation, not cause) ==

Correlation, not cause: listings that happened to sit near a policy's price are no proof that the price made them sell.
Realised net per listing-day (after the market's fee) of live listings whose ask was within 10 % of each policy's price, against listings further away, by market.
market          policy   near: listings  listing-days  net/day  far: listings  listing-days  net/day
--------------  -------  --------------  ------------  -------  -------------  ------------  -------
gameflip        old                 122         643.5    $0.08            178        1018.7    $0.03
gameflip        tracker              29         121.9    $0.17            190        1102.3    $0.03
gameflip        curve                46         235.0    $0.11            248        1393.4    $0.04
gameflip        clear                 7          29.9    $0.22             25         116.6    $0.07
ggsel           old                  61         311.3    $0.12              1           2.0    $0.00
ggsel           tracker              50         247.9    $0.12              0           0.0        —
ggsel           curve                56         277.3    $0.12              3          15.0    $0.14
ggsel           clear                 8          26.2    $0.20              0           0.0        —
eldorado        old                  27         141.3    $0.23              0           0.0        —
eldorado        tracker               2          14.0    $0.23              0           0.0        —
eldorado        curve                14          65.7    $0.15              6          36.6    $0.25
eldorado        clear                 3          13.8    $0.13              0           0.0        —
playerauctions  old                   3          21.0    $0.00              0           0.0        —
playerauctions  tracker               3          21.0    $0.00              0           0.0        —

== SOLD OR EXPIRED (no-claim) ==

No-claim units live at a forecast whose stock expiry (wave end + the learned claim window) has passed: the share the brain expected to sell before expiry against the share that did.
units  expected to sell  really sold  sold  expired  Brier per unit
-----  ----------------  -----------  ----  -------  --------------
   14             82.6%        50.0%     7        7          0.4170

By game
game           units  expected  really sold   Brier
-------------  -----  --------  -----------  ------
omega online       2     51.4%       100.0%  0.3172
omega racers       2     90.0%        50.0%  0.4659
omega saga         7     90.9%        42.9%  0.4644
omega tactics      3     79.2%        33.3%  0.3404
not scored: 0 units past their estimated expiry at the forecast (the model ignores that estimate), 0 whose expiry is still ahead, 0 the ledger has not closed, 0 with no dated wave, 29 on a market without a no-claim estimate.

== NOTES ==

- The brain's chance to sell is scored against a baseline that gives every listing on a market that market's base rate. The model must beat the baseline (skill above 0) before anything it says is trusted.
- What test mode cannot show: whether a different price would have sold, or whether a different shelf would have sold more. Every score here compares what the brain would have said with what happened at the price that was actually asked, from the shelf that was actually listed; that needs live experiments, a later round.
- Each week is replayed from the bundle as it stood at the cut: listings created, sales made and orders priced before it only; a row rebundled after the cut is left out of offer-level evidence (what it held at the cut was not recorded).
- The farm brain's demand at a cut is our own 45-day average then (its default estimator). Its stock at the cut is not known (only the units listed are), so a replayed regime comes from the farm brain's skip, fading demand or perishing stock, never from cover; no cool-down history is replayed.
- Still read as of today, not as of the cut: each listing's price, ask and learned floor (vmin), its quantity counters (qty, qr), the radar's game rows (no time filter), and each no-claim unit's bundle key and listing ids.
- Today's old-side numbers (new-listing prices, the flat split, the tracker's suggestion) stand in for the old side at each cut: the bundle holds only today's.
- Weekly cuts see a no-claim expiry at most a week ahead; the daily forward samples see its last days.
```

**The large fixture** (`node scripts/listing-brain-fixture.js --large --out <scratch>/large.json`, seed 1: 150 games,
4,742 listings, 5,255 unit sales, 1,526 no-claim units; then the backtest on it): model run 455 ms, six-week backtest
2.1 s.

- Run summary: 758 cells. Price classes, claim / no-claim: agree 239 / 29, brain-lower 112 / 5, brain-higher 71 / 0,
  no-evidence 249 / 3, managed 29 / 19, ladder 1 / 1. Live system-made rows, claim: hold 260, lower 215, raise 24,
  test 0 (no-claim: hold 13). Shelf on the cells both sides judge, claim: today 504 → brain 1,378 (+110 reserve);
  no-claim: 26 → 430 (+174 in the pool, 28 set aside for bulk). Weekly value of the live stock, claim: $582.83 at
  today's asks → $634.89 at the brain's prices (246 cells).
- 3,846 forecasts scored over the six weekly cuts (84 on ZeusX left out).
- Calibration skill, claim **+0.175** (Brier 0.1428 vs baseline 0.1731, 3,669 listings): Gameflip +0.311, GGSel
  +0.009, Eldorado 0.000, PlayerAuctions +0.012, G2G −0.072. No-claim +0.021 (0.2200 vs 0.2248, 93 listings).
- Discrimination, claim, sold within 7 days: hold 44.1 % (1,396), lower 10.5 % (2,052), raise 54.5 % (211), test
  37.5 % (8). No-claim: hold 71.2 %, raise 63.0 %.
- Placement, RMSE of each policy's weekly demand split on in-stock cell-weeks: claim (1,413 cell-weeks, 1,210 units)
  flat 1.047 ✓ best, newsvendor 1.051, share30 1.098 and instock 1.116 (both missing on 5 cell-weeks: not ranked);
  no-claim (38 cell-weeks) flat 3.263 ✓ best, share30 3.356, newsvendor 3.386, instock 3.638.
- Sold or expired (no-claim): 77.7 % expected to sell before expiry, 76.5 % did (149 units, Brier 0.152).

On both fixtures today's flat split still edges the newsvendor split on placement, and the no-claim calibration is
barely above (large) or below (small, 12 listings) its baseline: those are the numbers to watch first on real data.

## 7. Assumptions about real data that could not be checked — verify these first

Nobody in the build could see production. Each line: the assumption — where to look — what to check on real rows.
Items marked ✓ were checked against the producing code by the loader review (they read right in the code; real rows
may still differ). The run's `counts` (in the run document and the export's printout) carry most of the numbers named
here.

**The five riskiest — check these first**

1. **The Eldorado keep-alive renewed every unsold active offer whose 21 days ended on or after 2026-09-23.** No
   field records a resume, so the brain trusts the switch: with `autoFarm.eldoradoKeepAlive` on (unless false, as in
   `eldoradoFulfiller`) such an offer stays live with no end to its life; with it off, or when its 21 days ended
   before 2026-09-23 (`ELDORADO_KEEPALIVE_SINCE` in `model/util.js`, the keep-alive's first pass — inferred from the
   code's own note that 123 offers were due on 2026-09-27, not read from a log), it is dead at `createdAt + 21 d`
   (no advice, exposure cut, out of the 100-offer count). Found while writing this handoff and fixed (test EKA). —
   `utils/listingBrain/model/util.js:eldoradoDead`; `model/evidence.js:activeAt`, `exposureOf`, `daysLeftOf`;
   `inputs.js:trackerOffers` (its `isLive` restates it). Check: the date the keep-alive first ran on production (move
   `ELDORADO_KEEPALIVE_SINCE` to it); a sample of active system-made Eldorado rows older than 21 days with no sale
   are really on sale (an offer the keep-alive skipped — paused, or no longer ours — still reads live until its row
   changes).
2. **A no-claim sale comes from `UnclaimedAccount`, booked on the newest named `origin: "unclaimed"` row on the market
   it sold on that existed when it sold; every ledger record of such a row is dropped.** ✓ Read against the producers:
   `listingIds` only grow (GGSel rebuild `$addToSet`, Gameflip successor, lots), `manualListing` marks a sale through
   an owner row, `handSellAccounts` stamps `soldMarket: "manual"`, the mark-sold route writes the note. —
   `inputs.js:noclaimUnitsSteps`, `saleRowOf`, `saleRecordsSteps`. Check: `u_sales` (+ `u_pack`) against
   `s_unclaimedDropped` (+ `s_unclaimedDemandDropped`) — the same sales seen from both sides should be of one size
   (hand sales write no ledger record); `u_elsewhere` and `u_otherRows` small; a sample of GGSel no-claim sales falls
   inside its row's exposure.
3. **A Gameflip buyer takes the cheapest live row of an offer.** The per-offer fit and every Gameflip row's chance
   rest on it; the correction by queue place (alone / 1st / 2nd / 3rd+) is learnt from the offer timelines and stays
   near 1 where a class has little history. — `model/hazard.js:sweepOffer`, `queueP`, `rowPH`, `fitSteps` (the
   fit's `markets.gameflip.queue[].n`). Check: the samples per class (hundreds or more before a factor means
   much); the backtest's Gameflip reliability table; whether buyers choose dearer rows (seller rating, title) often enough to matter.
4. **The farm brain's rows join the games.** ✓ A claim row's `k` is `normGame(game)`, the tracker's game key; a
   no-claim row's `k` is `normGameName(keyword)` and its `stk.on` is listed + held (both read in the farm brain's
   code). The split of a bucket over its games by their 30-day no-claim sales, and on hand = own listed + (bucket on
   − Σ listed) × share, are this build's rules. — `inputs.js:demandRowsSteps`; `model/price.js:gameState`. Check:
   `counts.demand` and `demandUnsplit`; the regime per game beside the farm brain's own page; buckets whose games
   sell very unevenly.
5. **A no-claim unit's wave, and how long its drops outlive it.** ✓ `drops[].campaign` holds the raw Twitch campaign
   name (`twitchInventory`), matched to the wave's `name`; else the wave live when the unit was listed. The claim
   window is learnt as the median of `expiredAt − wave end` over expired units (the game's, else every game's). —
   `model/evidence.js:makeWaveEndOf`; `inputs.js:waves`; `model/price.js:perishOf`. Check: the share of listed units
   with a dated wave (`perishOf(g).dated ÷ listed`), the learned window per game in days, and that games read
   "perishing" really lose their drops within 48 h.

**Listings and the tracker's report**

6. ✓ The report's shape (`ledger.{sales, demandOnly, suspect}`, `prepared.rows[{l, id, market, listingId}]`,
   `prepared.setById` a Map, `at`, `truncated`) and the ledger fields read (`market`, lower-case `listingId`,
   `origin`, `gameKey`, `contentKey`, `bandKey`, `itemCount`, `exact`, `saleGroup`, `key`, `source`, `at`,
   `priceUsd`, `priceBasis`, `priced`); demand-only `priceUsd` is always 0. — `inputs.js:normaliseListingsSteps`,
   `saleRecordsSteps`. Check: `s_unknownSource` 0; `l_inReport` close to `listings`.
7. A row in the extra read but not in the report, older than the report, is classified by its flags (`unexplained`,
   with a note); it is a rent-farm row only by its flag or its fresh title. — `inputs.js:normaliseListingsSteps`.
   Check: `l_unexplained`, `l_farmByTitle`, `l_junkPrice`.
8. A row's price, status, dates, origin and `venueMinPriceUsd` come from the tracker's cached row (as old as the
   report), its flags, units and quantities from the fresh read. — same. Check: the "report is N min old" note.
9. ✓ `MarketplaceListing.price` and `venueMinPriceUsd` are USD on every market, GGSel included (roubles are made at
   publish); GGSel's raise-only rule is applied in USD. — `model/price.js:gateChain`. Check: a few GGSel rows' USD
   price against what GGSel shows at today's rate.
10. ✓ `units[].addedAt` / `deliveredAt` exist; `units[]` is in append order (the first 200 kept are the oldest); on a
    claim-at-sale row `addedAt == deliveredAt`. — `inputs.js:normaliseListingsSteps`; `model/evidence.js:exposureOf`.
    Check: `l_unitsCut`; rows whose first unit is not the earliest.
11. A Gameflip row is off sale 30 days after `createdAt` whatever its status (rows stayed `active` past expiry until
    2026-10-01; a renewal is a new row). — `model/evidence.js:activeAt`. Check: the `expired` flag count on Gameflip
    cells.
12. `updatedAt` approximates when a delisted or removed row ended, and when a single-unit row marked sold without a
    sale record sold. — `model/evidence.js:exposureOf` (`endApprox`). Check: how many fit rows end approximately.
13. ✓ The G2G operator-script rows are `origin: "auto"` and `autoClaimSet: true`: claim-at-sale, counted apart. —
    `inputs.js:kindOf`. Check: `l_script`.
14. ✓ `bulkPackSize` is accounts per pack and a pack row has `bulkOfferId`; `lotSize` and `qtyRemaining` mean what the
    brain reads. — `inputs.js:normaliseListingsSteps` (`packMath.packSizeOf`). Check: `l_bulk`, `l_lot`, `bulkPrices`.
15. The newest 20,000 listings by `_id` cover the 222-day window. — `inputs.js:readListings`. Check: `listingRows`
    under the cap; `listingOutsideWindow`.

**No-claim units (`UnclaimedAccount`)**

16. ✓ `market` and `soldMarket` use the tracker's keys (`digiseller`), `soldMarket: "manual"` is a hand sale,
    `soldPriceUsd` is USD (the row's price, or the order's for owner sales). — `inputs.js:noclaimUnitsSteps`. Check:
    the `u_*` counts.
17. ✓ `expiredAt` is never cleared on a re-list: older than `listedAt`, it is a previous life's and reads null. — same
    (`u_staleExpiry`).
18. ✓ A non-empty `manualListing` means the unit sold through an owner's listing; the ledger holds that sale. — same
    (`u_ownerRow`).
19. ✓ The operator's mark-sold route leaves the note "manual mark sold…" (matched `/^manual mark sold/i`, read in
    memory only). — `inputs.js:MARK_SOLD_RE`. Check: `u_markSold`.
20. The units booked on one row in the same minute are one order (one detection pass). — `inputs.js:noclaimUnitsSteps`
    (`grp`). Check: a few real passes that sold several units.
21. A pack unit naming a pack row the ledger already has a bulk record for is that record; matched by count per row,
    not unit by unit. — same (`u_packInLedger`).
22. `UnclaimedAccount.updatedAt` is when a skipped, removed or manual unit went off sale; any later write (a check
    pass's `lastCheckedAt`) moves it. — `model/evidence.js` (unit state, step 8); `inputs.js:UNIT_PROJECTION`.
    Check: a few skipped units' `updatedAt` against when they were skipped. (Only backtest cuts depend on it.)
23. `bundleKey` is `"<event key>|<wave label>+<wave label>…"` (`unclaimedBundles.classifyHoldings`) and the units of
    one bundle on one row share it. — `model/price.js:parseBundleKey`, `offerBundleOf`, `bundleContains`. Check: how
    many no-claim offers say "No bundle key recorded on its units"; that a bigger bundle's key holds a smaller one's
    labels.
24. The two unit reads (≤ 50,000 each, newest first) cover their windows. — `inputs.js:readUnits`. Check:
    `unitReadListed`, `unitReadSold` under the cap.

**Farm brain, radar, research, settings**

25. ✓ `DemandBrainRow` carries `k, f, at, live, hl, br.c/w/t, stk.on/fl, est.avg30/avg45`, `br.w` the weekly forecast.
    — `inputs.js:readDemandRows`, `demandRowsSteps`.
26. ✓ The radar's game key is `normGame`; `byMarket` keys gameflip / ggsel / plati; the feed's `market, gameKey,
    priceUsd, units, itemCount, soldAt, ttsHours, ours, kind`. — `inputs.js:radarSlim`. Check: `radarGames`,
    `radarFeed`.
27. ✓ `derivePrice` and `bundlePrice` read only `markets.gameflip/ggsel/plati`; the brain matches the research row on
    the game's label exactly, else case-insensitively, where the lister matches the task's label exactly. —
    `inputs.js:matchResearch`, `oldSide` (`rm`). Check: `researchCi`, `researchNone`.
28. ✓ `getUnclaimedPricing`, `getFarmSizing`, `getBulkPacks` (tiers `minQty` / `discountPct`), the fees from
    `loadSettings().priceTracker.fees`, `GAME_CAP` 70 and the first-matching-key cap rule. — `inputs.js:settingsBlock`,
    `afBlock`.
29. ✓ The switches read as `!!af.<switch>`, as the lister reads them (a string "false" reads as on). —
    `inputs.js:takesOf`.
30. `DropSet.sourceType === "autofarm-bundle"` (`autoFarmBundles.SOURCE_TYPE`) marks a claim event-bundle set and
    `sourceEventKey` names its event. — `inputs.js:readEventSets`, `oldSide`. Check: `eventBundleSets`,
    `eventBundleOffers`.

**Today's side, restated**

31. Today's split is fed the farm brain's stock on hand (else the tracker's `farm.onHand`, else the live auto units);
    the lister splits `task.assignedAccounts.length`. — `inputs.js:oldSide`.
32. The lister's per-game marketplace lookups are stood in for offline: GGSel by `ggselCategoryId` or our history,
    ZeusX by `zeusxGames` or history, PlayerAuctions by history only. — `inputs.js:oldOrder`.
33. ✓ `venuePrice` does not depend on the game (it asks `evidenceFor({ game: "" })`), so one GGSel factor serves every
    game. — `autoLister.venuePrice`; `inputs.js:oldSide`. Check: the GGSel old prices of two games with one base agree.
34. A no-claim offer's price today: `bundlePrice` classified against the whole event catalog, sold floor 0 (the
    new-set path). — `inputs.js:oldSide`.
35. An event bundle is priced as not complete (`full: false`), with the event's sold floor from its auto rows marked
    sold in 30 days, dated by their last write. — `inputs.js:oldSide` (`ebPrice`).
36. The loader's restatement of the model's main-offer rule (which offers the tracker is asked about) matches the
    model on real data as it does on its own bundle (test N5). — `inputs.js:trackerOffers` vs
    `model.js:priceGroup`, `mainVerdict`, `identities`. Check: `trackerAsked + trackerCut` against the number of
    priced cells; cells with no `pol.tracker` while no cap note was written (the tracker answered nothing, or the two
    rules drifted apart).

**Other**

37. ZeusX records no sale for an auto row (delivery by hand in chat). — `model/hazard.js:UNMEASURED`.
38. Plati and GGSel sales are inferred from stock drops and lean low (a refill between passes hides one). — the
    tracker's ledger; the scores.
39. `getReportSWR` may hand back a stale report (noted when over 30 min). — `inputs.js:load`.
40. Connecting with `autoIndex` and `autoCreate` off keeps the export's connection write-free. —
    `scripts/listing-brain-export.js`.

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
| `settings.getAutoFarm`, `getFarmSizing`, `getUnclaimedPricing`, `getBulkPacks`, `loadSettings().priceTracker.fees` | file reads (no DB) | once per run by the loader; `getAutoFarm` also once per tick by the runner (the switch) |

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

"Auto row" means `origin: "auto"`. File and line pointers are as read on `fix/live-defects-1003` (`66178bc`);
other sessions edit these files, so treat a line number as a pointer, the function name as the anchor.

**Automated**

| # | Path | File:line | What moves | Markets | Loop |
|---|---|---|---|---|---|
| 1 | Post-event markup | `autoLister.js:3259–3291` (`onCampaignEnded`) | **price** ×1.5 (`postEventPrice`), title, description, image; **`qtyRemaining += heldBack`** | Gameflip | `autoFarmer.completeEndedTasks` / `repriceEndedTasks` (legacy tick); `farm2/steps/publish.js:96` |
| 2 | Post-event retext | `autoLister.js:3301–3337` | title and description only | GGSel (Plati reported only) | same |
| 3 | Refill to `perMarketStock` | `autoLister.js:1642–1668` | the `qtyRemaining` counter | Gameflip | legacy tick, `autoFarmer.js:4827` |
| 4 | Refill to `perMarketStock` | `autoLister.js:1672–1706` | units added (`digisellerAddContent`) + `units[]` | Plati | same |
| 5 | Refill to `perMarketStock` | `autoLister.js:1710–1744` | products added (`ggselAddProducts`) + `units[]` | GGSel | same |
| 6 | Guardian auto-feed to `qtyTarget` | `marketplaceGuardian.js:1269–1520`; `lastStock` written at 1340, 1735 | units added; `lastStock` | Plati, GGSel (any `autoDeliver` row, hand-made included) | every 5 min, `server.js:895` |
| 7 | Guardian re-activation of a stuck-paused GGSel offer | `marketplaceGuardian.js:1352`, 1623 (`ggselFinalizeStock`) | on-sale state | GGSel | every 5 min |
| 8 | Sold-out Eldorado share retired | `autoLister.js:1285–1302` | `status → "sold"`, offer delisted | Eldorado | `retryMissingSecondaries` (legacy tick and farm2 secondaries) |
| 9 | Stale Gameflip row on a 404 | `autoLister.js:1807–1814` | `status → "removed"` | Gameflip | `listActivatedTask` (also in `dryRun`) |
| 10 | Relist chain on sale | `gameflipFulfiller.js` (`publishAutoDelivery` ~371; sale relists ~1826–1838 / ~1905–1926) | **a new row** at the predecessor's `price`, floored at `DropSet.minPriceUsd` (399–400); `qtyRemaining − 1`; origin carried | Gameflip | Gameflip fulfiller, every 60 s |
| 11 | Renewal after the 30-day expiry | `gameflipFulfiller.js:1095–1162`, ~1952–2015 | **a new row**, same price; `qtyRemaining` unchanged | Gameflip | same; switch `autoFarm.gameflipRenewExpired` |
| 12 | Eldorado quantity sync | `eldoradoFulfiller.js:265, 410, 734, 930–957` | advertised quantity = undelivered units; pause / resume at 0 | Eldorado | Eldorado fulfiller |
| 13 | G2G stock sync | `g2gFulfiller.js:1243–1330` (rows with `origin != "manual"`) | `actual_qty` = real stock | G2G (auto rows **and** the script `autoClaimSet` rows) | `g2gSyncStock` loop |
| 14 | PlayerAuctions stock sync | `playerauctionsFulfiller.js:401–419` | `totalUnit`; the offer id may be **replaced** | PlayerAuctions | after each delivery |
| 15 | Account detach | `listingDetach.js` (e.g. 420–444: ZeusX quantity, `qtyTarget = kept`) | quantity, units; a Gameflip offer taken down and republished | all | drop-archive "mark sold", a renter's manual add |
| 16 | Republish of a quantity listing | `listingRepublish.js:90–160` | **a new row** (`origin: row.origin \|\| "auto"`), same price | Plati, GGSel | guardian auto-heal and fixes, detach |
| 17 | Guardian fixes | `guardianFixes.js` (replace / detach / refeed) | units, quantity | Plati, GGSel | the Integrity tab's button, auto-heal |
| 18 | Retry of a missing secondary | `autoLister.js:1309–1527` | **new rows** at `gfRow.price` | Plati, GGSel, ZeusX, G2G, Eldorado | legacy tick and farm2 |

Also, found while writing this handoff: the **Eldorado keep-alive** (`eldoradoFulfiller.js`, "Offer keep-alive", switch
`autoFarm.eldoradoKeepAlive`, on unless false) pauses and resumes active offers that are still ours, restarting their
21-day life — it moves no price, but it decides how long an Eldorado row stays on sale; the brain now follows it
(§7 item 1).

**Run by an operator (not loops)**

| Path | File:line | What it moves |
|---|---|---|
| Reprice script | `scripts/reprice-listings.js` (`--apply`, `origin: "auto"` only) | price on Gameflip / Digiseller / GGSel (roubles) / ZeusX; sets `venueMinPriceUsd` on a GGSel refusal (355) — **the only writer of `venueMinPriceUsd` in the repo** |
| Eldorado reprice script | `scripts/reprice-eldorado-game.js:80` | Eldorado price |
| G2G offer update route | `routes/marketplaceRoutes.js:340–351` | any G2G offer |
| Delist route | `routes/marketplaceRoutes.js:1701` | delists a row |
| Description fixers | `scripts/fix-live-descriptions.js`, `sync-zeusx-descriptions.js`, `repair-mixed-game-sets.js` | text only |

`unclaimedAutoList.repriceUnclaimedRows`, `unclaimedListingAudit` and `noclaimOfferRotation` touch only no-claim rows
(below).

**Rule 5 holds for automated code:** nothing lowers an auto row's price. The only automated price change is the ×1.5
at campaign end, on Gameflip; Plati, GGSel, ZeusX, Eldorado, PlayerAuctions and G2G auto rows have no automated price
path at all, and the relist chain only carries a price forward and floors it. In the next round the brain's number
belongs in #1 (instead of the flat ×1.5), #10 (the relist price, with hook H5), and #3–#6 and #18 (the shelf, with
hook H4) — never in a new loop beside them.

### No-claim farm

No-claim rows are `origin: "unclaimed"` (the no-claim auto-lister's) and the owner's `noclaimStock` rows.

| # | Path | File:line | What it moves | Gate |
|---|---|---|---|---|
| 1 | `repriceUnclaimedRows` | `unclaimedAutoList.js:1866–2051` | the price of every active non-lot `origin: "unclaimed"` row (Gameflip, Digiseller, GGSel, Eldorado, PlayerAuctions), plus `DropSet.price` and `minPriceUsd` | switch `unclaimedRepriceExisting` (off), or the operator route `POST /api/unclaimed-auto/reprice` (`routes/unclaimedAutoRoutes.js:953`) |
| 2 | Dormant-set refresh | `unclaimedAutoList.js:4644–4663` | `DropSet.price` and `minPriceUsd` (the next publish's price) | the scan pass, every tick |
| 3 | Attach to an existing quantity row | `addUnitToRow` 2305–2356 | quantity +1 on Digiseller / GGSel (GGSel pauses, then re-finalises) | the scan pass |
| 4 | New row publish | `publishGameflipUnit` 2070, `publishProduct` 2288 | a new row at `set.price`, title `listingTitle(game, drops, cls)` | the scan pass |
| 5 | Gameflip successor | `publishGameflipSuccessor` 2360–2498 | a new live Gameflip row at **`DropSet.price`** with a **set-derived title** — a rebundled title and `requiredDrops` are **not** carried over | any unit removal, `repairGameflipChains` 4887, reconcile |
| 6 | Unit removal | `removeUnitFromRowLocked` 2719–2801 | quantity down (Digiseller content delete; GGSel rebuild; Gameflip delist plus successor); an empty row is delisted | sale, expiry, short unit, manual sold, reconcile |
| 7 | GGSel rebuild | `rebuildGgselOffer` 2838–2896 | delists, then publishes a **new offer (new external id)** at `DropSet.price` with a set-derived title | unit removal on GGSel |
| 8 | Check pass | `expirySalePass` 5031–5345 | quantity sales (`lastStock`, `spendAccount`); buyer-claimed / expired / short units. `handleShortUnit` 3152 and `takeShortUnitOff` 3205 delist the live Gameflip unit (Gameflip only) | every tick; shrink switch `unclaimedShrinkListings` (on unless false) |
| 9 | Reconcile | `reconcileRowsPass` 4126–4456 | duplicate rows delisted, dead units removed, stranded ledgers set to `skipped`, leaked Gameflip rows delisted, GGSel off-sale offers re-activated or closed | every check pass |
| 10 | Auto-rebundle | `runOnce` 5440 → `unclaimedListingAudit.rebundleAll({dryRun: false, auto: true})` → `applyRebundle` (`unclaimedListingAudit.js:1005–1064`) | **title, description, `requiredDrops`, `rebundledAt`**; price and `set` unchanged. Automatic on Gameflip and Eldorado; the manual route `POST /api/unclaimed-auto/rebundle` (`routes/unclaimedAutoRoutes.js:473`) can also do GGSel. Cool-down 1 h (`REBUNDLE_COOLDOWN_MS`) | switch `unclaimedAutoRebundle` (off) |
| 11 | Listing audit stock fix | `unclaimedListingAudit.applyStock` 1179–1304 | pause (`autoPaused: true`), ledgers set to released; quantity on Eldorado / PlayerAuctions / G2G split by `sharersForGame` | script only (`scripts/unclaimed-listing-audit.js:317, 408`) |
| 12 | Gameflip lots | `utils/unclaimedLots.js` (`publishLotIfReady`, `checkLots`), price = `lotPrice(set.price, n, pricing, game)` | lot rows | switch `unclaimedGameflipLots` (off); `checkLots` runs every pass |
| 13 | Eldorado offer rotation | `noclaimOfferRotation.rotationPass` 404, called from the `eldoradoFulfiller.js:1614–1622` stock tick | Eldorado **`noclaimStock`** rows: **`set` (moved to a new or reused DropSet)**, `requiredDrops`, title, description, note, `autoPaused`, `qtyTarget`, quantity; price unchanged, **no `rebundledAt`** | switch `noclaimRotateOffers` (on unless false) |
| 14 | Eldorado stock sync | `eldoradoFulfiller.syncBundleStock` 824–960 | `noclaimStock` rows: quantity = `noclaimStock.stockForListing`, pause / resume; retired `unclaimedGame` rows forced to 0, so they pause | the Eldorado stock tick |
| 15 | PlayerAuctions / G2G / bulk stock syncs | `playerauctionsFulfiller.js:364`, `g2gFulfiller.js:1216`, `bulkPacks/{stock.js:200, send.js:2601, 3304, loop.js:2220}` | the quantity of `noclaimStock` rows via `stockForListing` | their own loops |
| 16 | Scripts (by hand) | `scripts/reprice-listings.js`, `repair-unclaimed-set-prices.js`, `free-unclaimed-market.js`, `repair-unclaimed-cap.js`, `fix-unclaimed-descriptions.js`, `repair-mixed-game-sets.js` | price, text, delist | by hand |
| 17 | The owner's set edit | `routes/noclaimStockRoutes.js:586–602` | `DropSet.price` of the owner's no-claim sets | by hand |

In the next round the brain's number belongs in the paths that already set a no-claim price — #1
(`repriceUnclaimedRows`), #2 (the dormant refresh) and the `DropSet.price` that #4, #5 and #7 publish at — never in a
new pricer beside them. #10 and #13 change what an offer holds; the brain reads #10's `rebundledAt` and cannot see
#13 (plan §1.3 #11).

## 11. Proposed hooks for the next round — anchored snippets, NOT applied

Each hook is at most ten lines, anchored on text that occurs **exactly once** in today's file (every anchor below
was counted with `grep -cF` / a split count at `2563c49`: 1 each), in the style of
`scripts/apply-price-tracker-hook.js` (`once(label, anchor, replacement)`: an exact single match or abort; idempotent;
a dry run by default). None changes behaviour while its switch is off; none is applied.

### H1 — the health page watches the listing brain's loop like the farm brain's (`utils/systemHealth.js`)

Anchor A (the module table), 1 line added:
```js
  demandBrain: () => loadedModule("./demandBrain"),
  listingBrain: () => loadedModule("./listingBrain"),
```
Anchor B — the end of the farm brain's loop entry, these four lines, unique as a block:
```js
    offNote: "switched off (autoFarm.demandBrain.enabled)",
    // It logs nothing until it is switched on, so it is judged only then.
    onlyWhenEnabled: true,
  },
```
followed by, 4 lines added:
```js
  {
    id: "listingBrain", label: "listing brain (test log)", dep: "listingBrain", hook: "loopStatus", lastKey: "lastRunAt",
    fallbackMin: 180, offNote: "switched off (autoFarm.listingBrain.enabled)", onlyWhenEnabled: true,
  },
```
`loopStatus()` already exists, synchronous, never throws: `{ lastRunAt, intervalMin, enabled, since }`.

### H2 — the price seam: `attach.priceForNew` may ask the listing brain (`utils/priceTracker/attach.js`)

Anchor A: `    const sug = idx.suggestForNew(report, {` — replace that one line by these two; the rest of the call and every
guard after it (allowlist, `minConfidence`, non-engine basis, ±`maxDeviationPct`, floor, GGSel raise-only) stay as
they are:
```js
    const lb = cfg.source === "listingBrain" ? require("../listingBrain").priceFor({ marketplace: market, basePriceUsd: base, title: q.title, game: q.game, itemCount: q.itemCount, items }) : null;
    const sug = lb && lb.confidence !== "none" ? { price: lb.price, confidence: lb.confidence, basis: "listing brain: " + lb.basis, source: "listingBrain", position: lb.regime || "" } : idx.suggestForNew(report, {
```
Anchor B (`normalise`): `  return { mode, markets, minConfidence, maxDeviationPct };` →
```js
  return { mode, markets, minConfidence, maxDeviationPct, source: r.source === "listingBrain" ? "listingBrain" : "tracker" };
```
`priceFor` is synchronous, never throws, and answers today's price with confidence `none` when it has no fresh run —
the seam then falls back to the tracker exactly as today.

### H3 — the farm brain's value per account reads the listing brain's (`utils/demandBrain/inputs.js`)

Anchor A (`realDeps`): `    normGame: require("../priceTracker/setIdentity").normGame,` →
```js
    normGame: require("../priceTracker/setIdentity").normGame,
    listingBrain: require("../listingBrain"),
```
Anchor B (in `load`, the claim games' map; `af`, `d` and `key` are in scope), the two lines
`    let value = game && game.price ? num(game.price.valuePerAccount) : 0;` and
`    let valueBasis = value > 0 ? "our sales" : "";`, followed by:
```js
    const lbv = d.listingBrain && af.demandBrain && af.demandBrain.listingValue === true ? d.listingBrain.valueFor(key) : null;
    if (lbv && lbv.value > 0) { value = lbv.value; valueBasis = "listing brain"; }
```
Off unless `autoFarm.demandBrain.listingValue` is `true`; closes the loop between the two brains.

### H4 — the shelf, shadow only (`utils/autoLister.js` `listActivatedTask`, `models/AutoFarmTask.js`)

Anchor A: `  const split = computeSplit(qty);` (the file has three `computeSplit(` calls; this line occurs once) →
```js
  const split = computeSplit(qty);
  try { const lb = require("./listingBrain").shelfFor({ game: task.game, farm: "claim", stock: qty }); if (lb && lb.shelf) task.lbShelf = lb; } catch {}
```
Anchor B (the schema): `    // Dry-run preview: what WOULD have been listed (no real listing made).` → prepend
```js
    // The listing brain's shelf beside today's split (shadow; docs/LISTING-BRAIN-HANDOFF.md H4).
    lbShelf: { type: mongoose.Schema.Types.Mixed, default: null },
```
It records the brain's shelf beside today's split on the task; the next round decides whether `dealShares` reads
it. (`shelfFor` normalises the game itself and abstains — every unit in `reserve` — with no fresh run.)

### H5 — before any brain "lower" can stick on Gameflip (`utils/gameflipFulfiller.js` `publishAutoDelivery`)

Today the relist chain lifts every relist back to `DropSet.minPriceUsd`, which on an auto-lister set is the launch
price (`autoLister.js`: "The derived price IS the floor"): a brain-lowered Gameflip auto row would climb back on its
next relist. Anchor A (the function's parameters): `  qtyRemaining,\n  origin,\n  noclaim,\n}) {` →
```js
  qtyRemaining,
  origin,
  noclaim,
  lbPriced,
}) {
```
Anchor B (two lines; the first occurs once, the second twice — the other is the account-listing path):
`  const floor = Number(set && set.minPriceUsd) || 0;` + `  if (floor > 0 && (Number(priceUsd) || 0) < floor) priceUsd = floor;` →
```js
  const floor = Number(set && set.minPriceUsd) || 0;
  if (floor > 0 && (Number(priceUsd) || 0) < floor && !(origin === "auto" && lbPriced === true)) priceUsd = floor;
```
`lbPriced` is passed by whatever applies a brain price in the round after — never by the brain itself — and carried
along the relist chain with `origin`.

## 12. Decisions taken on the owner's behalf

Every choice the brief left open, or that a review settled, that the owner may want otherwise. "Setting" means a key
of `autoFarm.listingBrain` (plan §8): change it there, no restart. "Code" means a constant or a rule in the file
named: change it there (and the test that pins it).

**The owner's rules, as applied**

| # | Decision | Where it lives | How to change it |
|---|---|---|---|
| 1 | A ladder needs an owner row (hand-made or claim-at-sale); two system-made rows of one offer at two prices are drift, and advised (C4) | `model/evidence.js` step 9 (`owned`) | code |
| 2 | A ladder offer gets **no brain price at all**, live or as a new listing — a number beside it would invite a correction (M13a, N7) | `model/price.js:priceOffer` (`v.ladder`), `model.js:priceGroup` | code |
| 3 | The no-claim 30-day sold floor: a new listing takes it in full (as `bundlePrice` does); a live row is moved to it within the step limit (`sold-floor-steps`), with no order evidence needed (M13b) | `model/price.js:gateChain` | code |
| 4 | Claim-at-sale is checked **before** origin: the G2G operator-script rows (`origin: "auto"`, `autoClaimSet`) are never advised, their quantity never summed, and counted apart (`script`) | `inputs.js:kindOf`, `model/evidence.js:rowKindOf` | code |
| 5 | Every explicit `unclaimedGameCaps` entry is treated as the owner's (`managed`: shown, no shelf advice) — the allocator also writes entries, and nothing marks which are by hand, so the brain errs on the safe side | `inputs.js:afBlock` (`caps`), `model/place.js:capInfo`, `model.js:shelfForRun` | code; or mark hand-set caps in settings and read the mark |
| 6 | A raise needs `raiseMinSales` (2) of the farm's orders here at or above it, or repeated stock-outs; never on a market median, a rival's price or no basis | `model/price.js:gateChain`, `stockoutsOf` | settings `raiseMinSales`, `stockoutShare`; the bases in code |
| 7 | Every logged or answered policy price (`old`, `tracker`, `clear`) goes through the same gates; `old` is gated against itself, so only the floors, the no-claim ceiling and the sold floor move it (M2, N3) | `model.js:placeGroup` (`pol`), `model/price.js:gatePolicy` | code |
| 8 | A test unit is offered when a cut-back raise is worth ≥ 15 % more than holding (`TEST_VALUE_GAIN` 1.15), one step above the ask | `model/price.js` | code |
| 9 | The cool-down blocks only a **different** non-hold move inside `cooldownH` (72 h); the same move may repeat | `model/price.js:liveAction` | setting `cooldownH`; the rule in code |
| 10 | A live row priced above the curve's top node holds, with no brain price, unless it is stale at the top node's hazard (N11); nothing the brain advises lands above the evidence (H4) | `model/price.js:liveAction` (`above`), `model/hazard.js:evidenced` | code |
| 11 | Stale = age over `staleFactor` (3) × the expected days to a sale at the ask, only where the curve is evidenced and only when the gated price agrees with the ask; on multi-unit markets the age runs from the last sale (H2); one rung down inside every gate; a stale GGSel row holds (M1) | `model/price.js:liveAction` | setting `staleFactor`; the rest in code |
| 12 | Money is USD everywhere; GGSel's raise-only rule is judged in USD (its rouble price is made at publish) | the whole model | code |

**The model**

| # | Decision | Where it lives | How to change it |
|---|---|---|---|
| 13 | Gameflip is fitted **per offer** at its lowest live ask; a row's chance is the offer selling past its rank (H3), corrected per queue class from the offer timelines (N2) | `model/hazard.js:sweepOffer`, `queueP`, `QUEUE_CLASSES` | code |
| 14 | The scoring baseline is per **row** on single-unit markets (sales ÷ row-days), logged with each forecast (`pb`) (N1, H8) | `model/hazard.js:baseP`, `model/price.js:rowChance` | code |
| 15 | Thin price buckets have no hazard at all; the curve runs through the evidenced buckets' mean x; no price above the top one is a candidate (H4, H13) | `model/hazard.js:shrink`, `nodesOf`, `evidenced` | settings `minSales`, `minBucketDays`; the rule in code |
| 16 | The two farms are fitted and priced apart: every reference price reads one farm's orders (H5); the shrinkage uses one `shrinkK` for both | `model/evidence.js` (indexes), `model/ref.js` | setting `shrinkK`; the split in code |
| 17 | Fewer than 3 orders is no estimate anywhere, translated references included (C10) | `model/ref.js:MIN_ORDERS` | code |
| 18 | A translated, rival or market-wide reference is capped at the p75 of **this game's** orders here, else 1.5 × its source median (H11) | `model/ref.js:compute` | code (`SOURCE_CAP_MULT`) |
| 19 | On quantity and order-unit markets the fit counts **orders**, not units (H12) | `model/evidence.js:exposureOf` | code |
| 20 | A row's horizon is cut by its remaining life: Gameflip 30 days from creation, an unsold Eldorado offer 21 when no keep-alive could renew it (H9, EKA; §7 item 1) | `model/evidence.js:daysLeftOf`, `activeAt` | code (`GAMEFLIP_EXPIRY_DAYS`, `ELDORADO_OFFER_LIFE_DAYS`) |
| 21 | Regime precedence: perishing → cover over → cover under → ended campaign with the rivals gone (claim) → skip → fading; "rivals gone" = at most `rivalsGoneMax` (1) live rival sellers now (no history exists) | `model/price.js:gameState` | settings `rivalsGoneMax`, `scarceCover`, `overstockCover`, `fadeRatio`; the order in code |
| 22 | **Perishing** = at least 50 % of a no-claim game's listed units expire within `perishHours` (48) | `model/price.js:gameState` (the 0.5) | setting `perishHours`; the 50 % in code |
| 23 | The claim window is learnt as the median of `expiredAt − wave end` over expired units (the game's, else all games', else 0); a unit past its estimate reads "unknown", never 0 | `model/evidence.js` step 8, `model/price.js:perishOf` | code |
| 24 | A farm-brain row missing its forecast or stock is `unknown`, never 0 (M10a); a no-claim bucket with no sale in 30 days is not split equally over its games — they read `unknown` (M10b) | `model/price.js:gameState`; `inputs.js:demandRowsSteps` | code |
| 25 | The backtest's demand is our own 45-day average, with no stock: a replayed regime never comes from cover (H7) | `model/evidence.js:synthesiseDemand` | code |
| 26 | A thin no-claim offer starts from today's `bundlePrice` answer (the brief's rule); a thin claim offer gets no price | `model/price.js:priceOffer` | code |

**Placement**

| # | Decision | Where it lives | How to change it |
|---|---|---|---|
| 27 | `minMarginalUsd` $0.10 is kept as a tunable: on the claim farm a unit worth less stays in reserve | setting `minMarginalUsd` | setting |
| 28 | The no-claim fill has **no value floor** (`minMarginal` 0): any chance of a sale beats a certain expiry | `model/place.js:placeGame` | code |
| 29 | The no-claim free pool is one more "market" in the fill, selling only through an outlet (a live claim-at-sale offer, bulk, hand sales); with none, its units go on the shelves with demand, up to the cap, never on a market the game never sold on (M9, N6) | `model/place.js:placeGame`, `poolOutlet`, `poolPriceOf` | code |
| 30 | The brain's no-claim shelf is not held to the cap in force; it is logged beside it (only the no-outlet leftover stops at the cap) | `model/place.js:placeGame` | code |
| 31 | Bulk's expected take over the horizon is set aside first, but single shelves keep at least `reserveSingles` (C19a); the single-shelf forecast is the farm brain's minus bulk and hand sales (H6) | `model/place.js:placeGame` | the owner's `getBulkPacks().reserveSingles`; the rest in code |
| 32 | With no sale of ours on any open market, the forecast is split by where the radar sees rivals sell (`radar-split`), else nothing is placed on evidence (`unproven`); never an equal split (M12) | `model/place.js:placeGame` | code |
| 33 | Exploration: at most one unit, on one open market with no sale of the game, rivals-selling markets first; never ZeusX (`unmeasured`) or an unproven mapping | `model/place.js:placeGame` | setting `explore` |
| 34 | Placement is scored by each policy's weekly **demand split** on in-stock cell-weeks (≥ 6 of 7 days), not by its shelf: the sales came from the shelf really listed (H1) | `model/score.js:scorePlacementSteps`, `IN_STOCK_DAYS` | code |
| 35 | Today's flat shelf restates rule 4: `dealShares` of `computeSplit(stock on hand)`, then the `perMarketStock` top-up on Gameflip, Plati, GGSel (C12); stock on hand is the farm brain's, not the task's assigned accounts (L14) | `inputs.js:oldSide`, `refillShelf` | code |
| 36 | G2G is treated as not refillable (it gets a new offer per sweep, no shelf is held there) | `model/util.js:REFILLABLE` | code |

**Runtime, log, privacy**

| # | Decision | Where it lives | How to change it |
|---|---|---|---|
| 37 | Log retention: runs 21 days; the first run of each UTC day's rows 21 days; every other run's rows **3 days** (P20-12) | `index.js:ROW_KEEP_DAYS_DAILY`, `ROW_KEEP_DAYS_OTHER`; `models/ListingBrainRun.js:TTL_DAYS` | code: `ROW_KEEP_DAYS_*` only set each row's `exp`; changing `TTL_DAYS` changes a TTL index, which Mongo must be told (`collMod`, or drop and rebuild) |
| 38 | Log rows are written **sparse**: no reasons, nulls, `false`s, empty lists or zero action counts; every other 0 kept | `index.js:compact`, `expand` | code |
| 39 | Per-listing forecasts only on the first run of each UTC day, capped at `fcCap` 5,000 | `index.js:runOnce`, `firstOfDay` | setting `fcCap` |
| 40 | Rows go in before the run document: a failed insert leaves no run, never a half-sampled day (P20-13) | `index.js:runOnce` | code |
| 41 | The tracker's `suggestForNew` is asked only for each priced cell's main offer, **at most 400 a run** (live first) | `inputs.js:MAX_TRACKER_OFFERS`, `trackerOffers` | code (`load({ trackerCap })`) |
| 42 | Other read and work caps: 20,000 listings, 2 × 50,000 no-claim units, 5,000 campaigns and manifests, 2,000 research rows, 5,000 farm-brain rows, 400 claim games and 6,000 offers on the old side, 4,000 cells and 6,000 logged rows a run | `inputs.js` (`*_CAP`, `MAX_*`), `model.js:MAX_CELLS`, `index.js:MAX_ROWS_PER_RUN` | code |
| 43 | A load fails — nothing logged — when the settings, the tracker report, the listing read or the unit reads are unreadable; everything else degrades with a note | `inputs.js:load` | code |
| 44 | The evidence snapshot is warmed once; if it fails, every GGSel and event-bundle old price is null, never a guess (P20-6) | `inputs.js:oldSide` | code |
| 45 | The three answers abstain on a run older than `max(2 × intervalMin, maxDemandAgeH)`; an invalid base gets `price: 0` (M7, M8); a no-claim offer on a claim-at-sale market and an owner-set no-claim cap get no advice (M5, M6) | `model.js:staleRun`, `priceForRun`, `shelfForRun` | settings `intervalMin`, `maxDemandAgeH`; the rest in code |
| 46 | The Accuracy view reads nothing while the brain is off and has never run (C5) | `index.js:computeAccuracy` | code |
| 47 | The privacy scan blocks credential-**shaped** values (`token=…`, `Bearer …`), emails, links, IP addresses and 24-hex ids — not bare words, so a game called "Secret …" exports | `inputs.js:VALUE_RES`, `privacyScan` | code |
| 48 | The export writes outside the repository (the OS temp dir by default) and refuses a path inside it or an existing file; a `.gitignore` line `listing-brain-bundle-*.json` is proposed, not added | `scripts/listing-brain-export.js:insideRepo`, `exportBundle` | code; add the `.gitignore` line |
| 49 | Listing ids and order keys are an unsalted sha1, 12 hex (P6) | `inputs.js:hashId` | code (an HMAC with a server secret if bundles travel) |
| 50 | Defaults the brief did not fix: `fitDaysClaim` 90 / `fitDaysNoclaim` 30, `horizonDaysNoclaim` 2, `shrinkK` 30, `minBucketDays` 60, `tierEdges` [1, 5], `minP7Scarce` 0.5, `perishHours` 48, `rivalsGoneMax` 1, `shareShrinkDays` 14, `nonRefillHorizonDays` 28, `maxDemandAgeH` 6 | `model/util.js:DEFAULTS` | settings |

## 13. Commits

`git log --oneline 66178bc..HEAD` (newest first), before the commit that adds this documentation pass:

```
2563c49 fix(listing-brain): honest Gameflip baseline, calibrated queue chances, no advice above the evidence
05355ea fix(listing-brain): ask the tracker for exactly the offers the model reads; no locale-dependent order
fb86f53 docs(listing-brain): handoff skeleton — files, shared-file lines, deploy, old-side calls, realDeps modules
8e26047 feat(listing-brain): the tab shows the second round — demand-split placement scores, today's rule 3, packs, ladders left alone
4e55a0e docs(listing-brain): plan §6/§7/§10 with the measured log size, write order, retention, Node 20 timings and limits
c5f8c2f fix(listing-brain): second review round — owner's rules on every path, sounder curve and scores, no long stretch on Node 20
845af7a perf(listing-brain): loader under 200 ms per synchronous stretch on Node 20; event bundles, waves and today's shelf
5041eb0 fix(listing-brain): loader misreads of the no-claim ledger; privacy of the bundle, log and API
bc83396 test(listing-brain): one test per rule, the safety scan, speed and log size; the no-claim limits
1f2db65 perf(listing-brain): sparse log rows, intraday rows kept 7 days — under the 60 MB log target
89426aa feat(listing-brain): the scorer and the offline backtest
c18efa3 fix(listing-brain): declare pol and pf on ListingBrainRow
beb3290 fix(listing-brain): no-claim expiry read per unit, a pool for perishable stock, containment within one event
e75cec0 test(listing-brain): seeded synthetic fixture with planted truths
7ca7be6 feat(listing-brain): the pure model and the test-mode runner
605a9aa feat(listing-brain): the loader (bounded, read-only) and the reviewed-before-run export script
1d9fc2f feat(listing-brain): read-only API routes, the 'Listing brain (test)' tab and an offline preview
9c9b54a docs(listing-brain): contract for the listing brain (test mode) + its two log models
```
