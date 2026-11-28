# Remote Twitch Controller

The owner requested the existing personal companion controller inside the server site for outside access. This is a protected control surface for the existing Mac installation, not a migration of Twitch credentials, browser profiles or coordination state. Preserve stopped intent; installation and transport recovery never Start, Resume or send. The two existing Twitch watch tabs were explicitly closed for this task, with Chrome profiles left open.

## Fixed boundaries

- Production mount: `/admin/stream-companion/`, with Accounts at `/admin/stream-companion/accounts`. Add one superadmin-only navigation entry labelled Twitch Controller under Bots.
- Every page, asset and API is protected by existing `requireSuperadmin` and `enforce2fa`. Mount the router before public static serving. No copied controller HTML/assets in nodeserver public/. Keep original admin navigation behavior/CSP intact; do not embed controller in an iframe or inject admin-nav.js into it.
- Browser connects only to its same-origin HTTPS site. Existing site sessions/remembered-device/2FA remain authoritative. Public origin and remote pairing come from private deployment configuration, not request input or public source.
- Production connects only to fixed loopback port18795. A separate persistent Mac reverse SSH tunnel binds production127.0.0.1:18795 to Mac127.0.0.1:8795. No Nginx/firewall/public-port exposure and no changes to other tunnels.
- Host root/local URLs and helper internal routes remain unchanged. Host additionally recognizes the fixed `/admin/stream-companion` prefix for public routes only. Prefixed access requires a separate timing-safe checked bearer pairing from optional private/remote.json. Missing pairing disables the prefix; never expose prefixed/internal, health, private files or helpers.
- Production gateway sends only its separate remote bearer, canonical Host127.0.0.1:8795, local Origin and same-origin fetch metadata after validating the outside request. Do not forward user cookies, browser Authorization, arbitrary forwarded/hop-by-hop headers or request-selected upstreams to the Mac.

## Public route allowlist

GET only: `/`, `/accounts`, `/accounts/primary`, `/accounts/test`, `/app.js`, `/style.css`, `/accounts.js`, `/accounts.css`, `/controller-path.js`, `/api/status`, `/api/accounts` beneath the fixed mount. POST only: `/api/control` and `/api/accounts/(primary|test)/command`. Existing exact typed action/parameter validation remains on the helper/host; gateway also validates the finite command shape and body size before forwarding. Reject queries, unknown paths, encoded separators/traversal, extra slashes, unsupported methods and upgrades. No wildcard proxying.

All panels in one signed-in site session receive the same CSRF nonce, including on concurrent first reads. The gateway derives it from the authenticated session ID and the private pairing key, and honors existing session nonces during upgrades. Data reads replace the Mac token with the session nonce in the browser response. The gateway keeps the Mac token in worker memory and discards late data from a superseded Mac generation. Polling leaves the site session untouched. A POST requires the session nonce, configured public Origin and same-origin metadata. After a gateway worker restart, a validated action can obtain the Mac token with one read-only status check within its original deadline. The gateway forwards the explicit action once and the Mac checks its token. Request IDs and status polling reconcile the outcome after an interruption. The combined four-profile accounts read permits 2 MiB. Other responses retain the 256 KiB bound.

## Host UI compatibility

HTML uses a trusted `__COMPANION_BASE__` placeholder for root-relative asset/nav URLs, rendered as empty at local root or the fixed mount. No base element, inline script/style, CSP weakening, or gateway response-source rewriting. Host static allowlist includes controller-path.js. Both UI modules derive the mount from their own HTTP(S) module URL and pass explicit basePath to factories (default empty for current tests/local behavior). Prefix account parsing, generated links and all API fetches; use credentials same-origin. Prefix mode has a plain Back to server link to /superadmin.html. No browser-facing private pairing/config fields.

Phone UI retains existing readable layout and stable edits, uses16px input/select/textarea text, and resumes GET polling on pageshow after pagehide/BFCache. Reappearing pages never replay mutations. Distinguish401/sign-in and403/access-or-2FA from503/Mac unreachable. Retain stale values visibly and disable actions until fresh state. Remote POST timeouts are unconfirmed, not proof of rejection or permission to resend.

## Failure and verification

Mac asleep/locked-before-login, tunnel down or host unavailable: protected navigation returns a readable503 offline page with Retry and Back to server; APIs return bounded sanitized503. No secret exception text/SSH details leak. Browser profiles closed/stale retain existing status/actions. Restoring the tunnel changes transport only. Stop is confirmed only through actual helper completion/status.

Tests: real ephemeral HTTP host/gateway roundtrips, actual auth/2FA guard integration, session-cookie and CSRF binding, strict raw-route allowlist, origin/header stripping, secret sentinels, response/body bounds, outages/timeouts/no replay, root/prefix UI routing and phone restoration. Run host regression suite and necessary gateway checks; unchanged helper/extension suites need not be repeated. Native verified live remote page/status/Stop/settings with both held; no public test post or forced exchange.

Deployment: fingerprint live files immediately before targeted copy; timestamped source/config backups; preserve unrelated production bytes. Load/syntax checks before PM2 restart, then public unauthenticated rejection, authenticated controlled checks, local compatibility and bounded monitoring. Push source-only branch to origin and refresh Graphify built from that commit. Keep credentials, configs, source evidence/chat history, SQLite and journals private. Rollback stops the new tunnel/remote prefix or restores only backed-up router/entrypoint/nav/config, never older delivery state.
