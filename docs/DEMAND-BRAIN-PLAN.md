# Farm brain — one demand model for both farms (TEST MODE: log only)

Owner ask, 2026-10-02: "I want this new system to replace the account distribution of the
auto farm and the no-claim farm … for now it's logging data only: first we build it like a
test environment, then wait a week before implementing; inside that week we test how good
the new system is and adjust."

So this ships as a **test environment**. Every hour it works out, per game, how many accounts
each farm should farm, writes that down next to what each farm's own logic says **at the
same moment**, and scores both against what actually sells. It changes nothing: no farm
decision, no setting, no listing, no account. Wiring it into the farms is a separate step
after the week, decided on the evidence this produces.

## Status: LIVE in test mode since 2026-10-02 05:54:53Z (log only — no farm reads it)

- Deployed dark 05:53:34Z (commit b22b950; backup `_deploy_backup_20261002055257_farm-brain`): new
  `utils/demandBrain/{model,inputs,index}.js` ff349ac4 / 73b95694 / 7f64d980, `models/DemandBrainRun.js`
  78f3f9d8, `models/DemandBrainRow.js` 81374dcf; `routes/priceTrackerRoutes.js` 3318b47a → 9facf4c7,
  `public/price-tracker.html` 4ac6cdd5 → fb98e717. Load check: brain OFF, not started, engine functions
  present. After the restart: online, 0 unstable, every brain route 401 without a session, no errors.
- Switched on 05:54:53Z with `setAutoFarm({demandBrain:{enabled:true}})` (audited; settings backup
  `/root/_rehome_work/settings_before_demandBrain_20261002055452.json`). Nothing else in settings changed.
- First run 05:59:35Z, 3.5 s: 117 claim games (89 live), 3 no-claim buckets, 120 rows (~500 B each); live:
  2 agree, 40 both skip, 9 brain fewer, 18 brain skips, 20 brain has no evidence; live targets today 910 →
  brain 205 over 69 games. No-claim identical (250 / 158 / 10). Indexes: runs `at` TTL 21 d; rows
  `{k,f,at}`, `run`, `at` TTL 21 d. Memory 226 MB after boot → 383 MB after the first run (both reports
  cached), app limit none, host 2.2 GB free.
- Staging note: the harness blocked every write and index build but not `createCollection`, so it left
  the two collections behind, empty; harmless (the brain creates them on first use) and the harness now
  blocks collection creation too.
- Off switch (no restart): `node -e 'require("./utils/settings").setAutoFarm({demandBrain:{enabled:false}},{actor:"owner"})'`
  in `/var/www/redeemer/nodeserver`. Full rollback: restore the two changed files from the backup, remove
  the five new ones, `pm2 restart redeemer`; the collections expire by TTL or can be dropped.

## 1. What exists today (the "old" side, measured 2026-10-02)

| | Auto-farm (claim farm) | No-claim feeder |
|---|---|---|
| Games | every live campaign except no-claim games | Overwatch, Rainbow Six, Call of Duty (keyword buckets) |
| Runs | per campaign, farm2 lanes (`utils/farm2/steps/decide.js`) | hourly (`utils/unclaimedAllocator.js`) |
| Demand | probe gate → `autoFarmer.demandAllocation(research, af, internalSalesForGame(game), {probeAllowed, game})` = research `demandScore` (one snapshot of Gameflip/GGSel/Plati pages) + log-damped own sales → full / half / skip / probe | `farmDemand.unclaimedDemandSnapshot` = own sales from 5 sources incl. the ledger (every market), first-evidence dated, in-stock rate |
| Own sales | SaleSignal `connected` + `listing_sold` only: **no Eldorado / PlayerAuctions / G2G / ZeusX records** (0 in 30 days), mass-delist signals counted, login twins counted twice | every market, deduped by login |
| Size | cap = max(30 + 2×sales45 ≤ 60, coverage); asks `min(max(target, shelf floor 18), cap)`, probes their own target | `shelfAwareTarget` (shelf held + cover for other markets + safety) |
| 14 days | 194 low-demand skips over 62 games, 31 farm, 17 probe, 141 reuse | OW 647 farming / 250 target, R6 158/158, CoD parked |

## 2. What the brain computes (model v1)

### 2.1 Own sales, one counting rule for every game
- Claim-farm games: the price tracker's clean union (`utils/priceTracker/games.soldUnion`): every proven-sold
  account once (login-deduped), from delivered units (Eldorado/PA/G2G), marketplace signals and buyer
  connection flips; mass-delist / bulk mark-sold signals set aside. Built by the brain itself
  (`inputs.saleLogFrom`) from the report's sale ledger plus **135 days of connection flips grouped in the
  database** to one row per sold account (`inputs.connectedHistory`: ~25.6k raw rows → ~1.1k, 125 ms). The
  price tracker's own report keeps only 45 days of flips, and **61 % of our sold accounts in 135 days are
  proven only by a flip (88 % of those older than 45 days)**, so forecasting from the report alone would
  starve every window that reaches past 45 days (review finding H1). The price tracker's files are untouched.
- No-claim buckets: the feeder's own evidence (`farmDemand.saleEvidenceByBucket`, ledger-inclusive) —
  it already counts every market and the hand sales the price tracker cannot see.

### 2.2 Rate estimators (all logged, all scored — the week picks the winner)
Weekly rate from dated sales, `n(X)` = sales in the last X days:
| id | formula | note |
|---|---|---|
| `engine` | the auto-farm's own count over 45 days × 7/45 | what the old system believes (claim farm only, forward test only) |
| `avg45` | n(45)×7/45 | the engine's averaging, clean counting |
| `avg30` | n(30)×7/30 | |
| `max30_14` | max(n(30)×7/30, n(14)×7/14) | reacts to a rise in two weeks |
| `v2` | shelf (gameflip/ggsel/digiseller) max30_14 + other markets' in-stock rate by selling days (`farmSizing.inStockRate`), each max(30, 14) | exactly `farmDemand.demandRates` (used directly when present; the copy is checked identical on real evidence) |
| `listed` | max(n(30)×7/max(L30, 15), n(14)×7/max(L14, 7)), L = days the game had a live listing | stock-out correction from listing history, capped at 2× |

Defaults: claim farm **`avg45`**, no-claim **`v2`**. Switchable live (`estimatorClaim`, `estimatorNoclaim`).
- `avg45` was picked on production's own backtest (2026-10-02, 263 game-weeks, 135 days of evidence),
  ranked by RMSE: `avg45` 2.27 (bias +0.32), `avg30` 2.85 (+0.41), `max30_14` 3.59 (+0.76), `listed` 3.61
  (+0.82), `v2` 6.16 (+2.05). Same order on the 243 game-weeks the game was listed all week, so it is not a
  stock-out artefact: the in-stock correction over-forecasts sporadic sellers.
- No-claim keeps `v2` — with `v2` the brain uses the feeder's OWN snapshot rates, so its target equals the
  feeder's by construction. Its backtest truth is censored by frequent stock-outs (Eldorado offers covering
  0), which a score against realised sales cannot see through (`avg30` RMSE 29.9 vs `v2` 36.2, `v2` +6.2).

### 2.3 Market evidence (the radar, `utils/marketData`)
Per game, Gameflip + GGSel + Plati: rivals' units sold per week (only once a market was watched ≥ 2
days), live rival sellers, rivals' realised price. `ourWatched` = our own rate on those three markets.
`marketTotal = rivalsPerWeek + ourWatched`; `share = ourWatched / marketTotal`.
Market **proof** = rivals sell ≥ `minMarketRate` a week AND ≥ `minMarketUnits` units in the window.
`marketPotential = captureShare × marketTotal` (proof only). Eldorado / PA / G2G / ZeusX are not watched
(never touched from a side process), so the market term is blind there — said on every row.

### 2.4 Claim-farm verdict (per game)
```
own      = estimator(estimatorClaim)
forecast = max(own, marketPotential); basis = own | market | none
value    = our net per account (price tracker), else rivals' sold median × 0.85, else unknown
unknown  : no own sale in 135 d, never listed in 135 d, and no rated market      (brain abstains)
skip     : forecast < minRate, or value known and forecast × value < minWeeklyUsd
probe    : basis market and own = 0  → target = min(af.probeSize, cover(forecast))
farm     : target = max(cover(forecast), shelf floor), ≤ maxPerGame, then ≤ the owner's per-game cap
           (settings gameAccountCaps) when one is set; cover = ceil(forecast × coverageDays/7) + safetyStock
```
`cover` is `farmSizing.coverageTarget` with the live `getFarmSizing` policy (28 days, 6 safety, 250 max).
The shelf floor is the engine's own `marketStockFloor(af)` (18 today): the brain replaces the DEMAND
estimate, not the listing policy, so both sides keep it and are compared on demand alone. The row keeps
`td`, the demand-only target, so the floor's share is visible.

### 2.5 No-claim verdict (per bucket)
`farmSizing.shelfAwareTarget` with the bucket's live policy (`row.policy`), shelf held = listed. With `v2`
the rates are the snapshot row's own (`sales.shelfPerWeek` / `sales.otherPerWeek`): the brain's evidence
read looks back further than the feeder's, so re-deriving them could date a sale differently and drift
(review finding M3). Any other estimator runs on the feeder's evidence; when that evidence is unreadable
the row is a `mirror` (its own class, never counted as agreement). Market context for the shelf markets
is advisory. Buckets match by the LONGEST keyword, `farmDemand.bucketFor`'s rule.

### 2.6 Old vs brain, same moment
- Claim farm: for every game with a LIVE claimable campaign (the decisions being made now), every game we
  sold in 45 days and every game the radar rates, the brain calls the engine's own exported functions
  exactly as `decideCampaign` does — `decide.probeGate(label, af)` (probe budget and post-failure
  cooldown; on 2026-10-02 the budget was full and it held 109 of 117 games), `researchForGame`,
  `internalSalesForGame`, `demandAllocation(research, af, sales, {probeAllowed, game})` — never a copy, then
  sizes it as the decide step does: `min(max(target, floor), cap || maxPerGame)` for a farm, the target
  for a probe. Old class: skip / probe / farm(target), with the research age and whether a probe was held.
- No-claim: `farmDemand.unclaimedDemandSnapshot({days:30})` row target (DB-only; never `plan()`, which
  reads the Pi and overwrites the allocator's in-memory plan).
- Diff: `agree` (both act, |Δ| ≤ max(3, 20 % of old)), `agree-skip`, `brain-more`, `brain-less`,
  `brain-farm` (old skips, brain acts), `brain-skip` (old acts, brain skips), `brain-unknown`,
  `old-error`, `mirror` (no-claim, brain could not compute).
- Account totals compare like with like: live games where both sides have a verdict. A game the brain
  has no evidence for is counted apart (with the accounts today's logic asks for there), never as a 0.
- The farm's actual latest decision (AutoFarmTask) is shown beside it, for context only.

## 3. Scoring ("how good is it")
- Per estimator and farm: **RMSE** (picks the winner), average miss (MAE, easy to read) and bias. Not MAE
  for the pick: MAE is minimised by the median, which is 0 for a game selling under ~0.7 a week, so it
  rewards forecasting zero for every small seller (review finding M4).
- **Backtest, day one:** for each of the last 6 weeks, every estimator forecasts the next 7 days from the
  sales dated before that week; truth = sales actually dated inside it. Scored twice: every game-week, and
  only the claim-farm weeks the game was listed ≥ 6 of 7 days (realised sales are capped by stock-outs, so
  the estimators that see through stock-outs are bound to look high against empty weeks). Evidence first
  seen after a week can date a sale into it (small leakage, stated). The `engine` count reads raw signal
  rows as they were at decision time and cannot be replayed, so `avg45` stands in for its averaging.
- **Forward, from day 7:** the first logged run of each UTC day is scored once 7 days have passed:
  every estimator including `engine`, against the same truth (same in-stock split).
- **Decision review:** last week's disagreements on live campaigns with what happened next (our sales;
  rivals' units, or "—" when the radar does not watch the game).
- What shadow mode CANNOT test: whether farming more of a "market" game would have sold. That needs a
  small deliberate trial; the log marks every market-based call as untested.

## 4. Safety contract
- Reads only: the price-tracker report (cached, shared with the page), one grouped `SaleSignal`
  aggregation (connection flips, 135 days, bounded, no allowDiskUse), the radar report (cached),
  `TwitchCampaign` (one projected find), the engine's `probeGate` / `researchForGame` /
  `internalSalesForGame` (DB reads; never `freshResearchForGame`, which re-scans a marketplace),
  `marketStockFloor` / `demandAllocation` (pure), `farmDemand` snapshot + evidence (DB reads). No SSH, no
  host read, no marketplace call, no settings write. Every module it loads was scanned on production for
  load-time side effects (timers, connects, listeners): none in 139 + 134 modules.
- Writes only its own log: one `DemandBrainRun` document (settings, summary, notes) and one
  `insertMany` of its `DemandBrainRow` rows per run (~120 rows × ~455 B ≈ 53 KB; hourly ≈ 27 MB over the
  21-day TTL on both). A game's history is an indexed read of its rows (`{k, f, at}`), never of whole
  runs. Mongoose creates the two collections and their indexes on first use (even from the page while
  the brain is off).
- Starts from `routes/priceTrackerRoutes.real()` (called once at boot by server.js): server.js is not
  touched. Tests and the preview never call `real()`.
- Switch: `autoFarm.demandBrain.enabled` (default **false**; ships dark). Read every tick, no restart.
  Interval `intervalMin` (default 60, min 15). First tick 6 min after boot; while off, re-read every 10.
- One run at a time (module guard; redeemer is one fork-mode process). A load that outlives its 10-minute
  timeout blocks new runs until it settles, and every skipped tick says so in the log. Every failure is
  caught and logged; a failed run writes nothing; a failed no-claim read only drops the no-claim rows.
- Engine calls run 3 games at a time with yields; the report builds yield to the event loop. Measured on
  the production box: inputs 4.1 s cold (0.9 s with warm caches), model 32 ms, scoring 45 ms.
- Heartbeat: one log line per run (`demandBrain: run N (model v1, avg45) — … | Ns`), and one at boot when off.

## 5. Settings (`autoFarm.demandBrain`, all optional)
`enabled` false · `intervalMin` 60 · `estimatorClaim` "avg45" · `estimatorNoclaim` "v2" ·
`captureShare` 0.2 · `minMarketRate` 1 · `minMarketUnits` 3 · `minRate` 0.25 · `minWeeklyUsd` 0.25 (accounts
are not the scarce input — the auto-farm is demand-bound — so this only screens out near-worthless accounts;
$1 skipped proven small sellers such as NBA 2K27 at 0.7 a week in the preview).

## 6. API + page
`/api/price-tracker/brain/{status, latest, game/:key, accuracy}` — superadmin + 2FA, read-only, every
route through the guarded helper. Page: Price tracker → "Farm brain (test)" (Overview, Games, Accuracy).

## 7. Verification
- Unit tests: model 33, loader 18, runner 12 (incl. a real in-memory Mongo for the indexes and log
  queries), routes 7 — 70. Full repository suite: 2,251/2,251 locally.
- Mutation pass: 39 deliberate breakages (every review fix among them), 39 caught.
- Independent review (2026-10-02): 1 high, 4 medium, 12 low findings, all fixed or documented — see §9.
- Staged on the production box (real database, every write blocked, real settings): the only writes
  attempted were the brain's own (`insertOne demandbrainruns`, `insertMany demandbrainrows`); v2 copy
  identical to production's `demandRates` on real evidence (9/9); the API answers behind the real guards
  and refuses an anonymous caller; 164/164 Mongo-free tests pass on production's Node 20 and modules.
- Then: deploy dark, switch on, watch the first runs.

## 8. After the week (not in this build)
Pick the estimator per farm by score; decide whether market-based calls get a small real trial; then wire
the brain's target in place of `demandAllocation`'s (claim farm) and `unclaimedDemandSnapshot`'s (no-claim)
behind a switch, keeping every execution gate (reuse-only, fresh-account gate, capacity, shelf caps,
parked bots, duplicate logins, Plati block).

## 9. Review findings (2026-10-02) and what was done
- **H1** backtest windows past 45 days lacked the connection-only sales → the brain reads 135 days of flips
  (grouped) and builds its own sale log; the default was re-checked on the corrected evidence (`avg45` holds).
- **M2** "today" always allowed probing → `decide.probeGate` passed through.
- **M3** no-claim brain could drift from the feeder → `v2` uses the snapshot's own rates.
- **M4** MAE rewarded forecasting zero → ranked by RMSE.
- **M5** whole-run documents (~52–139 KB) and full-document history reads → per-game rows with an index.
- Low: the shelf floor and cap mirrored on "today" (and kept by the brain); research age logged; a no-claim
  failure no longer fails the run; rivals' units are null (not 0) for unwatched games; the overview reads
  no-claim rows separately; `mirror` class; the score cache is tagged by run so a run never gets
  overwritten by an older score; skipped ticks are logged; the scorer keeps only rivals' sale time/units
  from the radar feed; first-use index creation documented; longest-keyword buckets; production's
  `farmDemand.js` fingerprinted (119faace = the reviewed copy). Not changed: the accuracy view still runs
  one synchronous backtest (45 ms on production data).
