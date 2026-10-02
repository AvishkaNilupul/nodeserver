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

const world = {
  onsale: new Set(),
  state: {},
  ended: [],
  stateReads: [],
  endFails: new Set(),
  af: {},
  telegrams: [],
  sweepFails: false,
};

const fakeMp = {
  keyStatus: () => ({ gameflip: { configured: true } }),
  async gameflipListingIdsByStatus(status) {
    if (world.sweepFails) throw new Error("Request failed with status code 429");
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
    if (request === "./telegram") {
      return { sendTelegram: async (m) => { world.telegrams.push(m); } };
    }
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
const DropLog = require("../models/DropLog");
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
  await DropLog.deleteMany({});
  world.telegrams = [];
  world.sweepFails = false;
  gf.resetRenewalAlert();
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

test("the account is never released while the listing could still sell: a failed end leaves the row active", async () => {
  await row("gf-stuck", { accountId: "a".repeat(24) });
  world.state["gf-stuck"] = { status: "onsale", expiration: PAST, expired: true };
  world.endFails.add("gf-stuck");
  await gf.syncOnce();
  const after = await MarketplaceListing.findOne({ externalId: "gf-stuck" }).lean();
  assert.strictEqual(after.status, "active", "a 429 on the end must not retire the row");
  assert.strictEqual(after.accountId, "a".repeat(24), "its account stays with it");
  // Stamped BEFORE the end, so a 404 later is read as "we ended it" — see below.
  assert.match(after.lastError, /^expired on Gameflip — ending \(2026-08-25\)/);
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

test("out of stock is a dip, not an end: the chain backs off, keeps its debt, and the owner hears once", async () => {
  // Ending a 520-unit chain on one empty read would lose it for good; the
  // stalled lane retries out-of-stock with backoff and alerts at the 3rd miss.
  await chain("gf-dry");
  const pub = fakePublisher(() => {
    throw new Error("Out of stock — no unsold account holds this whole bundle, so there is nothing to auto-deliver");
  });
  for (let pass = 1; pass <= 4; pass++) {
    await gf.syncOnce(pub.opts);
    // Expire the backoff so the next pass may retry.
    await MarketplaceListing.updateOne({ externalId: "gf-dry" }, { $set: { relistRetryAt: new Date(Date.now() - 1000) } });
  }
  const after = await MarketplaceListing.findOne({ externalId: "gf-dry" }).lean();
  assert.strictEqual(pub.calls.length, 4);
  assert.match(after.lastError, /^expired on Gameflip — renewal pending \(attempt 4 failed: Out of stock/);
  assert.strictEqual(after.qtyRemaining, 5, "the debt waits for stock");
  const alerts = world.telegrams.filter((m) => /OUT OF STOCK/.test(m));
  assert.strictEqual(alerts.length, 1, "told once, at the 3rd miss — not every pass");
});

test("REGRESSION 2026-10-01: a renewal that keeps failing for a non-stock reason is told once — not left silent", async () => {
  // The Hunt: Showdown chain (187 owed) failed eight times on "code for
  // digital goods already exists" with no live listing anywhere, and only the
  // log knew: the lane paged for out-of-stock alone.
  await chain("gf-stuck-renewal");
  // Already waiting, not due this pass: one more stuck for a non-stock reason
  // (counted in the summary) and one out of stock (the other page's business).
  const later = new Date(Date.now() + 3600000);
  await row("gf-stuck-older", {
    status: "removed", autoDeliver: true, relistAttempts: 7, relistRetryAt: later,
    lastError: "expired on Gameflip — renewal pending (attempt 7 failed: Gameflip create: socket hang up)",
  });
  await row("gf-dry-older", {
    status: "removed", autoDeliver: true, relistAttempts: 7, relistRetryAt: later,
    lastError: "expired on Gameflip — renewal pending (attempt 7 failed: Out of stock — no unsold account holds this whole bundle)",
  });
  const pub = fakePublisher(() => {
    throw new Error(
      'Gameflip could not attach the delivery content (draft d-1 discarded): {"error":{"message":"code for digital goods already exists"}}',
    );
  });
  const passes = gf.RENEWAL_STUCK_ALERT_AT_ATTEMPT + 2;
  for (let pass = 1; pass <= passes; pass++) {
    await gf.syncOnce(pub.opts);
    if (pass === gf.RENEWAL_STUCK_ALERT_AT_ATTEMPT - 1) {
      assert.strictEqual(world.telegrams.length, 0, "a short limiter storm is not paged");
    }
    await MarketplaceListing.updateOne(
      { externalId: "gf-stuck-renewal" },
      { $set: { relistRetryAt: new Date(Date.now() - 1000) } },
    );
  }
  assert.strictEqual(pub.calls.length, passes);
  const alerts = world.telegrams.filter((m) => /renewals keep FAILING/.test(m));
  assert.strictEqual(alerts.length, 1, "told once, at the 5th miss — not every pass");
  assert.match(alerts[0], /\n\n2 expired listing\(s\) have failed renewal/, "one summary: both stuck rows, not the dry one");
  assert.match(alerts[0], /code for digital goods already exists/, "the page carries the reason");
  assert.match(alerts[0], /5 more unit\(s\) owed/);
  assert.ok(!world.telegrams.some((m) => /OUT OF STOCK/.test(m)), "and it is not called out of stock");
  const after = await MarketplaceListing.findOne({ externalId: "gf-stuck-renewal" }).lean();
  assert.strictEqual(after.qtyRemaining, 5, "the chain keeps its debt and keeps retrying");
  assert.match(after.lastError, /^expired on Gameflip — renewal pending/);
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

/* ------------------------------------------------------------------------ *
 * Round two (independent review, 2026-10-01)
 * ------------------------------------------------------------------------ */

test("the unclaimed engine's units and lots are never renewed here — the engine relists them", async () => {
  await row("gf-unclaimed", { autoDeliver: true, origin: "unclaimed", accountId: "b".repeat(24), qtyRemaining: 0 });
  await row("gf-lot", { autoDeliver: true, origin: "unclaimed", lotSize: 4, lotId: "lot-1", qtyRemaining: 0 });
  for (const id of ["gf-unclaimed", "gf-lot"]) {
    world.state[id] = { status: "onsale", expiration: PAST, expired: true };
  }
  const pub = fakePublisher();
  await gf.syncOnce(pub.opts);
  await gf.syncOnce(pub.opts);
  assert.strictEqual(pub.calls.length, 0, "a second successor from the claimed archive is a double listing");
  for (const id of ["gf-unclaimed", "gf-lot"]) {
    const r = await MarketplaceListing.findOne({ externalId: id }).lean();
    assert.strictEqual(r.status, "removed");
    assert.doesNotMatch(r.lastError, /renewal/);
  }
});

test("a retired row loses its account link, so a later Delist on it can free nothing", async () => {
  await row("gf-linked", { autoDeliver: true, origin: "auto", accountId: "c".repeat(24), accountLogin: "acct-c", qtyRemaining: 2 });
  world.state["gf-linked"] = { status: "onsale", expiration: PAST, expired: true };
  await gf.syncOnce(fakePublisher().opts);
  const after = await MarketplaceListing.findOne({ externalId: "gf-linked" }).lean();
  assert.strictEqual(after.accountId, "", "Delist releases row.accountId for the row's set, whatever its status");
  assert.deepStrictEqual(after.units, []);
  assert.match(after.note, /expired on Gameflip 2026-08-25; account acct-c handed back/, "the login is kept in the record");
});

async function reserve(login, setId, accountId = new mongoose.Types.ObjectId()) {
  await DropLog.create({
    account: accountId,
    login,
    benefitId: "b-" + login + "-" + Math.random(),
    itemKey: "k1",
    soldAt: new Date(),
    soldToUsername: "gameflip",
    soldSetId: String(setId),
  });
  return accountId;
}

test("an auto-lister head row hands back the one account its code belongs to", async () => {
  // listActivatedTask never records accountId on its head row, so an expiry
  // left that account reserved for the set forever.
  const set = new mongoose.Types.ObjectId();
  await row("gf-head", { set, autoDeliver: true, origin: "auto", accountLogin: "headacct, spare1, spare2", qtyRemaining: 2 });
  world.state["gf-head"] = { status: "onsale", expiration: PAST, expired: true };
  const acct = await reserve("headacct", set);
  await gf.syncOnce(fakePublisher().opts);
  const left = await DropLog.countDocuments({ account: acct, soldAt: { $ne: null } });
  assert.strictEqual(left, 0, "its reservation for the set is released");
});

test("a head row's reservation is left alone when it is not unambiguous", async () => {
  const set = new mongoose.Types.ObjectId();
  await row("gf-head2", { set, autoDeliver: true, origin: "auto", accountLogin: "one, two", qtyRemaining: 1 });
  world.state["gf-head2"] = { status: "onsale", expiration: PAST, expired: true };
  await reserve("one", set);
  await reserve("two", set);
  const set3 = new mongoose.Types.ObjectId();
  await row("gf-head3", { set: set3, autoDeliver: true, origin: "auto", accountLogin: "mine", qtyRemaining: 1 });
  world.state["gf-head3"] = { status: "onsale", expiration: PAST, expired: true };
  await reserve("someone-else", set3);
  await gf.syncOnce(fakePublisher().opts);
  assert.strictEqual(await DropLog.countDocuments({ soldAt: { $ne: null } }), 3, "nothing released on doubt");
});

test("a 404 on a row the watcher had stamped as ending finishes the job — renewal included", async () => {
  // The delete went through, but the pass died (or a manual sync overlapped)
  // before the retirement was recorded. The plain 404 branch would end the chain.
  await row("gf-halfway", {
    autoDeliver: true,
    origin: "auto",
    qtyRemaining: 7,
    lastError: "expired on Gameflip — ending (2026-09-10)",
  });
  const pub = fakePublisher();
  await gf.syncOnce(pub.opts);
  const after = await MarketplaceListing.findOne({ externalId: "gf-halfway" }).lean();
  assert.strictEqual(after.status, "removed");
  assert.match(after.lastError, /renewed as gf-new-1/);
  assert.strictEqual(pub.calls[0].qtyRemaining, 7);
});

test("an unstamped 404 keeps the 404 branch it always had", async () => {
  await row("gf-gone", { autoDeliver: true, origin: "auto", qtyRemaining: 3 });
  const pub = fakePublisher();
  await gf.syncOnce(pub.opts);
  const after = await MarketplaceListing.findOne({ externalId: "gf-gone" }).lean();
  assert.match(after.lastError, /gone from Gameflip \(404\)/);
  assert.strictEqual(pub.calls.length, 0);
});

test("nothing is ended or renewed while the bulk sweep is down — Gameflip is throttling us", async () => {
  await chain("gf-throttled");
  await row("gf-q", { autoDeliver: true, origin: "auto", status: "removed", qtyRemaining: 2, lastError: "expired on Gameflip — renewal pending (expired 2026-09-01)" });
  world.sweepFails = true;
  const pub = fakePublisher();
  await gf.syncOnce(pub.opts);
  assert.deepStrictEqual(world.ended, []);
  assert.strictEqual(pub.calls.length, 0);
  assert.strictEqual((await MarketplaceListing.findOne({ externalId: "gf-throttled" }).lean()).status, "active");
});

test("a listing Gameflip itself reports 'expired' keeps its old branch: retired, not deleted, not renewed", async () => {
  await chain("gf-gfexpired");
  world.state["gf-gfexpired"] = { status: "expired", expiration: PAST, expired: true };
  const pub = fakePublisher();
  await gf.syncOnce(pub.opts);
  const after = await MarketplaceListing.findOne({ externalId: "gf-gfexpired" }).lean();
  assert.match(after.lastError, /gameflip reports "expired" — retired by the watcher/);
  assert.deepStrictEqual(world.ended, []);
  assert.strictEqual(pub.calls.length, 0);
});

test("gameflipIsExpired: a draft is never expired; onsale/ready past expiry are; status expired is", () => {
  const real = require("../utils/marketplaces");
  const now = Date.parse("2026-10-01T05:00:00Z");
  assert.strictEqual(real.gameflipIsExpired({ status: "draft", expiration: "2026-08-01T00:00:00Z" }, now), false);
  assert.strictEqual(real.gameflipIsExpired({ status: "ready", expiration: "2026-08-01T00:00:00Z" }, now), true);
  assert.strictEqual(real.gameflipIsExpired({ status: "onsale", expiration: "2026-08-01T00:00:00Z" }, now), true);
  assert.strictEqual(real.gameflipIsExpired({ status: "onsale", expiration: "2026-10-01T04:55:00Z" }, now), false, "inside the grace");
  assert.strictEqual(real.gameflipIsExpired({ status: "onsale" }, now), false, "no expiration, no verdict");
  assert.strictEqual(real.gameflipIsExpired({ status: "expired" }, now), true);
  assert.strictEqual(real.gameflipIsExpired({ status: "sold", expiration: "2026-08-01T00:00:00Z" }, now), false);
});

test("a stale 'ending' stamp is cleared once the listing is live again — a later 404 is not ours to renew", async () => {
  // The end failed after the stamp, then the owner renewed the listing on
  // Gameflip by hand. If they later delete it, that 404 must take the plain
  // branch, not republish what they removed.
  const stamp = "expired on Gameflip — ending (2026-08-25)";
  await row("gf-revived", { autoDeliver: true, origin: "auto", qtyRemaining: 2, lastError: stamp });
  await row("gf-revived2", { autoDeliver: true, origin: "auto", qtyRemaining: 2, lastError: stamp });
  world.state["gf-revived"] = { status: "onsale", expiration: FUTURE, expired: false };
  world.onsale.add("gf-revived2");
  await gf.syncOnce(fakePublisher().opts);
  for (const id of ["gf-revived", "gf-revived2"]) {
    const r = await MarketplaceListing.findOne({ externalId: id }).lean();
    assert.strictEqual(r.status, "active");
    assert.strictEqual(r.lastError, "", id + " keeps a stale stamp");
  }
});

test("our own half-done end (off sale landed, delete did not) is resumed, not stranded in draft", async () => {
  // A draft is never "expired", so without the stamp check the row would sit
  // active forever with its account reserved and its chain never renewed.
  await row("gf-halfdone", {
    autoDeliver: true,
    origin: "auto",
    qtyRemaining: 4,
    lastError: "expired on Gameflip — ending (2026-08-25)",
  });
  world.state["gf-halfdone"] = { status: "draft", expiration: PAST, expired: false };
  const pub = fakePublisher();
  await gf.syncOnce(pub.opts);
  assert.deepStrictEqual(world.ended, [{ id: "gf-halfdone", status: "draft" }]);
  const after = await MarketplaceListing.findOne({ externalId: "gf-halfdone" }).lean();
  assert.strictEqual(after.status, "removed");
  assert.match(after.lastError, /renewed as gf-new-1/);
  assert.strictEqual(pub.calls[0].qtyRemaining, 4);
});

test("a draft that is not ours to finish keeps the recoverable branch it always had", async () => {
  await row("gf-parked", { autoDeliver: true, origin: "auto", qtyRemaining: 1 });
  world.state["gf-parked"] = { status: "draft", expiration: PAST, expired: false };
  await gf.syncOnce(fakePublisher().opts);
  const after = await MarketplaceListing.findOne({ externalId: "gf-parked" }).lean();
  assert.strictEqual(after.status, "active");
  assert.deepStrictEqual(world.ended, []);
  assert.match(after.lastError, /NOT purchasable/);
});

test("the account link is kept when its hand-back did not take — a leak can be found, a cleared link cannot", async () => {
  const set = new mongoose.Types.ObjectId();
  const acct = new mongoose.Types.ObjectId();
  await row("gf-stuckrelease", { set, autoDeliver: true, origin: "auto", accountId: String(acct), accountLogin: "acct-s", qtyRemaining: 1 });
  world.state["gf-stuckrelease"] = { status: "onsale", expiration: PAST, expired: true };
  await reserve("acct-s", set, acct);
  const orig = DropLog.updateMany;
  DropLog.updateMany = async () => ({ modifiedCount: 0 }); // the release write silently fails
  try {
    await gf.syncOnce(fakePublisher().opts);
  } finally {
    DropLog.updateMany = orig;
  }
  const after = await MarketplaceListing.findOne({ externalId: "gf-stuckrelease" }).lean();
  assert.strictEqual(after.status, "removed");
  assert.strictEqual(after.accountId, String(acct));
});

test("a bulk pack row's reservation is never handed back from here — its loop owns it", async () => {
  const set = new mongoose.Types.ObjectId();
  await row("gf-pack", { set, autoDeliver: true, origin: "auto", bulkOfferId: new mongoose.Types.ObjectId(), accountLogin: "packmember", qtyRemaining: 0 });
  world.state["gf-pack"] = { status: "onsale", expiration: PAST, expired: true };
  await reserve("packmember", set);
  await gf.syncOnce(fakePublisher().opts);
  assert.strictEqual(await DropLog.countDocuments({ soldAt: { $ne: null } }), 1);
  assert.strictEqual((await MarketplaceListing.findOne({ externalId: "gf-pack" }).lean()).status, "removed");
});
