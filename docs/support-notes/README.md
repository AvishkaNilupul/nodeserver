# Support sweep + complaint corpus

Purpose: catch every buyer complaint across every selling surface without a human
watching, and turn what we find into labelled training data for a support bot.

## What runs

| Piece | Where | Cadence |
|---|---|---|
| `scripts/complaint-sweep.js` | prod, `/var/www/redeemer/nodeserver` | hourly, `crontab` minute 7 |
| `scripts/complaint-sweep.sh` | prod wrapper — logs + prunes old reports | same |
| output | prod `support-sweeps/` | see below |

```bash
ssh -i ~/.ssh/claude_prod_deploy_ed25519 root@202.92.214.91 'cd /var/www/redeemer/nodeserver && cat support-sweeps/latest.json'
```

- `latest.json` — the most recent report (counts, per-source status, every item)
- `sweep-<ts>.json` — one file per run, pruned after 14 days
- `corpus.jsonl` — append-only, one line per **newly seen** item; this is the training set
- `seen.json` — dedupe state, so an item is "new" exactly once
- `sweep.log` — one line per run

Run it by hand any time — it is safe to run concurrently with the hourly job:

```bash
ssh -i ~/.ssh/claude_prod_deploy_ed25519 root@202.92.214.91 'cd /var/www/redeemer/nodeserver && node scripts/complaint-sweep.js --quiet'
```

## The one hard rule

**The sweep never writes to a marketplace.** It does not reply, deliver, reprice,
delist or mark anything. Replying to a buyer is sending a message as the operator,
and that is a decision a human makes. Draft replies live in `NOTES.md`; a human
sends them.

## What it can and cannot see

Covered:

- **PlayerAuctions** — full message inbox (thread transcripts), notifications,
  order states, disputes, and the paid-but-undelivered queue
- **Eldorado** — order state counts, disputed orders, paid-but-undelivered
- **Own storefront** — unread buyer chat (`Message`)
- **Catalog** — new inquiries (`CatalogInquiry`)
- **Complaints in waiting** — open guardian `AuditFinding`s, stuck
  `FarmServiceOrder`s, `SystemEvent` errors rolled up by category

Blind spots, all reported honestly in every run's `sources` block:

- **Eldorado buyer chat** — the TalkJS integration is send-only; the read side was
  never mapped. Buyers messaging on Eldorado are invisible.
- **Gameflip, Digiseller, GGSel, G2G, FunPay, ZeusX** — no order or message reader
  exists in `utils/marketplaces.js`. Complaints there are invisible.

## Two things worth knowing before changing the sweep

**The PlayerAuctions message list is not where it looks.**
`mp.playerauctionsMessages()` calls `/User/Messages`, which is a **badge counter**
(`{messageCount, pendingCount, …}`), not a list. Read as a list it reports zero
buyer messages forever — which it did until 2026-09-07. The real list is
`GET user-api/api/messages/inbox?pageIndex&pageSize`, and a thread body comes from
`/messages/detail?id=&isFromSystem=`. Proper home for this is a
`playerauctionsInbox()` in `utils/marketplaces.js`; it lives in the sweep for now
so nothing on the prod hot path had to change overnight.

**The sweep reads PlayerAuctions with the stored cookie directly, not through
`paGet`.** `paGet` refreshes on a 401, and a refresh rotates the entire PA session
— which would sign out the fulfiller and the operator's own browser. The sweep
reads with whatever jar the server last saved and reports a stale session instead
of healing it. Keep it that way.

**Opening a thread marks it read on PlayerAuctions.** There is no read-only way to
get a message body, so the unread badge in the PA web inbox is no longer a reliable
"needs attention" signal. `latest.json` is the source of truth instead: any thread
where the buyer spoke last is reported as `kind: "buyer-message"` regardless of the
read flag.

## Reading a report

Every item carries `severity` (`urgent` / `warn` / `info`), `platform`, `kind`,
`at`, `subject`, `body`, and `meta` (which for a PA thread includes the full
transcript). Severity is age-aware: a buyer waiting 3 hours is urgent, the same
message 5 days later is not — it is history.

`kind` values: `buyer-message`, `dispute`, `undelivered`, `bad-credential`,
`platform-notice`, `inquiry`, `integrity`, `error`.
