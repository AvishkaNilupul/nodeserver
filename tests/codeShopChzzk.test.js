// Code shop: CHZZK reward codes as a second source (utils/codeShop/sources.js,
// docs/code-shop/07-CHZZK-SOURCE.md). The SOOP path is pinned by the other
// codeShop* tests; these pin what is new:
//   - a CHZZK stored code becomes a ledger row under "chzzk:<account>" / "r<rewardNo>",
//     in its own group and slot, with its use-by;
//   - a sold CHZZK login's codes never reach stock; a revealed one is held;
//   - the switch keeps CHZZK out; a CHZZK failure never stops SOOP's ingest;
//   - a bundle built from CHZZK rows carries exactly those codes;
//   - release / replacement read the CHZZK code; event dates read the CHZZK campaign.
// Real Mongo via mongodb-memory-server. Every code is made up.
process.env.CRED_SECRET ||= "code-shop-chzzk-test-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const CodeStock = require("../models/CodeStock");
const CodeProduct = require("../models/CodeProduct");
const SuppliedAccount = require("../models/SuppliedAccount");
const SoopInventoryItem = require("../models/SoopInventoryItem");
const SoopAccount = require("../models/SoopAccount");
const ChzzkAccount = require("../models/ChzzkAccount");
const ChzzkCampaign = require("../models/ChzzkCampaign");
const ChzzkReward = require("../models/ChzzkReward");
const secretBox = require("../utils/secretBox");
const { encrypt, decrypt } = secretBox;
const { hashCode } = require("../utils/codeShop/slots");
const sources = require("../utils/codeShop/sources");
const { createIngest } = require("../utils/codeShop/ingest");
const { createUnits } = require("../utils/codeShop/units");
const { createHeld } = require("../utils/codeShop/held");
const { eventStarts } = require("../utils/codeShop/eventDates");

const ObjectId = mongoose.Types.ObjectId;
const NOW = Date.UTC(2026, 9, 23, 6, 0, 0);
const DAY = 86400000;
const ALL = [CodeStock, CodeProduct, SuppliedAccount, SoopInventoryItem, SoopAccount, ChzzkAccount, ChzzkCampaign, ChzzkReward];

let mem;
test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshopchzzk"));
  await Promise.all(ALL.map((m) => m.init()));
});
test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});
test.beforeEach(async () => {
  await Promise.all(ALL.map((m) => m.deleteMany({})));
});

function fakeEvents() {
  const logs = [];
  return { logs, log: async (e) => (logs.push(e), true), stamp: async () => true };
}
const staticConfig = (data = {}) => ({ get: async () => ({ expiryLeadHours: 36, sourceWords: [], ...data }) });

async function seedChzzk({ sold = false, codes = {}, revealed = [] } = {}) {
  const acc = await ChzzkAccount.create({ userIdHash: "h" + new ObjectId(), nickname: "nick", cookies: "x", status: "ok", sold });
  await ChzzkCampaign.updateOne(
    { campaignNo: 1954 },
    { $set: { campaignNo: 1954, title: "Made-up league", categoryType: "GAME", categoryId: "OVERWATCH", categoryValue: "OW",
      startAt: new Date(NOW - 3 * DAY), endAt: new Date(NOW + DAY),
      rewards: [{ rewardNo: 5089, title: "Epic Box", rewardType: "CODE_FIRST_COME", minutes: 180, remaining: 10, imageUrl: "https://example.test/a.png" }] } },
    { upsert: true },
  );
  const rows = [];
  for (const [rewardNo, code] of Object.entries(codes)) {
    rows.push(await ChzzkReward.create({
      accountId: String(acc._id), userIdHash: acc.userIdHash, campaignNo: 1954, rewardNo: Number(rewardNo),
      title: "Epic Box", rewardType: "CODE_FIRST_COME", categoryId: "OVERWATCH", campaignTitle: "Made-up league",
      earnedAt: new Date(NOW - DAY), codeEndAt: new Date(NOW + 30 * DAY), state: "stored",
      codeEnc: encrypt(code), hasCode: true, codeAt: new Date(NOW - DAY),
      revealedAt: revealed.includes(Number(rewardNo)) ? new Date(NOW - 3600e3) : null,
    }));
  }
  return { acc, rows };
}

const ingestWith = (extra = {}) => {
  const events = fakeEvents();
  return { events, ingest: createIngest({ secret: secretBox, now: () => NOW, events, config: staticConfig(), ...extra }) };
};

// ------------------------------------------------------------------ pure

test("sources: CHZZK identity and game numbers", () => {
  const id = "0123456789abcdef01234567";
  assert.equal(sources.chzzkLoginId(id), "chzzk:" + id);
  assert.deepEqual(sources.parseChzzk("chzzk:" + id, "r5089"), { accountId: id, rewardNo: 5089 });
  assert.equal(sources.parseChzzk("benbi649", "127843931"), null, "a SOOP login is never read as CHZZK");
  assert.equal(sources.parseChzzk("chzzk:not-an-id", "r1"), null);
  assert.equal(sources.chzzkGame("OVERWATCH").gameNo, "12", "a game SOOP also farms keeps SOOP's number");
  assert.equal(sources.chzzkGame("Call_of_Duty_Modern_Warfare4").gameNo, "910001");
  const unknown = sources.chzzkGame("Some_New_Game");
  assert.match(unknown.gameNo, /^92\d{5}$/);
  assert.equal(sources.chzzkGame("Some_New_Game").gameNo, unknown.gameNo, "stable");
  assert.equal(unknown.gameName, "Some New Game");
});

// ------------------------------------------------------------------ ingest

test("ingest: CHZZK codes join the ledger in their own group and slot, with their use-by", async () => {
  const a = await seedChzzk({ codes: { 5089: "CHZ-AAAA-1111" } });
  const b = await seedChzzk({ codes: { 5089: "CHZ-BBBB-2222" } });
  await SoopInventoryItem.create({ loginId: "soopone", key: "k1", kind: "code", hasCode: true, gameNo: "12", name: "Spray", nameRaw: "Spray",
    sentAt: new Date(NOW - DAY), codeEnc: encrypt("SOOP-CCCC-3333"), claim: { dropsName: "Some SOOP event" } });
  const { ingest, events } = ingestWith();
  const out = await ingest.run();
  assert.equal(out.added, 3);
  const rows = await CodeStock.find({ loginId: /^chzzk:/ }).lean();
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.itemKey, "r5089");
    assert.equal(r.gameNo, "12");
    assert.equal(r.groupKey, "12:chzzk-1954");
    assert.equal(r.campaignIdx, "chzzk-1954");
    assert.equal(r.state, "in_stock");
    assert.equal(+r.useBy, NOW + 30 * DAY);
    assert.equal(r.image, "https://example.test/a.png");
  }
  assert.equal(rows[0].slotKey, rows[1].slotKey, "the same reward on two logins is one slot");
  assert.deepEqual(new Set(rows.map((r) => r.loginId)), new Set(["chzzk:" + a.acc._id, "chzzk:" + b.acc._id]));
  const soop = await CodeStock.findOne({ loginId: "soopone" }).lean();
  assert.notEqual(soop.groupKey, rows[0].groupKey, "never the SOOP group");
  assert.ok(!JSON.stringify(events.logs).includes("CHZ-"), "no code in the activity log");
  const again = await ingest.run();
  assert.equal(again.added, 0, "a second run adds nothing");
});

test("ingest: a sold CHZZK login's codes never reach stock; a revealed one is held", async () => {
  await seedChzzk({ sold: true, codes: { 5089: "CHZ-SOLD-0001" } });
  await seedChzzk({ codes: { 5089: "CHZ-SEEN-0002" }, revealed: [5089] });
  const { ingest } = ingestWith();
  await ingest.run();
  const inStock = await CodeStock.find({ state: "in_stock" }).lean();
  assert.equal(inStock.length, 0);
  const held = await CodeStock.find({ state: "held" }).lean();
  assert.equal(held.length, 1);
  assert.match(held[0].problem, /shown in the farm panel/);
});

test("ingest: selling an already stocked CHZZK login holds its codes on the next run", async () => {
  const { acc } = await seedChzzk({ codes: { 5089: "CHZ-LATE-0003" } });
  const { ingest } = ingestWith();
  await ingest.run();
  assert.equal((await CodeStock.findOne({}).lean()).state, "in_stock");
  await ChzzkAccount.updateOne({ _id: acc._id }, { $set: { sold: true } });
  await ingest.run();
  const row = await CodeStock.findOne({}).lean();
  assert.equal(row.state, "held");
  assert.match(row.problem, /sold/);
});

test("ingest: the switch keeps CHZZK out; a CHZZK failure never stops SOOP", async () => {
  await seedChzzk({ codes: { 5089: "CHZ-OFF-0004" } });
  await SoopInventoryItem.create({ loginId: "soopone", key: "k1", kind: "code", hasCode: true, gameNo: "12", name: "Spray", nameRaw: "Spray",
    sentAt: new Date(NOW - DAY), codeEnc: encrypt("SOOP-DDDD-4444") });
  const off = ingestWith({ config: staticConfig({ sources: { chzzk: false } }) });
  await off.ingest.run();
  assert.equal(await CodeStock.countDocuments({ loginId: /^chzzk:/ }), 0, "switched off");
  assert.equal(await CodeStock.countDocuments({ loginId: "soopone" }), 1);

  await CodeStock.deleteMany({});
  const broken = { find() { throw new Error("chzzk db down"); } };
  const { ingest, events } = ingestWith({ models: { ChzzkReward: broken, ChzzkCampaign, ChzzkAccount, SoopAccount } });
  const out = await ingest.run();
  assert.equal(out.added, 1, "the SOOP code still went in");
  assert.ok(events.logs.some((e) => /CHZZK codes were not read/.test(e.msg)));
});

// ------------------------------------------------------------------ after ingest

test("units: a bundle built from CHZZK rows holds exactly their codes", async () => {
  await seedChzzk({ codes: { 5089: "CHZ-UNIT-0005" } });
  await seedChzzk({ codes: { 5089: "CHZ-UNIT-0006" } });
  await createIngest({ secret: secretBox, now: () => NOW, events: fakeEvents(), config: staticConfig() }).run();
  const rows = await CodeStock.find({}).sort({ loginId: 1 }).lean();
  const product = await CodeProduct.create({ name: "Test", status: "active", offer: new ObjectId(), slots: [{ slotKey: rows[0].slotKey, label: "Epic Box" }] });
  const units = createUnits({ events: fakeEvents(), now: () => NOW });
  const res = await units.build(product.toObject(), rows.map((r) => [r._id]));
  assert.equal(res.built, 2);
  const texts = [];
  for (const id of res.unitIds) texts.push(decrypt((await SuppliedAccount.findById(id)).password));
  assert.deepEqual(texts.sort(), ["1) Epic Box = CHZ-UNIT-0005", "1) Epic Box = CHZ-UNIT-0006"]);
  assert.equal(await CodeStock.countDocuments({ state: "in_unit" }), 2);
});

test("sources: code reads and sold logins cover both farms", async () => {
  const { acc } = await seedChzzk({ sold: true, codes: { 5089: "CHZ-READ-0007" } });
  await SoopAccount.create({ loginId: "soopsold", sold: true });
  await SoopInventoryItem.create({ loginId: "soopone", key: "k9", kind: "code", hasCode: true, codeEnc: encrypt("SOOP-READ-0008") });
  const deps = {};
  const enc = await sources.encOf(deps, [{ loginId: "chzzk:" + acc._id, itemKey: "r5089" }, { loginId: "soopone", itemKey: "k9" }, { loginId: "chzzk:" + acc._id, itemKey: "r1" }]);
  assert.equal(decrypt(enc.get(sources.idKey("chzzk:" + acc._id, "r5089"))), "CHZ-READ-0007");
  assert.equal(decrypt(enc.get(sources.idKey("soopone", "k9"))), "SOOP-READ-0008");
  assert.equal(enc.size, 2, "a missing reward reads as missing");
  assert.deepEqual(new Set(await sources.soldLoginIds(deps)), new Set(["soopsold", "chzzk:" + acc._id]));
  assert.equal(await sources.isSoldLogin(deps, "chzzk:" + acc._id), true);
  assert.equal(await sources.isSoldLogin(deps, "soopsold"), true);
  assert.equal(await sources.isSoldLogin(deps, "soopone"), false);
  // A caller that passes its own models without CHZZK ones simply has no CHZZK source.
  assert.deepEqual(await sources.soldLoginIds({ models: { SoopAccount } }), ["soopsold"]);
});

test("held: a revealed CHZZK code can be released by hand once its stored code still matches", async () => {
  await seedChzzk({ codes: { 5089: "CHZ-HELD-0009" }, revealed: [5089] });
  await createIngest({ secret: secretBox, now: () => NOW, events: fakeEvents(), config: staticConfig() }).run();
  const row = await CodeStock.findOne({}).lean();
  assert.equal(row.state, "held");
  assert.equal(row.codeHash, hashCode("CHZ-HELD-0009"));
  const held = createHeld({ secret: secretBox, now: () => NOW, events: fakeEvents() });
  const res = await held.release(String(row._id), { actor: "test" });
  assert.equal((await CodeStock.findById(row._id).lean()).state, "in_stock");
  assert.ok(res);
});

test("eventDates: a CHZZK group is dated by its campaign's start", async () => {
  await seedChzzk({ codes: {} });
  const starts = await eventStarts({ ChzzkCampaign, CodeStock }, ["12:chzzk-1954"]);
  assert.equal(+starts[0], NOW - 3 * DAY);
});

// ------------------------------------------------------------------ auto-bundler

test("planner: CHZZK Overwatch codes become a DRAFT for the owner — nothing is built or published", async () => {
  const { createPlanner } = require("../utils/codeShop/planner");
  const { DEFAULTS, deepMerge } = require("../utils/codeShop/config");
  const { checkBuyerText } = require("../utils/codeShop/textGuard");
  for (let i = 0; i < 3; i++) await seedChzzk({ codes: { 5089: `CHZ-PLAN-000${i}` } });
  // The campaign ended 5 h ago, past the 4 h grace: the group is ready to draft.
  await ChzzkCampaign.updateOne({ campaignNo: 1954 }, { $set: { endAt: new Date(NOW - 5 * 3600e3) } });
  await createIngest({ secret: secretBox, now: () => NOW, events: fakeEvents(), config: staticConfig() }).run();
  const cfgValue = deepMerge(DEFAULTS, {});
  const stamps = new Set();
  const planner = createPlanner({
    models: { CodeStock, CodeProduct, ChzzkCampaign },
    now: () => NOW,
    config: { get: async () => cfgValue },
    events: { logs: [], log: async () => true, stamp: async (k) => (stamps.has(k) ? false : (stamps.add(k), true)), has: async (k) => stamps.has(k) },
    telegram: { send: async () => true },
  });
  await planner.run();
  const drafts = await CodeProduct.find({}).lean();
  assert.equal(drafts.length, 1, "one draft for the CHZZK Overwatch group");
  const d = drafts[0];
  assert.equal(d.status, "draft", "never active without the owner");
  assert.equal(d.gameNo, "12");
  assert.deepEqual(d.groupKeys, ["12:chzzk-1954"]);
  assert.equal(d.slots[0].label, "Epic Box");
  assert.equal(await SuppliedAccount.countDocuments({}), 0, "no bundle was built");
  assert.equal(await CodeStock.countDocuments({ state: "in_stock" }), 3, "the codes stay in stock");
  const t = d.texts || {};
  const all = JSON.stringify(t);
  assert.ok(!/chzzk|naver|korea/i.test(all), "buyer text never names the source");
  assert.deepEqual(checkBuyerText({ ...t, labels: d.slots.map((x) => x.label) }), [], "every buyer text of the draft passes the guard");
  assert.ok(checkBuyerText({ title: "CHZZK drops" }).length > 0, "the guard does catch the source name");
  assert.match(t.title, /Event 20 Oct 2026/, "the event is named by its CHZZK start date");
});

test("planner: a CHZZK-only game is listed in the settings but never drafted until ticked", async () => {
  const { createPlanner } = require("../utils/codeShop/planner");
  const { DEFAULTS, deepMerge } = require("../utils/codeShop/config");
  assert.equal(DEFAULTS.games["910001"].sell, false);
  const acc = await ChzzkAccount.create({ userIdHash: "hz", nickname: "n", cookies: "x", status: "ok" });
  await ChzzkCampaign.create({ campaignNo: 1987, title: "Made-up CoD", categoryId: "Call_of_Duty_Modern_Warfare4", startAt: new Date(NOW - 9 * DAY), endAt: new Date(NOW - DAY),
    rewards: [{ rewardNo: 5149, title: "Gas Ready", rewardType: "CODE_FIRST_COME", minutes: 15 }] });
  for (let i = 0; i < 3; i++) {
    await ChzzkReward.create({ accountId: String(i === 0 ? acc._id : new ObjectId()), userIdHash: "h" + i, campaignNo: 1987, rewardNo: 5149, title: "Gas Ready", rewardType: "CODE_FIRST_COME",
      earnedAt: new Date(NOW - 2 * DAY), codeEndAt: new Date(NOW + 30 * DAY), state: "stored", codeEnc: encrypt("COD-PLAN-00" + i), hasCode: true });
  }
  await createIngest({ secret: secretBox, now: () => NOW, events: fakeEvents(), config: staticConfig() }).run();
  assert.equal(await CodeStock.countDocuments({ gameNo: "910001", state: "in_stock" }), 3, "in the ledger");
  const planner = createPlanner({ models: { CodeStock, CodeProduct, ChzzkCampaign }, now: () => NOW,
    config: { get: async () => deepMerge(DEFAULTS, {}) }, events: { log: async () => true, stamp: async () => true, has: async () => false }, telegram: { send: async () => true } });
  await planner.run();
  assert.equal(await CodeProduct.countDocuments({}), 0, "not ticked: no draft");
});
