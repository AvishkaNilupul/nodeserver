# Account listings — review findings to fix

Raised by an adversarial review of the build (2026-09-10) and each one
re-verified by hand against the code before being written down here. These are
confirmed defects, not suggestions. Fix them exactly.

Same rules as `docs/ACCOUNT-LISTINGS-CONTRACT.md`: additive and guarded, no
`npm run format`, no Mongoose sub-document spreads, comment the WHY, and every
change must keep `npm test` green (baseline 1677 pass / 0 fail).

---

## F1 — `utils/suppliedStock.js` (five fixes, one file)

**F1a. `extra` is stored in cleartext while its siblings are encrypted.**
`addAccounts` writes `extra: a.extra` raw (~:494) while `password`,
`clientSecret` and `email` all go through `encrypt()`. A 5-field paste routes
real credential material (a mail password, a second address) into `extra`, so
the same class of secret is ciphertext in one column and cleartext in the next.
Encrypt it on write and decrypt it wherever it is read back (`deliveryText`'s
`{extra}`, `claimForListing`'s returned `extra`, `rawLine`).

**F1b. The in-archive double-sell gate misses case-different logins.**
`archiveLogins` (~:410) queries `BotAccount.find({ login: { $in: part } })`
with only the pasted spelling and its lowercase form. `BotAccount.login` is
stored verbatim from the bot config's `Login` field, and every other join in
this repo compares logins **lowercased**. So a pool/bot account stored as
`DropFarm_X91` is not flagged when the owner pastes `dropfarm_x91`, and it
becomes claimable supplied stock while the archive can still sell it — the
exact double-sell this gate exists to prevent. Match case-insensitively.
`BotAccount` has no lowercased mirror field, so do it the way the rest of the
repo does: read the candidate rows and compare lowercased in JS, keeping the
indexed `$in` as the coarse filter, and add the lowercased spelling of each
pasted login to the `$in` as now. If that cannot be made exact, fall back to an
anchored case-insensitive `$in` of `RegExp`s **chunked and bounded**, and say
in a comment why the index cost is accepted.

**F1c. A failed archive lookup silently marks the whole batch conflict-free.**
Both queries in `archiveLogins` end in `.catch(() => [])` (~:419), so a
transient read failure reports zero overlaps. The flag is computed **only at
ingest and never revisited**, so those rows stay permanently claimable. A
failed lookup must not be reported as "no conflicts": let the failure surface
so `addAccounts` can either refuse the paste or flag every inserted row
`conflict:"in-archive"` (fail closed — a false conflict costs one click, a
missed one sells an account twice). Say which you chose and why in a comment.

**F1d. `claimForListing` does not enforce the per-offer auto-deliver switch.**
`deliveryEnabled(offer)` exists (~:390) and is never called from
`claimForListing` (~:550). `utils/g2gFulfiller.js:220-222` states in a comment
that "the claim layer enforces" it — that comment is currently false, so
`offer.autoDeliver === false` is ignored on G2G. Make it true: load the offer
and apply `deliveryEnabled` inside `claimForListing`, returning `[]` when
delivery is switched off. It is the single claim layer, so enforcing it there
fixes every caller at once. Keep `dryRun` able to report stock regardless, so
the panel can still show what is on the shelf while delivery is paused.

**F1e. `releaseClaim` can never release a `fed` row.**
Its filter is `status: "sold"` (~:687), but the credential-baked-in markets
move rows to `fed` at publish/feed time (`markFed`). So
`gameflipFulfiller.releaseSuppliedUnits` (~:516) — the function that hands
accounts back when a Gameflip listing 404s or is retired — matches zero rows,
returns 0, logs nothing, and the account is stranded out of sellable stock
forever. Release must accept **both** `sold` and `fed`, still refusing any row
with `deliveredAt` set (a delivered account must never return to the shelf).

---

## F2 — `utils/g2gFulfiller.js`

**F2a. G2G ignores the offer's delivery template.** It is the only fulfiller
that never calls `suppliedStock.deliveryText`: the hand-over is built with
`g2gDeliveryCode(c.login, c.password)` (~:411), so `AccountOffer.deliveryTemplate`
is discarded and the account's `{token}`, `{email}` and `{extra}` never reach
the buyer — while the order is still confirmed delivered and the ledger row
stamped sold, so the shortfall is unrecoverable. Use `deliveryText(account, offer)`
for offer-backed rows, exactly as Eldorado, PlayerAuctions and Z2U do. Keep
`g2gDeliveryCode` for every other stock source.

**F2b.** Once F1d lands, the comment at ~:220-222 is true. Re-read it and make
sure it still describes what the code does; if you load the offer here as well,
do not double-report the same refusal.

---

## F3 — `public/listings.html`

**Clicking "Change" without picking publishes the PREVIOUS listing's category.**
`mpPickWins(name)` (~:3827) returns true as soon as `mpAutoRevealed[name]` is
set — but *revealing* the picker is not *picking*. `dsSelected` / `ggSelected`
(~:3948, :4073), `#mpFpNode` and `#mpG2gProduct` are module-level and are reset
only on the first tick of their checkbox (`!dsCatsLoaded` / `!ggCatsLoaded`,
~:3742-3755), so they **outlive the modal**. `openPublishModal` (~:3578-3585)
resets `mpAuto` and `mpAutoRevealed` but not those selections.

Scenario: publish listing A to GGSel having drilled to
`Games > Rocket League > Twitch Drops`; open listing B (Overwatch), whose
category auto-resolves correctly; click "Change" to look at the tree and pick
nothing; publish. B goes live in **Rocket League's** category.

Fix: clear the picker selections when the publish modal opens — `dsSelected`,
`ggSelected`, the FunPay node input and the G2G product select — so a leftover
pick can never reach the body. This also fixes the same staleness on the
no-auto path, which pre-dates this feature (the existing "Drill down to a GGSel
catalog category first" guard is satisfied by a stale selection today). Leave
the loaded category trees alone — re-loading GGSel's 24k-child top level on
every modal open is not acceptable; only the *selection* is cleared.

---

## F4 — `routes/marketplaceRoutes.js`

**The owner's hand-picked G2G service+brand is never sent.** `body.g2g` carries
only `productId` / `offerAttributes`, never the `serviceId` / `brandId` the
owner drilled to, so `bodyCategoryGiven("g2g")` is always false and the
auto-resolved brand always overrides the owner's explicit choice — while the
owner's product still supplies `relation_id` and the offer attributes, so the
offer is assembled from two different games. Either make the browser send the
picked `serviceId`/`brandId` (see F3's file) or derive them from the picked
product server-side; whichever you choose, an explicit pick must win over the
auto resolution, which is the whole contract of the "Change" link.

---

## F5 — `utils/listingCategory.js`

**A timed-out GGSel lookup is cached as a 30-minute HIT.** The GGSel resolver
absorbs a timed-out live lookup into the `autoFarm.ggselCategoryId` fallback and
returns `ok:true` (~:213-220), so the cache write at ~:609
(`resolution.ok ? CACHE_TTL_MS : MISS_TTL_MS`) stores a transient failure under
the 30-minute HIT TTL — six times the miss TTL, and long enough to publish real
offers into the generic default category. A resolution that only succeeded
because a live lookup timed out must be cached under the **miss** TTL (or not
cached at all). Mark such a resolution at the point the fallback is taken
rather than guessing at the cache site.

---

## F6 — credential leak into the audit log (`middleware/auditRequest.js`)

**Pasting stock writes a real login + password into `SystemEvent` in cleartext,
and `/activity.html` renders it.** `public/listings.html` POSTs
`{ accounts: "<the whole paste>" }` as JSON; `express.json` (server.js:184)
parses it before `auditRequest` (server.js:224); `summarizeBody`
(middleware/auditRequest.js:31-33) keeps the first 40 characters; and
`utils/systemLog.js`'s `SECRET_KEY` regex (~:10-11) does not match the key
`accounts`, so nothing is redacted. Reproduced end-to-end with the real
middleware:

```
meta: { accounts: "dropfarm_x91:Tr0ub4dor&3:kunuxa5qz9:mybo…" }
```

`models/SystemEvent.js:28` states the invariant this breaks — meta is "NEVER a
secret" — and the row lives for the 90-day TTL. It is logged on **every**
outcome, including a 403 or a 500, because `auditRequest` summarizes the body
before the router runs.

Fix it centrally so no future route can reintroduce it: the body summary must
redact any value that looks like a pasted credential list. Prefer widening the
redaction to the key names that carry them (`accounts`, `lines`, `text`,
`paste`) **and** keeping a value-shaped guard for `login:password` lines, so a
differently-named field is still caught. Do not fix it only in the browser —
the leak must be impossible server-side.

---

## F7 — `utils/playerauctionsFulfiller.js`

**A paid order on a switched-off account listing parks with no record.** When
one of the three kill switches is off the supplied branch returns
`{ skipped: <reason> }`, but `ALERT_SKIPS` does not match those reasons and the
tick's logging chain only prints for `r.error` / `r.dryRun` / `r.delivered`, so
the reason string is discarded: a paid order sits unshipped with nothing in the
log and no alert. Make the skip visible — the owner must be able to find out
why an order was not delivered without reading the source.
