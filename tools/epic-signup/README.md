# Local Epic account generator

Open http://127.0.0.1:4107/epic-accounts.html in Chrome. This is a standalone
local app: no RedeemHub website login, admin login, local MongoDB or
production configuration is loaded by the signup runtime. Cloud uploads use the existing local SSH deployment key. It uses installed Node dependencies,
local source files, the existing Chrome extension and local Outlook reader.
Internet access to Epic, Outlook and the optional proxy provider is required.

From the project directory on macOS:

```
node tools/epic-signup/install-local.cjs
```

The installer replaces the old redirect service and starts
`com.avishka.epic-account-generator` at login. To run in a terminal instead:

```
node tools/epic-signup/local-app.cjs
```

Keep the Outlook reader running on 127.0.0.1:3999 and Marketplace Filler 1.5.0
enabled in Chrome. Check extension verifies connectivity without reserving an
inbox or opening Epic. Create Epic account reserves a local inbox and opens the
signup wizard. The extension fills details and retrieves fresh Outlook OTPs;
the automatic submission checkbox enables registration Continue and Store EULA
completion for that signup. Leave it unchecked for manual agreement review.
Captcha challenges can still require attention. Resume/recovery
reuse an interrupted signup's address and password.

The app binds only to 127.0.0.1:4107. UI requests require the per-process token
embedded in its local page, plus Host/Origin checks; extension callbacks use
per-signup bearer tokens. Secrets never appear in normal account-list responses.
Reveal/copy explicitly fetch credentials; revealed text clears after one minute
or when the page is hidden.

Data lives in ~/Library/Application Support/EpicAccountGenerator/:
`accounts.vault` is AES-256-GCM encrypted and `vault.key` is its random 256-bit
key. Directory permissions are 700 and files 600. Back up both together;
restoring only the vault without the key cannot recover it. Save uses an atomic
file replacement. Damaged/missing-key vaults fail closed instead of resetting.
Completed accounts now upload to the cloud automatically. A durable queue retries while cloud access is unavailable; local signup and local credentials remain available. The table shows Queued, Uploading or Uploaded, with a manual retry button. Existing cloud rows are never overwritten by repeat uploads.

`import-backup.cjs BACKUP_JSON LEGACY_ENV [ENCRYPTED_PROFILE]` supports a one-time
local import of the older encrypted test-account backup. It preserves the source
and re-encrypts into the local vault. Runtime does not need the legacy env file.

Cloud transport uses the existing SSH key at ~/.ssh/claude_prod_deploy_ed25519
and executes tools/epic-signup/cloud-import.cjs on the cloud host. Payloads are
sent through stdin, not command arguments or logs. The cloud encrypts credentials
with its own key. This command has no HTTP endpoint and does not rotate tokens,
reset sold state, overwrite existing rows, or trigger claims/notifications.

## Optional YesCaptcha companion

The official YesCaptcha Assistant can recognize and click hCaptcha images in
the same Chrome/private signup window. It uses the existing YesCaptcha balance;
returning a token alone does not establish that Epic accepted the challenge.

Preparation (does not install or enable browser access):

```
node tools/epic-signup/prepare-yescaptcha.cjs /path/to/existing/nodeserver
```

This reads the existing encrypted local solver configuration only during setup,
verifies the pinned official 1.4.9 package checksum, and writes the configured
companion under the private EpicAccountGenerator application-support directory.
The key stays outside the repository and local web page, with config.js mode 600.
Existing companion folders are preserved instead of overwritten.

Load the prepared directory through Chrome's Load unpacked control, enable its
private-window access, and verify its settings before a live run. Recognition is
restricted to HTTPS Epic domains, other CAPTCHA families are disabled, and the
companion stops after eight recognition flows per page. This is a retry bound,
not a global points budget. A zero balance or unsupported challenge must remain
a visible interruption rather than being reported as a saved account.

The prepared package has not yet been installed or tested against five new Epic
signups: Chrome setup is waiting for the Mac to be unlocked. No new account or
recognition charge was made while preparing it; the free balance check returned
1,302 points. Remove this pending note only after live verification.

## Interrupted security checks

A visible registration challenge preserves the same signup and pauses the
submission timeout. The banner reports that it is waiting for the security
check. Epic service-unavailable errors stop the driver and suppress automatic
resubmission. Use Recover created account for an account that already passed
email verification; reuse its interrupted signup instead of creating another
account or consuming another Outlook inbox. A completed challenge does not
guarantee that Epic will accept the following authentication request.

Navigation waits for sign-in and email verification also exclude visible
challenge time, and restart the response window after the challenge closes.
The overall flow budget excludes those waits. Form resubmission waits three
seconds after a challenge closes and remains bounded. An explicitly rejected
email code requests a fresh code with its own five-minute delivery window.

Closing a challenge without the SDK form response does not resubmit the form.
An insufficient-authentication error on the Store agreement uses the same
bounded normal-sign-in recovery as an invalid MFA context. Storefront hidden
error templates are excluded from authentication failure detection.


### Recovering a rejected security check

A stopped signup now offers **Retry this signup** in its red banner. This is an
explicit retry of the existing session, identity, and assigned tab; it does not
reserve a new Outlook address. The normal automatic challenge reloads remain
capped at two. The retry button resets that challenge budget only when clicked.
At an email-code step it requests a fresh email before retrying. Hidden page
error templates are excluded from CAPTCHA, OTP, and authentication rejection
checks. The extension still cannot guarantee Epic will accept a challenge.


Every signup now uses a dedicated private window, including normal-connection
signups with the proxy unchecked. Chrome shares cookies between private windows,
so the worker requires other private windows to be closed before reserving an
inbox. Token capture stays in that same window. Successful saves close it; failed
signups stay open for recovery. This avoids reusing a previous account's Store
or accounts.epicgames.com session without calling Epic's logout endpoint.
