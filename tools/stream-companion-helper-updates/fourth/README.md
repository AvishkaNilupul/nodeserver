# Stream Companion Fourth

Source-only bootstrap for the fourth personal companion: helper `127.0.0.1:8797`, central client `fourth`, extension **Stream Companion Fourth**, and LaunchAgent `local.stream-companion.fourth-helper`. The original three installations keep their own identities, ports and private state.

`npm run setup` creates this installation's fresh extension key, local pairing and `{version:1,held:true}` control intent. It does not allocate an account, register a host client, authorize Twitch, create a Chrome profile, install a service or start a session. No account login is embedded in this source tree. Private directories use `0700`; generated private files use `0600`.

Before installing the service, the owner-controlled setup must provide this instance's new private host pairing `{url,clientId,account,token}` with the fixed central URL `http://127.0.0.1:8795` and `clientId: "fourth"`. Account-only OAuth bootstrap metadata may contain `{account}` until that exact account grants its own access. No access token, refresh token, browser storage, email or delivery history is borrowed from another profile. Startup and service installation reject another companion's host client ID.

Load this installation's `extension/` in its dedicated Chrome profile. Save its own local account/channel/pairing values and keep it held, with automatic replies and recovery off, throughout preparation. The central controller owns message wording, plans and outgoing history. This helper keeps the final account, channel, playback, restriction and Stop checks. It has no automatic local message fallback.

Central roster registration is a coordinated paused change. Both fourth imports must be durably acknowledged alongside the existing six before central readiness is restored. Preserve all existing imports, history, consumed opportunities and scenes. No Start, public chat message or clip is necessary to verify setup.

The official NordVPN extension is installed separately through Chrome in the fourth profile. Its browser connection state is distinct from the Node helper's Helix/EventSub connections. No VPN credential, browser setting or system routing configuration is stored in this source bootstrap.

Run `npm test` in a complete disposable source stage. Tests use synthetic accounts and temporary loopback services; fresh-setup tests verify independent identities, held startup, rerun preservation, rejected copied identities and isolation from all three original ports.

When updating an existing fourth installation, preserve its installed manifest key, pairing and every private journal. Setup refuses an existing private configuration whose matching manifest key is missing. Service commands address only this fourth helper. Rollback preserves all newer private state and remains held until compatible central authority is verified.
