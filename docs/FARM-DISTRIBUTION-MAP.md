# How many accounts get farmed — the two live systems, end to end (2026-10-02)

The farm brain (`docs/DEMAND-BRAIN-PLAN.md`, test mode) is meant to become the root of "how many accounts
should be farming each game". This document maps what it would sit on top of, in **production's own
code** (fingerprinted 2026-10-02: `autoFarmer.js` 4,956 lines sha1 5878dd13…, `unclaimedAllocator.js`
d0db38d7, `farmDemand.js` 119faace, `farmSizing.js` 1a0c60a3, `noclaimFleet.js` 6b2671f6,
`farm2/steps/decide.js` 9f8386e3, `settings.js` bb9927c2), with every claim that could be checked
against production data checked read-only. File:line references are to production's copies.

Detailed research notes (three independent read-throughs, ~1,600 lines) were used to build this; the
facts below are the ones that matter for the brain, each re-checked.

---

## 0. One page

| | Auto-farm (claim farm) | No-claim farm |
|---|---|---|
| Unit of decision | **one Twitch campaign** (an `AutoFarmTask`) | one game bucket (Overwatch, Rainbow Six, Call of Duty) |
| Who decides | farm2 lanes (177 live lanes) — and still the legacy engine sometimes (§1.2) | `unclaimedAllocator` hourly (`noclaimAutoSize` on) |
| Demand number | `demandAllocation` → full / half / probe / skip, sized `min(max(target, shelf floor 18), cap)` | `farmDemand.unclaimedDemandSnapshot().target` = `shelfAwareTarget(shelf held, shelf rate, other rate)` |
| What is actually claimed | that number − own unsold holders, ≤ pool budget, ≤ free seats; then **topped up every 10 min toward the stored target** | target − accounts in usable bots, only if the fleet read worked, a campaign is live and the game is not parked; ≤ pool − reserve, ≤ 60 per pass, 70 per bot, 1 new bot per pass |
| After the decision | backfill tops up toward `targetAccounts`; a sell-through loop raises it +3 per tick; demand is **never re-read**; nothing ever shrinks | sold accounts retire from bots (the next pass refills); stopping a bot makes the feeder replace it; nothing shrinks |
| Live today | 28 active tasks, 598 distinct accounts; 6 tasks' targets ratcheted above their plan | Overwatch 646 accounts vs target 250; Rainbow Six 158/158; Call of Duty 9 (parked) |

Both draw from **one pool** (`AvailableAccount`, ~1,320 ready) with one reserve (20) and share settings
keys (`coverageDays`, `coverageSafetyStock`, `coverageMaxPerGame`, `poolReserve`).

The brain today replaces neither system: it computes the demand number for both, beside each system's own,
and logs it. Wiring it in later means replacing **only the demand number**, at the seams in §5, and
changing the few loops that would otherwise override it.

---

## 1. Auto-farm (claim farm)

### 1.1 Inputs
- Campaign catalog: `campaignWatcher` every 10 min (`TwitchCampaign`). Research: hourly scanner by freshness
  (live campaign 6 h). Own sales: `SaleSignal` `connected` + `listing_sold`, 45 days, one per account or
  dedupe key (`autoFarmer.js:370-426`) — **no Eldorado / PlayerAuctions / G2G / ZeusX records**; those sales
  are seen only if the buyer later links the account.

### 1.2 Which engine decides
- farm2 main mode is on: every game with a live claimable campaign has a live lane (177, all `live/idle`), each
  re-run about every 5 minutes (`supervisor.js:60-155`, `lane.js:499-519`).
- **The legacy engine still decides some campaigns** (lanes off/shadow/paused, game names with no Latin
  letters, and the first legacy tick after a boot or an `ownership.invalidate()` — an empty ownership cache
  answers "not owned" on purpose, `ownership.js:118-136`). Measured: 20 legacy decisions since main mode
  started (2026-09-06), the latest today with 19 accounts. Today's two deploy restarts (01:55 and 05:53 UTC)
  caused **none** (0 decisions in the 15 minutes after each).
- farm2 never reads `autoFarm.enabled`; turning that off stops only the legacy sweeps.

### 1.3 Gates, in order (same in both engines)
1. demand (`demandAllocation`, with the probe gate: budget of 8 concurrent probes, 90-day cooldown after a
   failed probe) → `skip_low_demand` (final) or `skip_probe_budget` (retried)
2. host reachable
3. **reuse first** — the game's newest task with bots: restart its warm accounts; top up once toward the demand
   target if the campaign is long enough
4. time left ≥ `minHoursLeft` (12 h) unless the game is forced (`forceGames: ["Rainbow Six Siege"]`)
5. coverage — subtract the game's own unsold accounts already holding its drops
6. pool budget, 7. container seats, 8. reuse-only games (11) claim only their own recycled accounts
9. plan → claim (`claimPoolAccounts`: the game's recycled accounts first, then the general ready pool, freshest
   token check first) → containers → `AutoFarmTask` (`targetAccounts = wanted`)

### 1.4 The number (code, verified against production's settings)
```
cap    = min(30 + 2 × sales45, 60), raised by coverage sizing (on: 28 days, 6 safety, ≤ 250); a per-game cap
         in gameAccountCaps replaces it (none set)
target = full tier → cap, half → ceil(cap/2), probe → min(15, cap), else skip
wanted = min(max(target, floor), cap)            floor = marketStockFloor = 18 (probes: 0)
```
The floor is 3 markets × 3 per market × 2 — **it still counts Plati**, which is blocked, so it is 18 where
the markets that can take stock would give 12.

### 1.5 After the decision — the policy that actually sticks
- **Backfill** (every 10 min, `autoFarmer.js:4551-4816`): tops every active task up toward
  `min(max(targetAccounts, floor), cap)`, undoing the coverage subtraction and the budget trim.
- **Refill ratchet** (`autoLister.js:1755-1765`): when a listed task has nothing spare left to sell,
  `targetAccounts = held + 3`, every tick, up to the cap. Live: 6 of 28 active tasks are above their plan
  (Predecessor 3 → 32 on two tasks, Plants on Fire 17 → 34, The Elder Scrolls Online 6 → 18, two 6 → 15).
- An active task **never re-reads demand**; only the cap is re-read. Nothing ever shrinks a task.
- Accounts pulled for dead tokens, suspensions, renter moves or sold-and-dead are refilled by backfill.
- Overlapping campaigns of one game reuse the newest warm task's accounts, so the same logins can sit on two
  active tasks (live: MARVEL Contest of Champions, 2 tasks, 18 shared accounts; Albion, 8 shared).

### 1.6 Who reads what the decision writes
- `targetAccounts`: backfill (enforced), the ratchet, the allocation forecast, the watcher snapshot, the
  price tracker, farm2 replay.
- `assignedAccounts`: **listing quantity** (`autoLister.js:1829-1830`), the public catalog's expected units,
  event bundles, the reseller forecast, completion and recycling.
- `decision`: the probe budget and stop-loss, retry rules, alerts.

---

## 2. No-claim farm

### 2.1 Demand and target
- Evidence (`farmDemand.js:188-339`): the ledger (`UnclaimedAccount` sold — every channel incl. Eldorado,
  PlayerAuctions, G2G, hand sales), `SaleSignal`, swept and hand-sold markers; each account once (by login),
  dated by its first evidence.
- Rates (`:458-499`): shelf markets (Gameflip, GGSel, Plati) at their raw rate; every other sale at an
  **in-stock rate** — sales ÷ the days that had a sale, floored at half the window — taking the larger of 30
  and 14 days.
- Target (`farmSizing.shelfAwareTarget`): `max(accounts listed, shelf rate × 4 weeks) + other rate × 4 weeks + 6`,
  clamped to ≤ 250.

### 2.2 What the allocator actually does with it (`unclaimedAllocator.js`)
- `have` = accounts in **usable** bots, read live from the Contabo host (a bot with no container, stopped by
  the operator, or marked personal is not usable).
- Grow only if the fleet read worked, a campaign is live (any `ACTIVE` campaign — it does not drop
  subscription-only ones, unlike the auto-power watcher) and the game is not parked.
- Budget `min(ready pool − 20, 60)` per pass, split by revenue weight (the first game in the list gets more
  when several need accounts).
- Apply: top up bots with room (≤ 70 each), then at most one new bot per pass.
- Claim order is freshest token check first, so recycled accounts (re-checked on return) tend to go first.

### 2.3 The shelf lever (`unclaimedGameCaps`, Overwatch 50, Rainbow Six 50)
- Caps how many accounts sit on Gameflip/GGSel auto-listings (Plati takes no new stock: blocked). The rest are
  free for Eldorado / PlayerAuctions / G2G, which claim an account only when a buyer pays.
- **The shelf cap is also a hidden fleet lever:** the target contains `max(accounts listed, …)`, so raising a
  cap — or GGSel filling more shelf slots — raises the fleet target one for one. An explicit cap is never
  raised automatically.

### 2.4 After the plan
- Sold accounts are removed from bots (after 1 h, ≤ 60 per pass) → `have` drops → the next pass refills.
- Stopping or marking a bot personal removes its accounts from `have` → the feeder replaces them.
- Expired listings keep their account in the bot; the auto-power watcher starts and parks bots by live streams.

---

## 3. Shared systems

### 3.1 One pool, no partition, no cross-farm budget
- `AvailableAccount.status` is only `available | claimed`; which system owns an account is written only in the
  `claimedNote` text (`auto-farm:`, `noclaim-farm:`, `rented to`, `recycled …`). Every automated claim is one
  atomic row update, and every claimer takes the most recently token-checked accounts first — so a just-returned
  or just-imported account goes to the front of every queue.
- Each system computes "ready − reserve" on its own definition of ready, on its own clock, first come first served:

  | Claimer | Clock | Takes | Reserve |
  |---|---|---|---|
  | auto-farm lanes (fresh + top-ups) | 3 min | ready pool | 20, at execution |
  | auto-farm backfill (incl. games the lanes own) | 10 min | up to ½ of spendable | 20 |
  | no-claim allocator | hourly | ≤ 60 per pass | 20 |
  | rent-farm orders (Eldorado / PA / G2G) | 60 s | **clean accounts only** | **none**; never returned to the pool |
  | Gameflip rent buffer | 15 min | clean accounts | stops at 50 clean |
  | renter manual add, pool claim/unclaim routes | on click | **anything, unconditionally** | none |

  `poolReserve` (20) is the only shared floor; it is checked before claiming, not per claim, and counted over the
  loose "ready" set, so it protects nothing clean. Paid rent-farm orders compete head-on with both farms for clean
  accounts (the 09-21 "No eligible pristine pool accounts" outage).

### 3.2 Capacity
- The only container cap is `maxAutoBots` (12), for the auto-farm only; it counts containers on active tasks on all
  hosts, parked ones included. Seats: auto-farm 120 per container, no-claim 70 per bot, rent stacks 1–100.
- There is **no per-host, RAM or CPU limit** anywhere, and the no-claim farm has no container cap at all (only
  ≤ 60 accounts and ≤ 1 new bot per pass). All three farms run on the same Contabo machine.

### 3.3 Demand inputs
- Research (`marketResearch`, hourly, live games every 6 h) scores Gameflip/GGSel/Plati pages **including our own
  listings**, and `demandAllocation` then adds our own sales again on top.
- The auto-farm's own-sales count cannot see Eldorado/PlayerAuctions/G2G/ZeusX sales when they happen (they are
  recorded as `drop_reserved`, which no demand reader counts). The no-claim feeder sees every market (ledger).
- Demand is consumed in at least nine places in the auto-farm (decide, top-up, cap at execution, backfill,
  farm2's per-game guard, the ratchet, the probe stop-loss, the forecast, replay) — not one.

### 3.4 Loops (production, `server.js`)
Legacy auto-farm tick 10 min · farm2 supervisor 3 min · no-claim allocator hourly (+3 min after boot) · no-claim
auto-power 3 min · stream scout 3 min · campaign catalog 10 min · drop scanner continuous · pool checker 6 h +
every release · host watchdog 5 min · guardian 5 min · unclaimed lister 10 min · Eldorado/Gameflip/PA/G2G
fulfillers 60 s · research scanner hourly · **farm brain hourly (+6 min after boot), reads only**.
None of the farm loops reads anything the brain writes.

### 3.5 Live collisions the brain would one day execute through (mechanisms verified in code)
- The wake/park fix (`fix/wake-park-flap`) is **not deployed**: production's `farmControl` still restarts parked
  bots daily.
- Right after a boot, the farm2 ownership cache is empty, so both engines can decide the same campaign (measured:
  0 such decisions after each of today's three restarts).
- Bot config slots and compose edits are written without a lock; legacy backfill and lane top-ups overwrite
  `assignedAccounts` without concurrency control.
- **`settings.json`**: every writer in the process uses the same temp file name, and a file that fails to parse
  makes every switch silently read its **default** — including `platiEnabled: true`, `enabled: false`,
  `farm2Enabled: false`. Three interrupted writes from 08-31 are still on disk (one torn). Today's file is healthy.

---

## 4. The brain against these systems

### 4.1 What it reproduces exactly
- Auto-farm "today": production's own `probeGate`, `researchForGame`, `internalSalesForGame`,
  `demandAllocation`, then `min(max(target, floor), cap)` — **the same formula as production's `wanted`**,
  checked line by line. None of the 89 live comparisons uses research older than 7 days (when the live
  engine would re-scan first).
- No-claim "today": the feeder's snapshot target; with its own rule the brain's number equals it by construction.

### 4.2 What it deliberately does not model (so its "today" is an *ask*, not spending)
- Reuse, coverage, budget, seats, backfill, the ratchet. "Today asks 910 accounts on live games" is what the
  engine would ask for **a new campaign** of each game now, not what it holds.
- One number per game, while production sizes per campaign (two live campaigns can each ask the full number).
- No-claim: `have`, parked bots, the campaign gate and the budget.

### 4.3 Isolation (verified twice: by grep of production's source and by an independent read-through)
- Nothing in production loads `utils/demandBrain` except the price tracker's route file (boot hook + read-only
  API) and its own two log models. No farm, lister or deliverer reads its collections.
- Every external call it makes is a database read or a pure function; it never calls a marketplace, SSH,
  `freshResearchForGame`, `unclaimedAllocator.plan()` or a settings writer.
- Every check run against production with writes blocked attempted **zero data writes** outside the brain's own
  log; the only blocked attempts were Mongoose's routine collection-exists calls.
- The only shared state is the price-tracker and radar report caches, which only those two pages read.
- Its real cost is CPU, memory and database time in the one process that runs every farm (§4.4).

### 4.4 Measured cost on the live app
Measured on production on 2026-10-02. The probe called an admin-only API (`/api/price-tracker/brain/status`) from
the server itself about 3.5 times a second. Without a session it is answered 401, so each call ran the full
middleware chain and wrote nothing. The `redeemer` process's CPU and memory were sampled every 5 s. Two windows:
a quiet 6 minutes (06:57–07:03 UTC) and the 6 minutes around the 07:29 run.

| | quiet window | window with the run |
|---|---|---|
| requests timed | 1,274 | 1,270 |
| median / p95 | 3.9 / 6.4 ms | 3.7 / 6.2 ms |
| p99 | 25.7 ms | 29.3 ms |
| slowest | 163 ms | 1,292 ms (one request) |
| CPU peak (5 s samples) | 67 % | 85.5 % (07:29:30) |
| memory | 253–435 MB | 270–334 MB |

- A run takes about 3–4 s (3.5, 3.7 and 3.1 s so far), once an hour.
- Typical response times do not change. One request in the run window waited 1.3 s. Its timestamp was not kept, so
  tying it to the run's price-tracker report rebuild is likely but not proven. Memory does not grow.
- About 21 % of the probe's calls in each window were refused with 429. The site-wide limiter (1,000 per IP per
  15 min) stopped the probe after exactly its 1,000th call (1,274 − 1,000 = 274; 1,270 − 1,000 = 270). The probe
  blocked only itself:
  - nginx forwards real client IPs, and logged 0 responses with 429 that day;
  - no local process calls the app;
  - the exact counts show that nothing else shared the probe's bucket.
- Both windows had the same share of 429s, so the comparison is like for like. The 07:29 run fell inside the
  first 1,000 calls.

### 4.5 Is it better than today's logic? (evidence so far)
- **Counting.** Today's auto-farm sales reading, replayed over the last 6 weeks on the same 281 game-weeks,
  forecast 486 sales where 275 happened (+77 %): it counts mass-delist signals and duplicate logins as sales and
  cannot see Eldorado/PA/G2G/ZeusX deliveries. The brain's default (45-day clean average) forecast 360:
  typical error 2.19 vs 2.62 (16 % lower), bias +0.30 vs +0.75.
- **Sizing.** Today's logic asks a flat 30–60 accounts per campaign (or the 18 floor) whatever the game sells; the
  brain asks 4 weeks of sales + 6 (with the same floor). Decisions made 28–60 days ago, against the next 4 weeks of
  real sales (account counts summed per decision, so shared accounts count twice):
  4 farm decisions put 114 accounts on games that sold 15; 13 probes put 216 on games that sold 2; Black Desert
  had 13 decisions on 520 accounts and sold 0.
- **Not yet proven:** whether the brain's smaller numbers would lose sales (the forward test, from 2026-10-09), and
  whether market-led calls would sell (needs a small real trial). No-claim: the brain currently equals the
  feeder by design — no improvement claimed there yet.

---

## 5. Wiring the brain in later (after the test week)

### 5.1 The seams
- Auto-farm: `farm2/steps/decide.js:472-478` and `:645-648` **and** the legacy path
  `autoFarmer.js:1789-1811` and `:2170-2174` — in one deploy, or legacy decides with the old number.
- No-claim: the row source at `unclaimedAllocator.js:77` (fleet number), behind a switch with a freshness limit
  and fallback to the snapshot; the shelf rate at `:156` on a **separate** switch.

### 5.2 What must change with it, or it will be overridden
- Backfill's goal and the refill ratchet (they enforce `targetAccounts` and grow it +3 per tick).
- `capForGame` re-clips at execution and in backfill — the brain's number needs to be the cap there too.
- The allocation forecast, farm2 replay / `decisionInputs` (version bump), the per-game budget guard.
- The probe stop-loss counts SaleSignal sales only: a probe whose sales are on Eldorado/PA/G2G/ZeusX would be
  stopped and cooled down for 90 days.
- A per-game brain number must become per-campaign targets (e.g. brain target − accounts already on the game's
  other active tasks), or concurrent campaigns multiply it.
- Keep the old `demandAllocation` exported under another name, or the brain's own "today" baseline silently
  becomes the brain.

### 5.3 What must stay exactly as it is
Host gate, reuse-first and re-arm, time gate and forced games, coverage fail-closed guards, the pool reserve
and ready-pool filters (fresh-account gate, manual-sold, unclaimed drops), `soldGames` filters, unrecyclable
logins, capacity, reuse-only claims, the ownership fail-safe, retryable skip shapes (never an ACTIVE row with 0
accounts), listing split and delivery picking (twins, listed logins, rented), the Plati block, the GGSel delist
route, manual listings never repriced, dry-run; for no-claim the fleet read, usable/parked/campaign gates,
budget, explicit shelf caps, and all of the fleet's claim/top-up/create machinery.

### 5.4 Decisions only the owner can make
1. Is the brain's number a **stock level per game** to hold, or a **farm count per campaign** (production's
   meaning today)?
2. Keep the +3 refill ratchet and the floor of 18 (which counts blocked Plati)?
3. Should accounts already holding a game's drops durably reduce its target? (Backfill undoes it today.)
4. Should one-day hand or bulk-pack sales drive no-claim fleet growth? (Today a burst of N reads as N a week
   for two weeks.)
5. Should the shelf cap feed the fleet target?
6. On a brain failure: fall back to today's number, or grow nothing?

---

## 6. Defects found in the live systems (not caused by the brain), with measured size

| # | System | Finding | Measured on production | Risk |
|---|---|---|---|---|
| 1 | no-claim feeder | Rollback releases the wrong pool rows when a duplicate is skipped mid-batch, and releases every claimed row if the bot restart fails after the config was written — leaving accounts in a bot but marked free (`unclaimedAllocator.js:429-444`, `noclaimFleet.js:414-468`) | latent: 0 duplicated secrets after the v2 pass (10-01); 0 ready accounts enabled in any bot (09-29) | high if it fires (double-home class) |
| 2 | no-claim feeder | Recycled accounts whose login already has a sold no-claim ledger can never be sold again on any no-claim path, but keep farming | 6 Overwatch accounts in the fleet | low (6 accounts) |
| 3 | no-claim feeder | Claims without a password check; every seller refuses those | 2 of 1,320 ready accounts; 0 in the fleet | latent |
| 4 | no-claim demand | One-day bulk sales read as a week's demand for two weeks (in-stock rule) | Overwatch had 30–36-account days in mid-Sept; the rule lifts Rainbow Six's other-market rate ~58% (16 → 25 a week) | policy |
| 5 | no-claim demand | GGSel/Plati quantity sales counted twice (comma-joined login on the signal) | 11 signals in 30 days on no-claim games | low |
| 6 | no-claim feeder | A provision that keeps failing builds another container-less bot every pass | not seen | latent |
| 7 | no-claim feeder | No health check proves the allocator loop is alive (heartbeat is console-only) | — | medium |
| 8 | auto-farm | The legacy engine still decides some campaigns in main mode | 20 since 09-06, latest today (19 accounts) | medium for wiring |
| 9 | auto-farm | The shelf floor counts blocked Plati (18 instead of 12) | live value 18 | low |
| 10 | auto-farm | Backfill claims skip the `soldGames` filter; farm2 ignores `autoFarm.enabled`; sold accounts stay in `assignedAccounts` | code | low–medium |
| 11 | ops | The daily automatic OS update restarted MongoDB and every PM2 app at 06:23 UTC today (OpenSSL patch) | pm2.log, apt history | medium (unplanned restarts) |
| 12 | settings | A torn `settings.json` silently resets every switch to its default, `platiEnabled: true` included; concurrent in-process writes share one temp file | file healthy today; 3 leftover temp files from 08-31, one torn | low probability, **high impact** (Plati block) |
| 13 | pool | Rent-farm takes clean accounts with no reserve and never returns them; the only reserve (20) protects nothing clean | 09-21 outage on record | medium |
| 14 | pool | Auto-farm backfill ignores `soldGames` (its claim note fails the game regex), so an account can be re-farmed on a game it was sold for | code, verified | medium |
| 15 | pool | The renter manual add and the pool claim/unclaim routes overwrite any claim unconditionally | code | medium (operator action) |
| 16 | capacity | No RAM/host limit; the no-claim farm has no container cap | code | medium |
| 17 | containers | The wake/park fix is not deployed (parked bots restarted daily) | production blob hashes | known, undeployed |
