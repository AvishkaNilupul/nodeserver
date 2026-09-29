# Pump Paper Bot - Complete Project Handoff Memory

Last consolidated: 2026-08-27 01:57 JST (2026-08-26 16:57 UTC)

Project root: `/Users/avishkanilupul/projects/nodeserver/tools/pump-paper-bot`

Dashboard: `http://127.0.0.1:4177`

This document is the primary context file for continuing this project in a new AI session. Read it completely before changing the code. Transfer the entire `pump-paper-bot` directory, especially `runs/`, with this file. This Markdown file explains the data but does not duplicate every raw JSONL record.

## Non-negotiable safety boundary

This is a research-only, paper-trading prototype.

- It has no private key.
- It has no wallet signer.
- It cannot submit a Solana transaction.
- It cannot buy or sell a token.
- All balances, entries, exits, fees, slippage, and profit are simulations.
- Do not describe its results as real profit.
- Do not add real execution merely because a paper result looks profitable. Real execution requires a separately reviewed design, secure key handling, failure controls, and substantially better validation.

## Original objective and observed wallet

The project began by investigating this public Solana wallet:

- Wallet: `HV4ZT4QpEW54rywbnigQUadJ4aK1JgieQjXSZ6o7Jy1y`
- Solscan: `https://solscan.io/account/HV4ZT4QpEW54rywbnigQUadJ4aK1JgieQjXSZ6o7Jy1y`

The user's observations were:

- The wallet appeared to behave like a bot because trade size and timing were repetitive.
- The user initially estimated roughly USD 40 per trade and thought exits happened at exactly seven seconds.
- Further observation contradicted the fixed-seven-second theory. Some trades dropped after entry, waited until price recovered near entry, and then exited quickly.
- The working hypothesis became: select coins with an unknown early-flow filter, enter quickly, take fast profit when available, recover near break-even after a drawdown, stop out, or time out.
- The user believed the wallet had made roughly USD 13,000 in one week. That number was not independently verified in the codebase and must be treated as an unverified observation.
- The private entry filter used by the target wallet is unknown. The current filter is an approximation based on public flow, not a reverse-engineered copy.

No claim should be made that this bot exactly reproduces the wallet.

## Important investigated token

Token/mint:

`GVR1eueFGKUXFbHyg2seb1J7XHUFHUPjXM35CqHGpump`

Dexscreener:

`https://dexscreener.com/solana/GVR1eueFGKUXFbHyg2seb1J7XHUFHUPjXM35CqHGpump`

An early dashboard/replay appeared to show approximately `+22.21 SOL` from this token. That result was false. Extreme transaction-derived price outliers caused the simulated valuation to jump unrealistically.

The fix was `filter.maxPriceDeviationRatio = 0.65`. Position updates and entry decisions now reject a transaction price more than 65% away from the recent reference median.

Controlled replay of this token after correcting the price problem showed that repeated entries made results worse:

| Entry policy | Corrected replay result |
| --- | ---: |
| One entry per token | `-0.109 SOL` |
| Two controlled entries | `-0.145 SOL` |
| Unlimited entries | `-0.784 SOL` |

Decision: keep `maxEntriesPerMint: 1`. Re-entry remains disabled. Do not restore repeated entry based on the old `+22 SOL` artifact.

## Development history

1. A paper engine was created to model the suspected fast-entry/dynamic-exit behavior.
2. A local dashboard was added at port 4177.
3. Public Pump.fun program logs were subscribed to over Solana WebSocket.
4. Confirmed transactions were fetched over HTTP and decoded into approximate market events.
5. RPC rate limiting and apparent stalls were addressed with a bounded lookup queue, concurrency limits, transaction-availability retries, reconnect logic, and a quiet-stream watchdog.
6. Position links first targeted Axiom. The final requirement changed them to Dexscreener.
7. Paper accounting was limited to a 2 SOL starting balance.
8. Simulated fees, slippage, and network costs were added.
9. One entry per token and a maximum of three simultaneous positions were enforced.
10. Every decision, market event, order, and run configuration began being logged.
11. Historical tuning was added with a chronological 70/30 split.
12. The false GVR `+22 SOL` result was diagnosed and the 65% price-deviation guard was added.
13. A corrected leaderboard, heartbeat, and overnight dashboard were added.
14. The dashboard was verified at desktop and mobile widths and left running as a detached macOS launch job.

## Current configuration

Source: `config.json`

```json
{
  "paperCapitalSol": 2,
  "startingCapitalSol": 2,
  "entrySizeSol": 0.42,
  "maxOpenPositions": 3,
  "cooldownSec": 180,
  "maxEntriesPerMint": 1,
  "execution": {
    "entryFeeBps": 40,
    "exitFeeBps": 40,
    "entrySlippageBps": 50,
    "exitSlippageBps": 50,
    "networkFeeSol": 0.00001
  },
  "filter": {
    "maxTokenAgeSec": 180,
    "minRecentBuys": 3,
    "minRecentBuyVolumeSol": 1.8,
    "minUniqueBuyers": 2,
    "minMedianBuySol": 0.02,
    "maxLargestBuyShare": 0.8,
    "minBuySellVolumeRatio": 1.1,
    "maxPriceDeviationRatio": 0.65,
    "maxBuySellRatio": 12,
    "minScore": 0.62
  },
  "exit": {
    "takeProfitBps": 450,
    "trailingActivateBps": 250,
    "trailingStopBps": 150,
    "stopLossBps": 600,
    "recoveryBps": 35,
    "recoveryAfterDrawdownBps": 250,
    "maxHoldSec": 180,
    "hardTimeoutSec": 300
  }
}
```

Interpretation:

- Starts with 2 simulated SOL.
- Allocates 0.42 SOL per position.
- Holds at most three positions.
- Enters a mint only once per run.
- Uses a 180-second per-mint cooldown, though the one-entry limit normally makes this redundant.
- Charges 0.40% entry fee and 0.40% exit fee.
- Applies 0.50% adverse slippage on entry and exit.
- Charges 0.00001 SOL network cost on each simulated transaction.
- A full round trip on a 0.42 SOL position begins with roughly 0.00338 SOL in explicit simulated fees/network cost, plus price impact from the two slippage adjustments.
- Takes profit at +4.50%, stops at -6.00%, can trail after +2.50%, attempts recovery after a -2.50% drawdown when price returns to within -0.35%, and hard-times out at 300 seconds.

## Architecture and file map

### Runtime and UI

- `dashboard-server.js`
  - Main local server and overnight process.
  - Binds only to `127.0.0.1`.
  - HTTP dashboard port defaults to 4177.
  - Serves `/`, `/dashboard.html`, `/api/state`, and `/api/config`.
  - WebSocket endpoint is `/stream`.
  - Subscribes to Pump.fun program logs.
  - Fetches and decodes transactions.
  - Manages reconnect/watchdog behavior.
  - Refreshes heartbeat every 15 seconds.
  - Refreshes leaderboard every 30 seconds and after a detected exit.
  - Starts tuning after 15 seconds and then every 10 minutes.

- `dashboard.html`
  - Single-file local dashboard.
  - Shows live connection, P&L, win rate, available capital, events, signals, open positions, closed positions, filter settings, learning result, heartbeat health, corrected leaderboard, best hits, worst losses, and top tokens.
  - Token/position links use `https://dexscreener.com/solana/<mint>`.
  - States clearly that the system is paper-only.

### Trading model

- `lib/paper-engine.js`
  - Owns simulated capital, open positions, exits, one-entry limit, cooldown, logging, costs, P&L, and summaries.
  - Persists `run-meta.json`, `decisions.jsonl`, `market-events.jsonl`, and `paper-orders.jsonl`.
  - Does not persist/reload open positions after restart.

- `lib/market-state.js`
  - Maintains a 30-second rolling event window per mint.
  - Calculates recent buys/sells, volume, unique buyers, median buy size, largest buyer share, reference median price, and deviation.

- `lib/filter.js`
  - Applies hard gates and a weighted score.
  - Score weights: age 20%, buys 25%, buy volume 25%, unique buyers 15%, flow 10%, no creator dump 5%.
  - Hard rejection reasons include token-too-old, price-outlier, low-buy-volume, few-buys, few-buyers, small-median-buy, buyer-concentration, weak-net-flow, and creator-sold.

- `lib/solana.js`
  - Pump.fun program: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`.
  - Fetches JSON-RPC data and parses one approximate trade event from a transaction.
  - Infers trader/mint from signer-owned token balance deltas.

- `lib/leaderboard.js`
  - Scans saved dashboard runs.
  - Includes only comparable corrected runs with a 2 SOL start, explicit entry/exit fees, explicit entry/exit slippage, and price-outlier protection.
  - This intentionally excludes legacy runs that produced inflated results.
  - Aggregates total P&L, fees, win rate, best/worst trades, and top tokens.

### Offline tools

- `tune.js`
  - Deduplicates dashboard events.
  - Sorts them chronologically.
  - Uses the oldest 70% for training and newest 30% for validation.
  - Evaluates 243 combinations of buy count, buyer count, volume, take profit, and stop loss.
  - Does not edit `config.json` automatically.

- `replay.js`
  - Replays a JSONL market event file through the paper engine.

- `live.js`
  - Older/minimal command-line live observer.
  - It is less robust than `dashboard-server.js`; use the dashboard server for overnight operation.

- `index.js`
  - CLI dispatcher for `live` and `replay`.

### Tests

- `test/engine.test.js`
- `test/filter.test.js`
- `test/leaderboard.test.js`
- `test/tune.test.js`

### Documentation

- `README.md`
- `PROJECT_HANDOFF_MEMORY.md` (this file)

## Data model and log schemas

All raw records are newline-delimited JSON unless stated otherwise.

### `run-meta.json`

One JSON object recording:

- `type: "run-start"`
- `startedAt`
- `startingCapitalSol`
- Full configuration used for that run

This is essential for deciding whether historical runs are comparable.

### `market-events.jsonl`

One decoded public transaction event per line. Typical fields:

- `type: "market"`
- `time` (Unix seconds from Solana block time)
- `slot`
- `signature`
- `mint`
- `action` (`buy` or `sell`)
- `trader`
- `tokenVolume`
- `solVolume`
- `priceSol`

### `decisions.jsonl`

One evaluated buy/position decision per line. Typical fields:

- Event identity: time, mint, signature, action
- Calculated `features`
- `decision.enter`, score, and reason
- Optional `gate`: capacity, repeat-limit, cooldown, filter, capital-limit, or price-quality
- Current open position count
- Available simulated capital

This file is important for studying rejected entries and missed winners, not just completed trades.

### `paper-orders.jsonl`

Entry records contain:

- Mint, entry time, market/effective entry price
- 0.42 SOL size
- entry fee, network fee, slippage, cost
- peak/trough/last price
- filter score and signature

Exit records contain:

- Mint and exit time
- effective/market exit price
- gross P&L and net P&L
- entry and exit costs
- total fees and total slippage
- hold seconds
- exit reason
- entry and exit signatures

Important: line count is order count, not completed-trade count. A normal completed position creates one entry line and one exit line.

### Shared root result files

- `runs/leaderboard.json`: latest aggregate corrected leaderboard.
- `runs/heartbeat.json`: process/run health snapshot written every 15 seconds.
- `runs/tuning-report.json`: most recent train/validation analysis.
- `runs/overnight.log`: detached process stdout/stderr.

## Historical run inventory

Inventory captured around 2026-08-27 01:51 JST. The active run continues growing after this snapshot.

| Run | Market events | Decisions | Order lines | Run metadata | Notes |
| --- | ---: | ---: | ---: | --- | --- |
| `dashboard-1787754472748` | 0 | 0 | 0 | no | empty early run |
| `dashboard-1787754618582` | 14 | 0 | 0 | no | legacy |
| `dashboard-1787754750986` | 40 | 0 | 2 | no | legacy |
| `dashboard-1787755111896` | 90 | 0 | 26 | no | legacy |
| `dashboard-1787755509356` | 149 | 0 | 76 | no | legacy |
| `dashboard-1787756231582` | 0 | 0 | 0 | no | empty early run |
| `dashboard-1787756685117` | 0 | 0 | 0 | no | empty early run |
| `dashboard-1787757323211` | 11 | 0 | 2 | no | legacy |
| `dashboard-1787758189485` | 2,548 | 0 | 138 | no | legacy, pre-correction |
| `dashboard-1787760178890` | 1,914 | 0 | 61 | no | legacy, pre-correction |
| `dashboard-1787761251481` | 1,629 | 846 | 45 | yes | 2 SOL/cost logging, but not accepted by current corrected leaderboard |
| `dashboard-1787761992920` | 1,351 | 700 | 39 | yes | corrected comparable run |
| `dashboard-1787762726015` | 414 | 210 | 15 | yes | corrected comparable run |
| `dashboard-1787762887714` | live/growing | live/growing | live/growing | yes | current overnight run |
| `replay-1787753872386` | 5 | 0 | 3 | no | early replay |

Empty directories are retained as historical evidence. Do not delete raw run data unless the user explicitly requests cleanup.

At the manifest snapshot, the whole project was about 5.0 MB and `runs/` was about 4.9 MB.

## Corrected leaderboard snapshot

Captured from `/api/state` at `2026-08-26T16:52:26Z` while the bot continued running:

- Qualifying corrected runs: 3
- Closed trades: 29
- Wins: 15
- Losses: 14
- Win rate: 51.72%
- Total net P&L: `+0.583801162359 SOL`
- Total explicit simulated fees: `0.09802 SOL`

Best trades at that moment:

| Mint | Net P&L | Hold | Exit reason |
| --- | ---: | ---: | --- |
| `3qrzH319rPtpdStUUNye12Tw7CH2L4di9t1pwZrYpump` | `+0.5293849634` | 18s | take-profit |
| `5a8CZCs4vBK8YEmTam2Q8YqchHVdetUi1KwgFstJpump` | `+0.2031674929` | 6s | take-profit |
| `6zWcmBGvmfxhcwFNjfn9gmGGNcMSxhvPJBnW2ogUpump` | `+0.1540359126` | 19s | take-profit |
| `msx3cnMxh2eSz63NuJ8mAQdNszAjqvg6HsRYrZ4pump` | `+0.1213258756` | 3s | take-profit |
| `DtviqSBqZiZ2q5m2YcqcutktGo3r4u9Qe7CAoMocpump` | `+0.1157105558` | 0s | take-profit |
| `6XgPvdNLWFY6Ncb8xf99yoYPN3UJNx898d2bYbYdnJ2F` | `+0.1140005681` | 6s | take-profit |
| `6UauxUY7BxAMDVd3mV5QvV2c8qerxkTS8oAzSkmTpump` | `+0.0767576271` | 3s | take-profit |
| `9Uzm2xMU9UCHm8x3PpuGTgJqzzQkCEegcRTGNXnYpump` | `+0.0585394655` | 0s | take-profit |
| `7jqd42v85UMcDumCj3hFn3n4gkg2263W31jz1Diupump` | `+0.0337288450` | 0s | take-profit |
| `FZoFUsRh1iCqt5AMxptmfVgumKs8NA2ZhrYs8CQ6pump` | `+0.0329315723` | 2s | take-profit |

Worst trades at that moment:

| Mint | Net P&L | Hold | Exit reason |
| --- | ---: | ---: | --- |
| `FhyFzaDQThf8U7QTwJ1BuJGukfr18wM2uui2s4jPdUsf` | `-0.2490881657` | 3s | stop-loss |
| `CMUxNcznv3kmKgMVE2mRgj3AWS8aKAjLS5fnQo2Dpump` | `-0.0955837103` | 4s | stop-loss |
| `r4Ann3A36k6zV7xviavEUfCv31cj745TeaNdhFzpump` | `-0.0954270155` | 4s | stop-loss |
| `H1Y4FhMNUfZudzSW5MGb2tt1p154bmztbA6zApqHpump` | `-0.0816348268` | 1s | stop-loss |
| `G899urrL5J9DXzcuNAiM4MwD9wMpPhc3BmBTJchVpump` | `-0.0811596852` | 12s | stop-loss |

Critical interpretation:

- The positive aggregate is dominated by one `+0.5294 SOL` trade.
- Removing only that best trade leaves approximately `+0.0544 SOL`.
- The leaderboard was negative shortly before that winner.
- This sample is far too small and unstable to claim a profitable strategy.
- Very large winners still need independent price/reserve verification even though the 65% single-event deviation guard is active.
- The live results can change after this document's timestamp. Read `runs/leaderboard.json` for the current value.

## Tuning snapshot

Source: `runs/tuning-report.json`

Snapshot generated at `2026-08-26T16:48:24.650Z`:

- Unique events: 8,163
- Training events: 5,714
- Validation events: 2,449
- Report note: a candidate passed the current held-out minimums; review before editing config.

Base configuration:

| Slice | Trades | Win rate | Net P&L | Max drawdown | Expectancy |
| --- | ---: | ---: | ---: | ---: | ---: |
| Train | 14 | 57.14% | `-0.26182` | `0.65107` | `-0.01870` |
| Test | 28 | 50.00% | `+0.17619` | `0.27708` | `+0.00629` |

Currently selected candidate (not applied to `config.json`):

```json
{
  "filter": {
    "minRecentBuys": 5,
    "minUniqueBuyers": 2,
    "minRecentBuyVolumeSol": 1.2
  },
  "exit": {
    "takeProfitBps": 300,
    "stopLossBps": 600
  }
}
```

Candidate results:

| Slice | Trades | Win rate | Net P&L | Max drawdown | Expectancy |
| --- | ---: | ---: | ---: | ---: | ---: |
| Train | 25 | 60.00% | `+0.90335` | `0.44733` | `+0.03613` |
| Test | 24 | 50.00% | `+0.36758` | `0.31823` | `+0.01532` |

Do not apply this candidate blindly. The tuner evaluates many candidates and uses the same test slice to decide whether a candidate passes, so this is not a pristine final holdout. A future version needs walk-forward validation or train/validation/final-test separation.

## Current runtime state and operations

At consolidation time:

- Launch label: `com.codex.pump-paper-bot`
- Process PID at snapshot: 8815 (PID is not stable; query it rather than relying on this number)
- Active run: `dashboard-1787762887714`
- WebSocket connected: true
- Last error: null
- HTTP lookup throttles in the active run: 0 at snapshot
- Dashboard URL: `http://127.0.0.1:4177`
- Node version used: `v26.5.0`

The process was launched with:

```bash
launchctl submit -l com.codex.pump-paper-bot -- /bin/zsh -lc 'exec /opt/homebrew/bin/node /Users/avishkanilupul/projects/nodeserver/tools/pump-paper-bot/dashboard-server.js >> /Users/avishkanilupul/projects/nodeserver/tools/pump-paper-bot/runs/overnight.log 2>&1'
```

Check it:

```bash
launchctl list | rg 'com\.codex\.pump-paper-bot'
ps -axo pid,ppid,etime,command | rg '[p]ump-paper-bot/dashboard-server.js'
curl -fsS http://127.0.0.1:4177/api/state
```

Stop it:

```bash
launchctl remove com.codex.pump-paper-bot
```

Start manually for development:

```bash
node tools/pump-paper-bot/dashboard-server.js
```

Run tests:

```bash
node --check tools/pump-paper-bot/lib/leaderboard.js
node --check tools/pump-paper-bot/dashboard-server.js
node --test tools/pump-paper-bot/test/*.test.js
```

Run tuning manually:

```bash
node tools/pump-paper-bot/tune.js
```

Last verification: 12 tests passed, 0 failed.

The browser was checked at 1280px desktop width and 390x844 mobile size. There was no horizontal page overflow and no browser warning/error output.

Operational limitations:

- The job can run while the terminal/Codex session is closed.
- If the Mac sleeps, network observation pauses until it wakes.
- The submitted launch job is tied to the user's macOS login session.
- There is no PM2 or `forever` installation.
- Avoid starting a second copy while port 4177 is occupied.

## Environment variables

- `PUMP_DASHBOARD_PORT`: local HTTP port, default `4177`.
- `PUMP_RPC_HTTP`: transaction lookup RPC, dashboard default `https://solana-rpc.publicnode.com`.
- `PUMP_RPC_WS`: log subscription endpoint, default `wss://api.mainnet-beta.solana.com`.
- `PUMP_LOOKUP_CONCURRENCY`: concurrent transaction lookups, default `8`.
- `PUMP_LOOKUP_QUEUE`: maximum queued signatures, default `500`.

The dashboard retries a null transaction result up to nine total attempts with increasing 500ms-based delays because WebSocket notification can arrive before HTTP transaction indexing.

## Dependencies and migration note

The code uses Node built-ins plus the `ws` package.

`ws` currently resolves from:

`/Users/avishkanilupul/projects/nodeserver/node_modules/ws/index.js`

The root package does not declare `ws` as a direct dependency. A new machine or isolated copy may fail with `Cannot find module 'ws'`. The next session should either run inside this repository with its existing dependencies or add a small local `package.json` under `tools/pump-paper-bot` and install/pin `ws` before migration.

No RPC credentials are stored in this prototype. Environment-specific paid RPC URLs must not be committed if added later.

## Known correctness limitations and risks

These are important and should be addressed before trusting profitability.

1. **Token age is not true mint age.** `ageSec` is measured from the first event observed for a mint by this running process, not from token creation on-chain. An old token first seen after restart appears new.

2. **Creator-sold detection is effectively incomplete.** `MarketState` checks `state.creator`, but the parser/event flow does not populate the creator address. The `creatorSold` feature usually remains false.

3. **Transaction price is approximate.** Price is calculated from signer token-balance delta and an inferred SOL balance delta. It is not a direct bonding-curve/pool reserve quote and can include unrelated balance movements or fees.

4. **Only one event is parsed per transaction.** Complex routed transactions or multiple swaps may be reduced incorrectly.

5. **No complete tick stream.** The observer receives confirmed Pump.fun transactions, not every executable pool quote. Exit paths and intrasecond ordering can differ from reality.

6. **Timeout exits use the last observed price.** If a token becomes illiquid or stops producing events, the simulated timeout can close at a stale price that may not be executable.

7. **Execution costs are static.** There is no dynamic price impact, liquidity depth, priority fee, Jito tip, failed transaction, dropped transaction, block inclusion latency, MEV/sandwiching, or sellability/honeypot model.

8. **Zero-second holds can appear.** Block timestamps have one-second granularity, so entry and exit can show `0s` even when ordered within the same or adjacent transaction sequence.

9. **Open positions do not survive restart.** Restarting creates a new run and discards in-memory simulated positions. Historical files remain, but positions are not restored.

10. **Heartbeat is intentionally delayed.** `/api/state` reads the last heartbeat file, which updates every 15 seconds; current engine state may be newer than the heartbeat subsection.

11. **Leaderboard is not strictly an overnight date window.** It aggregates every corrected/comparable dashboard run in `runs/`, not only trades since midnight.

12. **Leaderboard qualification is configuration-shape based.** It checks the 2 SOL start and the presence of costs/outlier protection, but it does not require every filter/exit parameter to be identical across runs.

13. **Survivorship/selection bias remains.** The original target wallet was selected because it looked successful, and the current model was inspired by visually interesting behavior.

14. **Tuner holdout is not final.** The held-out slice participates in selecting the reported candidate. Add an untouched final test slice or walk-forward evaluation.

15. **Public RPC can rate-limit or lag.** VPN IP changes are not a durable solution. A dedicated RPC should be used for reliable research, with its key supplied through environment configuration.

16. **Current aggregate is fragile.** A single large paper winner can flip the entire leaderboard from negative to positive. Always report concentration and results excluding the top one or top few trades.

## Recommended next work, in priority order

1. Preserve the current raw data before refactoring.
2. Add a true token-creation/mint-age source.
3. Decode Pump.fun bonding-curve or pool state directly and calculate reserve-based prices.
4. Validate every unusually large winner against independent reserve/quote data.
5. Populate and test creator/dev wallet behavior.
6. Add liquidity, market-cap, concentration, mint/freeze authority, and sellability checks where data is reliable.
7. Model dynamic slippage and price impact based on position size and pool depth.
8. Add execution latency and failed/dropped transaction scenarios.
9. Persist/recover simulated open positions or explicitly mark restart-abandoned positions.
10. Change tuning to walk-forward or train/validation/final-test evaluation.
11. Add bootstrap confidence intervals for win rate, expectancy, and drawdown.
12. Report P&L excluding the best one, three, and five trades.
13. Split leaderboard by configuration hash and time window so unlike strategies are not mixed.
14. Compare accepted trades with rejected candidates to learn which filters reduce losses without discarding winners.
15. Keep all changes paper-only until a statistically meaningful, independently verified sample exists.

## What not to do next

- Do not restore unlimited or repeated entries because of the old GVR result.
- Do not claim the target wallet exits at exactly seven seconds.
- Do not auto-apply `tuning-report.json` parameters.
- Do not infer real profit from the simulated leaderboard.
- Do not delete legacy runs; they document why correction filters were introduced.
- Do not expose the dashboard beyond localhost without authentication and a reason.
- Do not add a wallet key or real transaction sender as a routine incremental change.

## Quick prompt for the next session

Use this when handing the project to another AI session:

> Read `tools/pump-paper-bot/PROJECT_HANDOFF_MEMORY.md` completely, then inspect the current files and `runs/leaderboard.json`, `runs/heartbeat.json`, and `runs/tuning-report.json`. Continue this as a paper-only Solana/Pump.fun research system. Preserve all raw run data. Do not trust the old GVR +22 SOL artifact, do not enable repeated entries, and do not add real wallet execution. First validate current large winners using reserve-based prices, then fix true token age and creator detection before changing the strategy.

## Exact transfer manifest

Generated after the runtime and tests were verified. Hashes are a transfer-integrity aid; any live JSONL file can legitimately differ after this timestamp because the overnight process is still writing.

| Path | Bytes | Lines | SHA-256 |
| --- | ---: | ---: | --- |
| `tools/pump-paper-bot/README.md` | 2,124 | 31 | `48ee43eb6fb4010fcb12570aabec1888b5923ce5832460c2a111234547390b67` |
| `tools/pump-paper-bot/config.json` | 846 | 37 | `3d5125bef3f2fe7d614e1e13de80b870116051485501e83ca5db0ae4565b34b1` |
| `tools/pump-paper-bot/dashboard-server.js` | 10,131 | 283 | `159bdcf14c4054a59eeb39f9af0488d979a16b3f69341a3235b8805307873fb4` |
| `tools/pump-paper-bot/dashboard.html` | 19,017 | 63 | `49c684fa203aef05834d711530b757cef67980419c5597a7bfe2405cf2c203a5` |
| `tools/pump-paper-bot/index.js` | 448 | 12 | `f2e3e34bcdeb6a95b3d86b8c45f09cebda6cca528fad33046882ce77c7b2094f` |
| `tools/pump-paper-bot/lib/filter.js` | 2,272 | 32 | `fda8ed408758db8545af5cf092d315e1e933ffafdc1185b58f64ec1230eb1484` |
| `tools/pump-paper-bot/lib/leaderboard.js` | 3,053 | 80 | `dd56bccde258f488cd5331f19cd876f0431e7cec0795b25a9644d16aef58f412` |
| `tools/pump-paper-bot/lib/market-state.js` | 2,268 | 57 | `147b8db3645524d730e7f3363a9058c55fbc0e54f702366e51bb9dbe97d782b2` |
| `tools/pump-paper-bot/lib/paper-engine.js` | 9,125 | 175 | `7873382745d614ae59ca67bafc3b2d020cc2c92bbe9d0146c4f2f851213ca647` |
| `tools/pump-paper-bot/lib/solana.js` | 3,033 | 50 | `5ae30239a9d223537a7b80451d8d9726fd1ccf871e2b8ab193665cdf5d84019c` |
| `tools/pump-paper-bot/live.js` | 1,549 | 29 | `111e3e6762e6cc2c562e24346ab69fe26ee998f4064a95d3ed75c6bbc75c6b6c` |
| `tools/pump-paper-bot/replay.js` | 602 | 16 | `b469e37e49225f00fbb076f5cf48b4cf31c090f3ba5396ed2c267f8daaed505d` |
| `tools/pump-paper-bot/runs/dashboard-1787754618582/market-events.jsonl` | 5,132 | 14 | `7aa80de22be5727862cfcdb32f46a797bafab1233e1cb689b278905f680d4658` |
| `tools/pump-paper-bot/runs/dashboard-1787754750986/market-events.jsonl` | 14,642 | 40 | `9cef76a57e2d93b8c06214d852e32b16b1ef1470b9b224ab5eb20aab7bef1e07` |
| `tools/pump-paper-bot/runs/dashboard-1787754750986/paper-orders.jsonl` | 785 | 2 | `3799791a18ec4e5d213e369181404274e2d3f1aa8e30a1bfdc3edd00e1089d3f` |
| `tools/pump-paper-bot/runs/dashboard-1787755111896/market-events.jsonl` | 33,016 | 90 | `3ecfe558623aaae576a2b9bcf67a388e6fd09b3d6dc8d8e587b5aaaea6e2e5d1` |
| `tools/pump-paper-bot/runs/dashboard-1787755111896/paper-orders.jsonl` | 9,692 | 26 | `a05a4b40d81206bf278ac7d5ea0c454144913c8d82105397c5f073072fcc4b69` |
| `tools/pump-paper-bot/runs/dashboard-1787755509356/market-events.jsonl` | 54,623 | 149 | `61a91d79624da59097dab4de843a7f6578e0493cbee799dd29ca26ba2c9cc26c` |
| `tools/pump-paper-bot/runs/dashboard-1787755509356/paper-orders.jsonl` | 27,991 | 76 | `64116593662f52dba94d0e1a7d251b8bcfc9baad2e0cd08264f0c32ed431c7bb` |
| `tools/pump-paper-bot/runs/dashboard-1787757323211/market-events.jsonl` | 4,037 | 11 | `ee35aeba612393e7963ae80c691bfabd0d5a17ed938f194b687a35154111aa52` |
| `tools/pump-paper-bot/runs/dashboard-1787757323211/paper-orders.jsonl` | 725 | 2 | `4343644213ca983d56e4b479a873e6e433ef2f8fb545b34075111f3c9e21809a` |
| `tools/pump-paper-bot/runs/dashboard-1787758189485/market-events.jsonl` | 933,153 | 2,548 | `865575c0b0322ce06f680e83d73e97893b36f853adb2ceaa4d0642470c5f4626` |
| `tools/pump-paper-bot/runs/dashboard-1787758189485/paper-orders.jsonl` | 55,631 | 138 | `c5677b6485fc2b08d4ee7630a760ac3507ab44a109c15417e1ddf4d44ee9f663` |
| `tools/pump-paper-bot/runs/dashboard-1787760178890/market-events.jsonl` | 701,471 | 1,914 | `4e17e5f85fe1acc1182e5bc645bb00abc6df09a7b956046aa13f11b904a1da9c` |
| `tools/pump-paper-bot/runs/dashboard-1787760178890/paper-orders.jsonl` | 27,963 | 61 | `7db491e9fd3e59d9f8943451fd5e40107b1fcb09c75e2bbc9a33ed58d0282c48` |
| `tools/pump-paper-bot/runs/dashboard-1787761251481/decisions.jsonl` | 506,224 | 846 | `3ec9df5df9c9e177baeed866f51fbd13e2980f868a14acac06e21132e480afff` |
| `tools/pump-paper-bot/runs/dashboard-1787761251481/market-events.jsonl` | 596,680 | 1,629 | `9a666478ccc1144749f3e0c40f8a21aec4e5e01ed9f79ceaf93c704e39c81973` |
| `tools/pump-paper-bot/runs/dashboard-1787761251481/paper-orders.jsonl` | 26,635 | 45 | `5c6235ea5d8d39fd81bbe78fba4607b5e1fa48bbddf634a06db6320d4386a8e5` |
| `tools/pump-paper-bot/runs/dashboard-1787761251481/run-meta.json` | 724 | 1 | `3d1aef586ce944e30fd545ad2d06fcce1cfb92e89a7e6503a7d5277f5fa9b078` |
| `tools/pump-paper-bot/runs/dashboard-1787761992920/decisions.jsonl` | 470,694 | 700 | `a6d5a9bbb2eace2d2c917c7586dac961ada960c8079b019631e85353b7e3cd07` |
| `tools/pump-paper-bot/runs/dashboard-1787761992920/market-events.jsonl` | 495,072 | 1,351 | `4677515920d9b3615f91b6e66ef73e288c9fee340c9658a68ce4d9404f958ce9` |
| `tools/pump-paper-bot/runs/dashboard-1787761992920/paper-orders.jsonl` | 23,169 | 39 | `c561077f9b4e209d8a37e964b8e3d19307cb8899fb35b60b19497289d2040109` |
| `tools/pump-paper-bot/runs/dashboard-1787761992920/run-meta.json` | 754 | 1 | `99c098cd6e639748947e9403a3343d71278b5e24e77af13f30d0aab9f00d76f5` |
| `tools/pump-paper-bot/runs/dashboard-1787762726015/decisions.jsonl` | 142,511 | 210 | `64b9919bc0e8e5ec18175e6089d22b799bbc29d61b791e5b161de0a1858bea40` |
| `tools/pump-paper-bot/runs/dashboard-1787762726015/market-events.jsonl` | 151,727 | 414 | `175c872907bea5c1b20ca032b448acea0b1fa7504dcf0fc8790762e59f8360cc` |
| `tools/pump-paper-bot/runs/dashboard-1787762726015/paper-orders.jsonl` | 8,948 | 15 | `5b2f47f68c6cdc753092836ebd547ddf77a85e016d8af6623d793375b433a2cb` |
| `tools/pump-paper-bot/runs/dashboard-1787762726015/run-meta.json` | 754 | 1 | `4cdb8c2dd1d4652e5f635e3de291cce08bef3323944bed0d0a63040d6d7e81b4` |
| `tools/pump-paper-bot/runs/dashboard-1787762887714/decisions.jsonl` | 251,021 | 377 | `4a86de2957ef89b5a7eab089600c62079dc9512b7db1b31e773e129d8cf35217` |
| `tools/pump-paper-bot/runs/dashboard-1787762887714/market-events.jsonl` | 265,167 | 724 | `218b7b17f964ee012d96d2dccaf95617ae0977feaaed35402199f56b16bc1604` |
| `tools/pump-paper-bot/runs/dashboard-1787762887714/paper-orders.jsonl` | 9,558 | 16 | `172eb0b62ddf6e4c1a00d4eb13494846e300cf2d38a72fdaeb4d55b6eac12d6e` |
| `tools/pump-paper-bot/runs/dashboard-1787762887714/run-meta.json` | 754 | 1 | `f58e5e204867e4a4ad21f9f1695d0e304597be41dbb479db9e80b09eb9587f43` |
| `tools/pump-paper-bot/runs/heartbeat.json` | 551 | 25 | `a490effc42449762ad5cb7da9a2178a466153f8380b9ec8ea0ca4fea9147988e` |
| `tools/pump-paper-bot/runs/leaderboard.json` | 15,484 | 422 | `8f510627198fe30705f1fb989be3abc0c5f2e329b4aa669b143b63b872c091c2` |
| `tools/pump-paper-bot/runs/overnight.log` | 44 | 1 | `3310d544843e4ecbbb62186c544f74c179fc165478ee7cb44c8a8693fa0702be` |
| `tools/pump-paper-bot/runs/replay-1787753872386/market-events.jsonl` | 499 | 5 | `2d93998be4f1d83429c89650a2e59c767998970e4c169c5d400f5ba0af5f5e5c` |
| `tools/pump-paper-bot/runs/replay-1787753872386/paper-orders.jsonl` | 468 | 3 | `229c15358219d40e2cc8d36bd3d35e8261e9616dd7bd0a1636bbbdb78fe4134e` |
| `tools/pump-paper-bot/runs/tuning-report.json` | 13,664 | 514 | `f5ed54e0ad426cd1346c6482062ad29b0bd5a8a6d092bea5a65ed11f755e665c` |
| `tools/pump-paper-bot/test/engine.test.js` | 5,115 | 81 | `555a9ae6329e41e81fea833832b2fd9e45fc450dbdfd7dd3062dda5d0e56faaf` |
| `tools/pump-paper-bot/test/filter.test.js` | 1,299 | 25 | `f8f07513a55b0e58b630ef0a2f1999f376cc50c0b11e47bb17d6d4d8fcdff6b2` |
| `tools/pump-paper-bot/test/leaderboard.test.js` | 1,618 | 26 | `14453dffc97a2720e972b3e1c8391f83c523d6f21fb5ed40385fdd36dbd6e72a` |
| `tools/pump-paper-bot/test/tune.test.js` | 985 | 20 | `b08328fb63227b99147206ef27bf27d2de78e455b58094e2ada6c945dffab167` |
| `tools/pump-paper-bot/tune.js` | 4,237 | 112 | `eb4fe31e81238a99c9f024df4e7bedc9f9c7b8693b0784b6c19d728b8fd1fb3d` |

## Final handoff checklist

- Transfer this file.
- Transfer all source files under `tools/pump-paper-bot/`.
- Transfer the full `tools/pump-paper-bot/runs/` directory to preserve raw data.
- Confirm `ws` is installed/resolvable in the destination environment.
- Run all 12 tests.
- Read the latest heartbeat and leaderboard rather than relying only on the snapshot in this document.
- Keep the prototype paper-only.

