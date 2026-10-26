const test = require("node:test");
const assert = require("node:assert/strict");

const watch = require("../utils/funpaySessionWatch");

function setup({ configured = true, answer, pauseOn = true, listings = [], sources = {} } = {}) {
  const calls = { delist: [], relist: [], pages: [], status: [] };
  const rows = listings.map((l) => ({ autoPaused: false, lastError: "", status: "active", funpaySource: "S", marketplace: "eldorado", ...l, save: async () => {} }));
  const match = (r, q) =>
    Object.entries(q).every(([k, v]) => {
      if (v && typeof v === "object" && "$ne" in v) return r[k] !== v.$ne;
      return r[k] === v;
    });
  Object.assign(watch.deps, {
    settings: () => ({
      getFunpayResale: () => ({ sessionConfigured: configured, pauseListingWhenSourceDown: pauseOn }),
      setFunpaySessionStatus: async (x) => calls.status.push(x),
    }),
    Listing: () => ({ find: async (q) => rows.filter((r) => match(r, q)) }),
    Source: () => ({
      findById: async (id) => (id in sources ? sources[id] : { autoDelivery: true, maxBuyPriceUsd: 1.5, priceUsd: 1.2, sellerRating: 5, missingSince: null }),
    }),
    mp: () => ({
      eldoradoDelist: async (id) => calls.delist.push(id),
      eldoradoRelist: async (id) => calls.relist.push(id),
    }),
    notify: async (t) => calls.pages.push(t),
    sessionFor: () => (configured ? { checkSession: async () => (typeof answer === "function" ? answer() : answer) } : null),
  });
  watch.state.alerted = false;
  return { calls, rows };
}

test("no saved login: does nothing", async () => {
  const env = setup({ configured: false });
  const r = await watch.check();
  assert.match(r.skipped, /no FunPay login/);
  assert.equal(env.calls.status.length, 0);
});

test("signed in: saves the status, pauses nothing", async () => {
  const env = setup({ answer: { ok: true, status: 200, username: "Buyer", userId: 7 }, listings: [{ externalId: "e1" }] });
  const r = await watch.check();
  assert.equal(r.ok, true);
  assert.deepEqual(env.calls.status[0], { ok: true, user: "Buyer", userId: 7, error: "" });
  assert.equal(env.calls.delist.length, 0);
  assert.equal(env.calls.pages.length, 0);
});

test("expired: pauses active FunPay listings once and pages once per outage", async () => {
  const env = setup({ answer: { ok: false, status: 200 }, listings: [{ externalId: "e1" }, { externalId: "e2", status: "paused" }] });
  const r1 = await watch.check();
  const r2 = await watch.check();
  assert.equal(r1.ok, false);
  assert.equal(r1.paused, 1);
  assert.deepEqual(env.calls.delist, ["e1"], "only the active one, and only once");
  assert.equal(env.rows[0].lastError, watch.PAUSE_REASON);
  assert.equal(env.calls.pages.length, 1);
  assert.equal(r2.paused, 0);
});

test("expired with pausing switched off: pages, pauses nothing", async () => {
  const env = setup({ answer: { ok: false, status: 200 }, pauseOn: false, listings: [{ externalId: "e1" }] });
  await watch.check();
  assert.equal(env.calls.delist.length, 0);
  assert.equal(env.calls.pages.length, 1);
});

test("back: resumes only the listings this module paused", async () => {
  let ok = false;
  const env = setup({
    answer: () => (ok ? { ok: true, status: 200, username: "Buyer", userId: 7 } : { ok: false, status: 200 }),
    listings: [{ externalId: "e1" }, { externalId: "e3", autoPaused: true, lastError: "paused: FunPay source down — offer gone" }],
  });
  await watch.check();
  ok = true;
  const r = await watch.check();
  assert.equal(r.resumed, 1);
  assert.deepEqual(env.calls.relist, ["e1"], "the deal watcher's own pause is left alone");
  assert.equal(env.rows[0].autoPaused, false);
  assert.equal(env.rows[1].autoPaused, true);
  assert.equal(env.calls.pages.length, 2, "one 'expired', one 'back'");
});

test("back, but the deal itself is down: stays paused, handed to the deal watcher", async () => {
  let ok = false;
  const env = setup({
    answer: () => (ok ? { ok: true, status: 200, username: "Buyer", userId: 7 } : { ok: false, status: 200 }),
    listings: [{ externalId: "e1", funpaySource: "GONE" }],
    sources: { GONE: { autoDelivery: true, maxBuyPriceUsd: 1.5, priceUsd: 1.2, missingSince: new Date() } },
  });
  await watch.check();
  ok = true;
  const r = await watch.check();
  assert.equal(r.resumed, 0);
  assert.equal(env.calls.relist.length, 0);
  assert.equal(env.rows[0].autoPaused, true);
  assert.equal(env.rows[0].lastError, "paused: FunPay source down — offer gone");
});

test("FunPay not answering is not an expired login", async () => {
  const env = setup({ answer: () => Promise.reject(new Error("timeout")), listings: [{ externalId: "e1" }] });
  const r = await watch.check();
  assert.match(r.error, /did not answer/);
  assert.equal(env.calls.delist.length, 0);
  const env2 = setup({ answer: { ok: false, status: 503 }, listings: [{ externalId: "e1" }] });
  const r2 = await watch.check();
  assert.match(r2.error, /HTTP 503/);
  assert.equal(env2.calls.delist.length, 0);
  assert.equal(env2.calls.status.length, 0);
});
