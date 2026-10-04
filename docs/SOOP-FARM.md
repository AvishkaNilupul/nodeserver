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

## Watch time is only credited from some countries

Measured 2026-10-04 with one account, one campaign and the same 20 s bridge
protocol, changing only the viewing IP:

| Viewing IP                          | Watch time credited                                        |
| ----------------------------------- | ---------------------------------------------------------- |
| Tokyo residential (dev Mac)         | yes — ~1 min per min, the usual rate                        |
| US datacenter (the redeemer server) | no — 0 minutes across 5 accounts over ~54 min of watching   |
| Sri Lanka residential (home Pi)     | no — 0 minutes over 9.5 clean solo minutes, plus 13 in a bot |

So this is **not** "datacenter vs residential": the Pi is a residential line and
still earns nothing. From every IP the login works, `get_drops_event_list.php`
answers, the campaign lists as `live` with channels on air, and the socket joins
(`FLASH_LOGIN` → `CERTTICKETEX` → `JOINCH_COMMON`) — only the minute counter stays
at 0, and `utils/soopWorker.js` correctly gives up and waits rather than burning
the socket. Working conclusion: **SOOP credits drops only for viewers in
supported countries**, so the farm has to leave from a supported-country IP.

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
whichever host has a supported-country residential IP.
