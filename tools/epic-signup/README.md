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

Keep the Outlook reader running on 127.0.0.1:3999 and Marketplace Filler 1.4.0
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
