// Bulk packs — stock (reserve / isStillOurs / releaseUnits / unitHealth /
// freeDropsetAccounts / dropsetFreeCounts / noclaimCounts) and farm capacity
// (advertisable / read / demand). docs/bulk-packs/API-UI.md "Tests (A3)".
//
// The reservation tests run the REAL claim path (eldoradoFulfiller
// .claimAccountsForSet -> shopRoutes.availableAccountsForSet ->
// dropReservation.reserveSetOnAccount) against real DropLog / BotAccount docs
// in an in-memory mongo. Host reads (rent-farm snapshot, pool preview) are
// faked. Nothing here touches a network, a bot host or utils/settings.json.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

// Before anything derives the credential key (utils/secretBox caches it).
process.env.CRED_SECRET = "bulk-packs-stock-test-secret";

const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const BotAccount = require("../models/BotAccount");
const MarketplaceListing = require("../models/MarketplaceListing");
const FarmServiceOrder = require("../models/FarmServiceOrder");
const SaleSignal = require("../models/SaleSignal");
const { encrypt } = require("../utils/secretBox");
const { reserveSetOnAccount } = require("../utils/dropReservation");
const listedLogins = require("../utils/listedLogins");
const stock = require("../utils/bulkPacks/stock");
const farmCapacity = require("../utils/bulkPacks/farmCapacity");

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("bulk-packs-stock-test"));
  await Promise.all([DropLog.init(), BotAccount.init()]);
});

test.after(async () => {
  stock.__resetDeps();
  farmCapacity.__resetDeps();
  await mongoose.disconnect();
  await mongod.stop();
});

async function reset() {
  stock.__resetDeps();
  farmCapacity.__resetDeps();
  await Promise.all([
    DropLog.deleteMany({}),
    DropSet.deleteMany({}),
    BotAccount.deleteMany({}),
    MarketplaceListing.collection.deleteMany({}),
    FarmServiceOrder.collection.deleteMany({}),
    SaleSignal.deleteMany({}),
  ]);
}

let seq = 0;

async function makeAccount(login, { password = "pw-" + login, lastScanStatus = "ok", rawPassword } = {}) {
  seq += 1;
  const doc = await BotAccount.create({
    clientSecret: "client-secret-" + login + "-" + seq,
    login,
    credUsername: login,
    credPassword: rawPassword !== undefined ? rawPassword : password ? encrypt(password) : "",
    hasPassword: rawPassword !== undefined ? !!rawPassword : !!password,
    lastScanStatus,
  });
  return doc.toObject();
}

async function makeSet(name, keys, extra = {}) {
  const doc = await DropSet.create({
    name,
    items: keys.map((itemKey) => ({ itemKey, name: itemKey, game: "Rust" })),
    ...extra,
  });
  return doc.toObject();
}

async function giveDrops(account, keys, extra = {}) {
  for (const itemKey of keys) {
    seq += 1;
    await DropLog.create({
      account: account._id,
      login: account.login,
      benefitId: "benefit-" + seq,
      itemKey,
      name: itemKey,
      game: "Rust",
      ...extra,
    });
  }
}

async function rowsOf(account, keys) {
  return DropLog.find({ account: account._id, itemKey: { $in: keys } }).lean();
}

const KEYS = ["rust|hazmat", "rust|garage door"];

// ---------------------------------------------------------------------------
// freeDropsetAccounts
// ---------------------------------------------------------------------------

test("freeDropsetAccounts: sellable holders only, leanest first, listed logins out, string ids", async () => {
  await reset();
  const set = await makeSet("Rust bundle", KEYS);
  const alpha = await makeAccount("alpha");
  const bravo = await makeAccount("bravo");
  const charlie = await makeAccount("charlie");
  const delta = await makeAccount("delta", { password: "" });
  const echo = await makeAccount("echo", { lastScanStatus: "suspended" });
  const foxtrot = await makeAccount("foxtrot");
  const golf = await makeAccount("golf");
  await giveDrops(alpha, KEYS);
  await giveDrops(bravo, KEYS.concat(["rust|extra"])); // fatter: ships more
  await giveDrops(charlie, [KEYS[0]]); // not the whole bundle
  await giveDrops(delta, KEYS); // no password
  await giveDrops(echo, KEYS); // suspended
  await giveDrops(foxtrot, KEYS); // on a live listing
  await giveDrops(golf, KEYS); // only on a DEAD listing
  await MarketplaceListing.collection.insertMany([
    { marketplace: "eldorado", externalId: "live-1", status: "active", accountLogin: "", units: [{ login: "FOXTROT" }] },
    { marketplace: "g2g", externalId: "dead-1", status: "delisted", accountLogin: "golf", units: [] },
  ]);

  const free = await stock.freeDropsetAccounts(set);
  assert.deepEqual(
    free.map((u) => u.login),
    ["alpha", "golf", "bravo"],
  );
  for (const u of free) {
    assert.deepEqual(Object.keys(u).sort(), ["accountId", "login"]);
    assert.equal(typeof u.accountId, "string");
  }
  assert.equal(free[0].accountId, String(alpha._id));

  // Never dropset stock (CONTRACT §1).
  assert.deepEqual(await stock.freeDropsetAccounts({ ...set, custom: true }), []);
  assert.deepEqual(await stock.freeDropsetAccounts({ ...set, stockSource: "noclaim" }), []);
  assert.deepEqual(await stock.freeDropsetAccounts(null), []);
});

// ---------------------------------------------------------------------------
// reserve
// ---------------------------------------------------------------------------

test("reserve: claims through claimAccountsForSet with the market tag; never returns a password", async () => {
  await reset();
  const set = await makeSet("Rust bundle", KEYS);
  const alpha = await makeAccount("alpha");
  const bravo = await makeAccount("bravo");
  await giveDrops(alpha, KEYS);
  await giveDrops(bravo, KEYS.concat(["rust|extra"]));

  const got = await stock.reserve({ set, n: 1, market: "eldorado" });
  assert.deepEqual(got, [{ accountId: String(alpha._id), login: "alpha" }]);
  for (const r of await rowsOf(alpha, KEYS)) {
    assert.ok(r.soldAt instanceof Date);
    assert.equal(r.soldToUsername, "eldorado");
    assert.equal(r.soldSetId, String(set._id));
  }
  for (const r of await rowsOf(bravo, KEYS)) assert.equal(r.soldAt, null);
  // A reserved account is no longer free for another offer.
  assert.deepEqual(
    (await stock.freeDropsetAccounts(set)).map((u) => u.login),
    ["bravo"],
  );

  // n < 1 claims nothing (claimAccountsForSet on its own would coerce 0 to 1).
  assert.deepEqual(await stock.reserve({ set, n: 0, market: "g2g" }), []);
  assert.deepEqual(await stock.reserve({ set, n: -3, market: "g2g" }), []);
  assert.deepEqual(await stock.reserve({ set, n: "abc", market: "g2g" }), []);
  for (const r of await rowsOf(bravo, KEYS)) assert.equal(r.soldAt, null);

  // Blocked / unsupported markets are refused before anything is claimed.
  for (const market of ["plati", "ggsel", "digiseller", "playerauctions", "shop", ""]) {
    await assert.rejects(stock.reserve({ set, n: 1, market }), /market must be one of/);
  }
  for (const r of await rowsOf(bravo, KEYS)) assert.equal(r.soldAt, null);

  // Short stock comes back short (the caller refuses and releases).
  const short = await stock.reserve({ set, n: 5, market: "G2G " });
  assert.deepEqual(short, [{ accountId: String(bravo._id), login: "bravo" }]);
  for (const r of await rowsOf(bravo, KEYS)) assert.equal(r.soldToUsername, "g2g");

  // A custom or no-claim set is never dropset stock.
  assert.deepEqual(await stock.reserve({ set: { ...set, custom: true }, n: 1, market: "gameflip" }), []);
  await assert.rejects(stock.reserve({ n: 1, market: "gameflip" }), /DropSet is required/);
});

// ---------------------------------------------------------------------------
// isStillOurs
// ---------------------------------------------------------------------------

test("isStillOurs: true only while every live set row carries exactly our stamp", async () => {
  await reset();
  const set = await makeSet("Rust bundle", KEYS);
  const twin = await makeSet("Rust bundle (copy)", KEYS); // same items, other set
  const alpha = await makeAccount("alpha");
  const charlie = await makeAccount("charlie");
  await giveDrops(alpha, KEYS);
  await giveDrops(charlie, ["rust|other"]);
  const [unit] = await stock.reserve({ set, n: 1, market: "eldorado" });
  const accountId = unit.accountId;

  assert.equal(await stock.isStillOurs({ accountId, set, market: "eldorado" }), true);
  assert.equal(await stock.isStillOurs({ accountId: alpha._id, set, market: "eldorado" }), true);
  assert.equal(await stock.isStillOurs({ accountId, set: String(set._id), market: "eldorado" }), true);
  assert.equal(await stock.isStillOurs({ accountId, set, market: "g2g" }), false);
  assert.equal(await stock.isStillOurs({ accountId, set: twin, market: "eldorado" }), false);
  assert.equal(await stock.isStillOurs({ accountId: String(charlie._id), set, market: "eldorado" }), false);
  assert.equal(await stock.isStillOurs({ accountId: "not-an-id", set, market: "eldorado" }), false);
  assert.equal(await stock.isStillOurs({ accountId, set, market: "plati" }), false);
  assert.equal(await stock.isStillOurs({ accountId, set: { ...set, items: [] }, market: "eldorado" }), false);

  // A REDEEMED copy the reservation never stamped is not evidence either way
  // (reserveSetOnAccount only ever stamps connected != true rows).
  await giveDrops(alpha, [KEYS[0]], { connected: true, state: "connected" });
  assert.equal(await stock.isStillOurs({ accountId, set, market: "eldorado" }), true);

  // A new, unreserved copy of one of the items: not provably ours -> false.
  await giveDrops(alpha, [KEYS[1]]);
  assert.equal(await stock.isStillOurs({ accountId, set, market: "eldorado" }), false);
  await DropLog.deleteMany({ account: alpha._id, soldAt: null, connected: { $ne: true } });
  assert.equal(await stock.isStillOurs({ accountId, set, market: "eldorado" }), true);

  // One row taken over by another owner -> false.
  await DropLog.updateOne(
    { account: alpha._id, itemKey: KEYS[1], soldToUsername: "eldorado" },
    { $set: { soldToUsername: "bulk:order-7" } },
  );
  assert.equal(await stock.isStillOurs({ accountId, set, market: "eldorado" }), false);

  // Every set row redeemed -> nothing left that is ours to release.
  await DropLog.updateMany({ account: alpha._id }, { $set: { connected: true } });
  assert.equal(await stock.isStillOurs({ accountId, set, market: "eldorado" }), false);
});

// ---------------------------------------------------------------------------
// releaseUnits
// ---------------------------------------------------------------------------

test("releaseUnits: a released unit is free again and can be claimed again", async () => {
  await reset();
  const set = await makeSet("Rust bundle", KEYS);
  const alpha = await makeAccount("alpha");
  await giveDrops(alpha, KEYS);
  const [unit] = await stock.reserve({ set, n: 1, market: "eldorado" });
  assert.equal((await BotAccount.findById(alpha._id).lean()).soldToUsername, "eldorado");
  assert.deepEqual(await stock.freeDropsetAccounts(set), []);

  const res = await stock.releaseUnits({ set, market: "eldorado", accountIds: [unit.accountId, unit.accountId] });
  assert.deepEqual(res, { released: [unit.accountId], skipped: [], failed: [] });
  for (const r of await rowsOf(alpha, KEYS)) {
    assert.equal(r.soldAt, null);
    assert.equal(r.soldToUsername, "");
    assert.equal(r.soldSetId, "");
  }
  // The account shadow is cleared too (no reserved drop left on it).
  assert.equal((await BotAccount.findById(alpha._id).lean()).soldAt, null);
  assert.deepEqual(
    (await stock.freeDropsetAccounts(set)).map((u) => u.accountId),
    [unit.accountId],
  );
  assert.deepEqual(await stock.reserve({ set, n: 1, market: "g2g" }), [unit]);
});

test("releaseUnits: a reservation that belongs to another tag, set or buyer is skipped and left alone", async () => {
  await reset();
  const set = await makeSet("Rust bundle", KEYS);
  const twin = await makeSet("Rust bundle (copy)", KEYS);
  const other = await makeSet("Rust other bundle", ["rust|sheet metal"]);
  const alpha = await makeAccount("alpha");
  await giveDrops(alpha, KEYS.concat(["rust|sheet metal"]));
  const [unit] = await stock.reserve({ set, n: 1, market: "eldorado" });
  // A Shop buyer owns a DIFFERENT set on the same account (per-game sale).
  assert.equal(
    await reserveSetOnAccount(alpha._id, other, { soldToUsername: "carol", soldSetId: String(other._id) }),
    true,
  );

  // Another tag.
  let res = await stock.releaseUnits({ set, market: "g2g", accountIds: [unit.accountId] });
  assert.deepEqual(res, { released: [], skipped: [{ accountId: unit.accountId, reason: "not ours" }], failed: [] });
  // Another set holding the very same items.
  res = await stock.releaseUnits({ set: twin, market: "eldorado", accountIds: [unit.accountId] });
  assert.deepEqual(res.skipped, [{ accountId: unit.accountId, reason: "not ours" }]);
  for (const r of await rowsOf(alpha, KEYS)) {
    assert.equal(r.soldToUsername, "eldorado");
    assert.equal(r.soldSetId, String(set._id));
  }

  // Ours: released — and the buyer's other set on the same account is untouched.
  res = await stock.releaseUnits({ set, market: "eldorado", accountIds: [unit.accountId] });
  assert.deepEqual(res.released, [unit.accountId]);
  const [carolRow] = await rowsOf(alpha, ["rust|sheet metal"]);
  assert.equal(carolRow.soldToUsername, "carol");
  assert.equal(carolRow.soldSetId, String(other._id));
  assert.ok(carolRow.soldAt instanceof Date);
  assert.equal((await BotAccount.findById(alpha._id).lean()).soldAt instanceof Date, true);

  // Re-taken by a Shop buyer after our release: a stale second release must not free it.
  assert.equal(
    await reserveSetOnAccount(alpha._id, set, { soldToUsername: "bob", soldSetId: String(set._id) }),
    true,
  );
  res = await stock.releaseUnits({ set, market: "eldorado", accountIds: [unit.accountId] });
  assert.deepEqual(res.skipped, [{ accountId: unit.accountId, reason: "not ours" }]);
  for (const r of await rowsOf(alpha, KEYS)) assert.equal(r.soldToUsername, "bob");
});

test("releaseUnits: bad market / missing set skip, a set id works, a read error is 'failed' (retryable)", async () => {
  await reset();
  const set = await makeSet("Rust bundle", KEYS);
  const alpha = await makeAccount("alpha");
  await giveDrops(alpha, KEYS);
  const [unit] = await stock.reserve({ set, n: 1, market: "gameflip" });

  let res = await stock.releaseUnits({ set, market: "ggsel", accountIds: [unit.accountId] });
  assert.deepEqual(res.skipped, [{ accountId: unit.accountId, reason: "unsupported market" }]);
  res = await stock.releaseUnits({ set: new mongoose.Types.ObjectId(), market: "gameflip", accountIds: [unit.accountId] });
  assert.deepEqual(res.skipped, [{ accountId: unit.accountId, reason: "set missing" }]);
  for (const r of await rowsOf(alpha, KEYS)) assert.equal(r.soldToUsername, "gameflip");

  // DB trouble while proving ownership: nothing written, reported as failed.
  stock.__setDeps({
    DropLog: { countDocuments: async () => { throw new Error("db down"); } },
  });
  res = await stock.releaseUnits({ set, market: "gameflip", accountIds: [unit.accountId] });
  assert.deepEqual(res, { released: [], skipped: [], failed: [{ accountId: unit.accountId, reason: "db down" }] });
  stock.__resetDeps();
  for (const r of await rowsOf(alpha, KEYS)) assert.equal(r.soldToUsername, "gameflip");

  // A release that throws part-way may have taken: skipped, never retried.
  stock.__setDeps({
    dropReservation: {
      setKeys: require("../utils/dropReservation").setKeys,
      releaseSetForAccounts: async () => { throw new Error("shadow write failed"); },
    },
  });
  res = await stock.releaseUnits({ set, market: "gameflip", accountIds: [unit.accountId] });
  assert.deepEqual(res.skipped, [{ accountId: unit.accountId, reason: "release error: shadow write failed" }]);
  stock.__resetDeps();

  // The set may be passed by id; empty input is a no-op.
  res = await stock.releaseUnits({ set: String(set._id), market: "gameflip", accountIds: [unit.accountId] });
  assert.deepEqual(res.released, [unit.accountId]);
  assert.deepEqual(await stock.releaseUnits({ set, market: "gameflip", accountIds: [] }), {
    released: [],
    skipped: [],
    failed: [],
  });
  assert.throws(() => stock.__setDeps({ DropLogs: {} }), /unknown dependency/);
});

// ---------------------------------------------------------------------------
// unitHealth
// ---------------------------------------------------------------------------

test("unitHealth: missing / suspended / no password, everything else ok", async () => {
  await reset();
  const ok = await makeAccount("ok");
  const suspended = await makeAccount("gone", { lastScanStatus: "suspended" });
  const noPw = await makeAccount("nopw", { password: "" });
  const garbled = await makeAccount("garbled", { rawPassword: "enc:v1:AAAA:BBBB:CCCC" });
  const legacy = await makeAccount("legacy", { rawPassword: "plain-text-pw" });
  // token_invalid is re-authable, not the suspended test.
  const tokenDead = await makeAccount("tokendead", { lastScanStatus: "token_invalid" });
  const missing = String(new mongoose.Types.ObjectId());

  const health = await stock.unitHealth([
    String(ok._id),
    suspended._id,
    String(noPw._id),
    String(garbled._id),
    String(legacy._id),
    String(tokenDead._id),
    missing,
    "not-an-id",
  ]);
  assert.ok(health instanceof Map);
  assert.deepEqual(Object.fromEntries(health), {
    [String(ok._id)]: { ok: true, reason: "" },
    [String(suspended._id)]: { ok: false, reason: "suspended" },
    [String(noPw._id)]: { ok: false, reason: "no password" },
    [String(garbled._id)]: { ok: false, reason: "no password" },
    [String(legacy._id)]: { ok: true, reason: "" },
    [String(tokenDead._id)]: { ok: true, reason: "" },
    [missing]: { ok: false, reason: "account missing" },
    "not-an-id": { ok: false, reason: "account missing" },
  });
  assert.equal((await stock.unitHealth([])).size, 0);

  // A read failure propagates — it must never read as "bad" (that retires units).
  stock.__setDeps({
    BotAccount: { find: () => ({ lean: async () => { throw new Error("db down"); } }) },
  });
  await assert.rejects(stock.unitHealth([String(ok._id)]), /db down/);
  stock.__resetDeps();
});

// ---------------------------------------------------------------------------
// noclaimCounts / dropsetFreeCounts
// ---------------------------------------------------------------------------

test("noclaimCounts: free from the shelf, share per claim-at-sale market as a NEW row; errors propagate", async () => {
  await reset();
  const set = { _id: new mongoose.Types.ObjectId(), stockSource: "noclaim", items: [] };
  const asked = [];
  stock.__setDeps({
    noclaimStock: {
      stockForSet: async (s) => {
        assert.equal(s, set);
        return { free: 7, stale: 2 };
      },
      stockForListing: async (row) => {
        asked.push(row);
        return row.marketplace === "eldorado" ? 4 : 3;
      },
    },
  });
  assert.deepEqual(await stock.noclaimCounts(set), { free: 7, share: { eldorado: 4, g2g: 3 } });
  assert.deepEqual(asked, [
    { noclaimStock: true, marketplace: "eldorado", set: set._id },
    { noclaimStock: true, marketplace: "g2g", set: set._id },
  ]);

  stock.__setDeps({
    noclaimStock: {
      stockForSet: async () => ({ free: 7 }),
      stockForListing: async () => {
        throw new Error("snapshot unreadable");
      },
    },
  });
  await assert.rejects(stock.noclaimCounts(set), /snapshot unreadable/);
  stock.__resetDeps();
});

test("dropsetFreeCounts: per-set free counts, bounded by limit, one listed-login read", async () => {
  await reset();
  const a = await makeSet("A", ["rust|a"]);
  const b = await makeSet("B", ["rust|b"]);
  const c = await makeSet("C", ["rust|c"]);
  const n1 = await makeAccount("n1");
  const n2 = await makeAccount("n2");
  const n3 = await makeAccount("n3");
  await giveDrops(n1, ["rust|a", "rust|b"]);
  await giveDrops(n2, ["rust|a"]);
  await giveDrops(n3, ["rust|a"]);
  await MarketplaceListing.collection.insertOne({
    marketplace: "eldorado",
    externalId: "live-2",
    status: "active",
    accountLogin: "n3",
    units: [],
  });
  let listedReads = 0;
  stock.__setDeps({
    listedLogins: {
      loginsOnActiveListings: async () => {
        listedReads += 1;
        return listedLogins.loginsOnActiveListings();
      },
      notListed: listedLogins.notListed,
    },
  });

  const all = await stock.dropsetFreeCounts([a, b, c, a, null, { ...c, _id: undefined }]);
  assert.deepEqual(Object.fromEntries(all), {
    [String(a._id)]: 2,
    [String(b._id)]: 1,
    [String(c._id)]: 0,
  });
  assert.equal(listedReads, 1);

  const two = await stock.dropsetFreeCounts([a, b, c], { limit: 2 });
  assert.deepEqual([...two.keys()], [String(a._id), String(b._id)]);
  assert.equal((await stock.dropsetFreeCounts([], {})).size, 0);
  assert.equal((await stock.dropsetFreeCounts([{ ...a, custom: true }])).get(String(a._id)), 0);
  stock.__resetDeps();
});

// ---------------------------------------------------------------------------
// farmCapacity.advertisable
// ---------------------------------------------------------------------------

test("advertisable: min of max qty, best stack, free minus reserve, pristine minus reserve", () => {
  const bp = { farmMaxQty: 20, farmReserveSlots: 20, farmReservePristine: 20 };
  const cap = (bestStackRoom, totalFree, pristine, error = "") => ({ bestStackRoom, totalFree, pristine, error });
  assert.equal(farmCapacity.advertisable(cap(50, 100, 100), bp), 20); // max qty binds
  assert.equal(farmCapacity.advertisable(cap(12, 100, 100), bp), 12); // one stack binds
  assert.equal(farmCapacity.advertisable(cap(50, 30, 100), bp), 10); // slot reserve binds
  assert.equal(farmCapacity.advertisable(cap(50, 100, 27), bp), 7); // pristine reserve binds
  assert.equal(farmCapacity.advertisable(cap(50, 10, 100), bp), 0); // below the reserve -> 0, never negative
  assert.equal(farmCapacity.advertisable(cap(50, 100, 5), bp), 0);
  assert.equal(
    farmCapacity.advertisable(cap(50, 100, 100), { farmMaxQty: 7.9, farmReserveSlots: 0, farmReservePristine: 0 }),
    7,
  );
  assert.equal(farmCapacity.advertisable(cap(50, 100, 100, "Pi link timeout"), bp), 0);
  assert.equal(farmCapacity.advertisable(null, bp), 0);
  assert.equal(farmCapacity.advertisable(cap(50, 100, 100), null), 0);
  assert.equal(farmCapacity.advertisable(cap(50, 100, 100), { ...bp, farmReserveSlots: undefined }), 0);
  assert.equal(farmCapacity.advertisable(cap("x", 100, 100), bp), 0);
});

// ---------------------------------------------------------------------------
// farmCapacity.read
// ---------------------------------------------------------------------------

function fakeHosts({ snapshot, preview }) {
  const calls = { snapshot: 0, preview: [] };
  farmCapacity.__setDeps({
    rentFarmCapacity: {
      snapshot: async () => {
        calls.snapshot += 1;
        return typeof snapshot === "function" ? snapshot() : snapshot;
      },
    },
    operatorFarm: {
      previewFreshAccounts: async (args) => {
        calls.preview.push(args);
        return typeof preview === "function" ? preview() : preview;
      },
      farmFreshAccounts: async () => {
        throw new Error("farmCapacity must never provision");
      },
    },
  });
  return calls;
}

const SNAP = {
  stacks: [
    { host: "pi", file: "a.json", used: 5, capacity: 35, remaining: 30, running: false }, // dead
    { host: "pi", file: "b.json", used: 38, capacity: 50, remaining: 12, running: true },
    { host: "contabo", file: "c.json", used: 0, capacity: 25, remaining: 25, running: false }, // un-started: counts
    { host: "local", file: "d.json", used: 2, capacity: 10, remaining: 8, running: null }, // unknown: counts
  ],
  totalFree: 45,
};

test("read: best LIVE stack, total free, pristine from a count:1 preview — no provisioning", async () => {
  await reset();
  let clock = Date.UTC(2026, 8, 30, 12, 0, 0);
  farmCapacity.__setDeps({ now: () => clock });
  const calls = fakeHosts({ snapshot: SNAP, preview: { eligibleTotal: 73, willAdd: 1 } });

  const cap = await farmCapacity.read();
  assert.deepEqual(cap, {
    bestStackRoom: 25,
    totalFree: 45,
    pristine: 73,
    at: new Date(clock),
    error: "",
  });
  assert.deepEqual(calls.preview, [{ count: 1 }]);
  assert.equal(
    farmCapacity.advertisable(cap, { farmMaxQty: 20, farmReserveSlots: 20, farmReservePristine: 20 }),
    20,
  );

  // The holder's account limit caps the total; no single stack beats it.
  clock += farmCapacity.CACHE_MS;
  fakeHosts({ snapshot: { ...SNAP, totalFree: 10 }, preview: { eligibleTotal: 73 } });
  const capped = await farmCapacity.read();
  assert.equal(capped.bestStackRoom, 10);
  assert.equal(capped.totalFree, 10);

  // No readable stack at all reads as zero room, not as an error.
  fakeHosts({ snapshot: { stacks: [], totalFree: 0 }, preview: { eligibleTotal: 5 } });
  const empty = await farmCapacity.read({ force: true });
  assert.deepEqual(
    { ...empty, at: null },
    { bestStackRoom: 0, totalFree: 0, pristine: 5, at: null, error: "" },
  );
});

test("read: cached for 10 minutes, force bypasses, concurrent callers share one read", async () => {
  await reset();
  let clock = Date.UTC(2026, 8, 30, 12, 0, 0);
  farmCapacity.__setDeps({ now: () => clock });
  const calls = fakeHosts({ snapshot: SNAP, preview: { eligibleTotal: 73 } });

  const first = await farmCapacity.read();
  first.totalFree = 999; // a caller mutating its copy must not poison the cache
  clock += 9 * 60 * 1000;
  const second = await farmCapacity.read();
  assert.equal(calls.snapshot, 1);
  assert.equal(second.totalFree, 45);
  assert.deepEqual(second.at, new Date(clock - 9 * 60 * 1000));

  clock += 60 * 1000; // exactly 10 minutes old -> stale
  await farmCapacity.read();
  assert.equal(calls.snapshot, 2);
  await farmCapacity.read({ force: true });
  assert.equal(calls.snapshot, 3);
  await farmCapacity.read();
  assert.equal(calls.snapshot, 3);

  // Concurrent cold reads share one host round trip.
  farmCapacity.__resetDeps();
  farmCapacity.__setDeps({ now: () => clock });
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const shared = fakeHosts({
    snapshot: () => gate.then(() => SNAP),
    preview: { eligibleTotal: 73 },
  });
  const pending = [farmCapacity.read(), farmCapacity.read(), farmCapacity.read({ force: true })];
  release();
  const results = await Promise.all(pending);
  assert.equal(shared.snapshot, 1);
  for (const r of results) assert.equal(r.bestStackRoom, 25);

  // A read still in flight across a reset can neither write the cache nor
  // clear the newer read.
  farmCapacity.__resetDeps();
  farmCapacity.__setDeps({ now: () => clock });
  let releaseStale;
  const staleGate = new Promise((r) => {
    releaseStale = r;
  });
  fakeHosts({
    snapshot: () => staleGate.then(() => ({ stacks: [], totalFree: 0 })),
    preview: { eligibleTotal: 1 },
  });
  const stale = farmCapacity.read();
  farmCapacity.__resetDeps();
  farmCapacity.__setDeps({ now: () => clock });
  const fresh = fakeHosts({ snapshot: SNAP, preview: { eligibleTotal: 73 } });
  assert.equal((await farmCapacity.read()).bestStackRoom, 25);
  releaseStale();
  assert.equal((await stale).bestStackRoom, 0);
  assert.equal((await farmCapacity.read()).bestStackRoom, 25);
  assert.equal(fresh.snapshot, 1);
});

test("read: never throws — a failed read is zeros + error text, retried after a minute", async () => {
  await reset();
  let clock = Date.UTC(2026, 8, 30, 12, 0, 0);
  farmCapacity.__setDeps({ now: () => clock });
  let fail = true;
  const calls = fakeHosts({
    snapshot: () => {
      if (fail) throw new Error("Pi link timeout");
      return SNAP;
    },
    preview: { eligibleTotal: 73 },
  });

  const bad = await farmCapacity.read();
  assert.equal(bad.bestStackRoom, 0);
  assert.equal(bad.totalFree, 0);
  assert.equal(bad.pristine, 0);
  assert.match(bad.error, /Pi link timeout/);
  assert.equal(calls.preview.length, 0); // no pool read after a failed slot read
  assert.equal(
    farmCapacity.advertisable(bad, { farmMaxQty: 20, farmReserveSlots: 0, farmReservePristine: 0 }),
    0,
  );

  fail = false;
  clock += 30 * 1000; // a failed read is reused briefly...
  assert.match((await farmCapacity.read()).error, /Pi link timeout/);
  assert.equal(calls.snapshot, 1);
  clock += farmCapacity.ERROR_CACHE_MS; // ...then retried
  const good = await farmCapacity.read();
  assert.equal(good.error, "");
  assert.equal(good.bestStackRoom, 25);

  // A pool preview that throws synchronously, and an empty snapshot, are errors too.
  farmCapacity.__resetDeps();
  farmCapacity.__setDeps({
    now: () => clock,
    rentFarmCapacity: { snapshot: async () => SNAP },
    operatorFarm: {
      previewFreshAccounts: () => {
        throw new Error("pool eligibility read failed");
      },
    },
  });
  const poolFail = await farmCapacity.read();
  assert.deepEqual(
    [poolFail.bestStackRoom, poolFail.totalFree, poolFail.pristine],
    [0, 0, 0],
  );
  assert.match(poolFail.error, /pool eligibility read failed/);
  farmCapacity.__setDeps({ rentFarmCapacity: { snapshot: async () => undefined } });
  assert.match((await farmCapacity.read({ force: true })).error, /snapshot was empty/);
  await assert.doesNotReject(farmCapacity.read(null));
  assert.throws(() => farmCapacity.__setDeps({ rentFarmCapacityy: {} }), /unknown dependency/);
});

// ---------------------------------------------------------------------------
// farmCapacity.demand
// ---------------------------------------------------------------------------

test("demand: last N days, cancelled excluded, grouped by (game, days), orders first", async () => {
  await reset();
  const now = Date.UTC(2026, 8, 30, 12, 0, 0);
  const ago = (days) => new Date(now - days * 24 * 3600 * 1000);
  farmCapacity.__setDeps({ now: () => now });
  const row = (orderId, fields) => ({
    orderId,
    offerId: "",
    offerTitle: "",
    accounts: [],
    quantity: 1,
    state: "delivered",
    ...fields,
    updatedAt: fields.createdAt,
  });
  await FarmServiceOrder.collection.insertMany([
    row("e-1", { market: "eldorado", game: "Rust", days: 180, quantity: 3, accounts: [{ login: "a" }, { login: "b" }, { login: "c" }], createdAt: ago(10) }),
    row("g2g:1", { market: "g2g", game: "rust", days: 180, quantity: 2, state: "failed", createdAt: ago(5) }),
    // Created before the `market` field existed: an Eldorado order.
    row("e-legacy", { game: "Rust", days: 180, accounts: [{ login: "x" }], createdAt: ago(20) }),
    // PlayerAuctions "quantity" can count ITEMS: accounts handed over win.
    row("pa:1", { market: "playerauctions", game: "Rust", days: 365, quantity: 5, accounts: [{ login: "p" }], createdAt: ago(3) }),
    row("e-2", { market: "eldorado", game: "Apex Legends", days: 120, state: "cancelled", createdAt: ago(2) }),
    row("gf:1", { market: "gameflip", game: "Apex Legends", days: 120, accounts: [{ login: "g" }], createdAt: ago(61) }),
    row("e-3", { market: "eldorado", game: "Apex Legends", days: 120, accounts: [{ login: "h" }], createdAt: ago(0.5) }),
    row("e-bad", { market: "eldorado", game: "", days: 180, createdAt: ago(0.5) }),
    row("e-bad2", { market: "eldorado", game: "Rust", days: 0, createdAt: ago(0.5) }),
  ]);

  const list = await farmCapacity.demand();
  assert.equal(list.length, 3);
  assert.equal(list[0].game.toLowerCase(), "rust");
  assert.deepEqual(
    { ...list[0], game: "rust" },
    { game: "rust", days: 180, orders: 3, accounts: 6, markets: { eldorado: 2, g2g: 1 } },
  );
  assert.deepEqual(list[1], {
    game: "Apex Legends",
    days: 120,
    orders: 1,
    accounts: 1,
    markets: { eldorado: 1 },
  });
  assert.deepEqual(list[2], {
    game: "Rust",
    days: 365,
    orders: 1,
    accounts: 1,
    markets: { playerauctions: 1 },
  });

  const wider = await farmCapacity.demand({ days: 90 });
  const apex = wider.find((g) => g.game === "Apex Legends");
  assert.deepEqual(apex.markets, { eldorado: 1, gameflip: 1 });
  assert.equal(apex.orders, 2);
  // A sub-day window clamps to 1 day: only the order from 12 hours ago.
  assert.deepEqual(
    (await farmCapacity.demand({ days: 0.5 })).map((g) => [g.game, g.days, g.orders]),
    [["Apex Legends", 120, 1]],
  );
});

// ---------------------------------------------------------------------------
// tripwires
// ---------------------------------------------------------------------------

test("tripwire: farmCapacity never provisions or writes a bot config; stock never releases tag-wide", () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, "..", "utils", "bulkPacks", f), "utf8");
  const cap = src("farmCapacity.js");
  for (const banned of [
    "farmFreshAccounts",
    "ensureStackWithRoom",
    "movePoolAccountToRenter",
    "ensureOperatorRenter",
    "writeFile",
    "saveSettings",
    "setAutoFarm",
  ]) {
    assert.ok(!cap.includes(banned), "farmCapacity.js must not reference " + banned);
  }
  const st = src("stock.js");
  for (const banned of ["releaseAccountsForTag", "releaseBySet", "reserveSetOnAccount(", "allowDiskUse"]) {
    assert.ok(!st.includes(banned), "stock.js must not reference " + banned);
  }
  assert.match(st, /claimAccountsForSet\(set, want, \{\s*claimTag: market,?\s*\}\)/);
  assert.match(st, /releaseSetForAccounts\(\[id\], setId, market\)/);
});
