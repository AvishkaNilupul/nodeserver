// Code shop expiry guard (utils/codeShop/expiry.js, docs/code-shop/02-ENGINE.md).
//
// The guard takes stock off sale before its codes stop working. What must
// hold:
// - a unit leaves sale only through the atomic available -> removed, and its
//   rows move only when that write won: a unit a buyer took in between is
//   never touched;
// - a unit in a platform vault cannot be pulled from here: the owner is told
//   once (stamp-deduped), and nothing is changed;
// - a pulled unit's good codes go back to stock — unless the unit was ever in
//   a vault, then they are held;
// - one Telegram message per run, and a failing Telegram never fails the run.
//
// Real Mongo via mongodb-memory-server; events, config and Telegram are fakes.
// All values are made up (the repository is public).
process.env.CRED_SECRET ||= "code-shop-expiry-test-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const CodeStock = require("../models/CodeStock");
const CodeProduct = require("../models/CodeProduct");
const SuppliedAccount = require("../models/SuppliedAccount");
const AccountOffer = require("../models/AccountOffer");
const { createExpiry, PULL_NOTE } = require("../utils/codeShop/expiry");

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const ALL = [CodeStock, CodeProduct, SuppliedAccount, AccountOffer];

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshopexpiry"));
  await Promise.all(ALL.map((m) => m.init()));
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

// run() looks at the whole ledger, so every test starts from an empty one.
test.beforeEach(async () => {
  await Promise.all(ALL.map((m) => m.deleteMany({})));
});

// ------------------------------------------------------------------ fixtures

let seq = 0;

function fakeEvents() {
  const logs = [];
  const stamps = new Set();
  return {
    logs,
    stamps,
    log: async (e) => {
      logs.push(e);
      return true;
    },
    stamp: async (k) => {
      if (stamps.has(k)) return false;
      stamps.add(k);
      return true;
    },
    has: async (k) => stamps.has(k),
  };
}

function fakeTelegram({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    send: async (text) => {
      sent.push(text);
      if (fail) throw new Error("telegram is down");
    },
  };
}

const fakeConfig = (over = {}) => ({ get: async () => ({ expiryGuard: true, expiryLeadHours: 36, ...over }) });

function expiryWith({ config = fakeConfig(), events = fakeEvents(), telegram = fakeTelegram(), now, ...extra } = {}) {
  const NOW = now === undefined ? Date.now() : now;
  const expiry = createExpiry({ now: () => NOW, events, config, telegram, ...extra });
  return { expiry, events, telegram, NOW };
}

async function shop(name) {
  seq += 1;
  const offer = await AccountOffer.create({ title: "Test code offer " + seq, game: "Test Game", status: "active", priceUsd: 3 });
  const product = await CodeProduct.create({
    name: name || "Test product " + seq,
    status: "active",
    offer: offer._id,
    slots: [
      { slotKey: `g${seq}:a`, label: "Reward A" },
      { slotKey: `g${seq}:b`, label: "Reward B" },
    ],
  });
  return { offer, product };
}

async function unitOf(offer, fields = {}) {
  seq += 1;
  return SuppliedAccount.create({
    offer: offer._id,
    login: "cs-test-" + seq,
    password: "not-a-real-ciphertext",
    status: "available",
    note: "code unit",
    ...fields,
  });
}

// One ledger row per entry of `useBys` (ms offsets from now, or null).
async function rowsIn({ unit, product, offer, state = "in_unit", unitStatus = "available", ...fields }, useBys, base = Date.now()) {
  const docs = useBys.map((off, i) => {
    seq += 1;
    return {
      loginId: "login-" + seq,
      itemKey: "item-" + seq,
      gameNo: "1",
      slotKey: "slot-" + i,
      state,
      unit: unit ? unit._id || unit : null,
      product: product ? product._id || product : null,
      offer: offer ? offer._id || offer : null,
      unitStatus,
      useBy: off === null ? null : new Date(base + off),
      ...fields,
    };
  });
  return CodeStock.insertMany(docs);
}

const ledger = (rows) => CodeStock.find({ _id: { $in: rows.map((r) => r._id) } }).sort({ _id: 1 }).lean();
const unitNow = (u) => SuppliedAccount.findById(u._id).lean();
const lastHistory = (row) => row.history[row.history.length - 1];

// ---------------------------------------------------------------- the switch

test("expiryGuard off: nothing is pulled, moved, logged or sent", async () => {
  const { offer, product } = await shop("Switch product");
  const unit = await unitOf(offer);
  const inUnit = await rowsIn({ unit, product, offer }, [10 * HOUR, 20 * DAY]);
  const free = await rowsIn({ state: "in_stock", unitStatus: "" }, [10 * HOUR, -HOUR]);

  const { expiry, events, telegram } = expiryWith({ config: fakeConfig({ expiryGuard: false }) });
  const out = await expiry.run();

  assert.deepEqual(out, { pulled: 0, expiring: 0, expired: 0, vaultWarned: 0, held: 0, errors: 0 });
  assert.equal((await unitNow(unit)).status, "available");
  for (const r of await ledger([...inUnit, ...free])) {
    assert.ok(["in_unit", "in_stock"].includes(r.state));
    assert.equal(r.history.length, 0);
  }
  assert.equal(events.logs.length, 0);
  assert.equal(telegram.sent.length, 0);
});

// ------------------------------------------------------------- pulling units

test("available unit inside the lead is pulled: lead rows -> expiring, others -> in_stock, both with pulledAt; ONE Telegram message", async () => {
  const alpha = await shop("Alpha bundle");
  const beta = await shop("Beta bundle");
  const u1 = await unitOf(alpha.offer);
  const u1rows = await rowsIn({ unit: u1, product: alpha.product, offer: alpha.offer }, [10 * HOUR, 20 * DAY]);
  const u2 = await unitOf(alpha.offer);
  const u2rows = await rowsIn({ unit: u2, product: alpha.product, offer: alpha.offer }, [5 * HOUR, 30 * HOUR]);
  const u3 = await unitOf(beta.offer);
  await rowsIn({ unit: u3, product: beta.product, offer: beta.offer }, [20 * HOUR, 9 * DAY]);
  // Nothing inside the lead: stays on sale.
  const u4 = await unitOf(alpha.offer);
  const u4rows = await rowsIn({ unit: u4, product: alpha.product, offer: alpha.offer }, [37 * HOUR, 20 * DAY]);

  const { expiry, events, telegram, NOW } = expiryWith();
  const out = await expiry.run();

  assert.equal(out.pulled, 3);
  assert.equal(out.expiring, 4); // u1 one, u2 two, u3 one
  assert.equal(out.errors, 0);
  for (const u of [u1, u2, u3]) {
    const now = await unitNow(u);
    assert.equal(now.status, "removed");
    assert.equal(now.note, PULL_NOTE);
    assert.equal(now.note, "code unit — pulled before its codes stop working");
  }
  assert.equal((await unitNow(u4)).status, "available");
  for (const r of await ledger(u4rows)) assert.equal(r.state, "in_unit");

  const [lead1, far1] = await ledger(u1rows);
  assert.equal(lead1.state, "expiring");
  assert.equal(lead1.pulledAt.getTime(), NOW);
  assert.equal(String(lead1.unit), String(u1._id), "an expiring row keeps the pointer to its unit");
  assert.equal(lead1.unitStatus, "removed");
  assert.deepEqual([lastHistory(lead1).from, lastHistory(lead1).to], ["in_unit", "expiring"]);
  assert.equal(far1.state, "in_stock", "a good code goes back to free stock");
  assert.equal(far1.pulledAt.getTime(), NOW);
  assert.equal(far1.unit, null);
  assert.equal(far1.product, null);
  assert.equal(far1.offer, null);
  assert.equal(far1.unitStatus, "");
  assert.deepEqual([lastHistory(far1).from, lastHistory(far1).to], ["in_unit", "in_stock"]);
  for (const r of await ledger(u2rows)) assert.equal(r.state, "expiring");

  assert.equal(telegram.sent.length, 1, "exactly one Telegram message per run");
  const msg = telegram.sent[0];
  assert.match(msg, /Took 2 bundles of Alpha bundle off sale: their codes stop working on /);
  assert.match(msg, /Took 1 bundle of Beta bundle off sale: their codes stop working on /);

  const pulls = events.logs.filter((e) => e.kind === "expiry-pull");
  assert.equal(pulls.length, 2, "one event per product");
  assert.deepEqual(pulls.map((e) => String(e.product)).sort(), [String(alpha.product._id), String(beta.product._id)].sort());
  assert.equal(pulls.find((e) => String(e.product) === String(alpha.product._id)).data.units, 2);
  // The date is the earliest use-by of what was pulled (u2's +5 h code).
  const alphaEvent = pulls.find((e) => String(e.product) === String(alpha.product._id));
  assert.equal(alphaEvent.data.useBy.getTime(), (await ledger(u2rows))[0].useBy.getTime());
});

test("a pulled unit whose code has already passed its use-by: that row -> expired", async () => {
  const { offer, product } = await shop("Late product");
  const unit = await unitOf(offer);
  const rows = await rowsIn({ unit, product, offer }, [-HOUR, 10 * HOUR]);

  const { expiry } = expiryWith();
  const out = await expiry.run();

  assert.equal(out.pulled, 1);
  assert.equal(out.expired, 1);
  assert.equal(out.expiring, 1);
  const [past, soon] = await ledger(rows);
  assert.equal(past.state, "expired");
  assert.equal(past.history.length, 1, "straight to expired, one transition");
  assert.equal(soon.state, "expiring");
});

test("a unit a buyer took between the read and the pull is not touched (pull returns false)", async () => {
  const { offer, product } = await shop("Raced product");
  const unit = await unitOf(offer);
  const rows = await rowsIn({ unit, product, offer }, [10 * HOUR, 20 * DAY]);
  const calls = [];
  const units = {
    pull: async (id, opts) => {
      calls.push({ id: String(id), note: opts && opts.note });
      return false;
    },
  };

  const { expiry, telegram, events } = expiryWith({ units });
  const out = await expiry.run();

  assert.deepEqual(calls, [{ id: String(unit._id), note: PULL_NOTE }]);
  assert.equal(out.pulled, 0);
  assert.equal(out.expiring, 0);
  assert.equal((await unitNow(unit)).status, "available");
  for (const r of await ledger(rows)) {
    assert.equal(r.state, "in_unit");
    assert.equal(r.pulledAt, null);
    assert.equal(r.history.length, 0);
  }
  assert.equal(telegram.sent.length, 0);
  assert.equal(events.logs.filter((e) => e.kind === "expiry-pull").length, 0);
});

test("without deps.units the inline atomic pull loses to a sale that lands first", async () => {
  const { offer, product } = await shop("Inline race product");
  const unit = await unitOf(offer);
  const rows = await rowsIn({ unit, product, offer }, [10 * HOUR]);
  // The unit is read as available; a sale lands before the guarded write.
  const racing = {
    find: (...a) => SuppliedAccount.find(...a),
    updateOne: async (filter, update, opts) => {
      await SuppliedAccount.updateOne({ _id: filter._id }, { $set: { status: "sold", market: "eldorado", orderId: "order-race" } });
      return SuppliedAccount.updateOne(filter, update, opts);
    },
  };

  const { expiry, telegram } = expiryWith({ models: { SuppliedAccount: racing } });
  const out = await expiry.run();

  assert.equal(out.pulled, 0);
  const u = await unitNow(unit);
  assert.equal(u.status, "sold");
  assert.equal(u.note, "code unit");
  assert.equal((await ledger(rows))[0].state, "in_unit");
  assert.equal(telegram.sent.length, 0);
});

test("an injected units.pull is used when given", async () => {
  const { offer, product } = await shop("Injected product");
  const unit = await unitOf(offer);
  await rowsIn({ unit, product, offer }, [10 * HOUR]);
  const calls = [];
  const units = {
    pull: async (id, { note }) => {
      calls.push(note);
      const res = await SuppliedAccount.updateOne({ _id: id, status: "available" }, { $set: { status: "removed", note } });
      return res.modifiedCount === 1;
    },
  };

  const out = await expiryWith({ units }).expiry.run();

  assert.deepEqual(calls, [PULL_NOTE]);
  assert.equal(out.pulled, 1);
  assert.equal((await unitNow(unit)).status, "removed");
});

test("a pulled unit that was ever in a platform vault: its rows are held, never back in stock", async () => {
  const { offer, product } = await shop("Vault-back product");
  const unit = await unitOf(offer);
  const rows = await rowsIn({ unit, product, offer, wasFed: true }, [10 * HOUR, 20 * DAY]);

  const out = await expiryWith().expiry.run();

  assert.equal(out.pulled, 1);
  assert.equal(out.held, 2);
  assert.equal((await unitNow(unit)).status, "removed");
  for (const r of await ledger(rows)) {
    assert.equal(r.state, "held");
    assert.match(r.problem, /platform vault/);
  }
});

// ------------------------------------------------------------- vault units

test("fed unit inside the lead: one warning event + one Telegram line, deduped across runs; nothing changed", async () => {
  const { offer, product } = await shop("Vault product");
  const unit = await unitOf(offer, { status: "fed", market: "ggsel", fedAt: new Date() });
  const rows = await rowsIn({ unit, product, offer, unitStatus: "fed", wasFed: true }, [10 * HOUR, 20 * DAY]);
  const events = fakeEvents();
  const telegram = fakeTelegram();

  const first = await expiryWith({ events, telegram }).expiry.run();

  assert.equal(first.vaultWarned, 1);
  assert.equal(first.pulled, 0);
  assert.ok(events.stamps.has("vault-expiry:" + String(unit._id)));
  const warns = events.logs.filter((e) => e.kind === "vault-expiry");
  assert.equal(warns.length, 1);
  assert.equal(warns[0].level, "warn");
  assert.equal(String(warns[0].product), String(product._id));
  assert.equal(telegram.sent.length, 1);
  assert.match(telegram.sent[0], /Vault product bundle sits in a platform vault .*take it down by hand/);
  assert.equal((await unitNow(unit)).status, "fed");
  for (const r of await ledger(rows)) {
    assert.equal(r.state, "in_unit");
    assert.equal(r.history.length, 0);
  }

  const second = await expiryWith({ events, telegram }).expiry.run();
  assert.equal(second.vaultWarned, 0);
  assert.equal(events.logs.filter((e) => e.kind === "vault-expiry").length, 1);
  assert.equal(telegram.sent.length, 1, "no second message for the same unit");
});

// --------------------------------------------------------------- free codes

test("free codes: in_stock inside the lead -> expiring; in_stock / expiring past use-by -> expired; others untouched", async () => {
  const lead = await rowsIn({ state: "in_stock", unitStatus: "" }, [10 * HOUR]);
  const pastFree = await rowsIn({ state: "in_stock", unitStatus: "" }, [-HOUR]);
  const pastExpiring = await rowsIn({ state: "expiring", unitStatus: "" }, [-HOUR]);
  const far = await rowsIn({ state: "in_stock", unitStatus: "" }, [20 * DAY, null]);
  const held = await rowsIn({ state: "held", unitStatus: "", problem: "made-up" }, [-HOUR]);
  const sold = await rowsIn({ state: "sold", unitStatus: "sold" }, [-HOUR]);

  const { expiry, telegram } = expiryWith();
  const out = await expiry.run();

  assert.equal(out.expiring, 1);
  assert.equal(out.expired, 2);
  assert.equal(out.pulled, 0);
  const [l] = await ledger(lead);
  assert.equal(l.state, "expiring");
  assert.deepEqual([lastHistory(l).from, lastHistory(l).to], ["in_stock", "expiring"]);
  const [pf] = await ledger(pastFree);
  assert.equal(pf.state, "expired");
  assert.equal(pf.history.length, 1, "straight to expired");
  assert.deepEqual([lastHistory(pf).from, lastHistory(pf).to], ["in_stock", "expired"]);
  const [pe] = await ledger(pastExpiring);
  assert.equal(pe.state, "expired");
  assert.deepEqual([lastHistory(pe).from, lastHistory(pe).to], ["expiring", "expired"]);
  for (const r of await ledger(far)) assert.equal(r.state, "in_stock");
  assert.equal((await ledger(held))[0].state, "held");
  assert.equal((await ledger(sold))[0].state, "sold");
  assert.equal(telegram.sent.length, 0, "nothing pulled, nothing sent");
});

// ---------------------------------------------------------------- telegram

test("a Telegram send that throws does not throw out of run(); the pull stands", async () => {
  const { offer, product } = await shop("Quiet product");
  const unit = await unitOf(offer);
  const rows = await rowsIn({ unit, product, offer }, [10 * HOUR, 20 * DAY]);
  const telegram = fakeTelegram({ fail: true });

  const { expiry, events } = expiryWith({ telegram });
  const out = await expiry.run();

  assert.equal(out.pulled, 1);
  assert.equal(telegram.sent.length, 1);
  assert.equal((await unitNow(unit)).status, "removed");
  const [soon, good] = await ledger(rows);
  assert.equal(soon.state, "expiring");
  assert.equal(good.state, "in_stock");
  assert.ok(events.logs.some((e) => e.kind === "telegram" && e.level === "warn"));
});

test("a second run after a pull changes nothing and sends nothing", async () => {
  const { offer, product } = await shop("Twice product");
  const unit = await unitOf(offer);
  await rowsIn({ unit, product, offer }, [10 * HOUR, 20 * DAY]);
  await rowsIn({ state: "in_stock", unitStatus: "" }, [5 * HOUR, -HOUR]);
  const telegram = fakeTelegram();
  const events = fakeEvents();
  const NOW = Date.now();

  const first = await expiryWith({ telegram, events, now: NOW }).expiry.run();
  assert.equal(first.pulled, 1);
  const snap = async () => JSON.stringify({ rows: await CodeStock.find({}).sort({ _id: 1 }).lean(), units: await SuppliedAccount.find({}).sort({ _id: 1 }).lean() });
  const before = await snap();

  const second = await expiryWith({ telegram, events, now: NOW }).expiry.run();
  assert.deepEqual(second, { pulled: 0, expiring: 0, expired: 0, vaultWarned: 0, held: 0, errors: 0 });
  assert.equal(await snap(), before);
  assert.equal(telegram.sent.length, 1);
});
