# Task: make the farm2 lane engine verifiable

**You are working in a sandbox with no network access to production.** Everything
below is solvable without it. Do not propose steps that require SSH, a live
database, or deploying — those happen elsewhere, by someone else, afterwards.

Read `docs/FARM2-PLAN.md` first for the full architecture. This file is the task.

---

## The system in one paragraph

`utils/autoFarmer.js` (4,437 lines locally, 4,516 on prod) turns Twitch drop
campaigns into running bots. Its `runOnce()` is a ~900-line function running 18
phases serially under one global mutex, every 10 minutes, for every game at once —
so one game's exception or one slow SSH probe costs the whole fleet a tick, and
auto-listing sits *inside* the farm tick, so a marketplace 429 delays farming.

`utils/farm2/*` reorganises that into isolated per-game "lanes" with a shared
budget arbiter and durable job rows. **It contains no economics of its own** — all
demand/pricing/allocation logic is imported from the legacy module, deliberately,
because that logic encodes years of expensive bug fixes. The lane engine owns
scheduling, isolation, retries and state. Keep it that way.

A lane runs in one of three modes:

- `off` — inert
- `shadow` — runs the full decision pipeline, records what it *would* do, performs
  **no** side effects. The legacy engine still really farms the game.
- `live` — acts for real; the legacy engine skips the game.

## The problem you are solving

**Shadow mode cannot produce the evidence needed to promote a lane.**

The intended workflow was: run a lane in shadow, compare its decisions against the
legacy engine's for the same campaign, and promote once they agree. The comparison
is implemented in `diffAgainstLegacy()` in `utils/farm2/steps/decide.js` and gates
promotion via `laneReadiness()` in `utils/farm2/index.js`.

It does not work, for a structural reason:

> **Once the legacy engine acts on a campaign, it never re-decides it.**

Only retryable skips come back round. So a lane deciding a campaign today is
compared against a legacy decision made hours or days earlier, under conditions
that no longer exist. Measured on production:

- A first pass reported "91 of 101 agree, 10 differ". Investigating all ten found
  every one was **both engines being right about different moments** — legacy had
  decided 41–229 hours earlier. Example: legacy said `probe` 171h ago when a game
  was untested; the probe found no sales; the lane now correctly says
  `skip_low_demand`. Not a disagreement.
- A 6-hour staleness gate was then added (`COMPARABLE_WINDOW_MS`). Result:
  **0 genuinely comparable comparisons out of 300.**

So no lane can reach `ready`, and the one live lane (World of Tanks) was promoted
with an audited manual override. That is not sustainable for 34 lanes.

## What "done" looks like

A design — and ideally an implementation with tests — that lets an operator answer
**"is this lane safe to take over its game?"** with evidence rather than judgement.

You are explicitly allowed to conclude that decision-vs-decision comparison is the
wrong frame and propose something else. Some directions, none of them mandated:

- **Outcome comparison.** Instead of "did both engines decide the same?", ask "did
  the lane's decision produce the same farming/listing outcome?" Slower to
  accumulate, but measures what actually matters.
- **Replay.** Re-run the lane's decision logic against the *historical inputs* the
  legacy engine had at its decision time, rather than against today's state. The
  inputs are largely reconstructable (`AutoFarmTask` stores `demandScore`,
  `internalSales`, `hadResearch`, `decidedAt`).
- **Narrow the comparison to campaigns that ARE re-decided.** Retryable skips get
  re-decided every legacy tick, so those pairs are always fresh. Is that a
  sufficient sample to trust a lane? Argue it either way.
- **Shadow-execute.** Have a shadow lane compute what it would do at the moment the
  legacy engine acts, rather than on its own schedule.

Be honest about the weaknesses of whatever you propose.

## Hard constraints

1. **Never weaken the shadow guarantee.** A shadow lane must never spend a pool
   account, write to a host, or contact a marketplace. Three independent guards
   enforce this today (the lane runner's mode check, plus assertions in
   `steps/execute.js` and `steps/publish.js`). Tests pin them. Do not relax any of
   it to make measurement easier.
2. **Do not reimplement economics.** Demand tiers, the sales boost, probe gates,
   pricing and the holdings gate come from `autoFarmer`/`autoLister` exports. A
   second implementation would silently drift and reintroduce fixed bugs.
3. **Additive changes to legacy files only.** `utils/autoFarmer.js` and
   `utils/autoLister.js` differ between this checkout and production (prod has 79
   and 17 extra lines). Anything beyond adding an export will not deploy safely.
4. **Absence of a field is not a passing value.** This bit twice in one session:
   when a comparison metric changes, rows written before it lack the new field, and
   `!row.newField` reads as "passed". Both filters are now explicit presence checks
   (`d.stale === false`, `d.laneClass`). Preserve that discipline.

## How to verify your work in the sandbox

The full suite runs with no network: `node --test "tests/*.test.js"`.
Currently **650 pass, 1 fails** — `tests/dropSetsListLight.test.js` is a
pre-existing, unrelated failure (it needs `utils/archiveExclusions.js`, which lives
on another branch). Do not try to fix it; do not let it hide a new failure.

`mongodb-memory-server` is available and used by the farm2 tests — you can stand up
a real Mongo in-process and build whatever fixtures you need. See
`tests/farm2Staleness.test.js` for the pattern.

Lint: `npx eslint utils/farm2`.

## Where to look

```
utils/farm2/steps/decide.js   diffAgainstLegacy + COMPARABLE_WINDOW_MS  ← the problem
utils/farm2/index.js          laneReadiness  ← the gate built on it
utils/farm2/lane.js           per-game runner, shadow/live branching
utils/farm2/supervisor.js     scheduling, budget allocation per cycle
utils/farm2/budget.js         the arbiter (sealed allowances, notional fork)
models/FarmJob.js             durable job rows — where comparisons are stored
tests/farm2Staleness.test.js  the staleness cases, with the real production numbers
```

Branch point: `feature/farm2-lane-engine` @ `b995db0`.

## Deliverable

Work on a branch off `b995db0`. Produce:

1. A short written design (what you propose, why, what it can't tell us).
2. An implementation, if the design supports one, with tests.
3. An honest list of what still needs checking against production — you cannot
   verify anything there, and a plausible guess presented as fact is worse than
   saying "this needs confirming on prod."

Your output is a **proposal**, not something that ships. It will be reviewed and
verified against production before any of it is deployed.
