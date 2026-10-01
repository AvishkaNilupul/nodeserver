// The Gameflip sale watcher and listings that EXPIRED while Gameflip still
// called them "onsale" (2026-10-01).
//
// Every listing is created with expire_in_days: 30. Past its `expiration`
// Gameflip drops it from search — no buyer can find it — but a direct read still
// answers status "onsale" (or "ready"). The watcher only knew `status ===
// "expired"`, so 98 of 396 active rows (the oldest expired 08-25, one chain
// still owing 309 units) stayed "active" forever: accounts reserved, owed units
// never relisted, and — because they sit in neither bulk sweep — each one read
// individually on every 60s tick. That storm of ~100 GETs a minute is what kept
// Gameflip answering 429 to relists, publishes and the health page.
//
// Runs the real syncOnce against mongodb-memory-server with the marketplace
// faked; a listing is "ended" only through the fake, so nothing real is touched.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.SESSION_SECRET ||= "gf-expired-listings-test";
process.env.CRED_SECRET ||= "gf-expired-listings-cred";

const world = { onsale: new Set(), state: {}, ended: [], stateReads: [], endFails: new Set() };

const fakeMp = {
  keyStatus: () => ({ gameflip: { configured: true } }),
  async gameflipListingIdsByStatus(status) {
    return status === "onsale" ? new Set(world.onsale) : new Set();
  },
  async gameflipListingState(id) {
    world.stateReads.push(id);
    const s = world.state[id];
    if (!s) {
      const e = new Error("Gameflip listing status: not found");
      e.status = 404;
      throw e;
    }
    return { ...s };
  },
  async gameflipListingStatus() {
    throw new Error("the expiry-aware read must be used when available");
  },
  async gameflipEndListing(id, opts) {
    if (world.endFails.has(id)) {
      const e = new Error('Gameflip end listing (off sale): {"code":429}');
      e.status = 429;
      throw e;
    }
    world.ended.push({ id, status: opts && opts.status });
    return { deleted: true };
  },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /utils[\\/]gameflipFulfiller\.js$/.test(parent.filename || "")) {
    if (request === "./marketplaces") return fakeMp;
    if (request === "./telegram") return { sendTelegram: async () => {} };
    if (request === "./gameflipFarmService") {
      return { renewsOnExpiry: () => false, onBufferedSale: async () => ({}) };
    }
  }
  return realLoad.call(this, request, parent, isMain);
};

const MarketplaceListing = require("../models/MarketplaceListing");
const gf = require("../utils/gameflipFulfiller");

let mongod;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});
test.after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});
test.beforeEach(async () => {
  await MarketplaceListing.deleteMany({});
  world.onsale = new Set();
  world.state = {};
  world.ended = [];
  world.stateReads = [];
  world.endFails = new Set();
});

const PAST = "2026-08-25T17:06:48.066Z";
const FUTURE = new Date(Date.now() + 20 * 86400000).toISOString();

async function row(externalId, over = {}) {
  return MarketplaceListing.create({
    set: new mongoose.Types.ObjectId(),
    marketplace: "gameflip",
    externalId,
    title: "Escape from Tarkov Twitch Drops (3 Items) " + externalId,
    price: 2,
    status: "active",
    origin: "manual",
    autoDeliver: false,
    ...over,
  });
}

test("REGRESSION 2026-10-01: an 'onsale' listing past its expiry is ended on Gameflip, then retired", async () => {
  await row("gf-lapsed");
  world.state["gf-lapsed"] = { status: "onsale", expiration: PAST, expired: true };
  await gf.syncOnce();
  assert.deepStrictEqual(world.ended, [{ id: "gf-lapsed", status: "onsale" }]);
  const after = await MarketplaceListing.findOne({ externalId: "gf-lapsed" }).lean();
  assert.strictEqual(after.status, "removed");
  assert.match(after.lastError, /expired/);
});

test("the account is never released while the listing could still sell: a failed end leaves the row alone", async () => {
  await row("gf-stuck");
  world.state["gf-stuck"] = { status: "onsale", expiration: PAST, expired: true };
  world.endFails.add("gf-stuck");
  await gf.syncOnce();
  const after = await MarketplaceListing.findOne({ externalId: "gf-stuck" }).lean();
  assert.strictEqual(after.status, "active", "a 429 on the end must not retire the row");
  assert.strictEqual(after.lastError || "", "");
});

test("a listing inside its 30 days, and one in the onsale sweep, are left exactly as they were", async () => {
  await row("gf-fresh");
  await row("gf-swept");
  world.state["gf-fresh"] = { status: "onsale", expiration: FUTURE, expired: false };
  world.onsale.add("gf-swept");
  await gf.syncOnce();
  assert.deepStrictEqual(world.ended, []);
  assert.deepStrictEqual(world.stateReads, ["gf-fresh"], "a swept row costs no individual read");
  for (const id of ["gf-fresh", "gf-swept"]) {
    assert.strictEqual((await MarketplaceListing.findOne({ externalId: id }).lean()).status, "active");
  }
});

test("a 'ready' listing past its expiry is retired too, without an off-sale patch it does not need", async () => {
  await row("gf-ready-old");
  world.state["gf-ready-old"] = { status: "ready", expiration: PAST, expired: true };
  await gf.syncOnce();
  assert.deepStrictEqual(world.ended, [{ id: "gf-ready-old", status: "ready" }]);
  assert.strictEqual((await MarketplaceListing.findOne({ externalId: "gf-ready-old" }).lean()).status, "removed");
});

test("the backlog is bounded: individual reads and ends per pass are capped and rotate", async () => {
  // 30 unplaced rows, all lapsed: one pass reads at most 25 and ends at most 5.
  for (let i = 0; i < 30; i++) {
    const id = "gf-old-" + String(i).padStart(2, "0");
    await row(id);
    world.state[id] = { status: "onsale", expiration: PAST, expired: true };
  }
  await gf.syncOnce();
  assert.ok(world.stateReads.length <= 25, "read " + world.stateReads.length + " in one pass");
  assert.strictEqual(world.ended.length, 5);
  const firstReads = new Set(world.stateReads);
  world.stateReads = [];
  await gf.syncOnce();
  assert.strictEqual(world.ended.length, 10, "the next pass ends the next five");
  assert.ok(
    world.stateReads.some((id) => !firstReads.has(id)),
    "the read window must move, or the tail is never reached",
  );
  assert.strictEqual(
    await MarketplaceListing.countDocuments({ status: "removed" }),
    10,
  );
});
