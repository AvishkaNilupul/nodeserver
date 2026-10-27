/* global fetch */
// Route tests for the FunPay resale API (routes/funpayResaleRoutes.js,
// docs/FUNPAY-RESALE-CONTRACT.md §8). Everything behind the router's `deps` is
// an in-memory fake — no Mongo, no network, no FunPay, no Eldorado — while the
// REAL requireSuperadmin guards every route; a stub session (the x-test-as
// header) stands in for the admin login.
//
// What these exist to stop:
//   - a secret leaving the API: cookies, a bought login or a buy trace in any
//     answer but the one reveal route. Asserted on the serialised body, and the
//     fakes hand back every field on purpose (projections ignored, extra keys on
//     ops results): the route's own whitelists are what is under test;
//   - money or a new live offer before the owner's test purchase has worked;
//   - a listing linked onto stock another mode owns, or unlinked/deleted under an
//     Eldorado order still being worked;
//   - an open route.
// Made-up ids and names only — the repository is public.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");

const router = require("../routes/funpayResaleRoutes");
const { requireSuperadmin } = require("../middleware/auth");

const { deps } = router;
const REAL_PUBLIC = path.resolve(deps.publicDir);
const DEP_KEYS = ["Source", "Purchase", "Listing", "DropLog", "settings", "mp", "ops", "watch", "engine", "systemLog"];
const P = "/api/funpay-resale";

const GUID_A = "0a1b2c3d-1111-4222-8333-444455556666";
const GUID_B = "0a1b2c3d-aaaa-4bbb-8ccc-ddddeeeeffff";
const GUID_NEW = "0a1b2c3d-9999-4888-8777-666655554444";
const eldUrl = (id) => "https://www.eldorado.gg/twitch-drops/i/235?offerId=" + id;
const SENTINEL = {
  cookie: "COOKIE-CIPHERTEXT-SENTINEL-7f3a",
  cred: "ENC-CREDENTIALS-SENTINEL-2b9c",
  trace: "TRACE-SENTINEL-5d1e",
  password: "Pw-SENTINEL-8k2q",
};

const ROUTES = [
  "GET /api/funpay-resale/state",
  "POST /api/funpay-resale/session",
  "POST /api/funpay-resale/session/check",
  "DELETE /api/funpay-resale/session",
  "PUT /api/funpay-resale/settings",
  "POST /api/funpay-resale/sources",
  "PUT /api/funpay-resale/sources/:id",
  "DELETE /api/funpay-resale/sources/:id",
  "POST /api/funpay-resale/sources/:id/refresh",
  "POST /api/funpay-resale/sources/:id/test",
  "POST /api/funpay-resale/sources/:id/buy",
  "POST /api/funpay-resale/sources/:id/listing",
  "POST /api/funpay-resale/sources/:id/link",
  "POST /api/funpay-resale/sources/:id/unlink",
  "GET /api/funpay-resale/covers",
  "POST /api/funpay-resale/purchases/:id/reveal",
  "POST /api/funpay-resale/purchases/:id/credential",
  "POST /api/funpay-resale/purchases/:id/check",
  "POST /api/funpay-resale/purchases/:id/retry",
  "POST /api/funpay-resale/purchases/:id/close",
];

// ---------------------------------------------------------------- fakes

let seq = 0;
const oid = () => (0x5f0000000000 + ++seq).toString(16).padStart(24, "0");
let clock = Date.parse("2026-10-26T08:00:00Z");
const nextTime = () => new Date((clock += 1000));

const isOps = (c) => c && typeof c === "object" && !Array.isArray(c) && !(c instanceof Date) && Object.keys(c).some((k) => k.startsWith("$"));
function same(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() === new Date(b).getTime();
  return String(a) === String(b);
}
function matches(doc, query) {
  return Object.entries(query || {}).every(([k, cond]) => {
    const v = doc[k];
    if (cond instanceof RegExp) return typeof v === "string" && cond.test(v);
    if (!isOps(cond)) return same(v, cond);
    return Object.entries(cond).every(([op, arg]) => {
      if (op === "$in") return arg.some((x) => same(v, x));
      if (op === "$nin") return !arg.some((x) => same(v, x));
      if (op === "$ne") return !same(v, arg);
      if (op === "$gt") return v != null && v > arg;
      if (op === "$gte") return v != null && v >= arg;
      throw new Error("fake: unsupported operator " + op);
    });
  });
}
function sortBy(list, spec) {
  const keys = Object.entries(spec);
  const val = (x) => (x instanceof Date ? x.getTime() : x);
  return list.slice().sort((a, b) => {
    for (const [k, dir] of keys) {
      if (val(a[k]) < val(b[k])) return -dir;
      if (val(a[k]) > val(b[k])) return dir;
    }
    return 0;
  });
}
// A mongoose-ish query: chainable, awaitable.
function chain(run) {
  const st = {};
  const q = {
    sort(s) {
      st.sort = s;
      return q;
    },
    limit(n) {
      st.limit = n;
      return q;
    },
    lean() {
      return q;
    },
    then(ok, fail) {
      return Promise.resolve().then(() => run(st)).then(ok, fail);
    },
  };
  return q;
}
// Projections are recorded but NOT applied: every read hands back the whole row.
function fakeModel(defaults, { unique = [] } = {}) {
  const rows = [];
  const calls = [];
  const created = [];
  const copy = (r) => (r ? structuredClone(r) : null);
  const M = {
    rows,
    calls,
    created,
    seed(doc) {
      const at = nextTime();
      const r = { _id: oid(), createdAt: at, updatedAt: at, ...structuredClone(defaults), ...doc };
      rows.push(r);
      return r;
    },
    find(query = {}, proj) {
      calls.push({ op: "find", query, proj });
      return chain((st) => {
        let list = rows.filter((r) => matches(r, query));
        if (st.sort) list = sortBy(list, st.sort);
        if (st.limit) list = list.slice(0, st.limit);
        return list.map(copy);
      });
    },
    findOne(query = {}, proj) {
      calls.push({ op: "findOne", query, proj });
      return chain(() => copy(rows.find((r) => matches(r, query))));
    },
    findById(id, proj) {
      calls.push({ op: "findById", id, proj });
      return chain(() => copy(rows.find((r) => String(r._id) === String(id))));
    },
    async countDocuments(query = {}) {
      return rows.filter((r) => matches(r, query)).length;
    },
    async create(doc) {
      created.push(structuredClone(doc));
      for (const k of unique) {
        if (rows.some((r) => r[k] === doc[k])) {
          const e = new Error("E11000 duplicate key " + k);
          e.code = 11000;
          throw e;
        }
      }
      return copy(M.seed(doc));
    },
    async updateOne(query, update) {
      calls.push({ op: "updateOne", query, update: structuredClone(update) });
      const r = rows.find((x) => matches(x, query));
      if (!r) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(r, structuredClone(update.$set || {}));
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async updateMany(query, update) {
      calls.push({ op: "updateMany", query, update: structuredClone(update) });
      const hit = rows.filter((x) => matches(x, query));
      for (const r of hit) Object.assign(r, structuredClone(update.$set || {}));
      return { matchedCount: hit.length, modifiedCount: hit.length };
    },
    async deleteOne(query) {
      const i = rows.findIndex((x) => matches(x, query));
      if (i < 0) return { deletedCount: 0 };
      rows.splice(i, 1);
      return { deletedCount: 1 };
    },
  };
  return M;
}
function fakeDropLog() {
  const rows = [];
  return {
    rows,
    async aggregate(pipeline) {
      let list = rows.slice();
      for (const stage of pipeline) {
        if (stage.$match) list = list.filter((r) => matches(r, stage.$match));
        else if (stage.$group) {
          const field = stage.$group._id.slice(1);
          const countKey = Object.keys(stage.$group).find((k) => k !== "_id");
          const by = new Map();
          for (const r of list) by.set(r[field], (by.get(r[field]) || 0) + 1);
          list = [...by].map(([k, n]) => ({ _id: k, [countKey]: n }));
        } else if (stage.$sort) list = sortBy(list, stage.$sort);
        else if (stage.$limit) list = list.slice(0, stage.$limit);
        else throw new Error("fake aggregate: unsupported stage " + Object.keys(stage)[0]);
      }
      return list;
    },
  };
}
// Every call into a fake lands in env.log (the auth test expects none).
function instrument(obj, label, log) {
  for (const k of Object.keys(obj)) {
    if (typeof obj[k] !== "function") continue;
    const fn = obj[k];
    obj[k] = (...args) => {
      log.push(label + "." + k);
      return fn(...args);
    };
  }
  return obj;
}

function makeEnv() {
  const env = {
    log: [],
    events: [],
    next: {},
    calls: { saveSession: [], testSource: [], manualBuy: [], reveal: [], recheck: [], setManual: [], retry: [], close: [], publish: [], delist: [], setSettings: [], setCookies: [], runOnce: [] },
  };
  env.cfg = {
    watchEnabled: true, watchMinutes: 30, autoBuy: false, dryRun: true, commissioned: false, commissionedAt: null,
    perUnitMaxUsd: 3, dailyCapUsd: 15, maxBuysPerHour: 6, maxUnitsPerOrder: 3, minProfitUsd: 0.1, eldoradoFeePct: 10,
    sellerWaitMinutes: 15, giveUpHours: 24, pauseListingWhenSourceDown: true,
    // What a regression in utils/settings would hand out: the route must drop it anyway.
    session: SENTINEL.cookie,
    sessionConfigured: true, sessionOk: true, sessionUser: "owner-fp", sessionUserId: 4242, sessionCheckedAt: null,
    sessionError: "", balanceUsd: 9.5, balanceSeenAt: null,
  };
  env.Source = fakeModel(
    {
      label: "", node: "", game: "Rocket League", itemsText: "", maxBuyPriceUsd: 0, autoBuy: false, listingQuantity: 5,
      title: "", sellerId: "", sellerName: "", sellerRating: null, priceUsd: null, missingSince: null,
      competitorOfferIds: [], competitors: [], competitorHistory: [], lowestCompetitorUsd: null, suggestedPriceUsd: null,
      estProfitUsd: null, lastError: "",
    },
    { unique: ["offerId"] },
  );
  env.Purchase = fakeModel({
    source: null, offerId: "", kind: "order", eldoradoOrderId: "", unit: 0, listing: null, state: "new", funpayOrderId: "",
    chargedUsd: 0, maxPriceUsd: 0, login: "", credentials: "", reason: "", trace: [], alerted: [],
  });
  env.Listing = fakeModel({
    set: null, externalId: "", url: "", title: "", description: "", price: 0, status: "active", origin: "manual", units: [],
    accountOffer: null, noclaimStock: false, unclaimedGame: "", autoClaimSet: false, bulkOfferId: null, bulkPackSize: 0,
    rentFarm: false, requiredDrops: [], accountId: "", accountLogin: "", autoDeliver: false, funpaySource: null,
    autoPaused: false, lastError: "",
  });
  env.DropLog = fakeDropLog();
  const purchase = (id) => env.Purchase.rows.find((r) => String(r._id) === String(id));
  env.settings = {
    getFunpayResale: () => ({ ...env.cfg }),
    async setFunpayResale(patch, opts) {
      env.calls.setSettings.push({ patch, opts });
      if (patch.autoBuy === true && !env.cfg.commissioned) {
        const e = new Error("finish a test purchase first (Buy 1 now) — auto-buy stays off until one works end to end");
        e.code = "FUNPAY_NOT_COMMISSIONED";
        throw e;
      }
      Object.assign(env.cfg, patch);
      return { ...env.cfg };
    },
    async setFunpaySessionCookies(jar, opts) {
      env.calls.setCookies.push({ jar, actor: opts && opts.actor });
    },
  };
  env.ops = {
    async saveSession(text, opts) {
      env.calls.saveSession.push({ text, opts });
      return env.next.saveSession || { ok: true, user: "owner-fp", jar: { golden_key: SENTINEL.cookie } };
    },
    async checkSession() {
      return { ok: true, user: "owner-fp", userId: 4242, balanceUsd: 12.5, error: "", cookies: SENTINEL.cookie };
    },
    async testSource(id) {
      env.calls.testSource.push(id);
      if (env.next.testSource) return env.next.testSource;
      return { ok: true, signedIn: true, user: "owner-fp", priceUsd: 1.17, balanceUsd: 9.5, buyFormFound: true, maxPriceUsd: 1.4, reason: "", cookies: SENTINEL.cookie, page: "<html>" };
    },
    async manualBuy(id, opts) {
      env.calls.manualBuy.push([id, opts]);
      if (env.next.manualBuy) return env.next.manualBuy(id, opts);
      return { ok: true, purchaseId: oid(), state: "received", reason: "", trace: [] };
    },
    async revealCredentials(id) {
      env.calls.reveal.push(id);
      if (env.next.reveal) return env.next.reveal(id);
      return { username: "fake_login_1", password: SENTINEL.password };
    },
    // utils/funpayResaleOps: one more read of a bought purchase's FunPay order.
    async recheckPurchase(id) {
      env.calls.recheck.push(id);
      if (env.next.recheck) return env.next.recheck;
      Object.assign(purchase(id), { state: "received", login: "fake_login_9", credentials: SENTINEL.cred, reason: "" });
      return { ok: true, state: "received", reason: "", login: "fake_login_9", credentials: SENTINEL.cred };
    },
    async setManualCredential(id, c) {
      env.calls.setManual.push([id, c]);
      Object.assign(purchase(id), { state: "received", login: c.login, credentials: "ENC(" + c.password + ")", reason: "entered by hand" });
      return { ok: true };
    },
    async retryPurchase(id) {
      env.calls.retry.push(id);
      if (env.next.retry) return env.next.retry;
      Object.assign(purchase(id), { state: "new", reason: "" });
      return { ok: true };
    },
    async closePurchase(id, o) {
      env.calls.close.push([id, o]);
      Object.assign(purchase(id), { state: "failed", reason: "closed by owner: " + o.note });
      return { ok: true };
    },
  };
  env.mp = {
    ELD_MIN_PRICE: 0.5,
    async eldoradoPublish(args) {
      env.calls.publish.push(args);
      return { externalId: GUID_NEW, id: GUID_NEW, url: eldUrl(GUID_NEW), raw: { id: GUID_NEW } };
    },
    async eldoradoDelist(id) {
      env.calls.delist.push(id);
      return { ok: true };
    },
  };
  env.watch = {
    state: { running: false, lastRunAt: "2026-10-26T07:30:00.000Z", lastResult: { sources: 2, errors: 0 } },
    async runOnce(o) {
      env.calls.runOnce.push(o);
      return env.next.runOnce || { ok: true, sources: 1 };
    },
  };
  env.engine = {
    BUYER_GUIDE: "How to get your items:\n1. A made-up guide line for tests.",
    spentLast24h: async () => 4.2,
    buysLastHour: async () => 1,
  };
  env.systemLog = {
    actorFromReq: (req) => (req.session && req.session.admin ? "admin:" + req.session.admin.id : "anon"),
    async logEvent(e) {
      env.events.push(e);
    },
  };
  for (const k of DEP_KEYS) instrument(env[k], k, env.log);
  return env;
}

// ---------------------------------------------------------------- server

let env;
let server;
let base;

test.before(async () => {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.use((req, res, next) => {
    const who = req.get("x-test-as");
    if (who === "superadmin") req.session = { admin: { id: "owner-1", username: "owner", role: "superadmin" } };
    else if (who === "admin") req.session = { admin: { id: "helper-1", username: "helper", role: "admin" } };
    else req.session = {};
    next();
  });
  app.use(router);
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = "http://127.0.0.1:" + server.address().port;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  for (const k of DEP_KEYS) deps[k] = undefined; // back to the lazy real modules
  deps.publicDir = REAL_PUBLIC;
});

test.beforeEach(() => {
  env = makeEnv();
  for (const k of DEP_KEYS) deps[k] = env[k];
  deps.publicDir = REAL_PUBLIC;
});

async function call(method, p, body, as = "superadmin") {
  const init = { method, headers: { "x-test-as": as, accept: "application/json" } };
  if (body !== undefined && method !== "GET") {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetch(base + p, init);
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: r.status, body: json, text, headers: r.headers };
}
const noSecrets = (text) => {
  for (const s of Object.values(SENTINEL)) assert.ok(!text.includes(s), "leaked " + s);
};
// For the calls that end in a 5xx on purpose: the route logs those.
async function quiet(fn) {
  const saved = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = saved;
  }
}

// ---------------------------------------------------------------- auth

test("the router is exactly the contract's routes, each with requireSuperadmin in front", () => {
  assert.ok(router.stack.every((l) => l.route), "no router-level middleware: mounted at /, it would run for every request in the app");
  const seen = router.stack.map((l) => Object.keys(l.route.methods).map((m) => m.toUpperCase()).join(",") + " " + l.route.path);
  assert.deepEqual([...seen].sort(), [...ROUTES].sort());
  for (const l of router.stack) {
    assert.equal(l.route.stack[0].handle, requireSuperadmin, l.route.path + ": the session check runs first");
    assert.equal(l.route.stack.filter((s) => s.handle === requireSuperadmin).length, 1);
  }
});

test("signed out is a 401 and a plain admin a 403 on every route — nothing behind the guard runs", async () => {
  const id = oid();
  for (const r of ROUTES) {
    const [method, p] = r.split(" ");
    const url = p.replace(":id", id) + (p.endsWith("/covers") ? "?game=Rocket%20League" : "");
    const body = method === "GET" ? undefined : { cookies: "golden_key=x", confirmMaxUsd: 1 };
    assert.equal((await call(method, url, body, "nobody")).status, 401, r);
    assert.equal((await call(method, url, body, "admin")).status, 403, r);
  }
  assert.deepEqual(env.log, []);
});

// ---------------------------------------------------------------- state

test("GET /state: settings, deals with their linked listing, the newest 50 purchases — never a cookie, credential or trace", async () => {
  const s1 = env.Source.seed({ offerId: "100001", label: "Test deal one", competitorHistory: [{ offerId: GUID_A, quantity: 4, at: new Date() }] });
  const s2 = env.Source.seed({ offerId: "100002", label: "Test deal two" });
  env.Listing.seed({ marketplace: "eldorado", externalId: GUID_A, title: "Linked active listing", price: 2.89, url: eldUrl(GUID_A), funpaySource: s1._id });
  // newer, but off sale: the active row is the one shown
  env.Listing.seed({ marketplace: "eldorado", externalId: GUID_B, title: "Old paused listing", status: "delisted", funpaySource: s1._id });
  let last;
  for (let i = 0; i < 55; i++) {
    last = env.Purchase.seed({ source: s1._id, kind: "order", state: "delivered", eldoradoOrderId: "eld-order-" + i, login: "fake_login_" + i, credentials: SENTINEL.cred, trace: [{ step: SENTINEL.trace }] });
  }

  const r = await call("GET", P + "/state");
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.equal(r.headers.get("cache-control"), "no-store");
  noSecrets(r.text);

  assert.ok(!("session" in r.body.settings));
  assert.equal(r.body.settings.sessionConfigured, true);
  assert.equal(r.body.settings.dryRun, true);

  assert.deepEqual(r.body.sources.map((s) => s.label), ["Test deal one", "Test deal two"]);
  assert.deepEqual(r.body.sources[0].linkedListing, {
    externalId: GUID_A, title: "Linked active listing", price: 2.89, status: "active", autoPaused: false, url: eldUrl(GUID_A), lastError: "",
  });
  assert.equal(r.body.sources[1].linkedListing, null);
  assert.ok(r.body.sources.every((s) => !("competitorHistory" in s)));
  assert.equal(String(r.body.sources[1]._id), String(s2._id));

  assert.equal(r.body.purchases.length, 50);
  assert.equal(r.body.purchases[0]._id, String(last._id), "newest first");
  for (const p of r.body.purchases) {
    assert.ok(!("credentials" in p) && !("trace" in p) && !("alerted" in p));
    assert.match(p.login, /^fake_login_\d+$/);
  }
  const listed = env.Purchase.calls.find((c) => c.op === "find");
  assert.deepEqual(listed.proj, { credentials: 0, trace: 0 }, "the ciphertext is not even read for the list");

  assert.equal(r.body.spent24h, 4.2);
  assert.equal(r.body.buys1h, 1);
  assert.deepEqual(r.body.watcher, env.watch.state);
});

// ---------------------------------------------------------------- settings + session

test("PUT /settings: only the §4 editable keys, typed; the commission refusal is a 409", async () => {
  let r = await call("PUT", P + "/settings", { autoBuy: true });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /test purchase/);
  assert.equal(env.cfg.autoBuy, false);

  for (const bad of [{ dryRun: "no" }, { watchMinutes: "ten" }, { dailyCapUsd: null }, { autoBuy: 1 }]) {
    assert.equal((await call("PUT", P + "/settings", bad)).status, 400, JSON.stringify(bad));
  }
  r = await call("PUT", P + "/settings", { session: "x", commissioned: true, sessionOk: true, balanceUsd: 99 });
  assert.equal(r.status, 400, "nothing editable in it");

  env.calls.setSettings.length = 0;
  r = await call("PUT", P + "/settings", {
    watchMinutes: "45", dailyCapUsd: 20, dryRun: false, commissioned: true, commissionedAt: "now", session: "x", sessionUser: "y", balanceUsd: 99, golden_key: "z",
  });
  assert.equal(r.status, 200);
  assert.deepEqual(env.calls.setSettings, [{ patch: { watchMinutes: 45, dailyCapUsd: 20, dryRun: false }, opts: { actor: "admin:owner-1" } }]);
  assert.equal(r.body.settings.dailyCapUsd, 20);
  assert.ok(!("session" in r.body.settings));
  noSecrets(r.text);
});

test("POST /session hands the paste to ops and never echoes it; a refused login is a 400; DELETE clears", async () => {
  const paste = "golden_key=FAKEGOLDENKEY0123456789abcdef; PHPSESSID=fakesession12345";
  let r = await call("POST", P + "/session", { cookies: paste, extra: "ignored" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { success: true, ok: true, user: "owner-fp" });
  assert.deepEqual(env.calls.saveSession, [{ text: paste, opts: { actor: "admin:owner-1" } }]);

  // An ops error that (wrongly) quotes the paste back is scrubbed.
  env.next.saveSession = { ok: false, error: "rejected FAKEGOLDENKEY0123456789abcdef and fakesession12345" };
  r = await call("POST", P + "/session", { cookies: paste });
  assert.equal(r.status, 400);
  assert.equal(r.body.success, false);
  assert.ok(!r.text.includes("FAKEGOLDENKEY0123456789abcdef") && !r.text.includes("fakesession12345"));

  for (const bad of [{}, { cookies: "" }, { cookies: "   " }, { cookies: 12 }]) {
    assert.equal((await call("POST", P + "/session", bad)).status, 400, JSON.stringify(bad));
  }
  // A cookie-export the page already parsed is still a paste.
  env.next.saveSession = null;
  r = await call("POST", P + "/session", { cookies: [{ name: "golden_key", value: "fakeExportedKey987654321", domain: ".funpay.com" }] });
  assert.equal(r.status, 200);
  assert.equal(env.calls.saveSession.at(-1).text, JSON.stringify([{ name: "golden_key", value: "fakeExportedKey987654321", domain: ".funpay.com" }]));

  r = await call("POST", P + "/session/check", {});
  assert.deepEqual(r.body, { success: true, ok: true, user: "owner-fp", userId: 4242, balanceUsd: 12.5, error: "" });

  r = await call("DELETE", P + "/session");
  assert.equal(r.status, 200);
  assert.deepEqual(env.calls.setCookies, [{ jar: null, actor: "admin:owner-1" }]);
});

// ---------------------------------------------------------------- deals

test("POST /sources: a funpay.com offer link or a bare id; anything else is a 400, a repeat a 409", async () => {
  let r = await call("POST", P + "/sources", {
    offer: "https://funpay.com/en/lots/offer?id=123456789",
    label: "Test deal",
    itemsText: "Item one\r\nItem two\n",
    maxBuyPriceUsd: "1.25",
    listingQuantity: 4,
    game: "Rocket League",
    competitorOfferIds: [eldUrl(GUID_A)],
    autoBuy: true,
    priceUsd: 0.01,
    junk: 1,
  });
  assert.equal(r.status, 200);
  const s = r.body.source;
  assert.equal(s.offerId, "123456789");
  assert.equal(s.label, "Test deal");
  assert.equal(s.itemsText, "Item one\nItem two");
  assert.equal(s.maxBuyPriceUsd, 1.25);
  assert.equal(s.listingQuantity, 4);
  assert.deepEqual(s.competitorOfferIds, [GUID_A]);
  assert.equal(s.autoBuy, false, "a new deal never starts with auto-buy on");
  assert.deepEqual(env.Source.created[0], {
    offerId: "123456789", label: "Test deal", itemsText: "Item one\nItem two", maxBuyPriceUsd: 1.25, competitorOfferIds: [GUID_A], listingQuantity: 4, game: "Rocket League",
  });

  for (const [offer, id] of [
    ["funpay.com/lots/offer?id=222", "222"],
    ["https://www.funpay.com/ru/lots/offer/?id=333&from=x", "333"],
    [444, "444"],
    [" 555 ", "555"],
  ]) {
    r = await call("POST", P + "/sources", { offer });
    assert.equal(r.status, 200, String(offer));
    assert.equal(r.body.source.offerId, id);
  }
  for (const offer of [
    "https://evil.example/en/lots/offer?id=1",
    "https://funpay.com.evil.example/en/lots/offer?id=9",
    "https://funpay.com/en/users/77/",
    "https://funpay.com/en/lots/offer?id=abc",
    "javascript:alert(1)",
    "",
    "0",
    -5,
    1.5,
    null,
    {},
  ]) {
    r = await call("POST", P + "/sources", { offer });
    assert.equal(r.status, 400, JSON.stringify(offer));
    assert.match(r.body.error, /FunPay offer id/);
  }
  assert.equal((await call("POST", P + "/sources", {})).status, 400);

  r = await call("POST", P + "/sources", { offer: "https://funpay.com/en/lots/offer?id=123456789" });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already on the deals list/);

  for (const bad of [{ maxBuyPriceUsd: -1 }, { maxBuyPriceUsd: 51 }, { listingQuantity: 0 }, { listingQuantity: 2.5 }, { label: 123 }, { label: "two\nlines" }, { game: "" }]) {
    r = await call("POST", P + "/sources", { offer: "900900", ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal(env.Source.rows.length, 5, "the four other spellings, nothing from the refusals");
});

test("competitor offers: GUIDs and offerId= links, from a list or free text; junk is named in a 400", async () => {
  const { parseCompetitorIds } = router;
  const link = eldUrl(GUID_B.toUpperCase()) + "&utm=x";
  assert.deepEqual(parseCompetitorIds([GUID_A, link, GUID_A]), [GUID_A, GUID_B]);
  assert.deepEqual(parseCompetitorIds(GUID_A + "\n" + link + " , " + GUID_A.toUpperCase() + ";\n\n"), [GUID_A, GUID_B]);
  assert.deepEqual(parseCompetitorIds(["offerId=" + GUID_B]), [GUID_B]);
  assert.deepEqual(parseCompetitorIds(""), []);
  assert.deepEqual(parseCompetitorIds([]), []);
  assert.deepEqual(parseCompetitorIds(null), []);
  assert.throws(() => parseCompetitorIds("https://www.eldorado.gg/twitch-drops/i/235"), /could not read an Eldorado offer id/);
  assert.throws(() => parseCompetitorIds(GUID_A + " seller-notes"), /seller-notes/);
  assert.throws(() => parseCompetitorIds("0a1b2c3d-1111-4222"), /could not read/);
  assert.throws(() => parseCompetitorIds([12]), /offer ids or links/);
  assert.throws(() => parseCompetitorIds({ id: GUID_A }), /list or text/);
  const many = Array.from({ length: 21 }, (_, i) => "0a1b2c3d-0000-4000-8000-" + String(i).padStart(12, "0"));
  assert.throws(() => parseCompetitorIds(many), /at most 20/);
  assert.equal(parseCompetitorIds(many.slice(0, 20)).length, 20);

  // Through the route, as text.
  let r = await call("POST", P + "/sources", { offer: "700700", competitorOfferIds: link + "\n" + GUID_A });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.source.competitorOfferIds, [GUID_B, GUID_A]);
  r = await call("POST", P + "/sources", { offer: "700701", competitorOfferIds: "https://www.eldorado.gg/users/someone" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /users\/someone/);
});

test("PUT /sources/:id: auto-buy is refused until commissioned; edits are typed; a dropped competitor stops counting", async () => {
  const s = env.Source.seed({
    offerId: "1001",
    competitorOfferIds: [GUID_A, GUID_B],
    competitors: [{ offerId: GUID_A, priceUsd: 2.5, state: "Active" }, { offerId: GUID_B, priceUsd: 1.1, state: "Active" }],
    competitorHistory: [{ offerId: GUID_A, quantity: 3 }, { offerId: GUID_B, quantity: 9 }],
    lowestCompetitorUsd: 1.1,
    suggestedPriceUsd: 1.09,
    estProfitUsd: 0.2,
  });
  const url = P + "/sources/" + s._id;
  let r = await call("PUT", url, { autoBuy: true });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /test purchase/);
  assert.equal(s.autoBuy, false);

  env.cfg.commissioned = true;
  r = await call("PUT", url, { autoBuy: true });
  assert.equal(r.status, 200);
  assert.equal(s.autoBuy, true);
  assert.equal(r.body.source.autoBuy, true);
  assert.equal((await call("PUT", url, { autoBuy: "yes" })).status, 400);

  // Same ids in another order and case: nothing to prune.
  r = await call("PUT", url, { competitorOfferIds: [GUID_B.toUpperCase(), GUID_A] });
  assert.equal(r.status, 200);
  assert.equal(s.lowestCompetitorUsd, 1.1);
  assert.equal(s.competitors.length, 2);

  r = await call("PUT", url, { competitorOfferIds: [GUID_A], label: "Renamed", offerId: "999", sellerRating: 5, autoBuy: false });
  assert.equal(r.status, 200);
  assert.deepEqual(s.competitorOfferIds, [GUID_A]);
  assert.deepEqual(s.competitors.map((c) => c.offerId), [GUID_A]);
  assert.deepEqual(s.competitorHistory.map((c) => c.offerId), [GUID_A]);
  assert.equal(s.lowestCompetitorUsd, null, "the $1.10 came from the offer just removed");
  assert.equal(s.suggestedPriceUsd, null);
  assert.equal(s.estProfitUsd, null);
  assert.equal(s.label, "Renamed");
  assert.equal(s.autoBuy, false);
  assert.equal(s.offerId, "1001", "not editable");
  assert.equal(s.sellerRating, null, "watcher data is not editable");
  assert.ok(!("competitorHistory" in r.body.source));

  assert.equal((await call("PUT", url, {})).status, 400);
  assert.equal((await call("PUT", url, { listingQuantity: 500 })).status, 400);
  assert.equal((await call("PUT", P + "/sources/" + oid(), { label: "x" })).status, 404);
  assert.equal((await call("PUT", P + "/sources/not-an-id", { label: "x" })).status, 404);
});

test("DELETE /sources/:id: refused while an active Eldorado listing is linked or an Eldorado order is open", async () => {
  const s = env.Source.seed({ offerId: "2001" });
  const url = P + "/sources/" + s._id;
  const L = env.Listing.seed({ marketplace: "eldorado", externalId: GUID_A, title: "Linked listing", funpaySource: s._id });
  let r = await call("DELETE", url);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /active Eldorado listing/);
  assert.equal(env.Source.rows.length, 1);

  L.status = "delisted";
  const p = env.Purchase.seed({ source: s._id, kind: "order", state: "bought", eldoradoOrderId: "eld-order-1" });
  r = await call("DELETE", url);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /still open/);

  p.state = "delivered";
  env.Purchase.seed({ source: s._id, kind: "manual", state: "received" }); // a finished test buy never blocks
  r = await call("DELETE", url);
  assert.equal(r.status, 200);
  assert.equal(env.Source.rows.length, 0);
  assert.equal(String(L.funpaySource), String(s._id), "an off-sale row keeps its pointer: relisted by hand, its orders still page");
  assert.equal((await call("DELETE", url)).status, 404);
});

// ---------------------------------------------------------------- listings

test("POST /sources/:id/listing: 409 until commissioned, then exactly the publish call and the listing row", async () => {
  const s = env.Source.seed({ offerId: "3001", label: "Big set", itemsText: "Item one\nItem two", maxBuyPriceUsd: 1.4, sellerName: "fake_seller_x" });
  const url = P + "/sources/" + s._id + "/listing";
  const body = {
    title: "Rocket League Twitch Drops (2 Items) — Item one, Item two",
    description: "Item one\nItem two\n\nHow to get your items: …",
    priceUsd: 2.89,
    quantity: 3,
    deliveryTime: "Hour2",
    coverImage: "/app-icon-192.png",
  };
  let r = await call("POST", url, body);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /test purchase/);
  assert.equal(env.calls.publish.length, 0);

  env.cfg.commissioned = true;
  for (const [patch, re] of [
    [{ title: "too short" }, /title/],
    [{ title: "x".repeat(161) }, /title/],
    [{ title: undefined }, /title is required/],
    [{ description: "x".repeat(2001) }, /description/],
    [{ priceUsd: 0 }, /priceUsd/],
    [{ priceUsd: "cheap" }, /priceUsd/],
    [{ priceUsd: 0.3 }, /lowest price is \$0\.50/],
    [{ quantity: 0 }, /quantity/],
    [{ quantity: 101 }, /quantity/],
    [{ quantity: 2.5 }, /whole number/],
    [{ deliveryTime: "Week1" }, /deliveryTime/],
    [{ coverImage: 5 }, /coverImage/],
    [{ title: "Rocket League FunPay drops bundle" }, /FunPay/],
    [{ description: "Sold by fake_seller_x, enjoy" }, /seller/],
  ]) {
    r = await call("POST", url, { ...body, ...patch });
    assert.equal(r.status, 400, JSON.stringify(patch));
    assert.match(r.body.error, re);
  }
  // Titles another path takes before the FunPay branch could ever run.
  for (const [t, re] of [
    ["Rocket League Twitch Drops Automatic Farming 120 Days", /farming-service/],
    ["Rocket League Twitch Drops automatic  farming 1 Year", /farming-service/],
    ["Rocket League Drops — Starter Bundle — PACK OF 5 ACCOUNTS (-5%)", /bulk pack/],
    ["Rocket League Drops - pack of 12 accounts", /bulk pack/],
  ]) {
    r = await call("POST", url, { ...body, title: t });
    assert.equal(r.status, 409, t);
    assert.match(r.body.error, re);
  }
  assert.equal(env.calls.publish.length, 0);

  r = await call("POST", url, { ...body, junk: "x", origin: "auto", set: oid(), status: "sold" });
  assert.equal(r.status, 200);
  assert.deepEqual(env.calls.publish, [
    {
      game: "Rocket League",
      title: body.title,
      description: body.description,
      priceUsd: 2.89,
      quantity: 3,
      deliveryTime: "Hour2",
      coverImagePath: path.join(REAL_PUBLIC, "app-icon-192.png"),
    },
  ]);
  assert.deepEqual(env.Listing.created, [
    {
      marketplace: "eldorado",
      externalId: GUID_NEW,
      url: eldUrl(GUID_NEW),
      title: body.title,
      description: body.description,
      price: 2.89,
      status: "active",
      origin: "manual",
      funpaySource: s._id,
    },
  ]);
  assert.deepEqual(r.body.listing, {
    externalId: GUID_NEW, title: body.title, price: 2.89, status: "active", autoPaused: false, url: eldUrl(GUID_NEW), lastError: "",
  });
  assert.equal(s.listingQuantity, 3, "the watcher now holds the offer at the quantity just chosen");

  // One active Eldorado offer per deal.
  r = await call("POST", url, { ...body, title: "Another title for the very same deal" });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already has an active Eldorado listing/);
  assert.equal(env.calls.publish.length, 1);

  // No max buy price: an order could never be bought.
  const z = env.Source.seed({ offerId: "3002", maxBuyPriceUsd: 0 });
  r = await call("POST", P + "/sources/" + z._id + "/listing", { ...body, title: "A title nobody else uses here" });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /max buy price/);
  assert.equal(env.calls.publish.length, 1);
  assert.equal((await call("POST", P + "/sources/" + oid() + "/listing", body)).status, 404);
});

test("listing cover and defaults: outside public/ or not an image falls back to the default; twin titles and a lost row are handled", async () => {
  env.cfg.commissioned = true;
  const a = env.Source.seed({ offerId: "3101", itemsText: "Item one", maxBuyPriceUsd: 1 });
  const url = P + "/sources/" + a._id + "/listing";
  const def = path.join(REAL_PUBLIC, "listing-default-cover.png");
  const title = "Rocket League Twitch Drops — Item one";
  for (const cover of ["/../server.js", "/../../etc/hosts", "/admin-nav.js", "/drop-images/missing.png", "https://cdn.example/x.png", "", undefined]) {
    env.calls.publish.length = 0;
    env.Listing.rows.length = 0;
    const r = await call("POST", url, { title, priceUsd: "1.5", coverImage: cover });
    assert.equal(r.status, 200, String(cover));
    assert.equal(env.calls.publish[0].coverImagePath, def, String(cover));
  }
  const used = env.calls.publish[0];
  assert.equal(used.description, "Item one\n\n" + env.engine.BUYER_GUIDE, "no description given: the items, then the buyer guide");
  assert.equal(used.quantity, 5, "the deal's listing quantity");
  assert.equal(used.deliveryTime, "Hour1");
  assert.equal(used.priceUsd, 1.5);

  // Eldorado bans duplicate offers: the same title, case and punctuation aside.
  const b = env.Source.seed({ offerId: "3102", maxBuyPriceUsd: 1 });
  let r = await call("POST", P + "/sources/" + b._id + "/listing", { title: "rocket league twitch drops: ITEM ONE!", priceUsd: 1.5 });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /same title is already on sale/);
  assert.equal(env.calls.publish.length, 1);

  // Published, but our row could not be saved: the offer is taken off sale.
  env.Listing.create = async () => {
    throw new Error("validation failed");
  };
  r = await quiet(() => call("POST", P + "/sources/" + b._id + "/listing", { title: "A unique title for the failing save", priceUsd: 1.5 }));
  assert.equal(r.status, 500);
  assert.ok(r.body.error.includes(GUID_NEW));
  assert.match(r.body.error, /paused on Eldorado/);
  assert.deepEqual(env.calls.delist, [GUID_NEW]);
});

test("POST /sources/:id/link: only a plain Eldorado row; every other stock mode is refused; unlink waits for open orders", async () => {
  const s = env.Source.seed({ offerId: "4001", maxBuyPriceUsd: 1 });
  const other = env.Source.seed({ offerId: "4002" });
  const url = P + "/sources/" + s._id + "/link";
  const guid = (n) => "0a1b2c3d-5555-4666-8777-" + String(n).padStart(12, "0");
  const cases = [
    [{ set: oid() }, /drop set/],
    [{ units: [{ login: "fake_unit_login", contentId: "u1" }] }, /holds units/],
    [{ accountOffer: oid() }, /account listing/],
    [{ noclaimStock: true }, /no-claim shop/],
    [{ unclaimedGame: "Some Game" }, /no-claim farm/],
    [{ autoClaimSet: true }, /drop archive/],
    [{ bulkOfferId: oid() }, /bulk pack/],
    [{ bulkPackSize: 5 }, /bulk pack/],
    [{ rentFarm: true }, /rent-farm/],
    [{ accountId: oid() }, /account is attached/],
    [{ accountLogin: "fake_attached_login" }, /account is attached/],
    [{ autoDeliver: true }, /auto-delivery/],
    [{ requiredDrops: [{ name: "Some Item", qty: 1 }] }, /required drops/],
    [{ title: "Rocket League Twitch Drops Automatic Farming 120 Days" }, /farming-service/],
    [{ title: "Rocket League Drops — Starter Bundle — PACK OF 5 ACCOUNTS (-5%)" }, /bulk pack/],
    [{ funpaySource: other._id }, /another deal/],
  ];
  cases.forEach(([fields], i) => env.Listing.seed({ marketplace: "eldorado", externalId: guid(i), title: "Some listing " + i, ...fields }));
  for (const [i, [, re]] of cases.entries()) {
    const r = await call("POST", url, { externalId: guid(i) });
    assert.equal(r.status, 409, String(re));
    assert.match(r.body.error, re);
  }
  assert.ok(env.Listing.rows.every((l) => l.funpaySource === null || String(l.funpaySource) === String(other._id)), "nothing was linked");

  env.Listing.seed({ marketplace: "g2g", externalId: guid(50) });
  assert.equal((await call("POST", url, { externalId: guid(50) })).status, 404, "not an Eldorado listing");
  assert.equal((await call("POST", url, { externalId: guid(51) })).status, 404);
  assert.equal((await call("POST", url, { externalId: "not-an-offer-id" })).status, 400);
  assert.equal((await call("POST", url, {})).status, 400);
  assert.equal((await call("POST", P + "/sources/" + oid() + "/link", { externalId: guid(0) })).status, 404);

  // Two rows for one offer, whatever their status: the fulfiller would take
  // whichever it finds first, not necessarily the linked one.
  env.Listing.seed({ marketplace: "eldorado", externalId: guid(70), title: "Old row of the offer", status: "delisted" });
  env.Listing.seed({ marketplace: "eldorado", externalId: guid(70), title: "New row of the offer" });
  let r = await call("POST", url, { externalId: guid(70) });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /more than one listing row/);
  assert.deepEqual(env.Listing.calls.filter((c) => c.op === "updateOne"), [], "no refusal wrote anything");

  // A plain manual row links — by link or id, once — and only funpaySource is written.
  const plain = env.Listing.seed({ marketplace: "eldorado", externalId: guid(60), title: "Plain manual listing" });
  r = await call("POST", url, { externalId: eldUrl(guid(60).toUpperCase()) });
  assert.equal(r.status, 200);
  assert.equal(String(plain.funpaySource), String(s._id));
  assert.equal(r.body.listing.externalId, guid(60));
  assert.deepEqual(env.Listing.calls.filter((c) => c.op === "updateOne"), [
    { op: "updateOne", query: { _id: plain._id, funpaySource: null }, update: { $set: { funpaySource: s._id } } },
  ]);
  const untouched = {
    set: null, units: [], autoClaimSet: false, unclaimedGame: "", noclaimStock: false, accountOffer: null, bulkOfferId: null,
    bulkPackSize: 0, requiredDrops: [], rentFarm: false, accountId: "", accountLogin: "", autoDeliver: false, status: "active",
  };
  for (const [k, v] of Object.entries(untouched)) assert.deepEqual(plain[k], v, k);
  r = await call("POST", url, { externalId: guid(60) });
  assert.equal(r.status, 200);
  assert.equal(r.body.already, true);

  // One active offer per deal.
  env.Listing.seed({ marketplace: "eldorado", externalId: guid(61), title: "Second plain listing" });
  r = await call("POST", url, { externalId: guid(61) });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already has an active Eldorado listing/);

  // Unlink is refused while an Eldorado order of this deal is being worked.
  const p = env.Purchase.seed({ source: s._id, kind: "order", state: "bought", eldoradoOrderId: "eld-order-9" });
  r = await call("POST", P + "/sources/" + s._id + "/unlink");
  assert.equal(r.status, 409);
  assert.match(r.body.error, /still open/);
  assert.equal(String(plain.funpaySource), String(s._id));
  p.state = "failed";
  r = await call("POST", P + "/sources/" + s._id + "/unlink");
  assert.equal(r.status, 200);
  assert.equal(r.body.unlinked, 1);
  assert.equal(plain.funpaySource, null);
});

test("GET /covers: the default first, then at most 40 existing drop images of that game under public/", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fp-covers-"));
  try {
    const pub = path.join(root, "public");
    fs.mkdirSync(path.join(pub, "drop-images"), { recursive: true });
    fs.writeFileSync(path.join(pub, "listing-default-cover.png"), "png");
    fs.writeFileSync(path.join(root, "outside.png"), "png");
    fs.writeFileSync(path.join(pub, "drop-images", "notes.txt"), "txt");
    fs.writeFileSync(path.join(pub, "drop-images", "other.png"), "png");
    for (let i = 0; i < 45; i++) {
      const f = "/drop-images/img" + String(i).padStart(2, "0") + ".png";
      fs.writeFileSync(path.join(pub, f), "png");
      for (let n = 0; n <= i % 3; n++) env.DropLog.rows.push({ game: "Rocket League", imageLocal: f });
    }
    for (let n = 0; n < 9; n++) {
      env.DropLog.rows.push(
        { game: "Rocket League", imageLocal: "/drop-images/missing.png" },
        { game: "rocket league", imageLocal: "/../outside.png" },
        { game: "Rocket League", imageLocal: "/drop-images/notes.txt" },
        { game: "Rocket League", imageLocal: "" },
      );
    }
    env.DropLog.rows.push({ game: "Other Game", imageLocal: "/drop-images/other.png" });
    deps.publicDir = pub;

    let r = await call("GET", P + "/covers?game=Rocket%20League");
    assert.equal(r.status, 200);
    const c = r.body.covers;
    assert.equal(c[0], "/listing-default-cover.png");
    assert.equal(c.length, 41, "the default plus 40");
    assert.equal(new Set(c).size, 41);
    assert.ok(c.slice(1).every((p) => /^\/drop-images\/img\d\d\.png$/.test(p)), "only existing images inside public/");
    assert.ok(c.slice(1, 16).every((p) => Number(p.match(/img(\d\d)/)[1]) % 3 === 2), "most-cached first");

    r = await call("GET", P + "/covers?game=Other%20Game");
    assert.deepEqual(r.body.covers, ["/listing-default-cover.png", "/drop-images/other.png"]);
    r = await call("GET", P + "/covers");
    assert.deepEqual(r.body.covers, ["/listing-default-cover.png"]);
    r = await call("GET", P + "/covers?game=" + encodeURIComponent("Rocket.*"));
    assert.deepEqual(r.body.covers, ["/listing-default-cover.png"], "the game is matched literally");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- money + purchases

test("POST /sources/:id/buy: confirmMaxUsd is the deal's own max, one purchase at a time, a refusal before any money keeps its code", async () => {
  const s = env.Source.seed({ offerId: "6001", maxBuyPriceUsd: 1.4 });
  const url = P + "/sources/" + s._id + "/buy";
  for (const bad of [{}, { confirmMaxUsd: "lots" }, { confirmMaxUsd: 0 }, { confirmMaxUsd: -1 }, { confirmMaxUsd: null }]) {
    assert.equal((await call("POST", url, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call("POST", P + "/sources/" + oid() + "/buy", { confirmMaxUsd: 1.4 })).status, 404);
  // Anything but the deal's max price is a stale confirm box: never bought.
  for (const confirmMaxUsd of [1.39, 1.41, 51, "1.5"]) {
    const r = await call("POST", url, { confirmMaxUsd });
    assert.equal(r.status, 409, String(confirmMaxUsd));
    assert.match(r.body.error, /reload and confirm again/);
  }
  const none = env.Source.seed({ offerId: "6002", maxBuyPriceUsd: 0 });
  assert.equal((await call("POST", P + "/sources/" + none._id + "/buy", { confirmMaxUsd: 1 })).status, 409);
  assert.equal(env.calls.manualBuy.length, 0);

  // Passed on exactly as confirmed, never rounded.
  const odd = env.Source.seed({ offerId: "6003", maxBuyPriceUsd: 1.405 });
  assert.equal((await call("POST", P + "/sources/" + odd._id + "/buy", { confirmMaxUsd: 1.405 })).status, 200);
  assert.deepEqual(env.calls.manualBuy, [[String(odd._id), { confirmMaxUsd: 1.405, actor: "admin:owner-1" }]]);
  env.calls.manualBuy.length = 0;

  // An ops refusal before any row keeps its status (409 by default).
  env.next.manualBuy = async () => ({ ok: false, purchaseId: null, state: null, reason: "the 24 h spend cap would be passed", trace: [] });
  let r = await call("POST", url, { confirmMaxUsd: 1.4 });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /spend cap/);
  env.next.manualBuy = async () => ({ ok: false, purchaseId: null, reason: "confirm the max price first", status: 400 });
  assert.equal((await call("POST", url, { confirmMaxUsd: 1.4 })).status, 400);
  env.next.manualBuy = async () => ({ ok: false, purchaseId: null, reason: "deal not found", status: 404 });
  assert.equal((await call("POST", url, { confirmMaxUsd: 1.4 })).status, 404);
  env.calls.manualBuy.length = 0;

  // A second click while a purchase runs is refused, not queued.
  let release = null;
  const pid = oid();
  env.next.manualBuy = () =>
    new Promise((resolve) => {
      release = () =>
        resolve({
          ok: true, purchaseId: pid, state: "received", reason: "", funpayOrderId: "FAKEORDER1", commissioned: true,
          trace: [{ step: "offer", status: 200 }], credentials: SENTINEL.cred, login: "fake_login_3",
        });
    });
  const first = call("POST", url, { confirmMaxUsd: "1.40" });
  for (let i = 0; i < 400 && !release; i++) await new Promise((t) => setTimeout(t, 5));
  assert.ok(release, "the first purchase started");
  r = await call("POST", url, { confirmMaxUsd: 1.4 });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already running/);
  release();
  r = await first;
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    success: true, ok: true, purchaseId: pid, state: "received", reason: "", funpayOrderId: "FAKEORDER1", commissioned: true,
    trace: [{ step: "offer", status: 200 }],
  });
  noSecrets(r.text);
  assert.deepEqual(env.calls.manualBuy, [[String(s._id), { confirmMaxUsd: 1.4, actor: "admin:owner-1" }]], "the refused click never reached ops");

  // An attempt that wrote a row and then failed is a result to show, not an error.
  env.next.manualBuy = async () => ({ ok: false, purchaseId: pid, state: "needs_review", reason: "cut off mid-way", trace: [] });
  r = await call("POST", url, { confirmMaxUsd: 1.4 });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.state, "needs_review");
});

test("POST /purchases/:id/reveal: the only place a login leaves, audited with meta {purchaseId} only", async () => {
  const s = env.Source.seed({ offerId: "5001" });
  const p = env.Purchase.seed({ source: s._id, kind: "manual", state: "received", login: "fake_login_1", credentials: SENTINEL.cred, trace: [{ step: SENTINEL.trace }] });
  const r = await call("POST", P + "/purchases/" + p._id + "/reveal");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { success: true, credentials: { username: "fake_login_1", password: SENTINEL.password } });
  assert.ok(!r.text.includes(SENTINEL.cred) && !r.text.includes(SENTINEL.trace));
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(env.calls.reveal, [String(p._id)]);

  assert.equal(env.events.length, 1);
  const ev = env.events[0];
  assert.equal(ev.category, "funpay-resale");
  assert.equal(ev.actor, "admin:owner-1");
  assert.deepEqual(ev.meta, { purchaseId: String(p._id) });
  const evText = JSON.stringify(ev);
  assert.ok(!evText.includes(SENTINEL.password) && !evText.includes("fake_login_1") && !evText.includes(SENTINEL.cred));

  // Nothing stored: refused before ops is asked, and nothing audited.
  const q = env.Purchase.seed({ source: s._id, kind: "order", state: "bought" });
  assert.equal((await call("POST", P + "/purchases/" + q._id + "/reveal")).status, 409);
  assert.equal((await call("POST", P + "/purchases/" + oid() + "/reveal")).status, 404);
  assert.equal((await call("POST", P + "/purchases/x/reveal")).status, 404);
  assert.equal(env.events.length, 1);
  assert.equal(env.calls.reveal.length, 1);

  // utils/funpayResaleOps throws Errors carrying .status: passed through, never
  // turned into a 500; any other failure is a 500. Nothing is audited for them.
  for (const [status, expected] of [[409, 409], [404, 404], [400, 400], [418, 500], [undefined, 500]]) {
    env.next.reveal = () => {
      const e = new Error("the stored login could not be read back");
      if (status) e.status = status;
      throw e;
    };
    const res = await quiet(() => call("POST", P + "/purchases/" + p._id + "/reveal"));
    assert.equal(res.status, expected, String(status));
    assert.equal(res.body.success, false);
    assert.match(res.body.error, /could not be read back/);
  }
  assert.equal(env.events.length, 1, "a failed reveal is not audited as one");
});

test("purchase actions keep the contract's state rules and never return the stored login", async () => {
  const s = env.Source.seed({ offerId: "7001" });
  const order = (state) =>
    env.Purchase.seed({ source: s._id, kind: "order", state, eldoradoOrderId: "eld-" + state + "-" + seq, credentials: SENTINEL.cred, trace: [{ step: SENTINEL.trace }] });
  const manual = env.Purchase.seed({ source: s._id, kind: "manual", state: "bought" });
  const u = (p, what) => P + "/purchases/" + p._id + "/" + what;

  // Enter a login: an Eldorado-order purchase that is bought / needs review / failed.
  let r = await call("POST", u(manual, "credential"), { login: "fake_login_2", password: "x" });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Eldorado order/);
  assert.equal((await call("POST", u(order("delivered"), "credential"), { login: "fake_login_2", password: "x" })).status, 409);
  assert.equal((await call("POST", u(order("new"), "credential"), { login: "fake_login_2", password: "x" })).status, 409);
  assert.equal((await call("POST", u(order("bought"), "credential"), { login: "has space", password: "x" })).status, 400);
  assert.equal((await call("POST", u(order("bought"), "credential"), { login: "fake_login_2" })).status, 400);
  assert.equal((await call("POST", u(order("bought"), "credential"), { login: "fake_login_2", password: "a\nb" })).status, 400);
  assert.equal(env.calls.setManual.length, 0);
  const nr = order("needs_review");
  r = await call("POST", u(nr, "credential"), { login: "fake_login_2", password: "  Pw-typed-1 ", state: "delivered" });
  assert.equal(r.status, 200);
  assert.deepEqual(env.calls.setManual, [[String(nr._id), { login: "fake_login_2", password: "Pw-typed-1" }]]);
  assert.equal(r.body.purchase.state, "received");
  assert.ok(!r.text.includes("Pw-typed-1"));
  noSecrets(r.text);

  // Retry: a failed Eldorado-order purchase only.
  assert.equal((await call("POST", u(order("bought"), "retry"))).status, 409);
  manual.state = "failed";
  assert.equal((await call("POST", u(manual, "retry"))).status, 409);
  const f = order("failed");
  r = await call("POST", u(f, "retry"));
  assert.equal(r.status, 200);
  assert.equal(r.body.purchase.state, "new");
  assert.deepEqual(env.calls.retry, [String(f._id)]);
  env.next.retry = { ok: false, reason: "it changed meanwhile" };
  r = await call("POST", u(order("failed"), "retry"));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /changed meanwhile/);
  env.next.retry = { ok: false, reason: "this unit was already bought on FunPay", status: 409 };
  assert.equal((await call("POST", u(order("failed"), "retry"))).status, 409);
  env.next.retry = { ok: false, reason: "purchase not found", status: 404 };
  assert.equal((await call("POST", u(order("failed"), "retry"))).status, 404, "an ops refusal keeps its status");

  // Close: anything not delivered.
  assert.equal((await call("POST", u(order("delivered"), "close"), { note: "x" })).status, 409);
  assert.equal((await call("POST", u(manual, "close"), { note: 5 })).status, 400);
  r = await call("POST", u(manual, "close"), { note: "seller refunded" });
  assert.equal(r.status, 200);
  assert.deepEqual(env.calls.close, [[String(manual._id), { note: "seller refunded" }]]);
  assert.match(r.body.purchase.reason, /^closed by owner: seller refunded/);
  noSecrets(r.text);
  assert.equal((await call("POST", P + "/purchases/" + oid() + "/close", {})).status, 404);
});

test("refresh runs the watcher for one deal (busy = 409); test passes back only its own fields", async () => {
  const s = env.Source.seed({ offerId: "8001", label: "Watched deal" });
  let r = await call("POST", P + "/sources/" + s._id + "/refresh");
  assert.equal(r.status, 200);
  assert.deepEqual(env.calls.runOnce, [{ onlySourceId: String(s._id) }]);
  assert.deepEqual(r.body.result, { ok: true, sources: 1 });
  assert.equal(r.body.source.label, "Watched deal");
  env.next.runOnce = { skipped: "already running" };
  r = await call("POST", P + "/sources/" + s._id + "/refresh");
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already running/);
  // The watcher never throws; a broken run is reported, never shown as "refreshed".
  env.next.runOnce = { ok: false, error: "settings: unreadable" };
  r = await quiet(() => call("POST", P + "/sources/" + s._id + "/refresh"));
  assert.equal(r.status, 500);
  assert.match(r.body.error, /not refreshed: settings: unreadable/);
  env.next.runOnce = { ok: false, error: "source not found" };
  assert.equal((await call("POST", P + "/sources/" + s._id + "/refresh")).status, 404);
  assert.equal((await call("POST", P + "/sources/" + oid() + "/refresh")).status, 404);

  r = await call("POST", P + "/sources/" + s._id + "/test");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    success: true, ok: true, signedIn: true, user: "owner-fp", priceUsd: 1.17, balanceUsd: 9.5, maxPriceUsd: 1.4, buyFormFound: true, reason: "",
  });
  assert.deepEqual(env.calls.testSource, [String(s._id)]);
  noSecrets(r.text);
  // A failed test is the test's verdict (200); a missing deal is a 404.
  env.next.testSource = { ok: false, signedIn: false, user: "", priceUsd: null, balanceUsd: null, buyFormFound: false, maxPriceUsd: 1.4, reason: "FunPay says nobody is signed in" };
  r = await call("POST", P + "/sources/" + s._id + "/test");
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.ok, r.body.signedIn, r.body.reason], [false, false, "FunPay says nobody is signed in"]);
  env.next.testSource = { ok: false, reason: "deal not found", status: 404 };
  assert.equal((await call("POST", P + "/sources/" + s._id + "/test")).status, 404);
});

test("POST /purchases/:id/check: one more read of a bought purchase's FunPay order; the login never comes back here", async () => {
  const s = env.Source.seed({ offerId: "9001" });
  const bought = env.Purchase.seed({ source: s._id, kind: "order", state: "bought", eldoradoOrderId: "eld-order-77", funpayOrderId: "FAKEORDER77" });
  let r = await call("POST", P + "/purchases/" + bought._id + "/check", {});
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.ok, r.body.state, r.body.reason], [true, "received", ""]);
  assert.equal(r.body.purchase.state, "received");
  assert.equal(r.body.purchase.login, "fake_login_9");
  assert.ok(!("credentials" in r.body) && !("login" in r.body) && !("credentials" in r.body.purchase));
  noSecrets(r.text);
  assert.deepEqual(env.calls.recheck, [String(bought._id)]);

  // Only a bought purchase: anything else is refused before FunPay is asked.
  for (const state of ["new", "waiting_chat", "buying", "received", "delivered", "failed", "needs_review"]) {
    const p = env.Purchase.seed({ source: s._id, kind: "manual", state });
    r = await call("POST", P + "/purchases/" + p._id + "/check");
    assert.equal(r.status, 409, state);
  }
  assert.equal((await call("POST", P + "/purchases/" + oid() + "/check")).status, 404);
  assert.equal(env.calls.recheck.length, 1);

  // Still nothing from the seller: a verdict to show, not an error.
  const waiting = env.Purchase.seed({ source: s._id, kind: "manual", state: "bought" });
  env.next.recheck = { ok: false, state: "bought", reason: "the seller has not delivered yet" };
  r = await call("POST", P + "/purchases/" + waiting._id + "/check");
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.ok, r.body.state, r.body.reason], [false, "bought", "the seller has not delivered yet"]);
  // A refusal from ops keeps its status.
  env.next.recheck = { ok: false, reason: "this purchase is no longer waiting for the seller", status: 409 };
  assert.equal((await call("POST", P + "/purchases/" + waiting._id + "/check")).status, 409);
  // An ops module without the function yet: a clear 503, not a crash.
  delete env.ops.recheckPurchase;
  r = await quiet(() => call("POST", P + "/purchases/" + waiting._id + "/check"));
  assert.equal(r.status, 503);
  assert.match(r.body.error, /re-check/);
});
