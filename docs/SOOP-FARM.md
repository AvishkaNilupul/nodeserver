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

- **Accounts** — SOOP logins imported from Cookie-Editor exports: saved as files
  and dropped on the page (many at once, or a whole folder), or pasted (one or
  many per paste). Cookies are encrypted at rest and never leave the server.
- **Bots** — a bot is a plan plus accounts. Three kinds: one pinned campaign
  (finishes when every account reaches its goal), a **game** (farms every
  guaranteed campaign of that game as each goes live, never finishes on its own),
  or everything guaranteed. An account is in at most one active bot. Bots and
  per-campaign progress survive a restart.
- **Campaigns** — read from SOOP in English, grouped by game, and remembered
  once SOOP stops listing them, so a bot can still look one up.
- **Inventory** — every account's earned rewards synced into the database and
  shown per game and item, with expiry warnings. Reward codes are stored
  encrypted and only shown on an explicit, logged "reveal".
- **Health** — every login is re-checked shortly after boot and every 6 hours; a
  login that dies mid-farm stops its session and raises an alert.
- **Login alert** — a login that is logged out, or that the drops site refuses
  while the main site still calls it signed in, cannot farm. The panel shows it
  as an error, System Health has a `soop.logins` row for it, and the owner gets
  one Telegram message naming every such login (and one when all are accepted
  again). The fix is always the same: sign the account in, open
  drops.sooplive.com, export its cookies and import them again.
- **Activity log** — what each account and bot did, kept 14 days.

**Code rewards are claimed automatically** as soon as they are earned, and the
code is stored encrypted — so a login that stops working cannot take it along
(see "Codes are claimed as they are earned"). A link, a form or an in-game
reward is still claimed only when a superadmin presses "Claim on SOOP" on that
one reward (see "Claiming a reward").

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
| `utils/soop/autoClaim.js` | Claims code rewards as they are earned: after a step, after an import, and on a sweep. |
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

Every kind of bot also considers remembered campaigns that SOOP no longer
lists, **while their window is open** (`farmable()` in `utils/soopFarm.js`,
from two minutes before the start until the end). A delisted campaign has no
live flag, so the worker looks at its channels — and joins one unless its
stream says it carries no drops (see "Drops-enabled streams" below).
Listed-and-live campaigns are always preferred over one whose state is a
guess, and the 3-minute cool-down keeps a delisted campaign with nobody to join
from being probed constantly.

How often SOOP really delists a running campaign is **not known**. This section
was written on the belief that it does so "before and during broadcasts" (Delta
Force Rise Series Day 1 "vanished from the list 17 hours before its start" on
2026-10-07). On 2026-10-13 the farm's own reader turned out to be skipping
about half of SOOP's list, which looks exactly like that from the inside, so
those sightings prove nothing either way. The rule is kept for the case that
SOOP does. It is not free: in that state every account wakes about every five
minutes and looks at the campaign's channels (simulated for 29 accounts and a
seven-channel campaign: 2,000 to 2,700 player-info reads and 300 to 400
mission reads an hour, and no socket). With the list read whole it should be
rare.

## The campaign list was read wrongly (found 2026-10-13)

Found from 29 "Not earning — Joined, but SOOP is not counting minutes" alerts.
Measured on production between 15:28 and 15:51 UTC:

- **The reader asked for "page p of p rows".** `get_drops_event_list.php` takes
  `pageNo` and `prePageNo`, and `prePageNo` is the page SIZE (the site itself
  sends 20 or 200 in it for this list). v1 sent the page number in both,
  believing the list came one event a page, and v2 kept the shape. SOOP answers
  such a request with rows 0, then 2-3, then 6-8, 12-15, 20-24 … and nothing in
  between. Asked that way it returned 6 of the 10 running campaigns (rows 0,
  2, 3, 6, 7, 8; the fourth page was empty, which ended the read); asked the
  site's way (`pageNo: 1, prePageNo: 200`) it returned all 10 with
  `totalCount: 10`, and all 62 scheduled ones. The farm's own last scan had
  seen 6 running and 34 scheduled — what the arithmetic gives. (The 10-04
  probe's recording fits the same pattern: 6 running rows are 1+2+3.)
- **A campaign in a skipped row looked delisted**, and went in and out of view
  as the list's order changed. The Overwatch campaign (OWCS Korea Stage 3
  W3&4, `13787`) sat at row 4: listed by SOOP, not live. The farm took it for
  delisted, so for "state unknown, try its channels".
- **Its channel list includes co-streamers.** Two of them were on air playing
  ranked games; the official channel was off air. Their player info said
  `IS_DROPS: 0` and so did the category listing (0 of 31 Overwatch streams
  carried drops). From 09:08 UTC all 29 accounts joined one of them 725 times
  by 15:28 — three minutes each, then the 2 / 5 / 10 / 15-minute back-off —
  and were counted nothing. Before 09:08, with no co-streamer on air, the same
  mistake showed as "Campaign is live but no channel is on air yet" 2,345
  times since 10-12 14:41: sessions that started, found nobody on air and went
  back to sleep, for every account every few minutes.
- **What it cost.** No Overwatch watch time: SOOP had no Overwatch broadcast
  on. Of the three other running campaigns hidden at 15:32, none was one the
  bot farms (two were not watch-time campaigns, one needs a linked game
  account); what was hidden at other hours of the day was not checked. The nine guaranteed
  campaigns that ended since the farm started had all been seen by the farm at
  some point. The logins were all accepted and the Sri Lanka egress was up.
  What it did cost was 29 accounts appearing and leaving together on a small
  stream, every quarter of an hour, for more than six hours.

What changed, each part pinned by tests that fail without it:

- **`utils/soopClient.js` reads the whole list**: pages of 200, as the site's
  own full-list view does, until SOOP's `totalCount` campaigns are read.
  Measured through the tunnel: 2.2 s for the running list (12 KB) and 3.1 s for
  the scheduled one (55 KB) — one scan is 2 requests instead of 13. A read is
  **short** when SOOP hands over fewer rows than it counts, when the page cap
  is reached without them, or when a reply has no list in it (an empty list is
  an empty array with a count of "0", measured). `campaigns()` throws on a
  short read; `campaignsAll()` keeps the rows that did come and names the list
  in `unread` (why, in `unreadWhy`).
- **A list that was not read whole says nothing about what it did not hand
  over.** The two lists are two requests, and one lost request used to turn
  every running campaign into a "delisted" one until the next scan.
  `utils/soop/campaignStore.js` now keeps the campaigns such a list held
  exactly as they were last read, for ten minutes from when SOOP last really
  listed them — the tolerance a wholly failed scan gets (the two can follow
  each other, so the outside bound is about twenty). The panel's "campaign
  list could not be refreshed" alert shows meanwhile, and the server log gets
  one line when a list stops being read whole and one when it is again
  (`[soop] campaign store: the progress list was not read whole — …`).
- **A short read is asked for again at once** through the next login
  (`_scan` in `utils/soopFarm.js`, up to three logins as for a failed read);
  of several short reads, one that read the running list is kept.
- **`pickChannel()` in `utils/soopWorker.js` reads the stream's own flag before
  joining.** See the next section.

Found by the reviews of this change and fixed with it, though older:

- **A session's second dropped socket ended it.** The count of "looks with
  nothing to farm" was never reset by a stretch that was being counted, so the
  second time a session's socket closed — however many hours after the first —
  it ended as "idle" and the account sat out the 3-minute cool-down instead of
  one 30-second retry (simulated on the old code: 49 / 45 / 43 / 39 minutes
  earned in 50 with one to four interruptions). A stretch in which minutes
  were counted now resets the count.

Tests: `tests/soopClient.test.js` (a list paged as the real server pages it),
`tests/soopCampaignStore.test.js`, `tests/soopWorker.test.js`, and the
end-to-end cases in `tests/soopFarm.test.js`.

What the list rule does **not** cover:

- **After a restart there is no last read to keep.** If the very first scan of
  a new process is short, the campaigns of the unread list are delisted until
  the next whole read.
- **After the tolerance** a campaign of a list that still cannot be read is
  delisted like any other, and is then joined only on a stream that does not
  say "no drops".
- **A broadcast that starts while the running list is unread** is noticed at
  the next whole read, not before. The old code took the short read for a
  delisting and tried the channels at once (simulated: about two minutes an
  account for one lost request at exactly that look, less or the other way
  round in the other cases).

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

And a third, learned on 2026-10-13 from a campaign with a channel list:

- **A stream's own player info says it too**: `IS_DROPS` in the `CHANNEL`
  object of `player_live_api.php`, which answers without a cookie. Read once,
  at 15:32–15:36 UTC: `1` (a number) on six streams the category listing
  marked `is_drops`, `0` on the two co-streamers, one of which had been joined
  725 times and counted nothing. A channel of a campaign being on air therefore
  proves nothing — a co-streamer has broadcasts of their own.
- **The rule** (`pickChannel`, `carriesDrops`): of the campaign's channels on
  air, the first whose stream carries drops — or does not say — is joined. One
  that says it carries none is joined only when nothing better is on air AND
  SOOP itself lists the campaign as live; then it is the first such stream,
  which is the one the farm joined before it read the flag. A campaign that
  left SOOP's list is never joined on a stream that says it has no drops. A
  value other than SOOP's `1` / `0` counts as "does not say".
- **Not yet seen:** `IS_DROPS` on an official channel while its campaign is
  being counted (no such broadcast was on). That is why a stream saying "no
  drops" is still joined when SOOP calls the campaign live: should the flag
  ever be `0` on a counted stream, the farm is on it as long as its last read
  of SOOP's list says the campaign is live — not once the campaign counts as
  delisted (see what the list rule does not cover, above). Read the flag on
  `owesports` during the next OWCS broadcast; if it is `1` while minutes count,
  that exception can go.
- **When a counter stays flat** the panel now adds "(the stream says it carries
  no drops)" if the joined stream said so. Then it is the stream. Without it
  the two old causes remain (see "Two measurement traps" above).

Known limits, none of them new:

- `IS_DROPS` says that a stream carries drops, not whose. A listed co-streamer
  running another event's drops looks the same as one carrying this campaign's.
- Every account looks at the channels itself (29 accounts × up to 12 channels
  at a wake); the "nobody to join" note is shared for 90 s, a look in flight
  is not. A note reached by passing over a stream that said "no drops" stops
  binding the moment SOOP lists the campaign as live.
- For a campaign SOOP lists, the farm waits for SOOP's `live` flag. A campaign
  that used to sit in a skipped row was tried regardless; if `live` ever
  trails a counted broadcast, that head start is gone.

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

## Codes are claimed as they are earned

Since 2026-10-13 (contract §18). SOOP gives a reward's code out only when the
reward is claimed, and only a working login can claim. When all eight logins
were dropped on 2026-10-11, everything still unclaimed was out of reach until
each account had been signed in again — and 32 Eternal Return rewards, which
last one day, were gone by then. A code that is claimed and stored is ours
whatever happens to the login.

- **What**: every unclaimed **code** reward that has not expired and is not
  tied to a game account, on an account that is not sold and can log in.
  Nothing else.
- **When**: a couple of minutes after the step that earns it (the account's
  inventory is read, then the claim; if the reward is not there yet it looks
  again after 5 and 10 minutes); the moment a cookie is re-imported, for
  whatever was waiting on that login; and on a sweep of every login 8 minutes
  after a restart and every 3 hours.
- **Pace**: one account at a time, one claim every 7 seconds.
- **Where to see it**: Inventory tab (the line under the totals, and "Claimed"
  counts); Activity, kind `claim`; an alert on the Overview when codes are
  waiting on a login that cannot claim them, or have gone unclaimed for hours
  on one that can; and one line per sweep in the process log
  (`[soop] claim sweep: …`).
- **Switch it off** without a restart, from the app's directory on the server:

  ```
  node -e 'require("./utils/settings").setAutoFarm({soopAutoClaim:false},{actor:"owner"})'
  ```

  (`true` turns it back on; it is read within 30 seconds. The command sits for
  about ten seconds and may print a warning about its own audit entry — the
  setting is saved.) `SOOP_AUTO_CLAIM=0` in `.env` does the same at the next
  restart.
- **What it cannot do**: claim on a login SOOP refuses. Those rewards wait, the
  alert names the logins and says when the first one runs out, and re-importing
  the cookie claims them at once.
- When SOOP has run out of codes for a reward ("to be delivered later") the
  reward is claimed anyway and its code is asked for again every few hours,
  for a month.
- On a poor link the sweep goes on with the logins it has not read yet instead
  of starting over. A login that gives no answer is looked at again ten
  minutes later — four times at most — and then left for the next sweep, so
  logins that never answer cannot hold up the others; and one reward SOOP
  keeps refusing, or never answers for, never holds up the others on its
  account. After an outage every login is normally read within about twenty
  minutes of the link coming back, and by the next three-hourly sweep at the
  latest.
- A code is never deleted by the farm: not when SOOP stops listing the reward,
  and not when its account is deleted from the panel.

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
Add `--cookie-files=<dir>` and it also writes cookie exports the farm does not
have yet into `<dir>`: drop that folder on the page to try the import dialog.

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
5. (Since the 2026-10-14 change.) While a campaign's minutes are counting, read
   `IS_DROPS` on its official channel (`player_live_api.php`, no cookie
   needed). It has only ever been read on category streams and on streams
   that were counted nothing. If it is `1`, the exception "a stream that says
   no drops is still joined when SOOP calls the campaign live" in
   `pickChannel` can go.
6. `pm2 logs redeemer | grep "was not read whole"`. A line now and then is a
   lost request. A line that is never followed by "both lists read whole
   again" means SOOP's reply no longer matches what was measured — its count
   against the rows it hands over, or what an empty list looks like — and the
   reason is in the line.

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

**2026-10-12 15:23 UTC — import from files, and a login check of its own for a
fresh cookie** (contract §17): `public/soop/account-import.js` (new, `29b50449`),
`public/soop/soop.css` `e26e6ca4`→`5eaada98`, `public/soop/tab-accounts.js`
`d8ba6061`→`06ff2de7`, `utils/soop/health.js` `f5daa071`→`e3b4b3fd`,
`utils/soopFarm.js` `3c4f8a09`→`ef27335b` — the bytes of
`origin/feat/soop-import-files` `cbdcb29`, cut from
`origin/fix/telegram-send-retry` `0344d26`, which is what production held for
all four. Backup `_deploy_backup_20261012152316_soop-import-files`; pm2 restart
50 at 15:23:17Z (0 unstable), 23 minutes after an allocator pass. The panel's
entry file (`tab-accounts.js`) was copied last, so no page load could ask for a
file that was not there yet; the three panel files were then fetched from the
public site and matched the commit byte for byte. After the restart the farm
came back with its bot, the sweep two minutes later checked every login
through the new code, and the first allocator pass (15:26Z) applied nothing
unusual. Fingerprint the SOOP files against `cbdcb29` next time. The deploys
of 2026-10-12 before this one (login alert, Telegram retry) are in the same
line of commits.

**2026-10-12 17:46 UTC — code rewards are claimed as they are earned** (contract
§18): `utils/soop/autoClaim.js` (new, `32d204a1`), `utils/soop/inventory.js`
`87a1c5ef`→`3ce24d84`, `utils/soop/farmViews.js` `27f337b2`→`c7d7242c`,
`utils/soopFarm.js` `ef27335b`→`3d2f4070`, `models/SoopInventoryItem.js`
`5e1293f8`→`0ad2cc2c`, `public/soop/tab-overview.js` `68b13ba5`→`8eba38da`,
`public/soop/tab-inventory.js` `940cb850`→`1d262ecf` — the bytes of
`origin/feat/soop-auto-claim` `df6270d`, cut from `feat/soop-import-files`
`1d3187a`, which is what production held for all six. Backup
`_deploy_backup_20261012174557_soop-auto-claim`; pm2 restart 51 at 17:45:59Z
(0 unstable), 20 minutes after an allocator pass. The deploy script was
rehearsed first against a copy of the base tree with a stub `pm2` (apply,
re-check, rollback, a drifted file, a file that does not load).

In the same step the logins imported that day were put in the "everything"
bot. The live process holds its bots in memory and reads them only at start, so
the bot's row was written right before the restart. Within a minute of it every
one of them had joined a drops-enabled stream of the one campaign that was live.

Before the deploy, the code rewards waiting on the logins that work were
claimed by hand through the claim route (every one came back as a code), so the
first sweep had nothing left to claim. What it cannot reach: the rewards on the
logins that are still logged out.

Seen live after it: the first automatic sweep read every login and found
nothing left to claim; three minutes after the new logins reached a step, each
was read in turn and its code claimed and stored, one account about every ten
seconds, with no refusal.

**18:54 UTC — the second review's fixes**: `utils/soop/autoClaim.js`
`32d204a1`→`41648521`, `utils/soop/inventory.js` `3ce24d84`→`81c4fcc6`,
`utils/soopFarm.js` `3d2f4070`→`ec252aac` — the bytes of
`origin/feat/soop-auto-claim` `078abd5`. Backup
`_deploy_backup_20261012185422_soop-auto-claim-2`; pm2 restart 52 at 18:54:24Z
(0 unstable), five minutes after an allocator pass and between two reward
steps. Watch time carried over the restart.

**20:31 UTC — the third review's fixes** (the sweep: logins that never answer
cannot hold it up, and a tunnel that comes back late leaves nobody waiting for
the next pass): `utils/soop/autoClaim.js` `41648521`→`ae7a0e19`,
`utils/soopFarm.js` `ec252aac`→`8126df85` — the bytes of
`origin/feat/soop-auto-claim` `5e71873`. Backup
`_deploy_backup_20261012203121_soop-auto-claim-3`; pm2 restart 53 at 20:31:22Z
(0 unstable), 34 minutes after an allocator pass, with no campaign in progress.

Seen live before it, on the second round's code: the last step of the campaign
the new logins were on was reached at about 19:47 UTC, and every code of that
step was claimed and stored within eight minutes, with no refusal. Seen live
after it: the sweep eight minutes after the restart read every login that can
log in, in one run, and found nothing left to claim.

A known limit, accepted: when the tunnel goes in the middle of a pass (somebody
had already answered), or comes back for a moment and goes again, a few logins
can use up their four looks and then wait for the next three-hourly pass. Steps
reached after the tunnel is back are not affected: each is followed by its own
read.

**2026-10-14 01:03 UTC — the whole campaign list, and the stream's own drops
flag** ("The campaign list was read wrongly (found 2026-10-13)" above). Four
files by targeted copy: `utils/soopClient.js` `1aa489ab`→`2808a001`,
`utils/soopWorker.js` `9736639c`→`fce56a52`, `utils/soop/campaignStore.js`
`ba688bfc`→`fde83f86`, `utils/soopFarm.js` `8126df85`→`2463dcc0` — the bytes of
`origin/fix/soop-campaign-list-paging` `faa757a`, cut from
`origin/feat/soop-auto-claim` `4c20aed`, which production held for all four.
Backup `_deploy_backup_20261014010327_soop-list-paging`; pm2 restart 58 at
01:03:28Z (0 unstable), 41 minutes after an allocator pass, with no login
earning.

Seen live after it: the first list read saw 70 campaigns (9 running, 61
scheduled) where the last read before the restart had seen 39 (6 and 33); the
Overwatch campaign was listed as not live and nothing was joined; no "was not
read whole" line; the sweep eight minutes after the restart read all 29 logins.
Dokkaebi World week 2 opened at 02:00:00Z. Every login had looked at 01:58:35Z,
found no stream carrying its drops yet and gone to sleep; all 29 joined a
stream of the category at 02:04:44Z and had 4 minutes counted by 02:08:05Z.
(The 4 min 44 s between the start and the join is the look-early, sleep,
cool-down sequence, which is older than this change.)

By the time of the deploy the joins that started all this had stopped by
themselves, at 2026-10-13 19:11Z after 1,102 of them: the old reader happened
to see the campaign again, or the co-streamer went off air — not checked which.

Fingerprint the SOOP files against `faa757a` next time.

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
