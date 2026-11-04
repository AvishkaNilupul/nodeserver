# Rivals claim worker contract

The Mac owns a durable, encrypted queue. A scheduled Codex worker uses CUA to run the actual launcher, game and browser. The loopback app is the control plane and evidence ledger; it does not pretend that a network request or a click collects an item.

One account pair and one active lease at a time. Account identities and expected rewards come from inventory that has been explicitly held for this job. No live offer stock may be imported. Credentials are encrypted outside the repository. Browser API reads never include credentials; copy actions reveal only the selected credential to the clipboard.

Phases: queued → signed-in → linked → collected → verified → logged-out. A job becomes ready only after logged-out, with every expected reward individually verified in the actual game. Mail collection and inventory verification are separate observations. Each observation includes the selected Steam account, Rivals UID, observation time, screen description and expected reward IDs. The UI worker is the trusted observer; records are its observations, not cryptographically proven game entitlements. Unexpected screens stop that job for review. The queue is not a game protocol client.

Leases last 15 minutes, renewed per action. Process restarts and lease expiry retain the phase and account pair. A different worker cannot advance a live lease; expiry requires recovery of the same job, never a fresh login to another pair. Once linking may have started, the pairing cannot be changed or released automatically. Retried operations are idempotent by event ID. Job revisions reject stale writes. Claims must occur before the recorded mailbox expiry; this deadline is based on actual game mail, not Twitch campaign dates.

A local native service watches download status from GameHub's existing log as a hint only. Installation and game UI identity must be observed before advancing. No automatic paid purchase or unrelated farming configuration changes. The initial canary is complete. The owner has authorized additional Rivals accounts and Eldorado listing after each account passes the same claim, inventory and logout checks. Commission the next held pair before expanding the batch. Tests use isolated temporary directories and fake stock; no test suite touches production.

The source worktree remains independent of the original dirty checkout. The runtime data directory is ~/Library/Application Support/RivalsClaimWorker. The dashboard binds 127.0.0.1:4112 and requires a private per-launch token for every API. Write routes require same-origin JSON. No state changes on GET, no cross-origin credential access, no request-body/credential logging.


## Saved sessions and repeat processing

Steam website cookies and the Windows Steam client are separate authentication
surfaces. Keep the native client's normal Remember me session inside its private
CrossOver bottle while the same unsold preparation is active. Do not extract or
inject browser cookies to impersonate a native game login. Every new Steam account
needs its own initial authentication; the assigned cloud mailbox supplies email
Guard when requested. Password changes, revocation and expired sessions may still
require authentication again. Do not reuse a saved session for a different job.
Verify the actual client identity before launching and the actual game UID before
linking. A restart resumes the current job; it does not assume the client identity
from a cached job phase. Normal sign-out is still required before listing, and
listed/sold accounts must never be reopened by the worker.

Allocation is a two-step, recoverable operation. `stock-import.cjs --prepare`
checks real unlinked Twitch inventory and all buyer/listing/lease references,
claims an intent marker by comparing original Steam notes, requests the canonical
booster stop, and returns waiting-logout. Repeat the exact request after the real
worker acknowledgement. Only a stopped/ready booster with logoutAt (or an account
that has never boosted) can move from stock to the dedicated problem hold.
`stock-import.cjs` then rechecks and reserves rewards using the existing canonical
reservation helper before importing encrypted credentials. Never force an active
booster into a hold. Changed/ambiguous commitments stop the job; intent markers and
partial holds are retained for reconciliation.

The agent operates native Wine windows through the owner-authorized helper when
CUA cannot expose them. `native-input.swift` targets an exact AX window title and
supports US-layout physical keystrokes from stdin, avoiding Wine's stale clipboard
cache. Rediscover process, window and bounds before input. Screenshot and inspect
after each meaningful action. Game observations use a full display capture because
per-window Metal captures can be stale. Unknown dialogs, CAPTCHA, terms and OAuth
permissions follow the active computer-control requirements; no blind click-through.

Reuse the picture layout, verified costume naming and delivery template. Every new
unit requires its own UID, inventory evidence and claim receipt. Previous account
screenshots are not ownership proof for another unit; a prior1100-token receipt
cannot establish the next account's reward amount. Current reservation matching and
normal sale sync remain authoritative.
