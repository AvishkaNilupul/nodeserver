// Campaign store tests (docs/SOOP-FARM-CONTRACT.md §8).
//
// The failures these exist to prevent, all seen in v1:
//  - an empty campaign list was never cached, so SOOP was rescanned on every call;
//  - a campaign that left SOOP's list stayed `live` in the database for good;
//  - dates were stored nine hours late (Korea time read as server time).
// No network: the scan is a stub. No real waiting: time moves through `now`.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const SoopCampaign = require("../models/SoopCampaign");
const SoopGame = require("../models/SoopGame");
const SoopTranslation = require("../models/SoopTranslation");
const { createCampaignStore } = require("../utils/soop/campaignStore");

const TTL = 60000;
const STALE = 600000;
const START_KST = "2026-10-11 05:00:00";
const START_ISO = "2026-10-10T20:00:00.000Z"; // the same instant
const iso = (d) => (d ? d.toISOString() : null);

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([SoopCampaign.init(), SoopGame.init(), SoopTranslation.init()]);
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

test.beforeEach(async () => {
  await Promise.all([SoopCampaign.deleteMany({}), SoopGame.deleteMany({}), SoopTranslation.deleteMany({})]);
});

// A raw SOOP row (field names as in _soop-probe/events.json). The game numbers
// are made up so the name comes from `cateName`, not from the built-in table.
function raw(dropsIdx, over = {}) {
  return {
    dropsIdx: String(dropsIdx),
    title: `Event ${dropsIdx}`,
    giveCon: "term",
    filter: "progress",
    live: true,
    startDate: START_KST,
    endDate: "2026-10-18 05:00:00",
    gameNo: "9001",
    cateNo: "00049001",
    cateName: "Bravo",
    image: null,
    ingameGiveYn: "N",
    typeNm: null,
    broadIdList: [{ userId: "chan1", userNick: "Chan One", onAir: true }],
    itemList: [
      { itemType: "1", itemName: "Skin", giveTerm: "120" },
      { itemType: "1", itemName: "Spray", giveTerm: "60" },
    ],
    ...over,
  };
}

function scanner(rows = []) {
  const scan = async () => {
    scan.calls += 1;
    if (scan.gate) await scan.gate;
    if (scan.fail) throw scan.fail;
    return scan.rows;
  };
  Object.assign(scan, { calls: 0, rows, fail: null, gate: null });
  return scan;
}

// A store on a movable clock. The campaign write is fire-and-forget, so the
// model is wrapped to hand the test the promise to wait on.
function harness() {
  const clock = { t: Date.UTC(2026, 9, 6, 12) };
  const writes = [];
  const Campaigns = {
    find: (...a) => SoopCampaign.find(...a),
    findOne: (...a) => SoopCampaign.findOne(...a),
    bulkWrite: (...a) => {
      const p = SoopCampaign.bulkWrite(...a);
      writes.push(p);
      return p;
    },
  };
  const store = createCampaignStore({
    models: { SoopCampaign: Campaigns, SoopGame, SoopTranslation },
    ttlMs: TTL,
    staleOkMs: STALE,
    now: () => clock.t,
  });
  // Writes are queued one behind the other, hence the loop; setImmediate lets
  // the store start the next one (a macrotask turn, not a wait).
  const saved = async () => {
    do {
      await new Promise(setImmediate);
      await Promise.all(writes.splice(0));
      await new Promise(setImmediate);
    } while (writes.length);
  };
  return { store, clock, saved };
}

const row = (dropsIdx) => SoopCampaign.findOne({ dropsIdx }).lean();

test("list() caches for ttlMs, an empty result included", async () => {
  const { store, clock } = harness();
  const scan = scanner([]);
  assert.deepEqual(await store.list({ scan }), []);
  assert.deepEqual(await store.list({ scan }), []);
  clock.t += TTL - 1;
  await store.list({ scan });
  assert.equal(scan.calls, 1, "an empty list must be cached too");

  clock.t += 1;
  scan.rows = [null, { title: "no id" }, raw("a"), raw("a")];
  const list = await store.list({ scan });
  assert.equal(scan.calls, 2);
  assert.equal(list.length, 1, "junk and duplicate rows are dropped");
  const [c] = list;
  assert.equal(c.dropsIdx, "a");
  assert.equal(c.guaranteed, true);
  assert.equal(iso(c.startAt), START_ISO);
  assert.deepEqual(c.steps, [60, 120]);
  assert.equal(await store.list({ scan }), list, "the cached list is handed out as is");
});

test("concurrent list() calls share one in-flight scan", async () => {
  const { store } = harness();
  const scan = scanner([raw("a")]);
  let open;
  scan.gate = new Promise((r) => (open = r));
  const calls = [store.list({ scan }), store.list({ scan }), store.list({ scan, force: true })];
  open();
  const [a, b, c] = await Promise.all(calls);
  assert.equal(scan.calls, 1);
  assert.equal(a, b);
  assert.equal(a, c);
});

test("force bypasses the cache", async () => {
  const { store } = harness();
  const scan = scanner([raw("a")]);
  await store.list({ scan });
  scan.rows = [raw("a"), raw("b")];
  assert.equal((await store.list({ scan })).length, 1);
  assert.equal((await store.list({ scan, force: true })).length, 2);
  assert.equal(scan.calls, 2);
});

test("a failing scan serves the last good list inside staleOkMs, then rethrows; lastScan() reports both", async () => {
  const { store, clock } = harness();
  assert.deepEqual(store.lastScan(), { at: null, ok: false, error: null, count: 0 });

  const scan = scanner([raw("a"), raw("b")]);
  scan.fail = new Error("tunnel down");
  await assert.rejects(store.list({ scan }), /tunnel down/, "nothing to fall back on yet");
  assert.equal(store.lastScan().error, "tunnel down");

  scan.fail = null;
  const goodAt = clock.t;
  const good = await store.list({ scan });
  assert.deepEqual(store.lastScan(), { at: new Date(goodAt), ok: true, error: null, count: 2 });

  scan.fail = new Error("tunnel down");
  clock.t = goodAt + STALE - 1;
  assert.equal(await store.list({ scan }), good);
  assert.deepEqual(store.lastScan(), { at: new Date(clock.t), ok: false, error: "tunnel down", count: 2 });

  clock.t = goodAt + STALE;
  await assert.rejects(store.list({ scan }), /tunnel down/);
  await assert.rejects(store.list({ scan: null }), /no campaign scan/);

  scan.fail = null;
  assert.equal((await store.list({ scan })).length, 2);
  assert.equal(store.lastScan().ok, true);
});

test("get() finds a delisted campaign as 'unlisted', from memory and from the database", async () => {
  const { store, clock, saved } = harness();
  const scan = scanner([raw("a"), raw("b")]);
  await store.list({ scan });
  const listed = await store.get("a");
  assert.equal(listed.filter, "progress");
  assert.equal(listed.live, true);

  clock.t += TTL;
  scan.rows = [raw("b")];
  await store.list({ scan });
  const gone = await store.get("a");
  assert.equal(gone.filter, "unlisted");
  assert.equal(gone.live, false);
  assert.equal(gone.title, "Event a");
  assert.deepEqual(gone.steps, [60, 120]);
  assert.equal(iso(gone.startAt), START_ISO);
  assert.deepEqual(gone.channels, [{ id: "chan1", nick: "Chan One", onAir: true }]);
  assert.equal(store.all().map((c) => `${c.dropsIdx}:${c.filter}`).join(" "), "b:progress a:unlisted");
  assert.equal(await store.get("nope"), null);
  await saved();

  // A new process that has not loaded anything looks the row up on demand.
  const lazy = harness().store;
  const fromDb = await lazy.get("a");
  assert.equal(fromDb.filter, "unlisted");
  assert.equal(fromDb.live, false);
  assert.equal(iso(fromDb.startAt), START_ISO, "a v2 row's dates are not shifted again");
  assert.deepEqual(fromDb.items, gone.items);

  const loaded = harness().store;
  assert.deepEqual(await loaded.load(), { campaigns: 2, games: 0, translations: 0 });
  assert.equal(loaded.all().map((c) => c.filter).join(" "), "unlisted unlisted");
  assert.equal((await loaded.get("b")).live, false, "nothing is live until SOOP says so again");
});

test("`live` is cleared when SOOP stops reporting it and lastLiveAt is kept", async () => {
  const { store, clock, saved } = harness();
  const t0 = clock.t;
  const scan = scanner([raw("a"), raw("b")]);
  await store.list({ scan });
  await saved();
  assert.equal((await row("a")).live, true);
  assert.equal((await row("a")).lastLiveAt.getTime(), t0);

  // "a" is still listed but off air; "b" left the list altogether.
  clock.t += TTL;
  const t1 = clock.t;
  scan.rows = [raw("a", { live: false })];
  await store.list({ scan });
  await saved();
  const [a, b] = [await row("a"), await row("b")];
  assert.equal(a.live, false);
  assert.equal(a.lastLiveAt.getTime(), t0);
  assert.equal(a.seenAt.getTime(), t1);
  assert.equal(b.live, false);
  assert.equal(b.lastLiveAt.getTime(), t0);
  assert.equal(b.seenAt.getTime(), t0);

  clock.t += TTL;
  scan.rows = [raw("a")];
  await store.list({ scan });
  await saved();
  assert.equal((await row("a")).lastLiveAt.getTime(), clock.t);
});

test("a v1 row is rebuilt from its raw fields, and its late dates are rewritten by the next scan", async () => {
  // Written through the driver: exactly what production holds, no v2 defaults.
  await SoopCampaign.collection.insertOne({
    dropsIdx: "13337",
    title: "Legacy Cup",
    giveCon: "term",
    cateName: "Bravo",
    cateNo: "00049001",
    live: true,
    filter: "progress",
    startDate: new Date("2026-10-11T05:00:00.000Z"), // 9 h late
    endDate: new Date("2026-10-18T05:00:00.000Z"),
    broadIdList: raw("x").broadIdList,
    itemList: raw("x").itemList,
    seenAt: new Date("2026-10-04T00:00:00.000Z"),
  });
  const { store, saved } = harness();
  await store.load();
  const old = await store.get("13337");
  assert.equal(old.title, "Legacy Cup");
  assert.equal(old.filter, "unlisted");
  assert.equal(old.live, false, "v1 left `live` set on rows SOOP stopped listing");
  assert.equal(old.guaranteed, true);
  assert.equal(old.gameNo, null);
  assert.equal(old.gameName, "Bravo");
  assert.deepEqual(old.steps, [60, 120]);
  assert.equal(old.channels[0].id, "chan1");
  assert.equal(iso(old.startAt), START_ISO, "v1 dates are corrected on read");

  await store.list({ scan: scanner([raw("13337", { title: "Legacy Cup" })]) });
  await saved();
  const doc = await row("13337");
  assert.equal(iso(doc.startDate), START_ISO);
  assert.equal(iso(doc.endDate), "2026-10-17T20:00:00.000Z");
  assert.equal(doc.titleRaw, "Legacy Cup");
  assert.equal(doc.gameNo, "9001");

  const next = harness().store;
  await next.load();
  assert.equal(iso((await next.get("13337")).startAt), START_ISO, "corrected once, not twice");
});

test("games() counts campaigns per game, most live first, then by name", async (t) => {
  const { store, clock, saved } = harness();
  const game = (gameNo, cateName, over) => ({ gameNo, cateName, cateNo: `0004${gameNo}`, ...over });
  const scan = scanner([
    raw("b1", game("9001", "Bravo")),
    raw("b2", game("9001", "Bravo", { live: false })),
    raw("a1", game("9002", "Alpha", { live: false, giveCon: "draw" })),
    raw("c1", game("9003", "Charlie")),
    raw("c2", game("9003", "Charlie", { giveCon: "none" })),
    raw("d1", game("9004", "Delta")),
    raw("d2", game("9004", "Delta")),
  ]);
  await store.list({ scan });
  clock.t += TTL;
  scan.rows = scan.rows.filter((r) => r.dropsIdx !== "d2"); // remembered, no longer live
  await store.list({ scan });
  assert.deepEqual(store.games(), [
    { gameNo: "9003", name: "Charlie", campaigns: 2, live: 2, guaranteed: 1 },
    { gameNo: "9001", name: "Bravo", campaigns: 2, live: 1, guaranteed: 2 },
    { gameNo: "9004", name: "Delta", campaigns: 2, live: 1, guaranteed: 2 },
    { gameNo: "9002", name: "Alpha", campaigns: 1, live: 0, guaranteed: 0 },
  ]);

  await saved();
  await SoopGame.create({ gameNo: "9004", hidden: true });
  await store.load();
  assert.equal(store.games().map((g) => g.name).join(" "), "Charlie Bravo Alpha");

  // A database that cannot be read must not stop the farm from starting.
  t.mock.method(console, "error", () => {});
  const down = { find: () => ({ lean: () => Promise.reject(new Error("db down")) }) };
  const blind = createCampaignStore({
    models: { SoopCampaign: down, SoopGame: down, SoopTranslation: down },
  });
  assert.deepEqual(await blind.load(), { campaigns: 0, games: 0, translations: 0 });
  assert.deepEqual(blind.games(), []);
});

test("setGameName / setTranslation persist, apply to cached rows and survive a reload", async () => {
  const { store, saved } = harness();
  const KO = "알파 이벤트";
  const scan = scanner([raw("a", { title: KO }), raw("b")]);
  await store.list({ scan });

  await store.setTranslation(KO, "  Alpha Event ");
  await store.setGameName("9001", "Renamed");
  const [a] = await store.list({ scan });
  assert.equal(scan.calls, 1, "applied to the cache, no rescan");
  assert.equal(a.title, "Alpha Event");
  assert.equal(a.titleRaw, KO);
  assert.equal(a.gameName, "Renamed");
  assert.equal((await store.get("a")).title, "Alpha Event");
  assert.equal(store.games()[0].name, "Renamed");
  assert.equal((await SoopTranslation.findOne({ source: KO }).lean()).english, "Alpha Event");
  assert.equal((await SoopGame.findOne({ gameNo: "9001" }).lean()).name, "Renamed");
  await saved();

  const next = harness().store;
  assert.deepEqual(await next.load(), { campaigns: 2, games: 1, translations: 1 });
  const remembered = await next.get("a");
  assert.equal(remembered.filter, "unlisted");
  assert.equal(remembered.title, "Alpha Event");
  assert.equal(remembered.gameName, "Renamed");
  assert.equal((await next.list({ scan }))[0].title, "Alpha Event");

  // An empty value removes the override again.
  await next.setTranslation(KO, "");
  await next.setGameName("9001", "");
  assert.equal(await SoopTranslation.countDocuments({}), 0);
  assert.equal((await SoopGame.findOne({ gameNo: "9001" }).lean()).name, "");
  assert.notEqual((await next.get("a")).title, "Alpha Event");
  assert.equal((await next.get("a")).gameName, "Bravo");

  await assert.rejects(next.setGameName("", "x"), /gameNo/);
  await assert.rejects(next.setTranslation("   ", "x"), /source/);
});
