# Stream Companion Third

A separate personal Stream Companion instance on `127.0.0.1:8796`, using its own extension identity, Chrome profile, helper pairing, Twitch authorization and private journals. Routine controls are provided by the shared host at `http://127.0.0.1:8795/accounts/third` after that host is configured for the third companion.

The third instance starts held. Setup creates a fresh extension identity and local pairing; it never copies another account's private state. Before installing or starting the service, add the separately reserved account's private host pairing and account-only bootstrap metadata. Initial OAuth requires the matching account's approval through Twitch. Neither initial setup nor a service restart starts chat or playback.

## Installation state

This source tree bootstraps a separate installation. It contains no Chrome profile, browser session, Twitch credentials, message history or clip history. Use the local service status and controller for the installed instance’s current state. The original primary and second companions remain separate.

The private directory must stay outside source control. Its helper configuration, host pairing, optional OAuth grant, intent, delivery history, completion outbox and clip journal belong only to this instance. A fresh `{version:1,held:true}` control-intent journal is prepared independently.

## Verification

Run `npm test` for mocked local helper, browser, Twitch API and clip tests. Runtime uses built-in Node APIs and requires Node22.16 or newer; the test suite uses the declared jsdom development dependency. Historical second-profile lifecycle scripts were intentionally omitted because they target other existing installations.

## Service and browser

The service label is `local.stream-companion.third-helper`. Install/start it only once the reserved account and shared host pairing are in place. Service commands in package.json address this helper alone. Use a dedicated Chrome profile named **Stream Companion Third**, then load this instance's `extension/` folder and save its independently generated local pairing in the extension panel.

Keep automatic replies and session recovery off during initial authorization and verification. Additional optional Twitch page access and clip-creation permission use the existing explicit controls. The shared host must retain its current pause state until the owner starts a session.

## Source backup and updates

The source-only third overlay is kept in the nodeserver repository under `tools/stream-companion-helper-updates/third`. Its manifest is a source template with no generated key. Fresh `npm run setup` generates that installation's key and pairing locally. When updating an already installed profile, preserve the existing runtime manifest key and private pairing instead of replacing its identity with a newly generated one. Never copy another installation's key, pairing or browser session.

The shared host pairing uses `{url,clientId,account,token}` with the fixed host URL and `clientId: "third"`. A new account-only OAuth metadata file may contain only `{account}` to satisfy the startup account binding before Twitch grants access. It must contain no borrowed access or refresh token. Initial account and channel setup belong in the new profile's extension panel; keep it held throughout setup.
