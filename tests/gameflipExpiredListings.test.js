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

const world = { onsale: new Set(), state: {}, ended: [], stateReads: [], endFails: new Set(), af: {} };

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
    if (request === "./settings") {
      return { getAutoFarm: () => world.af, getAccountListingSettings: () => ({}) };
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
  world.af = {};
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
  // More unplaced rows than one pass may read, all lapsed: a pass reads at most
  // UNPLACED_POLL_LIMIT of them and ends at most LAPSED_END_LIMIT.
  const N = gf.UNPLACED_POLL_LIMIT + 5;
  for (let i = 0; i < N; i++) {
    const id = "gf-old-" + String(i).padStart(2, "0");
    await row(id);
    world.state[id] = { status: "onsale", expiration: PAST, expired: true };
  }
  await gf.syncOnce();
  assert.ok(
    world.stateReads.length <= gf.UNPLACED_POLL_LIMIT,
    "read " + world.stateReads.length + " in one pass",
  );
  assert.strictEqual(world.ended.length, gf.LAPSED_END_LIMIT);
  const firstReads = new Set(world.stateReads);
  world.stateReads = [];
  await gf.syncOnce();
  assert.strictEqual(world.ended.length, 2 * gf.LAPSED_END_LIMIT, "the next pass ends the next batch");
  assert.ok(
    world.stateReads.some((id) => !firstReads.has(id)),
    "the read window must move, or the tail is never reached",
  );
  assert.strictEqual(
    await MarketplaceListing.countDocuments({ status: "removed" }),
    2 * gf.LAPSED_END_LIMIT,
  );
});

/* ------------------------------------------------------------------------ *
 * Renewal (the owner's choice, 2026-10-01): an auto-delivery listing that
 * expired unsold keeps its unit — a fresh listing replaces it.
 * ------------------------------------------------------------------------ */

function fakePublisher(impl) {
  const calls = [];
  return {
    calls,
    opts: {
      relistSourceFn: async () => ({ set: { _id: "set-1" }, offer: null, imagePath: "" }),
      publishFn: async (args) => {
        calls.push(args);
        return impl ? impl(args, calls.length) : { externalId: "gf-new-" + calls.length };
      },
    },
  };
}

async function chain(id, over = {}) {
  await row(id, { autoDeliver: true, qtyRemaining: 5, origin: "auto", price: 2.7, description: "the same text", ...over });
  world.state[id] = { status: "onsale", expiration: PAST, expired: true };
}

test("REGRESSION 2026-10-01: an expired chain is renewed for the SAME unit — qtyRemaining carries over", async () => {
  await chain("gf-chain");
  const pub = fakePublisher();
  const r = await gf.syncOnce(pub.opts);
  assert.deepStrictEqual(world.ended.map((e) => e.id), ["gf-chain"], "ended on Gameflip first");
  assert.strictEqual(pub.calls.length, 1);
  const a = pub.calls[0];
  assert.strictEqual(a.qtyRemaining, 5, "nothing sold, so the debt is unchanged");
  assert.strictEqual(a.priceUsd, 2.7);
  assert.strictEqual(a.origin, "auto");
  assert.strictEqual(a.description, "the same text");
  const after = await MarketplaceListing.findOne({ externalId: "gf-chain" }).lean();
  assert.strictEqual(after.status, "removed");
  assert.strictEqual(after.qtyRemaining, 0, "the debt moved to the new row");
  assert.match(after.lastError, /renewed as gf-new-1/);
  assert.strictEqual(r.renewed, 1);
});

test("a renewal that hits Gameflip's limiter backs off and stays pending — never double-published", async () => {
  await chain("gf-busy");
  const pub = fakePublisher(() => {
    throw new Error('Gameflip create: {"message":"Too many attempts - Retry later","code":429}');
  });
  await gf.syncOnce(pub.opts);
  let after = await MarketplaceListing.findOne({ externalId: "gf-busy" }).lean();
  assert.strictEqual(after.status, "removed");
  assert.match(after.lastError, /renewal pending \(attempt 1 failed/);
  assert.strictEqual(after.relistAttempts, 1);
  assert.ok(after.relistRetryAt > new Date(), "backoff pushed into the future");
  assert.strictEqual(after.qtyRemaining, 5, "the debt is kept for the retry");
  await gf.syncOnce(pub.opts);
  assert.strictEqual(pub.calls.length, 1, "inside the backoff nothing is retried");
});

test("out of stock ends the chain and says so — it is not retried forever", async () => {
  await chain("gf-dry");
  const pub = fakePublisher(() => {
    throw new Error("Out of stock — no unsold account holds this whole bundle, so there is nothing to auto-deliver");
  });
  await gf.syncOnce(pub.opts);
  const after = await MarketplaceListing.findOne({ externalId: "gf-dry" }).lean();
  assert.match(after.lastError, /^expired on Gameflip — not renewed: Out of stock/);
  await MarketplaceListing.updateOne({ externalId: "gf-dry" }, { $set: { relistRetryAt: null } });
  await gf.syncOnce(pub.opts);
  assert.strictEqual(pub.calls.length, 1, "a chain nothing can fill is not picked up again");
});

test("one renewal per pass, and a hand-made listing is never republished", async () => {
  await chain("gf-c1");
  await chain("gf-c2");
  await row("gf-handmade", { autoDeliver: false, qtyRemaining: 0 });
  world.state["gf-handmade"] = { status: "onsale", expiration: PAST, expired: true };
  const pub = fakePublisher();
  await gf.syncOnce(pub.opts);
  assert.strictEqual(world.ended.length, Math.min(3, gf.LAPSED_END_LIMIT), "all three are taken off Gameflip");
  assert.strictEqual(pub.calls.length, 1, "but only one publish a pass");
  await gf.syncOnce(pub.opts);
  assert.strictEqual(pub.calls.length, 2);
  const hand = await MarketplaceListing.findOne({ externalId: "gf-handmade" }).lean();
  assert.strictEqual(hand.status, "removed");
  assert.doesNotMatch(hand.lastError, /renew/);
  assert.ok(pub.calls.every((c) => !/gf-handmade/.test(c.title)), "the owner's own listing is theirs to republish");
});

test("autoFarm.gameflipRenewExpired = false parks renewals; switching it back on resumes them", async () => {
  await chain("gf-parked");
  world.af = { gameflipRenewExpired: false };
  const pub = fakePublisher();
  await gf.syncOnce(pub.opts);
  let after = await MarketplaceListing.findOne({ externalId: "gf-parked" }).lean();
  assert.strictEqual(after.status, "removed");
  assert.match(after.lastError, /^expired on Gameflip — renewal pending/);
  assert.strictEqual(pub.calls.length, 0);
  world.af = {};
  await gf.syncOnce(pub.opts);
  assert.strictEqual(pub.calls.length, 1);
  after = await MarketplaceListing.findOne({ externalId: "gf-parked" }).lean();
  assert.match(after.lastError, /renewed as/);
});
