// Code shop farm priority (utils/codeShop/farmPriority.js, docs/code-shop/04-OPS.md).
//
// A priority change restarts a bot's sessions, so the guards under test are
// the ones that keep it from touching the farm when it should not: off by
// default, only the listed bots, only running "auto" bots, only when the
// target differs, a tie keeps what the bot already does, and at most one
// change per minHoursBetween.
//
// Real Mongo via mongodb-memory-server for the campaign and ledger queries;
// the farm, Telegram, config and events are fakes. All numbers are made up.
process.env.CRED_SECRET ||= "code-shop-farm-priority-test-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const CodeStock = require("../models/CodeStock");
const SoopCampaign = require("../models/SoopCampaign");
const SoopFarmTask = require("../models/SoopFarmTask");
const { DEFAULTS, deepMerge } = require("../utils/codeShop/config");
const { createFarmPriority } = require("../utils/codeShop/farmPriority");

const ObjectId = mongoose.Types.ObjectId;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshopfarmpriority"));
  await Promise.all([CodeStock, SoopCampaign, SoopFarmTask].map((m) => m.init()));
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

test.beforeEach(async () => {
  await Promise.all([CodeStock, SoopCampaign, SoopFarmTask].map((m) => m.deleteMany({})));
});

function fakeConfig(data = {}) {
  let value = deepMerge(DEFAULTS, data);
  const sets = [];
  return {
    sets,
    get: async () => value,
    set: async (patch) => {
      sets.push(patch);
      value = deepMerge(value, patch);
      return value;
    },
  };
}

function fakeFarm({ fail = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    updateBot: async (id, patch) => {
      calls.push([id, patch]);
      if (fail.has(id)) return { ok: false, error: "Unknown bot" };
      return { ok: true, bot: { id } };
    },
  };
}

function setup({ config, farm = fakeFarm(), now = NOW } = {}) {
  const events = { logs: [], log: async (e) => (events.logs.push(e), true) };
  const telegram = { sent: [], send: async (t) => telegram.sent.push(t) };
  const fp = createFarmPriority({ config, events, telegram, now: () => now, farm: () => farm });
  return { fp, farm, events, telegram, config };
}

let seq = 0;

async function campaign(gameNo, opts = {}) {
  seq += 1;
  return SoopCampaign.create({
    dropsIdx: "c" + seq,
    gameNo,
    giveCon: opts.giveCon || "term",
    startDate: opts.startDate || new Date(NOW - DAY),
    endDate: opts.endDate || new Date(NOW + 3 * DAY),
    itemList: opts.itemList || [{ itemType: "1", itemName: "Some reward" }],
  });
}

// `units` sold units of a game, `rowsPerUnit` codes each (one unit = one sale).
async function sales(gameNo, units, { rowsPerUnit = 2, soldAt = new Date(NOW - DAY), state = "sold" } = {}) {
  for (let u = 0; u < units; u++) {
    const unit = new ObjectId();
    for (let r = 0; r < rowsPerUnit; r++) {
      seq += 1;
      await CodeStock.create({ loginId: "l" + seq, itemKey: "k" + seq, gameNo, state, unit, soldAt });
    }
  }
}

async function bot(opts = {}) {
  return SoopFarmTask.create({
    label: opts.label || "bot",
    mode: opts.mode || "auto",
    active: opts.active === undefined ? true : opts.active,
    priorityGameNo: opts.priorityGameNo || "",
  });
}

const ids = (...bots) => bots.map((b) => String(b._id));
const on = (botIds, extra = {}) => ({ farmPriority: { enabled: true, botIds, ...extra } });

// ---------------------------------------------------------------------------

test("off: disabled, or no bots listed, does nothing", async () => {
  await campaign("12");
  const b = await bot();
  for (const config of [fakeConfig({ farmPriority: { enabled: false, botIds: ids(b) } }), fakeConfig(on([]))]) {
    const { fp, farm, telegram } = setup({ config });
    const res = await fp.run();
    assert.deepEqual(res.changed, []);
    assert.equal(res.top, null);
    assert.equal(farm.calls.length, 0);
    assert.equal(config.sets.length, 0);
    assert.equal(telegram.sent.length, 0);
  }
  // Shipped dark.
  const { fp, farm } = setup({ config: fakeConfig() });
  await fp.run();
  assert.equal(farm.calls.length, 0);
});

test("candidates: term campaigns with a code reward, live or starting within a day, of a game the shop sells", async () => {
  const games = {
    "12": { sell: true },
    "200": { sell: true },
    "300": { sell: true },
    "400": { sell: true },
    "500": { sell: true },
    "700": { sell: false },
    "800": { sell: true },
  };
  await campaign("12");
  await campaign("200", { giveCon: "time" }); // not guaranteed
  await campaign("300", { itemList: [{ itemType: "4", itemName: "In-game item" }] }); // no code
  await campaign("400", { startDate: new Date(NOW - 5 * DAY), endDate: new Date(NOW - HOUR) }); // over
  await campaign("500", { startDate: new Date(NOW + 2 * DAY), endDate: new Date(NOW + 9 * DAY) }); // too far off
  await campaign("600"); // a game the config does not know
  await campaign("700"); // sell: false
  await campaign("800", { startDate: new Date(NOW + 10 * HOUR), endDate: new Date(NOW + 5 * DAY) }); // starts soon
  await campaign("800", { itemList: [{ itemType: "4" }, { itemType: "1" }] }); // one code item is enough

  const b = await bot();
  const { fp } = setup({ config: fakeConfig({ games, ...on(ids(b)) }) });
  const res = await fp.run();
  assert.deepEqual(res.scores.map((s) => s.gameNo).sort(), ["12", "800"]);
  assert.deepEqual(res.scores.map((s) => s.score), [1, 1]);
});

test("scoring: distinct units sold in 14 days + 1; the best seller wins", async () => {
  await campaign("12");
  await campaign("200");
  await sales("12", 1, { rowsPerUnit: 3 }); // three codes, one sale
  await sales("200", 2);
  await sales("200", 1, { state: "dead" }); // a dead code was still sold
  await sales("12", 5, { soldAt: new Date(NOW - 15 * DAY) }); // too old
  await sales("12", 5, { state: "in_unit", soldAt: null }); // on sale, not sold

  const b = await bot({ label: "Main", priorityGameNo: "12" });
  const { fp, farm, telegram, config, events } = setup({ config: fakeConfig(on(ids(b))) });
  const res = await fp.run();
  assert.deepEqual(
    res.scores.map((s) => [s.gameNo, s.sold, s.score]),
    [
      ["200", 3, 4],
      ["12", 1, 2],
    ],
  );
  assert.equal(res.top, "200");
  assert.deepEqual(res.changed, [{ botId: String(b._id), from: "12", to: "200" }]);
  assert.deepEqual(farm.calls, [[String(b._id), { priorityGameNo: "200" }]]);

  // After a change: lastChangeAt recorded, one event, one Telegram line.
  assert.equal(config.sets.length, 1);
  assert.equal(new Date(config.sets[0].farmPriority.lastChangeAt).getTime(), NOW);
  assert.equal(telegram.sent.length, 1);
  assert.ok(!telegram.sent[0].includes("\n"), "one line");
  assert.match(telegram.sent[0], /Delta Force/);
  assert.match(telegram.sent[0], /Main/);
  assert.equal(events.logs.filter((e) => e.kind === "farm-priority" && e.level === "info").length, 1);
});

test("tie: a bot already on one of the tied games keeps it; others get the lower game number", async () => {
  await campaign("12");
  await campaign("200");
  await campaign("9");
  const games = { "9": { sell: true, displayName: "Nine" } };
  await sales("200", 1);
  await sales("12", 1);
  await sales("9", 0);
  const keeps = await bot({ label: "keeps", priorityGameNo: "200" });
  const blank = await bot({ label: "blank", priorityGameNo: "" });
  const other = await bot({ label: "other", priorityGameNo: "9" }); // not among the tied

  const { fp, farm } = setup({ config: fakeConfig({ games, ...on(ids(keeps, blank, other)) }) });
  const res = await fp.run();
  assert.equal(res.top, "12", "the lower game number of the tie (numerically)");
  assert.deepEqual(
    farm.calls.map(([id, p]) => [id, p.priorityGameNo]),
    [
      [String(blank._id), "12"],
      [String(other._id), "12"],
    ],
  );
  assert.ok(!farm.calls.some(([id]) => id === String(keeps._id)));
});

test("bots: never touches inactive, non-auto, unknown or already-right bots", async () => {
  await campaign("12");
  const stopped = await bot({ active: false });
  const gameMode = await bot({ mode: "game" });
  const campaignMode = await bot({ mode: "campaign" });
  const already = await bot({ priorityGameNo: "12" });
  const botIds = [...ids(stopped, gameMode, campaignMode, already), String(new ObjectId()), "not-an-id"];

  const { fp, farm, config, telegram } = setup({ config: fakeConfig(on(botIds)) });
  const res = await fp.run();
  assert.equal(res.top, "12");
  assert.deepEqual(res.changed, []);
  assert.equal(farm.calls.length, 0);
  assert.equal(config.sets.length, 0, "nothing changed, nothing recorded");
  assert.equal(telegram.sent.length, 0);
});

test("minHoursBetween: waits after the last change, runs once it has passed", async () => {
  await campaign("12");
  const b = await bot({ priorityGameNo: "" });

  const early = setup({ config: fakeConfig(on(ids(b), { minHoursBetween: 6, lastChangeAt: new Date(NOW - 2 * HOUR) })) });
  const res = await early.fp.run();
  assert.equal(res.skipped, "wait");
  assert.equal(early.farm.calls.length, 0);

  const later = setup({ config: fakeConfig(on(ids(b), { minHoursBetween: 6, lastChangeAt: new Date(NOW - 7 * HOUR) })) });
  await later.fp.run();
  assert.equal(later.farm.calls.length, 1);

  // A second run right after its own change waits.
  const again = await later.fp.run();
  assert.equal(again.skipped, "wait");
  assert.equal(later.farm.calls.length, 1);
});

test("a failed updateBot is a warn event, not a change", async () => {
  await campaign("12");
  const bad = await bot({ label: "bad" });
  const good = await bot({ label: "good" });
  const farm = fakeFarm({ fail: new Set([String(bad._id)]) });
  const { fp, events, config } = setup({ config: fakeConfig(on(ids(bad, good))), farm });
  const res = await fp.run();
  assert.equal(farm.calls.length, 2);
  assert.deepEqual(res.changed, [{ botId: String(good._id), from: "", to: "12" }]);
  const warn = events.logs.find((e) => e.level === "warn" && e.kind === "farm-priority");
  assert.ok(warn);
  assert.match(warn.msg, /bad/);
  assert.equal(config.sets.length, 1);

  // Only failures: nothing recorded.
  await SoopFarmTask.deleteMany({ _id: good._id });
  const throwing = { updateBot: async () => { throw new Error("farm down"); } };
  const t = setup({ config: fakeConfig(on(ids(bad))), farm: throwing });
  const r2 = await t.fp.run();
  assert.deepEqual(r2.changed, []);
  assert.equal(t.config.sets.length, 0);
  assert.ok(t.events.logs.some((e) => e.level === "warn" && /farm down/.test(e.msg)));
});

test("no candidate game: nothing changes", async () => {
  await campaign("12", { giveCon: "time" });
  const b = await bot({ priorityGameNo: "200" });
  const { fp, farm } = setup({ config: fakeConfig(on(ids(b))) });
  const res = await fp.run();
  assert.equal(res.top, null);
  assert.equal(farm.calls.length, 0);
});
