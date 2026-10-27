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
