// Farm loops and farm-host RAM on the health board (docs/LIVE-FIXES-1003.md §A6).
//
// Defect 7 of docs/FARM-DISTRIBUTION-MAP.md: no health check proved the no-claim
// allocator alive — its heartbeat was a console line — and the auto-farm tick,
// the farm2 supervisor and the farm brain were in the same state. Defect 16:
// nothing watched the RAM of the one Contabo machine all three farms share.
//
// What is under test is not "does it go green" but:
//   - a dead loop is red, a late one amber, and the row says by how much;
//   - a restart cannot hide a dead loop for longer than the loop's own budget,
//     although every stamp the hooks hand back lives in memory;
//   - a loop switched off is "off", never a failure — and the brain is judged
//     only when it is switched on;
//   - anything that cannot be read (a hook not exported yet, a module not
//     loaded in this process, a RAM figure nobody has taken) is `unknown`,
//     never `ok` and never `fail`;
//   - the health run takes no reading of its own: no SSH, no fresh module load.
//
// Everything runs on injected dependencies: no database, no network, no host.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const health = require("../utils/systemHealth");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
// Pinned so no age comparison can go flaky on a slow machine.
const NOW = new Date("2026-10-03T12:00:00.000Z");
const now = () => NOW;
const ago = (ms) => new Date(NOW.getTime() - ms);

/* ========================================================================== *
 * Fakes shaped exactly like the contract's hooks (§2, §3)
 * ========================================================================== */

// The four hooks as §3 freezes them, all healthy unless a test bends one.
function hooks({
  autoFarm = { lastTickAt: ago(4 * MIN), intervalMin: 10, enabled: true },
  farm2 = { lastRun: ago(1 * MIN), intervalMin: 3, enabled: true },
  allocator = { lastRun: ago(20 * MIN), intervalMin: 60 },
  brain = { lastRunAt: ago(30 * MIN), intervalMin: 60, enabled: true },
} = {}) {
  return {
    autoFarmer: { loopStatus: () => autoFarm },
    farm2Supervisor: { loopStatus: () => farm2 },
    unclaimedAllocator: { status: () => allocator },
    demandBrain: { loopStatus: () => brain },
  };
}

// utils/hostCapacity's cache. Only lastReading() may be used by the health run:
// the other two take a live reading over SSH, so here they blow up if touched.
function ramGate(readings = {}) {
  const asked = [];
  return {
    asked,
    lastReading(hostId) {
      asked.push(hostId);
      return readings[hostId] || null;
    },
    async memAvailableMb() {
      throw new Error("the health run opened SSH (memAvailableMb)");
    },
    async newContainerAllowed() {
      throw new Error("the health run opened SSH (newContainerAllowed)");
    },
  };
}

// Production's shape: master switch on, both farms on contabo, the shipped
// 1500 MB gate, a server up two days.
function deps(over = {}) {
  return {
    settings: {
      getAutoFarm: () => ({ enabled: true, hostId: "contabo", hostMinFreeMb: 1500 }),
    },
    uptimeMs: () => 2 * 24 * HOUR,
    hostCapacity: ramGate({ contabo: { availableMb: 4800, at: ago(3 * MIN) } }),
    ...hooks(),
    ...over,
  };
}

async function runCheck(id, d, opts = {}) {
  const run = await health.runAll({ only: [id], deps: d, now, ...opts });
  assert.equal(run.checks.length, 1, "expected exactly one check for " + id);
  return run.checks[0];
}

const row = (check, loop) => check.items.find((i) => i.loop === loop);

// Every farm-side module this check reads in the server, by file.
const FARM_MODULE_FILES = [
  path.join("utils", "autoFarmer.js"),
  path.join("utils", "farm2", "supervisor.js"),
  path.join("utils", "unclaimedAllocator.js"),
  path.join("utils", "demandBrain", "index.js"),
  path.join("utils", "hostCapacity.js"),
];
const loadedFarmModules = () =>
  Object.keys(require.cache).filter((file) => FARM_MODULE_FILES.some((f) => file.endsWith(f)));

/* ========================================================================== *
 * judgeLoop — the rule, on its own
 * ========================================================================== */

test("a loop is ok within 2.5 intervals, warns up to 6, fails beyond", () => {
  const judge = (ageMin, intervalMin = 10) =>
    health.judgeLoop({ lastAt: ago(ageMin * MIN), intervalMin, now: NOW, uptimeMs: 2 * 24 * HOUR })
      .status;
  assert.equal(judge(4), "ok");
  assert.equal(judge(25), "ok", "exactly 2.5 intervals is still inside the budget");
  assert.equal(judge(26), "warn");
  assert.equal(judge(60), "warn", "exactly 6 intervals still only warns");
  assert.equal(judge(61), "fail");
  // The same rule scales with the loop: the hourly allocator gets hours.
  assert.equal(judge(140, 60), "ok");
  assert.equal(judge(5 * 60, 60), "warn");
  assert.equal(judge(7 * 60, 60), "fail");
});

test("in the first 15 minutes after a restart no loop is late", () => {
  // farm2 ticks every 3 min, so 2.5 intervals is 7.5 min — shorter than a
  // busy boot. Ten minutes in, with no pass yet, it is not proved, not late.
  const first = health.judgeLoop({ lastAt: null, intervalMin: 3, now: NOW, uptimeMs: 10 * MIN });
  assert.equal(first.status, "pending");
  assert.equal(first.inGrace, true);
  // One pass a minute after boot and none for 9 minutes: still inside the grace.
  assert.equal(
    health.judgeLoop({ lastAt: ago(9 * MIN), intervalMin: 3, now: NOW, uptimeMs: 10 * MIN }).status,
    "ok",
  );
});

test("a loop with no pass since the restart is timed from the restart", () => {
  // The trap loops.alive was built around: an in-memory stamp is empty after
  // every restart, so read naively a loop that died before a restart would
  // look merely "not run yet" forever. Timed from the restart, it cannot hide
  // for longer than its own budget.
  const never = (uptimeMin, intervalMin) =>
    health.judgeLoop({ lastAt: null, intervalMin, now: NOW, uptimeMs: uptimeMin * MIN }).status;
  assert.equal(never(16, 3), "warn", "past the grace and past 2.5 x 3 min");
  assert.equal(never(19, 3), "fail", "past 6 x 3 min");
  assert.equal(never(20, 10), "pending", "the 10-min tick is not due until 25 min");
  assert.equal(never(2 * 60, 60), "pending", "the hourly allocator inside its 2.5 h");
  assert.equal(never(3 * 60, 60), "warn");
  assert.equal(never(7 * 60, 60), "fail");
});

test("a stamp older than the process is not this process's evidence", () => {
  // A stamp from before the restart can only have been carried over. It must
  // neither fail a loop that has had no chance yet nor vouch for one.
  const fresh = health.judgeLoop({ lastAt: ago(3 * HOUR), intervalMin: 10, now: NOW, uptimeMs: 5 * MIN });
  assert.equal(fresh.status, "pending");
  assert.equal(fresh.ranSinceStart, false);
  const later = health.judgeLoop({ lastAt: ago(3 * HOUR), intervalMin: 10, now: NOW, uptimeMs: 30 * MIN });
  assert.equal(later.status, "warn", "30 min after the restart with no pass of its own");
});

test("off is off whatever the stamp says, and nothing to time is unknown", () => {
  assert.equal(
    health.judgeLoop({ lastAt: ago(30 * 24 * HOUR), intervalMin: 10, enabled: false, now: NOW, uptimeMs: HOUR })
      .status,
    "off",
  );
  // No pass on record and no idea when the process started: never ok.
  assert.equal(health.judgeLoop({ lastAt: null, intervalMin: 10, now: NOW, uptimeMs: null }).status, "unknown");
  // No usable interval: nothing to compare against.
  assert.equal(health.judgeLoop({ lastAt: ago(MIN), intervalMin: 0, now: NOW, uptimeMs: HOUR }).status, "unknown");
});

test("a stamp reads the same as a Date, an ISO string or epoch ms — junk is no stamp", () => {
  const t = NOW.getTime();
  assert.equal(health.stampMs(NOW), t);
  assert.equal(health.stampMs(NOW.toISOString()), t);
  assert.equal(health.stampMs(t), t);
  assert.equal(health.stampMs("not a date"), null);
  assert.equal(health.stampMs(new Date("nope")), null);
  assert.equal(health.stampMs(null), null);
  assert.equal(health.stampMs(""), null);
});

/* ========================================================================== *
 * loops.farm
 * ========================================================================== */

test("REGRESSION (defect 7): a dead no-claim allocator turns the board red", async () => {
  // Its only heartbeat was a console line: it could stop and every card stayed
  // green. Seven hours without a pass is past 6 x its hourly interval.
  const check = await runCheck(
    "loops.farm",
    deps(hooks({ allocator: { lastRun: ago(7 * HOUR), intervalMin: 60 } })),
  );
  assert.equal(check.status, "fail");
  assert.equal(check.measured, 3, "the other three still proved a pass");
  assert.match(check.summary, /^No-claim fleet allocator \(last pass: 7h 0m ago\) has done no pass/);
  const allocator = row(check, "unclaimedAllocator");
  assert.equal(allocator.status, "fail");
  assert.equal(allocator.okWithin, "2h 30m");
  assert.equal(allocator.intervalMin, 60);
  assert.equal(allocator.lastAt.getTime(), ago(7 * HOUR).getTime());
});

test("all four loops ticking is ok, and every row shows its working", async () => {
  const check = await runCheck("loops.farm", deps());
  assert.equal(check.status, "ok");
  assert.equal(check.group, "loops");
  assert.equal(check.measured, 4);
  assert.equal(check.items.length, 4);
  assert.deepEqual(
    check.items.map((i) => i.loop),
    ["autoFarmer", "farm2", "unclaimedAllocator", "demandBrain"],
  );
  for (const i of check.items) {
    assert.equal(i.status, "ok", i.loop);
    assert.match(i.last, / ago$/, i.loop);
    assert.ok(i.okWithin, i.loop + " states its budget");
    assert.equal(i.note, null, i.loop + " has nothing to explain");
  }
  assert.equal(row(check, "farm2").okWithin, "7m");
  assert.match(check.summary, /4 of 4 enabled farm loop\(s\) proved a recent pass/);
  assert.match(check.threshold, /^4 enabled loop\(s\), each with a pass within 2\.5× its interval/);
  // The basis line names the evidence — in-memory hooks, not the DB.
  assert.match(check.detail, /in-memory stamp/);
  assert.match(check.detail, /no DB read and no SSH/);
});

test("a late loop warns and says by how much", async () => {
  const check = await runCheck(
    "loops.farm",
    deps(hooks({ farm2: { lastRun: ago(12 * MIN), intervalMin: 3, enabled: true } })),
  );
  assert.equal(check.status, "warn");
  assert.match(
    check.summary,
    /^Farm2 lane supervisor \(last pass: 12m ago, ok within 7m\) running late/,
  );
});

test("a loop switched off is off, never failing, and leaves the colour alone", async () => {
  const check = await runCheck(
    "loops.farm",
    deps(
      hooks({
        autoFarm: { lastTickAt: ago(5 * 24 * HOUR), intervalMin: 10, enabled: false },
        brain: { lastRunAt: null, intervalMin: 60, enabled: false },
      }),
    ),
  );
  assert.equal(check.status, "ok");
  assert.equal(row(check, "autoFarmer").status, "off");
  assert.equal(row(check, "demandBrain").status, "off");
  assert.equal(row(check, "autoFarmer").okWithin, null, "an off loop has no budget to show");
  assert.equal(check.measured, 2);
  assert.match(check.threshold, /^2 enabled loop\(s\)/);
  assert.match(check.summary, /auto-farm tick \(legacy engine\), farm brain \(test log\) off/);
});

test("loops switched off never make up for one that could not be read", async () => {
  // The allocator has no off state, so it is always judged: unreadable, it
  // keeps the card unknown however many of the others are switched off.
  const check = await runCheck(
    "loops.farm",
    deps({
      ...hooks({
        autoFarm: { lastTickAt: null, intervalMin: 10, enabled: false },
        farm2: { lastRun: null, intervalMin: 3, enabled: false },
        brain: { lastRunAt: null, intervalMin: 60, enabled: false },
      }),
      unclaimedAllocator: null,
    }),
  );
  assert.equal(check.status, "unknown", "three loops off and one unread is not a clean bill");
  assert.equal(row(check, "unclaimedAllocator").status, "unknown");
  for (const id of ["autoFarmer", "farm2", "demandBrain"]) assert.equal(row(check, id).status, "off");
});

test("the brain is judged only when it is switched on", async () => {
  // Without `enabled: true` it logs nothing by design, so a stale stamp is
  // not a dead brain.
  let check = await runCheck(
    "loops.farm",
    deps(hooks({ brain: { lastRunAt: ago(2 * 24 * HOUR), intervalMin: 60 } })),
  );
  assert.equal(row(check, "demandBrain").status, "off");
  assert.equal(check.status, "ok");
  // Switched on, the same stamp is a dead loop.
  check = await runCheck(
    "loops.farm",
    deps(hooks({ brain: { lastRunAt: ago(2 * 24 * HOUR), intervalMin: 60, enabled: true } })),
  );
  assert.equal(row(check, "demandBrain").status, "fail");
  assert.equal(check.status, "fail");
});

test("farm2 is idle by design while the master auto-farm switch is off", async () => {
  // A farm2 cycle does nothing while autoFarm.enabled is false (§A3 fix 3),
  // whatever farm2Enabled says; its stale stamp then is the design.
  const stale = hooks({ farm2: { lastRun: ago(6 * HOUR), intervalMin: 3, enabled: true } });
  let check = await runCheck(
    "loops.farm",
    deps({ ...stale, settings: { getAutoFarm: () => ({ enabled: false, hostId: "contabo" }) } }),
  );
  assert.equal(row(check, "farm2").status, "off");
  assert.match(row(check, "farm2").note, /master auto-farm switch/);
  assert.notEqual(check.status, "fail");
  // With the master switch on, the same stamp is a dead supervisor.
  check = await runCheck("loops.farm", deps(stale));
  assert.equal(row(check, "farm2").status, "fail");
  // An unreadable settings file must not excuse it either.
  check = await runCheck(
    "loops.farm",
    deps({ ...stale, settings: { getAutoFarm: () => { throw new Error("torn settings.json"); } } }),
  );
  assert.equal(row(check, "farm2").status, "fail");
});

test("the allocator has no off state: its status() flags are never read as off", async () => {
  // It measures every pass and only ACTS when autoFarm.noclaimAutoSize is on,
  // so a flag on its status must not silence a stopped loop.
  const check = await runCheck(
    "loops.farm",
    deps(hooks({ allocator: { lastRun: ago(8 * HOUR), intervalMin: 60, enabled: false } })),
  );
  assert.equal(row(check, "unclaimedAllocator").status, "fail");
});

test("a hook that is missing, throws, answers nothing or is not loaded is unknown for that loop alone", async () => {
  const check = await runCheck(
    "loops.farm",
    deps({
      autoFarmer: {}, // the owner has not exported loopStatus() yet
      farm2Supervisor: {
        loopStatus() {
          throw new Error("boom");
        },
      },
      unclaimedAllocator: { status: () => undefined },
      demandBrain: null, // not loaded in this process
    }),
  );
  assert.equal(row(check, "autoFarmer").status, "unknown");
  assert.match(row(check, "autoFarmer").note, /autoFarmer\.loopStatus\(\) is not exported/);
  assert.equal(row(check, "farm2").status, "unknown");
  assert.match(row(check, "farm2").note, /threw: boom/);
  assert.equal(row(check, "unclaimedAllocator").status, "unknown");
  assert.match(row(check, "unclaimedAllocator").note, /returned no status/);
  assert.equal(row(check, "demandBrain").status, "unknown");
  assert.match(row(check, "demandBrain").note, /not loaded in this process/);
  assert.equal(check.status, "unknown", "nothing measured a fault, so nothing may fail");
  assert.equal(check.measured, 0);
  assert.match(check.summary, /could not be read/);
});

test("one unreadable hook leaves the other loops judged", async () => {
  const check = await runCheck("loops.farm", deps({ demandBrain: {} }));
  assert.equal(row(check, "demandBrain").status, "unknown");
  assert.equal(row(check, "unclaimedAllocator").status, "ok");
  assert.equal(check.measured, 3);
  // unknown darkens a green card...
  assert.equal(check.status, "unknown");
  // ...but never outranks a real problem next to it.
  const mixed = await runCheck(
    "loops.farm",
    deps({
      ...hooks({ allocator: { lastRun: ago(9 * HOUR), intervalMin: 60 } }),
      demandBrain: {},
    }),
  );
  assert.equal(row(mixed, "demandBrain").status, "unknown");
  assert.equal(mixed.status, "fail", "a dead loop outranks an unreadable one");
});

test("a hook that turned async is still read, not taken for a loop with no stamp", async () => {
  const check = await runCheck(
    "loops.farm",
    deps({ unclaimedAllocator: { status: async () => ({ lastRun: ago(10 * MIN), intervalMin: 60 }) } }),
  );
  assert.equal(row(check, "unclaimedAllocator").status, "ok");
});

test("a hook without intervalMin is judged on production's cadence, and says so", async () => {
  const check = await runCheck(
    "loops.farm",
    deps(hooks({ allocator: { lastRun: ago(3 * HOUR) } })),
  );
  const allocator = row(check, "unclaimedAllocator");
  assert.equal(allocator.intervalMin, 60);
  assert.equal(allocator.status, "warn", "3 h is past 2.5 x the hourly cadence");
  assert.match(allocator.note, /no intervalMin — judged on production's 60 min/);
});

test("right after a restart nothing has run: unknown — never ok, never fail", async () => {
  const check = await runCheck(
    "loops.farm",
    deps({
      uptimeMs: () => 2 * MIN,
      ...hooks({
        autoFarm: { lastTickAt: null, intervalMin: 10, enabled: true },
        farm2: { lastRun: null, intervalMin: 3, enabled: true },
        allocator: { lastRun: null, intervalMin: 60 },
        brain: { lastRunAt: null, intervalMin: 60, enabled: true },
      }),
    }),
  );
  assert.equal(check.status, "unknown");
  assert.equal(check.measured, 0);
  for (const i of check.items) {
    assert.equal(i.status, "pending", i.loop);
    assert.match(i.note, /grace after a restart/, i.loop);
  }
  assert.match(check.summary, /not run since the server started 2m ago — not due yet/);
});

test("the first hourly run after a restart: the brain not due yet is no red", async () => {
  // systemHealthRoutes runs 5 min after boot; the allocator starts at +3 min
  // and the brain at +6 min (FARM-DISTRIBUTION-MAP §3.4).
  const check = await runCheck(
    "loops.farm",
    deps({
      uptimeMs: () => 5 * MIN,
      ...hooks({
        autoFarm: { lastTickAt: ago(4 * MIN), intervalMin: 10, enabled: true },
        farm2: { lastRun: ago(1 * MIN), intervalMin: 3, enabled: true },
        allocator: { lastRun: ago(2 * MIN), intervalMin: 60 },
        brain: { lastRunAt: null, intervalMin: 60, enabled: true },
      }),
    }),
  );
  assert.equal(check.status, "ok");
  assert.equal(check.measured, 3);
  assert.equal(row(check, "demandBrain").status, "pending");
  assert.equal(row(check, "demandBrain").last, "none since the server started 5m ago");
  assert.match(check.summary, /farm brain \(test log\) not run since the server started 5m ago/);
});

test("a dead loop cannot hide behind a restart for longer than its budget", async () => {
  // The supervisor died and the server restarted 25 minutes ago: no stamp at
  // all in this process. 25 min is past 6 x 3 min, so it fails.
  const check = await runCheck(
    "loops.farm",
    deps({
      uptimeMs: () => 25 * MIN,
      ...hooks({ farm2: { lastRun: null, intervalMin: 3, enabled: true } }),
    }),
  );
  assert.equal(row(check, "farm2").status, "fail");
  assert.equal(row(check, "farm2").last, "none since the server started 25m ago");
  assert.equal(check.status, "fail");
});

test("outside the server the check says unknown and never loads a farm module", async () => {
  // A CLI run or a test holds none of the loops. Loading a fresh copy of
  // utils/autoFarmer here would hand back a module with no stamp at all — a
  // dead loop invented by the act of looking.
  assert.deepEqual(loadedFarmModules(), [], "precondition: no farm module loaded in this test");
  // Every load ATTEMPT is recorded, not just a load that succeeded: a module
  // that throws while loading leaves nothing in require.cache behind it.
  const attempted = [];
  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (/(^|[\\/])(autoFarmer|supervisor|unclaimedAllocator|demandBrain|hostCapacity)(\.js)?$/.test(String(request))) {
      attempted.push(String(request));
    }
    return realLoad.call(this, request, ...rest);
  };
  let loops;
  let ram;
  const settings = { getAutoFarm: () => ({ enabled: true, hostId: "contabo", hostMinFreeMb: 1500 }) };
  try {
    loops = await runCheck("loops.farm", { settings, uptimeMs: () => 2 * HOUR });
    ram = await runCheck("hosts.ram", { settings });
  } finally {
    Module._load = realLoad;
  }
  assert.deepEqual(attempted, [], "the health run tried to load a farm module of its own");
  assert.deepEqual(loadedFarmModules(), [], "the health run loaded a farm module of its own");
  assert.equal(loops.status, "unknown");
  for (const i of loops.items) {
    assert.equal(i.status, "unknown", i.loop);
    assert.match(i.note, /not loaded in this process/, i.loop);
  }
  assert.equal(ram.status, "unknown");
  assert.equal(ram.measured, null);
  assert.match(ram.summary, /contabo: no reading/);
});

test("loadedModule hands back the instance already loaded, and never loads one", () => {
  assert.equal(health.loadedModule("./systemHealth"), health, "the very instance this test holds");
  assert.equal(health.loadedModule("./no-such-module-for-this-test"), null);
  // On disk but not loaded here: null, and still not loaded afterwards.
  assert.equal(health.loadedModule("./autoFarmer"), null);
  assert.deepEqual(loadedFarmModules(), []);
});

/* ========================================================================== *
 * hosts.ram
 * ========================================================================== */

test("RAM against the gate: ok, warn under 1.5x the line, fail under it", async () => {
  const ram = async (mb) =>
    (
      await runCheck(
        "hosts.ram",
        deps({ hostCapacity: ramGate({ contabo: { availableMb: mb, at: ago(2 * MIN) } }) }),
      )
    ).status;
  assert.equal(await ram(4800), "ok");
  assert.equal(await ram(2250), "ok", "at 1.5x the line is not under it");
  assert.equal(await ram(2249), "warn");
  assert.equal(await ram(1500), "warn", "at the line the gate still lets a container through");
  assert.equal(await ram(1499), "fail");
});

test("REGRESSION (defect 16): a host under the gate fails and says what it stops", async () => {
  const check = await runCheck(
    "hosts.ram",
    deps({ hostCapacity: ramGate({ contabo: { availableMb: 900, at: ago(2 * MIN) } }) }),
  );
  assert.equal(check.status, "fail");
  assert.equal(check.group, "capacity");
  assert.equal(check.measured, 900);
  assert.equal(check.threshold, "warn under 2250 MB, fail under 1500 MB available (autoFarm.hostMinFreeMb, the new-container gate)");
  assert.match(check.summary, /^contabo has 900 MB available — under the 1500 MB gate, so the farms start no new bot there$/);
  // Both farms build on contabo in production: one row, naming both.
  assert.equal(check.items.length, 1);
  assert.equal(check.items[0].farms, "auto-farm + no-claim");
  assert.equal(check.items[0].read, "2m ago");
  assert.match(check.detail, /never opens SSH/);
});

test("a healthy reading is ok and names its age", async () => {
  const check = await runCheck("hosts.ram", deps());
  assert.equal(check.status, "ok");
  assert.equal(check.measured, 4800);
  assert.equal(check.summary, "contabo has 4800 MB available (read 3m ago)");
});

test("no reading is unknown, never ok", async () => {
  // Readings exist only once a farm has asked the gate; after a restart, or
  // with nothing wanting a new container, there is no figure at all.
  const gate = ramGate({});
  const check = await runCheck("hosts.ram", deps({ hostCapacity: gate }));
  assert.equal(check.status, "unknown");
  assert.equal(check.measured, null);
  assert.match(check.summary, /^contabo: no reading — no farm has asked the new-container gate/);
  assert.deepEqual(gate.asked, ["contabo"]);
  // utils/hostCapacity not loaded in this process (nothing has asked it): the same.
  const unloaded = await runCheck("hosts.ram", deps({ hostCapacity: null }));
  assert.equal(unloaded.status, "unknown");
  assert.match(unloaded.summary, /no reading/);
  // A reading whose read failed carries no figure.
  const failed = await runCheck(
    "hosts.ram",
    deps({ hostCapacity: ramGate({ contabo: { availableMb: null, at: ago(MIN) } }) }),
  );
  assert.equal(failed.status, "unknown");
  assert.match(failed.summary, /last read of this host failed/);
});

test("an old reading is shown, never judged — it can neither cry wolf nor stay green", async () => {
  const low = await runCheck(
    "hosts.ram",
    deps({ hostCapacity: ramGate({ contabo: { availableMb: 600, at: ago(3 * HOUR) } }) }),
  );
  assert.equal(low.status, "unknown");
  assert.equal(low.items[0].availableMb, 600, "the figure is still shown");
  assert.match(low.items[0].note, /reading is 3h 0m old — shown, not judged/);
  const high = await runCheck(
    "hosts.ram",
    deps({ hostCapacity: ramGate({ contabo: { availableMb: 9000, at: ago(3 * HOUR) } }) }),
  );
  assert.equal(high.status, "unknown");
  // Inside the window it is judged as usual.
  const recent = await runCheck(
    "hosts.ram",
    deps({ hostCapacity: ramGate({ contabo: { availableMb: 600, at: ago(health.HOST_RAM_STALE_MS - MIN) } }) }),
  );
  assert.equal(recent.status, "fail");
});

test("a broken RAM cache is unknown with its reason, never a crash", async () => {
  const noExport = await runCheck("hosts.ram", deps({ hostCapacity: {} }));
  assert.equal(noExport.status, "unknown");
  assert.match(noExport.summary, /lastReading\(\) is not exported/);
  const throws = await runCheck(
    "hosts.ram",
    deps({
      hostCapacity: {
        lastReading() {
          throw new Error("cache gone");
        },
      },
    }),
  );
  assert.equal(throws.status, "unknown");
  assert.match(throws.summary, /threw: cache gone/);
});

test("with the gate switched off the reading is shown and nothing is judged against it", async () => {
  const check = await runCheck(
    "hosts.ram",
    deps({
      settings: { getAutoFarm: () => ({ enabled: true, hostId: "contabo", hostMinFreeMb: 0 }) },
      hostCapacity: ramGate({ contabo: { availableMb: 300, at: ago(MIN) } }),
    }),
  );
  assert.equal(check.status, "ok");
  assert.equal(check.measured, 300);
  assert.match(check.threshold, /RAM gate is off/);
  assert.match(check.summary, /gate off/);
});

test("a missing or junk hostMinFreeMb is the shipped 1500, never a laxer line", async () => {
  assert.equal(health.hostMinFreeMbOf({}), 1500);
  assert.equal(health.hostMinFreeMbOf(null), 1500);
  assert.equal(health.hostMinFreeMbOf({ hostMinFreeMb: "" }), 1500);
  assert.equal(health.hostMinFreeMbOf({ hostMinFreeMb: "lots" }), 1500);
  assert.equal(health.hostMinFreeMbOf({ hostMinFreeMb: "2000" }), 2000);
  assert.equal(health.hostMinFreeMbOf({ hostMinFreeMb: 0 }), 0);
  assert.equal(health.hostMinFreeMbOf({ hostMinFreeMb: -5 }), 0);
  // Settings written before the key existed: judged on 1500.
  const check = await runCheck(
    "hosts.ram",
    deps({
      settings: { getAutoFarm: () => ({ enabled: true, hostId: "contabo" }) },
      hostCapacity: ramGate({ contabo: { availableMb: 1400, at: ago(MIN) } }),
    }),
  );
  assert.equal(check.status, "fail");
  // And settings that cannot be read at all: the same line, not a crash.
  const torn = await runCheck(
    "hosts.ram",
    deps({
      settings: { getAutoFarm: () => { throw new Error("torn settings.json"); } },
      hostCapacity: ramGate({ contabo: { availableMb: 1400, at: ago(MIN) } }),
    }),
  );
  assert.equal(torn.status, "fail");
});

test("each farm host is covered, and the worse one decides", async () => {
  const gate = ramGate({
    contabo: { availableMb: 5000, at: ago(MIN) },
    pi: { availableMb: 1000, at: ago(MIN) },
  });
  const check = await runCheck(
    "hosts.ram",
    deps({
      settings: { getAutoFarm: () => ({ enabled: true, hostId: "pi", hostMinFreeMb: 1500 }) },
      hostCapacity: gate,
    }),
  );
  assert.deepEqual(gate.asked.slice().sort(), ["contabo", "pi"]);
  assert.deepEqual(
    check.items.map((i) => [i.label, i.farms, i.status]),
    [
      ["pi", "auto-farm", "fail"],
      ["contabo", "no-claim", "ok"],
    ],
  );
  assert.equal(check.status, "fail");
  assert.equal(check.measured, 1000, "the binding host is the one measured");
  assert.match(check.summary, /^pi has 1000 MB available/, "worst host first");
});

test("a blank hostId is resolved the way the engine resolves it", async () => {
  // autoFarm.hostId "" means "the first ssh host" to the engine — that was the
  // Pi until 09-20 — so the check asks the engine instead of guessing.
  const gate = ramGate({
    pi: { availableMb: 5000, at: ago(MIN) },
    contabo: { availableMb: 5000, at: ago(MIN) },
  });
  const engine = { ...hooks().autoFarmer, resolveFarmHost: () => ({ id: "pi", label: "Pi" }) };
  const check = await runCheck(
    "hosts.ram",
    deps({
      settings: { getAutoFarm: () => ({ enabled: true, hostId: "", hostMinFreeMb: 1500 }) },
      autoFarmer: engine,
      hostCapacity: gate,
    }),
  );
  assert.deepEqual(check.items.map((i) => i.label), ["pi", "contabo"]);
  // The engine not loaded here: only the no-claim host can be named.
  const alone = await runCheck(
    "hosts.ram",
    deps({
      settings: { getAutoFarm: () => ({ enabled: true, hostId: "" }) },
      autoFarmer: null,
      hostCapacity: gate,
    }),
  );
  assert.deepEqual(alone.items.map((i) => [i.label, i.farms]), [["contabo", "no-claim"]]);
});

/* ========================================================================== *
 * The page contract and the read-only rule
 * ========================================================================== */

// The page's own row renderer, lifted out of public/system-health.html so a
// row is read here exactly the way the owner reads it: `label`, then the first
// three plain, non-null fields.
function pageItemText() {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "system-health.html"), "utf8");
  const start = html.indexOf("function itemText(");
  assert.ok(start >= 0, "the page's itemText() was not found");
  let depth = 0;
  let end = -1;
  for (let i = html.indexOf("{", start); i < html.length; i += 1) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > start, "the page's itemText() could not be lifted out");
  return new Function(html.slice(start, end) + "\nreturn itemText;")();
}

test("on the page every row shows its status, its evidence, and the reason when there is one", async () => {
  const itemText = pageItemText();
  const loops = await runCheck(
    "loops.farm",
    deps({
      ...hooks({ autoFarm: { lastTickAt: null, intervalMin: 10, enabled: false } }),
      demandBrain: null,
    }),
  );
  assert.equal(itemText(row(loops, "farm2")), "farm2 lane supervisor · status=ok · last=1m ago · okWithin=7m");
  assert.equal(itemText(row(loops, "autoFarmer")), "auto-farm tick (legacy engine) · status=off · last=never · note=switched off in settings");
  assert.match(itemText(row(loops, "demandBrain")), /^farm brain \(test log\) · status=unknown · note=not loaded in this process/);
  const ram = await runCheck("hosts.ram", deps({ hostCapacity: ramGate({}) }));
  assert.match(itemText(ram.items[0]), /^contabo · status=unknown · read=never · note=no reading/);
  const ok = await runCheck("hosts.ram", deps());
  assert.equal(itemText(ok.items[0]), "contabo · status=ok · availableMb=4800 · read=3m ago");
});

test("both checks are registered once and answer the page's contract", async () => {
  const ids = health.CHECKS.map((c) => c.id);
  for (const id of ["loops.farm", "hosts.ram"]) {
    assert.equal(ids.filter((x) => x === id).length, 1, id + " registered exactly once");
  }
  for (const id of ["loops.farm", "hosts.ram"]) {
    const c = await runCheck(id, deps());
    assert.ok(health.STATUSES.includes(c.status), id);
    assert.ok(["critical", "warn", "info"].includes(c.severity), id);
    assert.ok(c.title && c.group && c.summary.length, id);
    assert.ok(typeof c.threshold === "string" && c.threshold.length, id + " threshold");
    assert.notEqual(c.measured, null, id + " gave a verdict with no number");
    assert.ok(Array.isArray(c.items) && c.items.length <= health.ITEM_CAP, id);
    // The page prints `label` first, then the first three plain fields:
    // the status and the evidence must be among them.
    const keys = Object.keys(c.items[0]);
    assert.equal(keys[0], "label", id);
    assert.equal(keys[1], "status", id);
  }
});

test("in the server, the checks read the very instances the loops run in", async () => {
  // The production path, nothing injected: each farm module must be found by
  // the path the server loaded it under. A wrong path would answer "not loaded"
  // on a healthy server — unknown, every hour, for ever. Instances are planted
  // in require.cache the way the server holds them; the real modules are never
  // loaded, and everything planted is removed again.
  const planted = [];
  const plant = (rel, exports) => {
    let file;
    try {
      file = require.resolve(path.join(__dirname, "..", "utils", rel));
    } catch {
      return false; // not on disk in this tree
    }
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
    planted.push(file);
    return true;
  };
  try {
    const h = hooks();
    for (const [rel, dep] of [
      ["autoFarmer", "autoFarmer"],
      ["farm2/supervisor", "farm2Supervisor"],
      ["unclaimedAllocator", "unclaimedAllocator"],
      ["demandBrain", "demandBrain"],
    ]) {
      assert.ok(plant(rel, h[dep]), "utils/" + rel + " is not on disk");
    }
    const gateOnDisk = plant("hostCapacity", ramGate({ contabo: { availableMb: 4800, at: ago(MIN) } }));
    const settings = { getAutoFarm: () => ({ enabled: true, hostId: "contabo", hostMinFreeMb: 1500 }) };

    const loops = await runCheck("loops.farm", { settings, uptimeMs: () => 2 * 24 * HOUR });
    assert.equal(loops.status, "ok");
    assert.equal(loops.measured, 4, "every planted hook was found and read");

    const ram = await runCheck("hosts.ram", { settings });
    if (gateOnDisk) {
      assert.equal(ram.status, "ok");
      assert.equal(ram.measured, 4800, "the planted gate cache was found and read");
    } else {
      // utils/hostCapacity not written yet in this tree: nothing to find.
      assert.equal(ram.status, "unknown");
      assert.match(ram.summary, /no reading/);
    }
  } finally {
    for (const file of planted) delete require.cache[file];
  }
});

test("the health run takes no reading of its own: no SSH, no live probe", () => {
  // §A6: the hooks and hostCapacity.lastReading only. memAvailableMb and
  // newContainerAllowed each open an SSH session to the host.
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "systemHealth.js"), "utf8");
  for (const re of [/\bmemAvailableMb\s*\(/, /\bnewContainerAllowed\s*\(/, /\brunShell\s*\(/, /\bexecSync\s*\(/]) {
    const hit = src.match(re);
    assert.equal(hit, null, "systemHealth.js takes a live reading: " + (hit && hit[0]));
  }
});
