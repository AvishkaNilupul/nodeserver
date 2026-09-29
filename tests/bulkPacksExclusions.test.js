// Bulk packs — hooks H5–H12: every AUTOMATIC sweep leaves a bulk row alone
// (docs/bulk-packs/CONTRACT.md §3, §8 and its "verify" bullet;
// docs/bulk-packs/API-UI.md "Tests", A10).
//
// A bulk dropset/noclaim offer is also an ordinary MarketplaceListing row
// (origin "manual" + bulkOfferId -> BulkOffer) that only the bulk loop writes.
// Each test puts a bulk row beside an ordinary row the sweep SHOULD act on, and
// proves the sweep reaches the ordinary row and never the bulk one. Most tests
// also re-run with bulkOfferId removed, to show it is the hook — not the
// fixture — that keeps the bulk row out. Where the sweep cannot run on its own
// (backfillActiveTasks, buildPublicCatalog) a source tripwire pins the filter
// in that function body and runs the literal filter against the fixtures.
//
// Fixtures go in through Model.collection.insertOne, so they behave the same
// whether or not models/MarketplaceListing.js declares bulkOfferId yet (H1).
// Memory Mongo only. The marketplace client, Telegram, the detach surgery, the
// price scouts and the no-claim stock count are replaced BEFORE the modules
// under test load; every other marketplace call is a tripwire that throws, so
// nothing here reaches the network or writes utils/settings.json.
process.env.CRED_SECRET ||= "test-secret";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ------------------------------------------------------ fakes (load first) --

const world = {
  mpHits: [],
  telegram: [],
  detached: [],
  eldoradoReads: [],
  gfSold: new Set(),
  gfLive: new Set(),
  scoutActive: [],
  scoutSold: [],
  af: {},
};

// Settings first: g2gFulfiller destructures getAutoFarm at require time.
const settings = require("../utils/settings");
const realGetAutoFarm = settings.getAutoFarm;
settings.getAutoFarm = (...args) => ({ ...realGetAutoFarm(...args), ...world.af });

// Every marketplace call is a tripwire; the few the sweeps need are faked.
const mp = require("../utils/marketplaces");
for (const [name, fn] of Object.entries(mp)) {
  if (typeof fn !== "function") continue;
  mp[name] = () => {
    world.mpHits.push(name);
    throw new Error("network tripwire: marketplaces." + name);
  };
}
mp.gameflipListingIdsByStatus = async (status) =>
  status === "sold" ? world.gfSold : world.gfLive;
mp.gameflipOwnerId = async () => "our-seller";
mp.eldoradoOffer = async (id) => {
  world.eldoradoReads.push(id);
  return { offerState: "Active", quantity: 0 };
};

const telegram = require("../utils/telegram");
for (const [name, fn] of Object.entries(telegram)) {
  if (typeof fn !== "function") continue;
  telegram[name] = async (msg) => {
    world.telegram.push(String(msg));
    return true;
  };
}

// utils/marketResearch destructures the scouts at require time.
const scout = require("../utils/priceScout");
scout.gameflipScout = async () => world.scoutActive;
scout.gameflipSoldScout = async () => world.scoutSold;
scout.ggselScout = async () => [];
scout.platiScout = async () => [];

// Required lazily by fixDedupe / retireFromLiveListings at call time.
const listingDetach = require("../utils/listingDetach");
listingDetach.detachAccountFromListing = async (row, acc) => {
  world.detached.push(String(row._id));
  return { detached: ["pulled " + (acc.login || acc._id)], warnings: [] };
};

// Required lazily by syncBundleStock / realStockFor at call time.
const noclaimStock = require("../utils/noclaimStock");
noclaimStock.stockForListing = async () => 2;

// ------------------------------------------------------ modules under test --

const MarketplaceListing = require("../models/MarketplaceListing");
const DropSet = require("../models/DropSet");
const BotAccount = require("../models/BotAccount");
const AuditFinding = require("../models/AuditFinding");
const MarketResearchSnapshot = require("../models/MarketResearchSnapshot");
const guardian = require("../utils/marketplaceGuardian");
const { fixFinding } = require("../utils/guardianFixes");
const suspended = require("../utils/suspendedAccounts");
const gameflip = require("../utils/gameflipFulfiller");
const evidence = require("../utils/pricingEvidence");
const research = require("../utils/marketResearch");
const eldorado = require("../utils/eldoradoFulfiller");
const g2g = require("../utils/g2gFulfiller");
const { buyLinksFor } = require("../utils/catalogPublic");

// ---------------------------------------------------------------- helpers --

const oid = () => new mongoose.Types.ObjectId();

async function insertRow(doc) {
  const _id = oid();
  const now = new Date();
  await MarketplaceListing.collection.insertOne({
    _id,
    title: "Rust Twitch Drops bundle",
    price: 1,
    status: "active",
    origin: "manual",
    units: [],
    createdAt: now,
    updatedAt: now,
    ...doc,
  });
  return _id;
}

// A bulk offer's row: origin "manual" plus bulkOfferId (CONTRACT §3).
const insertBulk = (doc) => insertRow({ ...doc, origin: "manual", bulkOfferId: oid() });

const unsetBulk = (id) =>
  MarketplaceListing.collection.updateOne({ _id: id }, { $unset: { bulkOfferId: "" } });

const row = (id) => MarketplaceListing.collection.findOne({ _id: id });

async function insertSet() {
  const _id = oid();
  await DropSet.collection.insertOne({
    _id,
    name: "Rust bundle",
    items: [{ itemKey: "rust-hoodie", name: "Rust Hoodie", game: "Rust", qty: 1 }],
    listed: true,
    price: 1.25,
  });
  return _id;
}

const unit = (accountId, login) => ({
  contentId: "",
  accountId: String(accountId),
  login,
  addedAt: new Date(),
  deliveredAt: null,
  orderId: "",
  messagedAt: null,
});

// The source of one top-level function, up to its closing brace at column 0.
function bodyOf(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, signature + " not found");
  const rest = src.slice(start);
  return rest.slice(0, rest.indexOf("\n}\n"));
}

// The object literal that is the first argument of the call found at `at`.
function firstObjectArg(code, at) {
  const open = code.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return code.slice(open, i + 1);
  }
  throw new Error("unbalanced object literal");
}

// ------------------------------------------------------------------ setup --

let mongod;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("bulk-packs-exclusions"));
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all(
    Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})),
  );
  world.mpHits = [];
  world.telegram = [];
  world.detached = [];
  world.eldoradoReads = [];
  world.gfSold = new Set();
  world.gfLive = new Set();
  world.scoutActive = [];
  world.scoutSold = [];
  world.af = {};
});

// ------------------------------------------------------------- H5 guardian --

test("H5 guardian: a bulk row is outside the pass (feed, checks, heal) and feedOne", async () => {
  const setId = await insertSet();
  const single = await insertRow({
    set: setId,
    marketplace: "gameflip",
    externalId: "gf-single",
    autoDeliver: true,
    origin: "auto",
    accountLogin: "alpha",
  });
  // Shares "alpha" on the same set: a duplicate-account finding if it were seen.
  const pack = await insertBulk({
    set: setId,
    marketplace: "gameflip",
    externalId: "gf-pack",
    autoDeliver: true,
    qtyRemaining: 0,
    accountLogin: "alpha, beta",
  });

  const run = await guardian.runOnce();
  assert.equal(run.listingsChecked, 1, "only the ordinary row is in the pass");
  assert.equal(run.issuesDetected, 0);
  assert.equal(await AuditFinding.countDocuments({ type: "duplicate-account" }), 0);
  await assert.rejects(guardian.feedOne(pack), /not an active auto-delivery listing/);
  assert.equal(await guardian.feedOne(single), 0, "the ordinary row is still fed");

  // Control: the same row without bulkOfferId IS a duplicate the pass flags.
  await unsetBulk(pack);
  const again = await guardian.runOnce();
  assert.equal(again.listingsChecked, 2);
  assert.equal(await AuditFinding.countDocuments({ type: "duplicate-account" }), 1);
  assert.deepEqual(world.mpHits, []);
});

// ---------------------------------------------------------- H6 fixDedupe --

test("H6 fixDedupe: a bulk row is never the detached loser", async () => {
  const day = 86400000;
  await insertRow({
    marketplace: "gameflip",
    externalId: "gf-keep",
    accountLogin: "alpha",
    createdAt: new Date(Date.now() - 3 * day),
  });
  const loser = await insertRow({
    marketplace: "eldorado",
    externalId: "el-loser",
    accountLogin: "alpha",
    createdAt: new Date(Date.now() - day),
  });
  // Newest of the three, so without the hook it would be a loser too.
  const pack = await insertBulk({
    marketplace: "gameflip",
    externalId: "gf-pack",
    accountLogin: "alpha, beta",
  });
  const finding = (key) =>
    AuditFinding.create({
      type: "duplicate-account",
      severity: "high",
      dedupeKey: key,
      accountLogin: "alpha",
      message: "alpha is on several live listings",
    });

  const res = await fixFinding(String((await finding("dup:1"))._id));
  assert.equal(res.action, "dedupe");
  assert.deepEqual(world.detached, [String(loser)]);

  // Control: without bulkOfferId the same row is detached as a loser.
  await unsetBulk(pack);
  world.detached = [];
  await fixFinding(String((await finding("dup:2"))._id));
  assert.deepEqual(world.detached.sort(), [String(loser), String(pack)].sort());
  assert.deepEqual(world.mpHits, []);
});

// ------------------------------------------------ H7 suspended retirement --

test("H7 retireFromLiveListings: a bulk row is left to the bulk loop", async () => {
  const acc = oid();
  await BotAccount.collection.insertOne({
    _id: acc,
    login: "gonebot",
    lastScanStatus: "suspended",
  });
  const single = await insertRow({
    marketplace: "gameflip",
    externalId: "gf-single",
    autoDeliver: true,
    origin: "auto",
    accountId: String(acc),
    accountLogin: "gonebot",
  });
  const pack = await insertBulk({
    marketplace: "eldorado",
    externalId: "el-pack",
    autoDeliver: false,
    units: [unit(acc, "gonebot")],
  });

  const report = await suspended.retireFromLiveListings();
  assert.equal(report.listings, 1);
  assert.deepEqual(world.detached, [String(single)]);

  // Control: without bulkOfferId the sweep would operate on it.
  await unsetBulk(pack);
  world.detached = [];
  await suspended.retireFromLiveListings();
  assert.ok(world.detached.includes(String(pack)));
  assert.deepEqual(world.mpHits, []);
});

// ------------------------------------------------ H8 backfill (tripwire) --

test("H8 backfillActiveTasks: the qtyRemaining top-up skips bulk rows (tripwire)", async () => {
  // Not callable in isolation (needs a bot host, pool and containers), so pin
  // the filter in the function body and run that literal filter for real.
  const body = bodyOf(read("utils/autoFarmer.js"), "async function backfillActiveTasks(");
  const at = body.indexOf("MarketplaceListing.updateOne(");
  assert.ok(at > 0, "backfill's listing top-up not found");
  assert.match(body.slice(at, at + 600), /\$inc: \{ qtyRemaining: addNow \}/);
  const literal = firstObjectArg(body, at);
  assert.match(literal, /bulkOfferId: null/);

  const setId = oid();
  // The pack goes in first, so natural order would pick it without the hook.
  const pack = await insertBulk({
    set: setId,
    marketplace: "gameflip",
    externalId: "gf-pack",
    autoDeliver: true,
    qtyRemaining: 0,
  });
  const single = await insertRow({
    set: setId,
    marketplace: "gameflip",
    externalId: "gf-chain",
    autoDeliver: true,
    origin: "auto",
    qtyRemaining: 3,
  });
  const filter = new Function("task", "return (" + literal + ");")({
    listing: { setId },
  });
  await MarketplaceListing.collection.updateOne(filter, { $inc: { qtyRemaining: 2 } });
  assert.equal((await row(pack)).qtyRemaining, 0, "a bulk pack is never re-queued");
  assert.equal((await row(single)).qtyRemaining, 5);
});

// -------------------------------------------------- H9 gameflip relisting --

test("H9 gameflip after-sale lane: a sold bulk pack is marked sold and announced, never relisted", async () => {
  // Both rows owe units (a pack never should — the qtyRemaining guard alone
  // would hide a broken hook) and point at a set that is gone, so any relist
  // attempt shows up as noteRelistFailure's "auto-relist failed" stamp.
  const goneSet = oid();
  const single = await insertRow({
    set: goneSet,
    marketplace: "gameflip",
    externalId: "gf-single",
    autoDeliver: true,
    origin: "auto",
    qtyRemaining: 2,
  });
  const pack = await insertBulk({
    set: goneSet,
    marketplace: "gameflip",
    externalId: "gf-pack",
    autoDeliver: true,
    qtyRemaining: 2,
  });
  world.gfSold = new Set(["gf-single", "gf-pack"]);

  const res = await gameflip.syncOnce();
  assert.equal(res.sold, 2, "sale marking still sees the bulk row");
  const [s, p] = await Promise.all([row(single), row(pack)]);
  assert.equal(s.status, "sold");
  assert.equal(p.status, "sold");
  assert.match(s.lastError || "", /^auto-relist failed/, "control reached the relist lane");
  assert.ok(!p.lastError, "the bulk pack never reached the relist lane");
  assert.equal(p.relistAttempts, undefined);
  assert.equal(world.telegram.filter((m) => /SOLD on Gameflip/.test(m)).length, 2);
  assert.deepEqual(world.mpHits, []);
});

test("H9 gameflip stalled-relist lane: a bulk pack is never retried or leased", async () => {
  const stalled = {
    set: oid(),
    marketplace: "gameflip",
    status: "sold",
    autoDeliver: true,
    qtyRemaining: 2,
    lastError: "auto-relist failed: HTTP 429",
    relistRetryAt: null,
  };
  const single = await insertRow({ ...stalled, externalId: "gf-single", origin: "auto" });
  const pack = await insertBulk({ ...stalled, externalId: "gf-pack" });

  await gameflip.syncOnce();
  const [s, p] = await Promise.all([row(single), row(pack)]);
  assert.equal(s.relistAttempts, 1, "the ordinary chain was retried");
  assert.match(s.lastError, /no longer exists/);
  assert.equal(p.relistAttempts, undefined);
  assert.equal(p.relistRetryAt, null, "not even leased");
  assert.equal(p.lastError, "auto-relist failed: HTTP 429");
  assert.deepEqual(world.mpHits, []);
});

// --------------------------------------------------- H10 price evidence --

test("H10 pricingEvidence: a sold bulk row is not a sold-price sample", async () => {
  await insertRow({ marketplace: "eldorado", externalId: "el-single", status: "sold", price: 2 });
  const pack = await insertBulk({
    marketplace: "eldorado",
    externalId: "el-pack",
    status: "sold",
    price: 0.5,
  });

  let snap = await evidence.buildSnapshot();
  assert.equal(snap.counts.soldListings, 1);
  assert.deepEqual(snap.platform.get("eldorado"), [2]);
  assert.deepEqual(snap.global, [2]);

  // Control: the discounted price would otherwise drag the venue down.
  await unsetBulk(pack);
  snap = await evidence.buildSnapshot();
  assert.deepEqual(snap.platform.get("eldorado").sort(), [0.5, 2]);
});

// ---------------------------------------------- H11 public catalog links --

test("H11 buildPublicCatalog: a bulk row never becomes a public buy link (tripwire)", async () => {
  const body = bodyOf(read("routes/catalogRoutes.js"), "async function buildPublicCatalog(");
  const at = body.indexOf("MarketplaceListing.find(");
  assert.ok(at > 0, "the buy-link read not found");
  const literal = firstObjectArg(body, at);
  assert.match(literal, /bulkOfferId: null/);

  const setId = await insertSet();
  await insertRow({
    set: setId,
    marketplace: "eldorado",
    externalId: "el-single",
    url: "https://www.eldorado.gg/single",
    price: 1.25,
  });
  // Cheaper per account, so buyLinksFor would pick it for the eldorado slot.
  await insertBulk({
    set: setId,
    marketplace: "eldorado",
    externalId: "el-pack",
    url: "https://www.eldorado.gg/pack",
    price: 1.19,
  });
  const filter = new Function("buyIds", "return (" + literal + ");")([String(setId)]);
  const rows = await MarketplaceListing.find(filter, {
    set: 1,
    marketplace: 1,
    url: 1,
    price: 1,
    status: 1,
  }).lean();
  assert.deepEqual(
    buyLinksFor(rows).map((l) => l.url),
    ["https://www.eldorado.gg/single"],
  );
  // Control: unfiltered, the bulk offer would win the marketplace's slot.
  const all = await MarketplaceListing.find({ set: setId, status: "active" }).lean();
  assert.deepEqual(buyLinksFor(all).map((l) => l.url), ["https://www.eldorado.gg/pack"]);
});

// ------------------------------------------------- H12 market research --

test("H12 marketResearch: our own Gameflip bulk packs never anchor a price", async () => {
  const packs = [
    await insertBulk({ marketplace: "gameflip", externalId: "pack-live", price: 6 }),
    await insertBulk({ marketplace: "gameflip", externalId: "pack-sold", status: "sold", price: 6 }),
  ];
  const now = new Date().toISOString();
  const scouted = (id, price, seller, updated = null) => ({
    title: "Rust Twitch Drops bundle",
    price,
    url: "https://gameflip.com/item/" + id,
    updated,
    seller,
    sellerName: "",
    sold: undefined,
  });
  world.scoutActive = [scouted("single-live", 1, "our-seller"), scouted("pack-live", 6, "our-seller")];
  world.scoutSold = [scouted("rival-sold", 1, "rival", now), scouted("pack-sold", 6, "our-seller", now)];

  const typical = async () =>
    (await MarketResearchSnapshot.findOne({ gameKey: "rust" }).sort({ at: -1, _id: -1 }).lean())
      .typicalPrice;

  let doc = await research.refreshGame("Rust");
  let gf = doc.markets.gameflip;
  assert.equal(gf.active, 1);
  assert.equal(gf.lowest, 1);
  assert.equal(gf.median, 1, "a pack price is not a unit price");
  assert.equal(gf.soldRecent, 1);
  assert.equal(gf.avgSoldPrice, 1);
  assert.equal(await typical(), 1);

  // Control: the same listings without bulkOfferId pull the anchors up.
  await Promise.all(packs.map(unsetBulk));
  doc = await research.refreshGame("Rust");
  gf = doc.markets.gameflip;
  assert.equal(gf.median, 6);
  assert.equal(gf.avgSoldPrice, 3.5);
  assert.equal(await typical(), 6);
  assert.deepEqual(world.mpHits, []);
});

// ------------------------------------- verify: stock syncs (no change) --

test("verify eldorado syncBundleStock: never selects a dropset bulk row, does select a noclaim one", async () => {
  const setId = await insertSet();
  await insertBulk({
    set: setId,
    marketplace: "eldorado",
    externalId: "el-dropset-pack",
    autoDeliver: false,
    qtyTarget: 5,
    units: [unit(oid(), "alpha")],
  });
  // Wanted: a no-claim bulk offer shares the claim-at-sale shelf (CONTRACT §3).
  await insertBulk({
    set: setId,
    marketplace: "eldorado",
    externalId: "el-noclaim-pack",
    noclaimStock: true,
  });
  // Control: a set-backed row reaches the stock read the dropset row would.
  await insertRow({
    set: setId,
    marketplace: "eldorado",
    externalId: "el-auto",
    origin: "auto",
    autoClaimSet: true,
  });

  await eldorado.syncBundleStock({ dryRun: true });
  assert.deepEqual(world.eldoradoReads.sort(), ["el-auto", "el-noclaim-pack"]);
  assert.deepEqual(world.mpHits, []);
});

test("verify g2g syncStock: never selects a dropset bulk row, does select a noclaim one", async () => {
  world.af = { g2gAutoDeliver: true, g2gSyncStock: true, g2gDeliverDryRun: true };
  const setId = await insertSet();
  await insertBulk({
    set: setId,
    marketplace: "g2g",
    externalId: "g2g-dropset-pack",
    autoDeliver: false,
    qtyTarget: 5,
    units: [unit(oid(), "alpha")],
  });
  await insertBulk({
    set: setId,
    marketplace: "g2g",
    externalId: "g2g-noclaim-pack",
    noclaimStock: true,
  });
  // Control: an auto row with pre-reserved units is counted.
  await insertRow({
    marketplace: "g2g",
    externalId: "g2g-auto",
    origin: "auto",
    units: [unit(oid(), "beta")],
  });

  const res = await g2g.syncStock();
  assert.equal(res.dryRun, true);
  assert.equal(res.checked, 2);
  assert.deepEqual(
    res.changes.map((c) => c.offer).sort(),
    ["g2g-auto", "g2g-noclaim-pack"],
  );
  assert.deepEqual(world.mpHits, []);
});
