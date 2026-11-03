# CHZZK account generator

Run `node tools/chzzk-signup/local-app.cjs` and open
<http://127.0.0.1:4109/>. Load `extension/chzzk-signup` as an unpacked Chrome
extension and enable **Allow in Incognito**. This is a separate generator and
does not change Epic or Steam extensions or proxy settings. Close other private
windows first because Chrome shares their cookie store.

Set the 5sim token as `fiveSimToken` in `settings.json` inside
`~/Library/Application Support/ChzzkAccountGenerator/`, permissions 0600.
The supplied token has already been saved there; it is never part of source code.
The UI reads current balance and live Naver prices without buying a number.

Enter name and birthday and choose Create account. Complete required Naver
agreements in the private signup window. The helper fills recognized identity
and phone controls, buys the cheapest available Naver number within the cap,
polls its SMS and fills the code. Complete visual challenges yourself. Unknown
forms pause instead of submitting guesses. Resume preserves the same identity.
If the helper cannot advance, fill the visible form manually and resume.

No SMS after ten seconds closes Naver's verification popup, cancels the unused
number, and retries in the same window. When Naver provides no
Back control, return to the number screen yourself, then Get / fill number.
After every failure, selection switches to the cheapest different
country. Default limits: ten numbers, 0.05 per number, 0.25 gross signup spend.
Received codes block replacement, preserving a potentially created account.
API purchase timeouts require Reconcile purchase; an unresolved history never
silently buys another number. Check 5sim history manually if reconciliation
cannot uniquely identify the purchase. No purchases resume on app startup.

After creation open Naver's home page in that same window. Verify & save login
checks the assigned ID and a logout link, captures cookies from its private
store and verifies the login on CHZZK. Complete CHZZK profile setup if prompted,
then Resume. A successful CHZZK userStatus plus the assigned Naver ID and SMS
are required before a local account is counted as created.

Credentials and cookies are AES-256-GCM encrypted in `accounts.vault`; back up
that file and `vault.key` together. A missing or damaged key never resets storage.
Revealed credentials clear after a minute or when the page is hidden.

Farm upload is optional until configured. `cloud.json` in the same protected
directory contains `host` and `remoteRoot`; never put it in git. It uses the
existing deployment SSH key. Install `tools/chzzk-signup/cloud-import.cjs` on
production before enabling uploads. The importer validates cookies through the
existing configured CHZZK egress and inserts new accounts without modifying
existing accounts or their sold/paused state. Upload failures remain queued in
the local vault. The farm supervisor discovers imported accounts normally.

Tests: `node --test tests/chzzkSignup.test.js`. Tests use fake 5sim responses,
temporary encrypted vaults and stub cloud models, without spending or contacting
Naver/CHZZK. A real registration and earned drops are separate live checks.

Protocol reference: <https://5sim.net/docs>. Existing farm contract:
`docs/CHZZK-FARM.md`. Generator contract: `tools/chzzk-signup/CONTRACT.md`.
