/* global fetch */
// Route-level tests for the CHZZK farm API (docs/CHZZK-FARM.md §11).
//
// What these guard:
//   - Every route refuses an anonymous or non-superadmin caller.
//   - Each route calls the farm method named in §11 with the parsed input.
//   - A ChzzkError with code AUTH -> 401, EGRESS/TIMEOUT -> 503, other -> 502.
//   - Reveal records who asked (farm.revealCode gets the admin name) and the
//     response is no-store. Nothing else returns a code or a cookie.
//
// The farm is swapped for a tiny recording stub via router._setFarmForTests;
// no network, no Mongo, no transport.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

process.env.CRED_SECRET ||= "chzzk-routes-test-cred-secret";

const chzzkRoutes = require("../routes/chzzkRoutes");
const { ChzzkError } = require("../utils/chzzk/errors");

// --- stub & harness ----------------------------------------------------------

// A farm stub whose every method records { name, args } and returns a safe
// default. Pass overrides to replace per-method behaviour for one test.
function makeFarm(overrides = {}) {
  const calls = [];
  const defaults = {
    stateView: () => ({ switch: { on: true }, totals: { accounts: 0 }, accounts: [] }),
    importAccounts: () => [{ ok: true, created: true, nickname: "nick", userIdHash8: "aabbccdd" }],
    checkAccounts: () => ({ total: 0 }),
    updateAccount: () => true,
    deleteAccounts: () => ({ deleted: 0, keptCodes: 0 }),
    campaignsView: () => ({ campaigns: [] }),
    refreshCampaigns: () => ({ found: 0, updated: 0 }),
    addCampaign: () => ({ ok: true, campaign: { campaignNo: 1 } }),
    setCampaignEnabled: () => true,
    rewardsView: () => ({ rewards: [] }),
    revealCode: () => ({ code: "CHZZK-FAKE-CODE" }),
    collectNow: () => ({ queued: 0 }),
    activityView: () => ({ entries: [] }),
    setSwitch: (on) => ({ on }),
    resetProgress: () => true,
    stockView: () => ({ stock: [], totals: { stored: 0, fresh: 0, revealed: 0, waiting: 0, expired: 0 } }),
  };
  const farm = { calls };
  for (const name of Object.keys(defaults)) {
    farm[name] = async (...args) => {
      calls.push({ name, args });
      const fn = overrides[name] || defaults[name];
      return fn(...args);
    };
  }
  return farm;
}

const SUPERADMIN = { username: "root", role: "superadmin" };
const PLAIN_ADMIN = { username: "mod", role: "admin" };

function harness(admin) {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use((req, _res, next) => {
    req.session = admin ? { admin } : {};
    next();
  });
  app.use(chzzkRoutes);
  const server = app.listen(0);
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function call(url, method, path, body) {
  const res = await fetch(url + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await res.text();
  let json = null;
  try { json = JSON.parse(t); } catch { /* non-JSON is fine */ }
  return { status: res.status, text: t, json, headers: res.headers };
}

// Each test gets a fresh server + fresh stub; the router's farm is swapped and
// restored around the test body so cross-test leakage is impossible.
function withServer(stub, admin, fn) {
  return async (t) => {
    chzzkRoutes._setFarmForTests(stub);
    const { server, url } = harness(admin);
    try {
      await fn({ url, stub, t });
    } finally {
      await new Promise((r) => server.close(() => r()));
      chzzkRoutes._setFarmForTests(null);
    }
  };
}

// --- guard: anonymous & non-superadmin ---------------------------------------

const TABLE = [
  ["GET", "/api/chzzk/state"],
  ["POST", "/api/chzzk/accounts/import"],
  ["POST", "/api/chzzk/accounts/check"],
  ["POST", "/api/chzzk/accounts/update"],
  ["POST", "/api/chzzk/accounts/delete"],
  ["GET", "/api/chzzk/campaigns"],
  ["POST", "/api/chzzk/campaigns/refresh"],
  ["POST", "/api/chzzk/campaigns/add"],
  ["POST", "/api/chzzk/campaigns/enable"],
  ["GET", "/api/chzzk/rewards"],
  ["POST", "/api/chzzk/rewards/reveal"],
  ["POST", "/api/chzzk/rewards/collect"],
  ["GET", "/api/chzzk/activity"],
  ["POST", "/api/chzzk/switch"],
  ["POST", "/api/chzzk/accounts/reset-progress"],
  ["GET", "/api/chzzk/stock"],
];

test("every route refuses an anonymous caller (401)", withServer(makeFarm(), null, async ({ url, stub }) => {
  for (const [m, p] of TABLE) {
    const r = await call(url, m, p, m === "POST" ? {} : undefined);
    assert.equal(r.status, 401, `${m} ${p} expected 401, got ${r.status}`);
  }
  assert.equal(stub.calls.length, 0, "farm must never be called for an anonymous request");
}));

test("every route refuses a non-superadmin (403)", withServer(makeFarm(), PLAIN_ADMIN, async ({ url, stub }) => {
  for (const [m, p] of TABLE) {
    const r = await call(url, m, p, m === "POST" ? {} : undefined);
    assert.equal(r.status, 403, `${m} ${p} expected 403, got ${r.status}`);
  }
  assert.equal(stub.calls.length, 0, "farm must never be called for a non-superadmin request");
}));

// --- happy-path per route ----------------------------------------------------

test("GET /state returns farm.stateView()", withServer(
  makeFarm({ stateView: () => ({ switch: { on: false }, totals: { accounts: 3 }, accounts: ["x"] }) }),
  SUPERADMIN,
  async ({ url, stub }) => {
    const r = await call(url, "GET", "/api/chzzk/state");
    assert.equal(r.status, 200);
    assert.equal(r.json.success, true);
    assert.equal(r.json.switch.on, false);
    assert.equal(r.json.totals.accounts, 3);
    assert.deepEqual(stub.calls, [{ name: "stateView", args: [] }]);
  },
));

test("POST /accounts/import rejects empty body, forwards text otherwise", withServer(
  makeFarm({ importAccounts: () => [{ ok: true }, { ok: false, error: "no NID_AUT" }] }),
  SUPERADMIN,
  async ({ url, stub }) => {
    const empty = await call(url, "POST", "/api/chzzk/accounts/import", {});
    assert.equal(empty.status, 400);
    assert.equal(empty.json.success, false);

    const blank = await call(url, "POST", "/api/chzzk/accounts/import", { cookies: "   " });
    assert.equal(blank.status, 400);

    const big = await call(url, "POST", "/api/chzzk/accounts/import", { cookies: "x".repeat(91 * 1024) });
    assert.equal(big.status, 400);

    const ok = await call(url, "POST", "/api/chzzk/accounts/import", { cookies: "   [cookie] " });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.success, true);
    assert.equal(ok.json.results.length, 2);
    assert.equal(stub.calls.filter((c) => c.name === "importAccounts").length, 1);
    assert.equal(stub.calls.find((c) => c.name === "importAccounts").args[0], "[cookie]");
  },
));

test("POST /accounts/check passes ids and returns total", withServer(
  makeFarm({ checkAccounts: (ids) => ({ total: ids.length }) }),
  SUPERADMIN,
  async ({ url, stub }) => {
    const r = await call(url, "POST", "/api/chzzk/accounts/check", { ids: ["a", "b", "a", " "] });
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 2); // dedup + blank-trim
    const empty = await call(url, "POST", "/api/chzzk/accounts/check", {});
    assert.equal(empty.status, 200);
    assert.equal(empty.json.total, 0);
    const bad = await call(url, "POST", "/api/chzzk/accounts/check", { ids: "nope" });
    assert.equal(bad.status, 400);
    const checkCalls = stub.calls.filter((c) => c.name === "checkAccounts");
    assert.equal(checkCalls.length, 2);
    assert.deepEqual(checkCalls[0].args[0], ["a", "b"]);
    assert.deepEqual(checkCalls[0].args[1], { background: true }, "the route never waits for the checks");
  },
));

test("POST /accounts/update requires id and at least one field; 404 on unknown", withServer(
  makeFarm({ updateAccount: (id) => id === "known" }),
  SUPERADMIN,
  async ({ url }) => {
    const noId = await call(url, "POST", "/api/chzzk/accounts/update", { sold: true });
    assert.equal(noId.status, 400);
    const noChange = await call(url, "POST", "/api/chzzk/accounts/update", { id: "x" });
    assert.equal(noChange.status, 400);
    const longNote = await call(url, "POST", "/api/chzzk/accounts/update", { id: "x", note: "n".repeat(600) });
    assert.equal(longNote.status, 400);
    const miss = await call(url, "POST", "/api/chzzk/accounts/update", { id: "ghost", paused: true });
    assert.equal(miss.status, 404);
    const ok = await call(url, "POST", "/api/chzzk/accounts/update", { id: "known", sold: true, paused: false, note: "ok" });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.success, true);
  },
));

test("POST /accounts/delete requires ids, returns deleted/keptCodes", withServer(
  makeFarm({ deleteAccounts: (ids) => ({ deleted: ids.length, keptCodes: 7 }) }),
  SUPERADMIN,
  async ({ url, stub }) => {
    const miss = await call(url, "POST", "/api/chzzk/accounts/delete", {});
    assert.equal(miss.status, 400);
    const ok = await call(url, "POST", "/api/chzzk/accounts/delete", { ids: ["a", "b"] });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.deleted, 2);
    assert.equal(ok.json.keptCodes, 7);
    assert.deepEqual(stub.calls.find((c) => c.name === "deleteAccounts").args[0], ["a", "b"]);
  },
));

test("GET /campaigns returns farm.campaignsView()", withServer(
  makeFarm({ campaignsView: () => ({ campaigns: [{ campaignNo: 42, title: "T" }] }) }),
  SUPERADMIN,
  async ({ url }) => {
    const r = await call(url, "GET", "/api/chzzk/campaigns");
    assert.equal(r.status, 200);
    assert.equal(r.json.campaigns.length, 1);
    assert.equal(r.json.campaigns[0].campaignNo, 42);
  },
));

test("POST /campaigns/refresh returns found/updated", withServer(
  makeFarm({ refreshCampaigns: () => ({ found: 4, updated: 2 }) }),
  SUPERADMIN,
  async ({ url }) => {
    const r = await call(url, "POST", "/api/chzzk/campaigns/refresh", {});
    assert.equal(r.status, 200);
    assert.equal(r.json.found, 4);
    assert.equal(r.json.updated, 2);
  },
));

test("POST /campaigns/add validates integer window; 400 when farm says ok:false", withServer(
  makeFarm({ addCampaign: (no) => (no === 999 ? { ok: false, error: "already there" } : { ok: true, campaign: { campaignNo: no } }) }),
  SUPERADMIN,
  async ({ url }) => {
    for (const bad of [{}, { campaignNo: 0 }, { campaignNo: 1.5 }, { campaignNo: "nope" }, { campaignNo: 1_000_000_001 }]) {
      const r = await call(url, "POST", "/api/chzzk/campaigns/add", bad);
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    }
    const dup = await call(url, "POST", "/api/chzzk/campaigns/add", { campaignNo: 999 });
    assert.equal(dup.status, 400);
    assert.match(dup.json.error, /already/);
    const ok = await call(url, "POST", "/api/chzzk/campaigns/add", { campaignNo: 42 });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.campaign.campaignNo, 42);
  },
));

test("POST /campaigns/enable requires enabled; 404 on unknown", withServer(
  makeFarm({ setCampaignEnabled: (no) => no === 1 }),
  SUPERADMIN,
  async ({ url, stub }) => {
    const noFlag = await call(url, "POST", "/api/chzzk/campaigns/enable", { campaignNo: 1 });
    assert.equal(noFlag.status, 400);
    const miss = await call(url, "POST", "/api/chzzk/campaigns/enable", { campaignNo: 2, enabled: false });
    assert.equal(miss.status, 404);
    const ok = await call(url, "POST", "/api/chzzk/campaigns/enable", { campaignNo: 1, enabled: true });
    assert.equal(ok.status, 200);
    const enableArgs = stub.calls.find((c) => c.name === "setCampaignEnabled" && c.args[0] === 1).args;
    assert.deepEqual(enableArgs, [1, true]);
  },
));

test("GET /rewards parses accountId+campaignNo query", withServer(
  makeFarm({ rewardsView: () => ({ rewards: [{ id: "r1" }] }) }),
  SUPERADMIN,
  async ({ url, stub }) => {
    const ok = await call(url, "GET", "/api/chzzk/rewards?accountId=abc&campaignNo=55");
    assert.equal(ok.status, 200);
    assert.equal(ok.json.rewards.length, 1);
    const bad = await call(url, "GET", "/api/chzzk/rewards?campaignNo=NaN");
    assert.equal(bad.status, 400);
    const noArgs = await call(url, "GET", "/api/chzzk/rewards");
    assert.equal(noArgs.status, 200);
    const forward = stub.calls.find((c) => c.name === "rewardsView");
    assert.deepEqual(forward.args[0], { accountId: "abc", campaignNo: 55 });
  },
));

test("POST /rewards/reveal: 400 on bad id, 404 when none, 200 with code + no-store + who recorded", withServer(
  makeFarm({ revealCode: (id, who) => (id === "aaaaaaaaaaaaaaaaaaaaaaaa" ? { code: "SECRET-" + who } : null) }),
  SUPERADMIN,
  async ({ url, stub }) => {
    const missing = await call(url, "POST", "/api/chzzk/rewards/reveal", {});
    assert.equal(missing.status, 400);
    const notHex = await call(url, "POST", "/api/chzzk/rewards/reveal", { id: "nothex" });
    assert.equal(notHex.status, 400);
    const unknown = await call(url, "POST", "/api/chzzk/rewards/reveal", { id: "ffffffffffffffffffffffff" });
    assert.equal(unknown.status, 404);
    const ok = await call(url, "POST", "/api/chzzk/rewards/reveal", { id: "aaaaaaaaaaaaaaaaaaaaaaaa" });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.code, "SECRET-root");
    assert.equal(ok.headers.get("cache-control"), "no-store");
    const revealed = stub.calls.find((c) => c.name === "revealCode" && c.args[0] === "aaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(revealed.args[1], "root");
  },
));

test("POST /rewards/collect returns queued and forwards ids", withServer(
  makeFarm({ collectNow: (ids) => ({ queued: ids.length || 5 }) }),
  SUPERADMIN,
  async ({ url, stub }) => {
    const all = await call(url, "POST", "/api/chzzk/rewards/collect", {});
    assert.equal(all.status, 200);
    assert.equal(all.json.queued, 5);
    const some = await call(url, "POST", "/api/chzzk/rewards/collect", { ids: ["a", "b", "a"] });
    assert.equal(some.status, 200);
    assert.equal(some.json.queued, 2);
    assert.deepEqual(stub.calls.filter((c) => c.name === "collectNow").map((c) => c.args[0]), [[], ["a", "b"]]);
  },
));

test("GET /activity validates limit window and forwards accountId", withServer(
  makeFarm({ activityView: ({ limit }) => ({ entries: new Array(limit).fill({ at: 0, kind: "x" }) }) }),
  SUPERADMIN,
  async ({ url, stub }) => {
    const def = await call(url, "GET", "/api/chzzk/activity");
    assert.equal(def.status, 200);
    assert.equal(def.json.entries.length, 100);
    const too = await call(url, "GET", "/api/chzzk/activity?limit=501");
    assert.equal(too.status, 400);
    const zero = await call(url, "GET", "/api/chzzk/activity?limit=0");
    assert.equal(zero.status, 400);
    const ok = await call(url, "GET", "/api/chzzk/activity?limit=3&accountId=abc");
    assert.equal(ok.status, 200);
    assert.equal(ok.json.entries.length, 3);
    const last = stub.calls.filter((c) => c.name === "activityView").pop();
    assert.deepEqual(last.args[0], { limit: 3, accountId: "abc" });
  },
));

test("POST /switch forwards flag + actor and returns { on }", withServer(
  makeFarm({ setSwitch: (on, actor) => ({ on, _actor: actor }) }),
  SUPERADMIN,
  async ({ url, stub }) => {
    const miss = await call(url, "POST", "/api/chzzk/switch", {});
    assert.equal(miss.status, 400);
    const notBool = await call(url, "POST", "/api/chzzk/switch", { on: "yes" });
    assert.equal(notBool.status, 400);
    const off = await call(url, "POST", "/api/chzzk/switch", { on: false });
    assert.equal(off.status, 200);
    assert.equal(off.json.on, false);
    const flipped = stub.calls.find((c) => c.name === "setSwitch");
    assert.deepEqual(flipped.args, [false, "root"]);
  },
));

// --- error mapping (ChzzkError) ---------------------------------------------

const QUIET = { log: console.log, warn: console.warn, error: console.error };

test("ChzzkError AUTH -> 401 (logged out message)", withServer(
  makeFarm({ stateView: () => { throw new ChzzkError("not logged in", { code: "AUTH" }); } }),
  SUPERADMIN,
  async ({ url }) => {
    console.error = () => {};
    try {
      const r = await call(url, "GET", "/api/chzzk/state");
      assert.equal(r.status, 401);
      assert.equal(r.json.success, false);
      assert.match(r.json.error, /logged out/i);
    } finally {
      console.error = QUIET.error;
    }
  },
));

test("ChzzkError EGRESS/TIMEOUT -> 503 (egress not ready)", withServer(
  makeFarm({
    stateView: () => { throw new ChzzkError("no proxy", { code: "EGRESS" }); },
    campaignsView: () => { throw new ChzzkError("slow", { code: "TIMEOUT" }); },
  }),
  SUPERADMIN,
  async ({ url }) => {
    console.error = () => {};
    try {
      const egress = await call(url, "GET", "/api/chzzk/state");
      assert.equal(egress.status, 503);
      assert.match(egress.json.error, /egress not ready/i);
      const timeout = await call(url, "GET", "/api/chzzk/campaigns");
      assert.equal(timeout.status, 503);
      assert.match(timeout.json.error, /egress not ready/i);
    } finally {
      console.error = QUIET.error;
    }
  },
));

test("Other ChzzkError (HTTP/API) -> 502 with the plain message", withServer(
  makeFarm({ campaignsView: () => { throw new ChzzkError("CHZZK rejected the call", { code: "API" }); } }),
  SUPERADMIN,
  async ({ url }) => {
    console.error = () => {};
    try {
      const r = await call(url, "GET", "/api/chzzk/campaigns");
      assert.equal(r.status, 502);
      assert.equal(r.json.success, false);
      assert.match(r.json.error, /CHZZK rejected/);
    } finally {
      console.error = QUIET.error;
    }
  },
));

test("Request body is never logged (even on error)", withServer(
  makeFarm({ importAccounts: () => { throw new Error("boom"); } }),
  SUPERADMIN,
  async ({ url }) => {
    const seen = [];
    console.error = (...a) => { seen.push(a.join(" ")); };
    try {
      await call(url, "POST", "/api/chzzk/accounts/import", { cookies: "SECRET-COOKIE-STRING" });
    } finally {
      console.error = QUIET.error;
    }
    assert.ok(seen.length > 0, "an error was logged");
    for (const line of seen) {
      assert.ok(!line.includes("SECRET-COOKIE-STRING"), `logged line leaked cookie: ${line}`);
    }
  },
));

// --- v2 routes (docs/CHZZK-PANEL-V2.md) ---------------------------------------

test("POST /accounts/reset-progress validates and calls farm.resetProgress", withServer(makeFarm(), SUPERADMIN, async ({ url, stub }) => {
  let r = await call(url, "POST", "/api/chzzk/accounts/reset-progress", { id: "a1", campaignNo: 1954 });
  assert.equal(r.status, 200);
  assert.deepEqual(stub.calls.at(-1), { name: "resetProgress", args: ["a1", 1954] });
  r = await call(url, "POST", "/api/chzzk/accounts/reset-progress", { id: "a1", campaignNo: "x" });
  assert.equal(r.status, 400);
  r = await call(url, "POST", "/api/chzzk/accounts/reset-progress", { campaignNo: 5 });
  assert.equal(r.status, 400);
}));

test("POST /accounts/reset-progress answers 404 for an unknown account", withServer(makeFarm({ resetProgress: () => false }), SUPERADMIN, async ({ url }) => {
  const r = await call(url, "POST", "/api/chzzk/accounts/reset-progress", { id: "nope", campaignNo: 7 });
  assert.equal(r.status, 404);
}));

test("GET /stock returns farm.stockView() and never a code", withServer(makeFarm({
  stockView: () => ({ stock: [{ campaignNo: 1, rewardNo: 2, stored: 3, fresh: 2 }], totals: { stored: 3 } }),
}), SUPERADMIN, async ({ url }) => {
  const r = await call(url, "GET", "/api/chzzk/stock");
  assert.equal(r.status, 200);
  assert.equal(r.json.stock[0].fresh, 2);
  assert.ok(!/CHZZK-FAKE-CODE/.test(r.text));
}));
