# TikTok farm

The admin server queues one run per selected TikTok account and shows live events, watch progress, and stored codes. An authenticated Mac worker picks up jobs for the accounts it hosts. The regular workflow keeps TikTok sessions on the Mac.

```text
Superadmin and 2FA -> dashboard -> MongoDB <- HTTPS -> Mac workers -> TikTok
                                     |
                               encrypted codes
```

A worker owns a run through a short renewable lease. Only one queued or running job can exist per account. Expired jobs require operator review so that a crash after a remote claim cannot silently trigger another claim. Stop cancels queued work and asks a running worker to stop before claiming. Code and completed status are written together and code fingerprints prevent duplicate stock. The dashboard requires a separate reveal request for each code.

Each Android session can bootstrap only one worker at a time. Mac workers can continue over HTTP after bootstrap where the campaign supports it. Keep the deployment limit at the number of separately verified sessions. Review session refresh, resource limits, and code recovery before increasing the count. Marketplace publishing is a separate workflow.

## Run on the Mac

Configure a random `TIKTOK_WORKER_KEY` on the server and put the same value in a Mac file readable only by its owner. Start the existing trace Android instance and Frida service for each signed-in account. Use a separate state directory per slot and run one process per slot with the private trace environment's Python:

```sh
python tools/tiktok-farm/mac-worker.py \
  --server https://YOUR-ADMIN-HOST \
  --account tiktok-01 --device emulator-5566 \
  --key-file /private/path/worker-key --state /private/path/tiktok-01 \
  --trace /private/path/happy-watch-control.py
```

Open `/admin/tiktok-farm`, select the account workers, and click **Enable auto farm**. Enabled workers scan when idle, at most once every ten minutes, even with the page closed. The server stores the schedule in MongoDB and queues one eligible event per account, shortest remaining countdown first. Scheduled runs keep the Android live player open while the worker checks progress and claims through the API. Completed, stopped, and review runs are skipped. Failed runs can be retried after thirty minutes, up to three scheduled attempts per reward and account. **Pause auto farm** stops future scans. Use a run's **Stop** button to cancel existing work before a claim starts.

**Scan & farm once** checks eligibility and queues one event per selected worker. **Scan live events** lists eligible rewards without starting a run. Use **Farm event** to pick a card. Event results expire after five minutes. The scanner uses the last completed room or `TIKTOK_CATALOG_SEED_ROOM` to prompt Android for an authenticated LIVE request. The seed only starts discovery. Each event uses a room returned by TikTok's current campaign feed.

Manual start is still available if you have a campaign and room ID. Leave the task at `auto` if exactly one eligible countdown is available, or specify its task ID. Both paths select countdown rewards that require no game account link. A live session challenge may require operator action in Android. The pending result file in the private state directory is kept until the server acknowledges the code. The dashboard shows a job in review if its worker disappears during the run. Check TikTok's reward history before manually resolving it.

The Accounts tab can save an encrypted login against an existing or future worker slot. Only a superadmin with 2FA can save or reveal a login. Sign in to TikTok on the assigned Android worker to activate that slot. The Events tab shows eligible live rewards and dates supplied by TikTok for upcoming events.

For a new slot, select **Create emulator & sign in**. The Mac setup worker boots a clean Android device, installs the verified TikTok APK and attempts the supplied sign-in once. Accounts shows the step log and emulator. Complete any TikTok verification in that window and click **Resume setup**. After checking the signed-in profile and farm access, the setup worker registers the slot and enables auto farm.

The setup worker uses a separate `TIKTOK_SETUP_KEY` stored in a private file on the Mac. Run `setup-worker.py --server https://YOUR-ADMIN-HOST --key-file /private/path/setup-key` in the existing trace environment. A Mac restart restores enrolled devices when the setup worker starts. The setup worker defaults to four running Android instances on this host.

## SOOP phone API transport

Run `phone-bridge.py` on the phone with Termux Python and curl over a private SSH stream. On the Mac, put a mode-0600 `phone-command.json` beside `mac-worker.py` and `phone-client.py`. It contains the command and arguments for opening that stream. Each worker opens a separate connection for its own catalog or job. The dashboard reports the API route. The Mac Android player still provides playback for scheduled rewards. If the phone connection cannot be opened, the worker starts the operation with its Mac transport. A failed claim is never resent on a different route.

## Linux canary

`cloud-worker.py` tests one prequeued job from a private Linux checkout with the trace module staged as `trace.py` and the worker's Python dependencies installed. Pause the Mac poller for that account first. Capture a fresh Android room entry, then stop the app. Send the leased job's target identifiers, worker key, and captures to Linux over SSH stdin. The worker reads eligibility, acquires the queued job, and uses the same lease and encrypted inventory as the Mac workers. The handoff stays in memory. The only file the canary may write is a private pending code result; preserve it if the control server has not acknowledged it. This tests the Linux request path after Android bootstrap; it is not a cloud login or a permanent service.
