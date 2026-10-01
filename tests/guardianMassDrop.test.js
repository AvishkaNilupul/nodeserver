// The guardian must not record a closeout or an outage as sales.
//
// On Plati and GGSel a sale is never announced: the pile of codes is simply smaller than
// the guardian left it, and feedListing reads that as "units sold". But codes also vanish
// for reasons that are not purchases. On 2026-09-28 the owner's "free Plati + GGSel"
// cleanup drained 3,290 GGSel codes while a pass was running, and the guardian recorded
// 236 units as SOLD in one hour (the audit log: 78 events, 77 listings / 233 units inside a
// single 5-minute pass, against a normal one listing and a few units). Those fake sales
// then inflated the farm engine's 45-day demand window and the price evidence.
//
// The guard collects what a pass infers and records it once the whole pass has been read:
//   1. a listing that is no longer active by then cannot have sold the codes that vanished
//      (and is set aside BEFORE the marketplace is judged);
//   2. one marketplace showing sales on `rows`+ listings or `units`+ units in one pass, or
//      `windowRows`+ / `windowUnits`+ across the last hour, is a closeout or an outage
//      (nothing from it is recorded; a finding, a Telegram alert, a log line and an audit
//      event say so, and none of those can stall or fail the pass);
//   3. settings autoFarm.saleOutageGuard.enabled:false restores record-as-you-read exactly.
//
// Driven through the REAL guardian module and its real runOnce / feedOne, with the models,
// the marketplaces and the ledger stubbed (the same harness shape as
// tests/guardianSuppliedTopUp.test.js), so the wiring itself is what is under test.
// GUARDIAN_PATH lets the same file be pointed at a patched copy of another checkout.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const realSaleLearning = require("../utils/saleLearning");

// A query result that is also "thenable" and chainable, resolving to an empty list: the
// stand-in for every model call the integrity checks make that these tests do not care about.
function emptyQuery(value = []) {
  const q = {
    then: (res, rej) => Promise.resolve(value).then(res, rej),
    catch: (rej) => Promise.resolve(value).catch(rej),
    lean: () => q,
    sort: () => q,
    limit: () => q,
    skip: () => q,
    select: () => q,
    populate: () => q,
  };
  return q;
}
function emptyModel(overrides = {}) {
  return new Proxy(overrides, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === "countDocuments") return async () => 0;
      if (prop === "then") return undefined;
      return () => emptyQuery();
    },
  });
}

function makeRow(i, over = {}) {
  return {
    _id: "row-" + i,
    marketplace: "ggsel",
    externalId: "ext-" + i,
    title: "Alpha Twitch Drops (" + i + ")",
    set: "set-1",
    price: 1.25,
    qtyTarget: 2,
    lastStock: 3,
    status: "active",
    autoDeliver: true,
    accountId: "",
    accountLogin: "",
    ...over,
  };
}

function loadGuardian({ rows = [], stock = {}, autoFarm = {}, onRead = null } = {}) {
  const world = {
    rows,
    stock: { ...stock },
    recorded: [],
    findings: [],
    telegrams: [],
    telegramFails: false,
    telegramHangs: false,
    events: [],
    eventsThrow: false,
    eventsReject: false,
    statusReads: 0,
    statusReadFailures: 0,
    updates: [],
    order: [],
    logs: [],
    errors: [],
    autoFarm,
  };

  const fakeMp = {
    async ggselOfferStockDetailed(id) {
      world.order.push("read:" + id);
      if (onRead) await onRead(id, world);
      return { stock: world.stock[id], reason: "" };
    },
    async digisellerProductStockDetailed(id) {
      world.order.push("read:" + id);
      if (onRead) await onRead(id, world);
      return { stock: world.stock[id], reason: "" };
    },
    async ggselFinalizeStock() {
      return { stock: 0, reactivated: false, pending: false };
    },
  };

  const fakeListing = {
    find(query) {
      let out = [];
      let fail = null;
      if (query && query._id && query._id.$in) {
        // The guard's own "which of these are still active NOW" read.
        world.statusReads += 1;
        if (world.statusReadFailures > 0) {
          world.statusReadFailures -= 1;
          fail = new Error("status read down");
        }
        const ids = new Set(query._id.$in.map(String));
        out = world.rows.filter((r) => ids.has(String(r._id))).map((r) => ({ _id: r._id, status: r.status }));
      } else if (query && query.status === "active" && query.autoDeliver === true) {
        out = world.rows.filter((r) => r.status === "active" && r.autoDeliver === true).map((r) => ({ ...r }));
      }
      const q = emptyQuery(out);
      q.lean = async () => {
        if (fail) throw fail;
        return out;
      };
      return q;
    },
    findOne(query) {
      const r = world.rows.find((x) => x._id === query._id && x.status === (query.status || x.status));
      return { lean: async () => (r ? { ...r } : null) };
    },
    async updateOne(filter, update) {
      world.updates.push({ filter, update });
      const r = world.rows.find((x) => x._id === filter._id);
      if (r && update.$set) Object.assign(r, update.$set);
      return { modifiedCount: 1 };
    },
    async countDocuments() {
      return 0;
    },
  };

  const knownKeys = new Set();
  const fakeFinding = emptyModel({
    async findOneAndUpdate(query, update) {
      world.findings.push({
        dedupeKey: query.dedupeKey,
        type: update.$set && update.$set.type,
        severity: update.$set && update.$set.severity,
        marketplace: update.$set && update.$set.marketplace,
        message: update.$set && update.$set.message,
      });
      // The first time a key is seen it is CREATED; afterwards it is a known open row.
      if (knownKeys.has(query.dedupeKey)) return { lastErrorObject: {}, value: { status: "open" } };
      knownKeys.add(query.dedupeKey);
      return { lastErrorObject: { upserted: true }, value: null };
    },
    async updateMany() {
      return { modifiedCount: 0 };
    },
    async updateOne() {
      return { modifiedCount: 0 };
    },
    async create(doc) {
      return doc;
    },
  });

  const fakeDropSet = emptyModel({
    findById(id) {
      return { lean: async () => ({ _id: id, name: "Set", items: [{ itemKey: "k1", game: "Alpha", qty: 1 }] }) };
    },
  });

  const stubs = new Map([
    [require.resolve("../utils/marketplaces"), fakeMp],
    [require.resolve("../utils/ggselFulfiller"), { GG_CLAIM_TAG: "ggsel", async claimAccountsForSet() { return []; }, async releaseAccounts() {} }],
    [require.resolve("../models/AuditFinding"), fakeFinding],
    [require.resolve("../models/MarketplaceListing"), fakeListing],
    [require.resolve("../models/DropLog"), emptyModel()],
    // The integrity checks load their accounts here; the marker shows WHEN they start.
    [
      require.resolve("../models/BotAccount"),
      emptyModel({
        find() {
          world.order.push("checks");
          return emptyQuery();
        },
      }),
    ],
    [require.resolve("../models/DropSet"), fakeDropSet],
    [
      require.resolve("../utils/telegram"),
      {
        sendTelegram: async (m) => {
          // A connection that never answers: telegram.js sets no request timeout.
          if (world.telegramHangs) await new Promise(() => {});
          if (world.telegramFails) throw new Error("telegram down");
          world.telegrams.push(String(m));
        },
      },
    ],
    [require.resolve("../utils/guardianAutoHeal"), { healOpenFindings: async () => null }],
    [require.resolve("../utils/settings"), { getAutoFarm: () => world.autoFarm }],
    [
      require.resolve("../utils/systemLog"),
      {
        logEvent: (e) => {
          if (world.eventsThrow) throw new Error("audit down");
          if (world.eventsReject) return Promise.reject(new Error("audit rejected"));
          world.events.push(e);
          return Promise.resolve();
        },
      },
    ],
    [
      require.resolve("../utils/saleLearning"),
      {
        ...realSaleLearning,
        async recordListingSale(a) {
          world.order.push("record:" + a.listing.externalId);
          world.recorded.push({ id: a.listing._id, externalId: a.listing.externalId, units: a.units, price: a.priceUsd });
          return a.units;
        },
      },
    ],
  ]);

  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    try {
      const resolved = Module._resolveFilename(request, parent, isMain);
      if (stubs.has(resolved)) return stubs.get(resolved);
    } catch {
      /* fall through to the real loader */
    }
    return origLoad.apply(this, arguments);
  };
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a) => world.logs.push(a.join(" "));
  console.error = (...a) => world.errors.push(a.join(" "));

  const guardianPath = require.resolve(process.env.GUARDIAN_PATH || "../utils/marketplaceGuardian");
  delete require.cache[guardianPath];
  const guardian = require(guardianPath);
  const restore = () => {
    Module._load = origLoad;
    console.log = realLog;
    console.error = realErr;
    delete require.cache[guardianPath];
  };
  return { guardian, world, restore };
}

// `n` GGSel rows each of which lost `lost` units since the last pass (stock 3 -> 3-lost).
function lossWorld(n, lost = 1, over = {}, market = "ggsel") {
  const rows = [];
  const stock = {};
  for (let i = 1; i <= n; i += 1) {
    rows.push(makeRow(i, { marketplace: market, lastStock: 3, ...over }));
    stock["ext-" + i] = 3 - lost;
  }
  return { rows, stock };
}

// `n` rows on one marketplace under their own ids, all fully stocked (nothing sold yet).
function marketRows(market, prefix, n, stockLevel = 3) {
  const rows = [];
  const stock = {};
  for (let i = 1; i <= n; i += 1) {
    const row = makeRow(i, { marketplace: market, _id: prefix + "-row-" + i, externalId: prefix + "-ext-" + i, lastStock: stockLevel });
    rows.push(row);
    stock[row.externalId] = stockLevel;
  }
  return { rows, stock };
}

// The notifyPass digest and the guard's alert run un-awaited at the end of a pass.
const tick = () => new Promise((r) => setImmediate(r));
async function settle() {
  for (let i = 0; i < 4; i += 1) await tick();
}

// Freeze Date.now so the hour a finding is keyed on, and the one-hour window, are exact.
function withClock(startMs) {
  const real = Date.now;
  const clock = {
    set(ms) {
      startMs = ms;
    },
    advance(ms) {
      startMs += ms;
    },
    restore() {
      Date.now = real;
    },
  };
  Date.now = () => startMs;
  return clock;
}

const alertsOf = (world) => world.telegrams.filter((t) => t.startsWith("🚨 GUARDIAN"));
const massFindings = (world) => world.findings.filter((f) => f.type === "mass-stock-drop");
// Everyone's stock drops one more unit (the same drain, one pass later).
function drainOneMore(world) {
  for (const r of world.rows) world.stock[r.externalId] = r.lastStock - 1;
}
const MIN = 60 * 1000;

/* ------------------------------ the guard itself ----------------------------- */

test("a normal sale is still recorded — after the whole pass has been read", async () => {
  const w = lossWorld(3, 0);
  w.stock["ext-2"] = 2; // one unit sold on row 2 only
  const { guardian, world, restore } = loadGuardian(w);
  try {
    const run = await guardian.runOnce();
    assert.deepStrictEqual(world.recorded.map((r) => [r.externalId, r.units, r.price]), [["ext-2", 1, 1.25]]);
    // Collected while reading, recorded only once every row has been read.
    const lastRead = world.order.map((x, i) => (x.startsWith("read:") ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    assert.ok(world.order.indexOf("record:ext-2") > lastRead, "no record before the last read: " + world.order.join(","));
    assert.deepStrictEqual(run.sales, { recorded: 1, droppedInactive: 0, droppedMass: 0, failed: 0, tripped: [] });
    assert.strictEqual(guardian.status().lastRun.sales.recorded, 1, "the pass summary carries it");
    assert.ok(world.logs.some((l) => /guardian: ggsel listing ext-2 sold 1 unit\(s\) since the last pass/.test(l)));
    // The baseline moved, exactly as before.
    assert.strictEqual(world.rows.find((r) => r._id === "row-2").lastStock, 2);
  } finally {
    restore();
  }
});

test("a pass with nothing sold records nothing and raises nothing", async () => {
  const { guardian, world, restore } = loadGuardian(lossWorld(6, 0));
  try {
    await guardian.runOnce();
    await settle();
    assert.strictEqual(world.recorded.length, 0);
    assert.strictEqual(massFindings(world).length, 0);
    assert.strictEqual(alertsOf(world).length, 0);
  } finally {
    restore();
  }
});

test("THE 09-28 EVENT: a marketplace-wide drop is not recorded as sales, and says so loudly", async () => {
  // 77 listings, 3 units each: stock 3 -> 0 on every one while the owner's cleanup drained the codes.
  const { guardian, world, restore } = loadGuardian(lossWorld(77, 3));
  try {
    const run = await guardian.runOnce();
    await settle();
    assert.strictEqual(world.recorded.length, 0, "not one fake sale recorded");
    assert.deepStrictEqual(run.sales.tripped, [{ marketplace: "ggsel", scope: "pass", rows: 77, units: 231 }]);
    assert.strictEqual(run.sales.droppedMass, 77);
    const f = massFindings(world)[0];
    assert.ok(f, "a finding is raised");
    assert.strictEqual(f.severity, "high");
    assert.strictEqual(f.marketplace, "ggsel");
    assert.match(f.dedupeKey, /^mass-stock-drop:ggsel:\d{4}-\d\d-\d\dT\d\d$/);
    assert.match(f.message, /77 listing\(s\) lost 231 unit\(s\) of stock in ONE guardian pass/);
    assert.match(f.message, /NOT recorded as sales/);
    assert.match(f.message, /saleOutageGuard/, "it says how to override it");
    // It reaches the owner as its OWN message ...
    const alerts = alertsOf(world);
    assert.strictEqual(alerts.length, 1);
    assert.match(alerts[0], /77 listing\(s\) lost 231 unit\(s\)/);
    // ... because in a real closeout every drained listing also raises a restock finding, and
    // the pass's digest shows five of them: the guard's finding would never be read there.
    const digest = world.telegrams.find((t) => t.startsWith("⚠️ GUARDIAN found"));
    assert.ok(digest, "the pass's digest was sent");
    assert.match(digest, /…and \d+ more/, "the digest is swamped");
    assert.ok(!digest.includes("lost 231 unit"), "so the guard's line is not in it");
    // ... the log, and the audit trail.
    assert.ok(world.errors.some((l) => /77 listing\(s\) lost 231/.test(l)));
    const ev = world.events.find((e) => e.action === "mass_stock_drop_ignored");
    assert.ok(ev && ev.subject === "ggsel" && ev.count === 231 && ev.meta.rows === 77 && ev.meta.scope === "pass");
    assert.strictEqual(ev.severity, "warn", "a SystemEvent severity is info / warn / error");
    assert.strictEqual(ev.meta.listingIds.length, 50, "bounded");
    // Every baseline moved, so the SAME drop is not read as a sale again next pass.
    assert.ok(world.rows.every((r) => r.lastStock === 0));
    world.recorded.length = 0;
    const again = await guardian.runOnce();
    assert.strictEqual(world.recorded.length, 0);
    assert.strictEqual(again.sales.droppedMass, 0, "nothing left to drop on the next pass");
  } finally {
    restore();
  }
});

test("thresholds: 4 listings / 11 units is still demand; 5 listings or 12 units is not", async () => {
  const cases = [
    { n: 4, lost: 1, trips: false }, // 4 rows, 4 units
    { n: 4, lost: 2, trips: false }, // 4 rows, 8 units
    { n: 5, lost: 1, trips: true }, // 5 rows
    { n: 3, lost: 3, trips: false }, // 3 rows, 9 units (a small real closeout is still recorded: documented limit)
    { n: 2, lost: 6, trips: true, rowsOk: true }, // 2 rows, 12 units
  ];
  for (const c of cases) {
    const w = lossWorld(c.n, Math.min(c.lost, 3));
    if (c.lost > 3) for (const r of w.rows) { r.lastStock = c.lost; w.stock[r.externalId] = 0; }
    const { guardian, world, restore } = loadGuardian(w);
    try {
      await guardian.runOnce();
      assert.strictEqual(world.recorded.length > 0, !c.trips, JSON.stringify(c));
      assert.strictEqual(massFindings(world).length > 0, c.trips, JSON.stringify(c));
    } finally {
      restore();
    }
  }
});

test("evaluateMassDrop is exact at the boundaries, in the pass and in the hour, and never trips when switched off", () => {
  const { guardian, restore } = loadGuardian();
  try {
    const it = (n, u, off = 0) => Array.from({ length: n }, (_, i) => ({ row: { _id: "r" + (off + i) }, units: u }));
    const rec = (n, u, off = 100) => Array.from({ length: n }, (_, i) => ({ id: "r" + (off + i), units: u }));
    const d = guardian.MASS_DROP_DEFAULTS;
    assert.deepStrictEqual(d, { enabled: true, rows: 5, units: 12, windowRows: 8, windowUnits: 20 });
    assert.strictEqual(guardian.MASS_DROP_WINDOW_MS, 60 * 60 * 1000);
    // one pass
    assert.strictEqual(guardian.evaluateMassDrop(it(4, 2), d).tripped, false);
    assert.deepStrictEqual(guardian.evaluateMassDrop(it(5, 1), d), { tripped: true, scope: "pass", rows: 5, units: 5 });
    assert.strictEqual(guardian.evaluateMassDrop(it(2, 5), d).tripped, false);
    assert.strictEqual(guardian.evaluateMassDrop(it(2, 6), d).tripped, true);
    assert.strictEqual(guardian.evaluateMassDrop(it(1, 11), d).tripped, false);
    assert.strictEqual(guardian.evaluateMassDrop(it(1, 12), d).tripped, true);
    assert.strictEqual(guardian.evaluateMassDrop(it(200, 9), { ...d, enabled: false }, rec(50, 9)).tripped, false);
    assert.deepStrictEqual(guardian.evaluateMassDrop([], d), { tripped: false, scope: "", rows: 0, units: 0 });
    // the hour: distinct listings (7 seen + 1 new = 8) ...
    assert.deepStrictEqual(guardian.evaluateMassDrop(it(1, 1), d, rec(7, 1)), { tripped: true, scope: "window", rows: 8, units: 8 });
    assert.strictEqual(guardian.evaluateMassDrop(it(1, 1), d, rec(6, 1)).tripped, false, "6 seen + 1 new = 7");
    // ... a listing seen before is not counted twice
    assert.strictEqual(guardian.evaluateMassDrop([{ row: { _id: "r100" }, units: 1 }], d, rec(7, 1)).tripped, false);
    // ... and units (19 seen + 1 new = 20)
    assert.deepStrictEqual(guardian.evaluateMassDrop(it(1, 1), d, rec(2, 9.5)), { tripped: true, scope: "window", rows: 3, units: 20 });
    assert.strictEqual(guardian.evaluateMassDrop(it(1, 1), d, [{ id: "x", units: 18 }]).tripped, false, "19 units");
    // the pass limit wins the label when both apply
    assert.strictEqual(guardian.evaluateMassDrop(it(5, 1), d, rec(7, 1)).scope, "pass");
    // pure: it neither mutates nor needs its inputs
    const items = Object.freeze(it(2, 1).map(Object.freeze));
    const seen = Object.freeze(rec(2, 1).map(Object.freeze));
    assert.strictEqual(guardian.evaluateMassDrop(items, d, seen).tripped, false);
    assert.strictEqual(guardian.evaluateMassDrop(items, d).tripped, false, "recent is optional");
  } finally {
    restore();
  }
});

test("a listing delisted while the pass was still reading is not a sale", async () => {
  // The owner's script delists row 1 and drains its codes while the pass is mid-way.
  const w = lossWorld(3, 1);
  const { guardian, world, restore } = loadGuardian({
    ...w,
    onRead: async (id, wd) => {
      if (id === "ext-2") wd.rows.find((r) => r._id === "row-1").status = "delisted";
    },
  });
  try {
    const run = await guardian.runOnce();
    assert.deepStrictEqual(world.recorded.map((r) => r.externalId).sort(), ["ext-2", "ext-3"], "row 1 was delisted: not recorded");
    assert.strictEqual(run.sales.droppedInactive, 1);
    assert.ok(world.logs.some((l) => /ext-1 is no longer active/.test(l)));
    assert.strictEqual(world.rows.find((r) => r._id === "row-1").lastStock, 2, "its baseline still moved");
  } finally {
    restore();
  }
});

test("rows delisted mid-pass are set aside BEFORE the marketplace is judged: a real sale beside them is kept", async () => {
  // Seven rows lose a unit; the owner's script delists six of them while the pass is still
  // reading. Seven vanished units would look like a closeout; one of them is a live sale.
  const w = lossWorld(7, 1);
  const { guardian, world, restore } = loadGuardian({
    ...w,
    onRead: async (id, wd) => {
      if (id === "ext-7") for (let i = 1; i <= 6; i += 1) wd.rows.find((r) => r._id === "row-" + i).status = "delisted";
    },
  });
  try {
    const run = await guardian.runOnce();
    await settle();
    assert.deepStrictEqual(world.recorded.map((r) => r.externalId), ["ext-7"], "the live sale is recorded");
    assert.strictEqual(run.sales.droppedInactive, 6);
    assert.deepStrictEqual(run.sales.tripped, [], "six delisted rows are not a mass drop");
    assert.strictEqual(massFindings(world).length, 0);
    assert.strictEqual(alertsOf(world).length, 0, "and no false alarm");
  } finally {
    restore();
  }
});

test("rows set aside as inactive are not counted toward the hour either", async () => {
  const { guardian, world, restore } = loadGuardian({ rows: [], stock: {} });
  try {
    const gone = Array.from({ length: 6 }, (_, i) => ({ row: makeRow(i + 1, { status: "delisted" }), supplied: false, units: 1 }));
    world.rows.push(...gone.map((p) => p.row));
    const live = Array.from({ length: 3 }, (_, i) => ({ row: makeRow(i + 11), supplied: false, units: 1 }));
    world.rows.push(...live.map((p) => p.row));
    const cfg = guardian.massDropConfig();
    const T = Date.UTC(2026, 9, 2, 12, 0, 0);
    const a = await guardian.flushPendingSales(gone, cfg, T);
    assert.strictEqual(a.droppedInactive, 6);
    // 6 (inactive) + 3 (live) would be 9 >= the hourly 8 if the inactive ones had been remembered.
    const b = await guardian.flushPendingSales(live, cfg, T + MIN);
    assert.strictEqual(b.recorded, 3);
    assert.deepStrictEqual(b.tripped, []);
  } finally {
    restore();
  }
});

test("each marketplace is judged on its own: a Digiseller closeout does not silence a real GGSel sale", async () => {
  const dig = lossWorld(6, 1, {}, "digiseller");
  const gg = lossWorld(1, 1, {}, "ggsel");
  const rows = [...dig.rows.map((r) => ({ ...r, _id: "d-" + r._id, externalId: "d-" + r.externalId })), ...gg.rows.map((r) => ({ ...r, _id: "g-" + r._id, externalId: "g-" + r.externalId }))];
  const stock = {};
  for (const r of dig.rows) stock["d-" + r.externalId] = 2;
  stock["g-ext-1"] = 2;
  const { guardian, world, restore } = loadGuardian({ rows, stock });
  try {
    const run = await guardian.runOnce();
    assert.deepStrictEqual(world.recorded.map((r) => r.externalId), ["g-ext-1"]);
    assert.deepStrictEqual(run.sales.tripped.map((t) => t.marketplace), ["digiseller"]);
    assert.strictEqual(massFindings(world)[0].marketplace, "digiseller");
  } finally {
    restore();
  }
});

test("the kill switch (saleOutageGuard.enabled:false) restores record-as-you-read exactly", async () => {
  const { guardian, world, restore } = loadGuardian({ ...lossWorld(6, 1), autoFarm: { saleOutageGuard: { enabled: false } } });
  try {
    const run = await guardian.runOnce();
    assert.strictEqual(world.recorded.length, 6, "all six recorded, as the old code did");
    assert.strictEqual(run.sales, null, "no flush happened");
    assert.strictEqual(massFindings(world).length, 0);
    // Recorded while reading: the first record comes before the last read.
    const firstRecord = world.order.findIndex((x) => x.startsWith("record:"));
    const lastRead = world.order.map((x, i) => (x.startsWith("read:") ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    assert.ok(firstRecord < lastRead);
    assert.strictEqual(world.statusReads, 0, "and no extra database read");
  } finally {
    restore();
  }
});

test("the kill switch accepts the ways a person writes 'off'; anything else leaves the guard on", async () => {
  const recordedWith = async (guard) => {
    const g = loadGuardian({ ...lossWorld(6, 1), autoFarm: { saleOutageGuard: guard } });
    try {
      await g.guardian.runOnce();
      return g.world.recorded.length;
    } finally {
      g.restore();
    }
  };
  const off = [false, 0, "0", "false", "FALSE", " off ", "No", "disabled", { enabled: false }, { enabled: 0 }, { enabled: "0" }, { enabled: "false" }, { enabled: " Off " }, { enabled: "disabled" }];
  for (const v of off) assert.strictEqual(await recordedWith(v), 6, "off: " + JSON.stringify(v));
  const on = [undefined, null, true, 1, "yes", "on", "garbage", [], {}, { enabled: true }, { enabled: 1 }, { enabled: "true" }, { enabled: null }, { enabled: undefined }, { enabled: "" }];
  for (const v of on) assert.strictEqual(await recordedWith(v), 0, "on: " + JSON.stringify(v));
});

test("thresholds can be tuned in settings; nonsense falls back to the defaults", async () => {
  const run = async (guard) => {
    const lw = lossWorld(6, 1);
    const g = loadGuardian({ ...lw, autoFarm: { saleOutageGuard: guard } });
    try {
      await g.guardian.runOnce();
      return g.world.recorded.length;
    } finally {
      g.restore();
    }
  };
  assert.strictEqual(await run({ rows: 8 }), 6, "raised to 8 rows: six listings are demand");
  assert.strictEqual(await run({ rows: 3 }), 0, "lowered to 3 rows: six listings trip");
  assert.strictEqual(await run({ rows: 1, units: 0 }), 0, "a threshold below 2 is ignored -> defaults (six listings trip)");
  assert.strictEqual(await run("garbage"), 0, "garbage -> defaults");
  assert.strictEqual(await run(null), 0);
});

test("the config parser: defaults, hourly limits tunable, never below 2, never tighter than the pass", () => {
  const { guardian, world, restore } = loadGuardian();
  try {
    const set = (g) => {
      world.autoFarm = { saleOutageGuard: g };
      return guardian.massDropConfig();
    };
    assert.deepStrictEqual(set(undefined), { enabled: true, rows: 5, units: 12, windowRows: 8, windowUnits: 20 });
    assert.deepStrictEqual(set({ windowRows: 20, windowUnits: 50 }), { enabled: true, rows: 5, units: 12, windowRows: 20, windowUnits: 50 });
    assert.strictEqual(set({ rows: 10 }).windowRows, 10, "the hour cannot be tighter than the pass");
    assert.strictEqual(set({ units: 30 }).windowUnits, 30);
    assert.strictEqual(set({ rows: 9, windowRows: 4 }).windowRows, 9, "an hourly limit below the pass limit is raised to it");
    assert.strictEqual(set({ rows: 3 }).windowRows, 8, "lowering the pass limit leaves the hourly default alone");
    assert.strictEqual(set({ windowRows: 1, windowUnits: 0 }).windowRows, 8, "below 2 is ignored");
    assert.strictEqual(set({ windowRows: 1, windowUnits: 0 }).windowUnits, 20);
    assert.strictEqual(set({ windowRows: "x", windowUnits: null }).windowRows, 8);
    assert.strictEqual(set({ rows: "7" }).rows, 7, "a number typed as text still counts");
    assert.strictEqual(set({ rows: 6.9 }).rows, 6);
    assert.strictEqual(set({ rows: Infinity }).rows, 5);
    assert.strictEqual(set(false).enabled, false);
    assert.strictEqual(set({ enabled: "off", rows: 7 }).rows, 7, "off keeps the rest of the settings readable");
    // the settings module itself failing must never fail a pass: defaults, guard on
    world.autoFarm = null;
    assert.deepStrictEqual(guardian.massDropConfig(), { enabled: true, rows: 5, units: 12, windowRows: 8, windowUnits: 20 });
  } finally {
    restore();
  }
});

test("a threshold below 2 can never be configured: it would drop an ordinary sale", async () => {
  const recordedWith = async (guard, n = 2) => {
    const g = loadGuardian({ ...lossWorld(n, 1), autoFarm: { saleOutageGuard: guard } });
    try {
      await g.guardian.runOnce();
      return g.world.recorded.length;
    } finally {
      g.restore();
    }
  };
  // Two ordinary one-unit sales, well under the defaults (5 listings / 12 units):
  assert.strictEqual(await recordedWith({}), 2);
  assert.strictEqual(await recordedWith({ rows: 1 }), 2, "rows:1 is ignored, not honoured");
  assert.strictEqual(await recordedWith({ rows: 0 }), 2);
  assert.strictEqual(await recordedWith({ rows: -3 }), 2);
  assert.strictEqual(await recordedWith({ units: 1 }), 2, "units:1 is ignored, not honoured");
  assert.strictEqual(await recordedWith({ units: 0 }), 2);
  assert.strictEqual(await recordedWith({ windowRows: 1 }), 2, "windowRows:1 is ignored too");
  assert.strictEqual(await recordedWith({ windowUnits: 1 }), 2, "windowUnits:1 is ignored too");
  // The smallest legitimate setting really does trip:
  assert.strictEqual(await recordedWith({ rows: 2 }), 0);
  assert.strictEqual(await recordedWith({ units: 2 }), 0);
});

test("feedOne (one retried listing) still records at once, exactly as before", async () => {
  const w = lossWorld(1, 1);
  const { guardian, world, restore } = loadGuardian(w);
  try {
    await guardian.feedOne("row-1");
    assert.deepStrictEqual(world.recorded.map((r) => [r.externalId, r.units]), [["ext-1", 1]]);
    assert.strictEqual(world.statusReads, 0);
  } finally {
    restore();
  }
});

test("one failing sale record cannot stop the rest of the pass", async () => {
  const w = lossWorld(3, 1);
  const { guardian, world, restore } = loadGuardian(w);
  try {
    // Make the second record throw by breaking its DropSet lookup (as a DB error would).
    let calls = 0;
    const DropSet = require("../models/DropSet");
    const origFind = DropSet.findById;
    DropSet.findById = (id) => ({
      lean: async () => {
        calls += 1;
        if (calls === 2) throw new Error("db hiccup");
        return { _id: id, items: [{ itemKey: "k", game: "Alpha", qty: 1 }] };
      },
    });
    try {
      const run = await guardian.runOnce();
      assert.deepStrictEqual(world.recorded.map((r) => r.externalId), ["ext-1", "ext-3"]);
      assert.strictEqual(run.sales.recorded, 2);
      assert.strictEqual(run.sales.failed, 1);
      assert.ok(world.errors.some((e) => /guardian sale record error: db hiccup/.test(e)));
    } finally {
      DropSet.findById = origFind;
    }
  } finally {
    restore();
  }
});

test("an account-listing (supplied) row is logged, never recorded, and still counts toward a mass drop", async () => {
  const rows = [];
  const stock = {};
  for (let i = 1; i <= 2; i += 1) {
    rows.push(makeRow(i, { accountOffer: "offer-" + i, set: null }));
    stock["ext-" + i] = 2;
  }
  const first = loadGuardian({ rows, stock });
  try {
    // feedListing on a supplied row reaches the supplied layer for its top-up; this pass only
    // proves the sale bookkeeping, so call the flush directly with what the pass would collect.
    const pending = rows.map((r) => ({ row: r, supplied: true, units: 1 }));
    const out = await first.guardian.flushPendingSales(pending, first.guardian.MASS_DROP_DEFAULTS);
    assert.strictEqual(out.recorded, 2);
    assert.strictEqual(first.world.recorded.length, 0, "an offer-backed row has no DropSet to learn against");
    assert.strictEqual(first.world.logs.filter((l) => /sold 1 unit\(s\) since the last pass/.test(l)).length, 2);
  } finally {
    first.restore();
  }
  // The rows are live listings, so they are registered with the world like any other.
  const many = Array.from({ length: 5 }, (_, i) => ({ row: makeRow(i + 1, { accountOffer: "o", set: null }), supplied: true, units: 1 }));
  const second = loadGuardian({ rows: many.map((p) => p.row), stock: {} });
  try {
    const out = await second.guardian.flushPendingSales(many, second.guardian.MASS_DROP_DEFAULTS);
    assert.deepStrictEqual(out.tripped, [{ marketplace: "ggsel", scope: "pass", rows: 5, units: 5 }]);
    assert.strictEqual(out.droppedInactive, 0);
  } finally {
    second.restore();
  }
});

test("the guard changes nothing about WHICH sales a normal pass records, or how many calls it makes", async () => {
  // Same world, guard on and guard off: the recorded sales are identical.
  const build = () => {
    const w = lossWorld(4, 0);
    w.stock["ext-1"] = 2; // 1 unit
    w.stock["ext-3"] = 0; // 3 units
    return w;
  };
  const on = loadGuardian(build());
  let a;
  let readsOn;
  try {
    await on.guardian.runOnce();
    a = on.world.recorded.map((r) => [r.externalId, r.units, r.price]).sort();
    readsOn = on.world.order.filter((x) => x.startsWith("read:")).length;
  } finally {
    on.restore();
  }
  const off = loadGuardian({ ...build(), autoFarm: { saleOutageGuard: { enabled: false } } });
  let b;
  let readsOff;
  try {
    await off.guardian.runOnce();
    b = off.world.recorded.map((r) => [r.externalId, r.units, r.price]).sort();
    readsOff = off.world.order.filter((x) => x.startsWith("read:")).length;
  } finally {
    off.restore();
  }
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.length, 2);
  assert.strictEqual(readsOn, readsOff, "no extra marketplace read");
  assert.strictEqual(readsOn, 4);
});

test("the sales are settled before the integrity checks run", async () => {
  const w = lossWorld(3, 0);
  w.stock["ext-2"] = 2;
  w.rows.forEach((r, i) => {
    r.accountId = "acc-" + i; // so runChecks loads its accounts (the marker)
  });
  const { guardian, world, restore } = loadGuardian(w);
  try {
    await guardian.runOnce();
    const checks = world.order.indexOf("checks");
    assert.ok(checks >= 0, "the integrity checks ran: " + world.order.join(","));
    assert.ok(world.order.indexOf("record:ext-2") >= 0 && world.order.indexOf("record:ext-2") < checks, "recorded before the checks: " + world.order.join(","));
  } finally {
    restore();
  }
});

test("a repeating event is ONE finding and ONE alert per marketplace per hour; a new hour is a new alert", async () => {
  const clock = withClock(Date.UTC(2026, 9, 2, 12, 5, 0));
  const { guardian, world, restore } = loadGuardian(lossWorld(6, 1));
  try {
    await guardian.runOnce();
    await settle();
    assert.deepStrictEqual(massFindings(world).map((f) => f.dedupeKey), ["mass-stock-drop:ggsel:2026-10-02T12"]);
    assert.strictEqual(alertsOf(world).length, 1);
    // 12:35 — the same drain goes on: the same key (one finding row), no second alert.
    clock.set(Date.UTC(2026, 9, 2, 12, 35, 0));
    drainOneMore(world);
    await guardian.runOnce();
    await settle();
    assert.deepStrictEqual(
      massFindings(world).map((f) => f.dedupeKey),
      ["mass-stock-drop:ggsel:2026-10-02T12", "mass-stock-drop:ggsel:2026-10-02T12"],
      "re-seen under the same key",
    );
    assert.strictEqual(alertsOf(world).length, 1, "no repeat inside the hour");
    // 13:05 — a new hour is a new finding and a new alert.
    clock.set(Date.UTC(2026, 9, 2, 13, 5, 0));
    drainOneMore(world);
    await guardian.runOnce();
    await settle();
    assert.strictEqual(massFindings(world)[2].dedupeKey, "mass-stock-drop:ggsel:2026-10-02T13");
    assert.strictEqual(alertsOf(world).length, 2);
    assert.strictEqual(world.recorded.length, 0, "and through all of it nothing was recorded");
  } finally {
    clock.restore();
    restore();
  }
});

test("a Telegram failure never changes the decision", async () => {
  const { guardian, world, restore } = loadGuardian(lossWorld(6, 1));
  try {
    world.telegramFails = true;
    const run = await guardian.runOnce();
    await settle();
    assert.ok(world.errors.some((e) => /guardian mass-drop notify error: telegram down/.test(e)));
    assert.strictEqual(world.recorded.length, 0);
    assert.strictEqual(run.sales.droppedMass, 6);
    assert.ok(massFindings(world).length === 1, "the finding is still raised");
    assert.ok(world.events.some((e) => e.action === "mass_stock_drop_ignored"), "and the audit line still written");
  } finally {
    restore();
  }
});

test("a HUNG Telegram connection cannot freeze the guardian pass", async () => {
  const { guardian, world, restore } = loadGuardian(lossWorld(6, 1));
  let timer;
  try {
    world.telegramHangs = true; // telegram.js has no request timeout: this never answers
    const watchdog = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("the guardian pass is stuck waiting for Telegram")), 4000);
    });
    const run = await Promise.race([guardian.runOnce(), watchdog]);
    assert.strictEqual(run.sales.droppedMass, 6);
    assert.strictEqual(world.recorded.length, 0);
    assert.strictEqual(massFindings(world).length, 1);
    assert.ok(world.events.some((e) => e.action === "mass_stock_drop_ignored"));
    assert.ok(run.openFindings >= 0 && run.tookMs >= 0, "the pass ran to its end (summary built)");
  } finally {
    clearTimeout(timer);
    restore();
  }
});

test("every step of the report is independent: no single failure costs the alert, the audit line, or the pass", async () => {
  const clock = withClock(Date.UTC(2026, 9, 2, 12, 5, 0));
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  const g = loadGuardian(lossWorld(6, 1));
  const AuditFinding = require("../models/AuditFinding");
  const orig = AuditFinding.findOneAndUpdate;
  try {
    // 1. the findings store is down: the alert and the audit line still go out ...
    AuditFinding.findOneAndUpdate = async () => {
      throw new Error("findings store down");
    };
    const run = await g.guardian.runOnce();
    await settle();
    assert.strictEqual(run.sales.droppedMass, 6, "still dropped");
    assert.ok(g.world.errors.some((e) => /guardian mass-drop finding error: findings store down/.test(e)));
    assert.strictEqual(alertsOf(g.world).length, 1, "alerted although the store could not say whether it was new");
    assert.ok(g.world.events.some((e) => e.action === "mass_stock_drop_ignored"));
    // ... and a store that stays down cannot turn one event into one alert per pass.
    clock.set(Date.UTC(2026, 9, 2, 12, 35, 0));
    drainOneMore(g.world);
    await g.guardian.runOnce();
    await settle();
    assert.strictEqual(alertsOf(g.world).length, 1, "same hour, store still down: no repeat");
    clock.set(Date.UTC(2026, 9, 2, 13, 5, 0));
    drainOneMore(g.world);
    await g.guardian.runOnce();
    await settle();
    assert.strictEqual(alertsOf(g.world).length, 2, "a new hour alerts again");
    AuditFinding.findOneAndUpdate = orig;

    // 2. the audit log throws, then rejects: nothing else is affected and nothing is unhandled.
    for (const mode of ["eventsThrow", "eventsReject"]) {
      const h = loadGuardian(lossWorld(6, 1));
      try {
        h.world[mode] = true;
        const r = await h.guardian.runOnce();
        await settle();
        assert.strictEqual(r.sales.droppedMass, 6, mode);
        assert.strictEqual(alertsOf(h.world).length, 1, mode + ": the alert still went out");
        assert.strictEqual(massFindings(h.world).length, 1, mode + ": the finding still exists");
      } finally {
        h.restore();
      }
    }
    assert.deepStrictEqual(unhandled, [], "no unhandled rejection from the guard");
  } finally {
    AuditFinding.findOneAndUpdate = orig;
    process.off("unhandledRejection", onUnhandled);
    clock.restore();
    g.restore();
  }
});

test("a failed status read is retried once; if it still fails every row counts as active and the breaker still decides", async () => {
  // One failure: the retry succeeds and the delisted row is still recognised.
  const a = loadGuardian({
    ...lossWorld(2, 1),
    onRead: async (id, wd) => {
      if (id === "ext-2") wd.rows.find((r) => r._id === "row-1").status = "delisted";
    },
  });
  try {
    a.world.statusReadFailures = 1;
    const run = await a.guardian.runOnce();
    assert.strictEqual(a.world.statusReads, 2, "read, failed, read again");
    assert.deepStrictEqual(a.world.recorded.map((r) => r.externalId), ["ext-2"]);
    assert.strictEqual(run.sales.droppedInactive, 1);
    assert.strictEqual(a.world.errors.filter((e) => /guardian sale status check error: status read down/.test(e)).length, 1);
  } finally {
    a.restore();
  }
  // Two failures: unknown -> fail open. Two ordinary sales are still recorded (not lost) ...
  const b = loadGuardian(lossWorld(2, 1));
  try {
    b.world.statusReadFailures = 2;
    const run = await b.guardian.runOnce();
    assert.strictEqual(b.world.statusReads, 2, "exactly one retry");
    assert.strictEqual(b.world.recorded.length, 2);
    assert.strictEqual(run.sales.recorded, 2);
  } finally {
    b.restore();
  }
  // ... and a mass drop is STILL stopped, because the breaker does not depend on the status read.
  const c = loadGuardian(lossWorld(6, 1));
  try {
    c.world.statusReadFailures = 2;
    const run = await c.guardian.runOnce();
    assert.strictEqual(c.world.recorded.length, 0);
    assert.strictEqual(run.sales.droppedMass, 6);
  } finally {
    c.restore();
  }
});

test("the default configuration is what a bare flushPendingSales uses", async () => {
  const rows4 = Array.from({ length: 4 }, (_, i) => makeRow(i + 1));
  const a = loadGuardian({ rows: rows4, stock: {} });
  try {
    const out = await a.guardian.flushPendingSales(rows4.map((r) => ({ row: r, supplied: false, units: 1 })));
    assert.strictEqual(out.recorded, 4);
    assert.deepStrictEqual(out.tripped, []);
  } finally {
    a.restore();
  }
  const rows5 = Array.from({ length: 5 }, (_, i) => makeRow(i + 1));
  const b = loadGuardian({ rows: rows5, stock: {} });
  try {
    const out = await b.guardian.flushPendingSales(rows5.map((r) => ({ row: r, supplied: false, units: 1 })));
    assert.strictEqual(out.recorded, 0);
    assert.deepStrictEqual(out.tripped, [{ marketplace: "ggsel", scope: "pass", rows: 5, units: 5 }]);
  } finally {
    b.restore();
  }
});

/* ----------------------- the hour: a drain that outlasts a pass ----------------------- */

test("a slow drain, a few listings per pass, is caught by the hourly window", async () => {
  const clock = withClock(Date.UTC(2026, 9, 2, 12, 0, 0));
  const w = lossWorld(12, 0); // 12 stocked rows, nothing sold yet
  const { guardian, world, restore } = loadGuardian(w);
  const drain = (from, to) => {
    for (let i = from; i <= to; i += 1) world.stock["ext-" + i] = 2;
  };
  try {
    // pass 1 (12:05): rows 1-4 lose a unit. 4 listings: ordinary demand.
    clock.advance(5 * MIN);
    drain(1, 4);
    let run = await guardian.runOnce();
    await settle();
    assert.strictEqual(world.recorded.length, 4);
    assert.deepStrictEqual(run.sales.tripped, []);
    // pass 2 (12:10): rows 5-8 lose a unit. Alone, still only 4 — but 8 listings inside the hour.
    clock.advance(5 * MIN);
    drain(5, 8);
    run = await guardian.runOnce();
    await settle();
    assert.strictEqual(world.recorded.length, 4, "pass 2 is not recorded");
    assert.deepStrictEqual(run.sales.tripped, [{ marketplace: "ggsel", scope: "window", rows: 8, units: 8 }]);
    const f = massFindings(world)[0];
    assert.match(f.message, /8 listing\(s\) lost 8 unit\(s\) of stock within the last hour/);
    assert.strictEqual(alertsOf(world).length, 1);
    // pass 3 (12:15): rows 9-12. The drain is remembered even though pass 2 was not recorded.
    clock.advance(5 * MIN);
    drain(9, 12);
    run = await guardian.runOnce();
    await settle();
    assert.strictEqual(world.recorded.length, 4, "a drain that keeps going stays suppressed");
    assert.strictEqual(run.sales.tripped[0].scope, "window");
    assert.strictEqual(run.sales.tripped[0].rows, 12);
    // The drain stops. More than an hour after its last drop the window is empty again:
    // an ordinary sale is recorded normally.
    clock.advance(61 * MIN);
    world.stock["ext-1"] = 1;
    run = await guardian.runOnce();
    await settle();
    assert.deepStrictEqual(run.sales.tripped, []);
    assert.deepStrictEqual(world.recorded.map((r) => r.externalId), ["ext-1", "ext-2", "ext-3", "ext-4", "ext-1"]);
  } finally {
    clock.restore();
    restore();
  }
});

test("the hour is exact: a drop 59 minutes old still counts, one 60 minutes old does not", async () => {
  const run = async (gapMinutes) => {
    const rows = Array.from({ length: 8 }, (_, i) => makeRow(i + 1));
    const { guardian, restore } = loadGuardian({ rows, stock: {} });
    try {
      const cfg = guardian.massDropConfig();
      const T = Date.UTC(2026, 9, 2, 12, 0, 0);
      const pend = (list) => list.map((r) => ({ row: r, supplied: false, units: 1 }));
      const first = await guardian.flushPendingSales(pend(rows.slice(0, 4)), cfg, T);
      const second = await guardian.flushPendingSales(pend(rows.slice(4)), cfg, T + gapMinutes * MIN);
      return { first, second };
    } finally {
      restore();
    }
  };
  const inside = await run(59);
  assert.strictEqual(inside.first.recorded, 4);
  assert.strictEqual(inside.second.droppedMass, 4, "59 minutes later the first four still count: 8 listings in the hour");
  assert.strictEqual(inside.second.tripped[0].scope, "window");
  const outside = await run(60);
  assert.strictEqual(outside.second.recorded, 4, "60 minutes later they have aged out");
  assert.deepStrictEqual(outside.second.tripped, []);
});

test("the hour is kept per marketplace", async () => {
  const clock = withClock(Date.UTC(2026, 9, 2, 12, 0, 0));
  const dig = marketRows("digiseller", "d", 8);
  const gg = marketRows("ggsel", "g", 2);
  const { guardian, world, restore } = loadGuardian({ rows: [...dig.rows, ...gg.rows], stock: { ...dig.stock, ...gg.stock } });
  try {
    // pass 1: Digiseller rows 1-4 sell one unit each
    clock.advance(5 * MIN);
    for (let i = 1; i <= 4; i += 1) world.stock["d-ext-" + i] = 2;
    await guardian.runOnce();
    await settle();
    assert.strictEqual(world.recorded.length, 4);
    // pass 2: Digiseller rows 5-8 (8 inside the hour -> suppressed) and one GGSel sale (its own hour)
    clock.advance(5 * MIN);
    for (let i = 5; i <= 8; i += 1) world.stock["d-ext-" + i] = 2;
    world.stock["g-ext-1"] = 2;
    const run = await guardian.runOnce();
    await settle();
    assert.deepStrictEqual(run.sales.tripped.map((t) => [t.marketplace, t.scope]), [["digiseller", "window"]]);
    assert.deepStrictEqual(world.recorded.map((r) => r.externalId).slice(4), ["g-ext-1"], "the GGSel sale is recorded");
  } finally {
    clock.restore();
    restore();
  }
});

test("one listing selling again and again is one listing, not many: the hour counts distinct listings", async () => {
  const clock = withClock(Date.UTC(2026, 9, 2, 12, 0, 0));
  const { guardian, world, restore } = loadGuardian({ rows: [makeRow(1, { lastStock: 10, qtyTarget: 1 })], stock: { "ext-1": 10 } });
  try {
    for (let n = 1; n <= 6; n += 1) {
      clock.advance(5 * MIN);
      world.stock["ext-1"] = 10 - n; // one more unit each pass: 6 passes, 6 units, ONE listing
      const run = await guardian.runOnce();
      await settle();
      assert.deepStrictEqual(run.sales.tripped, [], "pass " + n);
    }
    assert.strictEqual(world.recorded.length, 6);
    assert.strictEqual(massFindings(world).length, 0);
  } finally {
    clock.restore();
    restore();
  }
});

test("the hour also counts units: one big listing selling fast trips it", async () => {
  const clock = withClock(Date.UTC(2026, 9, 2, 12, 0, 0));
  const { guardian, world, restore } = loadGuardian({ rows: [makeRow(1, { lastStock: 40, qtyTarget: 1 })], stock: { "ext-1": 40 } });
  try {
    const stocks = [33, 26, 19]; // 7 units a pass: 7, then 14 in the hour, then 21
    const trips = [];
    for (const s of stocks) {
      clock.advance(5 * MIN);
      world.stock["ext-1"] = s;
      const run = await guardian.runOnce();
      await settle();
      trips.push(run.sales.tripped.map((t) => t.scope));
    }
    assert.deepStrictEqual(trips, [[], [], ["window"]]);
    assert.strictEqual(world.recorded.length, 2);
  } finally {
    clock.restore();
    restore();
  }
});

/* ------------------- the shape production really has, and a report that throws ------------------- */

test("production rows carry ObjectId ids: nothing is mistaken for inactive, and the ids reach the audit trail as text", async () => {
  const { Types } = require("mongoose");
  const mk = (n, lost) => {
    const rows = Array.from({ length: n }, (_, i) => makeRow(i + 1, { _id: new Types.ObjectId(), lastStock: 3 }));
    const stock = {};
    for (const r of rows) stock[r.externalId] = 3 - lost;
    return { rows, stock };
  };
  // Two ordinary sales: recorded, none wrongly set aside as "no longer active".
  const a = loadGuardian(mk(2, 1));
  try {
    const run = await a.guardian.runOnce();
    assert.strictEqual(run.sales.recorded, 2);
    assert.strictEqual(run.sales.droppedInactive, 0, "an ObjectId must compare equal to itself");
    assert.strictEqual(a.world.recorded.length, 2);
  } finally {
    a.restore();
  }
  // A delisted one among them IS recognised.
  const w = mk(3, 1);
  const b = loadGuardian({
    ...w,
    onRead: async (id, wd) => {
      if (id === "ext-3") wd.rows[0].status = "delisted";
    },
  });
  try {
    const run = await b.guardian.runOnce();
    assert.strictEqual(run.sales.droppedInactive, 1);
    assert.strictEqual(b.world.recorded.length, 2);
  } finally {
    b.restore();
  }
  // A mass drop reports plain 24-character ids, and the hour remembers them as the same listing.
  const c = loadGuardian(mk(6, 1));
  try {
    await c.guardian.runOnce();
    await settle();
    const ev = c.world.events.find((e) => e.action === "mass_stock_drop_ignored");
    assert.ok(ev.meta.listingIds.every((id) => typeof id === "string" && /^[0-9a-f]{24}$/.test(id)));
  } finally {
    c.restore();
  }
});

test("whatever goes wrong while REPORTING, the flush still finishes and says what it dropped", async () => {
  const rows = Array.from({ length: 6 }, (_, i) => makeRow(i + 1));
  const { guardian, world, restore } = loadGuardian({ rows, stock: {} });
  try {
    // An invalid clock makes the report itself throw (it keys the finding on the hour).
    const out = await guardian.flushPendingSales(rows.map((r) => ({ row: r, supplied: false, units: 1 })), guardian.massDropConfig(), NaN);
    assert.strictEqual(out.droppedMass, 6);
    assert.strictEqual(out.recorded, 0, "and nothing was recorded");
    assert.strictEqual(out.tripped.length, 1);
    assert.ok(world.errors.some((e) => /guardian mass-drop report error: Invalid time value/.test(e)), world.errors.join(" | "));
  } finally {
    restore();
  }
});
