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

// writeMeta's directory (the tests at the bottom) is fixed when botHosts loads.
const metaDir = fs.mkdtempSync(path.join(os.tmpdir(), "bothosts-meta-"));
process.env.TWITCHBOT_SNAPSHOT_DIR = metaDir;
const hosts = require("../utils/botHosts");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bothosts-observer-"));
fs.writeFileSync(path.join(dir, "botctl"), '#!/bin/sh\necho "botctl $*"\n');
const HOST = { id: "t1", label: "test", transport: "local", runtime: "native", dir };

const seen = [];
hosts.onContainerStart((info) => seen.push(info));

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(metaDir, { recursive: true, force: true });
});
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

// writeMeta holds botWaker's park registry (parked-bots.json). A plain
// writeFile truncated it in place, so a reader in between saw "" or half the
// JSON — "nothing is parked" to farm2's execute step and to the next park
// (2026-10-03).
const fsp = require("fs/promises");
const tmpLeft = () => fs.readdirSync(metaDir).filter((f) => f.includes(".tmp-"));

test("writeMeta stages the new text beside the file and renames it over — never truncates in place", async () => {
  const file = path.join(metaDir, "parked-bots.json");
  fs.writeFileSync(file, '{"old":1}');
  const realRename = fsp.rename;
  const renames = [];
  fsp.rename = async (from, to) => {
    renames.push({ from, to, live: fs.readFileSync(to, "utf8"), staged: fs.readFileSync(from, "utf8") });
    return realRename.call(fsp, from, to);
  };
  try {
    await hosts.writeMeta("parked-bots.json", '{"new":2}');
  } finally {
    fsp.rename = realRename;
  }
  assert.equal(renames.length, 1, "written through a rename");
  assert.equal(renames[0].to, file);
  assert.equal(path.dirname(renames[0].from), metaDir, "staged on the same filesystem");
  assert.equal(renames[0].live, '{"old":1}', "the live file was untouched until the rename");
  assert.equal(renames[0].staged, '{"new":2}');
  assert.equal(fs.readFileSync(file, "utf8"), '{"new":2}');
  assert.deepEqual(tmpLeft(), []);
});

test("a failed writeMeta keeps the old file and removes its temp file", async () => {
  const file = path.join(metaDir, "bot-version.json");
  fs.writeFileSync(file, '{"v":1}');
  const realRename = fsp.rename;
  fsp.rename = async () => {
    throw Object.assign(new Error("EIO: simulated"), { code: "EIO" });
  };
  try {
    await assert.rejects(hosts.writeMeta("bot-version.json", '{"v":2}'), /EIO/);
  } finally {
    fsp.rename = realRename;
  }
  assert.equal(fs.readFileSync(file, "utf8"), '{"v":1}');
  assert.deepEqual(tmpLeft(), []);
});

test("concurrent writeMeta calls each land whole (no shared temp file)", async () => {
  const bodies = Array.from({ length: 20 }, (_, i) => JSON.stringify({ i, pad: "x".repeat(4000) }));
  await Promise.all(bodies.map((b) => hosts.writeMeta("moves.json", b)));
  const final = fs.readFileSync(path.join(metaDir, "moves.json"), "utf8");
  assert.ok(bodies.includes(final), "the file is exactly one of the writes");
  assert.deepEqual(tmpLeft(), []);
});
