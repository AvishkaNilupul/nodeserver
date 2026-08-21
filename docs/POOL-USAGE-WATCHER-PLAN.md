# Account Pool — Usage Watcher tab

**Goal:** A new tab inside the Account Pool page that answers, at a glance:
*"Which game used how many pool accounts today, and where did those accounts go?"*
A watcher / dashboard for the operator — NOT the per-account history (that already
shipped and is the data source this reads from).

**Status:** spec / hand-off. Build, push, then it gets reviewed + adjusted.

---

## 1. What it shows (the view)

A **game-centric consumption dashboard** with a time-window toggle:
**Today · Last 7 days · Last 30 days · All time** (default: Today).

### A. Summary strip (top)
- Accounts consumed in window (total claims)
- Accounts returned to pool in window (releases + recycles)
- Net out of pool (consumed − returned)
- Ready pool size right now (existing `readyPoolQuery` count)

### B. Per-game table (the main thing)
One row per game, sorted by "consumed" desc:

| Game | Consumed | Still farming | Recycled back | Sold | Rented | Where it went |
|---|---|---|---|---|---|---|
| World of Tanks | 40 | 30 | 8 | 2 | 0 | breakdown chips |
| UFL | 12 | 12 | 0 | 0 | 0 | … |

- **Consumed** = count of `claimed` events for that game in the window.
- **Still farming / Recycled / Sold / Rented** = where those accounts are now,
  derived from the events (see §3).
- **Where it went** = small chips by `actor` (auto-farm / noclaim / webbot /
  renter / bot-deploy) so you can see the destination mix.

### C. Live activity feed (right side or below)
Reverse-chronological stream of the raw events in the window:
`14:32 · World of Tanks · claimed 1 (auto-farm · campaign 90210)`
`14:05 · UFL · recycled 1 (auto-farm)`
This is the "watcher" part — refreshes on an interval so you can watch it move.

---

## 2. Data source — new `PoolUsageEvent` collection (DECIDED)

The watcher reads from a **new flat, uncapped, indexed `PoolUsageEvent`
collection** — chosen over unwinding the capped embedded arrays so long-term
(month-over-month) trends survive the 50-entry-per-account cap.

**Wire it into the existing helper (the ONLY new instrumentation):**
`utils/poolUsageLog.js#recordPoolUsage` already fires at every
claim/release/recycle/rent/sale/deploy and writes the embedded
`AvailableAccount.usageHistory[]`. Make it **also** insert one `PoolUsageEvent`
doc per account per event — a dual-write. Keep the embedded-array write too (the
per-account History modal already deployed reads it); the new collection is purely
additive. Keep it best-effort (a logging failure must never break the transition).

New model `models/PoolUsageEvent.js`:
```js
const mongoose = require("mongoose");
const poolUsageEventSchema = new mongoose.Schema({
  at:         { type: Date, default: Date.now, index: true },
  accountId:  { type: mongoose.Schema.Types.ObjectId, ref: "AvailableAccount", index: true },
  username:   { type: String, default: "" },   // denormalized for the feed (no join)
  event:      { type: String },                // claimed|released|recycled|rented|returned|sold
  game:       { type: String, default: "" },
  campaignId: { type: String, default: "" },
  actor:      { type: String, default: "" },   // auto-farm|retro-reaper|manual|renter-admin|noclaim|webbot|bot-deploy
  host:       { type: String, default: "" },
});
poolUsageEventSchema.index({ game: 1, at: -1 });
poolUsageEventSchema.index({ event: 1, at: -1 });
module.exports = mongoose.model("PoolUsageEvent", poolUsageEventSchema);
```

> `recordPoolUsage` currently takes `idOrIds`. To denormalize `username` into the
> event doc without an extra query per call, either (a) look the usernames up once
> per call via `AvailableAccount.find({_id:{$in:ids}},{username:1})`, or (b) add an
> optional `usernames`/`accounts` field to the entry passed by callers. (a) is
> simpler and the call volume is low; use it unless it shows up as hot.

**Forward-only (DECIDED):** no DropLog backfill. The collection starts empty and
fills from the next claim onward; the tab will be sparse until the pool cycles,
which is expected and accepted.

---

## 3. API — `GET /account-pool/usage-summary?window=today|7d|30d|all`

Superadmin. Returns the numbers the tab renders. Aggregate over the
`PoolUsageEvent` collection (flat — no `$unwind`, and `$match` on the indexed
`at` runs first):

```js
// window -> since Date (today = start of operator's day; see §7 on timezone)
const pipeline = [
  { $match: { at: { $gte: since } } },
  { $group: { _id: { game: "$game", event: "$event" }, count: { $sum: 1 } } },
];
// (a parallel { $group: by actor } or a second facet gives the byActor chips)
```

Then reshape server-side into:
```json
{
  "success": true,
  "window": "today",
  "totals": { "consumed": 52, "returned": 16, "net": 36, "readyPool": 900 },
  "games": [
    { "game": "world of tanks", "consumed": 40, "farming": 30, "recycled": 8,
      "sold": 2, "rented": 0, "byActor": { "auto-farm": 38, "bot-deploy": 2 } }
  ]
}
```

Mapping of event → column:
- `claimed` → **consumed** (and split into byActor)
- `recycled` → **recycled back**
- `released` → returned (counts toward totals.returned, usually no game)
- `sold` → **sold**
- `rented` → **rented**
- **Still farming** = `claimed − recycled − sold − released` for that game in
  window (accounts consumed that haven't come back yet). Clamp at ≥0.

Separate endpoint `GET /account-pool/usage-feed?window=…&limit=100` for the
activity stream: `find({ at: { $gte: since } }).sort({ at: -1 }).limit(limit)` —
`username` is denormalized on the event, so no join needed.

**Atlas note (shared tier, allowDiskUse off, 100MB cap — memory:
atlas-no-diskuse):** reading a flat collection with `$match` on the indexed `at`
first keeps this trivially under the cap; the `{ at: -1 }`, `{ game: 1, at: -1 }`,
`{ event: 1, at: -1 }` indexes cover the summary and feed queries.

---

## 4. UI

`public/account-pool.html` already has a tab pattern (the status tabs:
available / claimed / suspended / all). Add a **"Usage"** tab next to them.

- Selecting it hides the accounts table and shows the dashboard container.
- Window toggle (Today / 7d / 30d / All) → refetches `usage-summary`.
- Render the summary strip, the per-game table, and the activity feed.
- Auto-refresh the feed + summary every ~30s while the Usage tab is active
  (clear the interval when leaving the tab) — that's the "watcher" behaviour.
- Reuse existing chip / table / card styles; no new dependencies.

---

## 5. Design decisions

**Resolved:**
- **Data layer** → build the `PoolUsageEvent` collection (§2). ✓
- **History** → forward-only, no backfill (§6). ✓

**Still to pick (small; sensible defaults in parens):**
- **Timezone for "today"** — server runs UTC; operator wants their local day.
  (Default: browser passes its start-of-day as an ISO string in the query, so
  "today" matches the operator's clock without hardcoding an offset.)
- **"returned" definition** — (Default: recycles + releases + sold + returned all
  count as "came off"; "Still farming" = consumed − those, clamped ≥0.)
- **Per-campaign drill-down** — campaignId is stored, so click-through is cheap.
  (Default: ship game-level for v1, drill-down as a fast-follow.)

---

## 6. Backfill — NOT doing it (DECIDED)

Forward-only. The tab starts sparse and fills as the pool cycles. (If that ever
changes: `DropLog` ties account → game farmed and could seed history via a
one-off backed-up script — but it is out of scope for this build.)

---

## 7. Rollout / safety

- **Read-only feature** — new endpoints + new tab, no change to how accounts are
  claimed/recycled. Very low risk.
- No new env, no migration (reads existing `usageHistory`; the optional
  `PoolUsageEvent` collection self-creates on first write).
- After deploy: refresh graphify, push to GitHub (per standing prefs).

## 8. Review checklist (for the check-after-build pass)
- [ ] `usage-summary` numbers reconcile with the raw feed for the same window.
- [ ] "Still farming" never goes negative; totals add up (consumed − returned = net).
- [ ] Window boundaries correct for the chosen timezone.
- [ ] Aggregate stays Atlas-safe (early `$match`, no diskUse needed).
- [ ] Usage tab auto-refresh interval is cleared when switching away (no leak).
- [ ] Games with a claim but no game string (edge: manual claims) are bucketed
      sanely (e.g. "(unspecified)") rather than dropped silently.
