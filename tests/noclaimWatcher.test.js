// Pure-function coverage for the no-claim auto-power watcher's two decisions —
// no docker, no Mongo, no network:
//   1. decideActions — start only a bot the watcher itself parked, stop only a
//      running bot on a confidently-dark game; never fight manual control.
//   2. resolveWithHysteresis — a stop is withheld until a game has been dark for
//      the full hysteresis window; going live clears the anchor immediately.
// See utils/noclaimWatcher.js.
const test = require("node:test");
const assert = require("node:assert");

const {
  decideActions,
  resolveWithHysteresis,
  _state,
} = require("../utils/noclaimWatcher");

const MIN = 60 * 1000;

test("decideActions: resumes a watcher-parked bot when its game is live", () => {
  const bots = [
    { id: "1", game: "Overwatch", running: false, autostopped: true, operatorOff: false },
    { id: "2", game: "Overwatch", running: true, autostopped: false, operatorOff: false },
  ];
  const verdict = { overwatch: { live: true, canStop: false } };
  const { starts, stops } = decideActions(bots, verdict);
  assert.deepStrictEqual(starts, ["1"]); // parked + game live -> resume
  assert.deepStrictEqual(stops, []); // running + live -> leave
});

test("decideActions: cold-starts a never-touched stopped bot when live", () => {
  // No markers (fresh / crashed / rebooted) -> start it when the game is live.
  const bots = [{ id: "9", game: "Overwatch", running: false, autostopped: false, operatorOff: false }];
  const verdict = { overwatch: { live: true, canStop: false } };
  assert.deepStrictEqual(decideActions(bots, verdict).starts, ["9"]);
});

test("decideActions: an uncertain verdict never cold-starts a stopped bot", () => {
  // No active campaign + an unverifiable catalog (e.g. the boot window before
  // campaignWatcher's first pass) => uncertain, not live. A stopped bot stays
  // stopped so a restart can't wake the fleet for a non-existent campaign.
  const bots = [
    { id: "1", game: "Overwatch", running: false, autostopped: true, operatorOff: false },
    { id: "9", game: "Overwatch", running: false, autostopped: false, operatorOff: false },
  ];
  const verdict = { overwatch: { live: true, uncertain: true, canStop: false } };
  const { starts, stops } = decideActions(bots, verdict);
  assert.deepStrictEqual(starts, []); // uncertain -> do NOT wake parked bots
  assert.deepStrictEqual(stops, []);
});

test("decideActions: an uncertain verdict keeps a running bot up (fail toward farming)", () => {
  const bots = [{ id: "2", game: "Overwatch", running: true, autostopped: false, operatorOff: false }];
  // uncertain resolves with canStop:false (never park a running bot when unsure).
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
    { id: "4", game: "Rainbow Six Siege", running: true, autostopped: false },
    { id: "5", game: "Rainbow Six Siege", running: true, autostopped: false },
  ];
  // Dark but still inside the hysteresis grace => no stop.
  assert.deepStrictEqual(
    decideActions(bots, { "rainbow six": { live: false, canStop: false } }).stops,
    [],
  );
  // Dark long enough => stop both.
  assert.deepStrictEqual(
    decideActions(bots, { "rainbow six": { live: false, canStop: true } }).stops,
    ["4", "5"],
  );
});

test("decideActions: leaves games it does not manage untouched", () => {
  const bots = [{ id: "6", game: "Genshin Impact", running: true, autostopped: false }];
  const verdict = { overwatch: { live: false, canStop: true } };
  const { starts, stops } = decideActions(bots, verdict);
  assert.deepStrictEqual(starts, []);
  assert.deepStrictEqual(stops, []);
});

test("decideActions: an already-stopped dark bot is a no-op (not double-stopped)", () => {
  const bots = [{ id: "7", game: "Overwatch", running: false, autostopped: true }];
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
  // First dark pass: anchor set, not yet stoppable.
  let out = resolveWithHysteresis({ overwatch: { live: false } }, t0);
  assert.strictEqual(out.overwatch.canStop, false);
  assert.strictEqual(_state.darkSince.overwatch, t0);
  // 5 min later: still in grace.
  out = resolveWithHysteresis({ overwatch: { live: false } }, t0 + 5 * MIN);
  assert.strictEqual(out.overwatch.canStop, false);
  // 21 min later: past the 20-min window -> stoppable.
  out = resolveWithHysteresis({ overwatch: { live: false } }, t0 + 21 * MIN);
  assert.strictEqual(out.overwatch.canStop, true);
});

test("resolveWithHysteresis: forgets anchors for games no longer managed", () => {
  _state.darkSince = { overwatch: Date.now(), "old game": Date.now() };
  resolveWithHysteresis({ overwatch: { live: false } }, Date.now());
  assert.ok("overwatch" in _state.darkSince);
  assert.strictEqual(_state.darkSince["old game"], undefined);
});
