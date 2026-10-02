# Market Radar — contract, data model, safety rules, rollout

Status: **being built 2026-10-02**. Ships DARK (`autoFarm.marketData.enabled` false). Read-only toward every
marketplace: it adds NO request to any market and changes NO listing, price or farm decision.

## Why

Every hour the market-research scanner (`utils/marketResearch.js`) reads, for each due game, the public search
pages of Gameflip (sold + on sale), GGSel and Plati. It counts a few numbers out of them and THROWS THE ROWS AWAY.
Those rows are the only view we have of what other sellers charge, what actually sells, how fast, and who sells it.
The radar keeps them. Verified 2026-10-02 against the live endpoints and production data:

| Source (anonymous, already read hourly) | What a row carries that the scanner discards |
|---|---|
| Gameflip `listing?status=sold` | listing id, seller id, title, price, `created`, `onsale`, `updated` (≈ sale time), seller score / rating / #ratings, platform. **Time-to-sell = updated − onsale, for ANY seller's listing.** The feed only retains ~3 weeks (a busy game: ~10 sold rows). |
| Gameflip `listing?status=onsale` | the same, for live rivals (price, seller, age) |
| GGSel search page (dehydrated JSON) | product id (`id_goods`), `id_seller`, seller name, price (USD), **`cnt_sell` = lifetime units sold (a counter: its deltas are real sales)**, rating, autoselling |
| Plati `search.ashx` | item id, seller id/name/rating, price, **`numsold`** (counter), returns / reviews, a change tick |

Scanner facts (production, 2026-10-02): 268 games, ~418 game-scans a day, median research age 48 h, 25% older than
14 days (games with no campaign and no farming drop out of rescans). Only aggregates are stored
(`MarketResearch.markets`: counts, lowest, median, sellers); rival rows and seller ids are used transiently.

## What it records (new collections only)

* `MarketSale` — one row per observed rival sale. Gameflip: one per sold listing, idempotent on the listing id
  (`gf:<id>`), with price, size, seller, seller score, `onsaleAt`, `soldAt`, `ttsHours`. GGSel / Plati: one per
  counter increase between two observations of the same product (`<market>:<id>:<newCount>`), with the price seen,
  the units, and the window `[prevObservedAt, soldAt]`. TTL 400 days.
* `MarketRival` — one row per rival listing: current price + bounded price history, counter + bounded history,
  seller, first/last seen, `goneAt` (Gameflip only, when the scan was provably complete), `outcome:"sold"` when the
  sold feed later shows it. TTL 150 days after last seen.
* `MarketDataState` — which seller ids are OURS per market (learned from our own listings), nothing else.

## The tap

One call inside `scanGame` (anchored patch on PRODUCTION's copy of `utils/marketResearch.js`, which differs from
the local one) hands the rows it already fetched to `utils/marketData.tap(...)`. The tap:

1. returns at once when the switch is off (one settings read), and never throws into the scan;
2. queues the work (bounded, one job at a time, newest wins when full) and writes in the background;
3. does one `find` + one unordered `bulkWrite` per (game, market); no `skip`, no `allowDiskUse`, every read projected;
4. opens a circuit breaker after 5 consecutive failures (pauses 15 min) so a sick database is never hammered.

`utils/priceScout.js` (also prod-ahead: FunPay removed) gains ADDITIVE row fields so the tap has what it needs
(`id`, `created`, `onsale`, seller score/ratings, counters, ...). Existing consumers ignore unknown keys.

## Rules (each one is a live-market rule or a past mistake)

* **Read-only toward markets; zero extra requests.** The radar only ever sees rows the scanner already fetched.
  (A later phase may add paced extra scans; that needs its own budget and the owner's say-so.)
* **Our own rows are flagged, never counted as rivals.** Every market: our listing ids (`externalId` is the same id
  the public page uses). Gameflip also by owner id — REMEMBERED (`MarketDataState.ownSellers.gameflip`), because
  the scanner passes "" whenever Gameflip throttles the lookup; with no owner id ever known, Gameflip is not
  recorded at all, and learning a new one corrects rows stored before it. GGSel / Plati also by the seller id
  learned from our own listings.
* **Rent-farm windows are a different product** (`marketPricing.classifyKind`) and never enter a price statistic.
* **Comparable means same market + same kind + same size band.** A 148-item "complete collection" is not a
  3-item bundle; bands: 1, 2-3, 4-6, 7-12, 13-30 (the tracker's), then 31-99 and 100+. Our bulk packs (priced per
  pack) and rent-farm rows are never compared with single bundles.
* **A counter is a counter.** The first observation only sets the baseline; only a rise above the HIGHEST value
  ever seen — or already accounted for by a recorded sale — is a sale (so a dip and its return, a stale page, or a
  sale whose rival update failed never count twice); an implausible jump (> 200 units) re-baselines; a counter the
  page did not carry (`soldRaw` null) is skipped, never read as 0.
* **Prices move in the seller's currency.** GGSel / Plati price in roubles; the USD figure drifts with the rate
  every day. A seller's price move is judged on the rouble price (`priceRub`); our GGSel listing is compared at the
  price the market shows for it now, converted at the same rate as the rivals'.
* **Absence is not proof of sale.** `goneAt` is set only for Gameflip, only for a page that was read in full AND
  held rows (an error body relayed through the Pi parses as an empty page), only for that page's own game, and
  only after two consecutive misses. GGSel / Plati rows are judged by `lastSeenAt` staleness alone. A listing keeps
  the game that first saw it.
* **Bounded everywhere.** Queue 50, history arrays capped, loaders limited, TTL indexes, no unbounded `$group`.
* **Nothing here reprices anything.** Output is advice on a page. Manual listings are never touched.
* **Seller names are public marketplace identifiers**; they are never written to logs and the API returns only
  what the page shows.

## Switch (ship dark)

`autoFarm.marketData = { enabled: false }` (settings, audited by `setAutoFarm`). Enable:

```
node -e 'require("./utils/settings").setAutoFarm({marketData:{enabled:true}},{actor:"owner"})'
```

Rollback = set it false (takes effect on the next scan; no restart) or restore the backed-up files.

## API (inside the existing tracker router, same guards: superadmin + 2FA)

`/api/price-tracker/market/overview` · `/market/games` · `/market/game/:key` · `/market/rivals` ·
`/market/sales` · `/market/undercuts` — all read-only, all bounded, cached with stale-while-revalidate.

## Phases

1. **Record + show (this build).** Tap, three collections, analytics, a "Market radar" tab.
2. **Use it.** Feed market-wide realised prices (size-matched, with time-to-sell) into the Games board and the
   suggestion engine as a new evidence source; undercut alerts; campaign playbooks (how fast rivals list and sales
   ramp after a campaign starts). Needs a few days of data first.
3. **Optional extra scanning** (own budget, the owner's decision): deeper pages for the top games, G2G where a
   public search exists. Eldorado and PlayerAuctions are NOT touched from a side process (their session cookies get
   clobbered, see the 09-27 sweep note).

## How it was verified (before any production write)

* **Tests (102, all real-data where it matters):** the pure planner against rows captured live from all three markets
  (sellers anonymised, `tests/fixtures/marketRadar`), the store against a real Mongo (idempotency, a counter rise is
  one sale once, a failed rival write cannot lose or double a sale, per-game gone logic, interleaved games, schema
  validity of everything the planner emits, every read projected/bounded, unique + TTL indexes), the tap's runtime
  contract (off by default, never throws, newest-wins queue, breaker, switch-off drops the queue), both hooks (the
  patcher is all-or-nothing; a failed fetch never looks like a complete page; a scan's stored RESULT is byte-identical
  with the recorder on, off or throwing), the analytics (hand-computed) and the API (guards on every route, no raw
  seller ids leave it).
* **The page** was checked in the browser through `scripts/price-tracker-preview.js` (captured rows vs our real
  listings from a production snapshot): every view, the game sheet, links only to the three public hosts with
  `noopener`, no console error, no horizontal overflow at phone width.
* **On the production box, before the swap:** the radar staged next to production's own modules (and production's
  own patched scanner copies), real database with every write blocked: modules load, the switch reads OFF from the
  real settings, a tap does nothing, every market route answers and is 401 without a session, 0 data writes; the
  five Mongo-free radar suites pass 61/61 on production's Node 20 against production's files.
* **Independent adversarial review (2026-10-02)** found one high and three medium defects, all verified and fixed
  with tests before any deploy: our own Gameflip sales stored as rival sales whenever the owner-id lookup was
  throttled (and never corrected); a Gameflip 429 body relayed by the Pi read as "a complete page with no rivals";
  a counter that dipped and came back recorded phantom sales (57 -> 0 -> 57 = 57 units); the rouble rate showed up
  as rival price cuts / a "price war" and as GGSel undercuts; plus existing rivals read per game only (overlapping
  game names, the 2,000 cap), a failed rival write that could still double a later sale, our bulk packs compared
  with bundles, Gameflip rates inflated on day one (the sold feed already covers ~3 weeks), the game sheet counting
  only 40 sales per seller, stale scans looking rival-free, and one database read per window. A mutation run
  re-introduces each of those 20 defects; every one fails a test.
* Mistakes the testing caught and fixed: a Gameflip fetch failure (turned into `[]` by the scanner) would have
  looked like "a complete page with no rivals" and marked every rival gone after two scans — the scout now sets an
  explicit `complete` flag only on a successful read; a weekly rate extrapolated from a few hours of counter rises
  ("115/wk") — a rate now needs 2 days of watching; rent-farm windows of different lengths were compared as equals —
  they are now excluded from rival counts and undercuts; "we list nothing here" read only what a capped search page
  showed — it now reads our real listings; spreading 40k rows into `Math.min` would overflow the stack — loops.

## Known limits (stated, not hidden)

* The sold feed keeps ~3 weeks, so history begins the day the radar is switched on.
* GGSel / Plati sales are inferred from counter deltas between scans (hours apart), not dated sales.
* A game that is not scanned (no campaign, no farming) is not recorded; coverage is shown on the page.
* Sellers can relist/rename; a listing id is the only stable key, and a relist is a new row.
* Learned GGSel / Plati seller ids (ours) are only ever added; a counter that genuinely restarts under the same
  listing id records nothing until it passes its old high (under-reporting, never invention).
* Gameflip's sold-feed reach (21 days) is a measured constant, not something the API states.
