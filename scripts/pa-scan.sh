#!/bin/sh
# Dry-run planner for PlayerAuctions bundle listings over the WHOLE archive.
# Publishes nothing. Exists because pm2 does not reliably forward "-- --all".
cd /var/www/redeemer/nodeserver || exit 1
exec /usr/bin/node scripts/pa-bundle-listings.js --all
