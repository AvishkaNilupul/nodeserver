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
