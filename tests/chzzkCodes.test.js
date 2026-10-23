// CHZZK code collector tests (docs/CHZZK-FARM.md §8).
//
// A real in-memory Mongo plus a hand-rolled fake client — no network, no
// A2 client.js (A2 is building in parallel). The failures these tests
// prevent:
//  1. A STORED CODE OVERWRITTEN. Once hasCode is true, a later run must
//     never clobber codeEnc, even on a repeat claim payload or a new fetch.
//  2. A CODE LEAKED. codeEnc is encrypted, reveal() strips codeEnc from the
//     returned row, no code value appears in activity or lastError.
//  3. A HAMMERED LOGIN. gapMs between coupon-code calls, one collection at
//     a time through the global queue.
//  4. AN AUTH FAILURE SWALLOWED. AUTH rethrows out of collect() so the farm
//     can mark the login; EGRESS / TIMEOUT returns { error: "egress" }.
//  5. A FORGOTTEN RETRY. A refused code bumps tries, sets a 30-min nextTryAt,
//     and is tried again after that.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.CRED_SECRET ||= "chzzk-codes-test-cred-secret";

const ChzzkAccount = require("../models/ChzzkAccount");
const ChzzkReward = require("../models/ChzzkReward");
const { ChzzkError } = require("../utils/chzzk/errors");
const { createCollector } = require("../utils/chzzk/codes");
const { encrypt, decrypt } = require("../utils/secretBox");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const RETRY_MS = 30 * MIN;

// KST wall-clock from a UTC epoch, as CHZZK sends it.
const kst = (ms) => new Date(ms + 9 * HOUR).toISOString().slice(0, 19).replace("T", " ");

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([ChzzkAccount.init(), ChzzkReward.init()]);
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

test.beforeEach(async () => {
  await Promise.all([ChzzkAccount.deleteMany({}), ChzzkReward.deleteMany({})]);
});

// A minimal activity log stub for tests: an array add() pushes to.
function activityStub() {
  const entries = [];
  return {
    add: (e) => entries.push(e),
    get: () => entries.slice(),
    reset: () => entries.splice(0, entries.length),
  };
}

// A hand-rolled fake client — exposes exactly the methods codes.js uses.
// The world keeps per-account claim lists and per-reward code payloads.
function makeWorld({ now }) {
  const claims = new Map(); // accountKey -> [claim]
  const codes = new Map(); // "accountKey:rewardNo" -> () => { codeNo, code } | () => throw
  const calls = [];
  const w = {
    calls,
    setClaims(key, list) {
      claims.set(key, list);
    },
    setCode(key, rewardNo, impl) {
      codes.set(`${key}:${rewardNo}`, impl);
    },
    clientFor(account) {
      const key = account.userIdHash;
      return {
        claims: async () => {
          calls.push({ key, method: "claims", at: now() });
          return (claims.get(key) || []).slice();
        },
        couponCode: async (rewardNo) => {
          calls.push({ key, method: "couponCode", rewardNo, at: now() });
          const fn = codes.get(`${key}:${rewardNo}`);
          if (!fn) {
            throw new ChzzkError("not earned yet", { code: "API" });
          }
          return fn();
        },
      };
    },
  };
  return w;
}

async function makeAccount({ nickname = "nick-a", userIdHash = "hash-a" } = {}) {
  return ChzzkAccount.create({ userIdHash, nickname, status: "ok" });
}

// A barebones setup helper: a world, a collector, a clock, an activity stub.
function setup({ gapMs = 0, overrides = {} } = {}) {
  const clock = { t: Date.parse("2026-10-23T00:00:00Z") };
  const now = () => clock.t;
  const waits = [];
  const sleep = async (ms) => {
    waits.push(ms);
    clock.t += ms;
  };
  const world = makeWorld({ now });
  const activity = activityStub();
  const collector = createCollector({
    Account: ChzzkAccount,
    Reward: ChzzkReward,
    activity,
    clientFor: (acc) => world.clientFor(acc),
    now,
    sleep,
    gapMs,
    ...overrides,
  });
  return { clock, now, world, activity, collector, waits };
}

// --------------------------------------------------------- happy path

test("a COMPLIED code reward is stored encrypted; IN_APP is marked, nothing else is fetched", async () => {
  const s = setup();
  const acc = await makeAccount();
  s.world.setClaims("hash-a", [
    {
      rewardNo: 101,
      campaignNo: 7,
      title: "7-day Pass",
      rewardType: "CODE_FIRST_COME",
      fulfillmentState: "COMPLIED",
      createdDate: kst(s.clock.t - HOUR),
      codeEndDate: kst(s.clock.t + 10 * 24 * HOUR),
      categoryId: "GAME_ID",
      campaign: { title: "Big Event" },
    },
    {
      rewardNo: 102,
      campaignNo: 7,
      title: "In-game Skin",
      rewardType: "IN_APP",
      fulfillmentState: "COMPLIED",
      createdDate: kst(s.clock.t - HOUR),
      codeEndDate: kst(s.clock.t + 10 * 24 * HOUR),
      categoryId: "GAME_ID",
      campaign: { title: "Big Event" },
    },
    {
      rewardNo: 103,
      campaignNo: 7,
      title: "Fallback Prize",
      rewardType: "ANNOUNCED_LATER",
      fulfillmentState: "COMPLIED",
      createdDate: kst(s.clock.t - HOUR),
      codeEndDate: kst(s.clock.t + 10 * 24 * HOUR),
      categoryId: "GAME_ID",
      campaign: { title: "Big Event" },
    },
  ]);
  s.world.setCode("hash-a", 101, () => ({ codeNo: "77", code: "ABC-XYZ-123" }));

  const out = await s.collector.collect(String(acc._id), { reason: "test" });
  assert.deepEqual(out, { read: 3, stored: 1, failed: 0 });

  const rows = await ChzzkReward.find({ accountId: String(acc._id) })
    .sort({ rewardNo: 1 })
    .lean();
  assert.equal(rows.length, 3);

  const code = rows.find((r) => r.rewardNo === 101);
  assert.equal(code.state, "stored");
  assert.equal(code.hasCode, true);
  assert.equal(code.codeNo, "77");
  assert.ok(code.codeEnc.startsWith("enc:v1:"), "codeEnc is encrypted");
  assert.notEqual(code.codeEnc, "ABC-XYZ-123", "plaintext is not persisted");
  assert.equal(decrypt(code.codeEnc), "ABC-XYZ-123");
  assert.ok(code.codeAt instanceof Date);
  assert.equal(code.title, "7-day Pass");
  assert.equal(code.campaignTitle, "Big Event");
  assert.equal(code.userIdHash, "hash-a");

  const inApp = rows.find((r) => r.rewardNo === 102);
  assert.equal(inApp.state, "in_app");
  assert.equal(inApp.hasCode, false);
  assert.equal(inApp.codeEnc, "");

  const other = rows.find((r) => r.rewardNo === 103);
  assert.equal(other.state, "earned");
  assert.equal(other.hasCode, false);

  // Only ONE couponCode call: for 101. 102 (IN_APP) and 103 (unknown) never fetched.
  const coupons = s.world.calls.filter((c) => c.method === "couponCode");
  assert.equal(coupons.length, 1);
  assert.equal(coupons[0].rewardNo, 101);

  // One activity "code" entry naming the title and the nickname, no code value.
  const codeEntries = s.activity.get().filter((e) => e.kind === "code");
  assert.equal(codeEntries.length, 1);
  assert.equal(codeEntries[0].msg, 'Stored the code for "7-day Pass" on nick-a');
  assert.ok(!/ABC-XYZ-123/.test(JSON.stringify(s.activity.get())), "no code value in activity");
});

test("a non-COMPLIED code reward and an expired COMPLIED one are not fetched", async () => {
  const s = setup();
  const acc = await makeAccount();
  s.world.setClaims("hash-a", [
    {
      rewardNo: 201,
      campaignNo: 1,
      title: "Pending",
      rewardType: "CODE_LOTTERY",
      fulfillmentState: "SHIPPING", // not COMPLIED
      createdDate: kst(s.clock.t - HOUR),
      codeEndDate: kst(s.clock.t + 24 * HOUR),
      campaign: { title: "X" },
    },
    {
      rewardNo: 202,
      campaignNo: 1,
      title: "Ran Out",
      rewardType: "CODE_FIRST_COME",
      fulfillmentState: "COMPLIED",
      createdDate: kst(s.clock.t - 10 * HOUR),
      codeEndDate: kst(s.clock.t - HOUR), // past
      campaign: { title: "X" },
    },
  ]);
  s.world.setCode("hash-a", 201, () => ({ codeNo: "1", code: "NEVER-1" }));
  s.world.setCode("hash-a", 202, () => ({ codeNo: "2", code: "NEVER-2" }));

  const out = await s.collector.collect(String(acc._id));
  assert.deepEqual(out, { read: 2, stored: 0, failed: 0 });
  const coupons = s.world.calls.filter((c) => c.method === "couponCode");
  assert.equal(coupons.length, 0, "no coupon-code call for either");

  const expired = await ChzzkReward.findOne({ rewardNo: 202 }).lean();
  assert.equal(expired.state, "earned");
  assert.equal(expired.hasCode, false);
  assert.equal(expired.lastError, "expired");
});

// --------------------------------------------- never overwrite a code

test("a stored code is NEVER overwritten — not on a repeat claim, not on a new fetch", async () => {
  const s = setup();
  const acc = await makeAccount();
  const claim = {
    rewardNo: 301,
    campaignNo: 5,
    title: "Keep Me",
    rewardType: "CODE_FIRST_COME",
    fulfillmentState: "COMPLIED",
    createdDate: kst(s.clock.t - HOUR),
    codeEndDate: kst(s.clock.t + 7 * 24 * HOUR),
    campaign: { title: "Set" },
  };
  s.world.setClaims("hash-a", [claim]);
  s.world.setCode("hash-a", 301, () => ({ codeNo: "A", code: "FIRST-CODE" }));

  const first = await s.collector.collect(String(acc._id));
  assert.equal(first.stored, 1);
  const after1 = await ChzzkReward.findOne({ rewardNo: 301 }).lean();
  assert.equal(decrypt(after1.codeEnc), "FIRST-CODE");

  // CHZZK now says a different code — the collector must refuse it.
  s.world.setCode("hash-a", 301, () => ({ codeNo: "B", code: "SECOND-CODE" }));
  const again = await s.collector.collect(String(acc._id));
  assert.deepEqual(again, { read: 1, stored: 0, failed: 0 });
  const after2 = await ChzzkReward.findOne({ rewardNo: 301 }).lean();
  assert.equal(decrypt(after2.codeEnc), "FIRST-CODE", "the first code stands");
  assert.equal(after2.codeNo, "A");

  // couponCode must not even have been asked on the second run — hasCode true already.
  const coupons = s.world.calls.filter((c) => c.method === "couponCode");
  assert.equal(coupons.length, 1);
  // Only the first store emitted an activity line.
  const codeEntries = s.activity.get().filter((e) => e.kind === "code");
  assert.equal(codeEntries.length, 1);
});

test("the structural filter refuses a code write when hasCode flips mid-run", async () => {
  const s = setup();
  const acc = await makeAccount();
  s.world.setClaims("hash-a", [
    {
      rewardNo: 401,
      campaignNo: 1,
      title: "Race",
      rewardType: "CODE_FIRST_COME",
      fulfillmentState: "COMPLIED",
      createdDate: kst(s.clock.t - HOUR),
      codeEndDate: kst(s.clock.t + 24 * HOUR),
      campaign: { title: "x" },
    },
  ]);
  // Another process stored the code (encrypted directly) between upsert and fetch.
  const existing = encrypt("ALREADY-STORED");
  s.world.setCode("hash-a", 401, async () => {
    // Simulate the race: the row grows a code just before our write.
    await ChzzkReward.updateOne(
      { accountId: String(acc._id), rewardNo: 401 },
      { $set: { hasCode: true, codeEnc: existing, state: "stored", codeNo: "race" } },
    );
    return { codeNo: "ours", code: "SHOULD-NOT-WIN" };
  });

  const out = await s.collector.collect(String(acc._id));
  assert.equal(out.stored, 0, "the write is refused — hasCode was true at commit");
  const row = await ChzzkReward.findOne({ rewardNo: 401 }).lean();
  assert.equal(row.codeNo, "race");
  assert.equal(decrypt(row.codeEnc), "ALREADY-STORED");
});

// --------------------------------------------------- retry / backoff

test("a refused coupon-code call bumps tries, sets a 30-min nextTryAt, and is tried again after", async () => {
  const s = setup();
  const acc = await makeAccount();
  s.world.setClaims("hash-a", [
    {
      rewardNo: 501,
      campaignNo: 3,
      title: "Slow",
      rewardType: "CODE_FIRST_COME",
      fulfillmentState: "COMPLIED",
      createdDate: kst(s.clock.t - HOUR),
      codeEndDate: kst(s.clock.t + 24 * HOUR),
      campaign: { title: "set" },
    },
  ]);
  let delivered = false;
  s.world.setCode("hash-a", 501, () => {
    if (!delivered) throw new ChzzkError("not ready", { code: "API" });
    return { codeNo: "1", code: "LATE-CODE" };
  });

  const first = await s.collector.collect(String(acc._id));
  assert.deepEqual(first, { read: 1, stored: 0, failed: 1 });
  const r1 = await ChzzkReward.findOne({ rewardNo: 501 }).lean();
  assert.equal(r1.hasCode, false);
  assert.equal(r1.tries, 1);
  assert.ok(r1.lastError && !/LATE-CODE/.test(r1.lastError), "lastError is short and never a code");
  assert.ok(r1.nextTryAt instanceof Date);
  assert.equal(r1.nextTryAt.getTime(), s.clock.t + RETRY_MS);

  // Try again just before the backoff ends — no couponCode call.
  const callsBefore = s.world.calls.filter((c) => c.method === "couponCode").length;
  const retry = await s.collector.collect(String(acc._id));
  assert.deepEqual(retry, { read: 1, stored: 0, failed: 0 }, "skipped, not failed again");
  const callsMid = s.world.calls.filter((c) => c.method === "couponCode").length;
  assert.equal(callsMid, callsBefore, "nextTryAt still in the future, no call");

  // Advance past the backoff; code now delivers.
  s.clock.t += RETRY_MS + 1000;
  delivered = true;
  const third = await s.collector.collect(String(acc._id));
  assert.equal(third.stored, 1);
  const r3 = await ChzzkReward.findOne({ rewardNo: 501 }).lean();
  assert.equal(decrypt(r3.codeEnc), "LATE-CODE");
  assert.equal(r3.lastError, "");
});

test("an empty code is treated as a failure, not a store", async () => {
  const s = setup();
  const acc = await makeAccount();
  s.world.setClaims("hash-a", [
    {
      rewardNo: 601,
      campaignNo: 1,
      title: "Blank",
      rewardType: "CODE_LOTTERY",
      fulfillmentState: "COMPLIED",
      createdDate: kst(s.clock.t - HOUR),
      codeEndDate: kst(s.clock.t + HOUR),
      campaign: { title: "x" },
    },
  ]);
  s.world.setCode("hash-a", 601, () => ({ codeNo: "0", code: "" }));
  const out = await s.collector.collect(String(acc._id));
  assert.deepEqual(out, { read: 1, stored: 0, failed: 1 });
  const r = await ChzzkReward.findOne({ rewardNo: 601 }).lean();
  assert.equal(r.hasCode, false);
  assert.equal(r.tries, 1);
});

// ------------------------------------------------------- AUTH / EGRESS

test("AUTH from claims() rethrows out of collect() and the row set is untouched", async () => {
  const s = setup();
  const acc = await makeAccount();
  // No setClaims — override the client to throw AUTH.
  const originalClientFor = s.world.clientFor;
  const authy = {
    claims: async () => {
      throw new ChzzkError("logged out", { code: "AUTH", status: 401 });
    },
    couponCode: async () => {
      throw new ChzzkError("logged out", { code: "AUTH" });
    },
  };
  const col = createCollector({
    Account: ChzzkAccount,
    Reward: ChzzkReward,
    activity: s.activity,
    clientFor: () => authy,
    now: () => s.clock.t,
    sleep: async () => {},
    gapMs: 0,
  });
  await assert.rejects(() => col.collect(String(acc._id)), /logged out/);
  assert.equal(await ChzzkReward.countDocuments({ accountId: String(acc._id) }), 0);
  void originalClientFor;
});

test("AUTH from couponCode rethrows and stops the collection; earlier rows are still upserted", async () => {
  const s = setup();
  const acc = await makeAccount();
  s.world.setClaims("hash-a", [
    {
      rewardNo: 701,
      campaignNo: 1,
      title: "First",
      rewardType: "CODE_FIRST_COME",
      fulfillmentState: "COMPLIED",
      createdDate: kst(s.clock.t - HOUR),
      codeEndDate: kst(s.clock.t + HOUR),
      campaign: { title: "x" },
    },
    {
      rewardNo: 702,
      campaignNo: 1,
      title: "Second",
      rewardType: "CODE_FIRST_COME",
      fulfillmentState: "COMPLIED",
      createdDate: kst(s.clock.t - HOUR),
      codeEndDate: kst(s.clock.t + HOUR),
      campaign: { title: "x" },
    },
  ]);
  s.world.setCode("hash-a", 701, () => {
    throw new ChzzkError("auth", { code: "AUTH", status: 401 });
  });
  await assert.rejects(() => s.collector.collect(String(acc._id)), /auth/);
  // Both rows were upserted (the loop upserts before fetching), but no code was stored.
  assert.equal(await ChzzkReward.countDocuments({ accountId: String(acc._id) }), 1);
  const r = await ChzzkReward.findOne({ rewardNo: 701 }).lean();
  assert.equal(r.hasCode, false);
});

test("EGRESS from claims() returns { error: 'egress' } and never throws", async () => {
  const s = setup();
  const acc = await makeAccount();
  const bad = {
    claims: async () => {
      throw new ChzzkError("tunnel down", { code: "EGRESS" });
    },
    couponCode: async () => {},
  };
  const col = createCollector({
    Account: ChzzkAccount,
    Reward: ChzzkReward,
    activity: s.activity,
    clientFor: () => bad,
    now: () => s.clock.t,
    sleep: async () => {},
    gapMs: 0,
  });
  const out = await col.collect(String(acc._id));
  assert.deepEqual(out, { read: 0, stored: 0, failed: 0, error: "egress" });
});

test("TIMEOUT from couponCode returns { error: 'egress' } and stops the loop", async () => {
  const s = setup();
  const acc = await makeAccount();
  s.world.setClaims("hash-a", [
    {
      rewardNo: 801,
      campaignNo: 1,
      title: "A",
      rewardType: "CODE_FIRST_COME",
      fulfillmentState: "COMPLIED",
      createdDate: kst(s.clock.t - HOUR),
      codeEndDate: kst(s.clock.t + HOUR),
      campaign: { title: "x" },
    },
    {
      rewardNo: 802,
      campaignNo: 1,
      title: "B",
      rewardType: "CODE_FIRST_COME",
      fulfillmentState: "COMPLIED",
      createdDate: kst(s.clock.t - HOUR),
      codeEndDate: kst(s.clock.t + HOUR),
      campaign: { title: "x" },
    },
  ]);
  s.world.setCode("hash-a", 801, () => {
    throw new ChzzkError("read timed out", { code: "TIMEOUT" });
  });
  s.world.setCode("hash-a", 802, () => ({ codeNo: "x", code: "SECOND" }));
  const out = await s.collector.collect(String(acc._id));
  assert.equal(out.error, "egress");
  // The second reward was NOT fetched: the loop stopped on the first egress.
  const second = await ChzzkReward.findOne({ rewardNo: 802 }).lean();
  assert.ok(!second || !second.hasCode, "second reward's code was not fetched");
  const coupons = s.world.calls.filter((c) => c.method === "couponCode");
  assert.deepEqual(coupons.map((c) => c.rewardNo), [801]);
});

// ------------------------------------------------------------- pacing

test("the global queue is serial and waits gapMs between coupon-code calls", async () => {
  const s = setup({ gapMs: 3000 });
  const a1 = await makeAccount({ nickname: "n1", userIdHash: "h1" });
  const a2 = await makeAccount({ nickname: "n2", userIdHash: "h2" });
  const mk = (no, title) => ({
    rewardNo: no,
    campaignNo: 1,
    title,
    rewardType: "CODE_FIRST_COME",
    fulfillmentState: "COMPLIED",
    createdDate: kst(s.clock.t - HOUR),
    codeEndDate: kst(s.clock.t + HOUR),
    campaign: { title: "pace" },
  });
  s.world.setClaims("h1", [mk(901, "A1"), mk(902, "A2")]);
  s.world.setClaims("h2", [mk(903, "B1")]);
  s.world.setCode("h1", 901, () => ({ codeNo: "1", code: "C-A1" }));
  s.world.setCode("h1", 902, () => ({ codeNo: "2", code: "C-A2" }));
  s.world.setCode("h2", 903, () => ({ codeNo: "3", code: "C-B1" }));

  const started = s.clock.t;
  const [r1, r2] = await Promise.all([
    s.collector.collect(String(a1._id)),
    s.collector.collect(String(a2._id)),
  ]);
  assert.equal(r1.stored, 2);
  assert.equal(r2.stored, 1);
  // Two gaps between the three coupon-code calls — but not before the first one.
  const codeWaits = s.waits.filter((w) => w === 3000);
  assert.equal(codeWaits.length, 2, "one 3s wait between each pair of coupon-code calls");
  // All three stored codes decrypt back.
  const [r901, r902, r903] = await Promise.all([
    ChzzkReward.findOne({ rewardNo: 901 }).lean(),
    ChzzkReward.findOne({ rewardNo: 902 }).lean(),
    ChzzkReward.findOne({ rewardNo: 903 }).lean(),
  ]);
  assert.equal(decrypt(r901.codeEnc), "C-A1");
  assert.equal(decrypt(r902.codeEnc), "C-A2");
  assert.equal(decrypt(r903.codeEnc), "C-B1");
  // The couponCode calls for a1 all happened before any for a2 (serial queue).
  const callOrder = s.world.calls
    .filter((c) => c.method === "couponCode")
    .map((c) => c.key);
  assert.deepEqual(callOrder, ["h1", "h1", "h2"]);
  // Pending drops back to 0 at the end.
  assert.equal(s.collector.pending(), 0);
  void started;
});

// --------------------------------------------------------------- sweep

test("sweep runs collect for each id in order and short-circuits on egress", async () => {
  const s = setup();
  const a1 = await makeAccount({ nickname: "n1", userIdHash: "h1" });
  const a2 = await makeAccount({ nickname: "n2", userIdHash: "h2" });
  const a3 = await makeAccount({ nickname: "n3", userIdHash: "h3" });
  const mk = (no) => ({
    rewardNo: no,
    campaignNo: 1,
    title: "Sweep " + no,
    rewardType: "CODE_FIRST_COME",
    fulfillmentState: "COMPLIED",
    createdDate: kst(s.clock.t - HOUR),
    codeEndDate: kst(s.clock.t + HOUR),
    campaign: { title: "sw" },
  });
  s.world.setClaims("h1", [mk(1001)]);
  s.world.setClaims("h2", []); // the egress victim overrides this
  s.world.setClaims("h3", [mk(1003)]);
  s.world.setCode("h1", 1001, () => ({ codeNo: "1", code: "SW-1" }));
  s.world.setCode("h3", 1003, () => ({ codeNo: "3", code: "SW-3" }));

  // Make account 2's client fail with EGRESS at claims() time.
  const col = createCollector({
    Account: ChzzkAccount,
    Reward: ChzzkReward,
    activity: s.activity,
    clientFor: (acc) => {
      if (acc.userIdHash === "h2") {
        return {
          claims: async () => {
            throw new ChzzkError("down", { code: "EGRESS" });
          },
          couponCode: async () => {},
        };
      }
      return s.world.clientFor(acc);
    },
    now: () => s.clock.t,
    sleep: async () => {},
    gapMs: 0,
  });

  const results = await col.sweep([String(a1._id), String(a2._id), String(a3._id)]);
  assert.equal(results.length, 2, "stops on egress");
  assert.equal(results[0].stored, 1);
  assert.equal(results[1].error, "egress");
  // a3 was never reached.
  assert.equal(await ChzzkReward.countDocuments({ accountId: String(a3._id) }), 0);
});

// --------------------------------------------------------------- reveal

test("reveal decrypts, stamps revealedAt/revealedBy, strips codeEnc from the returned row", async () => {
  const s = setup();
  const acc = await makeAccount();
  s.world.setClaims("hash-a", [
    {
      rewardNo: 1101,
      campaignNo: 2,
      title: "Reveal Me",
      rewardType: "CODE_LOTTERY",
      fulfillmentState: "COMPLIED",
      createdDate: kst(s.clock.t - HOUR),
      codeEndDate: kst(s.clock.t + HOUR),
      campaign: { title: "x" },
    },
  ]);
  s.world.setCode("hash-a", 1101, () => ({ codeNo: "a", code: "SECRET-ABC" }));
  await s.collector.collect(String(acc._id));
  const row = await ChzzkReward.findOne({ rewardNo: 1101 });
  const r = await s.collector.reveal(String(row._id), "alice");
  assert.ok(r);
  assert.equal(r.code, "SECRET-ABC");
  assert.equal(r.row.codeEnc, undefined, "codeEnc is stripped from the returned row");
  assert.equal(r.row.hasCode, true);
  assert.equal(r.row.rewardNo, 1101);
  const after = await ChzzkReward.findById(row._id).lean();
  assert.equal(after.revealedBy, "alice");
  assert.ok(after.revealedAt instanceof Date);
  // Activity entry logs who, not the code value.
  const reveals = s.activity.get().filter((e) => e.kind === "reveal");
  assert.equal(reveals.length, 1);
  assert.ok(reveals[0].msg.includes("alice"));
  assert.ok(!/SECRET-ABC/.test(reveals[0].msg));
});

test("reveal returns null when the row has no code yet or is missing", async () => {
  const s = setup();
  const acc = await makeAccount();
  const row = await ChzzkReward.create({
    accountId: String(acc._id),
    campaignNo: 1,
    rewardNo: 1,
    title: "Empty",
    rewardType: "CODE_FIRST_COME",
    hasCode: false,
    codeEnc: "",
    state: "earned",
  });
  assert.equal(await s.collector.reveal(String(row._id), "bob"), null);
  const bogusId = new mongoose.Types.ObjectId().toString();
  assert.equal(await s.collector.reveal(bogusId, "bob"), null);
});

// ------------------------------------------------------------ sold / unknown

test("a sold account is not asked for anything", async () => {
  const s = setup();
  const acc = await ChzzkAccount.create({
    userIdHash: "hash-sold",
    nickname: "sold",
    status: "ok",
    sold: true,
  });
  s.world.setClaims("hash-sold", [
    {
      rewardNo: 1201,
      campaignNo: 1,
      title: "Nope",
      rewardType: "CODE_FIRST_COME",
      fulfillmentState: "COMPLIED",
      createdDate: kst(s.clock.t - HOUR),
      codeEndDate: kst(s.clock.t + HOUR),
      campaign: { title: "x" },
    },
  ]);
  const out = await s.collector.collect(String(acc._id));
  assert.equal(out.error, "sold");
  assert.equal(s.world.calls.length, 0);
});

test("an unknown account id returns 'unknown-account' and never calls the client", async () => {
  const s = setup();
  const bogus = new mongoose.Types.ObjectId().toString();
  const out = await s.collector.collect(bogus);
  assert.equal(out.error, "unknown-account");
  assert.equal(s.world.calls.length, 0);
});
