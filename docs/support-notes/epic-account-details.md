# Epic account details

The Epic accounts page has Claims and Account details tabs. Both use the same
EpicAccount inventory and sold flag; this feature never changes ownership,
refresh tokens, claim eligibility or marketplace listings.

Superadmins can select an account, record its sign-in email/password, name,
date of birth, two-letter country, optional 2FA setup key and internal notes.
Editing a saved record does not change credentials at Epic. Blank password/key
inputs preserve the stored values. Details and credentials are encrypted with
secretBox using the existing credential key. Do not rotate that key as part of
this deployment.

GET `/api/epic/accounts/:id/details` returns profile and credential-presence
flags. PATCH updates allowed fields only, with a compare-and-swap on profile
ciphertext to prevent stale editors overwriting another edit. POST
`/api/epic/accounts/:id/details/reveal` returns saved credentials on demand.
All routes require superadmin and return Cache-Control: no-store. Passwords,
2FA keys and refresh tokens never appear in the details GET response.

Show saved credentials hides and clears the revealed values after one minute,
when switching tabs/accounts, or when leaving the browser tab. Copy sale details
includes saved login/profile data and game titles; it excludes internal notes,
refresh tokens and local Outlook mailbox credentials. Save edits before copying.

Validation: focused API tests cover access, no-store, encrypted storage, blank
credential preservation, input validation and preservation of sold/library/token
state. Browser fixture checks cover select, save, reveal/hide, copying and Claims.

Deploy only:
- models/EpicAccount.js
- routes/epicAccountRoutes.js
- routes/epicAccountDetailsRoutes.js
- public/epic-accounts.html
- public/epic-account-details.js
- public/epic-account-details.css

Use production-file fingerprints and timestamped backup before replacement,
require-load modules before restart, then verify real DB CRUD with a synthetic
sold account and confirm no unauthenticated access. Roll back those six files
and restart redeemer if route loading or smoke checks fail. Existing credential
fields remain additive and compatible with the old runtime.

## Signup availability repair — 2026-10-28 JST

The original successful signup used an isolated, temporary localhost:4107
harness. Closing that harness left the loaded Chrome page showing a generic
Failed to fetch error. It was not a permanent creator service.

The production Claims tab now includes the tested Outlook extension creator.
Signup routes and encrypted sessions run on production; Outlook/proxy access
remains in the Mac extension and local port 3999 reader. Successful new accounts
save directly into production inventory and receive an encrypted signup profile
for the Account details tab. Existing profile records are preserved on repeat
capture. Captchas and agreements can still require manual interaction.

The panel checks signup-service health before reserving an inbox and explains
network/session failures. Failed session preparation cancels its pending local
reservation. The former localhost:4107 address is a loopback-only shortcut to
the authenticated production panel, run at login by a LaunchAgent. It exposes
no local admin session or database. No new Epic account is created by service
health/fixture tests.

## Local-only generator — supersedes the hosted signup repair

The generator now runs independently at 127.0.0.1:4107, with its own encrypted
file vault and per-process UI token. No website session, production credentials
or MongoDB is loaded by the runtime. The old redirect LaunchAgent is replaced
by com.avishka.epic-account-generator. Server generation controls and route
mount are removed; the previously requested hosted account-details and manual
claim system remain. Completed accounts save locally first, then upload through the encrypted durable
SSH queue. Existing cloud credentials and inventory edits survive repeat uploads.

See tools/epic-signup/README.md for startup, storage, recovery and backup.


## Signup automation repair — 2026-10-28 JST

Marketplace Filler 1.4.0 carries explicit per-signup automation flags from the
local panel through the encrypted session and extension worker. The automatic
submission checkbox enables the Terms checkbox, registration Continue, and Store
EULA acceptance. The default remains manual agreement review. Resume uses the
currently selected automation settings with the original account identity.

Navigation waits now honor their deadline, skip hidden/disabled buttons, and
allow three minutes for slow proxy transitions. A visible CAPTCHA pauses the
navigation deadline for at most five minutes. Authentication-method review waits
for its Confirm button to render. EULA readiness scrolls the agreement and waits
for an enabled Accept button. A second email verification only reads mail newer
than the code already delivered. An invalid/expired-code banner triggers a
bounded fresh-email retry (at most three codes), and launcher email-MFA errors
open normal sign-in once before requiring explicit recovery. Token capture
reuses a single tab.

Regression coverage includes bounded waits, CAPTCHA pause/resume, button
readiness, automation propagation, fresh-mail cursors, capture-tab reuse, local
vault persistence, cloud retry/idempotency, and encrypted account details.

Five sequential residential-proxy rounds were completed. Earlier rounds exposed
CAPTCHA timeout, slow-navigation/review readiness, and launcher email-MFA errors.
The fifth exposed rejected-code retry and the console review's visible
“Done linking” label (accessibility labels it Continue). These cases were fixed;
the same fifth account was recovered with the corrected driver. No additional
registration was created during recovery. CAPTCHA solving was operator-assisted;
this test does not establish unattended CAPTCHA completion.

All five saved locally and uploaded: ForwardApple8197, HollowStoat4793,
RivalCrate1919, TangyIce5965, and OrotundCash1676. Direct server comparison found
one row per account, status ok, matching email/password/profile, and decryptable
encrypted credential, token and profile fields. Focused regression suite: 29/29.
