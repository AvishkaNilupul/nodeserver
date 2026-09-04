# Farm lanes (farm2) — the reorganised farm + list engine

Status: **deployed to prod and running in shadow.** Master switch ON, three
trial lanes, all in shadow mode — they decide and audit but change nothing. No
lane has ever been promoted to live. The legacy engine still farms every game.

---

## Why

`utils/autoFarmer.js` is 4,437 lines, and `runOnce()` (line ~3091) is a single
~900-line function that runs **18 phases sequentially under one global mutex**,
once every 10 minutes, for every game at once:

> cleanup → reprice → wake/park → host probe → research → allocation →
> per-campaign decisions → suspension sweep → dead-token reap → backfill →
> reap → recycle → probe stop-loss → repack → refill → re-list →
> **auto-list** → telegram

Three consequences, and they are the actual causes of "it crashes and gets
bugged":

1. **No isolation.** One game's exception, or one slow SSH probe to the Pi
   (seconds of RTT; ~63s for an offline host), costs *every* game the tick.
2. **Listing is welded to farming.** Auto-listing is phase 15 *inside* the farm
   tick (`autoFarmer.js:3735`), so a Gameflip 429 or a hung Plati call delays
   farm decisions for every game.
3. **State lives in RAM.** `state` and `progressLog` are module-level. A restart
   mid-tick loses the trail entirely and can leave DB rows in limbo, with the
   only visibility being an in-process array of strings.

## The core design decision

**Keep the brains, replace the nervous system.**

The economics in `autoFarmer.js` are hard-won — demand tiers, the internal-sales
boost, the price factor, the cold-start probe gate, the per-game cap, the
coverage rules. The memory notes are a graveyard of subtle bugs already fixed in
that logic (phantom demand counting stock claims as sales, the coverage-gate
wildcard, the non-Latin placeholder false-positive). **Rewriting any of it would
reintroduce those one at a time.**

So `utils/farm2/*` contains **no economics of its own**. It imports
`demandAllocation`, `capForGame`, `salesOf`, `fairShare`, `researchForGame`,
`internalSalesForGame`, `countReadyPool`, `marketStockFloor` from the legacy
module, and `verifiedHoldersForItems` / `campaignItems` from `autoLister`. What
it replaces is **scheduling, isolation, retries and state**.

## Architecture

```
supervisor.js ("main farm watcher")   — picks due lanes, computes the budget, dispatches
   └── budget.js  (the arbiter)       — sealed per-lane allowances + SSH semaphore
   └── lane.js    (one per game)      — hard error boundary, own clock, own errors
         ├── steps/decide.js          — research + demand + allocation
         ├── steps/execute.js         — drives autoFarmer.executeTask  [LIVE ONLY]
         ├── steps/verify.js          — the drop checker (holdings gate)
         ├── steps/publish.js         — listing, split from farming     [LIVE ONLY]
         └── steps/monitor.js         — per-lane health, queues the next step
   └── jobs.js                        — durable FarmJob rows: retries, backoff, recovery
   └── ownership.js                   — which engine owns which game
```

### What the live-mode steps do and don't own

`execute` does **not** reimplement spending. `autoFarmer.executeTask` already
carries the execution-time reserve re-check, the container-capacity re-check
(whose absence once produced 31 containers under a `maxAutoBots` of 6),
reuse-only handling, and the subtle "throw WITHOUT marking failed" cases — a
`failed` write on a transient pool shortage permanently bricks a plan. So the
lane prepares the `AutoFarmTask` row, applies its budget ceiling, and hands over.

`monitor` deliberately does **not** run the fleet sweeps (`completeEndedTasks`,
`backfillActiveTasks`, `reapRetiredBots`, `recycleSoldOutAccounts`,
`repackAutoBots`). Those are inherently fleet-wide — repacking consolidates
several games into one container, so a "per-game repack" is a different and more
dangerous operation, not a smaller one. They also still run against lane-created
tasks, because the ownership guard only blocks NEW task creation. That is a
feature: it is what makes a lane's tasks impossible to strand. **The legacy
engine remains the fleet's janitor, for lane tasks too.** Splitting the sweeps is
a later phase needing its own design.

### Publishing is two rows, not four

The original intent was one job per marketplace. The real `autoLister` API does
not support it: `publishPlatiShare`/`publishGgselShare` take a payload assembled
inside `retryMissingSecondaries` (resolved set, grid image, price, split, and
**reserved accounts** via `reserveAccountsForPublish`). Driving them directly
means duplicating the stock-reservation logic — the second source of truth this
engine exists to avoid. So the boundary is drawn where the API allows one:

- `publish/primary` → `listActivatedTask` (Gameflip, plus a first attempt at the secondaries)
- `publish/secondaries` → `retryMissingSecondaries`, on its **own** retry clock

A secondary-market outage still cannot block or delay the primary listing, and
vice versa. It is a genuine failure boundary, just coarser than per-market. True
per-marketplace splitting needs `autoLister` reworked first.

### The arbiter is the one genuinely new piece

The legacy engine is safe against over-spending for an *accidental* reason: it
does everything serially, so one running counter suffices. Concurrent lanes
destroy that guarantee, and three globals are contended — the account pool,
container slots, and SSH concurrency to the Pi.

Design: **sealed allowances.** The supervisor computes the budget once per cycle
and splits it across due lanes (via the legacy `fairShare`, so the division is
the same algorithm). A lane may not exceed its allowance, so the sum can never
exceed the budget — the invariant holds by construction, with no cross-lane
locking on the hot path.

Two independent nets back this up, so an arbiter bug costs *fairness*, never
*integrity*:

- `claimPoolAccounts` uses per-account atomic `findOneAndUpdate`
- bot config writes go through `utils/fileLock.js` (per-host-file serialisation)

## The ownership contract

**Exactly one engine may act on a game.** `utils/farm2/ownership.js` is the sole
authority, and its fail-safe direction is deliberate and asymmetric:

| Wrong answer | Consequence |
|---|---|
| "owned" when farm2 isn't running it | **both** engines skip → campaigns unfarmed, stock never listed. Silent, costs money. |
| "not owned" when farm2 could run it | legacy handles it exactly as today. Nothing lost. |

So **every** uncertainty — engine stopped, master switch off, lane table
unreadable, cache cold — resolves to **NOT owned**.

Only `mode: "live"` confers ownership. The legacy skip guard
(`autoFarmer.js`, beside the existing no-claim skip) creates **no new task** for
an owned game but **leaves already-active tasks alone**, so promoting a lane can
never strand an in-flight campaign — it finishes under the engine that started it.

## Shadow mode — why the trial is safe

A lane in `shadow` runs the **full** decision pipeline and records what it
*would* do, with **no side effects**: no pool claims, no host writes, no
marketplace calls, and it uses the read-only `researchForGame` rather than
triggering a live re-scan. The legacy engine keeps really farming that game.

The tab diffs the two. Agreement is judged on the **action class** the decision
causes, not on exact strings:

| Class | Decisions | Cost |
|---|---|---|
| `spend` | `farm`, `probe` | claims fresh pool accounts, may burn a container slot |
| `reuse` | `reuse_existing` | restarts warm bots — no accounts, no slots |
| `skip` | every `skip_*` | nothing |

Account *counts* may legitimately differ (the arbiter divides the pool
differently from a serial pass), so the delta is reported separately — but the
class must match, and a mismatch **blocks** promotion. An earlier version lumped
`spend` and `reuse` together as one "act" class; see the trial finding below for
why that was dangerous.

Shadow lanes are allocated from a **notional fork** of the cycle budget — same
totals, independent ledger — so their numbers are realistic without competing
with live lanes for real accounts. The SSH semaphore is shared, because host
concurrency is a physical limit that shadow reads consume too.

The drop checker is read-only in every mode, so it audits the inventory the
legacy engine is managing **right now** — the `ready, not listed` finding is the
silent failure mode the legacy engine has no view of.

## The three trial games (chosen from live prod data, 60-day window)

| Game | Why |
|---|---|
| **Albion Online** | 17 farm/reuse/probe decisions — highest churn of any game, so it produces comparison evidence fastest |
| **World of Tanks** | a **reuse-only** game — never spends fresh pool accounts. Deliberately a genuinely different branch, not a third happy path |
| **Black Desert** | 12 decisions on the normal fresh-spend path — the control case against WoT |

## Rollout

1. Deploy (engine OFF — a deploy changes nothing).
2. Turn the master switch on. All three lanes are in shadow; still nothing acts.
3. **Watch the comparison tab for a few days.** Every disagreement is either a
   lane bug or a legacy bug — investigate before promoting anything.
4. Promote **one** lane to live. This is gated: the confirm dialog shows the
   readiness check, which **blocks** promotion until the lane has at least 3
   recorded shadow decisions and the live-mode steps are present on that host,
   and **warns** (without blocking) when recent decisions disagreed with the
   legacy engine. An override is possible and is written to the audit log.
5. Watch it. Repeat per game. Demote to shadow at any time; the kill switch
   reverts everything instantly.

The live-mode steps are implemented. Three independent guards stop a shadow lane
ever spending or listing: the lane runner only drains jobs when
`mode === "live"`, and `execute` and `publish` each assert on both the shadow
flag **and** the lane's own mode. All are covered by tests.

## What the shadow trial caught on day one (2026-09-04)

The trial went live and immediately found a defect that would have made the
system **worse** if a lane had been promoted.

All three trial games were being served by the legacy engine as
`reuse_existing` — restart the game's existing warm bots, spend nothing:

| Game | Legacy | Lane said |
|---|---|---|
| Albion Online | `reuse_existing`, 3 warm bots | `farm` (fresh accounts) |
| World of Tanks | `reuse_existing`, 2 bots / 18 accounts | `farm` (fresh accounts) |
| Black Desert | `reuse_existing`, 3 bots / 40 accounts | `farm` (fresh accounts) |

**`decide.js` had no reuse-first path at all.** It always reached for fresh pool
accounts, so promoting any of those lanes would have claimed real accounts and
burned container slots to do something strictly worse than what was already
running. (World of Tanks was accidentally protected — it is reuse-only, so
`executeTask` would have refused fresh accounts. Luck, not design.)

Worse, **the comparison reported all three as `agree ✓`**, because the original
diff lumped `farm`, `probe` and `reuse_existing` into one "act" class. The
readiness gate was built on that metric, so it would have permitted the
promotion after three "agreeing" decisions.

Three fixes:

1. **Reuse-first in `decide.js`** — checks `reusableTaskForGame` (newly exported)
   *before* allocation, because reuse costs no accounts and no container slots, so
   a lane with a zero budget can still reuse. Bot-file existence is a host READ,
   allowed in shadow, routed through the SSH semaphore with a per-cycle cache
   (one container commonly serves all three games).
2. **Reuse execution in `execute.js`** — a reuse decision restarts the warm bots
   instead of going down `executeTask`'s fresh-spend path. `spokenFor` is
   computed against active **and** planned tasks, matching the legacy path, since
   `assignedAccounts` drives listing quantity and double-counting sells stock
   that cannot be delivered twice.
3. **Action-class diff + a blocking gate** — `spend` / `reuse` / `skip` are now
   distinct classes, a mismatch is a **blocker** rather than a warning, and
   shadow lanes are allocated from a *notional fork* of the budget so their
   numbers are realistic (they previously got zero, so every shadow decision read
   "trimmed to 0 of N" and the comparison could never validate an amount).

Cost of finding it this way: **zero accounts spent, nothing broken.** The legacy
engine farmed all three games normally throughout.

## Deployment note — prod drift

Fingerprinted 2026-09-03. Prod runs code this checkout does not have:

| File | Prod | Local | Drift |
|---|---|---|---|
| `utils/autoFarmer.js` | 4,516 lines | 4,437 | **79 lines prod-only** — the catalog integration (`stampPreorderSet`, `updateAutofarmCatalogStates`, the 6h variant sync) |
| `utils/autoLister.js` | 2,216 lines | 2,199 | **17 lines prod-only** — the non-Latin placeholder fix |

Everything else farm2 touches (`server.js`, `settings.js`, `botWaker`,
`botFactory`, `botHosts`, `marketplaces`, `AutoFarmTask`, `autoFarmRoutes`) was
**byte-identical** between prod and the local working tree at fingerprint time.

Note that `utils/settings.js` in this working tree was *already* ahead of `HEAD`
before this work started (`webbotStreamGate`, `coworkerAutonomy`,
`getWebbotGate`, `getCoworkerAutonomy` — all already live on prod). A `git diff`
against HEAD therefore shows those alongside the farm2 change. **The only
farm2 addition to that file is the `farm2Enabled: false` default.**

`utils/catalogPreorder.js` exists **only on prod**, so prod's `autoFarmer.js`
cannot be require-loaded in this checkout.

**Therefore: the two edits to `autoFarmer.js` and the one to `autoLister.js` must
be applied as hunks onto PROD's copies — never by copying the local files up.**
Deploying a local `autoFarmer.js` straight would silently revert the live catalog
integration; that has already happened twice.

The three hunks are all additive:
- `autoFarmer.js` — require `./farm2/ownership`; the skip guard beside the
  no-claim skip; export `freshResearchForGame`; export `reusableTaskForGame`
- `autoLister.js` — export `verifiedHoldersForItems`

## Verification done

- 46 new unit tests (budget invariants, ownership fail-safe, lane isolation,
  job queue, the shadow assertions, the readiness gate, reuse-first) — all pass
- full suite **634/635**; the single failure (`dropSetsListLight.test.js`) is
  pre-existing and unrelated — it needs `utils/archiveExclusions.js`, which lives
  on `perf/drops-archive-rollup` and is absent from this checkout
- end-to-end against a throwaway in-memory Mongo: inert-by-default, seeding,
  ownership flips, retry/backoff/exhaustion, crash recovery, full 3-lane cycle
- UI verified against a stubbed API harness — all five panels render, no console
  errors

**Bugs caught by that testing and fixed:**

1. `enqueue` relied on the partial unique index being *built*, so on a fresh
   database duplicate jobs were inserted and a second `claimNext` picked up the
   duplicate — one campaign decided twice. Now an atomic `findOneAndUpdate`
   upsert, independent of index-build timing, with the unique index kept as the
   race backstop.
2. `execute` resolved the farm host *before* the dry-run early return, so a
   preview failed with "no farm host configured" on exactly the occasions it is
   most useful — a host outage, or a machine with no farm host configured. The
   host is now resolved only on the real spending path.

## Explicitly untouched

The **unclaimed farm system** (`utils/unclaimedAutoList.js`,
`routes/unclaimedAutoRoutes.js`, `public/unclaimed-farms.html`,
`models/UnclaimedAccount.js`) — not modified in any way. Verified byte-identical
to prod.
