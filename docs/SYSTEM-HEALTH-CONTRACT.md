# System health + rent-farm coverage — build contract
Frozen 2026-09-09. Written after two paid "Automatic Farming" orders were lost.

## PART A — why Gameflip and GGSel cannot have a farm service like the others

Eldorado, PlayerAuctions and G2G expose an ORDER API: you poll paid orders and
fulfil them. That is why `operatorFarm.farmFreshAccounts` can provision an
account *at sale time* for those three.

**Gameflip and GGSel do not work that way.** Both deliver content that was
attached BEFORE the sale:
- Gameflip: a listing carries one account as an auto-delivered digital code;
  Gameflip hands it over the instant the buyer pays.
- GGSel: `ggselAddProducts` pushes credential strings into the offer's stock.

There is no post-sale hook to provision into. So a straight copy of
`eldoradoFarmService` is impossible for them.

### The live exposure this leaves (measured 2026-09-09)
8 live "Automatic Farming" offers — gameflip 5, ggsel 3 — carry DropSets of
12-44 items and **0 accounts hold the full set**. On sale each falls through to
the ordinary stock fulfiller and fails `Out of stock — no unsold account holds
this whole bundle`. Buyer waits, then cancels: the same outcome as order
e69b19d3, different cause. GGSel additionally has no fulfiller alerting at all.

### The design that DOES work: a pre-provisioned buffer
1. **Publish**: claim a pristine pool account (`operatorFarm`, which now has the
   stack-room fix), pin it to the one game, attach its credentials as the
   listing's delivery content. Do NOT stamp `farmUntil` yet.
2. **Sale detected** (the existing Gameflip sold-listing watcher / GGSel stock
   drain): stamp `RenterAccount.farmUntil = saleTime + days`, so the window the
   buyer paid for starts when they paid — not when we listed. Any farming before
   the sale is a bonus, never a shortfall.
3. **Top up**: publish a replacement so one buffered account is always ready.
4. **Delist / expiry**: release the buffered account back to the pool if the
   offer comes down unsold.

Cost: one rental slot per LIVE offer, not per sale. With 137 free slots that is
affordable; it must still be counted by `utils/rentFarmCapacity.js`.

**Sequencing decision:** the 8 offers are unsellable RIGHT NOW (0 stock). They
come off sale first — that is protective and reversible — and go back up only
when the buffer service is built and tested. Selling what cannot be delivered is
the bug being fixed; leaving them up while building is the same bug with a longer
fuse.

## PART B — the health page

A page that answers "is everything working?" without anyone re-checking by hand.

### Non-negotiables
- **READ-ONLY.** A health check that mutates is a health check nobody dares run.
  No publishing, no delisting, no repricing, no provisioning, no config writes.
- **Every check returns evidence**, not a green tick: the number it measured, the
  threshold it compared against, and when it last ran.
- **Never fabricate certainty.** A check that could not run is `unknown`, never
  `ok`. An offline host is `unknown`, not `fail` — a Pi hiccup must not read as
  a broken marketplace (that distinction already cost a wrong diagnosis once).
- **Cheap.** It runs hourly and must not hammer the Pi or the marketplaces.
  Reuse cached/DB state where possible; live calls only where nothing else can
  answer. Absolutely no fan-out (see `feedback_live_market_safety`).
- Each check declares `severity`: `critical` (money is being lost right now),
  `warn` (will lose money soon), `info`.

### The checks, and the exact question each answers
| id | question | fail condition |
|---|---|---|
| `connector.<market>` | does the API still authenticate? | test call throws |
| `orders.undelivered` | is any PAID order undelivered? | any order paid & not delivered |
| `rentfarm.capacity` | can the next Automatic-Farming order be filled? | total free stack slots = 0 |
| `rentfarm.coverage` | does every live rent-farm offer have a way to be delivered? | an offer on a market with no farm service AND no stock |
| `listings.stale` | is anything selling drops that expired? | any active listing whose advertised items no account holds |
| `listings.overpriced` | is anything priced above what has ever sold? | active, not-paused, price > realised ceiling, excluding platform floors |
| `autolist.running` | is the unclaimed auto-lister still ticking? | last run older than N ticks |
| `bundles.sane` | do bundle titles match their contents? | title item count disagrees with the set |
| `pool.health` | is there sellable stock and usable accounts? | eligible pristine accounts below a floor |
| `pool.tokens` | how much of the pool is inert? | available accounts with no clientSecret |
| `loops.alive` | has each background loop done work recently? | no evidence of a tick within its interval |

### Shape (frozen — the page and the checks agree on this)
```js
{ id, title, group, status: "ok"|"warn"|"fail"|"unknown",
  severity: "critical"|"warn"|"info",
  summary,            // one line a human reads first
  measured,           // the number/thing observed
  threshold,          // what it was compared against
  detail,             // optional longer text
  items: [...],       // optional offending rows, capped at 20
  ms, checkedAt }
```
`runAll()` returns `{ startedAt, ms, checks: [...], counts: {ok,warn,fail,unknown} }`.

### Storage + page
- Persist each run so the page shows history and "last good": one document per
  run, capped collection or TTL — do not grow forever.
- `GET /api/system-health` (superadmin, session auth like every admin route)
  returns the latest run; `?run=1` forces a fresh run.
- `public/system-health.html`: one card per group, colour by worst status inside
  it, each check showing summary + measured/threshold + age. Mobile layout
  (the owner checks from a phone; see the existing pages' `@media (max-width:720px)`).
  `admin-nav.js` for the nav, matching the other admin pages.
- Hourly scheduler in `server.js`, same `setTimeout`-chain + `unref` shape every
  other loop in this codebase uses.

### Testing
Pure functions (status rollup, thresholds, formatting) get real unit tests. Checks
that need the DB/network take injected dependencies so they can be tested without
either. No test may require prod.
