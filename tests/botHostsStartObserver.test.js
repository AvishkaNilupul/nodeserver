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

test("a restart flagged notAStart (a reload of a running container) is not reported", async () => {
  await hosts.dockerContainer(HOST, "restart", "twitchbotx9", { notAStart: true });
  assert.deepEqual(seen, []);
  await hosts.dockerContainer(HOST, "restart", "twitchbotx9");
  assert.equal(seen.length, 1, "an ordinary restart still is");
});

// The park/restart lock (2026-10-03): one "should this container run?" change
// at a time per container, in order; another container never waits; a failed
// step never wedges the next.
test("withContainerLock serialises one container's steps and never wedges", async () => {
  const order = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const a = hosts.withContainerLock(HOST, "twitchbotx9", async () => {
    order.push("a start");
    await gate;
    order.push("a end");
  });
  const b = hosts.withContainerLock(HOST, "twitchbotx9", async () => {
    order.push("b");
    throw new Error("b failed");
  });
  const c = hosts.withContainerLock(HOST, "twitchbotx9", async () => {
    order.push("c");
    return "c ok";
  });
  await hosts.withContainerLock(HOST, "twitchbotx10", async () => order.push("other"));
  assert.deepEqual(order, ["a start", "other"], "b and c wait for a; x10 does not");
  release();
  await a;
  await assert.rejects(b, /b failed/);
  assert.equal(await c, "c ok");
  assert.deepEqual(order, ["a start", "other", "a end", "b", "c"]);
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

// stopIfNoAccounts reports what it found (round-2 review, 2026-10-03): a
// failed `docker ps` read as "not running" let the suspended-account and
// dead-token sweeps restart an emptied bot. Real function, local host, a fake
// `docker` on PATH.
test("stopIfNoAccounts reports { stopped, empty, state }; a failed docker ps is never 'not running'", async () => {
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), "bothosts-empty-"));
  const log = path.join(sdir, "docker.log");
  fs.writeFileSync(
    path.join(sdir, "docker"),
    [
      "#!/bin/sh",
      'echo "$*" >> "$FAKE_DOCKER_LOG"',
      'case "$1:$FAKE_PS" in',
      '  ps:fail) echo "Cannot connect to the Docker daemon" >&2; exit 1;;',
      '  ps:*) printf "twitchbotx19\\t%s\\tUp 1 hour\\n" "$FAKE_PS";;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const cfg = (users) => JSON.stringify({ TwitchSettings: { TwitchUsers: users } });
  fs.writeFileSync(path.join(sdir, "config_19.json"), cfg([]));
  fs.writeFileSync(path.join(sdir, "config_20.json"), cfg([{ Login: "a", Enabled: false }]));
  fs.writeFileSync(path.join(sdir, "config_21.json"), cfg([{ Login: "a", Enabled: false }, { Login: "b" }]));
  const DH = { id: "t-empty", transport: "local", runtime: "docker", dir: sdir };
  const saved = { PATH: process.env.PATH, FAKE_DOCKER_LOG: process.env.FAKE_DOCKER_LOG, FAKE_PS: process.env.FAKE_PS };
  process.env.PATH = sdir + path.delimiter + process.env.PATH;
  process.env.FAKE_DOCKER_LOG = log;
  const run = async (file, ps) => {
    fs.writeFileSync(log, "");
    process.env.FAKE_PS = ps;
    const r = await hosts.stopIfNoAccounts(DH, file, "twitchbotx19");
    return { r, calls: fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(" ")[0]) };
  };
  try {
    let x = await run("config_19.json", "fail");
    assert.deepEqual(x.r, { stopped: false, empty: true, state: "unknown" }, "no accounts, docker ps failed");
    x = await run("config_19.json", "exited");
    assert.deepEqual(x.r, { stopped: false, empty: true, state: "exited" });
    x = await run("config_19.json", "running");
    assert.deepEqual(x.r, { stopped: true, empty: true, state: "running" });
    assert.deepEqual(x.calls, ["ps", "update", "stop"], "policy no, then the stop");
    x = await run("config_20.json", "running");
    assert.deepEqual(x.r, { stopped: false, empty: true, state: null }, "only disabled accounts: empty, not stopped");
    assert.deepEqual(x.calls, [], "no docker call for a config with accounts");
    x = await run("config_21.json", "running");
    assert.deepEqual(x.r, { stopped: false, empty: false, state: null });
    x = await run("config_99.json", "running");
    assert.deepEqual(x.r, { stopped: false, empty: null, state: null }, "unreadable config: emptiness unknown");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(sdir, { recursive: true, force: true });
  }
});
