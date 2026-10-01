// utils/dupeGuard (2026-10-01): a moved account is stripped from sibling
// configs AND the sibling is recorded as owing a reload (out of the config is
// not out of a running bot); a sibling that changed since the batched read is
// stripped from its fresh text (no lost update, no double); the guard skips only its own heal writes, not
// every write that happens to run meanwhile.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const owed = [];
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /utils[\\/]dupeGuard\.js$/.test(parent.filename || "") && request === "./renterBotOps") {
    return { markReloadOwed: async (host, file, reason) => { owed.push(host.id + "/" + file + ": " + reason); } };
  }
  return realLoad.call(this, request, parent, isMain);
};
const guard = require("../utils/dupeGuard");
test.after(() => { Module._load = realLoad; });

const cfg = (users) => JSON.stringify({ TwitchSettings: { TwitchUsers: users } });
const u = (s, extra = {}) => ({ ClientSecret: s, Login: s, Enabled: true, ...extra });

function fakeHosts(files, { onRead } = {}) {
  const h = {
    files,
    writes: [],
    readdir: async () => Object.keys(files),
    readFiles: async (host, names) => Object.fromEntries(names.map((f) => [f, { ok: true, text: files[f] }])),
    readFile: async (host, f) => {
      if (onRead) await onRead(f);
      return files[f];
    },
    writeFileAtomic: async (host, f, text) => {
      files[f] = text;
      h.writes.push(f);
      await guard.enforceSingleHome(h, host, f, text);
    },
  };
  return h;
}
const HOST = { id: "contabo" };

test("a moved account is stripped from the sibling AND the sibling owes a reload", async () => {
  owed.length = 0;
  const hosts = fakeHosts({
    "config_03.json": cfg([u("a"), u("b")]),
    "config_05.json": cfg([u("a")]),
  });
  const healed = await guard.enforceSingleHome(hosts, HOST, "config_05.json", hosts.files["config_05.json"]);
  assert.deepEqual(healed, [{ file: "config_03.json", removed: ["a"] }]);
  assert.deepEqual(JSON.parse(hosts.files["config_03.json"]).TwitchSettings.TwitchUsers.map((x) => x.ClientSecret), ["b"]);
  assert.deepEqual(owed, ["contabo/config_03.json: dupe guard: accounts moved to config_05.json"]);
});

test("REGRESSION: a sibling that changed since the batched read is stripped from what is there NOW — no lost update, and no token left enabled twice", async () => {
  owed.length = 0;
  let hosts = null;
  hosts = fakeHosts(
    { "config_03.json": cfg([u("a"), u("b")]), "config_05.json": cfg([u("a")]) },
    {
      onRead: async (f) => {
        // Another (locked) writer adds "c" to config_03 in between.
        if (f === "config_03.json") hosts.files["config_03.json"] = cfg([u("a"), u("b"), u("c")]);
      },
    },
  );
  const healed = await guard.enforceSingleHome(hosts, HOST, "config_05.json", hosts.files["config_05.json"]);
  assert.deepEqual(healed, [{ file: "config_03.json", removed: ["a"] }]);
  assert.deepEqual(
    JSON.parse(hosts.files["config_03.json"]).TwitchSettings.TwitchUsers.map((x) => x.ClientSecret),
    ["b", "c"],
    "the other writer's change stands AND the moved token is gone",
  );
  assert.deepEqual(owed, ["contabo/config_03.json: dupe guard: accounts moved to config_05.json"]);
});

test("REGRESSION: a write that runs WHILE a heal is under way is still guarded", async () => {
  owed.length = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  let hosts = null;
  hosts = fakeHosts({
    "config_03.json": cfg([u("a")]),
    "config_05.json": cfg([u("a")]),
    "config_07.json": cfg([u("z")]),
    "config_09.json": cfg([u("z")]),
  });
  const realWrite = hosts.writeFileAtomic;
  hosts.writeFileAtomic = async (host, f, text) => {
    if (f === "config_03.json") await gate; // the heal write of config_03 hangs a moment
    return realWrite(host, f, text);
  };
  const heal = guard.enforceSingleHome(hosts, HOST, "config_05.json", hosts.files["config_05.json"]);
  // Meanwhile an unrelated write lands on config_09 — its guard must still run.
  await new Promise((r) => setImmediate(r));
  const other = await guard.enforceSingleHome(hosts, HOST, "config_09.json", hosts.files["config_09.json"]);
  release();
  await heal;
  assert.deepEqual(other.map((x) => x.file), ["config_07.json"], "not skipped by a heal elsewhere");
});
