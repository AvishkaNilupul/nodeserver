# One sale per game per account — the sold-game guard

## Why

On 2026-09-29 the auto-lister put an account on ZeusX for one MARVEL Contest
of Champions set. Six minutes earlier, a Gameflip listing had delivered that
same account for a *different* MCOC set. The Gameflip buyer connected MCOC the
next day, which took every MCOC drop on the account, including the ones the
ZeusX offer promised. A ZeusX buyer would have received nothing.

How it got through:

- Reservation is per drop. A sale stamps `soldAt` only on the sold set's
  drops, so the account's drops for the *other* MCOC set still read as free
  (`AVAILABLE_DROP`).
- `utils/listedLogins.js` keeps one account on one *live* listing. A sold row
  is not live, so once the Gameflip row turned `sold` the account looked free.

A read-only sweep of the live listings found the same shape on other offers
too, including Eldorado units whose game Gameflip had already delivered.

## The rule

> An account is sold **once per game**. Once any drop of game G on an account
> is committed (`DropLog.soldAt` set), the account is not committed to
> anything else of game G.

- **Committed** means `soldAt != null`, whatever the tag or set. That covers:
  - a live listing's reservation;
  - a claim-at-sale market's delivered unit (Eldorado, G2G, PlayerAuctions:
    a buyer already paid);
  - a Shop, bulk or manual sale;
  - a reservation left behind by a taken-down listing.
- **Same game** means the same game part of `itemKey` (`name|game`, lowercased;
  see `twitchInventory.itemKeyFor`). Rows with an empty itemKey fall back to
  `DropLog.game`, lowercased and trimmed.
- **The same set counts too.** A commitment for S blocks a second commitment
  for S. A reservation stamps every free copy of the set's items anyway, and
  the first buyer's game link takes them all. Delist → republish, refunds and
  the Gameflip relist chain are unaffected: each one releases first, or claims
  a fresh account.
- **The call's own stamp is not foreign.** The post-stamp check in
  `reserveSetOnAccount` ignores rows carrying its own `soldAt`.
- **Other games are untouched.** Selling an account's Overwatch drops to one
  buyer and its Rainbow Six drops to another is the owner's accepted model
  (2026-07-21; `gameflipFulfiller.releaseAccount` documents it), and the guard
  does not change it.
- **Twins:** one Twitch login can have two `BotAccount` records
  (`utils/accountTwins.js`). The guard reads every record of the login.

## Where it applies

One implementation: `utils/soldGameGuard.js`.

1. `dropReservation.reserveSetOnAccount`: the commit point every claimer goes
   through. It refuses before stamping, then checks again after stamping and
   rolls back if a concurrent claim of the same game won the race. When the
   read fails, it does **not** sell.
2. `shopRoutes.availableAccountsForSet`: stock counts and picks for the Shop,
   every fulfiller, G2G, Eldorado, PlayerAuctions, bulk orders and bulk packs.
   Advertised quantities therefore stop counting accounts that cannot be sold.
3. `autoLister.pickDeliveryAccounts`: the auto-lister's own picker. Without
   this it would only lose the race at reserve time and list fewer units.
4. `dropReservation.liveUnits`: the filter every hand-over of a
   **pre-reserved** unit goes through (G2G `freshFreeUnits`, Eldorado,
   PlayerAuctions), plus the stock counts built on it. Such a unit was
   reserved at publish and is handed over later with no new claim, so items
   1–3 never see it again. This check is narrower: a unit is dropped only when
   a **different tag** holds the same game on the account (another market sold
   it or lists it). A unit whose own reservation cannot be found (a row
   rewritten to a new set id) is not judged. `foreignHeldUnitAccounts` /
   `foreignHeldFromRows`.

Items 1–3 use `sameGameTakenAccounts` / `takenFromRows`.

**Opt-out:** `reserveSetOnAccount(id, set, { alreadyCommitted: true })` skips
the guard. It is used only where the call records a commitment that already
exists, not a new sale:

- `guardianFixes.fixReserve`: re-reserves an account that is already on the
  listing.
- `bulkPacks/loop.deliveredAfterRelease`: records a delivery that already
  happened.
- `digisellerFulfiller.retireManualAccounts`: freezes accounts the owner listed
  by hand.

## Expected effect

Before building, the stock it would remove was measured read-only. The staged
code was then rehearsed against every active listing, comparing the claimer's
own count (`g2gFulfiller.realStockFor`) with the current code:

- A few percent of free account/game pairs stop counting as stock. Nearly all
  of them have the same game already sold or committed elsewhere.
- Claim-time shelves (Eldorado, G2G, PlayerAuctions) advertise somewhat less.
  A handful of small offers drop to 0, and their stock sync pauses them.
- Accounts whose game was connected by someone without a reservation were
  negligible, so that signal is not part of the rule.

## Tests

- `tests/soldGameGuard.test.js`, 15 tests:
  - the pure decision;
  - the 09-29 sequence against a real in-memory MongoDB: Shop/fulfiller
    stock, the commit point, and the auto-lister picker;
  - cross-game still sells, refunds give the game back, legacy and hand sales
    count, twins;
  - the `alreadyCommitted` opt-out, the race path, an unreadable check;
  - the pre-reserved-unit hand-over.
- Mutation checks:
  - Switching `sameGameTakenAccounts` off makes 5 fail: 09-29, refund, legacy,
    twins and race.
  - Switching `foreignHeldUnitAccounts` off makes the unit test fail.
- Full suite (`node --test "tests/*.test.js"`, Node 26): the same failures as
  the base commit before this change; none new, none fixed.

## Files

`utils/soldGameGuard.js` (new), `utils/dropReservation.js`,
`routes/shopRoutes.js`, `utils/autoLister.js`, `utils/guardianFixes.js`,
`utils/bulkPacks/loop.js`, `utils/digisellerFulfiller.js`.

## Not in scope

- Listings that already held a sold account when this shipped. Taking an
  offer down is a marketplace action, and it waits for the owner.
- The unclaimed / no-claim engines (`noclaimStock`, `autofarmStock`). They
  already sell one account to one buyer, whole.
- Account listings (`suppliedStock`): pasted credentials, no DropLog.
