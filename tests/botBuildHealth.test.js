// Coverage for the two silent failures that stopped rent/auto farming for days
// in 2026-09: bots left on a stale image (it watches, but Twitch never credits
// the minutes) and a bot host whose disk hit 100%. Both look like "the bot is
// up, it just isn't farming", so the health monitor now names them outright,
// and the updater's sanity test refuses a build that shows either sign.
//
// Telegram and the SystemEvent log are stubbed through require.cache so the
// orchestration runs with no network and no Mongo; the host layer is stubbed
// per test by swapping methods on the shared botHosts module object.
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

const sent = [];
const events = [];
stubModule("telegram", {
  sendTelegram: async (msg) => {
    sent.push(msg);
  },
});
stubModule("systemLog", {
  logEvent: (e) => {
    events.push(e);
  },
});

const hosts = require("../utils/botHosts");
const mon = require("../utils/botHealthMonitor");
const updater = require("../utils/botUpdater");

const HOUR = 60 * 60 * 1000;
const realRunShell = hosts.runShell;
const realHostStats = hosts.hostStats;

function reset() {
  sent.length = 0;
  events.length = 0;
  hosts.runShell = realRunShell;
  hosts.hostStats = realHostStats;
}

function host(id) {
  return { id, label: id.toUpperCase(), dir: "/home/ubuntu/twitchbot", runtime: "docker" };
}

function inspectOut(expectedId, rows) {
  return (
    "EXPECTED " +
    (expectedId || "") +
    "\n" +
    rows.map((r) => "/" + r.join("|")).join("\n") +
    "\n"
  );
}

// --- pure helpers ---------------------------------------------------------

test("the old build's progress line is recognised, the current one is not", () => {
  assert.ok(mon.isOldBuildLog("[TwitchUser - abc] Progress: 2/60 minutes"));
  assert.ok(!mon.isOldBuildLog("[TwitchUser - abc] Waiting 60 seconds... 12/60 minutes watched."));
  assert.ok(!mon.isOldBuildLog(""));
  assert.ok(!mon.isOldBuildLog(undefined));
});

test("only compose farm bots count, not no-claim bots or the updater's testrun", () => {
  assert.ok(mon.isFarmBot("twitchbot"));
  assert.ok(mon.isFarmBot("twitchbotx2"));
  assert.ok(mon.isFarmBot("twitchbotx36"));
  assert.ok(!mon.isFarmBot("noclaim-bot-5"));
  assert.ok(!mon.isFarmBot("twitchbot-testrun"));
  assert.ok(!mon.isFarmBot("twitchbotx"));
});

test("docker inspect rows parse, dropping the leading slash and junk lines", () => {
  const rows = mon.parseBotImages(
    "/twitchbotx2|sha256:aa|running\n\n  \ngarbage\n/twitchbotx3|sha256:bb|exited\n",
  );
  assert.deepStrictEqual(rows, [
    { name: "twitchbotx2", imageId: "sha256:aa", status: "running" },
    { name: "twitchbotx3", imageId: "sha256:bb", status: "exited" },
  ]);
});

test("stale builds are farm bots on a different image id, sorted numerically", () => {
  const rows = mon.parseBotImages(
    [
      "/twitchbotx10|sha256:old|exited",
      "/twitchbotx2|sha256:new|running",
      "/twitchbotx9|sha256:old|running",
      "/noclaim-bot-4|sha256:old|running",
      "/twitchbot-testrun|sha256:old|running",
    ].join("\n"),
  );
  assert.deepStrictEqual(mon.staleBuilds(rows, "sha256:new"), [
    { name: "twitchbotx9", running: true },
    { name: "twitchbotx10", running: false },
  ]);
});

test("an unknown expected image never reports every bot as stale", () => {
  const rows = mon.parseBotImages("/twitchbotx2|sha256:x|running");
  assert.deepStrictEqual(mon.staleBuilds(rows, ""), []);
});

test("disk percentage is rounded to one decimal and null without numbers", () => {
  assert.strictEqual(mon.diskPct({ diskTotal: 1000, diskUsed: 863 }), 86.3);
  assert.strictEqual(mon.diskPct({ diskTotal: 0, diskUsed: 5 }), null);
  assert.strictEqual(mon.diskPct({ diskTotal: 100, diskUsed: null }), null);
  assert.strictEqual(mon.diskPct(null), null);
});

// --- stale-build scan -----------------------------------------------------

test("a stale bot alerts once, stays quiet, then reminds after the cooldown", async () => {
  reset();
  const h = host("b1");
  hosts.runShell = async () => ({
    stdout: inspectOut("sha256:new", [
      ["twitchbotx2", "sha256:new", "running"],
      ["twitchbotx3", "sha256:old", "running"],
      ["twitchbotx14", "sha256:old", "exited"],
    ]),
  });
  const t0 = 10 * 24 * HOUR;
  await mon.buildScanHost(h, t0);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /1 RUNNING on an older build: twitchbotx3/);
  assert.match(sent[0], /1 parked on an older build .*twitchbotx14/);
  assert.doesNotMatch(sent[0], /twitchbotx2\b/);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].action, "stale_build");
  assert.strictEqual(events[0].severity, "error");
  assert.strictEqual(events[0].host, "b1");

  await mon.buildScanHost(h, t0 + HOUR);
  assert.strictEqual(sent.length, 1, "same stale set inside the cooldown stays quiet");

  await mon.buildScanHost(h, t0 + 7 * HOUR);
  assert.strictEqual(sent.length, 2, "reminds once the cooldown has passed");
});

test("a change in the stale set re-alerts at once; a clean host sends the all-clear", async () => {
  reset();
  const h = host("b2");
  let rows = [
    ["twitchbotx3", "sha256:old", "running"],
    ["twitchbotx4", "sha256:old", "exited"],
  ];
  hosts.runShell = async () => ({ stdout: inspectOut("sha256:new", rows) });
  const t0 = 20 * 24 * HOUR;
  await mon.buildScanHost(h, t0);
  assert.strictEqual(sent.length, 1);

  rows = [
    ["twitchbotx3", "sha256:new", "running"],
    ["twitchbotx4", "sha256:old", "exited"],
  ];
  await mon.buildScanHost(h, t0 + 60 * 1000);
  assert.strictEqual(sent.length, 2);
  assert.match(sent[1], /parked on an older build .*twitchbotx4/);
  assert.doesNotMatch(sent[1], /RUNNING/);
  assert.strictEqual(events[1].severity, "warn", "parked-only is a warning");

  rows = [
    ["twitchbotx3", "sha256:new", "running"],
    ["twitchbotx4", "sha256:new", "exited"],
  ];
  await mon.buildScanHost(h, t0 + 2 * 60 * 1000);
  assert.strictEqual(sent.length, 3);
  assert.match(sent[2], /^✅ B2: every farm bot is on the current/);

  await mon.buildScanHost(h, t0 + 3 * 60 * 1000);
  assert.strictEqual(sent.length, 3, "no repeated all-clear");
});

test("a host with farm bots but no farm image is flagged as missing, not as all-stale", async () => {
  reset();
  const h = host("b3");
  hosts.runShell = async () => ({
    stdout: inspectOut("", [["twitchbotx2", "sha256:any", "running"]]),
  });
  await mon.buildScanHost(h, 30 * 24 * HOUR);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /no local twitchbot-farm:latest image/);
  assert.doesNotMatch(sent[0], /older build/);
  assert.strictEqual(events[0].severity, "error");
});

test("the shared image id is the one every farm bot runs, else empty", () => {
  const rows = mon.parseBotImages(
    [
      "/twitchbotx3|sha256:aa|running",
      "/twitchbotx7|sha256:aa|created",
      "/noclaim-bot-4|sha256:zz|running",
    ].join("\n"),
  );
  assert.strictEqual(mon.sharedImageId(rows), "sha256:aa", "no-claim bots don't count");
  rows.push({ name: "twitchbotx8", imageId: "sha256:bb", status: "running" });
  assert.strictEqual(mon.sharedImageId(rows), "");
  assert.strictEqual(mon.sharedImageId([]), "");
  assert.strictEqual(
    mon.shortImageId("sha256:fdd990dd54f1bb71956365baf97ec0c9621488c08451d5d9df0118bf80b45e82"),
    "fdd990dd54f1",
  );
});

test("a farm tag removed by hand names the one-line re-tag, not a rebuild", async () => {
  reset();
  const h = host("m1");
  const id = "sha256:fdd990dd54f1bb71956365baf97ec0c9621488c08451d5d9df0118bf80b45e82";
  let expected = id;
  const rows = [
    ["twitchbotx3", id, "running"],
    ["twitchbotx7", id, "created"],
  ];
  hosts.runShell = async () => ({ stdout: inspectOut(expected, rows) });
  const t0 = 50 * 24 * HOUR;
  await mon.buildScanHost(h, t0);
  assert.strictEqual(sent.length, 0, "healthy host");

  expected = ""; // `docker rmi twitchbot-farm:latest` — the image stays, held by the bots
  await mon.buildScanHost(h, t0 + HOUR);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /tag is gone, but all 2 farm bots here still run fdd990dd54f1/);
  assert.match(sent[0], /pointed at before it disappeared/);
  assert.match(sent[0], /Fix, no restart needed: docker tag fdd990dd54f1 twitchbot-farm:latest$/);
  assert.doesNotMatch(sent[0], /force-recreate|rollout/);
  assert.strictEqual(events[0].severity, "error");

  await mon.buildScanHost(h, t0 + 7 * HOUR + HOUR);
  assert.strictEqual(sent.length, 2, "the reminder still carries the proof");
  assert.match(sent[1], /docker tag fdd990dd54f1 twitchbot-farm:latest$/);

  expected = id; // re-tagged
  await mon.buildScanHost(h, t0 + 9 * HOUR);
  assert.match(sent[2], /^✅ M1: every farm bot is on the current/);
});

test("with no history here, another host's farm tag on the same id is the proof", async () => {
  reset();
  const id = "sha256:0123456789abcdef";
  hosts.runShell = async () => ({ stdout: inspectOut(id, [["twitchbotx2", id, "running"]]) });
  await mon.buildScanHost(host("m2peer"), 51 * 24 * HOUR);
  hosts.runShell = async () => ({ stdout: inspectOut("", [["twitchbotx5", id, "running"]]) });
  await mon.buildScanHost(host("m2"), 51 * 24 * HOUR);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /same build as twitchbot-farm:latest on M2PEER/);
  assert.match(sent[0], /docker tag 0123456789ab twitchbot-farm:latest$/);
});

test("an image with no proof of being a farm build is never offered for a re-tag", async () => {
  reset();
  // One image, but nothing says it is a farm build (a stale Docker Hub pull
  // looks exactly like this) — and bots split across two images.
  for (const [hostId, rows] of [
    ["m3", [["twitchbotx2", "sha256:unproven", "running"]]],
    ["m4", [["twitchbotx2", "sha256:a1", "running"], ["twitchbotx3", "sha256:b2", "exited"]]],
  ]) {
    hosts.runShell = async () => ({ stdout: inspectOut("", rows) });
    await mon.buildScanHost(host(hostId), 52 * 24 * HOUR);
  }
  assert.strictEqual(sent.length, 2);
  for (const msg of sent) {
    assert.match(msg, /no local twitchbot-farm:latest image/);
    assert.match(msg, /Fix: build it with the Bots page rollout/);
    assert.doesNotMatch(msg, /docker tag|force-recreate/);
  }
});

test("a host with no farm bots and no farm image stays quiet", async () => {
  reset();
  const h = host("b4");
  hosts.runShell = async () => ({
    stdout: inspectOut("", [["noclaim-bot-1", "sha256:any", "running"]]),
  });
  await mon.buildScanHost(h, 31 * 24 * HOUR);
  assert.strictEqual(sent.length, 0);
});

test("an unreachable host and a native host are skipped without alerts", async () => {
  reset();
  hosts.runShell = async () => {
    throw new Error("ssh: connect timed out");
  };
  await mon.buildScanHost(host("b5"), 32 * 24 * HOUR);
  assert.strictEqual(sent.length, 0);

  let called = false;
  hosts.runShell = async () => {
    called = true;
    return { stdout: "" };
  };
  await mon.buildScanHost({ ...host("b6"), runtime: "native" }, 32 * 24 * HOUR);
  assert.strictEqual(called, false);
  assert.strictEqual(sent.length, 0);
});

// --- disk check -----------------------------------------------------------

test("a filling disk alerts at the threshold, stays quiet, and clears on recovery", async () => {
  reset();
  const h = host("d1");
  let used = 90;
  hosts.hostStats = async () => ({ diskTotal: 100, diskUsed: used });
  const t0 = 40 * 24 * HOUR;
  await mon.diskCheckHost(h, t0);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /D1 disk is 90% full/);
  assert.strictEqual(events[0].action, "disk_full");
  assert.strictEqual(events[0].severity, "warn");

  used = 96;
  await mon.diskCheckHost(h, t0 + HOUR);
  assert.strictEqual(sent.length, 1, "still inside the reminder cooldown");

  used = 40;
  await mon.diskCheckHost(h, t0 + 2 * HOUR);
  assert.strictEqual(sent.length, 2);
  assert.match(sent[1], /^✅ D1 disk is back to 40% used/);

  await mon.diskCheckHost(h, t0 + 3 * HOUR);
  assert.strictEqual(sent.length, 2, "healthy disk stays quiet");
});

test("a near-full disk is an error, and a stats failure is not a disk signal", async () => {
  reset();
  hosts.hostStats = async () => ({ diskTotal: 100, diskUsed: 99 });
  await mon.diskCheckHost(host("d2"), 41 * 24 * HOUR);
  assert.strictEqual(events[0].severity, "error");

  reset();
  hosts.hostStats = async () => {
    throw new Error("timeout");
  };
  await mon.diskCheckHost(host("d3"), 41 * 24 * HOUR);
  hosts.hostStats = async () => ({ diskTotal: null, diskUsed: null });
  await mon.diskCheckHost(host("d4"), 41 * 24 * HOUR);
  assert.strictEqual(sent.length, 0);
  reset();
});

// --- updater sanity test ---------------------------------------------------

test("the updater's farm image is the local-only name, never the Docker Hub repo", () => {
  assert.strictEqual(updater.IMAGE, "twitchbot-farm");
  assert.doesNotMatch(updater.IMAGE, /\//);
});

test("the updater rejects the old build and a config it cannot find", () => {
  assert.ok(updater.looksUnhealthy("[TwitchUser - abc] Progress: 2/60 minutes"));
  assert.ok(updater.looksUnhealthy("No users found\nWhich platform do you want to use?"));
  assert.ok(!updater.looksHealthy("[TwitchUser - abc] Progress: 2/60 minutes"));
});

test("the updater needs positive evidence of the per-account loop", () => {
  assert.ok(updater.looksHealthy('[TwitchUser - abc] Checking "Overwatch 2"...'));
  assert.ok(updater.looksHealthy("[TwitchUser - abc] Waiting 300 seconds"));
  assert.ok(updater.looksHealthy("[TwitchUser - abc] No broadcaster found"));
  assert.ok(!updater.looksHealthy(""), "a silent start is not healthy");
  assert.ok(!updater.looksHealthy("Starting TwitchDropsBot..."));
});
