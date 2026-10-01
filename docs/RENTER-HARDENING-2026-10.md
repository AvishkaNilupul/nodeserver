# Renter / rent-farm hardening — 2026-10-01

Owner request (2026-09-30): review the whole renter section (renters, rent-farm
orders on every market, the Gameflip buffer, the renter portal, the stacks
behind them) and "fix all one by one … do not break anything". Then (10-01):
"go ahead, finish the job, you decide" on the open owner decisions.

Branch `fix/renter-hardening`. Base `e5d666c` is a byte snapshot of prod's code
taken 2026-09-30 13:20Z; `git diff e5d666c..fix/renter-hardening` is exactly what
this work changes. `docs/` and `tests/` are not deployed.

## What changed, by area

### Renter bots (stop, lease end, games, start)
- A renter's Stop, lease end or games change touches **only that renter's
  accounts** — never another renter's or a rent-farm buyer's on a shared stack.
- A stop is never reported done while a bot may still have the account loaded.
  A reload that could not happen is recorded in `PendingReload`
  (`models/PendingReload.js`) and retried every renterExpiry tick (5 min); it
  pages after 30 min and then every 6 h.
- Placement first settles reloads owed by an earlier stop, and refuses
  (`reload_pending`) rather than putting an account on a second bot while the
  first may still run it.
- In-process busy marks (`utils/renterAccountBusy.js`): a lease-end sweep and an
  operator action on the same renter/account cannot interleave (routes answer 409).
- Renewing a window that already ended puts the account back on a bot; a
  lapsed window only counts as ended once it is really off the bot.
- Moving / deleting a renter's accounts cannot orphan them; the move scripts
  respect reserved slots and keep the window (`keepWindow`).

### Rent-farm orders (Eldorado, G2G, PlayerAuctions)
- An Eldorado order whose chat does not exist yet is held in `waiting_chat`
  BEFORE anything is provisioned (no account burned, no window started) and
  delivers when the chat appears. The check is
  `eldoradoFarmService.orderChatReady` (kept out of `marketplaces.js` on purpose
  — other work streams edit and deploy that file).
- The window counts from the hand-over, and the message states the end date
  ("runs until 2027-04-01 (UTC)", "2 years" instead of "730 days"). The date is
  pinned on the order (`handoverUntil`) at the first send attempt, so a retry
  sends byte-identical text (Eldorado's idempotency key and G2G's duplicate
  check hash the body); the ledger gets max(pinned, now + days).
- The hand-over re-stamp matches accounts by token, not login (duplicate-login
  twins keep their own windows). A G2G "paste it by hand" page stamps the
  ledger to the date in the text before it goes out.
- A failure after the login was sent never reports the order "NOT delivered".
- An order's size / game / term are frozen once any account is provisioned.
- G2G / PlayerAuctions match the most specific game name and accept announced
  games (`ANNOUNCED_FARM_GAMES`).
- Buyer copy no longer promises "new items will keep appearing" — items come
  whenever the game runs a Twitch Drops campaign during the window.

### Gameflip buffer
- An offer that expires unsold (Gameflip's 30-day limit; 87 offers expire
  10-09…10-11) is relisted with the **same** account — no pristine account
  burned, no restarts of stacks full of buyers.
- Sales that died half-way are finished automatically (`retryUnfinishedSales`,
  at most 8 tries per row).
- The buffer never takes the last 50 pristine pool accounts
  (`autoFarm.gfPoolReserve`, default 50) and keeps 40 free rental slots for paid
  orders (`autoFarm.gfRentSlotReserve`, default 40).
- A live offer backed by a bad account is paged (daily latch), never
  auto-delisted.
- A failing (game, term) cools down (1 h doubling to 6 h) instead of being
  retried first every pass.
- **Dark games**: a game with campaigns on record but none at any point in 45
  days gets no new offer and no renewal (its expired offers' accounts go back to
  the pool); live offers stay up. Nothing is dark when the campaign history is
  unreadable or empty, when the campaign watcher has refreshed nothing for 48 h,
  or when every catalogue game would be dark; a game with no campaign on record
  at all (announced, e.g. AION 2) is never dark. On 2026-10-01 this removed
  nothing (oldest: Escape from Tarkov, 33 days).
- The unfinished-sale sweep only looks at sold rows touched in the last 7 days,
  re-stamps only the holder's row (never another renter's lease on the same
  token), and pages only when it gives up. A delivered sale whose account is
  off its bot pages "DELIVERED … but NOT FARMING", not "NOT delivered".
- Offer text says drops come with the game's campaigns (applies to new
  publishes and renewals; live listings keep their text until renewed).

### New alerts (Telegram)
| Alert | Source | Cadence |
|---|---|---|
| Owed bot reload stuck | `renterBotOps.sweepPendingReloads` | after 30 min, then every 6 h |
| Dead rental stack (stopped/missing with buyers) | `rentFarmCapacity` tick (30 min) | then every 6 h while dead; one line when it farms again |
| Runway: rental slots / pristine pool | `rentFarmCapacity.runwayCheck` | warn < 10 days, critical < 4 days (daily reminder) |
| Integrity: dead token, not in any bot, farming past end, in two bots, wrong game, orphan, unreadable stack | `renterIntegrity` (hourly) | 2nd sighting; dead token weekly, others daily; "all clear" only after a page |
| Order walked away / refunded / cancelled | `farmOrderWatch` (hourly) | daily while it stands (latch survives restarts via SystemEvent) |
| Order intake failing | `intakeWatch` | 3 failures over 5 min, then every 6 h |
| Lease-end digest + 3-day advance warning | `renterExpiry` | daily 09:00 JST |
| Gameflip buffer stopped (pool reserve / capacity unreadable / reserve floor) | `gameflipFarmService` | latched per cause |
| Renter portal login lockout | `renterAuthRoutes` | per lock |

### Renter portal
- A password reset or suspend ends every existing session (`sessionEpoch`).
- 10 failed logins in 15 min from one address lock that username+address pair
  for 30 min; 20 failures across addresses page the operator once. The
  renter's own correct password is never refused because of other addresses.
- A renter whose access has not started is refused; a start date picked in the
  console opens at 00:00 JST that day; `whoami` returns the renter's own view
  only; ended accounts show as "Farming ended".

### Renter operations (seventh review pass)
- "Farm days" searches every configured host before it writes a new copy (a
  stale host pointer can no longer put a live account on a second host), and
  an unreadable stack while extending a live window just extends it.
- Start on a stopped renter with no accounts clears the stop ("farming is on
  again — add accounts").
- Add from pool refuses suspended / lapsed / stopped renters like manual add;
  manual add and approve re-check the renter under the busy mark.
- "Remove account": ending a buyer's paid farming (`?force=1`) and removing a
  row whose bot host cannot be read (`?skipPull=1`) are separate confirmations.
- Owed reloads: a removed container's policy row settles; an owed reload on a
  host this server no longer knows is dropped with one Telegram instead of
  blocking the renter; the retry sweep runs even if the lease step throws.
- Strict placement reads ignore unreadable files no bot reads (backups).
- dupeGuard strips a sibling that changed under it from its fresh text.
- Manual add always reloads the bot it took the account from.
- `move-renter-stack.js` refuses a same-host move (its rollback cannot work
  there).

### Infrastructure
- The Bots page / consolidator / `move-bot-host.js` refuse to delete, move or
  repack a rental stack (`rentalStackRefusal`); a slot number is never reused
  (archived/backup names count).
- `dupeGuard` marks healed sibling configs as owing a reload and never
  overwrites a sibling that changed under it.
- **Remote config writes verify their size**: the temp file is moved into place
  only when it holds every byte sent (`botHosts.writeFileRaw`). A cut-off ssh
  transfer used to install half a bot config. Verified on the Pi and Contabo.
- `scripts/credit-farm-outage.js`: extends live windows on given stacks by an
  outage length (dry run unless `--apply`, refuses > 14 days, keeps order
  copies in step).
- Market console Orders tab shows each account's live window, and a
  "Close & end windows" button for refunded/abandoned orders.

## Owner decisions (made 2026-10-01 on the owner's instruction "you decide")

| Question | Decision | Why (data read from prod, read-only) |
|---|---|---|
| Gameflip buffer size / pool reserve | **Keep** the full catalogue (29 games × 3 terms = 87 offers); pool reserve **50**, slot reserve 40 (defaults). | 8 sales since 09-11 (5 Fortnite). With same-account renewal an unsold offer costs one rental slot, not a fresh account every 30 days; slots have ~32 days of runway and the runway alarm warns 10 days ahead. Revisit after the 10-09 wave with more sales data. |
| Dead-token buyers `cgasc993ux` (Eldorado OW 365d) and `jfwxym692m` (Eldorado EFT 180d) | **Leave the orders and windows as they are; no buyer contact.** Integrity alert repeats weekly. | Both tokens died within 1–2 days of delivery with 0 drops — a password change by the buyer, which the hand-over says stops farming and is not refunded. Re-minting needs the account's login (and the token fetcher is broken since 09-29). If a buyer writes in: restore access (re-mint) or provision a replacement with the same `farmUntil`. |
| Renters with no accounts (`o7m339gbpgwcqvtqsfy0c`, `brawlhalla`, `marol4jcuts`, `rustfarm`) | **Leave alone.** | Created 08-11, never logged in, 0 rows ever. They reserve no slot (reservations count recorded rows only) and their leases end on their own (11-11; o7m339… 2027-02-11). Deleting a paid renter is irreversible. Lease end with no accounts is a no-op (verified in code). |
| Second bot host | **No, not now.** | Slot runway ~32 days, pool ~22 days; a host does not help the pool, and datacenter IPs are a ban risk. The runway alarm says when. |
| Pause games with no campaigns | **No auto-pause of live offers.** Gameflip stops adding/renewing offers for games dark 45+ days; copy no longer promises daily drops. | Windows are 120–365 days; many games sit between campaigns (Rocket League, Warframe: 9–13 campaigns in 30 days, none at this minute). Every catalogue game had a campaign within 33 days. Eldorado offers are untouched (no side-process Eldorado calls). |
| Delivery message wording | **Keep** the end date and "N years"; drop "new items will keep appearing". | Factual, and it was untrue for the 35 of 172 windows on games with no campaign on 09-30. |

## Not done (and why)
- **Eldorado Canceled/Disputed past the first page of 50**: the cursor format is
  unknown and the API must not be probed from a side process (session race).
- **Restart coalescing / automatic stack provisioner**: features, not fixes;
  the runway alarm covers the "out of slots" risk meanwhile.
- **Passwords in the admin account list**: pinned by
  `docs/renters-console-CONTRACT.md` + `tests/rentersConsole.test.js`; needs an
  owner call on what the console should show.
- **Live campaign status line in hand-over messages**: would add a DB read to
  every delivery; the copy change covers the expectation.
- `scripts/eldorado-farm-listings.js` and `utils/bulkPacks/copy.js` still say
  "new Drops every day" — the owner's listing copy / another work stream; the
  87 live Gameflip offers keep their old text until renewed (from 10-09).
- ~~Other remote config writers still unchecked~~ — DONE 2026-10-01 (branch
  `fix/remote-write-size-check` `bf3f466`): `utils/tokenReplace.js`,
  `utils/unclaimedAutoList.js`, `utils/noclaimFleet.js` (create + top-up) and
  `routes/noclaimFarmRoutes.js` (spent/remove, which wrote straight onto the
  live config) all build `botHosts.guardedWriteScript` now; see the deploy
  record below.
- Known, accepted edges (from the reviews): bot numbers above 999 would be
  invisible to the 3-digit config-name rules (numbers are < 100 today); a
  failed reload mark plus a failed reload can let a stop retry report done;
  the stack-move rollback can restart a source that was already stopped; a
  Close clicked while a delivery tick runs for the same order can be undone by
  it; G2G/PA game-prefix matching has no word boundary ("Rusty Lake" → Rust),
  as before.

## Deploy record
- **2026-10-01 03:44:29 UTC (12:44 JST)** — 51 files (44 replaced, 7 new) ==
  `fix/renter-hardening` `81847c8`, targeted copy. Every prod file was
  fingerprinted against the base `e5d666c` first (all 44 matched; the 7 new
  ones were absent), the staged copies hash-verified, the 40 server modules
  load-tested, then `pm2 restart redeemer` (restart 9, 0 unstable; "MongoDB
  connected", "Server started").
- Backup: `_deploy_backup_20261001034221_renter-hardening/` at the app root,
  with `MANIFEST.txt` (path, base blob, deployed blob) and `NEWFILES.txt`.
  **Fingerprint against the deployed blobs in that MANIFEST next time.**
- Not deployed: `utils/marketplaces.js` (prod carries another work stream's
  GGSel changes, `69f65c3f` at deploy time; this branch no longer edits it —
  it was checked to export every `mp.*` function the deployed code calls),
  `docs/` and `tests/`.
- Checked after the restart: protected pages and APIs answer 401, the renter
  login answers 400 to an empty body, the market console Orders tab returns
  live window chips from the real ledger (read-only harness, writes blocked),
  and no error from any changed module. Pre-existing noise seen: PlayerAuctions
  session refresh 429 (Cloudflare), G2G delivered-count HTTP 500.
- Backed up to GitHub: `origin/fix/renter-hardening`.
- **2026-10-01 04:09:44 UTC** — remote-write size check, 5 files ==
  `fix/remote-write-size-check` `bf3f466` (`utils/botHosts.js` 984736d8→381e8cd1,
  `routes/noclaimFarmRoutes.js` 66014ef1→e5a4c1fb, `utils/noclaimFleet.js`
  9171655a→cee2b54d, `utils/tokenReplace.js` 2d53cf1c→20e3c110,
  `utils/unclaimedAutoList.js` 6d1b6c0a→4ec71a38), same routine; backup
  `_deploy_backup_20261001040820_remote-write-guard/`; pm2 restart 10
  (0 unstable). The guarded command was first tried on the real Contabo and Pi
  in /tmp (whole write lands 600; a short one is refused, the file untouched).
  GitHub: `origin/fix/remote-write-size-check`.
- **2026-10-01 05:40:17 UTC** — G2G marks orders delivered itself:
  `utils/marketplaces.js` 16ab8147→169eb21f (merged onto the 05:19Z
  system-health deploy's bytes; only `g2gSetDeliveredQty` changed). G2G's own
  seller page sends `PUT /order/item/<id>/delivered_qty` with body `{ qty }` and
  `seller_id` in the query (www.g2g.com `seller-order-item` chunk,
  `ORDER.UPDATE_DELIVERED_QTY`); we sent `{ seller_id, delivery_qty }` and got
  HTTP 500 since September. `qty` is an increment, so the item is read first and
  only the undelivered remainder is sent. Verified live: order
  `1790817293060OS4Y-1` (Halo Infinite, 2 units, credentials sent 01:19Z) went
  to delivered 2/2, awaiting buyer confirmation, at 05:41:48Z on the server's own
  tick; both units stamped delivered. Backup
  `_deploy_backup_20261001053810_g2g-delivered-qty`; pm2 restart 12. GitHub:
  `origin/fix/g2g-delivered-qty`.
- **2026-10-01 07:15:39 UTC** — G2G delivery proofs. G2G holds an order's
  income until a delivery-proof image is uploaded
  (`require_delivery_proof_to_credit_income` on every order item, completed ones
  included). `marketplaces.g2gUploadDeliveryProof` does G2G's own seller-page
  flow (`GET /order/upload_url` → multipart POST to the pre-signed storage form
  → `POST /order/item/<id>/delivery_proof {upload_list, seller_id}`);
  `g2gFulfiller.sweepDeliveryProofs` (every 10 min, 8 uploads per pass) uploads
  one "Delivery confirmation" card (order, offer, accounts, time sent, "sent in
  the G2G chat" — never the credential) to each fully delivered order OUR chat
  send handed over that has no proof, and stamps owner-confirmed units
  delivered. Orders the bot did not send are skipped (4 on deploy day — upload
  those by hand). Files: `utils/marketplaces.js` 6742d3e1→d0f22a92 (merged onto
  the 06:39Z gameflip deploy), `utils/g2gFulfiller.js` db76fa9b→86935238,
  `utils/playerauctionsProof.js` d88db6a1→cc92c8f4 (PA card byte-identical).
  Backup `_deploy_backup_20261001071336_g2g-delivery-proof`; pm2 restart 14.

## Rollback
On prod, from the app root, with `BK` = the backup dir named below:

```bash
BK=_deploy_backup_20261001034221_renter-hardening
while read f base new; do
  if [ "$base" = "MISSING" ]; then rm -f "$f"; else cp -p "$BK/$f" "$f.rhold" && mv -f "$f.rhold" "$f"; fi
done < "$BK/MANIFEST.txt"
pm2 restart redeemer
```

`PendingReload` rows and the new Renter/RenterAccount/MarketplaceListing fields
are additive; the old code ignores them.
