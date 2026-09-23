// The capacity report must label a stopped stack the same way snapshot()
// counts it: an EMPTY stopped stack is un-started capacity (counted — the
// first delivery writes accounts and starts it), while a stopped stack that
// already HOLDS accounts is dead (not counted). Before this, the report said
// "these slots do not count" next to slots that were in the total.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const Module = require("node:module");

function stubModule(rel, exports) {
  const file = require.resolve(path.join(__dirname, "..", "utils", rel));
  const m = new Module(file);
  m.filename = file;
  m.loaded = true;
  m.exports = exports;
  require.cache[file] = m;
}
stubModule("telegram", { sendTelegram: async () => {} });
stubModule("systemLog", { logEvent: () => {} });

const { describe } = require("../utils/rentFarmCapacity");

const snap = {
  totalFree: 58,
  deadFree: 10,
  deadStacks: ["contabo/config_03.json"],
  offlineHosts: [],
  readable: 3,
  stacks: [
    { host: "contabo", file: "config_06.json", used: 0, capacity: 50, remaining: 50, running: false },
    { host: "contabo", file: "config_03.json", used: 40, capacity: 50, remaining: 10, running: false },
    { host: "contabo", file: "config_04.json", used: 42, capacity: 50, remaining: 8, running: true },
  ],
};

test("an empty stopped stack reads as un-started and counted", () => {
  const line = describe(snap).split("\n").find((l) => l.includes("config_06.json"));
  assert.match(line, /not started yet/);
  assert.match(line, /counted/);
  assert.doesNotMatch(line, /do not count/);
});

test("a stopped stack that holds accounts still reads as dead", () => {
  const text = describe(snap);
  const line = text.split("\n").find((l) => l.includes("config_03.json"));
  assert.match(line, /STOPPED — these slots do not count/);
  assert.match(text, /10 further slot\(s\) sit on STOPPED stacks/);
});

test("a running stack carries no label", () => {
  const line = describe(snap).split("\n").find((l) => l.includes("config_04.json"));
  assert.strictEqual(line.trim(), "contabo/config_04.json  42/50");
});
