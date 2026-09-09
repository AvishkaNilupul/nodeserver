# Gameflip rent-farm — the buffered offer, build contract

Frozen 2026-09-09. Requested by the owner: *"we have 100 rental listings, we put
100 accounts into the rental farm and keep them ready, when an order comes for a
specific game and time we already have an account ready, when it's sold we put
another account into that slot and list it again."*

That is the right design, and it is the only one Gameflip permits.

## Why Gameflip cannot work like Eldorado

Eldorado, PlayerAuctions and G2G expose an **order API**: a buyer pays, we see
the order, and `operatorFarm.farmFreshAccounts` provisions a pristine account at
that moment. `utils/eldoradoFarmService.js` and its two siblings do exactly that.

**Gameflip has no post-sale hook.** The account is baked into the listing as an
auto-delivered digital code and handed over the instant the buyer pays. There is
nothing to provision *into*. That is why the five Gameflip rent-farm offers were
taken down: with no farm service they fell through to the ordinary stock
fulfiller and failed `Out of stock — no unsold account holds this whole bundle`.

So the account must be ready **before** the sale. Hence a buffer.

## The one correctness rule that matters most

**The farming window starts when the buyer PAYS, not when we publish.**

`farmUntil` is stamped on sale, never at publish time. An offer may sit in the
buffer for days; if the window started at publish, a buyer who bought on day 6 of
a 120-day offer would receive 114 days and have been overcharged. Farming done
before the sale is a bonus to us and to them, never a shortfall.

This is the single thing most likely to be got wrong by a later edit, so it is
asserted directly in the tests.

## Capacity — the second rule

Every LIVE buffered offer holds one rental slot **continuously**, not one per
sale. Measured 2026-09-09: 200 slots total, **137 free**, 350 eligible pristine
accounts, 56 accounts already carrying a live window.

A 100-offer buffer therefore leaves 37 slots for every on-demand sale on
Eldorado (87 live rent-farm offers), PlayerAuctions and G2G. Running out of
slots is not theoretical: it is what lost order `4b20765f` and what the buyer
cancelled on in `e69b19d3`.

**So the buffer is bounded by a reserve, not only by its target.** It will fill
`GF_BUFFER_TARGET` offers *only while* doing so leaves at least
`RENT_SLOT_RESERVE` free slots for on-demand sales. Below that it stops
publishing, reports the shortfall, and alerts — it never wins a race against a
paid order. The target is a ceiling, the reserve is a floor, and the floor wins.

Defaults: target **100**, reserve **40**. Both live in settings (`autoFarm`)
so they can be changed without a deploy.

## The catalogue

Mirrors what is already live on Eldorado — 29 games × 3 terms, flat ladder:

| term | Eldorado | Gameflip |
|---|---|---|
| 120 Days | $3.00 | **$4.00** |
| 180 Days | $4.00 | **$5.00** |
| 1 Year | $7.00 | **$8.00** |

Gameflip is priced ABOVE Eldorado deliberately. The only hard evidence of
Gameflip rent-farm demand is a Rocket League 180-day offer that **sold at $5.00**
while Eldorado's equivalent was $4.00 — so Gameflip bears a premium, and the
codebase's standing rule is that our own realised price is proof while a rival's
asking price is not ([[project_market_intelligence]]).

## Part 1 — `models/MarketplaceListing` additions

```js
rentFarm:      { type: Boolean, default: false, index: true },
rentFarmGame:  { type: String,  default: "" },
rentFarmDays:  { type: Number,  default: 0 },
rentFarmPoolId:{ type: String,  default: "" },   // the buffered pool account
```

An explicit flag, NOT a title regex. Every other rent-farm service parses the
title because it is reading an order from a marketplace and has nothing else;
here we create the row ourselves and can simply say what it is. A title regex
would also misfire on a hand-made listing the owner names similarly.

## Part 2 — `utils/gameflipFarmService.js` (new)

```
topUpBuffer({ dryRun })   fill the buffer up to target, respecting the reserve
onBufferedSale(row)       a buffered offer sold: start the window, record it, refill
releaseBuffered(row)      an unsold offer came down: hand the account back
bufferState()             what the tracker renders
```

### `topUpBuffer`

1. Read the desired catalogue (29 games × 3 terms), and count live buffered
   offers per (game, term) from `MarketplaceListing`.
2. Compute how many are missing, capped by the target.
3. **Check the reserve before every publish**, not once at the start: publishing
   is slow and a concurrent sale elsewhere can consume slots mid-run.
4. For each: claim ONE pristine pool account via `operatorFarm.farmFreshAccounts`
   with `days: BUFFER_WINDOW_DAYS` (**365**).

   `days: 0` is not available — `farmFreshAccounts` rejects any non-positive
   window outright (`"A positive farming window in days is required."`), and it
   is right to: every other caller is filling a real order. So a buffered
   account is provisioned with a deliberately long window and the real one is
   stamped at sale.

   While the offer sits unsold, `farmUntil` means "how long WE keep farming
   this", not a buyer's entitlement — nobody has bought anything yet. A year is
   long enough that no buffered account is ever torn down by `renterExpiry`
   while its offer is live, which is the failure that would matter: a live offer
   whose account has been reclaimed sells a dead account.

   On sale it is re-stamped to `now + rentFarmDays`, which for a 120-day term is
   SHORTER than the 365 — that is correct and intended. The buyer paid for 120
   days from their purchase, not for whatever remained of our placeholder.
5. Publish to Gameflip with the account's credentials as the delivery code, and
   create the row with `rentFarm: true` and the pool id.
6. If the publish fails, hand the account straight back (`releaseBuffered`).

Bounded per pass (`GF_BUFFER_PER_PASS`, default 5): publishing is rate-limited
and a hundred publishes in one tick is how the limiter gets tripped.

### `onBufferedSale`

Called by `utils/gameflipFulfiller` when a `rentFarm: true` row goes `sold`.

1. **Claim atomically** — the same conditional `findOneAndUpdate` the sold-row
   lane already uses, so two overlapping passes cannot both process one sale.
2. **Re-stamp** `RenterAccount.farmUntil = now + rentFarmDays` — the buyer's
   window starts HERE, replacing the 365-day buffer placeholder. It moves DOWN
   for every term, which is the point: they paid for N days from purchase.
3. Create a `FarmServiceOrder` row (`market: "gameflip"`, state `delivered`,
   the account, the days) so the sale is visible to `orders.undelivered`, the
   console and every other consumer that already understands that model. Gameflip
   has delivered the credentials itself, so the row is created already delivered
   — it is a record, not a queue entry.
4. Leave the top-up to the next `topUpBuffer` pass rather than publishing inline:
   a replacement published inside the sale handler would run inside the watcher's
   tick and share its failure.

### Routing — the change in `gameflipFulfiller`

`syncOnce` currently sends every sold `autoDeliver` row with `qtyRemaining > 0`
to `publishAutoDelivery`, which needs an account holding a whole DropSet. A
rent-farm row has no DropSet, so it MUST be routed away before that:

```js
if (row.rentFarm) { await gfFarm.onBufferedSale(row); continue; }
```

placed above the existing `if (!row.autoDeliver) continue;`.

## Part 3 — the tracker, in the Gameflip console category

A `rentfarm` tab, gameflip-only (`EXTRA_TABS.gameflip`), showing per (game, term):

- live buffered offers, and whether each has a healthy backing account;
- sold-and-served, with the window end date;
- **missing** — wanted but not published, and WHY (no pristine account / reserve
  floor reached / publish failed), because "nothing here" must never be
  indistinguishable from "everything is fine";
- slot accounting: target, live, free slots, reserve.

## Part 4 — health

One check, `gameflip.rentfarm`:

- `fail` when a buffered offer's backing account is gone, suspended, or sold
  elsewhere — that offer takes money and delivers a dead account;
- `warn` when the buffer is below target because the reserve floor was hit
  (expected, but the owner should know the buffer is shrinking);
- `warn` when a sold buffered offer has no `farmUntil` — the window never
  started, so the buyer is not getting what they paid for;
- `ok` otherwise, always reporting live/target and free slots.

## Non-negotiables

1. **Never publish below the reserve.** An unsold buffered offer is worth less
   than a paid order we cannot fill.
2. **`farmUntil` on sale, never on publish.**
3. **One atomic claim per sale**, matching the sold-row lane.
4. **A failed publish releases the account immediately** — a pristine account
   held by a listing that does not exist is the leak this codebase has hit
   repeatedly.
5. **Delisted or expired unsold ⇒ the account goes back to the pool.** The
   watcher's retire path already fires for `expired`/`cancelled`/404; it must
   call `releaseBuffered` for a `rentFarm` row rather than the DropSet-scoped
   `releaseAccount`.
6. Bounded work per pass, everywhere.
