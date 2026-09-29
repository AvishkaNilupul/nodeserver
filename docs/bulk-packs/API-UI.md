# Bulk packs — API, page, tests (frozen)

## Router — routes/bulkPackRoutes.js (A8)

Every handler: `requireSuperadmin` (middleware/auth.js). Mounted after the admin blanket
with `enforce2fa` (CONTRACT H3). JSON `{success:true, ...}` or `{success:false, message}`
with the `status` that send.js returns. `actor = actorFromReq(req)` (utils/systemLog.js).

| Method | Path | Body / query | Does |
|---|---|---|---|
| GET | `/api/bulk-packs/overview` | — | `{settings: bp, gates, loop: loop.status(), counts:{open, byState}, capacity}` — gates = `{[market]:{dropset, noclaim, farm}}` each `{ok, reason}` for SOURCE_MARKETS; blocked markets listed as `{blocked:true}`; capacity = `farmCapacity.read()` (cached) + `advertisable` |
| GET | `/api/bulk-packs/proposals/accounts` | `?refresh=1` | `proposals.accountProposals` |
| GET | `/api/bulk-packs/proposals/farming` | `?refresh=1` | `proposals.farmProposals` |
| GET | `/api/bulk-packs/offers` | `?scope=open\|closed\|all&limit=100` | offers (newest first, no `reserved[]` logins beyond counts: `reservedCount`, `freeCount`, `retiringCount`) |
| GET | `/api/bulk-packs/offers/:id` | — | one offer incl. `reserved[]` (logins ok — superadmin only, no passwords) and last 60 history |
| POST | `/api/bulk-packs/send` | `{source, setId?, game?, days?, market, minQty, units?}` | `send.sendOffer` |
| POST | `/api/bulk-packs/offers/:id/refill` | `{add}` | `send.refillOffer` |
| POST | `/api/bulk-packs/offers/:id/pause` | — | `send.pauseOffer` |
| POST | `/api/bulk-packs/offers/:id/resume` | — | `send.resumeOffer` |
| POST | `/api/bulk-packs/offers/:id/withdraw` | — | `send.withdrawOffer` |
| POST | `/api/bulk-packs/withdraw-all` | `{confirm:"WITHDRAW"}` | `send.withdrawAll` (400 without the exact confirm) |
| POST | `/api/bulk-packs/run-now` | — | `loop.runOnce()` summary |
| GET | `/api/bulk-packs/settings` | — | `{settings: bp, raw, keys}` (raw = the autoFarm bulk* keys as stored) |
| POST | `/api/bulk-packs/settings` | `{patch}` | whitelist-validate (pattern: routes/unclaimedAutoRoutes.js `validatePricingPatch`) then `settings.setAutoFarm(patch, {actor})`; 400 on errors/empty patch |

Settings whitelist (autoFarm keys): `bulkPacksEnabled` (boolean), `bulkPacksMarkets`
(array ⊆ SUPPORTED_MARKETS), `bulkPackTiers` (array of {minQty 2..100 int, discountPct
0..60}, 1..4 entries, unique minQty), `bulkPackReserveSingles` 0..100 int,
`bulkPackUnitsPerOffer` 1..80 int, `bulkFarmPrices` ({eldorado|g2g: {days: price 0.5..100}}),
`bulkFarmDurations` (ints 1..730, 1..6 entries), `bulkFarmReserveSlots` 0..500 int,
`bulkFarmReservePristine` 0..500 int, `bulkFarmMaxQty` 1..100 int,
`bulkPacksLoopMinutes` 2..60 int, `bulkFarmSyncMinutes` 5..120 int. Export the validator
(`validateSettingsPatch`) for tests. After send/withdraw/settings changes call
`proposals.invalidate()`.

## Page — public/bulk-packs.html (A9)

Copy the shell of `public/system-health.html`: theme script in `<head>`, `:root` light
tokens + `html[data-theme="dark"]` overrides, `<aside class="nav">` with brand, empty
`<nav class="links">`, `.me` block (avatar/name/role, `data-theme-toggle`, logout POST
`/admin-logout`), then `/theme.js` and `/admin-nav.js`. Fetch with
`credentials:"same-origin"`; 401 → `/admin-login.html`; `success === false` → show message.
One `@media (max-width:720px)` block; support `?embed=1` like farm-sizing.html.
No external libraries. Escape every string from the API before inserting it (textContent
or an `esc()` helper) — titles and set names come from marketplaces.

Layout (single page, plain JS):
1. **Header strip**: title "Bulk packs"; master switch chip (ON/OFF) with a toggle
   button (confirm dialog; POST settings `{patch:{bulkPacksEnabled:x}}`); market chips
   (Eldorado / G2G / Gameflip: green "live" or amber with the gate reason; Plati & GGSel
   grey "blocked"); loop heartbeat ("last pass Xm ago · open N"); a "Run check now" button.
2. **Tabs**: Account packs · Farming packs · Live offers · History · Settings.
3. **Account packs**: cards from `/proposals/accounts` — set name, game, item thumbnails
   (max 6 + "+N"), source badge ("Farmed" / "No-claim"), `free`, `reserve`, `surplus`.
   Per market row: single price (anchor + basis), then one button per tier:
   eldorado/g2g "5+ at $X.XX each"; gameflip "Pack of 5 — $Y". Disabled with a tooltip
   when the gate is closed or the tier does not fit; replaced by a "Live" link when
   `liveOfferId` is set. Clicking opens the **Send dialog**: summary sentence (e.g.
   "List 'Rust Twitch Drops bundle — BULK 5+ accounts (5% off)' on Eldorado at $1.19 per
   account; 20 accounts will be reserved"), an editable "accounts on this offer" number
   for eldorado/g2g (default min(bp.unitsPerOffer, surplus)), Confirm → POST `/send`;
   show the result and refresh.
4. **Farming packs**: capacity banner (best stack room, free slots, pristine, advertisable
   now); table: game, duration, orders (60d), then per market the tier buttons
   ("5+ at $6.65 each"). Same Send dialog (units = advertisable, read-only).
5. **Live offers**: table from `/offers?scope=open`: market, kind, title (link to `url`),
   tier (min N / pack N), price, free / delivered / orders, state chip (live, paused,
   sending), lowStock/autoPaused flags, actions Pause / Resume / Refill (dropset
   eldorado/g2g) / Withdraw (confirm). "Withdraw all" button (typed confirm "WITHDRAW").
6. **History**: `/offers?scope=closed` with state, sold counters, revenue, closedAt; a
   total line (orders, accounts, revenue at our listed prices).
7. **Settings**: form for tiers (rows of minQty + discount%, add/remove up to 4), markets
   checkboxes (Eldorado/G2G/Gameflip), reserve for singles, accounts per offer, farm price
   table (eldorado/g2g × durations), farm reserve slots, farm reserve pristine, farm max
   qty, loop minutes, farm sync minutes. Save → POST settings; show validation errors.

Plain English, short labels; never show passwords; money as `$0.00`.

## Tests (each agent owns its files; run `node --test tests/bulkPacks<Area>.test.js`)

- A1 `tests/bulkPacksConfig.test.js`: getBulkPacks defaults + every clamp; slotKey;
  deliveryGate matrix (eldorado/g2g flags, dry-run, gameflip, noclaim shop, blocked,
  unsupported); BulkOffer partial unique index rejects a 2nd open slot but allows one
  after close (memory mongo); MarketplaceListing accepts/stores `bulkOfferId`.
- A2 `tests/bulkPacksPricing.test.js`, `tests/bulkPacksCopy.test.js`: floors, rounding,
  pickAnchor rules; titles length limits per market; account titles never match the farm
  regex; farm titles round-trip through the REAL `termToDays` and the "Twitch Drops" split
  for 120/180/365 and long game names.
- A3 `tests/bulkPacksStock.test.js`: reserve/isStillOurs/releaseUnits against real
  DropLog/BotAccount docs in memory mongo (a released unit becomes available again; a
  unit whose reservation belongs to another tag/set is skipped); unitHealth;
  farmCapacity.advertisable math + read() caching/never-throws with faked deps.
- A4 `tests/bulkPacksMarkets.test.js`: fake mp records calls; eldorado/g2g publish args
  (quantity/minQuantity/minQty, floors); gameflip code has N blocks + separator + refusal
  above max/unreadable password; readOffer never returns "gone" on a failed read.
- A5 `tests/bulkPacksSend.test.js`: memory mongo + faked stock/markets/farmCapacity:
  switched off → 409; gate closed → 409; duplicate slot → 409; not enough surplus → 409 and
  nothing reserved; publish failure → reservations released + offer "error"; row-create
  failure → offer paused + released; happy paths create the right row shape
  (origin manual, bulkOfferId, units, qtyRemaining 0 for gameflip); withdraw paths.
- A6 `tests/bulkPacksLoop.test.js`: reconcile heals a clobbered unit, re-pulls a
  re-added retiring unit, releases only after 2 min and only FREE units; delivered units
  are never released; sold-out → pause + retire; gameflip sold/removed; farm pause/resume
  (no resume while disabled); heartbeat string.
- A7 `tests/bulkPacksProposals.test.js`: tier fit rules, liveOfferId, blocked/unsupported
  markets absent, no-claim games excluded from dropset, caching/invalidate.
- A8 `tests/bulkPacksRoutes.test.js`: stub-session harness (pattern
  tests/dropSetsListLight.test.js): 401/403 without superadmin; settings validator;
  withdraw-all confirm; send returns send.js status.
- A10 `tests/bulkPacksExclusions.test.js`: for each hook, prove the sweep skips a row with
  `bulkOfferId` (memory mongo where the function is callable in isolation; otherwise a
  source-level tripwire asserting the filter exists in that function body).
