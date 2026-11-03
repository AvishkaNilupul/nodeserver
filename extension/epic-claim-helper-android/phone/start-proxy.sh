#!/data/data/com.termux/files/usr/bin/sh
cd "$(dirname "$0")" || exit 1
if [ -f proxy.pid ] && kill -0 "$(cat proxy.pid)" 2>/dev/null; then exit 0; fi
chmod 600 residential-proxy.json
node --check residential-proxy.cjs || exit 1
nohup node residential-proxy.cjs >>proxy.log 2>&1 </dev/null &
echo $! >proxy.pid
sleep 1
kill -0 "$(cat proxy.pid)" 2>/dev/null || exit 1
