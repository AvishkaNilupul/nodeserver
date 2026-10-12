// SOOP farm services (docs/SOOP-FARM-CONTRACT.md §9): activity log, inventory,
// account health. Runs against the real models on an in-memory MongoDB with a
// hand-rolled client — no network, and every pace / flush timer is 0–5 ms.
//
// The failures these exist to prevent:
//  1. A CODE LEAK. Reward codes are what gets sold. They may exist only as
//     `codeEnc`; the assertions are on SERIALISED output and on the raw
//     collection documents, so a future field or spread cannot slip one out.
//  2. A FALSE DEATH. A tunnel blip during a health sweep must never mark an
//     account logged out — that would stop the whole fleet farming.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.CRED_SECRET ||= "soop-services-test-cred-secret";

const SoopAccount = require("../models/SoopAccount");
const SoopActivity = require("../models/SoopActivity");
const SoopInventoryItem = require("../models/SoopInventoryItem");
const { SoopError } = require("../utils/soop/errors");
const { PLAIN } = require("../utils/soop/errors");
const { createActivityLog } = require("../utils/soop/activity");
const { createInventoryService } = require("../utils/soop/inventory");
const { createHealthService } = require("../utils/soop/health");

const NOW = Date.parse("2026-10-06T00:00:00Z");
const HOUR = 3600 * 1000;
const CODES = ["SENTINEL-CODE-AAAA", "SENTINEL-PIN-BBBB", "SENTINEL-COUPON-CCCC", "SENTINEL-PLAIN-DDDD"];
const CODE_FIELDS = ["itemCode", "code", "pinNo", "couponNo"];

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([SoopAccount.init(), SoopActivity.init(), SoopInventoryItem.init()]);
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

test.beforeEach(async () => {
  await Promise.all([SoopAccount.deleteMany({}), SoopActivity.deleteMany({}), SoopInventoryItem.deleteMany({})]);
});

const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("condition not reached in time");
    await tick(2);
  }
}
const noLeak = (value, what) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const c of CODES) assert.ok(!text.includes(c), `${what} leaked a reward code`);
  assert.ok(!text.includes("codeEnc"), `${what} exposes codeEnc`);
  assert.ok(!text.includes("enc:v1:"), `${what} exposes ciphertext`);
};

// Raw rows shaped like drops.sooplive.com/api/get_drops_list.php. Times are KST.
const row = (idx, extra = {}) => ({
  idx,
  itemName: `Item ${idx}`,
  itemType: "1",
  gameNo: "12",
  cateName: "Overwatch",
  sendDate: "2026-10-01 10:00:00",
  expDate: "2026-10-20 00:00:00",
  ...extra,
});

function inventoryClient(inv, counts) {
  return {
    inventoryCounts: async () =>
      counts || {
        available: (inv.available || []).length,
        acquired: (inv.acquired || []).length,
        expired: (inv.expired || []).length,
      },
    inventory: async (division) => inv[division] || [],
  };
}

function quietActivity() {
  return createActivityLog({ model: { insertMany: async () => [] }, flushMs: 1, now: () => NOW });
}

// ---------------------------------------------------------------- activity

test("activity: the ring keeps the newest `cap` entries, newest first", () => {
  const log = createActivityLog({ model: SoopActivity, cap: 5, flushMs: 60000 });
  for (let i = 0; i < 8; i++) log.add({ kind: "t", msg: `m${i}` });
  assert.deepEqual(log.recent().map((e) => e.msg), ["m7", "m6", "m5", "m4", "m3"]);
  assert.deepEqual(log.recent({ limit: 2 }).map((e) => e.msg), ["m7", "m6"]);
  assert.equal(log.recent()[0].level, "info");
  assert.ok(log.recent()[0].at instanceof Date);
  log.stop();
});

test("activity: recent() filters by level, account and bot", () => {
  const log = createActivityLog({ model: SoopActivity, flushMs: 60000 });
  log.add({ kind: "t", msg: "a", accountId: "acc1", botId: "bot1" });
  log.add({ kind: "t", msg: "b", accountId: "acc2", botId: "bot1", level: "warn" });
  log.add({ kind: "t", msg: "c", accountId: "acc1", botId: "bot2", level: "error", dropsIdx: 13337 });
  log.add({ kind: "t", msg: "d", level: "shouting" });
  assert.deepEqual(log.recent({ level: "warn" }).map((e) => e.msg), ["b"]);
  assert.deepEqual(log.recent({ accountId: "acc1" }).map((e) => e.msg), ["c", "a"]);
  assert.deepEqual(log.recent({ botId: "bot1" }).map((e) => e.msg), ["b", "a"]);
  assert.deepEqual(log.recent({ accountId: "acc1", level: "error" }).map((e) => e.msg), ["c"]);
  assert.equal(log.recent({ accountId: "acc1" })[0].dropsIdx, "13337");
  assert.equal(log.recent()[0].level, "info", "an unknown level falls back to info");
  log.stop();
});

test("activity: flush writes each queued entry to the database exactly once", async () => {
  const log = createActivityLog({ model: SoopActivity, flushMs: 60000, now: () => NOW });
  log.add({ kind: "bot", msg: "one", accountId: "acc1", data: { minutes: 30 } });
  log.add({ kind: "bot", msg: "two", level: "warn", botId: "bot9" });
  log.add({ kind: "bot", msg: "three", level: "error", dropsIdx: "13337" });
  await log.flush();
  await log.flush();
  const docs = await SoopActivity.find({}).sort({ msg: 1 }).lean();
  assert.deepEqual(docs.map((d) => d.msg), ["one", "three", "two"]);
  assert.equal(docs[0].at.getTime(), NOW);
  assert.equal(docs[0].accountId, "acc1");
  assert.deepEqual(docs[0].data, { minutes: 30 });
  assert.equal(docs[1].level, "error");
  log.stop();
});

test("activity: the timer flushes on its own after flushMs", async () => {
  const log = createActivityLog({ model: SoopActivity, flushMs: 2 });
  log.add({ kind: "t", msg: "timed" });
  await until(() => SoopActivity.countDocuments({ msg: "timed" }).then((n) => n === 1));
  await tick(10);
  assert.equal(await SoopActivity.countDocuments({}), 1);
  log.stop();
});

test("activity: add() never throws when the database write fails", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  let writes = 0;
  const model = {
    insertMany: async () => {
      writes += 1;
      throw new Error("db down");
    },
  };
  const log = createActivityLog({ model, flushMs: 1 });
  assert.doesNotThrow(() => log.add({ kind: "t", msg: "kept in memory" }));
  assert.doesNotThrow(() => log.add(null));
  assert.doesNotThrow(() => log.add({ msg: { toString: null } }));
  await assert.doesNotReject(() => log.flush());
  await until(() => writes >= 1);
  assert.doesNotThrow(() => log.add({ kind: "t", msg: "still fine" }));
  await assert.doesNotReject(() => log.flush());
  assert.equal(log.recent()[0].msg, "still fine");
  assert.ok(log.recent().some((e) => e.msg === "kept in memory"));
  assert.ok(errors.mock.callCount() >= 1, "the failed write is reported, not swallowed silently");
  log.stop();
});

// --------------------------------------------------------------- inventory

function inventoryWorld() {
  const inv = {
    acc1: {
      available: [
        row("101", { itemCode: CODES[0] }),
        row("102", { pinNo: CODES[1], expDate: "2026-10-07 12:00:00" }), // 27 h away
        row("103", { itemName: "=HYPERLINK(1)", itemType: "4" }),
      ],
      acquired: [row("104", { couponNo: CODES[2], expDate: "2026-10-07 12:00:00" })],
      expired: [row("105", { code: CODES[3], expDate: "2026-09-01 00:00:00" })],
    },
    acc2: {
      available: [
        row("201", { itemCode: CODES[0], expDate: "2026-10-08 23:00:00" }), // 62 h away
        row("202", { expDate: "2026-10-05 00:00:00" }), // already past
        row("203", { expDate: "" }),
        row("204", { gameNo: "244", cateName: "Wuthering Waves", expDate: "2026-10-09 10:00:00" }), // 73 h away
      ],
    },
  };
  const activity = quietActivity();
  const service = createInventoryService({
    getClient: async (id) => inventoryClient(inv[id] || {}),
    activity,
    paceMs: 2,
    now: () => NOW,
  });
  return { inv, activity, service };
}

test("inventory: syncAccount upserts by key and removes rows that vanished", async () => {
  const { inv, service } = inventoryWorld();
  const first = await service.syncAccount("acc1");
  assert.equal(first.id, "acc1");
  assert.equal(first.added, 5);
  assert.equal(first.items.length, 5);
  assert.deepEqual(first.counts, { available: 3, acquired: 1, expired: 1 });
  assert.equal(first.at.getTime(), NOW);
  const before = await SoopInventoryItem.find({ loginId: "acc1" }).lean();
  const idOf = (rows, key) => String(rows.find((r) => r.key === key)._id);

  // 101 was claimed by the buyer, 102 is gone, 106 is new.
  inv.acc1.acquired.push(inv.acc1.available.shift());
  inv.acc1.available.shift();
  inv.acc1.available.push(row("106"));
  const second = await service.syncAccount("acc1");
  assert.equal(second.added, 1);

  const after = await SoopInventoryItem.find({ loginId: "acc1" }).lean();
  assert.deepEqual(after.map((r) => r.key).sort(), ["101", "103", "104", "105", "106"]);
  assert.equal(idOf(after, "101"), idOf(before, "101"), "an existing row is updated in place");
  assert.equal(after.find((r) => r.key === "101").division, "acquired");
  assert.equal(await SoopInventoryItem.countDocuments({ loginId: "acc1", key: "102" }), 0);
});

test("inventory: a sync of one account never touches another account's rows", async () => {
  const { service } = inventoryWorld();
  await service.syncAccount("acc2");
  await service.syncAccount("acc1");
  await service.syncAccount("acc1");
  assert.equal(await SoopInventoryItem.countDocuments({ loginId: "acc2" }), 4);
  assert.equal(await SoopInventoryItem.countDocuments({ loginId: "acc1" }), 5);
});

test("inventory: codes are stored only encrypted", async () => {
  const { service, activity } = inventoryWorld();
  const result = await service.syncAccount("acc1");
  noLeak(result, "syncAccount result");
  noLeak(activity.recent(), "activity log");

  const docs = await SoopInventoryItem.collection.find({ loginId: "acc1" }).toArray();
  assert.equal(docs.length, 5);
  const stored = JSON.stringify(docs);
  for (const c of CODES) assert.ok(!stored.includes(c), "a plain code reached the collection");
  for (const d of docs) {
    assert.equal(d.code, undefined);
    for (const f of CODE_FIELDS) assert.equal(d.raw[f], undefined, `raw.${f} was persisted`);
    assert.equal(d.raw.itemName, `${d.nameRaw}`, "the rest of the raw row is kept");
    if (d.key === "103") {
      assert.equal(d.hasCode, false);
      assert.equal(d.codeEnc, "");
    } else {
      assert.equal(d.hasCode, true);
      assert.match(d.codeEnc, /^enc:v1:/);
    }
  }
});

test("inventory: forAccount, summary and csv never contain a code", async () => {
  const { service } = inventoryWorld();
  await service.syncAccount("acc1");
  await service.syncAccount("acc2");

  const items = await service.forAccount("acc1");
  assert.equal(items.length, 5);
  noLeak(items, "forAccount");
  for (const item of items) {
    assert.equal(item.code, undefined);
    assert.equal(item.raw, undefined);
    assert.equal(typeof item.hasCode, "boolean");
    assert.match(item.id, /^[0-9a-f]{24}$/);
  }
  assert.deepEqual(items.map((i) => i.division), ["available", "available", "available", "acquired", "expired"]);
  assert.deepEqual(await service.forAccount("nobody"), []);

  noLeak(await service.summary(), "summary");

  const csv = await service.csv();
  noLeak(csv, "csv");
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "loginId,game,item,kind,division,expiresAt,hasCode");
  assert.equal(lines.length, 1 + 9);
  assert.ok(lines.some((l) => /^acc1,[^,]+,Item 101,code,available,2026-10-19T15:00:00\.000Z,yes$/.test(l)), csv);
  assert.ok(lines.some((l) => l.includes(",'=HYPERLINK(1),")), "a formula-looking item name is defused");
});

test("inventory: revealCode round-trips the stored code", async () => {
  const { service } = inventoryWorld();
  await service.syncAccount("acc1");
  const items = await service.forAccount("acc1");
  const byName = (name) => items.find((i) => i.name.endsWith(name) || i.nameRaw.endsWith(name));
  assert.equal(await service.revealCode(byName("101").id), CODES[0]);
  assert.equal(await service.revealCode(byName("104").id), CODES[2]);
  assert.equal(await service.revealCode(byName("105").id), CODES[3]);
  assert.equal(await service.revealCode(items.find((i) => !i.hasCode).id), null);
  assert.equal(await service.revealCode(String(new mongoose.Types.ObjectId())), null);
  assert.equal(await service.revealCode("not-an-id"), null);
  assert.equal(await service.revealCode(""), null);
});

test("inventory: summary groups by game and item; expiringSoon is available items within 72 h", async () => {
  const { service } = inventoryWorld();
  await service.syncAccount("acc1");
  await service.syncAccount("acc2");
  const s = await service.summary();
  // 102 (27 h) and 201 (62 h) count. Not: 104 (acquired), 202 (already past),
  // 203 (no expiry), 204 (73 h), 105 (expired).
  assert.deepEqual(s.totals, { available: 7, acquired: 1, expired: 1, expiringSoon: 2 });
  assert.equal(new Date(s.lastSyncAt).getTime(), NOW);
  assert.equal(s.games.length, 2);
  const ow = s.games.find((g) => g.gameNo === "12");
  assert.equal(typeof ow.gameName, "string");
  const item = (g, suffix) => g.items.find((i) => i.name.endsWith(suffix));
  assert.deepEqual(
    { ...item(ow, "102"), image: null },
    {
      name: item(ow, "102").name, kind: "code", image: null,
      available: 1, acquired: 0, expired: 0,
      soonestExpiry: new Date("2026-10-07T03:00:00Z"), accountIds: ["acc1"],
    },
  );
  assert.equal(item(ow, "104").soonestExpiry, null, "only available items have an expiry worth chasing");
  assert.equal(item(ow, "202").soonestExpiry, null);
  assert.equal(ow.items.find((i) => i.name === "=HYPERLINK(1)").kind, "ingame");
  const ww = s.games.find((g) => g.gameNo === "244");
  assert.deepEqual(ww.items[0].accountIds, ["acc2"]);

});

test("inventory: summary of an empty store is zeros, not an error", async () => {
  const service = createInventoryService({ getClient: async () => ({}) });
  assert.deepEqual(await service.summary(), {
    totals: { available: 0, acquired: 0, expired: 0, expiringSoon: 0 },
    lastSyncAt: null,
    games: [],
  });
  assert.equal(await service.csv(), "loginId,game,item,kind,division,expiresAt,hasCode\n");
});

test("inventory: an empty read that contradicts SOOP's own counter deletes nothing", async () => {
  const { inv, service, activity } = inventoryWorld();
  await service.syncAccount("acc1");
  const blip = createInventoryService({
    getClient: async () => inventoryClient({}, { available: 3, acquired: 1, expired: 1 }),
    activity,
    now: () => NOW,
  });
  await blip.syncAccount("acc1");
  assert.equal(await SoopInventoryItem.countDocuments({ loginId: "acc1" }), 5);
  assert.ok(activity.recent({ level: "warn" }).length >= 1);

  // A genuinely empty inventory (counter agrees) does clear the rows.
  inv.acc1 = {};
  await service.syncAccount("acc1");
  assert.equal(await SoopInventoryItem.countDocuments({ loginId: "acc1" }), 0);
});

test("inventory: a failed list read fails the whole sync and deletes nothing", async () => {
  const { service } = inventoryWorld();
  await service.syncAccount("acc1");
  const broken = createInventoryService({
    getClient: async () => ({
      inventoryCounts: async () => ({ available: 1, acquired: 0, expired: 0 }),
      inventory: async (division) => {
        if (division === "acquired") throw new SoopError("socket hang up", { code: "EGRESS" });
        return [row("999")];
      },
    }),
    now: () => NOW,
  });
  await assert.rejects(() => broken.syncAccount("acc1"), { code: "EGRESS" });
  assert.equal(await SoopInventoryItem.countDocuments({ loginId: "acc1" }), 5);
  assert.equal(await SoopInventoryItem.countDocuments({ key: "999" }), 0);
});

test("inventory: syncMany is paced, one account at a time, and status() progresses", async () => {
  const ids = ["p1", "p2", "p3"];
  const starts = [];
  const seen = [];
  let open = 0;
  let maxOpen = 0;
  const service = createInventoryService({
    getClient: async (id) => {
      starts.push(performance.now());
      seen.push({ id, ...service.status() });
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      return {
        inventoryCounts: async () => ({ available: 1, acquired: 0, expired: 0 }),
        inventory: async (division) => {
          if (division === "expired") open -= 1;
          return division === "available" ? [row(`${id}-1`)] : [];
        },
      };
    },
    paceMs: 5,
    now: () => NOW,
  });
  assert.deepEqual(service.status(), { running: false, done: 0, total: 0, lastAt: null, errors: [] });
  assert.deepEqual(service.syncMany(ids), { total: 3 });
  assert.deepEqual(service.syncMany(["p2", "p3"]), { total: 3 }, "ids already queued are not added twice");
  assert.equal(service.status().running, true);
  await until(() => !service.status().running);

  assert.deepEqual(seen.map((s) => [s.id, s.done, s.total, s.running]), [
    ["p1", 0, 3, true],
    ["p2", 1, 3, true],
    ["p3", 2, 3, true],
  ]);
  assert.equal(maxOpen, 1);
  assert.ok(starts[1] - starts[0] >= 4 && starts[2] - starts[1] >= 4, `not paced: ${starts}`);
  const done = service.status();
  assert.equal(done.done, 3);
  assert.equal(done.lastAt.getTime(), NOW);
  assert.deepEqual(done.errors, []);
  assert.equal(await SoopInventoryItem.countDocuments({}), 3);
  assert.deepEqual(service.syncMany([]), { total: 0 });
});

test("inventory: an AUTH error is recorded for that account and the batch carries on", async () => {
  const activity = quietActivity();
  const service = createInventoryService({
    getClient: async (id) => {
      if (id === "dead") {
        return {
          inventoryCounts: async () => {
            throw new SoopError("Please log in", { code: "AUTH" });
          },
          inventory: async () => [],
        };
      }
      if (id === "gone") throw new Error("account not found");
      return inventoryClient({ available: [row(`${id}-1`, { itemCode: CODES[0] })] });
    },
    activity,
    paceMs: 0,
    now: () => NOW,
  });
  service.syncMany(["a1", "dead", "gone", "a2"]);
  await until(() => !service.status().running);
  const s = service.status();
  assert.equal(s.done, 4);
  assert.equal(s.total, 4);
  assert.deepEqual(s.errors.map((e) => [e.id, e.code]), [["dead", "AUTH"], ["gone", "ERROR"]]);
  assert.equal(s.errors[0].error, PLAIN.AUTH); // the panel shows this as is
  assert.deepEqual((await SoopInventoryItem.distinct("loginId")).sort(), ["a1", "a2"]);
  assert.equal(activity.recent({ accountId: "dead", level: "warn" }).length, 1);
  noLeak(s, "status()");
  noLeak(activity.recent(), "activity log");
});

// ------------------------------------------------------------------ health

const CHECKED = new Date("2026-10-01T00:00:00Z");
const account = (loginId, extra = {}) =>
  SoopAccount.create({ loginId, nickname: "Old nick", country: "KR", status: "ok", lastCheckedAt: CHECKED, ...extra });

function healthWorld(opts = {}) {
  const state = {}; // per id: { loggedIn, privateError, missionsError }
  const dead = [];
  const asked = [];
  let clock = NOW;
  const activity = quietActivity();
  const service = createHealthService({
    getClient: async (id) => {
      asked.push(id);
      const s = state[id] || {};
      return {
        privateInfo: async () => {
          if (s.privateError) throw s.privateError;
          return s.loggedIn === false
            ? { loggedIn: false, loginId: "", nick: "", country: "" }
            : { loggedIn: true, loginId: id, nick: `Nick ${id}`, country: "LK" };
        },
        missions: async () => {
          if (s.missionsError) throw s.missionsError;
          return [{ dropsIdx: "1", minutes: 30, items: [] }, { dropsIdx: "2", minutes: 0, items: [] }];
        },
      };
    },
    activity,
    onDead: (id, reason) => dead.push([id, reason]),
    paceMs: 0,
    now: () => clock,
    ...opts,
  });
  return { state, dead, asked, activity, service, advance: (ms) => (clock += ms) };
}

test("health: a healthy account is marked ok with a check summary", async () => {
  const { service, dead } = healthWorld();
  await account("h1", { status: "untested", lastCheckedAt: null });
  const result = await service.check("h1");
  assert.deepEqual(result, {
    at: new Date(NOW).toISOString(), loggedIn: true, nick: "Nick h1", country: "LK",
    dropsOk: true, dropsError: null, missions: 2,
  });
  const doc = await SoopAccount.findOne({ loginId: "h1" }).lean();
  assert.equal(doc.status, "ok");
  assert.equal(doc.lastError, "");
  assert.equal(doc.nickname, "Nick h1");
  assert.equal(doc.country, "LK");
  assert.equal(doc.lastCheckedAt.getTime(), NOW);
  assert.equal(doc.deadAt, null);
  assert.deepEqual(doc.check, result);
  assert.deepEqual(dead, []);
  await assert.rejects(() => service.check("nobody"), /not found/);
});

test("health: logged out -> not_logged_in, deadAt set, onDead called exactly once", async () => {
  const { service, state, dead, activity, advance } = healthWorld();
  await account("h1");
  state.h1 = { loggedIn: false };
  const result = await service.check("h1");
  assert.equal(result.loggedIn, false);
  assert.equal(result.dropsOk, false);
  advance(HOUR);
  await Promise.all([service.check("h1"), service.check("h1")]);
  advance(HOUR);
  await service.check("h1");

  const doc = await SoopAccount.findOne({ loginId: "h1" }).lean();
  assert.equal(doc.status, "not_logged_in");
  assert.equal(doc.deadAt.getTime(), NOW, "deadAt is when it was first seen dead");
  assert.equal(doc.lastCheckedAt.getTime(), NOW + 2 * HOUR);
  assert.match(doc.lastError, /re-import the cookie/);
  assert.equal(doc.nickname, "Old nick", "a logged-out reply does not blank the nickname");
  assert.deepEqual(dead, [["h1", "not_logged_in"]]);
  assert.equal(activity.recent({ accountId: "h1", level: "error" }).length, 1);
});

test("health: onDead throwing does not fail the check", async (t) => {
  t.mock.method(console, "error", () => {});
  let calls = 0;
  const { service, state } = healthWorld({
    onDead: () => {
      calls += 1;
      throw new Error("handler broke");
    },
  });
  await account("h1");
  state.h1 = { loggedIn: false };
  await assert.doesNotReject(() => service.check("h1"));
  assert.equal(calls, 1);
  assert.equal((await SoopAccount.findOne({ loginId: "h1" }).lean()).status, "not_logged_in");
});

test("health: AUTH from missions -> drops_rejected, and the login is not reported dead", async () => {
  const { service, state, dead } = healthWorld();
  await account("h1");
  state.h1 = { missionsError: new SoopError("로그인이 필요합니다", { code: "AUTH" }) };
  const result = await service.check("h1");
  assert.equal(result.loggedIn, true);
  assert.equal(result.dropsOk, false);
  assert.equal(result.dropsError, "로그인이 필요합니다");
  assert.equal(result.missions, 0);
  const doc = await SoopAccount.findOne({ loginId: "h1" }).lean();
  assert.equal(doc.status, "drops_rejected");
  assert.equal(doc.deadAt, null);
  assert.match(doc.lastError, /drops site rejected/);
  assert.deepEqual(dead, []);
});

test("health: EGRESS / TIMEOUT change nothing but lastError", async () => {
  const { service, state, dead } = healthWorld();
  const DEAD_AT = new Date("2026-09-30T00:00:00Z");
  await account("ok1", { check: { at: "before", loggedIn: true } });
  await account("ok2", { check: { at: "before", loggedIn: true } });
  await account("dead1", { status: "not_logged_in", deadAt: DEAD_AT, check: { at: "before", loggedIn: false } });
  state.ok1 = { privateError: new SoopError("proxy connection refused", { code: "EGRESS" }) };
  state.ok2 = { missionsError: new SoopError("timed out after 20000 ms", { code: "TIMEOUT" }) };
  state.dead1 = { privateError: new SoopError("proxy connection refused", { code: "EGRESS" }) };

  await assert.rejects(() => service.check("ok1"), { code: "EGRESS" });
  await assert.rejects(() => service.check("ok2"), { code: "TIMEOUT" });
  await assert.rejects(() => service.check("dead1"), { code: "EGRESS" });

  for (const [id, status, deadAt, lastError] of [
    ["ok1", "ok", null, PLAIN.EGRESS],
    ["ok2", "ok", null, PLAIN.TIMEOUT],
    ["dead1", "not_logged_in", DEAD_AT, PLAIN.EGRESS],
  ]) {
    const doc = await SoopAccount.findOne({ loginId: id }).lean();
    assert.equal(doc.status, status, id);
    assert.deepEqual(doc.deadAt, deadAt, id);
    assert.equal(doc.lastError, lastError, id);
    assert.equal(doc.lastCheckedAt.getTime(), CHECKED.getTime(), id);
    assert.equal(doc.check.at, "before", id);
    assert.equal(doc.nickname, "Old nick", id);
    assert.equal(doc.country, "KR", id);
  }
  assert.deepEqual(dead, []);

  // The same through the background runner: recorded, not fatal, nobody dies.
  service.checkMany(["ok1", "ok2"]);
  await until(() => !service.status().running);
  assert.deepEqual(service.status().errors.map((e) => [e.id, e.code]), [["ok1", "EGRESS"], ["ok2", "TIMEOUT"]]);
  assert.equal(await SoopAccount.countDocuments({ status: "ok" }), 2);
});

test("health: recovery back to ok clears deadAt, and a later death is reported again", async () => {
  const { service, state, dead, advance } = healthWorld();
  await account("h1");
  state.h1 = { loggedIn: false };
  await service.check("h1");
  assert.ok((await SoopAccount.findOne({ loginId: "h1" }).lean()).deadAt);

  advance(HOUR);
  state.h1 = {}; // cookie re-imported
  await service.check("h1");
  const doc = await SoopAccount.findOne({ loginId: "h1" }).lean();
  assert.equal(doc.status, "ok");
  assert.equal(doc.deadAt, null);
  assert.equal(doc.lastError, "");
  assert.equal(dead.length, 1);

  advance(HOUR);
  state.h1 = { loggedIn: false };
  await service.check("h1");
  assert.equal(dead.length, 2);
  assert.equal((await SoopAccount.findOne({ loginId: "h1" }).lean()).deadAt.getTime(), NOW + 2 * HOUR);
});

test("health: checkMany runs in the background and reports progress", async () => {
  const { service, state, dead } = healthWorld({ paceMs: 2 });
  await account("c1");
  await account("c2");
  await account("c3");
  state.c2 = { loggedIn: false };
  assert.deepEqual(service.checkMany(["c1", "c2", "c3"]), { total: 3 });
  assert.equal(service.status().running, true);
  await until(() => !service.status().running);
  assert.equal(service.status().done, 3);
  assert.deepEqual(service.status().errors, []);
  assert.deepEqual(dead, [["c2", "not_logged_in"]]);
  assert.equal(await SoopAccount.countDocuments({ lastCheckedAt: new Date(NOW) }), 3);
});

test("health: the periodic sweep checks every non-sold account and skips sold ones", async () => {
  const { service, asked } = healthWorld({ everyMs: 3 });
  await account("s1");
  await account("s2", { status: "untested" });
  await account("sold1", { sold: true });
  service.start();
  service.start(); // idempotent: still one timer
  await until(() => asked.includes("s1") && asked.includes("s2") && asked.filter((id) => id === "s1").length >= 2);
  service.stop();
  await until(() => !service.status().running);
  const count = asked.length;
  await tick(15);
  assert.equal(asked.length, count, "stop() ends the sweep");
  assert.ok(!asked.includes("sold1"), "a sold account was probed");
  const sold = await SoopAccount.findOne({ loginId: "sold1" }).lean();
  assert.equal(sold.lastCheckedAt.getTime(), CHECKED.getTime());
  assert.equal((await SoopAccount.findOne({ loginId: "s2" }).lean()).status, "ok");
});
