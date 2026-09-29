# Buyer complaint taxonomy

Derived from all 46 PlayerAuctions threads with a buyer message, read 2026-09-07.
Percentages are share of those 46 threads; a thread can carry several intents.

This is the label set for the support bot. Each entry: what the buyer says, what
it actually means, and what the answer is. Where the honest answer is "this is our
bug", it says so — a bot trained to reassure through a real defect just moves the
refund a week later.

---

## 1. "Everything is already claimed / I connected and got nothing" — 14 threads (30%)

**By far the largest category, and it is a product defect, not a support problem.**

Buyer wording: *"only had like one reward that wasn't already claimed"*, *"It says
everything is already claimed"*, *"the connected overwatch account didn't get any
of the items"*, *"The content never transferred to me"*, *"i dont see the purple
connect button and all the items have a check mark"*.

**What it means.** The drops on the delivered account were already **connected** —
linked to somebody else's Battle.net/game account — before the buyer got it. A
connected drop cannot be re-claimed. The check-mark-instead-of-Connect-button
report is the buyer literally describing an already-connected inventory.

**Known related work:** `project_autolist_wrong_content` (55/188 auto-listed
accounts did not hold the promised drops), `project_spent_connected_false_positive`
(CONNECTED means linked elsewhere), `project_unclaimed_listing_expiry` (expired
waves empty a listing while the ledger still says it is full).

**The answer that is true:** the account cannot deliver those items; replace it or
refund. The current standing replies — *"give it time to sync"*, *"blizzard servers
are slow"*, *"keep it linked and you'll get future drops"* — are what turned
several of these into refund threats over the following days (mykristian,
WorstWidowmaker, DomoAstro all went: sync excuse → 72 hours → refund demand).

**Bot rule:** never answer this with a sync-delay explanation. Verify the account's
live Twitch inventory first; if the drops are connected, offer a replacement
immediately.

---

## 2. Refund / chargeback / "are you scamming me" — 7 threads (15%)

Buyer wording: *"Hello can we do a refund? Otherwise I don't want to do a chargeback
on my card"*, *"Are you just someone else that's scamming people?"*, *"dang bro i
see how it is ur just going to scam me?"*

**Always an escalation of #1 or #4, never a standalone intent.** In every observed
case the buyer had already reported a concrete failure and been answered with
reassurance rather than a fix. Median time from first report to refund demand:
about 2–3 days.

**Bot rule:** escalate to a human immediately. Do not negotiate, do not re-explain
the product. A chargeback threat is a same-hour human task.

---

## 3. "When do I get it?" / delivery delay — 7 threads (15%)

Buyer wording: *"Would I be able to get this sooner than 6 hours?"*, *"Yo bro, when
do I get the stuff?"*, *"Hey, delivery is auto right?"*

The seller's own replies show the cause: *"I apologize for the delay i was
offline"*, *"sorry for being late i was sleeping"*, *"I apologise for the delay i
was offline"* — three separate orders.

**PlayerAuctions charges for this.** Order 16458589 was paid 11:50:30 and delivered
19:17:37 — 7h27m against a 6-hour guarantee, and the event log recorded
*"Seller delivery guarantee expired - first notice"*. Late delivery costs a penalty
fee and hides the offers.

**Bot rule:** answerable automatically, but the real fix is auto-delivery, not a
better apology. See NOTES.md — `playerauctionsAutoDeliver` is currently **off**.

---

## 4. "Wrong password" / "password is incorrect" — 2 threads (4%)

Buyer wording: *"wrong password"*, *"Apologies, but it seems that the given password
is incorrect"*.

**Confirmed root cause, at least for these:** the credential was delivered
**URL-encoded**. Three sends carry a `%XX` escape:

| Order | Buyer | Sent | Stored in pool |
|---|---|---|---|
| 16458589 | Wobbic | `…%5Ef` (16 ch) | `…^f` (14 ch) — raw `^` |
| 16445563 | SpititKin | `…%5E9q` (16 ch) | `…^9q` (14 ch) — raw `^` |
| 16457018 | drummondddsss | `%221gfzd…` | identical — **the stored password is itself encoded** |

Two directions, two defects. For Wobbic and SpititKin the pool holds the correct
password and something encoded it between the database and the message. For
drummondddsss the pool row is itself corrupt: `%22` is `"`, and **no** pool password
contains a literal `"`, so the stored value was written already-encoded.

**Scale:** 56 of 3199 pool accounts (1.8%) hold a password that is already
`%XX`-encoded. 347 contain a literal `^`. 65% contain at least one character
`encodeURIComponent` would escape, so anything that URL-encodes a credential on the
way out will keep producing this.

The delivery path itself is clean — there is no `encodeURIComponent` in
`playerauctionsCopy.js`, `playerauctionsFulfiller.js` or `eldoradoFulfiller.js`.
All three sends were hand-typed (before PA auto-delivery), so the most likely
source is the operator's own copy step. **Unproven** — it needs one look at where
the password is copied from.

**Bot rule:** the sweep now flags any outgoing credential containing `%XX` as
`kind: "bad-credential"` at severity urgent. The recovery that worked (SpititKin)
was simply sending a different account.

---

## 5. "How do I use this" / newbie — 5 threads (11%)

Buyer wording: *"wait what do i do sorry"*, *"im new to this"*, *"idk how to sign
out of a twitch account"*, *"So I don't get any boxes rn unless they are doing a
twitch drop?"*

Cheap to answer and highly scriptable — this is the category a bot handles best.
One thread (Ksks9ekwmsns) shows the cost of getting it wrong: an unanswered
"what do i do" escalated to all-caps and a refund demand within a day.

---

## 6. Twitch asks for an email code at login — 4 threads (9%)

Buyer wording: *"It's asking for a code sent to a gmail"*, *"says I need a 6 digit
code"*, *"need a code from the email to login"*.

**Verified answer:** click **"remind me later"** — these are email-less accounts.
Buyers get through every time. Belongs in the offer's `instruction` field so it is
read before the message arrives.

---

## 7. 7-day relink cooldown — 4 threads (9%)

Buyer wording: *"I had a previous twitch account connected says theres a 7 day
cooldown before I can connect another"*, *"ITS SAYING I NEEDA WAIT 6 DAYS TO LINK A
NEW ACCOUNT"*.

Twitch enforces a cooldown before a game account can be linked to a different Twitch
account. Nothing we can do about it, and it is **not** a defect — but a buyer who
learns it after paying reads it as a scam. One of the two all-caps blowups in the
whole corpus came from this.

**Bot rule:** answer plainly, and get it into the offer copy up front. The account
stays valid through the cooldown.

---

## 8. Auto-farm not farming — 2 threads (4%)

Buyer wording: *"are u sure the auto farming is working on <login> because the other
account is receiving rewards from 10 hours ago while <login> got 2 days ago"*,
*"i've checked twitch following the current twitch event and it's not farming it"*.

Both were real. Seller's own answers: *"my fault i forgot to turn on the first
one"* and *"it had a cookie issue now its fixed"*. Buyers running two accounts
side by side detect this faster than we do.

**Bot rule:** verifiable server-side — check the account is deployed on a bot and
actually earning. Do not answer from a template; look.

---

## What the corpus says overall

Support volume is not really support volume. **Roughly half of all buyer threads
(intents 1, 4 and 8 = 18 of 46) are reports of a broken delivery**, and the single
biggest one is accounts whose drops were already connected. A support bot will make
those conversations faster and more polite; it will not reduce them. The refund
demands come from the ~2-day gap between a buyer reporting a real failure and
anyone verifying it.

The highest-leverage bot capability is therefore **not** a reply generator — it is
a check, run the moment a buyer says "already claimed": read that account's live
Twitch inventory, and if the drops are connected, say so and replace it.
