# Account Pool — Usage Tracking Plan

**Goal:** In the Account Pool section, be able to open any pooled account and see a
full history of *where it has been used* — which game/campaign it was auto-farmed
on, when it was recycled, when it was rented, sold, released, etc. — instead of
only the single current status.

**Status:** spec / hand-off. Build this, push it, then it gets reviewed and adjusted.

---

## 1. Why this is needed (the current gap)

Today an `AvailableAccount` (the pool model, `models/AvailableAccount.js`) records
only:

- `status` — `"available"` | `"claimed"`
- `claimedAt` — when it was last claimed
- `claimedNote` — a **single** free-text string describing the *current* claim

Every transition **overwrites or erases** that one field, so there is no history:

| Transition | What happens to `claimedNote` |
|---|---|
| Auto-farm claims it for a game | set to `auto-farm: <game> (<campaignId>)` |
| Recycled after a campaign | overwritten to `recycled after <game>` |
| Retro-reaper recycles it | overwritten to `recycled by retro-reaper` |
| Released back to pool | **erased to `""`** |
| Rented to a renter | overwritten to `rented to <renter>` |
| Sold / token reclaimed | overwritten to `sold — token reclaimed by buyer` |

So the moment an account recycles or is released, the record of *which game/campaign
it just farmed* is gone. The tracker must capture each transition as an **append-only
event** the instant it happens.

---

## 2. Data model — append-only usage log

Add a capped, append-only array to `models/AvailableAccount.js`:

```js
// Append-only trail of everywhere this pool account has been used. Each
// transition (claim / release / recycle / rent / sale) pushes one entry; the
// current status fields (status/claimedNote/claimedAt) stay as-is for existing
// callers. Capped so a long-lived account that cycles hundreds of times can't
// grow the doc unbounded (Atlas: watch bytes returned).
usageHistory: {
  type: [
    {
      at:         { type: Date, default: Date.now }, // event time
      event:      { type: String },   // enum below
      game:       { type: String, default: "" },   // when known
      campaignId: { type: String, default: "" },   // when known
      note:       { type: String, default: "" },   // the human note used at the time
      actor:      { type: String, default: "" },   // "auto-farm" | "retro-reaper" | "renter-admin" | "manual" | "noclaim" | "webbot"
      host:       { type: String, default: "" },   // optional, if the deploy host is known at that point
      _id: false,
    },
  ],
  default: [],
},
```

**`event` enum** (keep it small and stable):

- `claimed` — moved available → claimed (any claimer)
- `released` — claimed → available with no game context (plain release)
- `recycled` — claimed → available after finishing a game (carries `game`)
- `rented` — claimed for a renter lease
- `returned` — renter lease ended, back to pool
- `sold` — token handed to a buyer / reclaimed
- `deleted` — (optional) record just before hard-delete, if we ever want a tombstone log

**Cap:** push with `$slice: -50` (keep newest 50). If you'd rather keep unbounded
history, use the separate-collection alternative in §6.

---

## 3. One helper, called from every transition

There are ~12 write sites that change pool status. Do **not** hand-push in each one —
add a single helper and call it everywhere so the shape stays consistent.

Create `utils/poolUsageLog.js`:

```js
const AvailableAccount = require("../models/AvailableAccount");

// Append one usage event to one or many pool accounts. Best-effort: a logging
// failure must never break the claim/release it is recording.
async function recordPoolUsage(idOrIds, entry) {
  const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
  if (!ids.length) return;
  const doc = { at: new Date(), event: "", game: "", campaignId: "", note: "", actor: "", host: "", ...entry };
  await AvailableAccount.updateMany(
    { _id: { $in: ids } },
    { $push: { usageHistory: { $each: [doc], $slice: -50 } } },
  ).catch((e) => console.error("recordPoolUsage failed:", e.message));
}

module.exports = { recordPoolUsage };
```

### Instrumentation points — call `recordPoolUsage` at each of these

| # | File:line (approx) | Transition | Suggested entry |
|---|---|---|---|
| 1 | `utils/autoFarmer.js:693` (`claimPoolAccounts`) | auto-farm claims for a game | `{ event: "claimed", actor: "auto-farm", note, game: preferGame }` — parse `campaignId` from the note if present |
| 2 | `utils/autoFarmer.js:716` (`releasePoolAccounts`) | plain release | `{ event: "released", actor: "auto-farm" }` |
| 3 | `utils/autoFarmer.js:928` | recycle after game/sale | `{ event: "recycled", actor: "auto-farm", game }` |
| 4 | `utils/autoFarmer.js:942` | sold — token reclaimed | `{ event: "sold", actor: "auto-farm", note }` |
| 5 | `utils/autoFarmer.js:1998` | retro-reaper recycle | `{ event: "recycled", actor: "retro-reaper" }` |
| 6 | `utils/autoFarmer.js:2328` | recycle after `<game>` | `{ event: "recycled", actor: "auto-farm", game: t.game }` |
| 7 | `routes/accountPoolRoutes.js:547` | manual Claim button | `{ event: "claimed", actor: "manual", note }` |
| 8 | `routes/accountPoolRoutes.js:564` | manual Unclaim | `{ event: "released", actor: "manual" }` |
| 9 | `routes/renterAdminRoutes.js:1670` & `:2116` | rented to a renter | `{ event: "rented", actor: "renter-admin", note }` |
| 10 | `routes/renterAdminRoutes.js:2132` | renter return | `{ event: "returned", actor: "renter-admin" }` |
| 11 | `routes/noclaimFarmRoutes.js:321` / `:382` / `:726` | no-claim claim / release | `{ event: "claimed"|"released", actor: "noclaim" }` |
| 12 | `routes/webbotFarmRoutes.js:301` / `:314` / `:336` / `:708` | webbot claim / release | `{ event: "claimed"|"released", actor: "webbot" }` |

> Tip for #1: the auto-farm note is `auto-farm: <game> (<campaignId>)`. Parse the
> `campaignId` out of the parenthetical so the history row links back to the campaign,
> not just the game name.

Because most of these already do a `findOneAndUpdate`/`updateOne` with `$set`, the
cleanest form is to add the `$push` to the **same** update op where practical
(atomic, one round-trip). For the `claimPoolAccounts` loop and the bulk recycle
`updateMany` sites, fold the `$push` into that same update. Use the helper only
where a second write is unavoidable.

---

## 4. API

**Add** `GET /account-pool/:id/history` (superadmin) → returns the account's
`usageHistory` newest-first. Keep it a **separate endpoint fetched on demand**
(when the history modal opens) rather than fattening `/account-pool/list` — the
list already returns the whole pool and the drop-archive work showed Atlas cost is
bytes-returned, so don't ship the full array on every list row.

**Add two lightweight fields to `publicAccount()`** in `accountPoolRoutes.js` for
at-a-glance context in the table (cheap — derived, not the whole array):

- `usageCount` = `a.usageHistory?.length || 0`
- `lastUsedGame` = the `game` of the most recent history entry that has one

---

## 5. UI (`public/account-pool.html`)

1. Add a **"History"** (or 🕓) button per row. There's already a modal pattern to
   reuse — `revealBg` (the reveal-password modal, ~line 200) — clone it into a
   `historyBg` modal.
2. On click → `GET /account-pool/:id/history` → render a simple **timeline**:
   `<when> · <event> · <game/campaign> · <note> (<actor>)`, newest first.
3. Add a small **"used N×"** badge / last-game column to the row so you can scan the
   table without opening each one. Feed it from the new `usageCount` / `lastUsedGame`
   list fields.
4. This is display-only — no change to claim/unclaim behavior.

---

## 6. Alternatives / open decisions (call these out before building)

- **Embedded capped array (recommended)** — simplest, co-located, zero extra query
  for count/last-game, safe under Atlas. Downside: history capped at 50 events.
- **Separate `PoolUsageLog` collection** — unbounded history, cleaner for analytics
  across accounts, but adds a join/extra query for the modal and the list badges.
  Choose this only if you want full lifetime history or cross-account reporting.
- **Seed from `DropLog`** (optional enrichment): `DropLog` already ties
  `AvailableAccount` → farmed drops by game and is real historical evidence. A
  one-time backfill could pre-populate `usageHistory` (or at least `lastUsedGame`)
  for accounts that farmed before this feature existed.

---

## 7. Rollout / safety

- Purely **additive** field + **display-only** UI. No change to how accounts are
  claimed, recycled, or spent → low risk.
- **Backfill:** existing accounts start with an empty history. Optionally seed one
  synthetic entry from the current `claimedNote` + `claimedAt` on first deploy so
  in-flight accounts aren't blank.
- Logging is **best-effort** — a `recordPoolUsage` failure must never break the
  claim/release it records (the helper already swallows errors).
- After deploy: refresh the graphify code-graph, and push to GitHub as backup.

---

## 8. Review checklist (for the pass after Sol builds it)

- [ ] Every one of the 12 instrumentation points in §3 actually pushes an event
      (grep for `status: "claimed"` / `status: "available"` and confirm each has a
      matching `recordPoolUsage`/`$push`).
- [ ] Release/recycle no longer *silently loses* the game context (it's in history).
- [ ] `campaignId` is parsed and stored for auto-farm claims.
- [ ] List payload didn't balloon (history not shipped per row; only count + lastGame).
- [ ] Cap (`$slice: -50`) is present so long-lived accounts can't grow unbounded.
- [ ] History modal renders newest-first and handles the empty case.
- [ ] No behavior change to claiming/recycling/reuse-only gates.
