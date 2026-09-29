// Route tests for the Bulk packs API (routes/bulkPackRoutes.js,
// docs/bulk-packs/API-UI.md "Tests A8").
//
// Harness: the stub-session pattern of tests/dropSetsListLight.test.js — a
// throwaway Express app with a seeded session and the router mounted bare
// (enforce2fa is server.js's job; the wiring tripwires at the bottom pin it).
// send / loop / proposals / farmCapacity and the settings store are FAKES
// injected with __setDeps: no network, and the real utils/settings.json is
// never read or written. BulkOffer rows live in mongodb-memory-server.
/* global fetch */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.SESSION_SECRET ||= "bulk-packs-routes-test-secret";

const ROOT = path.join(__dirname, "..");
const realSettings = require("../utils/settings");
const BulkOffer = require("../models/BulkOffer");
const SystemEvent = require("../models/SystemEvent");
const bulkPackRoutes = require("../routes/bulkPackRoutes");
const { validateSettingsPatch, SETTINGS_KEYS } = bulkPackRoutes;

const OID = "0123456789abcdef01234567"; // well-formed, never stored

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------
const calls = []; // [name, args]
const count = (name) => calls.filter((c) => c[0] === name).length;
const last = (name) => {
  for (let i = calls.length - 1; i >= 0; i--)
    if (calls[i][0] === name) return calls[i][1];
  return undefined;
};

let af; // the fake autoFarm object
let noclaimShop;
const nextResult = {}; // send.js function name -> result to return (or Error to throw)

function baseAf(over = {}) {
  return {
    bulkPacksEnabled: true,
    bulkPacksMarkets: ["eldorado", "g2g", "gameflip"],
    bulkPackTiers: [
      { minQty: 5, discountPct: 5 },
      { minQty: 10, discountPct: 10 },
    ],
    bulkPackUnitsPerOffer: 20,
    eldoradoAutoDeliver: true,
    eldoradoDeliverDryRun: false,
    g2gAutoDeliver: true,
    g2gDeliverDryRun: true,
    ...over,
  };
}

// getBulkPacks is the REAL accessor, which is pure when handed an object.
const fakeSettings = {
  getAutoFarm: () => af,
  getNoclaimShopSettings: () => noclaimShop,
  getBulkPacks: (afIn) =>
    realSettings.getBulkPacks(afIn && typeof afIn === "object" ? afIn : af),
  setAutoFarm: async (patch, opts) => {
    calls.push(["setAutoFarm", { patch, opts }]);
    af = { ...af, ...patch };
    return af;
  },
};

function sendFn(name) {
  return async (args) => {
    calls.push([name, args]);
    const r = nextResult[name];
    if (r instanceof Error) throw r;
    return r !== undefined ? r : { success: true, status: 200 };
  };
}
const fakeSend = {
  sendOffer: sendFn("sendOffer"),
  refillOffer: sendFn("refillOffer"),
  pauseOffer: sendFn("pauseOffer"),
  resumeOffer: sendFn("resumeOffer"),
  withdrawOffer: sendFn("withdrawOffer"),
  withdrawAll: sendFn("withdrawAll"),
};

const LOOP_STATUS = {
  running: true,
  lastRunAt: "2026-09-30T00:00:00.000Z",
  lastSummary: null,
  lastError: "",
  passes: 4,
};
const SUMMARY = {
  open: 2,
  accounts: 1,
  farming: 1,
  sold: 1,
  paused: 0,
  retiring: 0,
  released: 0,
  errors: 0,
};
let runOnceGate = null; // a promise the fake pass waits on
const fakeLoop = {
  status: () => ({ ...LOOP_STATUS }),
  // A getter, so a test can see a handler reach the module (loadDep).
  get runOnce() {
    calls.push(["get:runOnce"]);
    return async () => {
      calls.push(["runOnce"]);
      if (runOnceGate) await runOnceGate;
      return { ...SUMMARY };
    };
  },
};

const fakeProposals = {
  accountProposals: async (opts) => {
    calls.push(["accountProposals", opts]);
    return {
      at: "2026-09-30T00:00:00.000Z",
      items: [{ source: "dropset", free: 12 }],
    };
  },
  farmProposals: async (opts) => {
    calls.push(["farmProposals", opts]);
    return {
      at: "2026-09-30T00:00:00.000Z",
      capacity: { bestStackRoom: 9 },
      advertisable: 4,
      items: [],
    };
  },
  invalidate: () => {
    calls.push(["invalidate"]);
  },
};

const CAPACITY = {
  bestStackRoom: 30,
  totalFree: 60,
  pristine: 50,
  at: "2026-09-30T00:00:00.000Z",
  error: "",
};
const fakeFarmCapacity = {
  read: async (opts) => {
    calls.push(["read", opts]);
    return { ...CAPACITY };
  },
  advertisable: (cap, bp) => {
    calls.push(["advertisable", { cap, bp }]);
    return 17;
  },
};

function reset(over = {}) {
  calls.length = 0;
  af = baseAf(over);
  noclaimShop = { enabled: true, autoDeliver: true };
  runOnceGate = null;
  for (const k of Object.keys(nextResult)) delete nextResult[k];
  bulkPackRoutes.__resetDeps();
  bulkPackRoutes.__setDeps({
    settings: fakeSettings,
    send: fakeSend,
    loop: fakeLoop,
    proposals: fakeProposals,
    farmCapacity: fakeFarmCapacity,
  });
}

async function until(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let mongod;
let server;
let baseUrl;
let superCookie;
let adminCookie;
const ids = {};

const T0 = Date.parse("2026-09-01T00:00:00Z");
const hour = (h) => new Date(T0 + h * 3600e3);

function offerDoc(over) {
  return {
    kind: "accounts",
    source: "dropset",
    market: "eldorado",
    set: null,
    setName: "Rust bundle",
    game: "Rust",
    days: 0,
    minQty: 5,
    discountPct: 5,
    anchorPrice: 1.25,
    anchorBasis: "listing",
    unitPrice: 1.19,
    packPrice: 0,
    title: "Rust Twitch Drops bundle — BULK 5+ accounts (5% off)",
    description: "long buyer copy that the list view never ships",
    listing: null,
    externalId: "",
    url: "",
    state: "live",
    open: true,
    slotKey: "slot",
    autoPaused: false,
    lowStock: false,
    reserved: [],
    advertisedQty: 0,
    unitsDelivered: 0,
    ordersCount: 0,
    revenueUsd: 0,
    lastOrderAt: null,
    lastSyncAt: null,
    lastCheckAt: null,
    lastError: "",
    history: [],
    createdBy: "admin:root",
    closedAt: null,
    createdAt: hour(0),
    updatedAt: hour(0),
    ...over,
  };
}

async function seedOffers() {
  for (const k of ["A", "B", "C", "D", "E"])
    ids[k] = new mongoose.Types.ObjectId();
  const unit = (login, state, extra = {}) => ({
    accountId: "acc-" + login,
    login,
    state,
    orderId: "",
    at: hour(1),
    changedAt: null,
    reason: "",
    ...extra,
  });
  // Raw inserts: createdAt must be controllable (Mongoose makes it immutable).
  await BulkOffer.collection.insertMany([
    offerDoc({
      _id: ids.A,
      slotKey: "accounts|dropset|a|eldorado|5",
      reserved: [
        unit("login-a1", "on_offer"),
        unit("login-a2", "on_offer"),
        unit("login-a3", "on_offer"),
        unit("login-a4", "retiring", { changedAt: hour(2) }),
        unit("login-a5", "delivered", { orderId: "ord-1" }),
        unit("login-a6", "released", { reason: "sold out" }),
      ],
      history: Array.from({ length: 70 }, (_, i) => ({
        at: hour(1),
        action: "h" + i,
        detail: "",
        actor: "system",
      })),
      unitsDelivered: 1,
      ordersCount: 1,
      revenueUsd: 1.19,
      createdAt: hour(1),
    }),
    offerDoc({
      _id: ids.B,
      kind: "farming",
      source: "farm",
      market: "g2g",
      days: 180,
      minQty: 10,
      state: "paused",
      autoPaused: true,
      advertisedQty: 12,
      slotKey: "farming|farm|Rust@180|g2g|10",
      createdAt: hour(2),
    }),
    offerDoc({
      _id: ids.C,
      market: "g2g",
      state: "sold_out",
      open: false,
      closedAt: hour(4),
      slotKey: "accounts|dropset|c|g2g|5",
      reserved: [unit("login-c1", "released"), unit("login-c2", "released")],
      unitsDelivered: 5,
      ordersCount: 2,
      revenueUsd: 5.95,
      createdAt: hour(3),
    }),
    offerDoc({
      _id: ids.D,
      source: "noclaim",
      state: "withdrawn",
      open: false,
      closedAt: hour(5),
      slotKey: "accounts|noclaim|d|eldorado|5",
      unitsDelivered: 2,
      ordersCount: 2,
      revenueUsd: 3,
      createdAt: hour(4),
    }),
    offerDoc({
      _id: ids.E,
      market: "gameflip",
      state: "error",
      open: false,
      closedAt: hour(6),
      slotKey: "accounts|dropset|e|gameflip|5",
      createdAt: hour(5),
    }),
  ]);
}

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("bulk-packs-routes-test"));
  await BulkOffer.init();
  await seedOffers();

  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
    }),
  );
  app.get("/test/session", (req, res) => {
    const id = String(req.query.id || "root");
    req.session.admin = {
      id,
      username: id,
      role: String(req.query.role || "superadmin"),
      tfa: true,
    };
    res.json({ success: true });
  });
  app.use(bulkPackRoutes);
  app.use((req, res) =>
    res.status(404).json({ success: false, message: "Route not found" }),
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;

  const seed = async (qs) =>
    (await fetch(baseUrl + "/test/session?" + qs)).headers
      .get("set-cookie")
      .split(";")[0];
  superCookie = await seed("role=superadmin&id=root");
  adminCookie = await seed("role=admin&id=seller1");
});

test.after(async () => {
  bulkPackRoutes.__resetDeps();
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test.beforeEach(() => reset());

async function call(method, p, { body, as = "super" } = {}) {
  const headers = { Accept: "application/json" };
  if (as === "super") headers.Cookie = superCookie;
  else if (as === "admin") headers.Cookie = adminCookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(baseUrl + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text };
}

const VALID_SEND = {
  source: "dropset",
  setId: OID,
  market: "eldorado",
  minQty: 5,
};

// ---------------------------------------------------------------------------
// Loading and auth
// ---------------------------------------------------------------------------

test("the router loads while send/loop/proposals/farmCapacity cannot be required", () => {
  const script = `
    const Module = require("module");
    const load = Module._load;
    Module._load = function (request) {
      if (/bulkPacks\\/(send|loop|proposals|farmCapacity)(\\.js)?$/.test(request)) {
        throw new Error("sibling module required at load time: " + request);
      }
      return load.apply(this, arguments);
    };
    const r = require(${JSON.stringify(path.join(ROOT, "routes", "bulkPackRoutes.js"))});
    const ok = typeof r === "function" && typeof r.validateSettingsPatch === "function";
    process.stdout.write(ok ? "loaded" : "bad export");
  `;
  const out = spawnSync(process.execPath, ["-e", script], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, "loaded");
});

const ENDPOINTS = [
  ["GET", "/api/bulk-packs/overview"],
  ["GET", "/api/bulk-packs/proposals/accounts"],
  ["GET", "/api/bulk-packs/proposals/farming"],
  ["GET", "/api/bulk-packs/offers"],
  ["GET", "/api/bulk-packs/offers/" + OID],
  ["POST", "/api/bulk-packs/send"],
  ["POST", "/api/bulk-packs/offers/" + OID + "/refill"],
  ["POST", "/api/bulk-packs/offers/" + OID + "/pause"],
  ["POST", "/api/bulk-packs/offers/" + OID + "/resume"],
  ["POST", "/api/bulk-packs/offers/" + OID + "/withdraw"],
  ["POST", "/api/bulk-packs/withdraw-all"],
  ["POST", "/api/bulk-packs/run-now"],
  ["GET", "/api/bulk-packs/settings"],
  ["POST", "/api/bulk-packs/settings"],
];
// Everything a handler would accept, so only the guard can stop the request.
const ANY_BODY = {
  ...VALID_SEND,
  add: 2,
  confirm: "WITHDRAW",
  patch: { bulkPacksEnabled: true },
};

test("every endpoint answers 401 without a session and 403 for a non-superadmin", async () => {
  for (const [method, p] of ENDPOINTS) {
    const body = method === "POST" ? ANY_BODY : undefined;
    const anon = await call(method, p, { body, as: "none" });
    assert.equal(anon.status, 401, method + " " + p);
    assert.equal(anon.body.success, false);
    const admin = await call(method, p, { body, as: "admin" });
    assert.equal(admin.status, 403, method + " " + p);
    assert.equal(admin.body.message, "Superadmin access required");
  }
  assert.deepEqual(calls, [], "no handler, fake or settings write was reached");
});

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

test("overview: settings, a gate per market and source, blocked markets, loop, counts, cached capacity", async () => {
  const r = await call("GET", "/api/bulk-packs/overview");
  assert.equal(r.status, 200);
  const b = r.body;
  assert.equal(b.success, true);
  assert.deepEqual(b.settings, realSettings.getBulkPacks(af));

  const { gates } = b;
  assert.deepEqual(
    Object.keys(gates).sort(),
    ["digiseller", "eldorado", "gameflip", "g2g", "ggsel", "plati"].sort(),
  );
  for (const m of ["eldorado", "g2g", "gameflip"]) {
    assert.deepEqual(
      Object.keys(gates[m]).sort(),
      ["dropset", "farm", "noclaim"],
      m,
    );
    for (const g of Object.values(gates[m])) {
      assert.equal(typeof g.ok, "boolean");
      assert.equal(typeof g.reason, "string");
    }
  }
  assert.deepEqual(gates.eldorado.dropset, { ok: true, reason: "" });
  assert.equal(gates.eldorado.noclaim.ok, true);
  assert.equal(gates.eldorado.farm.ok, true);
  assert.equal(gates.g2g.dropset.ok, false);
  assert.match(gates.g2g.dropset.reason, /dry-run/);
  assert.equal(gates.gameflip.dropset.ok, true, "gameflip delivery is native");
  assert.equal(gates.gameflip.noclaim.ok, false);
  assert.match(gates.gameflip.noclaim.reason, /does not carry/);
  assert.equal(gates.gameflip.farm.ok, false);
  for (const m of ["digiseller", "plati", "ggsel"]) {
    assert.equal(gates[m].blocked, true, m);
    assert.equal(
      gates[m].ok,
      undefined,
      m + " never reads as a gate that could open",
    );
  }

  assert.deepEqual(b.loop, LOOP_STATUS);
  assert.deepEqual(b.counts, {
    open: 2,
    byState: {
      sending: 0,
      live: 1,
      paused: 1,
      sold_out: 1,
      sold: 0,
      withdrawn: 1,
      expired: 0,
      error: 1,
    },
  });
  assert.deepEqual(b.capacity, { ...CAPACITY, advertisable: 17 });
  assert.equal(count("read"), 1);
  assert.ok(
    !(last("read") && last("read").force),
    "the overview uses the cached read",
  );
  assert.deepEqual(last("advertisable").bp, realSettings.getBulkPacks(af));
});

test("overview gates follow the settings: market switched off, no-claim delivery off, unreadable settings", async () => {
  reset({ bulkPacksMarkets: ["eldorado"] });
  noclaimShop = { enabled: true, autoDeliver: false };
  let b = (await call("GET", "/api/bulk-packs/overview")).body;
  assert.equal(b.gates.gameflip.dropset.ok, false);
  assert.match(b.gates.gameflip.dropset.reason, /switched off for bulk packs/);
  assert.equal(b.gates.eldorado.dropset.ok, true);
  assert.equal(b.gates.eldorado.noclaim.ok, false);
  assert.match(
    b.gates.eldorado.noclaim.reason,
    /No-claim Shop delivery is off/,
  );

  bulkPackRoutes.__setDeps({
    settings: {
      ...fakeSettings,
      getAutoFarm: () => {
        throw new Error("settings file unreadable");
      },
      getNoclaimShopSettings: () => {
        throw new Error("settings file unreadable");
      },
    },
  });
  const r = await call("GET", "/api/bulk-packs/overview");
  assert.equal(r.status, 200);
  b = r.body;
  assert.equal(b.settings.enabled, false, "unreadable settings read as OFF");
  for (const m of ["eldorado", "g2g", "gameflip"]) {
    for (const g of Object.values(b.gates[m])) assert.equal(g.ok, false, m);
  }
});

test("overview degrades instead of failing when loop / farmCapacity are unavailable", async () => {
  bulkPackRoutes.__setDeps({ loop: {}, farmCapacity: null });
  const r = await call("GET", "/api/bulk-packs/overview");
  assert.equal(r.status, 200);
  assert.equal(r.body.loop.running, false);
  assert.match(r.body.loop.error, /loop\.js/);
  assert.equal(r.body.capacity.advertisable, 0);
  assert.equal(r.body.capacity.bestStackRoom, 0);
  assert.match(r.body.capacity.error, /farmCapacity\.js/);
  assert.equal(r.body.counts.open, 2);
});

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

test("proposals pass ?refresh through and return the module's payload", async () => {
  let r = await call("GET", "/api/bulk-packs/proposals/accounts?refresh=1");
  assert.equal(r.status, 200);
  assert.deepEqual(last("accountProposals"), { refresh: true });
  assert.equal(r.body.success, true);
  assert.deepEqual(r.body.items, [{ source: "dropset", free: 12 }]);
  assert.equal(r.body.at, "2026-09-30T00:00:00.000Z");

  await call("GET", "/api/bulk-packs/proposals/accounts");
  assert.deepEqual(last("accountProposals"), { refresh: false });

  r = await call("GET", "/api/bulk-packs/proposals/farming?refresh=true");
  assert.deepEqual(last("farmProposals"), { refresh: true });
  assert.equal(r.body.advertisable, 4);
  assert.deepEqual(r.body.capacity, { bestStackRoom: 9 });
  assert.deepEqual(r.body.items, []);
});

test("proposals: a failing module is a 500, a missing one a 503", async () => {
  bulkPackRoutes.__setDeps({
    proposals: {
      accountProposals: async () => {
        throw new Error("boom");
      },
    },
  });
  let r = await call("GET", "/api/bulk-packs/proposals/accounts");
  assert.equal(r.status, 500);
  assert.equal(r.body.message, "boom");
  r = await call("GET", "/api/bulk-packs/proposals/farming");
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "module_unavailable");
  assert.equal(r.body.module, "utils/bulkPacks/proposals.js");
});

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

test("offers list: scope, newest first, counts instead of reserved[], no history/description, totals", async () => {
  let r = await call("GET", "/api/bulk-packs/offers?scope=open");
  assert.equal(r.status, 200);
  assert.equal(r.body.scope, "open");
  assert.deepEqual(
    r.body.offers.map((o) => o.id),
    [String(ids.B), String(ids.A)],
  );
  for (const o of r.body.offers) {
    assert.equal(o.reserved, undefined);
    assert.equal(o.history, undefined);
    assert.equal(o.description, undefined);
    assert.equal(o._id, o.id);
  }
  assert.ok(!r.text.includes("login-a"), "no login leaves the list endpoint");
  const a = r.body.offers[1];
  assert.equal(a.title, "Rust Twitch Drops bundle — BULK 5+ accounts (5% off)");
  assert.deepEqual(
    {
      reservedCount: a.reservedCount,
      freeCount: a.freeCount,
      retiringCount: a.retiringCount,
      deliveredCount: a.deliveredCount,
      releasedCount: a.releasedCount,
    },
    {
      reservedCount: 6,
      freeCount: 3,
      retiringCount: 1,
      deliveredCount: 1,
      releasedCount: 1,
    },
  );
  assert.equal(r.body.offers[0].reservedCount, 0);
  assert.equal(r.body.offers[0].advertisedQty, 12);
  assert.deepEqual(r.body.totals, {
    offers: 2,
    orders: 1,
    accounts: 1,
    revenueUsd: 1.19,
  });

  r = await call("GET", "/api/bulk-packs/offers?scope=closed");
  assert.deepEqual(
    r.body.offers.map((o) => o.id),
    [ids.E, ids.D, ids.C].map(String),
  );
  assert.deepEqual(r.body.totals, {
    offers: 3,
    orders: 4,
    accounts: 7,
    revenueUsd: 8.95,
  });

  r = await call("GET", "/api/bulk-packs/offers?scope=all&limit=2");
  assert.deepEqual(
    r.body.offers.map((o) => o.id),
    [ids.E, ids.D].map(String),
  );
  assert.equal(r.body.limit, 2);
  assert.deepEqual(r.body.totals, {
    offers: 5,
    orders: 5,
    accounts: 8,
    revenueUsd: 10.14,
  });

  r = await call("GET", "/api/bulk-packs/offers");
  assert.equal(r.body.scope, "all");
  assert.equal(r.body.offers.length, 5);
});

test("offers list: limit is clamped and an unknown scope is a 400", async () => {
  let r = await call("GET", "/api/bulk-packs/offers?limit=0");
  assert.equal(r.body.offers.length, 1);
  r = await call("GET", "/api/bulk-packs/offers?limit=99999");
  assert.equal(r.body.limit, 500);
  assert.equal(r.body.offers.length, 5);
  r = await call("GET", "/api/bulk-packs/offers?scope=live");
  assert.equal(r.status, 400);
  assert.equal(r.body.success, false);
});

test("offer detail: reserved[] with logins, the last 60 history entries, 404 on bad ids", async () => {
  const r = await call("GET", "/api/bulk-packs/offers/" + ids.A);
  assert.equal(r.status, 200);
  const o = r.body.offer;
  assert.equal(o.id, String(ids.A));
  assert.deepEqual(
    o.reserved.map((u) => [u.login, u.state]),
    [
      ["login-a1", "on_offer"],
      ["login-a2", "on_offer"],
      ["login-a3", "on_offer"],
      ["login-a4", "retiring"],
      ["login-a5", "delivered"],
      ["login-a6", "released"],
    ],
  );
  assert.equal(o.history.length, 60);
  assert.equal(o.history[0].action, "h10");
  assert.equal(o.history[59].action, "h69");
  assert.equal(o.description, "long buyer copy that the list view never ships");
  assert.equal(o.freeCount, 3);
  assert.ok(!/password/i.test(r.text));

  assert.equal(
    (await call("GET", "/api/bulk-packs/offers/not-an-id")).status,
    404,
  );
  assert.equal(
    (await call("GET", "/api/bulk-packs/offers/" + OID)).status,
    404,
  );
});

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

test("send answers with the status and message send.js returned", async () => {
  const cases = [
    { success: false, status: 409, message: "Bulk packs are switched off" },
    {
      success: false,
      status: 409,
      message: "G2G delivery is in dry-run (autoFarm.g2gDeliverDryRun)",
    },
    {
      success: false,
      status: 409,
      message: "only 7 free (keeping 5 for single listings)",
    },
    { success: false, status: 400, message: "no tier with minQty 5" },
    { success: false, status: 404, message: "bundle not found" },
    { success: false, status: 502, message: "Eldorado publish failed" },
    { success: false, status: 500, message: "orphan offer paused" },
    {
      success: true,
      status: 200,
      offer: { _id: OID, state: "live", reserved: [] },
    },
  ];
  for (const c of cases) {
    nextResult.sendOffer = c;
    const r = await call("POST", "/api/bulk-packs/send", { body: VALID_SEND });
    assert.equal(r.status, c.status, JSON.stringify(c));
    assert.equal(r.body.success, c.success);
    if (c.message) assert.equal(r.body.message, c.message);
    if (c.offer) assert.deepEqual(r.body.offer, c.offer);
  }
  assert.equal(count("sendOffer"), cases.length);
  assert.ok(
    count("invalidate") >= cases.length,
    "proposals are invalidated after every send",
  );

  nextResult.sendOffer = new Error("send.js threw");
  let r = await call("POST", "/api/bulk-packs/send", { body: VALID_SEND });
  assert.equal(r.status, 500);
  assert.equal(r.body.message, "send.js threw");

  nextResult.sendOffer = null;
  r = await call("POST", "/api/bulk-packs/send", { body: VALID_SEND });
  assert.equal(r.status, 500);
  assert.equal(r.body.success, false);
});

test("send forwards only whitelisted primitives, per source; the actor is the session's", async () => {
  await call("POST", "/api/bulk-packs/send", {
    body: {
      source: "Dropset",
      setId: OID,
      market: " Eldorado ",
      minQty: "5",
      units: "12",
      game: "ignored for a bundle",
      days: 120,
      actor: "admin:someone-else",
      extra: { $ne: null },
    },
  });
  assert.deepEqual(last("sendOffer"), {
    source: "dropset",
    setId: OID,
    game: undefined,
    days: undefined,
    market: "eldorado",
    minQty: 5,
    units: 12,
    actor: "admin:root",
  });

  await call("POST", "/api/bulk-packs/send", {
    body: {
      source: "farm",
      game: "  Rust ",
      days: "180",
      market: "g2g",
      minQty: 10,
      setId: OID,
    },
  });
  assert.deepEqual(last("sendOffer"), {
    source: "farm",
    setId: undefined,
    game: "Rust",
    days: 180,
    market: "g2g",
    minQty: 10,
    units: undefined,
    actor: "admin:root",
  });

  await call("POST", "/api/bulk-packs/send", {
    body: {
      source: "noclaim",
      setId: OID,
      market: "g2g",
      minQty: 10,
      units: null,
    },
  });
  assert.equal(last("sendOffer").source, "noclaim");
  assert.equal(last("sendOffer").units, undefined);
});

test("send refuses malformed bodies and blocked markets before send.js is called", async () => {
  const bad = [
    { ...VALID_SEND, market: "ggsel" },
    { ...VALID_SEND, market: "GGSel" },
    { ...VALID_SEND, market: "plati" },
    { ...VALID_SEND, market: "digiseller" },
    { ...VALID_SEND, market: "playerauctions" },
    { ...VALID_SEND, market: "zeusx" },
    { ...VALID_SEND, market: undefined },
    { ...VALID_SEND, source: "bogus" },
    { ...VALID_SEND, source: { $ne: null } },
    { ...VALID_SEND, source: undefined },
    { ...VALID_SEND, setId: undefined },
    { ...VALID_SEND, setId: "abc" },
    { ...VALID_SEND, setId: { $gt: "" } },
    { ...VALID_SEND, minQty: undefined },
    { ...VALID_SEND, minQty: 1 },
    { ...VALID_SEND, minQty: 101 },
    { ...VALID_SEND, minQty: 2.5 },
    { ...VALID_SEND, minQty: "five" },
    { ...VALID_SEND, units: 0 },
    { ...VALID_SEND, units: -3 },
    { ...VALID_SEND, units: 2.5 },
    { ...VALID_SEND, units: "lots" },
    { ...VALID_SEND, units: 501 },
    { ...VALID_SEND, units: [5] },
    { source: "farm", market: "eldorado", minQty: 5, days: 120 },
    { source: "farm", market: "eldorado", minQty: 5, game: "Rust" },
    { source: "farm", market: "eldorado", minQty: 5, game: "Rust", days: 0 },
    {
      source: "farm",
      market: "eldorado",
      minQty: 5,
      game: "Rust",
      days: "abc",
    },
    {
      source: "farm",
      market: "eldorado",
      minQty: 5,
      game: { $ne: "" },
      days: 120,
    },
    {
      source: "farm",
      market: "eldorado",
      minQty: 5,
      game: "x".repeat(201),
      days: 120,
    },
  ];
  for (const body of bad) {
    const r = await call("POST", "/api/bulk-packs/send", { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.success, false);
    assert.ok(r.body.message);
  }
  for (const m of ["ggsel", "plati", "digiseller"]) {
    const r = await call("POST", "/api/bulk-packs/send", {
      body: { ...VALID_SEND, market: m },
    });
    assert.match(r.body.message, /blocked/);
  }
  assert.equal(count("sendOffer"), 0);
});

test("switched off (I8): send / refill / resume are refused; pause, withdraw, withdraw-all and run-now still work", async () => {
  for (const over of [
    { bulkPacksEnabled: false },
    { bulkPacksEnabled: "true" },
    {},
  ]) {
    reset(over);
    if (!Object.keys(over).length) delete af.bulkPacksEnabled; // absent -> shipped default OFF
    let r = await call("POST", "/api/bulk-packs/send", { body: VALID_SEND });
    assert.equal(r.status, 409, JSON.stringify(over));
    assert.equal(r.body.message, "Bulk packs are switched off");
    r = await call("POST", "/api/bulk-packs/offers/" + OID + "/refill", {
      body: { add: 2 },
    });
    assert.equal(r.status, 409);
    r = await call("POST", "/api/bulk-packs/offers/" + OID + "/resume");
    assert.equal(r.status, 409);
    assert.equal(
      count("sendOffer") + count("refillOffer") + count("resumeOffer"),
      0,
    );

    assert.equal(
      (await call("POST", "/api/bulk-packs/offers/" + OID + "/pause")).status,
      200,
    );
    assert.equal(
      (await call("POST", "/api/bulk-packs/offers/" + OID + "/withdraw"))
        .status,
      200,
    );
    r = await call("POST", "/api/bulk-packs/withdraw-all", {
      body: { confirm: "WITHDRAW" },
    });
    assert.equal(r.status, 200);
    assert.equal((await call("POST", "/api/bulk-packs/run-now")).status, 200);
    assert.equal(count("pauseOffer"), 1);
    assert.equal(count("withdrawOffer"), 1);
    assert.equal(count("withdrawAll"), 1);
    assert.equal(count("runOnce"), 1);
  }
});

// ---------------------------------------------------------------------------
// Offer actions
// ---------------------------------------------------------------------------

test("refill validates add and forwards it; offer actions pass send.js status through; bad ids are 404", async () => {
  let r = await call("POST", "/api/bulk-packs/offers/" + OID + "/refill", {
    body: { add: "3" },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(last("refillOffer"), {
    offerId: OID,
    add: 3,
    actor: "admin:root",
  });
  for (const add of [undefined, 0, -2, 1.5, "x", 501, [3]]) {
    r = await call("POST", "/api/bulk-packs/offers/" + OID + "/refill", {
      body: { add },
    });
    assert.equal(r.status, 400, String(add));
  }
  assert.equal(count("refillOffer"), 1);

  nextResult.pauseOffer = {
    success: false,
    status: 404,
    message: "Bulk offer not found",
  };
  r = await call("POST", "/api/bulk-packs/offers/" + OID + "/pause");
  assert.equal(r.status, 404);
  assert.deepEqual(last("pauseOffer"), { offerId: OID, actor: "admin:root" });

  nextResult.resumeOffer = {
    success: false,
    status: 409,
    message: "only 3 free, needs 5",
  };
  r = await call("POST", "/api/bulk-packs/offers/" + OID + "/resume");
  assert.equal(r.status, 409);
  assert.equal(r.body.message, "only 3 free, needs 5");

  const before = count("invalidate");
  nextResult.withdrawOffer = {
    success: true,
    status: 200,
    offer: { _id: OID, state: "withdrawn" },
  };
  r = await call("POST", "/api/bulk-packs/offers/" + OID + "/withdraw");
  assert.equal(r.status, 200);
  assert.equal(r.body.offer.state, "withdrawn");
  assert.equal(count("invalidate"), before + 1);

  const n = calls.length;
  for (const action of ["refill", "pause", "resume", "withdraw"]) {
    r = await call("POST", "/api/bulk-packs/offers/nope/" + action, {
      body: { add: 2 },
    });
    assert.equal(r.status, 404, action);
  }
  assert.equal(calls.length, n, "a malformed id never reaches send.js");
});

test("withdraw-all requires the exact confirm word", async () => {
  for (const body of [
    undefined,
    {},
    { confirm: "withdraw" },
    { confirm: " WITHDRAW" },
    { confirm: true },
    { confirm: ["WITHDRAW"] },
  ]) {
    const r = await call("POST", "/api/bulk-packs/withdraw-all", { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.success, false);
  }
  assert.equal(count("withdrawAll"), 0);

  nextResult.withdrawAll = {
    success: true,
    status: 200,
    results: [{ id: "a", success: true }],
  };
  let r = await call("POST", "/api/bulk-packs/withdraw-all", {
    body: { confirm: "WITHDRAW" },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results, [{ id: "a", success: true }]);
  assert.deepEqual(last("withdrawAll"), { actor: "admin:root" });

  nextResult.withdrawAll = {
    success: false,
    status: 502,
    message: "1 of 2 failed",
    results: [],
  };
  r = await call("POST", "/api/bulk-packs/withdraw-all", {
    body: { confirm: "WITHDRAW" },
  });
  assert.equal(r.status, 502);
  assert.equal(r.body.message, "1 of 2 failed");
});

test("a send.js without the function is a 503, never a crash", async () => {
  bulkPackRoutes.__setDeps({ send: {} });
  let r = await call("POST", "/api/bulk-packs/send", { body: VALID_SEND });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "module_unavailable");
  assert.equal(r.body.module, "utils/bulkPacks/send.js");
  r = await call("POST", "/api/bulk-packs/offers/" + OID + "/pause");
  assert.equal(r.status, 503);
  bulkPackRoutes.__setDeps({ loop: null });
  r = await call("POST", "/api/bulk-packs/run-now");
  assert.equal(r.status, 503);
  assert.throws(() => bulkPackRoutes.__setDeps({ sned: {} }), /unknown dep/);
});

// ---------------------------------------------------------------------------
// Run now
// ---------------------------------------------------------------------------

test("run-now returns the pass summary, audits it, and coalesces a double click", async () => {
  // `at` is stamped when logEvent is called, so earlier tests' rows never match.
  const auditQuery = {
    category: "bulk",
    action: "run_now",
    at: { $gte: new Date() },
  };
  let release;
  runOnceGate = new Promise((r) => {
    release = r;
  });
  const p1 = call("POST", "/api/bulk-packs/run-now");
  await until(() => count("runOnce") === 1);
  const seen = count("get:runOnce");
  const p2 = call("POST", "/api/bulk-packs/run-now");
  await until(() => count("get:runOnce") > seen); // the 2nd click reached the handler
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(count("runOnce"), 1, "one pass for two clicks");
  for (const r of [r1, r2]) {
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.deepEqual(r.body.summary, SUMMARY);
    assert.equal(r.body.open, 2);
    assert.deepEqual(r.body.loop, LOOP_STATUS);
  }
  runOnceGate = null;
  await call("POST", "/api/bulk-packs/run-now");
  assert.equal(count("runOnce"), 2, "a later click runs a new pass");
  // Two passes ran, so two audit rows — the joined click does not log again.
  await until(async () => (await SystemEvent.countDocuments(auditQuery)) >= 2);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await SystemEvent.countDocuments(auditQuery), 2);
  const ev = await SystemEvent.findOne(auditQuery).sort({ at: -1 }).lean();
  assert.equal(ev.actor, "admin:root");
  assert.match(ev.detail, /open 2 \(acct 1, farm 1\) \| sold \+1/);
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test("GET settings returns bp, the raw autoFarm bulk* keys and the key list", async () => {
  const r = await call("GET", "/api/bulk-packs/settings");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.settings, realSettings.getBulkPacks(af));
  assert.deepEqual(r.body.keys, Object.keys(SETTINGS_KEYS));
  assert.deepEqual(Object.keys(r.body.raw), Object.keys(SETTINGS_KEYS));
  assert.equal(r.body.raw.bulkPacksEnabled, true);
  assert.deepEqual(r.body.raw.bulkPackTiers, af.bulkPackTiers);
  assert.equal(
    r.body.raw.bulkFarmMaxQty,
    null,
    "a key the store lacks reads as null",
  );
});

test("POST settings: 400 without {patch}, on any error and on an empty patch — nothing written", async () => {
  for (const body of [
    undefined,
    {},
    { patch: [] },
    { patch: "x" },
    { bulkPacksEnabled: true },
  ]) {
    const r = await call("POST", "/api/bulk-packs/settings", { body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  let r = await call("POST", "/api/bulk-packs/settings", {
    body: { patch: { bulkPackUnitsPerOffer: 81, bulkPacksEnabled: true } },
  });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.errors, [
    "bulkPackUnitsPerOffer must be a whole number 1..80",
  ]);
  r = await call("POST", "/api/bulk-packs/settings", {
    body: { patch: { foo: 1 } },
  });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.ignored, ["foo"]);
  r = await call("POST", "/api/bulk-packs/settings", {
    body: { patch: { bulkPacksMarkets: ["eldorado", "ggsel"] } },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /ggsel is blocked/);
  assert.equal(count("setAutoFarm"), 0);
});

test("POST settings writes the normalised patch with the session actor and invalidates proposals", async () => {
  const auditQuery = {
    category: "bulk",
    action: "settings_changed",
    at: { $gte: new Date() },
  };
  const r = await call("POST", "/api/bulk-packs/settings", {
    body: {
      patch: {
        enabled: false,
        markets: ["G2G", "eldorado", "g2g"],
        bulkPackTiers: [
          { minQty: "10", discountPct: 12.5 },
          { minQty: 3, discountPct: 0 },
        ],
        bulkFarmPrices: { eldorado: { 120: "3.5", 365: "" } },
        junk: 1,
      },
    },
  });
  assert.equal(r.status, 200);
  assert.equal(count("setAutoFarm"), 1);
  assert.deepEqual(last("setAutoFarm"), {
    patch: {
      bulkPacksEnabled: false,
      bulkPacksMarkets: ["g2g", "eldorado"],
      bulkPackTiers: [
        { minQty: 3, discountPct: 0 },
        { minQty: 10, discountPct: 12.5 },
      ],
      bulkFarmPrices: { eldorado: { 120: 3.5 } },
    },
    opts: { actor: "admin:root" },
  });
  assert.deepEqual(r.body.changed, [
    "bulkPacksEnabled",
    "bulkPacksMarkets",
    "bulkPackTiers",
    "bulkFarmPrices",
  ]);
  assert.deepEqual(r.body.ignored, ["junk"]);
  assert.equal(r.body.settings.enabled, false);
  assert.deepEqual(r.body.settings.markets, ["g2g", "eldorado"]);
  assert.deepEqual(r.body.settings.farmPrices, {
    eldorado: { 120: 3.5 },
    g2g: {},
  });
  assert.equal(r.body.raw.bulkPacksEnabled, false);
  assert.equal(count("invalidate"), 1);
  await until(async () => (await SystemEvent.countDocuments(auditQuery)) === 1);
  const ev = await SystemEvent.findOne(auditQuery).sort({ at: -1 }).lean();
  assert.equal(ev.actor, "admin:root");
  assert.match(ev.detail, /master switch OFF/);
});

// ---------------------------------------------------------------------------
// validateSettingsPatch
// ---------------------------------------------------------------------------

test("validateSettingsPatch: whitelist, aliases, duplicates, junk and prototype keys", () => {
  for (const bad of [null, undefined, [], "x", 5]) {
    const v = validateSettingsPatch(bad);
    assert.deepEqual(v.patch, {});
    assert.equal(v.errors.length, 1);
  }
  let v = validateSettingsPatch({ enabled: "on", loopMinutes: "7", other: 1 });
  assert.deepEqual(v.patch, {
    bulkPacksEnabled: true,
    bulkPacksLoopMinutes: 7,
  });
  assert.deepEqual(v.ignored, ["other"]);
  assert.deepEqual(v.errors, []);

  v = validateSettingsPatch({ enabled: true, bulkPacksEnabled: false });
  assert.deepEqual(v.errors, ["bulkPacksEnabled is given twice"]);

  v = validateSettingsPatch(
    JSON.parse(
      '{"__proto__":{"bulkPacksEnabled":true},"constructor":1,"toString":2,"hasOwnProperty":3}',
    ),
  );
  assert.deepEqual(v.patch, {});
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.ignored.sort(), [
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "toString",
  ]);
  assert.equal({}.bulkPacksEnabled, undefined, "no prototype pollution");

  for (const b of [true, false, "true", "false", 1, 0, "on", "off"]) {
    assert.deepEqual(
      validateSettingsPatch({ bulkPacksEnabled: b }).errors,
      [],
      String(b),
    );
  }
  for (const b of ["maybe", null, 2, {}]) {
    assert.equal(
      validateSettingsPatch({ bulkPacksEnabled: b }).errors.length,
      1,
      String(b),
    );
  }
});

test("validateSettingsPatch: whole-number keys accept exactly their ranges", () => {
  const ranges = {
    bulkPackReserveSingles: [0, 100],
    bulkPackUnitsPerOffer: [1, 80],
    bulkFarmReserveSlots: [0, 500],
    bulkFarmReservePristine: [0, 500],
    bulkFarmMaxQty: [1, 100],
    bulkPacksLoopMinutes: [2, 60],
    bulkFarmSyncMinutes: [5, 120],
  };
  for (const [key, [lo, hi]] of Object.entries(ranges)) {
    assert.deepEqual(SETTINGS_KEYS[key].slice(0, 3), ["int", lo, hi], key);
    for (const ok of [lo, hi, String(hi)]) {
      const v = validateSettingsPatch({ [key]: ok });
      assert.deepEqual(v.errors, [], key + "=" + ok);
      assert.equal(v.patch[key], Number(ok));
    }
    for (const bad of [lo - 1, hi + 1, lo + 0.5, "", null, true, "abc", [lo]]) {
      const v = validateSettingsPatch({ [key]: bad });
      assert.equal(v.errors.length, 1, key + "=" + JSON.stringify(bad));
      assert.equal(v.patch[key], undefined);
    }
  }
});

test("validateSettingsPatch: markets are a subset of eldorado/g2g/gameflip; blocked ones are named", () => {
  let v = validateSettingsPatch({
    bulkPacksMarkets: [" Gameflip", "eldorado", "eldorado"],
  });
  assert.deepEqual(v.patch.bulkPacksMarkets, ["gameflip", "eldorado"]);
  v = validateSettingsPatch({ bulkPacksMarkets: [] });
  assert.deepEqual(
    v.patch.bulkPacksMarkets,
    [],
    "no market at all is a valid choice",
  );
  for (const m of ["ggsel", "plati", "digiseller", "GGSel"]) {
    v = validateSettingsPatch({ bulkPacksMarkets: ["eldorado", m] });
    assert.equal(v.patch.bulkPacksMarkets, undefined, m);
    assert.match(
      v.errors.join(),
      /blocked \(owner block since 2026-09-28\)/,
      m,
    );
  }
  for (const bad of [
    ["playerauctions"],
    ["zeusx"],
    [7],
    "eldorado",
    { eldorado: true },
    null,
  ]) {
    v = validateSettingsPatch({ bulkPacksMarkets: bad });
    assert.ok(v.errors.length >= 1, JSON.stringify(bad));
    assert.equal(v.patch.bulkPacksMarkets, undefined);
  }
});

test("validateSettingsPatch: tiers are 1..4 unique whole minQty 2..100 with discountPct 0..60, sorted", () => {
  let v = validateSettingsPatch({
    bulkPackTiers: [
      { minQty: 20, discountPct: 15 },
      { minQty: "2", discountPct: "0" },
      { minQty: 100, discountPct: 60 },
      { minQty: 10, discountPct: 7.5 },
    ],
  });
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.patch.bulkPackTiers, [
    { minQty: 2, discountPct: 0 },
    { minQty: 10, discountPct: 7.5 },
    { minQty: 20, discountPct: 15 },
    { minQty: 100, discountPct: 60 },
  ]);
  const t = (minQty, discountPct) => ({ minQty, discountPct });
  const bad = [
    [],
    [t(2, 1), t(3, 1), t(4, 1), t(5, 1), t(6, 1)],
    [t(1, 5)],
    [t(101, 5)],
    [t(2.5, 5)],
    [t(5, -1)],
    [t(5, 61)],
    [t(5, "x")],
    [t(5, 5), t(5, 10)],
    [t(5, 5), "10"],
    [{ minQty: 5 }],
    "5:5",
    { minQty: 5, discountPct: 5 },
  ];
  for (const b of bad) {
    v = validateSettingsPatch({ bulkPackTiers: b });
    assert.ok(v.errors.length >= 1, JSON.stringify(b));
    assert.equal(v.patch.bulkPackTiers, undefined, JSON.stringify(b));
  }
  v = validateSettingsPatch({ bulkPackTiers: [t(0, 5), t(5, 5), t(5, 5)] });
  assert.match(
    v.errors.join("; "),
    /minQty 5 is listed twice/,
    "later duplicates are still named",
  );
});

test("validateSettingsPatch: farm prices are {eldorado|g2g: {days: 0.5..100}}", () => {
  let v = validateSettingsPatch({
    bulkFarmPrices: {
      eldorado: { 120: 3, 180: "4.25", 365: "" },
      G2G: { "0365": 7, 30: null },
    },
  });
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.patch.bulkFarmPrices, {
    eldorado: { 120: 3, 180: 4.25 },
    g2g: { 365: 7 },
  });
  assert.deepEqual(validateSettingsPatch({ farmPrices: {} }).patch, {
    bulkFarmPrices: {},
  });
  const bad = [
    { gameflip: { 120: 3 } },
    { ggsel: { 120: 3 } },
    { plati: { 120: 3 } },
    { eldorado: { 120: 0.4 } },
    { eldorado: { 120: 101 } },
    { eldorado: { 120: 0 } },
    { eldorado: { 120: "cheap" } },
    { eldorado: { 0: 3 } },
    { eldorado: { 731: 3 } },
    { eldorado: { 1.5: 3 } },
    { eldorado: { year: 3 } },
    { eldorado: [3, 4] },
    { eldorado: { 120: 3 }, Eldorado: { 180: 4 } },
    { eldorado: { 120: 3, "0120": 4 } },
    [{ eldorado: {} }],
    "eldorado:120:3",
  ];
  for (const b of bad) {
    v = validateSettingsPatch({ bulkFarmPrices: b });
    assert.ok(v.errors.length >= 1, JSON.stringify(b));
    assert.equal(v.patch.bulkFarmPrices, undefined, JSON.stringify(b));
  }
  v = validateSettingsPatch({ bulkFarmPrices: { ggsel: { 120: 3 } } });
  assert.match(v.errors.join(), /blocked/);
});

test("validateSettingsPatch: farm durations are 1..6 whole days 1..730, deduped and sorted", () => {
  let v = validateSettingsPatch({ bulkFarmDurations: [365, "120", 120, 180] });
  assert.deepEqual(v.patch.bulkFarmDurations, [120, 180, 365]);
  v = validateSettingsPatch({ farmDurations: [1, 2, 3, 4, 5, 730] });
  assert.deepEqual(v.patch.bulkFarmDurations, [1, 2, 3, 4, 5, 730]);
  for (const b of [
    [],
    [1, 2, 3, 4, 5, 6, 7],
    [0],
    [731],
    [1.5],
    ["x"],
    [null],
    "120",
    { a: 120 },
  ]) {
    v = validateSettingsPatch({ bulkFarmDurations: b });
    assert.ok(v.errors.length >= 1, JSON.stringify(b));
    assert.equal(v.patch.bulkFarmDurations, undefined, JSON.stringify(b));
  }
});

// ---------------------------------------------------------------------------
// Wiring tripwires (CONTRACT §8 H3 / H4)
// ---------------------------------------------------------------------------

function once(src, needle) {
  const i = src.indexOf(needle);
  assert.ok(i >= 0, "missing: " + needle);
  assert.equal(src.indexOf(needle, i + 1), -1, "more than once: " + needle);
  return i;
}

test("server.js: page gated before static, router after the admin blanket, loop in the connected block", () => {
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  once(src, 'const bulkPackRoutes = require("./routes/bulkPackRoutes");');
  const page = once(
    src,
    'app.get("/bulk-packs.html", requireSuperadmin, enforce2fa, (req, res) => {',
  );
  const statik = once(src, "app.use(express.static(");
  assert.ok(page < statik, "the page route is declared before express.static");
  const blanket = once(src, "app.use(requireAdmin, enforce2fa, itemRoutes);");
  const mount = once(src, "app.use(enforce2fa, bulkPackRoutes);");
  assert.ok(
    blanket < mount,
    "the router mounts after the requireAdmin blanket",
  );
  const notFound = once(
    src,
    'res.status(404).json({ success: false, message: "Route not found" });',
  );
  assert.ok(mount < notFound, "the router mounts before the 404 handler");
  const connected = once(src, ".connect(config.MONGO_URI)");
  const loop = once(src, 'require("./utils/bulkPacks/loop").start();');
  const exit = once(src, 'console.error("MongoDB connection error:"');
  assert.ok(
    connected < loop && loop < exit,
    "the loop starts inside the mongoose-connected block",
  );
  once(
    src,
    "// Bulk packs maintenance (maintains live offers; publishing needs autoFarm.bulkPacksEnabled)",
  );
});

test("admin-nav.js: 'Bulk packs' sits right after 'Bulk orders' in the marketplace group, superadmin only", () => {
  const src = fs.readFileSync(
    path.join(ROOT, "public", "admin-nav.js"),
    "utf8",
  );
  const m = src.match(
    /href: "\/bulk-orders\.html",\s*label: "Bulk orders",\s*icon: ICONS\.bulkOrders,\s*superOnly: true,\s*\},\s*\{\s*href: "\/bulk-packs\.html",\s*label: "Bulk packs",\s*icon: ICONS\.(\w+),\s*superOnly: true,\s*\},/,
  );
  assert.ok(m, "Bulk packs entry directly after Bulk orders");
  assert.match(
    src,
    new RegExp("\\n    " + m[1] + ":"),
    "the icon reuses an existing ICONS key",
  );
  const at = once(src, 'href: "/bulk-packs.html"');
  assert.ok(
    src.indexOf('key: "marketplace"') < at &&
      at < src.indexOf('key: "watchers"'),
  );
});
