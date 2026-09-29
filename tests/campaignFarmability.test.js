// Which campaigns can a farm account earn by watching? A subscription-only drop
// (requiredSubs > 0) never can; missing evidence must always read as farmable
// so a gap can only keep a bot up. See utils/campaignFarmability.js.
const test = require("node:test");
const assert = require("node:assert");

const {
  WATCH_VERSION,
  isWatchableDrop,
  manifestFarmable,
} = require("../utils/campaignFarmability");

const sub = { requiredSubs: 1, requiredMinutesWatched: 0 };
const watch = { requiredSubs: 0, requiredMinutesWatched: 60 };

test("a subscription-only drop is not watchable; a watch-time drop is", () => {
  assert.strictEqual(isWatchableDrop(sub), false);
  assert.strictEqual(isWatchableDrop(watch), true);
  assert.strictEqual(isWatchableDrop({}), true); // unknown -> watchable
});

test("no manifest yet counts as farmable (fail toward farming)", () => {
  assert.strictEqual(manifestFarmable(undefined), true);
  assert.strictEqual(manifestFarmable(null), true);
});

test("a manifest saved before requiredSubs was recorded counts as farmable", () => {
  // e.g. "RL Worlds Sub Drops" fetched by the old query: no watchVersion.
  assert.strictEqual(manifestFarmable({ drops: [{ name: "Torque TX" }] }), true);
  assert.strictEqual(manifestFarmable({ watchVersion: 0, drops: [sub] }), true);
});

test("every drop subscription-only -> not farmable (RL Worlds Sub Drops)", () => {
  assert.strictEqual(
    manifestFarmable({ watchVersion: WATCH_VERSION, drops: [sub] }),
    false,
  );
});

test("any watchable drop makes the campaign farmable", () => {
  assert.strictEqual(
    manifestFarmable({ watchVersion: WATCH_VERSION, drops: [sub, watch] }),
    true,
  );
});

test("a recorded manifest with no time-based drops is not farmable", () => {
  // The bot farms time-based drops only ("No time based drops available").
  assert.strictEqual(
    manifestFarmable({ watchVersion: WATCH_VERSION, drops: [] }),
    false,
  );
});
