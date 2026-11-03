#!/data/data/com.termux/files/usr/bin/sh
cd "$(dirname "$0")" || exit 1
if [ -f proxy.pid ]; then kill "$(cat proxy.pid)" 2>/dev/null; rm -f proxy.pid; fi
