// The RAM gate failing open, as the health board sees it.
//
// utils/hostCapacity fails OPEN on an unreadable host: newContainerAllowed()
// answers "RAM unknown" and the farms go on creating containers. Its
// lastReading() used to keep only SUCCESSFUL reads, so an hour into a run of
// failed reads hosts.ram still judged the hour-old good figure — green, with
// no word that the gate was letting every create through unweighed (review
// proof 3a, 2026-10-03). lastReading() now also carries the newest failed
// attempt, and a failure newer than the last success warns.
//
// No SSH and no network: botHosts and settings are stubbed at require time,
// the way tests/hostCapacity.test.js does it.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const health = require("../utils/systemHealth");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const HOSTS = {
  local: { id: "local", label: "Server", transport: "local" },
  contabo: { id: "contabo", label: "Contabo VPS", transport: "ssh" },
};

// The real utils/hostCapacity with its two dependencies stubbed. `shell` is
// called for every SSH command, with the call number.
function loadGate({ shell, af = { hostMinFreeMb: 1500 } } = {}) {
  let calls = 0;
  const botHosts = {
    resolveHost(id) {
      if (id === undefined || id === null || id === "") return HOSTS.local;
      return HOSTS[String(id)] || null;
    },
    async runShell(host) {
      calls += 1;
      return shell(host, calls);
    },
  };
  const settings = { getAutoFarm: () => af };
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
    return mod;
  } finally {
    Module._load = realLoad;
  }
}

// Run `fn` with the module clock moved `ms` ahead.
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

const settingsDep = (af = {}) => ({
  getAutoFarm: () => ({ enabled: true, hostId: "contabo", hostMinFreeMb: 1500, ...af }),
});

async function ramCheck(hostCapacity, { now = new Date(), af } = {}) {
  const run = await health.runAll({
    only: ["hosts.ram"],
    deps: { settings: settingsDep(af), hostCapacity },
    now: () => now,
  });
  assert.equal(run.checks.length, 1);
  return run.checks[0];
}

// A hand-made cache, for the cases the clock would make slow to stage.
function gateWith(readings) {
  return { lastReading: (hostId) => readings[hostId] || null };
}

/* ========================================================================== *
 * hostCapacity.lastReading — the last success AND the newest failure
 * ========================================================================== */

test("lastReading keeps the newest failed attempt beside the last success", async () => {
  const gate = loadGate({
    shell: async (h, n) => {
      if (n === 1) return { stdout: "2600\n" };
      throw new Error("ssh: connect timed out\n(host thrashing)");
    },
  });
  assert.equal(gate.lastReading("contabo"), null, "nothing attempted yet");
  assert.equal(await gate.memAvailableMb("contabo"), 2600);
  const good = gate.lastReading("contabo");
  assert.equal(good.availableMb, 2600);
  assert.ok(good.at instanceof Date);
  assert.equal(good.lastErrorAt, null);
  assert.equal(good.lastError, null);

  await later(61 * MIN, async () => {
    // The gate itself is unchanged: it fails open.
    assert.deepEqual(await gate.newContainerAllowed("contabo"), {
      ok: true,
      availableMb: null,
      minFreeMb: 1500,
      reason: "RAM unknown",
    });
  });
  const r = gate.lastReading("contabo");
  assert.equal(r.availableMb, 2600, "the last success is kept");
  assert.equal(r.at.getTime(), good.at.getTime());
  assert.ok(r.lastErrorAt instanceof Date);
  assert.ok(r.lastErrorAt.getTime() > r.at.getTime(), "the failure is the newer attempt");
  assert.equal(r.lastError, "ssh: connect timed out (host thrashing)", "one line");
});

test("a host that never answered has a failure and no figure; unread hosts stay null", async () => {
  const gate = loadGate({ shell: async () => ({ stdout: "-5" }) });
  assert.equal(await gate.memAvailableMb("contabo"), null);
  const r = gate.lastReading("contabo");
  assert.equal(r.availableMb, null);
  assert.equal(r.at, null);
  assert.ok(r.lastErrorAt instanceof Date);
  assert.equal(r.lastError, 'no MemAvailable figure in the host\'s /proc/meminfo output ("-5")');
  // An unknown host id is never dialled, but the gate did fail open on it.
  assert.equal(await gate.memAvailableMb("nope"), null);
  assert.equal(gate.lastReading("nope").lastError, "unknown host nope");
  assert.equal(gate.lastReading("local"), null, "a host nobody asked about has no reading");
  gate._resetForTests();
  assert.equal(gate.lastReading("contabo"), null, "reset forgets failures too");
});

/* ========================================================================== *
 * hosts.ram — a failing gate warns
 * ========================================================================== */

test("REGRESSION (review proof 3a): the gate failing open warns instead of judging an hour-old figure", async () => {
  // The reviewer's sequence through the REAL module: one good read, then an
  // hour later the read fails and the gate lets the create through.
  const gate = loadGate({
    shell: async (h, n) => {
      if (n === 1) return { stdout: "2600\n" };
      throw new Error("ssh: connect timed out (host thrashing)");
    },
  });
  const t0 = Date.now();
  assert.equal(await gate.memAvailableMb("contabo"), 2600);
  await later(61 * MIN, async () => {
    assert.equal((await gate.newContainerAllowed("contabo")).reason, "RAM unknown");
  });
  const check = await ramCheck(gate, { now: new Date(t0 + 61 * MIN + 1000) });
  assert.equal(check.status, "warn", "a gate failing open is not ok");
  assert.match(
    check.summary,
    /^contabo: RAM unknown since \d{4}-\d\d-\d\d \d\d:\d\dZ \(ssh: connect timed out \(host thrashing\)\) — the gate is letting containers be created without a reading$/,
  );
  assert.equal(check.measured, "RAM unknown", "no current figure, so none is claimed");
  const row = check.items[0];
  assert.equal(row.error, "ssh: connect timed out (host thrashing)");
  assert.equal(row.availableMb, null, "the old figure is not presented as the current one");
  assert.match(row.read, /^failed \d+s ago; last good 1h 1m ago \(2600 MB\)$/);
  assert.match(check.threshold, /or while the gate cannot read the host/);
  assert.match(check.detail, /failing open/);
});

test("the time named is the last good read; with none, the server start", async () => {
  const now = new Date("2026-10-03T12:00:30.000Z");
  const at = new Date("2026-10-03T10:58:10.000Z");
  const withGood = await ramCheck(
    gateWith({
      contabo: { availableMb: 2600, at, lastErrorAt: new Date(now.getTime() - 20 * 1000), lastError: "boom" },
    }),
    { now },
  );
  assert.equal(
    withGood.summary,
    "contabo: RAM unknown since 2026-10-03 10:58Z (boom) — the gate is letting containers be created without a reading",
  );
  const never = await ramCheck(
    gateWith({
      contabo: { availableMb: null, at: null, lastErrorAt: new Date(now.getTime() - 20 * 1000), lastError: "boom" },
    }),
    { now },
  );
  assert.equal(never.status, "warn");
  assert.match(never.summary, /^contabo: RAM unknown since the server started \(boom\)/);
  assert.equal(never.items[0].read, "failed 20s ago; last good never");
});

test("a failure older than the last good read is history: the figure is judged", async () => {
  const now = new Date();
  const check = await ramCheck(
    gateWith({
      contabo: {
        availableMb: 4800,
        at: new Date(now.getTime() - 2 * MIN),
        lastErrorAt: new Date(now.getTime() - 30 * MIN),
        lastError: "a blip",
      },
    }),
    { now },
  );
  assert.equal(check.status, "ok");
  assert.equal(check.measured, 4800);
  assert.equal(check.items[0].error, null);
  assert.equal(check.summary, "contabo has 4800 MB available (read 2m ago)");
});

test("a failed read nobody has followed up for hours is shown, not judged", async () => {
  const now = new Date();
  const check = await ramCheck(
    gateWith({
      contabo: {
        availableMb: 2600,
        at: new Date(now.getTime() - 5 * HOUR),
        lastErrorAt: new Date(now.getTime() - 3 * HOUR),
        lastError: "boom",
      },
    }),
    { now },
  );
  assert.equal(check.status, "unknown");
  assert.match(check.items[0].note, /^the newest read failed 3h 0m ago — no farm has asked since/);
  assert.equal(check.items[0].error, "boom", "the error still shows");
});

test("with the gate switched off a failing read is no warning: nothing waits on it", async () => {
  const now = new Date();
  const check = await ramCheck(
    gateWith({ contabo: { availableMb: null, at: null, lastErrorAt: new Date(now.getTime() - MIN), lastError: "boom" } }),
    { now, af: { hostMinFreeMb: 0 } },
  );
  assert.equal(check.status, "unknown");
  assert.match(check.items[0].note, /gate is off/);
});

test("a failing host beside a healthy one: the warning shows, the healthy figure is measured", async () => {
  const now = new Date();
  const check = await ramCheck(
    gateWith({
      pi: { availableMb: 5000, at: new Date(now.getTime() - MIN), lastErrorAt: null, lastError: null },
      contabo: { availableMb: 2600, at: new Date(now.getTime() - HOUR), lastErrorAt: new Date(now.getTime() - MIN), lastError: "boom" },
    }),
    { now, af: { hostId: "pi" } },
  );
  assert.equal(check.status, "warn");
  assert.equal(check.measured, 5000);
  assert.match(check.summary, /^contabo: RAM unknown since .* \(boom\)/, "the warning first");
});
