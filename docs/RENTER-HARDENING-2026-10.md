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
  ("runs until 2027-04-01 (UTC)", "2 years" instead of "730 days").
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
- **Dark games**: a game with no Twitch campaign at any point in 45 days gets no
  new offer and no renewal (its expired offers' accounts go back to the pool);
  live offers stay up. Unknown/empty campaign history darkens nothing. On
  2026-10-01 this removed nothing (oldest: Escape from Tarkov, 33 days).
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
- 10 failed logins in 15 min lock that username for 30 min (+ Telegram).
- A renter whose access has not started is refused; `whoami` returns the
  renter's own view only; ended accounts show as "Farming ended".

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
- `scripts/eldorado-farm-listings.js` still says "new Drops every day 15 hours
  during GMT" in the Eldorado offer description — owner's listing copy, only
  used when the owner republishes.

## Deploy record
See the bottom of this file (filled in at deploy time).

## Rollback
On prod, from the app root, with `BK` = the backup dir named below:

```bash
BK=_deploy_backup_<ts>_renter-hardening
while read f base new; do
  if [ "$base" = "MISSING" ]; then rm -f "$f"; else cp -p "$BK/$f" "$f.rhold" && mv -f "$f.rhold" "$f"; fi
done < "$BK/MANIFEST.txt"
pm2 restart redeemer
```

`PendingReload` rows and the new Renter/RenterAccount/MarketplaceListing fields
are additive; the old code ignores them.
