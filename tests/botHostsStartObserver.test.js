// utils/botHosts start observers: every start/restart/compose-up made through
// this module is reported with the code path that asked for it — the record
// that was missing while the drop scanner's `docker restart` kept waking parked
// bots (2026-09, see tests/farmControl.test.js).
//
// Runs the real dockerContainer/composeUp end to end against a "native" local
// host, whose docker verbs go to a `botctl` shell script — here a fake one in a
// temp dir that just echoes, so no docker is needed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const hosts = require("../utils/botHosts");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bothosts-observer-"));
fs.writeFileSync(path.join(dir, "botctl"), '#!/bin/sh\necho "botctl $*"\n');
const HOST = { id: "t1", label: "test", transport: "local", runtime: "native", dir };

const seen = [];
hosts.onContainerStart((info) => seen.push(info));

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
test.beforeEach(() => {
  seen.length = 0;
});

async function restartForAReason() {
  return hosts.dockerContainer(HOST, "restart", "twitchbotx9");
}

test("a restart is reported with the function that asked for it", async () => {
  const out = await restartForAReason();
  assert.equal(out, "botctl restart twitchbotx9", "the verb itself is unchanged");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].hostId, "t1");
  assert.equal(seen[0].action, "restart");
  assert.equal(seen[0].container, "twitchbotx9");
  assert.match(
    seen[0].caller,
    /^restartForAReason \(tests\/botHostsStartObserver\.test\.js:\d+\)/,
  );
});

test("start and compose up report; stop and rm do not", async () => {
  await hosts.dockerContainer(HOST, "start", "twitchbotx9");
  await hosts.composeUp(HOST, "twitchbotx9");
  await hosts.dockerContainer(HOST, "stop", "twitchbotx9");
  await hosts.dockerContainer(HOST, "rm", "twitchbotx9");
  assert.deepEqual(
    seen.map((s) => s.action),
    ["start", "compose up"],
  );
});

test("a failed verb reports nothing", async () => {
  const bad = { ...HOST, dir: path.join(dir, "missing") };
  await assert.rejects(hosts.dockerContainer(bad, "restart", "twitchbotx9"));
  assert.equal(seen.length, 0);
});

test("a throwing observer never breaks the docker operation", async () => {
  hosts.onContainerStart(() => {
    throw new Error("observer bug");
  });
  const out = await hosts.dockerContainer(HOST, "restart", "twitchbotx9");
  assert.equal(out, "botctl restart twitchbotx9");
  assert.equal(seen.length, 1, "the other observers still ran");
});

test("callerFrames skips botHosts and node internals, keeps two app frames", () => {
  const app = path.resolve(__dirname, "..");
  const stack = [
    "Error",
    "    at dockerContainer (" + require.resolve("../utils/botHosts") + ":733:5)",
    "    at restartIfRunning (" + path.join(app, "utils/farmControl.js") + ":57:15)",
    "    at async stopFarmingGame (" + path.join(app, "utils/farmControl.js") + ":138:17)",
    "    at async scanOne (" + path.join(app, "utils/dropScanner.js") + ":599:19)",
    "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
  ].join("\n");
  assert.equal(
    hosts.callerFrames(stack),
    "restartIfRunning (utils/farmControl.js:57) < stopFarmingGame (utils/farmControl.js:138)",
  );
  assert.equal(
    hosts.callerFrames("Error\n    at " + path.join(app, "server.js") + ":12:3", 2),
    "(server.js:12)",
    "an anonymous frame keeps its location",
  );
  assert.equal(hosts.callerFrames("Error\n    at node:internal/x:1:1"), "");
  assert.equal(hosts.callerFrames(undefined), "");
});
