# SOOP phone service keeper

These scripts update the existing Termux SOOP relay installation; existing
`tunnel.sh`, `supervisor.sh`, `wakelock-loop.sh` and private `ports.env` remain
in `~/soop-egress/`. They do not change egress assignment or install credentials.

Termux 0.118.3 stops its foreground service when its wake lock is released with
zero managed sessions and tasks. Detached `nohup` workers do not count as managed
tasks. Periodic unlock/relock therefore can stop the service on a boot-only
installation and leave Android free to kill the empty app.

`start.sh` registers `service-keeper.sh` as a Termux-managed background task
before starting the existing workers. The keeper has an exclusive lock, a PID
file and a 30-second heartbeat. Repeated startup creates no duplicate keeper.
The managed task prevents an empty session/task list during lock refresh.
`10-soop-egress.sh` calls the same startup path from Termux:Boot.

Deploy `start.sh` and executable `service-keeper.sh` to `~/soop-egress/`; deploy
`10-soop-egress.sh` to `~/.termux/boot/`. Back up existing scripts first. Run
`sh ~/soop-egress/start.sh`. In the Termux notification, expect at least one
task even after closing all terminal sessions. After reboot, an initial PIN
unlock is still required. Existing powered screen-stays-on settings remain
necessary for the separately observed ColorOS sleep/network issue.

Verification performed on the phone: zero terminal sessions, one managed task;
three explicit unlock/relock cycles with the same foreground service; repeated
startup and boot-hook invocation with one keeper; both tunnels and Japanese
egress verified from production. This does not establish overnight stability
or recovery from Android killing the whole app despite foreground status.

Reference: [TermuxService 0.118.3](https://github.com/termux/termux-app/blob/v0.118.3/app/src/main/java/com/termux/app/TermuxService.java#L683-L689).

## Full-phone routing

The farm and cookie renewer can both use the existing phone SOCKS listener:
set `SOOP_PROXY_URL=socks5h://127.0.0.1:1085`, `SOOP_SOCKS_HOST=127.0.0.1`
and `SOOP_SOCKS_PORT=1085` in the server's protected environment, remove
`SOOP_PROXY_ALT_URL` and `SOOP_PROXY_ALT_LOGINS`, then restart the app.
No account or bot migration in MongoDB is needed. An omitted renewal port
silently retains its default of 1080, so changing the farm proxy alone leaves
a Mac dependency. The phone tunnel and boot configuration stay on port 1085.

`phone-watch.sh` is the existing production minute watcher with its outage
wording updated for this full-phone configuration. It belongs outside the app
checkout in the operator's existing relay directory. Its existing service,
state, health checks and alert delivery stay in place; do not start a second
watcher. Back up and fingerprint the current script before replacement.
