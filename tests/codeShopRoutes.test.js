/* global fetch */
// Route-level tests for the code shop API (docs/code-shop/04-OPS.md,
// "routes/codeShopRoutes.js"), against a stub-session Express harness.
//
// What these exist to prevent:
//  1. AN OPEN PANEL. Every route can change live stock or hand out a code, so
//     every one must refuse an anonymous or non-superadmin caller.
//  2. A CODE LEAK. Only POST /units/:id/replace returns a code; it must be
//     no-store, answer exactly { code, label, codeShape } and never be logged.
//  3. A SILENT REFUSAL. A publisher answer of { ok: false } must reach the
//     panel as an error, never as "done".
//  4. A BROKEN PRODUCT. Custom drafts, merges and edits write CodeProduct here:
//     one game per bundle, one non-retired product per slot set, slots fixed
//     once approved, buyer text guarded before it reaches a live offer.
//
// The service is a fake whose modules record their calls; the product routes
// run on real Mongo (mongodb-memory-server). All values are made up.
process.env.CRED_SECRET ||= "code-shop-routes-test";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const CodeStock = require("../models/CodeStock");
const CodeProduct = require("../models/CodeProduct");
const AccountOffer = require("../models/AccountOffer");
const MarketplaceListing = require("../models/MarketplaceListing");
const { DEFAULTS, deepMerge } = require("../utils/codeShop/config");
const { slotKeyOf, slotSetHash } = require("../utils/codeShop/slots");
const { defaultTexts } = require("../utils/codeShop/texts");
const { guideFor } = require("../utils/codeShop/games");
const codeShopRoutes = require("../routes/codeShopRoutes");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-15T12:00:00Z");
const CODE = "TEST-CODE-SENTINEL-7QX2";
const GHOST_ID = "0123456789abcdef01234567";
const ROOT = "root-admin";

// [method, path] — the 04-OPS.md table, row for row.
const TABLE = [
  ["GET", "/api/code-shop/state"],
  ["GET", "/api/code-shop/products/:id"],
  ["POST", "/api/code-shop/products"],
  ["POST", "/api/code-shop/products/merge"],
  ["POST", "/api/code-shop/products/:id"],
  ["DELETE", "/api/code-shop/products/:id"],
  ["POST", "/api/code-shop/products/:id/approve"],
  ["POST", "/api/code-shop/products/:id/publish"],
  ["POST", "/api/code-shop/products/:id/pause"],
  ["POST", "/api/code-shop/products/:id/resume"],
  ["POST", "/api/code-shop/products/:id/retire"],
  ["POST", "/api/code-shop/products/:id/scan"],
  ["POST", "/api/code-shop/products/:id/texts/reset"],
  ["GET", "/api/code-shop/stock"],
  ["GET", "/api/code-shop/logins"],
  ["GET", "/api/code-shop/sold"],
  ["POST", "/api/code-shop/units/:id/report"],
  ["POST", "/api/code-shop/units/:id/replace"],
  ["GET", "/api/code-shop/adopt/candidates"],
  ["POST", "/api/code-shop/adopt"],
  ["POST", "/api/code-shop/config"],
  ["POST", "/api/code-shop/run"],
  ["GET", "/api/code-shop/events"],
  ["POST", "/api/code-shop/held/:id/release"],
];

// ---- the fake service ---------------------------------------------------------

const calls = [];
let behave = {}; // module call name -> implementation for this test
let cfgOver = {};
let clock = NOW;
const mpCalls = [];
const mpFail = new Set();
// service.exclusive: a real one-at-a-time queue, like the service's; a call made
// while a queued job runs is recorded with queued: true.
let queue = Promise.resolve();
let queueDepth = 0;
const heldBuilt = [];

function rec(name, dflt) {
  return async (...args) => {
    calls.push({ name, args, queued: queueDepth > 0 });
    const fn = behave[name] || dflt;
    return fn ? fn(...args) : {};
  };
}
const callsOf = (name) => calls.filter((c) => c.name === name);

function exclusive(fn) {
  calls.push({ name: "service.exclusive", args: [] });
  const run = queue.then(async () => {
    queueDepth += 1;
    try {
      return await fn();
    } finally {
      queueDepth -= 1;
    }
  });
  queue = run.then(
    () => {},
    () => {},
  );
  return run;
}

// The held-code releaser the router builds from the service's deps.
const fakeHeld = {
  release: rec("held.release", (rowId) => ({
    row: {
      _id: rowId,
      loginId: "login-9",
      slotKey: "12:100:aaaa:1",
      name: "Sun Tea",
      nameRaw: "Sun Tea",
      codeHash: "hash-must-not-leave",
      codeEnc: "enc-must-not-leave",
      codeShape: "25:4-4-5-4-4",
      state: "in_stock",
      problem: "",
      useBy: new Date(NOW + 5 * DAY),
    },
  })),
};
function createHeld(deps) {
  heldBuilt.push(deps);
  return fakeHeld;
}

const fakeService = {
  exclusive,
  deps: {
    models: { CodeStock, CodeProduct, AccountOffer, MarketplaceListing },
    now: () => clock,
    guideFor,
    mp: () => ({
      eldoradoUpdateOffer: async (id, patch) => {
        mpCalls.push({ id, patch });
        if (mpFail.has(id)) throw new Error("Eldorado said no");
        return { id };
      },
    }),
  },
  modules: {
    config: {
      get: async () => deepMerge(DEFAULTS, cfgOver),
      set: rec("config.set", (patch) => deepMerge(DEFAULTS, patch)),
    },
    events: {
      log: rec("events.log", () => true),
      recent: rec("events.recent", () => [{ kind: "publish", msg: "made up" }]),
    },
    views: {
      state: rec("views.state", () => ({ config: { autoPublish: false }, summary: { inStock: 7 }, products: [], adoptable: 2, lastTick: null })),
      stock: rec("views.stock", () => ({ games: [{ gameNo: "12" }], held: [] })),
      logins: rec("views.logins", () => ({ logins: [{ loginId: "login-a" }] })),
      // Reads the stored row, so answers show what the route wrote.
      product: rec("views.product", async (id) => {
        const p = await CodeProduct.findById(id).lean();
        if (!p) throw Object.assign(new Error("Code shop product not found: " + id), { status: 404 });
        return {
          product: {
            id: String(p._id),
            name: p.name,
            status: p.status,
            slots: p.slots,
            texts: p.texts,
            pricing: p.pricing,
            markets: p.markets,
            problems: [],
          },
        };
      }),
    },
    publisher: {
      approve: rec("publisher.approve", () => ({ ok: true, built: 3, dissolved: 0 })),
      publishProduct: rec("publisher.publishProduct", () => ({ results: [{ market: "eldorado", ok: true, externalId: "E-new" }] })),
      pause: rec("publisher.pause", () => ({ ok: true, delisted: 1, errors: [] })),
      resume: rec("publisher.resume", () => ({ ok: true, publish: { results: [] } })),
      retire: rec("publisher.retire", () => ({ ok: true, dissolved: 2 })),
    },
    competitors: {
      scan: rec("competitors.scan", () => ({ scannedAt: new Date(NOW).toISOString(), lowestSameSetUsd: 1.2, offers: [] })),
    },
    afterSale: {
      sold: rec("afterSale.sold", () => [{ unitId: GHOST_ID, codes: [] }]),
      report: rec("afterSale.report", (unitId, { slot, status }) => ({ unitId, slot, label: "Sun Tea", codeShape: "25:4-4-5-4-4", state: status === "dead" ? "dead" : "sold", after: { status } })),
      replace: rec("afterSale.replace", () => ({ code: CODE, label: "Sun Tea", codeShape: "23:4-4-8-4", extra: "never sent" })),
    },
    adopt: {
      candidates: rec("adopt.candidates", () => [{ offerId: GHOST_ID, title: "Hand-made", units: { available: 2 } }]),
      adopt: rec("adopt.adopt", () => ({ ok: true, report: { units: 2, codes: 4 } })),
    },
  },
  runStep: rec("service.runStep", (step) => ({ step, ran: true })),
  lastTick: () => null,
};

// ---- harness ----------------------------------------------------------------------

const servers = {};
const logged = [];
const realConsole = { log: console.log, warn: console.warn, error: console.error };
let mem;

function harness(admin, service = fakeService, opts = { createHeld }) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    req.session = admin ? { admin } : {};
    next();
  });
  app.use(codeShopRoutes({ service, ...opts }));
  const server = app.listen(0);
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function call(method, path, body, who = "root") {
  const res = await fetch(servers[who].url + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, text, json, headers: res.headers };
}
const get = (path) => call("GET", "/api/code-shop" + path);
const post = (path, body = {}) => call("POST", "/api/code-shop" + path, body);
const del = (path) => call("DELETE", "/api/code-shop" + path);

function ok(r, what = "") {
  assert.equal(r.status, 200, `${what} expected 200, got ${r.status} ${r.text.slice(0, 300)}`);
  assert.equal(r.json.success, true);
  return r.json;
}

function refused(r, status, what = "") {
  assert.equal(r.status, status, `${what}: expected ${status}, got ${r.status} ${r.text.slice(0, 300)}`);
  assert.equal(r.json.success, false);
  assert.ok(typeof r.json.message === "string" && r.json.message, `${what}: no readable message`);
  return r.json;
}

test.before(async () => {
  for (const k of Object.keys(realConsole)) {
    console[k] = (...args) => {
      logged.push(args.map(String).join(" "));
      if (process.env.CODE_SHOP_TEST_LOGS) realConsole[k](...args);
    };
  }
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshoproutes"));
  await Promise.all([CodeStock.init(), CodeProduct.init(), AccountOffer.init(), MarketplaceListing.init()]);
  servers.root = harness({ id: "a1", username: ROOT, role: "superadmin" });
  servers.anon = harness(null);
  servers.seller = harness({ id: "s1", username: "shop", role: "seller" });
  // A service without the tick queue (an older build): queued actions must refuse.
  const noQueue = { ...fakeService };
  delete noQueue.exclusive;
  servers.noQueue = harness({ id: "a1", username: ROOT, role: "superadmin" }, noQueue);
  // No createHeld: the router builds utils/codeShop/held.js from the service's deps.
  servers.realHeld = harness({ id: "a1", username: ROOT, role: "superadmin" }, fakeService, {});
});

test.after(async () => {
  for (const s of Object.values(servers)) await new Promise((r) => s.server.close(r));
  await mongoose.disconnect();
  if (mem) await mem.stop();
  Object.assign(console, realConsole);
});

test.beforeEach(async () => {
  calls.length = 0;
  mpCalls.length = 0;
  mpFail.clear();
  behave = {};
  cfgOver = {};
  clock = NOW;
  await Promise.all([CodeStock.deleteMany({}), CodeProduct.deleteMany({}), AccountOffer.deleteMany({}), MarketplaceListing.deleteMany({})]);
});

// ---- data -----------------------------------------------------------------------

let seq = 0;

// `count` ledger rows of one reward; returns its slotKey.
async function addRows({
  gameNo = "12",
  groupKey = "12:100",
  nameRaw,
  name = nameRaw,
  count = 2,
  earnedAt = NOW - 3 * DAY,
  useBy = NOW + 20 * DAY,
  state = "in_stock",
  image = "",
  campaignTitle = "Autumn Cup",
  gameName = "Overwatch 2",
}) {
  const slotKey = slotKeyOf(groupKey, nameRaw, 1);
  for (let i = 0; i < count; i++) {
    seq += 1;
    await CodeStock.create({
      loginId: "login-" + seq,
      itemKey: "item-" + seq,
      gameNo,
      gameName,
      groupKey,
      campaignIdx: groupKey.split(":")[1],
      campaignTitle,
      slotKey,
      nameRaw,
      name,
      image,
      codeHash: "hash-" + seq,
      codeShape: "25:4-4-5-4-4",
      earnedAt: new Date(earnedAt + i * HOUR),
      useBy: useBy === null ? null : new Date(useBy),
      state,
    });
  }
  return slotKey;
}

const slot = (slotKey, label) => ({ slotKey, label, image: "", nameRaw: label, campaignTitle: "Autumn Cup" });

async function addProduct(over = {}) {
  const slots = over.slots || [slot("12:100:aaaa:1", "One"), slot("12:100:bbbb:1", "Two")];
  return CodeProduct.create({
    name: "Bundle " + ++seq,
    gameNo: "12",
    gameName: "Overwatch 2",
    marketGame: "Overwatch",
    groupKeys: ["12:100"],
    slotSetHash: slotSetHash(slots.map((s) => s.slotKey)),
    status: "draft",
    origin: "auto",
    kind: "full",
    texts: {
      title: "Overwatch 2 | 2 Codes Bundle | One + Two",
      description: "Two codes.",
      deliveryTemplate: "Thanks:\n{password}",
      coverTitle: "Overwatch 2 Code Bundle",
      coverServiceText: "2 Redeem Codes",
      coverBullets: ["Instant Automatic Delivery"],
    },
    markets: ["eldorado"],
    ...over,
    slots,
  });
}

// ---- mounting and access ------------------------------------------------------------

test("every path and method of the contract table is mounted, and nothing else", () => {
  const router = codeShopRoutes({ service: fakeService });
  const mounted = router.stack
    .filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route.path}`));
  assert.deepEqual([...mounted].sort(), TABLE.map(([m, p]) => `${m} ${p}`).sort());
});

test("the module router is built lazily and does not load the service", () => {
  const r = codeShopRoutes.router;
  assert.equal(typeof r, "function");
  assert.equal(codeShopRoutes.router, r, "built once");
  const loaded = Object.keys(require.cache).some((k) => /utils[\\/]codeShop[\\/]service\.js$/.test(k));
  assert.equal(loaded, false, "mounting must not require the service");
  assert.throws(() => codeShopRoutes({}), /service/);
});

test("every route answers 401 to an anonymous caller and 403 to a seller, and calls nothing", async () => {
  for (const [method, path] of TABLE) {
    const p = path.replace(":id", GHOST_ID);
    const body = method === "POST" ? {} : undefined;
    const anon = await call(method, p, body, "anon");
    assert.equal(anon.status, 401, `${method} ${path} anonymous`);
    assert.equal(anon.json.success, false);
    const seller = await call(method, p, body, "seller");
    assert.equal(seller.status, 403, `${method} ${path} seller`);
    assert.equal(seller.json.success, false);
  }
  assert.equal(calls.length, 0);
});

// ---- views --------------------------------------------------------------------------

test("GET /state, /stock and /logins spread the views", async () => {
  const s = ok(await get("/state"));
  assert.deepEqual(s.summary, { inStock: 7 });
  assert.equal(s.adoptable, 2);
  assert.deepEqual(s.config, { autoPublish: false });
  assert.deepEqual(ok(await get("/stock")).games, [{ gameNo: "12" }]);
  assert.deepEqual(ok(await get("/logins")).logins, [{ loginId: "login-a" }]);
});

test("GET /products/:id answers the product view; bad id 400, unknown 404", async () => {
  const p = await addProduct();
  const r = ok(await get("/products/" + p._id));
  assert.equal(r.product.id, String(p._id));
  assert.deepEqual(callsOf("views.product")[0].args, [String(p._id)]);
  refused(await get("/products/not-an-id"), 400, "bad id");
  refused(await get("/products/" + GHOST_ID), 404, "unknown id");
});

test("GET /sold passes limit and product; bad input 400", async () => {
  const r = ok(await get(`/sold?limit=5&product=${GHOST_ID}`));
  assert.deepEqual(r.sold, [{ unitId: GHOST_ID, codes: [] }]);
  assert.deepEqual(callsOf("afterSale.sold")[0].args, [{ limit: 5, productId: GHOST_ID }]);
  ok(await get("/sold"));
  assert.deepEqual(callsOf("afterSale.sold")[1].args, [{ limit: 100, productId: undefined }]);
  refused(await get("/sold?product=nope"), 400, "bad product");
  refused(await get(`/sold?product=${GHOST_ID}&product=${GHOST_ID}`), 400, "two products");
  refused(await get("/sold?limit=0"), 400, "limit 0");
  refused(await get("/sold?limit=abc"), 400, "limit abc");
  assert.equal(callsOf("afterSale.sold").length, 2);
});

test("GET /events passes its filters; a bad level or product is 400", async () => {
  const r = ok(await get(`/events?limit=20&kind=publish&level=warn&product=${GHOST_ID}`));
  assert.equal(r.events.length, 1);
  assert.deepEqual(callsOf("events.recent")[0].args, [{ limit: 20, kind: "publish", level: "warn", product: GHOST_ID }]);
  ok(await get("/events"));
  assert.deepEqual(callsOf("events.recent")[1].args, [{ limit: 100, kind: undefined, level: undefined, product: undefined }]);
  refused(await get("/events?level=loud"), 400, "level");
  refused(await get("/events?product=xyz"), 400, "product");
});

test("an error without a status is a 500 that does not repeat the error's text", async () => {
  behave["views.state"] = () => {
    throw new Error("database exploded at host-internal-1");
  };
  const raw = await get("/state");
  assert.equal(refused(raw, 500, "state").message, "Server error");
  assert.ok(!raw.text.includes("host-internal-1"));
  assert.ok(logged.some((l) => l.includes("host-internal-1")), "logged for the operator");
});

// ---- POST /products ------------------------------------------------------------------

test("POST /products makes a manual custom draft from ledger slots of one game", async () => {
  const a = await addRows({ nameRaw: "Sun Tea Icon", earnedAt: NOW - 2 * DAY, image: "https://img.example/a.png" });
  const b = await addRows({ nameRaw: "Moon Spray", earnedAt: NOW - 5 * DAY, useBy: NOW + 10 * DAY });
  const c = await addRows({ nameRaw: "SOOP Spray", earnedAt: NOW - 1 * DAY });
  // A code inside the expiry lead never decides the printed redeem-by date.
  await addRows({ nameRaw: "Sun Tea Icon", earnedAt: NOW - 1 * DAY, useBy: NOW + 10 * HOUR, count: 1 });

  const r = ok(await post("/products", { slotKeys: [a, c, b] }));
  const p = await CodeProduct.findById(r.product.id).lean();
  assert.equal(r.product.name, p.name);
  assert.equal(p.name, "Overwatch 2 - Autumn Cup (3 codes)");
  assert.equal(p.status, "draft");
  assert.equal(p.origin, "manual");
  assert.equal(p.kind, "custom");
  assert.equal(p.edited, true);
  assert.equal(p.stale, false);
  assert.equal(p.offer, null);
  assert.equal(p.gameNo, "12");
  assert.equal(p.gameName, "Overwatch 2");
  assert.equal(p.marketGame, "Overwatch");
  assert.deepEqual(p.groupKeys, ["12:100"]);
  // Oldest reward first; a name with a source word gets no default label.
  assert.deepEqual(p.slots.map((s) => s.slotKey), [b, a, c]);
  assert.deepEqual(p.slots.map((s) => s.label), ["Moon Spray", "Sun Tea Icon", ""]);
  assert.equal(p.slots[1].image, "https://img.example/a.png");
  assert.equal(p.slots[0].campaignTitle, "Autumn Cup");
  assert.equal(p.slotSetHash, slotSetHash([a, b, c]));
  assert.deepEqual(p.markets, ["eldorado"]);
  assert.deepEqual(
    { mode: p.pricing.mode, priceUsd: p.pricing.priceUsd, floorUsd: p.pricing.floorUsd, clearance: p.pricing.clearance, followCompetitors: p.pricing.followCompetitors },
    { mode: "fixed", priceUsd: 1, floorUsd: 0.5, clearance: false, followCompetitors: false },
  );
  const expected = defaultTexts({
    slots: p.slots,
    guide: guideFor("12", deepMerge(DEFAULTS, {})),
    useBy: new Date(NOW + 10 * DAY),
    now: NOW,
    // No campaign row: dated by the group's first earned code (Moon Spray).
    eventStarts: [new Date(NOW - 5 * DAY)],
  });
  assert.deepEqual({ ...p.texts }, expected);
  assert.match(p.texts.description, /REDEEM BY/);
  assert.match(p.texts.description, /^EVENT: /m);

  const ev = callsOf("events.log")[0].args[0];
  assert.equal(ev.kind, "draft");
  assert.equal(String(ev.product), r.product.id);
  assert.equal(ev.data.actor, ROOT);
});

test("POST /products takes a name and the enabled markets; GGSel is never picked (R1)", async () => {
  // A stored config from before R1 may still say GGSel is on.
  cfgOver = { markets: { eldorado: true, ggsel: true } };
  const a = await addRows({ nameRaw: "Sun Tea Icon" });
  const r = ok(await post("/products", { slotKeys: [a], name: "  My bundle  " }));
  assert.equal(r.product.name, "My bundle");
  const p = await CodeProduct.findById(r.product.id).lean();
  assert.deepEqual(p.markets, ["eldorado"]);
  assert.equal(p.slots.length, 1);
});

test("POST /products names PlayerAuctions too when it is switched on (06 plan, C7)", async () => {
  cfgOver = { markets: { eldorado: true, playerauctions: true } };
  const a = await addRows({ nameRaw: "Sun Tea Icon" });
  const r = ok(await post("/products", { slotKeys: [a] }));
  assert.deepEqual((await CodeProduct.findById(r.product.id).lean()).markets, ["eldorado", "playerauctions"]);
  // A draft's own market list may name it as well.
  const edited = ok(await post("/products/" + r.product.id, { markets: ["playerauctions"] }));
  assert.ok(edited);
  assert.deepEqual((await CodeProduct.findById(r.product.id).lean()).markets, ["playerauctions"]);
  // A game not on playerauctionsGames is drafted without it.
  cfgOver = { markets: { eldorado: true, playerauctions: true }, playerauctionsGames: [] };
  const b = await addRows({ nameRaw: "Moon Spray" });
  const r2 = ok(await post("/products", { slotKeys: [b] }));
  assert.deepEqual((await CodeProduct.findById(r2.product.id).lean()).markets, ["eldorado"]);
});

test("POST /products refuses unknown slots, mixed games and bad input with 400", async () => {
  const a = await addRows({ nameRaw: "Sun Tea Icon" });
  const d = await addRows({ gameNo: "200", groupKey: "200:7", nameRaw: "Rifle Skin", gameName: "Delta Force" });
  for (const [body, what] of [
    [{}, "no slotKeys"],
    [{ slotKeys: "x" }, "not a list"],
    [{ slotKeys: [] }, "empty"],
    [{ slotKeys: [1] }, "not strings"],
    [{ slotKeys: [a, "12:100:ffff:1"] }, "unknown slot"],
    [{ slotKeys: [a, d] }, "two games"],
    [{ slotKeys: [a], name: "x".repeat(121) }, "long name"],
    [{ slotKeys: [a], name: { $ne: 1 } }, "object name"],
  ]) {
    refused(await post("/products", body), 400, what);
  }
  assert.equal(await CodeProduct.countDocuments(), 0);
});

test("POST /products refuses a set a non-retired product already owns (409), not a retired one", async () => {
  const a = await addRows({ nameRaw: "Sun Tea Icon" });
  const b = await addRows({ nameRaw: "Moon Spray" });
  const first = ok(await post("/products", { slotKeys: [a, b] }));
  const again = refused(await post("/products", { slotKeys: [b, a] }), 409, "same set");
  assert.equal(again.productId, first.product.id);
  await CodeProduct.updateOne({ _id: first.product.id }, { $set: { status: "retired" } });
  ok(await post("/products", { slotKeys: [b, a] }), "after retire");
  assert.equal(await CodeProduct.countDocuments(), 2);
});

// ---- POST /products/merge ------------------------------------------------------------

test("POST /products/merge unions the drafts' slots, keeps first labels, deletes merged auto drafts", async () => {
  const d1 = await addProduct({ slots: [slot("12:100:a:1", "A1"), slot("12:100:b:1", "B1")], markets: ["eldorado"] });
  const d2 = await addProduct({ slots: [slot("12:100:b:1", "B2"), slot("12:100:c:1", "C2")], markets: ["ggsel"] });
  const d3 = await addProduct({ slots: [slot("12:101:d:1", "D3")], origin: "manual", groupKeys: ["12:101"] });
  const r = ok(await post("/products/merge", { ids: [String(d1._id), String(d2._id), String(d3._id)] }));
  assert.equal(r.deleted, 2);
  const p = await CodeProduct.findById(r.product.id).lean();
  assert.equal(p.name, r.product.name);
  assert.deepEqual(p.slots.map((s) => [s.slotKey, s.label]), [
    ["12:100:a:1", "A1"],
    ["12:100:b:1", "B1"],
    ["12:100:c:1", "C2"],
    ["12:101:d:1", "D3"],
  ]);
  assert.equal(p.origin, "manual");
  assert.equal(p.kind, "custom");
  assert.equal(p.status, "draft");
  assert.equal(p.edited, true);
  assert.deepEqual(p.markets, ["eldorado"], "an old draft's GGSel pick is dropped (R1)");
  assert.deepEqual(p.groupKeys, ["12:100", "12:101"]);
  assert.equal(p.slotSetHash, slotSetHash(["12:100:a:1", "12:100:b:1", "12:100:c:1", "12:101:d:1"]));
  assert.match(p.texts.title, /4 Codes Bundle \| A1 \+ B1 \+ C2 \+ D3/);
  assert.equal(await CodeProduct.exists({ _id: d1._id }), null);
  assert.equal(await CodeProduct.exists({ _id: d2._id }), null);
  assert.ok(await CodeProduct.exists({ _id: d3._id }), "a hand-made draft stays");
});

test("POST /products/merge: a merged auto draft owning the union is not a conflict", async () => {
  const d1 = await addProduct({ slots: [slot("12:100:a:1", "A"), slot("12:100:b:1", "B")] });
  const d2 = await addProduct({ slots: [slot("12:100:b:1", "B")] });
  const r = ok(await post("/products/merge", { ids: [String(d1._id), String(d2._id)] }));
  assert.equal(r.deleted, 2);
  assert.equal(await CodeProduct.countDocuments(), 1);
});

test("POST /products/merge refusals: 400 bad input / not drafts / two games, 404 unknown, 409 set taken", async () => {
  const d1 = await addProduct({ slots: [slot("12:100:a:1", "A")] });
  const d2 = await addProduct({ slots: [slot("12:100:b:1", "B")] });
  const live = await addProduct({ slots: [slot("12:100:c:1", "C")], status: "active" });
  const df = await addProduct({ slots: [slot("200:7:x:1", "X")], gameNo: "200" });
  const ids = (...ps) => ps.map((p) => String(p._id));
  refused(await post("/products/merge", {}), 400, "no ids");
  refused(await post("/products/merge", { ids: ids(d1) }), 400, "one id");
  refused(await post("/products/merge", { ids: [String(d1._id), "nope"] }), 400, "bad id");
  refused(await post("/products/merge", { ids: ids(d1, live) }), 400, "not a draft");
  refused(await post("/products/merge", { ids: ids(d1, df) }), 400, "two games");
  refused(await post("/products/merge", { ids: [String(d1._id), GHOST_ID] }), 404, "unknown");
  await addProduct({ slots: [slot("12:100:a:1", "A"), slot("12:100:b:1", "B")], status: "paused", origin: "manual" });
  const r = refused(await post("/products/merge", { ids: ids(d1, d2) }), 409, "set taken");
  assert.ok(r.productId);
  assert.equal(await CodeProduct.countDocuments(), 5, "nothing written or deleted");
});

// ---- POST /products/:id (edit) --------------------------------------------------------

test("POST /products/:id edits a draft: labels by stored order, then remove, then order", async () => {
  const k1 = "12:100:one:1";
  const k2 = "12:100:two:1";
  const k3 = "12:100:three:1";
  const p = await addProduct({ slots: [slot(k1, "One"), slot(k2, "Two"), slot(k3, "Three")], stale: true, markets: ["ggsel"] });
  const r = ok(
    await post("/products/" + p._id, {
      name: "Renamed",
      note: "for the weekend",
      labels: ["Uno", "Dos", "Tres"],
      removeSlots: [k2],
      slotOrder: [k3, k1],
      markets: ["eldorado"],
      pricing: { priceUsd: 2.5, floorUsd: 1, clearance: true },
      texts: { title: "New title" },
    }),
  );
  const q = await CodeProduct.findById(p._id).lean();
  assert.deepEqual(q.slots.map((s) => [s.slotKey, s.label]), [
    [k3, "Tres"],
    [k1, "Uno"],
  ]);
  assert.equal(q.slotSetHash, slotSetHash([k1, k3]));
  assert.equal(q.name, "Renamed");
  assert.equal(q.note, "for the weekend");
  assert.equal(q.edited, true);
  assert.equal(q.stale, false);
  assert.deepEqual(q.markets, ["eldorado"]);
  assert.equal(q.pricing.priceUsd, 2.5);
  assert.equal(q.pricing.floorUsd, 1);
  assert.equal(q.pricing.mode, "fixed", "fields not sent stay");
  assert.equal(q.pricing.clearance, true);
  assert.equal(q.texts.title, "New title");
  assert.equal(q.texts.description, p.texts.description, "texts not sent stay");
  // Answer = the product view.
  assert.equal(r.product.id, String(p._id));
  assert.equal(r.product.name, "Renamed");
  assert.deepEqual(callsOf("views.product").at(-1).args, [String(p._id)]);
  assert.equal(callsOf("events.log").at(-1).args[0].kind, "edit");
});

test("POST /products/:id refuses bad draft edits with 400 and writes nothing", async () => {
  const k1 = "12:100:one:1";
  const k2 = "12:100:two:1";
  const p = await addProduct({ slots: [slot(k1, "One"), slot(k2, "Two")] });
  const before = await CodeProduct.findById(p._id).lean();
  for (const [body, what] of [
    [{}, "nothing to change"],
    [{ pricing: { priceUsd: 1, floorUsd: 2 } }, "floor above price"],
    [{ pricing: { floorUsd: 1.5 } }, "floor above the stored price"],
    [{ pricing: { priceUsd: 0.4 } }, "under the minimum"],
    [{ pricing: { priceUsd: "2" } }, "price as text"],
    [{ pricing: { mode: "smart" } }, "mode"],
    [{ pricing: { clearance: "yes" } }, "clearance flag"],
    [{ pricing: { discount: 5 } }, "unknown pricing field"],
    [{ pricing: [] }, "pricing list"],
    [{ markets: ["gameflip"] }, "blocked market"],
    [{ markets: ["eldorado", "digiseller"] }, "blocked market 2"],
    [{ markets: ["ggsel"] }, "GGSel (R1)"],
    [{ markets: ["eldorado", "ggsel"] }, "GGSel beside Eldorado (R1)"],
    [{ markets: [] }, "no market"],
    [{ markets: "eldorado" }, "markets not a list"],
    [{ labels: ["Only one"] }, "labels count"],
    [{ labels: ["A", 2] }, "label not text"],
    [{ removeSlots: [k1, k2] }, "remove everything"],
    [{ removeSlots: ["12:100:zzz:1"] }, "remove unknown"],
    [{ slotOrder: [k1] }, "order not a permutation"],
    [{ slotOrder: [k1, k1] }, "order repeats"],
    [{ removeSlots: [k2], slotOrder: [k2, k1] }, "order names a removed slot"],
    [{ texts: { title: 5 } }, "title not text"],
    [{ texts: { subtitle: "x" } }, "unknown text field"],
    [{ texts: { coverBullets: "one" } }, "bullets not a list"],
    [{ name: "" }, "empty name"],
  ]) {
    refused(await post("/products/" + p._id, body), 400, what);
  }
  refused(await post("/products/not-an-id", { name: "x" }), 400, "bad id");
  refused(await post("/products/" + GHOST_ID, { name: "x" }), 404, "unknown id");
  const after = await CodeProduct.findById(p._id).lean();
  assert.deepEqual(after, before);
});

test("POST /products/:id: a retired product is 409; an edit onto another product's set is 409", async () => {
  const gone = await addProduct({ status: "retired" });
  refused(await post("/products/" + gone._id, { name: "x" }), 409, "retired");
  const k1 = "12:100:one:1";
  const k2 = "12:100:two:1";
  await addProduct({ slots: [slot(k1, "One")], status: "active", origin: "manual" });
  const p = await addProduct({ slots: [slot(k1, "One"), slot(k2, "Two")] });
  const r = refused(await post("/products/" + p._id, { removeSlots: [k2] }), 409, "set taken");
  assert.ok(r.productId);
  assert.equal((await CodeProduct.findById(p._id).lean()).slots.length, 2);
});

test("POST /products/:id on an active product updates its offer and, with pushLive, its live Eldorado offers", async () => {
  const offer = await AccountOffer.create({ title: "Old title", description: "Old", deliveryTemplate: "Old:\n{password}", priceUsd: 1, minPriceUsd: 0.5 });
  const p = await addProduct({ status: "active", offer: offer._id, origin: "manual" });
  const rows = await MarketplaceListing.create([
    { marketplace: "eldorado", externalId: "E1", accountOffer: offer._id, status: "active", title: "Old", price: 1 },
    { marketplace: "eldorado", externalId: "E2", accountOffer: offer._id, status: "active", title: "Old", price: 1 },
    { marketplace: "eldorado", externalId: "E3", accountOffer: offer._id, status: "delisted", title: "Old", price: 1 },
    { marketplace: "ggsel", externalId: "G1", accountOffer: offer._id, status: "active", title: "Old", price: 1 },
  ]);
  mpFail.add("E2");
  const title = "Overwatch 2 | 2 Codes Bundle | One + Two | Fresh";
  const r = ok(
    await post("/products/" + p._id, {
      name: "Live one",
      texts: { title, description: "Fresh text", coverBullets: ["Fast", "Safe"] },
      pricing: { priceUsd: 3, floorUsd: 2 },
      pushLive: true,
    }),
  );
  const q = await CodeProduct.findById(p._id).lean();
  assert.equal(q.status, "active");
  assert.equal(q.texts.title, title);
  assert.equal(q.pricing.priceUsd, 3);
  assert.equal(q.name, "Live one");
  const o = await AccountOffer.findById(offer._id).lean();
  assert.equal(o.title, title);
  assert.equal(o.description, "Fresh text");
  assert.equal(o.deliveryTemplate, "Old:\n{password}", "a text not sent stays as the offer has it (R5)");
  assert.equal(o.coverServiceText, "", "a text not sent stays as the offer has it (R5)");
  assert.deepEqual(o.coverBullets, ["Fast", "Safe"]);
  assert.equal(o.priceUsd, 3);
  assert.equal(o.minPriceUsd, 2);

  // Only the ACTIVE ELDORADO rows, one call each, with the new texts and price.
  assert.deepEqual(
    mpCalls.map((c) => c.id),
    ["E1", "E2"],
  );
  assert.deepEqual(mpCalls[0].patch, { title, description: "Fresh text", priceUsd: 3 });
  assert.deepEqual(
    r.live.map((x) => [x.externalId, x.ok]),
    [
      ["E1", true],
      ["E2", false],
    ],
  );
  assert.match(r.live[1].error, /Eldorado said no/);
  assert.match(r.message, /could not be updated/);
  const e1 = await MarketplaceListing.findById(rows[0]._id).lean();
  assert.deepEqual([e1.title, e1.description, e1.price], [title, "Fresh text", 3]);
  const e2 = await MarketplaceListing.findById(rows[1]._id).lean();
  assert.deepEqual([e2.title, e2.price], ["Old", 1], "a refused push leaves the row as it was");
  assert.equal(r.product.id, String(p._id));
  const ev = callsOf("events.log").at(-1).args[0];
  assert.equal(ev.level, "warn");
  assert.equal(ev.data.actor, ROOT);
});

test("POST /products/:id on a paused product: price only, no push, no market call", async () => {
  const offer = await AccountOffer.create({ title: "T", priceUsd: 1, minPriceUsd: 0.5 });
  const p = await addProduct({ status: "paused", offer: offer._id });
  const r = ok(await post("/products/" + p._id, { pricing: { priceUsd: 1.75 } }));
  assert.equal(r.live, undefined);
  assert.equal(mpCalls.length, 0);
  assert.equal((await AccountOffer.findById(offer._id).lean()).priceUsd, 1.75);
  assert.equal((await CodeProduct.findById(p._id).lean()).status, "paused");
});

test("POST /products/:id on an active product: slots and markets are fixed, buyer text is guarded", async () => {
  const offer = await AccountOffer.create({ title: "Old title", priceUsd: 1 });
  const p = await addProduct({ status: "active", offer: offer._id });
  await MarketplaceListing.create({ marketplace: "eldorado", externalId: "E1", accountOffer: offer._id, status: "active" });
  for (const [body, what] of [
    [{ labels: ["A", "B"] }, "labels"],
    [{ slotOrder: [] }, "slotOrder"],
    [{ removeSlots: [] }, "removeSlots"],
    [{ markets: ["eldorado"] }, "markets"],
    [{ pushLive: "yes" }, "pushLive flag"],
    [{}, "nothing"],
  ]) {
    refused(await post("/products/" + p._id, body), 400, what);
  }
  const r = refused(
    await post("/products/" + p._id, { texts: { title: "Codes from the official SOOP event" }, pushLive: true }),
    400,
    "source word",
  );
  assert.ok(Array.isArray(r.problems) && r.problems.some((x) => /names where the codes come from/.test(x)), JSON.stringify(r.problems));
  refused(await post("/products/" + p._id, { texts: { deliveryTemplate: "No placeholder" } }), 400, "no {password}");
  assert.equal(mpCalls.length, 0);
  assert.equal((await AccountOffer.findById(offer._id).lean()).title, "Old title");
  assert.equal((await CodeProduct.findById(p._id).lean()).texts.title, p.texts.title);
});

// ---- DELETE /products/:id ----------------------------------------------------------------

test("DELETE /products/:id deletes a draft without an offer, nothing else", async () => {
  const d = await addProduct();
  assert.equal(ok(await del("/products/" + d._id)).deleted, 1);
  assert.equal(await CodeProduct.exists({ _id: d._id }), null);
  const live = await addProduct({ status: "active", offer: new mongoose.Types.ObjectId() });
  refused(await del("/products/" + live._id), 409, "active");
  const odd = await addProduct({ offer: new mongoose.Types.ObjectId() });
  refused(await del("/products/" + odd._id), 409, "draft with an offer");
  refused(await del("/products/" + GHOST_ID), 404, "unknown");
  refused(await del("/products/zzz"), 400, "bad id");
  assert.equal(await CodeProduct.countDocuments(), 2);
});

// ---- publisher actions -----------------------------------------------------------------

test("POST /approve passes actor and flags and spreads the result", async () => {
  const r = ok(await post(`/products/${GHOST_ID}/approve`, { rebalance: true, publish: false }));
  assert.equal(r.ok, true);
  assert.equal(r.built, 3);
  assert.deepEqual(callsOf("publisher.approve")[0].args, [GHOST_ID, { actor: ROOT, rebalance: true, publish: false }]);
  refused(await post(`/products/${GHOST_ID}/approve`, { rebalance: "yes" }), 400, "flag");
  refused(await post("/products/nope/approve", {}), 400, "bad id");
  assert.equal(callsOf("publisher.approve").length, 1);
});

test("POST /approve: ok:false with problems is a 400 carrying the problems; not found is 404", async () => {
  behave["publisher.approve"] = () => ({ ok: false, problems: ["title is empty", "no market chosen"] });
  const r = refused(await post(`/products/${GHOST_ID}/approve`, { rebalance: false, publish: true }), 400, "problems");
  assert.deepEqual(r.problems, ["title is empty", "no market chosen"]);
  assert.match(r.message, /^Not approved: title is empty; no market chosen$/);
  behave["publisher.approve"] = () => ({ ok: false, problems: ["product not found"] });
  refused(await post(`/products/${GHOST_ID}/approve`, {}), 404, "not found");
});

test("POST /publish, /pause, /resume, /retire pass the actor, spread the result and refuse ok:false", async () => {
  const pub = ok(await post(`/products/${GHOST_ID}/publish`));
  assert.equal(pub.results[0].externalId, "E-new");
  assert.deepEqual(callsOf("publisher.publishProduct")[0].args, [GHOST_ID, { actor: ROOT }]);
  assert.equal(ok(await post(`/products/${GHOST_ID}/pause`)).delisted, 1);
  assert.deepEqual(ok(await post(`/products/${GHOST_ID}/resume`)).publish, { results: [] });
  assert.equal(ok(await post(`/products/${GHOST_ID}/retire`)).dissolved, 2);
  for (const a of ["pause", "resume", "retire"]) {
    assert.deepEqual(callsOf("publisher." + a)[0].args, [GHOST_ID, { actor: ROOT }]);
  }

  behave["publisher.publishProduct"] = () => ({ results: [], error: "product not found" });
  refused(await post(`/products/${GHOST_ID}/publish`), 404, "publish not found");
  behave["publisher.publishProduct"] = () => ({ results: [], error: "only an approved, active product is published (this one is draft)" });
  refused(await post(`/products/${GHOST_ID}/publish`), 400, "publish draft");
  behave["publisher.publishProduct"] = () => ({ results: [{ market: "eldorado", ok: false, error: "limit" }] });
  ok(await post(`/products/${GHOST_ID}/publish`), "per-market errors are reported, not refused");

  behave["publisher.pause"] = () => ({ ok: false, error: "a draft product cannot be paused" });
  const r = refused(await post(`/products/${GHOST_ID}/pause`), 400, "pause draft");
  assert.match(r.message, /cannot be paused/);
  behave["publisher.pause"] = () => ({ ok: false, delisted: 0, errors: ["E1: timeout"] });
  refused(await post(`/products/${GHOST_ID}/pause`), 502, "pause market error");
  behave["publisher.resume"] = () => ({ ok: false, problems: ["title is empty"] });
  assert.deepEqual(refused(await post(`/products/${GHOST_ID}/resume`), 400, "resume").problems, ["title is empty"]);
  behave["publisher.retire"] = () => ({ ok: false, error: "product not found" });
  refused(await post(`/products/${GHOST_ID}/retire`), 404, "retire not found");
  for (const a of ["publish", "pause", "resume", "retire"]) refused(await post(`/products/bad/${a}`), 400, a + " bad id");
});

test("POST /scan answers { competitors }; an unknown product is 404 without a scan", async () => {
  const p = await addProduct();
  const r = ok(await post(`/products/${p._id}/scan`));
  assert.equal(r.competitors.lowestSameSetUsd, 1.2);
  assert.deepEqual(callsOf("competitors.scan")[0].args, [String(p._id)]);
  refused(await post(`/products/${GHOST_ID}/scan`), 404, "unknown");
  assert.equal(callsOf("competitors.scan").length, 1);
});

test("POST /texts/reset rebuilds a draft's default texts from its saved labels; not on an active product", async () => {
  const p = await addProduct({ texts: { title: "Mangled", description: "x", deliveryTemplate: "no placeholder" } });
  // A sold code of the product's group dates its event (no campaign row here).
  await addRows({ groupKey: "12:100", nameRaw: "Old Reward", earnedAt: NOW - 4 * DAY, state: "sold", count: 1 });
  const r = ok(await post(`/products/${p._id}/texts/reset`));
  const q = await CodeProduct.findById(p._id).lean();
  const expected = defaultTexts({
    slots: q.slots,
    guide: guideFor("12", deepMerge(DEFAULTS, {})),
    useBy: null,
    now: NOW,
    eventStarts: [new Date(NOW - 4 * DAY)],
  });
  assert.deepEqual({ ...q.texts }, expected);
  assert.match(q.texts.title, /\| Event \d+ \w{3} 2026 \|/);
  assert.equal(r.product.texts.title, expected.title);
  const live = await addProduct({ status: "active", offer: new mongoose.Types.ObjectId() });
  refused(await post(`/products/${live._id}/texts/reset`), 409, "active");
  refused(await post(`/products/${GHOST_ID}/texts/reset`), 404, "unknown");
});

// ---- after sale ---------------------------------------------------------------------------

test("POST /units/:id/report passes slot, status, note and actor; bad input is 400", async () => {
  const r = ok(await post(`/units/${GHOST_ID}/report`, { slot: 1, status: "dead", note: " used already " }));
  assert.equal(r.state, "dead");
  assert.equal(r.slot, 1);
  assert.deepEqual(callsOf("afterSale.report")[0].args, [GHOST_ID, { slot: 1, status: "dead", note: "used already", actor: ROOT }]);
  ok(await post(`/units/${GHOST_ID}/report`, { slot: "0", status: "ok" }));
  assert.deepEqual(callsOf("afterSale.report")[1].args[1], { slot: 0, status: "ok", note: "", actor: ROOT });
  for (const [body, what] of [
    [{ slot: 0, status: "gone" }, "status"],
    [{ slot: 0 }, "no status"],
    [{ slot: -1, status: "ok" }, "negative slot"],
    [{ slot: 1.5, status: "ok" }, "fraction slot"],
    [{ slot: "x", status: "ok" }, "text slot"],
    [{ status: "ok" }, "no slot"],
    [{ slot: 0, status: "ok", note: "n".repeat(501) }, "long note"],
  ]) {
    refused(await post(`/units/${GHOST_ID}/report`, body), 400, what);
  }
  refused(await post("/units/nope/report", { slot: 0, status: "ok" }), 400, "bad id");
  behave["afterSale.report"] = () => {
    throw Object.assign(new Error("Only a sold code can be reported"), { status: 409 });
  };
  const e = refused(await post(`/units/${GHOST_ID}/report`, { slot: 0, status: "dead" }), 409, "not sold");
  assert.equal(e.message, "Only a sold code can be reported");
  assert.equal(callsOf("afterSale.report").length, 3);
});

test("POST /units/:id/replace answers exactly { code, label, codeShape }, no-store, never logged", async () => {
  const before = logged.length;
  const r = await post(`/units/${GHOST_ID}/replace`, { slot: 2 });
  ok(r, "replace");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(Object.keys(r.json).sort(), ["code", "codeShape", "label", "success"]);
  assert.equal(r.json.code, CODE);
  assert.equal(r.json.label, "Sun Tea");
  assert.deepEqual(callsOf("afterSale.replace")[0].args, [GHOST_ID, { slot: 2, actor: ROOT }]);

  behave["afterSale.replace"] = () => {
    throw Object.assign(new Error("No usable replacement code for this reward is in stock"), { status: 409 });
  };
  const none = await post(`/units/${GHOST_ID}/replace`, { slot: 2 });
  refused(none, 409, "none in stock");
  assert.equal(none.headers.get("cache-control"), "no-store");
  const badSlot = await post(`/units/${GHOST_ID}/replace`, { slot: "first" });
  refused(badSlot, 400, "bad slot");
  assert.equal(badSlot.headers.get("cache-control"), "no-store");
  refused(await post("/units/nope/replace", { slot: 0 }), 400, "bad id");
  behave["afterSale.replace"] = () => ({ label: "Sun Tea" });
  refused(await post(`/units/${GHOST_ID}/replace`, { slot: 0 }), 500, "no code came back");
  assert.ok(!logged.slice(before).some((l) => l.includes(CODE)), "the code is never logged");
});

// ---- adopt, config, run -----------------------------------------------------------------

test("GET /adopt/candidates and POST /adopt", async () => {
  const c = ok(await get("/adopt/candidates"));
  assert.equal(c.candidates[0].title, "Hand-made");
  const r = ok(await post("/adopt", { offerId: GHOST_ID, apply: true }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.report, { units: 2, codes: 4 });
  assert.deepEqual(callsOf("adopt.adopt")[0].args, [GHOST_ID, { apply: true, actor: ROOT }]);
  ok(await post("/adopt", { offerId: GHOST_ID }));
  assert.deepEqual(callsOf("adopt.adopt")[1].args[1], { apply: false, actor: ROOT });
  behave["adopt.adopt"] = () => ({ ok: false, problems: ["a code has no ledger row"], report: { units: 1 } });
  const no = ok(await post("/adopt", { offerId: GHOST_ID, apply: false }), "a check that finds problems is still an answer");
  assert.equal(no.ok, false);
  refused(await post("/adopt", { offerId: "nope" }), 400, "bad offerId");
  refused(await post("/adopt", {}), 400, "no offerId");
  refused(await post("/adopt", { offerId: GHOST_ID, apply: "yes" }), 400, "apply flag");
  assert.equal(callsOf("adopt.adopt").length, 3);
});

test("POST /config unwraps body.patch, takes a bare patch, passes the actor and refuses a bad patch with 400", async () => {
  const r = ok(await post("/config", { patch: { autoPublish: true } }));
  assert.equal(r.config.autoPublish, true);
  assert.deepEqual(callsOf("config.set")[0].args, [{ autoPublish: true }, { actor: ROOT }]);
  ok(await post("/config", { digest: { hourUtc: 5 } }));
  assert.deepEqual(callsOf("config.set")[1].args, [{ digest: { hourUtc: 5 } }, { actor: ROOT }]);
  refused(await post("/config", { patch: [1, 2] }), 400, "list patch");
  refused(await post("/config", { patch: "x" }), 400, "text patch");
  behave["config.set"] = () => {
    throw Object.assign(new Error("Invalid code shop settings: unknown key nope"), { status: 400, errors: ["unknown key nope"] });
  };
  const e = refused(await post("/config", { patch: { nope: 1 } }), 400, "bad patch");
  assert.deepEqual(e.errors, ["unknown key nope"]);
});

test("POST /run runs one step and answers { result }", async () => {
  const r = ok(await post("/run", { step: "fill" }));
  assert.deepEqual(r.result, { step: "fill", ran: true });
  assert.deepEqual(callsOf("service.runStep")[0].args, ["fill"]);
  refused(await post("/run", {}), 400, "no step");
  refused(await post("/run", { step: { $gt: "" } }), 400, "object step");
  behave["service.runStep"] = () => {
    throw Object.assign(new Error("Unknown step: nope"), { status: 400 });
  };
  refused(await post("/run", { step: "nope" }), 400, "unknown step");
});

// ---- review fixes (docs/code-shop/05-REVIEW-FIXES.md) ----------------------------------

const QUEUED_CALLS = ["publisher.approve", "publisher.publishProduct", "publisher.resume", "publisher.retire", "adopt.adopt", "held.release"];
const QUEUED_ROUTES = [
  [`/products/${GHOST_ID}/approve`, {}],
  [`/products/${GHOST_ID}/publish`, {}],
  [`/products/${GHOST_ID}/resume`, {}],
  [`/products/${GHOST_ID}/retire`, {}],
  ["/adopt", { offerId: GHOST_ID, apply: true }],
  [`/held/${GHOST_ID}/release`, {}],
];

test("R1: a draft edit naming GGSel is refused with the reason, and nothing is written", async () => {
  const p = await addProduct();
  const before = await CodeProduct.findById(p._id).lean();
  const r = refused(await post("/products/" + p._id, { markets: ["eldorado", "ggsel"] }), 400, "ggsel");
  assert.equal(r.message, "GGSel is not used for codes yet: it never reports which code it sold, so a code could be sold twice");
  assert.deepEqual(await CodeProduct.findById(p._id).lean(), before);
});

test("R3: approve, publish, resume, retire, adopt (apply) and held release run inside service.exclusive; pause and the adopt check do not", async () => {
  for (const [path, body] of QUEUED_ROUTES) ok(await post(path, body), path);
  for (const name of QUEUED_CALLS) {
    const c = callsOf(name);
    assert.equal(c.length, 1, name);
    assert.equal(c[0].queued, true, name + " ran inside the tick queue");
  }
  assert.equal(callsOf("service.exclusive").length, QUEUED_ROUTES.length);
  ok(await post(`/products/${GHOST_ID}/pause`));
  ok(await post("/adopt", { offerId: GHOST_ID, apply: false }));
  assert.equal(callsOf("publisher.pause")[0].queued, false);
  assert.equal(callsOf("adopt.adopt")[1].queued, false, "a check only reads");
  assert.equal(callsOf("service.exclusive").length, QUEUED_ROUTES.length);
});

test("R3: a queued action waits for the job ahead of it; a refusal comes back through the queue and the queue goes on", async () => {
  let release;
  const tick = exclusive(() => new Promise((resolve) => (release = resolve)));
  const pending = post(`/products/${GHOST_ID}/approve`, { publish: true });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(callsOf("publisher.approve").length, 0, "approve waits for the running tick");
  release("tick done");
  assert.equal(await tick, "tick done");
  ok(await pending, "approve after the tick");
  assert.equal(callsOf("publisher.approve").length, 1);

  behave["publisher.retire"] = () => {
    throw Object.assign(new Error("Empty its GGSel vault first"), { status: 409 });
  };
  assert.match(refused(await post(`/products/${GHOST_ID}/retire`), 409, "retire refused").message, /GGSel vault/);
  behave["publisher.resume"] = () => ({ ok: false, problems: ["title is empty"] });
  refused(await post(`/products/${GHOST_ID}/resume`), 400, "resume refused");
  delete behave["publisher.resume"];
  ok(await post(`/products/${GHOST_ID}/resume`), "the queue goes on after a failed job");
});

test("R3: without service.exclusive the queued actions answer 503 and call nothing", async () => {
  for (const [path, body] of QUEUED_ROUTES) {
    const r = refused(await call("POST", "/api/code-shop" + path, body, "noQueue"), 503, path);
    assert.match(r.message, /nothing was done/);
  }
  for (const name of QUEUED_CALLS) assert.equal(callsOf(name).length, 0, name);
  ok(await call("POST", `/api/code-shop/products/${GHOST_ID}/pause`, {}, "noQueue"), "pause is not queued");
  ok(await call("POST", "/api/code-shop/adopt", { offerId: GHOST_ID }, "noQueue"), "an adopt check is not queued");
});

test("R5: an active product's edit writes only the fields sent AND changed; the price goes live only when priceUsd changed", async () => {
  const offer = await AccountOffer.create({ title: "Offer title", description: "Offer text", deliveryTemplate: "Offer:\n{password}", priceUsd: 4, minPriceUsd: 0.5 });
  const p = await addProduct({ status: "active", offer: offer._id, origin: "manual", pricing: { mode: "fixed", priceUsd: 4, floorUsd: 0.5 } });
  const row = await MarketplaceListing.create({
    marketplace: "eldorado",
    externalId: "E1",
    accountOffer: offer._id,
    status: "active",
    title: "Live title",
    description: "Live text",
    price: 4.4,
  });
  const stored = p.toObject();
  const r = ok(
    await post("/products/" + p._id, {
      name: stored.name,
      texts: { title: stored.texts.title, description: "New text", coverBullets: [...stored.texts.coverBullets] },
      pricing: { mode: "fixed", priceUsd: 4, floorUsd: 1, clearance: false },
      pushLive: true,
    }),
  );
  assert.deepEqual([...r.changed].sort(), ["pricing.floorUsd", "texts.description"]);
  assert.deepEqual(r.sent, ["description"]);
  assert.deepEqual(mpCalls, [{ id: "E1", patch: { description: "New text" } }], "no title, no price");
  assert.deepEqual(r.live.map((x) => [x.externalId, x.ok]), [["E1", true]]);
  const o = await AccountOffer.findById(offer._id).lean();
  assert.deepEqual([o.title, o.description, o.deliveryTemplate, o.priceUsd, o.minPriceUsd], ["Offer title", "New text", "Offer:\n{password}", 4, 1]);
  const l = await MarketplaceListing.findById(row._id).lean();
  assert.deepEqual([l.title, l.description, l.price], ["Live title", "New text", 4.4], "the live price row is not touched");
  const q = await CodeProduct.findById(p._id).lean();
  assert.deepEqual([q.texts.description, q.pricing.floorUsd, q.pricing.priceUsd], ["New text", 1, 4]);
  assert.deepEqual(callsOf("events.log").at(-1).args[0].data.fields.sort(), ["pricing.floorUsd", "texts.description"]);

  // The price itself changes: now it is pushed, and only it.
  mpCalls.length = 0;
  const r2 = ok(await post("/products/" + p._id, { pricing: { priceUsd: 5 }, pushLive: true }));
  assert.deepEqual(r2.sent, ["priceUsd"]);
  assert.deepEqual(mpCalls, [{ id: "E1", patch: { priceUsd: 5 } }]);
  assert.equal((await AccountOffer.findById(offer._id).lean()).priceUsd, 5);
  assert.deepEqual(
    (({ title, description, price }) => [title, description, price])(await MarketplaceListing.findById(row._id).lean()),
    ["Live title", "New text", 5],
  );

  // Without pushLive nothing reaches Eldorado, whatever changed.
  mpCalls.length = 0;
  const r3 = ok(await post("/products/" + p._id, { texts: { title: "Overwatch 2 | 2 Codes Bundle | One + Two | New" }, pricing: { priceUsd: 6 } }));
  assert.equal(r3.live, undefined);
  assert.equal(mpCalls.length, 0);
  const o3 = await AccountOffer.findById(offer._id).lean();
  assert.deepEqual([o3.title, o3.priceUsd], ["Overwatch 2 | 2 Codes Bundle | One + Two | New", 6]);
});

test("R5: fields sent unchanged are 'Nothing to change' and write nothing; pushLive with only a floor change calls no market", async () => {
  const offer = await AccountOffer.create({ title: "Offer title", priceUsd: 1, minPriceUsd: 0.5 });
  const p = await addProduct({ status: "active", offer: offer._id, origin: "manual" });
  await MarketplaceListing.create({ marketplace: "eldorado", externalId: "E1", accountOffer: offer._id, status: "active", title: "Live", price: 1 });
  const stored = p.toObject();
  const same = {
    name: stored.name,
    texts: stored.texts,
    pricing: { mode: "fixed", priceUsd: 1, floorUsd: 0.5, clearance: false, followCompetitors: false },
  };
  const before = await CodeProduct.findById(p._id).lean();
  assert.match(refused(await post("/products/" + p._id, same), 400, "all the same").message, /Nothing to change/);
  assert.match(refused(await post("/products/" + p._id, { ...same, pushLive: true }), 400, "all the same, pushLive").message, /nothing is sent to Eldorado/);
  assert.deepEqual(await CodeProduct.findById(p._id).lean(), before);
  assert.equal(mpCalls.length, 0);
  assert.equal((await AccountOffer.findById(offer._id).lean()).title, "Offer title");

  const r = ok(await post("/products/" + p._id, { pricing: { priceUsd: 1, floorUsd: 0.75 }, pushLive: true }));
  assert.equal(mpCalls.length, 0);
  assert.deepEqual(r.live, []);
  assert.deepEqual(r.sent, []);
  assert.match(r.message, /Nothing was sent to Eldorado/);
  const o = await AccountOffer.findById(offer._id).lean();
  assert.deepEqual([o.priceUsd, o.minPriceUsd], [1, 0.75]);
});

test("R5: an adopted product cannot switch to auto pricing (400); a fixed-price edit is fine", async () => {
  const offer = await AccountOffer.create({ title: "Hand-made", priceUsd: 2 });
  const p = await addProduct({ status: "active", offer: offer._id, origin: "adopted", pricing: { mode: "fixed", priceUsd: 2, floorUsd: 0.5 } });
  assert.match(refused(await post("/products/" + p._id, { pricing: { mode: "auto" } }), 400, "auto").message, /adopted/i);
  refused(await post("/products/" + p._id, { pricing: { mode: "auto", followCompetitors: true, priceUsd: 3 }, pushLive: true }), 400, "auto and more");
  const q = await CodeProduct.findById(p._id).lean();
  assert.deepEqual([q.pricing.mode, q.pricing.priceUsd], ["fixed", 2]);
  ok(await post("/products/" + p._id, { pricing: { mode: "fixed", priceUsd: 2.5 } }));
  assert.equal((await CodeProduct.findById(p._id).lean()).pricing.priceUsd, 2.5);
  assert.equal((await AccountOffer.findById(offer._id).lean()).priceUsd, 2.5);
});

test("R6: POST /held/:id/release releases through held.js inside the queue and answers { row } without the code's hash", async () => {
  const id = "0123456789abcdef0123abcd";
  const r = ok(await post(`/held/${id}/release`));
  assert.deepEqual(callsOf("held.release")[0].args, [id, { actor: ROOT }]);
  assert.equal(callsOf("held.release")[0].queued, true);
  assert.equal(r.row.id, id);
  assert.equal(r.row.state, "in_stock");
  assert.equal(r.row.loginId, "login-9");
  assert.equal(r.row.useBy, new Date(NOW + 5 * DAY).toISOString());
  assert.ok(!/must-not-leave/.test(JSON.stringify(r)), "no hash or sealed code in the answer");
  assert.ok(heldBuilt.includes(fakeService.deps), "built from the service's deps");
  const built = heldBuilt.length;
  // A bare row as the answer works too, and is cleaned the same way.
  behave["held.release"] = (rowId) => ({ _id: rowId, state: "in_stock", codeHash: "hash-must-not-leave" });
  const bare = ok(await post(`/held/${id}/release`));
  assert.equal(bare.row.id, id);
  assert.ok(!/must-not-leave/.test(JSON.stringify(bare)));
  assert.equal(heldBuilt.length, built, "held.js is built once");

  behave["held.release"] = () => {
    throw Object.assign(new Error("Its code is in another listing's stock; it stays held"), { status: 409 });
  };
  assert.match(refused(await post(`/held/${id}/release`), 409, "stays held").message, /stays held/);
  behave["held.release"] = () => {
    throw Object.assign(new Error("No held code with that id"), { status: 404 });
  };
  refused(await post(`/held/${id}/release`), 404, "unknown");
  refused(await post("/held/nope/release"), 400, "bad id");
  assert.equal(callsOf("held.release").length, 4);
});

test("R8: CODE_SHOP=0 answers 503 on every route and calls nothing; sign-in is still checked first", async () => {
  const before = process.env.CODE_SHOP;
  process.env.CODE_SHOP = "0";
  try {
    for (const [method, path] of TABLE) {
      const p = path.replace(":id", GHOST_ID);
      const r = refused(await call(method, p, method === "POST" ? {} : undefined), 503, `${method} ${path}`);
      assert.equal(r.message, "The code shop is switched off");
    }
    assert.equal((await call("GET", "/api/code-shop/state", undefined, "anon")).status, 401);
  } finally {
    if (before === undefined) delete process.env.CODE_SHOP;
    else process.env.CODE_SHOP = before;
  }
  assert.equal(calls.length, 0);
  ok(await get("/state"), "on again");
});

test("R8: a 401/403 from a market is answered as 502, never as a sign-out", async () => {
  behave["publisher.pause"] = () => {
    throw Object.assign(new Error("Eldorado: 401 Unauthorized"), { status: 401 });
  };
  const r = refused(await post(`/products/${GHOST_ID}/pause`), 502, "401");
  assert.match(r.message, /Eldorado: 401 Unauthorized/);
  assert.equal(r.marketStatus, 401);
  behave["publisher.approve"] = () => {
    throw Object.assign(new Error("GGSel: forbidden"), { status: 403 });
  };
  assert.equal(refused(await post(`/products/${GHOST_ID}/approve`), 502, "403 in the queue").marketStatus, 403);
  const p = await addProduct();
  behave["competitors.scan"] = () => {
    throw Object.assign(new Error("Eldorado: 403"), { status: 403 });
  };
  refused(await post(`/products/${p._id}/scan`), 502, "scan 403");
  behave["views.state"] = () => {
    throw Object.assign(new Error("Eldorado: 401"), { status: 401 });
  };
  refused(await get("/state"), 502, "state 401");
});

test("R8: a product is scanned at most once per 10 minutes (429 + Retry-After); other products are not held up", async () => {
  const p = await addProduct();
  const q = await addProduct({ slots: [slot("12:100:cccc:1", "Three")] });
  ok(await post(`/products/${p._id}/scan`));
  clock = NOW + 4 * 60 * 1000;
  const again = await post(`/products/${p._id}/scan`);
  assert.match(refused(again, 429, "within 10 min").message, /again in 6 minutes/);
  assert.equal(again.headers.get("retry-after"), "360");
  ok(await post(`/products/${q._id}/scan`), "another product");
  refused(await post(`/products/${GHOST_ID}/scan`), 404, "an unknown product is still 404");
  clock = NOW + 10 * 60 * 1000;
  ok(await post(`/products/${p._id}/scan`), "after 10 minutes");
  assert.equal(callsOf("competitors.scan").length, 3);
});

test("R6: without a createHeld option the router uses utils/codeShop/held.js, built from the service's deps", async () => {
  const realPost = (path) => call("POST", "/api/code-shop" + path, {}, "realHeld");
  refused(await realPost(`/held/${GHOST_ID}/release`), 404, "no such row in the ledger");
  await addRows({ nameRaw: "Sun Tea Icon", count: 1 });
  const row = await CodeStock.findOne({}).lean();
  refused(await realPost(`/held/${row._id}/release`), 409, "an in-stock row is not held");
  assert.equal((await CodeStock.findById(row._id).lean()).state, "in_stock", "nothing written");
  assert.equal(callsOf("service.exclusive").length, 2, "both ran in the queue");
});
