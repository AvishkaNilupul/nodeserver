// The host RAM gate for NEW bot containers (utils/hostCapacity.js).
//
// Nothing weighed a bot host's memory before a container was created: the
// auto-farm, the no-claim feeder and the rent-farm each counted only their own
// containers on the one Contabo VPS. These pin the shared contract
// (docs/LIVE-FIXES-1003.md §2): one cached /proc/meminfo read per host per
// minute, a plain-words verdict, FAIL OPEN on an unreadable host, and a
// lastReading() the health page can use without ever touching SSH.
//
// No SSH: botHosts and settings are stubbed at require time.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const SCRIPT = "awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo";
const HOSTS = {
  local: { id: "local", label: "Server", transport: "local" },
  contabo: { id: "contabo", label: "Contabo VPS", transport: "ssh" },
  pi: { id: "pi", label: "Raspberry Pi", transport: "ssh" },
};

function load({ shell, af = { hostMinFreeMb: 1500 } } = {}) {
  const calls = { shell: [] };
  const botHosts = {
    resolveHost(id) {
      if (id === undefined || id === null || id === "") return HOSTS.local;
      return HOSTS[String(id)] || null;
    },
    async runShell(host, script, opts) {
      calls.shell.push({ host: host.id, script, opts });
      return shell(host, calls.shell.length);
    },
  };
  const settings = { getAutoFarm: () => (typeof af === "function" ? af() : af) };
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const from = parent && /hostCapacity\.js$/.test(parent.filename || "");
    if (from && request === "./botHosts") return botHosts;
    if (from && request === "./settings") return settings;
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    const p = require.resolve("../utils/hostCapacity");
    delete require.cache[p];
    const mod = require("../utils/hostCapacity");
    delete require.cache[p];
    mod._resetForTests();
    return { mod, calls };
  } finally {
    Module._load = realLoad;
  }
}

async function later(ms, fn) {
  const realNow = Date.now;
  const base = realNow();
  Date.now = () => base + ms;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

test("memAvailableMb reads MemAvailable once, with the contract's command and timeout", async () => {
  const { mod, calls } = load({ shell: async () => ({ stdout: "3456\n", stderr: "" }) });
  assert.equal(await mod.memAvailableMb("contabo"), 3456);
  assert.deepEqual(calls.shell, [{ host: "contabo", script: SCRIPT, opts: { timeout: 15000 } }]);
});

test("cached 60 s per host id; concurrent callers share one read", async () => {
  let n = 0;
  const { mod, calls } = load({ shell: async (h) => ({ stdout: String(h.id === "pi" ? 700 : 2000 + n++) }) });
  const [a, b] = await Promise.all([mod.memAvailableMb("contabo"), mod.memAvailableMb("contabo")]);
  assert.equal(a, 2000);
  assert.equal(b, 2000);
  assert.equal(calls.shell.length, 1, "two concurrent callers, one SSH command");
  assert.equal(await mod.memAvailableMb("contabo"), 2000);
  assert.equal(calls.shell.length, 1, "fresh: served from the cache");
  assert.equal(await mod.memAvailableMb("pi"), 700, "another host has its own entry");
  assert.equal(calls.shell.length, 2);
  await later(61 * 1000, async () => {
    assert.equal(await mod.memAvailableMb("contabo"), 2001, "stale after 60 s: read again");
  });
  assert.equal(calls.shell.length, 3);
});

test("no host id is the local host, as in botHosts.resolveHost", async () => {
  const { mod, calls } = load({ shell: async () => ({ stdout: "900" }) });
  assert.equal(await mod.memAvailableMb(""), 900);
  assert.equal(await mod.memAvailableMb(undefined), 900);
  assert.equal(await mod.memAvailableMb("local"), 900);
  assert.equal(calls.shell.length, 1);
  assert.equal(calls.shell[0].host, "local");
});

test("a resolved host object is read as its id, not as '[object Object]'", async () => {
  const { mod, calls } = load({ shell: async () => ({ stdout: "1800" }) });
  assert.equal(await mod.memAvailableMb(HOSTS.contabo), 1800);
  assert.equal(await mod.memAvailableMb("contabo"), 1800, "same cache entry as the id");
  assert.equal(calls.shell.length, 1);
  assert.equal(calls.shell[0].host, "contabo");
  assert.equal((await mod.newContainerAllowed(HOSTS.contabo)).ok, true);
  assert.equal(mod.lastReading(HOSTS.contabo).availableMb, 1800);
});

test("null on any error, and a dead host is not re-dialled for every caller", async () => {
  const { mod, calls } = load({
    shell: async () => {
      const e = new Error("ssh: connect to host timed out");
      e.unreachable = true;
      throw e;
    },
  });
  assert.equal(await mod.memAvailableMb("contabo"), null);
  assert.equal(await mod.memAvailableMb("contabo"), null);
  assert.equal(calls.shell.length, 1, "the failure is remembered for the minute");
  await later(61 * 1000, async () => {
    assert.equal(await mod.memAvailableMb("contabo"), null);
  });
  assert.equal(calls.shell.length, 2);
});

test("an unknown host id or unreadable output is null, never a number", async () => {
  const outputs = ["", "MemAvailable missing", "-5"];
  let i = 0;
  const { mod, calls } = load({ shell: async () => ({ stdout: outputs[i++] }) });
  assert.equal(await mod.memAvailableMb("nope"), null);
  assert.equal(calls.shell.length, 0, "an unknown host is never dialled");
  assert.equal(await mod.memAvailableMb("contabo"), null);
  assert.equal(await mod.memAvailableMb("pi"), null);
  assert.equal(await mod.memAvailableMb("local"), null);
});

test("newContainerAllowed: below hostMinFreeMb says no, in plain words", async () => {
  const { mod } = load({ shell: async () => ({ stdout: "1200\n" }) });
  const r = await mod.newContainerAllowed("contabo");
  assert.equal(r.ok, false);
  assert.equal(r.availableMb, 1200);
  assert.equal(r.minFreeMb, 1500);
  assert.match(r.reason, /contabo has 1200 MB RAM free/);
  assert.match(r.reason, /needs at least 1500 MB/);
});

test("newContainerAllowed: at or above the floor is ok", async () => {
  const { mod } = load({ shell: async (h) => ({ stdout: h.id === "pi" ? "1500" : "4000" }) });
  const r = await mod.newContainerAllowed("contabo");
  assert.equal(r.ok, true);
  assert.equal(r.availableMb, 4000);
  assert.equal(r.minFreeMb, 1500);
  assert.equal((await mod.newContainerAllowed("pi")).ok, true, "exactly the floor is enough");
});

test("FAIL OPEN: an unreadable host allows the create with 'RAM unknown'", async () => {
  const { mod } = load({ shell: async () => { throw new Error("boom"); } });
  assert.deepEqual(await mod.newContainerAllowed("contabo"), {
    ok: true,
    availableMb: null,
    minFreeMb: 1500,
    reason: "RAM unknown",
  });
});

test("hostMinFreeMb 0 (or unset) switches the gate off without any SSH", async () => {
  for (const v of [0, undefined, null, "", "x", -1]) {
    const { mod, calls } = load({ shell: async () => ({ stdout: "10" }), af: { hostMinFreeMb: v } });
    const r = await mod.newContainerAllowed("contabo");
    assert.equal(r.ok, true, String(v));
    assert.equal(r.minFreeMb, 0, String(v));
    assert.equal(calls.shell.length, 0, String(v));
  }
});

test("the setting is read on every call, so a change applies at once", async () => {
  let min = 1500;
  const { mod } = load({ shell: async () => ({ stdout: "1000" }), af: () => ({ hostMinFreeMb: min }) });
  assert.equal((await mod.newContainerAllowed("contabo")).ok, false);
  min = 800;
  assert.equal((await mod.newContainerAllowed("contabo")).ok, true);
});

test("lastReading: cached value only — the last SUCCESSFUL read, never SSH", async () => {
  let fail = false;
  const { mod, calls } = load({
    shell: async () => {
      if (fail) throw new Error("down");
      return { stdout: "2500" };
    },
  });
  assert.equal(mod.lastReading("contabo"), null, "nothing read yet");
  assert.equal(calls.shell.length, 0, "lastReading never dials the host");
  const before = Date.now();
  await mod.memAvailableMb("contabo");
  const r = mod.lastReading("contabo");
  assert.equal(r.availableMb, 2500);
  assert.ok(r.at instanceof Date);
  assert.ok(r.at.getTime() >= before);
  fail = true;
  await later(61 * 1000, async () => {
    assert.equal(await mod.memAvailableMb("contabo"), null);
  });
  assert.equal(mod.lastReading("contabo").availableMb, 2500, "a failed read keeps the last good one");
  assert.equal(mod.lastReading("pi"), null);
  assert.equal(mod.lastReading(""), null);
});
