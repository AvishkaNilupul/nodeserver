# Auto-Farm Watcher — rebuild plan

**For:** Sol (fresh session) · **Reviewed after build by:** Claude
**Target:** replace the current "Auto farm 🤖" tab in `public/bots.html` with a real
operational watcher.

---

## 0. Read this first — what is wrong with the current tab

Open `public/bots.html` → `renderAutoFarm()` (~line 782) and
`routes/autoFarmRoutes.js` → `GET /auto-farm/tasks` (~line 50).

The current tab renders **one flat list of every AutoFarmTask**, newest-first:
all live tasks + up to 200 history rows (`HISTORY_LIMIT = 200`), each as a card.
Because the farmer *skips far more campaigns than it farms*, the screen is a wall
of `SKIP · low demand` cards. The 3 things the operator actually needs — what is
farming right now, what needs attention, what the farmer turned on/off — are
buried or **not shown at all**.

Concretely, what is missing (not opinion — these data sources exist and are unused
by this tab):

| Missing | Where the data already is |
|---|---|
| Is each bot **actually farming**? | `BotAccount.inProgressCount`, `farmingCompleteAt`, `lastScanAt/lastScanStatus`; `utils/farmCompletion.js` |
| Is the container even **up**? | `utils/botHosts.js#dockerPs` / `dockerContainer` |
| Bots that **went silent / thread-decayed** | `utils/botHealthMonitor.js#status()` (silence, known-bad patterns, thread decay) |
| Bots the farmer **parked** (turned off) and why | `utils/botWaker.js#readRegistry()`, `stopFinishedBots`, `wakeFinishedBots` |
| Accounts **recycled / reaped / consolidated** | `reapRetiredBots`, `recycleSoldOutAccounts`, `repackAutoBots`, `reapDeadTokenAssignments` in `utils/autoFarmer.js` |
| History of any of the above | **nowhere** — only transient lines in an in-memory scan log that dies on restart |

And the load problem: `/auto-farm/tasks` returns **full task documents** (each with
`listing` + `stackListing` subdocs, `assignedAccounts` arrays) for 200+ rows, and
while a scan runs `afPollProgress()` re-fetches **both** `/auto-farm/status` and
`/auto-farm/tasks` every 2 seconds. That is the "long loading" the operator feels.

---

## 1. Design principle

**Separate the fleet's live reality from the decision log.** Today they are the
same list. They are different questions asked at different frequencies:

- *"What is my fleet doing right now?"* → changes every few minutes, needs to be **instant**
- *"Why did the brain skip Clickbait Tycoon?"* → an audit trail, **collapsed by default**

Everything below follows from that split.

---

## 2. The view (4 categorized sections)

### Section A — Header: engine + capacity, with derived alerts
One compact strip. Keep: mode (LIVE/DRY-RUN/OFF), host, pool ready/spendable/reserve,
caps, last scan time, Scan now / Rescan all / Settings.
**Add** derived signals (not raw settings): capacity used (`activeAutoBots / maxAutoBots`)
as a bar, pool headroom, and "next scan in Nm".
**Remove** nothing the operator uses — but demote it to one line.

### Section B — "Farming now" (the main event) — grouped Game → Bot → Accounts
This is what replaces the wall of cards. For each **active** task:

```
World of Tanks · Winter Drops        [FARMING]  ends in 3d 4h
  twitchbotx22 @ Pi   ● up 2d 6h   28/30 accounts progressing   2 dead token
  twitchbotx27 @ Pi   ▲ STALLED — no log output 41m (thread decay: 12/70 active)
  listed: Gameflip $12.50 · plati #123 · 8 held for post-event
```

Each bot gets a **derived state** (the logical core of this system — see §3).
Collapsed by default to one line per bot; expanding lazy-loads the account table.

### Section C — "Lifecycle" — what the farmer turned on/off (the timeline)
A reverse-chronological, **persisted** feed of the actions the farmer takes that are
invisible today. Filterable by type:

```
00:49  PARKED    twitchbotx19 (Sea of Thieves) — finished assigned games   [stopFinishedBots]
00:49  WOKEN     twitchbotx31 (Delta Force) — new campaign started         [wakeFinishedBots]
00:48  RECYCLED  12 accounts → pool after "Rust · Twitch Rivals"           [completeEndedTasks]
00:47  REPACKED  twitchbotx14+x18 → x14 (freed 1 container, ~130MB)        [repackAutoBots]
00:45  REAPED    3 dead-token accounts pulled off "Halo" task              [reapDeadTokenAssignments]
```

This is the "auto farm turning off stuff" the operator asked for, and it must
**survive restarts** (§5).

### Section D — "Decisions" — collapsed, aggregated, not a wall
Default view is a **one-line summary bar**, not cards:

```
Today: 44 decided → 3 farm · 1 reuse · 40 skipped
  skipped: 31 low demand · 5 ends soon · 3 already covered · 1 no capacity   [expand]
```

Expanding shows a compact **table** (not cards), grouped by decision, newest first,
with a search box. Skips never push farming context off the screen again.

### Plus: "Needs attention" strip (pinned to top when non-empty)
The only things a human must act on. If empty, show nothing (a quiet system should
look quiet):
- plans awaiting approval (dry-run)
- `failed` tasks + their error
- STALLED / DOWN bots
- `skip_no_capacity` / `skip_no_accounts` while campaigns are queued (a real block)
- dead-token or suspended accounts inside active tasks

---

## 3. The bot state machine (the logical core)

Derive **one** state per auto-bot. This is what makes the view readable instead of
a data dump. Compute it in the snapshot builder, never in the browser.

| State | Rule | Colour |
|---|---|---|
| `FARMING` | container running **and** ≥1 assigned account with in-progress work on an assigned game | green |
| `DONE_IDLE` | container running, but `farmCompletion` says every assigned game is finished (waiting to be parked) | blue |
| `PARKED` | intentionally stopped by `stopFinishedBots` — show reason + wake condition | grey |
| `STALLED` | container running but `botHealthMonitor` reports silence / known-bad pattern / thread decay | **amber — needs action** |
| `DOWN` | task expects a container that `dockerPs` does not show (or exited) | **red — needs action** |
| `DEGRADED` | farming, but N accounts are dead-token / suspended / banned | amber |
| `UNKNOWN` | never scanned, or last scan failed, or scan data older than the freshness window | grey-hatched |

**Rules that must be honoured (they are already learned lessons in this repo):**
- "Finished" is **not** `inProgressCount === 0`. Read the header comment in
  `utils/farmCompletion.js`: completion is the *intersection* of in-progress work with
  the bot's **assigned games** (`OnlyFavouriteGames`). Use that helper, don't re-derive.
- An account never scanned or whose last scan failed is **UNKNOWN**, never "finished".
- Scan freshness for park decisions is ~30h, not 6h (see memory `park-when-farmed`).
- `PARKED` is a healthy state, not an error — do not colour it like a failure.

---

## 4. Caching — the part that makes it fast (REQUIRED, not optional)

**Nothing in this tab may compute on the request path.** Two independent reasons:

1. **Atlas shared tier** — `allowDiskUse` is off, 100MB aggregation cap.
2. **The Pi link is seconds of RTT.** Reading live container state per request is
   fatal; an OFF host costs ~63s. Host reads must be batched and backgrounded.

### Copy the pattern that already works in this repo
`utils/archiveSnapshot.js` + `models/ArchiveRollup.js` solved exactly this for the
Drops Archive (33s → 11ms). **Read that file before writing any code — it is the
reference implementation.**

> ⚠️ **Those two files are NOT on `main` or on the pool-watcher branch.** They live
> only on branch `perf/drops-archive-rollup` (which *is* deployed on prod). Read them
> with:
> `git show perf/drops-archive-rollup:utils/archiveSnapshot.js`
> `git show perf/drops-archive-rollup:models/ArchiveRollup.js`

### Build
**`models/AutoFarmSnapshot.js`** — single doc, `key: "auto-farm"`, unique. Fields:
`builtAt`, `buildMs`, `hostBuiltAt`, plus `Mixed` payloads: `header`, `bots[]`,
`games[]`, `attention[]`, `decisionSummary`. Persisted (not memory-only) so a
deploy/pm2 restart serves last-known-good instantly instead of making whoever opens
the page pay a cold rebuild.

**`utils/autoFarmSnapshot.js`** — background builder on a timer, two cadences:
- **fast (~30–60s): DB-only** — tasks, BotAccount signals, pool counts, decision counts.
- **slow (~5 min): host-touching** — `dockerPs` / container uptime / health-monitor
  state. **Use `botHosts.readFiles`** (one gzipped round trip) — never a `readFile`
  loop (26× slower on the Pi; memory `host-read-batching`). Never fan out to hosts
  serially; never block the fast cycle on a dead host, and keep the last good host
  data with its own `hostBuiltAt` timestamp so the UI can label it "host data 4m old".

**Serve it:** `GET /auto-farm/watcher` returns the stored snapshot + `builtAt` +
`stale` flag. It **reads one document** — no aggregation, no SSH.
- Support `If-None-Match` / `?since=<builtAt>` → `304` when unchanged, so the
  browser can poll cheaply.
- Add `POST /auto-farm/watcher/refresh` to force a rebuild (button), so "Scan now"
  and manual refresh feel instant without shortening the timer for everyone.
- **Retire the 2s dual-endpoint poll** in `afPollProgress()`. During a scan poll the
  light snapshot (or just `/auto-farm/status` for the live log), not the full task list.

**Lazy-load detail:** per-bot account tables and full decision history are separate
endpoints, fetched only on expand. Never ship them in the snapshot.

---

## 5. Persist the lifecycle events (so Section C survives restarts)

Today park/wake/reap/recycle/repack exist only as strings in the in-memory
`progressLog`, lost on every deploy. Add a flat, indexed collection — same shape of
solution the pool watcher is using for `PoolUsageEvent`:

**`models/AutoFarmEvent.js`**
```js
{
  at:        { type: Date, default: Date.now, index: true },
  type:      String,   // parked|woken|reaped|recycled|repacked|listed|delisted|
                       // task_started|task_completed|task_failed|plan_expired|dead_token_pulled
  game:      String,
  campaignId:String,
  taskId:    { type: mongoose.Schema.Types.ObjectId, index: true },
  host:      String,
  container: String,
  count:     Number,   // accounts / containers affected
  reason:    String,   // human-readable, reuse the existing progress() text
  actor:     String,   // stopFinishedBots | wakeFinishedBots | completeEndedTasks | ...
}
// indexes: { at: -1 }, { type: 1, at: -1 }, { game: 1, at: -1 }
```

**Where to record** (all in `utils/autoFarmer.js` unless noted) — these are the exact
tick phases, in order, from `runOnce()`:

| # | Call site | Event |
|---|---|---|
| 1 | `completeEndedTasks()` (~2230) | `task_completed`, `recycled` |
| 2 | `repriceEndedTasks()` (~2203) | `listed` (post-event reprice) |
| 3 | `expireStalePlans()` (~1144) | `plan_expired` |
| 4 | `botWaker.wakeFinishedBots()` (utils/botWaker.js) | `woken` |
| 5 | `botWaker.stopFinishedBots()` (utils/botWaker.js) | `parked` ← **the "turning off" the operator wants** |
| 6 | `executeTask()` (~1704) | `task_started`, `listed` |
| 7 | `reapDeadTokenAssignments()` (~3047) | `dead_token_pulled` |
| 8 | `backfillActiveTasks()` (~3147) | `topped_up` |
| 9 | `reapRetiredBots()` (~1937) | `reaped` |
| 10 | `recycleSoldOutAccounts()` (~816) | `recycled` |
| 11 | `repackAutoBots()` (~2082) | `repacked` |
| 12 | `processCampaign()` (~1245) failure path | `task_failed` |

Write via one small best-effort helper (mirror `utils/poolUsageLog.js`): **a logging
failure must never break the farming action it records.** Wrap in `.catch()`.

Forward-only — no backfill.

---

## 6. Build order (ship in stages, don't big-bang it)

- **Phase 1 — snapshot + read-only categorized view.** `AutoFarmSnapshot` model +
  builder + `/auto-farm/watcher` + the new tab with Sections A/B/D and the bot state
  machine. Section C shows live-tick data only. *This alone fixes the noise and the
  slowness.*
- **Phase 2 — `AutoFarmEvent`** + the 12 record sites → Section C becomes real
  history + filters.
- **Phase 3 — Needs-attention strip** + inline actions (approve / stop / restart /
  delist / wake) wired to the **existing** endpoints in `routes/autoFarmRoutes.js`.
- **Phase 4 — polish:** per-game drill-down, per-campaign timeline, CSV export.

Keep the old tab reachable behind a toggle until Phase 1 is accepted.

---

## 7. Server access + how to verify against real data

You have prod access. **Use it to look at real shapes before designing queries.**

- **SSH:** `ssh -i ~/.ssh/claude_prod_deploy_ed25519 root@202.92.214.91`
- **App path:** `/var/www/redeemer/nodeserver` · **PM2:** `pm2 restart redeemer`,
  `pm2 logs redeemer --lines 50 --nostream`
- **Bot host (Pi) from prod:** `ssh -i /root/.ssh/id_bothost avishka@100.126.112.7`
  (containers `twitchbot`, `twitchbotx2..36`, configs in `/home/avishka/twitchbot`)

**Exercising a superadmin route without logging in** (auth is session-only, no header
bypass) — mount the deployed router in a throwaway app **in the repo root on prod**
(not `/tmp`, or `node_modules` won't resolve):
```js
app.use((req,_r,n)=>{req.session={admin:{id:"verify",role:"superadmin"}};n();});
app.use("/", require("./routes/autoFarmRoutes"));
```
…then fetch over localhost against the real DB. **Delete the harness afterwards.**

**Rules that will bite you if ignored:**
- **Prod runs a branch-mix, not `main`.** Verify per file **by blob hash**
  (`git hash-object --no-filters <file>` on prod vs `git show <ref>:<file> | git hash-object --stdin`),
  **never** by `git rev-parse`. Deploy by targeted file copy, backing originals into
  `_deploy_backup_<ts>/` — never `git pull`.
- **Atlas:** no `allowDiskUse`, 100MB cap. `$match` early; prefer flat indexed
  collections over `$unwind` on big arrays.
- **Don't deploy `tests/*.test.js` to prod** (they add phantom reds; `docs/` doesn't
  exist there).
- **Routine log noise to ignore:** `campaignWatcher error: failed integrity check`,
  Mongoose `new`-option deprecation warnings, `[stashAging] channel discovery…`.
- Run `npm test` (440 tests currently pass) + ESLint before pushing. Refresh graphify
  (`npm run graph:index`) and push to GitHub after.

**Useful reconnaissance queries** (run on prod, read-only) — do these first:
```js
// what the decision mix actually looks like (this is why the tab is noisy)
AutoFarmTask.aggregate([{ $group: { _id: "$decision", n: { $sum: 1 } } }])
// how big a task doc really is (why /tasks is slow)
AutoFarmTask.findOne({status:"active"}).lean()  // look at listing/stackListing/assignedAccounts
// the farming-reality signals for one active task's accounts
BotAccount.find({ login: { $in: [...task.assignedAccounts] } },
  { login:1, enabled:1, configFile:1, inProgressCount:1, farmingCompleteAt:1, lastScanAt:1, lastScanStatus:1 })
```

---

## 8. Non-goals / guardrails

- **Do not change farming behaviour.** This is a read/observability feature plus
  additive event logging. No changes to claiming, allocation, parking rules, or the
  reuse-only gates.
- Do not re-implement `farmCompletion` / `botHealthMonitor` / `botWaker` logic —
  **call them**.
- No new runtime dependencies; match the existing vanilla-JS + inline-CSS style of
  `public/bots.html`.
- Keep every existing control working (Scan now, Rescan all, Approve, Stop, Delete,
  Delist).

## 9. Review checklist (what I will check after you push)
- [ ] `/auto-farm/watcher` reads **one** document — no aggregation, no SSH on the request path.
- [ ] Snapshot persists across `pm2 restart` and serves stale-but-instant with an age label.
- [ ] Host-touching work is on the slow cycle, uses `readFiles` batching, and a dead
      host degrades gracefully (never blocks, never hangs the fast cycle).
- [ ] Bot state machine uses `farmCompletion` (assigned-games intersection), and
      never-scanned/failed-scan ⇒ `UNKNOWN`.
- [ ] Skips are aggregated, not rendered as individual cards by default.
- [ ] The 2s dual-endpoint scan poll is gone.
- [ ] `AutoFarmEvent` writes are best-effort and cannot break a farming action.
- [ ] All 12 record sites fire (grep the tick phases and confirm each has one).
- [ ] `npm test` green; no behaviour change to auto-farm decisions.
