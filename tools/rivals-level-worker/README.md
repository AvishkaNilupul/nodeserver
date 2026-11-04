# Rivals leveling worker

**Commissioning is pending. No live match or XP/hour result has been verified.**
The native driver compiles and the controller is covered by offline tests. UI
recognition, hero selection, gameplay navigation and the actual post-match XP
layout still need to be calibrated against a live Practice vs AI match. An
offline test passing does not establish unattended gameplay reliability.

Verified on 2026-11-04: the native driver compiles and discovers the real Wine
fullscreen window through accessibility; the integrated reader identifies the
correct UID and level 1 from an existing original Career screenshot (2.3 seconds,
85% badge confidence); a read-only production preflight confirms the existing
test preparation is held and unlisted; 40 focused checks pass. No live match,
automated movement, XP gain or XP/hour measurement has been commissioned. The
other skin-collection chat owns the game, and the owner instructed this task to
wait for it. Expiry of that worker's lease alone is not an explicit handoff.

This worker uses the existing encrypted Rivals claim queue for identity and
exclusive session ownership. It takes a held preparation after mailbox collection
and before normal sign-out. An active lease from the skin collector prevents it
from starting. It never adopts completed, listed or sold stock or switches login.
Production reads confirm the existing preparation hold before starting and before
each queue action. These reads do not load marketplace connectors or change data.

## Build and inspect

Requires macOS 14+, Xcode command-line tools, Node.js 20+, and the repository's
`sharp` and `tesseract.js` dependencies. Uses native Apple Vision for screen text,
an isolated digit reader for the small Career level badge, and bounded native
mouse/keyboard events for the Wine game. The existing macOS screen-recording and
accessibility grants must already be available; it does not change permissions.

```sh
npm ci --prefix tools/rivals-level-worker
node tools/rivals-level-worker/cli.cjs build
node tools/rivals-level-worker/cli.cjs status
node tools/rivals-level-worker/cli.cjs inspect
node --test tests/rivalsLevelWorker.test.js tests/rivalsClaimWorker.test.js
```

`inspect` only lists game windows and the existing permission state. It does not
focus a window or press anything. `analyze` reads an existing PNG, with a JSON
`file` path on stdin; it does not capture or alter the screen.

## First live benchmark

Wait for the claim collector to hand off the **same** held preparation. Its
operator can use `Queue.releaseLease(id, token)` from this source to relinquish
only its lease, preserving the active account and every claim phase. Never copy
another worker's lease token, force its lease away or resume a completed job.
Keep the preparation unlisted. Open its actual Career Overview, with UID and
account level visible. Rediscover the native PID and exact title using `inspect`.

Run `cli.cjs run` with JSON on stdin containing:

| Field | Meaning |
| --- | --- |
| `id` | Existing held claim preparation ID |
| `pid` | Fresh native game PID from `inspect` |
| `title` | Exact game title, including trailing spaces |
| `matches` | `1` for the first commissioning run |
| `minutes` | Hard runtime limit, default `30`, maximum `120` |
| `targetLevel` | Stop at this observed account level, default `15` |

The worker focuses that exact window once, checks the visible UID, and uses the
observed menu text to select Practice vs AI. It stops at any unrecognized layout
instead of guessing where a new control lives. Commission those layouts before
expecting a complete match. Gameplay is a bounded screen-feedback controller
using visible health-bar and objective-color hints; map navigation and mouse
response need real measurement before replay can be enabled.

Screenshots, OCR, decisions, limits and results live privately under
`~/Library/Application Support/RivalsLevelWorker/runs/`. `run.json` distinguishes
completed benchmarks from stopped or unrecognized screens. No evidence is stored
in git. Hero proficiency and Chrono Tokens are never counted as account XP.

## Stop and recovery

```sh
node tools/rivals-level-worker/cli.cjs stop
```

Ctrl-C, focus loss, a mouse moved to the upper-left display corner, the STOP file,
an expired/mismatched claim lease, stale screenshots, or the runtime limit stop
the controller. Input is held for at most three seconds per operation, with focus
checked every 25 ms. Every exit attempts key/button release and returns the same
claim session without advancing its claim phase. It does not abandon or sign out
of a running match automatically. Finish a stopped match manually before leaving
the client unattended.

The STOP file is deliberately persistent. Review the actual game and latest run
before removing it. A leftover `run.lock` also requires checking that its process
is gone; locks are not silently stolen. No LaunchAgent or recurring account queue
is installed. Repeated matches require a private commissioning receipt from a
completed run with combat observations and positive, explicitly labeled account
XP. The target level and per-run match/time limits remain enforced.
