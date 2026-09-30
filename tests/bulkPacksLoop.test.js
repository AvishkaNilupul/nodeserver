// Bulk packs maintenance loop (utils/bulkPacks/loop.js) against real models in
// an in-memory Mongo. Stock, markets, farm capacity, no-claim stock, Telegram,
// the audit log and settings are fakes: no network, no settings.json, no real
// reservation is ever touched (docs/bulk-packs/CONTRACT.md §9, I7).
//
// The fulfillers save a listing's WHOLE units array from an in-memory copy
// (utils/eldoradoFulfiller.js deliverOrder, utils/g2gFulfiller.js). Several tests
// reproduce exactly that with a hydrated MarketplaceListing loaded "before" the
// loop acts and saved "after" — the clobber the loop has to survive (I3, I10).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const BulkOffer = require("../models/BulkOffer");
const MarketplaceListing = require("../models/MarketplaceListing");
const FarmServiceOrder = require("../models/FarmServiceOrder");
const DropSet = require("../models/DropSet");
const loop = require("../utils/bulkPacks/loop");
const { packsFor } = require("../utils/bulkPacks/packMath");

// PACKS-2 §1: every bulk row carries bulkPackSize N. Written through the raw
// collection, so it is stored whether or not the schema has the path yet
// (insertMany drops a path the schema does not know); the loop reads rows lean
// with a projection that names it.
const setPackSize = (rowId, n) =>
  MarketplaceListing.collection.updateOne(
    { _id: rowId },
    { $set: { bulkPackSize: n } },
  );

const T0 = new Date("2026-09-30T00:00:00Z");
const at = (min) => new Date(T0.getTime() + min * 60000);

let mongod;
let fx;
let seq = 0;

const bp = (o = {}) => ({
  enabled: true,
  markets: ["eldorado", "g2g", "gameflip"],
  tiers: [
    { minQty: 5, discountPct: 5 },
    { minQty: 10, discountPct: 10 },
  ],
  reserveSingles: 5,
  unitsPerOffer: 20,
  farmPrices: {
    eldorado: { 120: 3, 180: 4, 365: 7 },
    g2g: { 120: 3, 180: 4, 365: 7 },
  },
  farmDurations: [120, 180, 365],
  farmReserveSlots: 20,
  farmReservePristine: 20,
  farmMaxQty: 20,
  loopMinutes: 5,
  farmSyncMinutes: 15,
  ...o,
});

function installFakes() {
  const f = {
    bp: bp(),
    gate: { ok: true, reason: "" },
    notOurs: new Set(),
    bad: new Map(),
    readState: "active",
    failPause: false,
    failWithdraw: false,
    releaseThrows: 0,
    advertisable: 10,
    cap: {
      bestStackRoom: 30,
      totalFree: 40,
      pristine: 60,
      at: new Date(),
      error: "",
    },
    share: 10,
    onSetQuantity: null,
    calls: {
      pause: [],
      resume: [],
      setQuantity: [],
      withdraw: [],
      readOffer: [],
      release: [],
      releaseArgs: [],
      isStillOurs: [],
      unitHealth: [],
      capRead: 0,
      telegram: [],
      events: [],
      invalidate: 0,
    },
  };
  loop.__setDeps({
    settings: { getBulkPacks: () => f.bp },
    config: { currentGate: () => f.gate },
    stock: {
      async isStillOurs({ accountId }) {
        f.calls.isStillOurs.push(accountId);
        return !f.notOurs.has(accountId);
      },
      async releaseUnits({ set, market, accountIds }) {
        if (f.releaseThrows > 0) {
          f.releaseThrows--;
          throw new Error("DropLog write failed");
        }
        f.calls.releaseArgs.push({
          setId: String(set && set._id),
          market,
          accountIds: [...accountIds],
        });
        const released = [];
        const skipped = [];
        for (const id of accountIds) {
          f.calls.release.push(id);
          if (f.notOurs.has(id))
            skipped.push({ accountId: id, reason: "not ours" });
          else released.push(id);
        }
        return { released, skipped };
      },
      async unitHealth(ids) {
        f.calls.unitHealth.push([...ids]);
        return new Map(
          ids.map((id) => [
            id,
            f.bad.has(id)
              ? { ok: false, reason: f.bad.get(id) }
              : { ok: true, reason: "" },
          ]),
        );
      },
    },
    markets: {
      async pause(m, id) {
        f.calls.pause.push([m, id]);
        if (f.failPause) throw new Error("pause refused");
      },
      async resume(m, id) {
        f.calls.resume.push([m, id]);
      },
      async setQuantity(m, id, n) {
        if (f.onSetQuantity) await f.onSetQuantity(m, id, n);
        f.calls.setQuantity.push([m, id, n]);
      },
      async withdraw(m, id) {
        f.calls.withdraw.push([m, id]);
        if (f.failWithdraw) throw new Error("listing is already sold");
      },
      async readOffer(m, id) {
        f.calls.readOffer.push([m, id]);
        return { state: f.readState, quantity: 0 };
      },
    },
    farmCapacity: {
      async read() {
        f.calls.capRead++;
        return f.cap;
      },
      advertisable: () => f.advertisable,
    },
    noclaimStock: {
      async stockForListing() {
        return f.share;
      },
    },
    telegram: {
      sendTelegram(text) {
        f.calls.telegram.push(text);
        return Promise.resolve();
      },
    },
    systemLog: {
      logEvent(ev) {
        f.calls.events.push(ev);
        return Promise.resolve();
      },
    },
    proposals: {
      invalidate() {
        f.calls.invalidate++;
      },
    },
  });
  return f;
}

// Run a pass with the heartbeat line captured instead of printed.
async function pass(now, lines) {
  const orig = console.log;
  console.log = (...a) => {
    const line = a.join(" ");
    if (lines && line.startsWith("bulkPacks:")) lines.push(line);
    else if (!line.startsWith("bulkPacks:")) orig(...a);
  };
  try {
    return await loop.runOnce({ now });
  } finally {
    console.log = orig;
  }
}

const getOffer = (id) => BulkOffer.findById(id).lean();
const getRow = (id) => MarketplaceListing.findById(id).lean();
const entryOf = (offer, id) => offer.reserved.find((e) => e.accountId === id);
const unitIds = (row) => row.units.map((u) => u.accountId);
const tg = (re) => fx.calls.telegram.filter((t) => re.test(t));

// A live dropset offer as send.js leaves it (PACKS-2 §3): one listing = one
// pack of minQty accounts, the row sized bulkPackSize = minQty, the market
// advertising whole PACKS. `packPrice` 0 = an offer with no pack price
// recorded (revenue then falls back to accounts × unitPrice).
async function dropsetOffer({
  market = "eldorado",
  minQty = 5,
  n = 6,
  state = "live",
  advertisedQty,
  unitPrice = 1.5,
  packPrice = 0,
  bulkPackSize = minQty,
} = {}) {
  seq++;
  const set = await DropSet.create({
    name: "Rust bundle " + seq,
    items: [{ itemKey: "rust-item-" + seq, name: "Rust item" }],
  });
  const ids = Array.from({ length: n }, (_, i) => "acc" + seq + "_" + i);
  const externalId = "ext-" + seq;
  const offer = await BulkOffer.create({
    kind: "accounts",
    source: "dropset",
    market,
    set: set._id,
    setName: set.name,
    game: "Rust",
    minQty,
    discountPct: 5,
    unitPrice,
    packPrice,
    title:
      market === "gameflip"
        ? "Rust bundle " + seq + " — PACK OF " + minQty + " ACCOUNTS"
        : "Rust bundle " + seq + " — BULK " + minQty + "+ accounts (5% off)",
    externalId,
    state,
    slotKey: ["accounts", "dropset", String(set._id), market, minQty].join("|"),
    reserved: ids.map((id) => ({
      accountId: id,
      login: "login_" + id,
      state: "on_offer",
      at: T0,
    })),
    advertisedQty:
      advertisedQty == null
        ? market === "gameflip"
          ? 1
          : packsFor(n, minQty)
        : advertisedQty,
  });
  // insertMany: defaults and casting, without the create-time audit hook.
  const [row] = await MarketplaceListing.insertMany([
    {
      set: set._id,
      marketplace: market,
      externalId,
      title: offer.title,
      price: packPrice > 0 || market === "gameflip" ? packPrice : unitPrice,
      status: "active",
      origin: "manual",
      bulkOfferId: offer._id,
      autoDeliver: market === "gameflip",
      qtyRemaining: 0,
      qtyTarget: n,
      units: ids.map((id) => ({
        contentId: "",
        accountId: id,
        login: "login_" + id,
        addedAt: T0,
        deliveredAt: null,
        orderId: "",
        messagedAt: null,
      })),
    },
  ]);
  if (bulkPackSize) await setPackSize(row._id, bulkPackSize);
  await BulkOffer.updateOne({ _id: offer._id }, { $set: { listing: row._id } });
  return { set, ids, offerId: offer._id, rowId: row._id, externalId };
}

// `advertisedQty` is in PACKS (PACKS-2 §3): 2 = 10 accounts at minQty 5.
async function farmOffer({
  market = "eldorado",
  minQty = 5,
  advertisedQty = 2,
  state = "live",
  autoPaused = false,
  externalId,
  unitPrice = 3.8,
  packPrice = 0,
} = {}) {
  seq++;
  const ext = externalId || "farm-ext-" + seq;
  const title =
    "Rust Twitch Drops Automatic Farming 180 Days — Bulk " +
    minQty +
    "+ Accounts";
  const offer = await BulkOffer.create({
    kind: "farming",
    source: "farm",
    market,
    game: "Rust",
    days: 180,
    minQty,
    discountPct: 5,
    unitPrice,
    packPrice,
    title,
    externalId: ext,
    state,
    autoPaused,
    advertisedQty,
    slotKey: ["farming", "farm", "Rust@180#" + seq, market, minQty].join("|"),
  });
  return { offerId: offer._id, externalId: ext, title };
}

async function noclaimOffer({
  market = "eldorado",
  minQty = 5,
  units = [],
  packPrice = 0,
  bulkPackSize = minQty,
} = {}) {
  seq++;
  const set = await DropSet.create({
    name: "Overwatch bundle " + seq,
    stockSource: "noclaim",
    items: [{ itemKey: "ow-" + seq, name: "Skin" }],
  });
  const ext = "nc-" + seq;
  const offer = await BulkOffer.create({
    kind: "accounts",
    source: "noclaim",
    market,
    set: set._id,
    game: "Overwatch",
    minQty,
    unitPrice: 2,
    packPrice,
    title: "Overwatch bundle " + seq + " — PACK OF " + minQty + " ACCOUNTS",
    externalId: ext,
    state: "live",
    advertisedQty: 2,
    slotKey: ["accounts", "noclaim", String(set._id), market, minQty].join("|"),
  });
  const [row] = await MarketplaceListing.insertMany([
    {
      set: set._id,
      marketplace: market,
      externalId: ext,
      title: offer.title,
      price: 2,
      status: "active",
      origin: "manual",
      noclaimStock: true,
      bulkOfferId: offer._id,
      units,
    },
  ]);
  if (bulkPackSize) await setPackSize(row._id, bulkPackSize);
  await BulkOffer.updateOne({ _id: offer._id }, { $set: { listing: row._id } });
  return { offerId: offer._id, rowId: row._id, externalId: ext };
}

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("bulk-packs-loop-test"));
  await BulkOffer.init();
});

test.after(async () => {
  loop.stop();
  loop.__resetDeps();
  await mongoose.disconnect();
  await mongod.stop();
});

test.beforeEach(async () => {
  await Promise.all([
    BulkOffer.deleteMany({}),
    MarketplaceListing.deleteMany({}),
    FarmServiceOrder.deleteMany({}),
    DropSet.deleteMany({}),
  ]);
  fx = installFakes();
});

// ---------------------------------------------------------------------------
// Reconcile (I3, I10)
// ---------------------------------------------------------------------------

test("reconcile puts back a unit a fulfiller's stale whole-array save dropped", async () => {
  const { offerId, rowId, ids } = await dropsetOffer({ n: 6 });
  // The fulfiller loads the row for an order...
  const stale = await MarketplaceListing.findById(rowId);
  // ...a refill lands atomically while it is talking to Eldorado...
  await MarketplaceListing.updateOne(
    { _id: rowId },
    {
      $push: { units: { accountId: "late", login: "login_late", addedAt: T0 } },
    },
  );
  await BulkOffer.updateOne(
    { _id: offerId },
    {
      $push: {
        reserved: {
          accountId: "late",
          login: "login_late",
          state: "on_offer",
          at: T0,
        },
      },
    },
  );
  // ...and it saves the WHOLE array it loaded, with its delivery stamped.
  stale.units[0].deliveredAt = at(1);
  stale.units[0].orderId = "order-1";
  stale.markModified("units");
  await stale.save();
  assert.ok(
    !unitIds(await getRow(rowId)).includes("late"),
    "the save clobbered the refill",
  );

  const s = await pass(at(2));
  const row = await getRow(rowId);
  const offer = await getOffer(offerId);
  assert.ok(unitIds(row).includes("late"), "healed back onto the row");
  assert.equal(row.units.filter((u) => u.accountId === "late").length, 1);
  assert.equal(entryOf(offer, "late").state, "on_offer");
  assert.equal(entryOf(offer, ids[0]).state, "delivered");
  assert.equal(entryOf(offer, ids[0]).orderId, "order-1");
  assert.deepEqual(fx.calls.isStillOurs, ["late"]);
  assert.ok(offer.history.some((h) => h.action === "units_readded"));
  // The sale the stale save carried is counted and announced once.
  assert.equal(offer.ordersCount, 1);
  assert.equal(offer.unitsDelivered, 1);
  assert.equal(offer.revenueUsd, 1.5);
  assert.equal(s.sold, 1);
  assert.equal(tg(/^Bulk sale/).length, 1);
  assert.deepEqual(fx.calls.release, []);

  await pass(at(8));
  assert.equal(
    tg(/^Bulk sale/).length,
    1,
    "a sale is announced once, not every pass",
  );
  assert.equal(
    (await getRow(rowId)).units.filter((u) => u.accountId === "late").length,
    1,
  );
});

test("a dropped unit whose reservation is no longer ours is retired, never put back", async () => {
  const { offerId, rowId, ids } = await dropsetOffer({ n: 7 });
  await MarketplaceListing.updateOne(
    { _id: rowId },
    { $pull: { units: { accountId: ids[6] } } },
  );
  fx.notOurs.add(ids[6]);
  await pass(at(1));
  assert.ok(!unitIds(await getRow(rowId)).includes(ids[6]));
  const e = entryOf(await getOffer(offerId), ids[6]);
  assert.equal(e.state, "retiring");
  assert.match(e.reason, /no longer reserved/);
  // Phase 2 (15 minutes later, FIXES-1 L2) hands it back through releaseUnits,
  // which skips it as "not ours".
  await pass(at(16));
  const done = entryOf(await getOffer(offerId), ids[6]);
  assert.equal(done.state, "released");
  assert.match(done.reason, /^not ours/);
});

test("a retiring unit a stale save put back FREE is pulled again and its clock restarts", async () => {
  const { offerId, rowId, ids } = await dropsetOffer({ n: 8 });
  const stale = await MarketplaceListing.findById(rowId);
  await loop.retireUnits(
    await getOffer(offerId),
    await getRow(rowId),
    [ids[7]],
    "test retire",
    { now: at(0) },
  );
  assert.ok(!unitIds(await getRow(rowId)).includes(ids[7]));
  assert.equal(entryOf(await getOffer(offerId), ids[7]).state, "retiring");

  // The fulfiller delivers ids[0] from its copy, which still holds ids[7] FREE.
  stale.units[0].deliveredAt = at(1);
  stale.units[0].orderId = "o-1";
  stale.markModified("units");
  await stale.save();
  assert.ok(unitIds(await getRow(rowId)).includes(ids[7]), "came back FREE");

  const s = await pass(at(3)); // 3 min after retiring — but it is back on the row
  let e = entryOf(await getOffer(offerId), ids[7]);
  assert.ok(!unitIds(await getRow(rowId)).includes(ids[7]), "pulled again");
  assert.equal(e.state, "retiring");
  assert.equal(
    new Date(e.changedAt).getTime(),
    at(3).getTime(),
    "clock restarted",
  );
  assert.equal(s.retiring, 1);
  assert.deepEqual(fx.calls.release, []);

  await pass(at(17)); // 14 minutes after the re-pull
  assert.deepEqual(fx.calls.release, []);
  await pass(at(18)); // 15 minutes after the re-pull (FIXES-1 L2)
  assert.deepEqual(fx.calls.release, [ids[7]]);
  e = entryOf(await getOffer(offerId), ids[7]);
  assert.equal(e.state, "released");
  assert.equal(e.reason, "test retire");
  // A real hand-back is noted as one; nothing claims it was kept.
  const acts = (await getOffer(offerId)).history.map((h) => h.action + ": " + h.detail);
  assert.ok(acts.some((h) => /^units_released: 1 unit\(s\) released back to stock/.test(h)), acts.join("\n"));
  assert.ok(!acts.some((h) => h.startsWith("units_kept")), acts.join("\n"));
});

test("retired units are released only after 15 minutes, through releaseUnits for this set and market", async () => {
  const { offerId, rowId, ids, set } = await dropsetOffer({
    n: 10,
    market: "g2g",
  });
  await loop.retireUnits(
    await getOffer(offerId),
    await getRow(rowId),
    [ids[8], ids[9]],
    "withdraw",
    {
      now: at(0),
    },
  );
  const s1 = await pass(at(14));
  assert.deepEqual(fx.calls.release, []);
  assert.equal(s1.retiring, 2);
  const s2 = await pass(at(15)); // RETIRE_GRACE_MS (FIXES-1 L2)
  assert.deepEqual(fx.calls.release.sort(), [ids[8], ids[9]].sort());
  assert.equal(s2.released, 2);
  assert.ok(
    fx.calls.releaseArgs.every(
      (r) => r.setId === String(set._id) && r.market === "g2g",
    ),
  );
  const offer = await getOffer(offerId);
  assert.equal(entryOf(offer, ids[8]).state, "released");
  assert.equal(
    offer.reserved.filter((e) => e.state === "on_offer").length,
    8,
    "the rest stay on sale",
  );
  await pass(at(30));
  assert.equal(fx.calls.release.length, 2, "never released twice");
});

test("a unit that sold while being retired comes back delivered and is never released", async () => {
  const { offerId, rowId, ids } = await dropsetOffer({ n: 8 });
  const stale = await MarketplaceListing.findById(rowId); // the fulfiller loaded the row...
  await loop.retireUnits(
    await getOffer(offerId),
    await getRow(rowId),
    [ids[7]],
    "test",
    { now: at(0) },
  );
  // ...and was delivering exactly that unit.
  const u = stale.units.find((x) => x.accountId === ids[7]);
  u.deliveredAt = at(1);
  u.orderId = "o-77";
  stale.markModified("units");
  await stale.save();

  await pass(at(5));
  let offer = await getOffer(offerId);
  assert.equal(entryOf(offer, ids[7]).state, "delivered");
  assert.equal(entryOf(offer, ids[7]).orderId, "o-77");
  assert.ok(unitIds(await getRow(rowId)).includes(ids[7]));
  assert.equal(offer.unitsDelivered, 1);
  await pass(at(15));
  assert.deepEqual(fx.calls.release, []);

  // A stale snapshot cannot trick the conditional $pull: an order takes ids[6]
  // after the caller read the row, and the unit stays where the order needs it.
  const snap = await getRow(rowId);
  await MarketplaceListing.updateOne(
    { _id: rowId, "units.accountId": ids[6] },
    { $set: { "units.$.orderId": "g2g-order-9" } },
  );
  await loop.retireUnits(await getOffer(offerId), snap, [ids[6]], "test", {
    now: at(20),
  });
  assert.ok(
    unitIds(await getRow(rowId)).includes(ids[6]),
    "an in-flight unit is never pulled",
  );
  await pass(at(30));
  offer = await getOffer(offerId);
  assert.equal(entryOf(offer, ids[6]).state, "delivered");
  assert.equal(entryOf(offer, ids[6]).orderId, "g2g-order-9");
  assert.deepEqual(fx.calls.release, []);

  // And retireUnits skips a unit the caller's own row already shows as sold.
  const before = entryOf(await getOffer(offerId), ids[5]);
  await MarketplaceListing.updateOne(
    { _id: rowId, "units.accountId": ids[5] },
    { $set: { "units.$.deliveredAt": at(31), "units.$.orderId": "o-5" } },
  );
  assert.equal(
    await loop.retireUnits(
      await getOffer(offerId),
      await getRow(rowId),
      [ids[5]],
      "x",
    ),
    0,
  );
  assert.equal(entryOf(await getOffer(offerId), ids[5]).state, before.state);
});

test("reconcileUnits reports its counts", async () => {
  const { offerId, rowId, ids } = await dropsetOffer({ n: 6 });
  await MarketplaceListing.updateOne(
    { _id: rowId },
    { $pull: { units: { accountId: ids[5] } } },
  );
  await MarketplaceListing.updateOne(
    { _id: rowId, "units.accountId": ids[0] },
    { $set: { "units.$.deliveredAt": at(1), "units.$.orderId": "o-0" } },
  );
  const r = await loop.reconcileUnits(
    await getOffer(offerId),
    await getRow(rowId),
    at(2),
  );
  assert.deepEqual(
    { ...r },
    { delivered: 1, released: 0, readded: 1, repulled: 0 },
  );
  // With no row at all, nothing can sell: released at once (after isStillOurs, inside releaseUnits).
  const r2 = await loop.reconcileUnits(await getOffer(offerId), null, at(3));
  assert.equal(r2.released, 5);
  assert.equal(fx.calls.release.length, 5);
  assert.ok(
    !fx.calls.release.includes(ids[0]),
    "the delivered unit is not released",
  );
});

test("release guards: another bulk offer's account, a failed release, a missing DropSet", async () => {
  const a = await dropsetOffer({ n: 8 });
  const b = await dropsetOffer({ n: 8 });
  // Corrupt on purpose: B holds one of A's accounts on sale.
  const shared = a.ids[7];
  await BulkOffer.updateOne(
    { _id: b.offerId },
    {
      $push: {
        reserved: {
          accountId: shared,
          login: "login_" + shared,
          state: "on_offer",
          at: T0,
        },
      },
    },
  );
  await loop.retireUnits(
    await getOffer(a.offerId),
    await getRow(a.rowId),
    [shared, a.ids[6]],
    "withdraw",
    {
      now: at(0),
    },
  );
  fx.releaseThrows = 1; // the first release attempt (a.ids[6]) fails
  const s = await pass(at(15)); // RETIRE_GRACE_MS (FIXES-1 L2)
  assert.ok(
    !fx.calls.release.includes(shared),
    "never releases an account another offer holds",
  );
  let offer = await getOffer(a.offerId);
  assert.equal(entryOf(offer, shared).state, "released");
  assert.match(entryOf(offer, shared).reason, /^not released: bulk offer/);
  assert.equal(
    entryOf(offer, a.ids[6]).state,
    "retiring",
    "a failed release goes back to retiring",
  );
  assert.match(entryOf(offer, a.ids[6]).reason, /^release failed/);
  assert.equal(s.errors, 1);
  assert.match(offer.lastError, /^Loop: release of .* failed/);

  await pass(at(16)); // the clock restarted at the failure
  assert.ok(!fx.calls.release.includes(a.ids[6]));
  await pass(at(30));
  assert.deepEqual(fx.calls.release, [a.ids[6]]);
  offer = await getOffer(a.offerId);
  assert.equal(entryOf(offer, a.ids[6]).state, "released");
  assert.equal(offer.lastError, "");

  // No DropSet, no release: the unit stays retiring and the pass reports it.
  await loop.retireUnits(
    await getOffer(b.offerId),
    await getRow(b.rowId),
    [b.ids[0]],
    "withdraw",
    {
      now: at(40),
    },
  );
  await DropSet.deleteOne({ _id: b.set._id });
  const s2 = await pass(at(55));
  assert.equal(s2.errors, 1);
  assert.equal(entryOf(await getOffer(b.offerId), b.ids[0]).state, "retiring");
  assert.ok(!fx.calls.release.includes(b.ids[0]));
});

test("a FREE copy of a unit that already sold is pulled off the row", async () => {
  const { offerId, rowId, ids } = await dropsetOffer({ n: 6 });
  await MarketplaceListing.updateOne(
    { _id: rowId, "units.accountId": ids[0] },
    { $set: { "units.$.deliveredAt": at(1), "units.$.orderId": "o-0" } },
  );
  await MarketplaceListing.updateOne(
    { _id: rowId },
    {
      $push: {
        units: { accountId: ids[0], login: "login_" + ids[0], addedAt: at(1) },
      },
    },
  );
  await pass(at(2));
  const copies = (await getRow(rowId)).units.filter(
    (u) => u.accountId === ids[0],
  );
  assert.equal(copies.length, 1);
  assert.equal(copies[0].orderId, "o-0");
  assert.equal(entryOf(await getOffer(offerId), ids[0]).state, "delivered");
});

// ---------------------------------------------------------------------------
// Dropset eldorado / g2g
// ---------------------------------------------------------------------------

test("PACKS-2 §4 sold out: a pack sells, the leftovers are fewer than one pack — paused first, retired, released 15 minutes later", async () => {
  // 7 accounts = 1 pack of 5 on sale + 2 extra accounts on the row.
  const { offerId, rowId, ids, externalId } = await dropsetOffer({
    n: 7,
    minQty: 5,
    unitPrice: 1.43,
    packPrice: 7.13,
  });
  assert.equal((await getOffer(offerId)).advertisedQty, 1);
  // One order buys ONE unit = one pack: Eldorado's fulfiller hands over five
  // accounts (deliveredAt + orderId stamped together).
  const pack = ids.slice(0, 5);
  await MarketplaceListing.updateOne(
    { _id: rowId },
    {
      $set: {
        "units.$[u].deliveredAt": at(1),
        "units.$[u].orderId": "order-A",
      },
    },
    { arrayFilters: [{ "u.accountId": { $in: pack } }] },
  );
  const lines = [];
  const s = await pass(at(2), lines);
  assert.deepEqual(fx.calls.pause, [["eldorado", externalId]]);
  assert.deepEqual(fx.calls.setQuantity, [], "paused, never re-quantified");
  let offer = await getOffer(offerId);
  let row = await getRow(rowId);
  assert.equal(offer.state, "sold_out");
  assert.equal(offer.open, false);
  assert.ok(offer.closedAt);
  assert.equal(offer.advertisedQty, 0);
  for (const id of pack) assert.equal(entryOf(offer, id).state, "delivered");
  // The two leftovers can never make a pack: they go back (two-phase).
  for (const id of ids.slice(5)) {
    const e = entryOf(offer, id);
    assert.equal(e.state, "retiring");
    assert.equal(e.reason, "sold out: 2 free < one pack of 5");
  }
  assert.deepEqual(
    unitIds(row).sort(),
    pack.slice().sort(),
    "only the sold units stay",
  );
  assert.equal(row.status, "delisted");
  assert.equal(offer.ordersCount, 1);
  assert.equal(offer.unitsDelivered, 5);
  assert.equal(offer.revenueUsd, 7.13, "one pack at the pack price");
  assert.equal(tg(/^Bulk offer sold out/).length, 1);
  assert.match(
    tg(/^Bulk offer sold out/)[0],
    /2 account\(s\) left — less than one pack of 5/,
  );
  const sale = tg(/^Bulk sale/);
  assert.equal(sale.length, 1);
  assert.match(sale[0], /\$7\.13 per pack of 5 \(≈ \$1\.43 each\)/);
  assert.match(
    sale[0],
    /\+1 order\(s\), \+5 account\(s\) \(\+1 pack\(s\) of 5\)/,
  );
  assert.equal(s.sold, 1);
  assert.equal(s.retiring, 2);
  assert.equal(s.open, 0);
  assert.equal(
    lines[0],
    "bulkPacks: pass — open 0 (acct 0, farm 0) | sold +1 | paused 0 | retiring 2 | released 0 | busy 0 | errors 0",
  );
  assert.ok(fx.calls.invalidate >= 1, "proposals are told the slot freed up");

  await pass(at(16));
  assert.deepEqual(fx.calls.release, []);
  const s3 = await pass(at(17)); // RETIRE_GRACE_MS (FIXES-1 L2)
  assert.deepEqual(fx.calls.release.sort(), ids.slice(5).sort());
  assert.equal(s3.released, 2);
  offer = await getOffer(offerId);
  for (const id of pack) assert.equal(entryOf(offer, id).state, "delivered");
  for (const id of ids.slice(5))
    assert.equal(entryOf(offer, id).state, "released");

  // Nothing left retiring: later passes (inside the 24-hour watch window of
  // FIXES-1 L2) release nothing more and alert nothing more.
  const calls = fx.calls.release.length;
  await pass(at(40));
  assert.equal(fx.calls.release.length, calls);
  assert.equal(
    tg(/^Bulk offer sold out/).length,
    1,
    "alerts fire on state changes only",
  );
  row = await getRow(rowId);
  assert.equal(row.units.length, 5);
});

test("PACKS-2 §4 a pass with at least one whole pack left keeps the extra accounts on the row — only fewer than N is sold out", async () => {
  // 12 accounts = 2 packs + 2 extra; a pack sells -> 7 = 1 pack + 2 extra.
  const { offerId, rowId, ids, externalId } = await dropsetOffer({
    n: 12,
    minQty: 5,
    packPrice: 7.13,
  });
  await MarketplaceListing.updateOne(
    { _id: rowId },
    {
      $set: {
        "units.$[u].deliveredAt": at(1),
        "units.$[u].orderId": "order-B",
      },
    },
    { arrayFilters: [{ "u.accountId": { $in: ids.slice(0, 5) } }] },
  );
  await pass(at(2));
  const offer = await getOffer(offerId);
  assert.equal(offer.state, "live");
  assert.deepEqual(fx.calls.pause, []);
  assert.deepEqual(fx.calls.setQuantity, [["eldorado", externalId, 1]]);
  assert.equal(offer.advertisedQty, 1);
  assert.equal(offer.revenueUsd, 7.13);
  for (const id of ids.slice(5))
    assert.equal(entryOf(offer, id).state, "on_offer", "all 7 stay on sale");
  assert.equal((await getRow(rowId)).units.length, 12);
  assert.deepEqual(fx.calls.release, []);
});

test("sold out with a failed pause retires nothing and retries next pass", async () => {
  const { offerId, rowId, ids } = await dropsetOffer({ n: 4, minQty: 5 });
  fx.failPause = true;
  const s = await pass(at(1));
  assert.equal(s.errors, 1);
  let offer = await getOffer(offerId);
  assert.equal(offer.state, "live");
  assert.match(offer.lastError, /^Loop: .*pause refused/);
  assert.equal(offer.reserved.filter((e) => e.state === "on_offer").length, 4);
  assert.equal((await getRow(rowId)).units.length, 4);
  assert.equal(tg(/sold out/).length, 0);

  fx.failPause = false;
  await pass(at(6));
  offer = await getOffer(offerId);
  assert.equal(offer.state, "sold_out");
  assert.equal(
    offer.lastError,
    "",
    "the loop clears its own error on a clean pass",
  );
  for (const id of ids) assert.equal(entryOf(offer, id).state, "retiring");
});

test("an unhealthy unit is retired after the advertised packs have been lowered", async () => {
  // 10 accounts = 2 packs of 5; one fails its health check -> 9 = 1 pack.
  const { offerId, rowId, ids, externalId } = await dropsetOffer({ n: 10 });
  assert.equal((await getOffer(offerId)).advertisedQty, 2);
  fx.bad.set(ids[3], "no password");
  let unitsAtQuantityCall = null;
  fx.onSetQuantity = async () => {
    unitsAtQuantityCall = unitIds(await getRow(rowId));
  };
  await pass(at(1));
  assert.deepEqual(fx.calls.setQuantity, [["eldorado", externalId, 1]]);
  assert.ok(
    unitsAtQuantityCall.includes(ids[3]),
    "the quantity dropped before the unit left the row",
  );
  assert.ok(!unitIds(await getRow(rowId)).includes(ids[3]));
  const offer = await getOffer(offerId);
  assert.equal(entryOf(offer, ids[3]).state, "retiring");
  assert.match(entryOf(offer, ids[3]).reason, /health: no password/);
  assert.equal(offer.advertisedQty, 1);
  assert.equal(offer.state, "live");
  assert.equal(tg(/^Bulk offer integrity/).length, 1);
  assert.match(
    tg(/^Bulk offer integrity/)[0],
    /1 account\(s\) taken off the offer: login_\S+ \(no password\)\. 9 still on sale \(1 pack\(s\) of 5\)/,
  );
  await pass(at(2));
  assert.equal(tg(/^Bulk offer integrity/).length, 1);
});

test("PACKS-2 §4 the market is offered the whole PACKS the free accounts make: shrinking always, growing only when switched on with the gate open", async () => {
  // 6 free = 1 pack (advertised 3): shrinks to 1. 14 free = 2 packs + 4
  // extra accounts (advertised 1): grows to 2 — the 4 extra stay on the row.
  const shrink = await dropsetOffer({ n: 6, advertisedQty: 3 });
  const grow = await dropsetOffer({ n: 14, advertisedQty: 1 });
  fx.bp = bp({ enabled: false });
  await pass(at(1));
  assert.deepEqual(
    fx.calls.setQuantity,
    [["eldorado", shrink.externalId, 1]],
    "no growth while switched off",
  );
  assert.equal((await getOffer(shrink.offerId)).advertisedQty, 1);
  assert.equal((await getOffer(grow.offerId)).advertisedQty, 1);

  fx.bp = bp({ enabled: true });
  fx.gate = { ok: false, reason: "Eldorado delivery is in dry-run" };
  await pass(at(2));
  assert.equal(
    fx.calls.setQuantity.length,
    1,
    "no growth with the delivery gate shut",
  );

  fx.gate = { ok: true, reason: "" };
  await pass(at(3));
  assert.deepEqual(fx.calls.setQuantity[1], ["eldorado", grow.externalId, 2]);
  const g = await getOffer(grow.offerId);
  assert.equal(g.advertisedQty, 2);
  assert.equal(g.state, "live");
  assert.ok(
    g.reserved.every((e) => e.state === "on_offer"),
    "a partial pack is not a sold-out offer: nothing retired",
  );
  assert.equal((await getRow(grow.rowId)).units.length, 14);
  await pass(at(4));
  assert.equal(fx.calls.setQuantity.length, 2, "no call once it matches");
  assert.deepEqual(fx.calls.pause, []);
  assert.deepEqual(fx.calls.release, []);
});

test("PACKS-2 §1 the pack size is the row's bulkPackSize and the offer's minQty — the LARGER when they disagree, minQty when the row has none", async () => {
  // A row sized 10 under a 5+ offer: the fulfiller hands over 10 per unit, so
  // 14 free accounts are ONE pack, never two.
  const big = await dropsetOffer({ n: 14, advertisedQty: 1, bulkPackSize: 10 });
  // A row with no size recorded (0): the offer's own pack of 5 still rules.
  const none = await dropsetOffer({ n: 14, advertisedQty: 1, bulkPackSize: 0 });
  await pass(at(1));
  assert.deepEqual(fx.calls.setQuantity, [["eldorado", none.externalId, 2]]);
  assert.equal((await getOffer(big.offerId)).advertisedQty, 1);
  assert.equal((await getOffer(none.offerId)).advertisedQty, 2);

  // 9 free accounts cannot fill the row's pack of 10: sold out, all retired.
  await MarketplaceListing.updateOne(
    { _id: big.rowId },
    {
      $set: {
        "units.$[u].deliveredAt": at(2),
        "units.$[u].orderId": "order-big",
      },
    },
    { arrayFilters: [{ "u.accountId": { $in: big.ids.slice(0, 5) } }] },
  );
  await pass(at(3));
  const o = await getOffer(big.offerId);
  assert.equal(o.state, "sold_out");
  for (const id of big.ids.slice(5)) {
    assert.equal(entryOf(o, id).state, "retiring");
    assert.equal(entryOf(o, id).reason, "sold out: 9 free < one pack of 10");
  }
});

test("switched off: sold-out, expiry and releases still run (I8)", async () => {
  fx.bp = bp({ enabled: false });
  const { offerId, ids } = await dropsetOffer({ n: 3, minQty: 5 });
  await pass(at(1));
  assert.equal((await getOffer(offerId)).state, "sold_out");
  await pass(at(16));
  assert.deepEqual(fx.calls.release.sort(), ids.slice().sort());
});

test("an expired offer (read every 30 minutes) removes the row and retires its units", async () => {
  const { offerId, rowId, ids, externalId } = await dropsetOffer({ n: 6 });
  await pass(at(0));
  assert.deepEqual(fx.calls.readOffer, [["eldorado", externalId]]);
  await pass(at(10));
  assert.equal(fx.calls.readOffer.length, 1, "not due yet");

  // "gone" is flagged for the owner, never acted on.
  fx.readState = "gone";
  await pass(at(31));
  assert.equal(fx.calls.readOffer.length, 2);
  let offer = await getOffer(offerId);
  assert.equal(offer.state, "live");
  assert.match(offer.attention, /^Needs attention \(gone\)/); // FIXES-1 L8
  assert.equal(tg(/needs attention/).length, 1);
  await pass(at(62));
  assert.equal(tg(/needs attention/).length, 1, "flagged once");

  fx.readState = "expired";
  await pass(at(93));
  offer = await getOffer(offerId);
  const row = await getRow(rowId);
  assert.equal(offer.state, "expired");
  assert.equal(offer.open, false);
  assert.equal(row.status, "removed");
  assert.equal(row.units.length, 0);
  for (const id of ids) assert.equal(entryOf(offer, id).state, "retiring");
  assert.equal(tg(/^Bulk offer expired/).length, 1);
  await pass(at(108));
  assert.equal(fx.calls.release.length, 6);
});

test("the row going inactive closes the offer, pausing it first unless the row says it is gone", async () => {
  const delisted = await dropsetOffer({ n: 6, market: "g2g" });
  const removed = await dropsetOffer({ n: 6 });
  await MarketplaceListing.updateOne(
    { _id: delisted.rowId },
    { $set: { status: "delisted" } },
  );
  await MarketplaceListing.updateOne(
    { _id: removed.rowId },
    { $set: { status: "removed" } },
  );
  await pass(at(1));
  assert.deepEqual(fx.calls.pause, [["g2g", delisted.externalId]]);
  const a = await getOffer(delisted.offerId);
  const b = await getOffer(removed.offerId);
  assert.equal(a.state, "withdrawn");
  assert.equal(b.state, "expired");
  assert.ok(a.reserved.every((e) => e.state === "retiring"));
  assert.ok(b.reserved.every((e) => e.state === "retiring"));
  assert.equal((await getRow(delisted.rowId)).units.length, 0);
});

test("a missing listing row: units are released at once and the offer is taken down", async () => {
  const { offerId, rowId, ids, externalId } = await dropsetOffer({ n: 6 });
  await MarketplaceListing.deleteOne({ _id: rowId });
  await pass(at(1));
  assert.deepEqual(
    fx.calls.release.sort(),
    ids.slice().sort(),
    "no 2-minute wait without a row",
  );
  assert.deepEqual(fx.calls.pause, [["eldorado", externalId]]);
  const offer = await getOffer(offerId);
  assert.equal(offer.state, "error");
  assert.equal(offer.open, false);
  assert.ok(offer.reserved.every((e) => e.state === "released"));
  assert.equal(tg(/^Bulk offer orphaned/).length, 1);
});

test("a row that does not point back at the offer is never written; a lost pointer is re-linked", async () => {
  const a = await dropsetOffer({ n: 6 });
  await MarketplaceListing.updateOne(
    { _id: a.rowId },
    { $set: { bulkOfferId: new mongoose.Types.ObjectId() } },
  );
  await MarketplaceListing.updateOne(
    { _id: a.rowId },
    { $pull: { units: { accountId: a.ids[5] } } },
  );
  const b = await dropsetOffer({ n: 6 });
  await BulkOffer.updateOne({ _id: b.offerId }, { $set: { listing: null } });

  await pass(at(1));
  const rowA = await getRow(a.rowId);
  assert.equal(rowA.units.length, 5, "a row that is not ours is never healed");
  const offerA = await getOffer(a.offerId);
  assert.match(offerA.attention, /^Needs attention \(row\)/); // FIXES-1 L8
  assert.ok(
    offerA.reserved.every((e) => e.state === "on_offer"),
    "and nothing is released",
  );
  assert.deepEqual(fx.calls.release, []);
  assert.equal(tg(/needs attention/).length, 1);
  assert.equal(
    String((await getOffer(b.offerId)).listing),
    String(b.rowId),
    "re-linked by bulkOfferId",
  );
  assert.equal((await getOffer(b.offerId)).state, "live");
});

test("a sending offer is never touched; a stuck one is reported once", async () => {
  const set = await DropSet.create({
    name: "Rust",
    items: [{ itemKey: "k", name: "Item" }],
  });
  const offer = await BulkOffer.create({
    kind: "accounts",
    source: "dropset",
    market: "eldorado",
    set: set._id,
    minQty: 5,
    title: "Rust — BULK 5+ accounts",
    state: "sending",
    slotKey: "accounts|dropset|" + set._id + "|eldorado|5",
    reserved: ["x1", "x2", "x3", "x4", "x5"].map((id) => ({
      accountId: id,
      login: id,
      state: "on_offer",
    })),
  });
  const born = new Date(offer.createdAt).getTime();
  const s = await pass(new Date(born + 60000));
  assert.equal(s.open, 1);
  assert.equal(s.accounts, 1);
  assert.deepEqual(fx.calls.release, []);
  assert.deepEqual(fx.calls.pause, []);
  assert.equal(fx.calls.telegram.length, 0);

  await pass(new Date(born + 20 * 60000));
  assert.equal(tg(/stuck in "sending"/).length, 1);
  await pass(new Date(born + 25 * 60000));
  assert.equal(tg(/stuck in "sending"/).length, 1);
  const after = await getOffer(offer._id);
  assert.equal(after.state, "sending");
  assert.ok(after.reserved.every((e) => e.state === "on_offer"));
  assert.deepEqual(fx.calls.release, []);
});

// ---------------------------------------------------------------------------
// Dropset gameflip (I9)
// ---------------------------------------------------------------------------

test("gameflip: a sold pack is finalised and its accounts are never released", async () => {
  const { offerId, rowId, ids, externalId } = await dropsetOffer({
    market: "gameflip",
    n: 5,
    minQty: 5,
    packPrice: 6.5,
    unitPrice: 0,
  });
  await MarketplaceListing.updateOne(
    { _id: rowId },
    { $set: { status: "sold" } },
  ); // gameflipFulfiller.syncOnce
  const s = await pass(at(1));
  const offer = await getOffer(offerId);
  assert.equal(offer.state, "sold");
  assert.equal(offer.open, false);
  for (const id of ids) {
    assert.equal(entryOf(offer, id).state, "delivered");
    assert.equal(entryOf(offer, id).orderId, "gf:" + externalId);
  }
  assert.equal(offer.ordersCount, 1);
  assert.equal(offer.unitsDelivered, 5);
  assert.equal(offer.revenueUsd, 6.5);
  assert.equal(s.sold, 1);
  assert.equal(tg(/^Bulk pack sold/).length, 1);
  assert.equal(tg(/^Bulk sale/).length, 0, "one message per pack sale");
  assert.deepEqual(
    fx.calls.readOffer,
    [],
    "the Gameflip sync owns the row status",
  );
  await pass(at(10));
  assert.deepEqual(fx.calls.release, []);
  assert.equal(fx.calls.telegram.length, 1);
});

test("gameflip: a removed pack expires, a delisted one is withdrawn; both release after 15 minutes", async () => {
  const removed = await dropsetOffer({
    market: "gameflip",
    n: 5,
    packPrice: 6.5,
  });
  const delisted = await dropsetOffer({
    market: "gameflip",
    n: 5,
    packPrice: 6.5,
  });
  await MarketplaceListing.updateOne(
    { _id: removed.rowId },
    { $set: { status: "removed" } },
  );
  await MarketplaceListing.updateOne(
    { _id: delisted.rowId },
    { $set: { status: "delisted" } },
  );
  await pass(at(1));
  assert.equal((await getOffer(removed.offerId)).state, "expired");
  assert.equal((await getOffer(delisted.offerId)).state, "withdrawn");
  assert.deepEqual(
    fx.calls.withdraw,
    [],
    "the row already says the listing is dead",
  );
  assert.deepEqual(fx.calls.pause, []);
  await pass(at(15));
  assert.deepEqual(fx.calls.release, []);
  await pass(at(16)); // RETIRE_GRACE_MS (FIXES-1 L2)
  assert.deepEqual(
    fx.calls.release.sort(),
    [...removed.ids, ...delisted.ids].sort(),
  );
});

test("gameflip: an unhealthy account withdraws the pack; a failed withdraw leaves it alone", async () => {
  const { offerId, rowId, ids, externalId } = await dropsetOffer({
    market: "gameflip",
    n: 5,
    packPrice: 6.5,
  });
  fx.bad.set(ids[2], "suspended");
  fx.failWithdraw = true;
  await pass(at(1));
  assert.deepEqual(fx.calls.withdraw, [["gameflip", externalId]]);
  let offer = await getOffer(offerId);
  assert.equal(offer.state, "live");
  assert.ok(
    offer.reserved.every((e) => e.state === "on_offer"),
    "it may have sold: nothing retired",
  );
  assert.equal((await getRow(rowId)).status, "active");
  assert.equal(tg(/needs attention/).length, 1);
  await pass(at(6));
  assert.equal(fx.calls.withdraw.length, 2, "retried");
  assert.equal(tg(/needs attention/).length, 1, "flagged once");

  fx.failWithdraw = false;
  await pass(at(11));
  offer = await getOffer(offerId);
  assert.equal(offer.state, "withdrawn");
  assert.equal((await getRow(rowId)).status, "delisted");
  assert.ok(offer.reserved.every((e) => e.state === "retiring"));
  assert.equal(tg(/^Bulk pack withdrawn \(integrity\)/).length, 1);
  await pass(at(26));
  assert.equal(fx.calls.release.length, 5);
});

test("gameflip: with no row the pack is withdrawn BEFORE anything is released", async () => {
  const { offerId, rowId, ids } = await dropsetOffer({
    market: "gameflip",
    n: 5,
    packPrice: 6.5,
  });
  await MarketplaceListing.deleteOne({ _id: rowId });
  fx.failWithdraw = true;
  await pass(at(1));
  assert.deepEqual(fx.calls.release, [], "a failed withdraw releases nothing");
  assert.equal((await getOffer(offerId)).state, "live");
  fx.failWithdraw = false;
  await pass(at(2));
  assert.deepEqual(fx.calls.release.sort(), ids.slice().sort());
  assert.equal((await getOffer(offerId)).state, "error");
});

// ---------------------------------------------------------------------------
// No-claim
// ---------------------------------------------------------------------------

test("noclaim: counters from delivery records, low stock is display only, a dead row closes it", async () => {
  const { offerId, rowId } = await noclaimOffer({
    minQty: 5,
    units: [
      { contentId: "l1", login: "a", deliveredAt: at(1), orderId: "o1" },
      { contentId: "l2", login: "b", deliveredAt: at(1), orderId: "o1" },
      { contentId: "l3", login: "c", orderId: "o2" }, // claimed for an order, hand-over pending
    ],
  });
  fx.share = 3;
  await pass(at(2));
  let offer = await getOffer(offerId);
  assert.equal(offer.unitsDelivered, 3);
  assert.equal(offer.ordersCount, 2);
  assert.equal(offer.revenueUsd, 6);
  assert.equal(offer.lowStock, true);
  assert.deepEqual(fx.calls.pause, [], "low stock never acts");
  assert.deepEqual(fx.calls.setQuantity, []);
  assert.equal(tg(/^Bulk sale/).length, 1);

  fx.share = 9;
  await pass(at(3));
  assert.equal((await getOffer(offerId)).lowStock, false);

  await MarketplaceListing.updateOne(
    { _id: rowId },
    { $set: { status: "delisted" } },
  );
  await pass(at(4));
  offer = await getOffer(offerId);
  assert.equal(offer.state, "withdrawn");
  assert.equal(offer.open, false);
  assert.deepEqual(fx.calls.pause, []);
  assert.deepEqual(fx.calls.release, []);
});

test("PACKS-2 §4 noclaim: low stock = the shelf share cannot fill ONE pack; sales are revenue per pack", async () => {
  // Packs of 10: one order bought one pack, ten accounts handed over.
  const units = Array.from({ length: 10 }, (_, i) => ({
    contentId: "c" + i,
    login: "nc" + i,
    deliveredAt: at(1),
    orderId: "o-pack",
  }));
  const { offerId } = await noclaimOffer({
    minQty: 10,
    packPrice: 17.1,
    units,
  });
  fx.share = 9; // nine accounts: not one pack of 10
  await pass(at(2));
  let offer = await getOffer(offerId);
  assert.equal(offer.lowStock, true);
  assert.equal(offer.ordersCount, 1);
  assert.equal(offer.unitsDelivered, 10);
  assert.equal(offer.revenueUsd, 17.1, "one pack at the pack price");
  assert.match(tg(/^Bulk sale/)[0], /\(\+1 pack\(s\) of 10\)/);
  fx.share = 10; // exactly one pack
  await pass(at(3));
  assert.equal((await getOffer(offerId)).lowStock, false);
  fx.share = 19;
  await pass(at(4));
  assert.equal((await getOffer(offerId)).lowStock, false);
  assert.deepEqual(fx.calls.pause, [], "display only — never acts");
  assert.deepEqual(fx.calls.setQuantity, []);

  // A row sized larger than the offer's minQty is read by its larger pack.
  const odd = await noclaimOffer({ minQty: 5, bulkPackSize: 10 });
  fx.share = 9;
  await pass(at(5));
  assert.equal((await getOffer(odd.offerId)).lowStock, true);
  offer = await getOffer(offerId);
  assert.equal(offer.lowStock, true, "the first offer reads the same share");
});

// ---------------------------------------------------------------------------
// Farm
// ---------------------------------------------------------------------------

test("PACKS-2 §4 farm: its capacity share (accounts) is advertised as whole packs; less than one pack pauses it, and it resumes only when switched on", async () => {
  const { offerId, externalId } = await farmOffer({
    minQty: 5,
    advertisedQty: 2,
  });
  fx.advertisable = 4; // 4 accounts: not one pack of 5
  await pass(at(0));
  assert.deepEqual(fx.calls.pause, [["eldorado", externalId]]);
  let offer = await getOffer(offerId);
  assert.equal(offer.state, "paused");
  assert.equal(offer.autoPaused, true);
  assert.equal(tg(/^Bulk farming offer paused/).length, 1);
  assert.match(
    tg(/^Bulk farming offer paused/)[0],
    /capacity for 4 account\(s\) = 0 pack\(s\) of 5 .* — less than one pack of 5/,
  );

  fx.advertisable = 12;
  fx.bp = bp({ enabled: false });
  await pass(at(20));
  assert.deepEqual(
    fx.calls.resume,
    [],
    "never resumed while bulk packs are off (I8)",
  );
  assert.equal((await getOffer(offerId)).state, "paused");

  fx.bp = bp({ enabled: true });
  const reads = fx.calls.capRead;
  await pass(at(25));
  assert.equal(
    fx.calls.capRead,
    reads,
    "capacity is read every farmSyncMinutes, not every pass",
  );
  assert.deepEqual(fx.calls.resume, []);

  // 12 accounts = 2 packs of 5 (the 2 extra are never advertised). The offer
  // was left at 3 packs, so its quantity comes down to 2 BEFORE it resumes.
  await BulkOffer.updateOne({ _id: offerId }, { $set: { advertisedQty: 3 } });
  await pass(at(36));
  assert.deepEqual(
    fx.calls.setQuantity,
    [["eldorado", externalId, 2]],
    "quantity set before resuming",
  );
  assert.deepEqual(fx.calls.resume, [["eldorado", externalId]]);
  offer = await getOffer(offerId);
  assert.equal(offer.state, "live");
  assert.equal(offer.autoPaused, false);
  assert.equal(offer.advertisedQty, 2);
  assert.equal(tg(/^Bulk farming offer resumed/).length, 1);
  assert.match(
    tg(/^Bulk farming offer resumed/)[0],
    /capacity for 12 account\(s\) = 2 pack\(s\) of 5/,
  );
  assert.equal(tg(/^Bulk farming offer paused/).length, 1);

  // Live and capacity moves: the packs follow (shrinking needs no switch).
  fx.advertisable = 9; // one pack of 5
  await pass(at(52));
  assert.deepEqual(fx.calls.setQuantity[1], ["eldorado", externalId, 1]);
  assert.equal((await getOffer(offerId)).advertisedQty, 1);
  // Exactly one pack's worth is still one pack: live, nothing paused.
  fx.advertisable = 5;
  await pass(at(68));
  assert.equal((await getOffer(offerId)).state, "live");
  assert.equal(fx.calls.pause.length, 1);
  assert.equal(fx.calls.setQuantity.length, 2);
});

test("PACKS-2 §4 farm: a pack size of 10 needs ten accounts of capacity per unit it advertises", async () => {
  const { offerId, externalId } = await farmOffer({
    minQty: 10,
    advertisedQty: 2,
  });
  fx.advertisable = 19; // one pack of 10, never "19 units"
  await pass(at(0));
  assert.deepEqual(fx.calls.setQuantity, [["eldorado", externalId, 1]]);
  fx.advertisable = 9;
  await pass(at(16));
  assert.deepEqual(fx.calls.pause, [["eldorado", externalId]]);
  assert.equal((await getOffer(offerId)).state, "paused");
});

test("farm: an owner-paused offer is never resumed, nor one whose delivery gate is shut", async () => {
  const manual = await farmOffer({ state: "paused", autoPaused: false });
  const gated = await farmOffer({
    state: "paused",
    autoPaused: true,
    market: "g2g",
  });
  fx.advertisable = 15;
  fx.gate = { ok: false, reason: "G2G delivery is in dry-run" };
  await pass(at(0));
  assert.deepEqual(fx.calls.resume, []);
  assert.equal((await getOffer(manual.offerId)).state, "paused");
  assert.equal((await getOffer(gated.offerId)).state, "paused");
  fx.gate = { ok: true, reason: "" };
  await pass(at(16));
  assert.deepEqual(fx.calls.resume, [["g2g", gated.externalId]]);
  assert.equal((await getOffer(manual.offerId)).state, "paused");
});

test("farm: sales come from FarmServiceOrder by the offer id the farm services record", async () => {
  const { offerId, externalId, title } = await farmOffer({
    unitPrice: 3.8,
    advertisedQty: 10,
  });
  const order = (o) =>
    FarmServiceOrder.create({
      market: "eldorado",
      game: "Rust",
      days: 180,
      ...o,
    });
  await order({
    orderId: "o1",
    offerId: externalId,
    offerTitle: title,
    quantity: 5,
    state: "delivered",
  });
  await order({
    orderId: "o2",
    offerId: externalId,
    quantity: 6,
    state: "cancelled",
  });
  await order({
    orderId: "g2g:o3",
    market: "g2g",
    offerId: externalId,
    quantity: 5,
    state: "delivered",
  });
  await order({
    orderId: "o4",
    offerId: "someone-else",
    offerTitle: title,
    quantity: 5,
  });
  await pass(at(0));
  let offer = await getOffer(offerId);
  assert.equal(offer.ordersCount, 1);
  assert.equal(offer.unitsDelivered, 5);
  assert.equal(offer.revenueUsd, 19);
  assert.equal(tg(/^Bulk sale/).length, 1);

  // An order whose offer id was never recorded falls back to title + market.
  await order({
    orderId: "o5",
    offerId: "",
    offerTitle: title,
    quantity: 5,
    state: "claimed",
  });
  await pass(at(5));
  offer = await getOffer(offerId);
  assert.equal(offer.ordersCount, 2);
  assert.equal(offer.unitsDelivered, 10);
  assert.equal(tg(/^Bulk sale/).length, 2);
  await pass(at(10));
  assert.equal(tg(/^Bulk sale/).length, 2, "no repeat");
});

test("PACKS-2 §2/§3 farm: sales are counted in accounts and packs, revenue per pack — whether an order row records its accounts or its units", async () => {
  const { offerId, externalId } = await farmOffer({
    minQty: 5,
    unitPrice: 3.8,
    packPrice: 19,
  });
  const order = (o) =>
    FarmServiceOrder.create({
      market: "eldorado",
      game: "Rust",
      days: 180,
      offerId: externalId,
      state: "delivered",
      ...o,
    });
  // Two packs bought: the farm service provisions 2 × 5 = 10 accounts.
  await order({ orderId: "p1", quantity: 10 });
  // One pack whose row records the units bought (1) — counted by the five
  // accounts it lists once provisioned.
  await order({
    orderId: "p2",
    quantity: 1,
    accounts: Array.from({ length: 5 }, (_, i) => ({ login: "f" + i })),
  });
  await pass(at(0));
  const offer = await getOffer(offerId);
  assert.equal(offer.ordersCount, 2);
  assert.equal(offer.unitsDelivered, 15);
  assert.equal(offer.revenueUsd, 57, "3 packs × $19");
  const sale = tg(/^Bulk sale/);
  assert.equal(sale.length, 1);
  assert.match(sale[0], /\$19\.00 per pack of 5 \(≈ \$3\.80 each\)/);
  assert.match(sale[0], /\+15 account\(s\) \(\+3 pack\(s\) of 5\)/);
});

test("farm: expiry is read every 30 minutes", async () => {
  const { offerId } = await farmOffer({});
  fx.advertisable = 10;
  fx.readState = "expired";
  await pass(at(0));
  const offer = await getOffer(offerId);
  assert.equal(offer.state, "expired");
  assert.equal(offer.open, false);
  assert.equal(tg(/^Bulk farming offer expired/).length, 1);
});

// ---------------------------------------------------------------------------
// Scheduler, heartbeat, invariants
// ---------------------------------------------------------------------------

test("heartbeat: one line per pass, idle passes included", async () => {
  const lines = [];
  const before = loop.status().passes;
  const s = await pass(at(0), lines);
  assert.deepEqual(lines, [
    "bulkPacks: pass — open 0 (acct 0, farm 0) | sold +0 | paused 0 | retiring 0 | released 0 | busy 0 | errors 0",
  ]);
  assert.deepEqual(s, {
    open: 0,
    accounts: 0,
    farming: 0,
    sold: 0,
    paused: 0,
    retiring: 0,
    released: 0,
    busy: 0,
    errors: 0,
  });
  const st = loop.status();
  assert.equal(st.passes, before + 1);
  assert.equal(st.running, false);
  assert.ok(st.lastRunAt instanceof Date);
  assert.deepEqual(st.lastSummary, s);
  assert.equal(st.lastError, "");

  await dropsetOffer({ n: 6 });
  await farmOffer({ state: "paused", autoPaused: false });
  const more = [];
  await pass(at(1), more);
  assert.deepEqual(more, [
    "bulkPacks: pass — open 2 (acct 1, farm 1) | sold +0 | paused 1 | retiring 0 | released 0 | busy 0 | errors 0",
  ]);
});

test("start is idempotent and stop clears it", () => {
  assert.equal(loop.status().started, false);
  loop.start();
  loop.start();
  assert.equal(loop.status().started, true);
  loop.stop();
  assert.equal(loop.status().started, false);
});

test("the loop never whole-array saves a listing (I3)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../utils/bulkPacks/loop.js"),
    "utf8",
  );
  assert.ok(!/\.save\(/.test(src), "no document save");
  assert.ok(!/\$set\s*:\s*\{\s*units\b/.test(src), "no $set of units");
  assert.ok(
    !/releaseAccountsForTag/.test(src),
    "never the tag-wide release (I1)",
  );
  assert.ok(!/allowDiskUse/.test(src));
});
