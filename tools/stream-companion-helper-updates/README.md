# Personal companion helper source updates

Source-only backup for the three existing personal companions, including the central message director and viewer clips. The primary/test overlays update the matching standalone installations; they are not a second helper service or the account farm.

Each `primary/` or `test/` tree is an overlay for its matching installation. Verify the matching source fingerprints and test a complete disposable source stage before copying intended files at the same relative paths. Back up overwritten source first. Keep each helper's fixed loopback port, manifest identity, pairing identity and credentials. Do not copy private directories, OAuth grants, account configuration, history or intent state into this backup.

The Mac host owns the message bank, decisions, immutable plans and outgoing history. Extensions report their own account's playback and execute exact current host plans; helpers retain credentials and the final Stop, account, channel, restriction and submission checks. There is no automatic local message fallback. Manual reviewed sends and drafts also pass through the central director. See [the director contract](../stream-companion-host/docs/CENTRAL-DIRECTOR-1126.md).

Update the host and all three helpers while globally paused and profiles inactive, then restart the affected services and reload each installed extension. Central authority remains held until durable imports of every helper's outgoing journal and every extension's sent, participation and handled ledgers are acknowledged. Preserve all original journals. Never re-enable an older autonomous planner or restore an older database to undo the migration.

`lib/clips.mjs` owns durable viewer clip jobs and explicit device authorization. `lib/twitch.mjs` adds the official Twitch viewer clip API and optional `clips:edit` grant. `server.mjs` exposes only fixed paired local routes. Automatic jobs require a single-use private host permit immediately before the Twitch request. There are no extension or browser permission changes.

Controller contract and activation: [CLIPS.md](../stream-companion-host/docs/CLIPS.md). Clip permission must be approved separately on Twitch for each selected account; existing chat grants remain usable when that approval is absent or denied.

Rollback is coordinated source-only recovery while held. Preserve newer message/clip journals, completion outboxes, coordination database and credentials, including permission-repair markers. Never replay uncertain submissions. Keep automatic messaging paused until one compatible host/helper/extension version is verified across all three profiles.

The `third/` tree is a complete source-only bootstrap for the third personal companion on8796. Its manifest omits the generated identity key. Run setup only for a fresh installation; preserve an already-installed manifest key and private configuration when updating or rolling back. See [third setup](third/README.md).
