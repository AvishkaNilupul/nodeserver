// Plati (Digiseller) off switch + the blocked-seller read pause (2026-09-28).
//
// The Plati seller account has been blocked since about 2026-09-14
// ("продавец товара заблокирован"): nothing listed there can be bought. Two
// costs followed, both measured on prod:
//  - the guardian re-read every live Plati product on every pass and each
//    refusal logged a line — 8,153 of the last 20,000 error-log lines;
//  - every automatic lister kept splitting accounts onto Plati: 52 of the 100
//    no-claim shelf slots, and 7 new auto-farm Plati products in one week.
// These tests pin the fix: a blocked seller costs one log line per pause and no
// requests inside it, the pause lifts on its own, and no automatic lister puts
// new stock on Plati while the owner's switch is off or the seller is blocked.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

const BLOCKED = { data: { retval: 2, retdesc: "продавец товара заблокирован" } };
const NOT_FOUND = { data: { retval: 1, retdesc: "запрашиваемый вами товар не найден" } };
const IN_STOCK = (n) => ({ data: { retval: 0, product: { num_in_stock: n } } });

// A fresh utils/marketplaces.js with axios and settings stubbed. No keys are
// configured, so the token call throws and every stock read takes the public
// path — which is all these tests need.
function loadMarketplaces({ answer, autoFarm = {} }) {
  const reads = [];
  const stubAxios = {
    get: async (url) => {
      reads.push(url);
      return answer(url);
    },
    post: async () => {
      throw new Error("no network in tests");
    },
    patch: async () => ({ data: {} }),
    put: async () => ({ data: {} }),
    delete: async () => ({ data: {} }),
    create: () => stubAxios,
    defaults: { headers: {} },
    interceptors: { request: { use() {} }, response: { use() {} } },
  };
  const stubSettings = {
    loadSettings: () => ({ autoFarm }),
    saveSettings: () => {},
    getAutoFarm: () => autoFarm,
    getUnclaimedPricing: () => ({}),
  };
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const fromMp = parent && /marketplaces\.js$/.test(parent.filename || "");
    if (request === "axios") return stubAxios;
    if (fromMp && request === "./settings") {
      return { ...realLoad.call(this, request, parent, isMain), ...stubSettings };
    }
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    const path = require.resolve("../utils/marketplaces");
    delete require.cache[path];
    const mod = require("../utils/marketplaces");
    delete require.cache[path];
    return { mod, reads };
  } finally {
    Module._load = realLoad;
  }
}

// Collect console.error lines while fn runs.
async function capturingErrors(fn) {
  const lines = [];
  const real = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.error = real;
  }
  return lines;
}

// Run fn with Date.now pinned to `at`.
async function at(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

const T0 = Date.UTC(2026, 8, 28, 15, 0, 0);
const MIN = 60 * 1000;

test("a blocked seller costs one request and one log line, not one per product", async () => {
  const { mod, reads } = loadMarketplaces({ answer: () => BLOCKED });
  const results = [];
  const lines = await capturingErrors(() =>
    at(T0, async () => {
      for (let i = 0; i < 50; i++) results.push(await mod.digisellerProductStockDetailed(6000000 + i));
    }),
  );
  assert.strictEqual(reads.length, 1, "only the first read goes out; the rest wait out the pause");
  assert.strictEqual(lines.length, 1, "one line for the whole pause: " + JSON.stringify(lines));
  assert.match(lines[0], /seller account blocked/);
  assert.match(lines[0], /pausing Plati product reads for 30 min/);
  for (const r of results) {
    assert.strictEqual(r.stock, null, "stock stays unknown — callers behave as before");
    // The guardian's market-wide refusal finding keys off this text.
    assert.match(r.reason, /заблокирован/);
  }
  const st = mod.digisellerBlockState(T0);
  assert.strictEqual(st.blocked, true);
  assert.strictEqual(st.paused, true);
  assert.strictEqual(st.skipped, 49);
});

test("reads already in flight when the block is seen log nothing extra", async () => {
  const { mod, reads } = loadMarketplaces({ answer: () => BLOCKED });
  const lines = await capturingErrors(() =>
    at(T0, () => Promise.all([1, 2, 3, 4].map((i) => mod.digisellerProductStockDetailed(i)))),
  );
  assert.strictEqual(reads.length, 4, "all four were already on the wire");
  assert.strictEqual(lines.length, 1, "but the block is announced once: " + JSON.stringify(lines));
});

test("the pause lifts on its own: one probe per window, and a good read clears it", async () => {
  let answer = BLOCKED;
  const { mod, reads } = loadMarketplaces({ answer: () => answer });
  await capturingErrors(() => at(T0, () => mod.digisellerProductStockDetailed(1)));
  await capturingErrors(() => at(T0 + 10 * MIN, () => mod.digisellerProductStockDetailed(2)));
  assert.strictEqual(reads.length, 1, "10 minutes in: still paused");

  // 31 minutes in: one real read, still blocked — re-armed, one line.
  const again = await capturingErrors(() => at(T0 + 31 * MIN, () => mod.digisellerProductStockDetailed(3)));
  assert.strictEqual(reads.length, 2, "the window ended, so one probe went out");
  assert.strictEqual(again.length, 1);
  assert.match(again[0], /still blocked/);
  assert.match(again[0], /1 reads skipped in the last pause/);

  // The seller is unblocked: the next probe succeeds and clears everything.
  answer = IN_STOCK(3);
  const back = await capturingErrors(() =>
    at(T0 + 62 * MIN, async () => {
      const r = await mod.digisellerProductStockDetailed(4);
      assert.strictEqual(r.stock, 3);
    }),
  );
  assert.strictEqual(back.length, 1);
  assert.match(back[0], /product reads work again/);
  assert.strictEqual(mod.digisellerBlockState().blocked, false);
  assert.strictEqual(mod.digisellerTakesNewStock(), true, "Plati takes stock again");
});

test("one deleted product is that product's problem, never a blocked market", async () => {
  const { mod, reads } = loadMarketplaces({ answer: () => NOT_FOUND });
  const lines = await capturingErrors(async () => {
    await mod.digisellerProductStockDetailed(1);
    await mod.digisellerProductStockDetailed(2);
  });
  assert.strictEqual(reads.length, 2, "no pause: each product is read");
  assert.strictEqual(lines.length, 2, "each unreadable product still logs its own line");
  assert.match(lines[0], /stock unreadable for product 1/);
  assert.strictEqual(mod.digisellerBlockState().blocked, false);
  assert.strictEqual(mod.digisellerTakesNewStock(), true);
});

test("digisellerTakesNewStock: the owner's switch, and the block, each say no", async () => {
  const on = loadMarketplaces({ answer: () => IN_STOCK(1), autoFarm: {} }).mod;
  assert.strictEqual(on.digisellerTakesNewStock(), true, "unset = on (the default)");

  const off = loadMarketplaces({ answer: () => IN_STOCK(1), autoFarm: { platiEnabled: false } }).mod;
  assert.strictEqual(off.digisellerTakesNewStock(), false, "switched off by the owner");

  const blocked = loadMarketplaces({ answer: () => BLOCKED, autoFarm: { platiEnabled: true } }).mod;
  await capturingErrors(() => blocked.digisellerProductStockDetailed(1));
  assert.strictEqual(blocked.digisellerTakesNewStock(), false, "blocked beats the switch");
});

// ---------------------------------------------------------------------------
// The listers: load the real module with settings/marketplaces stubbed.
// ---------------------------------------------------------------------------

function loadWith(modulePath, stubsByRequest) {
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubsByRequest, request)) {
      const s = stubsByRequest[request];
      return typeof s === "function" ? s(realLoad.call(this, request, parent, isMain)) : s;
    }
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    const path = require.resolve(modulePath);
    delete require.cache[path];
    const mod = require(modulePath);
    delete require.cache[path];
    return mod;
  } finally {
    Module._load = realLoad;
  }
}

function engineWith({ autoFarm, takes }) {
  return loadWith("../utils/unclaimedAutoList", {
    "./settings": (real) => ({ ...real, getAutoFarm: () => autoFarm, gameMarketsFor: () => null }),
    "./marketplaces": (real) => ({
      ...real,
      ggselResolveCategoryId: async () => "",
      ...(takes === undefined ? { digisellerTakesNewStock: undefined } : { digisellerTakesNewStock: () => takes }),
    }),
  });
}

test("no-claim auto-lister: Plati is offered only while it can take stock", async () => {
  const base = { platiCategoryId: "34187", ggselCategoryId: "" };
  const cases = [
    [{ ...base }, true, ["gameflip", "digiseller"], "switch on, seller fine"],
    [{ ...base, platiEnabled: false }, true, ["gameflip"], "owner switched Plati off"],
    [{ ...base, platiEnabled: true }, false, ["gameflip"], "seller blocked"],
    [{ ...base, platiEnabled: false }, undefined, ["gameflip"], "switch honoured even without the block check"],
  ];
  for (const [autoFarm, takes, want, why] of cases) {
    const engine = engineWith({ autoFarm, takes });
    const { markets } = await engine.enabledMarketsForGame("Call of Duty: Black Ops 7");
    assert.deepStrictEqual(markets, want, why);
  }
});

test("auto-farm lister: platiTakesNewStock and the reason a listing got no Plati share", () => {
  const lister = (takes) =>
    loadWith("../utils/autoLister", {
      "./marketplaces": (real) => ({ ...real, digisellerTakesNewStock: () => takes }),
    });
  const ok = lister(true);
  assert.strictEqual(ok.platiTakesNewStock({ platiCategoryId: "34187" }), true);
  assert.strictEqual(ok.platiTakesNewStock({ platiCategoryId: "34187", platiEnabled: false }), false);
  assert.strictEqual(ok.platiTakesNewStock({ platiCategoryId: "" }), false);
  assert.match(ok.platiOffReason({ platiCategoryId: "34187", platiEnabled: false }), /switched off/);
  assert.match(ok.platiOffReason({ platiCategoryId: "" }), /no Plati category id/);

  const blocked = lister(false);
  assert.strictEqual(blocked.platiTakesNewStock({ platiCategoryId: "34187" }), false);
  assert.match(blocked.platiOffReason({ platiCategoryId: "34187" }), /blocked/);
});

// ---------------------------------------------------------------------------
// The guardian's auto-feed: reads (and books sales) as before, feeds nothing.
// ---------------------------------------------------------------------------

function loadGuardian({ takes }) {
  const world = { claims: 0, added: [], stockReads: 0, lastStock: [] };
  const row = {
    _id: "listing-plati-1",
    marketplace: "digiseller",
    externalId: "6100001",
    qtyTarget: 4,
    lastStock: 2, // equal to the read below: no sale inferred
    set: "set-1",
    status: "active",
    autoDeliver: true,
  };
  const fakeMp = {
    async digisellerProductStockDetailed() {
      world.stockReads++;
      return { stock: 2, reason: "" };
    },
    async digisellerAddContent(externalId, codes) {
      world.added.push({ externalId, codes });
      return { contentIds: codes.map((_, i) => String(9000 + i)) };
    },
    async digisellerProductStock() {
      return 2;
    },
    digisellerTakesNewStock: () => takes,
  };
  const fakeDs = {
    DS_CLAIM_TAG: "digiseller",
    async claimAccountsForSet(set, need) {
      world.claims++;
      return Array.from({ length: need }, (_, i) => ({
        accountId: "acc-" + (i + 1),
        login: "farmed" + (i + 1),
        code: "Login: farmed" + (i + 1),
      }));
    },
    async releaseAccounts() {},
  };
  const stubs = new Map([
    [require.resolve("../utils/marketplaces"), fakeMp],
    [require.resolve("../utils/digisellerFulfiller"), fakeDs],
    [
      require.resolve("../models/AuditFinding"),
      {
        async findOneAndUpdate() {
          return { lastErrorObject: { upserted: true }, value: null };
        },
        async updateMany() {
          return { modifiedCount: 0 };
        },
        async updateOne() {
          return { modifiedCount: 0 };
        },
        async create(d) {
          return d;
        },
        async countDocuments() {
          return 0;
        },
      },
    ],
    [
      require.resolve("../models/MarketplaceListing"),
      {
        findOne() {
          return { lean: async () => row };
        },
        async updateOne(q, u) {
          if (u && u.$set && "lastStock" in u.$set) world.lastStock.push(u.$set.lastStock);
          return { modifiedCount: 1 };
        },
        find() {
          const r = { lean: async () => [row] };
          r.limit = () => r;
          return r;
        },
      },
    ],
    [
      require.resolve("../models/DropSet"),
      {
        findById() {
          return { lean: async () => ({ _id: "set-1", items: [] }) };
        },
        find() {
          return { lean: async () => [] };
        },
      },
    ],
    [
      require.resolve("../models/DropLog"),
      {
        async distinct() {
          return [];
        },
        find() {
          return { lean: async () => [] };
        },
      },
    ],
    [require.resolve("../utils/telegram"), { sendTelegram: async () => {} }],
    [require.resolve("../utils/guardianAutoHeal"), { healOpenFindings: async () => null }],
  ]);
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    try {
      const resolved = Module._resolveFilename(request, parent, isMain);
      if (stubs.has(resolved)) return stubs.get(resolved);
    } catch {
      /* fall through */
    }
    return realLoad.apply(this, arguments);
  };
  const path = require.resolve("../utils/marketplaceGuardian");
  delete require.cache[path];
  const guardian = require(path);
  const restore = () => {
    Module._load = realLoad;
    delete require.cache[path];
  };
  return { guardian, world, restore, row };
}

test("guardian: Plati off → the stock is still read, but no account is fed", async () => {
  const { guardian, world, restore, row } = loadGuardian({ takes: false });
  let fed;
  try {
    fed = await guardian.feedOne(row._id);
  } finally {
    restore();
  }
  assert.strictEqual(fed, 0, "nothing fed");
  assert.strictEqual(world.stockReads, 1, "the read still runs — it is what books a sale");
  assert.deepStrictEqual(world.lastStock, [2], "and the sale baseline is still kept");
  assert.strictEqual(world.claims, 0, "no account is claimed for a product nobody can buy");
  assert.strictEqual(world.added.length, 0, "no delivery code is added");
});

test("guardian: Plati on → the same row is topped up as before", async () => {
  const { guardian, world, restore, row } = loadGuardian({ takes: true });
  let fed;
  try {
    fed = await guardian.feedOne(row._id);
  } finally {
    restore();
  }
  assert.strictEqual(fed, 2, "two units below target, two fed");
  assert.strictEqual(world.claims, 1);
  assert.strictEqual(world.added.length, 1);
  assert.strictEqual(world.added[0].codes.length, 2);
});
