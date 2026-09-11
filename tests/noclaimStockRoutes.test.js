/* global fetch */
// Route tests for routes/noclaimStockRoutes.js — the No-claim Shop listings
// API (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §9).
//
// The failures these exist to prevent:
//
//  1. A CREDENTIAL LEAK. GET /noclaim-stock/sets/:id/accounts lists the farm
//     accounts that could fill a listing, built from candidate objects that
//     may carry anything. The assertion is on the SERIALISED body, so a future
//     spread cannot slip a password, token, email or pool id past a
//     field-by-field check.
//  2. A LIVE LISTING WHOSE ITEMS CHANGE UNDER IT. Gameflip / GGSel / Plati hold
//     accounts picked for the current items, so an items edit while a row is
//     active is a 409 — unless the "change" is the form re-sending the items
//     the set already has, which must never block a rename.
//  3. A SET PROMISING WHAT NO ACCOUNT HOLDS. Items come from the holdings
//     snapshot (name/game/image too — never trusted from the page) and a qty
//     is clamped to the most copies any one account holds.
//  4. A NO-CLAIM SET BORN AS SOMETHING ELSE: on the Shop, in the public
//     catalog, or — on a server whose DropSet model lacks stockSource — as a
//     plain Drop-archive listing that "Sell on…" would sell from the archive.
//  5. THE KILL SWITCH IGNORED. settings.noclaimShop.enabled:false stops every
//     write here while the reads keep answering.
//
// No Mongo, no network beyond the loopback server: every model and sibling
// module is stubbed through Module._load, as tests/manualSoldRemoval.test.js
// does. The hook stays installed for the whole file because the router
// requires its sibling modules lazily, inside the handlers — and those files
// may not exist on disk yet, so stubs are matched by path, not by resolving.
process.env.CRED_SECRET ||= "test-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");
const express = require("express");

const ROOT = path.resolve(__dirname, "..");

// Three farm accounts. Alpha Pack: most copies on one account = 3 (alpha).
// SMELLS LIKE BURNING: alpha's copy has no image, so beta's is the first one.
const HOLDINGS = [
  {
    loginLower: "alpha",
    login: "Alpha",
    items: [
      { itemKey: "alpha pack|overwatch 2", name: "Alpha Pack", game: "Overwatch 2", image: "https://img/alpha.png", qty: 3 },
      { itemKey: "smells like burning|overwatch 2", name: "SMELLS LIKE BURNING", game: "Overwatch 2", image: "", qty: 1 },
    ],
  },
  {
    loginLower: "beta",
    login: "Beta",
    items: [
      { itemKey: "alpha pack|overwatch 2", name: "Alpha Pack", game: "Overwatch 2", image: "", qty: 1 },
      { itemKey: "smells like burning|overwatch 2", name: "SMELLS LIKE BURNING", game: "Overwatch 2", image: "https://img/burn.png", qty: 2 },
    ],
  },
  {
    loginLower: "gamma",
    login: "Gamma",
    items: [
      { itemKey: "operator skin|rainbow six siege", name: "Operator Skin", game: "Rainbow Six Siege", image: "https://img/op.png", qty: 1 },
    ],
  },
];

let state;
function reset() {
  state = {
    settings: { enabled: true, autoDeliver: true, refreshBudget: 77 },
    settingsThrow: false,
    broken: new Set(), // stub keys whose require() throws
    holdings: structuredClone(HOLDINGS),
    snapshotThrows: false,
    summary: { accounts: 3, read: 3, fresh: 2, stale: 1, neverRead: 0, failed: 0, sweeping: false },
    lastPass: { at: "2026-09-11T00:00:00.000Z", spent: 0 },
    games: [{ game: "Overwatch 2", accounts: 2, free: 2, fresh: 2 }],
    pickerItems: [{ itemKey: "alpha pack|overwatch 2", name: "Alpha Pack", accounts: 2 }],
    pickerCalls: [],
    sweeping: false,
    sweepCalls: [],
    sweepImpl: () => Promise.resolve({ read: 0 }),
    sets: new Map(),
    created: [],
    updates: [],
    deleted: [],
    dropStockSource: false, // simulate a DropSet schema without the field
    rows: [],
    rowQueries: [],
    research: { game: "Overwatch 2", demandScore: 5 },
    researchQueries: [],
    engineThrows: false,
    engineCalls: [],
    stock: { free: 4, stale: 1, onAuto: 2, onManual: 1, covering: 8, snapshotAt: "2026-09-11T00:00:00.000Z" },
    stockCalls: [],
    candidates: [],
    freeCalls: [],
    runCalls: [],
    busts: 0,
    events: [],
  };
}
reset();

let seq = 0;
function oid() {
  seq += 1;
  return seq.toString(16).padStart(24, "0");
}

// A Mongoose query stand-in: every chained call is a no-op, lean() answers.
function chain(fn) {
  const c = {
    lean: async () => fn(),
    select: () => c,
    limit: () => c,
    sort: () => c,
  };
  return c;
}

const DropSetStub = {
  async create(doc) {
    state.created.push(structuredClone(doc));
    const now = new Date();
    const saved = { ...structuredClone(doc), _id: oid(), createdAt: now, updatedAt: now };
    // Mongoose strict mode silently drops a path the schema does not declare.
    if (state.dropStockSource) delete saved.stockSource;
    state.sets.set(saved._id, saved);
    return saved;
  },
  findById(id) {
    return chain(() => {
      const s = state.sets.get(String(id));
      return s ? structuredClone(s) : null;
    });
  },
  findOneAndUpdate(q, u, opts) {
    state.updates.push({ q, u, opts });
    return chain(() => {
      const cur = state.sets.get(String(q._id));
      if (!cur || (q.stockSource !== undefined && cur.stockSource !== q.stockSource)) return null;
      Object.assign(cur, structuredClone(u.$set || {}), { updatedAt: new Date() });
      return structuredClone(cur);
    });
  },
  deleteOne(q) {
    state.deleted.push(q);
    state.sets.delete(String(q._id));
    return Promise.resolve({ deletedCount: 1 });
  },
};

const ListingStub = {
  find(q) {
    state.rowQueries.push(q);
    return chain(() =>
      state.rows
        .filter((r) => String(r.set) === String(q.set) && (!q.status || r.status === q.status))
        .map((r) => ({ ...r })),
    );
  },
};

const ResearchStub = {
  findOne(q) {
    state.researchQueries.push(q);
    return chain(() => (state.research ? { ...state.research } : null));
  },
};

const settingsStub = {
  getNoclaimShopSettings() {
    if (state.settingsThrow) throw new Error("settings.json unreadable");
    return { ...state.settings };
  },
  getUnclaimedPricing: () => ({ floorUsd: 0.5, marker: "unclaimed-pricing" }),
  normGameName: (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim(),
};

const systemLogStub = {
  logEvent: (e) => {
    state.events.push(e);
  },
  actorFromReq: () => "admin:test",
};

const engineStub = {
  dropsFromSet(set) {
    return set.items.map((i) => ({
      name: i.name,
      game: i.game,
      campaign: "",
      imageURL: i.image,
      itemKey: i.itemKey,
      qty: i.qty,
    }));
  },
  async classificationForSet(set) {
    state.engineCalls.push({ fn: "classificationForSet", set: structuredClone(set) });
    return { event: "cls" };
  },
  listingTitle(game, drops) {
    if (state.engineThrows) throw new Error("bundles module exploded");
    return "ENGINE " + game + ": " + drops.map((d) => d.qty + "x " + d.name).join(" + ");
  },
  listingDescription(game, drops, marketplace, cls) {
    if (state.engineThrows) throw new Error("bundles module exploded");
    state.engineCalls.push({ fn: "listingDescription", game, marketplace, cls });
    return "ENGINE DESCRIPTION for " + game;
  },
  priceForItems(args) {
    if (state.engineThrows) throw new Error("pricing exploded");
    state.engineCalls.push({ fn: "priceForItems", args });
    return { price: 4.257, floor: 1.499 };
  },
};

const holdingsStub = {
  async summary() {
    return { ...state.summary };
  },
  async pickerGames() {
    return state.games;
  },
  async pickerItems(opts) {
    state.pickerCalls.push(opts);
    return state.pickerItems;
  },
  isSweeping: () => state.sweeping,
  sweepOnce(opts) {
    state.sweepCalls.push(opts);
    return state.sweepImpl(opts);
  },
  async snapshotBase() {
    if (state.snapshotThrows) throw new Error("atlas timeout");
    return {
      at: Date.now(),
      maxAgeMs: 8 * 3600 * 1000,
      holdings: structuredClone(state.holdings),
      ledgerByLogin: new Map(),
      activeLogins: new Set(),
      poolById: new Map(),
    };
  },
};

// The pure helpers behave as contract §3 describes them.
const stockStub = {
  async stockForSet(set) {
    state.stockCalls.push(set);
    return { ...state.stock };
  },
  async freeCandidates(set, opts) {
    state.freeCalls.push({ set, opts });
    return structuredClone(state.candidates);
  },
  requiredFromSet(set) {
    return new Map((set.items || []).map((i) => [i.itemKey, i.qty || 1]));
  },
  heldCounts(items) {
    const m = new Map();
    for (const it of items || [])
      m.set(it.itemKey, (m.get(it.itemKey) || 0) + (it.qty == null ? 1 : it.qty));
    return m;
  },
  extraLoad(held, required) {
    let h = 0;
    for (const v of held.values()) h += v;
    let r = 0;
    for (const v of required.values()) r += v;
    return Math.max(0, h - r);
  },
};

const listingsStub = {
  async runPass(opts) {
    state.runCalls.push(opts);
    return { spent: 1, settled: 2 };
  },
  status: () => ({ running: false, lastPass: state.lastPass }),
};

const archiveStub = {
  bustSetsCache: () => {
    state.busts += 1;
  },
};

const STUBS = new Map([
  ["models/DropSet", DropSetStub],
  ["models/MarketplaceListing", ListingStub],
  ["models/MarketResearch", ResearchStub],
  ["utils/settings", settingsStub],
  ["utils/systemLog", systemLogStub],
  ["utils/unclaimedAutoList", engineStub],
  ["utils/noclaimHoldings", holdingsStub],
  ["utils/noclaimStock", stockStub],
  ["utils/noclaimListings", listingsStub],
  ["routes/dropArchiveRoutes", archiveStub],
]);

// Relative requests only, resolved by hand to a repo-relative key, so a stub
// answers whether or not the real file exists.
function stubKey(request, parent) {
  if (typeof request !== "string" || !request.startsWith(".")) return "";
  const from = parent && parent.filename ? path.dirname(parent.filename) : ROOT;
  const rel = path.relative(ROOT, path.resolve(from, request)).split(path.sep).join("/");
  return rel.replace(/\.js$/, "");
}

const origLoad = Module._load;
let server;
let baseUrl;

test.before(async () => {
  Module._load = function (request, parent, isMain) {
    const key = stubKey(request, parent);
    if (key && state.broken.has(key)) {
      const err = new Error("Cannot find module '" + request + "'");
      err.code = "MODULE_NOT_FOUND";
      throw err;
    }
    if (key && STUBS.has(key)) return STUBS.get(key);
    return origLoad.apply(this, arguments);
  };
  const routerPath = require.resolve("../routes/noclaimStockRoutes");
  delete require.cache[routerPath];
  const router = require("../routes/noclaimStockRoutes");

  const app = express();
  app.use(express.json());
  // Stub session: a superadmin unless the request asks to be someone else.
  app.use((req, res, next) => {
    const role = req.get("x-test-role") || "superadmin";
    req.session =
      role === "anonymous" ? {} : { admin: { id: "root", username: "root", role, tfa: true } };
    next();
  });
  app.use(router);
  app.use((req, res) => res.status(404).json({ success: false, message: "Route not found" }));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;
});

test.after(async () => {
  Module._load = origLoad;
  if (server) await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(() => reset());

async function call(method, urlPath, opts = {}) {
  const headers = { Accept: "application/json" };
  if (opts.role) headers["x-test-role"] = opts.role;
  const init = { method, headers };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(baseUrl + urlPath, init);
  const raw = await res.text();
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  return { status: res.status, body, raw };
}

function seedSet(extra = {}) {
  const at = new Date("2026-09-10T00:00:00.000Z");
  const set = {
    _id: oid(),
    name: "OW2 starter",
    note: "",
    price: 3,
    listed: false,
    publicCatalog: false,
    custom: false,
    sourceType: "",
    stockSource: "noclaim",
    coverGame: "Overwatch 2",
    items: [
      { itemKey: "alpha pack|overwatch 2", name: "Alpha Pack", game: "Overwatch 2", image: "", qty: 2 },
    ],
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
  state.sets.set(set._id, set);
  return set;
}

// The route logs every fallback it takes; keep the test output readable.
function quietConsoleError() {
  const orig = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  return {
    lines,
    restore: () => {
      console.error = orig;
    },
  };
}

// ---------------------------------------------------------------------------
// Auth + module loading
// ---------------------------------------------------------------------------

test("every route is superadmin-only, and a path the router does not own falls through", async () => {
  const id = "a".repeat(24);
  const routes = [
    ["GET", "/noclaim-stock/summary"],
    ["GET", "/noclaim-stock/games"],
    ["GET", "/noclaim-stock/items"],
    ["POST", "/noclaim-stock/refresh"],
    ["POST", "/noclaim-stock/copy"],
    ["POST", "/noclaim-stock/sets"],
    ["PUT", "/noclaim-stock/sets/" + id],
    ["GET", "/noclaim-stock/sets/" + id + "/stock"],
    ["GET", "/noclaim-stock/sets/" + id + "/accounts"],
    ["POST", "/noclaim-stock/run"],
  ];
  for (const [method, p] of routes) {
    const body = method === "GET" ? undefined : {};
    const anon = await call(method, p, { role: "anonymous", body });
    assert.equal(anon.status, 401, "anonymous " + method + " " + p);
    const plain = await call(method, p, { role: "admin", body });
    assert.equal(plain.status, 403, "plain admin " + method + " " + p);
  }
  // server.js mounts this router at "/": it must not 401 a path it does not own.
  const other = await call("GET", "/somewhere-else", { role: "anonymous" });
  assert.equal(other.status, 404);
  assert.equal(state.sweepCalls.length + state.created.length + state.runCalls.length, 0);
});

test("a missing sibling module answers 503 on the endpoints that need it, not the others", async () => {
  state.broken.add("utils/noclaimHoldings");
  const games = await call("GET", "/noclaim-stock/games");
  assert.equal(games.status, 503);
  assert.equal(games.body.code, "module_unavailable");
  assert.match(games.body.message, /noclaimHoldings/);

  state.broken = new Set(["utils/noclaimListings"]);
  const summary = await call("GET", "/noclaim-stock/summary");
  assert.equal(summary.status, 200, "the snapshot numbers survive a broken listings module");
  assert.equal(summary.body.lastPass, null);
  const run = await call("POST", "/noclaim-stock/run", { body: {} });
  assert.equal(run.status, 503);
  assert.equal(run.body.code, "module_unavailable");
});

// ---------------------------------------------------------------------------
// Snapshot reads
// ---------------------------------------------------------------------------

test("reads: summary carries the pass's lastPass, games/items wrap the picker, params are trimmed", async () => {
  const s = await call("GET", "/noclaim-stock/summary");
  assert.equal(s.status, 200);
  assert.equal(s.body.success, true);
  assert.equal(s.body.sweeping, false);
  assert.equal(s.body.read, 3);
  assert.deepEqual(s.body.lastPass, state.lastPass);

  const g = await call("GET", "/noclaim-stock/games");
  assert.deepEqual(g.body, { success: true, games: state.games });

  const i = await call("GET", "/noclaim-stock/items?game=%20Overwatch%202%20&search=%20alpha%20");
  assert.deepEqual(i.body, { success: true, items: state.pickerItems });
  assert.deepEqual(state.pickerCalls, [{ game: "Overwatch 2", search: "alpha" }]);
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

test("kill switch: enabled:false refuses every write before anything runs; reads and copy still answer", async () => {
  const set = seedSet();
  state.settings.enabled = false;
  const writes = [
    ["POST", "/noclaim-stock/refresh", {}],
    ["POST", "/noclaim-stock/sets", { name: "X", items: [{ itemKey: "alpha pack|overwatch 2", qty: 1 }] }],
    ["PUT", "/noclaim-stock/sets/" + set._id, { name: "Renamed" }],
    ["POST", "/noclaim-stock/run", {}],
  ];
  for (const [method, p, body] of writes) {
    const r = await call(method, p, { body });
    assert.equal(r.status, 503, method + " " + p);
    assert.equal(r.body.success, false);
    assert.equal(r.body.message, "No-claim listings are switched off");
  }
  assert.equal(state.sweepCalls.length, 0);
  assert.equal(state.created.length, 0);
  assert.equal(state.updates.length, 0);
  assert.equal(state.runCalls.length, 0);
  assert.equal(state.sets.get(set._id).name, "OW2 starter");
  assert.equal(state.busts, 0);

  for (const p of [
    "/noclaim-stock/summary",
    "/noclaim-stock/games",
    "/noclaim-stock/items",
    "/noclaim-stock/sets/" + set._id + "/stock",
    "/noclaim-stock/sets/" + set._id + "/accounts",
  ]) {
    assert.equal((await call("GET", p)).status, 200, p);
  }
  const copy = await call("POST", "/noclaim-stock/copy", {
    body: { items: [{ itemKey: "alpha pack|overwatch 2", qty: 1 }] },
  });
  assert.equal(copy.status, 200, "copy writes nothing, so the switch does not gate it");
});

test("kill switch: an unreadable settings block counts as the defaults (on, refreshBudget 120)", async () => {
  state.settingsThrow = true;
  const r = await call("POST", "/noclaim-stock/refresh", { body: {} });
  assert.equal(r.status, 200);
  assert.equal(state.sweepCalls[0].budget, 120);
});

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

test("refresh: 409 while a sweep runs; otherwise starts one and answers without waiting for it", async () => {
  state.sweeping = true;
  const busy = await call("POST", "/noclaim-stock/refresh", { body: {} });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.success, false);
  assert.equal(state.sweepCalls.length, 0);

  state.sweeping = false;
  let finish = null;
  state.sweepImpl = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const r = await call("POST", "/noclaim-stock/refresh", { body: { game: "  Overwatch 2 " } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { success: true, started: true });
  assert.deepEqual(state.sweepCalls, [{ budget: 77, game: "Overwatch 2", reason: "refresh" }]);
  assert.equal(typeof finish, "function", "answered while the sweep was still running");
  finish({ read: 5 });

  // A hand-edited budget is held to the contract's 1..400.
  state.settings.refreshBudget = 5000;
  await call("POST", "/noclaim-stock/refresh", { body: {} });
  assert.equal(state.sweepCalls[1].budget, 400);
});

test("refresh: a sweep that fails later never becomes an unhandled rejection", async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  const quiet = quietConsoleError();
  try {
    state.sweepImpl = () => Promise.reject(new Error("pi unreachable"));
    const r = await call("POST", "/noclaim-stock/refresh", { body: {} });
    assert.equal(r.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(unhandled.length, 0);
    assert.ok(quiet.lines.some((l) => l.includes("pi unreachable")), "the failure is logged");
  } finally {
    quiet.restore();
    process.off("unhandledRejection", onUnhandled);
  }
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

test("copy: the engine's title/description/price over the snapshot's items, research matched case-insensitively", async () => {
  const r = await call("POST", "/noclaim-stock/copy", {
    body: {
      items: [
        { itemKey: "Alpha Pack|Overwatch 2", qty: 5 },
        { itemKey: "smells like burning|overwatch 2", qty: 1 },
      ],
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  // qty clamped to the 3 copies the richest holder has; names from the snapshot.
  assert.equal(r.body.title, "ENGINE Overwatch 2: 3x Alpha Pack + 1x SMELLS LIKE BURNING");
  assert.equal(r.body.description, "ENGINE DESCRIPTION for Overwatch 2");
  assert.equal(r.body.price, 4.26);
  assert.equal(r.body.floor, 1.5);

  const cls = state.engineCalls.find((c) => c.fn === "classificationForSet");
  assert.equal(cls.set.coverGame, "Overwatch 2");
  assert.equal(cls.set.items[1].image, "https://img/burn.png");
  const desc = state.engineCalls.find((c) => c.fn === "listingDescription");
  assert.equal(desc.marketplace, undefined, "neutral support line: no market is chosen yet");
  assert.deepEqual(desc.cls, { event: "cls" });
  const priced = state.engineCalls.find((c) => c.fn === "priceForItems").args;
  assert.equal(priced.game, "Overwatch 2");
  assert.deepEqual(priced.cls, { event: "cls" });
  assert.deepEqual(priced.research, state.research);
  assert.equal(priced.pricing.marker, "unclaimed-pricing");
  assert.deepEqual(
    priced.items.map((i) => [i.itemKey, i.qty]),
    [
      ["alpha pack|overwatch 2", 3],
      ["smells like burning|overwatch 2", 1],
    ],
  );
  assert.equal(state.researchQueries.length, 1);
  assert.ok(state.researchQueries[0].game.test("overwatch 2"));
  assert.ok(!state.researchQueries[0].game.test("overwatch 2 classic"));
});

test("copy: never fails — engine errors and a dead snapshot fall back to copy from the item names", async () => {
  const quiet = quietConsoleError();
  try {
    state.engineThrows = true;
    const r = await call("POST", "/noclaim-stock/copy", {
      body: {
        items: [
          { itemKey: "alpha pack|overwatch 2", qty: 2 },
          { itemKey: "smells like burning|overwatch 2" },
        ],
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.title, "Overwatch 2 Twitch Drops (3 Items) — 2× Alpha Pack + SMELLS LIKE BURNING");
    assert.match(r.body.description, /^- 2× Alpha Pack$/m);
    assert.match(r.body.description, /^- SMELLS LIKE BURNING$/m);
    assert.equal(r.body.price, 0);
    assert.equal(r.body.floor, 0);

    // Snapshot down: the page's own name/game still make a title.
    state.engineThrows = false;
    state.snapshotThrows = true;
    const dark = await call("POST", "/noclaim-stock/copy", {
      body: { items: [{ itemKey: "mystery drop|valorant", qty: 2, name: "Mystery Drop", game: "VALORANT" }] },
    });
    assert.equal(dark.status, 200);
    assert.equal(dark.body.title, "ENGINE VALORANT: 2x Mystery Drop");

    const empty = await call("POST", "/noclaim-stock/copy", { body: { items: [] } });
    assert.deepEqual(empty.body, { success: true, title: "", description: "", price: 0, floor: 0 });
  } finally {
    quiet.restore();
  }
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

test("create: validation errors are 400s and never write a set", async () => {
  const one = [{ itemKey: "alpha pack|overwatch 2" }];
  const cases = [
    [{ items: one }, /Name required/],
    [{ name: "   ", items: one }, /Name required/],
    [{ name: "X", price: -1, items: one }, /Invalid price/],
    [{ name: "X", price: "abc", items: one }, /Invalid price/],
    [{ name: "X" }, /Pick at least one item/],
    [{ name: "X", items: [] }, /Pick at least one item/],
    [
      { name: "X", items: Array.from({ length: 101 }, (_, n) => ({ itemKey: "item " + n + "|overwatch 2" })) },
      /Too many items/,
    ],
  ];
  for (const [body, re] of cases) {
    const r = await call("POST", "/noclaim-stock/sets", { body });
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(r.body.success, false);
    assert.match(r.body.message, re);
  }
  const unknown = await call("POST", "/noclaim-stock/sets", {
    body: { name: "X", items: [...one, { itemKey: "Ghost Item|Overwatch 2" }] },
  });
  assert.equal(unknown.status, 400);
  assert.deepEqual(unknown.body.unknown, ["ghost item|overwatch 2"]);
  assert.match(unknown.body.message, /ghost item\|overwatch 2/);
  assert.equal(state.created.length, 0);
  assert.equal(state.busts, 0);
});

test("create: items come from the snapshot, qty is clamped, and the set is born no-claim", async () => {
  const r = await call("POST", "/noclaim-stock/sets", {
    body: {
      name: "  OW2 duo  ",
      note: " two items ",
      price: "4.256",
      items: [
        // The page's name/game must never beat the snapshot's.
        { itemKey: "Alpha Pack|Overwatch 2", qty: 5, name: "HACKED", game: "Fortnite" },
        { itemKey: "smells like burning|overwatch 2", qty: 0 },
      ],
    },
  });
  assert.equal(r.status, 200);
  assert.equal(state.created.length, 1);
  const doc = state.created[0];
  assert.equal(doc.stockSource, "noclaim");
  assert.equal(doc.listed, false);
  assert.equal(doc.publicCatalog, false, "the schema default is true — it must be set");
  assert.equal(doc.custom, false);
  assert.equal(doc.sourceType, "");
  assert.equal(doc.name, "OW2 duo");
  assert.equal(doc.note, "two items");
  assert.equal(doc.price, 4.26);
  assert.equal(doc.coverGame, "Overwatch 2");
  assert.deepEqual(doc.items, [
    { itemKey: "alpha pack|overwatch 2", name: "Alpha Pack", game: "Overwatch 2", image: "https://img/alpha.png", qty: 3 },
    { itemKey: "smells like burning|overwatch 2", name: "SMELLS LIKE BURNING", game: "Overwatch 2", image: "https://img/burn.png", qty: 1 },
  ]);

  assert.deepEqual(Object.keys(r.body.set).sort(), [
    "coverGame",
    "createdAt",
    "custom",
    "id",
    "itemCount",
    "items",
    "listed",
    "name",
    "note",
    "price",
    "stockSource",
    "updatedAt",
  ]);
  assert.match(r.body.set.id, /^[a-f0-9]{24}$/);
  assert.equal(r.body.set.stockSource, "noclaim");
  assert.equal(r.body.set.itemCount, 2);
  assert.equal(state.busts, 1, "the Listings page's sets cache is cleared");
  const ev = state.events.find((e) => e.action === "set_created");
  assert.equal(ev.category, "noclaim_shop");
});

test("create: a mixed-game bundle takes the first item's game; the archive editor's itemKeys shape works", async () => {
  const r = await call("POST", "/noclaim-stock/sets", {
    body: {
      name: "Mixed",
      itemKeys: ["operator skin|rainbow six siege", "alpha pack|overwatch 2"],
      itemQuantities: { "alpha pack|overwatch 2": 2 },
    },
  });
  assert.equal(r.status, 200);
  const doc = state.created[0];
  assert.equal(doc.coverGame, "Rainbow Six Siege");
  assert.deepEqual(
    doc.items.map((i) => [i.itemKey, i.qty]),
    [
      ["operator skin|rainbow six siege", 1],
      ["alpha pack|overwatch 2", 2],
    ],
  );
});

test("create: a DropSet model without stockSource removes the set instead of keeping an archive listing", async () => {
  state.dropStockSource = true;
  const r = await call("POST", "/noclaim-stock/sets", {
    body: { name: "X", items: [{ itemKey: "alpha pack|overwatch 2" }] },
  });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "model_outdated");
  assert.equal(state.deleted.length, 1);
  assert.equal(state.sets.size, 0);
  assert.equal(state.busts, 0);
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

test("update: a bad id, a missing set, an archive set and bad fields are refused without a write", async () => {
  const archive = seedSet({ stockSource: "" });
  const set = seedSet();
  assert.equal((await call("PUT", "/noclaim-stock/sets/not-an-id", { body: { name: "X" } })).status, 400);
  assert.equal((await call("PUT", "/noclaim-stock/sets/" + "f".repeat(24), { body: { name: "X" } })).status, 404);
  const arch = await call("PUT", "/noclaim-stock/sets/" + archive._id, { body: { name: "X" } });
  assert.equal(arch.status, 400);
  assert.equal(arch.body.code, "not_noclaim");
  for (const [body, re] of [
    [{ name: "" }, /Name required/],
    [{ price: -2 }, /Invalid price/],
    [{ items: [] }, /Pick at least one item/],
    [{ items: [{ itemKey: "nobody holds this|overwatch 2" }] }, /nobody holds this/],
  ]) {
    const r = await call("PUT", "/noclaim-stock/sets/" + set._id, { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.message, re);
  }
  assert.equal(state.updates.length, 0);
});

test("update: name/note/price always; an items change while a row is live is a 409", async () => {
  const set = seedSet();
  state.rows.push({ _id: "r1", set: set._id, status: "active", marketplace: "ggsel", externalId: "g-1" });
  state.rows.push({ _id: "r0", set: set._id, status: "delisted", marketplace: "gameflip", externalId: "gf-0" });

  // The form re-sends the items the set already has: a rename, not an items
  // change — so no 409, and not even a snapshot read (it is down here).
  state.snapshotThrows = true;
  const rename = await call("PUT", "/noclaim-stock/sets/" + set._id, {
    body: { name: "Renamed", note: "new note", price: 5.5, items: [{ itemKey: "alpha pack|overwatch 2", qty: 2 }] },
  });
  assert.equal(rename.status, 200);
  assert.equal(rename.body.set.name, "Renamed");
  assert.equal(rename.body.set.note, "new note");
  assert.equal(rename.body.set.price, 5.5);
  assert.deepEqual(
    rename.body.set.items.map((i) => [i.itemKey, i.qty]),
    [["alpha pack|overwatch 2", 2]],
  );
  assert.equal("items" in state.updates[0].u.$set, false);
  assert.equal(state.busts, 1);

  state.snapshotThrows = false;
  const change = await call("PUT", "/noclaim-stock/sets/" + set._id, {
    body: { items: [{ itemKey: "alpha pack|overwatch 2", qty: 3 }] },
  });
  assert.equal(change.status, 409);
  assert.equal(change.body.message, "Delist it first — live listings advertise the current items");
  assert.deepEqual(change.body.listings, [{ id: "r1", marketplace: "ggsel", externalId: "g-1" }]);
  assert.deepEqual(state.rowQueries.at(-1), { set: set._id, status: "active" });
  assert.equal(state.sets.get(set._id).items[0].qty, 2, "the live set is untouched");
  assert.equal(state.updates.length, 1);
});

test("update: a qty that clamps back to what the set already promises is not an items change", async () => {
  const set = seedSet({
    items: [{ itemKey: "alpha pack|overwatch 2", name: "Alpha Pack", game: "Overwatch 2", image: "", qty: 3 }],
  });
  state.rows.push({ _id: "r1", set: set._id, status: "active", marketplace: "gameflip", externalId: "gf-1" });
  // 5 asked, 3 is the most any account holds, and 3 is what the set says.
  const r = await call("PUT", "/noclaim-stock/sets/" + set._id, {
    body: { price: 7, items: [{ itemKey: "alpha pack|overwatch 2", qty: 5 }] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.set.price, 7);
  assert.equal("items" in state.updates[0].u.$set, false);
});

test("update: with no live row the items change, and an item that left the farm keeps its qty", async () => {
  const set = seedSet({
    items: [
      { itemKey: "ghost drop|overwatch 2", name: "Ghost Drop", game: "Overwatch 2", image: "https://img/ghost.png", qty: 4 },
    ],
  });
  const r = await call("PUT", "/noclaim-stock/sets/" + set._id, {
    body: {
      items: [
        { itemKey: "ghost drop|overwatch 2", qty: 4 },
        { itemKey: "operator skin|rainbow six siege", qty: 9 },
      ],
    },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.set.items, [
    { itemKey: "ghost drop|overwatch 2", name: "Ghost Drop", game: "Overwatch 2", image: "https://img/ghost.png", qty: 4 },
    { itemKey: "operator skin|rainbow six siege", name: "Operator Skin", game: "Rainbow Six Siege", image: "https://img/op.png", qty: 1 },
  ]);
  assert.equal(r.body.set.coverGame, "Overwatch 2");
  const { q, u, opts } = state.updates[0];
  assert.deepEqual(q, { _id: set._id, stockSource: "noclaim" });
  assert.equal(u.$set.listed, false);
  assert.equal(u.$set.publicCatalog, false);
  assert.equal(opts.runValidators, true);
  assert.equal(state.busts, 1);
});

// ---------------------------------------------------------------------------
// Stock, accounts, run
// ---------------------------------------------------------------------------

test("stock: the no-claim layer's numbers for a no-claim set, 400 for an archive set", async () => {
  const set = seedSet();
  const r = await call("GET", "/noclaim-stock/sets/" + set._id + "/stock");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { success: true, ...state.stock });
  assert.equal(String(state.stockCalls[0]._id), set._id);

  const archive = seedSet({ stockSource: "" });
  const a = await call("GET", "/noclaim-stock/sets/" + archive._id + "/stock");
  assert.equal(a.status, 400);
  assert.equal(state.stockCalls.length, 1);
});

test("accounts: five whitelisted fields and no secret, capped at 200 in the claim order", async () => {
  const set = seedSet({
    items: [{ itemKey: "alpha pack|overwatch 2", name: "Alpha Pack", game: "Overwatch 2", image: "", qty: 1 }],
  });
  const SECRET = {
    password: "PW-SENTINEL-4kd9",
    cipher: "ENC-SENTINEL-8hh2",
    clientSecret: "CS-SENTINEL-2mx7",
    email: "sentinel-9qz1@leak.test",
    pool: "POOL-SENTINEL-7ab3",
    twitch: "TWID-SENTINEL-5cc1",
  };
  state.candidates = Array.from({ length: 250 }, (_, n) => ({
    loginLower: "acct" + n,
    login: "Acct" + n,
    botId: "bot" + (n % 7),
    container: "noclaim-bot-" + (n % 7),
    game: "Overwatch 2",
    readAt: "2026-09-11T01:00:00.000Z",
    ledgerStatus: "",
    poolAccountId: SECRET.pool,
    twitchId: SECRET.twitch,
    password: SECRET.password,
    credPasswordEnc: SECRET.cipher,
    clientSecret: SECRET.clientSecret,
    email: SECRET.email,
    items: [
      { itemKey: "alpha pack|overwatch 2", qty: 1 + (n % 3) },
      { itemKey: "smells like burning|overwatch 2", qty: n === 0 ? 1 : 0 },
    ],
  }));
  const r = await call("GET", "/noclaim-stock/sets/" + set._id + "/accounts");
  assert.equal(r.status, 200);
  for (const v of Object.values(SECRET)) assert.equal(r.raw.includes(v), false, "leaked " + v);
  assert.equal(r.body.total, 250);
  assert.equal(r.body.accounts.length, 200);
  for (const a of r.body.accounts)
    assert.deepEqual(Object.keys(a).sort(), ["botId", "extra", "game", "login", "readAt"]);
  assert.deepEqual(r.body.accounts[0], {
    login: "Acct0",
    botId: "bot0",
    game: "Overwatch 2",
    readAt: "2026-09-11T01:00:00.000Z",
    extra: 1,
  });
  assert.equal(r.body.accounts[2].extra, 2);
  assert.equal(r.body.accounts[199].login, "Acct199", "the claim order is kept");
  assert.deepEqual(state.freeCalls[0].opts, { fresh: true });

  await call("GET", "/noclaim-stock/sets/" + set._id + "/accounts?fresh=0");
  assert.deepEqual(state.freeCalls[1].opts, { fresh: false });
});

test("run: hands off to the lifecycle pass without a sweep and returns its summary", async () => {
  const r = await call("POST", "/noclaim-stock/run", { body: {} });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { success: true, result: { spent: 1, settled: 2 } });
  assert.deepEqual(state.runCalls, [{ sweep: false }]);
  assert.ok(state.events.find((e) => e.action === "pass_run"));
});
