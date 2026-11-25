# Personal companion helper clip overlay

Source-only backup of the targeted helper files accompanying the viewer clip controller. These files update the two existing standalone personal companion installations; they are not a second helper service or the account farm.

Each `primary/` or `test/` tree is an overlay for its matching existing installation. Back up matching current files, copy the overlay at the same relative paths, run `node --test test/*.test.mjs` from that installation, then restart only that helper. The second helper retains its separate fixed loopback port and pairing identity. Do not copy any private directory, OAuth grant, account configuration, history or intent state.

`lib/clips.mjs` owns durable viewer clip jobs and explicit device authorization. `lib/twitch.mjs` adds the official Twitch viewer clip API and optional `clips:edit` grant. `server.mjs` exposes only fixed paired local routes. Automatic jobs require a single-use private host permit immediately before the Twitch request. There are no extension or browser permission changes.

Controller contract and activation: [CLIPS.md](../stream-companion-host/docs/CLIPS.md). Clip permission must be approved separately on Twitch for each selected account; existing chat grants remain usable when that approval is absent or denied.

Rollback restores the matching previous source files and restarts the affected helper while held. Preserve the current private clip journal and credentials, including permission-repair markers, and never replay uncertain clip submissions.
