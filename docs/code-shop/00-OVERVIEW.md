# Code shop — overview and ground rules

The code shop turns reward codes the drops farm has already claimed and stored
(`SoopInventoryItem` rows with `hasCode: true`) into marketplace stock, keeps
that stock honest (one code is sold once), takes it off sale before it stops
working, and shows the owner what is in stock, on sale and sold.

It does NOT deliver anything itself. Selling and delivery reuse the existing
"account listings" stock mode (`docs/ACCOUNT-LISTINGS-CONTRACT.md`):

- a **product** (our `CodeProduct`) owns one `AccountOffer`;
- a **unit** is one `SuppliedAccount` row of that offer: its `login` is an
  internal label, its `password` (encrypted) is the buyer text holding one
  code per slot, e.g. `1) Sun Tea Player Icon = XXXX-XXXX-...`;
- the existing fulfillers (Eldorado chat delivery, GGSel vault) sell units;
  the existing 15-minute Eldorado stock sync advertises / pauses / resumes.

Every stored code gets one **ledger** row (`CodeStock`). The ledger is the only
place that knows which code sits in which unit.

## Files (all new unless marked)

| File | Role |
| --- | --- |
| `models/CodeStock.js` | Ledger: one row per stored code |
| `models/CodeProduct.js` | A sellable bundle (slots, texts, price, markets) |
| `models/CodeShopConfig.js` | One settings document (`key: "main"`) |
| `models/CodeShopEvent.js` | Activity log, 30-day TTL; also alert stamps |
| `utils/codeShop/config.js` | Read/write config with defaults, 30 s memo |
| `utils/codeShop/events.js` | `log()` / `recent()` / `stamp()` |
| `utils/codeShop/textGuard.js` | Pure buyer-text checks |
| `utils/codeShop/slots.js` | Pure: group / slot keys, ordinals, KST dates |
| `utils/codeShop/ingest.js` | Inventory rows → ledger rows |
| `utils/codeShop/allocate.js` | Pure: free codes → units per product |
| `utils/codeShop/units.js` | Write units (and dissolve them) |
| `utils/codeShop/fill.js` | Allocate free codes into units of active products |
| `utils/codeShop/reconcile.js` | Unit status → ledger state |
| `utils/codeShop/expiry.js` | Pull stock before its use-by date |
| `utils/codeShop/games.js` | Per-game buyer guides (defaults) |
| `utils/codeShop/texts.js` | Pure: default title/description/delivery/cover |
| `utils/codeShop/eventDates.js` | Start date of the event(s) a product's codes come from (R14) |
| `utils/codeShop/planner.js` | Draft products from free stock |
| `utils/codeShop/adopt.js` | Take over an existing hand-made code offer |
| `utils/codeShop/cover.js` | Cover image for a product |
| `utils/codeShop/publish.js` | Approve, publish, take down |
| `utils/codeShop/competitors.js` | Eldorado public same-set scan |
| `utils/codeShop/pricing.js` | Clearance + competitor price decisions |
| `utils/codeShop/claimAlert.js` | Telegram: rewards about to expire unclaimed |
| `utils/codeShop/digest.js` | Daily Telegram summary |
| `utils/codeShop/afterSale.js` | Dead-code reports and replacements |
| `utils/codeShop/farmPriority.js` | Point the farm at games that sell |
| `utils/codeShop/views.js` | Read models for the panel |
| `utils/codeShop/service.js` | The scheduler (`start()`, one tick every 5 min) |
| `routes/codeShopRoutes.js` | Superadmin API under `/api/code-shop` |
| `public/soop/tab-sales.js` (+ helpers) | "Sales" tab of the farm panel |

Farm-side changes (existing files): bots that new logins join by themselves,
the faster join when a campaign starts, and the Twitch-link field for cookie
renewal — see `04-OPS.md`.

## Ground rules (apply to every file)

1. **Live markets are real money.** Nothing in this subsystem may put a live
   listing at risk. Every write to `SuppliedAccount` is a single atomic
   `updateOne`/`findOneAndUpdate` guarded by the status it expects. Never
   rewrite the `password` of a unit that is not `available`.
2. **A code is sold once.** A ledger row moves into a unit only through an
   atomic `in_stock → in_unit` update; a unit's codes come only from rows that
   update won. A code that might have reached a buyer is never put back on sale.
3. **Never print, log, return or store a plaintext code** outside the unit's
   encrypted `password` and the inventory's `codeEnc`. Logs and events carry
   counts, labels and masked shapes only. The only API that returns codes is
   the after-sale replacement call (explicit owner action, `no-store`).
4. **Buyer-facing text never says where codes come from** — no platform name,
   no country/region, no "from the official … event", no "translated". The
   guard in `textGuard.js` refuses such text and non-ASCII text.
5. **Blocked markets stay blocked.** The shop only publishes to `eldorado` and
   `ggsel`. Gameflip, Plati/Digiseller and everything else are refused in code.
   GGSel also respects `mp.ggselTakesNewStock()`.
6. **Ships dark.** Defaults: no auto-publishing, no auto-pricing. Writes that
   change live stock (building units, expiry pulls) only touch products the
   owner approved or adopted.
7. **Manual prices are never changed.** A product with `pricing.mode: "fixed"`
   (the default, and always for adopted offers) is never repriced.
8. **The repository is public.** No real offer ids, prices, sales numbers,
   hostnames or code samples in tracked files (tests use made-up values).
9. **Dependency injection for tests.** Every module that does I/O takes an
   optional `deps` object (models, marketplaces, telegram, clock, farm) so tests
   never reach a live service. Real Mongo in tests via `mongodb-memory-server`.
10. CommonJS, `node:test` + `node:assert/strict`, match the existing style
    (2-space indent, double quotes, semicolons, short comments that say why).

## States at a glance

```
ledger: in_stock ──claim──▶ in_unit ──unit sold──▶ sold
           ▲  │                 │  └─unit removed by owner──▶ in_stock
           │  │                 └─near use-by (unit pulled)──▶ expiring ──▶ expired
           │  └─near use-by──▶ expiring
           └─ (never back from sold / held / dead)
        held  = cannot be sold safely (GGSel vault release, missing unit, duplicate code)
        dead  = reported dead after sale (after-sale)
```
