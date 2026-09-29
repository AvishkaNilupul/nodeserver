// Rolling a new TwitchDropsBot build out to the no-claim fleet
// (noclaimFleet.rolloutImage). The one property that matters most: an image
// that would CLAIM drops must never reach these bots — the sanity test and
// every recreated bot must show the no-claim guard's own log line. Driven
// end to end against a scripted fake host; no SSH, no docker.
const test = require("node:test");
const assert = require("node:assert");

const hosts = require("../utils/botHosts");
const fleet = require("../utils/noclaimFleet");

const GOOD_AND_GUARDED = [
  "2026-09-29 15:30:00.000 +00:00 [INF] [TwitchUser - acc1] Removing 1 finished campaigns...",
  "2026-09-29 15:30:00.100 +00:00 [INF] [TwitchUser - acc1] ClaimDrops is disabled — skipping claim, leaving drops unclaimed for the buyer.",
  '2026-09-29 15:30:00.200 +00:00 [INF] [TwitchUser - acc1] Checking "Overwatch" ("OWCS")...',
].join("\n");
const GOOD_NO_GUARD = [
  "2026-09-29 15:30:00.000 +00:00 [INF] [TwitchUser - acc1] Removing 1 finished campaigns...",
  '2026-09-29 15:30:00.200 +00:00 [INF] [TwitchUser - acc1] Checking "Overwatch" ("OWCS")...',
].join("\n");

test("containerRunArgs is exactly the create path's docker run shape", () => {
  const id = "38";
  const legacy =
    `--name ${hosts.shq("noclaim-bot-38")} --restart unless-stopped --log-opt max-size=10m --log-opt max-file=3 --user 0:0 ` +
    `-e INSIDE_DOCKER=true -v ${hosts.shq(fleet.botDir(id) + "/Configuration")}:/app/Configuration ` +
    `-v ${hosts.shq(fleet.botDir(id) + "/logs")}:/app/logs ${hosts.shq(fleet.IMAGE)}`;
  assert.strictEqual(fleet.containerRunArgs(id), legacy);
});

test("the verdict needs the per-account loop AND the no-claim guard line", () => {
  assert.strictEqual(fleet.rolloutLogVerdict(GOOD_AND_GUARDED), "ok");
  assert.strictEqual(fleet.rolloutLogVerdict(GOOD_NO_GUARD), "pending", "a build that would claim never passes");
  assert.strictEqual(fleet.rolloutLogVerdict(GOOD_AND_GUARDED + "\nUnhandled exception. System.Exception"), "bad");
  assert.strictEqual(fleet.rolloutLogVerdict("No users found"), "bad");
  assert.strictEqual(fleet.rolloutLogVerdict(""), "pending");
});

test("refs are validated and mapped to a docker tag", () => {
  assert.strictEqual(fleet.validRolloutRef("noclaim-test"), true);
  assert.strictEqual(fleet.validRolloutRef("farm-20260929b"), true);
  assert.strictEqual(fleet.validRolloutRef("a/../b"), false);
  assert.strictEqual(fleet.validRolloutRef("x; rm -rf /"), false);
  assert.strictEqual(fleet.rolloutImageTag("feature/x"), "twitchbot-noclaim:feature-x");
});

// ---- orchestration against a scripted host -------------------------------

function fakeHost({ busy = false, testLogs = GOOD_AND_GUARDED, bots, botLogs = {} }) {
  const calls = [];
  const state = { lock: false };
  hosts.resolveHost = (id) => ({ id, label: "Contabo VPS", transport: "ssh", runtime: "docker", dir: "/home/ubuntu/twitchbot" });
  hosts.runShell = async (host, script) => {
    calls.push(script);
    const out = (stdout) => ({ stdout, stderr: "" });
    if (script.includes(".provisioning' ] && echo busy")) return out(busy ? "busy" : "free");
    if (/mkdir -p .* && touch .*\.provisioning/.test(script)) { state.lock = true; return out(""); }
    if (script.includes("docker build -q")) return out("sha256:" + "a".repeat(64));
    if (script.includes("sort -t'|' -k2,2")) {
      const stopped = bots.find((b) => !b.running);
      return out(stopped ? `${stopped.id}|exited` : `${bots[0].id}|running`);
    }
    if (script.includes("docker run -d --name noclaim-rollout-test")) return out("");
    if (script.startsWith("docker logs noclaim-rollout-test")) return out(testLogs);
    if (script.startsWith("docker rm -f noclaim-rollout-test")) return out("");
    if (script.includes("|| true; docker tag")) {
      const m = script.match(/'(twitchbot-noclaim:pre-[^']+)'/);
      return out(m ? m[1] : "");
    }
    if (script.startsWith("docker ps -a --filter name=^/noclaim-bot-")) {
      return out(bots.map((b) => `noclaim-bot-${b.id}|${b.running ? "running" : "exited"}`).join("\n"));
    }
    if (script.includes("] && echo yes || echo no")) return out("yes");
    if (script.includes("docker create ")) return out("");
    if (script.includes("docker stop -t 20")) return out("");
    if (script.startsWith('echo "RUNNING=')) {
      const name = (script.match(/'(noclaim-bot-\d+)'/) || [])[1];
      return out("RUNNING=true\n" + (botLogs[name] != null ? botLogs[name] : GOOD_AND_GUARDED));
    }
    if (script.includes("&& docker rm -f") && script.startsWith("docker tag")) return out("");
    if (/^rm -f .*\.provisioning/.test(script)) { state.lock = false; return out(""); }
    throw new Error("unexpected command: " + script.slice(0, 160));
  };
  return { calls, state };
}

const FAST = { testWindowMs: 50, testPollMs: 1, settlePolls: 3, settlePollMs: 1 };

test("happy path: build, guarded sanity test, promote, stopped stay stopped, running rechecked", async () => {
  const { calls, state } = fakeHost({ bots: [{ id: "17", running: true }, { id: "3", running: false }] });
  const logs = [];
  const r = await fleet.rolloutImage({ ref: "farm-20260929b", timing: FAST, log: (m) => logs.push(m) });
  assert.strictEqual(r.image, "twitchbot-noclaim:farm-20260929b");
  assert.match(r.backup, /^twitchbot-noclaim:pre-/);
  assert.strictEqual(r.testedOn, "noclaim-bot-3", "tested on a STOPPED bot's config copy");
  assert.deepStrictEqual(r.created, ["noclaim-bot-3"]);
  assert.deepStrictEqual(r.recreated, ["noclaim-bot-17"]);
  const create = calls.find((c) => c.includes("docker create "));
  assert.match(create, /docker create --name 'noclaim-bot-3' --restart unless-stopped/);
  const run17 = calls.find((c) => c.includes("docker stop -t 20 'noclaim-bot-17'"));
  assert.match(run17, /docker run -d --name 'noclaim-bot-17'.*'twitchbot-noclaim:latest'/);
  assert.ok(calls.indexOf(create) < calls.indexOf(run17), "stopped bots first, live ones after");
  assert.strictEqual(state.lock, false, "provisioning lock released");
});

test("an image without the no-claim guard is never promoted", async () => {
  const { calls, state } = fakeHost({ testLogs: GOOD_NO_GUARD, bots: [{ id: "3", running: false }] });
  await assert.rejects(
    fleet.rolloutImage({ ref: "farm-20260929b", timing: FAST }),
    /sanity test failed .*nothing live was touched/,
  );
  assert.ok(!calls.some((c) => c.includes("|| true; docker tag")), "no promote");
  assert.ok(!calls.some((c) => c.includes("docker create ") || c.includes("docker stop -t 20")), "no bot touched");
  assert.strictEqual(state.lock, false);
});

test("a running bot that loses the guard after recreate is rolled back and the rollout stops", async () => {
  const { calls } = fakeHost({
    bots: [{ id: "17", running: true }, { id: "18", running: true }],
    botLogs: { "noclaim-bot-17": GOOD_NO_GUARD },
  });
  await assert.rejects(
    fleet.rolloutImage({ ref: "farm-20260929b", timing: FAST }),
    /noclaim-bot-17 failed its post-update check .*put back to twitchbot-noclaim:pre-/,
  );
  const rollback = calls.find((c) => c.startsWith("docker tag 'twitchbot-noclaim:pre-") && c.includes("&& docker rm -f 'noclaim-bot-17'"));
  assert.ok(rollback, "the previous build is put back on the failing bot");
  assert.ok(!calls.some((c) => c.includes("'noclaim-bot-18'")), "the rollout stopped before the next bot");
});

test("dry run stops after the sanity test", async () => {
  const { calls } = fakeHost({ bots: [{ id: "3", running: false }, { id: "17", running: true }] });
  const r = await fleet.rolloutImage({ ref: "noclaim-test", dryRun: true, timing: FAST });
  assert.strictEqual(r.dryRun, true);
  assert.ok(!calls.some((c) => c.includes("|| true; docker tag") || c.includes("docker create ") || c.includes("docker stop -t 20")));
});

test("with every bot running, the test uses ONE account of a running config", async () => {
  const { calls } = fakeHost({ bots: [{ id: "17", running: true }] });
  const r = await fleet.rolloutImage({ ref: "noclaim-test", dryRun: true, timing: FAST });
  assert.match(r.testedOn, /noclaim-bot-17 \(1 account/);
  const setup = calls.find((c) => c.includes("docker run -d --name noclaim-rollout-test"));
  assert.match(setup, /\[:1\]/, "the copied config is trimmed to one account");
});

test("a busy provisioning lock refuses to start", async () => {
  fakeHost({ busy: true, bots: [] });
  await assert.rejects(fleet.rolloutImage({ ref: "noclaim-test", timing: FAST }), (e) => e.status === 409);
});
