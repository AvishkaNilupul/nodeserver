# Web-token farm: ACL-aware channels, heartbeat, idle alert — contract

Frozen 2026-09-06. Agents code against this file, not each other's output.

## Why (measured on prod 2026-09-06)

- The two Overwatch web-token bots (webbot-bot-3/7, 100 accounts) were
  docker-stopped on 2026-09-02 while OW was dark, and `webbotStreamGate` is
  OFF, so nothing woke them for the CAH Championship Finals. The no-claim
  watcher is ON and did wake its bots. → enable the gate (operator action).
- The two RUNNING R6 bots (5/6) credited ZERO minutes in 3h: 9,000 "progress →
  no active drop-session on this channel yet" lines, Esports Pack frozen at
  30/60. Cause: campaign "R6S S2 2026 1" has an ACL of 8 official channels
  (`rainbow6, rainbow6fr, …`) while `channelPool` spreads accounts over the
  top-50 drops-tagged community streams (Skyte, vetelcito01, …), which credited
  the previous 844-channel campaign but not this one. The farmer never switches
  channel once attached (until the lease ends). Web tokens cannot read
  campaign ACLs (integrity-gated `DropCampaignDetails`), but the SERVER can
  (`utils/webbotFarmWatcher.js` already resolves ACLs with borrowed BotAccount
  tokens for its liveness verdicts).
- WebBotAccount rows stay `lastStatus: "pending"` forever: the Pi container
  (`--bot-config` mode) never writes Mongo, so the console cannot tell a
  farming bot from an idle one.

## Files / ownership

| File | Owner | Work |
|---|---|---|
| `webbot-farmer/src/channelPool.js`, `webbot-farmer/src/manager.js`, `webbot-farmer/src/watcher.js`, `webbot-farmer/src/autoPicker.js` (+ new `webbot-farmer/test/channelSelect.test.mjs`) | agent F | read `/config/channels.json`; prefer live ACL channels; leave a channel after `NO_SESSION_EXIT_MS` without a drop session and re-pick avoiding it. |
| `utils/webbotFarmWatcher.js`, `tests/webbotFarmWatcher.test.js` | agent G | write `channels.json` per bot each tick; per-bot heartbeat from docker logs; Telegram idle alert; expose in `status()`. |
| `routes/webbotFarmRoutes.js`, `public/webbot-farm.html` | agent H | surface heartbeat + channels file on the bot cards; "Recreate" action so a bot picks up a rebuilt image. |
| main session | — | rebuild the image on the Pi, recreate containers, enable `webbotStreamGate`, verify. |

Do not edit any other file. Edit-only on existing files. No Mongo `$group`.

## `channels.json` (written by the server into `/home/avishka/webbot-drops-farm/bots/<id>/channels.json`, visible in the container as `/config/channels.json`, mount is `:ro`)

```json
{
  "v": 1,
  "game": "Rainbow Six Siege",
  "updatedAt": "2026-09-06T12:00:00.000Z",
  "campaigns": [
    { "id": "<campaignId>", "name": "R6S S2 2026 1", "endAt": "2026-09-07T04:58:00.000Z",
      "acl": ["rainbow6", "rainbow6fr"],        // null = un-gated (any channel of the game credits)
      "live": ["rainbow6"] }                      // ACL logins live at updatedAt (subset of acl); [] when none
  ]
}
```

Rules for the farmer (`selectCandidates(all, file, now)` — PURE, exported from
`channelPool.js` and unit-tested; `all` = `fetchDropsChannels` result
`[{login, viewers, hasDropTag}]`):

1. File missing / unparsable / `updatedAt` older than **45 min** / different
   `game` (normalised compare: lowercase, non-alphanumerics → space, trim) →
   ignore the file → today's behaviour (drops-tagged first, top-K).
2. Consider only campaigns with `endAt` null or in the future.
3. `liveAcl` = union of `live` over gated campaigns. If non-empty → candidates =
   `liveAcl` logins (as `{login, viewers: 0, hasDropTag: true, fromAcl: true}`),
   merged with any `all` entries of the same login (keep their viewers). ONLY
   those — never pad with community streams while an ACL channel is live.
4. Else if any considered campaign is un-gated (`acl === null`) → today's
   behaviour on `all`.
5. Else (every active campaign is gated and none of its channels is live) →
   `[]` → `channelPool.next` returns null → the manager backs off
   `NO_CHANNEL_BACKOFF_MS` (no bandwidth burnt on channels that cannot credit;
   the watcher parks the bot after its dark hysteresis anyway).
6. No considered campaigns at all (file lists none) → today's behaviour.

`channelPool` re-reads the file on every refresh window (3 min). Path from
`process.env.WEBBOT_CHANNELS_FILE || "/config/channels.json"`. Log one line when
the selection source changes (`channels: acl-live (2) | community (20) | none`).

## No-session rotation (agent F)

`watchChannel` gains `opts.noSessionExitMs` (default 0 = off). The manager
passes `NO_SESSION_EXIT_MS = 10 min` (env `WEBBOT_NO_SESSION_EXIT_MS`). When the
drop-session probe has reported "no active drop-session" continuously for that
long (reset on any progress/session), `watchChannel` returns
`{ reason: "no-session", channel }`. `farmTurn` then logs
`[login] no drop session on <channel> for 10m — rotating` and immediately
re-picks via `channelPool.next(session, game, { avoid: [channel] })` (add the
`avoid` option: skip those logins for THIS call only; if every candidate is
avoided, return the first candidate anyway). Only ONE rotation per turn; a
second no-session exit ends the turn normally (lease semantics unchanged).

## Watcher additions (agent G) — `utils/webbotFarmWatcher.js`

Inside `runOnce` (gate ON path), after verdicts:

1. **channels.json per bot.** For each bot: the active campaigns of its game
   (reuse `activeCampaignsForGames`), each with `acl` from `aclChannels()` (→
   `null` when the campaign has no ACL / ACL disabled) and `live` = the ACL
   logins live now (reuse `getStreamsLive` in ≤100 batches; on Twitch error
   `live` = [] and set a top-level `"error": "<msg>"`). Build the JSON with a
   PURE exported `buildChannelsFile(bot, campaignsWithAcl, now)`. Write all
   bots' files in ONE SSH round trip (`hosts.runShell` with a heredoc-free
   approach: base64 → `echo <b64> | base64 -d > <path>.tmp && mv <path>.tmp
   <path>`), skipping a bot whose content hash (excluding `updatedAt`) is
   unchanged in the last **20 min** (keep a `lastWritten` map in state; the
   `updatedAt` freshness the farmer checks is 45 min, so a 20-min rewrite keeps
   it fresh). Write for running AND stopped bots (a bot that gets started must
   find a fresh file).
2. **Heartbeat.** In the same SSH round trip, for every RUNNING bot:
   `docker logs --since 6m <container> 2>&1 | grep -c "progress → drop"` and
   `… | grep -c "no active drop-session"` and `… | grep -c "farming .* via"`.
   Parse into `state.heartbeat[id] = { at, progress, noSession, attaches }`.
   PURE `heartbeatVerdict(hb, gameVerdict)` → `"farming"` (progress > 0),
   `"idle"` (progress 0 && noSession > 0), `"starting"` (all zero), `"unknown"`
   (no hb). Expose `heartbeat` in `status()` and per bot in `state.bots[]`
   (`hb`, `hbVerdict`).
3. **Idle alert.** When a running bot's game verdict is `live && !uncertain`
   and its verdict was `"idle"` on **2 consecutive** ticks, `sendTelegram`
   once per bot per **60 min**: `⚠️ webbot-bot-<id> (<game>, <n> accounts) is
   running but credited 0 minutes for 6+ min while the game is live — channel
   ACL: <live acl logins or "none live">`. Record `AutoFarmEvent`
   `webbot_idle_alert`. Gate with `settings.getAutoFarm().webbotIdleAlerts`
   (read fresh; default true — add the default to `utils/settings.js`? NO:
   agent G must not edit settings.js; treat missing as true).
4. Keep every existing invariant: fail toward farming, `.operatoroff`
   respected, no CampaignLiveState writes. All new work try/caught so a
   heartbeat/ACL failure never blocks start/stop actions (which stay first).

Tests: `buildChannelsFile` (gated/ungated/ended filtering, live subset),
`heartbeatVerdict`, and the idle-alert debounce as a pure helper
`shouldAlertIdle(prevVerdicts, nowVerdict, lastAlertAt, now)`.

## Routes + page (agent H)

- `GET /api/webbot-farm/bots-status` adds per container `hb` +`hbVerdict` (from
  `webbotFarmWatcher.status().heartbeat` / bots) and `channels` = the parsed
  `channels.json` summary read in the SAME SSH batch as `docker ps`
  (`cat bots/<id>/channels.json` for every bot dir; parse → `{updatedAt,
  campaigns:[{name, gated, liveCount, aclCount}]}`, null when missing).
- `POST /api/webbot-farm/bots/:id/recreate` → `docker rm -f` + the same `docker
  run` line `POST /bots` uses (`--restart unless-stopped -v <botDir>:/config:ro
  IMAGE`), preserving markers: if `.operatoroff` exists → `docker stop` right
  after run; if `.autostopped` exists → `docker stop` right after run (watcher
  wakes it). Audited (SystemEvent `webbot/bot_recreated`). Used after
  `/rebuild` so running bots pick up the new image.
- Page: bot card shows a heartbeat chip (`farming N/6m` green / `idle: no drop
  session` red / `starting` / `unknown`) and a "channels: acl-live 1/8 · R6S S2
  2026 1" line from `channels`; a **Recreate** button next to Start/Stop
  (confirm dialog). Auto power panel shows `lastError` and per-game verdicts
  already; add the heartbeat column.
