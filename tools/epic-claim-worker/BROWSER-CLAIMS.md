# Epic browser claims

The active path is nodeserver → SSH tunnel → localhost extension bridge → Epic Claim Helper in regular Chrome. The previous standalone browser triggered a visible challenge; the regular-profile extension completed the live Home test without one on 2026-10-28. This does not guarantee every checkout will be challenge-free.

Load `extension/epic-claim-helper` as an unpacked Chrome extension. Open `http://127.0.0.1:8123/connect`, enable the free-game checkout agreement and local Epic cookie reset, and connect. Pairing survives restarts. Keep Chrome and the Mac running; the existing launch agents maintain the bridge and tunnel. The page can be closed after pairing.

The bridge uses `CLAIM_WORKER_TOKEN` from the existing worker environment. It derives a separate token for the extension. It binds only to localhost, permits one claim at a time, expires jobs, and authenticates results by job id and lease. The helper only acts in its assigned tab, checks the account name, offer id, and explicit zero-price checkout in the displayed currency, and leaves visible security checks for the operator. Successful submissions close their tab.

A UI submission is provisional. Nodeserver checks Epic's library before recording success, including after apparent worker failures. The manual auto-claim endpoint uses the same worker and verification flow. Sold accounts are skipped; manual actions can bypass the scheduler's enabled flag and retry wait, but retain the fleet cap and final ownership guard.

The Mac service runs `extension-worker.cjs` from `~/epic-claim/` using the existing `run-worker.sh`; its `worker.js` is a small launcher. Restore the timestamped pre-change `worker.js` and restart `com.redeemer.epic-claim-worker` to roll back. Runtime server changes use the repository's fingerprinted targeted-copy deployment backups.

## Session isolation and reconnection

The 2026-10-28 monitored batch reproduced refresh-token revocation when reusing the existing Epic browser session for another exchange login. Ownership could still verify through a cached access token, masking the broken refresh token until the next process. Pause the scheduler during recovery. The extension now removes only Epic browser cookies locally before every assigned login or checkout; it never calls Epic’s logout endpoint. Chrome’s origin filter clears cookies for the Epic registrable domain, including its subdomains: https://developer.chrome.com/docs/extensions/reference/api/browsingData. This signs out other Epic browser tabs. The connection requires explicit cookie-reset consent.

Run `node tools/epic-claim-worker/reconnect-local.cjs` on the Mac to reconnect existing unsold accounts whose refresh tokens fail. The command reads the encrypted local generator vault, sends each account’s saved login only to the localhost bridge, retrieves fresh Outlook codes via the local reader, and validates Epic’s returned account id before saving the encrypted replacement token over SSH. It verifies all previously recovered refresh tokens from a new process after every recovery. No account passwords, mailbox tokens, or OAuth codes are printed. Visible security checks or unknown review screens pause recovery. Existing MFA-method confirmation is supported; authentication settings are not changed.

Phone Claim buttons now call the verified worker endpoint and refresh the target account’s library. Old phone pages receive HTTP 409 from the retired `claim-link` endpoint with a reload instruction; Telegram claim reminders no longer mint launcher-backed login links. After every worker attempt, the orchestrator forces a real refresh-grant check rather than trusting cached library access. A revoked grant is marked for reconnection even when the game was successfully claimed.

2026-10-28 completion: all 13 unsold accounts held both current giveaways, all 13 refresh grants passed from a fresh process after the monitored claims, and scheduled claims were restored. Seven accounts were reconnected using their existing credentials and fresh email codes.


## Claim all missing

The server Epic Accounts page has a **Claim all missing** button. It snapshots
current missing live offers for unsold accounts with status `ok`, then processes
that queue serially using the existing verified manual-claim path. Each item
rechecks current sold/login/offer state before checkout. Double taps join the
running batch; individual manual claims cannot overlap that batch. The browser
bridge still arbitrates scheduler contention.

The server owns execution, so closing the phone page does not stop the queue.
Reopening the page restores progress through GET `/api/epic/claims/batch`.
A security challenge, unavailable Mac, busy worker, or daily cap pauses the queue.
After resolving it, press Claim all missing again to replan remaining ownership.
Stop after current lets an in-flight checkout finish and leaves later jobs alone.
Batch progress is process-local: a server restart ends the queue; press the
button again to recheck remaining games. Results contain no account credentials.

## Giveaway rollover

All claim paths share `epicOfferWindow`: expired, future and inactive offers
stop before checkout, including manual requests. Dates override stale upcoming
flags once the recorded start time has arrived. Account-page missing games and
scheduled claims use the same rule. Claim all refreshes stale giveaway data
silently before planning; that refresh sends no Telegram messages or extra claims.
The watcher polls at most every 15 minutes and schedules known start/end boundaries.
Concurrent claim calls share one process-level lock; a worker transport outage
returns unavailable without consuming retry history or a daily-cap slot.

## Checkout completion and HTTP 429

A blank route during purchase is not a receipt. The helper waits for explicit
completion or a stable empty receipt, leaves submitted tabs alive briefly, and
ownership verification allows delayed entitlement propagation. An unchanged,
enabled free checkout can retry its initial click at most three times, rechecking
identity and zero price each time. Regional blocks and paid checkouts report
explicit failures instead of silently waiting for a timeout.

The full-fleet test on 2026-10-30 JST confirmed ten current-game entitlements,
two explicit Russian-region blocks, then HTTP 429 from v2 confirm-order in
Chrome's console. A free checkout can remain visible after this server response.
The helper's page-world metadata observer reports that response without reading
request headers or bodies. This uses Chrome's declarative content-script world
support: https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts.
A 429 pauses the whole queue and persists a shared server cooldown in the ignored
`_epic_claim_backoff.json`. It honors Retry-After where available, otherwise waits
six hours (a fallback, not a promise about Epic's reset time). Cooldown survives
restarts, applies to manual claims too, and does not consume per-account retry
history or the daily cap. No region or account settings are changed.

Epic's limit outlasted that six-hour pause: one probe at 07:07 JST and another at
13:28 JST on 2026-10-30 both got 429 again. So a 429 within 12 h of the last
pause ending doubles the pause (6 h, 12 h, then 24 h at most). A pause file
from before this rule counts as six hours. Once Epic answers a checkout normally
(claimed, already owned, region refusal, not free), the next 429 starts again at
six hours. While a pause is on, the page's Claim buttons and Claim all read
"Paused until HH:MM" and are disabled, and the Claim all route refuses to start.

Checkouts that reach Epic are also spaced at least 5 minutes apart
(`EPIC_CHECKOUT_GAP_MIN`, 0 turns it off). The 2026-10-29 burst ran 17 checkouts
in 27 minutes. A claim inside the gap answers `spacing` at once instead of holding
the one-claim lock. The scheduler and Claim all wait it out and retry the same
game, and the manual Claim button says when to try again. A busy or unreachable
Mac worker never opened Epic's checkout, so it does not start the gap.

## Region locks

Some giveaways are not sold in some countries (2026-10-29: every RU account
got "not available in your region" for Sorry We're Closed). The helper reports
`region_unavailable` without submitting anything. That log entry is final: the
pair is never retried, it gives its daily-cap slot back, and every other
account from the same country is locked out of that giveaway too, in the
scheduler, Claim all and the manual Claim button (`utils/epicRegion.js`).
An account's country is its saved details' `creationCountry` (the signup
proxy IP from the region detector), else its recorded `country`; accounts with
no country are only locked by their own refusal. No Telegram ping is sent for
a locked pair or during an HTTP 429 pause. The Epic Accounts page shows each
account's country, lists locked games apart ("Region locked · RU") without a
Claim button, shows each missing game's last try, and says when a 429 pause
lifts. After a pause the scheduler runs again two minutes after it lifts
instead of waiting for the next 6-hour tick.
