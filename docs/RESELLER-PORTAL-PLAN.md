# Reseller Portal — Full Build Plan

**Hand this document to the builder (ChatGPT / a dev). It is self-contained.**
It describes a new **Reseller** subsystem for an existing Node.js/Express +
MongoDB (Mongoose) app called *redeemer*. The app farms Twitch drops onto
Twitch accounts and sells those accounts. We now want to give trusted
**resellers** their own secure portal to receive account batches, see the
drops on each account, track whether each account still needs to be
**connected to a game/publisher account**, and mark what they've sold — plus a
**superadmin control panel** to hand accounts to resellers and watch their
activity.

> **The single most important rule:** a reseller must only ever see the
> accounts assigned to *that one reseller*. They must never be able to reach
> the operator database, the drops archive, or any admin route. Every design
> choice below serves that. Read section 2 before writing any code.

---

## 0. Golden rule for the builder: mirror the existing "Renter" subsystem

This app **already has** a fully built, security-hardened, separate-tenant
subsystem called **Renter**. The Reseller subsystem is a sibling of it and must
copy its patterns exactly. Before building, read these existing files and use
them as templates — do not invent a new architecture:

| Concern | Existing file to mirror | New file to create |
|---|---|---|
| Tenant model | `models/Renter.js` | `models/Reseller.js` |
| Tenant inventory model | `models/RenterAccount.js` | `models/ResellerAccount.js` |
| Auth middleware | `middleware/renterAuth.js` | `middleware/resellerAuth.js` |
| Login/logout/whoami | `routes/renterAuthRoutes.js` | `routes/resellerAuthRoutes.js` |
| Portal API (tenant-facing) | `routes/renterRoutes.js` | `routes/resellerRoutes.js` |
| Admin API (superadmin) | `routes/renterAdminRoutes.js` | `routes/resellerAdminRoutes.js` |
| Auth/util helpers | `utils/renters.js` | `utils/resellers.js` |
| Login page | `public/renter-login.html` | `public/reseller-login.html` |
| Portal page | `public/renter.html` | `public/reseller.html` |
| Admin page | `public/renters.html` | `public/resellers.html` |
| Rate limiters | `utils/rateLimit.js` | add reseller limiters |
| Encryption | `utils/secretBox.js` (`encrypt`/`decrypt`, AES-GCM) | reuse as-is |

The Renter subsystem proves out every hard part already: a separate session
realm (`req.session.renter`, never `req.session.admin`), fresh-record scope
loading on every request, per-request ownership checks that defeat IDOR,
tokens/passwords never returned to the tenant, session regeneration on login,
and instant lockout on suspend/expiry. **We reuse all of it.**

> ### Naming note — "Reseller" is a *realm*, not a third admin role
> The request was phrased as "a new role: resellers." Do **not** add
> `"reseller"` to the admin roles list (`utils/admins.js` `ROLES`). Admin roles
> (`admin`, `superadmin`) all live in `req.session.admin` and share admin
> routes. A reseller must be a **separate login realm** with its own session key
> (`req.session.reseller`), exactly like a renter. This is the whole reason a
> reseller cannot leak the operator DB: they never hold an admin session, so the
> admin/superadmin routes reject them structurally, not by a checkbox.

---

## 1. Domain background the builder needs

* **Account** = a Twitch account we farmed drops onto. Stored as `BotAccount`
  (keyed by its Twitch auth token `clientSecret`; `login` is the Twitch
  username; `credPassword`/`credEmail` are encrypted at rest).
* **Drop** = a reward farmed onto an account. Stored as `DropLog`, one document
  per `(account, benefitId)`. Key fields:
  * `login`, `game`, `name`, `imageLocal`/`imageURL` (the reward + picture).
  * `state`: **`claimed` | `connect` | `connected`** — this is the field the
    reseller most cares about:
    * `claimed` — farmed, nothing else needed.
    * `connect` — **the Twitch account must be linked to a game/publisher
      account (Riot, Ubisoft, EA, …) before this drop can be used.**
    * `connected` — that link is done / redeemed.
  * `connected` (boolean) and `requiredAccountLink` (which publisher, e.g.
    "Riot") support that.
  * `soldAt`, `soldToUsername`, `soldSetId`, `soldBulkOrderId` — the existing
    **reservation** fields. A drop is unavailable to operator supply when
    `connected === true` OR `soldAt !== null`.
* **Drops Archive** (`/drops-archive.html`, superadmin-only) is where the
  operator today copies an account's credentials to hand to a buyer. Handing a
  batch to a reseller is the same idea, formalised.

**"Track accounts when the Twitch account is connected to the game account"**
therefore means: for each account a reseller holds, show a per-account
**connection status** derived from its `DropLog` rows — which drops still need
connecting (`state:"connect"`, `connected:false`), which publisher each needs
(`requiredAccountLink`), and which are done. Plus a reseller-settable delivery
status for their own bookkeeping.

---

## 2. Security model — NON-NEGOTIABLE (read first)

Every one of these is already how the Renter subsystem behaves. Copy it.

1. **Separate session realm.** On reseller login, set **only**
   `req.session.reseller = { id, username, at }`. Never set `req.session.admin`.
   A reseller session can therefore never satisfy `requireAdmin` /
   `requireSuperadmin`.
2. **Scope is derived server-side, every request, from the DB — never from the
   client.** `middleware/resellerAuth.js` loads the fresh `Reseller` record by
   `req.session.reseller.id` and attaches it as `req.reseller`. Routes read
   `req.reseller._id`. **No route may ever accept a reseller id / owner id /
   "all" flag from a path, query, or body.**
3. **Ownership check on every per-account route (defeats IDOR).** To act on one
   account, resolve it as
   `ResellerAccount.findOne({ _id: paramId, reseller: req.reseller._id })`.
   If it returns null → `404`. A reseller passing another reseller's account id
   gets a 404, never data. (Mirror `ownAccount()` in `routes/renterRoutes.js`.)
4. **The portal never returns bulk-DB-wide data.** Every list query is
   `{ reseller: req.reseller._id }`. Hard `.limit()` caps and pagination on
   every list. No free-text filter is ever interpolated into a query without
   escaping (mirror the existing `replace(/[.*+?^${}()|[\]\\]/g, "\\$&")`
   escaping used throughout the codebase).
5. **Credentials are revealed carefully, not listed.** The account *roster*
   endpoints (the tables the portal renders) must **omit** `clientSecret`
   (token), `credPassword`, and `credEmail`. Credentials come only from a
   **separate, explicit, per-account reveal endpoint** that is rate-limited and
   **audit-logged** (see `ResellerAudit`, section 3). See section 6 for the
   credential-visibility decision — confirm it before building.
6. **Mounted before the `requireAdmin` blanket** in `server.js` (see section 8),
   exactly like the renter routes, so the public login and the
   `requireReseller`-guarded portal are reachable, while the admin-side routes
   self-guard with `requireSuperadmin`.
7. **Instant lockout.** `middleware/resellerAuth.js` checks `status` and any
   access window on every request; a suspended/expired reseller is denied and
   their session destroyed on their very next call (mirror `denyBlocked`).
8. **Login hardening (reuse what exists):** bcrypt password hash; `loginLimiter`
   on the login route; `req.session.regenerate()` on success (session-fixation
   defence); `httpOnly` + `secure:"auto"` + `sameSite:"strict"` cookies and the
   MongoStore session are already configured app-wide — inherit them.
9. **helmet CSP is already global.** Keep reseller pages self-contained
   (same inline-script style as the other pages) so no CSP change is needed.
10. **Least data on the wire.** The portal shows what a reseller needs to run
    their resale business and nothing about the operation: no host names, no
    config files, no other tenants, no counts of total stock, no pricing inputs
    they didn't agree to.

**Explicit "NEVER" list for the portal (`routes/resellerRoutes.js`):**
never return another reseller's data; never return `clientSecret` /
password / email from a list endpoint; never accept host/file/reseller-id from
the request; never expose operator counts or the archive; never allow a write
to any account the reseller doesn't own; never trust `req.body` for scope.

---

## 3. Data model (3 new collections + a reservation marker)

### 3.1 `models/Reseller.js` (mirror `models/Renter.js`)
```
username, usernameLower (unique, indexed), passwordHash (bcrypt),
passwordEnc (AES-GCM via secretBox, so a superadmin can reveal it),
displayName, notes,
status: "active" | "suspended"  (default "active", indexed),
accessStart, accessEnd (optional lease window; null = open-ended),
// business / limits (optional, see section 6)
maxAccounts (0 = unlimited),
lastLoginAt, createdBy, timestamps
```
Resellers do **not** get a bot slot (that's renter-only) — drop `botHost` /
`botFile` / `farmGames` / bot-stop bookkeeping.

### 3.2 `models/ResellerAccount.js` (mirror `models/RenterAccount.js`)
The reseller's **own tenant inventory** — one row per account handed to them.
This is the isolation boundary.
```
reseller: ObjectId ref Reseller (required, indexed)   // the boundary
botAccount: ObjectId ref BotAccount (indexed)         // link back to the real account
clientSecret: String (indexed)  // stored so reveal works; NEVER sent to a list endpoint
login: String (indexed)
game: String, // primary game, denormalised for fast filtering
receivedAt: Date (default now)   // "when he received the account"
// reseller-settable delivery bookkeeping (their own resale funnel):
resellerStatus: "received" | "listed" | "sold" | "returned"  (default "received", indexed)
resellerSoldAt: Date, resellerNote: String,
// connection snapshot, refreshed from DropLog at assign time and on "verify":
needsConnect: Boolean,      // any drop with state "connect" & not connected
connectSummary: [{ game, requiredAccountLink, total, connected }],
lastVerifiedAt: Date,
timestamps
```
> `ResellerAccount` deliberately does **not** copy password/email — those stay
> only in the encrypted `BotAccount` and are fetched on demand by the reveal
> endpoint (mirror `resolveAccountCreds()` in `routes/renterAdminRoutes.js`).

### 3.3 `models/ResellerAudit.js` (new — this subsystem handles real credentials)
An append-only audit trail. Superadmin-readable.
```
reseller: ObjectId ref Reseller (indexed),
action: "login" | "reveal_creds" | "mark_sold" | "verify" | "assign" | "reclaim" | ...,
accountLogin: String,   // when action targets one account
ip: String, at: Date (default now, indexed), meta: Mixed
```
Write an audit row on: every reseller login, every credential reveal, every
status change a reseller makes, and every assign/reclaim a superadmin makes.

### 3.4 Reservation marker on the existing models (the safe integration)
When an account is assigned to a reseller it must **leave operator supply** —
auto-farm, the shop, the public catalog, marketplace fulfilment and bulk orders
must all stop treating it as sellable stock. The app **already** has one
mechanism every one of those paths respects: the `soldAt` reservation. Reuse it
rather than inventing a parallel exclusion (inventing one is exactly how stock
gets double-sold).

Add a dedicated marker so a reseller handoff is distinguishable from a real
shop sale, mirroring how bulk orders use `soldBulkOrderId`:
* `BotAccount`: add `resellerId: String` (default ""). On assign, also stamp
  `soldAt = now`, `soldToUsername = "reseller:<username>"`.
* `DropLog`: add `soldResellerId: String` (default ""). On assign, stamp
  `soldAt`, `soldToUsername`, `soldResellerId` on that account's drops (the
  same per-drop reservation the sale path already writes).

On **reclaim** (superadmin pulls an account back), clear those fields
(`soldAt = null`, `resellerId = ""`, `soldResellerId = ""`) so the account
returns to supply, and delete the `ResellerAccount` row.

> **Builder must verify** the existing supply queries already filter
> `soldAt: null` (they do for shop/catalog/auto-farm/fulfilment). Grep for
> `soldAt` and confirm each stock query excludes reserved rows. If any path
> keys off something else, exclude `resellerId`/`soldResellerId` there too.

---

## 4. Reseller portal — pages & endpoints (tenant-facing)

Page: **`public/reseller.html`** (mirror `renter.html`), gated by
`requireReseller`; login at **`public/reseller-login.html`** (public static).
All endpoints below live in **`routes/resellerRoutes.js`**, every one behind
`requireReseller`, every one scoped to `req.reseller._id`.

**Auth (`routes/resellerAuthRoutes.js`, mirror `renterAuthRoutes.js`):**
* `POST /reseller-login` — `loginLimiter`; bcrypt verify; block if
  suspended/expired; `regenerate()`; set `req.session.reseller`; stamp
  `lastLoginAt`; write `ResellerAudit{action:"login", ip}`.
* `POST /reseller-logout` — destroy session, clear `connect.sid`.
* `GET /reseller/whoami` — `requireReseller`; returns sanitised identity.

**Portal data:**
* `GET /reseller/me` — display name, status, account count, delivery-funnel
  counts (received / listed / sold), lease window if used. No operator data.
* `GET /reseller/accounts` — **the inventory table.** Scoped list from
  `ResellerAccount`. Returns per row: `id`, `login`, `game`,
  `resellerStatus`, `needsConnect`, `receivedAt`, a small drops summary
  (count + top reward name/image), `lastVerifiedAt`.
  **Omits `clientSecret`, password, email.** Supports server-side
  `?status=`, `?game=`, `?q=` (escaped), pagination, hard `.limit()` cap.
* `GET /reseller/accounts/:id` — one owned account's detail (resolved via the
  ownership check): its `DropLog` rows grouped by game/reward with
  `state`/`connected`/`requiredAccountLink` and images — i.e. the full
  **connection checklist**. Still no credentials in this payload.
* `GET /reseller/accounts/:id/credentials` — **the only credential path.**
  `resellerRevealLimiter` + ownership check + `ResellerAudit{reveal_creds}`.
  Returns `login`, `password`, `email`, and the auth `token` (`clientSecret`)
  for that one account so the reseller can deliver it to their buyer. Reveal on
  click in the UI (never rendered in the table). *(Gate this behind the section
  6 decision.)*
* `POST /reseller/accounts/:id/status` — reseller sets their own delivery
  status (`listed`/`sold`/`returned`) + optional note; stamps
  `resellerSoldAt`; writes audit. Ownership-checked.
* `POST /reseller/accounts/:id/verify` — `resellerLiveLimiter`; server-side
  live re-check against Twitch (reuse `utils/twitchInventory.fetchInventory`
  like `renterRoutes` `/live`): confirms the token still works and refreshes
  `needsConnect`/`connectSummary`/`lastVerifiedAt`. The reseller never sees the
  token — the server holds it and returns only the status. Ownership-checked.
* `GET /reseller/summary` — counts by game and by connection status, for the
  dashboard header ("12 need connecting", "30 connected", "18 sold").

**Portal UX (build in `reseller.html`):**
* Dashboard header: totals — received, need-connecting, connected, sold.
* Inventory table with filter chips (game, status, "needs connecting") and
  search; each row shows the connection badge and a reward thumbnail.
* Row → detail drawer: the per-drop connection checklist (which publisher to
  link for each), a **Reveal credentials** button (audited), a **Copy** button,
  a **Verify live** button, and status controls (mark listed/sold).
* A "What's new" banner when a fresh batch was assigned since last login
  (compare `receivedAt` to `lastLoginAt`).
* Clear empty states and error toasts; mobile-friendly (the app already ships a
  mobile seller shell, keep it responsive).

---

## 5. Superadmin control panel — pages & endpoints

Page: **`public/resellers.html`** (mirror `renters.html`), served by a
`requireSuperadmin, enforce2fa` route in `server.js`. All endpoints in
**`routes/resellerAdminRoutes.js`**, every one `requireSuperadmin`.

**Reseller CRUD (mirror `renterAdminRoutes.js`):**
* `GET /resellers` — list with per-reseller counts (accounts held, need-connect,
  sold) via one grouped aggregate (do **not** run a countDocuments per reseller
  in a loop — the Atlas shared tier serialises those; mirror the `usedByRenter`
  aggregate).
* `POST /resellers` — create (username 3–32 `[A-Za-z0-9_.-]`, min-length
  password, uniqueness check).
* `GET /resellers/:id` — one reseller + their account roster (with credentials
  inline for the operator, via the credential resolver) + recent audit.
* `PUT /resellers/:id` — edit display name, notes, limits, access window.
* `POST /resellers/:id/password` — reset password (superadmin only).
* `GET /resellers/:id/password` — reveal password (superadmin only).
* `POST /resellers/:id/suspend` / `/unsuspend` — block/restore access.
* `DELETE /resellers/:id` — delete reseller; **reclaim all their accounts**
  first (clear reservations, delete `ResellerAccount` rows) so nothing is
  stranded out of supply; keep the audit trail.

**The assignment flow — "copy-paste from the drops archive" (the core feature):**
* `POST /resellers/:id/assign` — body is a pasted blob of **logins** (one per
  line; also accept `login:...` lines and just take the login). For each login:
  1. Find the `BotAccount` by `login` (case-insensitive, escaped regex).
  2. Refuse + report if it's already assigned to a reseller, already sold, on an
     active marketplace listing, or reserved for a bulk order (reuse the same
     "is this promised elsewhere" checks the fulfilment path uses). Report
     skipped lines back to the operator with reasons (mirror the
     parse-and-report style of `renterRoutes` `/submit`).
  3. Enforce `maxAccounts` if set.
  4. Create a `ResellerAccount` row (snapshot `login`, `clientSecret`, `game`,
     and compute `needsConnect`/`connectSummary` from `DropLog`).
  5. Stamp the reservation (section 3.4) on `BotAccount` + its `DropLog` rows.
  6. Write `ResellerAudit{action:"assign"}`.
  Return `{ assigned, skipped:[{login, reason}] }`.
* `GET /resellers/assign/preview?logins=...` — optional dry-run that resolves a
  pasted blob and shows what each line would do (found / not found / already
  taken / how many drops) **before** committing. Strongly recommended so the
  operator can paste straight from the archive and see the result first.
* `POST /resellers/:id/reclaim` — body: account ids (owned by that reseller).
  Clear reservations, delete `ResellerAccount` rows, audit. (Also expose a
  single-account reclaim from the roster.)
* `GET /reseller-accounts?reseller=<id>` — full operator roster across/within
  resellers, credentials inline (mirror `/renter-accounts`). Superadmin only.
* `GET /reseller-audit?reseller=<id>` — the activity log (logins, reveals,
  sales, assigns) for oversight.

**Admin UX (build in `resellers.html`):**
* Reseller list with status, accounts-held, need-connect, sold, last-login.
* "Create reseller" form (username, password, display name, notes, limits).
* Reseller detail: roster table (login, game, connection status, reseller
  status, credentials reveal), a big **Assign accounts** paste box with the
  dry-run preview, reclaim buttons, password reveal/reset, suspend, and the
  audit feed.
* An **Assign** shortcut that accepts exactly what the operator copies out of
  the Drops Archive today (so the workflow is: select in archive → copy → paste
  here → preview → assign).

**Notifications (optional, reuse `utils/telegram`):** ping the operator's
Telegram when a reseller logs in for the first time / marks a batch sold, and
(if the reseller has a channel) notify them when a new batch is assigned. The
app already has a Telegram sender — reuse it; don't add a new dependency.

---

## 6. Decisions to confirm before building

These change the shape; the recommended default is given so building can start.

1. **Do resellers see full credentials (login + password + token) for their
   assigned accounts?** *Recommended: **yes**, but only via the audited,
   rate-limited per-account reveal endpoint (§4), never in a table.* Reselling
   inherently means delivering the account to an end buyer, so they need the
   credentials for accounts they've bought. If instead you want to withhold the
   token (deliver password only, keep the auth token operator-side), the reveal
   endpoint simply omits `clientSecret`. **Confirm which.**
2. **Money/ledger?** The reseller "keeps buying." *Recommended: Phase 2* — add a
   per-reseller balance + ledger mirroring the existing admin wallet
   (`utils/admins.js` balance + `BalanceLog`) and a price-per-account so the
   panel shows what they owe. Not required for the first release.
3. **Continuous vs on-demand connection re-scan.** *Recommended: on-demand*
   ("Verify live" button, §4) plus the snapshot taken at assign time. A
   background scanner for reseller accounts (mirror `renterDropScanner`) is a
   Phase 2 nicety; on-demand keeps the first build small and avoids extra load.
4. **Can a reseller self-serve a re-order request?** *Recommended: a simple
   `POST /reseller/request` that just notifies the operator (Telegram) — no
   automatic fulfilment.* Cheap, useful, low-risk.

---

## 7. Build phases (build + review each before the next)

1. **Models + auth realm.** `Reseller`, `ResellerAccount`, `ResellerAudit`;
   `utils/resellers.js` (create/auth/sanitize/reveal — copy `utils/renters.js`);
   `middleware/resellerAuth.js`; `resellerAuthRoutes.js`; login page; wire into
   `server.js` (§8). *Acceptance: can create a reseller (via a temporary script
   or the admin route from phase 3), log in, hit `/reseller/whoami`, and a
   suspended reseller is locked out on the next request.*
2. **Superadmin panel + assignment.** `resellerAdminRoutes.js` +
   `resellers.html`: CRUD, the paste-to-assign flow with dry-run, reservation
   stamping, reclaim, roster, audit feed. *Acceptance: paste logins from the
   archive → preview → assign; the accounts leave operator supply (verify
   shop/catalog/auto-farm no longer offer them); reclaim returns them.*
3. **Reseller portal.** `resellerRoutes.js` + `reseller.html`: inventory table,
   detail/connection checklist, audited credential reveal, status controls,
   verify-live, summary. *Acceptance: reseller sees only their accounts;
   connection status is correct; credentials reveal is audited; all the IDOR
   probes in §9 fail closed.*
4. **Polish + notifications + (optional) Phase-2 items** from §6.

---

## 8. Integration into `server.js` (exact placement)

Mirror the renter wiring. Add near the other route requires:
```js
const resellerAuthRoutes  = require("./routes/resellerAuthRoutes");
const resellerRoutes      = require("./routes/resellerRoutes");
const resellerAdminRoutes = require("./routes/resellerAdminRoutes");
const { requireReseller } = require("./middleware/resellerAuth");
```
Serve the portal page (like `/renter.html`), **before** `express.static`:
```js
app.get("/reseller.html", requireReseller, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "reseller.html"));
});
```
Serve the admin page with the other superadmin pages:
```js
app.get("/resellers.html", requireSuperadmin, enforce2fa, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "resellers.html"));
});
```
Mount the routers **before the `requireAdmin` blanket routers** (same spot the
renter routers mount), so the public login + `requireReseller` portal are
reachable and the admin routes self-guard:
```js
app.use(resellerAuthRoutes);
app.use(resellerRoutes);
app.use(enforce2fa, resellerAdminRoutes);
```
Add the new rate limiters in `utils/rateLimit.js`:
`resellerRevealLimiter` (tight — e.g. a few reveals/min/IP) and
`resellerLiveLimiter` (Twitch-facing, like `renterLiveLimiter`). Reuse the
existing `loginLimiter` for login. `reseller-login.html` and
`reseller.html` need no CSP change (keep them same-origin/inline like the rest).

`public/reseller-login.html` and `public/reseller.html` are served by the
`requireReseller` route / are public static respectively — do **not** put the
portal behind `requireAdmin`.

---

## 9. Testing & acceptance — especially the security tests

Add `node --test` files under `tests/` (the repo runs `node --test tests/*.test.js`
against `mongodb-memory-server`). Cover:

**Isolation / IDOR (must all fail closed):**
* Reseller A cannot read Reseller B's account: `GET /reseller/accounts/:idOfB`
  → 404.
* Reseller A cannot reveal B's credentials, set B's status, or verify B's
  account → 404.
* No portal endpoint honours a `reseller`/owner id or `all` flag from
  query/body — scope always comes from the session.
* A reseller session cannot reach any admin/superadmin route
  (`/drops-archive.html`, `/resellers`, `/reseller-accounts`, `/admins`, …) →
  401/redirect. A reseller cannot reach renter routes and vice-versa.
* List endpoints never include `clientSecret`/password/email in the payload
  (assert the keys are absent).
* Suspended / access-expired reseller: blocked on the next request, session
  destroyed.
* Login is rate-limited; `regenerate()` changes the session id on login.

**Correctness:**
* Assign: pasted logins resolve; already-sold/assigned/listed logins are skipped
  with reasons; assigned accounts get the reservation stamped and disappear from
  shop/catalog/auto-farm supply queries; `ResellerAccount` + audit rows created.
* `needsConnect`/`connectSummary` computed correctly from `DropLog.state`.
* Reclaim / delete-reseller clears reservations and returns accounts to supply
  (no account left stranded with `soldAt` set but no owner).
* Credential reveal returns the right creds for an owned account and writes a
  `reveal_creds` audit row.

**Manual smoke:** create reseller → assign a small batch from the archive →
log in as the reseller in a private window → confirm they see exactly those
accounts, correct connection badges, working reveal (audited), and nothing else.

---

## 10. Deployment (this app's conventions)

* Production is a **separate remote host** (not the local checkout), run under
  PM2 behind a reverse proxy; deploy the way the other features here are
  deployed (see `REMOTE-HOSTS-SETUP.md` / the deploy docs). New Mongoose
  collections are created on first write — **no migration needed**; the two new
  fields on `BotAccount`/`DropLog` default empty and are backward-compatible.
* Set nothing new in the environment except (optionally) the reseller rate-limit
  tunables if you make them env-driven. `SESSION_SECRET`, `MONGO_URI`, helmet,
  and the session store are already configured.
* After deploy: create the first reseller, assign a test batch, run the §9
  manual smoke from a clean browser, then check the audit feed shows the login +
  reveal. Then push the code to the GitHub backup remote.
* Because reseller accounts are removed from operator supply via `soldAt`,
  double-check once in production that a freshly-assigned account no longer
  appears in the shop, the public catalog, or an auto-farm plan.

---

## 11. One-paragraph summary to paste at the top of the build task

> Build a **Reseller** subsystem for this Node/Express + Mongoose app by
> mirroring the existing **Renter** subsystem (`models/Renter*.js`,
> `middleware/renterAuth.js`, `routes/renter*Routes.js`,
> `public/renter*.html`, `utils/renters.js`). Resellers are a **separate login
> realm** (`req.session.reseller`, never `req.session.admin`) with their own
> secure portal to see only the accounts assigned to them, the drops on each,
> and whether each still needs to be **connected to a game/publisher account**
> (`DropLog.state` = `connect`/`connected`), plus a superadmin panel to
> paste-assign accounts from the drops archive, reveal credentials, and audit
> activity. Assigning an account reserves it out of operator supply by stamping
> the existing `soldAt` fields (+ new `resellerId`/`soldResellerId` markers).
> Enforce the section-2 security rules exactly, and ship the section-9 IDOR
> tests. Do not add "reseller" as an admin role.
</content>
</invoke>
