# Fleet sizing — how many accounts a game gets

Built 2026-09-08. **Both switches ship OFF**; with them off, both farming
systems behave exactly as they did before.

## The problem, measured on prod 2026-09-08

Two farming systems, one question, and neither could answer it.

**The auto-farm** sized a game with `capForGame`:

```
cap = min(maxPerGame + 2 × sales45d, maxPerGame × 2)
```

That is a **flat ceiling**. With `maxPerGame: 30` it saturates at 60 from the
15th sale onward, so a game that sold 15 units and a game that sold 202 get the
same cap. Measured the same week: Overwatch 202 sales/30d, Rocket League 83,
Brawlhalla 69 — all treated as identical to a 15-sale game. In 14 days the
engine recorded 236 `skip_low_demand`, 95 `reuse_existing` and **5 `farm`**.

**The no-claim / unclaimed farm** had no sizing at all. The account count was a
number the operator typed into `POST /api/noclaim-farm/bots`. Nothing read a
sale, a stock level or a demand score — verified exhaustively: no demand
reference exists anywhere in `unclaimedAutoList.js`, `unclaimedBundles.js` or
`noclaimWatcher.js`.

And the no-claim games are the best sellers on the business:

| game | sales/30d | /week | sellable stock | days of cover | median time-to-sale |
|---|---|---|---|---|---|
| Overwatch | 206 | 48.1 | 33 | **4.8** | 176h |
| Rainbow Six | 82 | 19.1 | **0** | **0** | **39h** |
| Call of Duty | 5 | 1.2 | 49 | 286 | 53h |

## The model

A sold account is **consumed** — the buyer keeps it — so a game selling N a week
burns N accounts a week. To hold D days of stock you need `N × D/7` accounts,
plus a flat safety buffer for the lumpiness of drop events (a campaign lands all
at once; Rainbow Six moved 30 units at a 39-hour median, then sat at zero).

```
target = ceil(salesPerWeek × coverageDays / 7) + safetyStock
```

Pure functions in `utils/farmSizing.js`, no database, no settings lookups. The
callers supply the measurements; that file supplies the policy.

**A game with no recorded sales gets nothing from this model** — not even the
safety stock. Safety stock stops a *proven* seller rounding down to a useless
number; handing it to unproven games would spend the pool on the whole
catalogue, which is the failure the phantom-demand fix already paid for once.

## TWO LEVERS, NEVER CONFLATED

This is the finding that shaped the whole design.

| lever | what it changes | cost |
|---|---|---|
| **fleet** | accounts farming the game (create a bot / top one up) | pool accounts + Pi RAM |
| **shelf** | accounts allowed on auto-listings (`unclaimedGameCaps`) | nothing |

Overwatch does **not** need more accounts. It has 350 farming against a target
of 199 — 151 spare — and only 33 sellable, because its **shelf cap is 28**. A
sizing system that only knew how to create bots would have burned hundreds of
accounts to fix a problem that is one settings key.

Rainbow Six is the opposite shape: 100 farming against a target of 83, and zero
stock on the shelf.

### A hand-set shelf cap is never raised automatically

`unclaimedGameCaps` is how the operator says *hold this game back*. Overwatch's
28 exists because they hand-sell Overwatch in bulk from the held pile — and the
coverage model only sees automated sales, so it reads that deliberate hold as a
shortage. `apply()` reports the recommendation and refuses to act on an
`explicit` cap unless called with `raiseExplicit: true`. Caps sitting at the
engine default (70) are raised freely; they are nobody's decision.

## Measuring demand: union, then dedupe by login

The no-claim sale evidence is scattered across five places that do not agree,
and three of them were silently unrecorded before this work:

| source | covers | notes |
|---|---|---|
| `UnclaimedAccount` status `sold` | every automated channel — `spendAccount` is the single funnel | the most complete unit count |
| `SaleSignal` `listing_sold` | Gameflip + Digiseller/GGSel only | Eldorado / PlayerAuctions / Z2U / G2G write **no** signal |
| `SaleSignal` `connected` | the drop scanner saw a buyer link the account | proves a sale, names no price |
| `NoclaimSpentAccount` | what the operator swept out of a bot | the only witness for an un-linked hand sale |
| `AvailableAccount.manualSold` | the hand-sold tick | no date of its own |

**176 distinct Overwatch logins connected in 30 days; only 58 have a ledger
row.** Sizing off the ledger alone would have read Overwatch as a 9-sales-a-month
game instead of a ~48-a-week one. So `utils/farmDemand.js` unions every source
and **dedupes by login** — an account sells exactly once, whoever noticed. The
per-source breakdown is kept and shown, so the coverage gaps stay visible instead
of silently shrinking the number.

### Game buckets

A no-claim "game" is a keyword, not a label. `noClaimGames` holds `overwatch`,
which must catch `Overwatch`, `Overwatch 2` and the lowercase spellings alike —
the ledger currently holds 197 `Overwatch` rows and 50 `overwatch` rows, which
without bucketing read as two half-sized games. Matching is exactly
`settings.isNoClaimGame`'s rule (substring of the normalised label), so a game
can never be in a different bucket here than the one the engines put it in.

## Performance: 45.5s → 5.7s

The first version pulled every real sale signal in the window and bucketed them
in JS: **60 seconds**, because it dragged 14,096 documents across the wire (the
Atlas bound here is BYTES RETURNED, not query time). A regex prefilter on
`gameKey` only reached 37s — an unanchored regex cannot *seek* the
`{ gameKey: 1, at: -1 }` index, only scan it.

The fix: resolve the exact `gameKey`s belonging to a no-claim bucket first (a
cheap index-covered `distinct`), then let the database dedupe in an aggregation.
One row per (game, login) — a few hundred instead of fourteen thousand.
**Verified byte-identical results** before and after.

Also added: `UnclaimedAccount` indexes on `{game, soldAt}` and
`{status, soldAt}`. `soldAt` was unindexed and every sell-rate query scanned.

## What changed in the engines

### `utils/autoFarmer.js` — `capForGame(af, internalSales, game)`

`game` is new and optional. **Without it, nothing changes** — that is what every
existing caller got before. With it:

1. an explicit `gameAccountCaps` entry wins over everything, in both directions;
2. if `coverageSizing` is off → the legacy flat clamp, unchanged;
3. if on → `max(legacyCap, coverageTarget)`, bounded by `coverageMaxPerGame`.

**The legacy cap is the FLOOR**, so turning coverage sizing on can only raise a
game's ceiling, never lower one. And it is only a *ceiling*: the demand tiers
still choose the target, the coverage gate still subtracts stock we hold, and
`fairShare`, `poolReserve` and container capacity all still bind afterwards.
Raising a cap does not spend an account.

The sizing policy is read out of the `af` object the caller already holds
(`getFarmSizing(af)`), not from a fresh `settings.json` read — one decision on
one consistent snapshot, and one less disk read per campaign per tick.

`opts.game` is now threaded through `demandAllocation` at all four call sites:
both legacy sites, `farm2/steps/decide.js`, `allocationForecast.js` and
`farm2/replay.js`. The replay one matters — a replay that omitted the game would
score past decisions against a different ceiling and report manufactured
disagreements.

### `utils/farm2/budget.js` — the per-game guard

`perGameCap` was `af.maxPerGame` (the flat 30) while `capForGame` already allowed
a proven seller 60. **A lane that legitimately decided 60 was silently clamped to
30**, so the sales headroom the legacy engine grants was unreachable in the
engine that now does all the deciding. It is now the highest cap any game could
legitimately be given; decide's own per-game number is always the binding one.
The arbiter's total invariant (lanes cannot collectively outspend the cycle
budget) is unchanged and pinned by a test.

### `utils/noclaimFleet.js` — the machinery, extracted

The claim/config/container primitives lived inside `routes/noclaimFarmRoutes.js`,
reachable only by an operator submitting a form. They moved here so the allocator
and the route share ONE implementation — the standing rule is *import, never
reimplement*, and a second copy of the claim path would drift and reintroduce the
bugs the first one has already paid for (the reserve guard, the rollback, the
`soldGames` exclusion, the config permissions).

Two bugs fixed in the move, both found by the audit:

- **Shell injection.** `game` came from the request body and was interpolated
  raw into a double-quoted `echo` inside a nested `sh -c` — a backtick or `$( )`
  in a game name executed on the Pi as root. It is now `hosts.shq`-quoted.
- **No game validation.** Nothing checked that `game` was on `noClaimGames`, so a
  typo built a container farming a game the *auto-farmer* also farms, and the two
  systems would fight over the same campaign — the one thing the no-claim split
  exists to prevent. `assertNoClaimGame` now gates every create.

New capability: **`topUpBot`**. Previously the only way to give a game more
accounts was another container, and containers are the scarce resource (~130MB
of Pi RAM each). Topping a bot from 20 to 50 costs nothing. Done under
`withFileLock` (two concurrent top-ups would both read the old config and the
second write would drop the first one's accounts), skipping duplicates by
`ClientSecret`, and restarting only a container that is **already running** — a
`docker restart` on a stopped bot would fight the auto-power watcher's park.

### `spendAccount` now records the price

`UnclaimedAccount` recorded a sale with five fields and **no money** — `price`
was passed into `ledgerAccount` and never written — so per-game revenue was only
reconstructible by joining the set's *current* listing price, which drifts every
time the repricer runs. Unit counts were exact and revenue was a guess. New
`soldPriceUsd` / `soldMarket`, captured from the row that carried the unit
before it is removed. `0` means "sold, price unknown", deliberately distinct from
a genuine $0.

## Settings

All under `autoFarm`, live-editable, audited by `setAutoFarm`.

| key | default | what |
|---|---|---|
| `coverageSizing` | `false` | auto-farm coverage ceiling |
| `coverageDays` | `28` | days of demand to hold |
| `coverageSafetyStock` | `6` | flat buffer |
| `coverageMaxPerGame` | `250` | blast-radius bound |
| `gameAccountCaps` | `{}` | `{ "rocket league": 120 }` — wins over everything |
| `noclaimAutoSize` | `false` | let the allocator act on its own |
| `noclaimSizeIntervalMin` | `60` | how often |
| `noclaimSizeMaxPerRun` | `60` | rate limit on accounts per pass |
| `noclaimGameSizing` | `{}` | per-game `{ coverageDays, safetyStock, min, max }` |

`HARD_MAX_ACCOUNTS = 600` in `farmSizing.js` bounds every path absolutely,
whatever a caller passes.

## Safety properties

1. **Off by default.** Both switches. With them off the auto-farm cap is the old
   arithmetic and the allocator only measures.
2. **The allocator measures every pass and acts only when told.** The panel and
   the history are worth having either way.
3. **An unknown fleet spends nothing.** If the Pi read fails, `plan()` still
   returns (marked `fleetKnown: false`) and refuses to recommend growth — not
   knowing how many accounts a game already has is exactly when "farm more" is
   dangerous.
4. **Prefer top-ups over containers**, and at most ONE create per pass, because
   provisioning takes a global lock on the Pi and a second create would 409.
5. **Every write goes through `noclaimFleet`**, so the pool reserve, the atomic
   per-account claim, the rollback-on-failure and the config permissions are the
   ones the operator's own form has always used.
6. **`POST /api/farm-sizing/apply` dry-runs unless sent `{apply: true}`.**

## Files

- `utils/farmSizing.js` — the pure model
- `utils/farmDemand.js` — per-game demand + stock, read-only
- `utils/noclaimFleet.js` — the extracted bot machinery
- `utils/unclaimedAllocator.js` — plan / apply / scheduler
- `routes/farmSizingRoutes.js` — `/api/farm-sizing/{settings,plan,apply,autofarm}`
- `public/farm-sizing.html` — the console (nav: Bots → "Fleet sizing")
- `tests/farmSizing.test.js` (16), `tests/farmSizingIntegration.test.js` (26)

Changed: `utils/settings.js` (keys + `getFarmSizing`/`gameAccountCapFor`),
`utils/autoFarmer.js` (`capForGame`, `demandAllocation`), `utils/farm2/budget.js`
(`perGameCap`), `utils/farm2/steps/decide.js` + `utils/farm2/replay.js` +
`utils/allocationForecast.js` (thread `game`), `utils/unclaimedAutoList.js`
(record the sale price), `models/UnclaimedAccount.js` (price + indexes),
`routes/noclaimFarmRoutes.js` (delegate to `noclaimFleet`), `server.js`,
`public/admin-nav.js`.

## What this does NOT do

- It does not shrink a fleet. Over-supplied games are reported as `spare`
  (Call of Duty: 49 farming for a target of 11) and left alone — reclaiming a
  deployed account is the recycler's job and has its own guards.
- It does not touch the auto-farm's demand *tiers* (`DEMAND_FULL` 40 /
  `DEMAND_HALF` 15) or `demandScore`. Only the ceiling moved.
- It does not fix the auto-farm's frozen `targetAccounts` (an active task never
  re-reads demand) or make `skip_low_demand` retryable. Both are real and both
  are separate changes.
- It does not add `SaleSignal` rows for the four marketplaces that write none.
  The demand union covers them through the ledger; minting signals there risks
  double-counting against the pollers that already write them.
