# Stream Companion Host

Fourth-profile setup and additive migration: [FOURTH-PROFILE-1126.md](docs/FOURTH-PROFILE-1126.md). Existing bank revisions, delivery records, imports and consumed scenes remain intact.

The Mac host owns the message bank, automatic decisions and outgoing history for the four personal companions. **Messages** edits the central catalog and shows the same delivery rows used by account details. Extensions report browser evidence and execute exact server plans; helpers retain Twitch authorization and final identity/channel/Stop checks. The protected site remains its existing typed gateway.

Current authority, schemas and paused migration contract: [CENTRAL-DIRECTOR-1126.md](docs/CENTRAL-DIRECTOR-1126.md). Design: [ADR-003](docs/ADR-003-central-director.md). The sections below retain the original coordination, operations and paired-exchange history. Never restore an older SQLite or journal over newer outcomes, or resume an older extension's automatic planner during rollback.

Optional remote access is available through the server's **Bots → Twitch Controller** menu, using its existing superadmin login and two-factor requirements. The protected route is `/admin/stream-companion/accounts`. Chrome, Twitch authorization, helper credentials and the coordination database stay on the Mac. The Mac must be awake and signed in, with the intended Chrome profiles open. Remote installation or reconnecting never starts a stopped companion.

Remote setup uses a separate private `private/remote.json` pairing, a fixed loopback reverse connection configured in `private/tunnel.json`, and matching private gateway settings on the server. Neither private file belongs in source control. The local URLs below continue to work. `npm run remote:status` checks the Mac connection; `remote:stop` disables outside access without changing companion intent. See [remote controller contract](docs/REMOTE-CONTROLLER.md).

Local account controls and shared turn-taking for the four personal Twitch companions. Open [Accounts](http://127.0.0.1:8795/accounts) for routine Start/Stop, stream, settings and activity controls, [Messages](http://127.0.0.1:8795/messages) for the central bank and outgoing history, or [Shared coordination](http://127.0.0.1:8795/) for shared limits and exchanges. The original read-only dashboard at8794 remains independent.

The coordination page shows each account's connection, playback observation, readiness, waiting reason, shared channel allowance and recent decisions. **Pause coordination** holds new turn grants across all companions; **Resume coordination** restores central eligibility. Neither button signs into Twitch or arms a stopped companion. Start/Stop each companion on its own account page; the existing extension Simple and Advanced pages remain available as fallback controls.

## Account pages

The routine controls are now available locally:

- [All accounts](http://127.0.0.1:8795/accounts)
- [Main companion](http://127.0.0.1:8795/accounts/primary)
- [Second companion](http://127.0.0.1:8795/accounts/test)
- [Third companion](http://127.0.0.1:8795/accounts/third)
- [Fourth companion](http://127.0.0.1:8795/accounts/fourth)

Each account page controls its designated account. Start selects the channel and recovery preference, uses the mode/source saved in Messages, then opens the real Twitch watch page in that account's Chrome profile. Stop interrupts a pending Start and saves a private hold across helper restarts. Open stream returns to the tracked watch tab. Safe settings can be saved while stopped without resuming it. Existing extension controls retain local Stop and final execution checks; automatic content selection stays central.

Pages show independent chat, video, browser check-in and permission status; current broadcast metadata; incoming public chat; retained delivery history; pending/completed commands; and earned-drop controls. Reply drafts and summaries are separate from explicit reviewed-message sending. An accepted command is shown as queued until the browser confirms it. Missing or stale browser state is unverified, not proof of playback. Verified offline channels can be armed to wait for the stream to return; known offline metadata blocks automatic posts.

The extension stays installed as the browser/watch engine and checks in without keeping a dashboard tab open. The regular alarm provides a fallback for worker termination, following [Chrome's service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle/). The Mac, Chrome profiles and actual Twitch players still need to be awake and available. No recurring window-focus job is added.

Account control is loopback-only with same-origin/CSRF checks. The server reads each existing helper's local pairing only in memory for fixed8792/8793 requests; pages never receive these credentials. Typed commands cannot change account identity, credentials or arbitrary URLs. Session/generation/command ownership and expiry are rechecked before provider submission. Browser command results are kept in helper memory; worker replacement/helper restart never replays a send. Only the stopped/transition hold is persisted in each helper's owner-only `private/control-intent.json`.

## Behavior

- Accounts exchange presence and turn proposals through this host. An optional **Occasional bot exchanges** mode adds short two-line exchanges between participating companion accounts in the same live broadcast.
- One generic category question per channel/broadcast and one companion answer per incoming message. Case, punctuation and spacing changes do not bypass recent duplicate suppression.
- Shared channel limit: six actual attempts/hour, at least three minutes apart across all companions. Existing per-account ten-minute participation spacing remains.
- Fresh direct replies precede generic questions. Equally eligible waiting companions alternate away from the last speaker. Stale playback, disconnected clients and old-channel proposals cannot take a turn.
- Direct addressing includes an explicit `@account` mention or Twitch's Reply action on that account's confirmed message in the same channel. A confirmed parent from an earlier broadcast or a reviewed manual send still belongs to that account; unknown, rejected and foreign parents do not establish ownership. Already-consumed or shared-answered incoming messages are excluded before choosing the newest target.
- Incoming reply targets remain eligible for 45 seconds and still obey the shared limits. A follow-up received during the three-minute cooldown can expire without a reply. Local mode answers supported message patterns from the enabled account catalog; unsupported text and a quiet room can produce no reply. Quiet does not by itself mean the browser or incoming feed failed.
- Unused leases expire. Known confirmed/rejected outcomes survive restart and completion replay; uncertain provider delivery holds its opportunity without retry. A host outage holds new sends without consuming a send allowance.
- Waiting activity explains current offline/playback state, cooldowns, unsupported local replies and the next occasional exchange check. These explanations read current state; they do not create a message opportunity or promise a send.

## Occasional bot exchanges

Enable or disable this feature on the host page. Each public line uses **`@recipient scene text`**, starting with the other companion's exact handle. The inline prefix was removed at the owner's request on2026-11-26; profile metadata and account identity remain unchanged. The host uses a collection of short local exchanges; it records used topics per channel and does not repeat them. When the collection is exhausted, it stays quiet. See the [message format contract](docs/EXCHANGE-FORMAT-1126.md).

The host schedules an opportunity every60–120minutes while both companions are eligible. A confirmed first line may receive one response3–6minutes later, within the normal shared limits. There is no reply chain. Both profiles need participation mode, fresh matching live metadata and playback; a stopped, disconnected or stale partner cancels the exchange. Fresh human chat defers it, and ordinary human replies retain priority. Unknown or rejected delivery does not trigger a follow-up or automatic retry.

The schedule, scene usage and outcomes survive restarts. There is no public test-send or fast-forward button. Enabling this feature does not start either profile. Start each intended profile through its account page when wanted; a stopped profile stays stopped.

Before the first line, the host requires two free hourly slots and enough time for the existing maximum reply delay. It rechecks at offer, reservation and begin. The return line needs one slot. This does not reserve future capacity: an ordinary human reply still has priority and may prevent the return. Unsent work consumes no allowance, and used scene identities remain durable.

## Setup and service

Requires Node22.16+ with built-in SQLite. The installed Mac services use `/opt/homebrew/bin/node`26.5.0. Run from this project with a suitable Node on PATH:

```sh
node setup.mjs
npm test
npm run service:install
npm run service:status
```

Setup is idempotent and creates only separate host-client pairings in this project's `private/config.json` and each existing helper's own `private/host.json`. It does not read or copy Twitch credentials. The host listens only on127.0.0.1:8795. Private files are owner-only; never commit them.

Both helpers must use their `HostCoordinator` adapter and reloaded extensions. Each helper still owns Twitch authentication and actual message submission. Its private completion outbox is replayed after host recovery. No helper-side database fallback is used; this service is the sole runtime writer of `~/.local/share/stream-companion/message-coordination.sqlite` and migrates the earlier ledger in place. Contribution content hashes expire after fourteen days; permit/request outcome identifiers remain available for idempotent replay after a longer outage.

```sh
npm run service:stop
npm run service:start
npm run service:restart
```

Stop preserves installation/data and causes updated helpers to wait for coordination. Auto-start works after Mac login; the Mac and Chrome still need to remain awake/online for playback and chat. No cloud service or spending is introduced.

The host retains sanitized status baselines, transitions and one-minute checkpoints from actual account reads in owner-only `private/status.jsonl` (four 1 MiB files including rotations). Browser/video source timestamps remain separate from host read time; token presence does not prove a valid chat grant. No chat text, account names, channels or raw errors are retained. See [status logging contract](docs/STATUS-LOG.md) for privacy, freshness, failure and rollback behavior.

## Verification and rollback

The local-pages implementation passes **93 host tests and 269 tests in each helper** at the 2026-11-25 verification checkpoint. Coverage includes permit idempotency, two-client races, shared budgets, pause/readiness changes, seed reconciliation, process restart, lease expiry, unknown outcomes, origin/token/CSRF isolation and UI failures. Helper suites additionally cover Stop during Start, stopped settings/Watch controls, worker replacement, expired sends at the final provider boundary, bounded relay payloads, durable hold recovery and completion replay. These automated checks do not establish uninterrupted live playback or a completed paired live test.

At the native activation checkpoint on 2026-11-25, the primary account encountered a channel-specific ban on `artofgaby`. Both companions were stopped and shared coordination paused before selecting a different test channel. That checkpoint is not a final paired live-test result; consult the running account pages for subsequent state.

Final activation03:19Z: both participating on `strager`, ordinary watch tabs selected and shared coordination resumed. Each player passed19/19 observations over3minutes. Both accounts delivered different Twitch-confirmed messages187seconds apart, also visible together in native chat. The occasional two-line exchange remains on its normal future schedule and has not been publicly verified. The running pages show subsequent state.

Routine use, failure states and source-only rollback for the hosted account pages are described in [Local account page operations](docs/LOCAL-PAGES-OPERATIONS.md). Preserve the database, private outboxes and both intent journals when reverting.

For a rollback of the central host itself, pause both companions and stop this host. Restore each helper's own backed-up source from `private/backup-central-host-20261125/`, preserving its port, manifest, credentials and histories. Restart both old helpers and reload each extension, then restore the intended running state. Keep the database, private outboxes and intent journals; do not run old helper-side writers concurrently with the host. The host's schema additions preserve the earlier contributions table, so rollback retains duplicate history.

Design: [ADR-001](docs/ADR-001-central-host.md), [ADR-002: bounded exchanges](docs/ADR-002-bounded-exchanges.md). Exact interfaces and invariants: [contract](docs/CONTRACT.md), [exchange contract](docs/EXCHANGES.md), [local control pages](docs/LOCAL-PAGES.md). No UI or logs include Twitch credentials, helper pairing tokens or account mail/password data.
