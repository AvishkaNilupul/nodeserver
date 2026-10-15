// Code shop reconcile (utils/codeShop/reconcile.js, docs/code-shop/02-ENGINE.md).
//
// Reconcile mirrors each unit's SuppliedAccount status onto the ledger rows of
// the codes inside it. It decides whether a code goes back on sale, so the
// things under test are the ones that could sell a code twice:
// - a unit that was in a platform vault and comes back "available" is taken off
//   sale atomically and its codes are held — and if a buyer took the unit
//   first, nothing is touched;
// - a removed unit's codes go back to stock only when nothing says the unit
//   ever went out through a market;
// - every ledger write is guarded by unit AND state, so a concurrent change is
//   never overwritten.
//
// Real Mongo via mongodb-memory-server: the guarded updates are the thing under
// test. All values are made up (the repository is public).
process.env.CRED_SECRET ||= "code-shop-reconcile-test-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const CodeStock = require("../models/CodeStock");
const CodeProduct = require("../models/CodeProduct");
const SuppliedAccount = require("../models/SuppliedAccount");
const MarketplaceListing = require("../models/MarketplaceListing");
const AccountOffer = require("../models/AccountOffer");
const { createReconcile, WHY, NOTE_VAULT } = require("../utils/codeShop/reconcile");

const ObjectId = mongoose.Types.ObjectId;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const ALL = [CodeStock, CodeProduct, SuppliedAccount, MarketplaceListing, AccountOffer];

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshopreconcile"));
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

const fakeConfig = (over = {}) => ({ get: async () => ({ expiryGuard: true, expiryLeadHours: 36, ...over }) });

function reconcileWith(extra = {}) {
  const events = fakeEvents();
  const rec = createReconcile({ now: () => Date.now(), events, config: fakeConfig(), ...extra });
  return { rec, events };
}

async function shop({ slots = 3, priceUsd = 4.5, status = "active", name } = {}) {
  seq += 1;
  const offer = await AccountOffer.create({ title: "Test code offer " + seq, game: "Test Game", status: "active", priceUsd });
  const product = await CodeProduct.create({
    name: name || "Test product " + seq,
    status,
    offer: offer._id,
    slots: Array.from({ length: slots }, (_, i) => ({ slotKey: `g${seq}:s${i}`, label: `Reward ${i + 1}` })),
    pricing: { mode: "fixed", priceUsd },
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

// n ledger rows in one unit; perRow[i] overrides fields of row i.
async function rowsIn({ unit, product, offer, n = 3, state = "in_unit", unitStatus = "available", ...fields }, perRow = []) {
  const docs = [];
  for (let i = 0; i < n; i += 1) {
    seq += 1;
    docs.push({
      loginId: "login-" + seq,
      itemKey: "item-" + seq,
      gameNo: "1",
      slotKey: "slot-" + i,
      state,
      unit: unit && unit._id ? unit._id : unit,
      product: product && product._id ? product._id : product,
      offer: offer && offer._id ? offer._id : offer,
      unitStatus,
      ...fields,
      ...(perRow[i] || {}),
    });
  }
  return CodeStock.insertMany(docs);
}

const ledger = (ids) => CodeStock.find({ _id: { $in: ids.map((r) => r._id || r) } }).sort({ _id: 1 }).lean();
const one = (row) => CodeStock.findById(row._id || row).lean();
const lastHistory = (row) => row.history[row.history.length - 1];

// An ObjectId minted `ago` ms in the past (a unit id that is not in flight).
const oldId = (ago = 2 * HOUR) => ObjectId.createFromTime(Math.floor((Date.now() - ago) / 1000));

async function insertListing(offer, marketplace, price, createdAt) {
  seq += 1;
  await MarketplaceListing.collection.insertOne({
    accountOffer: offer._id,
    marketplace,
    externalId: "ext-" + seq,
    price,
    status: "active",
    origin: "manual",
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  });
}

// --------------------------------------------------------------- missing unit

test("missing unit: in_unit rows become held, sold rows stay sold", async () => {
  const { offer, product } = await shop();
  const gone = oldId();
  const inUnit = await rowsIn({ unit: gone, product, offer, n: 2 });
  const [sold] = await rowsIn({ unit: gone, product, offer, n: 1, state: "sold", unitStatus: "sold", saleUsd: 1.5, market: "eldorado", orderId: "order-a" });

  const { rec } = reconcileWith();
  const out = await rec.run();

  assert.equal(out.checked, 1);
  assert.equal(out.held, 2);
  for (const r of await ledger(inUnit)) {
    assert.equal(r.state, "held");
    assert.equal(r.problem, WHY.missing);
    assert.equal(r.problem, "its stock row is gone");
    assert.equal(String(r.unit), String(gone), "a held row keeps the pointer to its unit");
    assert.deepEqual(
      { from: lastHistory(r).from, to: lastHistory(r).to, why: lastHistory(r).why },
      { from: "in_unit", to: "held", why: "its stock row is gone" },
    );
  }
  const s = await one(sold);
  assert.equal(s.state, "sold");
  assert.equal(s.saleUsd, 1.5);
  assert.equal(s.history.length, 0);
});

test("missing unit: a unit id minted moments ago is left alone (units.build may still be writing it)", async () => {
  const { offer, product } = await shop();
  const fresh = new ObjectId();
  const rows = await rowsIn({ unit: fresh, product, offer, n: 2 });

  const { rec } = reconcileWith();
  const out = await rec.run();

  assert.equal(out.held, 0);
  for (const r of await ledger(rows)) {
    assert.equal(r.state, "in_unit");
    assert.equal(r.history.length, 0);
  }
});

// ---------------------------------------------------- available after a vault

test("available unit whose rows were fed: unit removed atomically, rows held (unitStatus 'fed' and wasFed)", async () => {
  const { offer, product } = await shop();
  const u1 = await unitOf(offer);
  const fedRows = await rowsIn({ unit: u1, product, offer, n: 3, unitStatus: "fed", wasFed: true });
  const u2 = await unitOf(offer);
  // Seen in a vault once (wasFed), last seen available; one row already sold.
  const wasFedRows = await rowsIn({ unit: u2, product, offer, n: 2, unitStatus: "available", wasFed: true });
  const [wasFedSold] = await rowsIn({ unit: u2, product, offer, n: 1, state: "sold", unitStatus: "sold", wasFed: true, saleUsd: 1 });
  const u3 = await unitOf(offer);
  // Only unitStatus says fed (wasFed not yet set): still a vault unit.
  const statusOnly = await rowsIn({ unit: u3, product, offer, n: 1, unitStatus: "fed", wasFed: false });

  const { rec } = reconcileWith();
  const out = await rec.run();

  assert.equal(out.held, 7);
  for (const u of [u1, u2, u3]) {
    const now = await SuppliedAccount.findById(u._id).lean();
    assert.equal(now.status, "removed");
    assert.equal(now.note, NOTE_VAULT);
    assert.equal(now.note, "code unit — came back from a platform vault");
  }
  for (const r of await ledger([...fedRows, ...wasFedRows, ...statusOnly])) {
    assert.equal(r.state, "held");
    assert.equal(r.problem, "was in a platform vault and came back; it may already be sold");
    assert.equal(lastHistory(r).from, "in_unit");
    assert.equal(lastHistory(r).to, "held");
  }
  const s = await one(wasFedSold);
  assert.equal(s.state, "held");
  assert.equal(lastHistory(s).from, "sold");
});

test("available-after-fed: a buyer took the unit before the atomic remove -> nothing is changed", async () => {
  const { offer, product } = await shop();
  const unit = await unitOf(offer);
  const rows = await rowsIn({ unit, product, offer, n: 3, unitStatus: "fed", wasFed: true });

  // The unit is read as available; a sale lands before the guarded write.
  const racing = {
    find: (...a) => SuppliedAccount.find(...a),
    updateOne: async (filter, update, opts) => {
      await SuppliedAccount.updateOne(
        { _id: filter._id },
        { $set: { status: "sold", market: "eldorado", orderId: "order-race", soldAt: new Date() } },
      );
      return SuppliedAccount.updateOne(filter, update, opts);
    },
  };
  const { rec } = reconcileWith({ models: { SuppliedAccount: racing } });
  const out = await rec.run();

  assert.equal(out.held, 0);
  const u = await SuppliedAccount.findById(unit._id).lean();
  assert.equal(u.status, "sold", "the sale stands");
  assert.equal(u.note, "code unit", "the unit was not rewritten");
  for (const r of await ledger(rows)) {
    assert.equal(r.state, "in_unit");
    assert.equal(r.unitStatus, "fed");
    assert.equal(r.problem, "");
    assert.equal(r.history.length, 0);
  }

  // The next pass reads the sale.
  const again = await reconcileWith().rec.run();
  assert.equal(again.sold, 3);
  for (const r of await ledger(rows)) assert.equal(r.state, "sold");
});

test("available-after-fed: an injected units.pull that loses changes nothing", async () => {
  const { offer, product } = await shop();
  const unit = await unitOf(offer);
  const rows = await rowsIn({ unit, product, offer, n: 2, unitStatus: "fed", wasFed: true });
  const calls = [];
  const { rec } = reconcileWith({
    units: {
      pull: async (id, opts) => {
        calls.push({ id: String(id), note: opts && opts.note });
        return false;
      },
    },
  });
  const out = await rec.run();

  assert.deepEqual(calls, [{ id: String(unit._id), note: NOTE_VAULT }]);
  assert.equal(out.held, 0);
  assert.equal((await SuppliedAccount.findById(unit._id).lean()).status, "available");
  for (const r of await ledger(rows)) {
    assert.equal(r.state, "in_unit");
    assert.equal(r.history.length, 0);
  }
});

// ------------------------------------------------------------------ available

test("available unit: in_unit rows get unitStatus available; a released sale goes sold -> in_unit", async () => {
  const { offer, product } = await shop();
  const plain = await unitOf(offer);
  const adopted = await rowsIn({ unit: plain, product, offer, n: 2, unitStatus: "" });

  const released = await unitOf(offer); // the fulfiller released its claim
  const sold = await rowsIn({
    unit: released,
    product,
    offer,
    n: 3,
    state: "sold",
    unitStatus: "sold",
    soldAt: new Date(Date.now() - HOUR),
    market: "eldorado",
    orderId: "order-released",
    saleUsd: 1.5,
  });

  const { rec } = reconcileWith();
  const out = await rec.run();

  assert.equal(out.released, 3);
  for (const r of await ledger(adopted)) {
    assert.equal(r.state, "in_unit");
    assert.equal(r.unitStatus, "available");
    assert.equal(r.history.length, 0, "no state change, no history entry");
  }
  for (const r of await ledger(sold)) {
    assert.equal(r.state, "in_unit");
    assert.equal(r.unitStatus, "available");
    assert.equal(r.soldAt, null);
    assert.equal(r.market, "");
    assert.equal(r.orderId, "");
    assert.equal(r.saleUsd, 0);
    assert.deepEqual([lastHistory(r).from, lastHistory(r).to], ["sold", "in_unit"]);
  }
  assert.equal((await SuppliedAccount.findById(released._id).lean()).status, "available", "the unit itself is not touched");
});

// ----------------------------------------------------------------------- fed

test("fed unit: rows stay in_unit with unitStatus fed and wasFed true", async () => {
  const { offer, product } = await shop();
  const unit = await unitOf(offer, { status: "fed", market: "ggsel", fedAt: new Date() });
  const rows = await rowsIn({ unit, product, offer, n: 3 });

  const { rec } = reconcileWith();
  const out = await rec.run();

  assert.equal(out.fed, 3);
  for (const r of await ledger(rows)) {
    assert.equal(r.state, "in_unit");
    assert.equal(r.unitStatus, "fed");
    assert.equal(r.wasFed, true);
    assert.equal(r.history.length, 0);
  }
  assert.equal((await SuppliedAccount.findById(unit._id).lean()).status, "fed");
});

test("fed unit: a row seen sold (claim, then feed) goes back to in_unit, marked fed", async () => {
  const { offer, product } = await shop();
  const unit = await unitOf(offer, { status: "fed", market: "ggsel", fedAt: new Date() });
  const rows = await rowsIn({ unit, product, offer, n: 2, state: "sold", unitStatus: "sold", market: "ggsel", saleUsd: 2 });

  const out = await reconcileWith().rec.run();

  assert.equal(out.fed, 2);
  for (const r of await ledger(rows)) {
    assert.equal(r.state, "in_unit");
    assert.equal(r.unitStatus, "fed");
    assert.equal(r.wasFed, true);
    assert.equal(r.saleUsd, 0);
    assert.deepEqual([lastHistory(r).from, lastHistory(r).to], ["sold", "in_unit"]);
  }
});

// ---------------------------------------------------------------------- sold

test("sold unit: rows sold with soldAt = deliveredAt, market, orderId, saleUsd = newest listing of that market / slots", async () => {
  const { offer, product } = await shop({ slots: 3, priceUsd: 4.5 });
  const t0 = Date.now() - 10 * DAY;
  await insertListing(offer, "eldorado", 3, t0); // older
  const newestEldorado = t0 + DAY;
  await insertListing(offer, "eldorado", 6, newestEldorado); // newest of the market
  await insertListing(offer, "ggsel", 30, t0 + 2 * DAY); // newer, other market

  const soldAt = new Date(Date.now() - 2 * HOUR);
  const deliveredAt = new Date(Date.now() - HOUR);
  const unit = await unitOf(offer, { status: "sold", market: "eldorado", orderId: "order-7", soldAt, deliveredAt });
  const rows = await rowsIn({ unit, product, offer, n: 3 });

  const { rec } = reconcileWith();
  const out = await rec.run();

  assert.equal(out.sold, 3);
  for (const r of await ledger(rows)) {
    assert.equal(r.state, "sold");
    assert.equal(r.unitStatus, "sold");
    assert.equal(r.soldAt.getTime(), deliveredAt.getTime());
    assert.equal(r.market, "eldorado");
    assert.equal(r.orderId, "order-7");
    assert.equal(r.saleUsd, 2);
    assert.deepEqual([lastHistory(r).from, lastHistory(r).to, lastHistory(r).why], ["in_unit", "sold", "unit sold"]);
  }

  // The listing is repriced afterwards: the recorded share stays.
  await MarketplaceListing.collection.updateMany({ accountOffer: offer._id, marketplace: "eldorado" }, { $set: { price: 9 } });
  const second = await rec.run();
  assert.equal(second.sold, 0);
  for (const r of await ledger(rows)) {
    assert.equal(r.saleUsd, 2, "saleUsd is set once");
    assert.equal(r.history.length, 1);
  }
});

test("sold unit: no listing -> product price / slots; soldAt falls back to the unit's soldAt, then now", async () => {
  const { offer, product } = await shop({ slots: 3, priceUsd: 4.5 });
  const unitSoldAt = new Date(Date.now() - 3 * HOUR);
  const a = await unitOf(offer, { status: "sold", market: "eldorado", orderId: "order-a", soldAt: unitSoldAt });
  const rowsA = await rowsIn({ unit: a, product, offer, n: 3 });
  const b = await unitOf(offer, { status: "sold", market: "", orderId: "" });
  const rowsB = await rowsIn({ unit: b, product, offer, n: 3 });

  const before = Date.now();
  const out = await reconcileWith().rec.run();
  const after = Date.now();

  assert.equal(out.sold, 6);
  for (const r of await ledger(rowsA)) {
    assert.equal(r.saleUsd, 1.5);
    assert.equal(r.soldAt.getTime(), unitSoldAt.getTime());
  }
  for (const r of await ledger(rowsB)) {
    assert.equal(r.saleUsd, 1.5);
    assert.ok(r.soldAt.getTime() >= before && r.soldAt.getTime() <= after, "no sale time on the unit -> now");
  }
});

// ------------------------------------------------------------------- removed

test("removed unit with pulledAt: expiring, or expired once useBy has passed", async () => {
  const { offer, product } = await shop();
  const unit = await unitOf(offer, { status: "removed", note: "code unit — pulled" });
  const pulledAt = new Date(unit.createdAt.getTime() + 1000);
  const rows = await rowsIn({ unit, product, offer, n: 2, pulledAt }, [
    { useBy: new Date(Date.now() + 20 * DAY) }, // pulled with the unit, still far
    { useBy: new Date(Date.now() - HOUR) }, // already past
  ]);

  const out = await reconcileWith().rec.run();

  assert.equal(out.expiring, 1);
  assert.equal(out.expired, 1);
  assert.equal(out.back, 0);
  const [far, past] = await ledger(rows);
  assert.equal(far.state, "expiring");
  assert.equal(past.state, "expired");
  for (const r of [far, past]) {
    assert.equal(r.unitStatus, "removed");
    assert.equal(lastHistory(r).from, "in_unit");
  }
});

test("removed unit without pulledAt: back to in_stock (pointers cleared), or expiring inside the lead time", async () => {
  const { offer, product } = await shop();
  const unit = await unitOf(offer, { status: "removed", note: "code unit — removed by the owner" });
  const rows = await rowsIn({ unit, product, offer, n: 3 }, [
    { useBy: new Date(Date.now() + 20 * DAY) }, // far: back on the shelf
    { useBy: null }, // no use-by: back on the shelf
    { useBy: new Date(Date.now() + 10 * HOUR) }, // inside the 36 h lead
  ]);

  const out = await reconcileWith().rec.run();

  assert.equal(out.back, 2);
  assert.equal(out.expiring, 1);
  const [far, none, soon] = await ledger(rows);
  for (const r of [far, none]) {
    assert.equal(r.state, "in_stock");
    assert.equal(r.unit, null);
    assert.equal(r.product, null);
    assert.equal(r.offer, null);
    assert.equal(r.unitStatus, "");
    assert.deepEqual([lastHistory(r).from, lastHistory(r).to], ["in_unit", "in_stock"]);
  }
  assert.equal(soon.state, "expiring");
  assert.deepEqual([lastHistory(soon).from, lastHistory(soon).to], ["in_unit", "expiring"]);
});

test("removed unit: a pulledAt older than the unit (an earlier pull) does not count", async () => {
  const { offer, product } = await shop();
  const unit = await unitOf(offer, { status: "removed" });
  const rows = await rowsIn({ unit, product, offer, n: 1, pulledAt: new Date(unit.createdAt.getTime() - DAY), useBy: new Date(Date.now() + 20 * DAY) });

  const out = await reconcileWith().rec.run();

  assert.equal(out.back, 1);
  assert.equal((await one(rows[0])).state, "in_stock");
});

test("removed unit that went out through a market (vault marks, or fed rows): rows held, sold rows stay sold", async () => {
  const { offer, product } = await shop();
  // listingDetach removes a FED unit: the vault marks stay on it.
  const detached = await unitOf(offer, { status: "removed", market: "ggsel", fedAt: new Date(), contentId: "content-1" });
  const marked = await rowsIn({ unit: detached, product, offer, n: 2, useBy: new Date(Date.now() + 20 * DAY) });
  // No marks on the unit, but a row saw it fed.
  const clean = await unitOf(offer, { status: "removed" });
  const fedRows = await rowsIn({ unit: clean, product, offer, n: 1, wasFed: true, unitStatus: "fed" });
  // Sold, then the owner removed the unit: the sale stands.
  const soldUnit = await unitOf(offer, { status: "removed" });
  const [soldRow] = await rowsIn({ unit: soldUnit, product, offer, n: 1, state: "sold", unitStatus: "sold", saleUsd: 1 });

  const out = await reconcileWith().rec.run();

  assert.equal(out.held, 3);
  assert.equal(out.back, 0);
  for (const r of await ledger(marked)) {
    assert.equal(r.state, "held");
    assert.equal(r.problem, WHY.marketRemoved);
  }
  const f = await one(fedRows[0]);
  assert.equal(f.state, "held");
  assert.equal(f.problem, WHY.vaultRemoved);
  const s = await one(soldRow);
  assert.equal(s.state, "sold");
  assert.equal(s.history.length, 0);
});

// ----------------------------------------------------------- product useBy

test("product.useBy = earliest useBy of its in_unit rows on sale (available units only)", async () => {
  const a = await shop({ name: "Product A" });
  const u = await unitOf(a.offer);
  await rowsIn({ unit: u, product: a.product, offer: a.offer, n: 3 }, [
    { useBy: new Date(Date.now() + 5 * DAY) },
    { useBy: new Date(Date.now() + 3 * DAY) },
    { useBy: null },
  ]);
  // A vault unit's codes are not "on sale" by us: they do not count.
  const fedUnit = await unitOf(a.offer, { status: "fed", fedAt: new Date(), market: "ggsel" });
  await rowsIn({ unit: fedUnit, product: a.product, offer: a.offer, n: 1, useBy: new Date(Date.now() + DAY) });
  // Free stock tagged with the product does not count either.
  await rowsIn({ unit: null, product: a.product, offer: null, n: 1, state: "in_stock", unitStatus: "", useBy: new Date(Date.now() + HOUR) });

  const b = await shop({ name: "Product B" });
  await CodeProduct.updateOne({ _id: b.product._id }, { $set: { useBy: new Date(Date.now() + 2 * DAY) } });
  const draftUseBy = new Date(Date.now() + 9 * DAY);
  const c = await shop({ name: "Product C", status: "draft" });
  await CodeProduct.updateOne({ _id: c.product._id }, { $set: { useBy: draftUseBy } });

  await reconcileWith().rec.run();

  const rowsOnSale = await CodeStock.find({ unit: u._id, useBy: { $ne: null } }).lean();
  const min = Math.min(...rowsOnSale.map((r) => r.useBy.getTime()));
  assert.equal(rowsOnSale.length, 2);
  assert.equal((await CodeProduct.findById(a.product._id).lean()).useBy.getTime(), min, "the +3 days code, not the fed or free one");
  assert.equal((await CodeProduct.findById(b.product._id).lean()).useBy, null, "nothing on sale -> null");
  assert.equal((await CodeProduct.findById(c.product._id).lean()).useBy.getTime(), draftUseBy.getTime(), "only active products");
});

// -------------------------------------------------------- guards + idempotence

test("a row another writer moved after the read is not overwritten (state-guarded update)", async () => {
  const { offer, product } = await shop();
  const unit = await unitOf(offer, { status: "sold", market: "eldorado", orderId: "order-g", soldAt: new Date() });
  const rows = await rowsIn({ unit, product, offer, n: 3 });
  const victim = rows[1]._id;

  // After reconcile has read the ledger, after-sale marks one row dead.
  const racingStock = {
    find: (...a) => {
      const q = CodeStock.find(...a);
      return {
        lean: async () => {
          const res = await q.lean();
          await CodeStock.updateOne({ _id: victim }, { $set: { state: "dead" } });
          return res;
        },
      };
    },
    updateMany: (...a) => CodeStock.updateMany(...a),
    aggregate: (...a) => CodeStock.aggregate(...a),
  };
  const out = await reconcileWith({ models: { CodeStock: racingStock } }).rec.run();

  assert.equal(out.sold, 2);
  const after = await ledger(rows);
  assert.deepEqual(after.map((r) => r.state), ["sold", "dead", "sold"]);
  assert.equal(after[1].history.length, 0);
});

test("one unit that fails to settle does not stop the others", async () => {
  const { offer, product } = await shop();
  const bad = await unitOf(offer, { status: "sold", market: "eldorado", orderId: "order-bad", soldAt: new Date() });
  const badRows = await rowsIn({ unit: bad, product, offer, n: 2 });
  const good = await unitOf(offer, { status: "sold", market: "eldorado", orderId: "order-good", soldAt: new Date() });
  const goodRows = await rowsIn({ unit: good, product, offer, n: 2 });

  const flaky = {
    find: (...a) => CodeStock.find(...a),
    updateMany: async (filter, update) => {
      if (String(filter.unit) === String(bad._id)) throw new Error("made-up write failure");
      return CodeStock.updateMany(filter, update);
    },
    aggregate: (...a) => CodeStock.aggregate(...a),
  };
  const { rec, events } = reconcileWith({ models: { CodeStock: flaky } });
  const out = await rec.run();

  assert.equal(out.errors, 1);
  assert.equal(out.sold, 2);
  for (const r of await ledger(badRows)) assert.equal(r.state, "in_unit");
  for (const r of await ledger(goodRows)) assert.equal(r.state, "sold");
  assert.ok(events.logs.some((e) => e.level === "error" && e.kind === "reconcile"));
});

test("history keeps the last 20 transitions", async () => {
  const { offer, product } = await shop();
  const unit = await unitOf(offer, { status: "sold", market: "eldorado", orderId: "order-h", soldAt: new Date() });
  const old = Array.from({ length: 20 }, (_, i) => ({ at: new Date(Date.now() - (30 - i) * DAY), from: "x", to: "y", why: "old " + i }));
  const [row] = await rowsIn({ unit, product, offer, n: 1, history: old });

  await reconcileWith().rec.run();

  const r = await one(row);
  assert.equal(r.history.length, 20);
  assert.equal(r.history[0].why, "old 1", "the oldest entry fell off");
  assert.deepEqual([lastHistory(r).from, lastHistory(r).to], ["in_unit", "sold"]);
});

test("a second run over the same ledger changes nothing", async () => {
  const s1 = await shop({ name: "Idem A" });
  const sold = await unitOf(s1.offer, { status: "sold", market: "eldorado", orderId: "order-i", soldAt: new Date() });
  await rowsIn({ unit: sold, product: s1.product, offer: s1.offer, n: 3 });
  const avail = await unitOf(s1.offer);
  await rowsIn({ unit: avail, product: s1.product, offer: s1.offer, n: 3, unitStatus: "", useBy: new Date(Date.now() + 9 * DAY) });
  const released = await unitOf(s1.offer);
  await rowsIn({ unit: released, product: s1.product, offer: s1.offer, n: 2, state: "sold", unitStatus: "sold", saleUsd: 1, orderId: "order-r", market: "eldorado" });
  const fed = await unitOf(s1.offer, { status: "fed", market: "ggsel", fedAt: new Date() });
  await rowsIn({ unit: fed, product: s1.product, offer: s1.offer, n: 2 });
  const vault = await unitOf(s1.offer);
  await rowsIn({ unit: vault, product: s1.product, offer: s1.offer, n: 2, wasFed: true });
  const removed = await unitOf(s1.offer, { status: "removed" });
  await rowsIn({ unit: removed, product: s1.product, offer: s1.offer, n: 3 }, [
    { useBy: new Date(Date.now() + 20 * DAY) },
    { useBy: new Date(Date.now() + 5 * HOUR) },
    { useBy: new Date(Date.now() - HOUR) },
  ]);
  await rowsIn({ unit: oldId(), product: s1.product, offer: s1.offer, n: 1 });

  const { rec } = reconcileWith();
  const first = await rec.run();
  assert.ok(first.sold + first.held + first.back + first.released + first.fed + first.expiring + first.expired > 0);

  const snap = async () =>
    JSON.stringify({
      rows: await CodeStock.find({}).sort({ _id: 1 }).lean(),
      units: await SuppliedAccount.find({}).sort({ _id: 1 }).lean(),
      products: await CodeProduct.find({}).sort({ _id: 1 }).lean(),
    });
  const before = await snap();
  const second = await rec.run();
  const afterSnap = await snap();

  assert.deepEqual(
    { sold: second.sold, back: second.back, held: second.held, fed: second.fed, released: second.released, expiring: second.expiring, expired: second.expired, errors: second.errors },
    { sold: 0, back: 0, held: 0, fed: 0, released: 0, expiring: 0, expired: 0, errors: 0 },
  );
  assert.equal(afterSnap, before, "not one field (not even updatedAt) moved");
});
