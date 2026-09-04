# Making a farm lane verifiable

Status: **proposal.** Implemented and tested in the sandbox, verified against
nothing real. Section 7 lists what has to be confirmed on production before any
of it is trusted.

Companion to `docs/FARM2-PLAN.md` (the architecture) and
`docs/FARM2-TASK-comparison-evidence.md` (the task).

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
utils/farm2/replay.js          the harness
utils/farm2/decisionClasses.js the shared decision vocabulary
scripts/farm2-replay.js        operator CLI (read-only)
tests/farm2Replay.test.js      24 tests
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

Both are pre-existing, neither is caused by this change, and the second is the
more serious.

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

### 5.2 The lane's decision vocabulary is a strict subset of the legacy engine's

| Legacy can emit | Lane can emit |
|---|---|
| `farm`, `probe`, `reuse_existing` | `farm`, `probe`, `reuse_existing` |
| `skip_low_demand`, `skip_probe_budget` | `skip_low_demand`, `skip_probe_budget` |
| `skip_ends_soon` | — |
| `skip_already_covered` | — |
| `skip_no_accounts` | — |
| `skip_no_capacity` | — |
| `skip_host_offline` | — |
| `skip_reuse_only` | — |

`steps/decide.js` implements the sellability stage and the reuse-first check,
and **nothing downstream of them**. It has no time gate, no coverage gate, no
pool-floor gate, no capacity gate, no host-offline gate and no reuse-only gate.
It imports `demandAllocation`, `salesOf`, `researchForGame`,
`internalSalesForGame` and `reusableTaskForGame` from the brain, but not
`countReadyPool`, `marketStockFloor`, `capForGame`, `fairShare`,
`archiveHoldersByGame` or `ownedAccounts` — so `FARM2-PLAN.md`'s statement that
all the economics are imported is currently aspirational rather than true.

The consequence is concrete: **on any campaign the legacy engine settles with
one of those six gates, a live lane would carry on and spend accounts.** The
coverage gate is the one that matters most — it is named in `FARM2-PLAN.md` as
one of the hard-won pieces (the wildcard bug that silently blocked all farming),
and a lane with no coverage gate would re-buy accounts for demand that is
already covered.

**Nobody has observed this because the comparison is broken.** Zero comparable
pairs means zero opportunities to notice. That is the strongest argument I have
that the verification gap is not a reporting nicety: the trial's whole purpose
is to catch exactly this class of defect, and it caught the reuse-first gap on
day one precisely because a comparison happened to work that day.

This proposal **does not implement the missing gates** — that is a larger change
with its own risk surface and deserves its own review. What it does is make them
*visible and named*: `classifyDisagreement()` labels such a difference
`lane_missing_gate` rather than mixing it into a disagreement count, because the
response is "implement the gate", not "work out which engine was right".

## 6. Changes to the existing gate

`laneReadiness()` keeps every existing blocker and adds:

- **`caveats`** — standing facts about the *engine* that apply to every lane,
  kept out of `warnings` (observations about *this lane's* evidence) so a clean
  lane still reads as clean. Folding them in would make that list never empty
  and train an operator to ignore it. The vocabulary gap in §5.2 lives here.
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
twice. A test now asserts that every value in the model's enum is classified.

## 7. What this cannot tell you, and what needs checking on prod

**I have verified none of this against production.** It runs against an
in-process Mongo with fixtures I wrote. Everything below is a real hole, not a
formality.

### Weaknesses of the approach itself

1. **Replay measures the demand stage, not the lane.** A lane could reproduce
   every historical decision perfectly and still be unsafe, because the gates in
   §5.2 do not exist. Replay agreement is **necessary, not sufficient**, and
   should never be read as "safe to promote" on its own.
2. **It proves decision parity, not outcome parity.** Both engines can decide
   `farm 10` and one can execute it badly. Nothing here touches execution,
   listing or delivery.
3. **Settings are not versioned.** Today's `af` is applied to past decisions. If
   `maxPerGame`, `perMarketStock` or the probe settings changed during the
   window, rows either side of the change are replayed under the wrong
   configuration and may disagree for a reason that is not the lane's fault. The
   CLI prints the assumed values for this reason. **This is the largest
   unquantified risk in the design.**
4. **Cold-start probing weakens probe rows.** The concurrent-probe budget counts
   tasks by *current* status, so probe-vs-`skip_probe_budget` is not
   reconstructable when `probeColdStart` is on. Those rows come back `partial`
   and do not count.
5. **120-day horizon.** `MarketResearchSnapshot` has a TTL. Older decisions are
   unreplayable, and a row close to the boundary may vanish mid-run.
6. **Replay shares the lane's blind spots by construction.** It runs the same
   imported economics, so a bug *inside* `demandAllocation` reproduces
   identically in both and reads as agreement. It validates the lane's *use* of
   the brain, not the brain.

### Specific things to confirm on production

- **Does `MarketResearchSnapshot` actually have the coverage assumed?** Rows per
  game per scan, going back far enough, with `sellers` populated. If scans are
  sparse or the collection is thinner than the model suggests, the exact-fidelity
  count collapses and the whole approach needs re-costing. **Check this first —
  everything else depends on it.**
- **Run `node scripts/farm2-replay.js --days 110` and look at the real ratio.**
  My claim is that this turns "0 comparable out of 300" into a usable sample. I
  cannot demonstrate it. If `scored` comes back near zero the design has failed
  on contact and the `gapCounts` breakdown will say which assumption broke.
- **Whether the §5.2 gap shows up as real disagreements.** I predict a
  meaningful number of `lane_missing_gate` rows on any game where the legacy
  engine uses the coverage gate. If none appear, my reading of `decide.js` is
  wrong and should be re-checked before anything is built on it.
- **Whether `af` settings changed in the replay window.** Worth reconstructing
  from deploy history or operator memory before trusting any run longer than a
  few weeks.
- **Whether `hadResearch: true` on the skip path has corrupted anything else.**
  I found it while reading; I have not audited what else consumes that field.
- **The five pre-existing test failures** (below) — I assumed they are all the
  same orphan-file class as the documented one, but I have not confirmed that
  against the branches those utils live on.

## 8. Verification done in the sandbox

- `tests/farm2Replay.test.js` — 24 new tests: the vocabulary, every fidelity
  tier, the exact 171h trial case from the task brief, self-validating demand
  figures, a genuine disagreement, the readiness integration.
- All 63 pre-existing farm2 tests still pass, unmodified. No existing test was
  edited or deleted.
- `npx eslint utils/farm2 scripts/farm2-replay.js tests/farm2Replay.test.js` —
  clean.
- Full suite: **638 pass, 5 fail**, against a baseline of **614 pass, 5 fail**.
  The five failures are identical before and after and are all the same class —
  a test file whose util lives on another branch:
  `dropSetsListLight` (`utils/archiveExclusions`, documented in the brief),
  plus `coworkerActs`, `farmDuration`, `operatorFarm` and `webbotFarmWatcher`.
  The brief expected only the first; the other four are equally pre-existing on
  this checkout and are **not** caused by this work.

Nothing in this change touches `utils/autoFarmer.js` or `utils/autoLister.js` —
not even an added export. Nothing touches the lane runner, the budget arbiter,
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
2. **Snapshot the decision inputs onto `AutoFarmTask`** — a `decisionInputs`
   sub-document written at `record()` time carrying the research values, the
   sales figures and the `af` fingerprint. That removes reconstruction entirely
   for every decision made after it ships, and closes the settings-versioning
   hole in §7.3.

The second is the real fix, and it is small. Replay exists because the inputs
were not recorded; recording them going forward makes replay exact rather than
best-effort, and would let the readiness gate require full-fidelity evidence
without the caveats above.
