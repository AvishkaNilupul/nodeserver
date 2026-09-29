// The bot's own "nothing left to farm" verdict, shared by the managed-bot park
// (botWaker.stopFinishedBots) and the no-claim watcher. Pure parts only; the
// python classifier itself is exercised in tests/noclaimWatcherFinished.test.js.
const test = require("node:test");
const assert = require("node:assert");

const {
  FINISH_MIN_UPTIME_S,
  parseLogVerdicts,
  isNothingLeft,
} = require("../utils/botLogVerdict");
const { NOTHING_LEFT_REASON } = require("../utils/botWaker");

test("parseLogVerdicts reads one line per container and drops failures", () => {
  const out = parseLogVerdicts(
    ["noise", "LOGV|twitchbotx36|3600|50|50|0|0", "LOGV|twitchbotx42|900|175|100|70|5", "LOGV|twitchbot|4000|ERR|config"].join("\n"),
  );
  assert.deepStrictEqual(out.twitchbotx36, { uptimeS: 3600, enabled: 50, finished: 50, pending: 0, unknown: 0 });
  assert.strictEqual(out.twitchbotx42.pending, 70);
  assert.strictEqual(out.twitchbot, null);
});

test("isNothingLeft needs every enabled account finished, nothing pending or unknown", () => {
  const ok = { uptimeS: FINISH_MIN_UPTIME_S, enabled: 50, finished: 50, pending: 0, unknown: 0 };
  assert.strictEqual(isNothingLeft(ok), true);
  assert.strictEqual(isNothingLeft({ ...ok, finished: 49, unknown: 1 }), false);
  assert.strictEqual(isNothingLeft({ ...ok, finished: 49, pending: 1 }), false);
  assert.strictEqual(isNothingLeft({ ...ok, uptimeS: FINISH_MIN_UPTIME_S - 1 }), false);
  assert.strictEqual(isNothingLeft({ ...ok, enabled: 0, finished: 0 }), false);
  assert.strictEqual(isNothingLeft(null), false);
});

test("a nothing-left park wakes on the next NEW campaign, never on a grace window", () => {
  // wakeFinishedBots gives /manual|idle_no_campaign/ a 48h grace (a campaign
  // that started before the park still wakes it) and /idle_no_stream/ a
  // liveness wake. A nothing-left park must match neither, or it would be woken
  // straight back up by the campaign it just finished.
  assert.ok(!/manual|idle_no_campaign/i.test(NOTHING_LEFT_REASON));
  assert.ok(!/idle_no_stream/i.test(NOTHING_LEFT_REASON));
});
