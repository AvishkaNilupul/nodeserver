# Unclaimed Drop Archive — Implementation Plan

**For the implementing agent (you have GitHub + prod SSH).** Build this, then it will be
reviewed. Follow this spec exactly; where it says "do NOT", that constraint has bitten before.

---

## 0. Goal (one paragraph)

Add a **"Drop archive"** browsing section to the **Unclaimed Farms** console that looks and
behaves like the existing Drop Archive, but whose data source is the **`UnclaimedAccount`**
collection only (the no-claim + web-token farmed accounts that hold *unclaimed* drops). It is
**read-only browsing**: three sub-views — **By item**, **By game**, **Accounts** — with drops
shown and per-account credential copy on demand. This exists because unclaimed / no-claim
accounts (e.g. everything in `noclaim-bot-11`) deliberately have **no `BotAccount` rows**, so
they never appear in the real Drop Archive and can't be checked there.

---

## 1. Where things live

| Thing | File |
|---|---|
| Unclaimed console frontend (EDIT) | `public/unclaimed-farms.html` |
| Unclaimed console backend (EDIT) | `routes/unclaimedAutoRoutes.js` |
| Unclaimed engine / helpers (export 1–2 fns) | `utils/unclaimedAutoList.js` |
| Data model (DO NOT change schema) | `models/UnclaimedAccount.js` |
| **Reference only** — mirror its look & UX, NOT its data source | `public/drops-archive.html`, `routes/dropArchiveRoutes.js` |

App is Node/Express + Mongoose, CommonJS, **no frontend build step** (vanilla JS inside the
HTML). Mongo is **Atlas shared tier — `allowDiskUse` is OFF**.

---

## 2. Data model (already exists — DO NOT modify the schema)

`UnclaimedAccount`: `source` (`"noclaim"|"webbot"`), `login`, `loginLower`, `twitchId`, `game`,
`poolAccountId`, `webBotAccountId`, `botId`, `container`,
`drops: [{ name, game, campaign, itemKey }]`, `set` (ref DropSet),
`market` (`""|"gameflip"|"digiseller"|"ggsel"`),
`status` (`"listed"|"sold"|"expired"|"released"|"skipped"|"removed"`), `listedAt`, `soldAt`, …

- **"Held / available stock"** = `status ∈ {listed, skipped}` (account still holds its unclaimed
  drops). Everything else (`sold/expired/released/removed`) means the drops are gone.
- **Credentials are NOT on `UnclaimedAccount`.** Resolve from the owner row:
  - `noclaim` → `AvailableAccount.findById(poolAccountId)` → password via `poolPassword(row)`, email via `row.credEmail` (encrypted).
  - `webbot` → `WebBotAccount.findById(webBotAccountId)` → password via `plainPassword(row.credPasswordEnc)`, email via `row.credEmail` if present.
  - There is already an internal helper **`credentialForLedger(ledger)`** in
    `utils/unclaimedAutoList.js` (~line 766) that returns `{ login, password }` doing exactly
    this. It is **not exported** today. **Export it and reuse it** — do not re-implement the
    decryption. Add email by reading the owner row's `credEmail` (guard: field may be absent →
    return `""`).

---

## 3. Scope

**IN**
- New top-level tab **"Drop archive"** in the Unclaimed console, with 3 sub-views: **By item**,
  **By game**, **Accounts**.
- Shared **status filter** (default = *Held* = listed+skipped) and a search box.
- Per-account **Copy login** and **Copy password** (password fetched on click, never in bulk).

**OUT — do NOT build / change**
- **No new scanner.** The existing "Scan & list now" already refreshes `UnclaimedAccount`.
  This feature is browse-only over existing data.
- **No `BotAccount` coupling**, no "Sync from bots", no creating `BotAccount` rows for no-claim
  accounts. Keep the no-claim decoupling intact.
- **Do NOT modify** `spendAccount` / publish / delist or any auto-lister behavior. (You may
  surface the existing `POST /api/unclaimed-auto/sell/:id` "mark sold" in the accounts list, but
  do not change it.)
- Skip **Bad tokens / Duplicates** tabs (optional stretch only if trivial).

---

## 4. Backend — new endpoints in `routes/unclaimedAutoRoutes.js`

All endpoints **`requireSuperadmin`** (session auth — there is no header/key bypass). Prefix
`/api/unclaimed-auto/archive/`.

> **Performance rule:** the `UnclaimedAccount` collection is small (thousands of rows). Prefer a
> single **projected `find()` + in-memory grouping in JS** (mirror the stats code already in
> `utils/unclaimedAutoList.js`). **Do NOT** write `$group` aggregations that could trip Atlas
> `allowDiskUse`. Response **bytes** are the real perf bound, so never return decrypted
> passwords/emails in list payloads.

**4.1 `GET /archive/by-item?status=`**
- Load `UnclaimedAccount` (apply status filter; default *held* = `{status:{$in:["listed","skipped"]}}`),
  projection `{ drops, game, status, _id }`.
- Group by **item key**: use `drops[].itemKey` when present, else normalized `` `${game}|${name}` ``
  (lowercased). Track `name`, `game`.
- Counts per item: `accounts` = number of **distinct accounts** holding ≥1 of the item;
  `units` = total copies across accounts (so "4× Alpha Pack" on one account = `accounts:1, units:4`);
  and, when `status` is not filtered, a per-status breakdown `{listed, sold, ...}`.
- Return `{ success:true, items:[{ itemKey, name, game, accounts, units, byStatus }] }` sorted by
  `accounts` desc.

**4.2 `GET /archive/by-game?status=`**
- Same load; group by `game`. Return `{ success:true, games:[{ game, accounts, items, byStatus }] }`
  where `items` = distinct itemKeys for that game. Sort by `accounts` desc.

**4.3 `GET /archive/item-accounts?itemKey=&status=`**
- Accounts holding the given item. Return
  `{ success:true, accounts:[{ id, login, source, status, market, game, drops:[name...], listedAt, soldAt }] }`.
  **No credentials here.** Sort by `listedAt` asc (oldest first).

**4.4 `GET /archive/account/:id/credential`**
- Validate `:id` is 24-hex (else 400). Load `UnclaimedAccount`. Resolve
  `{ login, password, email }` (export & reuse `credentialForLedger`; add email from owner row).
  Return `{ success:true, login, password, email }`. **On-demand only** (called on a copy click),
  never in a list.

**4.5 Reuse existing `GET /api/unclaimed-auto/accounts`** for the flat Accounts sub-view. It is
already paged (`page`, `pageSize`), status-filtered (`status`), login-searched (`q`), and returns
`drops`. **Add one backward-compatible query param `game=`** (exact/normalized game filter) so the
Accounts tab can be filtered from a By-game drill. Do not otherwise change its shape.

---

## 5. Frontend — `public/unclaimed-farms.html`

The page already has: top tabs `.tab[data-sec]` (`autolist`/`noclaim`/`webbot`) wired to
`switchSec(sec)`; helpers `api(path,opts)`, `busy(btn,fn)`, `esc(s)`, `$(id)`; a status-chip map
at ~line 189; and a fully working accounts table (search + status `<select>` + pager) in
`#sec-autolist` hitting `/api/unclaimed-auto/accounts`. **Reuse all of it.**

- Add a tab button: `<button class="tab" data-sec="archive">Drop archive</button>`. Tab clicks are
  already wired (line ~298) — just add an `else if (sec==='archive')` branch in `switchSec()` that
  lazy-loads the archive on first open.
- Add `<section class="sec hidden" id="sec-archive">` containing an inner sub-tab bar
  **By item / By game / Accounts**, plus a shared status `<select>` (options: *Held* [default],
  *Listed*, *Sold*, *All*, and each raw status) and a search box.
- **Mirror the markup, CSS classes, tables, chips, and the item→accounts modal from
  `public/drops-archive.html`** so styling matches (both pages share the same CSS variables/classes).
  Reuse the existing `api/busy/esc/$` helpers and the status-chip map already in this file.
- **By item**: table `Item | Game | Accounts | Units | (status chips)`. Row click → modal (mirror
  drops-archive's item→accounts modal) that GETs `/archive/item-accounts`, lists accounts with a
  **Copy login** and **Copy password** button per row. Copy-password does
  `GET /archive/account/:id/credential` then `navigator.clipboard.writeText(...)`, with a
  `busy()` toast. (Mirror the drops-archive copy-password flow.)
- **By game**: table `Game | Accounts | Items | (status chips)`. Row click → switch to the
  Accounts sub-tab filtered to that game (uses the new `game=` param).
- **Accounts**: reuse the exact pattern from `#sec-autolist` (search + status + pager on
  `/api/unclaimed-auto/accounts`), add a game filter and a per-row **Copy password** button.
  Factor the existing loader to take its params/container so it can serve both places, or
  duplicate it carefully — either is fine, but keep one source of truth for the row rendering.

---

## 6. Constraints & traps (do not skip)

1. **Atlas `allowDiskUse` is OFF.** Use projected `find()` + JS grouping for these small queries;
   no disk-spilling `$group`.
2. **Bytes are the perf bound.** Paginate the flat list; resolve passwords/emails only per-account
   on click, never in bulk.
3. **Credential decryption needs prod's `CRED_SECRET` env** — it will not decrypt against a
   local/dev DB. Use the existing `decrypt`/`poolPassword`/`plainPassword` helpers; never hardcode.
   Unit tests must **not** rely on real decryption.
4. **All new endpoints `requireSuperadmin`.**
5. **Additive only.** Do not change `spendAccount`/publish/delist, the no-claim ↔ `BotAccount`
   decoupling, or the `UnclaimedAccount` schema.
6. **Style:** CommonJS, 2-space. `npm run format` (prettier) and `npm run lint` (eslint flat
   config) must pass clean. If you use a new browser global, add it to `eslint/config.js`
   (`navigator` is fine; `URLSearchParams`/`setImmediate` already allowed).
7. Keep the grouping helpers **pure and exported** so they are unit-testable.

---

## 7. Tests — add `tests/unclaimedArchive.test.js` (`node --test`)

- Mirror the style of `tests/unclaimedAutoList.test.js`. No DB needed for the grouping tests
  (feed fixture arrays to the exported helpers).
- Cover: by-item and by-game counts (distinct-account count vs `units`; multi-copy case like
  4× Alpha Pack → `accounts:1, units:4`); the *Held* default filter (includes `listed`+`skipped`,
  excludes `sold/expired/released/removed`); item-key fallback (`itemKey` present vs `${game}|${name}`).
- Do **not** test credential decryption (env-dependent).
- `npm test` must stay fully green (currently **547** passing).

---

## 8. Acceptance criteria (these will be checked)

- New "Drop archive" tab in the Unclaimed console; **By item / By game / Accounts** all load and
  are scoped to `UnclaimedAccount` only.
- Searching a no-claim login that is **absent from the real Drop Archive** (e.g. any account in
  `noclaim-bot-11`) finds it here, with its drops + status.
- Copy-password works on prod for a held account (returns the real credential); nothing decrypts
  client-side or in bulk.
- Default view = *Held* stock; status filter works across all three views.
- No change to auto-lister behavior; `npm run lint` clean, `npm test` green, endpoints
  superadmin-gated; no aggregation needs `allowDiskUse`.

---

## 9. Files touched

**Changed:** `public/unclaimed-farms.html`, `routes/unclaimedAutoRoutes.js`,
`utils/unclaimedAutoList.js` (export `credentialForLedger`, optional email helper).
**New:** `tests/unclaimedArchive.test.js`.

## 10. Workflow & handoff (do all of this)

1. **Branch:** work on a new branch `feature/unclaimed-drop-archive` off the current tip. Do not
   commit to `main`.
2. **Implement** per sections 3–6. Keep grouping helpers pure + exported (section 7).
3. **Local gate — all must pass before pushing:** `npm run format`, `npm run lint` (clean), and
   `npm test` (stays green — currently 547 passing, plus your new `tests/unclaimedArchive.test.js`).
4. **Push** the branch to GitHub (`origin`). This is also the off-server backup.
5. **Deploy to the live prod server** (`root@202.92.214.91`, app at `/var/www/redeemer/nodeserver`,
   pm2 app `redeemer`) via the repo's **targeted file-copy** convention:
   - Fingerprint each changed file first (local `git show HEAD:<f> | git hash-object --stdin` vs prod
     `git hash-object --no-filters <f>`).
   - Copy the changed **runtime** files up (`public/unclaimed-farms.html`,
     `routes/unclaimedAutoRoutes.js`, `utils/unclaimedAutoList.js`), backing up the originals into a
     `_deploy_backup_<ts>/` dir on prod.
   - **Load-test on prod before restart:** `node -e "require('./routes/unclaimedAutoRoutes')"` and
     `node --check server.js`. If either fails, restore the backup and stop.
   - `pm2 restart redeemer`; confirm `online`, `unstable_restarts: 0`, and "MongoDB connected".
   - **Do NOT deploy `tests/unclaimedArchive.test.js` to prod** (tests aren't runtime and can fail
     to load there).
6. **Smoke-test on live** (superadmin session in the Unclaimed Farms console): open the new
   **Drop archive** tab; verify **By item / By game / Accounts** load; search a `noclaim-bot-11`
   login and confirm it appears with its drops + status; confirm **Copy password** returns a real
   credential for a held account. Note anything odd in the pm2 logs
   (`campaignWatcher error: failed integrity check` and Mongoose deprecation warnings are routine
   noise, not regressions).
7. **Then stop and report** for review: the branch name, the commit SHA(s), the list of files
   deployed to prod with their verified hashes, and the smoke-test results. Do not merge to `main`.
