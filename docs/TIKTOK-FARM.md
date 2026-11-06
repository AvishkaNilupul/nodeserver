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

Open `/admin/tiktok-farm` and select the accounts to run. **Scan & auto farm** checks each idle account's eligibility and queues one event per account, shortest remaining countdown first. It skips stored rewards and jobs awaiting review. **Scan live events** lists eligible rewards without starting a run; use **Farm event** to pick a card. Event results expire after five minutes. The scanner uses the last completed room or `TIKTOK_CATALOG_SEED_ROOM` to prompt Android for an authenticated LIVE request. The seed is only for discovery; each event uses a room returned by TikTok's current campaign feed.

Manual start is still available if you have a campaign and room ID. Leave the task at `auto` if exactly one eligible countdown is available, or specify its task ID. Both paths select countdown rewards that require no game account link. A live session challenge may require operator action in Android. The pending result file in the private state directory is kept until the server acknowledges the code. The dashboard shows a job in review if its worker disappears during the run. Check TikTok's reward history before manually resolving it.

## Linux canary

`cloud-worker.py` tests one prequeued job from a private Linux checkout with the trace module staged as `trace.py` and the worker's Python dependencies installed. Pause the Mac poller for that account first. Capture a fresh Android room entry, then stop the app. Send the leased job's target identifiers, worker key, and captures to Linux over SSH stdin. The worker reads eligibility, acquires the queued job, and uses the same lease and encrypted inventory as the Mac workers. The handoff stays in memory. The only file the canary may write is a private pending code result; preserve it if the control server has not acknowledged it. This tests the Linux request path after Android bootstrap; it is not a cloud login or a permanent service.
