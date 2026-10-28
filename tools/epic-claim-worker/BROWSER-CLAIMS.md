# Epic browser claims

The active path is nodeserver → SSH tunnel → localhost extension bridge → Epic Claim Helper in regular Chrome. The previous standalone browser triggered a visible challenge; the regular-profile extension completed the live Home test without one on 2026-10-28. This does not guarantee every checkout will be challenge-free.

Load `extension/epic-claim-helper` as an unpacked Chrome extension. Open `http://127.0.0.1:8123/connect`, enable the free-game checkout agreement and local Epic cookie reset, and connect. Pairing survives restarts. Keep Chrome and the Mac running; the existing launch agents maintain the bridge and tunnel. The page can be closed after pairing.

The bridge uses `CLAIM_WORKER_TOKEN` from the existing worker environment. It derives a separate token for the extension. It binds only to localhost, permits one claim at a time, expires jobs, and authenticates results by job id and lease. The helper only acts in its assigned tab, checks the account name, offer id, and explicit zero-price checkout in the displayed currency, and leaves visible security checks for the operator. Successful submissions close their tab.

A UI submission is provisional. Nodeserver checks Epic's library before recording success, including after apparent worker failures. The manual auto-claim endpoint uses the same worker and verification flow. Sold accounts are skipped; manual actions can bypass the scheduler's enabled flag and retry wait, but retain the fleet cap and final ownership guard.

The Mac service runs `extension-worker.cjs` from `~/epic-claim/` using the existing `run-worker.sh`; its `worker.js` is a small launcher. Restore the timestamped pre-change `worker.js` and restart `com.redeemer.epic-claim-worker` to roll back. Runtime server changes use the repository's fingerprinted targeted-copy deployment backups.

## Session isolation and reconnection

The 2026-10-28 monitored batch reproduced refresh-token revocation when reusing the existing Epic browser session for another exchange login. Ownership could still verify through a cached access token, masking the broken refresh token until the next process. Pause the scheduler during recovery. The extension now removes only Epic browser cookies locally before every assigned login or checkout; it never calls Epic’s logout endpoint. Chrome’s origin filter clears cookies for the Epic registrable domain, including its subdomains: https://developer.chrome.com/docs/extensions/reference/api/browsingData. This signs out other Epic browser tabs. The connection requires explicit cookie-reset consent.

Run `node tools/epic-claim-worker/reconnect-local.cjs` on the Mac to reconnect existing unsold accounts whose refresh tokens fail. The command reads the encrypted local generator vault, sends each account’s saved login only to the localhost bridge, retrieves fresh Outlook codes via the local reader, and validates Epic’s returned account id before saving the encrypted replacement token over SSH. It verifies all previously recovered refresh tokens from a new process after every recovery. No account passwords, mailbox tokens, or OAuth codes are printed. Visible security checks or unknown review screens pause recovery. Existing MFA-method confirmation is supported; authentication settings are not changed.
