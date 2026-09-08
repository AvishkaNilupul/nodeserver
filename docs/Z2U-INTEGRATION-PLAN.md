# Z2U integration — the verified contract

Everything below was confirmed live against the real seller account
(`Avishkarex`) on **2026-09-08**, either from the production host or from a
signed-in browser session. Where an older note in this repo said something
different, the correction is called out.

## What Z2U is, mechanically

Z2U has **no API of any kind** — not even the half-API ZeusX exposes. The
seller panel is a server-rendered PHP site (ThinkPHP) and every "endpoint" is
the form the browser posts. So the integration is shaped like the FunPay one:
one stored session cookie, scrape the page, re-submit its own form.

**Prod is not blocked.** An older note claimed `cf_clearance` was bound to the
operator's browser IP and that the production host would get a 403, so a Chrome
extension bridge would be needed to publish. That is **not true of these paths
today**: from the prod host, `GET /` answers `200` and `GET /sell/manage`
answers a plain `302` to the login page. A WAF would have returned 403. No
bridge was built and none is needed.

## Credential

`FIELDS.z2u = ["cookie"]` — the whole `Cookie` header from a signed-in session
(DevTools → Network → any z2u.com request → copy the `Cookie` header). The
session cookies are httpOnly, so **the operator is the only possible source**;
browser tooling cannot read them. Renewed cookies are absorbed back into
settings on every call, so the paste keeps rolling.

Paste it under **Listings → Marketplace keys → Z2U**, then check it with
`GET /marketplaces/test/z2u` (the "Test" button).

## The surface

| What | Call |
|---|---|
| Game tiles (the account's `service`+`game` ids) | `GET /sell/manage` |
| Every offer in one group | `GET /sell/manageList?service=&game=` |
| One offer's editor form | `GET /sell/manageEdit.html?id=<pk>` |
| Save that form (price/stock/text) | `POST /sell/manageListToUpdate` |
| On sale / off sale / extend duration | `POST /sell/productAction` `{list_pk, list_action}` |
| Create a new offer | `POST /sell/submitSellInfo` |
| Bulk create from a spreadsheet | `POST /platform/Sell/acceptExcelProducts` |
| Sold orders | `GET /sellOrder/index/order_status/<STATE>` |
| One order + its delivery form | `GET /sellOrder?order_id=<Z…>` |
| Deliver that order | `POST /sellOrder/form_submit` |
| CSRF token | `GET /public/createToken` — value in the `__token__` RESPONSE HEADER |

`list_action` is one of `on_line` | `off_line` | `extend`.
Order states are `ALL` | `WAIT_DELIVERY` | `DELIVERED` | `COMMENT` | `CANCELED`.

**The CSRF token is the trap here.** `/public/createToken` is a **GET** (a POST
404s), and the token is **not in the body**: the envelope’s `url` field is a
redirect target that merely looks token-shaped, and `data` is empty. The real
value comes back as the **`__token__` response header** — the site’s own
`getToken()` reads it with `request.getResponseHeader("__token__")`. Getting
this wrong makes every write 404 while reads keep working.

Ajax replies are ThinkPHP envelopes — `{code, msg, data, url, wait}` — where
`code: 1` is success and `code: 0` carries a human message in `msg`
("Order does not exist."). The CSRF token comes back in the envelope's **`url`**
field, not `data`.

**Paging is `?page=N`.** The path-segment form Z2U uses elsewhere (`/p/2`) is
silently ignored and returns page 1 again, which would spin a paging loop
forever on the same 20 rows.

## Offer fields (the editor form, `#form`)

`list_title` · `list_description` · `list_online_date` (hours until visible)
· `list_term_of_validity` (**7/14/30 — the duration**) · `insurance` (0/7/15/30)
· `list_max_num` · `list_attr_id` · `list_platform_id` · `list_device_id[]`
· `list_area_id` · `list_transaction_mode[]` · `list_currency_type`
· `list_unit_price` · `list_stock_num` · `list_less_num` · `buy_multiple`
· `listPic[]` · `list_pk`

Enum values worth knowing: `list_attr_id` 29=Digital key, 30=Manual Top Up,
33=Account Ownership Transfer. `list_area_id` 35=Global. `list_platform_id`
12=Steam, 15=Xbox live, 19=PlayStation Network, 24=Uplay.
`list_transaction_mode[]` 5=Order Delivery.

**A save REPLACES the whole offer**, so anything not sent back is wiped. That is
why `z2uUpdateOffer` reads the form back and patches only the named fields
rather than reconstructing it — the same reasoning as the FunPay editor.

## The thing that actually makes Z2U different

**Every offer carries a DURATION, and Z2U takes it off sale when that runs
out.** Nothing announces it; the offer just stops being visible, keeps its
stock, and sits there. A shelf nobody tends goes dark on its own.

The seller panel's `.set_status[data-value]` is the real status:

| code | meaning | what it needs |
|---|---|---|
| 1 | on sale | nothing (or `extend` when near expiry) |
| 4 | paused by the seller | `on_line` |
| 5 | pulled by Z2U for running out its duration | `extend`, **then** `on_line` |

Relisting an expired offer without extending it first drops it straight back
off. That ordering is load-bearing and is pinned by a test.

Expiry date = the row's publish date + its duration, both of which the list
page prints.

## Delivery

Z2U *does* have a native credential vault with auto-delivery — `Storage`,
`Storage List`, `Delivery Logs`, and a `reloadKamiList` endpoint on the offer
editor ("kami" = 卡密, a redeem code). **It is gated behind an application:**
`/userStorage/product` redirects to `/userStorage/applyCheck.html` for this
account. Until the operator applies and is approved, auto-delivery through the
vault is not available.

So delivery uses the mode the account's 47 live offers already use — **Order
Delivery**: the buyer pays, the order lands in `WAIT_DELIVERY`, and the seller
posts the credential through the order's own delivery form. That is the same
shape as the Eldorado hand-over, so it reuses the same claim paths and the same
delivery copy.

The delivery form is per-category and only rendered while an order is actually
awaiting delivery, so `z2uDeliver` reads it off the live order page instead of
reconstructing it. If the page carries no delivery form, the order is not
deliverable (already delivered, cancelled, or under dispute) and it refuses
loudly rather than posting a payload Z2U would quietly drop.

## What is in the repo

- `utils/marketplaces.js` — the `z2u*` connector plus four **pure parsers**
  (`parseZ2uGroups`, `parseZ2uOffers`, `parseZ2uOrders`, `parseZ2uForm`) that
  are exported so the HTML shapes can be tested without a session.
- `utils/z2uFulfiller.js` — the shelf keeper (`keepShelfAlive`) and the
  delivery loop (`deliverPendingOrders`), on separate clocks: delivery polls one
  small page every 2 minutes, the shelf sweep reads ~16 pages of ~500KB every
  30. Both self-guard on flags and both ship in dry-run.
- `scripts/z2u-audit.js` — read-only. What is on sale, what is expiring, where
  advertised stock disagrees with claimable stock, what the shelf keeper would
  do (`--plan`), and what is waiting for delivery.
- `scripts/z2u-adopt.js` — links live offers to their stock source.
- `scripts/z2u-shelf.js` — runs the shelf keeper by hand, once, and prints what
  it actually did (`--apply`, `--revive`, `--limit=N`). This is how to do it the
  first time: the background tick does the same work on a 30-minute clock.
- `tests/z2u.test.js` — the HTML contract and the shelf-keeper policy.

### Flags (all default OFF / dry-run)

| flag | effect |
|---|---|
| `autoFarm.z2uAuto` | run the shelf keeper |
| `autoFarm.z2uShelfDryRun` | **defaults true** — set `false` to let it act |
| `autoFarm.z2uAutoDeliver` | run the delivery loop |
| `autoFarm.z2uDeliverDryRun` | **defaults true** — set `false` to let it send |

## How the parsers were verified

The exact shipped parser source was run inside the signed-in browser against
the live pages and its output compared field by field with the browser's own
DOM: **all 47 offers across 16 game groups, and all 20 orders on page 1**.
Numeric fields (offer id, status code, stock, price, duration) matched on every
row. Two real bugs were caught that way, and both are pinned by tests:

1. the row splitter cuts *inside* the opening tag, so every cell's text began
   with a stray `">`;
2. each cell fragment ends with a dangling `<div` that has no closing `>`,
   which an ordinary tag strip leaves behind.

A title legitimately containing quotes (`… — "EXPECTED FEAST" MP5SD`) is real
and is in the fixtures.

## State of the shelf when this was built (2026-09-08)

47 offers across 16 games — and **34 of them were off sale while only 2 were
genuinely empty**. Eleven of the sixteen games had *zero* live offers. That is
the duration mechanism above, working as designed, on a shelf nobody was
tending.

Matching those offers against the database (30 distinct products):

- **19** are the same product this site already sells elsewhere with a stock
  source wired up — 9 backed by the Drop Archive, 10 by the no-claim farm.
- **11** have no listing anywhere with a stock source; they stay manual.

Dark offers with real stock behind them included Hunt: Showdown (128 accounts),
Delta Force (95), Brawlhalla (59), Dead by Daylight (56), Dark and Darker (39).

**Two live problems the audit found, both of which the shelf keeper fixes:**

- Five Albion Online offers advertise 10 units each with **zero** claimable
  stock. They are currently paused, so nothing is oversold — but a naive
  "relist everything" would have oversold 50 units immediately. This is exactly
  why every action is gated on stock counted the way the delivery path counts
  it.
- The Overwatch and Rainbow Six offers that are **live right now** advertise far
  more than the no-claim farm can honour (R6: 8 live offers advertising ~75
  units against 1 sellable account). Those are no-claim games, so they can only
  be filled from the no-claim ledger. `keepShelfAlive` corrects the advertised
  quantity and pauses at zero.

## Writes are verified by read-back, never trusted

Two of this codebase's other marketplaces lie about whether an update landed:
**ZeusX returns a 500 for updates it HAS applied**, and **GGSel a 504 for ones
it has NOT**. Both were caught by a canary rather than by reasoning, and
trusting the status code left the database disagreeing with the live offer.

Z2U is a shared-hosting PHP site answering with a hand-rolled envelope, so it
gets the same distrust. `keepShelfAlive` acts on a whole game group, then
re-reads that group **once** and marks each action verified or mismatched
against what the offer actually looks like now — a group page is ~500KB, so
one re-read covering every action in it is what keeps this affordable.

The consequences are the point:

- an action that **reported an error but did land** is recorded as applied, and
  its error is dropped;
- an action that **reported success but did not land** is flagged
  (`reported success but the offer did not change`);
- the `autoPaused` flag is only written once the change is confirmed real, so
  the database never claims to have paused an offer that is still on sale.

## Two kinds of "off sale", and why only one is fixed automatically

Z2U says an offer is off sale but not who took it off.

- **Status 5** — Z2U pulled it for running out its duration. Unambiguous, so the
  keeper always extends and relists it.
- **Status 4** — a *person* paused it, and "paused because it was empty" cannot
  be told apart from "paused on purpose". A background job must never quietly
  undo a human decision, so reviving these is **opt-in**
  (`z2u-shelf.js --revive`, or `resumeSellerPaused`).

On the shelf as found, that distinction is where most of the money was: the
seller-paused offers included Hunt: Showdown with **128** accounts in stock,
Delta Force 95, Brawlhalla 59, Dead by Daylight 56, Dark and Darker 39.

The advertised stock is corrected only on an offer that is visible, or that the
same pass is about to make visible. Fixing the number on an offer that stays
dark changes nothing a buyer can see, and a stock change re-submits the whole
editor form — doing that for ~30 dark offers every sweep would hammer a
shared-hosting PHP site forever to no effect.

## Z2U throttles writes, and lies about it

Z2U answers seller actions with **"Operation too frequent, please try again one
hour later!"** — and the message means neither "applied" nor "rejected".
Measured on a real sweep at 1.2s spacing: 20 actions produced 9 of those
messages, and reading the offers back proved the change **had been applied
anyway in 7 of them**; only 2 genuinely did not happen, and both succeeded on a
spaced retry minutes later (not an hour).

This is the third marketplace in this codebase that lies about whether a write
landed, after ZeusX (500s on updates it applied) and GGSel (504s on ones it did
not). It is the whole reason every write here is verified by read-back.

Writes are spaced `WRITE_SPACING_MS` (4s) apart to keep the honest failures rare.

## A failed hand-over must give the account back

Delivery claims the account BEFORE sending the credential, because the reverse
order can hand one account to two buyers. So when the send fails, the claim has
to be undone or the account is marked sold to a buyer who never received it and
no later pass will offer it again. `releaseClaim()` returns it — an
`UnclaimedAccount` row goes back to `released`, a Drop Archive reservation is
released under the Z2U tag. Both are guarded on our own claim tag, so a row
claimed by another marketplace is never touched however the delivery failed.

## Traps

- **Never sell Overwatch / Rainbow Six / Call of Duty from the Drop Archive.**
  They are no-claim games: their drops must reach the buyer *unclaimed*, and the
  ordinary auto-farm claims as it farms. They may only be filled from
  `unclaimedGame`. `z2u-adopt.js` decides this by the GAME, not by the field the
  donor row happened to use — a donor that gets it wrong would otherwise spread
  the mistake.
- **Only ever resume a pause this system made** (`autoPaused`). A deliberate
  pause by the operator has to survive the tick.
- **An order is matched to its listing by title** — Z2U's order list gives the
  product title but not the offer id. Exact match first, normalised second;
  anything ambiguous is reported, never guessed.
- **Delivering twice is the one unrecoverable mistake**, so the row's `units[]`
  ledger is checked for the order id before anything is sent.
- Z2U is shared-hosting PHP: writes are spaced out, and the shelf sweep is on a
  slow clock.
