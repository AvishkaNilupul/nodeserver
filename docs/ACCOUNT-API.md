# Account API

A machine-to-machine, bearer-token API that resolves a **username → client
token** (and, optionally, full credentials) across **every** account source in
the system. Built for external projects that need to look an account up without
a browser session.

- Router: [`routes/accountApiRoutes.js`](../routes/accountApiRoutes.js)
- Lookup engine: [`utils/accountLookup.js`](../utils/accountLookup.js)
- Auth guard: [`middleware/apiToken.js`](../middleware/apiToken.js)
- Mounted in [`server.js`](../server.js) **before** the blanket `requireAdmin`
  cascade (it presents a static token, not a session).

## Auth

Every request needs the bearer token:

```
Authorization: Bearer <ACCOUNT_API_TOKEN>
```

The token lives in the environment as `ACCOUNT_API_TOKEN` (see `.env`). It is
compared in constant time. **If `ACCOUNT_API_TOKEN` is unset the API is disabled
and every request returns `503`** — it hands out credentials, so it fails closed
rather than falling open to "no auth".

Rotate the token by replacing the value and restarting the server. For quick
manual testing you may also pass `?api_token=...`, but a header is strongly
preferred (query strings leak into logs and browser history).

## Sources searched

| source      | collection         | what it is                              | token field            |
| ----------- | ------------------ | --------------------------------------- | ---------------------- |
| `bot`       | `BotAccount`       | Drops Archive — deployed farming bots   | `clientSecret`         |
| `pool`      | `AvailableAccount` | ready-to-deploy pool                    | `clientSecret`         |
| `unclaimed` | `UnclaimedAccount` | no-claim / unclaimed farms              | resolved via pool row  |
| `supplied`  | `SuppliedAccount`  | owner-supplied account-listing stock    | `clientSecret`         |
| `renter`    | `RenterAccount`    | a renter's isolated tenant inventory    | `clientSecret`         |
| `epic`      | `EpicAccount`      | Epic Games stock (matched by name/id)   | `refreshToken`         |

The same login can exist in more than one collection, so the API returns **every
match** grouped by source. `unclaimed` rows carry no token of their own; the
token is recovered from the pool row they point at via `poolAccountId`.

## Endpoints

### `GET /api/accounts/ping`

Auth/health check. No DB access.

```json
{ "success": true, "ok": true, "service": "account-api", "ts": 1737000000000 }
```

### `GET /api/accounts/lookup/:username`

### `GET /api/accounts/lookup?username=<login>`

Resolve a username. Both forms are identical. Matching is **exact and
case-insensitive**.

Query options:

- `?credentials=0` — token-only; skip decrypting password/email (least
  privilege for the common "just give me the token" case).

Response (`200`):

```json
{
  "success": true,
  "username": "coolfarmer12",
  "found": true,
  "clientToken": "<primary Twitch clientSecret>",
  "primarySource": "bot",
  "count": 2,
  "sources": [
    {
      "source": "bot",
      "collection": "BotAccount",
      "id": "…",
      "login": "coolfarmer12",
      "twitchId": "12345",
      "tokenType": "twitch_client_secret",
      "clientToken": "<clientSecret>",
      "credentials": { "username": "coolfarmer12", "password": "…", "email": "…" },
      "meta": { "host": "local", "container": "…", "enabled": true, "soldAt": null, "lastScanStatus": "ok" }
    },
    {
      "source": "pool",
      "collection": "AvailableAccount",
      "…": "…"
    }
  ]
}
```

`clientToken` at the top level is the single most authoritative token, picked by
source priority: `bot > pool > supplied > renter > unclaimed > epic`. Use the
`sources` array when you need a specific one.

`tokenType` is `twitch_client_secret` for the Twitch sources and
`epic_refresh_token` for Epic — don't confuse the two.

Misses return `404` with `{ "found": false }`. A missing `username` returns
`400`.

## Auditing

Every lookup writes a best-effort `SystemEvent` (category `accounts`, action
`api_lookup`) recording the **username, caller IP, hit/miss and source count** —
**never** the token or any credential. View them on `/activity.html` or query
`SystemEvent`.

## Examples

```bash
# health / auth check
curl -H "Authorization: Bearer $ACCOUNT_API_TOKEN" \
  https://YOUR_HOST/api/accounts/ping

# look a username up (full details)
curl -H "Authorization: Bearer $ACCOUNT_API_TOKEN" \
  https://YOUR_HOST/api/accounts/lookup/coolfarmer12

# token only, no credential decryption
curl -H "Authorization: Bearer $ACCOUNT_API_TOKEN" \
  "https://YOUR_HOST/api/accounts/lookup?username=coolfarmer12&credentials=0"
```

```js
// node / any external project
const res = await fetch(
  `https://YOUR_HOST/api/accounts/lookup/${encodeURIComponent(username)}`,
  { headers: { Authorization: `Bearer ${process.env.ACCOUNT_API_TOKEN}` } },
);
const data = await res.json();
if (data.found) console.log(data.clientToken, data.sources);
```

## Security notes

- One token unlocks **read access to every account credential** in the system.
  Treat `ACCOUNT_API_TOKEN` like a root password: keep it only in the external
  project's secret store, never commit it, rotate on any suspicion.
- Only expose this over HTTPS. Behind the existing nginx reverse proxy that is
  already the case; do not expose the node port directly.
- Consider restricting the route to the external project's source IP at the
  nginx layer if that project has a stable address.

## Other callers of the lookup engine

`utils/accountLookup.js` is shared, not private to this API. The other caller is
the operator-facing one:

- `GET /drops-archive/account-token?username=<login>`
  ([`routes/dropArchiveRoutes.js`](../routes/dropArchiveRoutes.js)) — backs the
  "Look up & check" box on `/twitch-inventory.html`. **Session** auth
  (`requireSuperadmin` + `enforce2fa`), not the bearer token, and it calls the
  engine with `includeCredentials: false`, so it returns the Twitch client
  token and non-secret metadata only — never a password or email. Epic rows are
  filtered out (their token is an Epic refresh token). A miss returns `404`
  with prefix `suggestions` from `suggestUsernames()`.

Anything added to the engine therefore shows up in both realms: check what a
new field would mean for a _browser_ response, not just for the external API.
