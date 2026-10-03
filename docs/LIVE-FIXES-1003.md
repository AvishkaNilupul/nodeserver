# Live-defect fixes, 2026-10-03 — the frozen contract

Owner asked (2026-10-02 15:38Z): fix all 17 defects in `docs/FARM-DISTRIBUTION-MAP.md` §6, add what is
needed, re-check everything, no bugs. This file is the single spec every implementer codes against.
Do not read sibling implementers' files; code against this contract only.

## 0. Ground rules (every implementer)

- **Tree.** Work only in `/Users/avishkanilupul/projects/nodeserver/.claude/worktrees/live-fixes-1003`.
  Its `models/ routes/ utils/ server.js` are a byte copy of PRODUCTION (commit `40d1fd0`). Line numbers in
  the research notes refer to these bytes.
- **Only edit the files your section owns** (plus new test files named in your section). Never run git
  commands that write (no add/commit/stash/checkout/reset). Never touch production, SSH, the network, or
  the database. Never edit `docs/` except where your section says so.
- **Style.** Match the surrounding code: CommonJS, 2-space indent, the comment density and voice of the
  file (comments explain *why*, with dates where the file does that). No new dependencies.
- **Tests.** `node:test` + `node:assert/strict`, in `tests/<name>.test.js`, no DB, no network: stub
  modules with `require.cache` / `Module._load` the way existing tests do (e.g.
  `tests/unclaimedAllocator.test.js`, `tests/noclaimSoldLeavesBot.test.js`). Run your tests with
  `CRED_SECRET=x node --test tests/<file>.test.js`. Each fix needs at least one test that FAILS on the
  old bytes and passes on yours (say which in your report).
- **Fail-safe direction.** When a new guard cannot read what it needs, prefer the direction that does
  not spend accounts and does not double-home an account; never the direction that strands a paid
  order. Each section names its direction.
- **Report back** (≤ 40 lines): files changed, every exported symbol added/changed, behaviour changes
  that are live by default vs dark, the tests (and which fail on old bytes), anything you could not do.

## 1. Shared settings keys (owned by §A1, read by others)

Added to `AUTO_FARM_DEFAULTS` in `utils/settings.js`, read through `settings.getAutoFarm()`:

| Key | Default | Meaning |
|---|---|---|
| `pristineReserve` | `150` | Pristine pool accounts no FARM may take (rent-farm orders need them). 0 = off. |
| `hostMinFreeMb` | `1500` | A NEW bot container is only created while the host has at least this much `MemAvailable`. 0 = off. |
| `noclaimMaxBots` | `40` | Most no-claim containers (any state) the allocator may own; it creates none beyond. 0 = off. |
| `noclaimBurstGuard` | `false` | Dark switch: one-day hand/bulk sales stop reading as a week's demand (§A4). |
| `platiEnabled` | **`false`** (was `true`) | Default only. Production has it explicitly `false`; the owner blocked Plati 09-28. |

## 2. Shared helper modules (owned by §A5; others call ONLY these signatures)

### `utils/pristineReserve.js` (new)
```js
PRISTINE_CONDITIONS            // plain object: the extra conditions that make a READY row pristine:
                               // { lastCheckStatus: "ok", hasPassword: true,
                               //   dropCount: { $not: { $gt: 0 } }, unclaimedDropCount: { $not: { $gt: 0 } } }
isPristine(doc) -> boolean     // same rule on a fetched pool doc (status/token/manualSold not re-checked)
async farmGuard() -> { reserve, pristine, headroom, protect }   // cached 60 s, module-level, shared by
                               // every farm claimer in the process. pristine = count of READY rows that
                               // match PRISTINE_CONDITIONS (ready = status available, token > "",
                               // lastCheckStatus in ["","ok"], manualSold != true, unclaimedDropCount not > 0).
                               // headroom = pristine - reserve. protect = min(pristine, reserve)
                               // (how many ready rows farms must leave alone). reserve 0 => headroom Infinity, protect 0.
                               // On a count error: FAIL SAFE = { reserve, pristine: null, headroom: 0,
                               // protect: reserve } (treat as "at the reserve": farms skip pristine rows).
async farmClaimFilter() -> object   // {} while headroom > 0, else { $nor: [PRISTINE_CONDITIONS] }.
                               // AND it into a farm's claim query: { $and: [query, await farmClaimFilter()] }
noteClaimed(doc)               // call after EVERY successful farm claim; if isPristine(doc) the cached
                               // pristine count drops by one, so a burst cannot dig below the reserve
                               // between two 60-s refreshes.
_resetForTests()
```
Farms = auto-farm (`claimPoolAccounts`: legacy decide, Approve, farm2 fresh + top-up, backfill) and the
no-claim feeder (`noclaimFleet.claimForGame`). NOT farms (never call it): rent-farm/renter/coworker
(`operatorFarm`, `movePoolAccountToRenter`), the Gameflip buffer, operator routes, the stock hold.

### `utils/hostCapacity.js` (new)
```js
async memAvailableMb(hostId) -> number|null   // one read of /proc/meminfo MemAvailable:
                               // const hosts = require("./botHosts"); const h = hosts.resolveHost(hostId);
                               // hosts.runShell(h, "awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo",
                               // { timeout: 15000 }) — cached 60 s per host id. null on any error.
async newContainerAllowed(hostId) -> { ok, availableMb, minFreeMb, reason }
                               // minFreeMb = settings.getAutoFarm().hostMinFreeMb (0 = off -> ok).
                               // FAIL OPEN on an unreadable host (ok: true, reason "RAM unknown"): the
                               // create itself needs the same SSH and fails loudly on its own.
lastReading(hostId) -> { availableMb, at } | null   // cached value only, never SSH (for the health page)
_resetForTests()
```

## 3. Health hooks (each owner exports; §A6 consumes; all synchronous, never throw)

| Module | Export | Returns |
|---|---|---|
| `utils/unclaimedAllocator.js` (§A2) | `status()` (exists — keep its shape, add fields if needed) | must include `lastRun` (Date or null) and `intervalMin` (number) |
| `utils/autoFarmer.js` (§A3) | `loopStatus()` | `{ lastTickAt: Date|null, intervalMin: 10, enabled: bool }` |
| `utils/farm2/supervisor.js` (§A3) | `loopStatus()` | `{ lastRun: Date|null, intervalMin: 3, enabled: bool }` (enabled = farm2Enabled) |
| `utils/demandBrain/index.js` (§A8) | `loopStatus()` | `{ lastRunAt: Date|null, intervalMin, enabled }` |

## A1 — settings that cannot tear or wipe (defect 12) — owns `utils/settings.js`

Today `saveSettings` writes `settings.json.tmp-<pid>` then renames; two saves in one process share that
temp file (a torn `settings.json`), `loadSettings` returns DEFAULTS on any parse error, and the next save
writes those defaults back — wiping `marketplaces` credentials and turning `platiEnabled` on.
External modules call `loadSettings()` / `saveSettings(s)` directly (`marketplaces.js`, `g2gInbox.js`,
`priceTracker/index.js`, `paSessionInstallRoutes.js`), so the fix must live entirely inside settings.js
with the same signatures.

1. **Serialize** every save in-process (one promise chain). A failed save must not wedge the chain.
2. **Three-way merge on save (no lost updates).** `loadSettings()` remembers, per returned object (a
   `WeakMap` → the raw file text it was parsed from, or the DEFAULTS marker when it came from a fallback).
   `saveSettings(s)`, inside the chain: re-read the CURRENT file (`theirs`), parse the remembered text
   (`base`), and apply `ours − base` onto `theirs` — recursive over plain objects, arrays and scalars are
   leaf values, a key present in base but absent in ours is a deletion. If `s` was not produced by
   `loadSettings` (no WeakMap entry), write it whole (today's behaviour). Write `{...DEFAULTS, ...merged}`.
3. **Atomic, unique temp:** `settings.json.tmp-<pid>-<counter>-<rand>`, write + `fsync` + close, rename.
   On any error remove the temp file.
4. **Last-known-good:** keep the last successfully parsed text in memory; after every successful save also
   refresh `settings.json.bak` (same atomic temp+rename).
5. **Load fallback** on a read/parse error: in-memory last-good → `settings.json.bak` (if it parses) →
   DEFAULTS. ENOENT with no last-good and no .bak = a fresh install → DEFAULTS, silently. Any OTHER path to
   DEFAULTS is a corrupt file: log once per minute (`console.error`) and best-effort
   `require("./systemLog").logEvent({category:"settings", action:"settings_corrupt", ...})` lazily.
6. **Never write over an unreadable file from defaults:** if the current file exists but cannot be parsed
   and the merge base would be DEFAULTS (no last-good, no .bak), `saveSettings` throws
   (`err.code = "SETTINGS_CORRUPT"`) instead of writing. With a last-good/.bak, it uses that as `theirs`
   (self-heals the file).
7. `platiEnabled` default `false`; add the four new keys of §1 to `AUTO_FARM_DEFAULTS` with a one-line
   comment each.
8. Tests (`tests/settingsSafeWrite.test.js`; point the module at a temp dir — check how settings.js picks
   `settingsFile`; if it is hard-wired, add an env override `SETTINGS_FILE` used only when set):
   concurrent `setAutoFarm({a})` + `setAutoFarm({b})` both land; a `marketplaces` write racing a
   `setAutoFarm` keeps both; a torn file → load falls back to .bak, a save heals the file; torn file with
   no .bak → load returns defaults with `platiEnabled:false` and save throws `SETTINGS_CORRUPT`; deletion
   of a key survives the merge; temp files never left behind; ENOENT → defaults, save creates the file.

## A2 — no-claim feeder (defects 1, 2, 3, 6, 16-no-claim, 13-hook, 7-hook) — owns `utils/noclaimFleet.js`, `utils/unclaimedAllocator.js`

1. **Claim filter** (`readyPoolQuery` / `claimForGame`): require a password — mirror EXACTLY the
   predicate the no-claim sellers use to refuse a password-less account (`unclaimedAutoList.js` scan
   ~4601, `noclaimHoldings.js` ~203, `noclaimStock.js` ~347; read them, pick the same fields). Exclude
   logins that hold a no-claim ledger (`UnclaimedAccount`) in the statuses those sellers treat as
   committed/unsellable (read `noclaimHoldings.js` ~211-218 and the scan skip ~4497-4501 to get the exact
   status set and whether it is per login or per login+game; mirror it). Build that exclusion once per
   `claimForGame` call (`usernameLower: { $nin: [...] }`, lower-cased). `spendable()` uses the same filters
   so the budget counts only claimable rows. AND in `await pristineReserve.farmClaimFilter()` and call
   `pristineReserve.noteClaimed(doc)` after each claim (§2).
2. **Rollback that never releases an in-config account** (defect 1):
   - `release()` only flips rows that are still `status:"claimed"` AND whose `claimedNote` starts with the
     no-claim prefix — never another system's row.
   - `topUpBot` returns `{ added, total, presentIds, absentIds }`: `presentIds` = ids of the given docs
     whose ClientSecret is in the config after the call (newly added OR already there — an already-present
     secret means the row IS in this bot and must stay claimed); `absentIds` = the rest. A docker
     restart failure after a landed write is NOT an error: return normally with `restartError`.
     A write that throws: re-read the config once; if readable, compute present/absent from it and
     return with `writeError`; if not readable, throw an error with `err.unknownState = true`.
   - Allocator top-up: release ONLY `absentIds`. On an error with `unknownState`, release NOTHING, keep
     going to the next game, and `logEvent({category:"noclaim", action:"topup_state_unknown", ...})`
     naming the bot and logins (orphan-safe: a claimed row that is in no bot is recoverable; an available
     row that is in a bot is a double-home).
   - `createBot`: split the config write from the provision launch. Once the config write has landed,
     never release; a failed launch returns `{ id, claimed, game, provisionError }` (the stuck-provision
     rule below handles it). A config write that throws → probe whether the config file now exists with
     those secrets; release only if it does not; if the probe fails, release nothing + `topup_state_unknown`.
3. **Stuck provisions do not snowball** (defect 6): in `plan()`, classify each bot: personal marker →
   personal; `.operatoroff` → operator-off (both: not supply, never fed — as today); no container AND no
   marker → **stuck** (counted in `have`/`assigned` for its bucket so the need does not grow, never fed,
   and the bucket gets `stuck: [ids]`). `apply()` never creates a bot for a bucket with `stuck` ids;
   `logEvent` `noclaim/provision_stuck` + one Telegram per bot id per process ("bot N has no container —
   not creating another"). Keep today's parked rule for buckets whose bots are all personal/off.
   Also in the provision script: when the image already exists, do not run the git fetch/clone/build
   steps at all (a fork fetch failure must not stop a container whose image is present).
4. **Caps on new containers** (defect 16): `createBot` refuses (409, clear message) when the no-claim
   container count (bots with any container state other than "none", from `readFleet`, or a fresh
   `docker ps -a` count — reuse what is cheapest and already available) is `>= noclaimMaxBots` (0 = off),
   or when `hostCapacity.newContainerAllowed("contabo" host id used by this module)` says no. The allocator
   checks the same two things before trying, and records why in its result instead of erroring.
5. `status()` includes `lastRun` and `intervalMin` (§3).
6. Defect 2's existing victims (accounts already in no-claim bots whose login has a committed ledger):
   do NOT build a mover. Add to `plan()` a count `deadWeight` per bucket if it can be computed from data
   the plan already has without new SSH/DB fan-out; otherwise skip and say so in your report.
7. Tests: duplicate-in-config is kept claimed (fails on old bytes: old code released it); restart failure
   keeps rows claimed; write failure + readable config releases only absent; unreadable → nothing
   released + event; release() ignores a row another system re-claimed; stuck bot counted, no create;
   cap + RAM gate block create with a reason; password-less and committed-ledger rows never claimed;
   pristine filter AND-ed in.

## A3 — claim farm (defects 8, 9, 10a, 14, 5-claim, 16-auto-farm, 13-hook) — owns `utils/autoFarmer.js`, `utils/farm2/ownership.js`, `utils/farm2/supervisor.js`, `utils/farm2/budget.js`, `utils/farm2/steps/decide.js`, `utils/farm2/steps/execute.js`

1. **Legacy never decides in a cold ownership window** (defect 8; 20 legacy decisions since 09-06, all
   right after a restart or a lane auto-create, e.g. 10-02 00:01 The Quinfall +19 accounts):
   `ownership.ensureFresh()` (async, never throws): when the engine runs and the kill switch is on and
   the cache is older than TTL, `await refresh()`. The legacy candidate loop awaits it once before the
   loop. If, after that, `ownership.isMain()` is true and the cache is still cold (`cache.at === 0`,
   i.e. the lane table could not be read), the legacy engine makes NO decisions this tick (progress line
   "decisions deferred: lane ownership unknown") — maintenance sweeps still run. Outside main mode the
   old fail-safe stays (legacy decides).
2. **Floor counts only open shelf markets** (defect 9): `marketStockFloor(af)` counts a shelf market only
   when it is switched on (`platiEnabled` for digiseller, `ggselEnabled` for ggsel; gameflip always).
   Production: 18 → 12. Keep the `maxPerGame` clamp.
3. **farm2 obeys the master switch** (defect 10a): `supervisor.runCycle` does nothing (like
   `farm2Enabled !== true`) while `af.enabled === false`. Production has `enabled:true` — no live change.
   Defect 10b (sold accounts stay in `assignedAccounts`) is NOT changed (counting policy for the brain
   wiring; changing it now would grow farming) — leave a one-line comment at the `have` count in backfill.
4. **Backfill respects sold games** (defect 14): backfill always passes the task's game to
   `claimPoolAccounts` so both passes apply the `soldGames` exclusion (reuse-only keeps `recycledOnly`).
   Make the note regex in `claimPoolAccounts` also recognise `auto-farm backfill:` notes.
5. **Quantity-sale double count in the claim farm** (defect 5): in `internalSalesForGame`, a
   `listing_sold` signal whose login holds a comma-joined pool ("a, b, c" — GGSel/Digiseller quantity
   rows) is ONE anonymous unit: if a `connected` signal for the same game names a login from that pool at
   or after the sale, count the pair once; otherwise count the unit once. Mirror
   `utils/priceTracker/games.js` `soldUnion` rule 3 (read it). Measured: 54 such World of Tanks, 20 Albion
   signals in 60 days.
6. **Pristine reserve** (defect 13): `claimPoolAccounts` ANDs `await pristineReserve.farmClaimFilter()`
   into both passes and calls `noteClaimed` per claimed doc. Every place that turns `countReadyPool()` into
   a spendable budget for a FARM claim (executeTask, backfill, legacy decide, farm2 budget) subtracts
   `(await pristineReserve.farmGuard()).protect`. Display-only counts stay as they are.
7. **RAM gate on new containers** (defect 16): wherever a free-container count is derived from
   `maxAutoBots` (legacy decide/execute/backfill, farm2 budget/decide), the containers term is 0 while
   `hostCapacity.newContainerAllowed(farmHostId)` says no. Seats in existing containers stay usable.
8. **No restart of a stopped bot from the engine:** the `docker restart` near production line ~3104 (see
   memory: "autoFarmer.js:3104 also docker restart possibly-parked bots") must use
   `require("./farmControl").restartIfRunning(host, container)` (§A7 adds it: returns
   `{ restarted, state }`; a stopped container is left stopped).
9. `loopStatus()` exports (§3).
10. Tests: cold cache in main mode → legacy defers (old bytes: decides); warm cache → same as before;
    floor 12 with Plati off, 18 with all three on; supervisor idle when enabled=false; backfill claim gets
    the game (soldGames exclusion present in the query); comma unit + later connection = 1 (old: 2);
    pristine filter AND-ed and protect subtracted; RAM gate zeroes new containers only.

## A4 — no-claim demand evidence (defects 5, 4) — owns `utils/farmDemand.js`

1. **Double count** (defect 5): in `saleEvidenceByBucket`, drop `listing_sold` signals whose login is a
   comma-joined pool — every no-claim quantity sale already has a victim ledger row (research §1.1).
   Keep a count of dropped signals in the returned diagnostics if the function returns any.
2. **Burst guard, dark** (defect 4): new option `burstGuard` on `demandRates(...)` (and threaded through
   `unclaimedDemandSnapshot`), default `settings.getAutoFarm().noclaimBurstGuard === true` (false today).
   When on, sales whose market is a hand sale (`manual`) or a bulk pack (find how packs record their
   market — `bulkPacks`/`noclaimStock` commitLedger; mirror it) are counted RAW over the window (n×7/W),
   never through the in-stock correction; other "other-market" sales keep `inStockRate`. Export the
   option so the brain can compute the guarded variant without flipping the switch.
3. Tests: comma signal + victim ledger → 1 unit (old: 2); burstGuard off → identical numbers to old
   bytes on a fixture; on → a 40-account one-day manual burst no longer reads as 40/week.

## A5 — helpers + operator routes (defects 13, 15, 16-helper) — owns NEW `utils/pristineReserve.js`, NEW `utils/hostCapacity.js`, `routes/accountPoolRoutes.js`, `routes/renterAdminRoutes.js`

1. The two helpers exactly as §2, with tests.
2. **Pool claim/unclaim routes** (defect 15): claim = conditional (`{_id, status:"available"}`); already
   claimed → 409 "Already claimed (<note>)". Unclaim refuses with 409 and a plain reason when the row is
   held by a live owner: note `rented to …` with an active `RenterAccount` for that login/token; note
   `noclaim-farm:` ("release it from the No-claim farm page so it leaves its bot first"); note
   `unclaimed stock —` (held stock); note `auto-farm…` while the login is in an `active` AutoFarmTask's
   `assignedAccounts`. Otherwise unclaim as today. The page already toasts `message` on a non-2xx.
3. **Renter manual add / Quick farm** (defect 15): BEFORE any config write, read the pool row by
   `usernameLower`; if it is `claimed` and its note does not start with `rented to ` → 409 naming the
   owner note, nothing written. Renter-to-renter moves keep working.
4. Tests for both routes with stubbed models (mount the router in a bare express app with a stub
   session, like other route tests in `tests/`).

## A6 — health covers every loop (defect 7) — owns `utils/systemHealth.js`

Add checks using ONLY the §3 hooks and `hostCapacity.lastReading` (no new SSH/DB fan-out): each loop is
ok when its last run is within 2.5 × interval, warn up to 6 ×, fail beyond (allow a 15-min boot grace;
a disabled loop is "off", not failing; the brain only when enabled). Host RAM: warn below
`hostMinFreeMb × 1.5`, fail below `hostMinFreeMb`, "unknown" when no reading. Follow the file's existing
check shape and `basis` wording. Tests in `tests/systemHealthLoops.test.js`.

## A7 — wake/park fix (defect 17) — owns `utils/farmControl.js`, `utils/botHosts.js`, `utils/botWaker.js` + the branch's tests

Branch `origin/fix/wake-park-flap` `1a79d93` (base `1a79d93~1`: farmControl `d3bb1ceb` == prod, botWaker
`6a9f4228` == prod, botHosts `c925b474` ≠ prod `381e8cd1`). Apply farmControl + botWaker as the branch
has them; three-way merge botHosts (`git merge-file` with base = `git show 1a79d93~1:utils/botHosts.js`,
ours = the worktree file, theirs = `git show 1a79d93:utils/botHosts.js` — write temp copies in the
scratchpad, not in the tree) and resolve by hand keeping every prod-only hunk. Copy the branch's three
test files into `tests/`. Then REVIEW the change adversarially (could any path now leave a bot running
that should park, or never wake one that should farm? does the observer add SSH load?) and fix real
problems. `restartIfRunning(host, container)` must be exported (A3 uses it).

## A8 — the farm brain (research + "new drops") — owns `utils/demandBrain/*`, its tests, `docs/DEMAND-BRAIN-PLAN.md`

1. **Intermittent-demand estimators**: add `sba` (Croston, Syntetos–Boylan corrected, α = 0.15) and
   `tsb` (Teunter–Syntetos–Babai, α = β = 0.15) over weekly counts from the same entries the other
   estimators use. Both go into `ESTIMATORS`, the per-row `est`, the backtest and forward scores. Do NOT
   change the defaults (`avg45` / `v2`) — the test week decides.
2. **No-claim burst-guarded variant `v2g`**: the feeder's rates with `farmDemand.demandRates(...,
   {burstGuard: true})` (§A4 API); logged beside `v2`, scored, not the default.
3. **New drops (cold start)** — today a game with a live campaign and no evidence is `unknown` (the brain
   abstains) while the old engine probes 15–18 accounts; of 20 finished probes, 17 expired with 0 sales.
   New class: `probe` (cold) with size `coldProbeSize` (default `perMarketStock × open shelf markets` =
   3 × 2 = 6) when the game has a live campaign, no own sale/listing in history, and is not a known dud
   (a probe of this game expired with 0 sales within `probeCooldownDays`). Rival evidence still upgrades
   to the existing market-led probe. Logged against the old verdict; `MODEL_VERSION` → 2; the summary
   line adds `cold probes N (old asks M)`.
4. Keep every isolation property in `docs/DEMAND-BRAIN-PLAN.md` §6 (reads only; writes only its two
   collections). Update the plan doc's estimator/cold-start sections.
5. Tests for each: SBA/TSB on known series (hand-computed), v2g uses the guard, cold probe rules
   (dud cooldown → skip; rivals → market-led; none → cold 6).

## Decisions taken on the owner's behalf (report them)

- Burst handling (4) ships dark; the brain scores it this week. Changing the live feeder's demand now
  would move the baseline the test compares against.
- Defect 10b left as is (explained above). Defect 11 (OS auto-update restarts) is a server security
  setting: no code change; fix 8 makes restarts harmless; instructions go to the owner.
- Rent-farm accounts are sold to the buyer by design, so they are never "returned"; the fix for 13 is the
  reserve.

## A9 — price tracker + market radar evidence (independent review, 2026-10-02) — owns `utils/priceTracker/ledger.js`, `utils/priceTracker/games.js`, `utils/marketData/analyze.js`, `utils/marketData/plan.js`, `routes/radarRoutes.js` + new tests

The farm brain reads its claim-farm sales from `games.soldUnion` and its market view from the radar
report, so every fix here changes the brain's evidence — that is intended. Do not edit `utils/demandBrain/*`.
Repro scripts from the review: `scratchpad/verify.js`, `scratchpad/verify2.js` (read them).

1. **Shop / bulk-order sales are demand** (`ledger.js` ~274): a `listing_sold` signal with a
   `reserved:<accountId>:…` dedupeKey and no price (Shop, `marketplace` "shop" or empty) or market "bulk"
   is a paying buyer (`dropReservation.js` ~70-100, callers `shopRoutes.js` ~564, `bulkOrderHealth.js`
   ~235). Put it in `demandOnly` (counts in `soldUnion`, never price evidence), dedupe by its key, and
   keep every `excluded` counter truthful. Measured: 42 such signals in 135 days (last 08-15).
2. **Radar counter rises spanning a gap** (`plan.js` ~370-396, `analyze.js` ~140-178, ~336-339): count only
   the share of a rise's units whose time span [prevObservedAt, at] falls inside the report window
   (pro-rata by time), and make "watched days" agree. A rise with no `prevObservedAt` keeps today's rule.
3. **One GGSel/Digiseller detection = one order for PRICE evidence** (`ledger.js` ~257): units sharing one
   listing and one `at` (one guardian detection) share one `saleGroup`; each unit still counts once in demand.
4. **Gameflip bulk pack of N = N sales, not N+1** (`ledger.js` ~225-245, ~320-347): build the
   already-counted listing set from `sales` AND `demandOnly`; the "sold units have no priced record" count
   must not add the pack's N either.
5. **The burst rule may only drop mass-delist shapes from DEMAND** (`ledger.js` ~375-399): read the guardian's
   own real-sale rule (`marketplaceGuardian.js` ~1001-1002: up to 11 units on 4 or fewer listings is a real
   pass) and drop a burst from demand only when it exceeds that shape; price-evidence exclusion stays as today.
6. **Drops radar unbounded read** (`radarRoutes.js` ~112-138, ~361-416): project only the fields the
   preview uses and read only the tasks/campaigns for the ids in question; same output.
7. Tests (`tests/priceTrackerReviewFixes.test.js`, `tests/radarEventContextBound.test.js`): each item fails
   on old bytes; the existing `priceTracker*`, `marketRadar*` and `radar*` tests keep passing.

## Deploy record (2026-10-03)

- **Deployed 06:48:35Z**, one batch of 36 files (35 runtime + `scripts/repair-unclaimed-cap.js`), commit `3181b93`
  on `fix/live-defects-1003`. Every production file matched the base it was built on (`40d1fd0`) at install time.
  Backup `_deploy_backup_20261003064819_live-fixes-1003` (the three 08-31 `settings.json.tmp-<pid>` leftovers moved
  into its `utils/legacy-settings-tmp/`). Load check passed (14 checks: Plati off, new keys at defaults); one pm2 restart,
  0 unstable.
- **Before deploy:** full suite 2,634 tests — only the 72 failures production's own code already had (plus a
  test-runner IPC flake in `farm2Gates`, 21/21 alone); four review rounds; staging on production data with every
  database and bot-host write blocked (no wakes on deploy, legacy decides 0 of 93 live games, floor 18 → 12, no-claim
  plan unchanged, 12 of 95 games' sales counts corrected, page guard 41/41 on production's pages).
- **After deploy (to 09:28Z):** 0 legacy decisions after the restart; no `topup_state_unknown`, `provision_stuck`,
  `decisions_deferred`, `lane_missing_fallback` or settings events; re-spelt admin URLs answer 401; `settings.json`
  intact (24,813 bytes, all 7 marketplace blocks) with an identical `settings.json.lastgood`; allocator hourly
  (+0, nothing short); farm brain model v2 hourly (~3.8 s); a rent-farm order provisioned normally.
- **Simplified before deploy:** the round-2/3 execute-idempotency machinery was replaced by one guard (a re-run of
  an execute job over an ACTIVE row is a no-op) after round 4 found it could double-list accounts; every other
  execute path is production's. Known residuals (pre-existing): a failed lane reuse retries only within its
  job's 5 attempts, then waits for a rescan; owed bot reloads are in memory (a restart forgets them).
