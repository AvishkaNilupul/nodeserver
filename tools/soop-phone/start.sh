#!/data/data/com.termux/files/usr/bin/sh
# Starts everything the SOOP egress needs. Safe to run again: running parts are skipped.
DIR=$HOME/soop-egress
# Register an actual Termux task before starting detached workers. Releasing
# the wake lock with zero sessions/tasks otherwise stops TermuxService.
am startservice --user "${TERMUX__USER_ID:-0}" \
  -n com.termux/com.termux.app.TermuxService \
  -a com.termux.service_execute \
  -d "com.termux.file://$DIR/service-keeper.sh" \
  --ez com.termux.execute.background true \
  --es com.termux.execute.command_label 'SOOP service keeper' >/dev/null || exit 1
termux-wake-lock
pgrep -x sshd >/dev/null || sshd
. "$DIR/ports.env"
BUSY_WAIT=120 nohup sh "$DIR/tunnel.sh" socks "$SOCKS_PORT" "127.0.0.1:$SOCKS_PORT" >/dev/null 2>&1 &
nohup sh "$DIR/tunnel.sh" mgmt 18022 "127.0.0.1:18022:127.0.0.1:8022" >/dev/null 2>&1 &

# Local lock refresh (flock prevents duplicate workers).
nohup sh "$DIR/wakelock-loop.sh" >/dev/null 2>&1 &

nohup sh "$DIR/supervisor.sh" >/dev/null 2>&1 &
