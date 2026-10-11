// utils/farmOps (2026-10-11): one structural auto-farm operation at a time —
// and that the engine's structural steps really do go through it.
process.env.TG_TOKEN = "";
const test = require("node:test");
const assert = require("node:assert/strict");

const farmOps = require("../utils/farmOps");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function gate() {
  let open;
  const closed = new Promise((r) => { open = r; });
  return { closed, open };
}
// Until `n` steps are queued behind the one in progress (each caller does some
// database work of its own before it asks for the turn), then a little longer
// so that one which was NOT going to wait has had time to show it.
async function queued(n) {
  const deadline = Date.now() + 5000;
  while (farmOps.status().waiting < n && Date.now() < deadline) await sleep(5);
  await sleep(40);
}

test("steps run one at a time, in the order they arrived", async () => {
  const seen = [];
  const step = (name, ms) =>
    farmOps.run(name, async () => {
      seen.push(name + ":in");
      await sleep(ms);
      seen.push(name + ":out");
      return name;
    });
  const results = await Promise.all([step("repack", 15), step("place", 1), step("end", 5)]);
  assert.deepEqual(results, ["repack", "place", "end"]);
  assert.deepEqual(seen, ["repack:in", "repack:out", "place:in", "place:out", "end:in", "end:out"]);
  assert.deepEqual(farmOps.status(), { busy: null, waiting: 0 });
});

test("a step that fails rejects its own caller and the next one still runs", async () => {
  const bad = farmOps.run("bad", async () => { throw new Error("boom"); });
  const good = farmOps.run("good", async () => "fine");
  await assert.rejects(bad, /boom/);
  assert.equal(await good, "fine");
  await assert.rejects(farmOps.run("throws at once", () => { throw new Error("sync"); }), /sync/);
  assert.equal(await farmOps.run("after", async () => "still fine"), "still fine");
});

test("a step that calls another runs it inline — it already has the turn", async () => {
  const order = [];
  const r = await farmOps.run("reuse", async () => {
    order.push("reuse");
    const topUp = await farmOps.run("top-up", async () => {
      order.push("top-up, status says: " + farmOps.status().busy.label);
      return 3;
    });
    order.push("after top-up");
    return topUp + 1;
  });
  assert.equal(r, 4);
  assert.deepEqual(order, ["reuse", "top-up, status says: reuse", "after top-up"]);
});

test("work a step starts and does not await takes its own turn once the step is over", async () => {
  const g = gate();
  let later;
  await farmOps.run("first", async () => {
    later = (async () => {
      await g.closed;
      return farmOps.run("detached", async () => farmOps.status().busy.label);
    })();
  });
  const seen = [];
  const busy = farmOps.run("second", async () => { seen.push("second:in"); g.open(); await sleep(10); seen.push("second:out"); });
  assert.equal(await later, "detached", "it ran as a step of its own");
  await busy;
  assert.deepEqual(seen, ["second:in", "second:out"], "after the step that had the turn");
});

test("a step that cannot start in time is NOT started, and says what it waited for", async () => {
  const g = gate();
  const holder = farmOps.run("a long repack", () => g.closed);
  let ran = false;
  let next;
  try {
    const waiter = farmOps.run("placing SPAM", async () => { ran = true; }, { waitMs: 20 });
    const err = await Promise.race([waiter.then(() => null, (e) => e), sleep(2000).then(() => "never refused")]);
    assert.notEqual(err, "never refused");
    assert.ok(err, "it was refused");
    assert.equal(farmOps.isBusy(err), true);
    assert.equal(err.autoFarmEventRecorded, true, "the engines write no task_failed row for a step that never ran");
    assert.match(err.message, /busy with “a long repack”/);
    assert.match(err.message, /“placing SPAM” was not started/);
    assert.equal(ran, false);
    assert.equal(farmOps.status().waiting, 0, "and it is out of the queue");
    // The holder is untouched, and whoever comes next still gets its turn.
    next = farmOps.run("next", async () => "ran");
  } finally {
    g.open();
    await holder;
  }
  assert.equal(await next, "ran");
  assert.equal(farmOps.isBusy(new Error("anything else")), false);
});

test("a step that holds the turn too long is reported once, and nothing is pre-empted", async () => {
  const errors = [];
  const realError = console.error;
  console.error = (m) => errors.push(String(m));
  const g = gate();
  const holder = farmOps.run("stuck teardown", () => g.closed, { holdWarnMs: 15 });
  const behind = farmOps.run("placing", async () => "placed");
  try {
    await sleep(60);
    assert.equal(errors.filter((e) => e.includes("[farmOps]")).length, 1, "said once");
    assert.match(errors.find((e) => e.includes("[farmOps]")), /“stuck teardown” has held .* 1 step\(s\) are waiting/);
    assert.equal(farmOps.status().busy.label, "stuck teardown", "still holding — never pre-empted");
  } finally {
    console.error = realError;
    g.open();
    await holder;
  }
  assert.equal(await behind, "placed");
});

test("a step that had to wait runs in ITS caller's async context, not the context of the step that ended before it", async () => {
  // The step that ends starts the next one. Left in the ender's context, the
  // next step would see the ender's AsyncLocalStorage stores as its own — for
  // utils/fileLock that means believing it holds a config another writer holds.
  const { AsyncLocalStorage } = require("node:async_hooks");
  const who = new AsyncLocalStorage();
  const g = gate();
  const first = who.run("first caller", () => farmOps.run("first", () => g.closed));
  const second = who.run("second caller", () => farmOps.run("second", async () => who.getStore()));
  const third = farmOps.run("third", async () => who.getStore());
  g.open();
  await first;
  assert.equal(await second, "second caller");
  assert.equal(await third, undefined, "and a caller with no store gets none");
});

test("a caller that holds a bot config's lock is refused the turn", async () => {
  // The holder of the turn waits for files; a caller waiting for the turn
  // while holding one is the arrangement that can never finish.
  const { withFileLock } = require("../utils/fileLock");
  let ran = false;
  const err = await withFileLock({ id: "h" }, "config_01.json", () =>
    farmOps.run("placing from inside a lock", async () => { ran = true; }).then(() => null, (e) => e),
  );
  assert.ok(err);
  assert.match(err.message, /asked for the auto-farm turn while holding a bot config's lock/);
  assert.equal(farmOps.isBusy(err), false, "a mistake in the caller, not a wait");
  assert.equal(ran, false);
  assert.deepEqual(farmOps.status(), { busy: null, waiting: 0 });
  // The other way round is the design: files are taken inside the turn.
  assert.equal(await farmOps.run("a step", () => withFileLock({ id: "h" }, "config_01.json", async () => "fine")), "fine");
});

/* ---------------- the engine's steps really are behind it ----------------- */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const AutoFarmTask = require("../models/AutoFarmTask");
const autoFarmer = require("../utils/autoFarmer");
const executeStep = require("../utils/farm2/steps/execute");
const hosts = require("../utils/botHosts");
const settings = require("../utils/settings");

let mem;
let tmpDir;
const HOST = { id: "opshost", label: "Ops host", transport: "local", runtime: "docker", dir: "" };
const real = { getAutoFarm: settings.getAutoFarm, resolveHost: hosts.resolveHost };
const af = () => ({
  ...real.getAutoFarm.call(settings),
  enabled: true,
  dryRun: false,
  hostId: HOST.id,
  consolidate: true,
  probeColdStart: true,
});

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("farmops"));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "farm-ops-"));
  HOST.dir = tmpDir;
  hosts.resolveHost = (id) => (String(id) === HOST.id ? HOST : real.resolveHost(id));
  settings.getAutoFarm = af;
});
test.after(async () => {
  settings.getAutoFarm = real.getAutoFarm;
  hosts.resolveHost = real.resolveHost;
  await mongoose.disconnect();
  if (mem) await mem.stop();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Each of these is called while another structural step holds the turn. None
// may have finished — or failed — until that step ends.
test("placing a farm, and every janitor step, waits for the step in progress", async () => {
  const g = gate();
  const holder = farmOps.run("a repack in progress", () => g.closed);
  const settled = [];
  const watch = (name, p) =>
    p.then(
      () => settled.push(name),
      () => settled.push(name),
    );
  const task = await AutoFarmTask.create({ game: "Lock Game", campaignId: "lock-1", decision: "farm", status: "planned", plannedAccounts: 1 });
  let all = [];
  try {
    all = [
      watch("executeTask", autoFarmer.executeTask(task, { af: af(), host: HOST })),
      watch("completeEndedTasks", autoFarmer.completeEndedTasks()),
      watch("reapRetiredBots", autoFarmer.reapRetiredBots(af(), HOST, () => {})),
      watch("expireStaleProbes", autoFarmer.expireStaleProbes(af(), () => {})),
      watch("backfillActiveTasks", autoFarmer.backfillActiveTasks(af(), HOST, () => {})),
      watch("repackAutoBots", autoFarmer.repackAutoBots(af(), HOST, () => {})),
    ];
    await queued(6);
    assert.deepEqual(settled, [], "none of them finished — or failed — while the turn was taken");
    assert.equal(farmOps.status().waiting, 6);
  } finally {
    g.open();
    await holder;
    await Promise.all(all);
  }
  assert.deepEqual(
    settled,
    ["executeTask", "completeEndedTasks", "reapRetiredBots", "expireStaleProbes", "backfillActiveTasks", "repackAutoBots"],
    "each ran, in arrival order",
  );
});

test("the lane engine's execute step takes the turn BEFORE the cycle's host slot — fresh farm and reuse alike", async () => {
  // A placement waiting behind a repack must not sit on one of the two host
  // slots every other lane reads through.
  let slotsTaken = 0;
  const cycle = { withHost: async (fn) => { slotsTaken += 1; return fn(); } };
  const lane = { game: "Lane Game", gameKey: "lane game", mode: "live" };
  const verdict = (decision, campaignId) => ({
    game: "Lane Game",
    campaignId,
    campaignName: "Launch",
    campaignEndAt: new Date(Date.now() + 96 * 3600000),
    decision,
    plannedAccounts: 2,
    reason: "test",
  });
  const g = gate();
  const holder = farmOps.run("a repack in progress", () => g.closed);
  const settled = [];
  const watch = (name, p) =>
    p.then(
      () => settled.push(name),
      () => settled.push(name),
    );
  let all = [];
  try {
    all = [
      watch("fresh", executeStep.executeDecision({ verdict: verdict("farm", "lane-fresh"), lane, cycle, af: af(), shadow: false })),
      watch("reuse", executeStep.executeDecision({ verdict: verdict("reuse_existing", "lane-reuse"), lane, cycle, af: af(), shadow: false })),
    ];
    await queued(2);
    assert.deepEqual(settled, [], "neither started");
    assert.equal(slotsTaken, 0, "and neither is holding a host slot while it waits");
    assert.equal(farmOps.status().waiting, 2);
  } finally {
    g.open();
    await holder;
    await Promise.all(all);
  }
  assert.deepEqual(settled.slice().sort(), ["fresh", "reuse"]);
  assert.equal(slotsTaken, 2, "each took its slot once it had the turn");
});

test("a plan that is no longer 'planned' when its turn comes is not placed", async () => {
  // While a plan waits for the turn, the other engine or the Approve button
  // can place the very same row. Placed again, it claimed a second set of
  // accounts and overwrote the bots of the first.
  for (const [became, superseded] of [["active", "active"], ["skipped", "skipped"], [null, "gone"]]) {
    const task = await AutoFarmTask.create({ game: "Twice " + superseded, campaignId: "twice-" + superseded, decision: "farm", status: "planned", plannedAccounts: 2 });
    const g = gate();
    const holder = farmOps.run("a repack in progress", () => g.closed);
    let placing;
    try {
      placing = autoFarmer.executeTask(task, { af: af(), host: HOST });
      await queued(1);
      if (became) await AutoFarmTask.updateOne({ _id: task._id }, { $set: { status: became } });
      else await AutoFarmTask.deleteOne({ _id: task._id });
    } finally {
      g.open();
      await holder;
    }
    assert.deepEqual(await placing, { decision: "farm", bots: [], accounts: 0, superseded }, "nothing claimed, nothing placed");
    const row = await AutoFarmTask.findById(task._id).lean();
    assert.equal(row ? row.status : null, became, "and the row is as the other writer left it");
  }
  // Still planned: it is placed (here it gets as far as the empty pool).
  const task = await AutoFarmTask.create({ game: "Once", campaignId: "once-1", decision: "farm", status: "planned", plannedAccounts: 2 });
  await assert.rejects(autoFarmer.executeTask(task, { af: af(), host: HOST }), /Pool below reserve floor/);
  // The reuse top-up adds fresh accounts to a row that IS active: it goes ahead too.
  const reused = await AutoFarmTask.create({ game: "Topped", campaignId: "top-1", decision: "reuse_existing", status: "active", plannedAccounts: 2 });
  await assert.rejects(autoFarmer.executeTask(reused, { af: af(), host: HOST }, { append: true }), /Pool below reserve floor/);
});

test("the stranded-account sweep is behind its switch, and inside the turn", () => {
  const src = fs.readFileSync(require.resolve("../utils/autoFarmer.js"), "utf8");
  const uses = src.split('require("./armedAudit")').length - 1;
  assert.equal(uses, 1, "one place in the engine re-arms");
  const at = src.indexOf('require("./armedAudit")');
  const before = src.slice(0, at);
  const gate = before.lastIndexOf("if (af.rearmStranded === true) {");
  assert.ok(gate > 0, "behind autoFarm.rearmStranded");
  // Nothing closes that block between the switch and the sweep.
  assert.equal(/\n {6}\}\n/.test(before.slice(gate)), false, "the sweep sits inside the switch's block");
  assert.match(src.slice(at, at + 400), /janitorStep\("Re-arming stranded accounts", null,/);
});

test("autoFarm.farmOpsLock = false turns the turn-taking off live: a step starts at once", async () => {
  const g = gate();
  const holder = farmOps.run("a stuck step", () => g.closed);
  const saved = settings.getAutoFarm;
  try {
    // On (the default, and any value but false): it waits.
    let ran = false;
    const waits = farmOps.run("waits", async () => { ran = true; }, { waitMs: 20 }).then(() => null, (e) => e);
    assert.equal(farmOps.isBusy(await waits), true);
    assert.equal(ran, false);
    // Off: it runs beside the stuck one.
    settings.getAutoFarm = () => ({ ...af(), farmOpsLock: false });
    assert.equal(await farmOps.run("placing anyway", async () => "placed", { waitMs: 200 }), "placed");
    assert.equal(farmOps.status().busy.label, "a stuck step", "the holder is untouched");
  } finally {
    settings.getAutoFarm = saved;
    g.open();
    await holder;
  }
});

test("a dry-run reuse touches nothing, so it waits for nothing", async () => {
  const g = gate();
  const holder = farmOps.run("a repack in progress", () => g.closed);
  try {
    const r = await Promise.race([
      executeStep.executeDecision({
        verdict: { game: "Dry Game", campaignId: "dry-1", decision: "reuse_existing", plannedAccounts: 0, reason: "test" },
        lane: { game: "Dry Game", gameKey: "dry game", mode: "live" },
        cycle: null,
        af: { ...af(), dryRun: true },
        shadow: false,
      }).then(
        () => "settled",
        () => "settled",
      ),
      sleep(500).then(() => "still waiting"),
    ]);
    assert.equal(r, "settled");
  } finally {
    g.open();
    await holder;
  }
});

test("a janitor step that cannot get its turn is skipped for the tick, not failed", async () => {
  const realRun = farmOps.run;
  // The wait is ten minutes in production; here it is refused at once.
  farmOps.run = (label, fn, opts) => realRun(label, fn, { ...opts, waitMs: 5 });
  const g = gate();
  const holder = realRun("placing a farm", () => g.closed);
  try {
    assert.equal(await autoFarmer.completeEndedTasks(), 0);
    assert.equal(await autoFarmer.repackAutoBots(af(), HOST, () => {}), null);
    // And the tick's own log says why, as a warning.
    const said = autoFarmer.status().progress.steps.filter((s) => /skipped this tick/.test(s.msg));
    assert.deepEqual(
      said.map((s) => s.level + ": " + s.msg.replace(/\(\d+s so far\)/, "(Ns so far)")),
      [
        "warn: Ending finished campaigns skipped this tick: the auto-farm is busy with “placing a farm” (Ns so far) — “Ending finished campaigns” was not started.",
        "warn: Repacking auto bots skipped this tick: the auto-farm is busy with “placing a farm” (Ns so far) — “Repacking auto bots” was not started.",
      ],
    );
  } finally {
    farmOps.run = realRun;
    g.open();
    await holder;
  }
});

test("inside the engine file every call of a structural step goes through the turn", () => {
  // The functions keep their names and bodies (other tests pin them by reading
  // the source); what calls them is `structural.<name>`. A bare call added
  // later — in the tick, or anywhere else in the file — would run beside a
  // repack or a placement again, and nothing else would notice.
  const src = fs.readFileSync(require.resolve("../utils/autoFarmer.js"), "utf8");
  const from = src.indexOf("const structural = {");
  const to = src.indexOf("\n};\n", from);
  assert.ok(from > 0 && to > from, "the wrappers are in one block");
  const wrappers = src.slice(from, to);
  const rest = src.slice(0, from) + src.slice(to);
  const callsIn = (text, name) => {
    const calls = [];
    const re = new RegExp("(.{0,24})\\b" + name + "\\(", "g");
    for (const line of text.split("\n")) {
      if (line.trim().startsWith("//")) continue;
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(line))) calls.push(m[1].trim());
    }
    return calls;
  };
  for (const name of ["executeTask", "completeEndedTasks", "backfillActiveTasks", "reapRetiredBots", "expireStaleProbes", "repackAutoBots"]) {
    const calls = callsIn(rest, name);
    const bare = calls.filter((before) => !/(^|\s)async function$/.test(before) && !/structural\.$/.test(before));
    assert.deepEqual(bare, [], name + " is called without the turn");
    assert.ok(calls.some((before) => /structural\.$/.test(before)), name + " is called through the turn somewhere");
    assert.equal(callsIn(wrappers, name).length, 1, name + " has exactly one wrapper, which calls it once");
    assert.match(wrappers, new RegExp("\\n {2}" + name + ": "), name + " is wrapped");
  }
  assert.match(src, /\n {2}executeTask: structural\.executeTask,\n/, "and other modules get the wrapped placement");
  for (const name of ["completeEndedTasks", "reapRetiredBots", "repackAutoBots"]) {
    assert.match(src, new RegExp("\\n {2}" + name + ": structural\\." + name + ",\\n"));
  }
});
