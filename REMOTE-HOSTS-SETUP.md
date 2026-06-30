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

# 3. create the bot directory and move your existing config in
mkdir -p ~/twitchbot/logs
cp ~/TwitchDropsBot-Console-linux-arm64-1.2.4/config.json ~/twitchbot/config.json

# 4. create the compose file (multi-arch image runs on the Pi's arm64)
cat > ~/twitchbot/docker-compose.yml <<'EOF'
services:
  twitchbot:
    image: ghcr.io/alorf/twitchdropsbot:latest
    container_name: twitchbot
    restart: always
    volumes:
      - ./config.json:/app/config.json
      - ./logs:/app/logs
EOF

# 5. start it
cd ~/twitchbot && docker compose up -d
docker ps
```

> The directory (`~/twitchbot` → `/home/avishka/twitchbot`) and the compose
> service naming must match what you put in the host config below. If your image
> expects the config at a different path inside the container, adjust the volume
> mapping — the host side (`./config.json`) is what matters to this feature.

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
