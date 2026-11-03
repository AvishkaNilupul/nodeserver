# Steam Eldorado pipeline contract

Owner scope 2026-11-03: complete, deploy, then create TEN NEW accounts to test. Eldorado only; existing G2G stock remains tracked.

Incoming stock: replenish empty regional shelf to keepPerRegion; overflow alternates per-game preparation and hour boosting, within maxAccounts. Game preparation uses one selected F2P game, real license and >=2 Steam-recorded minutes; boosting uses selected games and configured 500/1000-hour target. Each account is reserved atomically (stock -> boosting). Never publish an account while a worker can play it.

SteamBoost: queued -> boosting -> stopping -> ready (worker logout acknowledged), or failed. State stopping is excluded from assignments but returned as a tombstone. Worker credentials/tokens/mail/reports require id + gen. Worker drops assignments removed or changed; loses authority after 3 minutes without a successful assignment fetch and logs off. Login pacing >=20 seconds. Settle Steam playtime every 2 hours; report real minutes only. No fake hours or live reduced-tier listings for tests.

Ready accounts return to stock, permanently boostedAt-marked, with verified game records. Eldorado products are region, game(appId), boosted(appId,minHours). One account on one offer. Reuse existing SteamSales stock/session/order lifecycle; section and product persisted on SteamListing. Only licensed and verified games eligible; boosted eligibility checks SteamBoost ready+minutes >= tier. Automatic shelf refills only owned system offers, never manually paused offers. Per-game category configuration checked against Eldorado public API; unknown games remain in Steam account category with exact game title.

Deploy only fingerprinted files with timestamp backup and rollback; prod server.js patches merged onto prod bytes. Worker secret transport through SSH tunnel, loopback API only. Commit/push code backup and rebuild Graphify after deploy. Test 10 NEW generated rows through import, allocation, real worker/license/minutes and exact no-double-sale ownership. Full 500/1000-hour elapsed time cannot be completed during the smoke test; verify tier boundaries using isolated tests.
