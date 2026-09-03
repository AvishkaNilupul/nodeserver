// Coverage for the ownership boundary (utils/farm2/ownership.js).
//
// This is the file that decides which engine farms a game, and it is consulted
// from utils/autoFarmer.js's hot per-campaign loop. Its contract is asymmetric
// on purpose:
//
//   reporting "not owned" when farm2 could have run it -> the legacy engine
//     handles the game exactly as it does today. Nothing is lost.
//   reporting "owned" when farm2 is NOT running it     -> BOTH engines skip the
//     game. Campaigns go unfarmed and live tasks are never listed. Silent, and
//     it costs real money.
//
// So every uncertainty must resolve to NOT OWNED. These tests pin that
// direction for each way the lookup can be uncertain.
const test = require("node:test");
const assert = require("node:assert");

const ownership = require("../utils/farm2/ownership");
const settings = require("../utils/settings");

// Drive the master switch without writing settings.json, which is real operator
// state on a live host and must not be mutated by a test run.
function withKillSwitch(on, fn) {
  const orig = settings.getAutoFarm;
  settings.getAutoFarm = () => ({ ...orig.call(settings), farm2Enabled: on });
  try {
    return fn();
  } finally {
    settings.getAutoFarm = orig;
  }
}

test("owns nothing while the engine is not running", () => {
  ownership.setEngineRunning(false);
  withKillSwitch(true, () => {
    assert.strictEqual(ownership.isOwned("Albion Online"), false);
  });
});

test("owns nothing while the master switch is off", () => {
  ownership.setEngineRunning(true);
  withKillSwitch(false, () => {
    assert.strictEqual(ownership.isOwned("Albion Online"), false);
  });
  ownership.setEngineRunning(false);
});

test("a cold cache answers 'not owned' rather than guessing", () => {
  ownership.setEngineRunning(true);
  ownership.invalidate();
  withKillSwitch(true, () => {
    // No DB is connected in a unit-test run, so the background refresh cannot
    // populate the cache. The answer must still be the safe one.
    assert.strictEqual(ownership.isOwned("Albion Online"), false);
  });
  ownership.setEngineRunning(false);
});

test("an empty or unknown game name is never owned", () => {
  ownership.setEngineRunning(true);
  withKillSwitch(true, () => {
    assert.strictEqual(ownership.isOwned(""), false);
    assert.strictEqual(ownership.isOwned(null), false);
    assert.strictEqual(ownership.isOwned(undefined), false);
  });
  ownership.setEngineRunning(false);
});

test("stopping the engine immediately drops ownership", () => {
  ownership.setEngineRunning(true);
  ownership.setEngineRunning(false);
  withKillSwitch(true, () => {
    assert.strictEqual(ownership.isOwned("Albion Online"), false);
  });
});

test("game keys normalise so spacing and case cannot split a lane", () => {
  assert.strictEqual(ownership.normKey("Albion  Online"), ownership.normKey("albion online"));
  assert.strictEqual(ownership.normKey("World of Tanks"), ownership.normKey("WORLD OF TANKS"));
  assert.notStrictEqual(ownership.normKey("Albion Online"), ownership.normKey("Black Desert"));
});

test("isOwned never throws, whatever it is handed", () => {
  ownership.setEngineRunning(true);
  withKillSwitch(true, () => {
    for (const bad of [{}, [], 42, () => {}, Symbol("x")]) {
      assert.doesNotThrow(() => ownership.isOwned(bad));
    }
  });
  ownership.setEngineRunning(false);
});
