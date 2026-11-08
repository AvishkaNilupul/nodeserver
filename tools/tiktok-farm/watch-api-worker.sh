#!/data/data/com.termux/files/usr/bin/sh
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH=$PREFIX/bin:/system/bin
umask 077
D=$HOME/tiktok-api-worker
exec 9>"$D/supervisor.lock"
flock -n 9 || exit 0
echo $$ > "$D/supervisor.pid"
while [ ! -e "$D/disabled" ]; do
  date -u +%FT%TZ > "$D/supervisor-heartbeat"
  python -u "$D/api_worker.py" --fleet "$D/accounts" 9>&-
  [ -e "$D/disabled" ] && break
  sleep 5 9>&-
done
