// Code shop scheduler (docs/code-shop/04-OPS.md, service.js).
//
// The scheduler runs inside the live server next to the marketplace
// fulfillers, so these tests pin what keeps it harmless there: steps run in
// the contract's order and one failing step never stops the rest, two ticks
// never overlap (nor a manual step and a tick), CODE_SHOP=0 really is off,
// the hourly / per-product gates hold, and only the products the contract
// names are published, approved or scanned.
//
// Every module is a fake injected through `overrides.modules` (or a factory
// through `overrides.factories`); models are tiny in-memory fakes; timers are
// fakes fired by hand, so nothing waits on a real clock. All values are made up.
process.env.CRED_SECRET ||= "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const serviceModule = require("../utils/codeShop/service");
const { createService, STEPS } = serviceModule;
const { DEFAULTS, deepMerge } = require("../utils/codeShop/config");
const { OFFER_LIMIT_MSG } = require("../utils/codeShop/publish");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-10-15T12:00:00Z");

const ORDER = [
  "ingest",
  "reconcile",
  "expiry",
  "claimAlert",
  "fill",
  "plan",
  "publishPending",
  "autoPublish",
  "pricing",
  "scan",
  "digest",
  "farmPriority",
  "adoptable",
];

// --- fakes ---------------------------------------------------------------------

function getPath(doc, key) {
  return key.split(".").reduce((v, k) => (v === undefined || v === null ? undefined : v[k]), doc);
}

// Equality, $in and $ne: all the service's own queries use.
function matches(doc, filter) {
  for (const [k, cond] of Object.entries(filter || {})) {
    const v = getPath(doc, k);
    if (cond && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date)) {
      if ("$in" in cond && !cond.$in.map(String).includes(String(v))) return false;
      if ("$ne" in cond) {
        const same = cond.$ne === null ? v === null || v === undefined : String(v) === String(cond.$ne);
        if (same) return false;
      }
      continue;
    }
    if (String(v) !== String(cond)) return false;
  }
  return true;
}

function fakeModel(docs = [], extra = {}) {
  const m = {
    docs,
    finds: [],
    inits: 0,
    async init() {
      m.inits += 1;
    },
    find(filter, projection) {
      m.finds.push({ filter, projection });
      const out = docs.filter((d) => matches(d, filter)).map((d) => globalThis.structuredClone(d));
      return { lean: async () => out };
    },
    ...extra,
  };
  return m;
}

function fakeTimers() {
  const list = [];
  let seq = 0;
  const make = (kind) => (fn, ms) => {
    const t = {
      id: ++seq,
      kind,
      fn,
      ms,
      cleared: false,
      unrefed: false,
      unref() {
        t.unrefed = true;
        return t;
      },
    };
    list.push(t);
    return t;
  };
  return {
    list,
    setTimeout: make("timeout"),
    setInterval: make("interval"),
    clearTimeout: (t) => {
      if (t) t.cleared = true;
    },
    clearInterval: (t) => {
      if (t) t.cleared = true;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

const flush = () => new Promise((r) => setImmediate(r));

function harness(opts = {}) {
  const calls = [];
  const logs = [];
  const published = [];
  const approved = [];
  const scanned = [];
  const digestArgs = [];
  const clock = { now: opts.now ?? NOW };
  const cfg = deepMerge(DEFAULTS, opts.cfg || {});

  const runner = (name, result = { ok: true }) => ({
    run: async () => {
      calls.push(name);
      return result;
    },
  });

  const modules = {
    config: { get: async () => cfg, set: async () => cfg, forget() {} },
    events: {
      log: async (e) => {
        logs.push(e);
        return true;
      },
    },
    ingest: runner("ingest", { scanned: 0, added: 0 }),
    reconcile: runner("reconcile"),
    expiry: runner("expiry"),
    claimAlert: runner("claimAlert"),
    fill: runner("fill"),
    planner: runner("planner"),
    publisher: {
      problems: async (p) => {
        await flush(); // async on purpose: the service must await it
        return p.fakeProblems || [];
      },
      publishProduct: async (id, o) => {
        calls.push("publish:" + id);
        published.push({ id, opts: o });
        return { results: [{ market: "eldorado", ok: true, externalId: "x-" + id }] };
      },
      approve: async (id, o) => {
        calls.push("approve:" + id);
        approved.push({ id, opts: o });
        return { ok: true };
      },
    },
    competitors: {
      scan: async (p) => {
        calls.push("scan:" + p._id);
        scanned.push(String(p._id));
        return { lowestSameSetUsd: 1.25 };
      },
    },
    pricing: runner("pricing", { checked: 0, changed: [] }),
    digest: {
      run: async (a) => {
        calls.push("digest");
        digestArgs.push(a);
        return { sent: false };
      },
    },
    farmPriority: runner("farmPriority", { changed: [] }),
    adopt: {
      candidates: async () => {
        calls.push("adopt.candidates");
        return opts.candidates || [{ offerId: "a" }, { offerId: "b" }];
      },
      adopt: async () => ({ ok: false }),
    },
    ...(opts.modules || {}),
  };

  const models = {
    CodeProduct: fakeModel(opts.products || []),
    MarketplaceListing: fakeModel(opts.listings || []),
    CodeStock: fakeModel(),
    CodeShopConfig: fakeModel(),
    CodeShopEvent: fakeModel(),
    ...(opts.models || {}),
  };
  const shelf = opts.shelf || {};
  const timers = fakeTimers();
  const svc = createService({
    modules,
    factories: opts.factories,
    models,
    now: () => clock.now,
    timers,
    stock: () => ({ shelfFor: async (offer) => shelf[String(offer)] ?? 0 }),
    mp: () => ({ ggselTakesNewStock: () => opts.ggselOpen !== false }),
    telegram: { send: async () => ({ sent: 1 }) },
    ...(opts.overrides || {}),
  });
  return { svc, calls, logs, published, approved, scanned, digestArgs, clock, models, timers, cfg };
}

function product(id, extra = {}) {
  return {
    _id: id,
    name: "Bundle " + id,
    status: "active",
    offer: "of-" + id,
    markets: ["eldorado"],
    publish: { lastError: "" },
    proposed: { units: 0 },
    stale: false,
    ...extra,
  };
}

// --- surface -----------------------------------------------------------------------

test("modules: exactly the contract's set, built once from one shared deps, nothing loaded early", () => {
  const svc = createService();
  assert.deepEqual(Object.keys(svc.modules), [
    "config",
    "events",
    "ingest",
    "reconcile",
    "expiry",
    "units",
    "fill",
    "planner",
    "cover",
    "publisher",
    "competitors",
    "pricing",
    "claimAlert",
    "digest",
    "afterSale",
    "farmPriority",
    "views",
    "adopt",
  ]);
  const surface = {
    config: ["get", "set", "forget"],
    events: ["log", "recent", "stamp", "has"],
    ingest: ["run"],
    reconcile: ["run"],
    expiry: ["run"],
    units: ["build", "dissolve", "pull"],
    fill: ["run"],
    planner: ["run"],
    cover: ["build"],
    publisher: ["problems", "approve", "publishProduct", "pause", "resume", "retire"],
    competitors: ["scan"],
    pricing: ["run"],
    claimAlert: ["run"],
    digest: ["run"],
    afterSale: ["sold", "report", "replace"],
    farmPriority: ["run"],
    views: ["state", "product", "stock", "logins"],
    adopt: ["candidates", "adopt"],
  };
  for (const [name, fns] of Object.entries(surface)) {
    for (const fn of fns) assert.equal(typeof svc.modules[name][fn], "function", name + "." + fn);
    // every module is also on the shared deps, so modules share one instance
    assert.equal(svc.deps[name], svc.modules[name], "deps." + name);
  }
  for (const k of ["models", "secret", "mp", "stock", "category", "setImage", "farm", "telegram", "fetch", "now", "sleep", "guideFor", "problems", "extras"]) {
    assert.ok(svc.deps[k], "deps." + k);
  }
  for (const k of ["mp", "stock", "category", "setImage", "farm"]) assert.equal(typeof svc.deps[k], "function", k + " is lazy");
  assert.equal(typeof svc.deps.telegram.send, "function");
  assert.equal(svc.lastTick(), null);
  // Models, marketplaces and the stock layer are only loaded when used.
  const root = path.join(__dirname, "..");
  for (const f of ["models/CodeStock.js", "models/CodeProduct.js", "models/SuppliedAccount.js", "utils/marketplaces.js", "utils/suppliedStock.js", "utils/soopFarm.js"]) {
    assert.equal(require.cache[path.join(root, f)], undefined, f + " must not load at build time");
  }
  assert.deepEqual([...STEPS], ORDER);
});

test("the module's `service` is a lazily built singleton", () => {
  const d = Object.getOwnPropertyDescriptor(serviceModule, "service");
  assert.equal(typeof d.get, "function");
  const a = serviceModule.service;
  assert.equal(a, serviceModule.service);
  assert.equal(typeof a.start, "function");
});

test("views are wired to the publisher's problems and the service's adoptable / lastTick", async () => {
  const h = harness();
  assert.deepEqual(await h.svc.deps.problems({ fakeProblems: ["no price set"] }), ["no price set"]);
  assert.deepEqual(h.svc.deps.extras(), { adoptable: null, lastTick: null });
  const rec = await h.svc.tick();
  const x = h.svc.deps.extras();
  assert.equal(x.adoptable, 2);
  assert.equal(x.lastTick, rec);
  assert.equal(h.svc.lastTick(), rec);
});

// --- tick --------------------------------------------------------------------------

test("tick: every step in the contract's order", async () => {
  const h = harness({
    cfg: { autoPublish: true, markets: { eldorado: true } },
    products: [product("p1"), product("d1", { status: "draft", offer: null, proposed: { units: 5 } })],
    shelf: { "of-p1": 2 },
  });
  const rec = await h.svc.tick();
  assert.deepEqual(Object.keys(rec.steps), ORDER);
  assert.deepEqual(h.calls, [
    "ingest",
    "reconcile",
    "expiry",
    "claimAlert",
    "fill",
    "planner",
    "publish:p1",
    "approve:d1",
    "pricing",
    "scan:p1",
    "digest",
    "farmPriority",
    "adopt.candidates",
  ]);
  assert.ok(rec.at instanceof Date);
  assert.equal(rec.at.getTime(), NOW);
  assert.equal(typeof rec.ms, "number");
  assert.deepEqual(rec.steps.ingest, { scanned: 0, added: 0 });
  assert.deepEqual(rec.steps.adoptable, { adoptable: 2 });
  assert.deepEqual(h.digestArgs, [{ force: false }]);
  assert.equal(h.svc.lastTick(), rec);
});

test("tick: a failing step is recorded and logged, and every later step still runs", async () => {
  const h = harness({
    modules: {
      reconcile: {
        run: async () => {
          throw new Error("database went away");
        },
      },
      digest: {
        run: () => {
          throw new Error("sync throw");
        },
      },
    },
  });
  const rec = await h.svc.tick();
  assert.deepEqual(rec.steps.reconcile, { error: "database went away" });
  assert.deepEqual(rec.steps.digest, { error: "sync throw" });
  assert.deepEqual(Object.keys(rec.steps), ORDER);
  assert.deepEqual(h.calls, ["ingest", "expiry", "claimAlert", "fill", "planner", "pricing", "farmPriority", "adopt.candidates"]);
  const errors = h.logs.filter((e) => e.level === "error" && e.kind === "tick");
  assert.equal(errors.length, 2);
  assert.match(errors[0].msg, /reconcile failed: database went away/);
  assert.deepEqual(errors[0].data, { step: "reconcile" });
});

test("tick: a module that cannot be built becomes a stub that fails its step, not the service", async () => {
  const h = harness({
    modules: { ingest: undefined },
    factories: {
      ingest: () => {
        throw new Error("broken file");
      },
    },
  });
  await assert.rejects(h.svc.modules.ingest.run(), (err) => err.status === 503 && /ingest module did not load: broken file/.test(err.message));
  const rec = await h.svc.tick();
  assert.match(rec.steps.ingest.error, /did not load: broken file/);
  assert.equal(h.calls[0], "reconcile");
});

test("tick: a factory hook gets the shared deps", () => {
  let seen = null;
  const h = harness({
    modules: { pricing: undefined },
    factories: {
      pricing: (d) => {
        seen = d;
        return { run: async () => ({}) };
      },
    },
  });
  assert.equal(seen, h.svc.deps);
  assert.equal(seen.config, h.svc.modules.config);
  assert.equal(seen.events, h.svc.modules.events);
});

test("tick: a second call while one runs gets the same promise; nothing runs twice", async () => {
  const gate = deferred();
  let ingests = 0;
  const h = harness({
    modules: {
      ingest: {
        run: async () => {
          ingests += 1;
          await gate.promise;
          return {};
        },
      },
    },
  });
  const a = h.svc.tick();
  const b = h.svc.tick();
  assert.equal(a, b);
  await flush();
  assert.equal(ingests, 1);
  gate.resolve();
  const rec = await a;
  assert.equal(await b, rec);
  assert.equal(ingests, 1);
  const c = h.svc.tick();
  assert.notEqual(c, a);
  await c;
  assert.equal(ingests, 2);
});

test("runStep waits for a running tick instead of running on top of it", async () => {
  const gate = deferred();
  const h = harness({
    modules: {
      ingest: {
        run: async () => {
          await gate.promise;
          return {};
        },
      },
    },
  });
  const t = h.svc.tick();
  const s = h.svc.runStep("fill");
  await flush();
  assert.deepEqual(h.calls, []);
  gate.resolve();
  await Promise.all([t, s]);
  assert.deepEqual(h.calls.slice(-2), ["adopt.candidates", "fill"], "the manual fill ran after the whole tick");
  assert.equal(h.calls.filter((c) => c === "fill").length, 2);
});

test("tick: models are init()ed before the first step; a failed init is retried, and blocks the steps until it works", async () => {
  let fails = 2;
  const CodeStock = fakeModel([], {
    init: async () => {
      throw new Error("index build failed");
    },
    ensureIndexes: async () => {
      if (fails-- > 0) throw new Error("still failing");
    },
  });
  const h = harness({ models: { CodeStock } });
  const r1 = await h.svc.tick();
  assert.deepEqual(Object.keys(r1.steps), ["init"]);
  assert.match(r1.steps.init.error, /index build failed/);
  assert.deepEqual(h.calls, []);
  assert.equal(h.models.CodeProduct.inits, 0, "CodeProduct comes after CodeStock, which failed first");
  assert.ok(h.logs.some((e) => e.level === "error" && /models are not ready/.test(e.msg)));
  const r2 = await h.svc.tick();
  assert.match(r2.steps.init.error, /still failing/);
  const r3 = await h.svc.tick();
  assert.match(r3.steps.init.error, /still failing/);
  assert.deepEqual(h.calls, [], "no step runs before the indexes exist");
  const r4 = await h.svc.tick();
  assert.deepEqual(Object.keys(r4.steps), ORDER);
  assert.equal(h.calls[0], "ingest");
  // once it worked it is never asked again
  await h.svc.tick();
  for (const m of ["CodeProduct", "CodeShopConfig", "CodeShopEvent"]) assert.equal(h.models[m].inits, 1, m);
});

// --- gates ---------------------------------------------------------------------------

test("pricing and farmPriority run at most hourly; adoptable every 30 min", async () => {
  const h = harness();
  const count = (n) => h.calls.filter((c) => c === n).length;
  await h.svc.tick();
  assert.equal(count("pricing"), 1);
  assert.equal(count("farmPriority"), 1);
  assert.equal(count("adopt.candidates"), 1);

  h.clock.now = NOW + 5 * MIN;
  const r2 = await h.svc.tick();
  assert.equal(count("pricing"), 1);
  assert.equal(count("farmPriority"), 1);
  assert.equal(count("adopt.candidates"), 1);
  assert.match(r2.steps.pricing.skipped, /ran 5 min ago/);
  assert.ok(r2.steps.farmPriority.skipped);
  assert.ok(r2.steps.adoptable.skipped);
  assert.equal(count("ingest"), 2, "ungated steps run every tick");

  h.clock.now = NOW + 30 * MIN;
  await h.svc.tick();
  assert.equal(count("pricing"), 1);
  assert.equal(count("adopt.candidates"), 2);

  h.clock.now = NOW + 59 * MIN;
  await h.svc.tick();
  assert.equal(count("pricing"), 1);
  assert.equal(count("farmPriority"), 1);

  h.clock.now = NOW + 61 * MIN;
  const r5 = await h.svc.tick();
  assert.equal(count("pricing"), 2);
  assert.equal(count("farmPriority"), 2);
  assert.deepEqual(r5.steps.pricing, { checked: 0, changed: [] });

  // an explicit run does not wait for the hour, and restarts it
  h.clock.now = NOW + 62 * MIN;
  await h.svc.runStep("pricing");
  assert.equal(count("pricing"), 3);
  h.clock.now = NOW + 100 * MIN;
  await h.svc.tick();
  assert.equal(count("pricing"), 3);
});

test("scan: one active Eldorado product per tick, the stalest first, only when due", async () => {
  const h = harness({
    cfg: { competitorScan: { enabled: true, everyHours: 12 } },
    products: [
      product("s1", { competitors: { scannedAt: new Date(NOW - 20 * HOUR) } }),
      product("s2", { competitors: { scannedAt: new Date(NOW - 30 * HOUR) } }),
      product("s3", { markets: ["ggsel"] }),
      product("s4", { status: "paused" }),
      product("s5", { competitors: { scannedAt: new Date(NOW - 1 * HOUR) } }),
      product("s6"),
      product("s7", { status: "draft" }),
    ],
  });
  const r1 = await h.svc.tick();
  assert.deepEqual(r1.steps.scan, { product: "s6", name: "Bundle s6", lowestSameSetUsd: 1.25 });
  h.clock.now += 5 * MIN;
  await h.svc.tick();
  h.clock.now += 5 * MIN;
  await h.svc.tick();
  assert.deepEqual(h.scanned, ["s6", "s2", "s1"]);
  // The fake scan stores nothing (as a failed scan): s6/s2/s1 must not be
  // picked again until everyHours have passed.
  h.clock.now += 5 * MIN;
  const r4 = await h.svc.tick();
  assert.deepEqual(h.scanned, ["s6", "s2", "s1"]);
  assert.ok(r4.steps.scan.skipped);

  // runStep("scan") skips the age check, still one product, the stalest
  await h.svc.runStep("scan");
  assert.deepEqual(h.scanned, ["s6", "s2", "s1", "s5"]);

  // once everyHours have passed the first one tried is due again
  h.clock.now = NOW + 12 * HOUR + 1;
  await h.svc.tick();
  assert.equal(h.scanned.at(-1), "s6");
});

test("scan: nothing when the competitor scan is switched off", async () => {
  const h = harness({ cfg: { competitorScan: { enabled: false, everyHours: 12 } }, products: [product("s1")] });
  const r = await h.svc.tick();
  assert.deepEqual(h.scanned, []);
  assert.ok(r.steps.scan.skipped);
  await h.svc.runStep("scan");
  assert.deepEqual(h.scanned, []);
});

// --- publishPending ----------------------------------------------------------------------

test("publishPending: only active products with an allowed, enabled market that has no active row, stock, and no recent attempt", async () => {
  const h = harness({
    cfg: { markets: { eldorado: true, ggsel: false } },
    products: [
      product("p1"), // due
      product("p2"), // live Eldorado row
      product("p3"), // empty shelf
      product("p4", { markets: ["ggsel"] }), // GGSel switched off
      product("p5", { publish: { lastAttemptAt: new Date(NOW - 10 * MIN), lastError: "" } }), // tried 10 min ago
      product("p6", { publish: { lastAttemptAt: new Date(NOW - 2 * HOUR), lastError: "eldorado: " + OFFER_LIMIT_MSG } }), // offer limit: 6 h
      product("p7", { publish: { lastAttemptAt: new Date(NOW - 7 * HOUR), lastError: "eldorado: " + OFFER_LIMIT_MSG } }), // due again
      product("p8", { status: "draft" }),
      product("p9", { publish: { lastAttemptAt: new Date(NOW - 45 * MIN), lastError: "eldorado: HTTP 500" } }), // due again
      product("p10", { markets: ["gameflip"] }), // never a code shop market
      product("p11", { offer: null }), // never approved
      product("p12"), // its only row is not active
      product("p13", { status: "paused" }),
      product("p14", { publish: { lastAttemptAt: new Date(NOW - 29 * MIN), lastError: "" } }),
    ],
    listings: [
      { accountOffer: "of-p2", marketplace: "eldorado", status: "active" },
      { accountOffer: "of-p12", marketplace: "eldorado", status: "delisted" },
    ],
    shelf: { "of-p1": 2, "of-p2": 5, "of-p3": 0, "of-p4": 3, "of-p5": 3, "of-p6": 3, "of-p7": 1, "of-p9": 4, "of-p10": 3, "of-p12": 1, "of-p13": 3, "of-p14": 3 },
  });
  const r = await h.svc.runStep("publishPending");
  assert.deepEqual(
    h.published.map((p) => p.id),
    ["p1", "p7", "p9", "p12"],
  );
  for (const p of h.published) assert.deepEqual(p.opts, { actor: "auto" });
  assert.equal(r.steps.publishPending.attempted, 4);
  assert.equal(r.steps.publishPending.published, 4);
  assert.equal(r.steps.publishPending.failed, 0);
  assert.deepEqual(r.steps.publishPending.products[0], {
    id: "p1",
    name: "Bundle p1",
    markets: ["eldorado"],
    results: [{ market: "eldorado", ok: true }],
  });
});

test("publishPending: GGSel only while it takes new stock; a market already live is not published again", async () => {
  const setup = (ggselOpen) =>
    harness({
      ggselOpen,
      cfg: { markets: { eldorado: true, ggsel: true } },
      products: [product("g1", { markets: ["eldorado", "ggsel"] }), product("g2", { markets: ["eldorado", "ggsel"] })],
      listings: [
        { accountOffer: "of-g1", marketplace: "eldorado", status: "active" },
        { accountOffer: "of-g2", marketplace: "eldorado", status: "active" },
        { accountOffer: "of-g2", marketplace: "ggsel", status: "active" },
      ],
      shelf: { "of-g1": 3, "of-g2": 3 },
    });
  const open = setup(true);
  const r = await open.svc.runStep("publishPending");
  assert.deepEqual(open.published.map((p) => p.id), ["g1"]);
  assert.deepEqual(r.steps.publishPending.products[0].markets, ["ggsel"]);

  const closed = setup(false);
  await closed.svc.runStep("publishPending");
  assert.deepEqual(closed.published, []);
});

test("publishPending: one product's failure does not stop the others", async () => {
  const h = harness({
    products: [product("p1"), product("p2"), product("p3")],
    shelf: { "of-p1": 1, "of-p2": 1, "of-p3": 1 },
    overrides: {
      stock: () => ({
        shelfFor: async (offer) => {
          if (offer === "of-p2") throw new Error("count failed");
          return 1;
        },
      }),
    },
  });
  const r = await h.svc.runStep("publishPending");
  assert.deepEqual(h.published.map((p) => p.id), ["p1", "p3"]);
  assert.equal(r.steps.publishPending.failed, 1);
  assert.ok(h.logs.some((e) => e.level === "warn" && /Bundle p2/.test(e.msg) && /count failed/.test(e.msg)));
});

// --- autoPublish -------------------------------------------------------------------------

test("autoPublish: off by default", async () => {
  const h = harness({ products: [product("d1", { status: "draft", offer: null, proposed: { units: 9 } })] });
  const r = await h.svc.tick();
  assert.deepEqual(h.approved, []);
  assert.ok(r.steps.autoPublish.skipped);
});

test("autoPublish: drafts with no problems, enough proposed bundles and not stale are approved by 'auto'", async () => {
  const draft = (id, extra) => product(id, { status: "draft", offer: null, ...extra });
  const h = harness({
    cfg: { autoPublish: true, drafts: { minUnits: 3 } },
    products: [
      draft("d1", { proposed: { units: 5 } }),
      draft("d2", { proposed: { units: 5 }, fakeProblems: ["no price set"] }),
      draft("d3", { proposed: { units: 2 } }),
      draft("d4", { proposed: { units: 9 }, stale: true }),
      product("a1", { proposed: { units: 9 } }),
      draft("d5", { proposed: { units: 3 } }),
      draft("d6", { proposed: {} }),
    ],
  });
  const r = await h.svc.runStep("autoPublish");
  assert.deepEqual(h.approved, [
    { id: "d1", opts: { actor: "auto" } },
    { id: "d5", opts: { actor: "auto" } },
  ]);
  assert.equal(r.steps.autoPublish.approved, 2);
});

test("autoPublish: a refused approval is counted, not thrown", async () => {
  const h = harness({
    cfg: { autoPublish: true },
    products: [product("d1", { status: "draft", offer: null, proposed: { units: 5 } })],
    modules: {
      publisher: {
        problems: async () => [],
        approve: async () => ({ ok: false, problems: ["the product changed while it was being approved; try again"] }),
        publishProduct: async () => ({ results: [] }),
      },
    },
  });
  const r = await h.svc.runStep("autoPublish");
  assert.equal(r.steps.autoPublish.approved, 0);
  assert.equal(r.steps.autoPublish.refused, 1);
});

// --- runStep -------------------------------------------------------------------------------

test("runStep: one step now; 'all' is a whole tick; an unknown name is a 400", async () => {
  const h = harness();
  const r = await h.svc.runStep("ingest");
  assert.deepEqual(h.calls, ["ingest"]);
  assert.deepEqual(Object.keys(r.steps), ["ingest"]);
  assert.ok(r.at instanceof Date);
  assert.equal(h.svc.lastTick(), null, "a single step is not a tick");

  await h.svc.runStep("digest");
  assert.deepEqual(h.digestArgs, [{ force: true }]);

  await h.svc.runStep("adoptable");
  assert.equal(h.svc.deps.extras().adoptable, 2);

  const all = await h.svc.runStep("all");
  assert.deepEqual(Object.keys(all.steps), ORDER);
  assert.equal(h.svc.lastTick(), all);

  for (const bad of ["bogus", "", undefined, "planner", "__proto__", "init"]) {
    await assert.rejects(h.svc.runStep(bad), (err) => err.status === 400 && /Unknown code shop step/.test(err.message));
  }
});

test("runStep: a failing step comes back recorded, not thrown", async () => {
  const h = harness({
    modules: {
      fill: {
        run: async () => {
          throw new Error("no luck");
        },
      },
    },
  });
  const r = await h.svc.runStep("fill");
  assert.deepEqual(r.steps, { fill: { error: "no luck" } });
});

// --- start / stop -----------------------------------------------------------------------------

test("start: CODE_SHOP=0 does nothing", async () => {
  const before = process.env.CODE_SHOP;
  process.env.CODE_SHOP = "0";
  try {
    const h = harness();
    assert.equal(await h.svc.start(), false);
    assert.equal(h.timers.list.length, 0);
    assert.equal(h.models.CodeStock.inits, 0);
    assert.deepEqual(h.calls, []);
  } finally {
    if (before === undefined) delete process.env.CODE_SHOP;
    else process.env.CODE_SHOP = before;
  }
});

test("start: init first, then the first tick after 90 s and one every 5 min, unref'd; stop clears them", async () => {
  const before = process.env.CODE_SHOP;
  delete process.env.CODE_SHOP;
  try {
    const h = harness();
    const p1 = h.svc.start();
    const p2 = h.svc.start();
    assert.equal(p1, p2, "a second start() is the same start");
    assert.equal(await p1, true);
    for (const m of ["CodeStock", "CodeProduct", "CodeShopConfig", "CodeShopEvent"]) assert.equal(h.models[m].inits, 1, m);
    assert.equal(h.timers.list.length, 1);
    const [first] = h.timers.list;
    assert.equal(first.kind, "timeout");
    assert.equal(first.ms, 90000);
    assert.equal(first.unrefed, true);
    assert.deepEqual(h.calls, [], "nothing runs before the first timer");

    assert.equal(first.fn(), undefined, "the timer callback never throws or returns a promise");
    const interval = h.timers.list[1];
    assert.equal(interval.kind, "interval");
    assert.equal(interval.ms, 300000);
    assert.equal(interval.unrefed, true);
    const rec = await h.svc.tick(); // the tick the timer started
    assert.deepEqual(Object.keys(rec.steps), ORDER);
    assert.equal(h.calls.filter((c) => c === "ingest").length, 1);

    interval.fn();
    await h.svc.tick();
    assert.equal(h.calls.filter((c) => c === "ingest").length, 2);

    h.svc.stop();
    assert.equal(interval.cleared, true);
    assert.equal(h.timers.list.length, 2);
  } finally {
    if (before === undefined) delete process.env.CODE_SHOP;
    else process.env.CODE_SHOP = before;
  }
});

test("start: custom cadence; a timer firing during a slow tick starts no second one", async () => {
  const before = process.env.CODE_SHOP;
  delete process.env.CODE_SHOP;
  try {
    const gate = deferred();
    let ingests = 0;
    const h = harness({
      overrides: { firstTickMs: 1000, tickMs: 2000 },
      modules: {
        ingest: {
          run: async () => {
            ingests += 1;
            await gate.promise;
            return {};
          },
        },
      },
    });
    await h.svc.start();
    assert.equal(h.timers.list[0].ms, 1000);
    h.timers.list[0].fn();
    assert.equal(h.timers.list[1].ms, 2000);
    await flush(); // the tick is now inside ingest
    h.timers.list[1].fn();
    h.clock.now += 10 * 2000; // long past 3 ticks: the stuck warning
    h.timers.list[1].fn();
    await flush();
    assert.equal(ingests, 1);
    assert.ok(h.logs.some((e) => e.level === "warn" && /has been running for/.test(e.msg) && /in step ingest/.test(e.msg)));
    gate.resolve();
    await h.svc.tick();
    h.svc.stop();
  } finally {
    if (before === undefined) delete process.env.CODE_SHOP;
    else process.env.CODE_SHOP = before;
  }
});

test("start: a failed init does not stop the timers; the ticks retry it", async () => {
  const before = process.env.CODE_SHOP;
  delete process.env.CODE_SHOP;
  try {
    const CodeStock = fakeModel([], {
      init: async () => {
        throw new Error("not yet");
      },
      ensureIndexes: async () => {},
    });
    const h = harness({ models: { CodeStock } });
    assert.equal(await h.svc.start(), true);
    assert.ok(h.logs.some((e) => e.level === "error" && /not ready at start/.test(e.msg)));
    h.timers.list[0].fn();
    const rec = await h.svc.tick();
    assert.deepEqual(Object.keys(rec.steps), ORDER);
    h.svc.stop();
  } finally {
    if (before === undefined) delete process.env.CODE_SHOP;
    else process.env.CODE_SHOP = before;
  }
});

test("stop during start's init sets no timers", async () => {
  const before = process.env.CODE_SHOP;
  delete process.env.CODE_SHOP;
  try {
    const gate = deferred();
    const CodeStock = fakeModel([], { init: () => gate.promise });
    const h = harness({ models: { CodeStock } });
    const p = h.svc.start();
    h.svc.stop();
    gate.resolve();
    assert.equal(await p, false);
    assert.equal(h.timers.list.length, 0);
  } finally {
    if (before === undefined) delete process.env.CODE_SHOP;
    else process.env.CODE_SHOP = before;
  }
});

test("a timer tick where every step fails still resolves with a record", async () => {
  const boom = { run: async () => Promise.reject(new Error("down")) };
  const h = harness({
    modules: {
      ingest: boom,
      reconcile: boom,
      expiry: boom,
      claimAlert: boom,
      fill: boom,
      planner: boom,
      pricing: boom,
      digest: boom,
      farmPriority: boom,
      config: { get: async () => Promise.reject(new Error("no settings")) },
      adopt: { candidates: async () => Promise.reject(new Error("down")) },
    },
  });
  const rec = await h.svc.tick();
  for (const s of ORDER) assert.ok(rec.steps[s].error, s);
});

// --- real Mongo: the service's own queries and the real modules' wiring ------------------

test("real models: an empty tick runs every real step cleanly; publishPending and scan pick by real ObjectIds", async (t) => {
  const mongoose = require("mongoose");
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mem = await MongoMemoryServer.create();
  try {
    await mongoose.connect(mem.getUri("codeshopservice"));
    const CodeProduct = require("../models/CodeProduct");
    const MarketplaceListing = require("../models/MarketplaceListing");
    const sent = [];
    const touched = [];
    const svc = createService({
      now: () => NOW,
      telegram: {
        send: async (msg) => {
          sent.push(msg);
          return { sent: 1 };
        },
      },
      // No real market or network may be reached from a test.
      mp: () => {
        touched.push("mp");
        throw new Error("no marketplace in tests");
      },
      fetch: async () => {
        touched.push("fetch");
        throw new Error("no network in tests");
      },
      stock: () => ({ shelfFor: async (offer) => (String(offer) === String(offerA) ? 2 : 0) }),
      timers: fakeTimers(),
    });
    const offerA = new mongoose.Types.ObjectId();
    const offerB = new mongoose.Types.ObjectId();

    await t.test("an empty database: every step answers, none fails", async () => {
      const rec = await svc.tick();
      assert.deepEqual(Object.keys(rec.steps), ORDER);
      for (const s of ORDER) assert.ok(rec.steps[s] && !rec.steps[s].error, s + ": " + JSON.stringify(rec.steps[s]));
      assert.equal(rec.steps.autoPublish.skipped, "auto-publish is off");
      assert.deepEqual(rec.steps.adoptable, { adoptable: 0 });
      const state = await svc.modules.views.state();
      assert.equal(state.lastTick, rec);
      assert.equal(state.adoptable, 0);
      assert.deepEqual(touched, []);
    });

    await t.test("publishPending and scan on real documents", async () => {
      const published = [];
      const scanned = [];
      const [a, b] = await CodeProduct.create([
        { name: "Bundle A", status: "active", offer: offerA, markets: ["eldorado"], marketGame: "Game" },
        { name: "Bundle B", status: "active", offer: offerB, markets: ["eldorado"], marketGame: "Game", competitors: { scannedAt: new Date(NOW - 30 * HOUR) } },
      ]);
      await MarketplaceListing.collection.insertOne({ accountOffer: offerB, marketplace: "eldorado", status: "active", externalId: "made-up-1" });
      // The steps below use the service's real queries with fake publisher / scanner.
      svc.modules.publisher.publishProduct = async (id, o) => {
        published.push({ id: String(id), o });
        return { results: [] };
      };
      svc.modules.competitors.scan = async (p) => {
        scanned.push(String(p._id));
        return { lowestSameSetUsd: null };
      };
      const r1 = await svc.runStep("publishPending");
      assert.deepEqual(published, [{ id: String(a._id), o: { actor: "auto" } }]);
      assert.equal(r1.steps.publishPending.checked, 2);
      const r2 = await svc.runStep("scan");
      assert.deepEqual(scanned, [String(a._id)], "never scanned beats scanned 30 h ago");
      assert.equal(r2.steps.scan.product, String(a._id));
      await svc.runStep("scan");
      assert.deepEqual(scanned, [String(a._id), String(b._id)]);
      assert.deepEqual(touched, []);
    });
  } finally {
    await mongoose.disconnect();
    await mem.stop();
  }
});
