const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HOST_STALE_MS,
  WATCHER_FRESH_MS,
  deriveBotState,
  decisionSummary,
  buildPayload,
  mergeHostResult,
  allAutoBotKeys,
} = require("../utils/autoFarmSnapshot");
const { FRESH_MS, classifyBotCompletion } = require("../utils/farmCompletion");

const NOW = new Date("2026-08-22T12:00:00.000Z");
const RUNNING = { state: "running", status: "Up 2 days" };
const goodCompletion = {
  working: 2,
  finished: 1,
  unknown: 0,
  notStarted: 0,
  stoppable: false,
  reason: "2 still working",
};

test("watcher uses 30h freshness without changing farmCompletion's 24h default", () => {
  assert.equal(FRESH_MS, 24 * 60 * 60 * 1000);
  assert.equal(WATCHER_FRESH_MS, 30 * 60 * 60 * 1000);
});

test("batch classifier honours per-user games, unknowns and not-started accounts", () => {
  const data = {
    FavouriteGames: ["Fortnite"],
    TwitchSettings: {
      OnlyFavouriteGames: true,
      TwitchUsers: [
        { ClientSecret: "a", Login: "A", Enabled: true, FavouriteGames: [] },
        {
          ClientSecret: "b",
          Login: "B",
          Enabled: true,
          FavouriteGames: ["Rust"],
        },
        { ClientSecret: "c", Login: "C", Enabled: true },
      ],
    },
  };
  const rows = [
    {
      clientSecret: "a",
      login: "A",
      inProgressCount: 1,
      inProgressGames: ["Fortnite"],
      dropCount: 3,
      lastScanAt: new Date(NOW - 60_000),
      lastScanStatus: "ok",
    },
    {
      clientSecret: "b",
      login: "B",
      inProgressCount: 1,
      inProgressGames: ["A Game This Bot Does Not Farm"],
      dropCount: 4,
      lastScanAt: new Date(NOW - 60_000),
      lastScanStatus: "ok",
    },
    {
      clientSecret: "c",
      login: "C",
      inProgressCount: 0,
      inProgressGames: [],
      dropCount: 0,
      lastScanAt: new Date(NOW - 60_000),
      lastScanStatus: "ok",
    },
  ];
  const out = classifyBotCompletion(data, rows, {
    freshMs: WATCHER_FRESH_MS,
    now: NOW,
  });
  assert.equal(out.working, 1);
  assert.equal(out.finished, 1);
  assert.equal(out.notStarted, 1);
  assert.equal(out.unknown, 0);
  assert.equal(out.stoppable, false);
  assert.deepEqual(out.assignedGames.sort(), ["fortnite", "rust"]);
});

test("OnlyFavouriteGames false conservatively counts progress on every game", () => {
  const out = classifyBotCompletion(
    {
      FavouriteGames: ["Rust"],
      TwitchSettings: {
        OnlyFavouriteGames: false,
        TwitchUsers: [{ ClientSecret: "a", Enabled: true }],
      },
    },
    [
      {
        clientSecret: "a",
        login: "A",
        inProgressCount: 1,
        inProgressGames: ["Fortnite"],
        dropCount: 2,
        lastScanAt: NOW,
        lastScanStatus: "ok",
      },
    ],
    { now: NOW },
  );
  assert.equal(out.working, 1);
});

test("state precedence keeps parked healthy, then down and stalled actionable", () => {
  const observedAt = NOW;
  assert.equal(
    deriveBotState({
      docker: { state: "exited", status: "Exited (0)" },
      parked: { reason: "finished" },
      observedAt,
      now: NOW.getTime(),
    }).state,
    "PARKED",
  );
  assert.equal(
    deriveBotState({
      docker: null,
      parked: { reason: "finished" },
      observedAt,
      now: NOW.getTime(),
    }).state,
    "PARKED",
  );
  assert.equal(
    deriveBotState({ docker: null, observedAt, now: NOW.getTime() }).state,
    "DOWN",
  );
  assert.equal(
    deriveBotState({
      docker: RUNNING,
      completion: goodCompletion,
      health: { decay: { decayed: true } },
      degraded: 3,
      observedAt,
      now: NOW.getTime(),
    }).state,
    "STALLED",
  );
});

// Regression: collectHost passes `byFile[file] || null`, so a container that is
// up while its config could not be read (or failed to parse) reaches this with
// no completion verdict at all. Reading through that null threw a TypeError and
// aborted the whole host pass — the one case the watcher most needs to report.
test("a running container with no completion verdict is UNKNOWN, not a crash", () => {
  const observedAt = NOW;
  for (const completion of [null, undefined]) {
    const out = deriveBotState({
      docker: RUNNING,
      completion,
      parked: null,
      health: null,
      degraded: 0,
      observedAt,
      now: NOW.getTime(),
    });
    assert.equal(out.state, "UNKNOWN");
    assert.match(out.reason, /completion data unavailable/);
  }
});

test("farming bots become degraded for bad assigned accounts; completed ones idle", () => {
  const observedAt = NOW;
  assert.equal(
    deriveBotState({
      docker: RUNNING,
      completion: goodCompletion,
      degraded: 2,
      observedAt,
      now: NOW.getTime(),
    }).state,
    "DEGRADED",
  );
  assert.equal(
    deriveBotState({
      docker: RUNNING,
      completion: {
        working: 0,
        unknown: 0,
        notStarted: 0,
        stoppable: true,
        reason: "done",
      },
      observedAt,
      now: NOW.getTime(),
    }).state,
    "DONE_IDLE",
  );
});

test("stale host data is unknown rather than falsely down", () => {
  const out = deriveBotState({
    docker: null,
    observedAt: new Date(NOW.getTime() - HOST_STALE_MS - 1),
    now: NOW.getTime(),
  });
  assert.equal(out.state, "UNKNOWN");
});

test("a failed host refresh retains the previous last-good observation", () => {
  const old = {
    observedAt: "2026-08-22T11:55:00.000Z",
    lastAttemptAt: "2026-08-22T11:55:00.000Z",
    error: "",
    bots: { twitchbotx2: { docker: RUNNING } },
  };
  const merged = mergeHostResult(old, {
    lastAttemptAt: NOW.toISOString(),
    error: "host unreachable",
  });
  assert.equal(merged.observedAt, old.observedAt);
  assert.equal(merged.bots, old.bots);
  assert.equal(merged.error, "host unreachable");
  assert.equal(merged.lastAttemptAt, NOW.toISOString());
});

test("decision summary uses decidedAt and canonical decision enums", () => {
  const rows = [
    {
      decision: "farm",
      decidedAt: new Date("2026-08-22T08:00:00.000Z"),
      updatedAt: new Date("2026-08-20T00:00:00.000Z"),
    },
    {
      decision: "skip_low_demand",
      decidedAt: new Date("2026-08-22T09:00:00.000Z"),
    },
    {
      decision: "skip_no_capacity",
      decidedAt: new Date("2026-08-21T09:00:00.000Z"),
    },
  ];
  const out = decisionSummary(rows, NOW);
  assert.equal(out.total, 2);
  assert.equal(out.farm, 1);
  assert.equal(out.skipped, 1);
  assert.deepEqual(out.byDecision, { farm: 1, skip_low_demand: 1 });
});

test("auto ownership keys retain historical configs without exposing accounts", () => {
  const keys = allAutoBotKeys([
    {
      status: "active",
      assignedAccounts: ["secret-login"],
      bots: [{ host: "pi", file: "config_22.json" }],
    },
    {
      status: "completed",
      bots: [
        { host: "pi", file: "config_22.json" },
        { host: "local", file: "config_03.json" },
      ],
    },
  ]);
  assert.deepEqual(keys.sort(), ["local|config_03.json", "pi|config_22.json"]);
});

test("snapshot exposes the watcher header and per-game bot contract", () => {
  const out = buildPayload({
    tasks: [
      {
        _id: "task-1",
        game: "Rust",
        campaignId: "rust-drops",
        campaignName: "Rust Drops",
        status: "active",
        decision: "farm",
        assignedAccounts: ["one", "two", "three"],
        bots: [
          {
            host: "pi",
            container: "twitchbotx2",
            file: "config_02.json",
          },
        ],
      },
    ],
    hostData: new Map([
      [
        "pi",
        {
          observedAt: NOW,
          bots: {
            twitchbotx2: {
              docker: RUNNING,
              completion: { ...goodCompletion, total: 3 },
              deadToken: 1,
              degraded: 1,
            },
          },
        },
      ],
    ]),
    now: NOW,
    settingsValue: {
      enabled: true,
      dryRun: false,
      maxPerGame: 30,
      accountsPerBot: 70,
      maxAutoBots: 8,
      poolReserve: 20,
    },
    pool: { ready: 40, reserve: 20, spendable: 20 },
  });

  assert.equal(out.header.capacity.used, 1);
  assert.equal(out.header.capacity.max, 8);
  assert.ok(Object.hasOwn(out.header, "lastScanAt"));
  assert.equal(out.games.length, 1);
  assert.equal(out.games[0].game, "Rust");
  assert.equal(out.games[0].bots[0].key, "pi|twitchbotx2");
  assert.deepEqual(out.games[0].bots[0].accounts, {
    total: 3,
    progressing: 2,
    finished: 1,
    unknown: 0,
    deadToken: 1,
    suspended: 0,
    scanError: 0,
  });
});
