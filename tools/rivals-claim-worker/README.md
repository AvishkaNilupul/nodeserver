# Rivals claim desk

The local queue and encrypted credential store for a CUA-operated Marvel Rivals reward collector. The scheduled agent handles the actual launcher/game/browser UI. This service serializes the work and refuses to call an account ready until the agent records identity, linking, collection, each expected reward and sign-out in order. It does not implement a private game API or claim to infer inventory ownership from Twitch alone.

## Run

Requires Node.js 20 or newer. No package installation is needed for the local service.

```sh
node tools/rivals-claim-worker/install-local.cjs
node --test tests/rivalsClaimWorker.test.js
```

Open `http://127.0.0.1:4112`. Installation copies only the runtime source files into the private application-support directory, registers a login service and preserves the encrypted queue. The private directory must remain outside git and be backed up with its `queue.key`. Missing keys or corrupt ciphertext stop the service rather than resetting accounts.

## Canary allocation

Use the existing Steam booster stop action and wait for its real `logoutAt` before placing one unlisted Steam account in a dedicated preparation hold. Do not force a boost directly into stock or take an account from a marketplace. The stock importer checks the held account, sales/listing references, duplicate Twitch identities, copied credentials, pool history, existing reservations/leases and one live Twitch inventory before using the canonical production drop reservation helper.

The target server is read from the existing private Steam generator configuration. IDs, never credentials, go on stdin:

```sh
node tools/rivals-claim-worker/stock-import.cjs < private-canary-request.json
```

The request is `{ "id": "unique-job-id", "steamId": "24-hex-id", "twitchId": "24-hex-id" }`. The importer streams the selected credentials over SSH into the encrypted local queue. No password is printed. Its remote program is sent on stdin, not deployed into the web app. It does not restart production. A failed partial stock hold is retained for review; it must never be blindly released after a possible game link.

## Agent operations

`cli.cjs status` returns no credentials. Other commands read JSON from stdin: `acquire`, `observe`, `heartbeat`, `block`, `resume`, `pause`, `enable`, `import`. Acquiring requires an owner label, returns one account and a private 15-minute lease token. Use that token and the current revision for observations. On recovery, continue the same phase and account pair.

An observation has `id`, `phase`, `observedAt`, `steamLogin`, `rivalsUid`, `kind`, `screen` and the phase-specific facts. Kinds are `game-profile`, `linked-profile`, `game-mailbox`, `game-inventory`, `signed-out-screen`. Linking includes `twitchLogin`; collection includes integer `collectedCount` and actual `mailExpiresAt` if visible; verification includes exactly the expected `rewardIds`; sign-out includes `identityCleared: true`. Every observation must be fresh and reflect a screen actually inspected through CUA. The ledger trusts the operator's observation and does not make screenshots or entitlements cryptographically authentic.

Credential copy buttons are available on the authenticated loopback page. They copy only the chosen credential and never put it into the status endpoint. No account is uploaded to a marketplace by this tool.

## Recovery and stopping

Unexpected UI becomes a blocked job with an exact reason. A blocked signed-in job retains exclusive use of the game session. Resume keeps the pairing and phase; five attempts require review. Before starting a different account, verify the previous game/client identity has cleared.

Pause the queue on the dashboard to prevent new leases. Stop the local service using its LaunchAgent label `com.avishka.rivals-claim-worker`; account data and server holds remain intact. Remove only the task's own temporary keep-awake assertion when overnight work ends. The same-chat automation must be disabled when this commissioning task is complete or genuinely blocked. Bulk processing requires its own measured commissioning decision.


## Repeated account preparation

The owner can commission additional sequential jobs after the canary. For an
explicit unlisted pair, run the same private request first with `--prepare`.
A pending result means the canonical booster must acknowledge logout; repeat that
exact request. A held-for-import result allows the ordinary importer above. This
command never releases linked drops or converts a listed account into preparation.
The UI agent then processes the durable queue one account at a time and uses
Steam's native Remember me for interruptions during that unsold job. See CONTRACT.md
for identity rechecks, session expiry, sign-out and per-account screenshot rules.
Compile the authorized native helper with macOS swiftc when Wine windows cannot be
controlled through CUA. Its physical `keys` mode reads ASCII input exclusively from
stdin; credentials must never appear in arguments, command logs or screenshots.

An explicit owner request may retain the current verified game session for further
testing while listing that account. Export a manifest `sessionRetention` object with
`mode: "owner-retained"`, the actual `requestedAt` and the owner's reason. The trusted
report importer accepts this only at phase `verified` with all expected costume proofs;
it records state/phase `verified`, no completion/logout timestamp and the retention
request. Pause the local queue and preserve its active account. This is an operator
exception, never an inferred logout and never permission to switch accounts. Ordinary
preparations still require normal observed sign-out. Listing/delivery/stock guards apply
to both dispositions.

If native Steam stalls on restart, sample it before changing graphics. A confirmed
winecoreaudio AudioUnit/HAL initialization wait can be isolated with a Steam-only
`HKCU\\Software\\Wine\\AppDefaults\\steam.exe\\DllOverrides` empty `winecoreaudio.drv`
value. Back up the bottle registry first. This disables Steam client audio only; it
does not alter game audio or anti-cheat. Roll back by deleting only that value.
