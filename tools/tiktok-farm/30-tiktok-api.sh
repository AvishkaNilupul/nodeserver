#!/data/data/com.termux/files/usr/bin/sh
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH=$PREFIX/bin:/system/bin
[ -e "$HOME/tiktok-api-worker/disabled" ] && exit 0
exec am startservice --user "${TERMUX__USER_ID:-0}" \
  -n com.termux/com.termux.app.TermuxService \
  -a com.termux.service_execute \
  -d "com.termux.file://$HOME/tiktok-api-worker/watch-api-worker.sh" \
  --ez com.termux.execute.background true \
  --es com.termux.execute.command_label 'TikTok API worker'
