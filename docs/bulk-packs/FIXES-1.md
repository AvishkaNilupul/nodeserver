# Bulk packs — review fixes, round 1 (frozen, 2026-09-30)

Adversarial review proved these defects against the real modules. Each fix below is
binding. CONTRACT.md / MODULES.md still apply; where this file differs, this file
wins. Regression tests must reproduce each scenario and assert the FIXED outcome
(the reviewers' repros: scratchpad `bulkLoopAdversarial.test.js` and
`review-ssm/*.test.js` under
/private/tmp/claude-501/-Users-avishkanilupul-projects-nodeserver/a0b60a49-2d86-41fd-a6d3-5be411f54999/scratchpad/).

## New module: utils/bulkPacks/lock.js (owner: agent X1)
```
withOfferLock(offerId, fn) -> Promise<fn result>
```
In-process FIFO mutex keyed by `String(offerId)` (one PM2 process). Not re-entrant:
a caller must never nest the same id. Errors in `fn` release the lock and propagate.
`__reset()` for tests. EVERY writer of a BulkOffer after its creation runs inside
it and RE-READS the offer (and its row) inside the lock — never a snapshot taken
before the lock: the loop's per-offer pass, send.refill/pause/resume/withdraw/
releaseHeld, withdrawAll (one offer at a time), loop.takeAccountOut.
sendOffer holds the lock for its own new offer id from the moment it is created.

## Loop (owner: X1 — utils/bulkPacks/loop.js)
- **L1** An `on_offer` entry with `keepReserved` = "must leave the pack". Every pass:
  gameflip → treat it as a bad member (reason "taken out by the owner"), attempt
  `markets.withdraw` again until it succeeds; never `clearFlag("withdraw")` while such
  an entry exists. eldorado/g2g → `retireUnits` it again (no-op while not FREE).
- **L2** `RETIRE_GRACE_MS = 15 min`. Closed dropset offers stay in the pass for 24 h
  after `closedAt` (watch window). In reconcile, for entries in state `released`:
  a NOT-FREE copy on the row → the account was delivered after we released it:
  entry → `delivered`, count the sale, try to re-reserve it for the set
  (`dropReservation.reserveSetOnAccount(accountId, set, {soldToUsername: market,
  soldSetId})`, result recorded) and ALWAYS alert ("released account X was
  delivered after release — check it is not sold twice"). A FREE copy of a
  released entry → conditional `$pull` (zombie), no release.
- **L3** Per-offer pass = `withOfferLock(id, () => maintainOfferLocked(id, ctx))`,
  which re-reads the offer fresh. `pushUnit` (clobber heal) only if the entry is still
  `on_offer` and `keepReserved !== true` in a FRESH read; `releaseEntry` re-reads
  `keepReserved` fresh.
- **L4** `takeAccountOut` picks the entry `on_offer` first, then `retiring`, never an
  older `released`/`delivered` one when a live one exists. Runs under the lock.
- **L6** A capacity read with `error` → skip the farm capacity sync this pass
  (no pause/resume/requantify), note a loop error only.
- **L7** `takeAccountOut` (eldorado/g2g): after retiring, `free` = FREE row units whose
  entry is `on_offer` (retiring excluded). `free >= minQty` → `setQuantity(free)` +
  `advertisedQty`. Else → `markets.pause` + transition live→paused
  (autoPaused:false, reason "below the minimum after an owner take-out"); the next
  pass turns that into sold_out.
- **L8** Add `attention: String` to BulkOffer (model owner X1). `raiseFlag` /
  `clearFlag` dedupe on `attention` (not `lastError`); `noteLoopError` writes
  `lastError` only. Router/page show `attention` (X4).
- **S1 (loop side)** Farm capacity is SHARED: per pass `available =
  advertisable(cap, bp)`; each open farm offer (state live|paused, sorted by id)
  gets `farmCapacity.shareFor(offerId, ids, available)`; that share drives
  pause/resume/setQuantity (never the full `available`).
- Export `maintainOffer(offerId, {now})` (takes the lock) and keep `runOnce` using it.

## Send (owner: X2 — utils/bulkPacks/send.js)
- **S1** sendFarm / resumeOffer (farm) use the offer's SHARE of capacity counting
  itself as a sharer: `farmCapacity.shareFor(selfId, openFarmIds + self, available)`;
  share < minQty → 409 "capacity is already advertised by N other farm offer(s)".
- **S2/S5** A publish throw is classified by `markets` (below): `err.code ===
  "BULK_PACK_REFUSED"` or `err.outcome === "not_created"` → release as today.
  Anything else (`outcome` "may_be_live" or missing) → HOLD: do not release; keep the
  entries `on_offer`; offer → state "error", open false, `externalId` from
  `err.externalId` if any, lastError "publish outcome unknown — may be live on
  <market> (<id or 'no id'>): check it, then Release held accounts"; Telegram.
- **S3** `ownRow` / `abandonInterruptedSend` / any withdraw path: when `offer.listing`
  is empty, find the row by `bulkOfferId` (as `loop.loadRow` does) before deciding
  there is no row. Never release an entry whose unit is not FREE on that row.
- **S4/S6** refill, pause, resume, withdraw, releaseHeld run under `withOfferLock`
  and re-read state inside it; refill refuses unless state ∈ {live, paused} AND open.
- **S8** resumeOffer: set the quantity FIRST; only if that succeeds, resume.
- **New** `releaseHeld({offerId, confirm, actor})` — `confirm === "RELEASE"` else 400.
  For a CLOSED offer with `on_offer` entries (held after an unknown publish outcome):
  if `externalId` is known → `markets.withdraw` first (a failure → 409, nothing
  released); then mark the held entries `retiring` (changedAt now) so the loop
  releases them after the grace. Exported and routed (X4).

## Stock / capacity / markets (owner: X3)
- **S7** `stock.releaseUnits`: after `releaseSetForAccounts`, re-check
  `isStillOurs`; still ours → it did NOT release → put it in `failed` (retry).
- **S1** `farmCapacity.shareFor(selfId, ids, available) -> integer` — equal split,
  deterministic (reuse `utils/suppliedStock.js` `shareOfShelf`).
- **S2/S5** `markets` publish error classification — every publish function throws
  errors carrying `err.outcome` ∈ {"not_created", "may_be_live"} and `err.externalId`
  when known:
  - Gameflip: a message matching `/Gameflip created (\S+) but could not put it on sale/`
    or `/draft (\S+) discarded/` → try `mp.gameflipDelist(id)` (draft-then-delete);
    success → "not_created"; failure → "may_be_live" + externalId. Any error before a
    listing id exists → "not_created".
  - G2G: `/offer (\S+) did not read back/` → try the g2g delist(id); success →
    "not_created"; failure → "may_be_live" + externalId. Create/PUT failures →
    "not_created" (a draft cannot sell).
  - Eldorado: `err.status` 4xx (incl. 429) → "not_created"; no status / 5xx /
    timeout → "may_be_live" (no id).
  - farm and no-claim publishes: same rules for their market.

## Fulfillers + router + page (owner: X4)
- **L5** A bulk row (`bulkOfferId` set) that cannot fill a paid order must PAGE:
  eldoradoFulfiller units tail "not enough reserved stock" on a bulk row → an error
  string that `alertsOperator` pages on (smallest change: prefix "bulk pack short: "
  and add it to ALERT_REASONS). g2gFulfiller: a bulk row that reaches the
  "manual-delivery listing" skip / `pickStock` null → an alerting outcome instead
  (add to ALERT_SKIPS or return an alerting error). Non-bulk behaviour unchanged.
- Router: `POST /api/bulk-packs/offers/:id/release-held {confirm:"RELEASE"}` →
  `send.releaseHeld`; offer views include `attention`.
- Page: show `attention` next to `lastError`; on a closed offer that still holds
  entries (`freeCount > 0` or reserved on_offer) show "Release held accounts…" with a
  typed confirm "RELEASE", explaining: "Only after you checked the marketplace: the
  offer is NOT live."

## Existing-system items from review 3 (owner: X4, with L5 above)
- **R3-1 Demand double count.** `utils/saleLearning.js recordListingSale` gains
  `accountIds` (like `logins`): unit i gets `account: accountIds[i]` when given.
  `utils/gameflipFulfiller.js` sale learning passes the pack's `units[].accountId`.
  Non-bulk calls unchanged.
- **R3-3 No-claim pack below its minimum.** In `eldoradoFulfiller.syncBundleStock` and
  `g2gFulfiller.syncStock`: for a row with `bulkOfferId`, look up the BulkOffer's
  `minQty` (one findById, lean, projected); `real < minQty` → treat as `real = 0`
  (pause via the existing autoPaused path; it resumes when `real >= minQty`).
- **R3-4 Eldorado keep-alive vs a bulk pause.** Wherever the Eldorado keep-alive /
  renewal resumes an offer, first check `BulkOffer.exists({externalId: offerId,
  state: {$ne: "live"}})` (and for rows, `bulkOfferId` → that offer's state): a bulk
  offer that is not "live" is never resumed by it.
- **R3-5 G2G unreadable-password branch** (`g2gFulfiller.js` ~569-584): on a bulk row,
  never call the tag-wide `releaseAccountsForTag`; leave the unit for the bulk loop's
  health check (it retires "no password" units) and return an alerting error.
- **R3-8 System health false alarms** (`utils/systemHealth.js`): the overpriced-listing
  check and the "we say active, Eldorado does not" check skip rows with `bulkOfferId`.
