# CHZZK drops farm v1 — build contract (frozen 2026-10-23)

This is the single source of truth for the CHZZK farm. Every file below is written against
THIS document, not against sibling files that may not exist yet. If something is ambiguous,
pick the simplest reading and say so in your report — do not invent extra surface.

CHZZK (치지직, `chzzk.naver.com`) is Naver's streaming site. Its drops pay **coupon codes**
for watch minutes. The farm keeps N Naver logins "watching" campaign streams through the web
player's HTTP heartbeat (no video) and stores every earned code, encrypted, the moment it is
earned. Measured protocol and the probe: `_chzzk-probe/HANDOFF.md` in the main checkout
(git-excluded; holds real cookies — never copy anything from it into the repo).

## 0. Ground rules

- Node 20, CommonJS, **no new npm dependencies** (`socks-proxy-agent`, `mongoose`, `express`
  are installed; `mongodb-memory-server` for tests).
- Tests: `node:test` + `node:assert/strict`, in `tests/`, run with `node --test tests/<file>`.
  **Tests never touch the network** (no real CHZZK, no ipinfo). Model tests use
  `MongoMemoryServer` (see `tests/soopAutoClaim.test.js` lines 14 and 52-60 for the pattern).
- Each file stays under ~400 lines. Short header comment saying what the file is for;
  comments only where the WHY is not obvious. Plain English in every operator-facing message.
- **Never log, return, or persist in clear text**: cookies (any value), coupon codes.
  Cookies and codes are stored with `utils/secretBox` `encrypt()` / `decrypt()`.
- Untrusted text (campaign titles, nicknames, channel names) comes from CHZZK: server code
  treats it as data; UI renders it with `textContent` only — never string-built `innerHTML`.
- Mongoose: `returnDocument: "after"`, never `new: true`. No `allowDiskUse`.
- Do not edit any file you do not own (§1). Do not read sibling files to "match" them — code
  against this contract.
- CHZZK dates are KST strings `"YYYY-MM-DD HH:mm:ss"` (UTC+9, no DST). Store `Date` (UTC).

## 1. File ownership

| File(s) | Owner |
| --- | --- |
| `utils/chzzk/errors.js`, `utils/chzzk/http.js`, `utils/chzzk/cookies.js`, `utils/chzzk/normalize.js`, `tests/chzzkBasics.test.js` | A1 |
| `utils/chzzk/client.js`, `tests/chzzkClient.test.js` | A2 |
| `models/ChzzkAccount.js`, `models/ChzzkCampaign.js`, `models/ChzzkReward.js`, `models/ChzzkActivity.js`, `utils/chzzk/activity.js`, `utils/chzzk/codes.js`, `tests/chzzkCodes.test.js` | A3 |
| `tests/helpers/chzzkFake.js`, `tests/chzzkFake.test.js` | A4 |
| `utils/chzzk/worker.js`, `utils/chzzkFarm.js`, `tests/chzzkWorker.test.js`, `tests/chzzkFarm.test.js` | main session |
| `routes/chzzkRoutes.js`, `tests/chzzkRoutes.test.js` | A5 |
| `public/chzzk.html`, `public/chzzk/app.js` | U1 |
| `server.js`, `public/admin-nav.js` (small hunks, §12) | main session |

## 2. Errors — `utils/chzzk/errors.js`

```js
class ChzzkError extends Error { constructor(message, { code, status, cause } = {}) } // .code .status .cause
// code: "AUTH"    logged out (HTTP 401, or 403 with body.code 30001, or a user call saying loggedIn:false)
//       "EGRESS"  proxy missing/unusable/refused, network unreachable
//       "TIMEOUT" no full answer in time
//       "HTTP"    non-JSON body where JSON was expected, or a 5xx / unexpected status
//       "API"     CHZZK answered JSON with body.code !== 200 (message = body.message)
isAuthError(e)   // e.code === "AUTH"
isEgressError(e) // e.code === "EGRESS" || e.code === "TIMEOUT"
module.exports = { ChzzkError, isAuthError, isEgressError };
```

## 3. Transport — `utils/chzzk/http.js`

Same idea as `utils/soop/http.js` (read it for style: https.request, SocksProxyAgent built
lazily, one total timeout per exchange, credential scrubbing of the proxy URL in error text).

```js
createTransport({ proxyUrl, direct, agentFactory, request } = {})
// proxyUrl default: process.env.CHZZK_PROXY_URL || process.env.SOOP_PROXY_URL || ""
// direct   default: process.env.CHZZK_DIRECT === "1"
// FAILS CLOSED: no proxyUrl and not direct -> every call rejects ChzzkError EGRESS
//   ("No egress configured: set CHZZK_PROXY_URL (or CHZZK_DIRECT=1 for local tests)").
//   Proxy configured but agent cannot be built -> every call rejects EGRESS. Never go direct.
// request: injectable replacement for https.request (tests).
transport.request(url, { method = "GET", headers = {}, body = null, timeoutMs = 20000 })
  -> Promise<{ status, json, text }>   // json = parsed body or null when empty/not JSON
// It does NOT judge status codes; client.js does. Network errors -> EGRESS, timeout -> TIMEOUT.
// body: object -> JSON.stringify + content-type application/json; string/Buffer as-is.
transport.describe() -> "socks5h://127.0.0.1:1080" (never user:pass) | "direct" | "none"
transport.ready  // boolean
transport.stats() -> { requests, failures, lastOkAt, lastErrorAt, lastError }
getTransport()   // shared singleton
module.exports = { createTransport, getTransport };
```

## 4. Cookies — `utils/chzzk/cookies.js`

```js
parseImport(text) -> { jars: [ [{ name, value, domain }] ], errors: [string] }
// Accepts, in one paste: a Cookie-Editor JSON array; several arrays one after another
// (whitespace/newlines between them); a JSON array of arrays; {cookies:[...]};
// an object keyed by anything whose values are arrays or {cookies:[...]};
// a raw "name=value; name2=value2" header line (one jar per line).
// Keeps only cookies whose domain ends with "naver.com" (header-line cookies have domain "").
// A jar without BOTH NID_AUT and NID_SES is dropped with an error
// "Jar N has no NID_AUT/NID_SES — that export is logged out". Never echoes cookie values.
toHeader(jar) -> "NID_AUT=…; NID_SES=…; …"   // name=value joined by "; ", order kept
deviceIdOf(jar) -> value of "ba.uuid" or ""  // the web client's deviceId
sameLogin(a, b) -> boolean                   // NID_AUT values equal
module.exports = { parseImport, toHeader, deviceIdOf, sameLogin, REQUIRED: ["NID_AUT", "NID_SES"] };
```

## 5. Normalize — `utils/chzzk/normalize.js`

```js
kst(s) -> Date | null          // "2026-10-23 00:00:00" -> 2026-10-22T15:00:00Z; bad -> null
CODE_TYPES = ["CODE_FIRST_COME", "CODE_LOTTERY"]
campaignFromApi(c) -> {        // c = GET /service/v2/drops/campaigns/{no} content
  campaignNo: Number, title, categoryType, categoryId, categoryValue, imageUrl,
  state,                       // "PROMOTED" | "TERMINATED" | …
  startAt, endAt,              // Date
  needsLink: Boolean,          // !!(c.accountLinkUrl || c.providerId || c.externalProvider)
  guide: String,               // c.description, max 2000 chars
  rewards: [{ rewardNo: Number, title, rewardType, minutes: Number (conditionForMinutes),
              remaining: Number|null (codeRemainingCount), imageUrl }],
}
isFarmableReward(r) -> r.rewardType === "CODE_FIRST_COME" && r.remaining !== 0
                       || r.rewardType === "CODE_LOTTERY"
// A campaign is farmable at time t when: enabled, !needsLink, state !== "TERMINATED",
// startAt <= t < endAt, and it has at least one isFarmableReward.
isCampaignFarmable(camp, t) -> boolean      // camp in store shape (+ enabled field)
liveRow(l) -> { liveId, channelId, channelName, viewers, adult, paid, watchParty,
                openAt, dropsCampaignNo }   // from a drops-lives / live list row
// paid = !!(l.paidProductId || l.watchPartyPaidProductId); watchParty = !!l.watchPartyNo
```

## 6. Client — `utils/chzzk/client.js`

```js
makeClient({ cookies = null, deviceId = "", transport = getTransport() } = {})
// cookies null -> anonymous client (only public calls). Every call sends:
//   User-Agent: Chrome 141 macOS string; Accept "application/json, text/plain, */*";
//   Accept-Language "ko-KR,ko;q=0.9,en;q=0.8"; Origin "https://chzzk.naver.com";
//   Referer "https://chzzk.naver.com/" (live/<channelId> for live calls);
//   Front-Client-Product-Type "web"; Front-Client-Platform-Type "PC";
//   deviceId (from arg, else cookies' ba.uuid); Cookie (toHeader) when logged in.
// Judging answers (one helper):
//   status 401, or 403 with json.code 30001 -> AUTH
//   status 204 -> returns null
//   json with json.code === 200 -> returns json.content
//   json with another code -> API (message json.message)
//   no json and status >= 400 -> HTTP
API = "https://api.chzzk.naver.com", GAME = "https://comm-api.game.naver.com"
userStatus()            GET  GAME/nng_main/v1/user/getUserStatus
                        -> { loggedIn, userIdHash, nickname, penalties: [] }; loggedIn false -> throws AUTH
categoriesLive(next)    GET  API/service/v1/categories/live?size=50[&next fields]
                        -> { rows: [{categoryType, categoryId, categoryValue, openLiveCount, dropsCampaignNos:[]}], next|null }
campaign(no)            GET  API/service/v2/drops/campaigns/{no}             -> raw content
dropsLives(type,id,no,{size=20}) GET API/service/v1/categories/{type}/{id}/drops-lives?campaignNo=&size=&sortType=POPULAR
                        -> array of liveRow()
liveDetail(channelId)   GET  API/service/v3/channels/{id}/live-detail -> { liveId, openAt, status, dropsCampaignNo, channelName }
liveStatus(channelId)   GET  API/polling/v3.1/channels/{id}/live-status
                        -> { status, dropsCampaignNo, liveTokens: [], krOnly, blindType, adult, abroad }
watchEvent({ channelId, liveId, type, sessionId, positionAt, awt, liveTokens })
                        POST API/polling/v1/watch-event/live, header scene: "25", body
                        { channelId, liveId, payload: { watchEventType: type, sessionId, duration: 30,
                          positionAt, ...(awt ? { awt } : {}) }, liveTokens, autoPlay: false, radioMode: false }
                        -> true on 204/200
challenges()            GET  API/commercial/v2/drops/rewards/challenges -> content.challengeList || []
                        each { rewardNo, campaignNo, title, rewardType, conditionForMinutes, accumWatchMinutes, challengeStatus, codeRemainingCount }
claims()                GET  API/commercial/v2/drops/rewards/claims -> content.claimList || []
                        each { rewardNo, campaignNo, title, rewardType, fulfillmentState, createdDate, codeEndDate, categoryId, campaign:{title} }
couponCode(rewardNo)    GET  API/commercial/v1/drops/rewards/{no}/coupon-code -> { codeNo, code }
egressCountry()         GET  https://ipinfo.io/json (no cookies, no CHZZK headers) -> "JP" | "" 
module.exports = { makeClient, API, GAME };
```
Logged-in calls on an anonymous client throw `ChzzkError("Not logged in", {code:"AUTH"})`
without sending anything.

## 7. Models (A3)

`models/ChzzkAccount.js` — one row per Naver login.
```
userIdHash: String unique index (required)   nickname: String
cookies: String (encrypted JSON [{name,value,domain}])   cookieAt: Date   deviceId: String
status: String index, default "untested"     // untested | ok | not_logged_in
lastError: String   lastCheckedAt: Date   penalties: Number default 0
unusableSince: Date   unusableAlertAt: Date
sold: Boolean index default false   paused: Boolean default false   note: String
progress: Mixed default {}   // { [campaignNo]: { minutes, at } }
current: Mixed default null  // what the worker is doing now (§9 "current")
timestamps: true, minimize: false
```
`models/ChzzkCampaign.js` — campaignFromApi() fields + `enabled: Boolean default true`,
`source: String` ("scan" | "manual"), `lastSeenAt: Date` (last time discovery saw it live),
`refreshedAt: Date`. `campaignNo` unique Number. timestamps.

`models/ChzzkReward.js` — one row per (account, reward) that the account has EARNED.
```
accountId: String index (ChzzkAccount _id)   userIdHash: String
campaignNo: Number index   rewardNo: Number   unique index { accountId: 1, rewardNo: 1 }
title, rewardType, categoryId, campaignTitle: String
earnedAt: Date (claims createdDate, KST)   codeEndAt: Date (codeEndDate)
state: String   // "earned" (code not read yet) | "stored" | "in_app" (not a code — never fetched)
codeEnc: String (encrypted)   hasCode: Boolean index default false   codeNo: String
codeAt: Date   tries: Number default 0   nextTryAt: Date   lastError: String
revealedAt: Date   revealedBy: String
timestamps
```
**A row with `hasCode: true` is never deleted and its `codeEnc` never overwritten.**

`models/ChzzkActivity.js` — exactly like `models/SoopActivity.js` (14-day TTL; `at, level,
kind, accountId, campaignNo, msg, data`). `msg`/`data` never hold a cookie or a code.

`utils/chzzk/activity.js` — `add({ level="info", kind, accountId, campaignNo, msg, data })`
(never throws; also keeps the last 200 in memory), `list({ limit=100, accountId })` newest
first from Mongo, falls back to memory when Mongo is down.

## 8. Codes — `utils/chzzk/codes.js` (A3)

```js
createCollector({ Account, Reward, activity, clientFor, now = Date.now, sleep, gapMs = 3000 })
// clientFor(accountDoc) -> client (§6). Default deps are the real models/activity.
collector.collect(accountId, { reason }) -> Promise<{ read: n, stored: n, failed: n, error? }>
  // ONE global queue: collections run one at a time, gapMs between coupon-code calls.
  // 1. claims(). For each claim:
  //    - rewardType in CODE_TYPES and fulfillmentState === "COMPLIED": upsert a Reward row
  //      (state "earned" unless it has a code); if !hasCode, codeEndAt not past, and
  //      (nextTryAt null or <= now): couponCode(rewardNo) -> encrypt -> set codeEnc, hasCode,
  //      codeNo, codeAt, state "stored", lastError "". An empty code -> treat as failure.
  //      Failure: tries+1, lastError (short, no code), nextTryAt = now + 30 min.
  //    - rewardType "IN_APP": upsert row state "in_app" (never fetch anything).
  //    - anything else: ignore.
  // 2. AUTH from any call -> stop this account's collection and RETHROW (farm marks the login).
  //    EGRESS/TIMEOUT -> stop, return { error: "egress" }.
  // 3. activity: one "code" entry per stored code: `Stored the code for "<title>" on <nickname>`.
  // Uses findOneAndUpdate with filters that make "never overwrite a code" structural:
  // the code write filters on { _id, hasCode: { $ne: true } }.
collector.sweep(accountIds) -> runs collect for each in order, returns per-id results
collector.pending() -> number queued
collector.reveal(rewardId, who) -> { code, row } | null   // decrypt; stamps revealedAt/revealedBy
module.exports = { createCollector };
```

## 9. Worker — `utils/chzzk/worker.js` (main session)

`runSession({ account, client, campaigns, pickStream, onEvent, onProgress, onEarned, signal, clock, timings })`
watches for one account until aborted. Loop: pick campaign (farmable, not done for this
account, soonest `endAt` first; skip campaigns backed off for this account) → pick stream
(`pickStream(camp, account)` shared memo, top 5 by viewers, spread by account) → liveDetail +
liveStatus (must be OPEN, same dropsCampaignNo, not krOnly, blindType null) → WATCH_STARTED,
CONTINUED every 30 s, liveStatus every 60 s (new tokens; leave on close / campaign change),
challenges every 3 min (progress; a reward of this campaign leaving the list or reaching its
minutes → `onEarned(account)`), "not crediting" after 3 reads without a new minute → mark the
stream bad 30 min and pick another; 3 bad streams in a row → back the campaign off 30 min.
Done for a campaign when every farmable reward is earned. AUTH → end session with reason
"auth". EGRESS → wait and retry. Always sends WATCH_ENDED when leaving a stream.
`current` (written via onEvent) = `{ state: "watching"|"idle"|"waiting", campaignNo, title,
channelId, channelName, since, minutes, note }`.

## 10. Farm service — `utils/chzzkFarm.js` (main session)

Singleton. `start()` (idempotent, never throws, every timer `.unref()`):
egress check now + every 30 min; discovery 20 s after start + every 20 min; login checks
2 min after start + every 6 h; code sweep 8 min after start + every 3 h; login alert pass
every minute; supervisor every 30 s starting/stopping one worker per eligible account
(status ok|untested, !sold, !paused, switch on, egress ok).

**Switch**: `autoFarm.chzzkFarm` via `require("./settings").getAutoFarm()` — unset/unreadable =
ON; `CHZZK_FARM=0` env = OFF. Read at most every 30 s. `setSwitch(on, actor)` uses
`setAutoFarm({ chzzkFarm: on }, { actor })`.
**Egress OK** = transport ready AND `egressCountry()` in `CHZZK_COUNTRIES` (default
"JP,KR"). Unknown country = not OK. Not OK → workers stop; no logged-in call is sent.

Methods used by routes (all async unless noted, all return plain JSON-safe objects, never
cookies or codes):
```
stateView() -> { switch: { on }, egress: { via, country, ok, at, error }, totals: { accounts, ok,
  loggedOut, watching, codes, campaigns }, accounts: [accountView] }
  accountView = { id, nickname, userIdHash (first 8 chars), status, lastError, cookieAt,
  lastCheckedAt, sold, paused, note, current, progress, codes (count hasCode) }
importAccounts(text) -> [{ ok, created, nickname, userIdHash8, error }]  // checks each login live
checkAccounts(ids[])            -> { total }      // background, empty = all not sold
updateAccount(id, { sold, paused, note }) -> boolean
deleteAccounts(ids[])           -> { deleted, keptCodes }  // keeps Reward rows with hasCode
campaignsView()                 -> { campaigns: [campaignView] } // + farmable flag, per-reward
                                   earned counts across accounts
refreshCampaigns()              -> { found, updated }
addCampaign(no)                 -> { ok, campaign? , error? }
setCampaignEnabled(no, on)      -> boolean
rewardsView({ accountId, campaignNo }) -> { rewards: [rewardView] } // no codeEnc, ever
revealCode(rewardId, who)       -> { code } | null   // activity names who + which row, not the code
collectNow(ids[])               -> { queued }
activityView({ limit, accountId }) -> { entries }
setSwitch(on, actor)            -> { on }
```

## 11. Routes — `routes/chzzkRoutes.js` (A5)

Express router, every route `requireSuperadmin` (from `../middleware/auth`), JSON in/out,
`{ success: true, ...payload }` or `{ success: false, error }`. Same wrapper style as
`routes/soopRoutes.js` lines 66-151 (HttpError, `bad()`, input helpers, ChzzkError → 502 with a
plain sentence). Never logs a request body.
```
GET  /api/chzzk/state                       farm.stateView()
POST /api/chzzk/accounts/import  {cookies: string ≤ 90 kB}   -> { results }
POST /api/chzzk/accounts/check   {ids?: [id]}               -> { total }
POST /api/chzzk/accounts/update  {id, sold?, paused?, note? ≤ 500}  404 when unknown
POST /api/chzzk/accounts/delete  {ids: [id] (required)}     -> { deleted, keptCodes }
GET  /api/chzzk/campaigns                                   -> { campaigns }
POST /api/chzzk/campaigns/refresh                           -> { found, updated }
POST /api/chzzk/campaigns/add    {campaignNo: int 1..10^9}   -> 400 on {ok:false}
POST /api/chzzk/campaigns/enable {campaignNo, enabled: bool}
GET  /api/chzzk/rewards?accountId=&campaignNo=              -> { rewards }
POST /api/chzzk/rewards/reveal   {id: 24-hex}               -> { code } (404 none); who = req.session.admin.username
POST /api/chzzk/rewards/collect  {ids?: [id]}               -> { queued }
GET  /api/chzzk/activity?limit=(1..500)&accountId=          -> { entries }
POST /api/chzzk/switch           {on: bool}                 -> { on }  actor = admin username
```
`module.exports = router` (and `router.farm` may be swapped by tests via
`require("../utils/chzzkFarm")` being mocked — tests stub the farm module's methods).

## 12. Wiring (main session)

`server.js` (prod blob `dc45c471` == this branch's base): require `./utils/chzzkFarm` and
`./routes/chzzkRoutes` beside the SOOP ones; `app.get("/chzzk.html", requireSuperadmin,
enforce2fa, …no-store…)` beside `/soop.html`; `app.use(enforce2fa, chzzkRoutes)` beside
soopRoutes; `chzzkFarm.start()` beside `soopFarm.start()`. `public/admin-nav.js`: one item
`{ href: "/chzzk.html", label: "CHZZK farm", icon: ICONS.soop, superOnly: true }` in the
`soop` group.

## 13. Page — `public/chzzk.html` + `public/chzzk/app.js` (U1)

Shell copied from `public/do-servers.html` (its `<aside class="nav">` sidebar filled by
`/admin-nav.js`, its CSS tokens incl. dark theme, user chip + logout block). Sections:
1. Header: title "CHZZK farm", ON/OFF switch (POST /switch, confirm before OFF), egress chip
   ("via socks5h://… · JP · ok" green / red with the error).
2. Totals strip: accounts, ok, logged out, watching now, codes stored, campaigns farmable.
3. Import: textarea "Paste one or more Cookie-Editor exports (naver.com)" + Import button →
   per-jar result lines. Clears the textarea after a successful import.
4. Accounts table: nickname, status chip, now (current.state + campaign title + channel +
   minutes), codes, cookie age, actions (Check, Pause/Resume, Sold toggle, Delete with confirm).
5. Campaigns table: game (categoryValue), title, ends (local time + "in 5 h"), rewards
   ("15m CODE · 22,423 left"), farmable chip, Enable/Disable; "Add campaign #" input; Refresh.
6. Codes table (GET /rewards): earned at, account, game, reward, state, Reveal → shows code
   in the row + Copy button (navigator.clipboard), hidden again after 60 s.
7. Activity: last 100 entries (GET /activity), level color.
Poll `/state` every 10 s, the other lists every 60 s and after any action. All text from
the API via `textContent`. Fetch with `credentials: "same-origin"`; 401 → `/admin-login.html`.
No external scripts/fonts.

## 14. Fake CHZZK for tests — `tests/helpers/chzzkFake.js` (A4)

An in-memory CHZZK that hands out clients with exactly the §6 method names and return shapes.
No network, no timers of its own (time is whatever `now()` says).
```js
createFakeChzzk({ campaigns = [], lives = [], minutesPerBeat = 0.5, now = Date.now } = {})
// campaigns: raw API campaign objects (as GET /service/v2/drops/campaigns returns content):
//   { campaignNo, title, categoryType, categoryId, categoryValue, state, startDate, endDate
//     (KST strings), accountLinkUrl, rewardList: [{ rewardNo, title, rewardType,
//     conditionForMinutes, codeRemainingCount }] }
// lives: [{ channelId, channelName, liveId, categoryType, categoryId, dropsCampaignNo,
//           viewers, adult=false, krOnly=false, status="OPEN", openDate (KST) }]
fake.clientFor(key)          // key = any string (an account id); logged-in client
fake.anonymous()             // client with only public calls working (others -> AUTH)
// Behaviour:
//  - categoriesLive: one page with each category that has an OPEN drops live
//    (dropsCampaignNos from the lives), next null.
//  - dropsLives(type,id,no): OPEN lives of that campaign, viewers desc, as liveRow().
//  - watchEvent WATCH_CONTINUED on an OPEN live whose campaign is in its window adds
//    minutesPerBeat to (key, campaignNo) minutes, unless fake.noCredit(channelId) was called.
//  - challenges(): for each campaign the key has sent ≥1 event for: its CODE_* rewards not yet
//    reached, with accumWatchMinutes = floor(minutes), challengeStatus "IN_PROGRESS".
//  - claims(): reached rewards, fulfillmentState "COMPLIED", createdDate (KST of reach time),
//    codeEndDate "2026-11-30 23:59:59".
//  - couponCode(rewardNo): earned -> { codeNo: "<n>", code: "FAKE-<key>-<rewardNo>" };
//    not earned -> ChzzkError API.
//  - userStatus(): { loggedIn: true, userIdHash: "hash-<key>", nickname: "nick-<key>", penalties: [] }
//  - egressCountry(): fake.country (default "JP").
fake.logout(key)             // every logged-in call for key -> ChzzkError AUTH
fake.failNext(method, code, n = 1) // next n calls of method (any key) throw ChzzkError(code)
fake.noCredit(channelId)
fake.setLive(channelId, patch) // e.g. { status: "CLOSE" } or { dropsCampaignNo: 9 }
fake.minutes(key, campaignNo) -> number
fake.calls                   // [{ key, method, args }] in call order
fake.country = "JP"
module.exports = { createFakeChzzk };
```
Errors are real `ChzzkError` from `utils/chzzk/errors.js` (A1 writes it; require it lazily
or write against the §2 shape).
