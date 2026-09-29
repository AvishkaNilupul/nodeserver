// Bulk packs — the maintenance loop's races and the round-1 review fixes
// (docs/bulk-packs/FIXES-1.md L1–L4, L6–L8, S1 loop side, lock.js, and the
// coordinator's addendum: a CLOSED offer's on_offer entries are HELD).
//
// Part 4 pins the round-2 fixes (docs/bulk-packs/FIXES-2.md Y1: V1 loop side,
// V2, V3 loop side, V4) — each test failed on the round-1 loop.
//
// Part 1 ports the adversarial reviewer's repros F-A … F-D (scratchpad
// bulkLoopAdversarial.test.js) and asserts the FIXED outcome. Like the repros
// they run the REAL loop, stock, markets, reservation layer, Eldorado delivery
// path and listingDetach choke point over an in-memory Mongo; only the
// marketplace connector (utils/marketplaces.js), Telegram, the audit log and the
// settings source are faked. Offers are seeded exactly as send.sendOffer leaves
// them (claimAccountsForSet reservations, a live offer, its bulk row), so these
// tests do not lean on send.js.
//
// Part 2 pins each fix with fakes (the tests/bulkPacksLoop.test.js style).
// Part 3 tests utils/bulkPacks/lock.js.
//
// Nothing touches the network or utils/settings.json.
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.CRED_SECRET = "bulk-packs-integration-test-secret-0123456789";
process.env.TG_TOKEN = "";

// ---- fake marketplace connector, installed before anything requires it ----
const calls = [];
let seq = 0;
const knobs = { gfDelistFail: 0, eldSendGate: null };
const known = {
  G2G_MIN_PRICE: 1,
  G2G_ITEMS_SERVICE: "svc-items",
  delistOutcome: (m) =>
    /not.?found|404|must be active/i.test(String(m)) ? "gone" : "",
  async eldoradoSetQuantity(id, n) {
    calls.push(["eldoradoSetQuantity", id, n]);
  },
  async eldoradoDelist(id) {
    calls.push(["eldoradoDelist", id]);
  },
  async eldoradoRelist(id) {
    calls.push(["eldoradoRelist", id]);
  },
  async eldoradoOffer(id) {
    return { id, offerState: "Active", quantity: 10 };
  },
  async eldoradoOrderChatReady() {
    return true;
  },
  async eldoradoSendOrderMessage(order, msg) {
    calls.push(["eldoradoSendOrderMessage", order.id, msg]);
    if (knobs.eldSendGate) await knobs.eldSendGate; // a slow chat send
  },
  async eldoradoMarkDelivered(orderId) {
    calls.push(["eldoradoMarkDelivered", orderId]);
  },
  async gameflipDelist(id) {
    calls.push(["gameflipDelist", id]);
    if (knobs.gfDelistFail > 0) {
      knobs.gfDelistFail--;
      const e = new Error(
        "Gameflip delist: Request failed with status code 429",
      );
      e.status = 429;
      throw e;
    }
  },
};
const fakeMp = new Proxy(known, {
  get(t, k) {
    if (k in t) return t[k];
    if (typeof k === "string" && /^[a-z]/.test(k)) {
      return async (...args) => {
        calls.push(["?" + k, ...args]);
        return null;
      };
    }
    return undefined;
  },
});
const mpPath = require.resolve("../utils/marketplaces");
require.cache[mpPath] = {
  id: mpPath,
  filename: mpPath,
  loaded: true,
  exports: fakeMp,
};

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const realSettings = require("../utils/settings");
const { encrypt } = require("../utils/secretBox");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const BulkOffer = require("../models/BulkOffer");
const FarmServiceOrder = require("../models/FarmServiceOrder");
const config = require("../utils/bulkPacks/config");
const markets = require("../utils/bulkPacks/markets");
const loop = require("../utils/bulkPacks/loop");
const lock = require("../utils/bulkPacks/lock");
const dropReservation = require("../utils/dropReservation");
const { shareOfShelf } = require("../utils/suppliedStock");
const eldoradoFulfiller = require("../utils/eldoradoFulfiller");
const { detachAccountFromListing } = require("../utils/listingDetach");

const AF = {
  bulkPacksEnabled: true,
  bulkPacksMarkets: ["eldorado", "g2g", "gameflip"],
  bulkPackTiers: [
    { minQty: 5, discountPct: 5 },
    { minQty: 10, discountPct: 10 },
  ],
  bulkPackReserveSingles: 0,
  bulkPackUnitsPerOffer: 20,
  eldoradoAutoDeliver: true,
  eldoradoDeliverDryRun: false,
  g2gAutoDeliver: true,
  g2gDeliverDryRun: false,
  platiEnabled: false,
  ggselEnabled: false,
};
const fakeSettings = {
  ...realSettings,
  getAutoFarm: () => AF,
  getBulkPacks: (afIn) => realSettings.getBulkPacks(afIn || AF),
  getNoclaimShopSettings: () => ({ enabled: true, autoDeliver: true }),
};

let mongod;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("bulkPacksLoopRaces"));
  await Promise.all([
    BulkOffer.init(),
    MarketplaceListing.init(),
    DropLog.init(),
  ]);
  config.__setDeps({ settings: fakeSettings });
  markets.__setDeps({ settings: fakeSettings });
});
test.after(async () => {
  loop.stop();
  loop.__resetDeps();
  config.__resetDeps();
  markets.__resetDeps();
  lock.__reset();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

async function clean() {
  await Promise.all([
    BulkOffer.deleteMany({}),
    MarketplaceListing.deleteMany({}),
    DropSet.deleteMany({}),
    DropLog.deleteMany({}),
    BotAccount.deleteMany({}),
    FarmServiceOrder.deleteMany({}),
  ]);
  calls.length = 0;
  knobs.gfDelistFail = 0;
  knobs.eldSendGate = null;
  lock.__reset();
}

// Run a pass with the heartbeat line swallowed.
async function pass(now) {
  const orig = console.log;
  console.log = (...a) => {
    if (!String(a[0]).startsWith("bulkPacks:")) orig(...a);
  };
  try {
    return await loop.runOnce({ now });
  } finally {
    console.log = orig;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plus = (min) => new Date(Date.now() + min * 60e3);
const clock = () => {
  const t = Date.now();
  return (min) => new Date(t + min * 60e3);
};
const getOffer = (id) => BulkOffer.findById(id).lean();
const getRow = (id) => MarketplaceListing.findById(id).lean();
const entriesOf = (o, id) =>
  o.reserved.filter((e) => String(e.accountId) === String(id));
const liveEntry = (o, id) =>
  entriesOf(o, id).find(
    (e) => e.state === "on_offer" || e.state === "retiring",
  );
const unitIds = (row) => row.units.map((u) => String(u.accountId));
const count = (name) => calls.filter((c) => c[0] === name).length;
async function reservationOf(accountId) {
  const d = await DropLog.findOne({ account: accountId }).lean();
  return d
    ? { soldAt: d.soldAt, tag: d.soldToUsername, setId: d.soldSetId }
    : null;
}
const soldAtOf = async (id) => ((await reservationOf(id)) || {}).soldAt || null;

// A proxy of MarketplaceListing whose FIRST findById (the pass reading its
// row) runs `hook` first — how a write landing mid-pass is staged.
function hookFirstRowRead(hook) {
  let fired = false;
  return new Proxy(MarketplaceListing, {
    get(t, k) {
      if (k === "findById") {
        return (...args) => ({
          lean: async () => {
            if (!fired) {
              fired = true;
              await hook();
            }
            return t.findById(...args).lean();
          },
        });
      }
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

// ===========================================================================
// Part 1 — the reviewer's repros, real modules
// ===========================================================================

// The loop with the real stock/markets/reservations; Telegram, the audit log
// and proposals captured; the lock recorded (and real).
function useReal() {
  const r = { telegram: [], events: [], locked: [] };
  loop.__resetDeps();
  loop.__setDeps({
    settings: fakeSettings,
    telegram: {
      sendTelegram(t) {
        r.telegram.push(t);
        return Promise.resolve();
      },
    },
    systemLog: {
      logEvent(ev) {
        r.events.push(ev);
        return Promise.resolve();
      },
    },
    proposals: { invalidate() {} },
    lock: recordingLock(r.locked),
  });
  return r;
}

// The real lock, every take recorded in `locked` (the pass's non-waiting try
// included, whether or not it ran — `busy` lists the ones that found the offer
// held, FIXES-2 V2).
function recordingLock(locked, busy = []) {
  return {
    withOfferLock(id, fn) {
      locked.push(String(id));
      return lock.withOfferLock(id, fn);
    },
    async tryWithOfferLock(id, fn) {
      locked.push(String(id));
      const r = await lock.tryWithOfferLock(id, fn);
      if (!r.ran) busy.push(String(id));
      return r;
    },
    holdsAny: () => lock.holdsAny(),
  };
}

// A live dropset offer exactly as send.sendOffer leaves it: n accounts that
// each hold the set, reserved through CONTRACT I1's claimAccountsForSet with
// the market's claim tag, a live BulkOffer holding them on_offer, and its bulk
// row (origin manual, bulkOfferId, the units FREE).
async function seedPack({
  prefix,
  market = "eldorado",
  n = 6,
  minQty = 5,
  packPrice = 6,
  unitPrice = 1.9,
}) {
  seq++;
  const game = "Rust";
  const itemKey = prefix + "|x";
  const set = await DropSet.create({
    name: prefix + " bundle",
    items: [{ itemKey, name: prefix + " item", game, qty: 1 }],
    price: 3,
  });
  for (let i = 1; i <= n; i++) {
    const login = prefix + String(i).padStart(2, "0");
    const acc = await BotAccount.create({
      clientSecret: "secret-" + login,
      login,
      credUsername: login,
      credPassword: encrypt("pw-" + login),
      hasPassword: true,
      lastScanStatus: "ok",
    });
    await DropLog.create({
      account: acc._id,
      benefitId: "b-" + login,
      login,
      game,
      itemKey,
      count: 1,
      connected: false,
      soldAt: null,
    });
  }
  const got = await eldoradoFulfiller.claimAccountsForSet(set, n, {
    claimTag: market,
  });
  assert.equal(got.length, n, "the seed reserved every account");
  const units = got.map((g) => ({
    accountId: String(g.accountId),
    login: g.login,
  }));
  const externalId =
    (market === "gameflip" ? "gf-" : "eld-") + prefix + "-" + seq;
  const gf = market === "gameflip";
  const title = gf
    ? prefix + " bundle — PACK OF " + minQty + " ACCOUNTS"
    : prefix + " bundle — BULK " + minQty + "+ accounts (5% off)";
  const offer = await BulkOffer.create({
    kind: "accounts",
    source: "dropset",
    market,
    set: set._id,
    setName: set.name,
    game,
    minQty,
    discountPct: 5,
    unitPrice: gf ? 0 : unitPrice,
    packPrice: gf ? packPrice : 0,
    title,
    externalId,
    state: "live",
    slotKey: config.slotKey({
      kind: "accounts",
      source: "dropset",
      setId: String(set._id),
      market,
      minQty,
    }),
    reserved: units.map((u) => ({ ...u, state: "on_offer", at: new Date() })),
    advertisedQty: gf ? 1 : n,
    createdBy: "test",
  });
  const now = new Date();
  const [row] = await MarketplaceListing.insertMany([
    {
      set: set._id,
      marketplace: market,
      externalId,
      title,
      price: gf ? packPrice : unitPrice,
      status: "active",
      origin: "manual",
      bulkOfferId: offer._id,
      autoDeliver: gf,
      qtyRemaining: 0,
      qtyTarget: n,
      units: units.map((u) => ({
        contentId: "",
        accountId: u.accountId,
        login: u.login,
        addedAt: now,
        deliveredAt: null,
        orderId: "",
        messagedAt: null,
      })),
    },
  ]);
  await BulkOffer.updateOne({ _id: offer._id }, { $set: { listing: row._id } });
  return { set, offerId: offer._id, rowId: row._id, externalId, units };
}

// What send.withdrawOffer does to an Eldorado dropset offer (MODULES §send,
// CONTRACT I10 phase 1), under the offer's lock: pause on the market, row
// active -> delisted, retire every FREE unit, close the offer "withdrawn".
async function ownerWithdraw(pack) {
  await lock.withOfferLock(pack.offerId, async () => {
    await markets.withdraw("eldorado", pack.externalId);
    await MarketplaceListing.updateOne(
      { _id: pack.rowId, bulkOfferId: pack.offerId, status: "active" },
      { $set: { status: "delisted" } },
    );
    const offer = await getOffer(pack.offerId);
    const row = await getRow(pack.rowId);
    await loop.retireUnits(
      offer,
      row,
      offer.reserved
        .filter((e) => e.state === "on_offer")
        .map((e) => e.accountId),
      "withdrawn",
      { now: new Date() },
    );
    await BulkOffer.updateOne(
      { _id: pack.offerId },
      { $set: { state: "withdrawn" } },
    );
  });
}

test("F-A gameflip take-out: a failed withdraw is retried every pass and its flag survives until the pack is down (L1, L8)", async () => {
  await clean();
  const r = useReal();
  const pack = await seedPack({ prefix: "fa", market: "gameflip", n: 5 });
  const row = await getRow(pack.rowId);
  const victim = row.units[0];
  knobs.gfDelistFail = 2; // two transient 429s

  const out = await detachAccountFromListing(
    row,
    { _id: victim.accountId, login: victim.login },
    { reason: "sold manually" },
  );
  assert.equal(out.detached.length, 0, JSON.stringify(out));
  assert.match(out.warnings.join(" "), /could not take the Gameflip pack down/);
  let o = await getOffer(pack.offerId);
  assert.match(o.attention, /^Needs attention \(withdraw\)/);
  assert.equal(o.lastError, "", "a flag is not a loop error (L8)");
  assert.equal(liveEntry(o, victim.accountId).state, "on_offer");
  assert.equal(liveEntry(o, victim.accountId).keepReserved, true);
  const flagPages = () =>
    r.telegram.filter((t) => /needs attention/.test(t)).length;
  assert.equal(flagPages(), 1);
  assert.equal(count("gameflipDelist"), 1);

  // The pack is otherwise healthy. The OLD loop cleared the flag here and
  // never tried again; now the taken-out member is a bad member (L1).
  await pass(plus(5));
  assert.equal(count("gameflipDelist"), 2, "the withdraw is retried");
  o = await getOffer(pack.offerId);
  assert.equal(o.state, "live");
  assert.match(
    o.attention,
    /^Needs attention \(withdraw\)/,
    "never cleared while the taken-out member is still on offer",
  );
  assert.equal(flagPages(), 1, "flagged once");

  await pass(plus(10));
  assert.equal(count("gameflipDelist"), 3, "retried until it worked");
  o = await getOffer(pack.offerId);
  assert.equal(o.state, "withdrawn");
  assert.equal(o.open, false);
  assert.equal(o.attention, "", "cleared once the pack is down");
  assert.equal((await getRow(pack.rowId)).status, "delisted");
  for (const u of pack.units) {
    assert.equal(liveEntry(o, u.accountId).state, "retiring");
  }
  assert.equal(liveEntry(o, victim.accountId).keepReserved, true);

  // Phase 2 after the grace: the others back in stock, the hand-sold one kept.
  await pass(plus(26));
  o = await getOffer(pack.offerId);
  for (const u of pack.units) {
    const e = entriesOf(o, u.accountId)[0];
    assert.equal(e.state, "released");
    if (String(u.accountId) === String(victim.accountId)) {
      assert.match(e.reason, /kept reserved/);
      assert.ok(
        await soldAtOf(u.accountId),
        "the hand-sold account stays reserved",
      );
    } else {
      assert.equal(await soldAtOf(u.accountId), null, "back in stock");
    }
  }
  assert.equal(count("gameflipDelist"), 3, "never withdrawn twice");
});

test("F-A gameflip take-out: if the pack sells before the withdraw works, the taken-out account is reported", async () => {
  await clean();
  const r = useReal();
  const pack = await seedPack({ prefix: "fs", market: "gameflip", n: 5 });
  const row = await getRow(pack.rowId);
  const victim = row.units[2];
  knobs.gfDelistFail = 10;
  await detachAccountFromListing(
    row,
    { _id: victim.accountId, login: victim.login },
    { reason: "sold manually" },
  );
  await pass(plus(5));
  // gameflipFulfiller.syncOnce: Gameflip reports the pack sold.
  await MarketplaceListing.updateOne(
    { _id: pack.rowId },
    { $set: { status: "sold" } },
  );
  await pass(plus(10));
  const o = await getOffer(pack.offerId);
  assert.equal(o.state, "sold");
  assert.ok(o.reserved.every((e) => e.state === "delivered"));
  const warned = r.telegram.filter((t) =>
    /was taken out by the owner but a pack buyer received it/.test(t),
  );
  assert.equal(warned.length, 1);
  assert.ok(warned[0].includes(victim.login));
  assert.ok(await soldAtOf(victim.accountId), "never handed back");
});

test("F-B take-out of a re-reserved account picks its LIVE entry, not the old released one (L4, L7)", async () => {
  await clean();
  useReal();
  const pack = await seedPack({ prefix: "fb", n: 6, minQty: 5 });
  const A = pack.units[0];

  // A loses its password: retired, and released after the 15-minute grace.
  await BotAccount.updateOne(
    { _id: A.accountId },
    { $set: { credPassword: "" } },
  );
  await pass(plus(1));
  let o = await getOffer(pack.offerId);
  assert.equal(liveEntry(o, A.accountId).state, "retiring");
  await pass(plus(17));
  o = await getOffer(pack.offerId);
  assert.equal(entriesOf(o, A.accountId)[0].state, "released");
  assert.equal(await soldAtOf(A.accountId), null);

  // Password fixed; the owner refills and A — the only free account — comes
  // back: reserved again, $pushed onto the row, a NEW on_offer entry (what
  // send.refillOffer does).
  await BotAccount.updateOne(
    { _id: A.accountId },
    { $set: { credPassword: encrypt("pw-" + A.login) } },
  );
  const setDoc = await DropSet.findById(pack.set._id).lean();
  assert.ok(
    await dropReservation.reserveSetOnAccount(A.accountId, setDoc, {
      soldToUsername: "eldorado",
      soldSetId: String(setDoc._id),
    }),
  );
  await MarketplaceListing.updateOne(
    { _id: pack.rowId },
    {
      $push: {
        units: {
          contentId: "",
          accountId: A.accountId,
          login: A.login,
          addedAt: new Date(),
          deliveredAt: null,
          orderId: "",
          messagedAt: null,
        },
      },
    },
  );
  await BulkOffer.updateOne(
    { _id: pack.offerId },
    {
      $push: {
        reserved: {
          accountId: A.accountId,
          login: A.login,
          state: "on_offer",
          at: new Date(),
        },
      },
    },
  );
  o = await getOffer(pack.offerId);
  assert.deepEqual(
    entriesOf(o, A.accountId).map((e) => e.state),
    ["released", "on_offer"],
  );

  // A pass leaves A on sale: only an account's LATEST entry speaks for it,
  // so its FREE copy is not a "zombie" of the old released entry (L2).
  await pass(plus(20));
  assert.equal(
    (await getRow(pack.rowId)).units.filter(
      (u) => String(u.accountId) === String(A.accountId),
    ).length,
    1,
  );

  // The owner hand-sells A (drop-archive mark-sold -> listingDetach).
  const out = await detachAccountFromListing(
    await getRow(pack.rowId),
    { _id: A.accountId, login: A.login },
    { reason: "sold manually" },
  );
  assert.equal(out.detached.length, 1, JSON.stringify(out));
  o = await getOffer(pack.offerId);
  assert.deepEqual(
    entriesOf(o, A.accountId).map((e) => [e.state, !!e.keepReserved]),
    [
      ["released", false],
      ["retiring", true],
    ],
  );
  assert.ok(!unitIds(await getRow(pack.rowId)).includes(String(A.accountId)));
  const lastQty = calls.filter((c) => c[0] === "eldoradoSetQuantity").pop();
  assert.deepEqual(lastQty, ["eldoradoSetQuantity", pack.externalId, 5]);
  assert.equal(o.advertisedQty, 5, "L7: the new quantity is recorded");

  // The next buyer of 6 cannot receive the account the owner just sold.
  const del = await eldoradoFulfiller.deliverOrder(
    { id: "fb-order", offerId: pack.externalId, purchaseQuantity: 6 },
    { dryRun: false },
  );
  assert.ok(!del.delivered, JSON.stringify(del));
  assert.match(String(del.error), /not enough reserved stock/);
  assert.ok(
    !(await getRow(pack.rowId)).units.some(
      (u) => String(u.accountId) === String(A.accountId) && u.orderId,
    ),
  );

  // After the grace its reservation is kept, never handed back.
  await pass(plus(40));
  o = await getOffer(pack.offerId);
  const kept = entriesOf(o, A.accountId)[1];
  assert.equal(kept.state, "released");
  assert.match(kept.reason, /^kept reserved/);
  assert.ok(await soldAtOf(A.accountId));
});

test("F-C an owner take-out landing mid-pass waits for the pass and is never undone by it (L3)", async () => {
  await clean();
  const r = useReal();
  const pack = await seedPack({ prefix: "fc", n: 6, minQty: 5 });
  const row = await getRow(pack.rowId);
  const A = row.units[1];

  let reached;
  const atRead = new Promise((res) => (reached = res));
  let proceed;
  const gate = new Promise((res) => (proceed = res));
  loop.__setDeps({
    MarketplaceListing: hookFirstRowRead(async () => {
      reached();
      await gate; // the pass holds the offer's lock here
    }),
  });
  let settled = false;
  let takeOut;
  let passP;
  try {
    passP = pass(plus(1));
    await atRead;
    // The owner's click, from its own request (not the pass's context).
    takeOut = detachAccountFromListing(
      row,
      { _id: A.accountId, login: A.login },
      { reason: "sold manually" },
    ).then((x) => {
      settled = true;
      return x;
    });
    await sleep(50);
    assert.equal(settled, false, "the take-out waits for the pass");
  } finally {
    proceed(); // never leave a pass blocked (it would block every later pass)
    if (passP) await passP;
    loop.__setDeps({ MarketplaceListing });
  }
  const out = await takeOut;
  assert.equal(out.detached.length, 1, JSON.stringify(out));
  let o = await getOffer(pack.offerId);
  const e = liveEntry(o, A.accountId);
  assert.equal(e.state, "retiring");
  assert.equal(e.keepReserved, true);
  assert.ok(
    !unitIds(await getRow(pack.rowId)).includes(String(A.accountId)),
    "off the live row",
  );
  assert.ok(
    r.locked.filter((id) => id === String(pack.offerId)).length >= 2,
    "the pass and the take-out both took the offer's lock",
  );

  // The next pass does not put it back either.
  await pass(plus(6));
  assert.ok(!unitIds(await getRow(pack.rowId)).includes(String(A.accountId)));
  o = await getOffer(pack.offerId);
  assert.equal(liveEntry(o, A.accountId).state, "retiring");

  // A buyer of 6 does not get it.
  const del = await eldoradoFulfiller.deliverOrder(
    { id: "fc-order", offerId: pack.externalId, purchaseQuantity: 6 },
    { dryRun: false },
  );
  assert.ok(!del.delivered, JSON.stringify(del));
  assert.ok(
    !(await getRow(pack.rowId)).units.some(
      (u) => String(u.accountId) === String(A.accountId) && u.orderId,
    ),
  );
});

test("F-C a take-out written WITHOUT the lock after the pass read the offer is still not undone (fresh read before the heal, L3)", async () => {
  await clean();
  useReal();
  const pack = await seedPack({ prefix: "fk", n: 7, minQty: 5 });
  const [A, B] = pack.units;
  // Worst case: a writer that bypasses the lock, landing after the pass read
  // the offer. A: taken out and retiring. B: marked keepReserved, still
  // on_offer, its unit pulled (a crash between the two writes of a take-out).
  loop.__setDeps({
    MarketplaceListing: hookFirstRowRead(async () => {
      await BulkOffer.updateOne(
        {
          _id: pack.offerId,
          reserved: {
            $elemMatch: { accountId: A.accountId, state: "on_offer" },
          },
        },
        {
          $set: {
            "reserved.$.state": "retiring",
            "reserved.$.keepReserved": true,
            "reserved.$.changedAt": new Date(),
            "reserved.$.reason": "owner: sold manually",
          },
        },
      );
      await BulkOffer.updateOne(
        {
          _id: pack.offerId,
          reserved: {
            $elemMatch: { accountId: B.accountId, state: "on_offer" },
          },
        },
        { $set: { "reserved.$.keepReserved": true } },
      );
      await MarketplaceListing.updateOne(
        { _id: pack.rowId },
        {
          $pull: { units: { accountId: { $in: [A.accountId, B.accountId] } } },
        },
      );
    }),
  });
  try {
    await pass(plus(1));
  } finally {
    loop.__setDeps({ MarketplaceListing });
  }
  const row = await getRow(pack.rowId);
  assert.ok(!unitIds(row).includes(String(A.accountId)), "A not put back");
  assert.ok(!unitIds(row).includes(String(B.accountId)), "B not put back");
  const o = await getOffer(pack.offerId);
  assert.equal(liveEntry(o, A.accountId).state, "retiring");
  assert.equal(
    liveEntry(o, B.accountId).state,
    "retiring",
    "B leaves the pack (L1)",
  );
  assert.equal(liveEntry(o, B.accountId).reason, "taken out by the owner");
  assert.equal(liveEntry(o, B.accountId).keepReserved, true);
});

test("F-D slow delivery vs owner withdraw: nothing is released inside the 15-minute grace; the sale comes back delivered (L2)", async () => {
  await clean();
  const r = useReal();
  const pack = await seedPack({ prefix: "fd", n: 6, minQty: 5 });
  let open;
  knobs.eldSendGate = new Promise((res) => (open = res));
  const p = eldoradoFulfiller.deliverOrder(
    { id: "fd-order", offerId: pack.externalId, purchaseQuantity: 5 },
    { dryRun: false },
  );
  let o;
  try {
    await sleep(200); // the fulfiller is inside the chat send, holding its copy of the row
    await ownerWithdraw(pack);
    await pass(plus(3)); // the old 2-minute grace released all six here
    o = await getOffer(pack.offerId);
    assert.equal(o.reserved.filter((e) => e.state === "released").length, 0);
    for (const u of pack.units) {
      assert.ok(await soldAtOf(u.accountId), "still reserved");
    }
  } finally {
    knobs.eldSendGate = null;
    open();
  }
  const del = await p;
  assert.equal(del.delivered, 5, JSON.stringify(del));

  await pass(plus(9));
  o = await getOffer(pack.offerId);
  const delivered = o.reserved.filter((e) => e.state === "delivered");
  assert.equal(delivered.length, 5);
  assert.ok(delivered.every((e) => e.orderId === "fd-order"));
  assert.equal(
    o.reserved.filter((e) => e.state === "retiring").length,
    1,
    "the unsold one came back FREE and was pulled again",
  );
  assert.equal(o.unitsDelivered, 5);
  assert.equal(o.ordersCount, 1);

  await pass(plus(25));
  o = await getOffer(pack.offerId);
  for (const e of o.reserved) {
    if (e.state === "delivered") {
      assert.ok(
        await soldAtOf(e.accountId),
        "a delivered account stays reserved",
      );
    } else {
      assert.equal(e.state, "released");
      assert.equal(await soldAtOf(e.accountId), null);
    }
  }
  assert.equal(
    r.telegram.filter((t) => /delivered after release/.test(t)).length,
    0,
    "nothing was shipped after its release",
  );
});

test("F-D slower than the grace: a released account that comes back SOLD is recorded, re-reserved and always reported (L2 watch)", async () => {
  await clean();
  const r = useReal();
  const pack = await seedPack({ prefix: "fl", n: 6, minQty: 5 });
  let open;
  knobs.eldSendGate = new Promise((res) => (open = res));
  const p = eldoradoFulfiller.deliverOrder(
    { id: "fl-order", offerId: pack.externalId, purchaseQuantity: 5 },
    { dryRun: false },
  );
  let o;
  try {
    await sleep(200);
    await ownerWithdraw(pack);
    await pass(plus(20)); // past the grace: all six go back to stock
    o = await getOffer(pack.offerId);
    assert.equal(o.reserved.filter((e) => e.state === "released").length, 6);
    for (const u of pack.units) assert.equal(await soldAtOf(u.accountId), null);
  } finally {
    knobs.eldSendGate = null;
    open();
  }
  const del = await p;
  assert.equal(del.delivered, 5, JSON.stringify(del));

  // The closed offer is still watched: the sold copies are caught.
  await pass(plus(25));
  o = await getOffer(pack.offerId);
  const delivered = o.reserved.filter((e) => e.state === "delivered");
  assert.equal(delivered.length, 5);
  for (const e of delivered) {
    assert.equal(e.orderId, "fl-order");
    assert.match(e.reason, /delivered after release/);
    const res = await reservationOf(e.accountId);
    assert.ok(res.soldAt, "re-reserved so nobody else sells it");
    assert.equal(res.tag, "eldorado");
    assert.equal(res.setId, String(pack.set._id));
  }
  const alerts = () =>
    r.telegram.filter((t) =>
      /released account .* was delivered after release — check it is not sold twice/.test(
        t,
      ),
    ).length;
  assert.equal(alerts(), 5, "every one reported");
  assert.equal(o.unitsDelivered, 5, "the sale is counted");
  assert.equal(o.ordersCount, 1);
  // The unsold sixth came back FREE: pulled off the row, not released twice.
  const sixth = o.reserved.find((e) => e.state === "released");
  assert.ok(sixth);
  assert.ok(
    !unitIds(await getRow(pack.rowId)).includes(String(sixth.accountId)),
  );
  assert.equal(await soldAtOf(sixth.accountId), null);

  await pass(plus(30));
  assert.equal(alerts(), 5, "reported once");

  // After the 24-hour watch the closed offer is no longer visited.
  const before = r.locked.length;
  await pass(plus(24 * 60 + 30));
  assert.ok(
    !r.locked.slice(before).includes(String(pack.offerId)),
    "not visited after the watch window",
  );
});

test("a HELD offer (closed 'error', no row, entries on_offer) is never released by the loop inside the 24-hour watch", async () => {
  await clean();
  const r = useReal();
  const pack = await seedPack({ prefix: "hd", n: 5, minQty: 5 });
  const held =
    "publish outcome unknown — may be live on Eldorado (no id): check it, then Release held accounts";
  // What send.js leaves when a publish outcome is unknown (FIXES-1 S2/S5):
  // closed as "error", its accounts still reserved on_offer, no row.
  await MarketplaceListing.deleteOne({ _id: pack.rowId });
  await BulkOffer.updateOne(
    { _id: pack.offerId },
    { $set: { state: "error", listing: null, lastError: held } },
  );
  for (const t of [plus(1), plus(16), plus(60), plus(23 * 60)]) await pass(t);
  let o = await getOffer(pack.offerId);
  assert.equal(o.state, "error");
  assert.ok(
    o.reserved.every((e) => e.state === "on_offer"),
    "held",
  );
  for (const u of pack.units) {
    assert.ok(await soldAtOf(u.accountId), "still reserved");
  }
  assert.equal(o.lastError, held, "send's message is kept");
  assert.ok(
    r.locked.filter((id) => id === String(pack.offerId)).length >= 4,
    "it was visited every pass (the watch window)",
  );
  assert.equal(r.telegram.length, 0);

  // The owner's Release held accounts (send.releaseHeld) marks them retiring:
  // even with no row they wait out the grace, never a direct release.
  const T = new Date(Date.now() + 23.5 * 60 * 60e3);
  await BulkOffer.updateOne(
    { _id: pack.offerId },
    {
      $set: {
        "reserved.$[e].state": "retiring",
        "reserved.$[e].changedAt": T,
      },
    },
    { arrayFilters: [{ "e.state": "on_offer" }] },
  );
  await pass(new Date(T.getTime() + 5 * 60e3));
  o = await getOffer(pack.offerId);
  assert.ok(
    o.reserved.every((e) => e.state === "retiring"),
    "no direct release",
  );
  await pass(new Date(T.getTime() + 16 * 60e3));
  o = await getOffer(pack.offerId);
  assert.ok(o.reserved.every((e) => e.state === "released"));
  for (const u of pack.units) assert.equal(await soldAtOf(u.accountId), null);
});

// ===========================================================================
// Part 2 — each fix, with fakes
// ===========================================================================

const bpObj = (o = {}) => ({
  enabled: true,
  markets: ["eldorado", "g2g", "gameflip"],
  tiers: [
    { minQty: 5, discountPct: 5 },
    { minQty: 10, discountPct: 10 },
  ],
  reserveSingles: 5,
  unitsPerOffer: 20,
  farmPrices: {},
  farmDurations: [120, 180, 365],
  farmReserveSlots: 20,
  farmReservePristine: 20,
  farmMaxQty: 20,
  loopMinutes: 5,
  farmSyncMinutes: 15,
  ...o,
});

function useFakes() {
  const f = {
    bp: bpObj(),
    gate: { ok: true, reason: "" },
    bad: new Map(),
    notOurs: new Set(),
    // What readOffer answers: readStates (per externalId) first, then
    // readState for every offer; with neither, the market mirrors what we did
    // (a live offer reads "active", anything else "paused") — a test stages a
    // relist behind our back by answering "active" for a paused one.
    readState: null,
    readStates: new Map(),
    failPause: false,
    failSetQuantity: false,
    onSetQuantity: null,
    onPause: null,
    onReadOffer: null,
    advertisable: 10,
    cap: {
      bestStackRoom: 30,
      totalFree: 40,
      pristine: 60,
      at: new Date(),
      error: "",
    },
    rereserve: true,
    calls: {
      pause: [],
      resume: [],
      setQuantity: [],
      withdraw: [],
      readOffer: [],
      release: [],
      capRead: 0,
      shareFor: [],
      telegram: [],
      events: [],
      locked: [],
      busy: [],
      rereserve: [],
      market: [], // every market call in order: [verb, externalId, n?]
    },
  };
  loop.__resetDeps();
  loop.__setDeps({
    settings: { getBulkPacks: () => f.bp },
    config: { currentGate: () => f.gate },
    stock: {
      async isStillOurs({ accountId }) {
        return !f.notOurs.has(accountId);
      },
      async releaseUnits({ accountIds }) {
        const released = [];
        const skipped = [];
        for (const id of accountIds) {
          f.calls.release.push(id);
          if (f.notOurs.has(id))
            skipped.push({ accountId: id, reason: "not ours" });
          else released.push(id);
        }
        return { released, skipped, failed: [] };
      },
      async unitHealth(ids) {
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
        if (f.onPause) await f.onPause(m, id);
        f.calls.pause.push([m, id]);
        if (f.failPause) throw new Error("pause refused");
        f.calls.market.push(["pause", id]);
      },
      async resume(m, id) {
        f.calls.resume.push([m, id]);
        f.calls.market.push(["resume", id]);
      },
      async setQuantity(m, id, n) {
        if (f.onSetQuantity) await f.onSetQuantity(m, id, n);
        f.calls.setQuantity.push([m, id, n]);
        if (f.failSetQuantity) throw new Error("quantity refused");
        f.calls.market.push(["setQuantity", id, n]);
      },
      async withdraw(m, id) {
        f.calls.withdraw.push([m, id]);
      },
      async readOffer(m, id) {
        f.calls.readOffer.push([m, id]);
        if (f.onReadOffer) await f.onReadOffer(m, id);
        if (f.readStates.has(id)) {
          return { state: f.readStates.get(id), quantity: 0 };
        }
        if (f.readState) return { state: f.readState, quantity: 0 };
        const o = await BulkOffer.findOne(
          { externalId: id },
          { state: 1 },
        ).lean();
        return {
          state: o && o.state === "live" ? "active" : "paused",
          quantity: 0,
        };
      },
    },
    farmCapacity: {
      async read() {
        f.calls.capRead++;
        return f.cap;
      },
      advertisable: () => f.advertisable,
      shareFor(selfId, ids, available) {
        f.calls.shareFor.push([String(selfId), [...ids], available]);
        return shareOfShelf(available, selfId, ids);
      },
    },
    noclaimStock: {
      async stockForListing() {
        return 10;
      },
    },
    telegram: {
      sendTelegram(t) {
        f.calls.telegram.push(t);
        return Promise.resolve();
      },
    },
    systemLog: {
      logEvent(ev) {
        f.calls.events.push(ev);
        return Promise.resolve();
      },
    },
    proposals: { invalidate() {} },
    dropReservation: {
      async reserveSetOnAccount(id, set, opts) {
        f.calls.rereserve.push([
          String(id),
          String(set && set._id),
          { ...opts },
        ]);
        return f.rereserve;
      },
    },
    lock: recordingLock(f.calls.locked, f.calls.busy),
  });
  return f;
}

async function dsOffer({
  market = "eldorado",
  minQty = 5,
  n = 6,
  state = "live",
  advertisedQty,
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
    unitPrice: 1.5,
    title: "Rust bundle " + seq + " — BULK " + minQty + "+ accounts (5% off)",
    externalId,
    state,
    slotKey: ["accounts", "dropset", String(set._id), market, minQty].join("|"),
    reserved: ids.map((id) => ({
      accountId: id,
      login: "login_" + id,
      state: "on_offer",
      at: new Date(),
    })),
    advertisedQty: advertisedQty == null ? n : advertisedQty,
  });
  const [row] = await MarketplaceListing.insertMany([
    {
      set: set._id,
      marketplace: market,
      externalId,
      title: offer.title,
      price: 1.5,
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
        addedAt: new Date(),
        deliveredAt: null,
        orderId: "",
        messagedAt: null,
      })),
    },
  ]);
  await BulkOffer.updateOne({ _id: offer._id }, { $set: { listing: row._id } });
  return { set, ids, offerId: offer._id, rowId: row._id, externalId };
}

async function farmOffer({
  market = "eldorado",
  minQty = 5,
  advertisedQty = 10,
  state = "live",
  autoPaused = false,
} = {}) {
  seq++;
  const externalId = "farm-ext-" + seq;
  const offer = await BulkOffer.create({
    kind: "farming",
    source: "farm",
    market,
    game: "Rust",
    days: 180,
    minQty,
    discountPct: 5,
    unitPrice: 3.8,
    title:
      "Rust Twitch Drops Automatic Farming 180 Days — Bulk " +
      minQty +
      "+ Accounts",
    externalId,
    state,
    autoPaused,
    advertisedQty,
    slotKey: ["farming", "farm", "Rust@180#" + seq, market, minQty].join("|"),
  });
  return { offerId: offer._id, externalId };
}

const setEntryState = (offerId, accountId, patch) =>
  BulkOffer.updateOne(
    { _id: offerId, "reserved.accountId": accountId },
    {
      $set: Object.fromEntries(
        Object.entries(patch).map(([k, v]) => ["reserved.$." + k, v]),
      ),
    },
  );

test("L6 an unreadable farm capacity pauses, resumes and requantifies nothing — a loop error only", async () => {
  await clean();
  const f = useFakes();
  const at = clock();
  const live = await farmOffer({ state: "live", advertisedQty: 10 });
  const paused = await farmOffer({
    state: "paused",
    autoPaused: true,
    advertisedQty: 5,
  });
  f.advertisable = 40;
  f.cap = {
    bestStackRoom: 0,
    totalFree: 0,
    pristine: 0,
    at: new Date(),
    error: "ssh: connect timed out",
  };
  const s = await pass(at(0));
  assert.deepEqual(f.calls.pause, [], "not read as 'no capacity'");
  assert.deepEqual(f.calls.resume, []);
  assert.deepEqual(f.calls.setQuantity, []);
  assert.equal(s.errors, 2);
  assert.equal(f.calls.telegram.length, 0, "nobody is paged");
  let a = await getOffer(live.offerId);
  assert.equal(a.state, "live");
  assert.match(
    a.lastError,
    /^Loop: farm capacity unreadable \(ssh: connect timed out\)/,
  );
  assert.equal(a.attention, "");
  assert.equal(a.lastSyncAt, null, "not synced, so the next pass tries again");
  assert.equal((await getOffer(paused.offerId)).state, "paused");

  // Readable again (and short: 6 shared by two offers is 3 each < 5).
  f.cap = {
    bestStackRoom: 30,
    totalFree: 40,
    pristine: 60,
    at: new Date(),
    error: "",
  };
  f.advertisable = 6;
  const reads = f.calls.capRead;
  await pass(at(5));
  assert.equal(f.calls.capRead, reads + 1, "read again next pass");
  assert.deepEqual(f.calls.pause, [["eldorado", live.externalId]]);
  a = await getOffer(live.offerId);
  assert.equal(a.state, "paused");
  assert.equal(a.autoPaused, true);
  assert.equal(a.lastError, "", "the loop's own error cleared");
});

test("S1 open farm offers share the capacity by id: each is paused, resumed and requantified on ITS share", async () => {
  await clean();
  const f = useFakes();
  const at = clock();
  const A = await farmOffer({ state: "live", advertisedQty: 20 });
  const B = await farmOffer({ state: "live", advertisedQty: 20 });
  const C = await farmOffer({
    state: "paused",
    autoPaused: false,
    advertisedQty: 5,
  });
  await farmOffer({ state: "withdrawn", advertisedQty: 5 }); // closed: not a sharer
  const ids = [A, B, C].map((o) => String(o.offerId)).sort();

  f.advertisable = 20;
  await pass(at(0));
  // 20 over three offers is 7 + 7 + 6 by id — never 20 each.
  assert.deepEqual(f.calls.setQuantity, [
    ["eldorado", A.externalId, 7],
    ["eldorado", B.externalId, 7],
  ]);
  assert.equal(f.calls.shareFor.length, 3);
  for (const [self, list, available] of f.calls.shareFor) {
    assert.ok(ids.includes(self));
    assert.deepEqual(
      list,
      ids,
      "every open live|paused farm offer, sorted by id",
    );
    assert.equal(available, 20);
  }
  assert.equal(
    (await getOffer(C.offerId)).state,
    "paused",
    "an owner pause stays",
  );

  // 12 over three is 4 each < minimum 5: both live ones pause.
  f.advertisable = 12;
  await pass(at(16));
  assert.deepEqual(f.calls.pause, [
    ["eldorado", A.externalId],
    ["eldorado", B.externalId],
  ]);
  for (const o of [A, B]) {
    const x = await getOffer(o.offerId);
    assert.equal(x.state, "paused");
    assert.equal(x.autoPaused, true);
  }
  assert.ok(
    f.calls.telegram.some((t) =>
      /its share of 12 across 3 farm offers/.test(t),
    ),
  );

  // 30 over three is 10 each: both resume, quantity first.
  f.advertisable = 30;
  await pass(at(32));
  assert.deepEqual(f.calls.setQuantity.slice(2), [
    ["eldorado", A.externalId, 10],
    ["eldorado", B.externalId, 10],
  ]);
  assert.deepEqual(f.calls.resume, [
    ["eldorado", A.externalId],
    ["eldorado", B.externalId],
  ]);
  for (const o of [A, B]) {
    const x = await getOffer(o.offerId);
    assert.equal(x.state, "live");
    assert.equal(x.advertisedQty, 10);
  }
  assert.equal((await getOffer(C.offerId)).state, "paused");
});

test("L8 a flag lives in `attention`: a loop error in lastError neither wipes it nor re-pages it", async () => {
  await clean();
  const f = useFakes();
  const at = clock();
  const { offerId } = await dsOffer({ n: 6, advertisedQty: 9 });
  f.readState = "gone"; // flagged, never acted on
  f.failSetQuantity = true; // the shrink to 6 fails: a loop error
  await pass(at(0));
  let o = await getOffer(offerId);
  assert.match(o.attention, /^Needs attention \(gone\)/);
  assert.match(o.lastError, /^Loop: .*quantity refused/);
  const pages = () =>
    f.calls.telegram.filter((t) => /needs attention/.test(t)).length;
  assert.equal(pages(), 1);

  // The market is read again and still says gone; the loop error persists.
  // (Before L8 the loop error had overwritten the flag, so it paged again.)
  await pass(at(31));
  o = await getOffer(offerId);
  assert.match(o.attention, /^Needs attention \(gone\)/);
  assert.match(o.lastError, /^Loop: /);
  assert.equal(pages(), 1, "not re-paged");

  // Each clears on its own check.
  f.readState = "active";
  f.failSetQuantity = false;
  await pass(at(62));
  o = await getOffer(offerId);
  assert.equal(o.attention, "");
  assert.equal(o.lastError, "");
  assert.equal(o.advertisedQty, 6);
});

test("L8 a loop error never overwrites another writer's lastError, and a standing one is logged once", async () => {
  await clean();
  const f = useFakes();
  const at = clock();
  const { offerId } = await dsOffer({ n: 6, advertisedQty: 9 });
  await BulkOffer.updateOne(
    { _id: offerId },
    { $set: { lastError: "refill quantity: Eldorado said 500" } },
  );
  f.failSetQuantity = true;
  const s = await pass(at(0));
  assert.equal(s.errors, 1);
  assert.equal(
    (await getOffer(offerId)).lastError,
    "refill quantity: Eldorado said 500",
  );
  const logged = () =>
    f.calls.events.filter((e) => e.action === "loop_error").length;
  assert.equal(logged(), 1);
  await pass(at(5));
  assert.equal(logged(), 1, "a standing loop error is logged once");
  assert.equal(
    (await getOffer(offerId)).lastError,
    "refill quantity: Eldorado said 500",
  );
});

test("L1 an account the owner took out that is still FREE on the row leaves on the next pass — quantity first", async () => {
  await clean();
  const f = useFakes();
  const at = clock();
  const { offerId, rowId, ids, externalId } = await dsOffer({
    n: 7,
    advertisedQty: 7,
  });
  // The take-out found it mid-delivery (or died after marking it): on_offer,
  // keepReserved, and FREE on the row again.
  await setEntryState(offerId, ids[0], { keepReserved: true });
  let unitsAtQuantity = null;
  f.onSetQuantity = async () => {
    unitsAtQuantity = unitIds(await getRow(rowId));
  };
  await pass(at(0));
  assert.deepEqual(f.calls.setQuantity, [["eldorado", externalId, 6]]);
  assert.ok(
    unitsAtQuantity.includes(ids[0]),
    "the quantity dropped before the unit left the row",
  );
  let e = entriesOf(await getOffer(offerId), ids[0])[0];
  assert.equal(e.state, "retiring");
  assert.equal(e.reason, "taken out by the owner");
  assert.equal(e.keepReserved, true);
  assert.ok(!unitIds(await getRow(rowId)).includes(ids[0]));

  await pass(at(16));
  e = entriesOf(await getOffer(offerId), ids[0])[0];
  assert.equal(e.state, "released");
  assert.match(e.reason, /^kept reserved/);
  assert.ok(!f.calls.release.includes(ids[0]), "never handed back");
});

test("L1 a taken-out account that sells before it could leave is reported to the owner", async () => {
  await clean();
  const f = useFakes();
  const at = clock();
  const { offerId, rowId, ids } = await dsOffer({ n: 7 });
  await setEntryState(offerId, ids[0], { keepReserved: true });
  await MarketplaceListing.updateOne(
    { _id: rowId, "units.accountId": ids[0] },
    { $set: { "units.$.orderId": "o-9", "units.$.deliveredAt": new Date() } },
  );
  await pass(at(0));
  const e = entriesOf(await getOffer(offerId), ids[0])[0];
  assert.equal(e.state, "delivered");
  assert.equal(e.orderId, "o-9");
  assert.ok(
    unitIds(await getRow(rowId)).includes(ids[0]),
    "a sold unit is never pulled",
  );
  const warned = f.calls.telegram.filter((t) =>
    /login_acc\d+_0 was taken out by the owner but a pack buyer received it \(order o-9\)/.test(
      t,
    ),
  );
  assert.equal(warned.length, 1);
  await pass(at(5));
  assert.equal(
    f.calls.telegram.filter((t) =>
      /taken out by the owner but a pack buyer/.test(t),
    ).length,
    1,
    "reported once",
  );
});

test("L7 a take-out that leaves fewer than the minimum pauses the offer; the next pass closes it sold out", async () => {
  await clean();
  const f = useFakes();
  const at = clock();
  const { offerId, rowId, ids, externalId } = await dsOffer({
    n: 5,
    minQty: 5,
  });
  const out = await loop.takeAccountOut({
    row: await getRow(rowId),
    accountId: ids[0],
    login: "login_" + ids[0],
    reason: "sold manually",
  });
  assert.equal(out.detached.length, 1, JSON.stringify(out));
  assert.deepEqual(f.calls.setQuantity, []);
  assert.deepEqual(f.calls.pause, [["eldorado", externalId]]);
  let o = await getOffer(offerId);
  assert.equal(o.state, "paused");
  assert.equal(o.open, true);
  assert.equal(o.autoPaused, false);
  assert.ok(
    o.history.some((h) =>
      /below the minimum after an owner take-out/.test(h.detail),
    ),
  );
  assert.deepEqual(f.calls.locked, [String(offerId)], "under the offer's lock");

  await pass(at(1));
  o = await getOffer(offerId);
  assert.equal(o.state, "sold_out");
  assert.equal(f.calls.pause.length, 1, "already paused: not paused twice");
  for (const id of ids.slice(1)) {
    assert.equal(entriesOf(o, id)[0].state, "retiring");
  }
  assert.equal(entriesOf(o, ids[0])[0].keepReserved, true);
});

test("L7 after a take-out the quantity counts on_offer entries' FREE units only — a retiring unit back on the row is not stock", async () => {
  await clean();
  const f = useFakes();
  const { offerId, rowId, ids, externalId } = await dsOffer({
    n: 7,
    minQty: 5,
  });
  await loop.retireUnits(
    await getOffer(offerId),
    await getRow(rowId),
    [ids[6]],
    "test",
    {
      now: new Date(),
    },
  );
  // A stale whole-array save put it back FREE.
  await MarketplaceListing.updateOne(
    { _id: rowId },
    {
      $push: {
        units: {
          contentId: "",
          accountId: ids[6],
          login: "login_" + ids[6],
          addedAt: new Date(),
          deliveredAt: null,
          orderId: "",
          messagedAt: null,
        },
      },
    },
  );
  const out = await loop.takeAccountOut({
    row: await getRow(rowId),
    accountId: ids[0],
    reason: "sold manually",
  });
  assert.equal(out.detached.length, 1);
  // 7 − the retiring one − the one taken out; the old code counted 6 FREE row units.
  assert.deepEqual(f.calls.setQuantity, [["eldorado", externalId, 5]]);
  assert.equal((await getOffer(offerId)).advertisedQty, 5);
  assert.deepEqual(f.calls.pause, []);
});

test("L2 the grace is 15 minutes; a closed dropset offer is watched for 24 hours and its on_offer entries are HELD", async () => {
  await clean();
  const f = useFakes();
  assert.equal(loop.RETIRE_GRACE_MS, 15 * 60 * 1000);
  assert.equal(loop.WATCH_WINDOW_MS, 24 * 60 * 60 * 1000);
  const T = Date.now();
  const closed = await dsOffer({ n: 6 });
  await BulkOffer.updateOne(
    { _id: closed.offerId },
    { $set: { state: "error", closedAt: new Date(T) } },
  );
  const farm = await farmOffer({ state: "withdrawn" });
  await pass(new Date(T + 60 * 60e3));
  assert.ok(
    f.calls.locked.includes(String(closed.offerId)),
    "visited inside the window",
  );
  assert.ok(
    !f.calls.locked.includes(String(farm.offerId)),
    "only dropset offers are watched",
  );
  const o = await getOffer(closed.offerId);
  assert.ok(
    o.reserved.every((e) => e.state === "on_offer"),
    "held, not retired",
  );
  assert.equal((await getRow(closed.rowId)).units.length, 6, "nothing pulled");
  assert.deepEqual(f.calls.release, []);
  assert.deepEqual(f.calls.pause, []);
  const n = f.calls.locked.length;
  await pass(new Date(T + 25 * 60 * 60e3));
  assert.ok(
    !f.calls.locked.slice(n).includes(String(closed.offerId)),
    "not after 24 hours",
  );
});

test("L2 released entries are watched: a SOLD copy is recorded, re-reserved and reported; a FREE copy is pulled; a re-taken account is left alone", async () => {
  await clean();
  const f = useFakes();
  const at = clock();
  const { offerId, rowId, ids, set } = await dsOffer({ n: 8, minQty: 5 });
  await setEntryState(offerId, ids[7], {
    state: "released",
    reason: "withdrawn",
  });
  await setEntryState(offerId, ids[6], {
    state: "released",
    reason: "kept reserved (not handed back): owner: sold manually",
    keepReserved: true,
  });
  await setEntryState(offerId, ids[5], {
    state: "released",
    reason: "withdrawn",
  });
  // ids[4]: released once, then taken back by a refill (a newer on_offer entry).
  await setEntryState(offerId, ids[4], {
    state: "released",
    reason: "health: no password",
  });
  await BulkOffer.updateOne(
    { _id: offerId },
    {
      $push: {
        reserved: {
          accountId: ids[4],
          login: "login_" + ids[4],
          state: "on_offer",
          at: new Date(),
        },
      },
    },
  );
  // A fulfiller's save from an old copy: ids[7] and ids[6] went to an order;
  // ids[5] is back FREE.
  await MarketplaceListing.updateOne(
    { _id: rowId },
    {
      $set: {
        "units.$[u].deliveredAt": new Date(),
        "units.$[u].orderId": "o-late",
      },
    },
    { arrayFilters: [{ "u.accountId": { $in: [ids[7], ids[6]] } }] },
  );
  await pass(at(0));
  let o = await getOffer(offerId);
  const e7 = entriesOf(o, ids[7])[0];
  assert.equal(e7.state, "delivered");
  assert.equal(e7.orderId, "o-late");
  assert.match(e7.reason, /delivered after release .*re-reserved for this set/);
  const e6 = entriesOf(o, ids[6])[0];
  assert.equal(e6.state, "delivered");
  assert.match(e6.reason, /never handed back/);
  assert.deepEqual(
    f.calls.rereserve,
    [
      [
        ids[7],
        String(set._id),
        { soldToUsername: "eldorado", soldSetId: String(set._id) },
      ],
    ],
    "only the one whose reservation was handed back is re-reserved",
  );
  const alerts = () =>
    f.calls.telegram.filter((t) =>
      /was delivered after release — check it is not sold twice/.test(t),
    ).length;
  assert.equal(alerts(), 2, "ALWAYS reported");
  assert.equal(o.unitsDelivered, 2, "the sale is counted");
  const row = await getRow(rowId);
  assert.ok(
    !unitIds(row).includes(ids[5]),
    "a FREE copy of a released account is pulled",
  );
  assert.equal(entriesOf(o, ids[5])[0].state, "released");
  assert.equal(
    row.units.filter((u) => u.accountId === ids[4]).length,
    1,
    "re-taken: still on sale",
  );
  assert.deepEqual(
    entriesOf(o, ids[4]).map((e) => e.state),
    ["released", "on_offer"],
  );
  assert.deepEqual(f.calls.release, [], "nothing is released a second time");

  // A re-reserve that fails is recorded and reported just the same.
  await setEntryState(offerId, ids[3], {
    state: "released",
    reason: "withdrawn",
  });
  await MarketplaceListing.updateOne(
    { _id: rowId, "units.accountId": ids[3] },
    { $set: { "units.$.orderId": "o-late-2" } },
  );
  f.rereserve = false;
  await pass(at(5));
  o = await getOffer(offerId);
  assert.equal(entriesOf(o, ids[3])[0].state, "delivered");
  assert.match(entriesOf(o, ids[3])[0].reason, /NOT re-reserved/);
  assert.equal(alerts(), 3);
  assert.ok(f.calls.telegram.some((t) => /NOT re-reserved/.test(t)));
});

test("L3 + V2 a pass never waits for a held offer: it is skipped (busy), and the next pass reads it fresh under its lock", async () => {
  await clean();
  const f = useFakes();
  const at = clock();
  const { offerId, rowId, ids } = await dsOffer({ n: 6 });
  let release;
  const held = new Promise((r) => (release = r));
  // Another writer holds the offer (a take-out) and changes it meanwhile.
  const holder = lock.withOfferLock(offerId, async () => {
    await held;
    await setEntryState(offerId, ids[0], {
      state: "retiring",
      keepReserved: true,
      changedAt: new Date(),
      reason: "owner: sold manually",
    });
    await MarketplaceListing.updateOne(
      { _id: rowId },
      { $pull: { units: { accountId: ids[0] } } },
    );
  });
  const passP = pass(at(0));
  try {
    // Before FIXES-2 V2 the pass queued behind the holder here.
    const s = await Promise.race([passP, sleep(2000).then(() => "stalled")]);
    assert.notEqual(s, "stalled", "the pass does not wait for the lock");
    assert.equal(s.busy, 1);
    assert.equal(s.open, 1, "a busy offer is still counted open");
    assert.deepEqual(f.calls.busy, [String(offerId)]);
    assert.equal(
      (await getOffer(offerId)).lastSyncAt,
      null,
      "not maintained this pass",
    );
  } finally {
    release();
    await holder;
    await passP;
  }
  const s2 = await pass(at(5));
  assert.equal(s2.busy, 0);
  assert.ok(f.calls.locked.includes(String(offerId)));
  assert.ok(
    !unitIds(await getRow(rowId)).includes(ids[0]),
    "the pass saw the take-out",
  );
  const e = entriesOf(await getOffer(offerId), ids[0])[0];
  assert.equal(e.state, "retiring");
  assert.equal(e.keepReserved, true);
});

test("L3 a release re-reads keepReserved: a take-out landing after the pass read the offer keeps the reservation", async () => {
  await clean();
  const f = useFakes();
  const at = clock();
  const { offerId, rowId, ids } = await dsOffer({ n: 8 });
  await loop.retireUnits(
    await getOffer(offerId),
    await getRow(rowId),
    [ids[7]],
    "withdraw",
    {
      now: at(0),
    },
  );
  loop.__setDeps({
    MarketplaceListing: hookFirstRowRead(() =>
      setEntryState(offerId, ids[7], { keepReserved: true }),
    ),
  });
  try {
    await pass(at(16));
  } finally {
    loop.__setDeps({ MarketplaceListing });
  }
  const e = entriesOf(await getOffer(offerId), ids[7])[0];
  assert.equal(e.state, "released");
  assert.match(e.reason, /^kept reserved/);
  assert.ok(!f.calls.release.includes(ids[7]), "never handed back");
});

test("maintainOffer(offerId, {now}) runs one offer's pass under its lock", async () => {
  await clean();
  const f = useFakes();
  const at = clock();
  const { offerId, rowId, ids } = await dsOffer({ n: 6 });
  await MarketplaceListing.updateOne(
    { _id: rowId },
    { $pull: { units: { accountId: ids[5] } } },
  );
  const r = await loop.maintainOffer(offerId, { now: at(1) });
  assert.equal(r.error, "");
  assert.equal(String(r.offer._id), String(offerId));
  assert.equal(r.summary.open, 1);
  assert.ok(unitIds(await getRow(rowId)).includes(ids[5]), "healed");
  assert.deepEqual(f.calls.locked, [String(offerId)]);
  const missing = await loop.maintainOffer(new mongoose.Types.ObjectId(), {
    now: at(2),
  });
  assert.equal(missing.offer, null);
  assert.equal(missing.error, "");
});

// ===========================================================================
// Part 3 — utils/bulkPacks/lock.js
// ===========================================================================

test("lock: one holder at a time per offer, first come first served; other offers never wait", async () => {
  lock.__reset();
  const order = [];
  let releaseA;
  const gateA = new Promise((r) => (releaseA = r));
  const a1 = lock.withOfferLock("A", async () => {
    order.push("a1 start");
    await gateA;
    order.push("a1 end");
    return 1;
  });
  const a2 = lock.withOfferLock("A", async () => {
    order.push("a2");
    return 2;
  });
  const a3 = lock.withOfferLock("A", async () => {
    order.push("a3");
    return 3;
  });
  const b = await lock.withOfferLock("B", async () => {
    order.push("b");
    return "b";
  });
  assert.equal(b, "b");
  assert.ok(
    order.includes("b") && !order.includes("a1 end"),
    "B ran while A was held",
  );
  assert.ok(!order.includes("a2"), "A's next caller waits");
  releaseA();
  assert.deepEqual(await Promise.all([a1, a2, a3]), [1, 2, 3]);
  assert.deepEqual(
    order.filter((x) => x !== "b"),
    ["a1 start", "a1 end", "a2", "a3"],
  );
  assert.equal(lock.__size(), 0, "nothing left locked");
});

test("lock: an error releases the lock and reaches the caller", async () => {
  lock.__reset();
  const boom = lock.withOfferLock("E", async () => {
    throw new Error("boom");
  });
  const next = lock.withOfferLock("E", async () => "next");
  await assert.rejects(boom, /boom/);
  assert.equal(await next, "next");
  const sync = lock.withOfferLock("E", () => {
    throw new Error("sync boom");
  });
  await assert.rejects(sync, /sync boom/);
  assert.equal(await lock.withOfferLock("E", () => "after"), "after");
  assert.equal(lock.__size(), 0);
});

test("lock: not re-entrant — nesting the same offer is refused at once instead of deadlocking", async () => {
  lock.__reset();
  const out = await lock.withOfferLock("N", async () => {
    await assert.rejects(
      lock.withOfferLock("N", async () => "never"),
      /not re-entrant/,
    );
    // Another offer may be taken inside; nesting back to the first is refused too.
    return lock.withOfferLock("M", async () => {
      await assert.rejects(
        lock.withOfferLock("N", async () => "never"),
        /not re-entrant/,
      );
      return "ok";
    });
  });
  assert.equal(out, "ok");
  // Work started inside and still running after the release is not a holder.
  let later;
  await lock.withOfferLock("L", async () => {
    later = sleep(20).then(() => lock.withOfferLock("L", async () => "after"));
  });
  assert.equal(await later, "after");
  assert.equal(lock.__size(), 0);
});

test("lock: an offer id and a function are required; an ObjectId and its string are one lock; __reset forgets", async () => {
  lock.__reset();
  await assert.rejects(
    lock.withOfferLock(null, async () => 1),
    TypeError,
  );
  await assert.rejects(
    lock.withOfferLock(undefined, async () => 1),
    TypeError,
  );
  await assert.rejects(
    lock.withOfferLock("", async () => 1),
    TypeError,
  );
  await assert.rejects(lock.withOfferLock("x", null), TypeError);
  const id = new mongoose.Types.ObjectId();
  let releaseFirst;
  const gate = new Promise((r) => (releaseFirst = r));
  const order = [];
  const p1 = lock.withOfferLock(id, async () => {
    await gate;
    order.push(1);
  });
  const p2 = lock.withOfferLock(String(id), async () => {
    order.push(2);
  });
  await sleep(10);
  assert.deepEqual(order, []);
  releaseFirst();
  await p1;
  await p2;
  assert.deepEqual(order, [1, 2]);

  let hold;
  const g2 = new Promise((r) => (hold = r));
  const stuck = lock.withOfferLock("R", () => g2);
  assert.equal(lock.__size(), 1);
  lock.__reset();
  assert.equal(lock.__size(), 0);
  assert.equal(await lock.withOfferLock("R", async () => "fresh"), "fresh");
  hold();
  await stuck;
  assert.equal(lock.__size(), 0);
});

// ===========================================================================
// Part 4 — FIXES-2 round 2 (Y1): V1 loop side, V2, V3 loop side, V4
// ===========================================================================

// A pass with its heartbeat line captured instead of swallowed.
async function passLines(now, lines) {
  const orig = console.log;
  console.log = (...a) => {
    const line = a.join(" ");
    if (line.startsWith("bulkPacks:")) lines.push(line);
    else orig(...a);
  };
  try {
    return await loop.runOnce({ now });
  } finally {
    console.log = orig;
  }
}

const historyOf = (o, action) =>
  (o.history || []).filter((h) => h.action === action);
const sortCalls = (list) => [...list].map((c) => c.join("|")).sort();

// ---- V1: the farm sharers, and resplitFarm --------------------------------

test("V1 a farm offer still being SENT is a sharer: the pass splits the capacity with it, as send.js does", async () => {
  await clean();
  const f = useFakes();
  const at = clock();
  f.advertisable = 20;
  const A = await farmOffer({ state: "live", advertisedQty: 20 });
  const S = await farmOffer({ state: "sending", advertisedQty: 0 });
  await pass(at(0));
  // Round 1 counted live|paused only: A kept all 20 while S's send took 10.
  const ids = [A, S].map((o) => String(o.offerId)).sort();
  assert.deepEqual(f.calls.shareFor, [[String(A.offerId), ids, 20]]);
  assert.deepEqual(f.calls.setQuantity, [["eldorado", A.externalId, 10]]);
  assert.equal((await getOffer(A.offerId)).advertisedQty, 10);
  // A re-split leaves an offer being sent to its own send: its lock is never
  // asked for (the send calls resplitFarm itself when it is done).
  f.calls.locked.length = 0;
  const r = await loop.resplitFarm({ now: at(1) });
  assert.equal(r.offers, 1);
  assert.ok(!f.calls.locked.includes(String(S.offerId)));
});

test("V1 resplitFarm syncs every open farm offer NOW under its own lock, whatever farmSyncMinutes says", async () => {
  await clean();
  const f = useFakes();
  const at = clock();
  f.advertisable = 20;
  const A = await farmOffer({ state: "live", advertisedQty: 20 });
  const B = await farmOffer({ state: "live", advertisedQty: 10 });
  // A synced a minute ago with the whole pool to itself; B was resumed a
  // moment ago on its share of the two (send.resumeOffer).
  await BulkOffer.updateOne(
    { _id: A.offerId },
    { $set: { lastSyncAt: at(-1), lastCheckAt: at(-1) } },
  );
  await BulkOffer.updateOne(
    { _id: B.offerId },
    { $set: { lastSyncAt: at(0), lastCheckAt: at(0) } },
  );
  await pass(at(1));
  assert.deepEqual(
    f.calls.setQuantity,
    [],
    "not due: A still has all 20 on sale",
  );

  f.calls.locked.length = 0;
  const r = await loop.resplitFarm({ now: at(1) });
  assert.equal(r.offers, 2);
  assert.equal(r.errors, 0, r.lastError);
  assert.deepEqual(f.calls.setQuantity, [["eldorado", A.externalId, 10]]);
  const a = await getOffer(A.offerId);
  assert.equal(a.advertisedQty, 10);
  assert.equal(new Date(a.lastSyncAt).getTime(), at(1).getTime());
  assert.equal((await getOffer(B.offerId)).advertisedQty, 10);
  for (const o of [A, B]) {
    assert.equal(
      f.calls.locked.filter((id) => id === String(o.offerId)).length,
      2,
      "one lock per round (shrink, then grow)",
    );
  }
});

test("V1 resplitFarm shrinks every offer before any grows: the total on sale never exceeds the pool", async () => {
  await clean();
  const f = useFakes();
  const at = clock();
  f.advertisable = 20;
  // B (the LOWER id, so first in id order) was auto-paused short; A has the
  // whole pool on sale. Their shares are now 10 each.
  const B = await farmOffer({
    state: "paused",
    autoPaused: true,
    advertisedQty: 0,
  });
  const A = await farmOffer({ state: "live", advertisedQty: 20 });
  const r = await loop.resplitFarm({ now: at(0) });
  assert.equal(r.errors, 0, r.lastError);
  assert.deepEqual(f.calls.market, [
    ["setQuantity", A.externalId, 10],
    ["setQuantity", B.externalId, 10],
    ["resume", B.externalId],
  ]);
  // Replay what the market had on sale after each call.
  const qty = { [A.externalId]: 20, [B.externalId]: 0 };
  const on = { [A.externalId]: true, [B.externalId]: false };
  for (const [verb, id, n] of f.calls.market) {
    if (verb === "setQuantity") qty[id] = n;
    if (verb === "resume") on[id] = true;
    if (verb === "pause") on[id] = false;
    const total = Object.keys(qty).reduce(
      (t, k) => t + (on[k] ? qty[k] : 0),
      0,
    );
    assert.ok(total <= 20, total + " on sale after " + verb + " " + id);
  }
  const a = await getOffer(A.offerId);
  const b = await getOffer(B.offerId);
  assert.equal(a.advertisedQty, 10);
  assert.equal(b.state, "live");
  assert.equal(b.autoPaused, false);
  assert.equal(b.advertisedQty, 10);
});

test("V1 resplitFarm refuses to run inside any offer's lock, and WAITS for a busy farm offer instead of skipping it", async () => {
  await clean();
  const f = useFakes();
  const at = clock();
  f.advertisable = 20;
  const A = await farmOffer({ state: "live", advertisedQty: 20 });
  const B = await farmOffer({ state: "live", advertisedQty: 10 });
  // From inside an offer's lock (a send that did not release first): refused
  // at once — it would take the other offers' locks while holding this one.
  await lock.withOfferLock(B.offerId, async () => {
    await assert.rejects(
      loop.resplitFarm({ now: at(0) }),
      /must not run inside a bulk offer's lock/,
    );
  });
  assert.deepEqual(f.calls.market, []);

  // A is busy (an owner action holds it): the re-split waits for it, because
  // skipping it would leave it on its old share.
  let release;
  const gate = new Promise((r) => (release = r));
  const holder = lock.withOfferLock(A.offerId, () => gate);
  let done = false;
  const p = loop.resplitFarm({ now: at(1) }).then((r) => {
    done = true;
    return r;
  });
  try {
    await sleep(100);
    assert.equal(done, false, "waits for A's lock");
    assert.deepEqual(f.calls.market, []);
  } finally {
    release();
    await holder;
  }
  const r = await p;
  assert.equal(r.errors, 0, r.lastError);
  assert.deepEqual(f.calls.setQuantity, [["eldorado", A.externalId, 10]]);
});

test("V1 resplitFarm on an unreadable capacity pauses, resumes and requantifies nothing — a loop error on each offer (L6)", async () => {
  await clean();
  const f = useFakes();
  const at = clock();
  const A = await farmOffer({ state: "live", advertisedQty: 20 });
  const B = await farmOffer({
    state: "paused",
    autoPaused: true,
    advertisedQty: 0,
  });
  f.advertisable = 40;
  f.cap = { ...f.cap, error: "ssh: connect timed out" };
  const r = await loop.resplitFarm({ now: at(0) });
  assert.deepEqual(f.calls.market, []);
  assert.ok(r.errors >= 2);
  assert.match(r.lastError, /farm capacity unreadable/);
  for (const o of [A, B]) {
    const x = await getOffer(o.offerId);
    assert.match(
      x.lastError,
      /^Loop: farm re-split: farm capacity unreadable \(ssh: connect timed out\)/,
    );
    assert.equal(x.lastSyncAt, null, "not synced: the next pass tries again");
  }
  assert.equal(f.calls.telegram.length, 0, "nobody is paged");
});

// ---- V2: the pass never waits for a lock; per-offer clock and settings -----

test("V2 a send in flight (its offer's lock held) no longer stalls the pass: the rest is maintained, it is counted busy", async () => {
  await clean();
  const f = useFakes();
  const at = clock();
  // S: an offer an owner send is publishing right now (created first, so the
  // round-1 pass reached it first and queued behind the send's lock).
  const S = await farmOffer({ state: "sending", advertisedQty: 0 });
  // D: a live pack that must close sold out this pass (3 free < minimum 5).
  const D = await dsOffer({ n: 3, minQty: 5, advertisedQty: 3 });
  let release;
  const gate = new Promise((r) => (release = r));
  const sending = lock.withOfferLock(S.offerId, () => gate);
  const lines = [];
  const passP = passLines(at(0), lines);
  try {
    const s = await Promise.race([passP, sleep(3000).then(() => "stalled")]);
    assert.notEqual(
      s,
      "stalled",
      "the pass finished while the send held its lock",
    );
    assert.equal(s.busy, 1);
    assert.equal(s.errors, 0);
    assert.equal(s.open, 1, "the offer being sent is still counted open");
    assert.deepEqual(f.calls.busy, [String(S.offerId)]);
    assert.equal(
      (await getOffer(D.offerId)).state,
      "sold_out",
      "D was handled while the send ran",
    );
    assert.deepEqual(f.calls.pause, [["eldorado", D.externalId]]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\| released 0 \| busy 1 \| errors 0$/);
    assert.equal(loop.status().lastSummary.busy, 1);
  } finally {
    release();
    await sending;
    await passP;
  }
  const s2 = await pass(at(5));
  assert.equal(s2.busy, 0, "visited again once the send is done");
});

test("V2 each offer's clock is the pass's base time plus the real time the pass has run: a slow offer no longer back-dates the next", async () => {
  await clean();
  const f = useFakes();
  const base = new Date(Date.now() + 60e3);
  // X (first by id): its market read takes 1.2 s. Y: sold out this pass.
  const X = await dsOffer({ n: 6, minQty: 5 });
  const Y = await dsOffer({ n: 3, minQty: 5, advertisedQty: 3 });
  f.onReadOffer = async (m, id) => {
    if (id === X.externalId) await sleep(1200);
  };
  const t0 = Date.now();
  await pass(base);
  const took = Date.now() - t0;
  const x = await getOffer(X.offerId);
  assert.equal(
    new Date(x.lastSyncAt).getTime(),
    base.getTime(),
    "the first offer keeps the base time exactly (tests control it)",
  );
  const y = await getOffer(Y.offerId);
  assert.equal(y.state, "sold_out");
  const stamps = [
    ...y.reserved.map((e) => new Date(e.changedAt).getTime()),
    new Date(y.closedAt).getTime(),
  ].map((t) => t - base.getTime());
  for (const d of stamps) {
    // Round 1 stamped every one of them with the base: 0.
    assert.ok(
      d >= 1200 && d <= took + 50,
      d + " ms after the base (pass ran " + took + " ms)",
    );
  }
});

test("V2 the settings are read again for each offer: switching bulk packs off mid-pass holds for the offers after the switch", async () => {
  await clean();
  const f = useFakes();
  const at = clock();
  const X = await dsOffer({ n: 6, minQty: 5 });
  // Y: auto-paused for capacity, which is back — it would resume.
  const Y = await farmOffer({
    state: "paused",
    autoPaused: true,
    advertisedQty: 5,
  });
  f.advertisable = 10;
  f.onReadOffer = async (m, id) => {
    // The owner switches bulk packs off while the pass is on X.
    if (id === X.externalId) f.bp = bpObj({ enabled: false });
  };
  await pass(at(0));
  assert.deepEqual(f.calls.resume, [], "not resumed after the switch-off");
  assert.equal((await getOffer(Y.offerId)).state, "paused");
  f.onReadOffer = null;
  f.bp = bpObj();
  await pass(at(16));
  assert.deepEqual(
    f.calls.resume,
    [["eldorado", Y.externalId]],
    "on again: it resumes",
  );
});

// ---- V3: an offer we took off sale that the market shows active ----------

test("V3 a PAUSED offer the market shows active is paused again at that read, with a history line (Eldorado and G2G)", async () => {
  await clean();
  const f = useFakes();
  const at = clock();
  const P = await dsOffer({ n: 6, state: "paused" }); // owner-paused pack
  const F = await farmOffer({
    market: "g2g",
    state: "paused",
    autoPaused: false,
    advertisedQty: 5,
  });
  const L = await dsOffer({ n: 6 }); // live: "active" is right for it
  for (const o of [P, F, L]) f.readStates.set(o.externalId, "active");
  await pass(at(0));
  assert.deepEqual(
    sortCalls(f.calls.pause),
    sortCalls([
      ["eldorado", P.externalId],
      ["g2g", F.externalId],
    ]),
  );
  for (const o of [P, F]) {
    const x = await getOffer(o.offerId);
    assert.equal(x.state, "paused", "our state is unchanged");
    assert.equal(x.open, true);
    const h = historyOf(x, "repaused");
    assert.equal(h.length, 1);
    assert.match(
      h[0].detail,
      /showed the offer active while it is paused here — paused it again/,
    );
  }
  assert.equal(historyOf(await getOffer(L.offerId), "repaused").length, 0);
  assert.equal(
    f.calls.telegram.filter((t) => /^Bulk offer paused again/.test(t)).length,
    2,
  );
  assert.ok(
    f.calls.events.some(
      (e) => e.action === "repaused" && e.severity === "warn",
    ),
  );

  // Read every 30 minutes, not every pass.
  await pass(at(5));
  assert.equal(f.calls.pause.length, 2);
  // Paused on the market now: nothing more to do.
  f.readStates.clear();
  await pass(at(31));
  assert.equal(f.calls.pause.length, 2);
  assert.equal(
    f.calls.readOffer.filter(([, id]) => id === P.externalId).length,
    2,
    "read again after 30 minutes",
  );
});

test("V3 a CLOSED dropset offer is read inside its 24-hour watch and paused again when shown active; held, Gameflip and later offers are not read", async () => {
  await clean();
  const f = useFakes();
  const T = Date.now();
  const W = await dsOffer({ n: 6 }); // Eldorado, withdrawn
  const G = await dsOffer({ n: 6, market: "g2g" }); // G2G, sold out
  const H = await dsOffer({ n: 6 }); // held after an unknown publish ("error")
  const GF = await dsOffer({ n: 5, market: "gameflip" }); // a withdrawn pack
  const close = (o, state) =>
    BulkOffer.updateOne(
      { _id: o.offerId },
      { $set: { state, closedAt: new Date(T), lastCheckAt: new Date(T) } },
    );
  await close(W, "withdrawn");
  await close(G, "sold_out");
  await close(H, "error");
  await close(GF, "withdrawn");
  for (const o of [W, G, H, GF]) f.readStates.set(o.externalId, "active");

  await pass(new Date(T + 60 * 60e3));
  assert.deepEqual(
    sortCalls(f.calls.pause),
    sortCalls([
      ["eldorado", W.externalId],
      ["g2g", G.externalId],
    ]),
  );
  const read = new Set(f.calls.readOffer.map(([, id]) => id));
  assert.ok(!read.has(H.externalId), "a held offer is the owner's to settle");
  assert.ok(!read.has(GF.externalId), "a Gameflip pack has no pause");
  for (const [o, st] of [
    [W, "withdrawn"],
    [G, "sold_out"],
  ]) {
    const x = await getOffer(o.offerId);
    assert.equal(x.state, st);
    assert.equal(x.open, false);
    const h = historyOf(x, "repaused");
    assert.equal(h.length, 1);
    assert.match(h[0].detail, new RegExp("while it is " + st + " here"));
  }
  // Every 30 minutes inside the window…
  await pass(new Date(T + 70 * 60e3));
  assert.equal(f.calls.pause.length, 2);
  await pass(new Date(T + 95 * 60e3));
  assert.equal(f.calls.pause.length, 4, "still shown active: paused again");
  // …and never after it.
  const n = f.calls.readOffer.length;
  await pass(new Date(T + 25 * 60 * 60e3));
  assert.equal(f.calls.readOffer.length, n);
});

test("V3 a re-pause that fails is a loop error, and the market is read again on the next pass", async () => {
  await clean();
  const f = useFakes();
  const at = clock();
  const P = await dsOffer({ n: 6, state: "paused" });
  f.readStates.set(P.externalId, "active");
  f.failPause = true;
  const s = await pass(at(0));
  assert.equal(s.errors, 1);
  let x = await getOffer(P.offerId);
  assert.match(
    x.lastError,
    /^Loop: Eldorado shows this paused offer ACTIVE and pausing it again failed: pause refused/,
  );
  assert.equal(x.lastCheckAt, null, "not counted as read");
  f.failPause = false;
  await pass(at(5));
  assert.equal(
    f.calls.readOffer.filter(([, id]) => id === P.externalId).length,
    2,
  );
  x = await getOffer(P.offerId);
  assert.equal(x.lastError, "", "cleared by the clean pass");
  assert.equal(historyOf(x, "repaused").length, 1);
});

test("V3 an offer this very pass paused is not 'paused again' by the read right behind that pause", async () => {
  await clean();
  const f = useFakes();
  const at = clock();
  const A = await farmOffer({ state: "live", advertisedQty: 10 });
  f.advertisable = 3; // < minimum 5: the farm sync pauses it
  f.readStates.set(A.externalId, "active"); // the read lags behind the pause
  await pass(at(0));
  assert.deepEqual(f.calls.pause, [["eldorado", A.externalId]]);
  const a = await getOffer(A.offerId);
  assert.equal(a.state, "paused");
  assert.equal(historyOf(a, "repaused").length, 0);
  // The next read, half an hour on, still says active: that is paused again.
  await pass(at(31));
  assert.equal(f.calls.pause.length, 2);
  assert.equal(historyOf(await getOffer(A.offerId), "repaused").length, 1);
});

// ---- V4: a take-out lowers the market BEFORE the unit leaves --------------

test("V4 take-out: the quantity comes down BEFORE the unit leaves the row", async () => {
  await clean();
  const f = useFakes();
  const { offerId, rowId, ids, externalId } = await dsOffer({
    n: 7,
    advertisedQty: 7,
  });
  let unitsAtQuantity = null;
  f.onSetQuantity = async () => {
    unitsAtQuantity = unitIds(await getRow(rowId));
  };
  const out = await loop.takeAccountOut({
    row: await getRow(rowId),
    accountId: ids[0],
    reason: "sold manually",
  });
  assert.equal(out.detached.length, 1, JSON.stringify(out));
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(f.calls.setQuantity, [["eldorado", externalId, 6]]);
  assert.ok(
    unitsAtQuantity.includes(ids[0]),
    "lowered while the unit was still on the row",
  );
  assert.ok(!unitIds(await getRow(rowId)).includes(ids[0]), "then it left");
  const o = await getOffer(offerId);
  assert.equal(o.advertisedQty, 6);
  const e = entriesOf(o, ids[0])[0];
  assert.equal(e.state, "retiring");
  assert.equal(e.keepReserved, true);
});

test("V4 take-out below the minimum: the offer is paused BEFORE the unit leaves the row", async () => {
  await clean();
  const f = useFakes();
  const { offerId, rowId, ids, externalId } = await dsOffer({
    n: 5,
    minQty: 5,
  });
  let unitsAtPause = null;
  f.onPause = async () => {
    unitsAtPause = unitIds(await getRow(rowId));
  };
  const out = await loop.takeAccountOut({
    row: await getRow(rowId),
    accountId: ids[0],
    reason: "sold manually",
  });
  assert.equal(out.detached.length, 1, JSON.stringify(out));
  assert.deepEqual(f.calls.pause, [["eldorado", externalId]]);
  assert.ok(
    unitsAtPause.includes(ids[0]),
    "paused while the unit was still on the row",
  );
  assert.ok(!unitIds(await getRow(rowId)).includes(ids[0]));
  const o = await getOffer(offerId);
  assert.equal(o.state, "paused");
  assert.equal(o.autoPaused, false);
});

test("V4 a quantity call that fails still takes the account out; the error is noted and the next pass lowers the market", async () => {
  await clean();
  const f = useFakes();
  const at = clock();
  const { offerId, rowId, ids, externalId } = await dsOffer({
    n: 7,
    advertisedQty: 7,
  });
  f.failSetQuantity = true;
  const out = await loop.takeAccountOut({
    row: await getRow(rowId),
    accountId: ids[0],
    reason: "sold manually",
  });
  assert.equal(out.detached.length, 1, "it leaves anyway: the owner spent it");
  assert.match(
    out.warnings.join(" "),
    /quantity not updated yet \(quantity refused\)/,
  );
  assert.ok(!unitIds(await getRow(rowId)).includes(ids[0]));
  let o = await getOffer(offerId);
  assert.equal(entriesOf(o, ids[0])[0].state, "retiring");
  assert.equal(o.advertisedQty, 7);
  assert.match(
    o.lastError,
    /^Loop: take-out of login_\S+: the market was not lowered \(quantity refused\)/,
  );
  f.failSetQuantity = false;
  await pass(at(1));
  o = await getOffer(offerId);
  assert.deepEqual(f.calls.setQuantity.slice(-1), [
    ["eldorado", externalId, 6],
  ]);
  assert.equal(o.advertisedQty, 6);
  assert.equal(o.lastError, "", "the next pass corrected it");
});

test("V4 a pause that fails still takes the account out; the next pass closes the offer sold out", async () => {
  await clean();
  const f = useFakes();
  const at = clock();
  const { offerId, rowId, ids } = await dsOffer({ n: 5, minQty: 5 });
  f.failPause = true;
  const out = await loop.takeAccountOut({
    row: await getRow(rowId),
    accountId: ids[0],
    reason: "sold manually",
  });
  assert.equal(out.detached.length, 1, JSON.stringify(out));
  assert.match(out.warnings.join(" "), /pause refused/);
  let o = await getOffer(offerId);
  assert.equal(o.state, "live", "not marked paused while the market is not");
  assert.equal(entriesOf(o, ids[0])[0].state, "retiring");
  assert.match(o.lastError, /^Loop: take-out of .*pause refused/);
  f.failPause = false;
  await pass(at(1));
  o = await getOffer(offerId);
  assert.equal(o.state, "sold_out");
});

test("V4 a take-out only ever LOWERS the quantity — growing it is the pass's job, behind I4/I8", async () => {
  await clean();
  const f = useFakes();
  // Switched off: 8 free, 5 advertised (the pass was not allowed to grow it).
  f.bp = bpObj({ enabled: false });
  const { offerId, rowId, ids } = await dsOffer({ n: 8, advertisedQty: 5 });
  const out = await loop.takeAccountOut({
    row: await getRow(rowId),
    accountId: ids[0],
    reason: "sold manually",
  });
  assert.equal(out.detached.length, 1, JSON.stringify(out));
  assert.deepEqual(
    f.calls.setQuantity,
    [],
    "7 left >= 5 advertised: nothing to lower",
  );
  assert.equal((await getOffer(offerId)).advertisedQty, 5);
});

// ---- lock.js: tryWithOfferLock, holdsAny ---------------------------------

test("lock: tryWithOfferLock runs fn only if the offer is free — held or queued answers {ran:false} at once", async () => {
  lock.__reset();
  assert.deepEqual(await lock.tryWithOfferLock("T", async () => "v"), {
    ran: true,
    value: "v",
  });
  assert.equal(lock.__size(), 0);
  const order = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const holder = lock.withOfferLock("T", () => gate);
  const busy = { ran: false, value: undefined };
  assert.deepEqual(
    await lock.tryWithOfferLock("T", async () => order.push("try1")),
    busy,
  );
  const queued = lock.withOfferLock("T", async () => order.push("queued"));
  assert.deepEqual(
    await lock.tryWithOfferLock("T", async () => order.push("try2")),
    busy,
  );
  assert.deepEqual(await lock.tryWithOfferLock("U", async () => 1), {
    ran: true,
    value: 1,
  });
  release();
  await holder;
  await queued;
  assert.deepEqual(order, ["queued"], "a busy try never runs, never queues");

  // Taken through a try, the offer is held like any other holder's.
  let release2;
  const gate2 = new Promise((r) => (release2 = r));
  const t = lock.tryWithOfferLock("T", () => gate2.then(() => "late"));
  let waited = false;
  const w = lock.withOfferLock("T", async () => {
    waited = true;
  });
  await sleep(10);
  assert.equal(waited, false);
  assert.deepEqual(await lock.tryWithOfferLock("T", async () => 0), busy);
  release2();
  assert.deepEqual(await t, { ran: true, value: "late" });
  await w;
  assert.equal(waited, true);

  // fn's error releases the lock and rejects; re-entry is refused, not "busy".
  await assert.rejects(
    lock.tryWithOfferLock("T", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  await lock.withOfferLock("T", async () => {
    await assert.rejects(
      lock.tryWithOfferLock("T", async () => 1),
      /not re-entrant/,
    );
  });
  await assert.rejects(
    lock.tryWithOfferLock(null, async () => 1),
    TypeError,
  );
  await assert.rejects(lock.tryWithOfferLock("T", null), TypeError);
  assert.equal(lock.__size(), 0);
});

test("lock: holdsAny is true only inside a holder's own context", async () => {
  lock.__reset();
  assert.equal(lock.holdsAny(), false);
  let inside;
  let nested;
  let later;
  await lock.withOfferLock("H", async () => {
    inside = lock.holdsAny();
    await lock.withOfferLock("I", async () => {
      nested = lock.holdsAny();
    });
    later = sleep(20).then(() => lock.holdsAny());
  });
  assert.equal(inside, true);
  assert.equal(nested, true);
  assert.equal(lock.holdsAny(), false);
  assert.equal(
    await later,
    false,
    "work that outlives the holder holds nothing",
  );
  assert.deepEqual(
    await lock.tryWithOfferLock("J", async () => lock.holdsAny()),
    {
      ran: true,
      value: true,
    },
  );
});
