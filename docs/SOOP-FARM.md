# SOOP drops farm (v2)

SOOP (ex-AfreecaTV, `sooplive.com`) credits drops watch time from a live viewer
session, not an HTTP heartbeat. Holding the bridge WebSocket alone
(`wss://bridge.sooplive.com/Websocket`, subprotocol `bridge`: `INIT_GW` →
`CERTTICKETEX` → `INIT_BROAD` → `KEEPALIVE` every 20 s) earns one minute per
minute. No browser, video or chat is needed.

The protocol probe and its measurements live in `_soop-probe/` (git-excluded; it
holds login cookies and a recorded session with tokens — the repo is public, so
never commit it). The build contract — every module's exact surface and the HTTP
API — is `docs/SOOP-FARM-CONTRACT.md`. This file is the operating guide.

v2 (2026-10-06) is a rebuild of the first in-app port (`origin/codex/soop-farm`
up to `7eb67df`). What changed and why is in "What v1 got wrong" at the end.

## What it does

- **Accounts** — SOOP logins imported from Cookie-Editor exports (one or many per
  paste). Cookies are encrypted at rest and never leave the server.
- **Bots** — a bot is a plan plus accounts. Three kinds: one pinned campaign
  (finishes when every account reaches its goal), a **game** (farms every
  guaranteed campaign of that game as each goes live, never finishes on its own),
  or everything guaranteed. An account is in at most one active bot. Bots and
  per-campaign progress survive a restart.
- **Campaigns** — read from SOOP in English, grouped by game, remembered after
  SOOP delists them mid-broadcast so a bot can keep farming.
- **Inventory** — every account's earned rewards synced into the database and
  shown per game and item, with expiry warnings. Reward codes are stored
  encrypted and only shown on an explicit, logged "reveal".
- **Health** — every login is re-checked shortly after boot and every 6 hours; a
  login that dies mid-farm stops its session and raises an alert.
- **Activity log** — what each account and bot did, kept 14 days.

Nothing is ever claimed **automatically**. A reward is claimed only when a
superadmin presses "Claim on SOOP" on that one reward (see "Claiming a reward").

## Pieces

| File | Role |
| --- | --- |
| `utils/soop/errors.js` | Error codes (`AUTH`, `EGRESS`, `TIMEOUT`, `HTTP`, `API`) and their plain-English sentences. |
| `utils/soop/http.js` | Transport: one request path for direct and proxied traffic; **fails closed** when a proxy is configured but unusable. |
| `utils/soop/geo.js` | Country claim for the bridge handshake; a failed lookup is never cached. |
| `utils/soop/i18n.js` | Korean → English glossary, game names, reward-kind labels. |
| `utils/soop/normalize.js` | Raw SOOP rows → the shapes the app uses; Korea-time dates → real instants. |
| `utils/soopClient.js` | One account's SOOP client: read-only APIs and the bridge socket. |
| `utils/soopWorker.js` | One account's farm loop. |
| `utils/soopFarm.js`, `utils/soop/farmBots.js`, `utils/soop/farmViews.js` | The service: sessions, bots, the panel's read model. `.start()` runs after Mongo connects. |
| `utils/soop/campaignStore.js` | Shared campaign cache (one scan serves every account) and the remembered-campaign store. |
| `utils/soop/inventory.js`, `health.js`, `activity.js`, `metrics.js` | Inventory sync, login health, activity log, RAM/CPU sampler. |
| `models/Soop*.js` | `SoopAccount`, `SoopCampaign`, `SoopFarmTask` (a bot), `SoopInventoryItem`, `SoopGame`, `SoopTranslation`, `SoopActivity`. |
| `routes/soopRoutes.js` | Superadmin API (`/api/soop/*`), every route behind `requireSuperadmin`. |
| `public/soop.html`, `public/soop/*` | The panel: Overview, Bots, Campaigns, Accounts, Inventory, Activity. |
| `tests/helpers/soopFake.js`, `scripts/soop-dev-harness.js` | An in-memory SOOP and a local harness that serves the real page and API on it. |
| `scripts/soop-status.js` | Read-only production snapshot (accounts, bots, campaigns, inventory totals). |

`server.js` and `public/admin-nav.js` are unchanged from v1: the entry points
are still `routes/soopRoutes`, `utils/soopFarm.start()` and `/soop.html`.

## Watch time needs a country claim that matches the egress

The bridge handshake sends a `JOINLOG` block that states where the viewer is
(`geo_cc`, `geo_rc`, `join_cc`). Measured 2026-10-04, one account, one campaign,
one client, changing one thing at a time:

| Setup | Claimed | Result |
| --- | --- | --- |
| Dev Mac, Tokyo IP | JP, match | 0 → 13 min in 13 min |
| Dev Mac, Tokyo IP | US, wrong | 0 min in 8.5 min |
| Server, US IP | JP, wrong | 0 min across 5 accounts, ~54 min |
| Server, US IP | US, match | 0 min in 9 min — US is not credited |
| Pi, Sri Lanka IP | JP, wrong | 0 min in 9.5 min |
| Pi, Sri Lanka IP | LK, match | 0 → 10 min in 10 min |

Two conditions, both needed: the country claimed has to be the one SOOP sees for
the connection, and that country has to be one SOOP pays drops in (Japan and Sri
Lanka are, the United States is not).

So the client asks SOOP where the connection appears to be
(`get_private_info` → `COUNTRY_CODE`) and claims exactly that. The lookup belongs
to the egress, not the account: one lookup serves every account for 30 minutes.
If it fails, the bridge is **not** joined (v1 fell back to "JP" and kept that for
the life of the process, after which the account earned nothing).

`join_cc` is now the ISO numeric code of the claimed country (v1 always sent
Japan's `392`). `geo_rc` is still `13`, the value measured to work; its real
value outside Japan is unknown. `SOOP_GEO_CC`, `SOOP_JOIN_CC` and `SOOP_GEO_RC`
override each field.

Two measurement traps:

- A campaign's `viewTime` **resets when the broadcast changes**, so "minutes
  before" vs "minutes after" across runs proves nothing. The worker therefore
  tracks the highest value seen per account and campaign.
- A flat counter looks the same whether the egress is dead or the stream simply
  has drops off. After three flat reads the worker leaves the socket, says "not
  counting minutes" in the panel, and retries on a back-off (2, 5, 10, 15 min)
  instead of rejoining every two minutes forever.

## Egress proxy: `SOOP_PROXY_URL`

```
SOOP_PROXY_URL=socks5h://127.0.0.1:1080
```

Every SOOP call — the read-only APIs and the bridge socket — goes through this
SOCKS5 proxy when it is set. The reference setup on the server is the
`soop-socks.service` systemd unit (`ssh -N -D 127.0.0.1:1080` to the Pi), which
puts the farm on the Pi's Sri Lankan address.

If the variable is set but the proxy agent cannot be built, **nothing is sent**:
requests fail with "Could not reach SOOP" and the panel shows an egress alert.
(v1 logged one line and went direct, which would have sent every account from
the US datacenter address.) When the tunnel itself is down, calls fail the same
way; a failed campaign scan is retried at most every 30 s, and a tunnel blip
never marks an account logged out.

Every account shares the one egress address. Whether SOOP tolerates many
accounts on one address is still unmeasured.

## Language

SOOP's own messages come back in English when asked with
`accept-language: en-US`, so every call sends it — but campaign titles are
stored by SOOP in Korean and stay Korean (11 of 16 listed titles on
2026-10-06). The glossary in `utils/soop/i18n.js` does the real work: it was
fitted to the 171 campaigns in the probe and to the live list, and leaves none
of those titles or reward names in Korean. A new proper noun stays in Korean
until someone uses "Fix translation" on the campaign (stored in
`SoopTranslation`); a game can be renamed the same way (`SoopGame`). The
original text is always kept and shown on request.

## Sleep and wake

The SOOP version of the Twitch farm's park-when-farmed. An account has a session
only while there is something it can earn:

- **Sleep** — a session that finds nothing to farm for two looks in a row ends
  itself. Nothing then runs for that account and nothing is kept in memory for
  it (no timer, no socket, no client). An account whose bot has nothing live is
  never started in the first place.
- **Wake** — one watcher for the whole farm (`_wake` in `utils/soop/farmBots.js`)
  re-reads the campaign list and starts exactly the accounts that have work:
  every 2 minutes while a campaign a bot wants is inside its window or anything
  is farming, every minute in the 15 minutes before a scheduled start, every 10
  minutes otherwise. v1 and early v2 re-read the list every minute, all day.
- **Stop when farmed** — an account that has reached its goal on every live
  campaign is not woken. A pinned-campaign bot finishes; a game or "everything"
  bot sleeps until the next campaign.
- **No flapping** — an account that went to sleep on a campaign SOOP still lists
  as live (no channel on air), or on a delisted one whose state cannot be known,
  is not retried for 3 minutes.
- A sleeping account's mission counters are read once per boot, so the panel
  shows what it already has and finished accounts are not woken for nothing.

A sleeping SOOP account is not a stopped container as on Twitch — a waiting one
was only ever a timer in the site's process — so the RAM saved is small. What
sleeping saves is the round-the-clock polling of SOOP through the Pi.

The panel shows a sleeping bot and its accounts as "Sleeping", with the reason.
It also no longer waits on SOOP to open: it shows the remembered campaigns at
once and refreshes a list older than 5 minutes in the background.

## Delisted campaigns

SOOP drops campaigns from its list before and during broadcasts: on 2026-10-07
Delta Force Rise Series Day 1 vanished from the list 17 hours before its start.
Every kind of bot therefore also considers remembered campaigns that SOOP no
longer lists, **while their window is open** (`farmable()` in `utils/soopFarm.js`,
from two minutes before the start until the end). A delisted campaign has no
live flag, so the worker simply tries its channels; listed-and-live campaigns
are always preferred over one whose state is a guess, and the 3-minute
cool-down keeps a delisted campaign with nobody on air from being probed
constantly. Until this fix only a bot pinned to one campaign did this.

## Drops-enabled streams and start times

Two things learned on 2026-10-08 from the first category-wide campaign the farm
met (Dokkaebi World launch drops, any stream in category `00360141`):

- **Each stream says whether it carries drops.** The category listing
  (`main_broad_list_api.php`) has `is_drops` per stream. The only stream in the
  category had `is_drops=0`; eight accounts joined it eleven times and earned
  nothing. `categoryChannels()` now returns only streams with `is_drops` on, so
  a category with no drops-enabled stream has nothing to join.
- **SOOP's `live` flag can be true hours before a campaign's window opens.**
  That campaign was flagged live from 03:51 KST with a start of 11:00 KST.
  Nothing is counted before the start, so a campaign is not farmable until two
  minutes before its `startAt`, whatever the flag says.

## Priority game

An "everything guaranteed" bot can name one game that always wins
(`priorityGameNo` on the bot; the wizard preselects Overwatch). Its campaigns
are picked first, and an account farming anything else leaves for one within a
minute or two of it going live — provided a channel is really on air, otherwise
it stays where it is — then goes back when the priority campaign is farmed or
its broadcast ends. While anything is farming the campaign list is re-read
about every minute, which is what makes the switch quick.

Since 2026-10-06 02:30 UTC production runs one such bot for all eight accounts:
everything guaranteed, codes only (so PUBG and Wuthering Waves, which need a
linked game account, are skipped), Overwatch first. It replaced the bot pinned
to OWCS campaign 13337; that bot's row was converted in place
(`_id 6ac1f868cb44c29f94c82f16`: `mode` unset→`auto`, `dropsIdx` `13337`→empty,
`codesOnly` →true, `priorityGameNo` →`12`).

## Claiming a reward

SOOP only issues a reward's code when it is claimed, and the inventory list
never carries a code. Claim and "check info" are the same call
(`POST drops.sooplive.com/api/get_drops_use_info.php` with `{ itemCodeIdx }`):
on an unclaimed reward it claims it — which cannot be undone — and on a claimed
one it only reads. The reply's `itemCode` is the code (or a URL for link-type
rewards, or the literal `2차지급예정` when SOOP has run out and will deliver
later); `renewFlag: "Y"` means SOOP reissued the reward as a new item.

So in the Inventory tab an unclaimed reward has **Claim on SOOP** (confirm, one
reward, logged with who clicked), and a claimed one has **Show code**. A reward
claimed by hand on SOOP gets its code read back the first time Show code is
pressed. The server never sends the call for an unclaimed reward except from the
claim action, refuses expired rewards and ones that still need a linked game
account before asking SOOP, and stores codes encrypted. A sync never wipes a
stored code.

First real claim, 2026-10-06 01:16 UTC: an OWCS "Sun Tea Icon" returned a
25-character code shaped `XXXX-XXXX-XXXXX-XXXX-XXXX` — the Battle.net code
format — with no instructions text. Whether it redeems on a non-Korean
Battle.net account is still to be confirmed by redeeming one.

## Logins expire

The probe's first account, exported 2026-10-03, was logged out by 2026-10-06 —
but the eight production accounts imported on 2026-10-04 were all still logged
in on 2026-10-06. So the lifetime is not simply "two days"; it is still
unmeasured, and logging out in the browser the cookie came from may be what
ends it. A dead login shows as "Logged out — re-import its cookie" on the
account, as an alert on the Overview, and the account's session stops.
Importing a fresh export for the same login puts it straight back to work in
its bot.

## Running it locally

```
node scripts/soop-dev-harness.js 4599     # http://127.0.0.1:4599/soop.html
node --test tests/soop*.test.js
```

The harness uses an in-memory database and the fake SOOP; it cannot reach the
real database or sooplive.com. Time runs 30× so progress moves while you watch.

## Deploying

Targeted copy, as for everything else (see the production-server memory note):
the SOOP files only, fingerprinted first. v2 adds the directories `utils/soop/`
and `public/soop/` and the four new models; it replaces v1's `utils/soopClient.js`,
`utils/soopWorker.js`, `utils/soopFarm.js`, `routes/soopRoutes.js`,
`public/soop.html` and the three v1 models. `server.js`, `admin-nav.js` and
`package.json` do not change. Existing rows keep working: the active v1 bot
loads as a pinned-campaign bot, and v1's campaign dates (stored 9 hours late)
are corrected on read and rewritten by the next scan. Load-test with
`node -e "require('./utils/soopFarm')"` and `require('./routes/soopRoutes')`
before the restart.

## First broadcast after a deploy — check these

1. Overview shows the egress country as LK and "credited: yes".
2. Accounts move from "Watching" to "Earning" within about three minutes of the
   campaign going live. This also confirms the `join_cc` change.
3. After the first reward step, Inventory shows the reward as available — and
   whether an Overwatch reward really is a code, and where it redeems, which is
   still the open question that decides if buyers can use it.
4. Eight accounts on one address all keep earning.

## Deploy record

**2026-10-06 00:31 UTC — v2 live.** 35 files by targeted copy (3 replaced
utils, 12 new `utils/soop/*`, the router, 7 models, the page and 10 files under
`public/soop/`, `scripts/soop-status.js`); `server.js` untouched. Production held
exactly the v1 bytes of `origin/codex/soop-farm` `7eb67df` beforehand. Backup
`_deploy_backup_20261006003102_soop-v2`; pm2 restart 14 at 00:31:33Z (0
unstable). **00:38 UTC — follow-up**: `utils/soopWorker.js`,
`utils/soop/normalize.js`, `utils/soop/i18n.js`; backup
`_deploy_backup_20261006003843_soop-v2-followup`; pm2 restart 15 at 00:38:57Z
(0 unstable). Code is on `origin/feat/soop-farm-v2`; fingerprint against that
branch next time.

**01:15 UTC — claim feature**: `utils/soopClient.js`, `utils/soop/inventory.js`,
`routes/soopRoutes.js`, `models/SoopInventoryItem.js`, `public/soop/tab-inventory.js`;
backup `_deploy_backup_20261006011230_soop-claim`; pm2 restart 16 at 01:15:31Z
(0 unstable).

**02:02 UTC — sleep and wake**: `utils/soopWorker.js`, `utils/soopFarm.js`,
`utils/soop/farmBots.js`, `utils/soop/farmViews.js` and five files under
`public/soop/`; backup `_deploy_backup_20261006020150_soop-sleep-wake`; pm2
restart 17 at 02:02:37Z (0 unstable).

**02:30 UTC — priority game**: `utils/soopWorker.js`, `utils/soopFarm.js`,
`utils/soop/farmBots.js`, `utils/soop/farmViews.js`, `routes/soopRoutes.js`,
`models/SoopFarmTask.js`, `public/soop/bots-wizard.js`, `public/soop/tab-bots.js`;
backup `_deploy_backup_20261006023001_soop-priority-game`; pm2 restart 18 at
02:30:30Z (0 unstable).

**2026-10-07 17:27 UTC — delisted campaigns for every bot**: `utils/soopFarm.js`,
`utils/soop/farmBots.js`, `utils/soopWorker.js`, `utils/soop/i18n.js`; backup
`_deploy_backup_20261007172325_soop-delisted-campaigns`; pm2 restart 24 at
17:27:07Z (0 unstable).

**2026-10-07 23:51 UTC — drops-enabled streams only, no farming before the
start**: `utils/soopClient.js`, `utils/soopWorker.js`, `utils/soop/farmBots.js`;
backup `_deploy_backup_20261007235117_soop-drops-streams-only`; pm2 restart 25
at 23:51:19Z (0 unstable).

Seen against real SOOP right after the deploy:

- The v1 bot (OWCS Korea Stage 3, 8 accounts) loaded as a pinned-campaign bot
  and all 8 sessions went to "Campaign is not live right now".
- All 8 logins passed the health check; SOOP sees the connection in LK.
- The campaign scan stored 16 campaigns with games and correct dates.
- Inventory sync read 8 unclaimed rewards: 5 × Overwatch "Sun Tea Icon" (the
  OWCS 60-minute step, expires 2027-02-28) and 3 × Wuthering Waves "Shell Credit
  x25,000" (needs a linked Kuro account). So v1 did earn on production.
- SOOP's inventory rows are keyed by `itemCodeIdx`. An unclaimed reward carries
  no code; whether the Overwatch one becomes a code on Claim is still unknown.
- The five accounts holding the Sun Tea Icon read **0 minutes** on OWCS: the
  counter is per broadcast, which confirms the reset noted above. A bot's "all
  steps" goal on a multi-day campaign is therefore only reached if one
  broadcast is long enough; until then it simply farms every broadcast.

Not yet seen on v2: an account earning. No guaranteed campaign was live at
deploy time; the next are OWCS Korea's next broadcast and Delta Force Rise
Series Day 1 (2026-10-08 06:00 UTC).

## What v1 got wrong (fixed here, each pinned by a test in `tests/soopFarm.test.js`)

1. Stopping an account and starting it again within a minute lost the new
   session: it kept running unseen and could be started a second time.
2. One failed country lookup made an account claim Japan until the next restart.
3. An expired login looked like "waiting for a streamer"; nothing re-checked it.
4. A delisted campaign never finished: the socket was reopened every ~90 s forever.
5. The proxy failed open to a direct connection.

Also: Korea-time dates stored as UTC, the `sold` flag not enforced, every idle
account scanning the campaign list on its own, `origin` / `referer` headers
silently dropped, and a logged-out reply in Korean not recognised as one.
