# Epic browser claims

The active path is nodeserver → SSH tunnel → localhost extension bridge → Epic Claim Helper in regular Chrome. The previous standalone browser triggered a visible challenge; the regular-profile extension completed the live Home test without one on 2026-10-28. This does not guarantee every checkout will be challenge-free.

Load `extension/epic-claim-helper` as an unpacked Chrome extension. Open `http://127.0.0.1:8123/connect`, enable the free-game checkout agreement, and connect. Pairing survives restarts. Keep Chrome and the Mac running; the existing launch agents maintain the bridge and tunnel. The page can be closed after pairing.

The bridge uses `CLAIM_WORKER_TOKEN` from the existing worker environment. It derives a separate token for the extension. It binds only to localhost, permits one claim at a time, expires jobs, and authenticates results by job id and lease. The helper only acts in its assigned tab, checks the account name, offer id, and explicit $0.00 checkout, and leaves visible security checks for the operator. Successful submissions close their tab.

A UI submission is provisional. Nodeserver checks Epic's library before recording success, including after apparent worker failures. The manual auto-claim endpoint uses the same worker and verification flow. Sold accounts are skipped; manual actions can bypass the scheduler's enabled flag and retry wait, but retain the fleet cap and final ownership guard.

The Mac service runs `extension-worker.cjs` from `~/epic-claim/` using the existing `run-worker.sh`; its `worker.js` is a small launcher. Restore the timestamped pre-change `worker.js` and restart `com.redeemer.epic-claim-worker` to roll back. Runtime server changes use the repository's fingerprinted targeted-copy deployment backups.
