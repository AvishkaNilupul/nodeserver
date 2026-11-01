# Steam accounts (server page)

Steam accounts are made on the Mac by the local generator (`tools/steam-signup`,
http://127.0.0.1:4108). This page is where they live once made: one list on the
admin site to load games onto them, check their store region, and get them ready
to sell on Eldorado and other markets.

## How an account gets here

1. The generator saves a finished signup in its encrypted vault on the Mac.
2. Its upload queue sends the account over the existing prod SSH key and runs
   `tools/steam-signup/cloud-import.cjs` on the server, with the account on stdin
   (never on the command line or in a log). The server address comes from
   `cloud.json` in the generator's data folder on the Mac (not in git); without it
   the upload stays off and the Mac page says "Not set up".
3. The import inserts a `SteamAccount` row with `$setOnInsert`, so a repeat upload
   never overwrites anything edited on the server (games, region, stage, notes).
   Login, password and email are encrypted with `utils/secretBox`.
4. The queue retries with back-off while the server is unreachable. The Mac page
   shows Queued / Uploading / On server per account.

There is no HTTP import route. Nothing on the server calls Steam.

## What a row holds

| Field | Meaning |
|---|---|
| `localId` | the account's id in the Mac vault (unique) |
| `accountName`, `password`, `email` | Steam login; password + email encrypted |
| `signupCountry` | country picked on Steam's signup form |
| `proxyCountry`, `proxyCity` | where the browser's proxy exit was at signup |
| `storeCountry` | Steam store region, `null` until someone checks it in Steam |
| `steamId64` | optional, for the profile link |
| `games[]` | what is loaded: name, Steam app id, store price in USD |
| `stage` | `stock` · `listed` · `sold` · `problem` (set by hand for now) |
| `notes`, `soldAt`, `soldNote` | free text and the sale record |

"Empty" vs "loaded" is not stored: an account is loaded when `games` is not empty.

## Page (`/steam-accounts.html`, superadmin + 2FA)

- Tiles: total, empty, loaded, on sale, sold.
- Search, stage chips, region filter, one row per account; a row opens the details.
- Details: copy login / reveal password (hidden again after 60 s), region and
  store-region check, games list (add / remove), notes, stage + sold note, Save.

## API (`routes/steamAccountRoutes.js`, every route superadmin)

- `GET /api/steam/accounts` → rows without secrets + counts.
- `GET /api/steam/accounts/:id/credentials` → login, password, email (no-store).
- `PATCH /api/steam/accounts/:id` → `storeCountry`, `steamId64`, `games`, `notes`,
  `stage`, `soldNote`. Moving to `sold` stamps `soldAt`; moving away clears it.

## Not built yet (next steps)

- Listing on Eldorado / G2G / other markets, and sale detection.
- Buyer email access (the Outlook inbox for each account stays on the other Mac).
- Reading a library from Steam automatically; the generator does not load games yet.
