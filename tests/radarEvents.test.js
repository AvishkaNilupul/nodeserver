const test = require("node:test");
const assert = require("node:assert/strict");

const { buildRadarEvents, splitEventWave } = require("../utils/radarEvents");
const { mergeWaveItems } = require("../utils/radarEventListings");

test("radar groups repeated Twitch campaign ids into one named event", () => {
  const events = buildRadarEvents(
    [
      {
        campaignId: "day-1",
        game: "Escape from Tarkov",
        name: "KORD BREACH S1",
        status: "EXPIRED",
        startAt: "2026-08-11T13:00:00Z",
        endAt: "2026-08-11T18:00:00Z",
      },
      {
        campaignId: "drops-1",
        game: "Escape from Tarkov",
        name: "KORD BREACH S1 Drops",
        status: "ACTIVE",
        active: true,
        startAt: "2026-08-11T13:00:00Z",
        endAt: "2026-08-12T13:00:00Z",
      },
      {
        campaignId: "day-2",
        game: "Escape from Tarkov",
        name: "KORD BREACH S1",
        status: "ACTIVE",
        active: true,
        startAt: "2026-08-12T13:00:00Z",
        endAt: "2026-08-12T18:00:00Z",
      },
    ],
    [],
    [],
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].name, "KORD BREACH S1");
  assert.equal(events[0].campaignCount, 3);
  assert.equal(events[0].status, "ACTIVE");
  assert.equal(events[0].endAt, "2026-08-12T18:00:00Z");
});

test("a standalone Drops suffix remains part of its event name", () => {
  const [event] = buildRadarEvents(
    [{ campaignId: "sf", game: "Shakes and Fidget", name: "S&F Drops" }],
    [],
    [],
  );
  assert.equal(event.name, "S&F Drops");
});

test("week campaigns roll up into one parent event and preserve wave labels", () => {
  const events = buildRadarEvents(
    [
      {
        campaignId: "busan-1",
        game: "Overwatch",
        name: "S4 Heroes of Busan Launch Week 1",
      },
      {
        campaignId: "busan-2",
        game: "Overwatch",
        name: "S4 Heroes of Busan Launch - Week 2",
      },
    ],
    [],
    [],
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].name, "S4 Heroes of Busan Launch");
  assert.deepEqual(
    events[0].waves.map((wave) => wave.label),
    ["Week 1", "Week 2"],
  );
});

test("explicit day and wave suffixes group, while season numbers stay", () => {
  assert.deepEqual(splitEventWave("KORD BREACH S1 Day 1"), {
    eventName: "KORD BREACH S1",
    waveLabel: "Day 1",
  });
  assert.deepEqual(splitEventWave("KORD BREACH S1 (Wave II)"), {
    eventName: "KORD BREACH S1",
    waveLabel: "Wave II",
  });
  assert.deepEqual(splitEventWave("Season 4 Launch"), {
    eventName: "Season 4 Launch",
    waveLabel: "",
  });
  assert.deepEqual(splitEventWave("KORD BREACH S1"), {
    eventName: "KORD BREACH S1",
    waveLabel: "",
  });
});

test("similar names and different games never merge", () => {
  const events = buildRadarEvents(
    [
      { campaignId: "a", game: "Game A", name: "Launch Week 1" },
      { campaignId: "b", game: "Game A", name: "Launch Party Week 2" },
      { campaignId: "c", game: "Game B", name: "Launch Week 2" },
    ],
    [],
    [],
  );
  assert.equal(events.length, 3);
});

test("active tasks and archive evidence produce operational farm coverage", () => {
  const [event] = buildRadarEvents(
    [
      {
        campaignId: "busan",
        game: "Overwatch",
        name: "S4 Heroes of Busan Launch",
        status: "ACTIVE",
        active: true,
      },
    ],
    [
      {
        campaignId: "busan",
        status: "active",
        assignedAccounts: ["Alpha", "alpha", "Bravo"],
        bots: [
          { host: "pi", container: "twitchbotx1" },
          { host: "pi", container: "twitchbotx1" },
        ],
        reason: "Demand tier allocated two accounts",
        updatedAt: "2026-08-12T00:00:00Z",
      },
    ],
    [
      {
        game: "Overwatch",
        campaign: "S4 Heroes of Busan Launch",
        dropRows: 5,
        totalCount: 7,
        accounts: ["a1", "a2"],
        items: ["spray|overwatch", "skin|overwatch"],
      },
    ],
  );

  assert.equal(event.farm.state, "farming");
  assert.equal(event.farm.assignedAccounts, 2);
  assert.equal(event.farm.bots, 1);
  assert.equal(event.farm.archiveAccounts, 2);
  assert.equal(event.farm.archiveItems, 2);
  assert.equal(event.farm.archivedQuantity, 7);
});

test("completed, skipped, and unseen events remain distinguishable", () => {
  const campaigns = [
    { campaignId: "done", game: "A", name: "Done" },
    { campaignId: "skip", game: "B", name: "Skip" },
    { campaignId: "none", game: "C", name: "None" },
  ];
  const events = buildRadarEvents(
    campaigns,
    [
      { campaignId: "done", status: "completed", assignedAccounts: [] },
      { campaignId: "skip", status: "skipped", decision: "skip_low_demand" },
    ],
    [],
  );
  const state = Object.fromEntries(
    events.map((event) => [event.name, event.farm.state]),
  );
  assert.deepEqual(state, {
    None: "untracked",
    Skip: "skipped",
    Done: "farmed",
  });
});

test("assigned accounts do not hide a failed farming wave", () => {
  const [event] = buildRadarEvents(
    [{ campaignId: "failed", game: "A", name: "Failed event" }],
    [
      {
        campaignId: "failed",
        status: "failed",
        assignedAccounts: ["AccountOne"],
      },
    ],
    [],
  );
  assert.equal(event.farm.state, "failed");
  assert.equal(event.waves[0].farm.state, "failed");
  assert.equal(event.farm.assignedAccounts, 1);
});

test("a completed wave plus an unfarmed wave is partially farmed", () => {
  const [event] = buildRadarEvents(
    [
      { campaignId: "w1", game: "A", name: "Launch Week 1" },
      { campaignId: "w2", game: "A", name: "Launch Week 2" },
    ],
    [{ campaignId: "w1", status: "completed", assignedAccounts: ["One"] }],
    [],
  );
  assert.equal(event.farm.state, "partially_farmed");
  assert.equal(event.farm.assignedAccounts, 1);
  assert.deepEqual(
    event.waves.map((wave) => wave.farm.state),
    ["farmed", "untracked"],
  );
});

test("assigned accounts are deduplicated across event waves", () => {
  const [event] = buildRadarEvents(
    [
      { campaignId: "w1", game: "A", name: "Launch Week 1" },
      { campaignId: "w2", game: "A", name: "Launch Week 2" },
    ],
    [
      {
        campaignId: "w1",
        status: "completed",
        assignedAccounts: ["One", "Two"],
      },
      {
        campaignId: "w2",
        status: "completed",
        assignedAccounts: ["one", "Three"],
      },
    ],
    [],
  );
  assert.equal(event.farm.state, "farmed");
  assert.equal(event.farm.assignedAccounts, 3);
});

test("event listing merges rewards and sums repeats across waves", () => {
  const items = mergeWaveItems([
    {
      game: "Overwatch",
      items: [
        { name: "Busan Spray", itemKey: "busan spray|overwatch", qty: 1 },
        { name: "Hero Skin", itemKey: "hero skin|overwatch", qty: 1 },
      ],
    },
    {
      game: "Overwatch",
      items: [
        { name: "Busan Spray", itemKey: "busan spray|overwatch", qty: 2 },
      ],
    },
  ]);
  assert.deepEqual(
    Object.fromEntries(items.map((item) => [item.itemKey, item.qty])),
    {
      "busan spray|overwatch": 3,
      "hero skin|overwatch": 1,
    },
  );
});
