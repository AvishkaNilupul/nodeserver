#!/bin/bash
# Watches the OPPO phone's SOOP tunnel from prod (run by soop-phone-watch.service).
# Once a minute: one line in phone-watch.log (socks up/DOWN, exit country, ip, maintenance link).
# Telegram — through the app's own utils/telegram.js, so the same chats as every farm alert:
#   * the tunnel has been down DOWN_AFTER checks in a row (default 5 = 5 min)
#   * a reminder every REMIND_S while it stays down (default 6 h)
#   * it is back up (with how long it was down)
#   * it is up but no longer exits in Japan (SOOP credits JP)
# Every 5 min: one phone health line in phone-stats.log (via the maintenance link):
#   tunnel loop ages (a reset = Termux killed or phone restarted), reconnects, free memory.
# State survives a restart of this script (phone-watch.state), so a restart neither
# repeats an alert nor forgets an outage.
PORT=${1:-1085}
APP=/var/www/redeemer/nodeserver
DIR=/root/soop-egress
LOG=${LOG:-$DIR/phone-watch.log}
STATE=${STATE:-$DIR/phone-watch.state}
INTERVAL=${INTERVAL:-60}
DOWN_AFTER=${DOWN_AFTER:-5}
REMIND_S=${REMIND_S:-21600}
TAG=${TAG:-}            # "[TEST] " when testing

jst() { TZ=Asia/Tokyo date -d "@$1" '+%m-%d %H:%M JST'; }
mins() { echo $(( ($1 + 59) / 60 )); }

send() {
  local r
  r=$(cd "$APP" && timeout 60 node -e '
    require("dotenv").config({ quiet: true });
    require("./utils/telegram").sendTelegram(process.argv[1])
      .then((r) => { console.log(JSON.stringify(r || {})); process.exit(0); })
      .catch((e) => { console.log("ERR " + e.message); process.exit(0); });
  ' "$TAG$1" 2>&1 | tail -1)
  echo "$(date -u +%FT%TZ) telegram: ${1%%$'\n'*} -> $r" >> "$LOG"
}

# down_since (epoch, 0 = up), fails (consecutive), alerted_at (epoch of last down alert, 0 = none), last_loc
down_since=0; fails=0; alerted_at=0; last_loc=JP
[ -f "$STATE" ] && . "$STATE"
# The app (whatever pid holds :3000) and its open connections through each egress.
conns() { local pid n; pid=$(ss -ltnpH "sport = :3000" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
  [ -z "$pid" ] && { echo "-"; return; }
  n=$(ss -tnpH state established "( dport = :$1 )" | grep -c "pid=$pid,"); echo "$n"; }
# Which phone relay holds the port: "relay" (shell-user relay, the main one since 11-02),
# "termux" (Termux's standby tunnel) or "none". From the key that opened the session.
hpid=""; hlabel=none
holder() { local pid ppid fp
  pid=$(ss -ltnpH "sport = :$PORT" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
  if [ -z "$pid" ]; then hpid=""; hlabel=none; return; fi
  [ "$pid" = "$hpid" ] && return
  ppid=$(ps -o ppid= -p "$pid" | tr -d ' ')
  fp=$(journalctl _PID="$ppid" --no-pager -o cat 2>/dev/null | grep -oE 'SHA256:[A-Za-z0-9+/]{10}' | head -1)
  case "$fp" in "SHA256:+L8ypFfFl+") hlabel=relay ;; "SHA256:/uULb4tYlW") hlabel=termux ;; *) hlabel="?" ;; esac
  hpid=$pid; }
i=0
save() { printf 'down_since=%s\nfails=%s\nalerted_at=%s\nlast_loc=%s\n' "$down_since" "$fails" "$alerted_at" "$last_loc" > "$STATE"; }

while :; do
  now=$(date +%s)
  t=$(curl -s --max-time 10 --socks5-hostname "127.0.0.1:$PORT" https://www.cloudflare.com/cdn-cgi/trace)
  loc=$(sed -n 's/^loc=//p' <<< "$t"); ip=$(sed -n 's/^ip=//p' <<< "$t")
  mgmt=$(timeout 6 bash -c "exec 3<>/dev/tcp/127.0.0.1/18022; head -c 7 <&3" 2>/dev/null | grep -q SSH-2.0 && echo up || echo down)
  holder
  echo "$(date -u +%FT%TZ) socks=$([ -n "$loc" ] && echo up || echo DOWN) loc=${loc:--} ip=${ip:--} mgmt=$mgmt app_phone=$(conns "$PORT") app_mac=$(conns 1080) via=$hlabel" >> "$LOG"
  i=$((i + 1))
  if [ $((i % 5)) -eq 1 ]; then
    st=$(timeout 20 ssh -i /root/.ssh/id_bothost -p 18022 -o BatchMode=yes -o ConnectTimeout=8 \
      -o UserKnownHostsFile=/root/.ssh/known_hosts u0@127.0.0.1 sh soop-egress/stats.sh 2>/dev/null | tail -1)
    echo "$(date -u +%FT%TZ) ${st:-phone unreachable}" >> "$DIR/phone-stats.log"
  fi

  if [ -n "$loc" ]; then
    if [ "$alerted_at" != 0 ]; then
      send "✅ SOOP phone tunnel is back up after $(mins $((now - down_since))) min (down since $(jst "$down_since")). The logins on the phone resume on their own."
    fi
    down_since=0; fails=0; alerted_at=0
    if [ "$loc" != JP ] && [ "$last_loc" != "$loc" ]; then
      send "⚠️ SOOP phone tunnel now exits in $loc (ip $ip), not Japan — SOOP may stop crediting the logins on the phone. Is the phone still on the home Wi-Fi?"
    elif [ "$loc" = JP ] && [ "$last_loc" != JP ]; then
      send "✅ SOOP phone tunnel exits in Japan again (ip $ip)."
    fi
    last_loc=$loc
  else
    [ "$down_since" = 0 ] && down_since=$now
    fails=$((fails + 1))
    if [ "$alerted_at" = 0 ] && [ "$fails" -ge "$DOWN_AFTER" ]; then
      send "⚠️ SOOP phone tunnel DOWN for $(mins $((now - down_since))) min (since $(jst "$down_since")). All SOOP logins use the phone and are paused until its tunnel returns. If the phone restarted, unlock it with the PIN. Maintenance link: $mgmt."
      alerted_at=$now
    elif [ "$alerted_at" != 0 ] && [ $((now - alerted_at)) -ge "$REMIND_S" ]; then
      send "⚠️ SOOP phone tunnel still DOWN — $(( (now - down_since) / 3600 )) h now (since $(jst "$down_since")). Maintenance link: $mgmt."
      alerted_at=$now
    fi
  fi
  save
  sleep "$INTERVAL"
done
