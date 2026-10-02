// Evicting a suspended account must never start a parked bot.
//
// evictSuspendedFromConfigs used to call restartConfigContainer on every
// config it touched. That is `docker restart` plus a restart-policy restore, so
// a bot botWaker had parked (stopped, policy "no") came back up with no wake
// trigger and its park undone — the wake/park flap class found 2026-09-29. A
// running bot still has to be restarted (bots read their config only at
// startup); a stopped one reads the edit whenever it is next started.
//
// 2026-10-03: the first fix read `docker ps` and then restarted in a separate
// call, so a park landing between the two was still undone. The check and the
// restart are now one shell command (farmControl.restartIfRunning).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const ROUTES = path.resolve(__dirname, "../routes/botConfigRoutes.js");
const containerForFile = (file) => "twitchbot" + String(file).replace(/\D/g, "");

// A fake docker host shared by every path the sweep could take: `docker ps` +
// restartConfigContainer (the two-call version) and runShell running the
// one-command check-and-restart. `states` maps container -> docker status (no
// key = no container). `parkAfterFirstTrip` lands the auto-farm tick's park
// (`docker stop`) on that container right after the first round trip to the
// host — between a `docker ps` and a separate restart. `accounts` maps a
// config to how many accounts it still holds after the eviction.
function setup({ states, accounts = {}, parkAfterFirstTrip = null, shellError = null }) {
  const log = [];
  let trips = 0;
  let psCalls = 0;
  let shellCalls = 0;
  const trip = () => {
    trips++;
    if (trips === 1 && parkAfterFirstTrip && states[parkAfterFirstTrip] === "running") {
      states[parkAfterFirstTrip] = "exited";
      log.push("park " + parkAfterFirstTrip);
    }
  };
  require.cache[ROUTES] = {
    id: ROUTES,
    filename: ROUTES,
    loaded: true,
    exports: {
      removeAccountFromConfig: async () => 1,
      // `docker restart` STARTS a stopped container, then the policy restore.
      restartConfigContainer: async (host, file) => {
        const c = containerForFile(file);
        log.push("restart " + c + " (was " + (states[c] || "missing") + ")");
        if (states[c]) states[c] = "running";
        trip();
        return { restarted: true, container: c };
      },
      containerForFile,
    },
  };
  const hosts = require("../utils/botHosts");
  hosts.resolveHost = (id) => ({ id, transport: "ssh" });
  hosts.dockerPs = async () => {
    psCalls++;
    const snap = {};
    for (const [c, s] of Object.entries(states)) snap[c] = { state: s };
    trip();
    return snap;
  };
  hosts.runShell = async (_h, script) => {
    shellCalls++;
    if (shellError) {
      trip();
      throw shellError;
    }
    const c = /docker restart '([^']+)'/.exec(script)[1];
    let stdout = "STATE " + (states[c] || "missing") + "\n";
    if (states[c] === "running") {
      log.push("restart " + c + " (was running)");
      stdout = "RESTARTED\n";
    }
    trip();
    return { stdout, stderr: "" };
  };
  hosts.restoreRestartPolicy = async (_h, c) => {
    log.push("policy always " + c);
  };
  hosts.stopIfNoAccounts = async (_h, file, c) => {
    let stopped = false;
    if ((accounts[file] ?? 1) === 0 && states[c] === "running") {
      states[c] = "exited";
      log.push("stop " + c + " (no accounts)");
      stopped = true;
    }
    trip();
    return { stopped };
  };
  const BotAccount = require("../models/BotAccount");
  const rows = [
    { _id: "a1", login: "one", clientSecret: "s1", configFile: "config_7.json", host: "contabo" },
    { _id: "a2", login: "two", clientSecret: "s2", configFile: "config_8.json", host: "contabo" },
    { _id: "a3", login: "three", clientSecret: "s3", configFile: "config_9.json", host: "contabo" },
  ].filter((r) => !setup.only || setup.only.includes(r.configFile));
  BotAccount.find = () => ({ lean: async () => rows });
  BotAccount.updateOne = async () => ({ modifiedCount: 1 });
  const { evictSuspendedFromConfigs } = require("../utils/suspendedAccounts");
  return {
    evictSuspendedFromConfigs,
    log,
    states,
    psCalls: () => psCalls,
    shellCalls: () => shellCalls,
  };
}

test.beforeEach(() => {
  setup.only = null;
});

test("only a RUNNING bot is restarted after an eviction; parked and missing ones stay down", async () => {
  const t = setup({
    states: {
      twitchbot7: "running",
      twitchbot8: "exited", // parked by botWaker
      // twitchbot9 has no container at all
    },
  });
  const out = await t.evictSuspendedFromConfigs({});
  assert.equal(out.evicted, 3);
  assert.equal(out.configs, 3);
  // The policy is restored only after the one real restart.
  assert.deepEqual(t.log, ["restart twitchbot7 (was running)", "policy always twitchbot7"]);
  assert.deepEqual(t.states, { twitchbot7: "running", twitchbot8: "exited" });
  // One shell command per touched config does the check AND the restart.
  assert.equal(t.shellCalls(), 3);
  assert.equal(t.psCalls(), 0);
});

test("a park landing between the check and the restart is never undone", async () => {
  // Only config_8 was touched; its bot is running when the sweep looks, and
  // the tick parks it a moment later. A `docker ps` followed by a separate
  // restart starts the just-parked bot again (docker restart starts a stopped
  // container); the one-command check-and-restart cannot.
  setup.only = ["config_8.json"];
  const t = setup({ states: { twitchbot8: "running" }, parkAfterFirstTrip: "twitchbot8" });
  await t.evictSuspendedFromConfigs({});
  assert.equal(t.states.twitchbot8, "exited", "the park holds");
  assert.ok(
    !t.log.some((l) => l === "restart twitchbot8 (was exited)"),
    "a stopped (just-parked) bot was restarted: " + t.log.join(" | "),
  );
});

test("a failed check restarts nothing, restores no policy, and does not throw", async () => {
  const t = setup({
    states: { twitchbot7: "running", twitchbot8: "exited" },
    shellError: new Error("ssh: connect timed out"),
  });
  const out = await t.evictSuspendedFromConfigs({});
  assert.equal(out.evicted, 3);
  assert.deepEqual(t.log, []);
  assert.equal(t.states.twitchbot7, "running");
});

test("a config the eviction empties is stopped, never restarted", async () => {
  // A bot with no accounts spins in a login-retry loop (botHosts.stopIfNoAccounts).
  const t = setup({
    states: { twitchbot7: "running", twitchbot8: "running" },
    accounts: { "config_7.json": 0 },
  });
  await t.evictSuspendedFromConfigs({});
  assert.deepEqual(t.log, [
    "stop twitchbot7 (no accounts)",
    "restart twitchbot8 (was running)",
    "policy always twitchbot8",
  ]);
  assert.equal(t.states.twitchbot7, "exited");
});

test("TWITCHBOT_ALLOW_RESTART=0 still turns the restarts off", async () => {
  const saved = process.env.TWITCHBOT_ALLOW_RESTART;
  process.env.TWITCHBOT_ALLOW_RESTART = "0";
  try {
    const t = setup({ states: { twitchbot7: "running" } });
    const out = await t.evictSuspendedFromConfigs({});
    assert.equal(out.evicted, 3);
    assert.deepEqual(t.log, []);
    assert.equal(t.shellCalls(), 0);
  } finally {
    if (saved === undefined) delete process.env.TWITCHBOT_ALLOW_RESTART;
    else process.env.TWITCHBOT_ALLOW_RESTART = saved;
  }
});
