// The scanner used to sweep every game it had ever seen on one flat 12h clock,
// so a campaign ending tomorrow was no fresher than a game with no campaign
// since last year — and the sweep got slower as the archive grew. It now wakes
// hourly and scans what is due for its own priority. These lock the priority
// ordering and the counter-differencing that history makes possible.
const test = require("node:test");
const assert = require("node:assert");

const { freshnessFor, velocityPerWeek } = require("../utils/marketResearch");

const HOURS = 3600000;
const hoursFromNow = (h) => new Date(Date.now() + h * HOURS);

// ------------------------------------------------------------- freshness

test("a campaign about to end is the most urgent thing there is", () => {
  const soon = freshnessFor({ active: true, endAt: hoursFromNow(10) }, 50);
  const running = freshnessFor({ active: true, endAt: hoursFromNow(300) }, 50);
  assert.ok(soon < running, "ending-soon must be rescanned more often");
  assert.equal(soon, 3 * HOURS);
});

test("priority runs urgent -> active -> upcoming -> seller -> idle", () => {
  const order = [
    freshnessFor({ active: true, endAt: hoursFromNow(10) }, 50),
    freshnessFor({ active: true, endAt: hoursFromNow(300) }, 50),
    freshnessFor({ upcoming: true }, 50),
    freshnessFor({}, 50), // no campaign but sells
    freshnessFor({}, 0), // no campaign, no demand
  ];
  for (let i = 1; i < order.length; i++) {
    assert.ok(
      order[i] > order[i - 1],
      "step " + i + " should be less frequent: " + order.join(","),
    );
  }
});

test("a game that sells is watched more closely than a dead one", () => {
  assert.ok(freshnessFor({}, 40) < freshnessFor({}, 2));
});

test("an active campaign with no end date is still treated as active", () => {
  // endAt is nullable on the campaign catalog; a missing date must not make
  // the game look idle.
  assert.equal(freshnessFor({ active: true, endAt: null }, 0), 6 * HOURS);
});

test("an already-ended campaign does not count as ending soon", () => {
  // hoursLeft goes negative once the campaign is over. Treating that as "under
  // 48h" would pin dead campaigns to the 3h lane forever.
  const ended = freshnessFor({ active: true, endAt: hoursFromNow(-20) }, 50);
  assert.equal(ended, 6 * HOURS);
});

// -------------------------------------------------------------- velocity

test("a rising lifetime counter becomes units per week", () => {
  // GGSel and Plati never date a sale — they only report a running total. The
  // difference across two scans is the only recent rate obtainable from them.
  assert.equal(velocityPerWeek(114, 100, 7), 14);
  assert.equal(velocityPerWeek(110, 100, 14), 5);
});

test("a counter that went backwards reports nothing, not negative demand", () => {
  // Happens when a competitor delists or the market reindexes. It is missing
  // information, and must never subtract from the game's score.
  assert.equal(velocityPerWeek(90, 100, 7), null);
});

test("an unusable window reports nothing", () => {
  assert.equal(velocityPerWeek(120, 100, 0), null);
  assert.equal(velocityPerWeek(120, 100, -3), null);
});

test("no movement is zero sales, which is real information", () => {
  // Distinct from null: we looked, and nothing sold.
  assert.equal(velocityPerWeek(100, 100, 7), 0);
});
