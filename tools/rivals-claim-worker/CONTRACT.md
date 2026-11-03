# Rivals claim worker contract

The Mac owns a durable, encrypted queue. A scheduled Codex worker uses CUA to run the actual launcher, game and browser. The loopback app is the control plane and evidence ledger; it does not pretend that a network request or a click collects an item.

One account pair and one active lease at a time. Account identities and expected rewards come from inventory that has been explicitly held for this job. No live offer stock may be imported. Credentials are encrypted outside the repository. Browser API reads never include credentials; copy actions reveal only the selected credential to the clipboard.

Phases: queued → signed-in → linked → collected → verified → logged-out. A job becomes ready only after logged-out, with every expected reward individually verified in the actual game. Mail collection and inventory verification are separate observations. Each observation includes the selected Steam account, Rivals UID, observation time, screen description and expected reward IDs. The UI worker is the trusted observer; records are its observations, not cryptographically proven game entitlements. Unexpected screens stop that job for review. The queue is not a game protocol client.

Leases last 15 minutes, renewed per action. Process restarts and lease expiry retain the phase and account pair. A different worker cannot advance a live lease; expiry requires recovery of the same job, never a fresh login to another pair. Once linking may have started, the pairing cannot be changed or released automatically. Retried operations are idempotent by event ID. Job revisions reject stale writes. Claims must occur before the recorded mailbox expiry; this deadline is based on actual game mail, not Twitch campaign dates.

A local native service watches download status from GameHub's existing log as a hint only. Installation and game UI identity must be observed before advancing. No automatic paid purchase, publishing, farming configuration changes or account batches. The initial live canary is one pair. Tests use isolated temporary directories and fake stock; no test suite touches production.

The source worktree remains independent of the original dirty checkout. The runtime data directory is ~/Library/Application Support/RivalsClaimWorker. The dashboard binds 127.0.0.1:4112 and requires a private per-launch token for every API. Write routes require same-origin JSON. No state changes on GET, no cross-origin credential access, no request-body/credential logging.
