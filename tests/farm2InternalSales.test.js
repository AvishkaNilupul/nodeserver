// `internalSales` is written on the two record() paths that omitted it.
//
// utils/autoFarmer.js processCampaign records internalSales on every path
// except reuse_existing (both the dry-run and the live record() call) and
// skip_host_offline. On those rows the field was the schema default on a fresh
// row, or a leftover from an earlier decision on the same (game, campaignId)
// row — which is how 15 Black Desert reuse rows came to say internalSales 0
// while SaleSignal held 13 sales (FARM2-VERIFICATION §5.1). The replay harness
// no longer reads the field, and the recorded snapshot carries the truth, but a
// row that lies is still a row that lies. One field on three record() calls,
// in its own commit.
//
// Driven through the real processCampaign. The dry-run reuse path and the host
// gate need no host; the LIVE reuse record() call restarts containers and is
// not reachable from a sandbox — it carries the identical one-field change and
// is covered by inspection only.
//
// What this commit deliberately does NOT change: the replay harness's write-map
// (decisionClasses.OMITS_INTERNAL_SALES). That map gates an integrity check
// against the flat field, and rows written BEFORE this commit still carry the
// old value on these two paths. Widening the check would turn the 15 Black
// Desert rows from `agree` back into `sales_count_mismatch`. Trustworthiness of
// the field is a property of WHEN a row was written, not of its decision alone;
// rows written since the snapshot shipped never consult the flat field anyway.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const FarmJob = require("../models/FarmJob");
const autoFarmer = require("../utils/autoFarmer");
const classes = require("../utils/farm2/decisionClasses");
const settings = require("../utils/settings");

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("farm2internalsales"));
  await FarmJob.init();
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

const hoursAgo = (h) => new Date(Date.now() - h * 3600000);
const hoursFromNow = (h) => new Date(Date.now() + h * 3600000);

function ctxFor({ campaignId, research, sales, hostOnline = false }) {
  return {
    af: {
      ...settings.getAutoFarm(),
      dryRun: true,
      probeColdStart: false,
      maxPerGame: 30,
      platiCategoryId: "",
    },
    host: null,
    hostOnline,
    budgetMap: new Map(),
    infoMap: new Map([[campaignId, { research, sales }]]),
    priorTasks: new Map(),
  };
}

test("skip_host_offline now records the sales the gate saw", async () => {
  const game = "Offline Sales Game";
  await AutoFarmTask.deleteMany({ game });
  const c = { game, campaignId: "os1", name: "Weekly", endAt: hoursFromNow(48) };
  const r = await autoFarmer.processCampaign(
    c,
    ctxFor({
      campaignId: "os1",
      research: { demandScore: 90, sellers: 5, scannedAt: hoursAgo(1) },
      sales: { count: 7, revenue: 35, avgPrice: 5 },
      hostOnline: false,
    }),
  );
  assert.equal(r.decision, "skip_host_offline");
  const row = await AutoFarmTask.findOne({ game, campaignId: "os1" }).lean();
  assert.equal(row.internalSales, 7, "was the schema default 0 before this commit");
  assert.equal(row.decisionInputs.sales.count, 7, "and agrees with the recorded snapshot");
});

test("the dry-run reuse record — the Black Desert path — now records the sales the gate saw", async () => {
  const game = "Reuse Sales Game";
  await AutoFarmTask.deleteMany({ game });
  const reusable = {
    _id: new mongoose.Types.ObjectId(),
    game,
    campaignId: "old",
    status: "completed",
    assignedAccounts: ["a1", "a2", "a3"],
    bots: [{ host: "local", file: "config_7.json", container: "bot7" }],
  };
  const ctx = ctxFor({
    campaignId: "rs1",
    research: { demandScore: 3.7, sellers: 10, scannedAt: hoursAgo(1) },
    sales: { count: 13, revenue: 22.75, avgPrice: 1.75 },
    hostOnline: true,
  });
  ctx.host = { id: "local", label: "Server" };
  ctx.reusableMap = new Map([[game, reusable]]);
  ctx.hostState = { hasFile: () => true, activateBot() {} };
  const c = { game, campaignId: "rs1", name: "Weekly", endAt: hoursFromNow(48) };
  const r = await autoFarmer.processCampaign(c, ctx);
  assert.equal(r.decision, "reuse_existing");
  assert.equal(r.dryRun, true);
  const row = await AutoFarmTask.findOne({ game, campaignId: "rs1" }).lean();
  assert.equal(row.internalSales, 13, "the exact value the Black Desert rows were missing");
  assert.equal(row.decisionInputs.sales.count, 13);
});

test("a stale internalSales from an earlier decision is overwritten on re-decision", async () => {
  // The leftover case: the row was once a farm decision recording 2 sales, then
  // the host went away. Before this commit the reuse/offline record() left the
  // 2 in place; now the field follows the decision.
  const game = "Stale Sales Game";
  await AutoFarmTask.deleteMany({ game });
  const c = { game, campaignId: "ss1", name: "Weekly", endAt: hoursFromNow(48) };
  await AutoFarmTask.create({
    game,
    campaignId: "ss1",
    decision: "farm",
    status: "skipped",
    internalSales: 2,
    decidedAt: hoursAgo(10),
  });
  await autoFarmer.processCampaign(
    c,
    ctxFor({
      campaignId: "ss1",
      research: { demandScore: 90, sellers: 5, scannedAt: hoursAgo(1) },
      sales: { count: 9, revenue: 45, avgPrice: 5 },
      hostOnline: false,
    }),
  );
  const row = await AutoFarmTask.findOne({ game, campaignId: "ss1" }).lean();
  assert.equal(row.decision, "skip_host_offline");
  assert.equal(row.internalSales, 9, "not the leftover 2");
});

test("the replay harness's write-map is deliberately NOT widened — old rows still carry the old value", () => {
  // If this ever flips, every pre-commit reuse_existing / skip_host_offline row
  // with a stale internalSales becomes sales_count_mismatch in replay — the
  // Black Desert rows among them. Trustworthiness is per row-write-time, and
  // the harness has no way to know which rows predate this commit.
  assert.equal(classes.recordsInternalSales("reuse_existing"), false);
  assert.equal(classes.recordsInternalSales("skip_host_offline"), false);
  assert.deepEqual([...classes.OMITS_INTERNAL_SALES].sort(), ["reuse_existing", "skip_host_offline"]);
});
