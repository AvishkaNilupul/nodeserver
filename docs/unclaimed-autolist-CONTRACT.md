# Unclaimed farms auto-listing — contract (v2)

Status: agreed design for the build. Read this before touching the files it
names. Owner decisions captured 2026-08-30: auto-list + auto-sell the no-claim
farm AND the web-token farm on the same marketplaces the auto-farm uses; drops
stay weeks (verified via the Twitch inventory client, not 24h); ONE listing per
item with "sold → list it again" (the same pattern the auto-farm already has);
delist on expiry; return the account to the pool ONLY after all of its drops
expired; one combined sidebar tab with No-claim / Web-token / Auto-list
sections.

**v2 correction (owner, after seeing v1 live):** v1 published ONE listing per
ACCOUNT, so 100 accounts holding the same drops became 100 identical listings
per marketplace — a mess. v2 groups by item: an item is one game + one exact
set of drops, and ALL ready accounts for it share ONE listing per marketplace.
Gameflip (no quantity) runs a relist chain — the next account is published when
the live unit sells. Digiseller / GGSel are quantity products — every ready
account is attached as one delivery-code unit, and a sale consumes a unit while
the next ready account joins as stock. Accounts are split round-robin across
the enabled markets, so one account is only ever attached to ONE market and can
never be handed to two buyers on different platforms.

## What stays true (rules)

1. **No-claim means no claim.** Nothing in this feature ever claims a drop,
   reprices a manual/auto listing, touches `origin:"auto"` rows, or releases a
   listed account to the pool while it still has sellable drops.
2. **Ground truth is live Twitch inventory.** A drop counts as sellable only
   when the live inventory shows `percent >= 100 && !claimed` (no-claim via
   `utils/twitchInventory.js`, webbot via `utils/webbotTwitch.js`). Never infer
   sellability from configs/DB alone.
3. **One account, one buyer.** An account is attached to exactly one
   marketplace and is listed only if it is not already on an active
   `MarketplaceListing` (any origin) and not sold per the same DB markers the
   spent scan uses (`soldMapForSecrets` logic).
4. **Listing model (v2).** One `DropSet` + one active row per marketplace per
   item (game + exact drop set):
   - Gameflip: one live unit on sale, `qtyRemaining:0` (the engine relists —
     the auto-farm's relist chain must never relist these rows, because its
     stock source is the claimed-account archive). When the live unit sells /
     expires / is claimed, the next waiting unit is published as the successor
     ("list it again").
   - Digiseller / GGSel: one product/offer, `units[]` = the attached accounts'
     delivery codes. A stock drop = a sale (FIFO attribution — the platform
     does not say which unit sold, same limitation the auto-farm lives with);
     new ready accounts join the same product as new stock. On expiry/claim a
     unit is removed (Digiseller by contentId; GGSel cannot delete one unit, so
     the offer is rebuilt without it, or taken down when no healthy unit
     remains).
   - ZeusX is NOT auto-published: it is a manual hand-over market for the
     auto-farm and has no auto-sell path (v1's ZeusX rows were part of the
     duplicate mess).
5. **Expiry lifecycle:** a listed drop expiring makes the listing content wrong
   → the account's unit is removed (Gameflip live unit → delist + successor);
   once ALL drops are gone the account returns to the pool (no-claim:
   `AvailableAccount` -> available; webbot: `WebBotAccount` -> idle, off the
   bot). A drop that flips to `claimed` means a buyer took it -> SPENT path
   (never pool-returned).
6. **Sold lifecycle:** Gameflip sales are detected by the existing
   `gameflipFulfiller` (it polls all auto-deliver rows; with `qtyRemaining:0`
   it marks the row sold and never touches it). GGSel/Digiseller sales are
   inferred from this module's own stock-read pass. On sold, the account stops
   farming (no-claim: config rewrite like spent/remove; webbot: DB row
   disabled+idle) and its pool row is stamped `soldGames` + `claimedNote
   "spent"` — exactly like spent/remove does, so it surfaces in the recycler.
   Sold accounts are NEVER pool-returned.
7. **Marketplaces = the auto-farm's set minus ZeusX**, gated by the same
   settings: gameflip always; digiseller (plati) if `platiCategoryId`; ggsel if
   a category resolves. FunPay/EpicNPC/G2G are not auto-published by the
   auto-farm either — out of scope.
8. **Pricing = `derivePrice(MarketResearch)`** like the auto-farm; fallback
   $1.00 (floor $0.75). No markup, no repricing later.
9. **Origin boundary:** new listing rows use a new `origin:"unclaimed"` so
   `isAutoOwned()` (origin `"auto"`) stays false and no auto-farm reprice can
   ever touch them. `qtyTarget:0` — the guardian must not feed these rows.

## Files

- `models/UnclaimedAccount.js` — per-account ledger (source, login, game,
  drops snapshot, set ref, market, status listed/sold/expired/released,
  timestamps, refs).
- `models/MarketplaceListing.js` — ADD `"unclaimed"` to the `origin` enum.
- `utils/unclaimedAutoList.js` — engine: candidate collection (Pi configs for
  no-claim + `WebBotAccount` for webbot), live-inventory eligibility, item
  grouping (one DropSet per game+drop-set), ONE listing per market, restock /
  relist on sale, expiry → unit removal + pool return. Pure helpers exported
  for tests. `start()` interval + `runOnce()` + `status()`.
- `routes/unclaimedAutoRoutes.js` — superadmin API for the Auto-list panel
  (state, accounts, scan, refresh, pause, manual sell/delist).
- `public/unclaimed-farms.html` — combined tab: Auto-list panel + the two
  existing pages embedded via `?embed=1` iframes.
- `server.js` — mount route + page (with `?embed=1` nav-hiding), start watcher.
- `public/admin-nav.js` — replace the two nav items with one "Unclaimed farms".

## Known trade-offs (documented, accepted)

- Quantity-market sales are FIFO-attributed: when a product's stock drops we
  spend the OLDEST still-listed unit. The platform does not say which unit
  sold; the auto-farm has the same blind spot. The platform's stock read is the
  product's truth; our row bookkeeping is best-effort.
- A sold unit's code is left on the product (the platform consumed it); expiry
  / claim removals always target the exact content line (Digiseller) or rebuild
  (GGSel).

## Invariants not to break

- Preserve the dirty worktree (incl. the in-progress webbot feeder/pagination
  edits) — build on top, never revert.
- Do not modify the Claude memory dir; deployment follows
  `reference_production_server` (fingerprint, backup, load-test, pm2, verify)
  and the repo pushes to GitHub + refreshes graphify after deploy.

## v2 hardening (applied live 2026-08-30 after first tick)

- **One-account-one-buyer is enforced at attach time.** Inside the set lock,
  before any publish/attach, the engine re-checks the DB that the login is not
  already a listed ledger unit and not already on another active unclaimed row
  (`units[].login` OR `accountLogin`) — same login from both farms, or a second
  pass mid-scan, is skipped and logged. `activeListingsForLogin` also matches
  `units[].login`, not just the `accountLogin` string.
- **`ledgerAccount` never re-points a listed ledger.** An existing listed
  ledger keeps its original `market` (set only on insert); a re-attach to a
  different market is refused. Defense-in-depth for the guard above.
- **Cross-process run lock actually works now.** `utils/unclaimedAutoList.js`
  had never imported `mongoose`, so `acquireRunLock` always failed open — two
  processes (pm2 tick + a harness/manual run) could scan concurrently and both
  attach the same login. Import added; the lock now serializes passes and the
  attach guard covers the window even if the lock is ever down again.
- **Digiseller content adds are chunked (12/call).** The content-add API only
  commits the first ~17 lines of a large batch (verified live: a 56-line add
  left 17 in stock). `publishDigisellerProduct` now feeds units in small chunks
  and records every contentId in order; a short response throws and takes the
  product down instead of silently selling partial stock.
- **Integrity is visible in the panel.** `engine.consistencyIssues()` checks
  every active unclaimed row against its listed ledgers per set+market (an
  item = a set, and several items share a marketplace — the check is keyed by
  `set:marketplace`, not marketplace alone): units with no ledger, ledgers not
  on their set's row, a login on two markets, and a gameflip live unit that is
  not a listed gameflip ledger of its set. The Auto-list panel shows
  "integrity ok" or a red count, and `/api/unclaimed-auto/state` carries the
  full issue list.

- **Listing titles use the auto-lister's `buildTitle` style** — "{Game} Twitch
  Drops ({N} Items) — {Item A} + {Item B} +{N-2} more" — so a buyer sees the
  drops, not a vague "drop account". The Gameflip successor skips a waiting
  unit whose delivery code the platform still holds (e.g. a delisted
  predecessor) and publishes the next in the chain instead of blocking the
  item.
