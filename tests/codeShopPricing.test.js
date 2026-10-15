// Code shop — automatic prices (utils/codeShop/pricing.js,
// docs/code-shop/03-MARKETS.md).
//
// A price change here is a live Eldorado offer changing price, so the rules
// that matter most are the ones that stop a change:
// - a fixed-price product (the default, and every adopted offer) is never
//   touched — the owner's price is the owner's;
// - the floor (and Eldorado's $0.50 minimum) always wins over a cut;
// - one change per cooldown window, and no call for a sub-cent difference;
// - GGSel prices are never changed;
// - a market error on one product never stops the others.
//
// decidePrice is pure and runs plain. run() runs against real Mongo
// (mongodb-memory-server) with an injected marketplace, so nothing here
// reaches a live market. All ids and prices are made up.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const CodeProduct = require("../models/CodeProduct");
const MarketplaceListing = require("../models/MarketplaceListing");
const { DEFAULTS, deepMerge } = require("../utils/codeShop/config");
const { decidePrice, createPricing } = require("../utils/codeShop/pricing");

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-15T12:00:00Z");
const STEPS = DEFAULTS.pricing.clearanceSteps; // 7d: 0 %, 3d: 25 %, 1d: 50 %

function pricing(extra = {}) {
  return { mode: "auto", priceUsd: 2, floorUsd: 0.5, clearance: false, followCompetitors: false, ...extra };
}

const decide = (product, lowestSameSetUsd = null, undercutUsd = 0.01) =>
  decidePrice({ product, now: NOW, steps: STEPS, undercutUsd, lowestSameSetUsd });

// --- decidePrice ------------------------------------------------------------

test("decidePrice: no clearance and no competitors is the base price", () => {
  assert.deepEqual(decide({ pricing: pricing(), useBy: new Date(NOW + 0.5 * DAY) }, 0.6), {
    priceUsd: 2,
    reasons: ["base price"],
  });
  // Switched on, but nothing to act on.
  assert.equal(decide({ pricing: pricing({ clearance: true, followCompetitors: true }), useBy: null }).priceUsd, 2);
});

test("decidePrice: clearance takes the tightest step the days left fall in", () => {
  const at = (days) => decide({ pricing: pricing({ clearance: true }), useBy: new Date(NOW + days * DAY) }).priceUsd;
  assert.equal(at(10), 2, "10 days: no step");
  assert.equal(at(5), 2, "5 days: the 7-day step, 0 %");
  assert.equal(at(2.5), 1.5, "2.5 days: the 3-day step, 25 %");
  assert.equal(at(0.5), 1, "0.5 days: the 1-day step, 50 %");
  assert.equal(at(-1), 1, "already past use-by: still the deepest step");
  const r = decide({ pricing: pricing({ clearance: true }), useBy: new Date(NOW + 2.5 * DAY) });
  assert.match(r.reasons[0], /clearance -25%/);
  // Steps given in any order; a broken step is ignored.
  const mixed = [{ days: 1, cutPct: 50 }, { days: "x", cutPct: 10 }, { days: 3, cutPct: 25 }, { days: 7, cutPct: 0 }];
  const r2 = decidePrice({ product: { pricing: pricing({ clearance: true }), useBy: NOW + 2 * DAY }, now: new Date(NOW), steps: mixed });
  assert.equal(r2.priceUsd, 1.5);
});

test("decidePrice: one undercut step under the cheapest same-set offer, never up", () => {
  const follow = { pricing: pricing({ followCompetitors: true }) };
  const r = decide(follow, 1.5);
  assert.equal(r.priceUsd, 1.49);
  assert.match(r.reasons[0], /cheapest same-set offer \(\$1\.50\)/);
  assert.equal(decide(follow, 2.5).priceUsd, 2, "a dearer competitor does not raise the price");
  assert.equal(decide(follow, 1.5, 0.05).priceUsd, 1.45);
  assert.equal(decide({ pricing: pricing() }, 1.5).priceUsd, 2, "followCompetitors off");
  // Clearance first, then the competitor only if it is lower still.
  const both = { pricing: pricing({ clearance: true, followCompetitors: true }), useBy: NOW + 2 * DAY };
  assert.equal(decide(both, 1.6).priceUsd, 1.5);
  assert.equal(decide(both, 1.2).priceUsd, 1.19);
});

test("decidePrice: the floor, and the $0.50 minimum, always win", () => {
  const r = decide({ pricing: pricing({ followCompetitors: true, floorUsd: 1.2 }) }, 0.8);
  assert.equal(r.priceUsd, 1.2);
  assert.match(r.reasons[r.reasons.length - 1], /floor \$1\.20/);
  assert.equal(decide({ pricing: pricing({ followCompetitors: true, floorUsd: 0.1 }) }, 0.3).priceUsd, 0.5);
  assert.equal(decide({ pricing: pricing({ followCompetitors: true, floorUsd: 0 }) }, 0.2).priceUsd, 0.5);
  const cheap = { pricing: pricing({ priceUsd: 0.8, clearance: true, floorUsd: 0.5 }), useBy: NOW + 0.5 * DAY };
  assert.equal(decide(cheap).priceUsd, 0.5, "50 % of $0.80 is under the minimum");
  // A floor above the base price lifts it.
  assert.equal(decide({ pricing: pricing({ priceUsd: 0.7, floorUsd: 0.9 }) }).priceUsd, 0.9);
  // A floor in fractions of a cent is never undercut by the rounding.
  assert.equal(decide({ pricing: pricing({ followCompetitors: true, floorUsd: 0.555 }) }, 0.3).priceUsd, 0.56);
});

test("decidePrice: cents are floored, never rounded up", () => {
  const at = (priceUsd, days) =>
    decide({ pricing: pricing({ priceUsd, clearance: true }), useBy: NOW + days * DAY }).priceUsd;
  assert.equal(at(1.99, 2), 1.49, "1.4925");
  assert.equal(at(1.2, 2), 0.9, "0.8999999… is still 0.90");
  assert.equal(decide({ pricing: pricing({ followCompetitors: true }) }, 1.2345).priceUsd, 1.22, "1.2245");
  assert.equal(decide({ pricing: pricing({ priceUsd: 1.239 }) }).priceUsd, 1.23);
});

test("decidePrice: no usable base price gives no price", () => {
  assert.equal(decide({ pricing: pricing({ priceUsd: 0 }) }).priceUsd, null);
  assert.equal(decide({ pricing: pricing({ priceUsd: "abc" }) }).priceUsd, null);
  assert.equal(decide({}).priceUsd, null);
});

// --- run (real Mongo, fake market) -------------------------------------------

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshoppricing"));
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

// run() looks at every active auto product, so each test starts empty.
test.beforeEach(async () => {
  if (mongoose.connection.readyState !== 1) return;
  await CodeProduct.deleteMany({});
  await MarketplaceListing.deleteMany({});
});

let seq = 0;

// A product plus its listings. `rows` = [{ market, price, status }].
async function productWith(extra = {}, rows = [{ market: "eldorado", price: 2 }]) {
  seq += 1;
  const offer = new mongoose.Types.ObjectId();
  const p = await CodeProduct.create({
    name: "Bundle " + seq,
    gameNo: "12",
    status: "active",
    offer,
    ...extra,
    pricing: pricing(extra.pricing),
  });
  // insertMany: no save hook, so no audit-log write racing the disconnect.
  const listed = await MarketplaceListing.insertMany(
    rows.map((r, i) => ({
      accountOffer: offer,
      marketplace: r.market,
      externalId: "ext-" + seq + "-" + i,
      price: r.price,
      status: r.status || "active",
    })),
  );
  return { product: p, rows: listed };
}

function harness({ fail = () => false, answer } = {}) {
  const calls = [];
  const logged = [];
  const pricingRun = createPricing({
    models: { CodeProduct, MarketplaceListing },
    now: () => NOW,
    config: { get: async () => deepMerge(DEFAULTS, {}) },
    events: { log: async (e) => (logged.push(e), true) },
    mp: () => ({
      eldoradoReprice: async (externalId, priceUsd) => {
        calls.push({ externalId, priceUsd });
        if (fail(externalId)) throw new Error("Eldorado reprice: HTTP 503");
        return answer ? answer(priceUsd) : priceUsd;
      },
      ggselReprice: async () => {
        throw new Error("GGSel must never be repriced here");
      },
    }),
  });
  return { pricing: pricingRun, calls, logged };
}

const nearUseBy = () => new Date(NOW + 2 * DAY); // inside the 25 % step

test("run: fixed-price and inactive products are never touched", async () => {
  const fixed = await productWith({ pricing: { mode: "fixed", clearance: true, followCompetitors: true }, useBy: nearUseBy() });
  const paused = await productWith({ status: "paused", pricing: { clearance: true }, useBy: nearUseBy() });
  const draft = await productWith({ status: "draft", pricing: { clearance: true }, useBy: nearUseBy() });
  const h = harness();
  const res = await h.pricing.run();
  assert.equal(res.checked, 0);
  assert.deepEqual(res.changed, []);
  assert.deepEqual(h.calls, []);
  for (const { product, rows } of [fixed, paused, draft]) {
    assert.equal((await MarketplaceListing.findById(rows[0]._id).lean()).price, 2);
    assert.equal((await CodeProduct.findById(product._id).lean()).pricing.lastChangeAt, null);
  }
});

test("run: a change is applied on Eldorado and recorded on the row and the product", async () => {
  const { product, rows } = await productWith({ pricing: { clearance: true }, useBy: nearUseBy() });
  const h = harness();
  const res = await h.pricing.run();
  assert.equal(res.checked, 1);
  assert.deepEqual(h.calls, [{ externalId: rows[0].externalId, priceUsd: 1.5 }]);
  assert.equal(res.changed.length, 1);
  assert.equal(String(res.changed[0].product), String(product._id));
  assert.equal(res.changed[0].from, 2);
  assert.equal(res.changed[0].to, 1.5);
  assert.match(res.changed[0].reasons[0], /clearance -25%/);

  assert.equal((await MarketplaceListing.findById(rows[0]._id).lean()).price, 1.5);
  const saved = await CodeProduct.findById(product._id).lean();
  assert.equal(saved.pricing.lastChangeAt.getTime(), NOW);
  assert.match(saved.pricing.lastReason, /clearance -25%/);
  assert.equal(saved.pricing.priceUsd, 2, "the base price is the owner's and stays");
  assert.ok(h.logged.some((e) => e.kind === "pricing" && e.level !== "warn" && /2\.00 -> \$1\.50/.test(e.msg)));
});

test("run: the amount Eldorado actually took is what is recorded", async () => {
  const { rows } = await productWith({ pricing: { clearance: true }, useBy: nearUseBy() });
  const h = harness({ answer: () => 1.55 });
  const res = await h.pricing.run();
  assert.equal(res.changed[0].to, 1.55);
  assert.equal((await MarketplaceListing.findById(rows[0]._id).lean()).price, 1.55);
});

test("run: the cooldown since the last change is respected", async () => {
  const recent = await productWith({
    pricing: { clearance: true, lastChangeAt: new Date(NOW - 2 * HOUR) },
    useBy: nearUseBy(),
  });
  const old = await productWith({
    pricing: { clearance: true, lastChangeAt: new Date(NOW - 7 * HOUR) },
    useBy: nearUseBy(),
  });
  const h = harness();
  const res = await h.pricing.run();
  assert.equal(res.checked, 2);
  assert.deepEqual(h.calls.map((c) => c.externalId), [old.rows[0].externalId]);
  assert.equal((await MarketplaceListing.findById(recent.rows[0]._id).lean()).price, 2);
  const kept = await CodeProduct.findById(recent.product._id).lean();
  assert.equal(kept.pricing.lastChangeAt.getTime(), NOW - 2 * HOUR);
});

test("run: a sub-cent difference is not a change", async () => {
  const { rows } = await productWith({ pricing: { clearance: true }, useBy: nearUseBy() }, [{ market: "eldorado", price: 1.505 }]);
  const same = await productWith({ pricing: {} }, [{ market: "eldorado", price: 2 }]);
  const h = harness();
  const res = await h.pricing.run();
  assert.equal(res.checked, 2);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(res.changed, []);
  assert.equal((await MarketplaceListing.findById(rows[0]._id).lean()).price, 1.505);
  assert.equal((await MarketplaceListing.findById(same.rows[0]._id).lean()).price, 2);
});

test("run: exactly one cent is a change (float noise is not a reason to skip)", async () => {
  // 1.15 - 1.14 is 0.00999… in floating point.
  const { rows } = await productWith({ pricing: { priceUsd: 1.14 } }, [{ market: "eldorado", price: 1.15 }]);
  const h = harness();
  await h.pricing.run();
  assert.deepEqual(h.calls, [{ externalId: rows[0].externalId, priceUsd: 1.14 }]);
});

test("run: GGSel listings are never repriced", async () => {
  const both = await productWith({ pricing: { clearance: true }, useBy: nearUseBy() }, [
    { market: "ggsel", price: 2 },
    { market: "eldorado", price: 2 },
  ]);
  const ggselOnly = await productWith({ pricing: { clearance: true }, useBy: nearUseBy() }, [{ market: "ggsel", price: 2 }]);
  const delisted = await productWith({ pricing: { clearance: true }, useBy: nearUseBy() }, [
    { market: "eldorado", price: 2, status: "delisted" },
  ]);
  const h = harness();
  const res = await h.pricing.run();
  assert.equal(res.checked, 3);
  assert.deepEqual(h.calls.map((c) => c.externalId), [both.rows[1].externalId]);
  assert.equal((await MarketplaceListing.findById(both.rows[0]._id).lean()).price, 2);
  assert.equal((await MarketplaceListing.findById(ggselOnly.rows[0]._id).lean()).price, 2);
  assert.equal((await MarketplaceListing.findById(delisted.rows[0]._id).lean()).price, 2);
  assert.equal((await CodeProduct.findById(ggselOnly.product._id).lean()).pricing.lastChangeAt, null);
});

test("run: a market error is a warning and the run goes on to the next product", async () => {
  const bad = await productWith({ pricing: { clearance: true }, useBy: nearUseBy() });
  const good = await productWith({ pricing: { clearance: true }, useBy: nearUseBy() });
  const h = harness({ fail: (id) => id === bad.rows[0].externalId });
  const res = await h.pricing.run();
  assert.equal(res.checked, 2);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(res.changed.map((c) => String(c.product)), [String(good.product._id)]);
  assert.equal(res.failed, 1);

  assert.equal((await MarketplaceListing.findById(bad.rows[0]._id).lean()).price, 2);
  assert.equal((await CodeProduct.findById(bad.product._id).lean()).pricing.lastChangeAt, null);
  assert.equal((await MarketplaceListing.findById(good.rows[0]._id).lean()).price, 1.5);

  const warn = h.logged.filter((e) => e.level === "warn");
  assert.equal(warn.length, 1);
  assert.equal(warn[0].kind, "pricing");
  assert.equal(String(warn[0].product), String(bad.product._id));
  assert.match(warn[0].msg, /HTTP 503/);
});

test("run: competitor data stored by the scan is followed", async () => {
  const { rows } = await productWith({
    pricing: { followCompetitors: true, floorUsd: 1 },
    competitors: { lowestSameSetUsd: 1.75, offers: [], scannedAt: new Date(NOW - 3600e3) },
  });
  const h = harness();
  const res = await h.pricing.run();
  assert.deepEqual(h.calls, [{ externalId: rows[0].externalId, priceUsd: 1.74 }]);
  assert.match(res.changed[0].reasons[0], /same-set/);
});

test("run: a competitor price from an old scan is not followed", async () => {
  await productWith({
    pricing: { followCompetitors: true, floorUsd: 1 },
    competitors: { lowestSameSetUsd: 1.75, offers: [], scannedAt: new Date(NOW - 25 * 3600e3) },
  });
  const h = harness();
  await h.pricing.run();
  assert.deepEqual(h.calls, []);
});

test("freshLowest: two scan intervals, then nothing", () => {
  const { freshLowest } = require("../utils/codeShop/pricing");
  const cfg = { competitorScan: { everyHours: 12 } };
  const p = (h) => ({ competitors: { lowestSameSetUsd: 2, scannedAt: new Date(NOW - h * 3600e3) } });
  assert.equal(freshLowest(p(24), NOW, cfg), 2);
  assert.equal(freshLowest(p(24.01), NOW, cfg), null);
  assert.equal(freshLowest({ competitors: { lowestSameSetUsd: 2 } }, NOW, cfg), null);
});
