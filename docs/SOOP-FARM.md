# SOOP drops farm (super-admin section)

SOOP (ex-AfreecaTV, `sooplive.com`) credits drops watch time from a live viewer
session, not an HTTP heartbeat. The bridge WebSocket alone (`wss://bridge.sooplive.com/Websocket`,
subprotocol `bridge`: `INIT_GW` → `CERTTICKETEX` → `INIT_BROAD` → `KEEPALIVE` every 20 s)
earns one minute per minute. No browser, video or chat is needed.

The protocol probe and its measurements live in `_soop-probe/` (git-excluded; it
holds login cookies and a recorded session with tokens — the repo is public, so
never commit it). This document describes the in-app port.

## Pieces

| File                     | Role                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `models/SoopAccount.js`  | One row per SOOP login. Cookies encrypted at rest via `utils/secretBox` (key = `CRED_SECRET`).                                       |
| `models/SoopCampaign.js` | Remembered campaign records. SOOP delists events mid-broadcast, so the last good record is kept here and reused to keep farming.     |
| `models/SoopFarmTask.js` | A "bot": one campaign + N accounts. Persisted so it resumes after a PM2 restart.                                                     |
| `utils/soopClient.js`    | Shared client: cookie parsing, read-only APIs, the bridge watch socket.                                                              |
| `utils/soopWorker.js`    | One account's farm loop (`runSession`).                                                                                              |
| `utils/soopFarm.js`      | The service: many accounts in one process, shared campaign cache, durable bots, RAM/CPU meter. `.start()` runs after Mongo connects. |
| `routes/soopRoutes.js`   | Superadmin API (self-guards with `requireSuperadmin`).                                                                               |
| `public/soop.html`       | The super-admin panel section. Linked from the sidebar via `public/admin-nav.js`.                                                    |

## Assumptions and rules

- Cookies are secrets. They are encrypted before they touch MongoDB and are
  never returned to the browser. Only the `AuthTicket` cookie matters, but the
  whole export is stored so a re-import is a straight replace.
- A campaign only pays while its own `live` flag is true. A listed channel being
  on air is not enough.
- Only `giveCon: "term"` (Mission/Fixed) campaigns are guaranteed; `draw` is a
  raffle and `none` is random, so neither is auto-farmed.
- Drops are left **unclaimed** by design (see the no-claim rule in `AGENTS.md`).
  The panel reads inventory; it never presses Claim.
- Bots are in one Node process alongside the `redeemer` PM2 app, following the
  same pattern as `utils/autoFarmer.js` (`.start()` after the Mongo connection).

## Watch time needs a country claim that matches the egress

The bridge handshake sends a `JOINLOG` block that states where the viewer is
(`geo_cc`, `geo_rc`, `join_cc`). Those were hard-coded to Japan, which is
correct only while the farm actually egresses from Japan. Measured 2026-10-04,
one account, one campaign, one client, changing one thing at a time:

| Setup                                 | Claimed  | Result                            |
| ------------------------------------- | -------- | --------------------------------- |
| Dev Mac, Tokyo IP                     | JP, match | 0 → 13 min in 13 min              |
| Dev Mac, Tokyo IP                     | US, wrong | 0 min in 8.5 min                  |
| Server, US IP                         | JP, wrong | 0 min across 5 accounts, ~54 min  |
| Server, US IP                         | US, match | 0 min in 9 min — US is not credited |
| Pi, Sri Lanka IP                      | JP, wrong | 0 min in 9.5 min                  |
| Pi, Sri Lanka IP                      | LK, match | 0 → 10 min in 10 min              |

Two conditions, both needed:

1. the country claimed in the handshake has to be the one SOOP sees for the
   connection, and
2. that country has to be one SOOP credits drops for — Sri Lanka and Japan are,
   the United States is not.

So `utils/soopClient.js` asks SOOP where the connection appears to be
(`get_private_info` → `COUNTRY_CODE`) and claims exactly that, once per client;
`SOOP_GEO_CC` overrides it if that is ever needed. It is not about datacenters
vs homes — a mismatching claim fails from either, and a matching one succeeds
from either.

Two measurement traps worth remembering, because they produce exactly this
symptom and both bit us:

- A campaign's `viewTime` **resets when the broadcast changes**, so comparing
  "minutes before" with "minutes after" across runs proves nothing. Compare two
  runs started at the same time, or watch whether the counter rises during a run.
- `utils/soopWorker.js` gives up on a socket after two flat polls (~90 s) and
  rejoins. When credit is flowing that is harmless, but it makes any short
  window of a genuinely dead egress look identical to a slow one.

## Egress proxy: `SOOP_PROXY_URL`

`utils/soopClient.js` sends every SOOP call — the read-only APIs and the bridge
watch socket alike — through a SOCKS5 proxy when `SOOP_PROXY_URL` is set:

```
SOOP_PROXY_URL=socks5h://127.0.0.1:1080
```

`socks5h` resolves the hostname on the far side. The socket is the part that
matters (it is what earns time) and a `ws` connection needs a SOCKS agent, so
this is SOCKS rather than an HTTP proxy. `fetch` cannot take a SOCKS agent, so
the proxied path issues the same request through `https.request` with
`socks-proxy-agent` — same headers, same 20 s timeout, same JSON-or-throw
contract; the unproxied path is unchanged `fetch`.

The reference setup on the server is a `soop-socks.service` systemd unit running
`ssh -N -D 127.0.0.1:1080` to the home host. Point it (and the env var) at
whichever host has an IP in a country SOOP credits; the client claims that
country on its own, so nothing else needs configuring when the host changes.
