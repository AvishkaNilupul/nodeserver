#!/bin/sh
# Hourly complaint sweep. Read-only; see scripts/complaint-sweep.js.
cd /var/www/redeemer/nodeserver || exit 1
/usr/bin/node scripts/complaint-sweep.js --quiet >> support-sweeps/sweep.log 2>&1
# Keep a fortnight of per-run reports; latest.json and corpus.jsonl are kept forever.
find support-sweeps -name "sweep-*.json" -mtime +14 -delete 2>/dev/null
