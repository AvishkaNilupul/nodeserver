# Task: record decision inputs so replay stops guessing

**Sandbox, no production access.** Everything here is solvable without it. Do not
propose steps requiring SSH, a live database, or deploying.

Read `docs/FARM2-VERIFICATION.md` (your own §9) and `docs/FARM2-PLAN.md` first.
Start from the current tip of `feature/farm2-lane-engine`.

---

## Where things stand

Your three-commit series plus the row-field fix are applied, deployed and running
on production. Measured there:

- **Replay: 284 scored of 367, 284 agree, 0 disagree.** The 15 Black Desert false
  positives came back as `agree`, exactly as you predicted. `unreplayable` rose
  11 → 45 — the honest cost you named.
- **Live shadow comparison: 47 comparable, 47 agree, 0 differ**, with the six
  gates in play.
- **Three lanes now pass readiness on their own evidence** (Albion Online,
  Black Desert, Apex Legends — 25/25/23 comparable, 0 disagreements). The gate
  that refused everything now says yes without an override.

The six gates are live. World of Tanks has been on the new engine all day: 99
runs, 22 executions, 0 failures.

## The task: §9.2 — snapshot the decision inputs

Your own words: *"The second is the real fix, and it is small. Replay exists
because the inputs were not recorded; recording them going forward makes replay
exact rather than best-effort."*

Do that. A `decisionInputs` sub-document on `AutoFarmTask`, written at `record()`
time, carrying what the decision actually saw:

- the research values (`demandScore`, `sellers`, `scannedAt`)
- the sales figures (`count`, `avgPrice`) — the values `salesOf()` returned
- an `af` fingerprint covering at least `maxPerGame`, `probeColdStart`,
  `probeSize`, `probeMaxSellers`, `perMarketStock`, `poolReserve`, `minHoursLeft`
- the `probeAllowed` the gate computed
- a schema version, so a later shape change is detectable rather than silent

Then teach `replay.js` to prefer it when present and fall back to reconstruction
when absent, reporting which it used per row (the same discipline as
`salesBasis`). Rows recorded after this ships become `exact` with no
reconstruction at all — which closes §7.3, the settings-versioning hole you
called "the largest unquantified risk in the design".

### Why this matters more than it looks

Every remaining `unreplayable` row is one of these: a sales window that moved, a
missing snapshot, an unreconstructable probe budget. All three vanish for rows
recorded going forward. The 45 unreplayable and 38 partial rows become ~0 for
future decisions.

## Second, smaller: `hadResearch: true` is a lie on one path

You found this and did not fix it. `utils/autoFarmer.js` hardcodes
`hadResearch: true` on the sellability-skip path even when `research` was null,
while every other path writes a truthful `!!research`.

**Handle with care.** This is a behaviour change to `autoFarmer.js`, not an
added export, and production runs a copy 79 lines longer than this checkout.
So:

- make it the **smallest possible** change — the literal `true` becomes
  `!!research`, nothing else
- put it in its **own commit**, separate from the §9.2 work, so it can be
  deployed or held independently
- state in the commit message what else reads `hadResearch`, or say plainly that
  you could not determine it

If you judge the change unsafe from a sandbox, say so and leave it. A clear "I
would not do this without seeing prod" is a better answer than a confident patch.

## Hard constraints

1. **Import, never reimplement.** Adding an export to `autoFarmer.js` is allowed.
   Copying logic into `farm2` is not.
2. **Never weaken the shadow guarantee.** A shadow lane must not spend, write to
   a host, or contact a marketplace. Three independent guards enforce it.
3. **`record()` must stay backward compatible.** Old rows have no
   `decisionInputs`; replay must handle them exactly as it does today.
4. **Absence of a field is never a passing value.** A row without
   `decisionInputs` is "reconstruct it", never "assume it matched". This trap has
   bitten this codebase three times.
5. No deploy, no PR to main, no push to `feature/farm2-lane-engine` or
   `feature/farm2-verification`.

## Delivery — this is the part that went wrong last time

- Deliver as **downloadable patch files**, one per commit, plus a series mbox.
  Publish the **sha256 and line count** of each.
- Thread-text extraction is **not byte-faithful** — a patch re-extracted from
  thread text came back with a different sha256 than you published. Patches must
  travel as files.
- Applying needs `git am -3`; plain `git am` fails on `autoFarmer.js` because of
  the prod drift.

## Verifying in the sandbox

```
node --test "tests/*.test.js"
npx eslint utils/farm2 scripts/farm2-replay.js
```

Current baseline on a clean clone: **708 pass, 1 fail**. The single failure is
`dropSetsListLight.test.js` — it needs `utils/archiveExclusions.js`, which lives
on another branch. Do not chase it, and do not let it mask a new failure. (The
four extra failures you saw last time were orphaned test files, since removed.)

## What to report back

1. What you changed and why.
2. What you could not verify without production — be specific, as you were in
   §7. That section was accurate and it is why your work was trusted.
3. Anything you found while reading that is out of scope. Your last three
   findings of that kind were all real.
