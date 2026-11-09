# TikTok account onboarding

Contract: new account login -> isolated temporary Mac Android instance -> human verification when required -> captured native request/session + WebSocket entry -> encrypted server handoff -> phone validation and encrypted local install -> ready and auto-farm enabled. No Mac farming worker is started. Existing accounts and their pending results are never replaced by enrollment.

Only authenticated superadmins submit credentials. Only the separate setup agent can obtain login jobs and upload session packets. Only the existing authenticated phone worker can lease and acknowledge session delivery. Leases, account slot and packet digest bind every transition. Secrets never appear in dashboard responses or logs. Duplicate identities are rejected before enablement. A lost completion acknowledgment retries idempotently.

Phone enrollment adds a thread to the shared fleet without restarting existing account threads. Verification uses read-only campaign discovery; no reward claim is used as a setup test. The temporary Android instance shuts down after capture or failure; an account needing interactive verification remains available for Resume. Existing slots are not a session-renewal target in this release.

Implementation: setup-worker polls the existing separate setup-key endpoint. Human verification uses the preserved Android window and Resume. Capture checks a current LIVE source, retains only the HTTP entry and native WebSocket entry template, uploads at most 48 KB, then shuts Android down. Login correction after a failed new-slot setup resets only that slot's local app data on the next attempt.

The phone polls enrollment every 30 seconds; session verification performs authenticated campaign reads without claims. Successful installation uses a fresh phone-local encryption key and atomic directory rename. A durable acknowledgment record is replayed after network loss. The fleet picks up activated slots within six seconds. Existing phone directories are never overwritten, including slots with pending codes. Expired delivery leases are reissued without deleting installed state.

Supported native socket origins include the observed Singapore `.tiktokv.com` host as well as US/EU origins. Capture/session validity is distinct from login-cookie expiry. Initial API-only login and automatic session renewal are not implemented here.
