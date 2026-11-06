#!/data/data/com.termux/files/usr/bin/sh
# Termux:Boot runs after the phone is unlocked following a reboot.
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH=$PREFIX/bin:/system/bin

exec am startservice --user "${TERMUX__USER_ID:-0}" \
  -n com.termux/com.termux.app.TermuxService \
  -a com.termux.service_execute \
  -d "com.termux.file://$HOME/epic-claim/watch-workers.sh" \
  --ez com.termux.execute.background true \
  --es com.termux.execute.command_label 'Epic Claims workers'
