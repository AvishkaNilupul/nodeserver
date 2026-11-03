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

No SMS after ten seconds cancels the unused number, closes Naver's verification
popup after confirmation, and retries in the same window. A code arriving during
cancellation stays assigned and is entered before the popup closes. When Naver provides no
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

Tests: `node --test tests/chzzkSignup.test.js tests/chzzkSignupExtension.test.js tests/chzzkSignupForms.test.js`. Tests use fake 5sim responses,
temporary encrypted vaults and stub cloud models, without spending or contacting
Naver/CHZZK. A real registration and earned drops are separate live checks.

Protocol reference: <https://5sim.net/docs>. Existing farm contract:
`docs/CHZZK-FARM.md`. Generator contract: `tools/chzzk-signup/CONTRACT.md`.

## Logged manual demonstration

Choose **Open logged manual signup** to start at Naver’s terms screen with the
same private-window isolation and encrypted vault, but without automated filling,
submission or number purchases. The assigned tab journals clicks, field changes,
country options and navigation in the protected data directory’s
`recordings/browser-events.jsonl`. Passwords/SMS values are excluded; field
changes record character counts. 5sim order history supplies country, operator,
price and SMS arrival timing independently.

Naver currently issues its own login ID; bind the ID shown on the completed
signup page before checking the authenticated home page. Passwords are 16
characters. The optional passkey prompt carries the signup’s return destination.
The protected local APIs `adopt-order` and `account-name` support a manual SMS
handoff into that same signup without buying another number or resetting it.

Chrome cookie access needs both Naver URL schemes: this live signup’s NID_AUT
and NID_SES were `secure:false`, so HTTPS-only host permission hid them from the
cookies API even while Naver showed a working login. Cookie reads are bound to
the assigned private store and include its partition key. Only the required
Naver jar reaches the existing farm; credential values never reach the journal.

The form helper handles the separate birthday screen and the demonstrated gender
and country buttons. Country selection matches name and dialing prefix together,
including Canada versus USA (+1). The SMS clock starts when the popup appears.
If Naver never opens it within 15 seconds of Send Code, the helper pauses on the
same assigned number so its message can be checked before explicitly replacing it.
Naver's explicit invalid-phone message is allowed five seconds to settle before
the unused order is cancelled and a different country is selected. Reloaded phone
forms refill the existing assigned order; an already received SMS blocks replacement.
The recommended Naver ID is preserved and bound from the completion page.

Some new accounts require a separate Naver sign-in when first opening CHZZK.
The helper follows CHZZK's login button and signs in using the saved account.
Additional security challenges pause this handoff for completion in the same
window. The signup's credentials remain in the encrypted local session throughout;
it is counted as a saved farm account only after authenticated CHZZK verification.
