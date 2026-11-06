# TikTok farm

The admin server queues one run per selected TikTok account and shows run status and stored codes. An authenticated Mac worker picks up jobs for the accounts it hosts. TikTok credentials and Android sessions stay on the Mac. The operator provides the campaign and chooses the worker slots from the dashboard.

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

Open `/admin/tiktok-farm`. Choose the online accounts, a campaign ID and an eligible LIVE room ID. Leave the reward at `auto` if exactly one eligible countdown is available, or specify its task ID. The worker selects countdown rewards that require no game account link. A live session challenge may require operator action in Android. The pending result file in the private state directory is kept until the server acknowledges the code; back up that directory if a claim is awaiting upload. The dashboard shows a job in review if its worker disappears during the run. Check TikTok's reward history before manually resolving it.
