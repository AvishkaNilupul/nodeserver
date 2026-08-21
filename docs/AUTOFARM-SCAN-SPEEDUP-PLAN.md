# Auto-farm scan: make the tick fast (without breaking the fleet)

**For:** Sol · **Reviewed after build by:** Claude
**Symptom:** the Scan log crawls — campaigns are decided strictly one after another,
each printing `Deciding X…` then `X → decision.` seconds apart.

---

## 1. The real cause — it is NOT mostly "no concurrency"

The decision loop lives in `utils/autoFarmer.js#runOnce` (~line 2857):

```js
for (const c of candidates) {
  const r = await processCampaign(c, { af, host, budgetMap, infoMap, ... });
}
```

The genuinely expensive shared inputs are **already batched** before this loop —
`infoMap` (research + own sales), `farmMap`, `archiveHolders`, `owned`,
`priorTasks`, and the `fairShare` budget are all computed once per tick. Good.

The problem is **inside** `processCampaign`: it makes **per-campaign SSH round
trips to the Pi, in serial loops**.

| Where | Call | Cost |
|---|---|---|
| `processCampaign` ~line 1397 | `await hosts.exists(h, b.file)` inside `for (const b of reusable.bots)` | one SSH round trip **per bot, per campaign**, awaited serially |
| `processCampaign` ~line 1650 | `await autoSeatCapacity(host, af)` → `await hosts.readFile(host, b.file)` inside a loop over active task bots | one SSH round trip **per bot**, recomputed **per campaign** |

The Pi link runs at **seconds of RTT** (memory: `pi-link-timeouts`). With ~7 auto
bots and ~29 campaigns in a tick, that is on the order of **hundreds of serial SSH
round trips per scan**, and most of them re-read *the exact same files* over and
over.

That matches the observed log exactly: `skip_low_demand` campaigns (which return
before the host work) print in **0–1s**, while `reuse_existing` ones — the ones that
reach the host calls — take **2–3s each**.

> This is the same trap already documented in memory `host-read-batching`:
> `hosts.readFiles` does one gzipped round trip and measured **26× faster** than a
> `readFile` loop on the Pi. The new watcher's `collectHost()` already does it the
> right way — copy that.

**So: fix the redundancy first. Concurrency second. In that order.**

---

## 2. What must NEVER be parallelised

The loop is not naively parallelisable, because `processCampaign` **commits** to
shared, finite resources. Running commits concurrently reintroduces bugs this
codebase has already been burned by:

| Shared resource | What breaks under concurrency | Evidence |
|---|---|---|
| Host config files | `writeFileAtomic`'s dupeGuard is **last-write-wins** — two campaigns writing the same host config in parallel silently lose one write | memory `dupeguard-single-home` (the stale-write teardown trap) |
| Container capacity | `activeAutoBotCount()` vs `maxAutoBots` is a check-then-act; parallel checks all read the pre-commit count and **blow past the cap** | `skip_no_capacity` exists precisely to enforce this |
| Account pool | `fairShare` pre-allocates a budget, but parallel `claimPoolAccounts` can drain past `poolReserve` between check and claim | memory `autofarm-capacity-cap` |
| Bot placement | Concurrent read-modify-write of configs → an account placed in several containers | memory `autofarm-duplicate-sprawl` — *one account ran in 30 containers* |

**Rule: reads and decisions may run in parallel. Commits stay serial.**

---

## 3. The plan — three tiers, in this order

### Tier 1 — Hoist the host reads out of the loop (biggest win, lowest risk)
Do the host I/O **once per tick**, before the loop, and pass it in via `ctx`:

1. Collect every file referenced by active task bots (same shape as
   `autoFarmSnapshot.collectHost`).
2. **One** `hosts.readFiles(host, files)` call → parse once into a
   `Map<file, config>`.
3. **One** `hosts.dockerPs(host)` (or one `readdir`) to answer "does this bot still
   exist" — replacing every `hosts.exists` call in the loop.
4. Pass `ctx.hostFiles` / `ctx.hostContainers`; rewrite `hosts.exists(...)` and
   `autoSeatCapacity(...)` to read from that map instead of the wire.
5. Recompute seat capacity **in memory** as the loop commits (decrement a local
   counter when a task takes a seat) rather than re-reading the host each time.

*Expected effect:* removes essentially all per-campaign SSH latency. This alone
should take the scan from tens of seconds to a few seconds, **with no concurrency
risk at all.**

⚠️ Freshness caveat: the snapshot must be taken **after** the wake/park phase in
`runOnce` (those mutate containers), and any commit that changes a config must
update the in-memory map so later campaigns in the same tick see it.

### Tier 2 — Parallelise the decision phase only (bounded)
Split `processCampaign` into two halves:

- `decideCampaign(c, ctx)` → **pure/read-only**: research, coverage, demand,
  `budgetMap` lookup, reuse eligibility. Returns a *plan* (`{decision, reason,
  want, reuseTaskId, …}`) and touches nothing shared.
- `commitCampaign(plan, ctx)` → everything that mutates: claim accounts, write
  configs, start/restart containers, record the task, list.

Then:
```js
const plans = await mapWithConcurrency(candidates, 4, (c) => decideCampaign(c, ctx));
for (const plan of plans) await commitCampaign(plan, ctx);   // still serial
```
Use a **small fixed concurrency (4–6)**, not `Promise.all` over everything — the
decision half still issues Mongo reads, and Atlas is a shared tier.

*Expected effect:* the remaining decision time collapses to roughly
`slowest / concurrency`. Skips become effectively instant.

### Tier 3 — Nice-to-have polish
- Emit progress lines as `Decided X → skip_low_demand` in completion order, and add
  a `n/total` counter so the log reads as progress, not a stall.
- Short-circuit `skip_low_demand` **before** any host work (verify it already
  returns early — the log suggests it does).
- Keep a per-phase timing breakdown in the scan log (`decide 1.2s · commit 4.8s`)
  so the next regression is obvious.

---

## 4. Verification (this touches the live farming engine — prove it)

- [ ] **No behaviour change in decisions**: run a tick with the same inputs before
      and after; the set of `(game, campaignId) → decision` must be identical.
- [ ] **Capacity cap holds**: with `maxAutoBots` nearly full, a tick must never
      create more containers than the cap (test the in-memory seat counter).
- [ ] **No double-spend**: total accounts claimed in a tick ≤ `ready − poolReserve`.
- [ ] **One-home invariant**: after a tick, no account appears in two configs on a
      host (`dupeGuard`) — grep the configs, as in the split-bot recipe.
- [ ] Count SSH round trips per tick before/after (log them) — should drop from
      hundreds to a handful.
- [ ] Wall-clock scan time before/after, recorded in the commit message.
- [ ] `npm test` green; add a unit test for `mapWithConcurrency` ordering and for
      the seat counter.

Deploy notes: prod is a branch-mix — fingerprint per file by blob hash, back up into
`_deploy_backup_<ts>/`, and remember **`server.js` is at the repo root** (a tarball
of `models public routes utils` silently omits it).

---

## 5. Summary

The scan is slow because it **re-reads the same Pi files hundreds of times, one
round trip at a time** — not simply because it lacks threads. Batch those reads
(Tier 1) and the tick gets dramatically faster with zero concurrency risk; then
parallelise only the read-only decision half (Tier 2). The commit half must remain
serial, permanently.
