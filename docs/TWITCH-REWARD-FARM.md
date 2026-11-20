# Dedicated Twitch Rewards farm

Twitch Rewards → Farm bots (`/twitch-rewards.html#farm`) controls an isolated GTA VI worker. Each bot owns one unused, verified pool account and has independent Start/Stop controls. Ordinary no-claim, managed, rental and marketplace services are not reconfigured by this feature.

The section uses a separate container prefix, source/image and persistent Configuration/log folders. It requires the TwitchDropsBot `codex/gta-vi-reward-farm` build, image `twitch-reward-farm:20261120`. RewardCampaignsOnly prevents fallback to standard Drops. ClaimDrops stays off. The configured campaign window ends 2026-12-01 07:59:59.999Z; both worker and controller enforce the cutoff. Stop retains the account reservation. Creation is capped at five bots across operators.

Creation respects both existing fleet fences, committed listing ledgers and the pristine-account reserve. It atomically claims a pool row, validates Twitch login/ID against the token, writes a guarded private config and creates a stopped container. It returns a failed claim only when Docker proves no corresponding container exists; otherwise the account stays reserved for review. Accounts with sold-game history or existing drop inventory are excluded.

A minute worker check reads only this section's containers and imports issued code receipts into the existing encrypted Accounts & codes ledger. Import verifies account identity, deduplicates codes and rejects overwriting a saved code. There is no public worker-auth endpoint. Private SSH transports may carry decrypted code exports internally; they must not be logged. Code files and keys remain persisted in each bot's private Configuration mount as a recovery source.

Watch progress is only shown when Twitch reports it. Missing counters remain unknown. A badge goal is not a game code, and surprise game keys are not guaranteed after a viewing timer. Account/code totals count actual saved awards, not viewing activity.

Deployment is targeted: fingerprint the five existing Rewards assets/router before copying, back them up with a manifest, install only this section's changed/new files, require-load the route and run syntax checks, restart the app, verify unauthenticated APIs remain protected and run an authenticated smoke through the documented throwaway Express harness. Build the separate worker image; never overwrite existing farm image tags. Start one bot and inspect live behavior before adding more.

Rollback: stop this section's exact reward containers first; retain their folders, keys and pool reservations. Restore existing files from the deploy manifest and remove only its newly installed feature files, then restart the app. Keep the reward-bot collection and code receipts. Do not return accounts to available while any config can still use them.
