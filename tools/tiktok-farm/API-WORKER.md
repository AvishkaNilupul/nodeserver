# Saved-session API worker

Runs one account inside Termux using curl for authenticated HTTP and a native-format
WebSocket for LIVE presence. It does not launch TikTok, an emulator, Frida, or video
playback. Initial session enrollment and expired-session renewal remain external.

## Contract

- Reuse the existing dashboard worker authentication, automatic discovery schedule,
  exact job leases, duplicate guards and encrypted code store.
- Only supported type-5 countdown rewards, up to one hour; skip share/link/gift tasks.
- Confirm the requested room in the native entry response before watching.
- Renew the job lease before claiming. Send a claim once. Uncertain claims enter
  review; a returned code is fsynced locally before delivery and recovered before
  accepting another job. The server's completion acknowledgment is idempotent.
- Session-required responses appear in the dashboard. Never loop through login,
  CAPTCHA, or new account creation. Network errors back off and watches have bounded
  socket reconnects and a two-minute no-progress deadline.
- The source contains no session or worker credentials. `state/session.enc` is
  AES-256-GCM encrypted using a separate phone-local `session.key`, both mode 0600
  inside a 0700 directory. The production master key stays on production.

## Runtime

Python 3.14 with `compression.zstd`, curl, Node (startup decryption only), and the
existing isolated websocket-client package. Copy this directory's API worker,
client, control, native socket, phone bridge, dictionary and config reader into
`~/tiktok-api-worker`. Keep state under its `state/` directory. Run:

```sh
python api_worker.py --state "$HOME/tiktok-api-worker/state" --scan
python api_worker.py --state "$HOME/tiktok-api-worker/state"
```

The managed Termux task `watch-api-worker.sh` restarts an exited worker and holds a
singleton lock. Install `30-tiktok-api.sh` in Termux:Boot. It uses its own service
task and does not change SOOP or Epic scripts. Android still requires the owner's
normal unlock after reboot. Phone power and connectivity remain prerequisites.

Disable only this account's dashboard automation, create `~/tiktok-api-worker/disabled`,
then terminate the verified worker PID while idle to stop. The supervisor exits
and the boot hook respects that marker. Preserve state and pending results.
Remove the marker and invoke the boot hook to resume. Never start a second worker
for the same account elsewhere.

Rollback: stop this worker as above and remove its dedicated boot hook; restore
only any files backed up for this deployment. No production runtime restart or
SOOP configuration rollback is required. Keep the code inventory and session.

Validation must include phone campaign reads, one fresh watch and stored claim,
restart recovery while idle, a duplicate-launch check, and continued SOOP health.
Unit tests cover room binding, exact claim scope, lease failure, uncertain claims
and durable recovery after a storage outage. A short test does not establish
indefinite uptime or future compatibility with changed reward protocols.
