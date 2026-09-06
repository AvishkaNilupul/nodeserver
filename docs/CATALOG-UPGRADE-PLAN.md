# Public Catalog Upgrade — Build Plan

**Target page:** https://redeemhub.lets.game/catalog (`public/catalog.html` + `routes/catalogRoutes.js`)
**Author:** Claude (diagnosis + design), 2026-08-22
**Builder:** Sol
**Reviewer:** Claude (verify after Sol pushes)

---

## 0. Read this first

Everything below is grounded in measurements taken against the **live production
database** on 2026-08-21/22. Re-verify anything you doubt — the recipe for a
read-only prod harness is at the bottom (§8). Do not guess at numbers.

The catalog today is a **stale, partial, badly-named view of the inventory**. The
single biggest problem is not styling — it is that the catalog is hiding most of
the sellable stock and every recognisable product name.

---

## 1. What is wrong today (measured, not guessed)

### 1.1 The catalog cannot show event bundles at all — 322 bundles / 17,069 units hidden

`utils/autoLister.js:1291` and `:1633` create every auto-farm event bundle with:

```js
DropSet.create({ name: "Sea of Thieves — Season 20 Drops 3", ..., listed: false, custom: true })
```

`buildPublicCatalog()` (`routes/catalogRoutes.js:351`) selects with:

```js
DropSet.find({ listed: true, publicCatalog: { $ne: false }, custom: { $ne: true }, $or:[{price:{$gt:0}},{publicPrice:{$gt:0}}] })
```

`custom: true` + `listed: false` means **no auto-farmed event bundle has ever
appeared on the public catalog.** Measured on prod:

| DropSet bucket | count | on catalog? |
|---|---:|---|
| `catalog_profile` (generated variants), listed | 176 | yes |
| approved/manual, listed | 45 | yes |
| approved/manual, unlisted | 38 | no |
| `catalog_profile`, retired by sweep | 8 | no |
| **`custom: true` auto-farm event bundles** | **374** | **no** |

Of those 374, **322 have live deliverable stock right now, totalling 17,069
units** (measured with `stockForSets`, 38.6s). Examples the catalog is hiding:

```
2026-08-21   311 units  $0.75  Rocket League — Kai x Speed Play RL!
2026-08-21   137 units  $1.75  THE FINALS — DEEP SIGNAL EVENT
2026-08-20   272 units  $0.75  World of Tanks — Birthday Skill4ltu
2026-08-19   137 units  $1.25  Fortnite — Fortnite Reload @ EWC
2026-08-17    50 units  $2.25  Black Desert — 2026 BDO Drops (Aug 17)
```

These are the products buyers actually search for — real event names. The
catalog instead shows machine-generated bundles (§1.3).

### 1.2 The catalog is frozen in time

The only thing that creates catalog listings is `syncInventoryVariants`
(`routes/catalogRoutes.js:202`), which runs **only when a superadmin clicks
"Publish variants"** in `catalog-admin.html`. There is no scheduler.

- Last `catalog_profile` write on prod: **2026-08-18 07:35 UTC** — 4 days stale.
- `server.js:657` only calls `warmPublicCatalog()` (a cache warm), not a sync.

Every drop farmed since 2026-08-18 is invisible.

### 1.3 Machine-generated titles are unsellable

`profileTitle()` in `utils/catalogProfiles.js:46`:

```js
const highlighted = names.find((name) => /rlcs|drop|collection/i.test(name));
const label = highlighted ? highlighted.replace(/\s+(drop|collection drop)$/i, "") : `${items.length} reward types`;
return `${game} ${label} bundle - ${totalRewards} rewards`;
```

Live output on the page right now:

- `World of Tanks 1x Mystery bundle - 17 rewards`
- `World of Tanks 1x Mystery bundle - 43 rewards`
- `World of Tanks 1x Mystery bundle - 146 rewards`
- `World of Tanks 2 reward types bundle - 2 rewards`

`1x Mystery` is not a product name — it is the first item whose name happened to
contain "Drop". Buyers cannot tell these apart.

### 1.4 Near-duplicate sprawl

Measured subset relationships (bundle A's items ⊂ bundle B's items) among live
public sets:

| Game | live sets | subset pairs |
|---|---:|---:|
| World of Tanks | 19 | 111 |
| Overwatch | 20 | 66 |
| Rainbow Six Siege | 17 | 59 |
| Halo Infinite | 14 | 44 |
| Rocket League | 14 | 39 |

A buyer opening World of Tanks sees 19 cards, most of which are strict subsets of
each other, all called "1x Mystery bundle".

### 1.5 Smaller but real

- **Duplicate categories from label case.** Live: `Dark and Darker` (9 sets) *and*
  `dark and darker` (1); `Call of Duty: Black Ops 7` (4) *and* `call of duty:
  black ops 7` (1). `categoryFor()` (`routes/catalogRoutes.js:54`) groups on the
  raw string.
- **Zero-stock categories still listed** — `call of duty: black ops 7`, 1 set,
  `0 units available`.
- **No pagination.** `renderCards()` (`public/catalog.html:1251`) injects every
  matching listing at once. 221 cards → 25,390px page. It will be far worse after
  this work.
- **No sort control.** Order is fixed: featured → publicSort → updatedAt.
- **Conversion is zero.** `CatalogEvent`: 37 `catalog_view`, 64 `category_view`,
  65 `listing_view`. `CatalogInquiry`: **0**. 65 people opened a listing and not
  one requested a quote.
- Images, thumbnails and the theme toggle all work correctly — **do not "fix"
  those.** (Grey tiles on first paint are lazy-loading, not breakage.)

---

## 2. What we are building

Five phases. **Ship them in order**, each as its own commit, each independently
deployable and revertible. Phase 1 and 2 are the ones that matter.

---

## Phase 1 — Event bundles on the catalog, including **pre-order while farming**

This is the headline feature and the owner's explicit ask:

> when it's farming a bundle it lists on our platforms after farmed — but when
> the farm is *started*, those listings should go to the catalog *before*, so
> bulk buyers can get started as well.

Today an event bundle only reaches a marketplace after `pickDeliveryAccounts`
confirms an account holds the **complete** bundle. For a campaign like *Sea of
Thieves — Season 20 Drops 3* the top tier needs **360 minutes** of watch time, so
that gate holds the listing back ~6 hours after farming starts. Bulk buyers
should be able to reserve during that window.

### 1a. Stamp a catalog-visible DropSet the moment a task goes active

**Where:** `utils/autoFarmer.js` — `executeTask()`, immediately after the
`AutoFarmTask.updateOne({ status: ok ? "active" : "failed", ... })` block at
**`utils/autoFarmer.js:1937`**. Only when `ok === true` and `append === false`.

Create (or upsert) a **separate** DropSet:

```js
{
  name:  `${task.game} — ${task.campaignName}`,
  items: await autoLister.campaignItems(task.campaignId, task.game, task.campaignName),
  sourceType:      "autofarm_event",
  sourceEventKey:  `autofarm:${task.campaignId}`,   // upsert key — idempotent per campaign
  sourceEventName: task.campaignName,
  listed:        true,
  publicCatalog: true,
  custom:        false,          // MUST be false or the catalog query skips it
  price:         <derivePrice(research)>,
  // NEW fields, see §4
  catalogState:    "preorder",
  farmStartedAt:   new Date(),
  campaignEndAt:   task.campaignEndAt,
  expectedUnits:   (task.assignedAccounts || []).length,
  autoFarmTaskId:  String(task._id),
}
```

**Critical rules:**

1. **Do not touch the marketplace path.** `autoLister.listActivatedTask` keeps
   creating its own `custom: true` set exactly as it does today. Two DropSets per
   event is intentional here — the `custom: true` one is invisible to the catalog,
   so there is no visible duplication and the blast radius is zero. Consolidating
   them is Phase 5, not now.
2. **Idempotent.** Use `updateOne({ sourceEventKey }, { $set: {...} }, { upsert: true })`.
   `executeTask` can run again for the same campaign (append mode, approve button).
3. **Never throw into the farm path.** Wrap the whole thing in try/catch and
   `console.error` on failure. A catalog write must never fail a farm deploy.
4. `campaignItems()` does a **live, integrity-gated Twitch call** and can throw
   ("Campaign details unavailable", "no resolvable drop items"). If it throws,
   log and skip — no set, no crash. Do **not** publish a set with zero items.

### 1b. Promote pre-order → in-stock automatically

**Where:** the existing 10-minute auto-farm tick (`utils/autoFarmer.js`, near the
auto-listing sweep at `:3014`).

For every DropSet with `sourceType: "autofarm_event"` and `catalogState: "preorder"`:

- if live stock (from `stockForSets`) > 0 → set `catalogState: "instock"`
- if the linked `AutoFarmTask.status` is `completed`/`stopped` **and** stock is 0
  → set `catalogState: "soldout"` (keep it visible; it is a real "ask us" signal)
- if `campaignEndAt` has passed and stock is 0 → `listed: false`

Call `catalogRoutes.invalidateCatalogCache()` after any state change.

### 1c. Live farming progress + ETA on the pre-order card

The data already exists — **do not build a new scanner.**
`utils/dropScanner.js:515` writes `BotAccount.farmingProgress[]`:

```js
{ name, game, campaign, imageURL, current, required, percent, connected, scannedAt }
```

plus `farmingSnapshotAt`. `utils/resellerFarmingForecast.js:184` already reads it —
**reuse that reader, don't write a second one.**

For a pre-order set, compute over the task's `assignedAccounts`:

```
perAccount   = max(required - current) across that account's unclaimed rows
               matching this campaign
remainingMin = min(perAccount) across accounts        // first account to finish
elapsed      = now - farmingSnapshotAt                // snapshot can be hours old
etaMinutes   = max(0, remainingMin - elapsed/60000)
percent      = mean(percent) across the campaign's rows
```

Watch time accrues ~1 minute per minute, so `required - current` is a direct
minute estimate. Surface as `readyInMinutes` + `progressPercent`. Round to hours
in the UI ("ready in ~3h"). **Guard against a stale snapshot** — if
`farmingSnapshotAt` is older than 12h, return `progressPercent` but suppress the
ETA rather than showing a wrong one.

Reference numbers from the live SoT campaign (probed 2026-08-21 16:10 UTC):
accounts at 191–211 min watched, 4 of 7 items already claimed, top tier 360 min →
`readyInMinutes ≈ 150`, `progressPercent ≈ 82`.

### 1d. Public API surface

Extend `publicListing()` (`routes/catalogRoutes.js:96`) with:

```jsonc
{
  "state": "preorder" | "instock" | "soldout",
  "eventName": "Season 20 Drops 3",
  "campaignEndsAt": "2026-08-26T09:59:59.999Z",
  "preorder": {                      // present only when state === "preorder"
    "expectedUnits": 36,
    "progressPercent": 82,
    "readyInMinutes": 150            // omit entirely when the snapshot is stale
  }
}
```

**Hard privacy rule — unchanged:** the public payload must never contain account
logins, passwords, `accountScopeLogins`, `accountScopeIds`, or host/config names.
Re-read `publicListing` before you extend it; keep the same discipline.

### 1e. UI

In `public/catalog.html`:

- New rail directly under the hero, above `#categories`:
  **"Farming now — reserve ahead"**, horizontally scrollable, pre-order cards only.
- Pre-order card: amber `Pre-order` badge, progress bar, `~Xh until ready`,
  `~N units expected`, event name as the title, `Reserve now` CTA (not "Request
  quote").
- **A pre-order card must never render a stock number or the words "in stock".**
  It shows *expected* units, visually distinct (different colour token, the word
  "expected"). We are not promising inventory we do not hold.
- `Ending soon` badge when `campaignEndsAt` is within 48h.
- The quote dialog (`openQuote`, `public/catalog.html:1427`) must pass
  `preorder: true` and the expected-ready date through to `CatalogInquiry`
  (add `preorder: Boolean` + `expectedReadyAt: Date` to
  `models/CatalogInquiry.js`), and the confirmation copy must say the order is a
  pre-order and when it is expected to be deliverable.

---

## Phase 2 — Make the existing listings legible

### 2a. Real titles

Rewrite `profileTitle()` (`utils/catalogProfiles.js:46`). Rules, in order:

1. If the profile's items all belong to one campaign whose name is known, use
   `"{Game} — {Campaign}"`.
2. Otherwise name by tier, derived from the item count's position within that
   game's profiles: `"{Game} Drops — Starter / Standard / Complete Bundle"`.
3. Always append the size as a subtitle, never inside the name:
   `"{n} rewards · {m} types"`.

Kill the `/rlcs|drop|collection/` regex entirely. Never let a raw item name
become the product name.

### 2b. Collapse the subset sprawl

In `buildCatalogProfilePlan()` (`utils/catalogProfiles.js:64`), after `ranked`:

- Sort a game's profiles by item-set size.
- Drop any profile whose item set is a **strict subset** of a larger kept profile
  *and* whose stock is ≤ the larger one's — it offers the buyer nothing.
- Cap what survives per game at **6** tiers (new default; keep it configurable via
  the existing `maxProfilesPerGame` knob, which is currently 40).

Target: World of Tanks 19 → ~5, Overwatch 20 → ~5.

### 2c. Category hygiene

In `categoryFor()` (`routes/catalogRoutes.js:54`): group case-insensitively,
then display the **most frequent original casing** as the label. Fixes
`Dark and Darker` / `dark and darker` and the Black Ops 7 pair.

Hide categories whose total stock is 0 from the `#categories` grid (keep them
reachable via search).

---

## Phase 3 — Buyer-facing UX

- **Sort control** on `#inventory`: Newest · Price ↑ · Price ↓ · Most stock ·
  Most rewards. Client-side over the already-loaded array.
- **Pagination / progressive render.** Render 24 cards, then `IntersectionObserver`
  to append. Non-negotiable once the list is ~600 items.
- **Bulk price tiers on the card.** `bulkMinQty` / `bulkDiscountPct` already exist
  on `DropSet` and are already used by `publicPriceFor()`. Show the ladder
  (e.g. `10+ $1.20 · 50+ $1.05 · 100+ $0.95`) instead of one opaque unit price.
  This is the most likely cause of 65 listing views → 0 inquiries.
- **Lower the quote friction.** Contact field currently demands an email. Accept
  Telegram/Discord handles explicitly in the placeholder and label, state an
  expected reply time, and keep the form to two fields above the fold.
- **Mobile pass.** Verify at 375px: the category grid, the new farming rail
  (horizontal scroll must not scroll the page body), and the dialogs.
- Keep the existing indigo tokens and the light/dark split — `catalog.html` has a
  **separate** `:root[data-theme="dark"]` block; any new colour must be defined in
  **both**.

---

## Phase 4 — Keep it fresh automatically

- Add a scheduled `syncInventoryVariants({ apply: true })` on the existing tick
  infrastructure, **every 6 hours**, reusing the `variantSyncJob` guard at
  `routes/catalogRoutes.js:800` so two syncs never overlap.
- Surface `generatedAt` in the UI as a real relative timestamp
  ("inventory checked 12 minutes ago") — it is already in the payload.
- Log each sync to the auto-farm event log so it is auditable.

---

## Phase 5 — Optional follow-up (do NOT do this in the same PR)

Consolidate the two DropSets per event (the `custom:true` marketplace one and the
new `autofarm_event` catalog one) into a single row keyed on `sourceEventKey`.
This also fixes the known duplicate-DropSet sprawl in `autoLister` (it calls
`DropSet.create` unconditionally on every publish, with no dedupe — 3 co-existed
for Halo). Higher risk: it touches the live marketplace fulfilment path. Separate
PR, separate review.

---

## 4. Schema changes

`models/DropSet.js` — add and **declare** these (Mongoose strict mode silently
drops undeclared paths on `$set`; this repo has been bitten by that twice):

```js
catalogState:   { type: String, enum: ["instock","preorder","soldout"], default: "instock", index: true },
farmStartedAt:  { type: Date,   default: null },
campaignEndAt:  { type: Date,   default: null, index: true },
expectedUnits:  { type: Number, default: 0 },
autoFarmTaskId: { type: String, default: "" , index: true },
```

`models/CatalogInquiry.js` — add `preorder: { type: Boolean, default: false }`
and `expectedReadyAt: { type: Date, default: null }`.

No migration needed — all defaults, self-populating on first write.

---

## 5. Performance budget — read this before you write the query

`buildPublicCatalog()` is **already ~55s cold** on prod. You are about to add
~322 more sets to it. Naive changes will make the page unusable.

1. **Call `stockForSets` exactly ONCE over the merged list.** It does a single
   `DropLog` aggregation over the union of all item keys, then evaluates each set
   in memory. One call over 595 sets is much cheaper than two calls over 221 and
   374. Measured: 38.6s for the 374 custom sets alone, ~55s for the current 221 —
   merged should land well under their sum.
2. **Atlas has `allowDiskUse` disabled** (shared tier). Any `$group` over 100MB
   just throws. Never carry name/image strings through a per-drop group — that is
   exactly the pattern that broke this sync before and forced the two-pass split
   in `buildCatalogProfilePlan`. Follow that split if you add an aggregation.
3. The per-set loop in `stockForSetFromHoldings` is O(sets × holdings). At 595
   sets × ~3,000 holdings it is the dominant in-memory cost. If it regresses, index
   `holdings` by itemKey once instead of scanning all holdings per set.
4. The 5-minute cache + `warmPublicCatalog()` on boot + stale-while-revalidate
   already protect visitors. Keep all three. **Measure the cold build before and
   after** and put both numbers in the PR description.

---

## 6. Tests — required, not optional

Add to `tests/`, following the existing style (`node --test`, no network, no DB):

| File | Must cover |
|---|---|
| `catalogEventSets.test.js` | pre-order set is built from a task correctly; upsert is idempotent for the same `campaignId`; a `campaignItems` throw produces **no** set and does not propagate; `custom` is `false` |
| `catalogPreorderEta.test.js` | ETA maths — normal case, all-complete (0 min), stale `farmingSnapshotAt` → ETA suppressed but percent kept, empty `farmingProgress` → no crash |
| `catalogProfiles.test.js` (extend) | new titles never contain a raw item name; strict-subset profiles are dropped; per-game cap honoured |
| `catalogRules.test.js` (extend) | `categoryFor` is case-insensitive and returns the dominant casing; `publicListing` never leaks `accountScopeLogins`/`accountScopeIds`/logins |

Run the **whole** suite before pushing:

```bash
npx prettier --write . && node --test tests/*.test.js
```

Prod's suite was 318 pass / 0 fail as of 2026-08-20. **Do not regress that.**

---

## 7. Deploy + push (this repo's conventions — follow them exactly)

1. **Branch off `main`**, one commit per phase, clear messages.
2. **Never `git pull` on prod.** Deploys are targeted file copies.
3. **Fingerprint every file before overwriting.** Prod runs a *mix of unmerged
   branches* — its git checkout ref lies. Compare `git hash-object --no-filters`
   on prod against `git show <ref>:<file> | git hash-object --stdin` locally. If a
   file has drifted, start from **prod's** copy and re-apply only your diff.
4. Back up originals into `_deploy_backup_<ts>_catalog/` on prod before extracting.
5. `node --check` + a `node -e "require('./routes/catalogRoutes')"` load test
   **before** swapping anything in.
6. `pm2 restart redeemer`, then confirm `online`, `unstable_restarts: 0`,
   "MongoDB connected" / "Server started".
7. **Do not copy `tests/*.test.js` to prod.** Tests are not runtime and have caused
   phantom prod-suite failures before.
8. Push the branch to GitHub (`origin` = `AvishkaNilupul/nodeserver`) as the
   off-server backup, and open a PR. Prod is the deploy target; GitHub is backup.

### Live verification after deploy

```bash
curl -s "https://redeemhub.lets.game/catalog/listings?limit=5" | head -c 2000
curl -s "https://redeemhub.lets.game/catalog/categories" | head -c 600
```

Then in a browser at 1440px **and** 375px: hero → farming rail → categories →
listings → open a details dialog → open a quote dialog. Both themes.

---

## 8. Read-only prod harness recipe

```
ssh -i ~/.ssh/claude_prod_deploy_ed25519 root@202.92.214.91
# app dir: /var/www/redeemer/nodeserver   (scripts MUST live here — node needs node_modules)
```

`scp` a throwaway `_probe.js` into the app dir, `require("dotenv").config()`,
`mongoose.connect(process.env.MONGO_URI)`, query, **then delete the file.**
Long queries: `nohup node _probe.js > /tmp/probe.log 2>&1 &` and poll — anything
touching `stockForSets` takes 30–60s and will blow an SSH timeout.

Admin endpoints are session-only (no header bypass). To exercise one, mount the
deployed router in a throwaway Express app with a stub superadmin session and
fetch over localhost.

---

## 9. Acceptance checklist (what I will verify)

- [ ] A campaign that starts farming appears on the catalog within one tick, as
      **Pre-order**, with the real event name, before any marketplace listing exists
- [ ] A pre-order card shows expected units and progress, and **never** a stock
      count or the words "in stock"
- [ ] It flips to In stock automatically once accounts complete the bundle
- [ ] Event bundles with live stock are visible — expect roughly 322 more listings
      / ~17,000 units than today
- [ ] No listing title contains "1x Mystery bundle" or "N reward types bundle"
- [ ] World of Tanks shows ≤ 6 tiers, not 19; Overwatch ≤ 6, not 20
- [ ] `Dark and Darker` and `dark and darker` are one category
- [ ] Public API leaks no login, password, scope array, host or config filename
- [ ] Cold catalog build time is reported, and is not worse than ~60s
- [ ] Sort + progressive render work; page height is bounded
- [ ] Mobile 375px is clean; both themes are clean
- [ ] Full test suite green, new tests included
- [ ] Deploy fingerprinted per file, backup dir created, branch pushed to GitHub
