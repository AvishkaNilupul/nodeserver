# Steam hour boost (v1)

Owner, 2026-11-03: "make hour boosted accounts like 1000 hours on Apex, 1000 hours on CS … like
that seller (el9in_store) … first Eldorado". Answers: **500 h, then 1000 h**; **many free games at
once**; **the distributor decides** what goes to boosting and what stays on the region offers; run
it on **contabo2**.

What el9in_store does (read 2026-11-03, docs in memory `project_el9in_steam_shelf_1101`): one pool
of fresh Steam accounts idles ~30 free games at once; two tiers, "500 Idle (Boosted) Hours" $2
(488 accounts) and "2000 Idle (Boosted) Hours" $3 (40); each tier listed in every game's own
Eldorado section; titles say "0 Hours Played", the description says nobody played and the hours
were idled by a program. Stock on all 82 of those offers was unchanged 11-01 → 11-03.

## Time

Steam books hours in real time. One account plays up to 32 games at once and every one of them
gets the hours, so 500 h ≈ 21 days and 1000 h ≈ 42 days of non-stop idling — for all its games
together. Steam books a session's time when the session ends, so the worker stops playing for a
minute every 2 hours ("cycle") and the hours show up as they go.

## Pieces

| Where | What |
|---|---|
| prod `utils/steamBoost.js` | the pool: settings, add/stop/retry, the worker's answers, hours, milestones |
| prod `models/SteamBoost.js` | one row per boosted account (state, games, licenses, hours, saved login) |
| prod `routes/steamBoostWorkerApi.js` | the worker's API, its own listener on **127.0.0.1:3011** only (never behind nginx), bearer token |
| prod `steam-boost-tunnel.service` | `ssh -N -R 127.0.0.1:18130:127.0.0.1:3011 ubuntu@contabo2` (same shape as chzzk-socks) |
| contabo2 `steam-booster` container | `workers/steam-boost/worker.cjs` (node:20-slim, `--network host`, restart unless-stopped) |
| prod `utils/steamDistributor.js` | each new ready account → region offers or boosting |
| `/steam-accounts.html` | tabs **Region sales** · **Hour boost** |

Secrets: Steam passwords and saved logins stay on prod (secretBox). The worker gets a password
only for a first login, a saved login (refresh token) after that, both over the tunnel. The
residential proxy login is in the worker's env file on contabo2 (mode 600), never in git.

## Account states

`SteamAccount.stage` gets **boosting**: in the pool, not on sale. Nothing else lists it (every vet
wants `stock`). `SteamAccount.boostedAt` is set when boosting starts and is never cleared: an
account that owns free games and idle hours is no longer a fresh empty account, so the region
offers refuse it for good ("hour-boosted").

`SteamBoost.state`: **queued** (waiting for the worker) → **boosting** (logged in and playing) →
**stopped** (owner stopped it, or the account left the pool) · **failed** (Steam refused for good:
wrong password, ban, lock, authenticator; Retry puts it back to queued).
Milestones `reached500At`, `reached1000At` (Telegram once each).

Hours of an account = the LOWEST hours among its games that Steam lists as owned, so a title can
say "500 h" for every game it names ("not fewer", as el9in words it).

## Distributor (every 5 min, mode on / plan / off as before)

For each ready account (oldest first), in order:
1. If boosting is **on**, fewer than `boost.maxAccounts` are boosting, and its country already has
   at least `boost.keepPerRegion` unsold accounts on the Eldorado region offers →
   **boosting**.
2. Otherwise → Eldorado region offers only (owner scope, 2026-11-03). If Eldorado is unavailable, keep the account in stock for retry; never send it to G2G.
Defaults: on, max 50, keep 2 per country. "plan" only records what it would do. Accounts already
on sale are never pulled back.

## Worker protocol (`/boost-worker/v1`, JSON, `Authorization: Bearer <token>`)

- `GET  assignments` → `{ accounts: [{ id, gen, accountName, country, games[], licensed[] }] }` —
  the rows in queued/boosting. A row missing from the list = stop it now; a new `gen` (Retry) =
  start it again from scratch.
- `POST login {id}` → `{ accountName, password, refreshToken }` (password only while no saved login).
- `POST token {id, refreshToken}` · `POST token/clear {id}`.
- `POST guard-code {id, since, exclude[]}` → `{ code, messageId, subject }` or `{ code: null }`;
  read from the account's own inbox through the Mac mail proxy, `@steampowered.com` only, mail
  newer than the login attempt. The worker asks every 10 s for up to 4 min.
- `POST report { worker, accounts: [{ id, gen, state, steamID, playing[], playtime{appid:{minutes}},
  licensed[], lastError, exit{country,city}, failed }] }` every 60 s.

The worker starts at most one new login every 20 s, gives way when someone plays the account
elsewhere, keeps saved logins on prod, and never prints passwords, codes or tokens.

## Completed pipeline — 2026-11-03

The worker runner, panel, logout acknowledgement and Eldorado per-game shelf are implemented in `codex/steam-eldorado-pipeline`. `docs/STEAM-PIPELINE.md` defines the transitions. The initial default is Apex + CS2; other catalog games are selectable.

Once each region has its empty-account reserve, overflow alternates game preparation (one F2P game, >=2 recorded minutes) and hour boosting (all selected games, target 500 or 1000 hours). Defaults are $2 for prepared game accounts and $3 for boosted accounts; edit them in the new tab. These prices are settings, not a claim about demand.

`stopping` keeps the account reserved until the worker acknowledges logout for the same generation. It then becomes `ready` (completed target) or `stopped` (manual stop). Only completed, verified game/tier stock is listed automatically; manually stopped stock stays held from automatic shelves. Each account sits in only one Eldorado Instant offer, in its game category for Apex/CS2 or Steam category for other games. Existing G2G stock is tracked but receives no new allocations.

Every worker POST concerning an account requires `id` and `gen`, including login, token changes and Guard. Assignments include `stopping` tombstones, which the worker acknowledges only after stopping its session. After 3 minutes without assignment reads the worker logs off all sessions. Reports carry only real Steam minutes. The worker settles an initial session after 3 minutes, waits 90 seconds for Steam to book it, then uses a 2-hour cycle for boosting and 3-minute cycle for game preparation.

No 500/1000-hour live test can be compressed; isolated tests cover exact boundaries. The first ten-new-account test must separately record generated IDs, import completion, allocation, verified licensing and real recorded minutes, and distinguish these from pre-existing stock.
