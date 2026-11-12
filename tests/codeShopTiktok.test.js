process.env.CRED_SECRET ||= "synthetic-tiktok-shop-test-secret";
const test = require("node:test"), assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const mongoose = require("mongoose"), express = require("express");
const { MongoMemoryServer } = require("mongodb-memory-server");
const names = ["TikTokFarmRun", "TikTokFarmSchedule", "CodeStock", "CodeProduct", "CodeShopConfig", "CodeShopEvent",
  "SoopInventoryItem", "SoopCampaign", "SoopAccount", "SoopActivity", "ChzzkAccount", "ChzzkReward", "ChzzkCampaign", "SuppliedAccount", "AccountOffer", "MarketplaceListing"];
const models = Object.fromEntries(names.map((n) => [n, require("../models/" + n)]));
const Run = models.TikTokFarmRun, Stock = models.CodeStock;
const secret = require("../utils/secretBox");
const { DEFAULTS, deepMerge } = require("../utils/codeShop/config");
const { createIngest } = require("../utils/codeShop/ingest");
const { createUnits } = require("../utils/codeShop/units");
const { createExpiry } = require("../utils/codeShop/expiry");
const { createPlanner } = require("../utils/codeShop/planner");
const { checkBuyerText } = require("../utils/codeShop/textGuard");
const { guideFor } = require("../utils/codeShop/games");
const { eventStarts } = require("../utils/codeShop/eventDates");
const source = require("../utils/codeShop/tiktok");
const { inventoryStatus, reveal } = require("../routes/tiktokFarmShop");
const DAY = 86400e3, NOW = Date.UTC(2026, 10, 8, 5), digest = (s) => createHash("sha256").update(s).digest("hex");
let mongo, clock = NOW;
const cfg = deepMerge(DEFAULTS, { sources: { tiktok: true }, autoPublish: true });
const events = { log: async () => true, stamp: async () => true, has: async () => false };
const deps = () => ({ models, secret, now: () => clock, config: { get: async () => cfg }, events, telegram: { send: async () => true } });
const reward = (extra = {}) => ({ campaign: "100", task: "200", gameId: "7276576189992524804", gameName: "Infinity Nikki",
  giftId: "300", name: "Diamond", needAuth: false, campaignStartAt: NOW - 10 * DAY, campaignEndAt: NOW + 10 * DAY,
  useBy: NOW + 17 * DAY, redeemType: 2, redeemUrl: "", instructions: "Pear-Pal > Settings > Other > Redeem Code",
  items: [{ name: "Diamond", count: 10 }], verifiedAt: NOW, ...extra });
async function seed(account = "tiktok-01", extra = {}) {
  const code = "SYNTHETIC-" + account + "-" + (extra.task || "200");
  return Run.create({ account, campaign: "100", room: "400", anchor: "500", task: "200", batch: "fixture",
    active: false, state: "completed", phase: "stored", code: secret.encrypt(code), codeHash: digest(code),
    createdAt: new Date(NOW - 2 * DAY), updatedAt: new Date(NOW - DAY), reward: reward(), ...extra });
}
test.before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Promise.all(Object.values(models).map((m) => m.init())); });
test.after(async () => { await mongoose.disconnect(); await mongo.stop(); });
test.beforeEach(async () => { clock = NOW; await Promise.all(Object.values(models).map((m) => m.deleteMany({}))); });

test("TikTok ingest is idempotent, preserves exact tasks/quantities and never substitutes campaign expiry", async () => {
  await seed(); await seed("tiktok-02");
  await seed("tiktok-01", { task: "201", reward: reward({ task: "201", giftId: "301", items: [{ name: "Diamond", count: 20 }] }) });
  const ingest = createIngest(deps()); assert.equal((await ingest.run()).added, 3); assert.equal((await ingest.run()).added, 0);
  const rows = await Stock.find({}).lean();
  assert.equal(new Set(rows.map((r) => r.slotKey)).size, 2);
  assert.ok(rows.every((r) => +r.useBy === NOW + 17 * DAY && +r.campaignEndAt === NOW + 10 * DAY));
  assert.deepEqual(new Set(rows.map((r) => r.name)), new Set(["10x Diamond", "20x Diamond"]));
  assert.equal(await Stock.countDocuments({ state: "in_stock" }), 3);
});

test("unknown deadlines, new games, wrong region and unverified rows never enter stock", async () => {
  await seed("tiktok-01", { reward: undefined });
  await seed("tiktok-02", { reward: reward({ useBy: null }) });
  await seed("tiktok-03", { reward: reward({ gameId: "999" }) });
  await seed("tiktok-04", { reward: reward({ gameId: "7277642444328522756", gameName: "World of Tanks", redeemType: 1, redeemUrl: "https://worldoftanks.com/" }) });
  assert.equal((await createIngest(deps()).run()).added, 0);
  const status = await inventoryStatus(await Run.find({}).lean(), NOW);
  assert.ok(status.every((r) => r.shop.state === "review"));
  const off = { ...deps(), config: { get: async () => ({ ...cfg, sources: { tiktok: false } }) } };
  await seed("tiktok-05"); assert.equal((await createIngest(off).run()).added, 0);
});

test("revealing free stock holds it; allocated and sold codes cannot be revealed", async () => {
  const run = await seed(); await createIngest(deps()).run();
  assert.ok((await reveal(Run, String(run._id), NOW)).code);
  assert.equal((await Stock.findOne({})).state, "held");
  await Stock.updateOne({}, { $set: { state: "in_unit" } });
  assert.equal((await reveal(Run, String(run._id), NOW)).status, 409);
  await Stock.updateOne({}, { $set: { state: "sold" } });
  assert.equal((await reveal(Run, String(run._id), NOW)).status, 409);
  await Stock.deleteMany({}); await createIngest(deps()).run();
  assert.equal((await Stock.findOne({})).state, "held", "reveal before first ingestion is also held");
});

test("bundles deliver the exact source code, cannot double-allocate, and withdraw at the expiry buffer", async () => {
  await seed(); await createIngest(deps()).run(); const row = await Stock.findOne({}).lean();
  const product = await models.CodeProduct.create({ name: "Fixture", status: "active", offer: new mongoose.Types.ObjectId(),
    slots: [{ slotKey: row.slotKey, label: "10x Diamond" }] });
  const units = createUnits(deps()); const results = await Promise.all([units.build(product.toObject(), [[row._id]]), units.build(product.toObject(), [[row._id]])]);
  assert.equal(results.reduce((n, r) => n + r.built, 0), 1);
  const unit = await models.SuppliedAccount.findOne({ status: "available" });
  assert.equal(secret.decrypt(unit.password), "1) 10x Diamond = SYNTHETIC-tiktok-01-200");
  clock = NOW + 17 * DAY - 36 * 3600e3;
  assert.equal((await createExpiry({ ...deps(), units }).run()).pulled, 1);
  assert.equal((await models.SuppliedAccount.findById(unit._id)).status, "removed");
  assert.equal((await Stock.findById(row._id)).state, "expiring");
  assert.equal((await source.encrypted(deps(), [{ account: "tiktok-01", _id: row.itemId }])).length, 0);
  clock += 36 * 3600e3; await createExpiry({ ...deps(), units }).run();
  assert.equal((await Stock.findById(row._id)).state, "expired");
});

test("planner uses the campaign start and real redemption deadline with existing marketplace gates", async () => {
  await seed(); await createIngest(deps()).run(); await createPlanner(deps()).run();
  const p = await models.CodeProduct.findOne({}).lean();
  assert.ok(p); assert.equal(p.proposed.units, 1); assert.match(p.texts.description, /REDEEM BY 24 November 2026/);
  assert.deepEqual(p.markets, ["eldorado"]);
  assert.ok(p.texts.description.includes("10x Diamond"));
  assert.match(p.texts.description, /REDEEM BY|VALID UNTIL/);
  assert.equal(checkBuyerText(p.texts, cfg).length, 0);
  const starts = await eventStarts(models, ["930001:tiktok-100"]); assert.equal(+starts[0], NOW - 10 * DAY);
  assert.match(guideFor("930003", cfg).howTo[0], /EU.*Not for Blitz/);
  assert.ok(checkBuyerText({ ...p.texts, title: "TikTok bonus" }, { sourceWords: [] }).some((s) => /source/.test(s)));
});

test("metadata worker jobs bind account/code/campaign, reject incomplete data and preserve sale timestamps", async (t) => {
  const run = await seed("tiktok-01", { reward: undefined });
  const original = +run.updatedAt;
  const app = express(); app.use(express.json()); app.use(require("../routes/tiktokFarmRoutes").createRouter({ now: () => NOW, workerKey: () => "fixture-worker-key-with-32-characters" }));
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r)); t.after(() => new Promise((r) => server.close(r)));
  const req = async (path, body, auth = true) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/api/tiktok-farm/worker/` + path, {
    method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer fixture-worker-key-with-32-characters" } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  assert.equal((await req("stock", {}, false)).status, 401);
  const poll = await req("poll", { account: "tiktok-01", stockCapable: true });
  assert.equal(poll.body.stock.id, String(run._id)); assert.ok(!poll.body.stock.code);
  assert.equal((await req("poll", { account: "tiktok-01", stockCapable: true })).body.stock, undefined, "bounded retry prevents hot polling");
  const body = { id: String(run._id), account: "tiktok-01", codeHash: digest("SYNTHETIC-tiktok-01-200"), reward: reward() };
  assert.equal((await req("stock", { ...body, account: "tiktok-02" })).status, 409);
  assert.equal((await req("stock", { ...body, reward: reward({ useBy: null }) })).status, 400);
  assert.equal((await req("stock", { ...body, reward: { ...reward(), password: "do not persist", verifiedAt: 1 } })).status, 200);
  const saved = await Run.findById(run._id).lean(); assert.equal(+saved.updatedAt, original);
  assert.equal(saved.reward.password, undefined); assert.equal(saved.reward.verifiedAt, NOW);
  assert.equal((await req("stock", { ...body, reward: reward({ giftId: "999" }) })).status, 409);
  assert.equal((await Run.findById(run._id)).rewardBlocked, true);
});

test("a changed verified reward withdraws its unsold unit and preserves a sold unit", async () => {
  const run = await seed(); await createIngest(deps()).run(); const row = await Stock.findOne({}).lean();
  const product = await models.CodeProduct.create({ name: "Fixture", status: "active", offer: new mongoose.Types.ObjectId(), slots: [{ slotKey: row.slotKey, label: "10x Diamond" }] });
  const result = await createUnits(deps()).build(product.toObject(), [[row._id]]);
  assert.equal(result.built, 1); await Run.updateOne({ _id: run._id }, { $set: { rewardBlocked: true } });
  await createIngest(deps()).run();
  assert.equal((await Stock.findById(row._id)).state, "held");
  assert.equal((await models.SuppliedAccount.findById(result.unitIds[0])).status, "removed");
  await Stock.updateOne({ _id: row._id }, { $set: { state: "sold" } });
  await source.withdrawBlocked(deps()); assert.equal((await Stock.findById(row._id)).state, "sold");
});

test("code shop blocks duplicates across farms and attributes TikTok revenue separately", async () => {
  await seed();
  await models.SoopInventoryItem.create({ loginId: "soop-fixture", key: "1", kind: "code", hasCode: true,
    name: "Fixture", codeEnc: secret.encrypt("SYNTHETIC-tiktok-01-200"), sentAt: new Date(NOW - 3 * DAY) });
  await createIngest(deps()).run();
  assert.equal((await Stock.findOne({ loginId: "tiktok:tiktok-01" })).state, "held");
  await Stock.deleteMany({});
  await Stock.create({ loginId: "tiktok:tiktok-01", itemKey: "fixture", gameNo: "930001", groupKey: "930001:tiktok-100",
    state: "sold", unit: new mongoose.Types.ObjectId(), soldAt: new Date(NOW - 1000), saleUsd: 2, market: "eldorado" });
  const board = await require("../utils/codeShop/board").createBoard(deps()).build();
  assert.equal(board.sources.find((s) => s.id === "tiktok").revenue.all, 2);
  assert.equal(board.sources.find((s) => s.id === "soop").revenue.all, 0);
  assert.equal(board.sales[0].bySource.tiktok.usd, 2);
  assert.deepEqual(board.sales[0].sources, ["tiktok"]);
});

test("TikTok covers use refreshed native artwork and reject unrelated image hosts", async () => {
  const { imageUrl } = require("../utils/tiktokRewards");
  assert.equal(imageUrl("https://localhost/reward.png"), "");
  assert.equal(imageUrl("https://p19.tiktokcdn.com.evil.test/reward.png"), "");
  assert.equal(imageUrl("https://name:secret@p19.tiktokcdn.com/reward.png"), "");
  assert.equal(imageUrl("http://p16-common-sign.tiktokcdn-us.com/reward.webp?x-expires=1"),
    "https://p16-common-sign.tiktokcdn-us.com/reward.webp?x-expires=1");
  const old = "https://p19.tiktokcdn.com/reward.webp?x-expires=1", fresh = "https://p19.tiktokcdn.com/reward.webp?x-expires=9999999999";
  await seed("tiktok-01", { reward: reward({ image: old }) });
  await seed("tiktok-02", { reward: reward({ image: fresh, verifiedAt: NOW + 1 }) });
  await createIngest(deps()).run();
  const slotKey = (await Stock.findOne({}).lean()).slotKey;
  assert.equal((await source.images(deps(), [{ slotKey, image: old }])).get(slotKey), fresh);
  let passed;
  const cover = require("../utils/codeShop/cover").createCover({ ...deps(),
    sharp: () => ({ png: () => ({ toBuffer: async () => Buffer.from("synthetic-png") }) }),
    setImage: () => ({ buildPromoCoverImage: async (options) => { passed = options; return "synthetic-cover"; } }),
  });
  await cover.build({ slots: [{ slotKey, image: "" }], texts: { coverTitle: "Fixture", coverServiceText: "Redeem code" } });
  assert.equal(passed.itemImages[0], fresh);
});

test("Sales exposes draft validation problems without code fields", async (t) => {
  await seed(); await createIngest(deps()).run(); await createPlanner(deps()).run();
  const p = await models.CodeProduct.findOne({}); p.slots[0].label = ""; await p.save();
  const app = express(); app.use((req, res, next) => { req.session = { admin: { role: "superadmin", tfa: true } }; next(); });
  app.use(require("../routes/tiktokFarmRoutes"));
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  t.after(() => new Promise((r) => server.close(r)));
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/tiktok-farm/sales`); assert.equal(r.status, 200);
  const out = await r.json(); assert.ok(out.products[0].problems.includes("label 1 is empty"));
  assert.ok(!JSON.stringify(out).includes("SYNTHETIC-"));
});

test("new game profiles keep PC/mobile stock separate and produce guarded redemption guides", async () => {
  const profiles = [
    ["7223211460934503169", "PUBG MOBILE", "https://www.pubgmobile.com/en/event/redeemcode/", "Theme Token X 10", "930005"],
    ["7276730075688531204", "Delta Force Mobile", "https://www.playdeltaforce.com/en/cdkredeem.html", "SG552 - Purr Baby", "930006"],
    ["7276547073576525572", "Delta Force", "https://www.playdeltaforce.com/en/cdkredeem.html", "SG552 - Purr Baby", "930007"],
    ["7278453307944521732", "OneState", "https://onestate.com/promocode", "$10k State Bucks US", "930008"],
  ];
  const { eligibility } = require("../utils/tiktokRewards");
  for (const [i, [gameId, gameName, redeemUrl, name, gameNo]] of profiles.entries()) {
    const r = reward({ gameId, gameName, redeemUrl, redeemType: 1, name, items: [{ name, count: 1 }] });
    assert.equal(eligibility(r), "");
    assert.ok(eligibility({ ...r, redeemUrl: "https://example.com/redeem" }));
    assert.ok(eligibility({ ...r, redeemUrl: new URL("/different-region", redeemUrl).href }));
    assert.ok(eligibility({ ...r, redeemType: 2 }));
    assert.ok(eligibility({ ...r, verifiedAt: undefined }));
    await seed(`tiktok-0${i + 1}`, { reward: r });
    assert.match(guideFor(gameNo, cfg).deliveryHelp, /https:\/\//);
  }
  assert.ok(eligibility(reward({ gameId: "7278453307944521732", gameName: "OneState", redeemUrl: "https://onestate.com/promocode", redeemType: 1, name: "$10k State Bucks EU" })));
  assert.equal((await createIngest(deps()).run()).added, 4);
  const stock = await Stock.find({}).lean();
  assert.equal(new Set(stock.map(x => x.gameNo)).size, 4);
  assert.equal(new Set(stock.map(x => x.slotKey)).size, 4);
  await createPlanner(deps()).run();
  const products = await models.CodeProduct.find({}).lean();
  assert.equal(products.length, 4);
  for (const p of products) {
    assert.deepEqual(p.markets, ["eldorado"]);
    assert.equal(checkBuyerText(p.texts, cfg).length, 0);
    assert.match(p.texts.description, /REDEEM BY 24 November 2026/);
    assert.ok(p.texts.description.length <= 2000);
    const row = stock.find(x => x.gameNo === p.gameNo);
    const active = { ...p, status: "active", offer: new mongoose.Types.ObjectId() };
    await models.CodeProduct.updateOne({ _id: p._id }, { $set: { status: active.status, offer: active.offer } });
    const built = await createUnits(deps()).build(active, [[row._id]]);
    assert.equal(built.built, 1);
    const unit = await models.SuppliedAccount.findById(built.unitIds[0]);
    assert.ok(secret.decrypt(unit.password).endsWith(`SYNTHETIC-${row.loginId.slice(7)}-200`));
  }
  assert.match(products.find(p => p.gameNo === "930006").texts.title, /Mobile/);
  assert.match(products.find(p => p.gameNo === "930007").texts.title, /PC/);
  assert.match(products.find(p => p.gameNo === "930008").texts.description, /US server/);
});

test("verified hair cosmetic gets a descriptive label without weakening source guards", async () => {
  const { buyerLabelOf } = require("../utils/tiktokRewards");
  const r = reward({ gameId: "7279025357352522244", gameName: "Wolvesville", redeemType: 1,
    redeemUrl: "https://vouchers.wolvesville.com/", name: "TikTok Hair - November 2026", items: [{ name: "TikTok Hair", count: 1 }] });
  assert.equal(buyerLabelOf(r), "1x Hair Cosmetic");
  assert.equal(buyerLabelOf({ ...r, gameId: "999" }), "1x TikTok Hair");
  assert.equal(buyerLabelOf({ ...r, items: [{ name: "TikTok Hat", count: 1 }] }), "1x TikTok Hat");
  await seed("tiktok-01", { reward: r });
  await createIngest(deps()).run();
  const row = await Stock.findOne({}).lean();
  assert.equal(row.nameRaw, "1x TikTok Hair");
  assert.equal(row.name, "1x Hair Cosmetic");
  await createPlanner(deps()).run();
  let p = await models.CodeProduct.findOne({}).lean();
  assert.equal(p.slots[0].label, "1x Hair Cosmetic");
  assert.equal(checkBuyerText(p.texts, cfg).length, 0);
  await models.CodeProduct.updateOne({ _id: p._id }, { $set: { "slots.0.label": "" } });
  await createPlanner(deps()).run();
  p = await models.CodeProduct.findById(p._id).lean();
  assert.equal(p.slots[0].label, "1x Hair Cosmetic", "existing draft repairs itself");
  assert.ok(checkBuyerText({ ...p.texts, title: "TikTok Hair" }, cfg).length > 0);
});
