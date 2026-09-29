# Farm2 Lane Engine Verification

**Status: Task Completed**

## Files Collected

### ✅ FARM2-VERIFICATION.md
- **Location:** `/Users/avishkanilupul/projects/nodeserver/_fable/FARM2-VERIFICATION.md`
- **Size:** 347 lines
- **Content:** Complete design document for the farm lane verification harness
- **Status:** Saved locally

### ⏳ farm2-lane-verification-a4e4e21.patch
- **Commit:** a4e4e21
- **Size:** 2,314 lines (99 KB)
- **Files changed:** 7 files, +2,098 −11
- **Applies on:** f7880c9 (via `git am`)
- **Status:** Available in hyperagent thread
  - Design doc + patch download cards: https://hyperagent.com/tasks/cmtmvlyiy043107aduj2u65cm
  - File IDs: `cmtmx3gkq04ye06admtfd4a64` (doc), `cmtmx3gtc059c06adch7ka5d0` (patch)

## Verification Results

- **Tests:** 87/87 passing (farm2 subset only)
  - 63 pre-existing + 24 new tests
  - Full suite: 638/643 (5 pre-existing failures unrelated to this work)
- **Linting:** `npx eslint utils/farm2` — clean
- **Branch:** feature/farm2-lane-verification
- **Constraints respected:**
  - ✓ No deploy
  - ✓ No PR to main
  - ✓ No push to feature/farm2-lane-engine  
  - ✓ autoFarmer.js and autoLister.js untouched

## Key Findings

From FARM2-VERIFICATION.md:

1. **Legacy comparison was broken** — 0 comparable pairs out of 300 due to proxy-based age gate
2. **Proposed solution:** Replay harness using MarketResearchSnapshot + SaleSignal history
3. **Decision gap identified:** Lane only emits 5 of 11 possible decisions (missing 6 gates)
4. **Data quality issue:** demandScore means two different things depending on decision path

## Next Steps

1. Get the patch file from hyperagent (download link in thread)
2. Read FARM2-VERIFICATION.md §7 for production verification requirements
3. Run `node scripts/farm2-replay.js --days 110` on prod to validate coverage assumptions
