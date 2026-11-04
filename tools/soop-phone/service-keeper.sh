#!/data/data/com.termux/files/usr/bin/sh
# A Termux-managed task keeps the foreground service alive during lock refresh.
# Detached nohup workers do not count as sessions/tasks in TermuxService.
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH=$PREFIX/bin:/system/bin
D=$HOME/soop-egress
exec 8>"$D/service-keeper.lock"
flock -n 8 || exit 0
echo $$ > "$D/service-keeper.pid"
printf '%s managed service keeper started\n' "$(date -u +%FT%TZ)" >> "$D/service-keeper.log"
trap 'exit 0' TERM INT
while :; do
  date -u +%FT%TZ > "$D/service-keeper.at"
  sleep 30 8>&-
done
