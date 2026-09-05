# FARM2 TASK — the reuse account gap: is the shadow comparison self-defeating?

**Status:** open question, blocking 3 lane promotions
**Written:** 2026-09-05, from live prod data
**Audience:** Fable 5.1 (sandboxed). You cannot reach prod. Everything you need to
reason about is in this document plus the repo files it names.

---

## 0. Hard limits (these override any capability you have)

1. **Do not touch the unclaimed farm system.** Not `utils/unclaimedLister.js`, not
   `routes/unclaimed*`, not `models/UnclaimedAccount.js`. It is a separate live
   subsystem and is out of scope. Verify byte-identical if you touch anything nearby.
2. **Do not rewrite the economics.** `utils/farm2/*` contains NO economics by design —
   it imports `demandAllocation`, `capForGame`, `salesOf`, `fairShare`,
   `researchForGame`, `internalSalesForGame`, `countReadyPool`, `marketStockFloor` from
   `utils/autoFarmer.js`. Reimplementing any of that reintroduces bugs that took weeks
   to find. Only scheduling / isolation / measurement may change.
3. **Patches must be `git format-patch` files, and you must publish the sha256.**
   Thread-text extraction is not byte-faithful — a re-extracted patch came out with a
   different hash last time. The patch travels as a downloaded file.
4. **`git am -3` is required.** Prod's `utils/autoFarmer.js` is ~79 lines longer than
   any git ref (prod-only catalog integration). Do not assume line numbers.
5. **Answer the question before writing code.** If the conclusion is "the measurement
   is wrong, the engine is right", the correct deliverable is a measurement change, not
   an engine change. Say so plainly rather than producing a patch to look productive.

---

## 1. The situation

`utils/farm2/` is a lane engine that is replacing `autoFarmer.runOnce()`'s single
900-line serial tick. It owns three phases (decide → execute → list) for games whose
lane is `mode: "live"`. The legacy engine still owns the other ~15 phases for every
game, including live ones. A lane in `mode: "shadow"` runs the full decision pipeline
and records what it *would* do, with zero side effects.

Promotion from shadow to live is gated on shadow evidence: the lane's decision is
diffed against what the legacy engine actually decided for the same campaign
(`diffAgainstLegacy` in `utils/farm2/steps/decide.js`). A disagreement on **action
class** (`spend` / `reuse` / `skip`) blocks promotion. A difference in **account
count** is reported separately as a non-blocking warning, on the stated reasoning
that "the arbiter divides the pool differently from a serial pass".

As of today 6 lanes are live (Albion Online, World of Tanks, Apex Legends, SMITE 2,
Tanks Blitz, Warframe) and 29 are in shadow.

## 2. The finding

Across every comparable (non-stale) shadow row on prod, grouped by lane:

```
lane                         comp agree  rows<=-10  rows>=+10  worstDelta  avgDelta
world of tanks                  126   126          0         84         +18     +12.0
apex legends                     91    91          0          0           0       0.0
albion online                    90    90          0          0           0       0.0
black desert                     78    78         35          0         -40     -17.9
marvel contest of champions      66    66         18          0         -18      -4.9
tanks blitz                      37    37          0          0           0       0.0
eve online                       30    30         15          0         -12      -2.5
smite 2                          15    15          0          0           0       0.0
warframe                         13    13          0          0           0       0.0
```

`accountDelta = lane.plannedAccounts - legacy.plannedAccounts`, computed at
`utils/farm2/steps/decide.js:694`.

Every one of these rows **agrees on action class** — all are `reuse_existing` vs
`reuse_existing`. The disagreement is purely in how many accounts each engine planned
to reuse.

The economic consequence if the lane is wrong: `assignedAccounts` is what
`utils/autoLister.js` derives listing quantity from. A lane that reuses 13 accounts
where legacy reused 40 produces a listing a third the size. On Black Desert that is
the difference between a 40-account listing and nothing worth publishing.

Because of this I **held Black Desert, MARVEL Contest of Champions and EVE Online
back** from today's promotion round. That hold is the thing this task should resolve.

## 3. What I have already ruled out

**It is not a difference in the spoken-for logic.** I diffed both. They are identical:

`utils/autoFarmer.js` (legacy inline reuse, ~line 1783):
```js
const spokenFor = new Set();
for (const other of await AutoFarmTask.find(
  { status: { $in: ["active", "planned"] }, _id: { $ne: reusable._id } },
  { assignedAccounts: 1 },
).lean()) {
  for (const u of other.assignedAccounts || []) {
    spokenFor.add(String(u).toLowerCase());
  }
}
const mine = (reusable.assignedAccounts || []).filter(
  (u) => !spokenFor.has(String(u).toLowerCase()),
);
```

`utils/farm2/steps/decide.js` (`reuseCandidate`):
```js
const others = await AutoFarmTask.find(
  { status: { $in: ["active", "planned"] }, _id: { $ne: reusable._id } },
  { assignedAccounts: 1 },
).lean();
const spokenFor = new Set();
for (const t of others) {
  for (const u of t.assignedAccounts || []) spokenFor.add(String(u).toLowerCase());
}
const mine = (reusable.assignedAccounts || []).filter(
  (u) => !spokenFor.has(String(u).toLowerCase()),
);
```

Same query, same scope (note: **no `game` filter** — spoken-for is fleet-wide in both),
same lowercase normalisation, same filter. Given identical inputs these return
identical answers. So the two engines differ only because their **inputs differ**, and
the inputs differ because the two engines ran at different moments.

**The positive deltas are a known artifact.** World of Tanks shows `+18` on 84 rows.
In those rows `legacyPlanned == 0` (16 of 24 in the 1–2h bucket, and so on). This is
the documented trap in `docs/FARM2-TASK-decision-inputs.md`: **AutoFarmTask fields are
not decision inputs.** `record()` is a `$set` upsert, and the `reuse_existing` path
does not write `targetAccounts` and often does not write a meaningful
`plannedAccounts`. Comparing against a field the writer never wrote yields
`lane - 0 = lane`. So `+18` means "legacy recorded nothing", not "legacy planned zero".

Note EVE Online sits in between: roughly half its rows have `legacyPlanned == 0`
(same artifact) and half carry a real number.

## 4. My hypothesis, stated so you can falsify it

**Claim: the negative deltas are an artifact of shadow mode itself, not a lane defect.**

The mechanism:

1. Legacy decides campaign C at time T. At that moment N accounts on the reusable task
   are free, so it plans N and — in the same `record()` write — creates a task holding
   those N accounts.
2. That write is exactly what makes those N accounts `spokenFor`.
3. The shadow lane decides C again at T+Δ. It now correctly sees those N accounts as
   taken by another active task, and plans fewer.
4. The lane is **right for its moment**. Legacy was **right for its moment**. The
   input changed because *legacy's own execution changed it*.

If this is true, then **a shadow lane can never match legacy on reuse account counts
for a game legacy is actively farming** — the measurement destroys what it measures.
And critically: if the lane owned the game, it would be the engine deciding *first*,
and it would get the N accounts.

### Evidence for the claim

Bucketing Black Desert's comparable rows by the age of the legacy decision they are
compared against:

```
age     n   avgDelta  delta==0
<1h    12     -26.7         4
1-2h   21     -24.8         8
2-3h   16     -27.5         5
3-4h   10     -12.0         7
4-5h    8       0.0         8
5-6h   11       0.0        11
```

MARVEL Contest of Champions shows the same shape at smaller magnitude. Note the delta
appears **immediately** (it is already -26.7 at age < 1h) and does not grow with age —
consistent with "legacy's own write caused it at T", not with "the world drifted".

### Evidence against the claim (do not skip this)

I have not verified that the accounts the lane excludes are the *same* accounts legacy
counted. It is possible that:

- The reusable task the lane picks (`reusableTaskForGame`) is a **different task** from
  the one legacy reused, with a different account set.
- Black Desert has 40 accounts on one active task — an unusually large set — and its
  `-40` worst case means the lane found **zero** free. Zero is a suspicious number.
  A live lane planning 0 would produce the `reuse_existing / 0 accounts` shape, which
  is legal (Albion produces it routinely, in both engines) but sells nothing.
- I have not checked whether `reusableTaskForGame` can return a task whose accounts are
  wholly spoken-for while a *better* reuse target exists.

## 5. What to determine

In priority order:

1. **Is the claim in §4 true?** If yes, the account-delta warning is measuring
   something structurally unmeasurable in shadow mode, and it should either be dropped
   or replaced with a comparison that holds the world still.
2. **If it is true, what is the right measurement?** Note the project already solved
   the analogous problem once: `utils/farm2/replay.js` reconstructs the inputs legacy
   had *at its decision moment* and re-runs the lane's economics against them
   (305 scored / 305 agree / 0 disagree). The obvious candidate is to extend replay to
   also reconstruct the spoken-for set at time T and compare account counts there.
   Assess whether that is feasible — `AutoFarmTask` rows mutate, so reconstructing a
   historical spoken-for set may not be possible from stored state. Say so if not.
3. **Is `reusableTaskForGame` picking the best reuse target?** Specifically: when the
   chosen task's accounts are entirely spoken-for, is there another task for the same
   game whose accounts are free? If so, the lane is leaving accounts on the table and
   that IS a real defect worth a patch.
4. **Should `plannedAccounts` be the compared field at all?** Given §3, it is unwritten
   on some reuse paths. `assignedAccounts.length` may be the honest field. Check what
   each path actually writes before proposing this.

## 6. Deliverable

A short written answer to §5.1 and §5.2 first — I will verify it against prod before
anything is applied. Then, only if warranted:

- a patch to the comparison/measurement (likely `utils/farm2/steps/decide.js` and/or
  `utils/farm2/index.js` readiness warnings), and/or
- a patch to `reuseCandidate` if §5.3 finds a real target-selection defect,
- with tests in `tests/farm2*.test.js` style (mongodb-memory-server, offline).

Do not bundle unrelated changes. The last collaboration produced a commit of 257 files
because `.graphify/` and uncommitted WIP were swept in — commit only the files you
intend.

## 7. Reference — files you will need

| File | Why |
|---|---|
| `utils/farm2/steps/decide.js` | `reuseCandidate`, `diffAgainstLegacy`, `accountDelta` |
| `utils/farm2/index.js` | `laneReadiness`, the 10+ account warning (~line 233) |
| `utils/farm2/replay.js` | the existing "hold the world still" harness |
| `utils/autoFarmer.js` | `reusableTaskForGame`, the inline reuse + `spokenFor` (~1783), `record()` |
| `models/AutoFarmTask.js` | which paths write which fields (comments are accurate) |
| `docs/FARM2-TASK-decision-inputs.md` | the "fields are not decision inputs" trap |
| `docs/FARM2-VERIFICATION.md` | how replay verification was built and validated |
