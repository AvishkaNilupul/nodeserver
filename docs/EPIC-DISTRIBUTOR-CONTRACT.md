# Epic auto-distributor

Owner ask (2026-10-30): "when a new account comes it auto lists … a better system", plus a panel
card on the Epic page. One loop decides where every new sellable Epic account goes, instead of the
G2G sweep loading every ready account into one $1 offer and PlayerAuctions being hand-listed.

## Who decides

`utils/epicDistributor.js` runs every 10 minutes (first run 2 minutes after start). Each run:

1. Reads stock with `epicSales.stockContext` / `readinessOf` — the same rules every market uses.
2. Puts each unsold, unlisted account in one of:
   - **skip** — not `source: "generated"` (the owner's own accounts are never listed automatically);
   - **hold** — blocked (inbox, missing login…), no games yet, or (switch on by default) one of its
     games is still free on Epic, so a buyer could claim it themselves;
   - a **market**, in this order, while that market has room:
     1. **PlayerAuctions** — one account per offer, owner price (default $5, PA minimum), up to
        `maxLive` (default 3). Richest accounts first. Needs the owner's saved phone + city, a live PA
        session, no 2FA on the account, and no PA unit stuck in `loading`/`error` (that brake stays on
        until the owner reconciles it).
     2. **Eldorado** — adds to an existing live Eldorado listing for exactly the same games, up to
        `maxPerListing`, only while Eldorado allows the category. Never creates a listing.
     3. **G2G** — a linked Instant offer whose games the account owns, up to `maxStock` (default 10)
        units listed + loading. Leanest accounts first (G2G's own rule).
   - **reserve** — sellable, but every market is full or none takes this game set. It fills the next
     free slot automatically.
3. Stores the plan (`EpicDistributorState.lastPlan`, ≤ 60 rows) for the panel.

## Modes

`off` (does nothing) · `plan` (default: computes and shows the plan, changes nothing) · `on`
(executes). Switching to `on` needs `confirm: true`. In `on`:
- at most **one** PA publish per run (PA throttles writes ~25 s apart and a publish is not
  idempotent) through `epicPa.publish` — the same reservation/verification path as the manual button;
- Eldorado through `epicSales.addAccounts`; G2G through `epicG2g.loadStock(offerId, { only })`;
- a failed account backs off 6 h; one Telegram summary per run that placed something.

While the distributor is `on`, the G2G sweep stops loading new accounts by itself (it still retries
and confirms units already sent). In `off`/`plan` the sweep behaves exactly as before.

## Owner contact for PlayerAuctions

PA requires original-owner first/last name, email, phone, city, country on every Account offer.
Name, email and country come from the account's own Epic registration. **Phone and city come only
from the owner's saved details** (encrypted in `EpicDistributorState.ownerEnc`; the panel shows them
masked). Generated accounts carry a made-up sample phone/address (`contactSource:
"synthetic-internal"`) — it is never sent to PA; the manual PA form no longer pre-fills it either.

## Never

Never moves an account out of a market. Never lists a sold, listed, manual, empty or blocked account.
Never invents contact data. Never touches Gameflip/Plati/GGSel/ZeusX. No new marketplace write path —
only the existing PA/Eldorado/G2G functions, under their own locks (the distributor itself never holds
`epicSales.withLock`, which those functions take).

## Routes (superadmin, no-store)

`GET /api/epic/sales/distributor` · `POST …/distributor/config` · `POST …/distributor/owner` ·
`POST …/distributor/preview` (plan now, no changes) · `POST …/distributor/run` (only in `on`).
