const test = require("node:test");
const assert = require("node:assert/strict");

const { usageSince, summarizeUsageRows } = require("../utils/poolUsageWatcher");

test("today starts at midnight in Tokyo, not UTC", () => {
  const now = new Date("2026-08-22T04:30:00.000Z"); // 13:30 JST
  assert.equal(usageSince("today", now).since.toISOString(), "2026-08-21T15:00:00.000Z");
});

test("7d and 30d include today plus the preceding calendar days", () => {
  const now = new Date("2026-08-22T20:00:00.000Z"); // Aug 23 JST
  assert.equal(usageSince("7d", now).since.toISOString(), "2026-08-16T15:00:00.000Z");
  assert.equal(usageSince("30d", now).since.toISOString(), "2026-07-24T15:00:00.000Z");
  assert.equal(usageSince("all", now).since, null);
});

test("a browser-provided boundary wins so today follows the operator's clock", () => {
  const result = usageSince(
    "today",
    new Date("2026-08-22T04:30:00.000Z"),
    "2026-08-21T22:00:00.000Z",
  );
  assert.equal(result.since.toISOString(), "2026-08-21T22:00:00.000Z");
});

test("summary maps events, actors and unspecified games", () => {
  const summary = summarizeUsageRows([
    { _id: { game: "UFL", event: "claimed", actor: "auto-farm" }, count: 12 },
    { _id: { game: "UFL", event: "recycled", actor: "auto-farm" }, count: 3 },
    { _id: { game: "UFL", event: "sold", actor: "auto-farm" }, count: 2 },
    { _id: { game: "", event: "claimed", actor: "bot-deploy" }, count: 4 },
    { _id: { game: "", event: "released", actor: "manual" }, count: 1 },
    { _id: { game: "UFL", event: "rented", actor: "renter-admin" }, count: 1 },
  ]);
  assert.deepEqual(
    { consumed: summary.consumed, returned: summary.returned, net: summary.net },
    { consumed: 16, returned: 6, net: 10 },
  );
  assert.equal(summary.games[0].game, "UFL");
  assert.equal(summary.games[0].farming, 7);
  assert.equal(summary.games[0].rented, 1);
  assert.deepEqual(summary.games[0].byActor, { "auto-farm": 12 });
  assert.equal(summary.games[1].game, "(unspecified)");
  assert.deepEqual(summary.games[1].byActor, { "bot-deploy": 4 });
});

test("still farming is clamped at zero", () => {
  const summary = summarizeUsageRows([
    { _id: { game: "Game", event: "claimed", actor: "auto-farm" }, count: 1 },
    { _id: { game: "Game", event: "recycled", actor: "auto-farm" }, count: 3 },
  ]);
  assert.equal(summary.games[0].farming, 0);
});
