# Cloud Outlook pool

The cloud runtime is the single writer for registration reservations. Epic, Steam and Riot each require a completely unused inbox and retain exclusive ownership. Other purposes skip those inboxes. Never start a second dashboard against a copy of the ledger.

Runtime layout: `scripts/mail-dashboard.js`, `scripts/epic-mail-proxy.js`, `utils/epicMailOtp.js`, `utils/epicLocalProxy.js`, the dependencies in this directory's package.json, and ecosystem.config.cjs. Set OUTLOOK_RUNTIME_ROOT when using a location other than the ecosystem default. Install dependencies in the runtime root. Run the ecosystem with PM2 and save its process list.

Private files, mode 0600 inside a mode 0700 runtime directory:

- data/outlooks.txt: existing vendor/harvester account format.
- data/mail-usage.json: original authoritative reservation ledger, copied only after stopping the previous writer.
- runtime.env: EPIC_MAIL_PROXY_TOKEN (matching the application's OUTLOOK_PROXY_TOKEN), plus RES_HOST/RES_PORT/RES_USER/RES_PASS for the Epic proxy endpoint. Never commit this file or the data directory.

The dashboard binds loopback port 3999. Mount routes/outlookDashboardRoutes under /outlook after the application session middleware. It uses superadmin + existing 2FA enforcement, preserves JSON bodies, and refuses cross-origin mutations. The dashboard page requires a trailing slash and uses relative API URLs. The buyer mail reader binds loopback 18124, preserving the application's existing OUTLOOK_PROXY_URL; it retains sender, cutoff and Steam ownership restrictions.

For existing local signup tools, forward local loopback 3999 to cloud loopback 3999 over the established private SSH connection. Keep only the forwarder on each Mac, with launchd restart enabled. Disable the old dashboard writer, buyer reader and reverse tunnel before activating their replacements. The copied local ledger is a rollback snapshot, never a second live pool.

Verify counts and file hashes before activating writers; exercise registration and buyer inbox reads without printing addresses, tokens or messages. Use tests/outlookCloud.test.js for proxy guards, concurrent/exclusive allocation, redaction and consent-scope fallback. A rollback must transfer the latest cloud ledger back before reactivating the previous writer, or newly reserved addresses could be reused.
