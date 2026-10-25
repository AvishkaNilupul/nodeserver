# Code shop — the Listings board (2026-10-25)

Owner, 2026-10-25: "make a tab in both those systems … where it's listed and
where it's being sold … a good view with game images, cards … so I can watch
everything properly organized".

One read-only page of everything both farms earned and sell: per game, which
campaign each code came from, where each bundle is listed (Eldorado,
PlayerAuctions, with links), what is on sale now, and what sold where, when
and for how much. It is a **Listings** tab in `/soop.html` and in
`/chzzk.html`: the same code in both, opening on that panel's own farm.

Nothing on the board changes anything. It never shows a code.

## Files

| File | What |
| --- | --- |
| `utils/codeShop/board.js` | `createBoard(deps)` → `{ build({ days, sales, tz }) }`, the read model |
| `routes/codeShopRoutes.js` | `GET /api/code-shop/board` (one route, same `route()` wrapper as the rest) |
| `public/shop-board/board.js` | `window.ShopBoard.mountTab(kit, { farm })` — the whole UI, kit = `Soop` or `Chzzk` |
| `public/shop-board/board.css` | the board's own classes (`sb-*`), built on the panels' tokens |
| `public/soop/tab-listings.js`, `public/chzzk/tab-listings.js` | one call each |
| `public/soop.html`, `public/chzzk.html` | tab button + panel root + stylesheet + two scripts |
| `tests/codeShopBoard.test.js` | the read model and the route |
| `scripts/shop-board-harness.js` | both panels on an in-memory database, for looking at it |

## `GET /api/code-shop/board`

Superadmin (the router's `requireSuperadmin`); `CODE_SHOP=0` answers 503 like
every code shop route. Query: `days` = length of the daily sales chart
(default 14, 1–60), `sales` = length of the sales feed (default 80, 1–300),
`tz` = the viewer's IANA time zone (default and fallback `UTC`). Out-of-range
or empty values fall back or are clamped, never an error. One answer per
(days, sales, tz) serves every caller for 15 s (both panels poll; a read in
flight is shared); a failed read is not kept.

```
{ success, now, tz,
  config:   { markets: { eldorado, playerauctions }, autoPublish, expiryLeadHours },
  totals:   { codes: COUNTS, units: { available, fed, sold }, listings: LISTINGS,
              revenue: MONEY, salesCount: MONEY-shaped counts },
  sources:  [{ id: "soop"|"chzzk", name, logins, codes: COUNTS, revenue: MONEY, lastEarnedAt }],
  markets:  [{ id, name, on, listings: LISTINGS, unitsOnSale, sold: { units, codes, usd, lastAt } }],
  games:    [{ key, gameNo, gameNos, name, cover, banner, sell, sellOff, sources, codes: COUNTS, revenue: MONEY,
               lastSoldAt, nextUseBy, products: [productId],
               campaigns: [{ groupKey, source, title, banner, startAt, endAt, codes: COUNTS,
                             revenue: MONEY, lastSoldAt, nextUseBy,
                             rewards: [{ slotKey, label, nameRaw, image, codes: COUNTS, nextUseBy }] }] }],
  products: [{ id, name, title, status, kind, origin, gameNo, sources, groupKeys,
               rewards: [{ slotKey, label, image }], priceUsd, useBy, markets,
               units: { available, fed, sold, removed },
               listings: [{ market, url, externalId, status, state, price, autoPaused, lastError }],
               sold: { units, codes, usd, lastAt, bySource: FARMS,
                       byMarket: { <market>: { units, usd, lastAt, bySource: FARMS } } },
               createdAt }],
  sales:    [{ id, product, productName, gameNo, market, orderId, soldAt, usd, codes, dead, sources,
               bySource: { soop: { usd }, chzzk: { usd } } }],
  daily:    [{ day: "YYYY-MM-DD" (in `tz`), rows: [{ market, units, usd, soop: { units, usd }, chzzk: { units, usd } }] }] }

COUNTS   = { inStock, onSale, inVault, sold, expiring, expired, held, dead }   (codes)
MONEY    = { d1, d7, d30, all }                                               (USD, cents)
LISTINGS = { live, paused, down, error }
FARMS    = { soop: { units, usd }, chzzk: { units, usd } }
```

**Per farm.** A bundle can hold codes of both farms (a custom bundle of one
game). Per-farm `units` count a bundle under every farm it has codes from;
per-farm `usd` is that farm's codes' share (`saleUsd`) of the money. So a
farm's numbers always match its campaigns' revenue, and only "all farms"
(`units`, `usd`) counts a two-farm bundle once with its whole price.

Rules the read model keeps:

- **Read-only, whitelisted.** Every read names the fields it keeps. Never a
  code, `codeHash`, `codeShape`, `codeEnc`, unit password or cookie. Units are
  counted, never read.
- **Bounded memory** (Atlas-safe, no `allowDiskUse`): every `$group` key is a
  slot, a product+market, a sold unit, a login or a day; the feed sorts after
  grouping with a `$limit` straight behind the `$sort` (top-k).
- **Source** of a ledger row = its `loginId` (`chzzk:` prefix → `chzzk`, else
  `soop`); of a campaign = its `groupKey` (`:chzzk-` → `chzzk`); of a product =
  its `groupKeys` (a custom mix can list both); of a sale = the logins of the
  codes in that bundle.
- **Counts** follow `views.summaryOf`: `onSale` = `in_unit` with unit status
  `available`, `inVault` = `in_unit` + `fed`. Revenue = the codes' `saleUsd`
  of rows in `sold`/`dead`, by `soldAt` (d1/d7/d30 = the last 1/7/30 days).
- **Games** are built per `gameNo` (Overwatch `12` holds both farms). Name:
  `config.games[gameNo].displayName`, else the newest ledger `gameName`, else
  the product's, else `Game #<n>`. Then one card per name: two numbers with
  the same name (CHZZK's Black Survival ER `9217747` and SOOP's `18` are both
  "Eternal Return") merge; `key` = the normalized name, `gameNos` = every
  number, `gameNo` = the one holding the most codes on its own. The name key
  keeps letters and digits of every script ("오버워치 2" and "배틀그라운드 2" stay
  apart); a name without a letter never merges. `sellOff` = the numbers that
  do not sell: named in `config.games` with `sell !== true`, or never named
  while `sellNewGames` is off (when it is on, the planner adds a new game by
  itself the first time it has a bundle). `sell` = none is off.
- **Cover** = Twitch box art (`TwitchCampaign.boxArt`, `{width}x{height}` →
  `285x380`) of the first of displayName / marketGame / ledger game names that
  matches a Twitch game name (case and punctuation ignored, then once more
  without a trailing number: "Overwatch 2" → "Overwatch"), plus a short alias
  list ("Black Survival Eternal Return" → "Eternal Return"). Read once an hour.
  No match → `""` (the page draws a monogram tile).
- **Banner** of a campaign = `SoopCampaign.image` (by dropsIdx) or
  `ChzzkCampaign.imageUrl` (by campaignNo); of a game = the banner of its
  campaign that ends last.
- **Products**: every non-retired product, plus retired ones that sold
  something (so a sale never loses its listing). Listings = `views.pickListings`
  (every live row; for a market with none live, its newest row); a `url` that
  is not http(s) is sent as `""`. A listing's
  `state` is `live` (active, not auto-paused), `paused` (auto-paused), `error`
  (status `error`), or `down` (delisted / removed / sold). `title` = the buyer
  title (`texts.title`).
- **Sales** = bundles whose codes are `sold`/`dead`, newest first; `dead` =
  how many of its codes the owner reported dead. A bundle is grouped first
  (its product and market are its rows' `$max`), so the feed, the chart and
  the per-product / per-market totals count it once even if its rows
  disagree. Replacement codes (sold, no bundle, market `replacement`) are not
  sales: not in the feed, the chart or "last sale", and they earn nothing;
  like the Sales tab, they still count in `codes.sold` (they left stock).
- **Bundles on sale per market** (`markets[].unitsOnSale`) = an active
  product's available bundles, once per market it has a live listing on.

## The page

`ShopBoard.mountTab(kit, { farm })` registers tab `listings` ("Listings") in
that panel and polls `/api/code-shop/board` every 30 s while the tab and the
browser tab are both visible (a timeout chain, never an interval). A failed
read keeps what is on screen and says so; a 401/403 goes to the login page.
Filters are remembered per panel in `localStorage` (a private window simply
forgets them).

- **Bar**: farm chips (`SOOP` / `CHZZK` / `Both`, opening on the panel's own
  farm), view chips (`Games` / `Marketplaces` / `Sales`), search (game,
  campaign, reward, listing title), "Updated … ago" and a reload button.
- **Tiles**: Bundles on sale · Live listings · Sold today · Sold 7 days ·
  All-time revenue · In stock · Expiring. Every number follows the farm chip.
- **Games**: one card per game. Banner (campaign art) with the box-art cover
  over it, name, farm badges; on sale / sold / in stock; one pill per market
  with its live listings; the reward pictures with how many are on sale; the
  last sale and any warning (codes about to expire, game switched off). A
  click opens the game drawer: its listings (with market links), its
  campaigns and rewards (with pictures and counts), its sales.
- **Marketplaces**: one column per market (Eldorado, PlayerAuctions): the
  market's numbers, then a card per listing (cover, rewards, title, price,
  on sale / sold, state, "Open"). A last column, **Not listed**, holds drafts,
  products missing from a market they are meant for, and games with codes in
  stock that no bundle holds yet (and why, when the page can tell).
- **Sales**: a bar chart of the last 14 days (bundles per day, one colour per
  market, dollars on hover), then the sales feed by day: game cover, listing,
  market, farm, price, time.

Everything is built with the kit's `el()` (no `innerHTML`); outside URLs are
only ever `href`/`src`, which the kit scrubs to http(s). Images load lazily
with `referrerpolicy="no-referrer"`; a broken one falls back to the monogram.
