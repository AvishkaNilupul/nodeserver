# Build plan — "Spent accounts" recycle tab

**For:** Sol (builder). **Reviewed/deployed by:** Avishka + Claude.
**Status:** ready to build. Manual-only, ships safe (no background behavior change on day one).

---

## 0. Read this first — most of this already exists

Do **not** build a new subsystem. The recycle engine was already built (PR #38, `recycleSoldOutAccounts()` in `utils/autoFarmer.js:878`) and **shipped OFF** because its auto-gate leaned on two signals that are unreliable in prod data (`connected` flips back to false when a buyer disconnects the Twitch link; `soldAt` is `null` on most delivered accounts because a sale commits the drops, not the account). We are **not** reviving that auto-sweep. We are building the **manual-review version** that was proposed and deferred last time.

Two decisions are locked (Avishka, this session):

1. **Trigger = manual from a tab.** A human clicks "recycle" per account (or bulk). A fresh live rescan runs as the safety net. This sidesteps the broken auto-signals — *you* are the gate.
2. **Never re-farm a sold game.** Once a game has been delivered to a buyer on an account, that game is excluded from that account **forever**, even after it goes back to the pool. Only other/new games may farm.

Preserve these existing guards (they already work — don't regress them):
- Renters excluded (`AvailableAccount.claimedNote` matching `/^rented to/i`).
- Accounts on an active `MarketplaceListing` excluded (never recycle mid-sale).
- Accounts still deployed to a bot (`BotAccount.configFile` non-empty) excluded.
- Accounts with sold-but-not-yet-connected drops excluded (delivery still pending).

**Known residual risk (leave visible in the UI, do not try to "solve" it):** the first buyer keeps the account's login:password. Cooldown + rescan prove the password still works *today*, not that the buyer won't return. The "never the sold game" rule caps double-selling the same game but does not remove shared-login risk across other games. This is why it ships manual + cooldown-gated. Put a one-line warning banner on the tab.

---

## 1. Design (read before touching code)

### The core rule: exclusion keys on **delivered**, not **farmed**

`soldGames` on an account = the set of games that were actually delivered to a real buyer on that account: a `DropLog` row for that login that is **`connected: true`** OR **real-sold** (`soldAt != null` AND `soldToUsername` NOT in the marketplace-reservation tags). Merely-listed reservations do **not** count (a listing tag is not a sale — see `utils/dropScanner.js` `MARKET_CLAIM_TAGS` at line 50).

Why "delivered, not farmed" matters — it makes this coexist correctly with **reuse-only games** (WoT/UFL, see `settings.isReuseOnlyGame`), which *deliberately* re-farm the same game on recycled-but-**unsold** accounts:
- A WoT account farmed → recycled → **never sold** → `soldGames` empty → reuse-only re-farms WoT. ✅ (unchanged)
- A WoT account **sold to a buyer** → WoT ∈ `soldGames` → never re-farmed, even under reuse-only. ✅ (the fix)

### Where the exclusion is enforced

At claim time in `claimPoolAccounts()` (`utils/autoFarmer.js:734`). The claim always knows its game (from the `preferGame` arg or parsed from the `note`). Add the game to the query so the pool never hands an account a game it already sold. This is the **only** edit to `autoFarmer.js`, and it can only ever *reduce* what an account farms — never expand — so it's safe.

### What stamps `soldGames`

The **new manual recycle endpoint only** (Task C). Compute delivered games from `DropLog` at recycle time and `$set` them. Nothing else writes this field. That means: until someone clicks recycle in the new tab, `soldGames` is empty everywhere and the claim-time hunk is a no-op → **zero behavior change on deploy**.

---

## 2. Build tasks (ordered, self-contained)

### Task A — data model
**File:** `models/AvailableAccount.js`
- Add field: `soldGames: { type: [String], default: [] }` (normalized game labels, see `utils/gameLabel.js` `normGame`). Place near `usageHistory`.
- No migration needed (default `[]`). Beware the Mongoose retroactive-defaults trap — existing docs read back `[]` fine, but never rely on `$exists` for this field; treat missing as empty.

### Task B — pure eligibility helper (unit-tested, no DB)
**New file:** `utils/spentAccountEligibility.js`, modeled on the existing pure helpers `utils/recycleEligibility.js` / `utils/renterPoolEligibility.js`.
- Export a pure function `spentAccountEligibility(facts)` returning `{ recyclable: boolean, reason: string, cooldownPassed: boolean }`.
- Facts in (gathered in bulk by the route, same shape idea as `recycleEligibility`): `claimedNote`, `availableDrops`, `deliveredDrops` (connected OR real-sold), `soldUnconnectedDrops`, `onActiveListing`, `deployed` (BotAccount.configFile non-empty), `newestDeliveredAt`, `cooldownDays`, `now?`.
- Rules: reject if rental note / already-recycled note / `availableDrops > 0` / `deliveredDrops < 1` / `soldUnconnectedDrops > 0` / `onActiveListing` / `deployed`. If it passes those, it is a **spent** account; set `cooldownPassed` from `newestDeliveredAt + cooldownDays`. `recyclable = passedAll && cooldownPassed`.
- **New test file:** `tests/spentAccountEligibility.test.js` — cover each reject branch + the cooldown boundary. Keep it self-contained (no DB, no docs deps — see deploy trap #4).

### Task C — backend routes (new router)
**New file:** `routes/spentAccountsRoutes.js`. Mount it in `server.js` next to the other admin routers (behind `enforce2fa`, superadmin — see `server.js:619-620` where `accountPoolRoutes`/`autoFarmRoutes` mount).

Cooldown default 14 days; read it from the same auto-farm settings the old feature used (`af.recycleCooldownDays`) so there's one knob, or hardcode 14 with a query override — your call, keep it one number.

`GET /spent-accounts/list` — the review list. Build it like the sweep's bulk gather in `recycleSoldOutAccounts` (`utils/autoFarmer.js:886-984`) but **read-only**:
- Candidate logins = pool rows (`AvailableAccount`) whose `DropLog` shows `availableDrops === 0` AND `deliveredDrops >= 1`. Use one `DropLog.aggregate` grouped by `$toLower:"$login"` computing `available` / `connected` / `soldUnconnected` / `newestSold` / delivered-game breakdown (game + soldToUsername + soldAt + connected, so the UI can show **what sold, to whom, when**). Reuse `MARKET_CLAIM_TAGS` from `dropScanner` to classify real-sale vs listing tag. `AVAILABLE_DROP` is `utils/dropReservation.js:18`.
- Join `MarketplaceListing` (active) and `BotAccount` (`configFile`) to fill `onActiveListing` / `deployed`.
- Run each candidate through `spentAccountEligibility`. Return every spent account with: username, per-game sold detail, cooldown countdown (days left), `recyclable` flag, `deployed`/`listed`/`rented` flags, `lastCheckStatus`, and whether it already carries `soldGames`.
- **v1 scope:** only accounts that already have an `AvailableAccount` pool row (status `claimed` or `available`). If a spent account exists only as a `BotAccount` with no pool row, list it as "needs pool import — out of scope v1" and don't offer recycle. Don't build the park-credentials-into-pool path now.

`POST /spent-accounts/recycle` — body `{ login }` (or `{ id }`). Re-verify server-side; **never trust the client's list**:
1. Re-gather facts and run `spentAccountEligibility`; if not `recyclable`, 409 with the reason.
2. Fresh rescan: `require("../utils/dropScanner").scanAccountNow(botId)` (get `botId` from the `BotAccount`), then re-read `BotAccount.lastScanStatus`.
3. If `lastScanStatus === "ok"`: compute `soldGames` = distinct normalized delivered games for this login. `AvailableAccount.updateOne({ _id, status: "claimed" }, { $set: { status:"available", claimedAt:null, claimedNote:"recycled — spent (never re-farm sold games)", soldGames } })`. Then `recordPoolUsage(id, { event:"recycled", actor:"spent-accounts", note:"recycled — sold games excluded", game:"" })` and `recordAutoFarmEvent({ type:"recycled", count:1, actor:"spentAccountsTab", reason:"manual recycle" })` (both already exist in `autoFarmer.js` — export/require them, don't duplicate).
4. If rescan **not** ok: `$set claimedNote:"sold — token reclaimed by buyer"`, do NOT recycle, return that state so the UI shows it. (Same behavior as the old sweep's dead-token branch, `autoFarmer.js:1030`.)

`POST /spent-accounts/recycle-bulk` — array of logins; loop the single-recycle logic, cap the batch (e.g. 20 rescans/request like `RECYCLE_BATCH`), return per-login results. Rescans are live Twitch calls — keep the cap.

**Note the crucial change from the old sweep:** the old code set `claimedNote:"recycled after <game>"` which *matches the same-game affinity regex* (`autoFarmer.js:744`) so it re-farmed the same game. We are doing the **opposite** — neutral note + `soldGames` exclusion. Do not copy the old note.

### Task D — claim-time exclusion (the ONLY `autoFarmer.js` edit — surgical)
**File:** `utils/autoFarmer.js`, function `claimPoolAccounts` (line 734).
- At the top, derive the target game: `preferGame` if set, else parse from `note` with the existing regex (the code already does this parse at line 763 for pool-usage — lift it up). Normalize with `normGame` from `utils/gameLabel.js`.
- If a game is known, add `soldGames: { $ne: <normGame(game)> }` to **each pass's** query (both the `preferGame` affinity pass and the generic pass). i.e. merge it into `{ ...readyPoolQuery(), ...extra, soldGames: { $ne: g } }`.
- That's it. ~4 lines. No signature change, no caller changes. Because `soldGames` is empty until Task C stamps it, this is inert until the tab is used.
- **DANGER — see §4 deploy:** prod's `autoFarmer.js` is a union that exists in no git ref. You must apply this as a **hunk onto prod's live file**, never ship your whole `autoFarmer.js`.

### Task E — frontend tab
**New file:** `public/spent-accounts.html` (clone the structure/nav/`admin-nav.js` include + `/whoami` guard from `public/account-pool.html`).
**Edit:** `public/admin-nav.js` — add a nav entry under the **Bots** group near "Account pool" (`admin-nav.js:151`): `{ href:"/spent-accounts.html", label:"Spent accounts" }`.
- Table per account: username · games sold (with buyer name / "listing" tag, and date) · cooldown (✅ passed / "N days left") · status chips (deployed/listed/rented — these should be filtered out, but show if present) · last rescan status · **Recycle** button (enabled only when `recyclable === true`).
- Bulk: checkboxes + "Recycle selected". Show per-row result after the POST (recycled ✓ / token reclaimed ✗ / not eligible).
- **Warning banner** at top (one line): "Recycling reuses an account a buyer already has the login for. Sold games are permanently blocked; other games may still be farmed and re-sold — the original buyer still holds the login."

### Task F — leave the old auto-sweep alone
- Do **not** delete `recycleSoldOutAccounts` / `recycleEligibility.js`. It's already OFF (`af.recycleSoldAccounts=false`). Leave it inert. Removing it is scope creep and touches the dangerous file more than needed.

---

## 3. Definition of done
- [ ] `models/AvailableAccount.js` has `soldGames`.
- [ ] `utils/spentAccountEligibility.js` + passing `tests/spentAccountEligibility.test.js` (`node --test tests/spentAccountEligibility.test.js`).
- [ ] `routes/spentAccountsRoutes.js` mounted; `GET /spent-accounts/list`, `POST /spent-accounts/recycle`, `POST /spent-accounts/recycle-bulk` all work against the real DB.
- [ ] `public/spent-accounts.html` + nav entry render; list loads; recycle button behaves; warning banner present.
- [ ] `claimPoolAccounts` hunk excludes `soldGames`; `node --check` + a `require()` load-test pass.
- [ ] Unauth probe of `/spent-accounts/list` returns 401; page 401s without session (superadmin-only).
- [ ] Verified read-only on prod data first: run the `GET /list` logic and eyeball that the accounts it surfaces really are spent + not deployed/listed/rented, before enabling any recycle click.

---

## 4. Deploy (targeted file copy — follow exactly, this repo has bitten us)

SSH: `ssh -i ~/.ssh/claude_prod_deploy_ed25519 root@202.92.214.91`. App path `/var/www/redeemer/nodeserver`. PM2 app `redeemer` (port 3000).

**Deploy convention (never `git pull` — prod runs a per-file mix of branch tips):**
1. **Fingerprint every file** you're changing: local `git show HEAD:<f> | shasum` vs prod `git hash-object --no-filters <f>`. Per file, no exceptions.
2. **`utils/autoFarmer.js` — DO NOT overwrite.** Prod's copy is a union that exists in no git ref (catalog integration + reuse-only + scan speedup + pool-usage + watcher + Stream Scout). Deploying your whole file silently reverts live features — this has bitten twice. **Block-swap only your `claimPoolAccounts` hunk onto prod's copy**, then verify prod's other markers survive (`updateAutofarmCatalogStates`, reuse-only, Stream Scout hunks) by count and placement, not just that it compiles.
3. **`server.js` lives at the repo ROOT** — a `tar models public routes utils` silently omits it. Include it explicitly. Fingerprint it; patch only your `app.use` line onto prod's server.js.
4. `models/AvailableAccount.js`, `public/admin-nav.js` — fingerprint for drift, patch your additions onto prod's copy (don't clobber).
5. New files (`routes/spentAccountsRoutes.js`, `public/spent-accounts.html`, `utils/spentAccountEligibility.js`) — copy straight up.
6. **Do NOT deploy `tests/*.test.js`** (not runtime; prod has no `docs/` so some tests fail to load and show phantom reds).
7. Stage into `/tmp` or `.NEW` temp names; back up originals into `_deploy_backup_<ts>_spent-accounts/` at repo root on prod; swap; **hash-verify every file == expected**.
8. Load-test before restart: `node -e "require('./routes/spentAccountsRoutes')"`, `node -e "require('./utils/spentAccountEligibility')"`, `node --check server.js`, `node --check utils/autoFarmer.js`. Auto-restore on any failure.
9. `pm2 restart redeemer` (runtime code changed). Confirm `online`, `unstable_restarts: 0`, "MongoDB connected"/"Server started". Ignore the known routine noise (`campaignWatcher error: failed integrity check`, Mongoose deprecation warnings).
10. Probe live: `/spent-accounts.html` should 401 unauth; `/spent-accounts/list` should 401 unauth.
11. **Backup + index:** push the branch to GitHub (`AvishkaNilupul/nodeserver`) as the off-server backup, and refresh `.graphify` after committing.

**Verify an admin endpoint without logging in** (session-only auth, no header bypass): mount the deployed router in a throwaway Express app in the repo ROOT on prod with a stubbed `req.session.admin`, drive over localhost against the real DB, delete the harness + any scratch rows after. Scp the router under an inert name (`routes/_spentAccountsRoutes_VERIFY.js`) to test before deploying the real file. **Never** trigger `POST /auto-farm/tick` from a harness.

---

## 5. What NOT to do
- Don't revive the auto-sweep or wire recycling into the 10-min tick. Manual only.
- Don't stamp `BotAccount.soldAt` anywhere (breaks stock accounting — see the note in `autoFarmer.js:807`).
- Don't re-farm the same game via a "recycled after <game>" note. That's the old behavior we're reversing.
- Don't build the "park BotAccount creds into a new pool row" path for accounts with no pool row — list them as out-of-scope v1.
- Don't touch renter / listing / delivery exclusions except to preserve them.
- Don't force-push (local history is disjoint from origin); land commits via a worktree off `origin/<branch>`.
