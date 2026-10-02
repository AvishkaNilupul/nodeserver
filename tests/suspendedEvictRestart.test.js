// Evicting a suspended account must never start a parked bot.
//
// evictSuspendedFromConfigs used to call restartConfigContainer on every
// config it touched. That is `docker restart` plus a restart-policy restore, so
// a bot botWaker had parked (stopped, policy "no") came back up with no wake
// trigger and its park undone — the wake/park flap class found 2026-09-29. A
// running bot still has to be restarted (bots read their config only at
// startup); a stopped one reads the edit whenever it is next started.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const ROUTES = path.resolve(__dirname, "../routes/botConfigRoutes.js");

function setup({ states }) {
  const restarted = [];
  require.cache[ROUTES] = {
    id: ROUTES,
    filename: ROUTES,
    loaded: true,
    exports: {
      removeAccountFromConfig: async () => 1,
      restartConfigContainer: async (host, file) => {
        restarted.push(file);
        return { restarted: true };
      },
      containerForFile: (file) => "twitchbot" + String(file).replace(/\D/g, ""),
    },
  };
  const hosts = require("../utils/botHosts");
  hosts.resolveHost = (id) => ({ id, transport: "ssh" });
  let psCalls = 0;
  hosts.dockerPs = async () => {
    psCalls++;
    return states;
  };
  const BotAccount = require("../models/BotAccount");
  BotAccount.find = () => ({
    lean: async () => [
      { _id: "a1", login: "one", clientSecret: "s1", configFile: "config_7.json", host: "contabo" },
      { _id: "a2", login: "two", clientSecret: "s2", configFile: "config_8.json", host: "contabo" },
      { _id: "a3", login: "three", clientSecret: "s3", configFile: "config_9.json", host: "contabo" },
    ],
  });
  BotAccount.updateOne = async () => ({ modifiedCount: 1 });
  const { evictSuspendedFromConfigs } = require("../utils/suspendedAccounts");
  return { evictSuspendedFromConfigs, restarted, psCalls: () => psCalls };
}

test("only a RUNNING bot is restarted after an eviction; parked and missing ones stay down", async () => {
  const t = setup({
    states: {
      twitchbot7: { state: "running" },
      twitchbot8: { state: "exited" }, // parked by botWaker
      // twitchbot9 has no container at all
    },
  });
  const out = await t.evictSuspendedFromConfigs({});
  assert.equal(out.evicted, 3);
  assert.equal(out.configs, 3);
  assert.deepEqual(t.restarted, ["config_7.json"]);
  // One `docker ps` per host per sweep, not one per config.
  assert.equal(t.psCalls(), 1);
});

test("a failed docker ps restarts nothing and does not throw", async () => {
  const t = setup({ states: {} });
  const hosts = require("../utils/botHosts");
  hosts.dockerPs = async () => {
    throw new Error("ssh: connect timed out");
  };
  const out = await t.evictSuspendedFromConfigs({});
  assert.equal(out.evicted, 3);
  assert.deepEqual(t.restarted, []);
});
