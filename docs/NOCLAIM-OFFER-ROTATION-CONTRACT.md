# No-claim Eldorado offer rotation — contract

Owner rule, 2026-10-02 JST: *when a no-claim Eldorado offer runs dry because its
wave expired, it switches itself to the newest bundle the farm holds (same
offer, same price) and comes back on sale.*

## Why

A no-claim Eldorado offer (`MarketplaceListing` with `marketplace:"eldorado"`,
`noclaimStock:true`) sells ONE fixed no-claim `DropSet`. Rainbow Six drops a new
"Esports Pack" wave every 2–3 days, each wave's items leave the accounts about a
week after it ends, and later waves rename the item ("Esports Pack 26 stage 2"
→ "Esports Pack 26 Stage 2.1"). The set's items expire off every account,
`eldoradoFulfiller.syncBundleStock` pauses the offer (`autoPaused:true`,
`lastError:"paused: no claimable stock"`), and nothing brings it back.

Measured 2026-10-01: R6's selling offer `c847f2c2` (~4 sales/day, 45 of the
last 51 R6 sales) sat paused 31 h on "9× Esports Pack 26 stage 2" while 41 free
accounts held 6× Stage 2.1 + 2× OL' CLANKER. Fixed by hand the same day; this
module makes it automatic.

## Scope

Eldorado only. PlayerAuctions (a text edit is cancel + create) and G2G are out.
Vault markets (Gameflip / GGSel / Plati) belong to the unclaimed auto-lister.

## When a set rotates — all must hold

1. `autoFarm.noclaimRotateOffers !== false` (default ON; `false` is the kill switch).
2. It runs inside the Eldorado stock tick, so `eldoradoAutoDeliver` is on and
   the Eldorado keys are configured.
3. The set is a no-claim set (`stockSource:"noclaim"`).
4. The set has ≥1 row with `marketplace:"eldorado"`, `noclaimStock:true`,
   `status:"active"`, `autoPaused:true`, `lastError:"paused: no claimable stock"`,
   no `bulkOfferId`, last written ≥ 30 min ago.
5. `noclaimStock.stockForSet(set, { leadMs: sell lead })` has `free === 0` and
   `stale === 0`: no FREE account will still hold the whole bundle a sell lead
   from now — the count the stock sync paused it on (see Expiry). (Until
   2026-10-06 this was
   `covering === 0`. Accounts that are sold or on another listing may still
   hold it; that alone no longer blocks a rotation, because an offer grown to
   a bigger bundle — see Grow below — ends exactly there when the extra drops
   expire.) Real contention is caught by the picker: fewer than 10 free
   accounts for the game, or the same bundle again, is skipped.
6. Some of those rows delivered an order in the last 7 days (`units[].deliveredAt`).
   An offer dead for longer is not brought back at an old price. (R6's offers
   paused since 09-22 stay paused.)
7. No paid Eldorado order is waiting on any of those offers.
8. The picker finds a bundle that differs from the set's items.

## The picker (pure)

- Pool = holdings that are in a bot config, free for the game
  (`noclaimHoldings.freeReason === ""`) and fresh (`isFresh`), counting only
  items of the set's game — and of those only the copies that outlast the
  bundle lead (`noclaimHoldings.durableHoldings`; see Expiry).
- Fewer than 10 such accounts → no bundle.
- An item is "newest" when one of its recorded campaigns is ACTIVE now or ended
  ≤ 72 h ago (`TwitchCampaign` by name). Only newest items are used when any
  exist; otherwise every item of the game.
- Order: active-campaign items first, then most holders, then key.
- Greedy: `minCover = max(10, ceil(pool / 2))`. For each item take the largest
  qty that at least `minCover` of the still-covering accounts hold, then narrow
  the covering accounts to them; skip the item when fewer than `minCover` hold it.

## Applying (per set, ≤ 2 sets and ≤ 6 rows per pass)

1. Target set: an existing no-claim set (last 30 days, same game) with the
   identical item signature (key × qty) is reused; otherwise a new one is made
   with the fields `POST /noclaim-stock/sets` writes. The old set is never
   edited: sold ledgers keep pointing at it.
2. Title / description: `unclaimedAutoList.listingTitle` / `listingDescription`
   (house style, marketplace `"eldorado"`, event-aware classification). Cover:
   `setImage.buildSetGridImage`, uploaded once per set.
3. Per row: the live offer must read `Paused`; `eldoradoUpdateOffer` rewrites
   title, description and cover WHILE PAUSED (price and quantity untouched);
   the read-back title must match and the price must be unchanged.
4. Only then the row is re-pointed by compare-and-set on
   `{_id, set:old, status:"active", autoPaused:true}` → `set`, `requiredDrops`,
   `title`, `description`, `lastError:""`, `note`.
5. Resume exactly like `syncBundleStock`: `stockForListing(row) > 0` →
   `eldoradoRelist`, `autoPaused:false`, `eldoradoSetQuantity`.
6. `SystemEvent` `noclaim_shop/offer_rotated` per row; one Telegram per pass
   that rotated anything.

## Never

Touches a row the owner paused (`autoPaused:false`), an Active offer, a bulk-pack
row, a delisted or sold row, PlayerAuctions or G2G; changes a price; creates an
Eldorado offer; edits a set; runs a second pass concurrently.

## Failure leaves the offer paused

Any error before step 4 leaves the row on its old set and the offer paused
(with its old text, or with the new text but still paused — nothing can be
bought). The next pass sees the same stale set and retries; the target set is
reused, so a retry does not mint a second set. After step 4 a failed resume
leaves `autoPaused:true` on the new set, which the next stock sync resumes.

---

# Grow — a selling offer follows the accounts up

Owner rule, 2026-10-06: *when the accounts hold more than an offer advertises,
the offer is updated to the bigger bundle (same offer, same price, still on
sale).* `utils/noclaimOfferGrow.js`, run right after the rotation in the
Eldorado stock tick.

## Why

The rotation only looks at an offer the stock sync paused. A set that is still
in stock was never looked at again. Measured 2026-10-06: the four Overwatch
offers said "OWCS Stage 3 Asia Kickoff (6 Items)" while 271 of 367 accounts held
those 6 plus 5× "100 Comp Points"; R6's offer said 6× Esports Pack while half
the free accounts held 11×. Every sale shipped the extra drops unadvertised.

The unclaimed auto-rebundle (`unclaimedListingAudit.rebundleAll`) does not cover
these rows: it reads Eldorado rows by `unclaimedGame`, retired 2026-09-28.

## When a set grows — all must hold

1. `autoFarm.noclaimGrowOffers !== false` (default ON; `false` is the kill switch).
2. It runs inside the Eldorado stock tick (see rotation rule 2).
3. The set is a no-claim set with ≥1 row: `marketplace:"eldorado"`,
   `noclaimStock:true`, `status:"active"`, NOT `autoPaused`, no `bulkOfferId`.
4. None of those rows grew in the last 6 h (`rebundledAt`).
5. The picker finds a bigger bundle.
6. No other on-sale Eldorado no-claim set of the game already sells exactly
   that bundle (two deliberately different offers stay different; the bigger
   set is considered first).
7. `noclaimStock.stockForSet` (with the sell lead) counts ≥ 10 free accounts
   for the bigger bundle.

## The picker (pure)

- Holders = free + fresh accounts that hold the whole current bundle — the
  offer's own stock — judged, like everything in this picker, on the copies
  that outlast the bundle lead (see Expiry): a wave about to leave the accounts
  is not "more". Fewer than 10 → nothing.
  `minCover = max(10, ceil(holders × 0.8))` (`GROW_KEEP`).
  (Until 2026-10-07 the bar was half of the game's WHOLE free farm. It froze as
  soon as the farm was two cohorts: ~490 new Overwatch accounts holding only
  the new season's drops put the ~270 behind the offers under half, and the
  offers sat at "12 Items" while their accounts held 17. An offer is a promise
  about its own accounts, so only they are asked; a step can cost at most a
  fifth of the stock.)
- Candidates = items the holders carry, "newest" rule and order as the rotation.
- Greedy over the holders: an item is added, or its count raised, to the
  largest qty that at least `minCover` of the still-covering holders hold.
- The result always contains the current bundle (every item, ≥ its copies).
  Nothing is ever removed: a bundle that expired is the rotation's job.

## Applying (≤ 2 sets per pass; a set's rows always move together)

1. Read every row's live offer. None readable → nothing is touched.
2. Target set as in the rotation (identical signature reused, else created,
   name tagged `auto-grown`). Title / description / cover as in the rotation.
3. **Rows first.** Each row is re-pointed by compare-and-set on
   `{_id, set:old, status:"active", autoPaused ≠ true}` → `set`,
   `requiredDrops`, `note` (ending in "listing text still to update").
   From here every delivery hands out the bigger bundle: a buyer of the old
   text gets more than they paid for, never less. (Text first would let someone
   buy 11 items and be handed 6.) No paid-order check is needed for the same
   reason, and the offer is never paused.
4. **Then the text**, per row: `eldoradoUpdateOffer` (title, description, cover;
   price and quantity not sent), title read back, price unchanged. On success
   the row gets `title`, `description`, the clean `note`, `rebundledAt`.
5. Quantity: `stockForListing` for the moved row → `eldoradoSetQuantity`,
   `qtyTarget` (Active offers only).
6. `SystemEvent` `noclaim_shop/offer_grown` per row; one Telegram per pass.

An offer the OWNER paused (Paused on Eldorado, `autoPaused:false`) is moved and
re-texted with its ladder but not resumed.

## Failure

A text edit that fails leaves the row on the bigger set with the marker in its
`note`; the next pass finds the marker and only redoes the text (no new set).
Until then the offer under-advertises, exactly as before this existed.

## When the extra drops expire

No free account holds the grown bundle → the stock sync pauses the offer → the
rotation (rule 5 above) moves it to the bundle the free farm holds now, after
its usual 30 minutes. So a grown offer costs one short pause per expiry — a day
BEFORE the copies go, never after (see Expiry below).

## Never

Removes an item or lowers a count; changes a price; pauses or resumes an offer
the owner paused; touches a bulk-pack row, a sync-paused row, PlayerAuctions,
G2G or a vault market; edits a set.

---

# Expiry — an offer never promises what is about to leave the accounts

Owner rule, 2026-10-10: *"this cannot happen again"* — after Eldorado order
`588d88a3` was paid for a bundle no account held any more, and was disputed.

## What happened

An earned, unclaimed drop leaves the inventory **7 days after its campaign
ends**, on every account at once. Measured on five Rainbow Six waves in a row:
the first Gameflip unit came off sale as "part of its bundle expired" at 05:48,
05:21, 05:25, 05:26 and 05:22 UTC on 09-30, 10-03, 10-05, 10-07 and 10-10 — each
wave had ended at 04:58 UTC exactly seven days earlier (two confirming reads
20 minutes apart account for the gap).

The holdings snapshot learned that one account at a time: a row is trusted for
`maxAgeHours` (8) and not re-read for half of that. On 2026-10-10 the offer
"OL' CLANKER + 14× Esports Pack 26 Stage 2.1" (grown to 14× the day before,
18 hours ahead of wave 12's expiry) kept an advertised quantity for 3 h 55 min
after those three packs had gone, shrinking one re-read at a time until the
sync paused it at 08:53 UTC. The buyer paid inside that window.

## The rules (`utils/noclaimHoldings.js`)

1. **Copies are kept per campaign.** `NoclaimHolding.items[].waves` =
   `[{ campaign, qty }]`, summing to the item's `qty`. "14× Esports Pack" is
   3 of wave 12 + 3 of 13 + 4 of 14 + 4 of 15.
2. **A copy is gone at `TwitchCampaign.endAt + claim window`** (7 days), matched
   by campaign name and game. Not known → it counts until a read shows it gone:
   no campaign of that name, no end date, a row stored before waves were kept,
   or a copy still seen more than 6 h after its campaign should have taken it
   (a re-used name, or a rule we do not know — inside the 6 h a late sighting is
   Twitch clearing up slowly and is not believed).
3. **Stock is counted on the copies still there at a moment**
   (`durableItems`, `noclaimStock.scanSet({ leadMs })`):
   - *now* — every count and every claim's shortlist. A row read before an
     expiry stops counting the expired copies at the expiry, not when it is
     next read. This alone closes the four-hour hole, on every market.
   - *now + sell lead* — what a claim-at-sale offer may ADVERTISE
     (`stockForListing`). Eldorado: **24 h**, so the offer comes off sale a day
     before a wave goes and every buyer has a day to claim what they were sold.
     PlayerAuctions / G2G (no rotation to move them on): 1 h.
   - *now + sell lead + 12 h* — what the rotation and the grow may BUILD a
     bundle from, so a rewritten offer is not paused by the next sync.
   A paid order is still claimed on what the accounts hold *now*: one that lands
   between the lead and the pause is filled in full.
4. **The rotation asks the same question as the sync** (`stockForSet` with the
   sell lead), or it would see "still held" and leave the offer paused until the
   copies were really gone.

Settings (autoFarm, read on every snapshot build — no restart):
`noclaimExpiryAware` (`false` = the old behaviour), `noclaimClaimWindowHours`
(168), `noclaimSellLeadHours` (24; never under 1).

## When the prediction is wrong

Two nets, so a wrong or missing end date costs minutes, not hours:

- **Losses nobody predicted.** When 3 different FREE accounts are read short of
  the same item within 30 minutes and no campaign end explains it, every holder
  of that item read before them is flagged (`recheckAt`). A flagged row is not
  fresh — it counts as no stock, though it stays on a paid order's shortlist —
  and is read first; a drain re-reads them at once (`refreshBudget` a pass). An
  account read as holding nothing at all is not evidence, and a forced re-read
  never empties a row: Twitch answers an empty inventory now and then, and that
  answer is left for the regular sweep to confirm.
- **A paid order that finds no account** (`eldoradoFulfiller.holdShortOffer`).
  When the claim read accounts and found them short, every on-sale Eldorado row
  of the set is paused at once, the way the stock sync pauses an empty one, and
  the holders of the set's items are flagged. When nothing was read at all
  (the last accounts went to another order) the rows are paused without a
  flag. When the scan host simply did not answer, nothing is paused: the order
  ships on the next tick that reaches the accounts.

`SystemEvent` `noclaim_shop/recheck_flagged` (warn) for every flag.

## Never

Shortens what an account is believed to hold on a forced re-read's empty
answer; pauses an offer because the scan host was unreachable; counts a copy
for an offer inside its sell lead; delivers a different bundle than the one
the row sells.
