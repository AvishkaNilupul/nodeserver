# Rivals leveling worker

**Live commissioning is in progress. Repeated unattended play is not yet verified.**
A supervised Practice vs AI match produced 227 account XP in 7m35s. That run
included operator movement and had no verified positive combat damage. It is not
a commissioning receipt. The current navigation and combat controller must pass
its own live damage, reward and navigation checks before repeated play is enabled.
The current screen detector, aim correction and rifle controller have produced a
verified Practice Range KO. That isolated combat proof does not establish
unattended match completion or account XP.
A later AI calibration match with controller restarts earned another 227 account
XP in 8m10s. Its named scoreboard showed zero damage. Repeated play remains
uncommissioned.

This local macOS worker owns one existing encrypted claim-queue session. It
checks the Career UID, reads the level badge, selects Practice vs AI, selects The
Punisher, and reads real match rewards. It preserves the claim phase and login.
It does not create accounts or publish marketplace listings.

## Build

Requires macOS 14+, Swift command-line tools, Node.js 20+, existing accessibility
and screen-recording grants, and the repository dependencies. Install the private
model before driving the game:

```sh
npm ci --prefix tools/rivals-level-worker
node tools/rivals-level-worker/cli.cjs build
node tools/rivals-level-worker/setup-depth.cjs
node tools/rivals-level-worker/setup-input.cjs
node tools/rivals-level-worker/cli.cjs inspect
node --test tests/rivalsLevelInput.test.js tests/rivalsLevelWorker.test.js tests/rivalsClaimWorker.test.js
```

The optional depth helper uses Apple's [Core ML Depth Anything V2 Small](https://huggingface.co/apple/coreml-depth-anything-v2-small)
under Apache-2.0, pinned to revision
`cfef6f6f2a70783dedc0bfae40cecbc2052285d3`. Weights, compiled model cache, checksums,
credentials and game receipts stay outside git in
`~/Library/Application Support/RivalsLevelWorker/`. No screenshots are uploaded
for inference. Warm newly built native/model helpers before entering a match.
First-use model compilation can exceed the live screenshot freshness budget.

## Run one benchmark

Open the same account's real Career Overview. Obtain the exact current PID/title
from `inspect`; trailing spaces in the Wine title matter. Release the collector's
lease explicitly. Keep ordinary preparations held and unlisted.

Pass JSON on stdin to `node tools/rivals-level-worker/cli.cjs run`:

| Field | Meaning |
| --- | --- |
| `id` | Existing held claim job |
| `pid`, `title` | Exact observed native game window |
| `nickname` | Exact game name for named scoreboard damage verification |
| `bottle` | Exact existing CrossOver bottle; enables Windows relative input |
| `depth` | `true` enables the depth-based gameplay navigator |
| `captureMethod` | `display-kit` uses ScreenCaptureKit; default `system` uses the system screenshot command |
| `fastCombat` | Uses up to four fresh 1280px target updates over at most 2.2 seconds after an enemy is observed |
| `matches` | `1` until a real commissioning receipt exists |
| `minutes` | Runtime limit, default 30, maximum 120 |
| `targetLevel` | Observed stop level, default 15 |

The explicit `retainedTest` exception is for an owner-retained, verified active
session that was already listed. It requires a separately reconciled remote test
hold, the exact paused offer, one unchanged delivery entry, and no sale or other
commitment. It never automatically pauses or adopts listed stock. The global
claim queue stays paused. Handoff requires `holdId`, `confirmedAt`, and an optional
explicit `authorizedUntil` bounded to eight hours after confirmation. Ordinary
lease expiry does not authorize taking another worker's session.

## Perception and evidence

The controller uses full-display captures cropped to newly read game bounds;
per-window Wine/Metal images can be stale. The optional ScreenCaptureKit path was
checked against the actual foreground game and captures the current main display
at its backing resolution. Vision OCR supplies visible controls,
UIDs and reward labels. A separate digit reader reads the Career badge.

Combat segmentation preserves the thin coral enemy outline at 1280px. Filled
scenery and blue allies are excluded. Dim outlines additionally require a red world-name label; blue names veto allied muzzle flashes. Targets are aligned and observed again before firing; the
navigator can retreat at low health and reloads an observed empty rifle. The depth navigator checks both the forward opening and ground continuity,
so a gap beyond a railing is not automatically treated as a walkable route. It
turns before advancing, includes body clearance beside doorway edges, and keeps
a side passage long enough to observe progress when objective distance stalls.
These are screen-space estimates and require live validation across maps.
Fast combat omits OCR and depth for its brief tracking interval, then returns to
full perception. Each correction requires a fresh image, matching focus and an
observed outline near the previous target. Losing the target ends the burst.
The installed display path measured 262–303 ms for warm raw captures on this Mac.

The actual reward panel binds XP to its Level row, keeping accessory points and
hero proficiency separate. A named scoreboard row supplies damage, final hits
and accuracy. Repeated matches require a completed account-XP receipt and
positive named damage, not just fired inputs or a passing fixture.
Digit isolation reads the reward's level badge and orange scoreboard numbers
when full-frame OCR misses them. Unreadable accuracy stays unknown.

Private `runs/` receipts contain original PNGs, OCR, decisions and limits.
Transitions, initial attack evidence, periodic gameplay, rewards and scoreboards
are retained. To inspect a retained decision:

```sh
node tools/rivals-level-worker/render-evidence.cjs /absolute/frame.png.json /absolute/annotated.png
```

## Stop

```sh
node tools/rivals-level-worker/cli.cjs stop
```

Ctrl-C, focus loss, Control+Option+Escape, stale captures, the
STOP file, mismatching/expired leases or runtime limits release inputs and stop
the worker. Each operation lasts at most three seconds and checks focus every
25ms. The STOP file and stale run locks require inspection before removal. The
worker preserves the account and its claim phase on exit. It does not silently
leave a stopped match or sign out. No LaunchAgent or recurring account queue is
installed by this source.

## CrossOver input

The private Windows helper uses ordinary foreground Win32 input in the exact
existing bottle. Relative mouse input continues when the desktop cursor reaches
an edge; no cursor warp or recenter is used. Gameplay keys use virtual-key
SendInput packets. Escape uses a bounded one-shot window-message path; the persistent stdin path
did not reliably open its menu. The one-shot path was verified against the actual
network diagnostic UI. A native watcher polls macOS focus, STOP and the emergency
hotkey every 25ms; either backend can abort the other. Only owned keys/buttons are
released. The mouse-corner stop applies to the native fallback only, because
normal relative camera input can clamp the Windows cursor at that corner.

The setup script installs a pinned, checksum-verified private Zig toolchain and
builds the helper without changing global Homebrew permissions or bottle settings.
