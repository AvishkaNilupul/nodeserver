// One account, one bot — across every host and the no-claim tree (owner,
// 2026-09-28). dupeGuard only keeps an account to one regular config per host;
// 32 accounts farmed in a regular bot and a no-claim bot at once for 54 hours.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const users = (...pairs) => ({
  TwitchSettings: { TwitchUsers: pairs.map(([Login, ClientSecret, Enabled]) => ({ Login, ClientSecret, ...(Enabled === false ? { Enabled } : {}) })) },
});

test("findCollisions: enabled in two configs is a collision; disabled copies and one config are not", () => {
  const { findCollisions } = require("../utils/fleetIntegrity");
  const r = findCollisions([
    { where: "pi/config_14.json", cfg: users(["twice", "secret-AAAA"], ["solo", "secret-BBBB"], ["gone", "secret-CCCC", false]) },
    { where: "no-claim bot 21", cfg: users(["twice", "secret-AAAA"], ["gone", "secret-CCCC"]) },
    { where: "contabo/config_42.json", cfg: users(["dup", "secret-DDDD"], ["dup", "secret-DDDD"]) },
  ]);
  assert.strictEqual(r.accounts, 4);
  assert.deepStrictEqual(r.collisions, [
    { login: "twice", secretTail: "…AAAA", homes: ["no-claim bot 21", "pi/config_14.json"] },
  ]);
});

test("oneAccountOneBot: reads every host's configs and the no-claim bots; unreadable ones are reported", async () => {
  const files = {
    local: { "config.json": JSON.stringify(users(["a", "s-1"])), "notes.txt": "x", "config_2.json": "{ broken" },
    pi: { "config_14.json": JSON.stringify(users(["b", "s-2"], ["twice", "s-3"])) },
  };
  const hosts = {
    listHosts: () => [{ id: "local" }, { id: "pi" }, { id: "phone" }],
    resolveHost: (id) => ({ id }),
    readdir: async (h) => {
      if (!files[h.id]) throw new Error("ssh: connect timed out");
      return Object.keys(files[h.id]);
    },
    readFiles: async (h, list) => Object.fromEntries(list.map((f) => [f, { ok: true, text: files[h.id][f] }])),
  };
  const engine = {
    readNoClaimConfigs: async () => [
      { id: "21", cfg: users(["twice", "s-3"]) },
      { id: "22", cfg: null },
    ],
  };
  const stubs = new Map([
    [require.resolve("../utils/botHosts"), hosts],
    [require.resolve("../utils/unclaimedAutoList"), engine],
  ]);
  const path = require.resolve("../utils/fleetIntegrity");
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    let resolved;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch {
      return origLoad.apply(this, arguments);
    }
    if (stubs.has(resolved)) return stubs.get(resolved);
    return origLoad.apply(this, arguments);
  };
  delete require.cache[path];
  try {
    const r = await require("../utils/fleetIntegrity").oneAccountOneBot();
    assert.strictEqual(r.configs, 3, "local config.json, pi config_14.json, no-claim bot 21");
    assert.deepStrictEqual(r.collisions.map((c) => [c.login, c.homes]), [["twice", ["no-claim bot 21", "pi/config_14.json"]]]);
    assert.deepStrictEqual(r.unreadable.sort(), ["local/config_2.json", "no-claim bot 22", "phone: ssh: connect timed out"]);
  } finally {
    Module._load = origLoad;
    delete require.cache[path];
  }
});
