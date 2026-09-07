# Auto-farm event bundles — contract

Status: built 2026-09-08. Owner's ask: _"we built a bundler system for the
unclaimed farm — makes bundles and lists them. Do the same thing for the auto
farm."_

Read `docs/UNCLAIMED-BUNDLES-CONTRACT.md` first: this is the same idea applied
to the auto-farm's own stock, reusing that module's parser, titles and event
catalog rather than growing a second copy of them.

## Why (what the auto-farm does today)

1. **One campaign = one listing.** `autoLister.listActivatedTask` publishes a
   task's own campaign items. Twitch ships events in waves — `CAH Championship
Week 1` then `Finals`, `EWC 2026 DAY 1..10` — so each wave becomes its own
   thin listing while the accounts that farmed several waves hold the whole
   event and nobody sells it as one.
2. **The one bundling path that exists is blind.** `listStackedBundle` unions
   the items of **every** prior auto-farm set for the game, regardless of
   event. Then the holdings gate (correctly) finds nobody holding that union,
   so the usual outcome is `nothing extra to stack` /
   `no free account holds the full stack yet`. When it does fire it publishes
   `"… stacked bundle (Campaign X + 5 earlier events)"` — a title that names no
   event and no waves.
3. **Its price ignores the bundle.** `stackedBundlePrice(derivePrice(research))`
   is the solo price ×1.25 capped at +$1, off an anchor that undercuts
   `gameflip.lowest` — frequently our own row (the self-undercut documented in
   the unclaimed contract). Bundle size, event completeness and what this exact
   set has already sold for are not inputs.
4. **The manual proof already exists.** `POST /api/radar/events/:id/listing`
   builds exactly the right artefact — merged wave items, `accountScopeLogins`
   scoped to the event's tasks — but only when an operator clicks it, and it
   stops at the DropSet: publishing is a second manual step.

So the gap is not "the auto-farm cannot make event bundles", it is that nothing
makes them **automatically**, titles them, or prices them on evidence.

## What this adds

`utils/autoFarmBundles.js` (NEW, pure + thin DB loaders) decides bundles;
`utils/autoLister.js` `listStackedBundle` publishes them through the machinery
it already has. No new sweep, no new model field, no change to
`utils/autoFarmer.js` (its stacked-bundle sweep calls the same function with
the same signature and reads the same `{ listed }` shape).

### The decision

For a task's game:

1. Load the event catalog — `unclaimedBundles.loadCatalog({ games })` over
   `TwitchCampaign` + `CampaignDrops`, so waves, wave order and per-wave
   manifests are the same ones the unclaimed side uses.
2. Place every one of the game's stock-bearing tasks (`active` / `completed` /
   `stopped`, with assigned accounts) on a wave, by campaignId first and by
   `parseWave(campaignName)` when the catalog does not know the campaign.
3. Group by event. An event with **two or more** farmed waves is a bundle
   candidate; a single-wave event is already the solo listing.
4. Items per wave come from that wave's task's own published `DropSet` when it
   has one (it carries images and the real qty) and from the campaign manifest
   otherwise. A wave whose items are unknown is left out and the event cannot
   be `full`.
5. Merge with `radarEventListings.mergeWaveItems` — qty **sums** across waves,
   so an item granted by Week 1 and by Finals is promised as `2×` and the
   holdings gate demands two copies. This is the same rule the manual radar
   event listing uses.
6. `full` = every **started** wave of the event is held. Only a full bundle may
   claim `COMPLETE BUNDLE` in its title or take the full-event price bonus.

### The title

`unclaimedBundles.bundleTitle` is reused verbatim, fed a classification built
from the plan, so both farms produce the same house style and the same
120-char clamping:

```
Overwatch 2 Twitch Drops — CAH Championship COMPLETE BUNDLE (Week 1 + Finals · 7 Items)
Rainbow Six Siege Twitch Drops — EWC 2026 DAY 1 + DAY 2 (4 Items) — 2× Alpha Pack + …
```

### The price

`utils/pricing.priceListing` (the shared engine), not `derivePrice`:
evidence from `pricingEvidence.evidenceFor({ game, marketplace, research })`,
`itemCount` = total qty, `fullEvent` = the plan's `full`, and
`soldFloorUsd` = the best price this event's own bundle actually sold at in the
last 30 days, so a repeat bundle never relists below what a buyer already paid.
If the engine is unavailable or returns nothing the old
`stackedBundlePrice(derivePrice(...))` still applies — the price path fails
soft, never to zero.

### Guards (all of them already load-bearing elsewhere)

- **Holdings gate.** Accounts come from `pickDeliveryAccounts`, so every unit
  provably holds every item at the promised copy count, is unconnected,
  unsold, and is not on another active listing.
- **Never steals the solo listing's stock.** Same exclusion — an account
  selling the current wave is not eligible for the event bundle.
- **One live bundle per event.** Before publishing, an active `MarketplaceListing`
  on a set with `sourceType:"autofarm-bundle"` and this `sourceEventKey` skips
  the run. This is the duplicate-set sprawl guard the solo path still lacks.
- **Half now, half later.** `computeSplit` as before: the rest stays unlisted
  for the next wave to bundle on top of.
- **Kill switch.** `autoFarm.autoFarmEventBundles` (default **true**). Off ⇒
  `listStackedBundle` behaves exactly as it did before this change.

### What is deliberately NOT changed

- `listActivatedTask` (the solo, per-campaign listing) — untouched.
- `onCampaignEnded` — its markup/retitle/stack gate is untouched.
- `derivePrice` — still what the solo path uses.
- `utils/autoFarmer.js`, `utils/farm2/*`, `models/*` — no edits.
- The catalog's `sourceType:"autofarm_event"` preorder sets — a different
  system with a different key shape (`autofarm:<campaignId>`); the new sets use
  `autofarm-bundle` so neither query sees the other.

## Files

| File                              | State | Work                                                                                                            |
| --------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------- |
| `utils/autoFarmBundles.js`        | NEW   | wave placement, event grouping, plan, title, note, price                                                        |
| `tests/autoFarmBundles.test.js`   | NEW   | node:test, no Mongo/network                                                                                     |
| `utils/autoLister.js`             | EDIT  | `listStackedBundle` publishes an event bundle when there is one; `buildDescription` gains optional `extraLines` |
| `scripts/autofarm-bundle-plan.js` | NEW   | read-only dry run: what would be bundled, titled and priced                                                     |
| `routes/autoFarmRoutes.js`        | EDIT  | `GET /auto-farm/bundles` (read-only view of the same plan)                                                      |
| `utils/settings.js`               | EDIT  | `autoFarmEventBundles` default + save whitelist                                                                 |

## Verifying before trusting it

```bash
node scripts/autofarm-bundle-plan.js            # every game
node scripts/autofarm-bundle-plan.js --game="Overwatch 2" --verbose
```

Read-only: it opens Mongo, prints each event's waves, merged items, verified
holder count, title and price, and writes nothing.
