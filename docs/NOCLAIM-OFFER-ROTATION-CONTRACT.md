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
5. `noclaimStock.stockForSet(set).covering === 0`: NO in-config account holds
   the whole bundle any more. Zero free stock while accounts still cover it is
   contention, which a new bundle cannot fix — left alone.
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
