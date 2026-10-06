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
5. `noclaimStock.stockForSet(set)` has `free === 0` and `stale === 0`: no FREE
   account holds the whole bundle any more. (Until 2026-10-06 this was
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
  items of the set's game.
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
7. `noclaimStock.stockForSet` counts ≥ 10 free accounts for the bigger bundle.

## The picker (pure)

- Pool = the rotation's pool: free + fresh holdings with any drop of the game.
  Fewer than 10 → nothing. `minCover = max(10, ceil(pool / 2))`.
- Holders = pool accounts that hold the whole current bundle. Fewer than
  `minCover` → nothing (a bundle already held by under half the free farm is
  never narrowed further — without this the stock would halve on every pass).
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
its usual 30 minutes. So a grown offer costs one short pause per expiry.

## Never

Removes an item or lowers a count; changes a price; pauses or resumes an offer
the owner paused; touches a bulk-pack row, a sync-paused row, PlayerAuctions,
G2G or a vault market; edits a set.
