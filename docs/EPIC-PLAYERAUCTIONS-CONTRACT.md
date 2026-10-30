# Epic accounts on PlayerAuctions

Use the native Account API, Epic Games game 9310 (All server 9311). One account per instant offer. Never publish empty libraries or accounts held by G2G/Eldorado, sold accounts, or accounts without a working buyer inbox. New stock only; no G2G transfers.

`EpicPaUnit` reserves an account before minting a listed BuyerMailSession and before any publish request. Loading/error/paused units remain reserved. Unknown outcomes never retry publication automatically. Only a payment/delivery event on an order matched by offer ID and native account login marks the unit sold. Mail access begins at the payment timestamp, 14 days. A refund never returns disclosed credentials to stock.

`utils/playerauctionsAccountOffers.js`: native Account DTO, RSA PKCS1 password encryption matching the live member Angular bundle, validated original/current owner contact info. No synthetic recovery data. Expose narrow request wrappers through marketplaces.js so the existing cross-process session lock remains authoritative.

`utils/epicPa.js`: preview(accountId, opts), publish(accountId, opts, actor), overview(), tick(), setPaused(unitId, paused), reconcile(unitId, offerId), ownsOrder(order), start(). Explicit per-account publishing, no unattended auto-list switch. `reconcile` binds an ambiguous create to a verified own offer after operator review.

Routes under `/api/epic/sales/playerauctions`, superadmin and no-store. Panel on the existing Epic Listings & sales tab shows ready stock, recovery-data gaps, PA offers, unknown publish outcomes and sale sync. Never return passwords in overview or logs. Do not use Item stock/reprice helpers on Account offers.

Shared `epicSales._internals.withLock` serializes PA/Eldorado creation and G2G account selection in the production process. Tests use isolated in-memory Mongo + fake PA, including ambiguous publication, wrong-account matching, duplicate scans, and stock exclusion.

## Validation and first-sale limits

The native Account form, RSA public key/encryption, server taxonomy and order-account query are read from PlayerAuctions' own member client on 2026-10-30. Native Account fields include original/current owner contact details; these are required inputs, never synthesized. Publishing stays explicit per account.

In-memory Mongo tests cover native DTO validation, cross-market stock exclusion, duplicate publication, ambiguous HTTP outcomes, verified reconciliation, exact-account order matching, payment-based mail expiry, refunds and pause/resume. No live offer or sale is fabricated for validation. First real native publication and first real paid Account order remain live validation points.

At implementation time all 16 game-bearing accounts were reserved by G2G; ten unlisted accounts had empty libraries. The owner selected new stock for PlayerAuctions. Therefore deployment alone publishes nothing and transfers no G2G inventory.

Production's PlayerAuctions fulfiller differed from this branch's base. Its deployed bytes (07435b0f41b6efa7a0191738982064f1c1908f8f) were preserved before adding the native-account routing guard. The three existing PlayerAuctions test failures reproduce unchanged on the base branch (pool splitting, session-alert wording, Call of Duty game alias).
