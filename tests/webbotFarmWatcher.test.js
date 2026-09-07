// Pure-function coverage for the web-farm auto-power watcher's two decisions —
// no docker, no Mongo, no network:
//   1. decideActions — start only a stopped bot on a CONFIRMED-live game (never
//      on an uncertain verdict, never one the operator stopped); stop only a
//      running bot on a confidently-dark game.
//   2. resolveWithHysteresis — a stop is withheld until a game has been dark for
//      the full hysteresis window; going live clears the anchor immediately.
// The web farm's games are dynamic (any pinned game), so these use a mix.
// See utils/webbotFarmWatcher.js.
const test = require("node:test");
const assert = require("node:assert");

const {
  decideActions,
  resolveWithHysteresis,
  buildChannelsFile,
  channelsHash,
  heartbeatVerdict,
  shouldAlertIdle,
  buildSyncScript,
  parseSyncOutput,
  _state,
} = require("../utils/webbotFarmWatcher");

const MIN = 60 * 1000;

test("decideActions: resumes a watcher-parked bot when its game is live", () => {
  const bots = [
    { id: "3", game: "Overwatch", running: false, autostopped: true, operatorOff: false },
    { id: "7", game: "Overwatch", running: true, autostopped: false, operatorOff: false },
  ];
  const verdict = { overwatch: { live: true, canStop: false } };
  const { starts, stops } = decideActions(bots, verdict);
  assert.deepStrictEqual(starts, ["3"]); // parked + game live -> resume
  assert.deepStrictEqual(stops, []); // running + live -> leave
});

test("decideActions: cold-starts a never-touched stopped bot when live", () => {
  // No markers (fresh / crashed / rebooted, or a plain docker-stop) -> start it
  // when the game is live.
  const bots = [{ id: "9", game: "Overwatch", running: false, autostopped: false, operatorOff: false }];
  const verdict = { overwatch: { live: true, canStop: false } };
  assert.deepStrictEqual(decideActions(bots, verdict).starts, ["9"]);
});

test("decideActions: an uncertain verdict never cold-starts a stopped bot", () => {
  // No active campaign + an unverifiable catalog (e.g. the boot window before
  // campaignWatcher's first pass) => uncertain, not live. A stopped bot stays
  // stopped so a restart can't wake the fleet for a non-existent campaign.
  const bots = [
    { id: "3", game: "Overwatch", running: false, autostopped: true, operatorOff: false },
    { id: "9", game: "Overwatch", running: false, autostopped: false, operatorOff: false },
  ];
  const verdict = { overwatch: { live: true, uncertain: true, canStop: false } };
  const { starts, stops } = decideActions(bots, verdict);
  assert.deepStrictEqual(starts, []); // uncertain -> do NOT wake parked bots
  assert.deepStrictEqual(stops, []);
});

test("decideActions: an uncertain verdict keeps a running bot up (fail toward farming)", () => {
  const bots = [{ id: "7", game: "Overwatch", running: true, autostopped: false, operatorOff: false }];
  const verdict = { overwatch: { live: true, uncertain: true, canStop: false } };
  const { starts, stops } = decideActions(bots, verdict);
  assert.deepStrictEqual(starts, []);
  assert.deepStrictEqual(stops, []); // running + uncertain -> leave running
});

test("decideActions: never auto-starts a bot the operator stopped", () => {
  // .operatoroff marker => explicit Stop; stays down even when the game is live.
  const bots = [{ id: "3", game: "Overwatch", running: false, autostopped: false, operatorOff: true }];
  const verdict = { overwatch: { live: true, canStop: false } };
  const { starts, stops } = decideActions(bots, verdict);
  assert.deepStrictEqual(starts, []);
  assert.deepStrictEqual(stops, []);
});

test("decideActions: stops a running bot only once the game can-stop", () => {
  const bots = [
    { id: "5", game: "Rainbow Six Siege", running: true, autostopped: false },
    { id: "6", game: "Rainbow Six Siege", running: true, autostopped: false },
  ];
  // Dark but still inside the hysteresis grace => no stop.
  assert.deepStrictEqual(
    decideActions(bots, { "rainbow six": { live: false, canStop: false } }).stops,
    [],
  );
  // Dark long enough => stop both.
  assert.deepStrictEqual(
    decideActions(bots, { "rainbow six": { live: false, canStop: true } }).stops,
    ["5", "6"],
  );
});

test("decideActions: gates each bot by its own pinned game independently", () => {
  // Mixed fleet: OW dark+stoppable, R6 live. Only the OW running bot is stopped;
  // the R6 bot is left farming. (The real regression this guards: don't let one
  // game's verdict leak onto a bot pinned to another.)
  const bots = [
    { id: "3", game: "Overwatch", running: true, autostopped: false, operatorOff: false },
    { id: "5", game: "Rainbow Six Siege", running: true, autostopped: false, operatorOff: false },
  ];
  const verdict = {
    overwatch: { live: false, canStop: true },
    "rainbow six": { live: true, canStop: false },
  };
  const { starts, stops } = decideActions(bots, verdict);
  assert.deepStrictEqual(starts, []);
  assert.deepStrictEqual(stops, ["3"]); // only OW stopped; R6 left running
});

test("decideActions: leaves games it does not manage untouched", () => {
  const bots = [{ id: "1", game: "Marvel Rivals", running: true, autostopped: false }];
  const verdict = { overwatch: { live: false, canStop: true } };
  const { starts, stops } = decideActions(bots, verdict);
  assert.deepStrictEqual(starts, []);
  assert.deepStrictEqual(stops, []);
});

test("decideActions: an already-stopped dark bot is a no-op (not double-stopped)", () => {
  const bots = [{ id: "3", game: "Overwatch", running: false, autostopped: true }];
  const verdict = { overwatch: { live: false, canStop: true } };
  const { starts, stops } = decideActions(bots, verdict);
  assert.deepStrictEqual(starts, []); // dark -> don't resume
  assert.deepStrictEqual(stops, []); // already stopped -> nothing to do
});

test("resolveWithHysteresis: live clears the dark anchor and can-stop", () => {
  _state.darkSince = { overwatch: Date.now() - 60 * MIN };
  const out = resolveWithHysteresis({ overwatch: { live: true } }, Date.now());
  assert.strictEqual(out.overwatch.canStop, false);
  assert.strictEqual(_state.darkSince.overwatch, undefined);
});

test("resolveWithHysteresis: dark withholds can-stop until the window elapses", () => {
  _state.darkSince = {};
  const t0 = Date.now();
  let out = resolveWithHysteresis({ overwatch: { live: false } }, t0);
  assert.strictEqual(out.overwatch.canStop, false);
  assert.strictEqual(_state.darkSince.overwatch, t0);
  out = resolveWithHysteresis({ overwatch: { live: false } }, t0 + 5 * MIN);
  assert.strictEqual(out.overwatch.canStop, false);
  out = resolveWithHysteresis({ overwatch: { live: false } }, t0 + 21 * MIN);
  assert.strictEqual(out.overwatch.canStop, true);
});

test("resolveWithHysteresis: forgets anchors for games no longer managed", () => {
  _state.darkSince = { overwatch: Date.now(), "old game": Date.now() };
  resolveWithHysteresis({ overwatch: { live: false } }, Date.now());
  assert.ok("overwatch" in _state.darkSince);
  assert.strictEqual(_state.darkSince["old game"], undefined);
});

// ---------------------------------------------------------------------------
// channels.json / heartbeat / idle alert (docs/WEBBOT-ACL-CHANNELS-CONTRACT.md)
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-09-06T12:00:00.000Z");
const bot = { id: "5", game: "Rainbow Six Siege", running: true, accounts: 50 };

test("buildChannelsFile: gated campaign → acl + live subset; ungated → acl null, live []", () => {
  const file = buildChannelsFile(
    bot,
    [
      {
        campaignId: "c1",
        name: "R6S S2 2026 1",
        endAt: "2026-09-07T04:58:00.000Z",
        acl: ["Rainbow6", "rainbow6fr", "rainbow6", "rainbow6es"],
        live: ["rainbow6", "skyte"], // skyte is NOT in the ACL → must not leak
      },
      { campaignId: "c2", name: "Community", endAt: null, acl: [], live: ["skyte"] },
      { campaignId: "c3", name: "Ungated", endAt: null, acl: null, live: [] },
    ],
    NOW,
  );
  assert.strictEqual(file.v, 1);
  assert.strictEqual(file.game, "Rainbow Six Siege");
  assert.strictEqual(file.updatedAt, "2026-09-06T12:00:00.000Z");
  assert.strictEqual(file.error, undefined);
  assert.strictEqual(file.campaigns.length, 3);
  const [c1, c2, c3] = file.campaigns;
  assert.deepStrictEqual(c1, {
    id: "c1",
    name: "R6S S2 2026 1",
    endAt: "2026-09-07T04:58:00.000Z",
    acl: ["rainbow6", "rainbow6es", "rainbow6fr"], // lowercased, deduped, sorted
    live: ["rainbow6"], // strict subset of acl
  });
  assert.strictEqual(c2.acl, null); // [] ACL == un-gated
  assert.deepStrictEqual(c2.live, []);
  assert.strictEqual(c2.endAt, null);
  assert.strictEqual(c3.acl, null);
});

test("buildChannelsFile: drops campaigns that already ended", () => {
  const file = buildChannelsFile(
    bot,
    [
      { campaignId: "old", name: "Old", endAt: "2026-09-06T11:59:59.000Z", acl: ["rainbow6"], live: ["rainbow6"] },
      { campaignId: "cur", name: "Current", endAt: "2026-09-06T12:00:01.000Z", acl: ["rainbow6"], live: [] },
    ],
    NOW,
  );
  assert.deepStrictEqual(file.campaigns.map((c) => c.id), ["cur"]);
  // Empty input still yields a well-formed file (the farmer falls back to
  // today's behaviour on "no considered campaigns").
  assert.deepStrictEqual(buildChannelsFile(bot, [], NOW).campaigns, []);
});

test("buildChannelsFile: a liveness error blanks live and surfaces a top-level error", () => {
  const file = buildChannelsFile(
    bot,
    [
      { campaignId: "c1", name: "A", endAt: null, acl: ["rainbow6"], live: ["rainbow6"], error: "Twitch liveness read failed (HTTP 502)" },
      { campaignId: "c2", name: "B", endAt: null, acl: ["x"], live: ["x"], error: "second" },
    ],
    NOW,
  );
  assert.strictEqual(file.error, "Twitch liveness read failed (HTTP 502)"); // first wins
  assert.deepStrictEqual(file.campaigns[0].live, []);
  assert.deepStrictEqual(file.campaigns[0].acl, ["rainbow6"]); // acl itself is still published
  // live accepts a Set too (getStreamsLive returns one)
  const viaSet = buildChannelsFile(bot, [{ campaignId: "c", name: "", endAt: null, acl: ["a", "b"], live: new Set(["b"]) }], NOW);
  assert.deepStrictEqual(viaSet.campaigns[0].live, ["b"]);
});

test("channelsHash: ignores updatedAt, changes with content", () => {
  const camps = [{ campaignId: "c1", name: "A", endAt: null, acl: ["rainbow6"], live: [] }];
  const a = buildChannelsFile(bot, camps, NOW);
  const b = buildChannelsFile(bot, camps, NOW + 10 * MIN);
  assert.strictEqual(channelsHash(a), channelsHash(b));
  const c = buildChannelsFile(bot, [{ ...camps[0], live: ["rainbow6"] }], NOW);
  assert.notStrictEqual(channelsHash(a), channelsHash(c));
});

test("heartbeatVerdict: farming / idle / starting / unknown", () => {
  const gv = { live: true, uncertain: false };
  assert.strictEqual(heartbeatVerdict({ progress: 3, noSession: 9, attaches: 1 }, gv), "farming");
  assert.strictEqual(heartbeatVerdict({ progress: 0, noSession: 12, attaches: 2 }, gv), "idle");
  assert.strictEqual(heartbeatVerdict({ progress: 0, noSession: 0, attaches: 1 }, gv), "starting");
  assert.strictEqual(heartbeatVerdict({ progress: 0, noSession: 0, attaches: 0 }, gv), "starting");
  assert.strictEqual(heartbeatVerdict(null, gv), "unknown");
  assert.strictEqual(heartbeatVerdict(undefined, gv), "unknown");
});

test("shouldAlertIdle: needs 2 consecutive idle ticks, then one alert per 60 min", () => {
  // first idle tick → no alert yet
  assert.strictEqual(shouldAlertIdle([], "idle", null, NOW), false);
  assert.strictEqual(shouldAlertIdle(["starting"], "idle", null, NOW), false);
  assert.strictEqual(shouldAlertIdle(["farming"], "idle", null, NOW), false);
  // second consecutive idle → alert
  assert.strictEqual(shouldAlertIdle(["idle"], "idle", null, NOW), true);
  assert.strictEqual(shouldAlertIdle(["farming", "idle"], "idle", null, NOW), true);
  // current tick not idle → never
  assert.strictEqual(shouldAlertIdle(["idle"], "farming", null, NOW), false);
  assert.strictEqual(shouldAlertIdle(["idle"], "unknown", null, NOW), false);
  // cooldown: alerted 30 min ago → hold; 61 min ago → fire again
  assert.strictEqual(shouldAlertIdle(["idle"], "idle", NOW - 30 * MIN, NOW), false);
  assert.strictEqual(shouldAlertIdle(["idle"], "idle", NOW - 61 * MIN, NOW), true);
});

test("buildSyncScript: writes ride stdin, heartbeat greps run per running bot, unsafe ids dropped", () => {
  const file = buildChannelsFile(bot, [], NOW);
  const { script, input } = buildSyncScript(["5", "6", "../evil"], [{ id: "5", file }, { id: "x y", file }]);
  // stdin payload: "<id> <base64>\n" per SAFE write only
  const lines = input.split("\n").filter(Boolean);
  assert.strictEqual(lines.length, 1);
  const [id, b64] = lines[0].split(" ");
  assert.strictEqual(id, "5");
  assert.deepStrictEqual(JSON.parse(Buffer.from(b64, "base64").toString("utf8")), file);
  // atomic tmp→mv, no heredoc
  assert.ok(script.includes('base64 -d > "$d/channels.json.tmp" && mv "$d/channels.json.tmp" "$d/channels.json"'));
  assert.ok(!script.includes("<<"));
  // The heartbeat discovers running containers from docker itself, so a bot
  // that came up after the tick's snapshot still gets sampled. No per-id
  // `docker logs` line, and the caller's ids never reach the shell.
  assert.ok(script.includes("docker ps --filter name=^/webbot-bot- --format '{{.Names}}'"));
  assert.ok(script.includes('docker logs --since 6m "$c"'));
  assert.ok(!script.includes("docker logs --since 6m 'webbot-bot-5'"));
  assert.ok(!script.includes("evil"));
  assert.ok(script.includes("grep -c -F 'progress → drop'"));
  assert.ok(script.includes("grep -c -F 'no active drop-session'"));
  assert.ok(script.includes("grep -c -E 'farming .* via'"));
  // The caller's own (possibly stale) view is echoed back, SAFE-filtered, for
  // the alert pass — it no longer decides what gets sampled.
  const { runningIds } = buildSyncScript(["5", "6", "../evil"], []);
  assert.deepStrictEqual(runningIds, ["5", "6"]);
  // no writes → still a parseable heartbeat block, and it still sweeps docker
  const empty = buildSyncScript([], []);
  assert.strictEqual(empty.input, "");
  assert.ok(empty.script.includes('echo "HB_START"'));
  assert.ok(empty.script.includes('echo "HB_END"'));
  assert.ok(empty.script.includes("docker ps --filter"));
});

test("buildSyncScript: a bot missing from runningIds is still heartbeated", () => {
  // The regression: bots 7/8 were recreated after the tick's snapshot, so they
  // were absent from runningIds and the page showed them as "unknown".
  const { script } = buildSyncScript([], []);
  assert.ok(script.includes("docker ps --filter"), "must sweep docker, not the caller's list");
  // and the parser accepts whatever ids come back
  const out = parseSyncOutput(["HB_START", "7|245|4|51|50|4", "8|241|6|51|50|6", "HB_END"].join("\n"));
  assert.deepStrictEqual(Object.keys(out.heartbeat).sort(), ["7", "8"]);
  assert.strictEqual(out.heartbeat["7"].progressAccounts, 50);
});

test("parseSyncOutput: heartbeat rows and write receipts", () => {
  const out = parseSyncOutput(
    ["WR|5|ok", "WR|6|fail", "HB_START", "5|3|120|1", "6|0|40|2", "junk line", "HB_END", ""].join("\n"),
  );
  assert.deepStrictEqual(out.written, ["5"]);
  assert.deepStrictEqual(out.failed, ["6"]);
  assert.deepStrictEqual(out.heartbeat["5"], { progress: 3, noSession: 120, attaches: 1 });
  assert.deepStrictEqual(out.heartbeat["6"], { progress: 0, noSession: 40, attaches: 2 });
  assert.strictEqual(out.heartbeat["junk line"], undefined);
});

// --- Per-account coverage: the partial-failure blind spot -------------------
// A raw `grep -c 'progress → drop'` says "farming" whenever ANY line exists, so
// a bot with 49 of 50 accounts stalled and one healthy looked perfectly fine.
// These lock in the distinct-ACCOUNT verdict that replaced it.

test("heartbeatVerdict: full coverage is farming, thin coverage is partial", () => {
  const gv = { live: true, uncertain: false };
  // 50 of 50 accounts credited a minute → healthy.
  assert.strictEqual(
    heartbeatVerdict({ progress: 300, noSession: 0, attaches: 50, progressAccounts: 50 }, gv, 50),
    "farming",
  );
  // Exactly at the threshold (25/50 = 0.5) is still farming — rotation churn.
  assert.strictEqual(
    heartbeatVerdict({ progress: 150, noSession: 30, attaches: 50, progressAccounts: 25 }, gv, 50),
    "farming",
  );
  // THE BUG: one healthy account out of fifty. Raw line count said "farming".
  assert.strictEqual(
    heartbeatVerdict({ progress: 6, noSession: 280, attaches: 50, progressAccounts: 1 }, gv, 50),
    "partial",
  );
  // 24/50 = 0.48, just under the line.
  assert.strictEqual(
    heartbeatVerdict({ progress: 144, noSession: 90, attaches: 50, progressAccounts: 24 }, gv, 50),
    "partial",
  );
});

test("heartbeatVerdict: a pre-label farmer image must NOT read as partial", () => {
  const gv = { live: true, uncertain: false };
  // Old image: plenty of progress lines but no labels to count, so the row
  // carries no progressAccounts key at all. Falling through to the line count
  // is what stops a rolling image upgrade alerting on every healthy bot.
  assert.strictEqual(
    heartbeatVerdict({ progress: 300, noSession: 0, attaches: 50 }, gv, 50),
    "farming",
  );
  // Same row shape, genuinely idle → still idle.
  assert.strictEqual(
    heartbeatVerdict({ progress: 0, noSession: 280, attaches: 50 }, gv, 50),
    "idle",
  );
});

test("heartbeatVerdict: labelled image with zero accounts progressing is idle, not partial", () => {
  const gv = { live: true, uncertain: false };
  assert.strictEqual(
    heartbeatVerdict(
      { progress: 0, noSession: 280, attaches: 50, progressAccounts: 0, noSessionAccounts: 50 },
      gv,
      50,
    ),
    "idle",
  );
  // No account count known (bot config unreadable) → cannot judge coverage.
  assert.strictEqual(
    heartbeatVerdict({ progress: 6, noSession: 280, attaches: 50, progressAccounts: 1 }, gv, 0),
    "farming",
  );
});

test("shouldAlertIdle: partial alerts, and idle/partial flapping still alerts", () => {
  const NOW = 1758000000000;
  assert.strictEqual(shouldAlertIdle(["partial"], "partial", null, NOW), true);
  // A bot alternating between the two bad states is still failing.
  assert.strictEqual(shouldAlertIdle(["idle"], "partial", null, NOW), true);
  assert.strictEqual(shouldAlertIdle(["partial"], "idle", null, NOW), true);
  // One bad tick alone is not enough.
  assert.strictEqual(shouldAlertIdle(["farming"], "partial", null, NOW), false);
  // Recovery silences it.
  assert.strictEqual(shouldAlertIdle(["partial"], "farming", null, NOW), false);
  // Cooldown still applies across the widened verdict set.
  assert.strictEqual(shouldAlertIdle(["partial"], "partial", NOW - 30 * MIN, NOW), false);
  assert.strictEqual(shouldAlertIdle(["partial"], "partial", NOW - 61 * MIN, NOW), true);
});

test("buildSyncScript: emits distinct-account counts as a 6-field row", () => {
  const { script } = buildSyncScript(["5"], []);
  // The distinct extractor must de-duplicate, and `sed -n …p` must print only
  // on a match so an unlabelled log yields 0 rather than a bogus count.
  assert.match(script, /sed -n -E/);
  assert.match(script, /sort -u \| wc -l/);
  assert.ok(script.includes("pa=$(grep -F 'progress → drop'"));
  assert.ok(script.includes("sa=$(grep -F 'no active drop-session'"));
  // The id now comes from the container name docker reported, not the caller.
  assert.ok(script.includes('echo "$id|$p|$s|$a|$pa|$sa|$ca"'));
  assert.ok(script.includes('id=${c#webbot-bot-}'));
  assert.ok(script.includes("ca=$(grep -F 'already complete'"));
  // The load-bearing grep strings the farmer's log lines must keep matching.
  assert.ok(script.includes("grep -c -F 'progress → drop'"));
  assert.ok(script.includes("grep -c -F 'no active drop-session'"));
});

test("parseSyncOutput: 6-field rows carry coverage, 4-field rows stay untouched", () => {
  const out = parseSyncOutput(
    ["HB_START", "5|300|0|50|50|0", "6|6|280|50|1|49", "7|3|120|1", "HB_END"].join("\n"),
  );
  assert.deepStrictEqual(out.heartbeat["5"], {
    progress: 300, noSession: 0, attaches: 50, progressAccounts: 50, noSessionAccounts: 0,
  });
  assert.deepStrictEqual(out.heartbeat["6"], {
    progress: 6, noSession: 280, attaches: 50, progressAccounts: 1, noSessionAccounts: 49,
  });
  // Pre-label row: identical shape to before this change, no coverage keys.
  assert.deepStrictEqual(out.heartbeat["7"], { progress: 3, noSession: 120, attaches: 1 });
  // A 5-field row is malformed and must be ignored, not half-parsed.
  const bad = parseSyncOutput(["HB_START", "5|1|2|3|4", "HB_END"].join("\n"));
  assert.strictEqual(bad.heartbeat["5"], undefined);
});

test("end-to-end: the 49-of-50-stalled bot now reports partial and alerts", () => {
  const gv = { live: true, uncertain: false };
  const { heartbeat } = parseSyncOutput(["HB_START", "5|6|280|50|1|49", "HB_END"].join("\n"));
  const verdict = heartbeatVerdict(heartbeat["5"], gv, 50);
  assert.strictEqual(verdict, "partial");
  assert.strictEqual(shouldAlertIdle([verdict], verdict, null, Date.now()), true);
});

// A bot whose accounts have FINISHED the event is the farm working, not a
// stall. Both signals it used to produce — thin progress coverage ("partial")
// and no drop session ("idle") — are alertable, so on 2026-09-07 all five
// Overwatch bots finished the CAH Championship Finals and every one of them
// would have paged the operator.
test("heartbeatVerdict: a finished campaign reads complete, not partial/idle", () => {
  const done = { progress: 0, noSession: 50, attaches: 50, progressAccounts: 0, noSessionAccounts: 50, completeAccounts: 50 };
  assert.strictEqual(heartbeatVerdict(done, null, 50), "complete");
  // mid-transition: a few still finishing their last drop, the rest done
  const mixed = { progress: 20, noSession: 10, attaches: 50, progressAccounts: 3, noSessionAccounts: 48, completeAccounts: 45 };
  assert.strictEqual(heartbeatVerdict(mixed, null, 50), "complete");
  // a genuinely thin bot with nothing complete still reports partial
  const thin = { progress: 6, noSession: 280, attaches: 50, progressAccounts: 1, noSessionAccounts: 49, completeAccounts: 0 };
  assert.strictEqual(heartbeatVerdict(thin, null, 50), "partial");
  // and "complete" must never be alertable
  assert.strictEqual(shouldAlertIdle(["complete"], "complete", null, Date.now()), false);
});

test("parseSyncOutput: 7-field rows carry the complete count; 6- and 4-field rows still parse", () => {
  const out = parseSyncOutput(
    ["HB_START", "8|0|50|50|0|50|50", "9|300|0|50|50|0", "10|3|120|1", "HB_END"].join("\n"),
  );
  assert.strictEqual(out.heartbeat["8"].completeAccounts, 50);
  assert.strictEqual(out.heartbeat["9"].progressAccounts, 50);
  assert.ok(!("completeAccounts" in out.heartbeat["9"]), "6-field row must not invent a complete count");
  assert.ok(!("progressAccounts" in out.heartbeat["10"]), "4-field row shape unchanged");
});

