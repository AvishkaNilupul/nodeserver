const test = require("node:test");
const assert = require("node:assert/strict");

const { buildRadarEvents } = require("../utils/radarEvents");

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
