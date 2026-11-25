# Remote Twitch Controller

The owner requested the existing personal companion controller inside the server site for outside access. This is a protected control surface for the existing Mac installation, not a migration of Twitch credentials, browser profiles or coordination state. Preserve stopped intent; installation and transport recovery never Start, Resume or send. The two existing Twitch watch tabs were explicitly closed for this task, with Chrome profiles left open.

## Fixed boundaries

- Production mount: `/admin/stream-companion/`, with Accounts at `/admin/stream-companion/accounts`. Add one superadmin-only navigation entry labelled Twitch Controller under Bots.
- Every controller page, asset and API is protected by existing `requireSuperadmin` and `enforce2fa`. Mount the router before public static serving. No copied controller HTML/data assets in nodeserver public/. The gateway adds normal site navigation around authenticated HTML; generic public shell CSS/JS contains no controller state. No iframe.
- Browser connects only to its same-origin HTTPS site. Existing site sessions/remembered-device/2FA remain authoritative. Public origin and remote pairing come from private deployment configuration, not request input or public source.
- Production connects only to fixed loopback port18795. A separate persistent Mac reverse SSH tunnel binds production127.0.0.1:18795 to Mac127.0.0.1:8795. No Nginx/firewall/public-port exposure and no changes to other tunnels.
- Host root/local URLs and helper internal routes remain unchanged. Host additionally recognizes the fixed `/admin/stream-companion` prefix for public routes only. Prefixed access requires a separate timing-safe checked bearer pairing from optional private/remote.json. Missing pairing disables the prefix; never expose prefixed/internal, health, private files or helpers.
- Production gateway sends only its separate remote bearer, canonical Host127.0.0.1:8795, local Origin and same-origin fetch metadata after validating the outside request. Do not forward user cookies, browser Authorization, arbitrary forwarded/hop-by-hop headers or request-selected upstreams to the Mac.

## Public route allowlist

GET only: `/`, `/accounts`, `/accounts/primary`, `/accounts/test`, `/app.js`, `/style.css`, `/accounts.js`, `/accounts.css`, `/controller-path.js`, `/api/status`, `/api/accounts` beneath the fixed mount. POST only: `/api/control` and `/api/accounts/(primary|test)/command`. Existing exact typed action/parameter validation remains on the helper/host; gateway also validates the finite command shape and body size before forwarding. Reject queries, unknown paths, encoded separators/traversal, extra slashes, unsupported methods and upgrades. No wildcard proxying.

Each remote session receives its own random CSRF nonce. GET status/accounts replaces the upstream csrfToken with that nonce and stores the current upstream token privately in that authenticated session. A POST must have the exact nonce plus configured public Origin and same-origin request metadata before any upstream request. Forward its validated body once with the saved upstream CSRF. Host still checks its own token. No automatic retry, durable outside queue or command replay after timeout/reconnect. Existing request IDs/expiry/completion reconciliation remain authoritative.

## Host UI compatibility

HTML uses a trusted `__COMPANION_BASE__` placeholder for root-relative asset/nav URLs, rendered as empty at local root or the fixed mount. The gateway wraps only remote HTML in the RedeemHub sidebar/phone drawer; local host HTML/assets stay unchanged. Normal pages and generated offline HTML use the same shell. A fresh per-document style nonce permits admin-nav.js's dynamically created style blocks; script-src stays self, with no unsafe-inline, base element or iframe. Other upstream CSP directives stay intact. The Twitch menu entry matches its bounded subtree so detail/coordination pages keep Bots expanded. Link admin-nav.css last for the phone's first paint. Host static allowlist includes controller-path.js. Both UI modules derive the mount from their own HTTP(S) module URL and pass explicit basePath to factories (default empty for current tests/local behavior). Prefix account parsing, generated links and all API fetches; use credentials same-origin. No browser-facing private pairing/config fields.

Phone UI retains existing readable layout and stable edits, uses16px input/select/textarea text, and resumes GET polling on pageshow after pagehide/BFCache. Reappearing pages never replay mutations. Distinguish401/sign-in and403/access-or-2FA from503/Mac unreachable. Retain stale values visibly and disable actions until fresh state. Remote POST timeouts are unconfirmed, not proof of rejection or permission to resend.

## Failure and verification

Mac asleep/locked-before-login, tunnel down or host unavailable: protected navigation returns a readable503 offline page with Retry and the normal site menu; APIs return bounded sanitized503. No secret exception text/SSH details leak. Browser profiles closed/stale retain existing status/actions. Restoring the tunnel changes transport only. Stop is confirmed only through actual helper completion/status.

Tests: real ephemeral HTTP host/gateway roundtrips, actual auth/2FA guard integration, session-cookie and CSRF binding, strict raw-route allowlist, origin/header stripping, secret sentinels, response/body bounds, outages/timeouts/no replay, root/prefix UI routing and phone restoration. Run host regression suite and necessary gateway checks; unchanged helper/extension suites need not be repeated. Native verified live remote page/status/Stop/settings with both held; no public test post or forced exchange.

Deployment: fingerprint live files immediately before targeted copy; timestamped source/config backups; preserve unrelated production bytes. Load/syntax checks before PM2 restart, then public unauthenticated rejection, authenticated controlled checks, local compatibility and bounded monitoring. Push source-only branch to origin and refresh Graphify built from that commit. Keep credentials, configs, source evidence/chat history, SQLite and journals private. Rollback stops the new tunnel/remote prefix or restores only backed-up router/entrypoint/nav/config, never older delivery state.
