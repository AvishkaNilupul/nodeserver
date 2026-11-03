# Steam account sales on Eldorado

## Current scope — 2026-11-03

New account allocations are **Eldorado only**. Empty regional accounts go to
Eldorado offers; overflow selected by the boost policy is reserved for hour boosting.
Only Eldorado regional stock counts toward `keepPerRegion`. If Eldorado fails,
accounts wait in stock for retry; they never fall back to G2G. Existing G2G
inventory and sale tracking remain intact. The v2 routing below is historical.
Accounts with games are excluded from empty-account offers; per-game offers and
boosted-account sale handoff remain unfinished. This is a local code change, not
a production deployment.

## Original regional-sales implementation

Owner's choices (2026-11-01): sell like el9in_store's Steam shelf, start with one
offer per region in Steam › Accounts, **$1 each**, buyer gets Steam codes through our
**mail page** (like Epic, not the Outlook inbox), G2G right after. Per-game offers and
idle hours wait for the loader. Background: memory notes project_el9in_steam_shelf_1101,
reference_steam_account_market_rules_1101.

## What a buyer gets (Eldorado's own instant delivery, nothing sent by us)
- Account details: login = Steam account name, password = Steam password.
- Email details: provider URL = `https://<site>/mail/`, login = the account's Outlook
  address, password = a random password that only opens our mail page.
- The mail page shows only mail from **steampowered.com**, only from the purchase on,
  for `sessionDays` (default 7). No auto-close on "email changed" for Steam (Steam's
  change-request mail carries the code the buyer still needs).
- `hasOriginalEmail: false`; the description says the inbox itself is not included and
  names the region (Eldorado Rule 2).

## Rules the engine keeps (same as the Epic engine)
- An account is on at most ONE live listing; listing it sets `SteamAccount.stage = "listed"`.
- Only `stage: "stock"`, not loaded (v1 sells empty accounts), with a password, an email,
  a signup country, and an inbox the Mac pool uses for Steam only.
- One listing = one region (the account's `signupCountry`); create/top-up refuse others.
- Stock rewrites only when Eldorado's entry count equals the offer quantity; a unit that
  left the stock is never put back.
- Sale sync every 5 min while a listing is live: offer + entries; orders when a unit left
  or every 15 min. Match by the order's own entry, else the single unit that left; record
  once (`SteamSale.orderId` unique); then the account is `stage: "sold"`, the mail session
  turns "sold" with expiresAt = sale + sessionDays. Telegram on live / sale / dispute /
  unit gone without an order.
- Keep-alive: pause+resume an Active offer within 5 days of expiry.
- Manual edits on the page cannot change the stage of an account that is on a listing.

## Pieces
- Mail: `BuyerMailSession.kind` ("epic" default | "steam") + `steamAccountId`; Epic rows
  unchanged. `outlookGraphReader` sends `kind` to the Mac proxy and re-checks the sender
  list locally. `scripts/epic-mail-proxy.js` (Mac, untracked) accepts `kind: "steam"`
  only for inboxes whose usage lists `steam`. Watcher scans Epic rows only.
- `eldoradoAccountOffers.sectionOf` accepts a section object; Steam passes
  `{gameId: "42", seoAlias: "steam-accounts"}` (the shared SECTIONS list is unchanged).
- `models/SteamListing.js`, `models/SteamSale.js`, `models/SteamSalesState.js`,
  `utils/steamSales.js`, routes in `routes/steamAccountRoutes.js`, panel card on
  `/steam-accounts.html`, covers `public/img/steam-cover-<cc>.jpg`.
- `eldoradoFulfiller`: an order on a Steam listing offer is skipped quietly.
- `server.js`: `steamSales.start()`; nothing reaches Eldorado until a listing exists.

# v2: G2G + the distributor (owner, 2026-11-01)

Owner: "after the system is created I will add more accounts … the system decides
Eldorado or G2G"; "use the API system we already have, auto delivery as on Epic".

## G2G (utils/steamG2g.js, models/SteamG2gUnit.js)
- One offer per country in G2G Game Accounts › Steam Accounts (service
  `f6a1aba5-…`, brand `lgc_game_20647`, relation `5af4ff27-…`), created through the
  seller API we already use (`POST /offer` draft + `PUT /offer/<id>`), shaped like the
  live Epic Instant offer: `delivery_speed: "instant"`, `delivery_method_ids:
  ["instant_inventory"]`, the brand's one required attribute "Games Owned" = "4 or
  below" (empty accounts), $1, min 1, global. Links kept in `SteamSalesState.g2gOffers`.
- "Steam Country" (`294cea68`) = the country in plain English ("Japan", "Turkey"), sent
  at creation and filled in once by the sweep on older offers (`countrySet`). "Steam
  Age" (`33e42e40`) is never sent: G2G sets it to 0 by itself, refuses an edit that
  sends a value under 1, and keeps its value when an edit leaves it out.
- Stock: rows in the brand's account form (Account ID = Steam account name, Password,
  Account Country = signup country, Account Email = the Outlook address, Email
  Password = a mail-page password, Additional Note = how to use the mail page + the
  owner's region warning), uploaded with softpin + job, confirmed by G2G's stock stats.
  G2G's note takes no link with a path: it names the bare site, whose front page now
  has a "Steam account emails" button (→ /mail/).
- Mail page window 14 days after the sale (G2G's minimum warranty for accounts).
- Sales: G2G hands the row out itself; the sweep (3 min) reads our orders on the
  linked offers, `order_inventories[].upload_reference` = the Account ID → unit sold,
  account sold, mail session sold, `SteamSale` "g2g:<order item>" (unique).
- g2gFulfiller skips orders on these offers quietly (pages if one waits > 15 min).

## The distributor (utils/steamDistributor.js), every 5 min, mode on | plan | off
- Takes ready stock accounts (same vet as listing: empty, signup country, password,
  email, inbox used for Steam only). Never an account already on a market.
- Per account, region R: the market whose R offer holds FEWER unsold accounts;
  tie → the market with more Steam sales in the last 14 days; tie → G2G (empty
  accounts sell there with volume, Eldorado's floor is $0.05).
- A market whose offer for R can't be made/loaded right now is skipped for 6 h and
  the account goes to the other one. Missing offers are created on the fly
  (Eldorado region listing / G2G region offer).
- At most 20 accounts per pass. "plan" records what it would do without doing it.
- Ships ON (owner asked for automatic placement); the panel can switch it.
