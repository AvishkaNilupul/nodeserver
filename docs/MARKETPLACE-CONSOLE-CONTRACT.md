# Per-marketplace console — build contract

Frozen 2026-09-09. Written after four delivery bugs in one week that were all
found by the owner noticing, not by the system reporting: G2G auto-delivery had
never once worked, a G2G send resolved without arriving, PlayerAuctions shipped
11 accounts for a $5 order, and a PlayerAuctions rent-farm order would have
shipped 1 account for a 2-unit sale.

**Every one of them was invisible.** The 11-account over-delivery wrote no
`SystemEvent` at all. Nothing anywhere records what we actually SENT to a buyer.
The goal here is that the next one is a row on a page instead of a discovery.

## The one-line requirement

> For each marketplace, a category you can go into and see: what sold, what was
> sent, price history, errors — everything about that platform, so debugging the
> next problem starts from a page instead of a script.

## Non-negotiables

1. **READ-ONLY UI.** The console never publishes, delists, reprices, provisions
   or delivers. Same rule as the health page: a monitor that mutates is a
   monitor nobody dares open.
2. **Capture is best-effort and MUST NEVER break a delivery.** Every
   `logMarketEvent` call is wrapped so a logging failure cannot fail an order.
   This is the same contract as `utils/systemLog.js`. A delivery that works and
   logs nothing is bad; a delivery that fails because logging threw is
   catastrophic.
3. **NO PASSWORDS IN THE LOG.** Message bodies are stored REDACTED. See
   *Redaction* below. This is not optional and not configurable.
4. **Atlas is bytes-bound** (shared tier, `allowDiskUse` disabled — see
   `reference_atlas_no_diskuse`). Every list endpoint is cursor-paginated with a
   hard cap, every query is covered by an index, and no endpoint ever returns an
   unbounded array. No `$group` over a large collection.
5. **No marketplace fan-out.** The console reads our own database. It does not
   poll marketplaces to render a page (`feedback_live_market_safety`).
6. **Z2U is excluded** — no capture, no tab.
7. **G2G stops at delivering.** Capture the auto-send and the mark-delivering /
   mark-delivered calls. Do NOT add a confirm-delivery step; the owner completes
   that by hand deliberately.

## Part 1 — `models/MarketplaceEvent.js` (new)

A separate collection from `SystemEvent`, deliberately:
- `SystemEvent` is documented as "kept small… NEVER a secret" and has a 90-day
  TTL. Message bodies are bigger rows and would bloat a collection that every
  other subsystem shares.
- The console needs `{market, kind, at}` indexes that would not earn their keep
  on `SystemEvent`.
- `SystemEvent` has no `market` field at all, which is exactly why per-market
  filtering is impossible today.

`SystemEvent` keeps its job (system-wide audit). This is the marketplace-money
trail.

```js
{
  at:        Date,    // indexed, TTL 120 days
  market:    String,  // "gameflip" | "digiseller" | "ggsel" | "zeusx" |
                      // "eldorado" | "playerauctions" | "g2g" | "funpay"
  kind:      String,  // see the table below
  severity:  String,  // "info" | "warn" | "error"
  actor:     String,  // "playerauctions-fulfiller" | "autolister" | "admin:<id>"

  orderId:   String,  // marketplace order id, as the marketplace writes it
  externalId:String,  // offer / listing id on the marketplace
  listing:   ObjectId,// MarketplaceListing._id when known
  game:      String,
  title:     String,  // offer title, truncated to 160

  qty:       Number,  // ACCOUNTS (never an item count — see paQuantity)
  priceUsd:  Number,  // unit price at the time
  paidUsd:   Number,  // what the buyer actually paid, total
  netUsd:    Number,  // what we receive after fees, when the market says

  accounts:  [String],// LOGINS ONLY. Never a password, never a token.
  channel:   String,  // "chat" | "order-message" | "attached-content" | "api"
  message:   String,  // REDACTED body, max 2000 chars
  ok:        Boolean,
  error:     String,  // max 400
  meta:      Mixed,   // small
}
```

`kind` values, and what each answers:

| kind | the question it answers |
|---|---|
| `order_seen` | when did we first see this paid order? |
| `sold` | what sold, for how much, how many accounts |
| `message_sent` | **what did the buyer actually receive**, verbatim (redacted) |
| `delivered` | when did we mark it delivered, and did the market accept |
| `price_changed` | what was the price before and after, and why |
| `listed` / `delisted` | when did this offer go on/off sale |
| `stock_synced` | quantity we pushed to the marketplace |
| `error` | anything that failed, with the reason kept whole |

Indexes — exactly these, no more:
```
{ market: 1, at: -1, _id: -1 }        // the console's main list query
{ market: 1, kind: 1, at: -1 }        // a category inside a market
{ orderId: 1, at: -1 }                // "show me everything about this order"
{ at: 1 }, expireAfterSeconds: 120d   // TTL, doubles as the ascending index
```

## Part 2 — `utils/marketplaceLog.js` (new)

```js
logMarketEvent(evt)            // best-effort write, never throws
redactSecrets(text, secrets)   // returns text with every secret masked
orderTrail(orderId)            // every event for one order, oldest first
```

### Redaction — the load-bearing part

A delivery message contains `login:password`. Storing that verbatim would turn
the console into a credential dump rendered in a browser.

`redactSecrets(text, secrets)`:
- replaces every string in `secrets` (the passwords the caller is about to send)
  with `••••••••`, longest first so a password that contains another is not
  half-masked;
- then applies a belt-and-braces pass for common credential shapes
  (`password: X`, `pass — X`, `Пароль: X`) in case a caller forgets to pass one;
- never stores a string it could not confirm was processed — if `secrets` is
  empty AND the text matches a credential shape, store the shape with the value
  masked, not the raw text.

Logins ARE kept: they identify which account went to which buyer, which is half
the debugging value, and they are not secret (they are printed on the listing).

**The full password is always recoverable from the account record**, so nothing
is lost for debugging — only the copy in the log is removed.

## Part 3 — capture points

Wire `logMarketEvent` in. One small edit per site; do not restructure the
fulfillers.

| file | events |
|---|---|
| `utils/playerauctionsFulfiller.js` | `order_seen`, `sold`, `message_sent` (per message, in `handOver`), `delivered`, `error` |
| `utils/playerauctionsFarmService.js` | `order_seen`, `sold`, `message_sent`, `delivered`, `error` + the `suspect` unit-count warning |
| `utils/eldoradoFulfiller.js` | same set |
| `utils/eldoradoFarmService.js` | same set |
| `utils/g2gFulfiller.js` | `order_seen`, `sold`, `message_sent` (the SendBird body), `delivered` (mark-delivering / delivered ONLY), `error` |
| `utils/g2gFarmService.js` | same set |
| `utils/gameflipFulfiller.js` | `sold`, `delivered` (content attached pre-sale → `channel: "attached-content"`), `error` |
| `utils/digisellerFulfiller.js`, `utils/ggselFulfiller.js`, `utils/funpayFulfiller.js` | `sold`, `delivered`, `error` |
| `utils/autoLister.js`, `utils/unclaimedAutoList.js`, `scripts/reprice-listings.js` | `listed`, `delisted`, `price_changed` |

Rules for every call site:
- `await logMarketEvent({...}).catch(() => {})` — or the helper swallows it
  itself; either way the delivery path cannot be affected.
- Log the message **after** the send resolves, recording `ok` — and for G2G,
  `ok` means the read-back verification passed, not that `sendUserMessage`
  resolved. That distinction is the whole point of `__g2gChatDropped`.
- `qty` is always ACCOUNTS. If you are tempted to write an item count here,
  re-read `tests/paQuantity.test.js`.

## Part 4 — `routes/marketplaceConsoleRoutes.js` (new)

Superadmin + 2FA, mirroring `routes/systemHealthRoutes.js`.

```
GET /api/market-console/summary
    -> per market: counts for the last 24h/7d, last event at, open errors,
       live listing count, undelivered order count. Cheap: countDocuments on
       indexed fields, cached 60s in memory.

GET /api/market-console/:market/:category?cursor=<c>&limit=<n>&q=<text>
    categories: orders | deliveries | prices | errors | listings | health
    -> { items: [...], nextCursor, hasMore }
    limit default 25, hard max 100.

GET /api/market-console/order/:orderId
    -> the full trail for one order, oldest first, hard cap 200 rows.
```

**Cursor pagination, never `skip`.** `skip` on a large collection makes Mongo
walk everything it skips — the exact bytes-bound cost this codebase keeps
hitting. Cursor is `<at ISO>|<_id>`; the query is

```js
{ market, ...(kinds && { kind: { $in: kinds } }),
  $or: [ { at: { $lt: curAt } }, { at: curAt, _id: { $lt: curId } } ] }
```
sorted `{ at: -1, _id: -1 }`, `.limit(limit + 1)` to compute `hasMore`.

`listings` and `health` read `MarketplaceListing` / the latest
`SystemHealthRun` rather than `MarketplaceEvent`, same pagination shape.

## Part 5 — `public/market-console.html` (new)

- Marketplace cards on the landing view (name, status dot, 24h sold, open
  errors, last event). Click a card → that market's categories.
- Inside a market: tabs for Orders / Deliveries / Prices / Errors / Listings /
  Health.
- **Load 25 rows at a time**, with an explicit "Load more" button AND an
  IntersectionObserver auto-load. Never fetch a whole category.
- A row expands in place to show its detail; the message body is shown in a
  `<pre>` with the mask visible, plus a note saying the password is masked by
  design and where to find it.
- Clicking an order id anywhere opens the **order trail** — every event for that
  order across kinds, oldest first. This is the debugging view the whole thing
  exists for.
- Theme, header and auth handling copied from `public/system-health.html` so it
  looks like one product.
- Link both ways: a "Console" link on the health page, a "Health" link here, and
  an entry in `public/admin-nav.js` next to System health.

## Part 6 — keep what is already there

`utils/systemHealth.js`'s 18 checks stay exactly as they are. The console's
`health` category renders the existing per-check results **filtered to that
market** (`connector.<market>`, plus any check whose evidence names it). Nothing
in `systemHealth.js` is rewritten; the console reads `SystemHealthRun`.

## Testing

- `tests/marketplaceLog.test.js` — redaction never leaks a password (including a
  password that is a substring of another, and one containing regex
  metacharacters); the logger swallows a DB failure; `qty` is documented as
  accounts.
- `tests/marketplaceConsole.test.js` — cursor paging returns each row exactly
  once across pages with no gaps and no repeats; `limit` is capped; an unknown
  market is rejected; z2u is rejected.
- Both must pass before deploy, alongside the existing suite.
