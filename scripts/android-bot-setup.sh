#!/data/data/com.termux/files/usr/bin/sh
# One-shot setup that turns an Android phone into a TwitchDropsBot host the
# Bots page can manage (as a "native" runtime host — see
# REMOTE-HOSTS-SETUP.md, "Android phone" section).
#
# Run this INSIDE TERMUX on the phone:
#
#   curl -fsSL https://raw.githubusercontent.com/AvishkaNilupul/nodeserver/main/scripts/android-bot-setup.sh -o setup.sh
#   sh setup.sh 'ssh-ed25519 AAAA... redeemhub-bothost'
#
# The single argument is the SERVER's public key (from
# `cat /root/.ssh/id_bothost.pub` on the server) so it can SSH in.
#
# What it does:
#   1. installs openssh + proot-distro + a Ubuntu rootfs (the bot is a glibc
#      linux-arm64 build, which can't run on Android's libc directly)
#   2. downloads the latest TwitchDropsBot Console linux-arm64 release into
#      ~/twitchbot/app and installs botctl next to it
#   3. writes a starter config.json (no accounts) so the Bots page has a
#      template to clone from
#   4. starts sshd (port 8022) and installs a Termux:Boot script so sshd,
#      the wake lock and the bots all come back after a reboot
#
# After it finishes it prints exactly what to add to the server's
# config/botHosts.json.

set -eu

PUBKEY="${1:-}"
BOTDIR="$HOME/twitchbot"
# The fork, not upstream Alorf: upstream publishes no linux-arm64 asset (x64
# only), and this pulls the `combined` branch build so the phone runs the same
# patched bot the rest of the fleet does. See project_twitchdropsbot_fork.
REPO="AvishkaNilupul/TwitchDropsBot"

if [ -z "$PUBKEY" ]; then
  echo "usage: sh android-bot-setup.sh '<server public key>'" >&2
  echo "  (get it on the server with: cat /root/.ssh/id_bothost.pub)" >&2
  exit 1
fi

echo "==> Installing packages (openssh, proot-distro, curl, unzip, tar)..."
pkg update -y >/dev/null 2>&1 || true
# `pkg upgrade` first: a partial package set leaves curl unable to load
# (libngtcp2/openssl symbol mismatch — "cannot locate symbol
# SSL_set_quic_tls_transport_params"), which breaks every curl download below.
# Left visible (not silenced) so it can't hang hidden on a prompt.
pkg upgrade -y || true
pkg install -y openssh proot-distro curl unzip tar termux-services >/dev/null

echo "==> Setting up SSH access for the server..."
mkdir -p "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
grep -qF "$PUBKEY" "$HOME/.ssh/authorized_keys" || echo "$PUBKEY" >> "$HOME/.ssh/authorized_keys"
chmod 700 "$HOME/.ssh"
chmod 600 "$HOME/.ssh/authorized_keys"
sshd 2>/dev/null || true

echo "==> Installing the Ubuntu rootfs (runs the glibc bot binary)..."
proot-distro install ubuntu >/dev/null 2>&1 || echo "    (already installed)"

# The bundled arm64 libmsquic.so needs libcrypto.so.3 (libssl3) and
# libnuma.so.1 (libnuma1); the latter isn't in a base Ubuntu rootfs, and
# without it .NET fails to load QUIC. Install them inside the rootfs so the
# bot's networking comes up. libssl3 is usually already present.
echo "==> Installing bot runtime deps inside the Ubuntu rootfs..."
proot-distro login ubuntu -- sh -c \
  'apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq libssl3 libnuma1 >/dev/null 2>&1' \
  || echo "    (could not install rootfs deps automatically — QUIC may be unavailable)"

echo "==> Downloading the latest TwitchDropsBot Console linux-arm64 build..."
mkdir -p "$BOTDIR/logs" "$BOTDIR/run"
ASSET_URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -o '"browser_download_url": *"[^"]*"' \
  | grep -i 'console' | grep -i 'linux-arm64' \
  | head -1 | sed 's/.*"\(https[^"]*\)".*/\1/')
if [ -z "$ASSET_URL" ]; then
  echo "!! Could not find a Console linux-arm64 asset on the latest release of $REPO." >&2
  echo "   Download it manually and unzip it into $BOTDIR/app (the folder must" >&2
  echo "   contain the TwitchDropsBot.Console executable), then re-run this script." >&2
else
  echo "    $ASSET_URL"
  # Linux release assets are .tar.gz (the arm64 Console build included); older
  # notes assumed .zip, so pick the extractor by extension instead of guessing.
  case "$ASSET_URL" in
    *.tar.gz|*.tgz) ARCHIVE="$BOTDIR/bot.tar.gz" ;;
    *) ARCHIVE="$BOTDIR/bot.zip" ;;
  esac
  curl -fsSL "$ASSET_URL" -o "$ARCHIVE"
  rm -rf "$BOTDIR/app"
  mkdir -p "$BOTDIR/app"
  case "$ARCHIVE" in
    *.tar.gz|*.tgz) tar xzf "$ARCHIVE" -C "$BOTDIR/app" ;;
    *) unzip -oq "$ARCHIVE" -d "$BOTDIR/app" ;;
  esac
  rm -f "$ARCHIVE"
  # The archive wraps everything in a top-level folder — flatten it so the
  # executable ends up at $BOTDIR/app/TwitchDropsBot.Console.
  if [ ! -f "$BOTDIR/app/TwitchDropsBot.Console" ]; then
    inner=$(find "$BOTDIR/app" -name "TwitchDropsBot.Console" -type f | head -1)
    if [ -n "$inner" ]; then
      innerdir=$(dirname "$inner")
      mv "$innerdir"/* "$BOTDIR/app/" 2>/dev/null || true
    fi
  fi
  chmod +x "$BOTDIR/app/TwitchDropsBot.Console" 2>/dev/null || true
fi

echo "==> Installing botctl..."
curl -fsSL "https://raw.githubusercontent.com/AvishkaNilupul/nodeserver/main/scripts/botctl" -o "$BOTDIR/botctl"
chmod +x "$BOTDIR/botctl"

if [ ! -f "$BOTDIR/config.json" ]; then
  echo "==> Writing starter config.json (no accounts yet)..."
  cat > "$BOTDIR/config.json" <<'EOF'
{
  "TwitchSettings": {
    "TwitchUsers": [],
    "AvoidCampaign": [],
    "OnlyFavouriteGames": true,
    "MinimizeInTray": true,
    "ForceTryWithTags": false,
    "OnlyConnectedAccounts": false,
    "WatchManager": "WatchRequest"
  },
  "KickSettings": {
    "KickUsers": [],
    "WatchManager": "WatchRequest"
  },
  "FavouriteGames": [],
  "LaunchOnStartup": false,
  "LogLevel": 0,
  "WebhookURL": "",
  "WaitingSeconds": 300,
  "AttemptToWatch": 5,
  "WatchBrowserHeadless": true,
  "MinimizeInTray": false
}
EOF
fi

echo "==> Installing the boot script (needs the Termux:Boot app)..."
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/start-bots.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
sshd
sh "$BOTDIR/botctl" autostart
EOF
chmod +x "$HOME/.termux/boot/start-bots.sh"

# Keep the phone awake right now too.
termux-wake-lock 2>/dev/null || true

IP=$(ip -4 addr show wlan0 2>/dev/null | grep -o 'inet [0-9.]*' | cut -d' ' -f2 | head -1)
TSIP=$(tailscale ip -4 2>/dev/null | head -1 || true)

echo ""
echo "================ DONE ================"
echo "SSH:        port 8022, user irrelevant (Termux single-user)"
echo "Wi-Fi IP:   ${IP:-unknown}"
[ -n "${TSIP:-}" ] && echo "Tailscale:  $TSIP"
echo "Bot dir:    $BOTDIR"
echo ""
echo "Now do these on the phone (once):"
echo "  1. Install the Termux:Boot app (F-Droid) and open it once"
echo "  2. Android Settings -> Apps -> Termux -> Battery -> Unrestricted"
echo "  3. (Recommended) install Tailscale from Play Store and log in, so the"
echo "     server can always reach the phone"
echo ""
echo "Then add this to config/botHosts.json on the server and restart it:"
echo '  {'
echo '    "id": "phone",'
echo '    "label": "Android Phone",'
echo '    "runtime": "native",'
echo "    \"dir\": \"$BOTDIR\","
echo '    "ssh": {'
echo "      \"target\": \"anyuser@<PHONE-IP-OR-TAILSCALE-NAME>\","
echo '      "identityFile": "/root/.ssh/id_bothost",'
echo '      "port": 8022'
echo '    }'
echo '  }'
echo ""
echo "Test from the server:"
echo "  ssh -i /root/.ssh/id_bothost -p 8022 anyuser@<PHONE-IP> 'sh $BOTDIR/botctl ps'"
