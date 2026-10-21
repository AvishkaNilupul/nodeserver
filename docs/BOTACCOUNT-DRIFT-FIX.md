# BotAccount.enabled drift — fix and backlog correction

Branch `fix/botaccount-enabled-drift`, cut from `origin/fix/drop-expiry` (`cfeebc6`).
Written 2026-10-21. **Not deployed, and the backlog is not corrected.** Both
steps wait for the owner's OK.

## What was wrong

`BotAccount` mirrors the bot configs. `enabled` says whether the account's
config entry is switched on. Two config writers switched accounts off
without updating the mirror:

- `completeEndedTasks` (`utils/autoFarmer.js`): when a campaign ends, it trims
  the ended game out of a **shared** auto bot and disables accounts left with
  no game.
- `farmControl.stopFarmingGame`: after a sale, when the sold game was the last
  one the account farmed.

Only a manual "Sync from bots" ever caught the mirror up, and that sync had
three bugs of its own:

- the copy read **last** won, so a retired copy could overwrite the live one;
- it wrote renter-stack configs in as operator placements, which renting
  forbids;
- it does not read the no-claim fleet.

Measured on prod 2026-10-21:

- 823 rows on the four shared auto containers said enabled while the config
  said off (x24 218, x42 219, x44 304, x53 82). Example: x44 showed "397 on",
  but only 93 are really on.
- The retro-reaper (`reapRetiredBots`) keeps an account claimed for as long as
  the mirror says enabled, so these accounts never went back to the pool.

## What changed

| File | prod blob before | after |
|---|---|---|
| `utils/botAccountMirror.js` | (new) | `06a11e81` |
| `utils/autoFarmer.js` | `79983d86` | `acde51d8` |
| `utils/farmControl.js` | `b45de42f` | `a3773fb2` |
| `routes/dropArchiveRoutes.js` | `4ac39666` | `6790d148` |
| `scripts/reconcile-host-ledger.js` | `c3511592` | `144ff342` |
| `utils/farmOps.js` | `ee8c6b44` (unchanged — prod's own file, added to git only) | same |

The "before" column was checked on 2026-10-21: every base file is
byte-identical to prod. **If prod still has these blobs at deploy time, a
straight copy is safe.** If any differ, apply this branch's hunks onto prod's
bytes instead. Prod is a mix of branch tips.

1. **Engine** (`3a0465f`). Both config writers now call
   `mirrorDisabled(host, file, secrets)` after their write lands:
   - It only touches rows that still name that config.
   - It is best-effort and never breaks a tick.
   - `retroRecycleLogins` is the reaper's choice, pulled out as a pure function
     with no behaviour change.
2. **Sync from bots** (`a2ea8b4`). One placement per token, chosen by
   `chooseHome`:
   - the enabled copy wins;
   - two enabled copies are left alone;
   - a renter-held account has its operator placement cleared;
   - a disabled copy never overwrites a no-claim row.
3. **Reconcile script** (`ccc15cb`). The dry run now predicts what the
   retro-reaper releases after the correction, using the reaper's own rules.
   `--apply` refuses if any released account would land in the ready pool while
   holding sellable unclaimed stock, unless you pass `--allow-stock-release`.
4. **Tests** (`b0e25b5`): `tests/botAccountDrift.test.js`, 15 tests.
   - The three integration tests use an in-memory Mongo and a fake host.
   - Each of the three fails on the pre-fix code.
   - Full suite: the failing files and counts are identical to the base commit
     (all pre-existing).

## Deploy (owner's OK first)

Follow the targeted-copy recipe in the memory note `reference_production_server.md`:

1. Fingerprint the 5 prod files against the "before" column.
2. Back up into `_deploy_backup_<ts>_botaccount-drift/`.
3. Copy the files.
4. Hash-verify them.
5. Load-test with
   `node -e "require('./utils/autoFarmer'); require('./routes/dropArchiveRoutes'); require('./utils/farmControl')"`.
6. Run `pm2 restart redeemer` between auto-farm ticks.

No settings switch is involved. From the next campaign end on, retirements
are mirrored.

## Correct the backlog (owner's OK first, after the deploy)

```
node scripts/reconcile-host-ledger.js --host contabo            # dry run
node scripts/reconcile-host-ledger.js --host contabo --apply    # writes
```

Dry run on prod data, 2026-10-21 (the new script, read-only):

- 2,504 contabo rows (`soldAt: null`):
  - 431 only the flag is wrong;
  - 246 point at the wrong bot (many accounts now live in no-claim bots);
  - 29 ghost rows for removed no-claim bots 3/4/10.
- 497 flags switched off and 126 switched on.
- Retro-reaper releases: **0 today → 90 after the correction**:
  - all 90 are `auto-farm:` / `auto-farm backfill:` claims;
  - 89 go to the ready pool, and 1 holds unclaimed drops (kept out, held as
    stock);
  - **0 at risk** (none has a sellable unclaimed-stock snapshot).

What happens on `--apply`:

1. On the next auto-farm tick (≤ 10 min), the retro-reaper returns about 90
   finished auto-farm accounts to the pool, with the note
   `recycled by retro-reaper`.
2. The pool checker re-reads them as it does any pool row, and holds any that
   turn out to carry unclaimed drops.
3. Watch for: the tick's "Retro-recycled N account(s)" line; ready pool count
   up by about 90; no "📦 Account pool check" hold storm.

Run the dry run for `--host local` and `--host pi` too. Rows on other hosts are
not touched by a contabo run.

Sold rows (`soldAt` set) are out of the script's scope by design. 278 of the
823 stale flags belong to sold accounts. They stay "enabled" in the mirror,
which only affects page counts: the recycler never takes a sold account.

## Do not

- Press "Sync from bots" on the **current** prod code. It records the copy it
  read last, and it writes renter-stack placements.
- Lower the reaper's guards to "fix" the counts. The `enabled` guard is what
  stops a running account from being recycled.
