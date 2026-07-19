# Managing bots on remote hosts (e.g. a Raspberry Pi)

The Bots page (`/bots.html`) can manage TwitchDropsBot instances that run on a
**different machine** from this server — for example a Raspberry Pi at home —
in addition to the bots running locally on the server itself.

Each remote host shows up as its own **tab** at the top of the Bots page. The
local server is always the first tab ("Server"); remote hosts you configure
appear next to it. Switching tabs lists, edits, restarts, creates and deletes
bots **on that host**, using the exact same UI as the local bots.

Everything on a remote host happens over **SSH**: the server runs file commands
(`cat`, `ls`, atomic write) and `docker` / `docker compose` commands on the
remote host. So the only requirements are:

1. The server can reach the host over the network at a **stable address**.
2. The server can SSH into the host **non-interactively** (key-based, no
   password prompt).
3. The host runs its bots in **Docker** (`config_NN.json` + a compose file),
   the same layout the server uses.

If a remote host is powered off or unreachable, its tab simply shows an
"offline / unreachable" message — it never breaks the page or the local bots.

---

## 1. Stable connectivity with Tailscale (recommended)

A home Raspberry Pi usually sits behind NAT and may get a new public IP after a
reboot. **Tailscale** gives the Pi a permanent private address + DNS name that
survives reboots and IP changes, so the server can always reach it. It's free
and reconnects automatically on boot.

### On the Pi

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# follow the printed login URL; log in with the account you'll also use on the server
```

Find the Pi's Tailscale name/IP:

```bash
tailscale status        # shows 100.x.y.z and the MagicDNS name
tailscale ip -4
```

In the Tailscale admin console, **disable key expiry** for the Pi so it never
needs re-authentication.

### On the redeemhub server

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up        # log in with the SAME account
```

Now the server can reach the Pi at its MagicDNS name (e.g.
`raspberrypi.your-tailnet.ts.net`) or its `100.x.y.z` IP, regardless of the
home network's public IP.

> You can use any other stable connectivity instead of Tailscale (a static IP +
> port-forward, a different VPN, etc.). All this feature needs is an address the
> server can SSH to.

---

## 2. SSH key from the server to the Pi

On the **server**, create a dedicated key (no passphrase, so the app can use it
non-interactively):

```bash
ssh-keygen -t ed25519 -f /root/.ssh/id_bothost -N "" -C "redeemhub-bothost"
cat /root/.ssh/id_bothost.pub
```

Add that public key to the **Pi's** `~/.ssh/authorized_keys`:

```bash
# on the Pi (paste the printed public key):
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "ssh-ed25519 AAAA...redeemhub-bothost" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

Verify a non-interactive login works **from the server** (this exact command is
what the app runs):

```bash
ssh -i /root/.ssh/id_bothost -o BatchMode=yes avishka@raspberrypi.your-tailnet.ts.net 'echo ok && docker ps'
```

It must print `ok` without prompting for a password. The first connection will
accept the host key automatically (`StrictHostKeyChecking=accept-new`).

---

## 3. Run the Pi's bots in Docker (match the server layout)

The remote-host feature manages bots the same way the server does: a directory
containing `config.json`, `config_02.json`, … and a `docker-compose.yml` whose
services are named `twitchbot`, `twitchbotx2`, … (one per config file).

On the Pi:

```bash
# 1. stop the old systemd service if you set one up earlier
sudo systemctl disable --now twitchdrops 2>/dev/null || true

# 2. install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER      # then log out/in so `docker` works without sudo

# 3. build the bot image from source (see "Building the bot image" below —
#    do NOT `docker pull ghcr.io/alorf/twitchdropsbot`, it reads its config
#    from a different path than this app expects and will silently start
#    every bot with a blank config)

# 4. create the bot directory and move your existing config in
mkdir -p ~/twitchbot/logs
cp ~/TwitchDropsBot-Console-linux-arm64-1.2.4/config.json ~/twitchbot/config.json

# 5. create the compose file
cat > ~/twitchbot/docker-compose.yml <<'EOF'
services:
  twitchbot:
    image: avishkarex/twitchbot:latest
    container_name: twitchbot
    restart: always
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    volumes:
      - ./config.json:/app/config.json
      - ./logs:/app/logs
EOF

# 6. start it
cd ~/twitchbot && docker compose up -d
docker ps
```

> The directory (`~/twitchbot` → `/home/avishka/twitchbot`) and the compose
> service naming must match what you put in the host config below. The
> `logging:` block matters — see "Why the log cap" below.

### Building the bot image

The Bots page manages TwitchDropsBot instances by mounting a single
`config.json` file into the container at `/app/config.json`. The official
image (`ghcr.io/alorf/twitchdropsbot`) defaults to reading its config from
`/app/Configuration/config.json` instead (an `INSIDE_DOCKER=true` env var
baked into its Dockerfile) — mount a file at the old path against that image
and it finds nothing there, auto-creates an empty `{}` config, and every bot
silently starts with zero accounts. Build your own image with that one env
var flipped, and everything else about the official release is untouched:

```bash
git clone --branch <release-tag> https://github.com/Alorf/TwitchDropsBot.git
cd TwitchDropsBot
sed -i 's/ENV INSIDE_DOCKER=true/ENV INSIDE_DOCKER=false/' TwitchDropsBot.Console/Dockerfile
docker build -f TwitchDropsBot.Console/Dockerfile -t avishkarex/twitchbot:latest .
```

Run this on each host natively (the main server is amd64, a Raspberry Pi is
usually arm64 — cross-building is possible via `docker buildx` but a native
build is simpler and just as fast). Before rolling a new build out to a bot
that's actively farming, sanity-check it in isolation first:

```bash
docker run -d --name twitchbot-testrun \
  -v /root/twitchbot/config_02.json:/app/config.json \
  avishkarex/twitchbot:latest
docker logs -f twitchbot-testrun   # should show accounts loading, not "No users found"
docker rm -f twitchbot-testrun
```

Then recreate bots one at a time (`docker compose up -d --no-deps <service>`
per bot) rather than all at once, checking each one's logs before moving to
the next.

### Why the log cap

TwitchDropsBot has a real bug: with **zero accounts** configured, it retries
an interactive login prompt in a tight loop with no backoff — tens of
thousands of log lines per second. This has filled a host's disk and pegged
a CPU core in production before the `logging:` block above existed (Docker's
own container log driver has no size limit by default). The app itself now
also refuses to start/restart a bot with zero accounts and auto-stops one
that ends up empty (see `utils/botHosts.js`'s `stopIfNoAccounts`), but the
`logging:` cap is defense-in-depth for containers created outside the app
(like the manual setup above) — set it on **every** host, including a fresh
one. As a second layer, also cap it at the Docker daemon level so it applies
to every container on the host, not just ones this app creates:

```bash
sudo tee /etc/docker/daemon.json > /dev/null <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
sudo systemctl restart docker
```

> A `docker`/`dockerd` restart does **not** stop running containers, but any
> container whose `restart` policy is `always` **will** come back up on a
> daemon restart even if it was manually `docker stop`-ed beforehand — if you
> have a bot deliberately stopped (e.g. because it has no accounts), also run
> `docker update --restart=no <container>` so a daemon restart can't silently
> resurrect it.

---

## 4. Tell redeemhub about the host

Copy the example file and edit it (this file is **gitignored** — it holds your
SSH targets):

```bash
cp config/botHosts.example.json config/botHosts.json
```

`config/botHosts.json`:

```json
{
  "hosts": [
    {
      "id": "pi",
      "label": "Raspberry Pi",
      "dir": "/home/avishka/twitchbot",
      "ssh": {
        "target": "avishka@raspberrypi.your-tailnet.ts.net",
        "identityFile": "/root/.ssh/id_bothost",
        "port": 22,
        "options": []
      }
    }
  ]
}
```

Field reference:

| field             | meaning                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `id`              | short id used in the URL/UI (letters/digits/`-`/`_`; not `local`)    |
| `label`           | the tab name shown on the Bots page                                  |
| `dir`             | the bot directory **on the remote host**                            |
| `ssh.target`      | `user@host` the server SSHes to (use the Tailscale name)             |
| `ssh.identityFile`| path to the private key **on the server**                            |
| `ssh.port`        | SSH port (optional, default 22)                                      |
| `ssh.options`     | extra `ssh` flags, e.g. `["-o","ServerAliveInterval=15"]` (optional) |

You can configure **multiple** remote hosts — each becomes its own tab.

Alternatively, set the same JSON inline via the `BOT_HOSTS` environment variable
(it takes precedence over the file), which is handy in containerised
deployments.

Restart redeemhub so it loads the host config:

```bash
# however you run it, e.g.
pm2 restart redeemhub      # or: systemctl restart redeemhub, docker compose restart, …
```

---

## 5. Verify

Open `/bots.html` as a superadmin. You should now see a **"Raspberry Pi"** tab
next to "Server".

- Click the Pi tab → it lists the Pi's bots and docker statuses.
- Edit a config and **Save** → it writes to the Pi over SSH (a `.bak` is kept).
- **Restart / Start / Stop** → runs `docker` on the Pi.
- **+ Add bot** → creates `config_NN.json`, adds a compose service, and starts
  the container on the Pi.
- Power the Pi off → the tab shows an "unreachable" message instead of erroring;
  the Server tab keeps working normally.

### Drop tracking for Pi accounts

The drops archive sync (`POST /drops-archive/sync`, the "Sync" button) now reads
every configured host, so accounts running on the Pi are imported and tracked
just like server accounts. They're tagged with their host id internally, so the
Bots page health/drop counts are scoped per tab. Drop scanning itself is
machine-independent (it calls Twitch with each account's token), so it works no
matter where the bot physically runs.

### Sharing the account-pool auto-scan across hosts

The account pool's background auto-check (`utils/accountPoolChecker.js`, which
verifies each imported account's token against Twitch) no longer runs entirely
on the server. It runs **one worker on the server plus one worker per configured
remote host**, all draining a single shared queue. Each remote worker makes the
very same Twitch calls **from that host** over SSH + `curl` (see the host
transport in `utils/twitchInventory.js`), so the scan traffic is spread across
the server's IP and each host's IP instead of hammering everything from one
address — and the pool clears roughly N× faster with N machines helping. Each
worker keeps its own pacing (`ACCOUNT_POOL_CHECK_DELAY_MS`, default 1200 ms), so
the per-IP request rate is unchanged; only the aggregate throughput rises.

This is built to treat a host disappearing as normal, not an error — a Pi can be
unplugged mid-sweep:

- Each host is probed before it's given any account, and skipped for that pass
  if it's offline.
- A "couldn't reach Twitch through this host" failure **never** writes a status
  onto the account. The account is put back on the queue and the server worker
  finishes it; the host's worker retires for the rest of the run rather than
  re-failing every remaining account against a dead host.
- The server worker alone always drains the whole queue, so losing every remote
  host only makes a sweep slower — never wrong, never stuck.

By default **every** remote host in `config/botHosts.json` helps scan. To
restrict or disable it, set `ACCOUNT_POOL_SCAN_HOSTS`:

- a comma-separated list of host ids to use only those, e.g.
  `ACCOUNT_POOL_SCAN_HOSTS=pi` (server + the Pi only);
- `none` (or `off` / `local`) to keep all scanning on the server.

The check-queue status endpoint (`GET /account-pool/check-queue/status`) reports
a `scanHosts` array of the host ids currently helping, so you can see the split
in action.

---

## 6. Android phone as a bot host (native runtime, no Docker)

An Android phone can also farm drops. Android can't run Docker, so a phone is
configured as a **`"runtime": "native"`** host: bots run as plain processes
managed by a small `botctl` script that speaks the same vocabulary as docker
(ps / start / stop / restart / rm / logs / stats), so the Bots page tab works
exactly the same — list, edit, restart, logs, stats, add bot, move bot.

The bot binary is a glibc linux-arm64 build, which runs inside a
[Termux](https://termux.dev) + proot-distro Ubuntu rootfs (no root needed).

### On the phone (once)

1. Install **Termux** and **Termux:Boot** from F-Droid (not the Play Store —
   that build is outdated). Open Termux:Boot once so Android registers it.
2. Android Settings → Apps → Termux → **Battery → Unrestricted** (otherwise
   Android kills the bots when the screen is off).
3. (Recommended) install **Tailscale** from the Play Store and log in with the
   same account as the server, so the phone has a stable address — same
   reasoning as the Pi in section 1.
4. In Termux, run the one-shot setup script with the server's public key
   (`cat /root/.ssh/id_bothost.pub` on the server):

```bash
curl -fsSL https://raw.githubusercontent.com/AvishkaNilupul/nodeserver/main/scripts/android-bot-setup.sh -o setup.sh
sh setup.sh 'ssh-ed25519 AAAA...redeemhub-bothost'
```

It installs sshd (port **8022**), the Ubuntu rootfs, the latest TwitchDropsBot
Console linux-arm64 release, `botctl`, a starter `config.json`, and a boot
script that re-acquires the wake lock and restarts sshd + all bots after a
phone reboot. It prints the exact host entry to add on the server.

### On the server

Verify SSH works (Termux ignores the username; the port is 8022):

```bash
ssh -i /root/.ssh/id_bothost -p 8022 u0@<phone-tailscale-name> \
  'sh /data/data/com.termux/files/home/twitchbot/botctl ps'
```

Then add the host to `config/botHosts.json` with `"runtime": "native"` (see
`config/botHosts.example.json` for the full shape) and restart redeemhub. The
phone appears as its own tab on the Bots page.

### Phone-specific notes

- Keep the phone **plugged in** and preferably on Wi-Fi. A phone idles at a
  few watts — it's a fine 24/7 farmer with a built-in UPS (its battery).
- "Restart policy" maps to a flag file: a bot stopped for having zero accounts
  stays down across reboots until accounts are added again, same as Docker's
  `--restart=no`.
- Logs live in `~/twitchbot/logs/<bot>.log`, auto-rotated at 10 MB (same
  runaway-logging protection as the Docker log cap).
- If the phone is unreachable (dead battery, left the network), its tab shows
  the same offline message as a powered-off Pi, and "move to server" works
  from the last-known snapshot.

---

## Notes & safety

- The implicit `local` host is unchanged and always present; existing setups
  with no `config/botHosts.json` behave exactly as before.
- Only filenames matching `config(_NN)?.json` are ever read/written on any host
  (path-traversal guard).
- Writes are atomic (temp file + rename) and keep a `.bak`; deletes archive the
  config as `*.deleted-<timestamp>` rather than destroying it.
- The SSH calls use `BatchMode=yes` + `ConnectTimeout`, so an offline host fails
  fast and cleanly rather than hanging.
- Set `TWITCHBOT_ALLOW_RESTART=0` to disable all container start/stop/restart
  actions (config viewing/editing still works).
- The app won't start or restart a bot with zero accounts, and auto-stops one
  that ends up empty (a raw config save, a bad-tokens purge, or a duplicates
  purge can all zero out a file) — see "Why the log cap" above for why.
