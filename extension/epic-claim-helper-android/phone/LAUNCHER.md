# Epic Claims phone takeover

The phone is the active browser worker. A Firefox home-screen shortcut named
**Epic Claims** opens `http://127.0.0.1:8123/phone`. The dashboard fetches the
remaining eligible account/game pairs, shows the count and per-game breakdown,
then starts the existing Claim all queue after four seconds. Repeat taps join
the same queue. Returning from a checkout uses `/connect` and never starts a
second batch. Stop finishes the current checkout before stopping the queue.

Keep Firefox visible and the phone unlocked. Security challenges pause the
queue for a tap; cooldowns, region refusals, sold-account checks, library
verification, normal daily cap and checkout pacing remain in effect. The
phone shortcut starts operator-driven claims; scheduled automatic checkout is
disabled (`epicAutoClaim.enabled=false`). Manual Claim all explicitly enables
the operator run using the existing `manual` option.

The local phone panel uses a domain-separated HMAC of the worker token to
call only the dedicated status/start/stop API on the HTTPS server. The API is
mounted before blanket admin-session guards and authenticates independently.
No account credentials, exchange codes, raw worker token or account IDs are
returned to this panel. All controls share the existing singleton queue.

Install alongside the phone bridge: `phone-panel.cjs`, `phone-panel.html`,
and the updated `phone-bridge.cjs`. Phone `.env` needs `EPIC_PHONE_SERVER_URL`
set to the deployment's HTTPS origin. Keep the existing protected worker-token
configuration. `/pair` retains the original add-on pairing page.

The production worker URL points to its loopback phone forward. Install
`epic-phone-tunnel.service` on production for automatic SSH reconnects. It
uses the existing phone management tunnel, which originates on the phone.
Install executable `watch-workers.sh` alongside the bridge and
`20-epic-claim.sh` in the phone's `~/.termux/boot/` folder. Run the boot
script once to register the watchdog as a Termux task. It checks every 30
seconds and uses the existing launcher to restart missing workers. A reboot
still requires the owner's initial PIN unlock before Termux can run.
To stop the bridge and proxy for maintenance, stop the watchdog task first
(see `PROXY.md` for proxy controls).

Disable both Mac Epic LaunchAgents with `launchctl disable`, then boot them
out. Leave the Mac's unrelated SOOP and mail services alone. Neither Mac Epic
worker nor its tunnel should be re-enabled while the phone is primary.

Rollback uses the timestamped production backup of the router, server mount,
environment and previous home-IP cooldown. Remove the new phone-control module
only if absent before deployment; re-enable the prior scheduler setting and
Mac Epic agents; stop the phone tunnel service. Re-fingerprint before restoring
files because another release may have changed them. Restore the phone bridge
and environment from its private backup if removing the dashboard.

Tests cover authentication, narrow response fields, count-only preview,
joining/stopping one queue, cooldown/availability refusal, fixed HTTPS proxying,
count-before-start and no automatic restart after checkout return. A live phone
run on 2026-11-03 completed and verified its first claim automatically, then
waited at the normal five-minute checkout gap.

Phone helper 1.2.1.3 keeps the assigned job alive for its existing two-minute
checkout budget during a visible security check. Completing the check lets
it continue the same verified free checkout. An unresolved check still pauses
at the deadline. The panel labels a running queue explicitly, shows a live
spacing countdown and never automatically restarts a paused batch.

Phone helper 1.2.1.4 requests a screen wake lock on visible helper and Epic
pages, including checkout waits, and reacquires it after a visibility change
or an OS release. Navigation and hidden pages release their locks. The phone
panel also serves the same `phone-awake.js` from its directory, so copy that
file alongside `phone-panel.cjs` and `phone-panel.html` during installation.
Low battery or OS policy can refuse a wake lock; keep the phone powered and
Firefox in front. A five-second background poll reduces job pickup latency;
the server's checkout spacing and rate-limit cooldowns remain unchanged.

Phone helper 1.2.1.5 also selects the tab from its recent, top-frame visibility
heartbeat. Firefox Nightly shortcut tabs can report `active:false` and make
`tabs.query({currentWindow:true})` throw despite being on screen. Never create
a replacement tab in that case: it can lose desktop mode. A missing/stale
heartbeat refuses tab setup, and a setup failure now returns an error to the
bridge immediately instead of silently waiting for the lease timeout.
