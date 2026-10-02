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

- **Model v2 built 2026-10-03, NOT deployed yet** (`docs/LIVE-FIXES-1003.md` §A8, worktree `live-fixes-1003`).
  Changes `utils/demandBrain/{model,inputs,index}.js` and three labels on the page: the intermittent-demand
  estimators `sba` and `tsb` (§2.2), the no-claim feeder's burst-guarded rule `v2g` (§2.2, §2.5), cold probes for
  new drops (§2.4), one admission rule for both scorers (§3), the heartbeat's `cold probes N (old asks M)` clause
  and the health hook `loopStatus()` (§4). No model, route or setting changes; two new reads (§4). Defaults
  unchanged (`avg45` / `v2`): the test week decides. Needs `utils/farmDemand.js` from the same release (§A4:
  `demandRates`/`unclaimedDemandSnapshot` take `burstGuard`, units carry `pack`) — against an older farmDemand,
  `v2g` silently equals `v2` and packs are not flagged.
- Independent review of v2 (2026-10-03), all fixed the same day, each with a test that fails before it (§10):
  SBA rose with silence; the backtest hid sba/tsb false alarms; listings stopped cold probes (an engine probe
  listed 2 days ago read as a skip); v2 and v2g came from different evidence; the cold size ignored the engine's
  floor; the probe-history read had no cap note; a misleading `v2g` label; the feeder's guard could raise a rate.
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

## 2. What the brain computes (model v2; v1 until 2026-10-03)

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
| `v2` | shelf (gameflip/ggsel/digiseller) max30_14 + other markets' in-stock rate by selling days (`farmSizing.inStockRate`), each max(30, 14) | exactly `farmDemand.demandRates(units, {burstGuard: false})` (used directly when present; the copy is checked identical on real evidence) |
| `v2g` (v2) | "no-claim feeder rule, hand/pack sales at raw rate": `v2` with the feeder's burst guard on. Burst sales (a hand sale, market `manual`, or a bulk-pack unit, `pack: true`) count raw in each window; the rest keep the in-stock correction over the selling days of ALL other-market sales; each window is clamped to its unguarded figure: other = max(min(plain30, inStock30(rest, all days) + n30(burst)×7/30), min(plain14, inStock14(rest, all days) + n14(burst)×7/14)) | exactly `farmDemand.demandRates(units, {burstGuard: true})` (§A4, dark): it can only lower a rate. A one-day lump of 40 reads 20/wk, not 40; nothing is de-duplicated |
| `listed` | max(n(30)×7/max(L30, 15), n(14)×7/max(L14, 7)), L = days the game had a live listing | stock-out correction from listing history, capped at 2× |
| `sba` (v2) | Croston with the Syntetos–Boylan correction on the weekly counts y₁…y₁₃ (last 13 weeks, oldest first): SES (α = 0.15) of each selling week's size z and of the weeks between selling weeks p, updated only in selling weeks; with two or more selling weeks it starts from the first size and the first GAP between selling weeks, with one it reads one sale in the whole window (p = 13) — the window's first week is never an interval's start; forecast (1 − α/2)·z/p | never decays while a game is silent (Croston's blind spot); sliding the window changes it only when a sale enters or leaves |
| `tsb` (v2) | Teunter–Syntetos–Babai on the same weekly counts: the chance a week sells π is smoothed every week (β = 0.15), the selling-week size z only in selling weeks (α = 0.15); started from the window's own averages (share of weeks that sold, average selling week); forecast π·z | fades a game that stopped selling |

Defaults: claim farm **`avg45`**, no-claim **`v2`**. Switchable live (`estimatorClaim`, `estimatorNoclaim`) to any id above.
- **Model v2 (2026-10-03)** added `sba`, `tsb` and `v2g`; the defaults did not move — the test week decides. All
  three are logged on every row (`est`), backtested and forward-scored like the others. The weekly series is 13
  weeks (91 days) at every forecast moment, live or replayed: the longest that fits inside the 135-day evidence
  under the oldest backtest week (6 × 7 + 91 = 133). `v2` and `v2g` always pass `burstGuard` explicitly, so the
  owner's switch (`autoFarm.noclaimBurstGuard`) never changes what an estimator means and the feeder never reads
  its settings for a default (the backtest calls it once per game-week). The brain's fallback copy of the feeder's
  rule is held equal to production's `demandRates` on 400 random histories (hand sales, packs, guard on and off),
  and guarded ≤ unguarded is checked on 2,000 more, against both.
- Forward scores of `sba`, `tsb` and `v2g` start with the first v2 run: v1 rows do not carry them, so until the
  last v1 sample leaves the 21-day log they are shown as "not enough history yet" and never ranked (§3).
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
new drop  (v2) = forecast 0 + a live campaign + NO OWN SALE in 135 d (listings and rated markets do not count)
probe (cold, v2): a new drop, not dud-like → target = coldProbeSize (6), basis "cold", shown as "new drop: small test batch"
skip (dud, v2)  : a new drop listed longer than probeMaxDays (30) and never sold     → row flag br.dud "listed"
                  or, while the engine's probeColdStart is on, a probe of this game ended with 0 sales
                  inside its re-probe cooldown (probeCooldownDays, 90)            → row flag br.dud "probe"
unknown  : forecast 0, no live campaign, and no sale, listing or rated market in 135 d (v1); or a new drop
           whose probe history was unreadable while probeColdStart is on; or coldProbeSize 0 (v1's answer)
skip     : forecast < minRate, or value known and forecast × value < minWeeklyUsd; or forecast 0 with a sale of
           ours in 135 d (the estimator says 0 now); or, with no live campaign, a listing or a rated market (v1)
probe    : basis market and own = 0  → target = min(af.probeSize, cover(forecast))
farm     : target = max(cover(forecast), shelf floor), ≤ maxPerGame, then ≤ the owner's per-game cap
           (settings gameAccountCaps) when one is set; cover = ceil(forecast × coverageDays/7) + safetyStock
```
`cover` is `farmSizing.coverageTarget` with the live `getFarmSizing` policy (28 days, 6 safety, 250 max).
The shelf floor is the engine's own `marketStockFloor(af)` (18 on 2026-10-02; 12 once `docs/LIVE-FIXES-1003.md`
§A3 counts only the open markets): the brain replaces the DEMAND estimate, not the listing policy, so both sides
keep it and are compared on demand alone. The row keeps `td`, the demand-only target, so the floor's share is visible.

**New drops (cold start, model v2).** In v1 a live campaign with no evidence of ours was `unknown` — the brain
abstained — while the engine probes 15 accounts; of the engine's 20 finished probes, 17 ended with 0 sales. v2
gives such a game a small **cold probe**, shown on the page as "new drop: small test batch". Eligible: a live
campaign and **no sale of ours in 135 days** — listings do not disqualify (the engine's own probe, listed 2 days
ago and unsold, is exactly a new drop; the review found v1's evidence rule turned it into a brain-skip), and
neither does a rated rival market below proof. The size is `coldProbeSize`, by default **half the engine's own
shelf floor** (`marketStockFloor` = open shelf markets × `perMarketStock` × 2, which already knows the Plati and
GGSel switches and keys: 12 → 6 with Plati blocked) — enough for each market that takes stock to hold its share,
the floor without its post-event doubling; an unreadable floor (0) means no cold probes. Two exceptions skip:
**dud-like** — listed longer than the engine's probe window (`probeMaxDays`, 30) and never sold, what its
stop-loss calls a failed probe whether or not one was stamped; and, only while the engine's `probeColdStart` is
on (its probe gate ignores the cooldown otherwise), a **known dud** — a probe of this game the engine stamped
`probeOutcome: "expired"` (0 sales) and completed inside `probeCooldownDays`. Rival proof still upgrades a game to
the existing market-led probe (at least 7 at today's settings), even over a dud (the reasons say so). The
per-game cap and `maxPerGame` bound a cold probe; the shelf floor never applies to a probe. The dud check reads
the engine's own predicate (`decide.probeGate`'s first query) once for all live games' campaign labels (§4); if
that read fails while `probeColdStart` is on, the brain abstains (`unknown`) rather than probe a game it could not
check. A game that sold in 135 days but forecasts 0 now is not a new drop: the claim estimator's 0 decides (skip).
Cold probes are compared with today's verdict like any other (a cold 6 against today's probe 15 is `brain-less`;
against a probe held by the budget, `brain-farm`), and counted apart: summary `coldProbes`, `coldTarget`,
`oldTargetCold`, `coldDuds`; heartbeat `cold probes N (old asks M)`.

### 2.5 No-claim verdict (per bucket)
`farmSizing.shelfAwareTarget` with the bucket's live policy (`row.policy`), shelf held = listed. With the
feeder's live rule the rates are the snapshot row's own (`sales.shelfPerWeek` / `sales.otherPerWeek`): the
brain's evidence read looks back further than the feeder's, so re-deriving them could date a sale differently
and drift (review finding M3). Model v2 asks the feeder for its snapshot twice per run, on the same evidence and
window, once per burst-guard setting (`unclaimedDemandSnapshot({days: 30, burstGuard})`): the live rule — `v2`
while `autoFarm.noclaimBurstGuard` is off (today), `v2g` once the owner turns it on — is the row's "today" and is
mirrored under its own name; the other is the same snapshot with the guard flipped, so `v2g − v2` is the guard
alone (the review found v2g re-derived from the brain's longer read differed from v2 with nothing to guard). If
the other snapshot fails (the guarded one withholds itself when the bulk-pack lookup fails), that rule logs null
for the run, with a note. Every other estimator runs on the feeder's evidence (each unit dated by its first
evidence, with the feeder's `pack` flag carried on the entry so a replayed `v2g` sees bulk packs); when that
evidence is unreadable the row is a `mirror` (its own class, never counted as agreement).
Market context for the shelf markets is advisory. Buckets match by the LONGEST keyword, `farmDemand.bucketFor`'s rule.

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
- **One admission rule for both** (model v2, review 2026-10-03): a game-week is scored when it sold, or when ANY
  estimator forecast a sale for it, and every estimator is scored on every admitted row (a missing forecast — a
  null, or `engine` on an errored verdict — counts as 0), so all are compared on the same rows. The v1 backtest
  admitted a week only when the game had sold in the 45 days before it (avg45's horizon), which hid every sba/tsb
  false alarm 46–91 days after a game's last sale (a dead game's sba scored on 4 of its 6 weeks; now 6). An
  estimator a logged row does not carry at all (a v1 row has no sba/tsb/v2g) is marked "not enough history yet"
  (`partial`) and is never ranked: `best` and the page's "✓ best" compare only estimators scored on every row.
- **Decision review:** last week's disagreements on live campaigns with what happened next (our sales;
  rivals' units, or "—" when the radar does not watch the game).
- What shadow mode CANNOT test: whether farming more of a "market" game would have sold. That needs a
  small deliberate trial; the log marks every market-based call as untested.

## 4. Safety contract
- Reads only: the price-tracker report (cached, shared with the page), one grouped `SaleSignal`
  aggregation (connection flips, 135 days, bounded, no allowDiskUse), the radar report (cached),
  `TwitchCampaign` (one projected find), the engine's `probeGate` / `researchForGame` /
  `internalSalesForGame` (DB reads; never `freshResearchForGame`, which re-scans a marketplace),
  `marketStockFloor` / `demandAllocation` (pure), `farmDemand` evidence (DB reads), its snapshot (DB reads) —
  twice per run in model v2, once per burst-guard setting (`burstGuard` passed explicitly, so the feeder never
  reads its settings for it) — and its pure `demandRates` (same), and (model v2) one `AutoFarmTask` find for the
  cold-start rule, only while the engine's `probeColdStart` is on — `{game: {$in: live campaign labels},
  probeOutcome: "expired", completedAt ≥ now − probeCooldownDays}`, projected to `{game, completedAt}`, limit
  5,000 (a run that hits it says so in its notes), on the indexed `game` field, skipped when no game is live. No
  SSH, no host read, no marketplace call, no settings write. Every
  module it loads was scanned on production for load-time side effects (timers, connects, listeners): none in
  139 + 134 modules (`models/AutoFarmTask`, new to the loader in v2, is a plain schema with no hooks that
  `utils/autoFarmer.js`, already loaded by the brain, requires at load — no new module enters the process).
- A failed bulk-pack lookup in the feeder's evidence (`packError`) makes that evidence unreadable for the run (a
  note; no-claim rows fall back to the snapshot or `mirror`): packs read as ordinary sales would inflate `v2g`. The
  feeder withholds its own guarded snapshot on the same error.
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
  caught and logged. A run whose inputs fail writes nothing; if the rows insert fails after the run document
  was written, the heartbeat says NOT LOGGED and only the brain's own collections hold the partial record. A
  failed no-claim read only drops the no-claim rows.
- Engine calls run 3 games at a time with yields; the report builds yield to the event loop. Measured on
  the production box: inputs 4.1 s cold (0.9 s with warm caches), model 32 ms, scoring 45 ms.
- Heartbeat: one log line per run (`demandBrain: run N (model v2, avg45) — … | cold probes N (old asks M) | … | Ns`),
  and one at boot when off.
- Health hook (model v2, `docs/LIVE-FIXES-1003.md` §3): `loopStatus()` → `{ lastRunAt, intervalMin, enabled,
  since }`, synchronous, never throws. `lastRunAt` moves only when a run computed (a failed or timed-out load
  leaves it, so a stuck brain shows as late); `enabled` is the live switch (unreadable settings read as off);
  `since` is when the loop last began waiting to run — `start()`, or its latest tick that found the switch off —
  and null when not started. A brain switched on hours after boot is due one tick (≤ 10 min) after `since`, not
  since the process started; a dead scheduler's `since` stops moving, so it still ages into "late".

## 5. Settings (`autoFarm.demandBrain`, all optional)
`enabled` false · `intervalMin` 60 · `estimatorClaim` "avg45" · `estimatorNoclaim` "v2" ·
`captureShare` 0.2 · `minMarketRate` 1 · `minMarketUnits` 3 · `minRate` 0.25 · `minWeeklyUsd` 0.25 (accounts
are not the scarce input — the auto-farm is demand-bound — so this only screens out near-worthless accounts;
$1 skipped proven small sellers such as NBA 2K27 at 0.7 a week in the preview) · `coldProbeSize` (v2; 0–250,
0 = no cold probes; unset = half the engine's `marketStockFloor`, 6 once §A3 counts only open markets).
Read, never written, from the auto-farm's own settings: `probeSize`, `maxPerGame`, `probeColdStart` (whether the
known-dud cooldown applies, as in the engine's probe gate), `probeMaxDays` (the dud-like listing window, default
30, as its stop-loss reads it), `probeCooldownDays` (the dud window) and `noclaimBurstGuard` (which rule the
feeder's live snapshot is); the shelf floor through the engine's own `marketStockFloor(af)`. The run document logs
the cold-probe size it used, `probeColdStart`, `probeMaxDays`, `probeCooldownDays` and `noclaimBurstGuard` with
the rest of its settings.

## 6. API + page
`/api/price-tracker/brain/{status, latest, game/:key, accuracy}` — superadmin + 2FA, read-only, every
route through the guarded helper. Page: Price tracker → "Farm brain (test)" (Overview, Games, Accuracy).
Model v2 changes no route, and only labels on the page: `sba` "irregular-sales forecast (SBA)", `tsb`
"irregular-sales forecast, fades dying games (TSB)", `v2g` "no-claim feeder rule, hand/pack sales at raw rate"
(nothing is de-duplicated — an earlier label said "bulk sales counted once"); a cold probe reads "probe 6" with
basis "new drop: small test batch"; an estimator without full history reads "not enough history yet" and never
gets "✓ best". The overview's account totals now include cold probes (they are verdicts), so "brain: no
evidence" only counts games the brain could not check.

## 7. Verification
- Unit tests: model 33, loader 18, runner 12 (incl. a real in-memory Mongo for the indexes and log
  queries), routes 7 — 70. Full repository suite: 2,251/2,251 locally.
- Model v2 (2026-10-03): `tests/demandBrainV2.test.js` 20 (SBA and TSB checked by hand on known series, the
  fallback `v2`/`v2g` copy equal to the feeder's own `demandRates` on 400 random histories, hand-sale and
  bulk-pack bursts, the cold-probe rules, the summary and heartbeat, `loopStatus`) and 8 more loader tests (the
  probe-history read, every raw label, end-to-end cold probe and dud, unreadable history, the burst-guard switch,
  the `pack` flag, a failed pack lookup) — 98 brain tests. One v1 expectation changed: `v2`'s call now pins
  `burstGuard: false`. 27 of the 28 new tests fail on the v1 bytes (the 28th checks that no read happens when no
  game is live).
- Review fixes (2026-10-03): `tests/demandBrainV2.test.js` 33 and the loader file 31 — 115 brain tests. Every
  test named "review N" fails on the bytes before that fix; the reviewer's proof scripts were re-run after it
  (sba 0.43 → 5.55 over 12 silent weeks is now 0.43 flat; the dead game's sba is scored on 6 of 6 weeks; the
  in-flight probe is a cold 6; v2g − v2 is 0 with nothing to guard; the guard's case A reads 15.6 → 15.4, not 23.5).
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

## 10. Model v2 decisions (2026-10-03, `docs/LIVE-FIXES-1003.md` §A8)
- **SBA / TSB starting values.** Croston/SBA starts from the first size and the first GAP between two selling weeks;
  one selling week in the window is one sale in 13 weeks. The window's first week is never an interval's start:
  the "naive" start (first interval counted from the series start, R tsintermittent's `crost`) is right for a fixed
  series but wrong on a sliding window, where that interval shrinks every week a lone old sale sits in it and the
  forecast grew with silence (review, 2026-10-03: 0.43 → 5.55 a week over 12 silent weeks). So sba no longer
  matches `crost(init="naive")` on purpose; tsb still matches `tsb(init="mean")`. TSB starts from the window's
  averages, because a first-week start puts the chance at exactly 0 or 1. α = β = 0.15 as the contract set. Both
  forecast a weekly rate directly (the period is a week).
- **13-week window, fixed.** Same length live and in every replayed week, so the backtest scores the estimator the
  live run uses; longer would reach past the evidence under the oldest backtest week.
- **`v2` / `v2g` pinned.** `v2` is the unguarded rule and `v2g` the guarded one whatever the owner's switch says;
  both are the feeder's own snapshots (§2.5), the live one logged under the name of the rule it ran.
- **One admission rule, same rows, no ranking without full history** (§3).
- **Cold probe scope.** Eligibility is "no sale of ours in 135 days" with a live campaign — listings and an unproven
  rival market do not disqualify; a listing older than the engine's probe window with no sale is dud-like; the
  engine's re-probe cooldown counts only while its `probeColdStart` is on; rival proof outranks the cooldown
  (market-led probe, with the failed probe named in the reasons). The size follows the engine's own floor (its
  market count knows the switches and the keys; the brain cannot call the marketplace module). Reuse-only, time
  left, the probe budget and capacity are execution gates the brain does not model (§4.2 of
  `docs/FARM-DISTRIBUTION-MAP.md`), so a cold probe is a demand verdict, not a spend.
- **Fail-safe direction.** An unreadable probe history abstains (`unknown`), never probes; an unreadable floor means
  no cold probes; an unreadable pack lookup withholds the no-claim evidence, and a guarded snapshot that withholds
  itself logs `v2g` as null — never an inflated `v2g`.
