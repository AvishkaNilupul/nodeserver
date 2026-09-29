# Bulk packs — review fixes, round 2 (frozen, 2026-09-30)

From the verification of round 1 (repros:
/private/tmp/claude-501/-Users-avishkanilupul-projects-nodeserver/a0b60a49-2d86-41fd-a6d3-5be411f54999/scratchpad/verify2/bulkVerify2.test.js).
FIXES-1 still applies; this file wins where they differ.

## Y1 — utils/bulkPacks/lock.js, utils/bulkPacks/loop.js
- **V1 (loop side)** Farm sharers = open farm offers in state sending | live | paused
  (the same list send.js uses). New export `resplitFarm({now})`: for every open
  farm offer, under its own lock, run the farm capacity sync NOW (ignore the
  farmSyncMinutes throttle), shrinking before growing. It must never be called
  from inside any offer's lock.
- **V2** `lock.tryWithOfferLock(id, fn) -> {ran:boolean, value}`: runs fn only if the
  id is free (no waiting). `runOnce` uses it for every offer: a busy offer (send,
  owner action) is skipped this pass and counted as `busy` in the summary /
  heartbeat. Per offer, `now` = pass `now` + real time elapsed since the pass
  started (tests keep control of the base time), and `bp` is re-read per offer.
- **V3 (loop side)** An offer that is closed or paused by us (state paused,
  sold_out, withdrawn, expired) whose market read says "active" is paused again
  at that read (eldorado/g2g), with a history line. Also: this read happens for
  closed dropset offers inside the watch window.
- **V4** `takeAccountOut` (eldorado/g2g): FIRST lower the market — freeAfter = FREE
  on_offer units excluding the leaving one; freeAfter >= minQty →
  setQuantity(freeAfter), else pause (+ live→paused as in L7) — THEN retire/pull
  the unit. If the quantity/pause call fails, still retire the unit (the account
  was spent) and note the error; the next pass corrects the market.

## Y2 — utils/bulkPacks/send.js, utils/eldoradoFulfiller.js
- **V1 (send side)** After a successful farm send or farm resume — after its own
  lock is released — call `loop.resplitFarm({now})` (lazy require; errors logged,
  never fail the send).
- **V3 (keep-alive side)** In `eldoradoFulfiller` renewOffer: after the relist,
  re-check the bulk state once more; if the bulk offer is no longer "live", pause
  it again immediately (log it). Non-bulk offers unchanged.
- **V5** `releaseHeld`: a withdraw error that means the offer is already not live
  (not found / 404 / must be active / already paused / expired — reuse the
  existing `delistOutcome` classifier used in send.js) → proceed with the release;
  "sold" → refuse (409) and say so; anything else → 409 as today.
