# Unclaimed farms auto-listing — contract

Status: agreed design for the build. Read this before touching the files it
names. Owner decisions captured 2026-08-30: auto-list + auto-sell the no-claim
farm AND the web-token farm on the same marketplaces the auto-farm uses;
drops stay weeks (verified via the Twitch inventory client, not 24h); delist on
expiry; return the account to the pool ONLY after all of its drops expired;
one combined sidebar tab with No-claim / Web-token / Auto-list sections.

## What stays true (rules)

1. **No-claim means no claim.** Nothing in this feature ever claims a drop,
   reprices a manual/auto listing, touches `origin:"auto"` rows, or releases a
   listed account to the pool while it still has sellable drops.
2. **Ground truth is live Twitch inventory.** A drop counts as sellable only
   when the live inventory shows `percent >= 100 && !claimed` (no-claim via
   `utils/twitchInventory.js`, webbot via `utils/webbotTwitch.js`). Never infer
   sellability from configs/DB alone.
3. **One account, one buyer.** An account is listed only if it is not already
   on an active `MarketplaceListing` (any origin) and not sold per the same DB
   markers the spent scan uses (`soldMapForSecrets` logic).
4. **Expiry lifecycle:** any listed drop expiring makes the listing content
   wrong -> delist every row for that account; once ALL drops are gone the
   account returns to the pool (no-claim: `AvailableAccount` -> available;
   webbot: `WebBotAccount` -> idle, off the bot). A drop that flips to
   `claimed` means a buyer took it -> SPENT path (never pool-returned).
5. **Sold lifecycle:** Gameflip sales are detected by the existing
   `gameflipFulfiller`; GGSel/Digiseller sales by this module's own stock-read
   pass; ZeusX stays manual hand-over (same as the auto-farm). On sold, the
   account stops farming (no-claim: config rewrite like spent/remove; webbot:
   DB row disabled+idle, container cleanup via the tab) and its pool row is
   stamped `soldGames` + `claimedNote "spent"` — exactly like spent/remove
   does, so it surfaces in the recycler. Sold accounts are NEVER pool-returned.
6. **Marketplaces = the auto-farm's set**, gated by the same settings:
   gameflip always; digiseller (plati) if `platiCategoryId`; ggsel if a
   category resolves; zeusx if `zeusxAuto`. FunPay/EpicNPC/G2G are not
   auto-published by the auto-farm either — out of scope.
7. **Pricing = `derivePrice(MarketResearch)`** like the auto-farm; fallback
   $1.00 (floor $0.75). No markup, no repricing later.
8. **Origin boundary:** new listing rows use a new `origin:"unclaimed"` so
   `isAutoOwned()` (origin `"auto"`) stays false and no auto-farm reprice can
   ever touch them. `qtyTarget:0`, `qtyRemaining:0` — the guardian and the
   gameflip relist chain leave them alone.

## Files

- `models/UnclaimedAccount.js` — NEW per-account ledger (source, login, game,
  drops snapshot, status listed/sold/expired/released, timestamps, refs).
- `models/MarketplaceListing.js` — ADD `"unclaimed"` to the `origin` enum.
- `utils/unclaimedAutoList.js` — NEW engine: candidate collection (Pi configs
  for no-claim + `WebBotAccount` for webbot), live-inventory eligibility,
  publish (DropSet + rows per market), expiry/sale passes, pool return.
  Pure helpers exported for tests. `start()` interval + `runOnce()` + `status()`.
- `routes/unclaimedAutoRoutes.js` — NEW superadmin API for the Auto-list panel
  (state, accounts, scan, refresh, pause, manual sell/delist).
- `public/unclaimed-farms.html` — NEW combined tab: Auto-list panel + the two
  existing pages embedded via `?embed=1` iframes.
- `server.js` — mount route + page (with `?embed=1` nav-hiding), start watcher.
- `public/admin-nav.js` — replace the two nav items with one "Unclaimed farms".

## Invariants not to break

- Preserve the dirty worktree (incl. the in-progress webbot feeder/pagination
  edits) — build on top, never revert.
- Do not modify the Claude memory dir; deployment follows
  `reference_production_server` (fingerprint, backup, load-test, pm2, verify)
  and the repo pushes to GitHub + refreshes graphify after deploy.
