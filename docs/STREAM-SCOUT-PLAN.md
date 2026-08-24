# Stream Scout — park bots until a drop is actually watchable

**For:** a fresh builder session · **Reviewed after build by:** Claude
**Target:** stop woken containers from idle-polling Twitch when no qualifying
stream is live. Add a read-only server-side "Scout" that gates wake/park on
*real-time stream availability*, not just the campaign calendar.

**Scope locked with the owner (2026-08-24):**
1. **Esports detection = a curated game→channel map** (not a Twitch allowlist query).
2. **First cut = gate only** (smarter wake/park). No verify-earned, no channel-steering,
   no demand-scaling in v1 — those are later phases, sketched in §9.
3. **Wake all assigned accounts** when a campaign goes farmable (unchanged from today's
   botWaker behaviour — the Scout only decides *when*, not *how many*).

---

## 0. Read this first — the gap

The container park/wake system lives in [utils/botWaker.js](../utils/botWaker.js) and
runs on the auto-farm tick (10 min, [utils/autoFarmer.js](../utils/autoFarmer.js) `TICK_MS`
`:31`; wake `:2883`, park `:2893`, looped over every host `:2881`). Campaigns are
discovered separately by [utils/campaignWatcher.js](../utils/campaignWatcher.js) every
**2h** (`TICK_MS` `:14`, started `server.js:699`).

**The whole wake/park decision keys on campaign `startAt`/`endAt` vs. the park
timestamp — nothing else.** `liveCampaigns()` (`botWaker.js:136-146`) projects only
`{campaignId, game, name, startAt, endAt}` (`:144`); `wakeTrigger` (`botWaker.js:94-104`)
matches game name + `startAt`. **No stream/broadcaster field is ever fetched or
consulted.** So when a campaign starts, botWaker wakes the container and all its
accounts start polling Twitch every 20s — whether or not there is anything live to
watch. "No live broadcaster found" is emitted *inside the .NET bot*, never server-side.

That idle-polling is the waste this plan removes. It is ~130 MB RAM per container **and**
most of the ~1 TB/month of bandwidth (Twitch GraphQL polling by ~1000 accounts at 20s
cadence — memory `project_pi_bandwidth_usage`). The waste concentrates on
**broadcast-window / esports drops**, where the campaign is "live" for days but drops
only credit during scheduled broadcasts:

- `twitchbotx32` (R6 EWC stash) sat **up** through the entire Aug 9→12 tournament gap
  with no broadcast to watch (memory `project_r6_ewc_stash`, watch-item #1).
- `twitchbotx13` was **parked right before** OWCS MSC Day 2's broadcast drops landed;
  today's only defence is a blunt 48h time grace (`BOT_PARK_CAMPAIGN_GRACE_MS`,
  `botWaker.js:44-45`) that keeps bots up on a *timestamp*, never a real "is a stream
  live now" check (memory `project_park_when_farmed`).

The Scout replaces that timestamp proxy with the real signal.

---

## 1. Design principle

**A campaign being *live* and a drop being *watchable right now* are two different
questions.** Today they are conflated. Separate them:

- *"Does a campaign exist / is it within its window?"* → `campaignWatcher`, every 2h, slow.
- *"Is a channel that credits this drop live at this instant?"* → **Scout, every few
  minutes, fast** — because liveness flips in minutes and a missed wake costs drops.

botWaker then consumes the Scout's answer instead of guessing from `startAt`.

---

## 2. Feasibility — why this needs no bot and no burned account

Confirmed against the server-side Twitch surface ([utils/twitchWatch.js](../utils/twitchWatch.js)):

- **`getStreamInfo(token, login)`** (`:224-252`) → `{ live, streamId, game, ... }` — "is
  channel Y live". This is the whole esports primitive.
- Public liveness/directory reads work **tokenless** (Client-Id only) — proven by
  `twitchAccountState.probeAccount` (`utils/twitchAccountState.js:43-58`, no Authorization
  header). If a token is ever needed, borrow a healthy one read-only via
  `campaignWatcher.fetchWithAnyToken()` (`campaignWatcher.js:31-52`).
- **Reads never hit the integrity gate** — only claim *mutations* do
  (`webbotTwitch.js:5-7`). The Scout is strictly read-only, so it cannot burn or degrade
  a farming account and cannot trip integrity.

So the Scout is a plain server-side poller. No container, no account, no watch-time.

---

## 3. Architecture

### 3a. `models/CampaignLiveState.js` (new) — one row per active, farmed campaign
```js
{
  campaignId: { type: String, unique: true, index: true },
  game:       String,
  name:       String,
  gated:      Boolean,   // is this game in the curated map? (only gated games are acted on in v1)
  mode:       String,    // "channels" (esports) | "category" (Phase 2) | "none"
  liveNow:    Boolean,   // a qualifying channel is live right now
  liveChannels: [String],// which mapped channels are live
  lastLiveAt: Date,      // last time liveNow was true  (hysteresis anchor)
  darkSince:  Date,      // when liveNow last went true→false (null while live)
  checkedAt:  Date,
}
```
Kept separate from `TwitchCampaign` on purpose: the Scout owns a **fast-changing** signal;
`campaignWatcher` owns the slow catalog. No write contention between them.

### 3b. `utils/streamScout.js` (new) — the Scout
- `start()` on its own timer (default **~3 min**), started in `server.js` next to
  `campaignWatcher` (`:699`). Its own loop, not the 10-min auto-farm tick — liveness
  needs to be fresher than that.
- Each pass: load active campaigns that **at least one parked-or-up container is
  assigned to** (small set — don't check campaigns nobody farms). For each:
  - **Gated game (in map, `mode:"channels"`):** `getStreamInfo(login)` for each mapped
    channel. `liveNow = any mapped channel live`. (v1 keeps it lenient: "channel live" is
    the signal; matching the exact game category is a Phase-2 tightening. Over-waking is
    the safe direction.)
  - **Not in map:** `gated:false`, `liveNow:true` — **treated as always-watchable, i.e.
    behaviour identical to today.** v1 does **not** gate category-wide games (see §9,
    Phase 2 for why and how).
  - Update `CampaignLiveState` with hysteresis fields (`lastLiveAt`, `darkSince`).
- **On a false→true transition** for a gated campaign that has parked containers, the
  Scout **nudges `botWaker.wakeFinishedBots(host)` immediately** rather than waiting up
  to 10 min for the next auto-farm tick (tightens wake latency for short broadcasts).

### 3c. `utils/botWaker.js` changes (the two gates)
**Wake precondition.** In `wakeTrigger`/`wakeFinishedBots`, before waking a container for
a campaign, if that campaign is `gated`, require `CampaignLiveState.liveNow === true`.
Non-gated campaigns: unchanged.

**New park trigger.** `stopFinishedBots` today parks only on a `botCompletion` "finished"
verdict. Add a second, independent reason: park a container that is **up, has an assigned
gated campaign that has been dark longer than `PARK_AFTER_DARK_MS` (~15–20 min), and has
nothing in progress on its assigned games.** Record the park with a distinct
`reason: "idle_no_stream"` in the registry (`parked-bots.json`, shape at
`botWaker.js:126-131`).

**Never park a container that is actively farming** (any in-progress work on an assigned
game). The gate parks *idle-waiting* bots only.

### 3d. Wiring
- `server.js` — `require("./utils/streamScout").start()` beside `campaignWatcher` (`:699`).
- Master switch **`autoFarm.streamGate`** (settings, **default `false`**), read fresh each
  pass via `loadSettings()` (the maxAutoBots/forceGames live-edit pattern — memory
  `project_autofarm_capacity_cap`). With it off, the Scout still *observes* and fills
  `CampaignLiveState` (so the UI shows liveness), but botWaker ignores it → zero behaviour
  change until you flip it on for a real event.

---

## 4. THE CRITICAL TRAP — wake on *liveness*, not on `startAt`

The existing wake key is `campaign.startAt > parkedAt` (`botWaker.js:94-104`). That is
**wrong for a Scout-parked bot** and will silently strand it:

> Scout parks R6 at 14:00 during a between-matches gap. The EWC campaign started *days*
> ago. Broadcast resumes 16:00. `startAt (days ago) > parkedAt (14:00)` is **false**, so
> the normal wake trigger returns nothing → the bot stays parked straight through the
> resumed broadcast. This is the OWCS-miss failure, re-created by our own park.

**Fix:** containers parked with `reason:"idle_no_stream"` must be woken on a **liveness
transition**, not `startAt`. Branch in the wake path: for that reason, wake when any
assigned gated campaign has `liveNow === true` (or `lastLiveAt > parkedAt`). This mirrors
how manual parks already get special-cased by `/manual/i` on the reason (`botWaker.js:201`).
Get this wrong and the gate loses drops — it is the highest-risk line in the plan.

---

## 5. The curated map

Live-editable settings key (no deploy — `settings.js` reads fresh), seeded from the
esports we actually farm. `owner` on `TwitchCampaign` (`:8`, populated
`campaignWatcher.js:63`) is a good source to sanity-check channel names against.
```json
"autoFarm": {
  "streamGate": false,
  "streamGatedGames": {
    "Rainbow Six Siege": { "mode": "channels", "channels": ["rainbow6"] },
    "Overwatch 2":       { "mode": "channels", "channels": ["owcs", "playoverwatch"] }
  }
}
```
- The gated set overlaps the no-claim set (`settings.js:27` `noClaimGames:["overwatch",
  "rainbow six"]`) — keep them **separate configs**: no-claim is about *claiming*, the map
  is about *liveness*. A game can be in either, both, or neither.
- Games absent from the map are never gated in v1 (fail toward farming).

---

## 6. Safety — fail toward farming, always

A needless wake costs RAM; a missed wake costs drops **forever**. So the gate only ever
acts on a **confident** signal:

- Scout down / stale / errored / never-checked a campaign → treat as **farmable** (wake,
  don't park). Missing Scout data must never block a wake or trigger a park.
- Never gate a game not explicitly in the map.
- Never park a bot with in-progress work; hysteresis (`PARK_AFTER_DARK_MS`) on the park
  side; **instant** wake on the live side.
- Scout is read-only and tokenless where possible — it cannot touch a farming account's
  watch state or integrity.

---

## 7. Cadence & latency

- Scout ~3 min; auto-farm tick 10 min. Worst-case wake latency without the nudge = ~10
  min. The §3b **transition-nudge** cuts this to ~one Scout pass, which matters for short
  daily esports campaigns (a drop may need only 15–60 min of watch inside a multi-hour
  broadcast, so ~3 min latency is comfortably safe).
- Cost per pass = N `getStreamInfo` calls (one per mapped channel of each farmed esports
  campaign) — a handful. Respect the directory pager's existing 300–500 ms politeness
  (`twitchWatch.js:356-357`) if Phase 2's category query is added.

---

## 8. Visibility (minimal, but required in v1)

A gate that silently parks bots with no UI = "why is my R6 bot off?" confusion. Surface
it in the **existing** Auto-farm watcher (memory `project_autofarm_watcher`):

- New derived bot state **`WAITING_FOR_STREAM`** in `autoFarmSnapshot.js`'s state machine:
  container parked/idle, campaign live, but `CampaignLiveState.liveNow === false`.
  Distinct from `PARKED` (finished) and `DONE_IDLE`.
- A per-campaign live indicator (live channel name + "dark 18m" / "live now") on the
  Farming-now section. Read straight from `CampaignLiveState` — one small collection, no
  compute on the request path (memory `reference_atlas_no_diskuse`).

No new tab. Just two additive reads into the watcher that already exists.

---

## 9. Build order

- **Phase 1 — Scout + esports gate (this cut).** `CampaignLiveState`, `streamScout.js`,
  the curated map, the two botWaker gates (§3c) with the §4 liveness-wake, the
  `streamGate` master switch (default off), and the `WAITING_FOR_STREAM` surfacing.
  Ship **off**, enable for the next R6/OWCS event, watch one event before trusting it —
  exactly how `stopFinishedBots` was rolled out (memory `project_farming_completion_signal`).
- **Phase 2 — category-wide gate.** Add a Drops-filtered game-directory query
  (`DirectoryPage_Game` by slug — does not exist yet, `twitchWatch.discoverChannels` is
  *global*, not category-filtered) so regular games (Rocket League, etc.) also stay parked
  until a drops-enabled channel is live. Deferred because it needs live validation against
  Twitch's current schema and the RAM win there is smaller (popular games are almost always
  live anyway).
- **Phase 3 — verify-earned before park.** Close the real correctness hole: today's
  "finished" tests **global** `dropCount > 0` (`farmCompletion.js:107-108`,
  `dropScanner.js:502`) — "earned *any* drop", not "earned *this game's* drop". Upgrade the
  park verdict to confirm each account holds the assigned campaign's expected drop
  (`DropLog` by itemKey/game vs. a persisted expected-drops manifest from
  `fetchCampaignDetails`). This is the owner's "check everyone farmed correctly before
  sleeping", done rigorously; it also protects the sell path from over-delivery.
- **Phase 4 — channel-steering & demand-scaling.** Steer the fleet to the exact esports
  channel (needs a small fork capability for the .NET bot; trivial for the webbot path),
  and wake only enough accounts to meet demand.

---

## 10. What reacts to this (the ripple)

- **botHealthMonitor** — disambiguate "silent because broken" (up + farmable + no logs =
  real thread decay, alert) from "silent because nothing to watch" (expected, don't
  alert). Feed `CampaignLiveState.liveNow` in to suppress false alarms (memory
  `project_bot_thread_decay`).
- **autoFarmer decision** — don't consume pool accounts / `maxAutoBots` capacity for a
  campaign whose broadcast is hours away; spend when it goes farmable.
- **dropScanner** — prioritise scanning accounts on a *just-became-farmable* campaign so
  the completion data is fresh exactly when the park decision reads it (the priority queue
  already exists, `dropScanner.js:177-181`).
- **Drops Radar** — a "farmable now / waiting for stream" status per event.
- **Manual + rented esports bots** — the same signal tells a manual stash bot
  (`twitchbotx32`) or a rented esports operator when to be up vs. park in the gap.
- **Telegram** — "Campaign X went live, woke N bots"; "X ends in 3h, fleet only 60%
  complete — broadcaster was barely live."

---

## 11. Non-goals / guardrails

- **Do not change how many accounts wake or how claiming works.** v1 only decides *when*
  botWaker fires. Wake still wakes the whole container (owner's choice).
- Do not gate any game not in the curated map. Do not touch the no-claim system.
- Reuse `getStreamInfo`/`fetchWithAnyToken`/`loadSettings`/`readRegistry` — do not
  re-implement them. Read-only, tokenless where possible.
- Match the repo's plain-Node + vanilla-JS style; no new runtime deps.

---

## 12. Verification (prod harness, read-only first)

- Confirm the primitive against reality before wiring anything: on prod, call
  `twitchWatch.getStreamInfo(null, "rainbow6")` when a broadcast is on vs. off and confirm
  `live` flips. (Tokenless path — see `twitchAccountState` for the no-Authorization shape.)
- Prod is a **branch-mix, not `main`** — fingerprint per file by blob hash before any
  deploy, deploy by targeted file copy (memory `feedback_prod_drift_check`,
  `reference_production_server`). Don't ship `tests/` or `docs/`.
- Exercise botWaker's new branch with the throwaway-router harness pattern from
  `docs/AUTOFARM-WATCHER-PLAN.md` §7 (real DB, stubbed superadmin, scratch port).
- `npm test` green + ESLint before push; refresh graphify + push to GitHub after (memories
  `feedback_refresh_graphify_after_changes`, `feedback_github_backup`).

---

## 13a. CRUX RESOLVED (2026-08-24) — the .NET fork self-steers via the campaign ACL

Confirmed by reading the deployed fork's channel picker
(`AvishkaNilupul/TwitchDropsBot@combined`,
`TwitchDropsBot.Core/Platform/Twitch/Bot/TwitchBot.cs` → `SelectBroadcasterAsync`):

- For each campaign the bot fetches `campaign.Allow.Channels` (the `DropCampaignACL`
  allow-list) via `FetchTimeBasedDropsAsync`.
- **Channel-locked drop (allow-list present):** it watches the FIRST allowed channel
  that is live AND on the right game. If none of the allowed channels are live it
  returns a **null broadcaster** → "No broadcaster found for this campaign" → drops the
  campaign and idle-sleeps. That idle-sleep is precisely the waste this plan removes.
- **No allow-list:** falls back to the highest-viewer drops-enabled channel in the game
  directory (`FetchDirectoryPageGameAsync`).

**Consequences for the build (owner confirmed drops are channel-locked, and chose
Architecture A = gate the .NET containers, gate + verify-earned together):**

1. **Gate-only is sufficient to EARN.** Waking the container during an allowed-channel
   broadcast is enough — the bot steers itself. No channel-steering to build (Phase 4 not
   needed for value).
2. **Gate on the REAL ACL, not the curated map (supersedes §5).** Extend
   `twitchInventory.fetchCampaignDetails` (`utils/twitchInventory.js:461`,
   `CAMPAIGN_DETAILS_QUERY`) with `allow { channels { name } }`, persist it per campaign,
   and have the Scout check liveness of exactly those channels. This makes the Scout's
   signal identical to what the container actually watches and **eliminates the stale-map
   failure class**. Keep the curated map only as an optional override.
3. **`ForceTryWithTags` must be OFF** for channel-locked configs — with it ON the bot
   bypasses the allow-list and watches a high-viewer directory channel that will NOT credit
   a channel-locked drop. Verify in the deployed BotSettings before rollout.
4. **Verify-earned (§9 Phase 3) is still required server-side** — the fork's per-campaign
   `IsCompleted` (`Models/Partials/DropCampaign.Custom.cs`) is stronger than our server park
   verdict, which still uses global `dropCount` (`farmCompletion.js:107-108`). Build it
   alongside the gate (owner's choice), diffing DropLog by itemKey/game vs. the persisted
   allow/drops manifest from the extended `fetchCampaignDetails`.

## 13b. SHIPPED (2026-08-24) — Architecture A: gate + verify-earned, off by default

Built on branch `feature/stream-scout`. All 496 tests pass (13 new in
`tests/streamScout.test.js`), ESLint clean, no require cycles. **Ships OFF** —
`autoFarm.streamGate:false` + empty `streamGatedGames` + `verifyEarnedBeforePark:false`
mean zero behaviour change until enabled.

Files:
- `utils/settings.js` — `streamGate`, `streamGatedGames`, `verifyEarnedBeforePark`
  defaults + `getStreamGate` / `streamGatedGameEntry` / `isStreamGatedGame` (fresh-read).
- `utils/twitchInventory.js` — `fetchCampaignDetails` now pulls `allow { channels }` (the ACL).
- `models/CampaignLiveState.js` — new; one row per gated campaign (liveNow + hysteresis).
- `utils/streamScout.js` — new; ~3-min poller, gates on the ACL channels' real liveness,
  borrows a healthy token, caches ACL 6h, nudges wake on a dark→live flip. `start()`
  wired in `server.js` beside campaignWatcher. Self-guards: no Twitch calls until a game
  is opted in.
- `utils/botWaker.js` — wake gate (`gatedDark` holds a wake into a dark broadcast;
  `liveWakeTrigger` wakes idle_no_stream parks on a LIVENESS transition per §4) +
  `parkIdleBots` (new idle_no_stream park). `stopFinishedBots` passes `requireEarned`.
- `utils/farmCompletion.js` — verify-earned: `classifyBotCompletion` takes
  `dropGamesByLogin`; `botCompletion` builds it from DropLog when `requireEarned`.
- `utils/autoFarmer.js` — tick calls `parkIdleBots` (independent of stopFinishedBots) +
  Telegram summary.
- `utils/autoFarmSnapshot.js` + `public/bots.html` — `WAITING_FOR_STREAM` watcher state.

**To enable for one event:** set `autoFarm.streamGate:true`, add the game to
`streamGatedGames` (e.g. `{ "rainbow six": {} }` — `{}` = gate on the campaign's ACL;
add `{"channels":[...]}` only to override), optionally `verifyEarnedBeforePark:true`, and
confirm `ForceTryWithTags` is OFF in the deployed BotSettings (§13a #3). Then watch one
event before trusting it.

**DEPLOYED to prod 2026-08-24 (off by default, verified inert).** 11 files, backup
`_deploy_backup_20260824-032118_streamscout/`. `utils/autoFarmer.js` was RECONCILED (prod
runs the catalog integration my branch predates — my 2 park-hunks applied on top; all
catalog markers verified intact). Post-deploy: `unstable=0`, MongoDB connected, `/`→200,
`CampaignLiveState docs=0` (Scout no-op with gate off). Live-validated against real Twitch
before deploy: `allow{channels}` query works (auto-lister safe); EWC 2026 ACL = 648
channels resolved live in ONE batched request. Bugs found+fixed during testing: (1) the
catalog-revert landmine (reconciled), (2) per-channel liveness would be ~648 calls/pass on
a dark gap → replaced with a batched `users(logins)` query (chunks of 100, early-exit) in
`twitchWatch.getStreamsLive`, (3) null array entries for dead logins filtered. Graphify not
yet refreshed; not committed to GitHub yet.

## 13c. Follow-on fixes (2026-08-24) — idle-no-campaign park + Phase 2 category gating

Prompted by a real observation: `twitchbotx36`/`x40` on the Pi were ON, "farming
nothing" — 50 fresh Rocket League accounts each, all `notStarted`, with **no active
RL campaign at all** (the "Kai x Speed Play RL!" campaign expired). The stream gate
didn't touch them (RL not gated; category-wide, not channel-locked) and
`stopFinishedBots` won't park a `notStarted` bot. Two gaps, two fixes:

**Fix #1 — idle-no-campaign park (`botWaker.parkIdleNoCampaignBots`, setting
`parkIdleNoCampaignBots`, default OFF, ENABLED on prod 2026-08-24).** Parks a RUNNING
bot whose assigned games have ZERO active campaign — nothing to farm, pure idle RAM —
which `stopFinishedBots` deliberately skips (never-started ≠ finished). Wakes on the
normal new-campaign trigger (with grace). Safety: INCLUSIVE bidirectional-substring
game↔campaign match (`gameMatchesCampaign`, via `normGameName`) so a farming bot
("overwatch" vs "Overwatch 2") is never read as idle; no-claim games excluded; requires
a FRESH verdict with zero working AND zero unknown; any uncertainty keeps the bot up.
Dry-run on the live fleet: parks ONLY x36/x40, all 17 other bots KEEP.

**Fix #2 — Phase 2 category gating (`twitchWatch.getGameDropsLive` +
streamScout category mode, opt-in via `streamGatedGames[game]={mode:"category"}`,
default OFF).** For a gated game with NO ACL (category-wide, e.g. Rocket League), the
Scout checks the game's Drops-filtered directory
(`game(name){streams(options:{systemFilters:[DROPS_ENABLED]})}` — validated live) for
any live drops channel; none ⇒ dark ⇒ the existing `parkIdleBots` (idle_no_stream) path
parks it. No botWaker change needed — category-mode games get a `gated:true` liveness
row the gate already consumes. Inert until an active category campaign exists for a
`mode:"category"` game.

502 tests pass (+ gameMatchesCampaign + reason round-trip tests). Deployed to prod
off-by-default via targeted copy (autoFarmer re-reconciled onto the catalog version);
fix #1 then enabled.

## 13. Review checklist (what Claude checks after the build)
- [ ] Scout is read-only and tokenless (or borrows read-only) — never watches, never claims.
- [ ] `streamGate` **defaults off**; with it off there is **zero** behaviour change (Scout
      observes only).
- [ ] **§4 honoured**: `idle_no_stream` parks wake on a liveness transition, NOT on
      `startAt`. Regression test proves a mid-window broadcast resume re-wakes the bot.
- [ ] Missing/stale/errored Scout data ⇒ campaign treated as farmable (fail toward farming).
      Test the Scout-down path explicitly.
- [ ] A bot with in-progress work is never parked by the gate. Hysteresis on park, instant
      on wake.
- [ ] Only gated (in-map) games are ever acted on; non-map games behave exactly as today.
- [ ] `CampaignLiveState` is a small keyed collection; `/auto-farm/watcher` still reads one
      snapshot doc — no new compute on the request path.
- [ ] `WAITING_FOR_STREAM` state renders and is distinct from PARKED/DONE_IDLE.
- [ ] `npm test` green; no change to auto-farm *decision* logic beyond the wake/park gate.

## 13d. Bug-fix pass (2026-08-25) — review findings fixed

A code review + live-prod verification pass (branch `feature/stream-scout` worktree)
found and fixed four issues plus the verify-earned upgrade:

1. **Error-swallowing in the liveness read (`utils/streamScout.js`).** `anyChannelLive`
   swallowed every non-token error (a 429/5xx/network blip, or an all-tokens-dead
   pass) and returned `liveNow:false` — which the Scout then wrote as a FRESH,
   confident-dark row, letting a Twitch outage park gated bots after
   `PARK_AFTER_DARK_MS` with zero error trail (the §6 fail-toward-farming contract,
   inverted). Fixed: non-rotatable failures now throw; `runOnce` catches them and
   marks the campaign watchable + records `counts.errors`/`lastError` (and the
   short retry fuse now fires on per-campaign errors too). Also hardened
   `twitchWatch.getStreamsLive` / `getGameDropsLive` to throw on HTTP-level
   failures instead of returning an empty (="dark") result.
2. **Dark gated campaign suppressed a whole wake (`utils/botWaker.js`).** The wake
   path checked `gatedDark` on the FIRST trigger campaign only and nulled the whole
   wake — a mixed bot (gated + ungated games) could miss the ungated game's drops
   until the gated channel came back. Fixed: `wakeCandidates` collects every
   candidate; the loop skips dark-gated ones and wakes on the first farmable.
3. **Park/wake matching asymmetry.** `parkIdleNoCampaignBots` matched inclusively
   (`gameMatchesCampaign`) but every wake path matched exactly, so a relabeled new
   campaign ("naraka" vs "NARAKA: BLADEPOINT") could strand a parked bot. Fixed:
   `wakeTrigger`/`liveWakeTrigger` now use the same inclusive bidirectional match.
4. **Stop-before-record in all three park paths.** A registry write failure after a
   successful `docker stop` left the bot parked but unwakeable. Fixed: record the
   park FIRST (a failed stop self-heals — wakeFinishedBots drops entries whose
   container is running), and undo the restart-policy change if the stop fails.
5. **Verify-earned upgraded to per-campaign completeness.** `farmCompletion` now
   checks not just "holds a drop for every assigned game" but "holds every expected
   drop of every ACTIVE campaign of its games", against a persisted manifest
   (`models/CampaignDrops.js`, refreshed read-only by `campaignWatcher` ~6h TTL,
   network-neutral until `verifyEarnedBeforePark` is on) — matched by `benefitId`
   with `itemKey` fallback. Held-game labels also match inclusively ("overwatch"
   vs DropLog "Overwatch 2"), so a finished bot is no longer held forever by label
   drift, and a never-live game's bot can no longer be parked as "finished".

All four park/wake fixes fail toward farming (keep a bot up on any uncertainty).
523 tests pass (+10 new: wake candidates/gatedDark skip, per-campaign verify,
inclusive labels, liveness error propagation/token rotation); ESLint clean.
