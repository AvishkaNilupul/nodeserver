# CHZZK panel v2 — build contract (frozen 2026-10-23)

The CHZZK farm page (`/chzzk.html`) rebuilt on the SOOP farm's UI kit: tabs, tables, drawer,
modal, toasts. Server side (§2) is **already built and live** — code against these shapes, do
not change server files. v1 contract for the farm itself: `docs/CHZZK-FARM.md`.

## 0. Ground rules

- The GitHub repo is **public**. Never put a real cookie, code, nickname or server detail in a
  file, test or comment. Sample data uses made-up values.
- Plain ES2019 in an IIFE, no build step, no external scripts/fonts, no `innerHTML`, no
  globals except the ones named here. All DOM through `Chzzk.el` (text nodes only — CHZZK titles
  and nicknames are untrusted data). Images (campaign/reward `imageUrl`, CHZZK's CDN) only via
  `el("img", { class: "s-thumb", src, alt: "", loading: "lazy", referrerpolicy: "no-referrer" })`.
- Operator-facing words: short, plain English, no jargon ("logged out — re-import its cookie",
  not "AUTH"). Titles/games come in Korean from CHZZK: show them as they are, next to the English
  game name from `Chzzk.gameName()`.
- A code is shown only after the operator presses Reveal (one row at a time, `/rewards/reveal`),
  hidden again after 60 s, with Copy. Never fetch codes in bulk, never put one in a toast,
  title, URL or log.
- `update()` runs on every `/state` poll (5 s): never rebuild what the operator is using —
  build in `render`, then `.update(rows)` / `.set()` / `textContent` only (UI-KIT §1).
- Each file < ~400 lines, short header comment, comments only for the non-obvious WHY.

## 1. Files and owners

| File | Owner | What |
| --- | --- | --- |
| `public/chzzk.html`, `public/chzzk/core.js`, `public/chzzk/chzzk.css` | K | page shell + kit (§3) |
| `public/chzzk/tab-overview.js` | T1 | §4.1 |
| `public/chzzk/tab-accounts.js` | T2 | §4.2 (table + account drawer) |
| `public/chzzk/accounts-import.js` | T3 | §4.3 (import dialog + page-wide file drop) |
| `public/chzzk/tab-campaigns.js` | T4 | §4.4 |
| `public/chzzk/tab-codes.js` | T5 | §4.5 |
| `public/chzzk/tab-activity.js` | T6 | §4.6 |
| `scripts/chzzk-dev-harness.js` | H | §5 |

Do not edit a file you do not own. Do not read a sibling's file to "match" it — code against
this contract and `public/soop/UI-KIT.md`. The old `public/chzzk/app.js` is retired by K
(the new `chzzk.html` no longer loads it; K deletes it).

## 2. Server API (live; all JSON; paths under `/api/chzzk`)

Every answer is `{ success: true, ...payload }` or `{ success: false, error }`. Dates are ISO
strings unless noted. `current.since` is epoch **milliseconds** (number).

`GET /state`
```
{ now, started, switch: { on }, egress: { via, country, ok, at, error },
  totals: { accounts, ok, loggedOut, untested, paused, sold, running, watching,
            codes, codesFresh, codesToday, codesWaiting, campaigns, farmable },
  alerts: [{ level: "error"|"warn"|"info", kind, msg, campaignNo? }],   // worst first
  collector: { pending },
  accounts: [{
    id, nickname, userIdHash /* 8 chars */, status: "ok"|"untested"|"not_logged_in",
    lastError, cookieAt, lastCheckedAt, sold, paused, note,
    running,                 // a watch worker is running for it now
    why,                     // "" when running; else "Paused" | "Sold" | "Logged out — re-import its cookie" | "Farm is switched off" | "Egress is down" | "Starting…"
    current: null | { state: "watching"|"idle"|"waiting", campaignNo, title, channelId,
                      channelName, since, minutes, needed /* next reward's minutes or null */,
                      watched /* min on this stream */, credited /* min CHZZK credited on this stream */, note },
    progress: { [campaignNo]: { minutes, next, done, rewards: { [rewardNo]: "claimed"|"reached"|"passed"|"working"|"not_started" }, at } },
    codes,                   // codes stored for this login
    login: { kind: "session"|"persistent"|"unknown", expiresAt, ageDays, deadSince, livedDays },
  }] }
```
`GET /campaigns` → `{ campaigns: [c] }`, farmable first, then soonest end:
```
c = { campaignNo, title, categoryType, categoryId, categoryValue, state, startAt, endAt, imageUrl,
      enabled, source: "scan"|"manual", needsLink, guide, lastSeenAt, refreshedAt,
      farmable, why /* "" or e.g. "Needs a linked game account", "Ended", "Every code is gone",
      "In-game rewards only (no codes)", "Turned off here", "Not started yet" */, maxMinutes,
      rewards: [{ rewardNo, title, rewardType: "CODE_FIRST_COME"|"CODE_LOTTERY"|"IN_APP",
                  minutes, remaining /* codes left in CHZZK's pool, null = unknown */, imageUrl,
                  farmable, earned /* our logins that earned it */ }],
      logins: { eligible, done, watching, list: [{ id, nickname, minutes, done, watching }] } }
```
`GET /rewards?accountId=&campaignNo=` → `{ rewards: [r] }`, newest earned first, ≤ 500:
```
r = { id, accountId, nickname, userIdHash, campaignNo, rewardNo, title, rewardType, categoryId,
      gameName, campaignTitle, state: "earned"|"stored"|"in_app", hasCode, earnedAt, codeAt,
      codeEndAt /* use-by */, tries, nextTryAt, lastError, revealedAt, revealedBy }
```
`GET /stock` → `{ stock: [s], totals: { stored, fresh, revealed, waiting, expired } }`:
```
s = { campaignNo, rewardNo, game, campaignTitle, title, rewardType,
      stored, fresh /* stored, never revealed, not expired */, revealed, waiting /* earned, code not read yet */,
      expired, useBy /* earliest use-by of an unexpired code */, lastEarnedAt }
```
`GET /activity?limit=1..500&accountId=` → `{ entries: [{ at, level, kind, accountId, campaignNo, msg }] }`
newest first. Kinds seen: `watch` `farm` `progress` `code` `collect` `import` `egress` `alert`
`discovery` `switch` `worker` `reveal`.

POST (body JSON):
| Path | Body | Answer |
| --- | --- | --- |
| `/accounts/import` | `{ cookies: string ≤ 90 kB }` | `{ results: [{ ok, created, nickname, userIdHash8, cookieKind, cookieExpiresAt, error }] }` |
| `/accounts/check` | `{ ids?: [id] }` (empty = all not sold) | `{ total }` (runs in background) |
| `/accounts/update` | `{ id, sold?, paused?, note? ≤ 500 }` | `{}` |
| `/accounts/delete` | `{ ids: [id] }` | `{ deleted, keptCodes }` (rows holding a code are kept) |
| `/accounts/reset-progress` | `{ id, campaignNo }` | `{}` — "Farm again": forget a done mark, re-checked in ≤ 30 s |
| `/campaigns/refresh` | `{}` | `{ found, updated }` |
| `/campaigns/add` | `{ campaignNo }` | `{ campaign }` (400 with `error` when unknown) |
| `/campaigns/enable` | `{ campaignNo, enabled }` | `{}` |
| `/rewards/reveal` | `{ id }` | `{ code }` (404 when none) |
| `/rewards/collect` | `{ ids?: [id] }` (empty = every eligible login) | `{ queued }` |
| `/switch` | `{ on }` | `{ on }` |

## 3. The kit — `window.Chzzk` (owner K)

`core.js` is `public/soop/core.js` adapted; `chzzk.css` is `public/soop/soop.css` copied (same
`s-*` classes, same tokens, dark theme via `data-theme`). **Everything in
`public/soop/UI-KIT.md` holds with `Soop` → `Chzzk`**, except:

- API base `/api/chzzk`; `Chzzk.state` = last `/state` (poll 5 s, 15 s after 3 failures);
  `Chzzk.campaigns` = last `/campaigns` list (poll 60 s); there is no `games` / `scan`.
  `Chzzk.refreshCampaigns()` reloads `/campaigns` (never rejects); to make the server rescan
  CHZZK call `Chzzk.api.post("/campaigns/refresh")` first.
- Tab ids: `overview accounts campaigns codes activity`.
- Lookups: `Chzzk.accountById(id)`, `Chzzk.campaignByNo(no)` (`null` when unknown),
  `Chzzk.gameName(categoryId, categoryValue)` → English game name: a fixed map
  (`OVERWATCH` Overwatch, `Lost_Ark` Lost Ark, `Black_Desert` Black Desert,
  `Call_of_Duty_Modern_Warfare4` Call of Duty: MW4, `World_of_Warcraft_Midnight` WoW: Midnight,
  `dokkaebi` Dokkaebi World, `Once_Human` Once Human, `stellasora` Stella Sora,
  `WutheringWaves` Wuthering Waves, `Arknights_Endfield` Arknights: Endfield, `FIFA_ONLINE4`
  FC Online), else the id split on `_`/camelCase and title-cased, else `categoryValue`, else "Other".
- `Chzzk.rewardType(t)` → `"Code"` (CODE_FIRST_COME) | `"Lottery"` (CODE_LOTTERY) | `"In-game"` (IN_APP).
- `Chzzk.reveal(rewardId, cell)` — shared reveal helper: posts `/rewards/reveal`, fills `cell`
  (a node you own) with `s-code` text + Copy button + "hides in 60 s" countdown, restores a
  "Reveal" button after 60 s or when `cell` leaves the page. Returns a promise. Only K writes
  the code into the DOM; tabs call this.
- `Chzzk.switchFarm(on)` — confirm when turning OFF ("All watching stops; logins, progress and
  codes are kept."), posts `/switch`, refreshes.
- Header status line (`#chzzkStatus`): lead + tone — not started → warn "Starting up"; switch
  off → warn "Switched off"; egress not ok → error "Egress is down"; any error alert → error
  "Needs attention"; watching > 0 → ok "Farming"; else muted "Idle — nothing to watch right now".
  Then " · N of M logins watching · K codes (F new) · via <country> · A alerts".
- Header menu (`#chzzkMenuBtn`): Refresh now · Check all logins (`/accounts/check {}`) ·
  Collect codes now (`/rewards/collect {}`) · Rescan CHZZK campaigns (`/campaigns/refresh`, then
  `refreshCampaigns`) · — · Switch farm off / on.
- Page ids: `chzzkMain chzzkStatus chzzkBanner chzzkTabs chzzkMenuBtn chzzkToasts`.
- `chzzk.html`: same shell as `public/soop.html` (sidebar `.nav` filled by `/admin-nav.js`, theme
  toggle, `/theme.js`), title "CHZZK farm", one `s-tab` button + `s-panel` root per tab id in
  the order above, then scripts: `/theme.js`, `/admin-nav.js`, `/chzzk/core.js`, the tab files,
  `/chzzk/accounts-import.js`.

`window.ChzzkImport = { open() }` is defined by T3 (other tabs call `ChzzkImport.open()` when
present; guard with `window.ChzzkImport &&`).

## 4. Tabs

### 4.1 Overview (T1)
- Alerts card: every `state.alerts` entry as an `s-note` (tone by level) — an "ending" alert has
  a "Show campaign" link (`Chzzk.go("campaigns", { no })`). None → a quiet ok note "All good".
- Stats row: Logins watching (of running), Logged out, Codes stored (hint "F new, T today"),
  Campaigns farmable (of total), Egress (country + via; error tone when down).
- "Right now" card: one row per running account — nickname, what it watches (game name,
  campaign title, channel), progress bar `minutes / needed` with "M of N min", "credited X of
  W min on this stream" (warn tone when watched ≥ 6 and credited = 0), since. Accounts not
  running: one muted line each with `why`. Empty → `ui.empty`.
- "Ending soon" card: farmable campaigns ending within 24 h — game, title, `fmt.until(endAt)`,
  "D of E logins done", progress of the most advanced login.
- "Codes" card: `GET /stock` (on render + every 30 s while visible): top lines by `fresh`
  (game · reward · fresh · use-by), link "All codes" → `Chzzk.go("codes")`.
- Farm switch card: big ON/OFF state + `Chzzk.switchFarm`.
- Badge: error alerts count (tone error), else warn count (tone warn), else null.

### 4.2 Accounts (T2)
- Toolbar: search (nickname / hash / note), chips All · Watching · Logged out · Paused · Sold
  (with counts), buttons "Import logins" (`ChzzkImport.open()`), "Check all".
- Table (`ui.table`, key id, select true): Login (nickname bold + hash mono + note muted) ·
  Status (badge: ok "Ready" / untested "Not checked" / not_logged_in "Logged out" error; + Paused
  / Sold badges) · Doing now (watching: game + channel + `M/N min` + "credited X of W"; else
  `why` muted) · Codes (num) · Login (kind: persistent "until <date>", session "session only"
  warn, unknown "–"; + "imported N days ago") · actions menu.
- Bulk bar when rows are selected: Check, Pause, Resume, Delete (confirm; "codes are kept").
- Row menu: Check now · Pause/Resume · Mark sold/Not sold · Edit note (modal with textarea,
  ≤ 500) · Delete (confirm danger).
- Row click → drawer: status + lastError; login lifetime (kind, expiry, imported, last OK
  check, "lived N days" when logged out); Now (current); Progress — one line per campaign in
  `progress` joined with `Chzzk.campaignByNo`: game, title, `ui.progress(minutes, maxMinutes)`,
  done badge (Finished) or per-reward states; a "Farm again" button on finished ones
  (`/accounts/reset-progress`, confirm); Codes — `GET /rewards?accountId=` list with
  `Chzzk.reveal`; "Collect codes now" (`/rewards/collect {ids:[id]}`); Activity — last 20
  `GET /activity?accountId=&limit=20`.
- Badge: loggedOut (tone error) or null.

### 4.3 Import dialog (T3)
`ChzzkImport.open()` → `Chzzk.modal({ sticky: true })`: a `s-drop` zone (drop or choose
`.json`/`.txt` files, many at once; read with FileReader) + a textarea for pasting. Help text:
"Cookie-Editor export of chzzk.naver.com / naver.com while signed in. Tick 'Stay signed in'
(로그인 상태 유지) when you sign in — those cookies last much longer." Import → one POST per
file/paste (≤ 90 kB each; bigger → error line, not sent) → result lines: ok "nickname (hash) —
new / updated — session only|keeps until <date>" or error. Never echo cookie text. After at
least one ok: `Chzzk.refresh()`; the textarea clears. Also owns the page-wide drag/drop: files
dropped anywhere on the page open the dialog with those files queued (show an `s-dropveil`
while dragging; UI-KIT §7).

### 4.4 Campaigns (T4)
- Toolbar: chips Farmable · All · Not farmable (counts), search (title / game), "Add campaign #"
  (number input + button → `/campaigns/add`), "Rescan CHZZK" (`/campaigns/refresh`).
- Card grid (`s-grid`, keyed node reuse): thumb (imageUrl), English game name + Korean
  `categoryValue` muted, title, window `fmt.when(startAt)` – `fmt.when(endAt)` + `fmt.until`,
  status badge (Farmable ok / `why` muted), rewards as `s-steps` (minutes, type, title, "N left"
  from `remaining`, "ours: earned"), logins line "D of E logins finished · W watching",
  Enable/Disable button. Click → drawer: guide text (pre-wrap), rewards with images, per-login
  list (`logins.list`: nickname, minutes / maxMinutes progress, Finished/Watching), CHZZK link
  `https://chzzk.naver.com/` (external, rel noopener).
- `Chzzk.on("tab")` with `params.no` → open that campaign's drawer.
- Badge: null.

### 4.5 Codes (T5)
- Stock summary (`GET /stock`): stats Fresh (never revealed) · Revealed · Waiting (earned, not
  read yet) · Expired; table per reward: game, reward (title + type), campaign, fresh, revealed,
  waiting, use-by (`fmt.when` + until; warn tone < 7 days), last earned. "Download CSV" builds a
  CSV of THIS table client-side (no codes in it) via a Blob link.
- All codes (`GET /rewards`): toolbar chips All · Stored · Waiting · In-game, game filter chips,
  search (reward / login), table: earned (`fmt.when`), login, game, reward, use-by, state badge
  (stored ok / earned "waiting" warn with lastError + next try / in_app muted), Revealed by/when,
  code cell (`Chzzk.reveal`). Refresh on render, every 30 s while visible, and after "Collect
  codes now" (`/rewards/collect {}`).
- Badge: `state.totals.codesFresh` (tone ok) when > 0.

### 4.6 Activity (T6)
- `GET /activity?limit=200` (render + every 15 s while visible; "Load 500" button).
- Toolbar: level chips All · Warnings · Errors, kind chips (from the entries), login select
  (from `Chzzk.state.accounts`; when set, fetch with `accountId`), search text.
- List: time (`fmt.ago`, title = `fmt.when`), level dot, kind badge, login nickname (from
  `accountById`), campaign game (from `campaignByNo`) when set, message.
- Badge: null.

## 5. Dev harness (H) — `scripts/chzzk-dev-harness.js`

`node scripts/chzzk-dev-harness.js [port=4600]` → `http://127.0.0.1:4600/chzzk.html`. Real
`routes/chzzkRoutes.js` + a real `Farm` (`require("../utils/chzzkFarm").Farm`) wired through
`router._setFarmForTests(farm)`, in-memory MongoDB (`mongodb-memory-server`), the fake from
`tests/helpers/chzzkFake.js`, `express.static(public)`, a fake superadmin session, `/whoami`.
Never loads `.env`, deletes `MONGO_URI` / `CHZZK_PROXY_URL`, sets a throwaway `CRED_SECRET`,
and a tripwire makes any http(s) request to `naver.com` / `ipinfo.io` throw. Fast timings (beat
1 s, status 1 s, progress read 4 s, supervisor 3 s, discovery 30 s) with `minutesPerBeat` 1, so
progress moves while you watch. Seeds: 6 campaigns (Korean-looking made-up titles; mixes of
CODE_FIRST_COME / CODE_LOTTERY / IN_APP; one needsLink; one ending in 2 h; one sold out),
lives for the farmable ones, 4 logins imported through `farm.importAccounts` (made-up jars:
one persistent with `expirationDate`, two session, one header line) plus one logged out
(`fake.logout`) and one paused; a couple of earned codes so Codes/Stock are not empty. Prints
the URL. Telegram is a stub that prints. Ctrl-C stops it.
