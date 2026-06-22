# Audit fixes — changelog

Unzip at the repo root (folders preserved → overwrites the right files), then push and restart.

## HIGH

**H1 — Balance race (lost money).** `utils/admins.js` now serializes every
read-modify-write of `admins.json` through a single async lock (`withLock` +
`mutate`). Concurrent top-ups and purchase debits can no longer clobber each
other. Verified: 20 concurrent `+1` and 20 concurrent `-1` adjustments on a
starting balance of 100 end at exactly 100.

**H1 — Balance ledger.** New `models/BalanceLog.js` append-only audit trail.
Every top-up (`routes/adminManageRoutes.js`), purchase and refund
(`routes/shopRoutes.js`) is recorded with who/when/amount/balance-after. New
`GET /admins/ledger` (superadmin) and a **Balance ledger** card on the Admins
page.

**H2 — Slow Shop/Drops queries.** Aggregations that filtered drops now match the
indexed `itemKey` directly instead of computing a key and matching on it (which
forced a full collection scan). Fixed in `routes/shopRoutes.js` and the filtered
aggregations in `routes/dropArchiveRoutes.js`. `/shop/listings` stock is now one
parallel batch (`Promise.all`) instead of an N+1 query per bundle. Legacy rows
keep working — `lastScanAt`/`itemKey` are backfilled on startup.

## MEDIUM

**M1 — CRED_SECRET.** `utils/secretBox.js` warns once at startup if `CRED_SECRET`
is unset and it falls back to `SESSION_SECRET`. Set a dedicated `CRED_SECRET`
**before** rotating `SESSION_SECRET`, or stored passwords/emails become
undecryptable.

**M2 — Encrypt redeem codes.** `routes/redeemRoutes.js` now encrypts the account
and password at rest (same `secretBox` as bot accounts) and decrypts on
delivery. Legacy plaintext rows still read fine.

**M3 — Chat leak across sellers.** `socket/chatSocket.js` scopes real-time events
to per-seller rooms (`seller:<id>` + `supers`) instead of broadcasting every
message to all admins. A normal admin only sees their own buyers; superadmins
still see everything.

**M4 — Redeem device-lock race.** `/validate` now binds the device atomically
via `findOneAndUpdate({ code, deviceToken: null }, …)`, closing the
read-then-write race on first redeem.

**M5 — Blocking Telegram sends.** Notifications in `server.js` (new gamer-tag)
and `socket/chatSocket.js` (new chat message) are fire-and-forget with
`.catch()` handling, so the buyer-facing request isn't delayed by the Telegram
round-trip.

## LOW

**L1/L2 — Login.** `routes/adminAuthRoutes.js` is now case-insensitive on
username, always runs a bcrypt compare (dummy hash for unknown users → no
timing/enumeration leak), and regenerates the session id on success (no session
fixation).

**L4 — Scanner.** `models/BotAccount.js` indexes `lastScanAt`; the Drops-archive
progress poll slowed from 4s → 8s (`public/drops-archive.html`).

**L5 — Credential import.** `routes/dropArchiveRoutes.js` import is now one DB
read + one `bulkWrite` instead of a regex `findOne` + save per row.

**L6 — Scanner overlap.** `utils/dropScanner.js` "Scan now" returns busy if a
scan is in progress, and the background tick skips rather than overlapping.

**L7 — orderId.** Informational only; `orderId` is not unique by design.

## Additions

- **Refund / unsell** (superadmin): `POST /shop/purchases/:id/refund` returns the
  account to the pool, credits the buyer, stamps the purchase refunded, and logs
  the ledger entry. A **Refund** button + refunded badge on the Admins → Buyer
  history table.
- **Pagination** on purchase history (`GET /shop/purchases?page=&limit=`) with a
  **Load more** button in the Shop and Buyer-history tables.
- **Shop search** box (filter listings by name) + **low-stock** badge (≤3 left).
