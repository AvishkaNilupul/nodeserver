# Local account page operations

## Routine use

Open [Accounts](http://127.0.0.1:8795/accounts), then choose [Main companion](http://127.0.0.1:8795/accounts/primary) or [Second companion](http://127.0.0.1:8795/accounts/test). Each page controls its fixed helper and Chrome profile regardless of which browser opens the page. The [coordination page](http://127.0.0.1:8795/) independently controls shared turn grants and optional bot exchanges.

1. Keep the intended account's Chrome profile open. If playback permission is missing, grant it from that profile's existing extension controls; hosted commands do not open a permission prompt.
2. Choose the channel login, conversation mode, reply source and automatic-recovery preference. Start opens the ordinary Twitch watch page and arms the chosen session after confirming the intended chat identity/channel. A verified offline channel may wait for the stream to return; known offline context holds automatic posts.
3. Use Open stream to return to the tracked watch page. It can also open the selected channel while stopped without connecting or arming chat.
4. Use Stop to interrupt work and hold the helper. Browser cleanup waits for the extension if the profile is unavailable. A stopped companion stays stopped when safe settings are saved.
5. Review drafts before explicitly sending. Summaries remain separate from the message editor, and late draft results do not overwrite newer edits. No public demonstration send is needed to verify the controls.

The extension remains the browser/watch engine, with its Simple and Advanced controls available as fallback. The hosted pages do not replace account authorization or secret configuration. They contain no credential setup fields.

After maintenance, select each companion's ordinary Twitch watch tab and leave the active primary profile in front. Brief visits to controls are fine. Preserve each profile's running/stopped intent; do not start a stopped profile for tab arrangement. There is no recurring focus-stealing task. Foreground visibility alone is not proof of healthy playback.

## Reading status and failures

| Display or outcome | Meaning and next step |
| --- | --- |
| Host unavailable / status stale | The last values are retained for context. Wait for a fresh host response before relying on them. |
| Session unverified / no browser check-in | The helper has no current browser evidence. Open the account's profile and check its extension. Fresh helper defaults do not establish an enabled session. |
| Browser check-in older than45seconds | Start, settings, draft, send and drop actions are held. Stop can still enforce the helper hold when the host is available. |
| Chat connected | The chat transport connected; check the separate video status for playback. |
| Missing playback access | Grant optional Twitch playback access from the extension fallback controls before hosted Start. |
| Queued / running | The request was accepted or claimed, not yet confirmed complete. Stop can interrupt an older Start. |
| Failed / cancelled / expired | Read the command reason. Expiry is90seconds; an expired or lost command is not replayed. |
| Unconfirmed message outcome | Inspect delivery history. No automatic retry follows an uncertain submission. |
| Channel ban / verified-phone restriction | A channel/account restriction reported by Twitch. Playback or chat connectivity does not override it. |

While stopped, Start, Open stream, safe settings and disabling claims remain available when the necessary browser evidence exists; Stop can also hold a helper without a current browser. Drafting, sending, enabling claims and checking drops require a resumed session. Shared coordination Resume only restores eligibility; it does not Start either account.

## Implementation and verification boundary

The host serves `public/account.html`, `public/accounts.css` and `public/accounts.js` at the account routes. `lib/accounts.mjs` reads fixed helpers8792/8793 server-side. Same-origin/CSRF checks protect typed, allowlisted controls; browser pages never receive helper pairings, OAuth or provider credentials. The helper broker owns command states and the extension relay executes Chrome operations. Session, generation, command ownership, exact reviewed text and expiry are rechecked at the final send boundary.

Only `{version, held}` is persisted in each helper's `private/control-intent.json`. Stop, a Start transition, failed/expired Start and interrupted Start retain a hold. A verified completed Start can release it. Commands, draft text and browser session identifiers are not saved in that journal. Replacing a worker or restarting a helper does not replay a queued/running public send. Existing delivery and coordination journals remain separate.

At the 2026-11-25 implementation checkpoint, automated verification passed **93 host tests and 269 tests per helper**. Tests use simulated browser/provider behavior and local ephemeral HTTP servers. Native activation encountered a primary-account ban on `artofgaby`; both companions were stopped and shared coordination paused before another test channel was selected. This is a checkpoint record, not a claim that a paired live test or uninterrupted playback was completed. The running pages are the source for later operational state.

At **2026-11-25 03:19Z**, both accounts were participating on `strager`, shared coordination resumed, with no pending completions. A three-minute monitor recorded **19/19 Connected and Playing samples per account**, with no helper errors. Second's reply at03:15:54.912Z and primary's different greeting at03:19:01.972Z were Twitch-confirmed and visible together in native chat,187.060seconds apart. This verifies two-account ordinary delivery and observed spacing. It does not verify uninterrupted future playback or the occasional two-line exchange: that exchange remained scheduled for04:52:35.456Z, with timing unchanged and zero scenes used. Both ordinary watch tabs were selected at handoff; primary foreground. Sanitized activation, command, source/process and native evidence is in `private/evidence-local-pages-1125/`.

## Source-only rollback of this rollout

Use each project's own timestamped `private/backup-local-pages-*` source backup. This rollout is separate from the earlier `backup-central-host-20261125` rollback. Do not exchange source manifests or private directories between accounts.

1. Stop both companions and pause shared coordination. Record the intended account/channel/running state and the chosen backup timestamp.
2. Stop only the local services whose source will be restored. Keep the shared coordination database and all private runtime data in place.
3. Restore the intended host/helper/extension source files from their matching project backup. Keep each helper's own loopback port, manifest identity and private configuration. Do not copy a backup `private/` directory wholesale.
4. Restart the affected services and reload each unpacked extension. Verify fixed account identity, helper reachability and current browser evidence before a new explicit Start. Leave both companions stopped and coordination paused until that check and the desired running state are established.
5. Finish on the ordinary watch tabs as described above. Reverting the control pages does not require clearing any delivery or duplicate records.

Preserve, without resetting or replacing:

- The shared database at `~/.local/share/stream-companion/message-coordination.sqlite` and its SQLite sidecar files. Never run an old helper-side writer concurrently with the host.
- Each helper's `private/host-completions.json` outbox and `private/control-intent.json` hold journal.
- Each installation's existing OAuth, pairing/provider configuration, send history, participation history and Chrome storage.

Never delete an intent hold to force a Start, clear an uncertain outcome to make a message retry, or restore older history over newer delivery records. If a pre-rollout extension fallback is used, confirm its current Stop state explicitly before leaving it unattended.
