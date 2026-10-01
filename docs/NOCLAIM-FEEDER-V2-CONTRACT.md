# No-claim feeder v2 — contract

Owner ask, 2026-10-02 JST: *a system like the auto-farm for the no-claim farm,
feeding it accounts from the pool by how much past sales and demand say we need
— mostly R6; Overwatch has a lot of demand. Check whether an old system exists;
fix it or make one.*

## What already existed (kept)

`utils/unclaimedAllocator.js` (ON since 2026-09-08, `noclaimAutoSize`), hourly:
demand snapshot (`utils/farmDemand.js`) → per-game target (`utils/farmSizing.js`)
→ top up existing no-claim bots (≤ `MAX_PER_BOT` 70), at most one new bot per
pass, budget `min(pool spendable, noclaimSizeMaxPerRun 60)`, growth only while
the game has an active drop campaign. Page: Bots → Fleet sizing.

Measured on prod 2026-10-01: it works (30 d: +61 R6, +73 OW accounts, 55 of the
61 R6 ones hold drops). Fleet: R6 118 accounts / 3 bots, OW 652 / 27 bots,
CoD 10 in the parked bot 10. Pool: 1,362 ready, 657 pristine.

## What was wrong (measured)

1. **Sales were dated by whoever last touched them.** `manualSold` was dated by
   the pool row's `updatedAt` and swept rows by `sweptAt`. The 09-28
   sold-account backfill swept 142 sales made days or weeks earlier and stamped
   136 pool rows, so Overwatch read 94.5/week (real: ~60–75).
2. **The target ignored the shelf.** The auto-lister keeps up to
   `unclaimedGameCaps` accounts (R6 50) committed to Gameflip/GGSel, which sell
   R6 ~2–5/week, while R6 sells ~25/week on Eldorado from the rest. The target
   (`rate × 28 d + 6`) treated the 50 parked accounts as cover for Eldorado
   demand, so R6 was ~40 accounts short of what its sales justify.
3. **The shelf advice was backwards.** "shelf cap below target → raise it"
   would move MORE accounts onto the slowest markets.
4. **"Fleet" counted bots that cannot farm.** Personal bots, operator-stopped
   bots and bots with no container counted as supply; and a game whose only bot
   is parked by the owner (CoD bot 10, owner decision 2026-09-20) could be
   "grown" by creating a new container.

## Changes

### D1 — one sale, one date (farmDemand.soldUnitsByBucket)

- Every source is read over the window PLUS 90 days of history.
- Dating sources: ledger `soldAt`; `SaleSignal.at` (`listing_sold`, `connected`).
- Confirming-only sources: `NoclaimSpentAccount` (`sweptAt` = when a bot was
  cleaned) and `AvailableAccount.manualSold` (no date at all).
- A login counts as a sale in the window only when its EARLIEST dating evidence
  is inside the window. A login seen only by confirming sources is reported as
  `undated` and does not drive sizing. Since 2026-09-28 every sale path writes a
  ledger row (`handSellAccounts` included), so only legacy hand sales are undated.
- The sale's market is the market of its earliest dated evidence.

### D2 — in-stock rate

A day with zero sales for a game that sells every day is a stock-out, not a lack
of buyers. For a window of `W` days with `n` dated sales on `s` selling days:
`rate = n / max(s, W/2) × 7` — at most 2× the raw rate. The demand rate is
`max(rate over 30 d, rate over 14 d)`: rising demand shows within two weeks; a
dip never shrinks the target faster than the 30-day window.

### D3 — shelf-aware target (farmSizing.shelfAwareTarget)

- `shelf markets` = gameflip, ggsel, digiseller (accounts committed up front).
- `shelfHeld` = ledger rows `listed` for the game.
- `shelfRate` = RAW rate of sales whose market is a shelf market (a shelf is
  never out of stock), `max(30 d, 14 d)`.
- `otherRate` = in-stock rate (D2) of every other sale (Eldorado,
  PlayerAuctions, G2G, manual).
- `target = max(shelfHeld, ceil(shelfRate × D/7)) + ceil(otherRate × D/7) + safety`,
  clamped to `[min, max]` (`D` = coverage days, 28; safety 6; max 250).
  A game with no dated sale at all still gets the floor only (unchanged rule).
- Shelf advice: `shelf.need = max(0, ceil(shelfRate × D/7) + safety − cap)` —
  the shelf is sized by what the shelf sells.

### F1 — usable fleet (unclaimedAllocator.plan)

- `have` counts accounts in bots that can farm: container exists, no
  `.operatoroff`, no `.personal`. (`.autostopped` is the auto-power park — usable.)
- A game whose bots ALL fail that test is parked by the operator: no top-up, no
  new bot, note "every <game> bot is stopped by you — not grown".
- Heartbeat: `<game> fleet <have>/<target>` plus the stock and the grant.

## Unchanged

Claim order and pool query (recycled accounts may still be in a previous
buyer's hands — not preferred), pool reserve, per-pass budget, one bot per pass,
the active-campaign gate, explicit shelf caps never raised, Pi-unreachable =
no growth, kill switch `noclaimAutoSize`.

## Expected effect on 2026-10-01 data

R6: ~27/week (shelf ~4, other ~23) → target ≈ 50 + 92 + 6 = 148 vs fleet 118 →
+~30 into bots 17/18/21 (room 210, no new container). OW: target capped at 250 vs
fleet 647 → nothing. CoD: parked → nothing. No shelf-cap suggestions.
