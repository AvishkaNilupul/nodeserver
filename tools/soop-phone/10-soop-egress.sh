#!/data/data/com.termux/files/usr/bin/sh
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH=$PREFIX/bin:/system/bin
exec >> "$HOME/soop-egress/boot.log" 2>&1
printf '%s boot hook entered\n' "$(date -u +%FT%TZ)"
sh "$HOME/soop-egress/start.sh" || exit 1
printf '%s managed keeper and workers launched\n' "$(date -u +%FT%TZ)"
