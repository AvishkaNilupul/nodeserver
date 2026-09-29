# Support triage log

Newest first. One entry per sweep review. Anything needing a message to a buyer is
drafted here and left for a human to send — the sweep never sends.

---

## 2026-09-07 ~16:30 UTC — first sweep, baseline

Built the sweep, mapped the PlayerAuctions inbox, read all 46 buyer threads, and
installed the hourly cron. Baseline: **76 items, 55 urgent** — the urgent count is
dominated by 63 open guardian findings, not by live buyers.

### Needs a human, in order

**1. Wobbic — order 16458589 — "wrong password", 11.5h unanswered.**
Root cause found. We sent `gkpchqu : 0Gxde8hst3k9%5Ef`. The pool holds the same
password with a literal `^` where the message has `%5E` — 14 characters, not 16.
The buyer is right; the credential we sent cannot work.

The account itself: `AvailableAccount` status `claimed`; `BotAccount` marked
`soldAt 2026-09-05`, `soldTo: manual`, sitting in `noclaim-bot-4` on the Pi;
`UnclaimedAccount` status `removed`. Nothing suggests the account is dead — only
the password transcription.

Draft reply (not sent — needs a human, and the password should be re-read from the
pool at send time rather than copied from here):

> Sorry about that — the password I sent got mangled in transit. The `%5E` in the
> middle should be a single `^` character. Full password: `<re-read from pool>`.
> If that still fails, tell me and I'll send you a replacement account right away.

**2. `playerauctionsAutoDeliver` is OFF while `playerauctionsAuto` is ON.**
Offers are live and can sell tonight; nothing will deliver them. PA's guarantee is
measured in hours and a breach costs a penalty fee plus hidden offers — the corpus
already contains three orders that went late because the operator was asleep, and
order 16458589 tripped *"Seller delivery guarantee expired - first notice"* at
7h27m. Right now the queue is empty (0 paid-and-unshipped), so nothing is on fire.
Only the operator can decide to flip this on; `playerauctionsDeliverDryRun` is
already `false`, so it would deliver for real.

**3. Three buyers were sent `%XX`-mangled credentials** (Wobbic, SpititKin,
drummondddsss). SpititKin was recovered by sending a different account;
drummondddsss's stored password is itself encoded. 56 of 3199 pool accounts hold an
already-encoded password. See TAXONOMY.md §4 — the delivery code is clean, so the
encoding most likely enters at the manual copy step. Worth ten minutes awake.

**4. One old dispute still open** — order 16420465, buyer Manomaninho, $5, Call of
Duty MW4 beta, disputed 2026-08-23 (15 days). Not new, but it has never closed.

### Older threads where the buyer spoke last

Not urgent by age, all still unanswered, all from the "already claimed / got
nothing" family (TAXONOMY.md §1):

| Buyer | Order | Last said |
|---|---|---|
| xavqul | 16449512 | *"yea i still havent got any of the items other than 1 loot box"* |
| Ksks9ekwmsns | 16435665 | *"the new twitch account u gave me it alrdy claimed the rewards"* |
| Bubbaskiddo | 16427586 | *"Are you just someone else that's scamming people?"* |
| DomoAstro | 16410661 | *"Anything previous rewards i dont get"* |
| mykristian | 16408598 | *"can we do a refund? Otherwise I don't want to do a chargeback"* |

mykristian's is a live chargeback threat that was never answered.

### Everything else the sweep found

- **63 open guardian findings**: 51 `claim-mismatch`, 10 `restock-failed`,
  2 `dead-token`. These are complaints in waiting — a claim-mismatch means an
  account in a live listing is no longer reserved for it.
- 3 unread storefront messages, all from 2026-07-24 and all benign
  (*"Ok I think everything is here"*). Downgraded to `info` by age.
- 0 Eldorado disputes, 0 Eldorado paid-and-undelivered, 0 PA pending delivery,
  0 system errors in 24h, 0 stuck farm-service orders.

### Side effect to know about

Reading a PA thread body marks it read on PlayerAuctions — there is no read-only
way to fetch a message. The unread badge in the PA web inbox is therefore no longer
a reliable signal; `latest.json` is. Wobbic's message was unread when found and is
now marked read.

### Gaps worth closing when awake

- Eldorado buyer chat is unreadable (TalkJS send-only). Eldorado auto-delivers
  tonight, so a complaint there is invisible until it becomes a dispute.
- Gameflip, Digiseller, GGSel, G2G, FunPay and ZeusX have no message reader at all.
- `playerauctionsInbox()` belongs in `utils/marketplaces.js`, not in the sweep.

---

## 2026-09-07 ~16:45 UTC — addendum: PA auto-delivery switched ON

Operator approved turning `playerauctionsAutoDeliver` on. Done:
`false → true`, `playerauctionsDeliverDryRun` left at `false`, so it delivers for
real. `utils/settings.json` backed up to `settings.json.bak-preflip` first.

No restart was needed — `playerauctionsFulfiller.start()` runs its ticker
unconditionally and re-reads the flag every 60s, so the change takes effect on the
next tick. pm2 `redeemer` online, restarts 55, unstable 0.

**Caveat found after the fact, worth knowing.** Two long publishing runs were
already in flight on prod when the flag was flipped —
`scripts/pa-bundle-listings.js --all` (18 min in, launched as a dry run) and
`scripts/reprice-listings.js --apply --titles`. The documented procedure is to park
`playerauctionsAutoDeliver=false` during a long run so the pm2 tick cannot race the
session, which is very likely why it was off in the first place. That precaution is
belt-and-braces rather than mandatory: `paRefreshOnce()` serialises refresh across
processes with a lock file and re-checks the token under the lock.

Checked, and it is behaving:

- `.playerauctions-refresh.stamp` updated 24s before the check — a refresh happened
  and completed cleanly
- zero `401` / `session not accepted` lines in `redeemer-error.log`
- delivery queue empty (0 paid-and-unshipped), so the quiet delivery log is correct,
  not a stall

**If a 401 storm appears on later sweeps, turn the flag back off** — that is the
signature of the concurrent-refresh failure, and it signs the operator's own browser
out too.

Sweep at 16:41 UTC: 76 items, **0 new**. Nothing changed since the baseline.

---

## 2026-09-07 17:40 UTC — hourly sweep, quiet

**0 new items.** Total 76 → 75; the drop is one `medium` guardian finding resolving
itself (68 → 67 open). No new buyer messages, no new orders, no disputes, nothing
undelivered on any platform. Nothing investigated because nothing new appeared.

Unchanged and still waiting on a human: Wobbic (16458589), mykristian's chargeback
threat (16408598), the three `%XX` credentials, the 15-day dispute (16420465).

### PlayerAuctions auto-delivery — healthy, but untested by a real sale

| Check | Result |
|---|---|
| `playerauctionsAutoDeliver` | `true` |
| `playerauctionsDeliverDryRun` | `false` — real delivery |
| `401` / "session not accepted" in error log | none |
| pm2 `redeemer` | online, 109 min uptime, restarts 55, unstable 0 |
| delivery queue | 0 paid-and-unshipped |
| PA order count | 73, unchanged since 16:20 |

**No sale has arrived since the flip, so no delivery has actually been observed.**
The ticker starts unconditionally at boot and re-reads the flag every 60s, and its
`catch` logs any failure — so silence plus zero errors plus an empty queue is
consistent with a healthy tick, but it is not the same as watching one succeed.
First real order will settle it.

**The concurrency caveat from the 16:45 entry is now moot** — both publishing runs
(`pa-bundle-listings.js --all`, `reprice-listings.js --apply --titles`) have exited.
`server.js` is the only node process left, so nothing is competing for the PA
session any more.

### One commercial observation, not a complaint

The publishing run left **55 live offers** (the shelf was 4). The
"Overwatch Twitch Drops (26 Items) OWWC Groups 2026" offer — the bestseller, 18
lifetime orders — is **not among them**, which matches the stock sync's earlier
`hide (no sellable stock)` on exactly that title. It cannot sell tonight until it
has stock. Flagging rather than acting: restocking is a listing change, not triage.

---

## 2026-09-07 18:40 UTC — hourly sweep, quiet

**0 new items.** Totals flat at 75 / 55 urgent / 67 open guardian findings. No new
buyer messages, no new orders, no disputes, nothing undelivered anywhere. Nothing
investigated because nothing new appeared.

Still waiting on a human, unchanged: Wobbic (16458589), mykristian (16408598), the
three `%XX` credentials, the 15-day dispute (16420465).

**The prod cron is confirmed firing on its own** — `sweep.log` has 17:07 and 18:07
entries independent of this session, which is the point of putting collection there.

### `redeemer` restarted at 18:36:53 — deliberate, not a crash

pm2 restarts 55 → 56, uptime 3 min. Investigated rather than assumed:

- error log holds **no stack** around the restart, only the routine Mongoose
  `new`-option deprecation warnings (documented noise)
- out.log shows a clean boot: `MongoDB connected` → `Server started on
  http://0.0.0.0:3000` → `telegramBot: listening`
- `unstable restarts 0`
- `scripts/pa-bundle-listings.js` was modified in the same window

Reads as someone deploying that script and restarting — consistent with another
session working on the box, not a fault.

**`playerauctionsAutoDeliver` survived the restart.** Diffed `utils/settings.json`
against the pre-flip backup: exactly two changes since 16:40 — my
`playerauctionsAutoDeliver false → true`, and the `marketplaces` block, which is the
PA cookie jar being re-saved after a refresh. Nothing else was touched.

### PlayerAuctions auto-delivery — still healthy, still untested by a sale

`autoDeliver true`, `dryRun false`, zero `401`/session errors, 0 paid-and-unshipped,
PA order count 73 unchanged since 16:20. The restart re-armed the ticker (first tick
50s after boot). **No sale has arrived since the flip, so a real delivery still has
not been observed.**

### One healthy signal

Eldorado moved one order `delivered → completed` (19→18 delivered, 47→48 completed,
70 total both times) — a buyer confirming receipt, which is the opposite of a
complaint. Worth recording because it is the only buyer-side movement all hour.

---

## 2026-09-07 19:40 UTC — ⚠ DISPUTE OPENED on order 16458589 (Wobbic)

**1 new item, and it is the escalation predicted in the baseline entry.** Wobbic
opened a dispute rather than replying. PA order states moved
`Delivery Pending Buyer Confirmation: 2 → 1` and `Disputing: 0 → 1`.

- Order **16458589** — "Overwatch Twitch Drops (26 Items) OWWC Groups 2026 Day
  1+2+3+4 All Set"
- Status `Disputing` / `Dispute Resolution`
- **Dispute 390495** — https://member.playerauctions.com/orders/dispute/detail/390495
- Event log, newest first: `Disputing started` · `Full delivery claimed by seller` ·
  `Seller delivery guarantee expired - first notice` · `Payment settlement completed`
- The buyer added **no new message** — last words are still *"account not working"*
  (Sep-06) and *"wrong password"* (Sep-07 04:54). He escalated silently.

### The good news: the account is genuinely fine

Checked rather than assumed. **This is NOT the "already claimed" failure**
(TAXONOMY.md §1) — it is only the mangled password:

| Check | Result |
|---|---|
| DropLog rows for `gkpchqu` | 20, all Overwatch, **all `connected: false`** |
| Stored password | 14 chars, contains a literal `^`, contains no `%` |
| What we sent | 16 chars, `%5E` in place of that `^` |
| `AvailableAccount` | `status: claimed`, `manualSold: true` |
| `BotAccount` | `soldAt 2026-09-05`, `soldTo manual`, still on Pi `noclaim-bot-4` |

The drops are unclaimed and still connectable. **Sending the correct password
should resolve this outright — no replacement account needed.**

### Draft reply (NOT sent — a human sends this)

> Sorry — that's my mistake, not yours. The password I sent got URL-encoded on the
> way out: the `%5E` in the middle is a single `^` character. So it's
> `0Gxde8hst3k9^f` — 14 characters, not 16.
>
> I've checked the account and all 26 items are still unclaimed and ready to
> connect, so nothing is lost. If it still won't log in, say the word and I'll send
> you a replacement account immediately.

Read the password from the pool at send time rather than trusting this note. The
transformation is unambiguous: **replace `%5E` with `^`**.

### Two caveats

- **No dispute deadline could be established.** The order detail exposes only a
  `SeeDispute` href, and `order-api` has no `/dispute/detail/{id}`, `/Dispute/{id}`
  or `/disputes/{id}` (all 404). How long PlayerAuctions gives a seller to respond
  is therefore **unknown** — open the dispute URL to find out. I did not wake the
  operator on the assumption that a same-morning reply is in time; if PA's window
  turns out to be tight, that assumption was wrong and the rule should change.
- The offer advertises **26 items** and the account carries **20 DropLog rows**.
  Drops and items are not the same unit, so this may be nothing — but it is worth
  one look while resolving the dispute, given TAXONOMY.md §1.

### Everything else

Unchanged: 76 items / 56 urgent, 67 open guardian findings, 3 stale storefront
messages, 0 catalog inquiries, 0 system errors, 0 stuck farm-service orders,
Eldorado clean (0 paid, 0 disputed).

**PA auto-delivery:** `autoDeliver true`, `dryRun false`, zero 401/session errors,
0 paid-and-unshipped, pm2 online 65 min, restarts 56, unstable 0. Order count still
73 — **no sale since the flip, so a real delivery is still unobserved.**

---

## 2026-09-07 20:40 UTC — quiet sweep, and I broke PlayerAuctions for one tick

**0 new items.** Totals flat at 76 / 56 urgent / 67 open guardian findings. Dispute
390495 (order 16458589, Wobbic) unchanged — still `Disputing`, no new buyer message.
Everything else clean: 0 catalog inquiries, 0 system errors, 0 stuck farm-service
orders, Eldorado 0 paid / 0 disputed.

### ⚠ My mistake: an endpoint probe tripped Cloudflare on the live seller session

Trying to close the "no dispute deadline established" gap from the 19:40 entry, I
fanned out **42 GETs across three PlayerAuctions API hosts** looking for a
dispute-detail endpoint. PlayerAuctions is behind Cloudflare, and it answered with
**HTTP 429 `Just a moment…`** challenge pages.

Consequences, measured rather than assumed:

- **The live fulfiller lost exactly one tick**:
  `playerauctions fulfiller: could not read orders: PlayerAuctions orders failed
  (HTTP 429)`. One such line in the entire error log.
- One module read immediately afterwards failed with *"playerauctions is not
  configured"*, i.e. the stored jar momentarily read as empty — most likely two
  processes absorbing Cloudflare's `set-cookie` and racing `setKeys`. I could not
  pin the mechanism down and did not keep probing to find out.
- **Recovered on its own within ~2 minutes.** Re-checked: `keyStatus.configured
  true`, cookie jar intact with all three `Production_*` cookies, orders read OK
  (73), pm2 online 126 min, restarts 56, unstable 0.
- **Nothing was actually delayed** — the delivery queue was empty, so the lost tick
  had no work to do.

**Rule, learned the expensive way: never fan out endpoint probes against a
Cloudflare-fronted marketplace using the operator's live seller session, and
absolutely not while unattended auto-delivery is running.** One or two spaced
requests, or none. The dispute deadline is not worth an outage — open the dispute
URL in a browser instead.

### The dispute deadline is still unknown, and I am leaving it that way

`order-api`, `user-api` and `public-api` have no reachable dispute-detail route, and
the remaining way to find one is more probing, which is what just caused the
problem. **Open https://member.playerauctions.com/orders/dispute/detail/390495 in a
browser** — that answers it in seconds and costs nothing.

Caution if you do: signing in to PlayerAuctions in your own browser rotates the
session and invalidates the server's copy, which breaks auto-delivery until the
cookie is re-pasted. That is a known trap, not a new one.

### PA auto-delivery

`autoDeliver true`, `dryRun false`, 0 paid-and-unshipped, order count still 73.
Still **no sale since the flip, so a real delivery remains unobserved** — the only
delivery-path exercise all night was the 429 failure above, which it recovered from
cleanly on the next tick.

---

## 2026-09-07 21:40 UTC — quiet sweep; first hard proof the flag is live, plus a pacing bug

**0 new items.** Totals flat at 76 / 56 urgent / 67 open guardian findings. Dispute
390495 (Wobbic) unchanged, still no new buyer message. Eldorado clean. Storefront,
catalog, farm-service, system errors all unchanged.

Prod cron confirmed firing unattended: 18:07, 19:07, 20:07, 21:07 all in `sweep.log`.

### The autoDeliver flag is definitely live in the running process

Previous entries could only say "no errors, queue empty" — which was consistent with
a healthy tick but did not prove one. It is proven now. `syncUnclaimedStock()` is
gated on the same `playerauctionsAutoDeliver` flag, and the out.log shows it doing
real work since the flip:

```
playerauctions stock sync: 95 -> 94 — Halo Infinite Twitch Drops (1 Item) — Boogeyman Charm
playerauctions stock sync: 95 -> 94 — Halo Infinite Twitch Drops (1 Item) — Quigley Charm
playerauctions stock sync: 93 -> 92 — Halo Infinite Twitch Drops (1 Item) — Anderson Nights Visor
playerauctions stock sync: 89 -> 88 — Halo Infinite Twitch Drops (2 Items) — Boogeyman Charm + Bullseye
```

Those are writes to PlayerAuctions that only happen when the flag reads true. The
delivery tick shares the flag and the same session, so the path is live. **A real
order still has not arrived** — order count is still 73 — so an actual credential
hand-over remains unobserved, but the machinery is demonstrably running.

### New: the stock sync fires writes with no rate-limit gap

One new error line since the last sweep:

```
playerauctions stock sync: PlayerAuctions update offer failed (code 1):
Operated too frequent, please try again later
```

`code: 1` is PlayerAuctions' documented **mutation rate limit** — writes need roughly
25s of spacing, and `marketplaces.js` even exports `PA_WRITE_GAP_MS` for it.
`syncUnclaimedStock()` does not use it: it loops over `MarketplaceListing` rows and
issues `playerauctionsHide` / `playerauctionsDisplay` / `syncStock` **back to back
with no delay**.

- Impact tonight: **exactly one** lost update out of many successful ones. The pass
  re-runs every 30 minutes and recomputes from scratch, so it self-heals; the cost is
  that one offer's advertised stock is briefly wrong.
- It will get worse: the shelf went from 4 offers to **55** after tonight's
  publishing run, so passes now have far more writes to make.
- **Not fixing it unattended.** It is a one-line pacing change inside the live
  delivery-path file; that belongs in daylight with a human watching.

### Session health after the 429 I caused last hour

Clean. No new `429`, `401` or "session not accepted" lines. `settings.json` rewritten
2 min ago (the jar re-saves on every cookie absorb, so recent writes mean healthy
traffic), last PA refresh 25 min ago — a normal cadence for a 30-minute access token.
pm2 online 184 min, restarts 56, unstable 0.

---

## 2026-09-07 22:40 UTC — quiet

**0 new items.** 76 / 56 urgent / 67 open guardian findings, all unchanged. Dispute
390495 (Wobbic) still `Disputing`, still no new buyer message. Eldorado clean
(0 paid, 0 disputed). Storefront, catalog, farm-service, system errors unchanged.

**The stock-sync pacing bug is intermittent, not systematic.** Still exactly **one**
`Operated too frequent` line in the whole log, and the most recent pass wrote
cleanly across Halo Infinite, Black Desert and Rust rows. So it bites only when a
burst of writes happens to land inside PA's window — the fix (use the exported
`PA_WRITE_GAP_MS`) is worth doing, but it is not losing updates every pass.

**PA health:** no new `429` / `401` / session errors since the one I caused at 20:40.
`settings.json` rewritten 3 min ago (jar absorbing normally), pm2 online 243 min,
restarts 56, unstable 0. Order count still **73 — no sale all night**, so an actual
unattended credential hand-over is still unobserved. The stock-sync writes remain the
proof the flag is live.

---

## 2026-09-07 23:40 UTC — quiet, but I was framing "no sale" wrongly

**0 new items.** 76 / 56 urgent / 67 open guardian findings, unchanged. Dispute 390495
(Wobbic) still open, no new buyer message. Eldorado clean.

### Calibration: hours without a sale is the base rate, not a symptom

I have repeated "no sale, so delivery is unobserved" for six entries as though it were
a gap. Measured it instead — **73 orders over 35 days = 2.07 orders/day**, so the mean
gap between orders is about 12 hours. A quiet night proves nothing either way, and I
should have checked the base rate before treating the silence as noteworthy.

### What IS worth noticing: the sales rate has roughly halved

Orders per day, most recent first:

```
Sep-07  (today)  0        Aug-28  4
Sep-06           1        Aug-26  4
Sep-05           0        Aug-25  3
Sep-04           1        Aug-24  1
Sep-03           2        Aug-23  4
Sep-02           1        Aug-22  3
Sep-01           2        Aug-20  5
```

Late August ran 3–5/day; September runs 0–2/day. The last order landed
**2026-09-06 18:02 UTC — 30 hours ago**, longer than the ~12h mean gap, and today has
had none at all.

**A plausible cause is sitting in the logs.** The stock sync hid exactly one offer all
night, and it is the bestseller:

```
playerauctions stock sync: hide (no sellable stock)
  — Overwatch Twitch Drops (26 Items) OWWC Groups 2026 Day 1+2+3+4 All Set
```

That title has 18 lifetime orders — the single biggest seller on the account — and it
is currently hidden for want of stock. No other offer was hidden.

**This is correlation, not proof.** The decline starts before tonight, the shelf was
also being rebuilt (4 → 55 offers), and one hidden offer cannot be assumed to explain
a week-long trend. But "the bestseller has been out of stock" is the first thing to
check in the morning, and it is a stock problem rather than anything the sweep or the
delivery path can fix.

### Health

PA: `autoDeliver true`, `dryRun false`, 0 paid-and-unshipped. Error log still holds
exactly two lines all night — the one `429` I caused at 20:40 and the one
`Operated too frequent` from the unpaced stock sync. `settings.json` rewritten 2 min
ago, pm2 online 304 min, restarts 56, unstable 0.

---

## 2026-09-08 01:47 UTC — quiet; and the error log is 97% noise

**0 new items.** 76 / 56 urgent / 67 open guardian findings, unchanged all night.
Dispute 390495 (Wobbic) still open, still no new buyer message. Eldorado clean.
Order count still 73 — no sale since 2026-09-06 18:02 UTC (~32h).

**Collection never missed a beat.** My triage skipped an hour (23:40 → 01:47), but
`sweep.log` has 22:07, 23:07, 00:07 and 01:07 — the prod cron carried it, which is
exactly why collection lives there and not in a session.

### Correction: I had been reading a truncated log

Earlier entries said things like "zero 401/session errors" based on
`tail -c 400000`. That window was too small — the error log grows fast enough that
tonight's two real errors had already scrolled out of it by 01:47, and a naive tail
now reports a suspiciously perfect "nothing found".

Whole-file counts, which is what I should have used from the start:

| Line | What | Position |
|---|---|---|
| 1016–1063 | 4× `session refresh failed (HTTP 401) … paste a fresh cookie` | **start of the log — historical, predates tonight** |
| 10992 | the `429` I caused at 20:40 | mid |
| 11556 | `Operated too frequent` from the unpaced stock sync | mid |

Total lines 14,963. **Nothing PlayerAuctions-related has gone wrong in the 3,400+
lines since 11,556** — so the session really has been clean since ~21:30, but that
now rests on a whole-file count rather than a lucky tail.

The 401s are the historical session deaths from the integration build, not the flip.

### Finding: Mongoose deprecation spam is drowning the error log

**14,535 of 14,963 lines (97%) are the Mongoose `new`-option deprecation warning.**
That is why two genuine errors aged out of a 500KB tail inside two hours. Any
health check based on tailing this file will miss real failures — mine nearly did.

It is known-routine noise, but the *rate* is the problem, not the content. Worth
either fixing the call sites (`returnDocument: 'after'`) or suppressing the warning,
so the error log becomes readable again. **Not changing it unattended.**

### Health

PA: `autoDeliver true`, `dryRun false`, 0 paid-and-unshipped, `settings.json`
rewritten 2 min ago (jar absorbing normally). Stock sync still writing cleanly across
Rust rows. pm2 online, restarts 56, unstable 0.

---

## 2026-09-08 ~02:30 UTC — new cookie installed; listings extended; one hard blocker

Triage first: **0 new items**, 76 / 56 urgent / 67 open guardian findings, dispute 390495
(Wobbic) still open. Nothing new from any buyer.

### Session restored

The operator signed in to PlayerAuctions to look at the dispute, which rotated the session
and killed the server's copy — the known trap, now actually hit. They pasted a fresh Cookie
header; installed it with `mp.setKeys`, having first parked
`playerauctionsAutoDeliver=false` so the pm2 tick could not race the install. Verified by
READ only (never `playerauctionsRefreshSession`, which would spend the refresh token):
seller `avishkarex2`, memberId 6423186, 73 orders, access token 26 min, refresh 24h.
`utils/settings.json.bak-precookie` holds the previous file. Auto-delivery restored to
`true` once publishing was done.

### The listing estate is healthy — my earlier "55 offers" was wrong

Corrected: PlayerAuctions has **171 live offers**, not 55. The earlier figure was a
snapshot taken while a publishing run was still going.

Reconciled against the DB rather than assumed:

| | |
|---|---|
| DB rows `marketplace: playerauctions, status: active` | 126 |
| of those, live on PA | **124** |
| not live | 2 — both Overwatch, and both *hidden* by the stock sync, not orphaned |
| PA offers with no active DB row | 47 — of which **45** are "Automatic Farming" service offers (they deliver via `FarmServiceOrder`, so they correctly have no `MarketplaceListing` row) |

So there is no orphan sprawl. The 2 remaining untracked offers are an Overwatch 6-item
listing whose DB row points at a superseded `offerId` (the documented "an update REPLACES
the offer and issues a new id" trap) and the hand-made CoD MW4 offer.

### Published: 3 new farm-service offers

`pa-farm-listings.js` reports the service shelf is nearly saturated —
**82 games, 15 usable, 45 planned, 42 already live, 3 to create**. Published those 3:

```
ok  Pokémon GO Twitch Drops Automatic Farming 120 Days  $5  295640358
ok  Pokémon GO Twitch Drops Automatic Farming 180 Days  $6  295640364
ok  Pokémon GO Twitch Drops Automatic Farming 1 Year    $9  295640366
created=3 failed=0
```

The other 67 games are genuinely unlistable: account-only on PA (World of Tanks, Naraka,
World of Warships, Madden), no cosmetic category, or no PA game by that name.

### ⚠ Unclaimed Overwatch cannot go on PlayerAuctions today

This was the specific ask, and it is blocked in code, not configuration:

```
UNCLAIMED_MARKETS = ["gameflip", "digiseller", "ggsel"]
gameMarketsFor("Overwatch") = ["gameflip"]
```

**PlayerAuctions is not a supported market for the unclaimed auto-lister at all.** Adding it
is a code change to `utils/unclaimedAutoList.js` (publish path, stock sync, claim tag,
fulfilment wiring), not a settings toggle — cf. [[reference_market_claim_tags]], where PA was
missing from three of four copies of the claim-tag list.

`pa-bundle-listings.js` cannot cover the gap either, and says so in its own comments:
Overwatch, Rainbow Six and Call of Duty drops must reach the buyer **unclaimed**, while that
script sells only from the **claimed** Drop Archive. The existing PA Overwatch offers are
`origin: manual` — hand-made.

Stock that is sitting idle as a result: **Overwatch 28 listed + 7 released**,
**Call of Duty: MW4 49 listed**, Rainbow Six 17 removed. CoD MW4 is the biggest untapped
block and PA does support it (`Bundle > Other Bundles`).

### Bundle scan running

`pa-bundle-listings.js --all` is scanning the full archive, detached. It is slow by design —
it walks ~1437 sets with a `findById` each plus a holdings query per survivor, and its own
comments record a 37-minute planning run. Two earlier attempts produced no output because
they were killed before finishing, not because they failed. The proven-demand default source
is **exhausted**: `sold sets=39, after item-dedupe=9, publishable=0`.

**Addendum — why the bundle scan kept "failing".** It was not failing. A foreground run
under `timeout 100` exited **124** (timeout killed it), which proves the script was still
working, not crashing; the empty logs came from the process being killed, not from an early
exit. Two launch styles died anyway — a plain `nohup … &` over SSH (exit 255, transport
drop) and a `setsid nohup … </dev/null &`, which should have survived. `redeemer` restarted
**5 more times** in the same window (60 → 65), so other sessions are actively deploying on
this box; a deploy step that sweeps stray `node` processes would explain it.

Now running supervised as pm2 app **`pa-scan`** (`--no-autorestart`, so it cannot
double-run). Read the plan with `pm2 logs pa-scan --lines 80 --nostream`. Dry run only —
it publishes nothing.

---

## 2026-09-08 04:54 UTC — the sweep said "0 new" and was wrong twice

Counts flat at 76 / 56 urgent / 67 open guardian findings, and the sweep reported
**0 new**. Two real things had changed underneath it.

### 1. Wobbic's dispute escalated — and my own tool hid it

Order 16458589 moved **`Disputing` → `Disputed Delivery Not Completed`**, the same
state as the 15-day-old Manomaninho dispute. Now 89h old, $5.

```
16458589 | Disputed Delivery Not Completed | Wobbic     | $5 |  89h
16420465 | Disputed Delivery Not Completed | Manomaninho| $5 | 374h
```

**The sweep missed it because I keyed disputes on `pa:dispute:<orderId>` alone**, so a
dispute that changes state keeps its old key and is reported as "not new". A state
change on a live dispute is exactly the thing that should page a human.

Fixed: the key now includes the status
(`pa:dispute:<orderId>:<status-slug>`), deployed to prod, hash-verified against local.
Re-running immediately surfaced both disputes as new — that is the re-key, not two
fresh disputes, and it will settle after one pass.

Nothing to add to the draft reply from the 19:40 entry: the account is still good
(20 unclaimed Overwatch drops, none connected) and the fix is still replacing `%5E`
with `^`. It is now the oldest unanswered item of the night.

### 2. Eldorado auto-delivery is working — first end-to-end proof

Three unattended hand-overs in the log:

```
eldorado delivered ca9f420a-4539-494e-0ee6-08df0ce148d6: 1 account(s)
eldorado delivered 4bb818ff-ba18-4d31-b74c-08df0ce14a03: 1 account(s)
eldorado delivered 6feb3543-9ddb-497c-f98f-08df0ce14b3e: 1 account(s)
```

Eldorado state counts moved `delivered 19 → 21`. So orders **did** arrive overnight and
were delivered automatically with no human involved. This is the first real evidence all
night that an unattended delivery path works end to end.

**PlayerAuctions delivery remains unexercised** — no PA order has arrived since the flag
was flipped, so its queue has never had work. Nothing wrong with it; nothing proven either.

### 3. The bundle scan had been running the wrong mode

`pm2 start … -- --all` did **not** forward the flag — `ps` showed
`node scripts/pa-bundle-listings.js` with no `--all`, i.e. it was re-running the
proven-demand source we already know yields `publishable=0`. Replaced with
`scripts/pa-scan.sh`, a wrapper that hard-codes `--all`, started under pm2
(`--no-autorestart`). Confirmed by `ps`: `node scripts/pa-bundle-listings.js --all`.
Still a dry run; publishes nothing.

---

## 2026-09-08 05:40 UTC — the PA shelf is exhausted; and I overstated the unclaimed blocker

**0 new items.** Urgent 56 → 55 and warn 12 → 13: that is the Manomaninho dispute
(374h) re-aging from urgent to warn under the fixed dispute key, working as intended.
Wobbic's dispute (16458589, 90h) is unchanged and still the oldest unanswered item.

### The full-archive bundle scan finished: nothing left to publish

```
sold sets=1443   after item-dedupe=198   publishable=0   skipped-game=65
DRY RUN — nothing published.
```

Every distinct product in the Drop Archive that PlayerAuctions can take is already on
sale there. Combined with the earlier runs, all four listing paths are now measured:

| Path | Result |
|---|---|
| farm-service (`pa-farm-listings`) | 42 live, **3 published** (Pokémon GO), rest unlistable |
| bundles, proven demand | `publishable=0` |
| bundles, whole archive (`--all`) | `publishable=0` |
| unclaimed (Overwatch / CoD / R6) | blocked — see below |

So "more listings on PlayerAuctions" has exactly one remaining route.

### Correction: the unclaimed blocker is smaller than I said

Last entry I wrote that PlayerAuctions "is not a supported market for the unclaimed
auto-lister at all" and implied a new integration was needed. The first half is right;
the implication was wrong, and the numbers say so:

- There are **2 active `playerauctions` + `unclaimedGame: overwatch`** listing rows
  already — hand-made, but real.
- `playerauctionsFulfiller.syncUnclaimedStock()` already manages exactly those rows —
  it is what hid the OWWC offer for "no sellable stock" earlier tonight.

**So the delivery and stock-sync halves already work on PlayerAuctions.** What is missing
is only the auto-lister's routing: `UNCLAIMED_MARKETS = ["gameflip","digiseller","ggsel"]`
does not include `playerauctions`, so `unclaimedAutoList` never publishes there. That is a
smaller job than "build the integration" — though still a change to live money-handling
code, so still not something to do unattended.

### What is actually idle, precisely

```
overwatch                       listed=28  released=9  => 37 sellable   markets: ["gameflip"]
call of duty: modern warfare 4  listed=49  released=0  => 49 sellable   markets: null
rainbow six siege               listed=0   released=1  =>  1 sellable   markets: null
```

**87 sellable unclaimed accounts**, and CoD: MW4 — the largest block at 49 — has **no
market routing configured at all**. PlayerAuctions supports Call of Duty
(`Bundle > Other Bundles`, per the integration notes), so that stock is reachable.

### Health

PA `autoDeliver true`, `dryRun false`, 0 paid-and-unshipped, 73 orders — still no PA
order since the flip, so PA delivery stays unexercised. Eldorado unchanged since its
three deliveries last hour (`delivered 21`). Guardian findings steady at 67.

---

## 2026-09-08 06:40 UTC — quiet

**0 new items.** 76 / 55 urgent / 67 open guardian findings. Wobbic's dispute (16458589,
91h) and Manomaninho's (16420465, 375h) both unchanged; no new buyer messages anywhere.

**Eldorado delivered another order** — state counts `delivered 21 → 22`, and the log now
shows five unattended hand-overs in total. That path is reliably working.

**PA health:** `autoDeliver true`, `dryRun false`, 0 paid-and-unshipped. Session is
renewing itself normally — access token 27 min left, refresh ~20h, so the locked refresh
is running as designed on the cookie installed at ~02:30. Whole-file error counts are
**unchanged** since the 01:47 check (42 PA lines, 2× `429`, 40× `session not accepted`,
all of them historical or already accounted for), so nothing new has failed.

Still no PlayerAuctions order since the flag was flipped ~14h ago, which is within the
normal ~12h mean gap but on the long side; the shelf's bestselling Overwatch offer being
hidden for no stock remains the most plausible reason.

`redeemer` restarts 65 → 69 — other sessions are still deploying on this box roughly
hourly. No impact on the sweep or on delivery.

---

## 2026-09-08 07:40 UTC — quiet; and a note on how fast the corpus actually grows

**0 new items.** Everything flat: 76 / 55 urgent / 67 open guardian findings, both
disputes unchanged, no new buyer messages, Eldorado steady at `delivered 22`.

**PA health:** `autoDeliver true`, `dryRun false`, 0 paid-and-unshipped. Whole-file error
counts still `429: 2` and `session not accepted: 40` — identical to six hours ago, so
nothing new has failed. `redeemer` restarts 71 (other sessions still deploying).

### The corpus is not going to grow itself

Worth stating plainly, because it bears on the reason this was built. After **16 sweeps**,
`corpus.jsonl` holds **79 rows** — 76 from the first pass and 3 since, two of which are
just the re-keyed disputes. Overnight produced essentially **no new complaint data**.

That is arithmetic, not a fault: PlayerAuctions averages ~2 orders/day, and only a
fraction of orders generate a message. The training set is therefore the **46 historical
threads already read and labelled in TAXONOMY.md**, not something the hourly sweep will
accumulate at any useful rate — expect a handful of new threads per week.

If the goal is a support bot, the leverage is in the data already captured plus the other
platforms, not in more sweeps of PlayerAuctions:

- **Eldorado buyer chat is still unreadable** (TalkJS send-only) and Eldorado is the
  busier channel — 7 unattended deliveries logged tonight versus PlayerAuctions' zero
  orders. Its complaint traffic is invisible, and it is probably the largest untapped
  source of training data.
- **Gameflip, Digiseller, GGSel, G2G, FunPay, ZeusX** have no message reader at all.
- The storefront `Message` collection has months of history that only 3 unread rows
  represent here; a full read of it would add labelled examples immediately.

---

## 2026-09-08 08:40 UTC — quiet

**0 new items.** 76 / 55 urgent / 67 open guardian findings. Both disputes unchanged
(Wobbic 16458589 now ~93h, Manomaninho 16420465 ~377h), no new buyer messages, Eldorado
steady at `delivered 22` / 7 logged hand-overs.

**One real change, and it is a good one:** PlayerAuctions `availableBalance` moved
**0 → 2.88**. Funds from a completed order have cleared to the seller balance, which is
the settlement side of the pipeline working normally. Not a complaint; recording it
because it is the only movement of the hour.

**Health:** PA `autoDeliver true`, `dryRun false`, 0 paid-and-unshipped; Eldorado
`autoDeliver true`. Whole-file error counts unchanged for a seventh hour —
`429: 2`, `session not accepted: 40`, `Operated too frequent: 1`. Nothing new has failed
since 21:30 yesterday. `redeemer` restarts 73.

Still no PlayerAuctions order since the flag was flipped ~16h ago.
