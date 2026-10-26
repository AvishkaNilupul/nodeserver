const test = require("node:test");
const assert = require("node:assert/strict");

const engine = require("../utils/funpayResale");

// ---------------------------------------------------------------- fakes
// Made-up ids and logins only (the repository is public).

function fakeModel(rows, { unique } = {}) {
  const wrap = (r) => {
    if (!r.save) {
      Object.defineProperty(r, "save", { value: async () => r, enumerable: false });
    }
    return r;
  };
  const match = (r, q) =>
    Object.entries(q || {}).every(([k, v]) => {
      if (v && typeof v === "object" && "$gte" in v) return r[k] && new Date(r[k]) >= v.$gte;
      return r[k] === v;
    });
  return {
    rows,
    find(q) {
      const found = rows.filter((r) => match(r, q)).map(wrap);
      const res = Promise.resolve(found);
      res.sort = (spec) => Promise.resolve(found.slice().sort((a, b) => (a.unit || 0) - (b.unit || 0)));
      res.lean = () => Promise.resolve(found.map((r) => ({ ...r })));
      return res;
    },
    async findById(id) {
      const r = rows.find((x) => String(x._id) === String(id));
      return r ? wrap(r) : null;
    },
    async countDocuments(q) {
      return rows.filter((r) => match(r, q)).length;
    },
    async create(doc) {
      if (unique && rows.some((r) => unique.every((k) => r[k] === doc[k]))) {
        const e = new Error("duplicate key");
        e.code = 11000;
        throw e;
      }
      const r = wrap({ _id: "p" + (rows.length + 1), alerted: [], trace: [], createdAt: new Date(clock.t), chargedUsd: 0, maxPriceUsd: 0, ...doc });
      rows.push(r);
      return r;
    },
  };
}

const clock = { t: Date.parse("2026-10-26T12:00:00Z") };

function setup({ settings = {}, source = {}, chat = true, buy, read, sendFails = 0 } = {}) {
  const purchases = [];
  const Purchase = fakeModel(purchases, { unique: ["eldoradoOrderId", "unit"] });
  const src = { _id: "s1", offerId: "9001", label: "52 drops", maxBuyPriceUsd: 1.5, autoBuy: true, missingSince: null, ...source };
  const Source = fakeModel([src]);
  const cfg = {
    autoBuy: true, dryRun: false, commissioned: true, perUnitMaxUsd: 3, dailyCapUsd: 15, maxBuysPerHour: 6,
    maxUnitsPerOrder: 3, minProfitUsd: 0.1, eldoradoFeePct: 10, sellerWaitMinutes: 15, giveUpHours: 24, ...settings,
  };
  const calls = { buy: [], read: [], send: [], marked: [], pages: [] };
  let sendLeft = sendFails;
  const session = {
    buyOne: async (a) => {
      calls.buy.push(a);
      if (buy) return buy(a, calls.buy.length);
      return { ok: true, orderId: "ORD" + calls.buy.length + "XYZ", chargedUsd: 1.17, trace: [{ step: "offer" }] };
    },
    readOrder: async (id) => {
      calls.read.push(id);
      if (read) return read(id);
      return { status: 200, order: { orderId: id, status: "paid", secrets: ["fakeuser_" + id.toLowerCase() + " : Pass1234!"] } };
    },
  };
  Object.assign(engine.deps, {
    models: () => ({ Source, Purchase }),
    settings: () => ({ getFunpayResale: () => cfg, getFunpaySessionCookies: () => ({ golden_key: "k" + Math.random() }) }),
    mp: () => ({
      eldoradoSendOrderMessage: async (order, text) => {
        if (sendLeft > 0) {
          sendLeft--;
          throw new Error("chat 500");
        }
        calls.send.push(text);
      },
      eldoradoMarkDelivered: async (id) => calls.marked.push(id),
    }),
    notify: async (t) => calls.pages.push(t),
    chatReady: () => (typeof chat === "function" ? chat() : chat),
    clientFactory: () => session,
    encrypt: (s) => "ENC(" + s + ")",
    decrypt: (s) => String(s).replace(/^ENC\(/, "").replace(/\)$/, ""),
    now: () => clock.t,
  });
  const listing = { _id: "L1", title: "RL 52 drops", price: 2.89, funpaySource: "s1", units: [], saved: 0 };
  listing.save = async () => {
    listing.saved++;
  };
  let n = 0;
  const order = (extra = {}) => ({ id: "eldo-" + ++n, offerId: "off1", totalPrice: { amount: 3.12, currency: "USD" }, ...extra });
  return { cfg, src, purchases, calls, listing, order, cfg_: cfg };
}

const run = (env, order, qty = 1, dryRun = false) => engine.deliverEldoradoOrder({ order, listing: env.listing, qty, dryRun });

test.beforeEach(() => {
  clock.t = Date.parse("2026-10-26T12:00:00Z");
});

// ---------------------------------------------------------------- tests

test("Eldorado dry run: nothing is bought, sent or written", async () => {
  const env = setup();
  const r = await run(env, env.order(), 1, true);
  assert.equal(r.dryRun, true);
  assert.match(r.wouldSend, /would buy 1/);
  assert.equal(env.purchases.length, 0);
  assert.equal(env.calls.buy.length, 0);
});

for (const [name, settings, source, why] of [
  ["engine dry run", { dryRun: true }, {}, /dry run/],
  ["auto-buy off", { autoBuy: false }, {}, /auto-buy is switched off/],
  ["not commissioned", { commissioned: false }, {}, /no test purchase/],
  ["deal auto-buy off", {}, { autoBuy: false }, /auto-buy is off for this deal/],
  ["deal gone", {}, { missingSince: new Date() }, /offer is gone/],
  ["no max price", {}, { maxBuyPriceUsd: 0 }, /no max buy price/],
]) {
  test("gate: " + name + " holds the order, pages once, writes no row", async () => {
    const env = setup({ settings, source });
    const o = env.order();
    const r1 = await run(env, o);
    const r2 = await run(env, o);
    assert.match(r1.skipped, why);
    assert.match(r1.skipped, /^funpay resale: on hold/);
    assert.equal(r2.skipped, r1.skipped);
    assert.equal(env.purchases.length, 0);
    assert.equal(env.calls.buy.length, 0);
    assert.equal(env.calls.pages.length, 1);
  });
}

test("happy path: waits for the chat, buys, reads the login, delivers once", async () => {
  let chatOpen = false;
  const env = setup({ chat: () => chatOpen });
  const o = env.order();
  const r1 = await run(env, o);
  assert.match(r1.skipped, /waiting for the buyer's order chat/);
  assert.equal(env.purchases[0].state, "waiting_chat");
  assert.equal(env.calls.buy.length, 0, "nothing bought before the chat exists");

  chatOpen = true;
  const r2 = await run(env, o);
  assert.deepEqual(r2, { orderId: o.id, delivered: 1, source: "funpay:9001" });
  assert.equal(env.calls.buy.length, 1);
  assert.equal(env.calls.buy[0].offerId, "9001");
  assert.equal(env.calls.send.length, 1);
  const msg = env.calls.send[0];
  assert.match(msg, /Username: fakeuser_ord1xyz\nPassword: Pass1234!/);
  assert.doesNotMatch(msg, /funpay/i, "the buyer never sees where it came from");
  assert.deepEqual(env.calls.marked, [o.id]);
  const row = env.purchases[0];
  assert.equal(row.state, "delivered");
  assert.equal(row.funpayOrderId, "ORD1XYZ");
  assert.equal(row.chargedUsd, 1.17);
  assert.equal(row.credentials, 'ENC({"username":"fakeuser_ord1xyz","password":"Pass1234!"})');
  assert.equal(env.listing.units.length, 1);
  assert.equal(env.listing.units[0].orderId, o.id);
  assert.equal(env.listing.units[0].login, "fakeuser_ord1xyz");
  assert.equal(env.listing.units[0].accountId, "");

  const r3 = await run(env, o);
  assert.match(r3.skipped, /already delivered/);
  assert.equal(env.calls.buy.length, 1);
  assert.equal(env.calls.send.length, 1);
});

test("price ceiling = min(deal max, per-unit max, net sale − min profit)", async () => {
  const env = setup({ source: { maxBuyPriceUsd: 5 }, settings: { perUnitMaxUsd: 4 } });
  // listing price 2.89 < order 3.12 → sale 2.89, net 2.601, minus 0.10 → 2.50
  await run(env, env.order());
  assert.equal(env.calls.buy[0].maxPriceUsd, 2.5);
});

test("no profit at the sale price: held, nothing bought", async () => {
  const env = setup({ source: { maxBuyPriceUsd: 3 } });
  env.listing.price = 0.1;
  const r = await run(env, env.order({ totalPrice: { amount: 0.1, currency: "USD" } }));
  assert.match(r.skipped, /no profit/);
  assert.equal(env.calls.buy.length, 0);
});

test("a row left in 'buying' goes to needs_review and is never bought again", async () => {
  const env = setup();
  const o = env.order();
  env.purchases.push({ _id: "old", eldoradoOrderId: o.id, unit: 0, state: "buying", alerted: [], buyingAt: new Date(clock.t), maxPriceUsd: 1.5, chargedUsd: 0 });
  const r = await run(env, o);
  assert.match(r.skipped, /cut off mid-way/);
  assert.equal(env.purchases[0].state, "needs_review");
  assert.equal(env.calls.buy.length, 0);
  assert.equal(env.calls.pages.length, 1);
  await run(env, o);
  assert.equal(env.calls.buy.length, 0);
  assert.equal(env.calls.pages.length, 1, "paged once");
});

test("a network error during the buy is needs_review, not a retry", async () => {
  const env = setup({ buy: () => Promise.reject(new Error("socket hang up")) });
  const o = env.order();
  const r = await run(env, o);
  assert.match(r.skipped, /needs checking/);
  assert.equal(env.purchases[0].state, "needs_review");
  await run(env, o);
  assert.equal(env.calls.buy.length, 1);
});

test("a refused buy is 'failed', paged once, and not retried by itself", async () => {
  const env = setup({ buy: () => ({ ok: false, reason: "FunPay balance $0.20 is below the price $1.17", trace: [] }) });
  const o = env.order();
  const r1 = await run(env, o);
  const r2 = await run(env, o);
  assert.match(r1.skipped, /balance/);
  assert.match(r2.skipped, /balance/);
  assert.equal(env.purchases[0].state, "failed");
  assert.equal(env.calls.buy.length, 1);
  assert.equal(env.calls.pages.length, 1);
});

test("slow seller: pages after the wait, gives up to needs_review after the limit", async () => {
  let delivered = false;
  const env = setup({ read: (id) => ({ status: 200, order: { orderId: id, secrets: delivered ? ["fakeuser_late : LatePass9"] : [] } }) });
  const o = env.order();
  const r1 = await run(env, o);
  assert.match(r1.skipped, /waiting for the seller/);
  clock.t += 16 * 60000;
  await run(env, o);
  assert.equal(env.calls.pages.length, 1);
  assert.match(env.calls.pages[0], /has not delivered yet/);
  clock.t += 60000;
  await run(env, o);
  assert.equal(env.calls.pages.length, 1, "seller_slow pages once");
  delivered = true;
  const r = await run(env, o);
  assert.equal(r.delivered, 1);

  const env2 = setup({ read: (id) => ({ status: 200, order: { orderId: id, secrets: [] } }) });
  const o2 = env2.order();
  await run(env2, o2);
  clock.t += 25 * 3600 * 1000;
  const r2 = await run(env2, o2);
  assert.equal(env2.purchases[0].state, "needs_review");
  assert.match(r2.skipped, /has not delivered after 24 h/);
});

test("an unreadable delivery goes to needs_review with one page", async () => {
  const env = setup({ read: (id) => ({ status: 200, order: { orderId: id, secrets: ["Thanks! Link it and enjoy."] } }) });
  const o = env.order();
  const r = await run(env, o);
  assert.match(r.skipped, /exactly one login/);
  assert.equal(env.purchases[0].state, "needs_review");
  assert.equal(env.calls.send.length, 0);
  assert.equal(env.calls.pages.length, 1);
});

test("24 h cap and hourly limit stop new buys", async () => {
  const env = setup({ settings: { dailyCapUsd: 2 } });
  env.purchases.push({ _id: "x", eldoradoOrderId: "other", unit: 0, state: "delivered", buyingAt: new Date(clock.t - 3600e3), chargedUsd: 1.2, maxPriceUsd: 1.5, alerted: [] });
  const r = await run(env, env.order());
  assert.match(r.skipped, /24 h spend cap/);
  assert.equal(env.calls.buy.length, 0);

  const env2 = setup({ settings: { maxBuysPerHour: 1 } });
  env2.purchases.push({ _id: "y", eldoradoOrderId: "other", unit: 0, state: "delivered", buyingAt: new Date(clock.t - 600e3), chargedUsd: 1, alerted: [] });
  const r2 = await run(env2, env2.order());
  assert.match(r2.skipped, /hourly buy limit/);
  assert.equal(env2.calls.buy.length, 0);
});

test("two units: two buys, one message with both accounts", async () => {
  const env = setup();
  const o = env.order({ totalPrice: { amount: 6.24, currency: "USD" } });
  const r = await run(env, o, 2);
  assert.equal(r.delivered, 2);
  assert.equal(env.calls.buy.length, 2);
  assert.equal(env.calls.send.length, 1);
  assert.match(env.calls.send[0], /=== ACCOUNT 1 of 2 ===/);
  assert.match(env.calls.send[0], /=== ACCOUNT 2 of 2 ===/);
  assert.equal(env.listing.units.length, 2);
});

test("an order above the unit limit is held before anything is written", async () => {
  const env = setup({ settings: { maxUnitsPerOrder: 2 } });
  const r = await run(env, env.order(), 3);
  assert.match(r.skipped, /above the limit/);
  assert.equal(env.purchases.length, 0);
});

test("a failed chat send keeps the login and re-sends next tick", async () => {
  const env = setup({ sendFails: 1 });
  const o = env.order();
  const r1 = await run(env, o);
  assert.match(r1.skipped, /delivery message failed/);
  assert.equal(env.purchases[0].state, "received");
  assert.equal(env.calls.marked.length, 0);
  const r2 = await run(env, o);
  assert.equal(r2.delivered, 1);
  assert.equal(env.calls.buy.length, 1, "the account was bought once");
});

test("an unexpected error is returned as an error and paged once", async () => {
  const env = setup();
  engine.deps.models = () => {
    throw new Error("db down");
  };
  const o = env.order();
  const r1 = await run(env, o);
  const r2 = await run(env, o);
  assert.equal(r1.error, "funpay resale: db down");
  assert.equal(r2.error, "funpay resale: db down");
  assert.equal(env.calls.pages.length, 1);
});

test("buildDeliveryMessage never names the source and skips broken accounts", () => {
  const m = engine.buildDeliveryMessage([{ username: "a_user", password: "pw1234" }, { username: "", password: "x" }]);
  assert.match(m, /^Username: a_user\nPassword: pw1234\n\nHow to get your items:/);
  assert.doesNotMatch(m, /funpay/i);
  assert.equal(engine.buildDeliveryMessage([]), "");
  assert.match(
    engine.buildDeliveryMessage([{ username: "b_user", password: "pw5678", token: "tok0123456789" }]),
    /^Username: b_user\nPassword: pw5678\nToken \(only if Twitch asks for an email code\): tok0123456789\n\n/,
  );
});

test("unitSalePriceUsd uses the lower of the order share and the list price", () => {
  assert.equal(engine.unitSalePriceUsd({ totalPrice: { amount: 6, currency: "USD" } }, 2, 2.89), 2.89);
  assert.equal(engine.unitSalePriceUsd({ totalPrice: { amount: 5, currency: "USD" } }, 2, 2.89), 2.5);
  assert.equal(engine.unitSalePriceUsd({}, 1, 2.89), 2.89);
  assert.equal(engine.unitSalePriceUsd({ totalPrice: { amount: 5, currency: "EUR" } }, 1, 0), 0);
});
