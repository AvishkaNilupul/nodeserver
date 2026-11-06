#!/data/data/com.termux/files/usr/bin/sh
# Keep the loop registered as a Termux task so it survives wake-lock refresh.
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH=$PREFIX/bin:/system/bin
cd "$HOME/epic-claim" || exit 1

exec 8>watch-workers.lock
flock -n 8 || exit 0

worker_running() {
  [ -s "$1.pid" ] && kill -0 "$(cat "$1.pid")" 2>/dev/null
}

while :; do
  if ! worker_running bridge || ! worker_running proxy; then
    printf '%s Starting missing Epic workers\n' "$(date -u +%FT%TZ)" >>watch-workers.log
    ./start.sh >>watch-workers.log 2>&1 8>&-
  fi
  sleep 30 8>&-
done
