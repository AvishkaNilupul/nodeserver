# Making a farm lane verifiable

Status: **proposal.** Implemented and tested in the sandbox, verified against
nothing real. Section 7 lists what has to be confirmed on production before any
of it is trusted.

Companion to `docs/FARM2-PLAN.md` (the architecture) and
`docs/FARM2-TASK-comparison-evidence.md` (the task).

The series on this branch, in order:

1. **the replay harness** — the measurement (§1–§4)
2. **the six downstream gates** — the safety work (§5.2)
3. **probe-gate exactness** — the first prod run's finding (§7.4)
4. **row fields are not inputs** — the second prod run's finding (§5.1)
5. **recorded decision inputs** — replay stops reconstructing (§10)
6. **`hadResearch` truthful on the sellability skip** — one token, own commit (§5.1)
7. **`internalSales` written on the two paths that omitted it** — own commit (§5.1)

Commits 6 and 7 change behaviour inside `utils/autoFarmer.js` and are separate so
each can be deployed or held on its own.

---

## 1. Why the current comparison cannot work

`diffAgainstLegacy()` asks:

> does the lane's decision **today** match the legacy engine's decision from
> **whenever it last decided**?

Two things differ between those two observations: the **engine** and the
**world**. When the answers differ, nothing in the record says which one caused
it. That is not a tuning problem, it is the experiment being malformed — and it
explains the trial result exactly. All ten "disagreements" turned out to be both
engines being right about different moments, because the legacy engine had
decided 41–229 hours earlier and never revisits a campaign it has acted on.

The 6-hour `COMPARABLE_WINDOW_MS` gate was the right diagnosis and the wrong
cure. Age is a **proxy** for "the world has not moved", and it is wrong in both
directions:

- it **discards** a decision made 200 hours ago on a game where nothing has
  changed since — still perfectly comparable;
- it **accepts** a decision made 20 minutes ago on a game that was rescanned in
  between — not comparable at all.

Applied to prod it left **0 comparable pairs out of 300**, which is the honest
consequence of a proxy that mostly measures how often the legacy engine happens
to re-decide things. Tightening or loosening the window cannot fix it. Loosening
readmits the ten false disagreements; tightening keeps the zero.

**The fix is to stop holding the world still by proxy and hold it still
directly.**

## 2. What I propose: replay

Reconstruct the inputs the legacy engine had **at the moment it decided**, run
the lane's economics against those, and compare. The world is then fixed by
construction and the only remaining variable is the engine.

This also inverts the sample-size problem. Shadow comparison waits for fresh
pairs to accumulate — days per lane, 34 lanes. Replay treats **every decision
the legacy engine has already made** as a test case, available immediately,
offline, with no engine running.

```
utils/farm2/replay.js               the harness
utils/farm2/decisionClasses.js      the shared decision vocabulary
utils/farm2/steps/decide.js         the six gates (commit 2)
utils/decisionInputs.js             the recorded snapshot — one shape for both engines and replay (§10)
scripts/farm2-replay.js             operator CLI (read-only)
tests/farm2Replay.test.js           37 tests
tests/farm2Gates.test.js            21 tests
tests/farm2DecisionInputs.test.js   19 tests
```

### The key enabler

`models/MarketResearchSnapshot.js` already exists and already keeps what is
needed: one row per game per scan, carrying `demandScore`, `sellers` and `at`,
retained 120 days. `MarketResearch` itself is overwritten in place and keeps no
history, which is why this looked unreconstructable — but the snapshot
collection was added for trend analysis and happens to be exactly the historical
research record replay needs.

`models/SaleSignal.js` is append-only and timestamped, so whether the 45-day
sales window's *contents* changed between then and now is two existence queries.

### No second source of truth

Every number comes from `autoFarmer`'s own exports — `demandAllocation`,
`salesOf`, `capForGame`, `marketStockFloor`. The harness reconstructs **inputs**
and compares **outputs**. It does not re-derive a single tier, boost, cap or
threshold, so it cannot drift from the engine it is measuring.

That discipline costs one thing, at `salesInputsFor()`: reconstructing a past
`avgPrice` would mean copying the SaleSignal aggregation out of
`internalSalesForGame` (the per-source grouping that fixes the phantom-demand
bug). Rather than copy it, the harness detects whether it is safe to reuse the
live value and **gives up honestly when it is not**. See §4.

## 3. What replay can and cannot see

Reconstructable for a past moment T:

| Input | Source | Notes |
|---|---|---|
| `research.demandScore` | `MarketResearchSnapshot` | newest row with `at <= T` |
| `research.sellers` | `MarketResearchSnapshot` | only read on the cold-start probe branch |
| `research.scannedAt` | the snapshot's own `at` | that IS the scan moment |
| `internalSales` | `SaleSignal` | see §4 — drift-detectable, sometimes exactly recoverable |

**Not** reconstructable, and this bounds everything:

| Input | Why |
|---|---|
| `af` settings | `utils/settings.js` is not versioned |
| pool depth | `countReadyPool` is a live count |
| container capacity | live host query |
| host reachability | live SSH probe |
| archive coverage | `archiveHoldersForCampaign` reads current inventory |

Those four settle every decision **downstream** of the sellability gate. So
replay is deliberately scoped to the demand stage, and reports downstream
decisions as out of scope rather than pretending to score them. Measuring the
reconstruction's blind spots and calling it engine disagreement is precisely the
mistake the 6-hour gate made; repeating it with better tooling would be worse,
not better.

### Fidelity tiers

Only `exact` counts as evidence.

- **exact** — every input the decision depends on was recovered, *or is provably
  irrelevant to it*
- **partial** — something is assumed rather than known; reported, never counted
- **unreplayable** — a required input cannot be recovered; reported with the
  reason

"Provably irrelevant" is doing real work. When the recorded sales count is 0 the
sales boost is 0 and the cap is at its base **regardless of price**, so no price
information is needed and the row is exact despite being unrecoverable in
principle. Similarly, when `probeColdStart` is off the entire probe gate is
inert and reconstructs exactly.

The probe gate with `probeColdStart` **on** is the sharpest case. Its budget
half is never reconstructable (§7.4), and the first version of the harness let
that downgrade every row — on prod, all 363. But `demandAllocation` reads
`probeAllowed` on only two branches; everywhere else the value is dead. Rather
than restate those two conditions here (which would put `DEMAND_HALF` and the
boost formula in a second place, to drift the first time the tiers move), the
harness asks the economics directly: `probeGateLoadBearing()` runs
`demandAllocation` with `probeAllowed` true and again with it false and compares
the outputs. Identical means the unknown value cannot affect this row and the
row is exact. Each row records `probeGateMatters` so the split is auditable.

## 4. How the scoring works

Three shapes, depending on what the recorded decision proves about the demand
stage.

**(a) The legacy engine stopped at the sellability gate** (`skip_low_demand`,
`skip_probe_budget`, `probe`). The stage's whole output is recorded, so this is
a full check — and for the two skips it is **self-validating**: `autoFarmer`
records `demandScore: alloc.demand` there, which is the blended effective demand
*output*, so a replayed figure that matches confirms both the input
reconstruction and the economics at once. That is hard to get by luck.

**(b) The legacy engine got past that gate.** Whatever it did next, the stage
must not have skipped. A replay that skips here is a real contradiction.

**(c) The tier target is checkable** when `targetAccounts` was recorded. It is
`wanted` from the coverage gate, rebuilt from the same imported helpers:
`min(max(alloc.target, probe ? 0 : marketStockFloor(af)), alloc.cap || af.maxPerGame)`.

A mismatch on (a)'s demand figure is reported as **inconclusive**, not
*disagree* — the likeliest explanation is a missing input on our side, and
blocking a promotion on our own reconstruction gap would repeat the original
error in a new place.

## 5. Two findings the harness surfaced while being built

Both were pre-existing. The first is documented; the second was serious enough
that it became the second commit on this branch.

### 5.1 `AutoFarmTask.demandScore` means two different things

On the sellability-skip path `utils/autoFarmer.js` records
`demandScore: alloc.demand` — the **blended effective demand**, an *output* —
and hardcodes `hadResearch: true` **even when `research` was null**. Every other
decision, `probe` included, is recorded further down with the raw
`research ? research.demandScore : null` and a truthful `hadResearch`.

So on `skip_low_demand` / `skip_probe_budget` rows those two fields are an
output and a constant; everywhere else they are inputs. Anything reading them —
a replay, a dashboard, an alert — has to branch on the decision beside them or
it is silently comparing two different quantities. `hadResearch: true` on that
path is simply incorrect and is worth fixing on its own merits, though not from
this checkout (`autoFarmer.js` is additive-export-only here).

Captured as `classes.recordsEffectiveDemand()`.

#### …and some are not written at all, depending on the path

`record()` is a `$set` upsert. A field a path does not name is left as the
schema default on a fresh row, **or as whatever an earlier decision on the same
`(game, campaignId)` row wrote.** Reading the `record()` calls in
`processCampaign`/`executeTask`:

| Path | `demandScore` | `internalSales` | `targetAccounts` |
|---|---|---|---|
| `skip_low_demand`, `skip_probe_budget` | effective (output) | written | — |
| `skip_host_offline` | raw | **not written** *(written since commit 7)* | — |
| `reuse_existing` (live and dry-run) | raw | **not written** *(written since commit 7)* | **not written** |
| `skip_ends_soon`, `skip_already_covered`, `skip_no_accounts`, `skip_no_capacity` | raw | written | **not written** |
| `farm`, `probe` | raw | written | written (`wanted`) |
| `skip_reuse_only` | (kept from the farm/probe write moments earlier) | kept | kept |

This bit on the second prod run. **15 of 38 disagreements were false** — all
Black Desert, all `reuse_existing`, all "legacy passed the sellability gate but
the replay skips". The rows carried `internalSales: 0` because that path never
writes it; `SaleSignal` held 13 sales at $1.75; `demandAllocation` with 13 sales
gives demand 37 and passes, with 0 it gives 3.7 and skips. The first version of
`salesInputsFor()` short-circuited on a recorded 0 without consulting
`SaleSignal` at all. The live shadow lane, which reads `SaleSignal`, agreed with
legacy on every one of those decisions. **The replay was wrong and would have
blocked Black Desert's promotion on a reason that was not real.**

Now: the row's `internalSales` is **never an input**. Sales always come from
`SaleSignal` through the window-stability check; the recorded value is used only
as an integrity cross-check, and only on paths that write it. `targetAccounts`
is checked only on paths that write it. Captured as
`classes.recordsInternalSales()` / `classes.recordsTargetAccounts()`, and every
replayed row carries `salesBasis` (`window_unchanged` | `recorded_zero`) so a
scored row can be traced to *why* its sales were trusted.

The cost is honest: a `reuse_existing` row whose sales window has moved since
the decision is **unreplayable** rather than scored, because on that path not
even the count at decision time is recorded. For a game that sells steadily
(Black Desert, ~2 sales/week) that drops older reuse rows out of the scored set.
On prod the third run showed it: unreplayable rose 11 → 45 while the 15 false
disagreements became agreements.

**For rows recorded since commit 5 (§10), neither cost applies.** The snapshot
carries the sales the gate saw, so a reuse row replays exactly whatever the
window did afterwards; and commit 7 writes the flat `internalSales` on those two
paths too, so the row itself stops lying. Commit 6 makes `hadResearch` truthful
on the sellability skip. Rows from before those commits keep the behaviour
described above; `§9.1` is what would recover *them*.

One thing commit 7 deliberately does **not** do: widen the harness's write-map
(`classes.recordsInternalSales`). That map gates the integrity cross-check
against the flat field, and every row written before commit 7 still carries the
old value on those two paths — widening it would turn the 15 Black Desert rows
from `agree` back into `sales_count_mismatch`. Trustworthiness of the flat field
is a property of *when* a row was written, which the harness cannot see. Nothing
is lost: rows written since commit 5 never consult the flat field at all.

### 5.2 The lane's decision vocabulary WAS a strict subset of the legacy engine's

At `f7880c9`, `steps/decide.js` implemented the sellability stage and the
reuse-first check and **nothing downstream of them**:

| Legacy can emit | Lane at `f7880c9` | Lane now |
|---|---|---|
| `farm`, `probe`, `reuse_existing` | yes | yes |
| `skip_low_demand`, `skip_probe_budget` | yes | yes |
| `skip_host_offline` | — | **yes** |
| `skip_ends_soon` | — | **yes** |
| `skip_already_covered` | — | **yes** |
| `skip_no_accounts` | — | **yes** |
| `skip_no_capacity` | — | **yes** |
| `skip_reuse_only` | — | **yes** |

The consequence was concrete: **on any campaign the legacy engine settled with
one of those six gates, a live lane would have carried on and spent accounts.**
The coverage gate matters most — it is named in `FARM2-PLAN.md` as one of the
hard-won pieces (the wildcard bug that silently blocked all farming), and a lane
with no coverage gate would re-buy accounts for demand already covered. There
was also a phantom disagreement hiding in the pool-floor case: with a zero grant
the lane returned decision `farm` with `plannedAccounts: 0`, which compared as
`spend` against a legacy `skip_no_accounts`.

**Nobody had observed this because the comparison was broken.** Zero comparable
pairs means zero opportunities to notice. That is the strongest argument that
the verification gap was never a reporting nicety: the trial's whole purpose is
to catch exactly this class of defect, and it caught the reuse-first gap on day
one precisely because a comparison happened to work that day.

#### What the second commit does about it

`decideCampaign` now runs all six gates, **in the legacy order** (the comparison
is only meaningful if both engines stop at the same gate for the same inputs):

```
sellability → host → reuse-first → time → coverage → pool floor → capacity → reuse-only → farm/probe
```

Each gate comes from the legacy engine's own helpers, exposed by **one additive
hunk** on `autoFarmer.js`'s `module.exports` (`probeHost`, `isForcedGame`,
`manualFarmMap`, `activeAutoBotCount`, `autoSeatCapacity`, `readyPoolQuery`,
`WILDCARD_CREDIT_CAP`, `COUNT_MANUAL_AS_COVERAGE`). Nothing else in that file
changes. Specifics worth knowing at review:

- **Host gate.** `hostOnline = host ? probeHost(host) : false`, exactly as the
  tick. No configured host is *offline*, not *unknown* — a lane on a box with no
  farm host records `skip_host_offline` for everything, as legacy does. The
  probe is memoised per cycle and goes through the SSH semaphore.
- **Coverage gate.** Uses the exported `archiveHoldersByGame` (one game),
  `ownedAccounts`, `marketStockFloor` and the two constants. The manual-bot
  stash comes from `manualFarmMap`, memoised per cycle so every lane in the
  cycle shares one sweep — see §7 for the cost.
- **Pool floor.** The arbiter's `remainingAccounts` is the lane's `budgetMap`.
  A zero grant is now `skip_no_accounts`, not "farm 0".
- **Capacity gate.** Free containers from the cycle's snapshot; spare seats in
  running bots (`autoSeatCapacity`, a config read per container) are consulted
  **only when no container is free**, so the SSH cost is paid only when it can
  change the answer.
- **Reuse-only.** Legacy settles this at *claim* time inside `executeTask`. A
  lane needs it at *decision* time, so `recycledPoolCount()` counts what that
  claim would find. **This is the one place the lane leans on the shape of a
  legacy query rather than calling it** — the recycled pass of
  `claimPoolAccounts` (`readyPoolQuery()` + `^recycled after <game>$` +
  `soldGames ≠ normGame(game)`), composed from exported primitives. If that
  filter changes, this must change with it. A claim with `n = 0` was the
  alternative; it claims nothing and therefore tells us nothing.
- **`targetAccounts` now includes the market floor**, as the legacy row's
  `wanted` does (and as replay check (c) rebuilds). Previously the lane
  recorded the bare tier target.
- **Every gate is a read.** A test asserts no `AutoFarmTask` or
  `AvailableAccount` row is written or claimed by a full pass through all nine
  stages, including the reuse-only pre-check.

The decision context (host state, stash, owned set, coverage) can also be handed
in as legacy's `ctx` shape, which is how the tests drive each gate without a
host. `lane.js` is unchanged; the runner passes what it always did and the
context resolves lazily.

The vocabulary machinery in `decisionClasses.js` — `LANE_DECISIONS`,
`LEGACY_ONLY_DECISIONS`, the `lane_missing_gate` taxonomy, the readiness caveat —
is **kept, not removed**. `LANE_DECISIONS` is a separate declaration rather than
an alias of `LEGACY_DECISIONS` on purpose: the next time a decision is added to
the legacy engine and not to the lane, the gap reappears there, the comparison
labels those disagreements `lane_missing_gate` again, and a test fails. It
should currently have nothing to report, and a test asserts that too.

## 6. Changes to the existing gate

`laneReadiness()` keeps every existing blocker and adds:

- **`caveats`** — standing facts about the *engine* that apply to every lane,
  kept out of `warnings` (observations about *this lane's* evidence) so a clean
  lane still reads as clean. Folding them in would make that list never empty
  and train an operator to ignore it. The vocabulary caveat is now inert (§5.2)
  but the slot stays for the "no replay evidence" caveat.
- **`disagreementKinds`** — the taxonomy split. A row with no
  `disagreementKind` counts as `unclassified`, never as benign, following the
  discipline already established for `laneClass` and `stale`.
- **`replay`** — an optional report from the harness. A replay **disagreement
  blocks** promotion. Missing replay evidence is a caveat by default and a
  blocker under `requireReplay: true`.

`requireReplay` defaults to **false** deliberately. Raising the bar on a gate
that already guards a live promotion path is a decision for review, not
something this change should do quietly. **My recommendation is to turn it on**
once §7 has been worked through, with `MIN_REPLAY_DECISIONS` at 20 — replay rows
come from history rather than from waiting, so there is no reason to accept a
thin sample.

Also folded in: `steps/decide.js` had the action-class mapping written out
**twice in the same file** (`classOf` for the stale branch, `actionClass` for
the live one), with no shared definition — two copies of the rule that decides
whether a lane may take over a real game. Both now come from
`decisionClasses.js`, and an unclassified decision returns `"unknown"` rather
than falling through to `"skip"`. The old default meant a decision added to the
`AutoFarmTask` enum without being classified would read as "the lane is doing
nothing" and agree with any skipping lane — the same
absence-is-not-a-passing-value trap that has already bitten this comparison
twice. A test asserts that every value in the model's enum is classified.

## 7. What this cannot tell you, and what needs checking on prod

**I have verified none of this against production.** It runs against an
in-process Mongo with fixtures I wrote. Everything below is a real hole, not a
formality.

### Weaknesses of the approach itself

1. **Replay measures the demand stage, not the lane.** It proves the lane's
   *use* of `demandAllocation` reproduces recorded decisions. It says nothing
   about the six gates in §5.2, which are settled by state nobody snapshots.
   Those are now implemented, but their only evidence is unit tests and the
   shadow comparison — replay agreement is **necessary, not sufficient**, and
   should never be read as "safe to promote" on its own.
2. **It proves decision parity, not outcome parity.** Both engines can decide
   `farm 10` and one can execute it badly. Nothing here touches execution,
   listing or delivery.
3. **Settings are not versioned.** Today's `af` is applied to past decisions. If
   `maxPerGame`, `perMarketStock` or the probe settings changed during the
   window, rows either side of the change are replayed under the wrong
   configuration and may disagree for a reason that is not the lane's fault. The
   CLI prints the assumed values for this reason. **This was the largest
   unquantified risk in the design.** *Closed for rows with a recorded snapshot
   (§10): they replay under the settings then in force. Still applies to every
   row from before commit 5 shipped.*
4. **Cold-start probing weakens probe-reachable rows.** The concurrent-probe
   budget counts tasks by *current* status, so on the two branches where
   `demandAllocation` actually reads `probeAllowed` — no market data with a
   sub-half sales boost, or a sub-floor score with at most `probeMaxSellers`
   rivals — the row is `partial` and does not count. On every other branch the
   value is dead and the row is exact (§3). *Prod run 2026-09-04:
   `probeColdStart` is ON, and the first version of the harness downgraded all
   363 rows on this alone — 0 scored. Measured on those rows: 53 had no
   snapshot (unreplayable), 27 sat on a probe-reachable branch (partial), 283
   did not. This version scores those 283. Closed entirely for recorded rows
   (§10): the snapshot carries `probeAllowed`, so nothing is inferred.*
5. **120-day horizon.** `MarketResearchSnapshot` has a TTL. Older decisions are
   unreplayable, and a row close to the boundary may vanish mid-run. *Recorded
   rows (§10) do not read the snapshot collection at all.*
6. **Replay shares the lane's blind spots by construction.** It runs the same
   imported economics, so a bug *inside* `demandAllocation` reproduces
   identically in both and reads as agreement. It validates the lane's *use* of
   the brain, not the brain.

### Weaknesses the gates introduce

7. **The stash sweep runs per lane cycle.** `manualFarmMap` reads every config
   file on every host. Legacy pays that once per 10-minute tick; the lane
   supervisor cycles every 3 minutes, so shadow lanes will sweep roughly three
   times as often (once per cycle, shared across lanes, through the semaphore).
   If that is too much for the Pi, the supervisor cadence or a TTL on the memo
   is the knob — not skipping the sweep, which would change the coverage answer.
8. **A live lane's skips are not written to `AutoFarmTask`.** Legacy records
   every skip as a row with status `skipped`, which is what makes the RETRYABLE
   set re-decide and what the Auto-farm tab shows. `lane.js` only enqueues an
   execute job for `wouldFarm` verdicts, so a live lane's six new skips exist
   only as `FarmJob` rows. Harmless in shadow; a real gap in live mode, and
   pre-existing in shape (the two sellability skips had the same behaviour).
   Needs its own change in `lane.js`/`execute.js` — not made here, because it
   writes to a shared collection and deserves separate review.
9. **`recycledPoolCount` depends on a query's shape** (§5.2). It has a test that
   mirrors the `soldGames` term, but nothing ties it to `claimPoolAccounts`
   mechanically.
10. **Two fallbacks exist for an `autoFarmer` that predates the export hunk**
    (`isForcedGame` → not forced; `probeHost` → single `readdir`). They make the
    lane *more* conservative, not less, but on such a build it would disagree
    with legacy on forced games. Deploy the hunk with the lane code.

### Specific things to confirm on production

- **Does `MarketResearchSnapshot` actually have the coverage assumed?** Rows per
  game per scan, going back far enough, with `sellers` populated. If scans are
  sparse or the collection is thinner than the model suggests, the exact-fidelity
  count collapses and the whole approach needs re-costing. **Check this first —
  everything else depends on it.**
- **Run `node scripts/farm2-replay.js --days 110` and look at the real ratio.**
  The 2026-09-04 run gave 0 scored of 363 (all `partial`, all
  `probe_budget_unreconstructable`) — the design failed on first contact, as
  §7.4 warned, and `gapCounts` named the assumption. Re-run after the exactness
  fix; the measured expectation is ~283 exact of 363.
- **Re-run after the row-field fix and read the disagreement breakdown.** The
  second run scored 315 of 364 with 38 disagreements; 15 were the Black Desert
  false positives above. Each disagreement now carries a `kind` and a
  `salesBasis`, and the CLI prints both histograms. The 15 must come back as
  `agree` (window unchanged) or `unreplayable` (window drifted) — never
  `disagree`. Of the remaining 23: any `legacy_passed_replay_skips` row with
  `salesBasis: window_unchanged` is a *real* finding about one of the two
  engines; `tier_target` rows point at `af` settings drift or the market floor
  (§7.3), not at sales; `legacy_skipped_replay_wants` rows mean the replay has
  *more* demand than legacy had — the drift check should already have made those
  unreplayable, so any that survive are worth a look. Albion Online's 2 of 21
  will sort themselves into one of those buckets on the re-run.
- **Run a shadow cycle with the gates and diff against legacy rows.** The six
  new decisions should now appear in lane verdicts and, for campaigns the legacy
  engine re-decides every tick (the RETRYABLE skips), agree with it. Any
  `class_mismatch` on those is a real finding about one of the two engines.
- **After commit 5 deploys, confirm the snapshot is being written.** Every new
  `AutoFarmTask` row — legacy or lane, any decision — should carry
  `decisionInputs.version: 1` with `research`, `sales`, `af`, `probeAllowed`
  and `marketStockFloor` populated. A row with `decision` newer than the deploy
  and no snapshot means the `processCampaign` hunk did not land on prod's copy
  (its context lines were byte-identical at the last fingerprint, but prod-only
  lines could sit between them — `git am -3`).
- **Watch `inputsBasis.recorded` climb on each replay run.** It should track
  the share of rows decided since the deploy, and `unreplayable` should fall
  toward zero as pre-deploy rows age out of the 110-day window. If recorded
  rows ever show a disagreement, that is a real finding: nothing on that row
  was reconstructed.
- **Whether the §5.2 gap showed up as real disagreements** before this commit.
  If none appeared on prod, my reading of `decide.js` at `f7880c9` was wrong and
  the gates work should be re-examined.
- **Whether `af` settings changed in the replay window.** Worth reconstructing
  from deploy history or operator memory before trusting any run longer than a
  few weeks.
- **Whether `hadResearch: true` on the skip path has corrupted anything else.**
  I found it while reading; I have not audited what else consumes that field.
- **The stash sweep's cost on the Pi** at the 3-minute cadence (§7.7).
- **The five pre-existing test failures** (below) — I assumed they are all the
  same orphan-file class as the documented one, but I have not confirmed that
  against the branches those utils live on.

## 8. Verification done in the sandbox

- `tests/farm2Replay.test.js` — 37 tests: the vocabulary, every fidelity tier,
  the exact 171h trial case from the task brief, self-validating demand
  figures, a genuine disagreement, the readiness integration, the probe-gate
  cases from the first prod run (research present, `sellers > probeMaxSellers`,
  score below the half tier, `probeColdStart` ON → **exact**; the two
  probe-reachable branches → partial), and the row-field cases from the second
  prod run — the pinned one being **the Black Desert case**: a `reuse_existing`
  row with `internalSales: 0` and 13 `SaleSignal` sales at $1.75 → sales taken
  from `SaleSignal`, `salesBasis: window_unchanged`, `salesCount: 13`, gate
  passes, **agree**; the same row with one sale landed since → **unreplayable,
  never disagree**; a contradicting count on a path that writes the field →
  integrity failure; a stale `targetAccounts` on a reuse row → not checked; and
  which fields each legacy path writes, pinned.
- `tests/farm2Gates.test.js` — 21 tests: each of the six gates reached in
  isolation with the legacy row's decision and numbers, the legacy gate order,
  forced-game bypass, reuse-before-time-gate, partial coverage, seat trimming,
  the reuse-only `soldGames` term, read-only assertion across all nine stages,
  per-cycle memoisation, and that `LEGACY_ONLY_DECISIONS` is empty.
- All 87 pre-existing farm2 tests still pass. Three vocabulary tests in
  `farm2Replay.test.js` were inverted to assert the gap is closed; no other
  existing test was edited.
- `npx eslint utils/farm2 utils/autoFarmer.js tests/farm2Gates.test.js` — clean.
- Full suite after commit 5: **691 pass / 1 fail** (692), against a baseline on
  `de4facd` of 672 / 1 — exactly the 19 new tests. The single failure is
  `dropSetsListLight.test.js`, which needs `utils/archiveExclusions.js` from
  another branch; identical before and after. (The four orphaned test files
  that failed in earlier runs were un-tracked at `f83acb9`.) A clean clone of
  the target branch reports a higher pass total than this checkout because it
  carries test files this branch does not; the delta, not the total, is the
  claim.

- `tests/farm2DecisionInputs.test.js` — 19 tests: the snapshot shape and its
  version check; the model keeps the sub-document under strict mode; **the real
  legacy `record()`**, driven through `processCampaign` on the three branches
  that need no host (sellability skip, host gate, dry-run reuse) — the last two
  being the paths that never wrote `internalSales`; a re-decided row gets a
  fresh snapshot; the lane writes the same shape and `execute` persists it;
  replay is exact from a snapshot alone, uses the recorded settings over
  today's (with the reconstruction as a control that *does* disagree), recovers
  a drifted reuse row and a cold-start probe row, reconstructs an unknown
  version with a gap, and treats an old row exactly as before.

`utils/autoLister.js` is untouched. `utils/autoFarmer.js` carries, across the
series: the `module.exports` hunk (commit 2; commit 5 adds `processCampaign`
so the real write path is testable); one `require` and a ~12-line hunk inside
`processCampaign` that snapshots the inputs and writes them from every
`record()` call (commit 5); one token on the sellability skip (commit 6); one
field on three `record()` calls (commit 7). Commit 5 is the first in the series
to touch the body of `processCampaign`. Per `FARM2-PLAN.md`'s deployment note,
every hunk must be applied onto **prod's** copy of the file (4,516 lines, with
the catalog integration this checkout does not have) with `git am -3` — never by
copying the local file up. Nothing touches the lane runner, the budget arbiter,
the shadow guards or the live-mode steps.

## 9. If you want the stronger version later

Two small, additive changes to `autoFarmer.js` would materially improve this.
Both are out of scope here (this checkout is additive-export-only, and prod runs
79 lines this tree does not have), so they are recorded rather than made:

1. **`internalSalesForGame(game, { asOf })`** — one optional parameter, shifting
   the aggregation window. It would make every drifted-sales row exactly
   replayable instead of unreplayable, which is currently the single largest
   source of dropped rows. Without it, the only alternative is copying the
   aggregation, which is the second source of truth this engine exists to avoid.
2. ~~**Snapshot the decision inputs onto `AutoFarmTask`**~~ — **done, commit 5.
   See §10.**

The first remains the only way to recover rows from *before* commit 5. It is
not needed for anything recorded since.

## 10. Recorded decision inputs (commit 5)

Replay existed because the inputs a decision saw were not recorded, so they had
to be rebuilt after the fact — and every rebuild has a hole the prod runs found
one at a time: research snapshots expire (§7.5), a sale since the decision loses
the price (§5.1), the probe budget can only be inferred (§7.4), and yesterday's
decision was replayed under today's settings (§7.3). This commit records the
inputs instead.

**What.** A `decisionInputs` sub-document on `AutoFarmTask`:

| field | source | why |
|---|---|---|
| `version` | `1` | checked for **equality** by the reader; anything else is reconstructed |
| `at` | write time | — |
| `research` | `{ demandScore, sellers, scannedAt }`, or `null` | what `demandAllocation` was given; an unscanned document is kept distinct from no document |
| `sales` | `{ count, revenue, avgPrice }` | exactly what `salesOf()` returned |
| `af` | `maxPerGame`, `probeColdStart`, `probeSize`, `probeMaxSellers`, `probeMaxGames`, `probeCooldownDays`, `perMarketStock`, `poolReserve`, `minHoursLeft` | every setting the sellability stage, the probe gate and the tier target read |
| `probeAllowed`, `probeBudgetBlocked` | the probe gate's two outputs | the half that could never be rebuilt |
| `marketStockFloor` | `alloc.probe ? 0 : marketStockFloor(af)` | the floor as it stood — it also depends on marketplace keys, so it is recorded as a value rather than re-derived |

**Where it is written.** `utils/decisionInputs.js` is the **one** definition of
the shape; the legacy engine, the lane and replay all import it and none
describes it themselves.

- Legacy: a `let recordedInputs` in `processCampaign`, populated the moment
  `alloc` is known, and spread into `record()`'s `$set` — so **every** `record()`
  call on **every** path writes it, including `reuse_existing` and
  `skip_host_offline`, with no per-call-site edits. `skip_reuse_only`
  (executeTask's later `updateOne`) keeps the farm-time snapshot from the same
  tick. A re-decided RETRYABLE row gets a fresh snapshot each tick.
- Lane: `decideCampaign` builds the same object and carries it on every verdict
  via `common`; `execute.js` persists it from `upsertTask` and `executeReuse`.
  A lane-created row is therefore replayable exactly like a legacy one.

**How replay uses it.** `reconstructInputs` checks the snapshot **first**. A
recognised version is taken whole — research, sales, the recorded `af`
fingerprint overriding today's for the fields it covers, `probeAllowed`, the
floor — with fidelity `exact`, no gaps, no `SaleSignal` query, no snapshot
lookup, no probe sensitivity check. Every row reports `inputsBasis`
(`recorded` | `reconstructed`) and `inputsVersion`; the summary and CLI show the
split; `afAssumed` is now labelled as applying to reconstructed rows only.

**What it deliberately does not do.**

- A snapshot that *exists* but is not recognised — a later version, a malformed
  write — is **not** trusted and **not** silently ignored: the row is
  reconstructed and carries `decision_inputs_version_unknown`. A row with no
  snapshot is reconstructed exactly as before, with no gap. Absence is never a
  passing value.
- It records the **sellability-stage** inputs only. Pool depth, container
  capacity, host state and archive coverage — the inputs to the six downstream
  gates — are not snapshotted. Replay's scope (§3) is unchanged; widening it is
  a possible follow-up, not this commit.
- It does nothing for rows written before it ships. Those keep every caveat in
  §7 and every reconstruction path in §3–§4.

**Cost.** Roughly 200 bytes per `AutoFarmTask` row, one row per game and
campaign. Negligible.
