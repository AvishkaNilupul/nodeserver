// The market radar's loader + cache (utils/marketData/report.js).
//   - every read is projected, limited and sorted on an indexed field; truncation is REPORTED;
//   - stale-while-revalidate: the first call waits, a fresh report is served from memory, a stale
//     one is served at once while exactly ONE rebuild runs; a failed rebuild never surfaces as an
//     unhandled rejection and never replaces the last good report.
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../utils/marketData/report");

function recordingModel(name, rows, calls) {
  return {
    find(filter, projection) {
      const call = { name, filter, projection, sort: null, limit: null };
      calls.push(call);
      const q = {
        sort(s) {
          call.sort = s;
          return q;
        },
        limit(n) {
          call.limit = n;
          return q;
        },
        lean: async () => rows(call),
      };
      return q;
    },
  };
}

test("the loader reads four collections, each projected, limited and (where sorted) on an indexed field", async () => {
  const calls = [];
  const models = {
    MarketSale: recordingModel("sale", () => [{ soldAt: new Date() }], calls),
    MarketRival: recordingModel("rival", () => [], calls),
    MarketplaceListing: recordingModel("own", () => [], calls),
    MarketResearch: recordingModel("research", () => [], calls),
  };
  const out = await R.loadFromDb({ models, now: Date.UTC(2026, 9, 10) });
  assert.deepStrictEqual(calls.map((c) => c.name).sort(), ["own", "research", "rival", "sale"]);
  for (const c of calls) {
    assert.ok(c.projection && Object.keys(c.projection).length, c.name + " is projected");
    assert.ok(c.limit > 0, c.name + " is limited");
  }
  const sale = calls.find((c) => c.name === "sale");
  assert.deepStrictEqual(sale.sort, { soldAt: -1 }, "sorted on the soldAt index");
  assert.ok(sale.filter.soldAt.$gte instanceof Date);
  const rival = calls.find((c) => c.name === "rival");
  assert.deepStrictEqual(rival.sort, { lastSeenAt: -1 }, "sorted on the lastSeenAt index");
  assert.deepStrictEqual(rival.projection.priceHistory, { $slice: -2 }, "only the last two price points come back");
  assert.strictEqual(calls.find((c) => c.name === "own").filter.status, "active");
  assert.deepStrictEqual(out.truncated, { sales: false, rivals: false, own: false });
});

test("a read that hits its limit is reported as truncated, not passed off as the whole market", async () => {
  const calls = [];
  const full = (n) => () => Array.from({ length: n }, () => ({}));
  const out = await R.loadFromDb({
    models: {
      MarketSale: recordingModel("sale", full(R.MAX_SALES), calls),
      MarketRival: recordingModel("rival", full(10), calls),
      MarketplaceListing: recordingModel("own", full(1), calls),
      MarketResearch: recordingModel("research", full(1), calls),
    },
  });
  assert.deepStrictEqual(out.truncated, { sales: true, rivals: false, own: false });
});

test("only 7, 30 and 90 day windows exist; anything else is 30", () => {
  for (const [v, w] of [[7, 7], ["30", 30], [90, 90], [1, 30], ["x", 30], [undefined, 30], [-7, 30]]) assert.strictEqual(R.windowOf(v), w, String(v));
});

const tick = () => new Promise((r) => setImmediate(r));
const emptyInput = () => ({ sales: [], rivals: [], ownListings: [], research: [], truncated: {} });

test("stale-while-revalidate: first call waits, fresh is cached, stale is served at once with ONE rebuild", async () => {
  R.invalidate();
  let loads = 0;
  let release;
  let gate = null;
  const loader = async () => {
    loads++;
    if (gate) await gate;
    return emptyInput();
  };
  const statusFn = () => ({ enabled: true });
  const a = await R.getReport({ loader, statusFn });
  assert.strictEqual(loads, 1);
  assert.deepStrictEqual(a.status, { enabled: true });
  const b = await R.getReport({ loader, statusFn });
  assert.strictEqual(b, a, "fresh: the same object, no load");
  assert.strictEqual(loads, 1);
  // make it stale
  const realNow = Date.now;
  Date.now = () => realNow() + R.TTL_MS + 1000;
  try {
    gate = new Promise((r) => (release = r));
    const c1 = await R.getReport({ loader, statusFn });
    const c2 = await R.getReport({ loader, statusFn });
    assert.strictEqual(c1, a, "the stale report is served immediately");
    assert.strictEqual(c2, a);
    assert.strictEqual(loads, 2, "one rebuild, not one per request");
    release();
    await tick();
    await tick();
    await tick();
  } finally {
    Date.now = realNow;
  }
  const d = await R.getReport({ loader, statusFn });
  assert.notStrictEqual(d, a, "the rebuilt report replaced it");
  assert.strictEqual(loads, 2);
  // a different window is its own report — built from the SAME database read
  const w7 = await R.getReport({ loader, statusFn, days: 7 });
  const w90 = await R.getReport({ loader, statusFn, days: 90 });
  assert.strictEqual(w7.windowDays, 7);
  assert.strictEqual(w90.windowDays, 90);
  assert.strictEqual(loads, 2, "one read serves every window");
});

test("force waits for a fresh build; a failing first build rejects; a failing background rebuild keeps the last good report", async () => {
  R.invalidate();
  const unhandled = [];
  const onU = (e) => unhandled.push(e);
  process.on("unhandledRejection", onU);
  try {
    let fail = true;
    const loader = async () => {
      if (fail) throw new Error("db down");
      return emptyInput();
    };
    await assert.rejects(() => R.getReport({ loader, statusFn: () => null }), /db down/);
    fail = false;
    const good = await R.getReport({ loader, statusFn: () => null });
    const forced = await R.getReport({ loader, statusFn: () => null, force: true });
    assert.notStrictEqual(forced, good, "force rebuilt");
    fail = true;
    const realNow = Date.now;
    Date.now = () => realNow() + R.TTL_MS + 1000;
    try {
      const stale = await R.getReport({ loader, statusFn: () => null });
      assert.strictEqual(stale, forced, "the last good report is still served");
      await tick();
      await tick();
      await tick();
    } finally {
      Date.now = realNow;
    }
    assert.deepStrictEqual(unhandled, [], "a failed background rebuild is not an unhandled rejection");
  } finally {
    process.off("unhandledRejection", onU);
  }
});
