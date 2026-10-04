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
