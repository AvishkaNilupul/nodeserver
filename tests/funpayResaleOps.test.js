const test = require("node:test");
const assert = require("node:assert/strict");

const resale = require("../utils/funpayResale");
const ops = require("../utils/funpayResaleOps");

// ---------------------------------------------------------------- fakes
// Made-up ids, names, logins and prices only (the repository is public). No Mongo,
// no network: the engine's deps fields are swapped for in-memory fakes and put back
// after every test.

const ORIGINAL_DEPS = { ...resale.deps };
const ORIGINAL_SLEEP = ops.opsDeps.sleep;
const T0 = Date.parse("2026-10-26T12:00:00Z");
const clock = { t: T0 };

test.beforeEach(() => {
  clock.t = T0;
});
test.afterEach(() => {
  Object.assign(resale.deps, ORIGINAL_DEPS);
  ops.opsDeps.sleep = ORIGINAL_SLEEP;
});

const clone = (o) => structuredClone(o);

const PURCHASE_DEFAULTS = {
  source: null, offerId: "", kind: "order", eldoradoOrderId: "", unit: 0, listing: null, state: "new",
  funpayOrderId: "", chargedUsd: 0, maxPriceUsd: 0, login: "", credentials: "", reason: "",
  trace: [], alerted: [], buyingAt: null, boughtAt: null, receivedAt: null, deliveredAt: null,
};
const SOURCE_DEFAULTS = { label: "", offerId: "", maxBuyPriceUsd: 0, autoBuy: false, missingSince: null };

// The store holds what was SAVED: a document reaches it only through create() or
// save(), so a test sees what really got written, and when.
function fakeModel(defaults, seed = []) {
  const store = [];
  let n = 0;
  const match = (r, q) =>
    Object.entries(q || {}).every(([k, v]) =>
      v && typeof v === "object" && !(v instanceof Date) && "$gte" in v ? r[k] != null && new Date(r[k]) >= v.$gte : r[k] === v,
    );
  const asDoc = (stored) => {
    const d = clone(stored);
    Object.defineProperty(d, "save", {
      enumerable: false,
      value: async () => {
        const i = store.findIndex((r) => r._id === d._id);
        store[i] = clone({ ...d, updatedAt: new Date(clock.t) });
        return d;
      },
    });
    return d;
  };
  const add = (doc) => {
    const row = clone({ ...defaults, _id: "row-" + ++n, createdAt: new Date(clock.t), updatedAt: new Date(clock.t), ...doc });
    store.push(row);
    return row;
  };
  seed.forEach(add);
  return {
    rows: () => store.map(clone),
    row: (id) => clone(store.find((r) => r._id === id)),
    async findById(id) {
      if (/^bad/.test(String(id))) {
        const e = new Error("Cast to ObjectId failed");
        e.name = "CastError";
        throw e;
      }
      const r = store.find((x) => x._id === String(id));
      return r ? asDoc(r) : null;
    },
    find(q) {
      const p = Promise.resolve().then(() => store.filter((r) => match(r, q)).map(asDoc));
      p.lean = () => Promise.resolve().then(() => store.filter((r) => match(r, q)).map(clone));
      return p;
    },
    async countDocuments(q) {
      return store.filter((r) => match(r, q)).length;
    },
    async create(doc) {
      return asDoc(add(doc));
    },
  };
}

const offerPage = (over = {}) => ({
  offerId: "fake-offer-1",
  userId: 4242,
  buyForm: { action: "https://funpay.com/en/orders/new", fields: {}, methods: [], balance: { usd: 2, rub: 0, eur: 0, totalUsd: 7.5 } },
  priceGuard: { usd: 1.17 },
  ...over,
});
const withBalance = (balance) => offerPage({ buyForm: { ...offerPage().buyForm, balance } });

// What the seller's auto-delivery shows on the FunPay order page.
const delivered = (...secrets) => () => ({ status: 200, order: { orderId: "FAKEORD1", status: "paid", secrets } });

// A FunPay session: `o` sets what each call answers; every call is recorded.
function fakeSession(o, calls, Purchase, jar) {
  return {
    async checkSession() {
      calls.checkSession++;
      if (o.check instanceof Error) throw o.check;
      return o.check || { ok: true, status: 200, userId: 4242, username: "fake_owner" };
    },
    async readOffer(id) {
      calls.readOffer.push(id);
      if (o.offer instanceof Error) throw o.offer;
      return o.offer || { status: 200, offer: offerPage() };
    },
    async readOrder(id) {
      calls.readOrder.push(id);
      const answer = typeof o.orders === "function" ? o.orders(calls.readOrder.length) : null;
      if (answer instanceof Error) throw answer;
      return answer || { status: 200, order: { orderId: id, status: "paid", secrets: [] } };
    },
    async buyOne(args) {
      calls.buyOne.push(args);
      calls.rowsAtBuy = Purchase.rows(); // what the database held when the money moved
      if (o.buy) return o.buy(args);
      return { ok: true, orderId: "FAKEORD1", chargedUsd: 1.234, trace: [{ step: "offer", status: 200 }, { step: "preview", status: 302 }] };
    },
    cookies: () => ({ ...jar, ...(o.setCookies || {}) }),
  };
}

let keyNo = 0;

function setup({ settings = {}, source = {}, sources, purchases = [], session = {}, jar } = {}) {
  const calls = {
    factory: [], checkSession: 0, readOffer: [], readOrder: [], buyOne: [], rowsAtBuy: null, sleeps: [],
    cookiesSaved: [], status: [], commissioned: [], pages: [], eldorado: [],
  };
  const Source = fakeModel(SOURCE_DEFAULTS, sources || [{ _id: "src-1", offerId: "fake-offer-1", label: "fake deal", maxBuyPriceUsd: 1.5, ...source }]);
  const Purchase = fakeModel(PURCHASE_DEFAULTS, purchases);
  const cfg = { perUnitMaxUsd: 3, dailyCapUsd: 15, maxBuysPerHour: 6, sessionUser: "fake_owner", sessionUserId: 4242, ...settings };
  // A fresh golden_key per test: the engine caches one session per stored jar.
  const stored = jar === undefined ? { golden_key: "fake-golden-key-" + ++keyNo } : jar;
  Object.assign(resale.deps, {
    models: () => ({ Source, Purchase }),
    settings: () => ({
      getFunpayResale: () => ({ ...cfg }),
      getFunpaySessionCookies: () => ({ ...(stored || {}) }),
      setFunpaySessionCookies: async (j, opts) => {
        calls.cookiesSaved.push({ jar: j, opts });
      },
      setFunpaySessionStatus: async (st) => {
        calls.status.push(st);
      },
      markFunpayCommissioned: async (opts) => {
        calls.commissioned.push(opts);
      },
    }),
    clientFactory: (j) => {
      calls.factory.push(j);
      return fakeSession(session, calls, Purchase, j);
    },
    encrypt: (s) => "ENC(" + s + ")",
    decrypt: (s) => String(s).replace(/^ENC\(/, "").replace(/\)$/, ""),
    now: () => clock.t,
    notify: async (t) => {
      calls.pages.push(t);
    },
    mp: () => {
      calls.eldorado.push("mp");
      throw new Error("Eldorado must not be touched");
    },
    chatReady: () => {
      calls.eldorado.push("chatReady");
      throw new Error("Eldorado must not be touched");
    },
  });
  ops.opsDeps.sleep = async (ms) => {
    calls.sleeps.push(ms);
  };
  return { calls, Source, Purchase, cfg };
}

// Nothing paged, nothing asked of Eldorado.
function assertQuiet(env) {
  assert.deepEqual(env.calls.pages, [], "never pages");
  assert.deepEqual(env.calls.eldorado, [], "never touches Eldorado");
}

const BUY = { confirmMaxUsd: 1.5, actor: "owner-test" };
const GUEST = { ok: false, status: 200, userId: 0, username: null };

// ---------------------------------------------------------------- module shape

test("exports exactly the nine hand tools, opsDeps, and the engine's own deps", () => {
  const fns = Object.keys(ops).filter((k) => typeof ops[k] === "function").sort();
  assert.deepEqual(fns, ["checkSession", "closePurchase", "manualBuy", "recheckPurchase", "retryPurchase", "revealCredentials", "saveSession", "setManualCredential", "testSource"]);
  assert.equal(typeof ops.opsDeps.sleep, "function");
  assert.equal(ops.deps, resale.deps, "no second deps object");
});

// ---------------------------------------------------------------- checkSession

test("checkSession: no login saved — nothing asked, nothing saved", async () => {
  const env = setup({ jar: null });
  const r = await ops.checkSession();
  assert.equal(r.ok, false);
  assert.match(r.error, /no FunPay login saved/);
  assert.equal(r.balanceUsd, null);
  assert.equal(env.calls.factory.length, 0);
  assert.deepEqual(env.calls.status, []);
});

test("checkSession: signed in — user, and the balance from a still-listed deal's page", async () => {
  const env = setup({
    sources: [
      { _id: "src-gone", offerId: "fake-offer-gone", maxBuyPriceUsd: 1, missingSince: new Date(T0 - 3600e3) },
      { _id: "src-1", offerId: "fake-offer-1", maxBuyPriceUsd: 1.5 },
    ],
  });
  const r = await ops.checkSession();
  assert.deepEqual(r, { ok: true, user: "fake_owner", userId: 4242, balanceUsd: 7.5, error: "" });
  assert.equal(env.calls.checkSession, 1);
  assert.deepEqual(env.calls.readOffer, ["fake-offer-1"], "one page read, of a deal still listed");
  assert.deepEqual(env.calls.status, [{ ok: true, user: "fake_owner", userId: 4242, error: "", balanceUsd: 7.5 }]);
  assert.equal(env.calls.buyOne.length, 0);
  assertQuiet(env);
});

test("checkSession: the balance falls back to the USD figure; no deals → balance unknown", async () => {
  setup({ session: { offer: { status: 200, offer: withBalance({ usd: 2.25, rub: 0, eur: 0, totalUsd: 0 }) } } });
  assert.equal((await ops.checkSession()).balanceUsd, 2.25);

  const env = setup({ sources: [] });
  const r = await ops.checkSession();
  assert.equal(r.ok, true);
  assert.equal(r.balanceUsd, null);
  assert.deepEqual(env.calls.readOffer, []);
  assert.equal(env.calls.status[0].balanceUsd, null);
});

test("checkSession: FunPay answers but nobody is signed in — saved as not ok, no balance read", async () => {
  const env = setup({ session: { check: GUEST } });
  const r = await ops.checkSession();
  assert.equal(r.ok, false);
  assert.match(r.error, /nobody is signed in/);
  assert.deepEqual(env.calls.status, [{ ok: false, error: r.error }]);
  assert.deepEqual(env.calls.readOffer, []);
});

test("checkSession: no answer or an error page is not an expired login — nothing saved", async () => {
  for (const check of [new Error("socket hang up"), { ok: false, status: 502, userId: 0, username: null }]) {
    const env = setup({ session: { check } });
    const r = await ops.checkSession();
    assert.equal(r.ok, false);
    assert.match(r.error, /did not answer: socket hang up|HTTP 502/);
    assert.deepEqual(env.calls.status, []);
  }
});

// ---------------------------------------------------------------- saveSession

test("saveSession: no golden_key in the paste — refused before asking FunPay, nothing stored", async () => {
  const env = setup();
  const r = await ops.saveSession("PHPSESSID=fake-sess-1", { actor: "owner-test" });
  assert.equal(r.ok, false);
  assert.match(r.error, /golden_key/);
  assert.match(r.error, /nothing was saved/);
  assert.equal(env.calls.factory.length, 0);
  assert.deepEqual(env.calls.cookiesSaved, []);
  assert.deepEqual(env.calls.status, []);
});

test("saveSession: a guest page stores NOTHING — no cookies, no status", async () => {
  const env = setup({ session: { check: GUEST } });
  const r = await ops.saveSession("golden_key=fakegoldenkey0000000000001; PHPSESSID=fake-sess-1", { actor: "owner-test" });
  assert.equal(r.ok, false);
  assert.match(r.error, /nobody is signed in/);
  assert.match(r.error, /nothing was saved/);
  assert.equal(env.calls.factory.length, 1, "checked with a session built from the pasted jar");
  assert.deepEqual(env.calls.cookiesSaved, []);
  assert.deepEqual(env.calls.status, []);
});

test("saveSession: no answer, or FunPay dropping the golden_key, stores nothing", async () => {
  for (const session of [{ check: new Error("ECONNRESET") }, { check: { ok: false, status: 503, userId: 0 } }, { setCookies: { golden_key: "" } }]) {
    const env = setup({ session });
    const r = await ops.saveSession("golden_key=fakegoldenkey0000000000001", { actor: "owner-test" });
    assert.equal(r.ok, false);
    assert.match(r.error, /nothing was saved/);
    assert.deepEqual(env.calls.cookiesSaved, []);
    assert.deepEqual(env.calls.status, []);
  }
});

test("saveSession: signed in — stores the session's own jar (after FunPay's rotation) and the status", async () => {
  const env = setup({ session: { setCookies: { PHPSESSID: "fake-sess-rotated" } } });
  const r = await ops.saveSession("golden_key=fakegoldenkey0000000000001; PHPSESSID=fake-sess-1", { actor: "owner-test" });
  assert.deepEqual(r, { ok: true, user: "fake_owner", userId: 4242, balanceUsd: 7.5, error: "" });
  assert.deepEqual(env.calls.factory, [{ golden_key: "fakegoldenkey0000000000001", PHPSESSID: "fake-sess-1" }]);
  assert.deepEqual(env.calls.cookiesSaved, [
    { jar: { golden_key: "fakegoldenkey0000000000001", PHPSESSID: "fake-sess-rotated" }, opts: { actor: "owner-test" } },
  ]);
  assert.deepEqual(env.calls.status, [{ ok: true, user: "fake_owner", userId: 4242, error: "", balanceUsd: 7.5 }]);
  assert.doesNotMatch(JSON.stringify(r), /fakegoldenkey|fake-sess/, "cookies are never handed back");
  assertQuiet(env);
});

// ---------------------------------------------------------------- testSource

test("testSource: a signed-in read — price, balance, buy form; buys nothing", async () => {
  const env = setup();
  const r = await ops.testSource("src-1");
  assert.deepEqual(r, { ok: true, signedIn: true, user: "fake_owner", priceUsd: 1.17, balanceUsd: 7.5, buyFormFound: true, maxPriceUsd: 1.5, reason: "" });
  assert.deepEqual(env.calls.readOffer, ["fake-offer-1"]);
  assert.equal(env.calls.buyOne.length, 0);
  assert.equal(env.Purchase.rows().length, 0);
  assert.deepEqual(env.calls.status, [{ ok: true, userId: 4242, error: "", balanceUsd: 7.5 }]);
  assertQuiet(env);
});

test("testSource: unknown deal (404), malformed id (404), no login saved", async () => {
  setup();
  const r = await ops.testSource("src-nope");
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.match(r.reason, /deal not found/);
  assert.equal((await ops.testSource("bad-id")).status, 404);

  const env = setup({ jar: null });
  const r2 = await ops.testSource("src-1");
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /no FunPay login saved/);
  assert.equal(env.calls.readOffer.length, 0);
});

test("testSource: a guest page means the cookies expired — saved as not signed in", async () => {
  const env = setup({ session: { offer: { status: 200, offer: offerPage({ userId: 0 }) } } });
  const r = await ops.testSource("src-1");
  assert.equal(r.ok, false);
  assert.equal(r.signedIn, false);
  assert.equal(r.user, "");
  assert.equal(r.balanceUsd, null);
  assert.match(r.reason, /nobody is signed in/);
  assert.deepEqual(env.calls.status, [{ ok: false, error: r.reason }]);
});

test("testSource: a page signed in as another account than the saved login names its id", async () => {
  setup({ settings: { sessionUserId: 1111 } });
  assert.equal((await ops.testSource("src-1")).user, "user #4242");
});

for (const [name, opts, why, expect] of [
  ["no buy form", { session: { offer: { status: 200, offer: offerPage({ buyForm: null, priceGuard: null }) } } }, /no buy form/, { buyFormFound: false, signedIn: true }],
  ["offer gone", { session: { offer: { status: 404, offer: null } } }, /HTTP 404 — the offer is gone/, {}],
  ["price above the max", { session: { offer: { status: 200, offer: offerPage({ priceGuard: { usd: 1.9 } }) } } }, /price \$1\.90 is above the max \$1\.50/, { priceUsd: 1.9 }],
  ["balance short", { session: { offer: { status: 200, offer: withBalance({ usd: 0.5, rub: 0, eur: 0, totalUsd: 0.5 }) } } }, /balance \$0\.50 is below the price \$1\.17/, { balanceUsd: 0.5 }],
  ["deal without a max buy price", { source: { maxBuyPriceUsd: 0 } }, /no max buy price/, { maxPriceUsd: 0 }],
  ["no answer", { session: { offer: new Error("socket hang up") } }, /did not answer: socket hang up/, {}],
]) {
  test("testSource: " + name + " → not ok, says why, buys nothing", async () => {
    const env = setup(opts);
    const r = await ops.testSource("src-1");
    assert.equal(r.ok, false);
    assert.match(r.reason, why);
    for (const [k, v] of Object.entries(expect)) assert.deepEqual(r[k], v, k);
    assert.equal(env.calls.buyOne.length, 0);
  });
}

// ---------------------------------------------------------------- manualBuy: refusals

for (const [name, opts, args, why, status] of [
  ["unknown deal", {}, ["src-nope", BUY], /deal not found/, 404],
  ["malformed deal id", {}, ["bad-id", BUY], /deal not found/, 404],
  ["deal without a max buy price", { source: { maxBuyPriceUsd: 0 } }, ["src-1", BUY], /no max buy price/, 409],
  ["max price not confirmed", {}, ["src-1", { actor: "owner-test" }], /confirm the max price/, 400],
  ["confirmed max given as text", {}, ["src-1", { confirmMaxUsd: "1.5" }], /confirm the max price/, 400],
  ["confirmed max not a number", {}, ["src-1", { confirmMaxUsd: NaN }], /confirm the max price/, 400],
  ["confirmed max below the deal's max", {}, ["src-1", { confirmMaxUsd: 1.49 }], /confirmed \$1\.49 .* max buy is \$1\.50 — confirm again/, 409],
  ["per-unit max allows nothing", { settings: { perUnitMaxUsd: 0 } }, ["src-1", BUY], /per-unit max/, 409],
  [
    "24 h cap would be passed",
    { purchases: [{ state: "delivered", buyingAt: new Date(T0 - 3600e3), chargedUsd: 14 }] },
    ["src-1", BUY],
    /24 h spend cap \(\$15\.00\) would be passed: \$14\.00 spent, this buy up to \$1\.50/,
    409,
  ],
  [
    "24 h cap: an unknown outcome counts at its ceiling",
    { purchases: [{ kind: "manual", state: "needs_review", buyingAt: new Date(T0 - 600e3), maxPriceUsd: 14 }] },
    ["src-1", BUY],
    /24 h spend cap/,
    409,
  ],
  ["daily cap 0 = never buy", { settings: { dailyCapUsd: 0 } }, ["src-1", BUY], /24 h spend cap \(\$0\.00\)/, 409],
  [
    "hourly buy limit",
    { settings: { maxBuysPerHour: 2 }, purchases: [{ state: "failed", buyingAt: new Date(T0 - 600e3) }, { state: "failed", buyingAt: new Date(T0 - 1200e3) }] },
    ["src-1", BUY],
    /2 FunPay buys in the last hour/,
    409,
  ],
  ["no FunPay login saved", { jar: null }, ["src-1", BUY], /no FunPay login saved/, 409],
]) {
  test("manualBuy refuses — " + name + ": no row, nothing bought", async () => {
    const env = setup(opts);
    const before = env.Purchase.rows().length;
    const r = await ops.manualBuy(...args);
    assert.equal(r.ok, false);
    assert.match(r.reason, why);
    assert.equal(r.status, status);
    assert.equal(r.purchaseId, null);
    assert.equal(r.state, null);
    assert.equal(env.Purchase.rows().length, before, "no purchase row");
    assert.equal(env.calls.buyOne.length, 0, "nothing bought");
    assert.deepEqual(env.calls.commissioned, []);
    assertQuiet(env);
  });
}

test("manualBuy: exactly at the 24 h cap is allowed; buys older than 24 h / 1 h do not count", async () => {
  const env = setup({
    settings: { dailyCapUsd: 15, maxBuysPerHour: 1 },
    session: { orders: delivered("fake_buyer_7 : Secret93!") },
    purchases: [
      { state: "delivered", buyingAt: new Date(T0 - 2 * 3600e3), chargedUsd: 13.5 }, // in the 24 h, not in the hour
      { state: "delivered", buyingAt: new Date(T0 - 25 * 3600e3), chargedUsd: 9 }, // older than 24 h
    ],
  });
  const r = await ops.manualBuy("src-1", BUY);
  assert.equal(env.calls.buyOne.length, 1);
  assert.equal(r.state, "received");
});

test("manualBuy: one at a time — a second click while a purchase is in flight is refused; the lock frees after errors too", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const env = setup({
    session: {
      buy: async () => {
        await gate;
        return { ok: false, reason: "fake refusal before paying", trace: [] };
      },
    },
  });
  const first = ops.manualBuy("src-1", BUY);
  for (let i = 0; i < 200 && env.calls.buyOne.length === 0; i++) await new Promise((r) => setImmediate(r));
  assert.equal(env.calls.buyOne.length, 1, "the first click is inside buyOne");
  // Without the lock the second click would wait behind the gate: give up after 1 s, never hang.
  let timer;
  const second = await Promise.race([
    ops.manualBuy("src-1", BUY),
    new Promise((r) => (timer = setTimeout(() => r({ hung: true }), 1000))),
  ]);
  clearTimeout(timer);
  release();
  assert.equal(second.ok, false);
  assert.equal(second.status, 409);
  assert.match(String(second.reason), /still running/);
  assert.equal((await first).state, "failed");
  assert.equal(env.Purchase.rows().length, 1, "one row: the second click wrote nothing");
  assert.equal(env.calls.buyOne.length, 1);

  const findById = env.Source.findById;
  env.Source.findById = async () => {
    throw new Error("fake db down");
  };
  await assert.rejects(ops.manualBuy("src-1", BUY), /fake db down/);
  env.Source.findById = findById;
  const third = await ops.manualBuy("src-1", BUY);
  assert.equal(third.state, "failed", "the lock was freed");
  assert.equal(env.calls.buyOne.length, 2);
});

// ---------------------------------------------------------------- manualBuy: buying

test("manualBuy: the row is written in 'buying' BEFORE the money moves, then bought → received → commissioned", async () => {
  const env = setup({ session: { orders: delivered("fake_buyer_1 : Secret99!") } });
  const r = await ops.manualBuy("src-1", BUY);

  // At the moment buyOne ran, the database already held the row.
  assert.equal(env.calls.rowsAtBuy.length, 1);
  const atBuy = env.calls.rowsAtBuy[0];
  assert.equal(atBuy.state, "buying");
  assert.equal(atBuy.kind, "manual");
  assert.equal(atBuy.source, "src-1");
  assert.equal(atBuy.offerId, "fake-offer-1");
  assert.equal(atBuy.eldoradoOrderId, "");
  assert.equal(atBuy.maxPriceUsd, 1.5);
  assert.deepEqual(atBuy.buyingAt, new Date(T0));
  assert.deepEqual(env.calls.buyOne, [{ offerId: "fake-offer-1", maxPriceUsd: 1.5 }]);

  assert.equal(r.ok, true);
  assert.equal(r.state, "received");
  assert.equal(r.purchaseId, atBuy._id);
  assert.equal(r.funpayOrderId, "FAKEORD1");
  assert.equal(r.login, "fake_buyer_1");
  assert.equal(r.commissioned, true);
  assert.equal(r.reason, "");
  assert.deepEqual(r.trace, [{ step: "offer", status: 200 }, { step: "preview", status: 302 }]);
  assert.doesNotMatch(JSON.stringify(r), /Secret99/, "the password is never returned");

  const row = env.Purchase.row(r.purchaseId);
  assert.equal(row.state, "received");
  assert.equal(row.chargedUsd, 1.23);
  assert.equal(row.credentials, 'ENC({"username":"fake_buyer_1","password":"Secret99!"})');
  assert.equal(row.login, "fake_buyer_1");
  assert.equal(row.reason, "");
  assert.deepEqual(row.boughtAt, new Date(T0));
  assert.deepEqual(row.receivedAt, new Date(T0));
  assert.deepEqual(row.trace, r.trace);

  assert.deepEqual(env.calls.readOrder, ["FAKEORD1"], "the first read comes straight after paying");
  assert.deepEqual(env.calls.sleeps, []);
  assert.deepEqual(env.calls.commissioned, [{ actor: "owner-test" }]);
  assertQuiet(env);
});

test("manualBuy: the ceiling is the lower of the deal's max and the per-unit max", async () => {
  const env = setup({ source: { maxBuyPriceUsd: 5 }, settings: { perUnitMaxUsd: 3 }, session: { orders: delivered("fake_buyer_2 : Secret98!") } });
  const short = await ops.manualBuy("src-1", { confirmMaxUsd: 3 });
  assert.match(short.reason, /confirm again/, "the confirmation must cover the deal's own max");
  const r = await ops.manualBuy("src-1", { confirmMaxUsd: 5 });
  assert.equal(r.state, "received");
  assert.deepEqual(env.calls.buyOne, [{ offerId: "fake-offer-1", maxPriceUsd: 3 }]);
  assert.equal(env.Purchase.row(r.purchaseId).maxPriceUsd, 3);
});

test("manualBuy: a network error mid-purchase is needs_review — never retried, counted at its ceiling", async () => {
  const env = setup({
    session: {
      buy: () => {
        throw new Error("socket hang up");
      },
    },
  });
  const r = await ops.manualBuy("src-1", BUY);
  assert.equal(r.ok, false);
  assert.equal(r.state, "needs_review");
  assert.match(r.reason, /failed mid-purchase \(socket hang up\)/);
  assert.equal(env.Purchase.row(r.purchaseId).state, "needs_review");
  assert.equal(env.calls.buyOne.length, 1);
  assert.equal(env.calls.readOrder.length, 0);
  assert.deepEqual(env.calls.commissioned, []);
  assert.equal(await resale.spentLast24h(), 1.5, "an unknown outcome counts at its ceiling");
  assertQuiet(env);
});

test("manualBuy: an uncertain stop (request sent, outcome unclear) is needs_review, never failed", async () => {
  const trace = [{ step: "offer", status: 200 }, { step: "preview", status: 200 }, { step: "confirm", status: 200 }];
  const env = setup({ session: { buy: () => ({ ok: false, uncertain: true, reason: "no order number after confirming (HTTP 200)", trace }) } });
  const r = await ops.manualBuy("src-1", BUY);
  assert.equal(r.ok, false);
  assert.equal(r.state, "needs_review");
  assert.equal(r.reason, "no order number after confirming (HTTP 200) — FunPay may have charged; check your FunPay orders");
  assert.deepEqual(r.trace, trace);
  const row = env.Purchase.row(r.purchaseId);
  assert.equal(row.state, "needs_review");
  assert.equal(row.reason, r.reason);
  assert.deepEqual(row.trace, trace);
  assert.equal(env.calls.buyOne.length, 1);
  assert.equal(env.calls.readOrder.length, 0);
  assert.deepEqual(env.calls.commissioned, []);
  assert.equal(await resale.spentLast24h(), 1.5, "counted at its ceiling");
  assertQuiet(env);
});

test("manualBuy: a stop that is not uncertain is 'failed' with FunPay's reason — even after a confirm step", async () => {
  for (const res of [
    { ok: false, reason: "FunPay balance $0.20 is below the price $1.17 — top up the balance (cards are never used)", trace: [{ step: "offer", status: 200 }] },
    { ok: false, reason: "FunPay sent the order to an outside payment page — stopped, nothing paid from a card", trace: [{ step: "offer" }, { step: "preview" }, { step: "confirm", status: 302 }] },
  ]) {
    const env = setup({ session: { buy: () => res } });
    const r = await ops.manualBuy("src-1", BUY);
    assert.equal(r.ok, false);
    assert.equal(r.state, "failed");
    assert.equal(r.reason, res.reason);
    const row = env.Purchase.row(r.purchaseId);
    assert.equal(row.state, "failed");
    assert.deepEqual(row.trace, res.trace);
    assert.equal(env.calls.readOrder.length, 0);
    assert.deepEqual(env.calls.commissioned, []);
    assert.equal(await resale.spentLast24h(), 0, "a definite refusal spent nothing");
  }
});

test("manualBuy: a success without an order number is needs_review", async () => {
  const env = setup({ session: { buy: () => ({ ok: true, chargedUsd: 1.17, trace: [] }) } });
  const r = await ops.manualBuy("src-1", BUY);
  assert.equal(r.state, "needs_review");
  assert.match(r.reason, /no clear answer/);
  assert.equal(env.calls.readOrder.length, 0);
  assert.deepEqual(env.calls.commissioned, []);
});

for (const [name, lines] of [
  ["two accounts", ["fake_one_1 : PassOne11", "fake_two_2 : PassTwo22"]],
  ["no account", ["Thanks for your purchase! Link it and enjoy."]],
]) {
  test("manualBuy: a delivery with " + name + " is needs_review and does not commission", async () => {
    const env = setup({ session: { orders: delivered(...lines) } });
    const r = await ops.manualBuy("src-1", BUY);
    assert.equal(r.ok, false);
    assert.equal(r.state, "needs_review");
    assert.match(r.reason, /exactly one login/);
    const row = env.Purchase.row(r.purchaseId);
    assert.equal(row.state, "needs_review");
    assert.equal(row.credentials, "");
    assert.equal(row.funpayOrderId, "FAKEORD1");
    assert.equal(env.calls.readOrder.length, 1, "no more polling once something was delivered");
    assert.deepEqual(env.calls.commissioned, []);
    assertQuiet(env);
  });
}

test("manualBuy: nothing delivered after 6 reads 10 s apart — stays 'bought', waiting for the seller", async () => {
  const env = setup();
  const r = await ops.manualBuy("src-1", BUY);
  assert.equal(r.ok, false);
  assert.equal(r.state, "bought");
  assert.match(r.reason, /^waiting for the seller/);
  assert.equal(r.funpayOrderId, "FAKEORD1");
  assert.equal(env.calls.readOrder.length, 6);
  assert.deepEqual(env.calls.sleeps, [10000, 10000, 10000, 10000, 10000]);
  const row = env.Purchase.row(r.purchaseId);
  assert.equal(row.state, "bought");
  assert.equal(row.chargedUsd, 1.23);
  assert.match(row.reason, /^waiting for the seller/);
  assert.deepEqual(env.calls.commissioned, []);
  assertQuiet(env);
});

test("manualBuy: a failed or empty read is retried on the next poll; a late delivery is still received", async () => {
  const late = { status: 200, order: { orderId: "FAKEORD1", status: "paid", secrets: ["fake_late_1:LatePass9:faketoken0123"] } };
  const env = setup({ session: { orders: (n) => (n === 1 ? new Error("timeout") : n === 2 ? { status: 502, order: null } : late) } });
  const r = await ops.manualBuy("src-1", BUY);
  assert.equal(r.ok, true);
  assert.equal(r.state, "received");
  assert.equal(env.calls.readOrder.length, 3);
  assert.deepEqual(env.calls.sleeps, [10000, 10000]);
  assert.equal(env.Purchase.row(r.purchaseId).credentials, 'ENC({"username":"fake_late_1","password":"LatePass9","token":"faketoken0123"})');
  assert.deepEqual(env.calls.commissioned, [{ actor: "owner-test" }]);
});

test("manualBuy: a failure after paying never hides the purchase — needs_review, not commissioned", async () => {
  const env = setup({ session: { orders: delivered("fake_buyer_5 : Secret95!") } });
  resale.deps.encrypt = () => {
    throw new Error("fake key missing");
  };
  const r = await ops.manualBuy("src-1", BUY);
  assert.equal(r.ok, false);
  assert.equal(r.state, "needs_review");
  assert.match(r.reason, /something failed after the purchase started \(fake key missing\)/);
  assert.equal(r.funpayOrderId, "FAKEORD1");
  const row = env.Purchase.row(r.purchaseId);
  assert.equal(row.state, "needs_review");
  assert.equal(row.credentials, "");
  assert.deepEqual(env.calls.commissioned, []);
});

test("manualBuy: when saving the commissioned flag fails, the login is still received", async () => {
  setup({ session: { orders: delivered("fake_buyer_6 : Secret94!") } });
  const settings = resale.deps.settings();
  resale.deps.settings = () => ({
    ...settings,
    markFunpayCommissioned: async () => {
      throw new Error("fake disk full");
    },
  });
  const r = await ops.manualBuy("src-1", BUY);
  assert.equal(r.ok, true);
  assert.equal(r.state, "received");
  assert.equal(r.commissioned, false);
  assert.match(r.reason, /commissioned flag failed: fake disk full/);
});

// ---------------------------------------------------------------- revealCredentials

test("revealCredentials: the decrypted login, with the token when the seller sent one", async () => {
  setup({
    purchases: [
      { _id: "p-tok", state: "received", credentials: 'ENC({"username":"fake_buyer_3","password":"Secret97!","token":"faketoken9876"})' },
      { _id: "p-plain", state: "delivered", credentials: 'ENC({"username":"fake_buyer_4","password":"Secret96!"})' },
    ],
  });
  assert.deepEqual(await ops.revealCredentials("p-tok"), { username: "fake_buyer_3", password: "Secret97!", token: "faketoken9876" });
  assert.deepEqual(await ops.revealCredentials("p-plain"), { username: "fake_buyer_4", password: "Secret96!" });
});

test("revealCredentials: throws 404 / 409 when there is nothing to show", async () => {
  setup({
    purchases: [
      { _id: "p-empty", state: "bought" },
      { _id: "p-broken", state: "received", credentials: "ENC(not json)" },
    ],
  });
  await assert.rejects(ops.revealCredentials("p-nope"), (e) => e.status === 404 && /not found/.test(e.message));
  await assert.rejects(ops.revealCredentials("bad-id"), (e) => e.status === 404);
  await assert.rejects(ops.revealCredentials("p-empty"), (e) => e.status === 409 && /no login/.test(e.message));
  await assert.rejects(ops.revealCredentials("p-broken"), (e) => e.status === 409 && /could not be read back/.test(e.message));
});

// ---------------------------------------------------------------- setManualCredential

for (const state of ["bought", "needs_review", "failed"]) {
  test("setManualCredential: an order purchase in '" + state + "' takes a login → received", async () => {
    const env = setup({ purchases: [{ _id: "p-1", kind: "order", eldoradoOrderId: "fake-eldo-1", state, reason: "something earlier" }] });
    const r = await ops.setManualCredential("p-1", { login: "  fake_hand_1 ", password: " HandPass1 " });
    assert.deepEqual(r, { ok: true, purchaseId: "p-1", state: "received", reason: "entered by hand", login: "fake_hand_1" });
    const row = env.Purchase.row("p-1");
    assert.equal(row.state, "received");
    assert.equal(row.reason, "entered by hand");
    assert.equal(row.login, "fake_hand_1");
    assert.equal(row.credentials, 'ENC({"username":"fake_hand_1","password":"HandPass1"})');
    assert.deepEqual(row.receivedAt, new Date(T0));
    assertQuiet(env);
  });
}

test("setManualCredential: refused for manual buys and for every other state — row unchanged", async () => {
  const states = ["new", "waiting_chat", "buying", "received", "delivered"];
  const env = setup({
    purchases: [
      { _id: "p-manual", kind: "manual", state: "needs_review" },
      ...states.map((state) => ({ _id: "p-" + state, kind: "order", eldoradoOrderId: "fake-eldo-" + state, state })),
    ],
  });
  const good = { login: "fake_hand_2", password: "HandPass2" };
  const m = await ops.setManualCredential("p-manual", good);
  assert.equal(m.ok, false);
  assert.equal(m.status, 409);
  assert.match(m.reason, /Eldorado order/);
  assert.equal(env.Purchase.row("p-manual").credentials, "");
  for (const state of states) {
    const r = await ops.setManualCredential("p-" + state, good);
    assert.equal(r.ok, false, state);
    assert.equal(r.status, 409);
    assert.match(r.reason, new RegExp('"' + state + '"'));
    assert.equal(env.Purchase.row("p-" + state).state, state);
    assert.equal(env.Purchase.row("p-" + state).credentials, "");
  }
  assert.equal((await ops.setManualCredential("p-nope", good)).status, 404);
});

test("setManualCredential: the login must look like a Twitch login, the password ≥ 4 characters", async () => {
  const env = setup({ purchases: [{ _id: "p-1", kind: "order", eldoradoOrderId: "fake-eldo-1", state: "needs_review" }] });
  for (const login of ["", "ab", "has space", "bad-dash", "x".repeat(33), 12345, undefined]) {
    const r = await ops.setManualCredential("p-1", { login, password: "HandPass3" });
    assert.equal(r.ok, false, String(login));
    assert.equal(r.status, 400);
    assert.match(r.reason, /login/);
  }
  for (const password of ["", "abc", "   ab  ", undefined, "x".repeat(129)]) {
    const r = await ops.setManualCredential("p-1", { login: "fake_hand_3", password });
    assert.equal(r.ok, false, String(password));
    assert.equal(r.status, 400);
    assert.match(r.reason, /password/);
  }
  assert.equal(env.Purchase.row("p-1").state, "needs_review", "nothing stored");
  assert.equal(env.Purchase.row("p-1").credentials, "");
  const ok = await ops.setManualCredential("p-1", { login: "abc", password: "abcd" });
  assert.equal(ok.ok, true, "a 3-character login and a 4-character password are enough");
});

// ---------------------------------------------------------------- retryPurchase

test("retryPurchase: a failed order purchase goes back to 'new' and pages afresh", async () => {
  const env = setup({
    purchases: [
      { _id: "p-1", kind: "order", eldoradoOrderId: "fake-eldo-1", state: "failed", reason: "fake refusal before paying", alerted: ["failed"], trace: [{ step: "offer", status: 200 }] },
    ],
  });
  const r = await ops.retryPurchase("p-1");
  assert.deepEqual(r, { ok: true, purchaseId: "p-1", state: "new", reason: "" });
  const row = env.Purchase.row("p-1");
  assert.equal(row.state, "new");
  assert.equal(row.reason, "");
  assert.deepEqual(row.alerted, [], "a repeat failure pages again");
  assertQuiet(env);
});

test("retryPurchase: refused unless failed + order, and never for a unit already bought", async () => {
  const env = setup({
    purchases: [
      { _id: "p-manual", kind: "manual", state: "failed" },
      { _id: "p-review", kind: "order", eldoradoOrderId: "e1", state: "needs_review" },
      { _id: "p-bought", kind: "order", eldoradoOrderId: "e2", state: "bought", funpayOrderId: "FAKEORD2" },
      { _id: "p-new", kind: "order", eldoradoOrderId: "e3", state: "new" },
      { _id: "p-delivered", kind: "order", eldoradoOrderId: "e4", state: "delivered" },
      { _id: "p-closed-paid", kind: "order", eldoradoOrderId: "e5", state: "failed", funpayOrderId: "FAKEORD3", chargedUsd: 1.17, reason: "closed by owner: seller never delivered" },
      { _id: "p-closed-charged", kind: "order", eldoradoOrderId: "e6", state: "failed", chargedUsd: 1.17, reason: "closed by owner" },
    ],
  });
  for (const [id, why] of [
    ["p-manual", /Eldorado order/],
    ["p-review", /only a failed purchase.*"needs_review"/],
    ["p-bought", /"bought"/],
    ["p-new", /"new"/],
    ["p-delivered", /"delivered"/],
    ["p-closed-paid", /already bought on FunPay \(order FAKEORD3\) — a retry would buy a second one/],
    ["p-closed-charged", /already bought on FunPay/],
  ]) {
    const before = env.Purchase.row(id);
    const r = await ops.retryPurchase(id);
    assert.equal(r.ok, false, id);
    assert.equal(r.status, 409);
    assert.match(r.reason, why);
    assert.deepEqual(env.Purchase.row(id), before, id + " unchanged");
  }
  assert.equal((await ops.retryPurchase("p-nope")).status, 404);
});

test("retryPurchase: an unclear purchase the owner checked and closed can be retried", async () => {
  const env = setup({
    purchases: [
      { _id: "p-1", kind: "order", eldoradoOrderId: "e1", state: "needs_review", reason: "no order number after confirming (HTTP 200) — FunPay may have charged; check your FunPay orders" },
    ],
  });
  assert.equal((await ops.retryPurchase("p-1")).ok, false, "never straight from needs_review");
  await ops.closePurchase("p-1", { note: "checked FunPay, nothing was bought" });
  const r = await ops.retryPurchase("p-1");
  assert.equal(r.ok, true);
  assert.equal(env.Purchase.row("p-1").state, "new");
});

// ---------------------------------------------------------------- closePurchase

test("closePurchase: any purchase not delivered becomes 'failed', closed by owner", async () => {
  const states = ["new", "waiting_chat", "buying", "bought", "received", "failed", "needs_review"];
  const env = setup({
    purchases: [
      ...states.map((state) => ({ _id: "p-" + state, kind: "order", eldoradoOrderId: "fake-eldo-" + state, state })),
      { _id: "p-manual", kind: "manual", state: "bought", funpayOrderId: "FAKEORD4", chargedUsd: 1.17 },
    ],
  });
  for (const state of states) {
    const r = await ops.closePurchase("p-" + state, { note: "  seller\nrefunded   it " });
    assert.deepEqual(r, { ok: true, purchaseId: "p-" + state, state: "failed", reason: "closed by owner: seller refunded it" });
    assert.equal(env.Purchase.row("p-" + state).state, "failed");
  }
  const m = await ops.closePurchase("p-manual", {});
  assert.equal(m.reason, "closed by owner");
  const row = env.Purchase.row("p-manual");
  assert.equal(row.state, "failed");
  assert.equal(row.funpayOrderId, "FAKEORD4", "the purchase record stays");
  assert.equal(row.chargedUsd, 1.17);
  assertQuiet(env);
});

test("closePurchase: a delivered purchase is refused; unknown ids are 404; long notes are cut", async () => {
  const env = setup({
    purchases: [
      { _id: "p-done", kind: "order", eldoradoOrderId: "e1", state: "delivered" },
      { _id: "p-open", kind: "order", eldoradoOrderId: "e2", state: "bought" },
    ],
  });
  const r = await ops.closePurchase("p-done", { note: "fake note" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(env.Purchase.row("p-done").state, "delivered");
  assert.equal((await ops.closePurchase("p-nope")).status, 404);
  assert.equal((await ops.closePurchase("bad-id")).status, 404);
  const long = await ops.closePurchase("p-open", { note: "y".repeat(500) });
  assert.equal(long.reason, "closed by owner: " + "y".repeat(200));
});


// ---------------------------------------------------------------- recheckPurchase

const boughtRow = (extra = {}) => ({ _id: "pur-9", kind: "manual", state: "bought", funpayOrderId: "FAKEORD9", source: "src-1", ...extra });

test("recheckPurchase: a late delivery becomes 'received' and a manual buy commissions", async () => {
  const env = setup({ purchases: [boughtRow()], session: { orders: () => ({ status: 200, order: { secrets: ["fakeuser_late : LatePass77"] } }) } });
  const r = await ops.recheckPurchase("pur-9");
  assert.deepEqual(r, { ok: true, state: "received", login: "fakeuser_late", commissioned: true });
  const row = env.Purchase.rows()[0];
  assert.equal(row.state, "received");
  assert.equal(row.credentials, 'ENC({"username":"fakeuser_late","password":"LatePass77"})');
  assert.equal(env.calls.commissioned.length, 1);
  assert.deepEqual(env.calls.readOrder, ["FAKEORD9"]);
  assert.equal(env.calls.buyOne.length, 0, "buys nothing");
  assertQuiet(env);
});

test("recheckPurchase: an order purchase is received but never commissions", async () => {
  const env = setup({ purchases: [boughtRow({ kind: "order", eldoradoOrderId: "eo-1" })], session: { orders: () => ({ status: 200, order: { secrets: ["fakeuser_ord : OrdPass77"] } }) } });
  const r = await ops.recheckPurchase("pur-9");
  assert.equal(r.ok, true);
  assert.equal(r.commissioned, false);
  assert.equal(env.calls.commissioned.length, 0);
});

test("recheckPurchase: nothing yet stays bought; an unreadable delivery is needs_review", async () => {
  const env = setup({ purchases: [boughtRow()] });
  const r = await ops.recheckPurchase("pur-9");
  assert.deepEqual(r, { ok: false, state: "bought", reason: "the seller has not delivered yet" });
  assert.equal(env.Purchase.rows()[0].state, "bought");
  const env2 = setup({ purchases: [boughtRow()], session: { orders: () => ({ status: 200, order: { secrets: ["Thanks! Enjoy."] } }) } });
  const r2 = await ops.recheckPurchase("pur-9");
  assert.equal(r2.state, "needs_review");
  assert.equal(env2.Purchase.rows()[0].state, "needs_review");
  assert.equal(env2.calls.commissioned.length, 0);
});

test("recheckPurchase refuses anything but a bought row with an order, and never throws", async () => {
  setup({ purchases: [boughtRow({ state: "received" }), boughtRow({ _id: "pur-8", funpayOrderId: "" })] });
  assert.equal((await ops.recheckPurchase("pur-9")).status, 409);
  assert.equal((await ops.recheckPurchase("pur-8")).status, 409);
  assert.equal((await ops.recheckPurchase("nope")).status, 404);
  setup({ purchases: [boughtRow()], jar: null });
  assert.equal((await ops.recheckPurchase("pur-9")).status, 409, "no login saved");
  setup({ purchases: [boughtRow()], session: { orders: () => new Error("socket hang up") } });
  const r = await ops.recheckPurchase("pur-9");
  assert.equal(r.ok, false);
  assert.match(r.reason, /did not answer/);
});
