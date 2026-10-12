# SOOP farm v2 — build contract (frozen 2026-10-06)

This is the single source of truth for the rebuild of the SOOP drops farm. Every
file below is written against THIS document, not against sibling files that may
not exist yet. If something here is ambiguous, pick the simplest reading and say
so in your report — do not invent extra surface.

Background reading (do not copy from, but understand): `docs/SOOP-FARM.md`,
`_soop-probe/HANDOFF.md`, and the v1 files being replaced
(`git show origin/codex/soop-farm:<path>` always has the v1 bytes).

## 0. Ground rules

- Node 20, CommonJS, no new npm dependencies (`ws`, `socks-proxy-agent`,
  `mongoose`, `express` are installed; `mongodb-memory-server` for tests).
- Tests use `node:test` + `node:assert/strict`, live in `tests/`, and must not
  touch the network. Run one with `node --test tests/<file>`.
- Each file stays under ~350 lines. Match the comment density of v1: a short
  header saying what the file is for, comments only where the WHY is not obvious.
- **Never call sooplive.com** from a test, a script you run, or while developing.
- **Never log, return or persist in clear text**: cookies, `AuthTicket`, reward codes.
- **Never claim a drop.** The system only reads inventory.
- Untrusted text: campaign titles, nicknames, item names and messages come from
  SOOP. Server code treats them as data; UI code renders them with
  `textContent` / the `Soop.el` builder — never string-built `innerHTML`.
- Mongoose: use `returnDocument: "after"`, never `new: true`. No `allowDiskUse`.
- Do not edit `server.js`, `public/admin-nav.js`, `package.json` or any file you
  do not own in the table below. Entry points stay where v1 had them:
  `require("./routes/soopRoutes")`, `require("./utils/soopFarm").start()`,
  page at `/soop.html`.

## 1. File ownership

| File | Owner |
| --- | --- |
| `utils/soop/errors.js`, `utils/soop/http.js`, `utils/soop/geo.js`, `tests/soopHttpGeo.test.js` | A1 |
| `utils/soop/i18n.js`, `tests/soopI18n.test.js` | A2 |
| `utils/soop/normalize.js`, `tests/soopNormalize.test.js` | A3 |
| `utils/soopClient.js`, `tests/soopClient.test.js` | A4 |
| `models/SoopAccount.js`, `models/SoopCampaign.js`, `models/SoopFarmTask.js`, `models/SoopInventoryItem.js`, `models/SoopGame.js`, `models/SoopTranslation.js`, `models/SoopActivity.js`, `utils/soop/campaignStore.js`, `tests/soopCampaignStore.test.js` | A5 |
| `utils/soop/activity.js`, `utils/soop/inventory.js`, `utils/soop/health.js`, `tests/soopServices.test.js` | A6 |
| `utils/soopWorker.js`, `utils/soopFarm.js` | main session |
| `routes/soopRoutes.js`, `tests/soopRoutes.test.js` | A8 |
| `tests/helpers/soopFake.js`, `scripts/soop-dev-harness.js`, `scripts/soop-status.js` | A9 |
| `public/soop.html`, `public/soop/soop.css`, `public/soop/core.js`, `public/soop/UI-KIT.md` | U1 |
| `public/soop/tab-*.js` (one per tab, see §9) | U2–U6 |

## 2. Errors — `utils/soop/errors.js`

```js
class SoopError extends Error { constructor(message, { code, cause } = {}) }  // .code, .cause
// codes: "AUTH" session not logged in · "EGRESS" proxy missing/down, network
// unreachable, country unknown · "TIMEOUT" · "HTTP" non-JSON or bad status ·
// "API" SOOP answered result !== 1 for another reason
const LOGIN_RE = /log ?in|sign ?in|로그인/i;
isAuthError(e), isEgressError(e)   // EGRESS or TIMEOUT count as egress
module.exports = { SoopError, LOGIN_RE, isAuthError, isEgressError };
```

## 3. Transport — `utils/soop/http.js`

One request path for proxied and direct traffic (v1 used `fetch` direct and
`https.request` proxied, so the two paths sent different headers).

```js
createTransport({ proxyUrl = process.env.SOOP_PROXY_URL || "", agentFactory } = {}) -> transport
getTransport()            // lazy process singleton built with the defaults
transport = {
  proxied,                // boolean: a proxy URL is configured
  ready,                  // false when proxied but no agent could be built
  describe(),             // "direct" | "socks5h://127.0.0.1:1080" (never credentials)
  requestJson(url, { method = "GET", headers = {}, body = null, timeoutMs = 20000 }) -> Promise<object>,
  wsOptions(),            // {} direct, { agent } proxied; throws EGRESS when !ready
  stats(),                // { requests, failures, lastOkAt, lastErrorAt, lastError }
}
```

- `agentFactory(proxyUrl)` defaults to `new (require("socks-proxy-agent").SocksProxyAgent)(proxyUrl)`,
  required lazily inside a try/catch so a missing package cannot stop the app booting.
- **Fail closed**: `proxied && !ready` makes every `requestJson` reject with
  `SoopError("EGRESS")` and `wsOptions()` throw. It must never fall back to a
  direct connection (v1 did, which would send every account from the US server IP).
- `requestJson` always uses `https.request` (agent only when proxied). `body` may
  be a string, Buffer or `URLSearchParams`; set `content-length`. Parse JSON or
  throw `HTTP` with `"<url> -> HTTP <status>: <first 160 chars>"`. Socket errors
  (`ECONNREFUSED`, `ECONNRESET`, `EHOSTUNREACH`, `ENOTFOUND`, socks failures) → `EGRESS`;
  timer → `TIMEOUT`. Update `stats()` on every call.

## 4. Geo — `utils/soop/geo.js`

SOOP credits watch time only when the country claimed in the bridge handshake is
the one it sees for the connection, AND that country is one it pays drops in
(measured 2026-10-04: JP yes, LK yes, US no).

```js
ISO_NUMERIC               // alpha-2 -> 3-digit string, at least 80 common countries (JP "392", KR "410", LK "144", US "840", …)
numericFor(cc) -> string | null
creditStatus(cc) -> "yes" | "no" | "unknown"       // from the measured table above
createGeoResolver({ ttlMs = 30 * 60 * 1000, env = process.env, now = Date.now } = {}) -> {
  get(fetchCountry) -> Promise<{ cc, joinCc, geoRc }>,   // fetchCountry: async () => "JP" | null
  peek() -> { cc, joinCc, geoRc, at } | null,
  invalidate(),
}
```

- `SOOP_GEO_CC`, `SOOP_JOIN_CC`, `SOOP_GEO_RC` override the respective field.
- `joinCc` = override, else `numericFor(cc)`, else `"392"`. `geoRc` = override, else `"13"`.
- A successful lookup is cached for `ttlMs`. **A failed or empty lookup throws
  `SoopError("EGRESS")` and caches nothing** (v1 cached a "JP" fallback for the
  whole process, after which the account earned nothing). Concurrent `get()`
  calls share one in-flight lookup.

## 5. Language — `utils/soop/i18n.js`

SOOP is asked for English (`accept-language`, see §7); this module cleans up what
it still returns in Korean.

```js
hasHangul(s) -> boolean
translate(s, { overrides } = {}) -> string
//   overrides: Map or plain object of exact source -> english, checked first.
//   Then glossary phrase replacement, longest phrase first; collapse whitespace;
//   trim. Unknown Hangul is left as is (never dropped). Non-strings -> "".
GLOSSARY                  // [[korean, english], …], 120+ entries: drops vocabulary
//   (드롭스, 인게임 아이템, 시청 미션, 이벤트, 결승전, 예선, 시즌, 주차, 회차, 생방송, 입중계,
//   상품권, 문화상품권, 기프티콘, 쿠폰, 코인 …), weekdays in brackets ((일)…(토)),
//   and game / league / broadcaster names seen in _soop-probe/events.json.
GAMES                     // { [gameNo]: { name, kind: "game" | "tv" | "sports" | "platform" } }
//   seed from _soop-probe/events.json (gameNo + cateName + titles), e.g.
//   "12" Overwatch, "18" Eternal Return, "200" Delta Force, "244" Wuthering Waves,
//   "8" PUBG, "4" League of Legends, "6" Teamfight Tactics, "14" VALORANT,
//   "16" StarCraft II, "10" StarCraft, "26" THE FINALS, "30" FC Online …
gameName(gameNo, { cateName, typeNm, overrides } = {}) -> string
//   overrides[gameNo] > GAMES > translate(cateName) > PROVIDERS[typeNm] > "Game #<gameNo>" > "Other"
PROVIDERS                 // { kuro: "Kuro Games", krafton: "KRAFTON", riot: "Riot Games", nexon: "NEXON" }
rewardKind(itemType) -> "code" | "link" | "ingame" | "other"     // "1" | "2" | "4" | anything else
REWARD_KIND_LABEL         // { code: "Code", link: "Link / form", ingame: "In-game (linked account)", other: "Other" }
GIVE_CON_LABEL            // { term: "Guaranteed", draw: "Raffle", none: "Random" }
```

## 6. Normalised shapes — `utils/soop/normalize.js`

```js
parseKst(s) -> Date | null     // "2026-10-11 05:00:00" is Korea time (+09:00). "", null, "0000-00-00 00:00:00", invalid -> null
stepsOf(rawOrCampaign) -> number[]   // unique giveTerm (raw) or items[].minutes (normalised), > 0, ascending
normalizeCampaign(raw, { overrides, gameOverrides, filter } = {}) -> Campaign
normalizeMission(raw) -> Mission
normalizeInventoryItem(raw, division) -> InventoryItem
```

```
Campaign = {
  dropsIdx: string, title: string, titleRaw: string, image: string|null,
  gameNo: string|null, gameName: string,
  giveCon: string, guaranteed: boolean (giveCon === "term"),
  live: boolean, filter: "progress" | "scheduled" | "completed" | "unlisted",
  startAt: Date|null, endAt: Date|null,
  categoryWide: boolean (no channel list AND a cateNo), cateNo: string|null, cateName: string,
  channels: [{ id, nick, onAir: boolean }],
  items: [{ name, nameRaw, kind, minutes: number, image: string|null }],   // ascending minutes
  steps: number[], rewardKind: string (kind of the majority of items),
  needsLink: boolean (ingameGiveYn === "Y"), provider: string|null (typeNm),
}
Mission = { dropsIdx: string, minutes: number (max viewTime), items: [{ name, minutes (giveTerm), viewTime }] }
InventoryItem = {
  key: string,           // stable per account+item: first present of raw.idx, itemIdx, dropsItemIdx,
                         // giveIdx, seq, no; else sha1 of name|sendDate|expiry|gameNo (hex, 16 chars)
  division: "available" | "acquired" | "expired",
  name, nameRaw, kind, gameNo: string|null, gameName, image: string|null,
  expiresAt: Date|null   (expDate || useExpDate),
  sentAt: Date|null (sendDate), receivedAt: Date|null (receiveDate),
  needsLink: boolean (ingameGiveYn === "Y" && acctConn === false),
  linkPath: string|null (acctLinkPath || loginPath), used: boolean (useFlag === "Y"),
  code: string|null      (itemCode || code || pinNo || couponNo) — the caller encrypts it,
  raw: object            // the raw row WITHOUT the four code fields
}
```

Raw field names are in `_soop-probe/events.json` (campaigns) and in v1
`routes/soopRoutes.js` (inventory). `title`, `cateName` and item names go through
`translate`; the untouched text is kept in `titleRaw` / `nameRaw`.

## 7. Client — `utils/soopClient.js`

Port of v1 with the transport, geo and error modules swapped in.

```js
parseCookieInput(text) -> [{ name, value }]            // v1 behaviour, unchanged
splitCookieExports(text) -> string[]                   // bulk paste: several Cookie-Editor JSON arrays one
//   after another, and/or lines of "AuthTicket=…". One entry per account. A single export -> [text].
makeClient(cookies, { id = null, transport = getTransport(), geo = sharedGeo(), lang = "en-US,en;q=0.9" } = {}) -> client
sharedGeo()                                            // one geo resolver per process (country belongs to the egress, not the account)
client = {
  id,
  privateInfo() -> { loggedIn, loginId, nick, country },   // never throws AUTH; a logged-out reply is { loggedIn: false, … }
  missions() -> Mission[],                                   // normalised (§6)
  campaigns(filter = "progress") -> raw[],                   // raw rows, each tagged { filter }
  campaignsAll() -> raw[],                                   // "progress" + "scheduled", de-duplicated by dropsIdx
  liveInfo(bj, bno = "") -> CHANNEL object | null,
  categoryChannels(cateNo, limit = 5) -> string[],           // top live channel ids by viewers
  inventoryCounts() -> { available, acquired, expired },     // numbers
  inventory(division) -> raw[],
  openBridge(bj, ch, { onEvent } = {}) -> { joined, closed, error, stop() },
}
```

- Every request sends `cookie`, `user-agent`, `accept-language: <lang>`, and the
  `origin` / `referer` of the site that owns the endpoint **inside `headers`**
  (v1 passed several outside `headers`, where they were silently ignored):
  `drops.sooplive.com` endpoints use origin `https://drops.sooplive.com`; the
  rest use `https://play.sooplive.com`.
- A reply with `result !== 1`: `result === -1` or a message matching `LOGIN_RE`
  → throw `AUTH`; anything else → `API` with SOOP's message.
- `campaigns()` keeps v1's request shape (`{ filter, gameIdx: "all", prePageNo: p, pageNo: p }`,
  one event per page, stop on an empty page), page cap 80.
- `openBridge`: v1 handshake, except the JOINLOG fields `geo_cc`, `join_cc`,
  `geo_rc` come from `geo.get(() => privateInfo().country)`. If that throws, the
  socket is closed, `state.error = "geo"` and `onEvent("error:geo")` fires — it
  must not join with a guessed country. `ws` options come from
  `transport.wsOptions()` (a throw there → `state.error = "egress"`, `state.closed = true`,
  no socket). `stop()` is idempotent and never throws.

## 8. Data models (A5)

Collections keep their v1 names so production rows keep working. New fields get
defaults; nothing is renamed.

- **SoopAccount** — `loginId` (unique), `nickname`, `country`, `cookies` (encrypted),
  `cookieAt: Date` (when the cookie was last imported), `status`
  (`ok | not_logged_in | drops_rejected | untested`), `lastError`, `lastCheckedAt`,
  `deadAt: Date|null`, `check: Mixed`, `sold: Boolean`, `note: String`,
  `progress: Mixed` default `{}` — `{ [dropsIdx]: { minutes, max, goal, done, at } }`.
- **SoopCampaign** — v1 fields plus `titleRaw`, `gameNo`, `image`, `ingameGiveYn`,
  `typeNm`, `lastLiveAt: Date|null`. `startDate` / `endDate` are real instants (§6 `parseKst`).
- **SoopFarmTask** (a "bot") — `label` (the bot name), `mode`
  (`campaign | game | auto`, default `campaign`), `dropsIdx` (no longer required),
  `gameNo`, `target` (`all | first`), `codesOnly: Boolean` default false,
  `accountIds: [String]`, `doneIds: [String]`, `active`, `startedAt`, `endedAt`.
- **SoopInventoryItem** — `loginId` + `key` (compound unique), every §6
  InventoryItem field except `code`, plus `hasCode: Boolean`, `codeEnc: String`
  (via `utils/secretBox`), `syncedAt`. Indexes: `loginId`, `division`, `gameNo`, `expiresAt`.
- **SoopGame** — `gameNo` (unique), `name`, `hidden: Boolean`.
- **SoopTranslation** — `source` (unique), `english`.
- **SoopActivity** — `at: Date` (TTL index, 14 days), `level` (`info | warn | error`),
  `kind`, `accountId`, `botId`, `dropsIdx`, `msg`, `data: Mixed`. Index `{ at: -1 }`.

### Campaign store — `utils/soop/campaignStore.js`

```js
createCampaignStore({ models = { SoopCampaign, SoopGame, SoopTranslation }, ttlMs = 60000, staleOkMs = 600000, now = Date.now } = {}) -> {
  load(),                                   // remembered campaigns + name overrides from the DB
  list({ scan, force = false }) -> Promise<Campaign[]>,
  //   scan: async () => raw[] (client.campaignsAll). Cached for ttlMs — an EMPTY list is cached too.
  //   One in-flight scan shared by all callers. If the scan fails and the last good list is younger
  //   than staleOkMs, return it; otherwise rethrow.
  get(dropsIdx) -> Promise<Campaign|null>,  // listed, else remembered (memory, then DB) as filter "unlisted"
  all() -> Campaign[],                      // last listed + remembered-but-unlisted (filter "unlisted", live false)
  games() -> [{ gameNo, name, campaigns, live, guaranteed }],   // from all(), sorted live desc then name
  setGameName(gameNo, name), setTranslation(source, english),   // persist + apply to cached rows
  lastScan() -> { at, ok, error, count },
}
```

Each successful scan upserts every row (`bulkWrite`, unordered, fire-and-forget
with a logged catch) and sets `live` to what SOOP reports now; `lastLiveAt` is
stamped when it is true. (v1 never cleared `live`, so 37 of 47 remembered rows say live.)

## 9. Services (A6)

```js
// utils/soop/activity.js
createActivityLog({ model = SoopActivity, cap = 500, flushMs = 5000 } = {}) -> {
  add({ level = "info", kind, accountId, botId, dropsIdx, msg, data }),   // memory ring + queued DB write
  recent({ limit = 200, level, accountId, botId } = {}) -> entry[],       // newest first, from memory
  flush() -> Promise, stop(),
}
// utils/soop/inventory.js
createInventoryService({ models = { SoopInventoryItem }, getClient, activity, paceMs = 2500, now = Date.now }) -> {
  syncAccount(id) -> Promise<{ id, counts, items, added, at }>,   // upsert by key, delete rows that vanished
  syncMany(ids) -> { total },                                     // background, one account per paceMs
  status() -> { running, done, total, lastAt, errors },
  summary() -> Promise<{ totals: { available, acquired, expired, expiringSoon }, lastSyncAt,
    games: [{ gameNo, gameName, items: [{ name, kind, image, available, acquired, expired, soonestExpiry, accountIds }] }] }>,
  forAccount(id) -> Promise<item[]>,                              // no code, no codeEnc
  revealCode(itemId) -> Promise<string|null>,
  csv() -> Promise<string>,                                       // loginId,game,item,kind,division,expiresAt,hasCode — no codes
}
// utils/soop/health.js
createHealthService({ models = { SoopAccount }, getClient, activity, onDead, paceMs = 4000, everyMs = 6 * 3600 * 1000, now = Date.now }) -> {
  check(id) -> Promise<{ at, loggedIn, nick, country, dropsOk, dropsError, missions }>,
  checkMany(ids) -> { total }, status(), start(), stop(),
}
```

- `getClient(id)` is async and returns a §7 client (or throws).
- `expiringSoon` = available items expiring within 72 hours.
- Health: logged out → status `not_logged_in`, `deadAt` set, `onDead(id, reason)`
  called once. Missions throwing `AUTH` → `drops_rejected`. **An `EGRESS` /
  `TIMEOUT` error changes nothing but `lastError`** — a tunnel blip must not mark
  an account dead. `start()` sweeps every non-sold account every `everyMs`, paced.
- All timers are `unref()`ed and injectable enough to test without real waiting.

## 10. Worker and farm service (main session)

`utils/soopWorker.js` exports `runSession(opts)`; `utils/soopFarm.js` exports the
singleton service. Other files use ONLY this surface:

```js
farm.start() -> Promise                    // idempotent; loads stores, resumes active bots, starts health sweep
farm.started                               // boolean
farm.setClientFactory(fn)                  // tests / harness: fn(cookies, { id }) -> client (§7 shape)
farm.setClock({ now, sleep })              // tests: sleep(ms, signal) -> Promise, rejects/resolves early on abort
farm.stateView() -> Promise<State>         // §11 GET /state payload minus `success`
farm.campaignsView({ force }) -> Promise<{ campaigns, games, scan }>
farm.importAccounts(text) -> Promise<[{ ok, id, nick, country, error }]>
farm.checkAccounts(ids) -> { total }       // background, paced
farm.updateAccount(id, { sold, note }) -> Promise<boolean>     // sold: true also stops its session
farm.deleteAccounts(ids) -> Promise<number>
farm.createBot({ name, mode, dropsIdx, gameNo, accountIds, target, codesOnly }) -> Promise<{ ok, bot } | { ok: false, error }>
farm.updateBot(id, { name, target, addIds, removeIds }) -> Promise<{ ok, bot } | { ok: false, error }>
farm.stopBot(id) / farm.resumeBot(id) / farm.deleteBot(id) -> Promise<{ ok, error }>
farm.stopAllBots() -> Promise<number>
farm.renameGame(gameNo, name), farm.setTranslation(source, english) -> Promise
farm.inventory                             // §9 inventory service
farm.activity                              // §9 activity log
farm.health                                // §9 health service
```

Rules the farm enforces (routes and UI may rely on them):

- An account is in at most one active bot; sold or `not_logged_in` accounts cannot be added.
- Bot modes: `campaign` farms one pinned `dropsIdx` and finishes when every account
  reached its goal; `game` farms every guaranteed campaign of one `gameNo` as each
  goes live and never finishes on its own; `auto` does the same for every game.
  `codesOnly` skips campaigns whose rewards need a linked game account.
- Stopping is immediate (interruptible waits); a stopped account can be restarted at once.
- A dead login stops that account's session, marks it `not_logged_in` and raises an alert.

## 11. HTTP API — `routes/soopRoutes.js` (A8)

Every route: `requireSuperadmin` (from `middleware/auth`), JSON in/out, success
`{ success: true, … }`, failure `{ success: false, error, message }` (same text
in both) with 400 for bad input, 404 unknown id, 502 when SOOP/egress failed,
500 otherwise (log `console.error("soop <route> error:", err.message)`, never the body).
Thin handlers: validate, call the farm, shape nothing.

| Method + path | Body / query | Returns (besides `success`) |
| --- | --- | --- |
| GET `/api/soop/state` | — | `State` (below) |
| GET `/api/soop/campaigns` | `?force=1` | `{ campaigns: Campaign[], games: Game[], scan }` |
| POST `/api/soop/accounts/import` | `{ cookies }` (one or many exports) | `{ results: [{ ok, id, nick, country, error }] }` |
| POST `/api/soop/accounts/check` | `{ ids: [] }` (empty = all) | `{ total }` |
| POST `/api/soop/accounts/update` | `{ id, sold?, note? }` | `{}` |
| POST `/api/soop/accounts/delete` | `{ ids: [] }` | `{ deleted }` |
| POST `/api/soop/bots/create` | `{ name, mode, dropsIdx?, gameNo?, accountIds, target, codesOnly }` | `{ bot: Bot }` |
| POST `/api/soop/bots/update` | `{ id, name?, target?, addIds?, removeIds? }` | `{ bot: Bot }` |
| POST `/api/soop/bots/stop` | `{ id }` or `{ all: true }` | `{ stopped }` |
| POST `/api/soop/bots/resume` | `{ id }` | `{}` |
| POST `/api/soop/bots/delete` | `{ id }` | `{}` |
| POST `/api/soop/games/rename` | `{ gameNo, name }` | `{}` |
| POST `/api/soop/translate` | `{ source, english }` | `{}` |
| GET `/api/soop/inventory/summary` | — | inventory `summary()` + `{ sync: status() }` |
| GET `/api/soop/inventory/account` | `?id=` | `{ items }` |
| POST `/api/soop/inventory/sync` | `{ ids: [] }` (empty = all non-sold) | `{ total }` |
| POST `/api/soop/inventory/reveal` | `{ itemId }` | `{ code }` (logs an activity entry, kind `reveal`) |
| GET `/api/soop/inventory/export.csv` | — | `text/csv` attachment `soop-inventory.csv` |
| GET `/api/soop/activity` | `?limit&level&accountId&botId` | `{ entries }` |

```
State = {
  now: ISO string, started: boolean,
  egress: { proxied, ready, via: string, country: string|null, credited: "yes"|"no"|"unknown",
            lastOkAt, lastErrorAt, lastError },
  totals: { accounts, ok, dead, sold, farming, waiting, idle, bots, botsActive },
  accounts: [Account], bots: [Bot], alerts: [Alert],
  scan: { at, ok, error, count },
  inventory: { running, done, total, lastAt },
  metrics: { rssMB, heapMB, cpuPct, sockets, freeMemMB, totalMemMB, samples: [{ t, rssMB, cpu }] },
}
Account = { id, nick, country, status, lastError, sold, note, createdAt, cookieAt, lastCheckedAt,
            botId: string|null, session: Session|null }
Session = { state: "starting"|"farming"|"waiting"|"backoff"|"stopping"|"error",
            detail: string,            // human sentence, e.g. "Campaign is not live yet"
            dropsIdx, title, channel, minutes, goal, since, lastEventAt,
            credited: true|false|null  // null = not known yet
          }
Bot = { id, name, mode, dropsIdx, gameNo, gameName, title, target, codesOnly, active,
        state: "running"|"waiting"|"stopped"|"finished",
        createdAt, startedAt, endedAt, accountIds: [], doneIds: [],
        counts: { total, farming, waiting, done, error }, minutes: { sum, goalSum } }
Alert = { id, level: "error"|"warn"|"info",
          kind: "egress"|"auth"|"not-crediting"|"expiring"|"scan"|"geo"|"country",
          msg, accountId: string|null, botId: string|null, at }
Game = { gameNo, name, campaigns, live, guaranteed }
Campaign = §6 shape with dates as ISO strings, plus { botIds: [] } (bots farming it)
```

`tests/soopRoutes.test.js` keeps v1's two guarantees — the serialised `/state`
body never contains a stored cookie value, and every route answers 401 anonymous /
403 non-superadmin — and adds: a route table check (every path above exists),
bot create → stop → resume → delete through HTTP against the fake world (§12),
bulk import, and that `/inventory/account` and `/inventory/summary` never contain a code.

## 12. Fake SOOP and dev harness (A9)

`tests/helpers/soopFake.js` — an in-memory SOOP, no network:

```js
createFakeSoop({ now = Date.now } = {}) -> world
world.addAccount({ id, nick, country = "LK", loggedIn = true }) -> cookies   // [{ name: "AuthTicket", value }]
world.addCampaign(partialRaw) -> raw       // sensible defaults; fields as in _soop-probe/events.json
world.setLive(dropsIdx, bool), world.setOnAir(channelId, bool), world.delist(dropsIdx)
world.logout(id), world.setEgress({ country, down })
world.addInventory(id, rawItem, division)
world.advance(minutes)                     // credits `minutes` to every account holding a joined bridge on an
//   on-air channel of a LIVE campaign, when the bridge's claimed country equals the egress country and that
//   country is credited (§4). Otherwise nothing is credited.
world.clientFor(cookies, { id }) -> client // full §7 client shape; the function to hand to farm.setClientFactory
world.bridges() -> [{ id, channel, joined, claimedCountry }]
world.calls() -> { [method]: count }       // for pacing / dedupe assertions
```

The fake client throws the same `SoopError` codes as the real one (logged-out →
`AUTH` from missions / inventory; `down` → `EGRESS`). `openBridge` joins on the
next macrotask and reports the country it claimed.

`scripts/soop-dev-harness.js` — `node scripts/soop-dev-harness.js [port=4599]`:
Express + `mongodb-memory-server` + a stub superadmin session + `routes/soopRoutes`
+ static `public/` (and `/soop.html`), a stub `GET /whoami` so `admin-nav.js`
does not redirect, the farm wired to a fake world seeded with ~12 accounts
(one logged out, one sold), ~14 campaigns across 5 games (live / scheduled /
unlisted, guaranteed and not, one category-wide, Korean and English titles),
inventory rows, and a timer that calls `world.advance(1)` every 2 s so progress
visibly moves. It sets `CRED_SECRET` if unset and must never connect to the real
database or to SOOP. Print the URL on start.

`scripts/soop-status.js` — read-only CLI for production: connects with `MONGO_URI`
(dotenv), prints accounts by status, bots, remembered campaigns and inventory
totals. Never prints cookies or codes, never calls SOOP, never writes.

## 13. UI (U1, then U2–U6)

One page, `/soop.html`, in the site's existing shell (theme bootstrap script in
`<head>`, the static `<aside>` sidebar, `/theme.js`, `/admin-nav.js` — copy the
shell markup from v1 `public/soop.html`). Everything SOOP-specific lives in
`public/soop/`. Plain ES2019 scripts, no build step, no framework, no CDN.
Light and dark themes via the existing `html[data-theme="dark"]` variables.
Usable at phone width (the sidebar collapses the way other admin pages do).

**U1 owns the kit**: `soop.css` (tokens, layout, components), `core.js`, the page
shell with a tab bar, and `UI-KIT.md` listing every class and helper with a
one-line example. Tab files use only what `UI-KIT.md` documents.

```js
window.Soop = {
  state,                          // last GET /state payload (null until first load)
  campaigns, games, scan,         // last GET /campaigns payload
  api: { get(path), post(path, body) },   // resolve with the JSON; reject with Error(message) on !success
  refresh(), refreshCampaigns(force),      // manual reloads; core polls /state every 3 s, /campaigns every 60 s
  on(event, fn),                  // "state" | "campaigns" | "tab"
  registerTab({ id, label, render(root), update(), badge() }),
  //   render once into an empty root; update() on every "state"/"campaigns" while visible; badge() -> string|number|null
  go(tabId, params),              // switch tab (also reflected in location.hash)
  el(tag, attrs, ...children),    // DOM builder; strings become text nodes; attrs: class, dataset, on*: handlers
  toast(msg, tone), confirm({ title, body, danger, okLabel }) -> Promise<boolean>,
  modal({ title, body, actions }) -> { close() }, drawer({ title, body }) -> { close() },
  fmt: { mins(n), ago(iso), when(iso), until(iso), pct(a, b), num(n) },
  ui: { badge(text, tone), dot(tone), progress(value, max, tone), empty(title, hint, action),
        button(label, { tone, size, icon, onClick, disabled }), stat(label, value, hint, tone),
        table({ columns, rows, key, onRow, empty }), chips({ options, value, onChange, multi }),
        search({ placeholder, onInput }), menu(button, items) },
  accountById(id), botById(id), campaignById(dropsIdx), gameName(gameNo),
};
```

Tabs (file → owner):

- `tab-overview.js` (U2) — status strip (egress + country + "credited here?",
  accounts ok / dead, bots, scan age), alerts list with a fix action per kind,
  "Live now" (live guaranteed campaigns, who is farming each, one-click
  "Start bot"), compact resource meter.
- `tab-bots.js` (U3) — bot cards with per-account progress, state and detail;
  create wizard: 1 choose mode (a game · one campaign · everything), 2 pick the
  game or campaign (search, live first), 3 accounts (all free · first N · tick),
  4 options (target all steps / first step, codes only) and a summary; stop,
  resume, rename, add / remove accounts, delete.
- `tab-campaigns.js` (U4) — game chips with counts, filters (live · upcoming ·
  ended/unlisted · guaranteed only, on by default), search, cards showing English
  title (Korean original as a tooltip and a small "KO" toggle), game, reward
  steps as a timeline, reward kind, channels on air, start/end in local time and
  relative, "Start bot" (opens the bots wizard pre-filled), "Fix translation"
  and "Rename game".
- `tab-accounts.js` (U5) — table with search + status filter + bulk select:
  id, nick, status, country, bot, what it is doing now, minutes, cookie age, last
  check; bulk import dialog (paste many exports, per-account result list);
  re-check, mark sold, note, delete; a drawer per account (progress per campaign,
  inventory, recent activity).
- `tab-inventory.js` (U6) — totals (available / claimed / expired / expiring in
  72 h), by game → item with counts and soonest expiry, account drill-down,
  reveal code (confirm first), sync now with progress, export CSV. A clear note
  that drops are never claimed by the system.
- `tab-activity.js` (U6) — activity log with level / account / bot filters, and a
  System panel: egress details, resource meter with sparkline, translation
  overrides.

Copy rules: plain English, sentence case, no jargon ("Logged out — re-import the
cookie", not "AUTH"). Every state the worker can be in has a human sentence.
Empty states say what to do next. Destructive actions confirm. Times are local
with a relative hint. Korean source text is always reachable but never the default.

## 14. Addendum for tab authors (as built, 2026-10-06)

Read `public/soop/UI-KIT.md` first; it is the truth for classes and helpers.
Where this section and §11/§13 differ, this section wins.

**Cross-tab links** — a tab opens another with `Soop.go(tabId, params)`; the
target reads the params from the `"tab"` event (values arrive as strings):

| Call | Target does |
| --- | --- |
| `Soop.go("bots", { create: "campaign", dropsIdx })` | opens the create wizard with that campaign chosen |
| `Soop.go("bots", { create: "game", gameNo })` | opens the wizard with that game chosen |
| `Soop.go("bots", { create: "1" })` | opens the wizard at step 1 |
| `Soop.go("bots", { id })` | scrolls to and highlights that bot |
| `Soop.go("accounts", { id })` | opens that account's drawer |
| `Soop.go("accounts", { status })` | applies the status filter (`ok`, `dead`, `sold`, `idle`) |
| `Soop.go("accounts", { import: "1" })` | opens the import dialog |
| `Soop.go("campaigns", { game })` | filters to that gameNo |
| `Soop.go("inventory", { account })` | opens that account's inventory |
| `Soop.go("activity", { accountId })` / `{ botId }` | applies that filter |

**API facts**

- `GET /campaigns` always answers 200. A failed refresh shows as
  `scan: { ok: false, error: "<plain English>" }` next to whatever is remembered;
  `campaigns` may be empty (no account imported yet).
- `State.scan.error`, alert `msg`, session `detail` and every `error` string are
  already plain English: show them as they are.
- The server accepts at most ~100 KB of JSON per request. **Import sends one
  request per account**: split the paste in the browser (top-level JSON arrays,
  found by bracket depth outside strings; or one `AuthTicket=…` line each) and
  POST each part to `/accounts/import` in turn, showing a per-account result as it lands.
- Inventory items (from `/inventory/account`): `{ id, loginId, key, division, name,
  nameRaw, kind, gameNo, gameName, image, expiresAt, sentAt, receivedAt, needsLink,
  linkPath, used, hasCode, syncedAt }`. `POST /inventory/reveal { itemId: item.id }`.
- `/inventory/summary` → `{ totals, lastSyncAt, games: [{ gameNo, gameName, items:
  [{ name, kind, image, available, acquired, expired, soonestExpiry, accountIds }] }],
  sync: { running, done, total, lastAt, errors: [{ id, error, at }] } }`.
- Activity entries: `{ id, at, level, kind, accountId, botId, dropsIdx, msg }`;
  kinds in use: `session`, `step`, `done`, `bot`, `account`, `auth`, `reveal`, `inventory`, `health`.
- `Game.live` and `Game.guaranteed` are counts of campaigns, not booleans.
- Bot `mode`: `campaign` (one pinned campaign, finishes), `game` (every guaranteed
  campaign of a game, never finishes), `auto` (every guaranteed campaign).
- Session states and what to call them: `starting` "Joining", `farming`
  "Earning" (when `credited === true`) / "Watching" (when null), `waiting`
  "Waiting", `backoff` "Not earning", `stopping` "Stopping", `error` "Error".
  Always show `session.detail` beside the label.

**Dev harness** — `node scripts/soop-dev-harness.js <port>` serves the real page
and API on a fake SOOP with seeded data (time runs 30x). Use your own port; stop
it when you are done. It cannot reach the real database or sooplive.com.

## 15. Claiming (added 2026-10-06)

- Client: `useInfo(itemCodeIdx) -> data` — SOOP's claim / check-info call. Claims an
  unclaimed reward (irreversible); only reads a claimed one.
- Inventory service: `claim(itemId) -> { ok, result: { kind, message, description,
  code, name, loginId } } | { ok: false, error }` with `kind` one of
  `code | link | ingame | pending | renewed`; `reveal(itemId) -> { code, claim } | null`,
  which asks SOOP only for a reward that is already claimed.
- Route: `POST /api/soop/inventory/claim { itemId }` -> `{ result }`;
  `POST /api/soop/inventory/reveal` now returns `{ code, claim }`.
- Items carry `claimedAt` and `claim` (`{ kind, message, description, gameTitle, dropsName }`,
  never a code). Inventory rows are keyed by SOOP's `itemCodeIdx`.
