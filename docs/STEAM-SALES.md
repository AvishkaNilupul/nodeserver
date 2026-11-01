# Steam account sales on Eldorado (v1: one offer per region)

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
