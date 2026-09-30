// Bulk packs — send.js under races and unknown publish outcomes
// (docs/bulk-packs/FIXES-1.md: S1, S2/S5, S3, S4/S6, S8, releaseHeld;
// docs/bulk-packs/FIXES-2.md: V1 send side, V5).
//
// Ports of the adversarial reviewers' repros (scratchpad review-ssm/:
// farmOvercommit, gameflipSendRelease, g2gReadbackOrphan,
// stuckSendingWithdraw, refillRace, refillSoldOutStrand). Each one proved a
// defect; here each asserts the FIXED outcome.
//
// The originals drove the real sibling modules. Those (lock, loop, stock,
// farmCapacity, markets) are being rewritten in parallel, so every one of them
// is a fake written from FIXES-1's signatures:
//   lock.withOfferLock(offerId, fn)        in-process FIFO mutex, not re-entrant
//   farmCapacity.shareFor(selfId, ids, n)  utils/suppliedStock.js shareOfShelf
//   markets publish errors                 err.outcome / err.externalId / err.code
//   the loop's per-offer pass              a scripted pass under the same lock
// Memory Mongo with the real BulkOffer / MarketplaceListing / DropSet models,
// the real pack maths and buyer copy (PACKS-2: one listing = one pack of N
// accounts; every quantity is in packs) and the real farm-order parsers; no
// network, and the real utils/settings.json is never read.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const BulkOffer = require("../models/BulkOffer");
const MarketplaceListing = require("../models/MarketplaceListing");
const DropSet = require("../models/DropSet");
const CampaignDrops = require("../models/CampaignDrops");
const realSettings = require("../utils/settings");
const { shareOfShelf } = require("../utils/suppliedStock");
const config = require("../utils/bulkPacks/config");
const realPricing = require("../utils/bulkPacks/pricing");
const realCopy = require("../utils/bulkPacks/copy");
const { packsFor } = require("../utils/bulkPacks/packMath");
const send = require("../utils/bulkPacks/send");

let mongod;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

let af;
let shop;
function resetSettings(patch = {}) {
  af = {
    bulkPacksEnabled: true,
    bulkPacksMarkets: ["eldorado", "g2g", "gameflip"],
    eldoradoAutoDeliver: true,
    eldoradoDeliverDryRun: false,
    g2gAutoDeliver: true,
    g2gDeliverDryRun: false,
    bulkPackReserveSingles: 0,
    bulkPackUnitsPerOffer: 20,
    ...patch,
  };
  shop = { enabled: true, autoDeliver: true };
}
const fakeSettings = {
  getAutoFarm: () => af,
  getNoclaimShopSettings: () => shop,
  getBulkPacks: (x) =>
    realSettings.getBulkPacks(x && typeof x === "object" ? x : af),
  isNoClaimGame: (g) => /overwatch/i.test(String(g || "")),
};

// The real pack maths and buyer copy (pure).
const fakePricing = realPricing;
const fakeCopy = realCopy;

// The stock layer: `held` stands in for the DropLog reservations
// (accountId -> market tag).
const st = {};
function resetStock() {
  st.pool = [];
  st.held = new Map();
  st.reserveCalls = [];
  st.releaseCalls = [];
  st.noclaim = { free: 0, share: { eldorado: 0, g2g: 0 } };
}
const fakeStock = {
  freeDropsetAccounts: async () =>
    st.pool.filter((a) => !st.held.has(a.accountId)).map((a) => ({ ...a })),
  reserve: async ({ n, market }) => {
    st.reserveCalls.push({ n, market });
    const out = [];
    for (const a of st.pool) {
      if (out.length >= n) break;
      if (st.held.has(a.accountId)) continue;
      st.held.set(a.accountId, market);
      out.push({ ...a });
    }
    return out;
  },
  releaseUnits: async ({ market, accountIds }) => {
    st.releaseCalls.push({ market, accountIds: [...accountIds] });
    const released = [];
    const skipped = [];
    for (const id of accountIds) {
      if (st.held.get(id) === market) {
        st.held.delete(id);
        released.push(id);
      } else {
        skipped.push({ accountId: id, reason: "not ours" });
      }
    }
    return { released, skipped };
  },
  noclaimCounts: async () => st.noclaim,
};

// Marketplaces: records every call. `fail[name]` makes that call throw: a
// string is a plain Error, an object is an Error carrying what markets.js puts
// on a publish failure (FIXES-1 S2/S5: outcome, externalId, code).
const mk = {};
function resetMarkets() {
  mk.calls = [];
  mk.fail = {};
  mk.seq = 0;
  mk.onPublish = null;
  mk.noclaimLanded = null;
}
function called(name) {
  return mk.calls.filter((c) => c[0] === name);
}
function maybeFail(name) {
  const f = mk.fail[name];
  if (!f) return;
  if (typeof f === "string") throw new Error(f);
  throw Object.assign(new Error(f.message), f);
}
const fakeMarkets = {
  gameOfSet: (set) => (set.items && set.items[0] && set.items[0].game) || "",
  coverForSet: async () => "",
  publishAccounts: async (args) => {
    mk.calls.push(["publishAccounts", args]);
    if (mk.onPublish) await mk.onPublish(args);
    maybeFail("publishAccounts");
    return {
      externalId: "EXT-" + ++mk.seq,
      url: "https://market.test/offer/" + mk.seq,
      price: args.packPrice,
    };
  },
  publishNoclaim: async (args) => {
    mk.calls.push(["publishNoclaim", args]);
    maybeFail("publishNoclaim");
    const row = await MarketplaceListing.create({
      set: args.set._id,
      marketplace: args.market,
      externalId: "NC-" + ++mk.seq,
      title: args.title,
      price: args.packPrice,
      status: "active",
      origin: "manual",
      noclaimStock: true,
      qtyTarget: mk.noclaimLanded != null ? mk.noclaimLanded : args.quantity,
    });
    return {
      rowId: String(row._id),
      externalId: row.externalId,
      url: "https://market.test/nc/" + mk.seq,
      price: args.packPrice,
      ...(mk.noclaimLanded != null ? { quantity: mk.noclaimLanded } : {}),
    };
  },
  publishFarm: async (args) => {
    mk.calls.push(["publishFarm", args]);
    maybeFail("publishFarm");
    return {
      externalId: "FARM-" + ++mk.seq,
      url: "https://market.test/farm/" + mk.seq,
      price: args.packPrice,
    };
  },
  pause: async (market, id) => {
    mk.calls.push(["pause", market, id]);
    maybeFail("pause");
  },
  resume: async (market, id) => {
    mk.calls.push(["resume", market, id]);
    maybeFail("resume");
  },
  setQuantity: async (market, id, n) => {
    mk.calls.push(["setQuantity", market, id, n]);
    maybeFail("setQuantity");
  },
  withdraw: async (market, id) => {
    mk.calls.push(["withdraw", market, id]);
    maybeFail("withdraw");
  },
};

const cap = {};
function resetCapacity() {
  cap.value = {
    bestStackRoom: 30,
    totalFree: 60,
    pristine: 60,
    at: new Date(),
    error: "",
  };
}
const fakeFarmCapacity = {
  read: async () => ({ ...cap.value }),
  advertisable: (c, bp) =>
    c.error
      ? 0
      : Math.max(
          0,
          Math.floor(
            Math.min(
              bp.farmMaxQty,
              c.bestStackRoom,
              c.totalFree - bp.farmReserveSlots,
              c.pristine - bp.farmReservePristine,
            ),
          ),
        ),
  shareFor: (selfId, ids, available) => shareOfShelf(available, selfId, ids),
};

// lock.js: an in-process FIFO mutex keyed by String(offerId), not re-entrant.
const fakeLock = (() => {
  const tails = new Map();
  return {
    async withOfferLock(offerId, fn) {
      const key = String(offerId);
      const prev = tails.get(key) || Promise.resolve();
      let release;
      const gate = new Promise((r) => (release = r));
      const tail = prev.then(() => gate);
      tails.set(key, tail);
      await prev;
      try {
        return await fn();
      } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    },
    // The offer ids held (or queued for) right now.
    lockedKeys: () => [...tails.keys()],
    __reset: () => tails.clear(),
  };
})();

// Phase 1 of CONTRACT I10 (the loop's retireUnits): conditional $pull of the
// FREE unit, then the reserved entry goes retiring.
//
// resplitFarm (FIXES-2 V1, the loop's export): recorded with the offer locks
// held at the moment it is called; `resplitImpl`, when a test sets one, is
// what it then does.
const loopState = { calls: [], resplits: [], resplitImpl: null };
const fakeLoop = {
  resplitFarm: async (opts) => {
    loopState.resplits.push({ opts, locked: fakeLock.lockedKeys() });
    if (loopState.resplitImpl) return loopState.resplitImpl(opts);
    return {};
  },
  retireUnits: async (offer, row, accountIds, reason) => {
    loopState.calls.push({ accountIds: [...accountIds], reason });
    const now = new Date();
    for (const id of accountIds) {
      await MarketplaceListing.updateOne(
        { _id: row._id, bulkOfferId: offer._id },
        {
          $pull: {
            units: {
              accountId: id,
              deliveredAt: null,
              messagedAt: null,
              orderId: "",
            },
          },
        },
      );
      await BulkOffer.updateOne(
        {
          _id: offer._id,
          reserved: { $elemMatch: { accountId: id, state: "on_offer" } },
        },
        {
          $set: {
            "reserved.$.state": "retiring",
            "reserved.$.changedAt": now,
            "reserved.$.reason": reason,
          },
        },
      );
    }
  },
};

const ncl = { calls: [] };
const fakeNoclaimListings = {
  beforeDelist: async (row) => {
    ncl.calls.push(["beforeDelist", String(row._id)]);
    return { sold: 0 };
  },
  afterDelist: async (row, { outcome } = {}) => {
    ncl.calls.push(["afterDelist", String(row._id), outcome]);
    return { released: 0, sold: 0 };
  },
};

// A no-claim row's share of the shelf, in accounts (noclaimStock.stockForListing).
const nc = { share: 10 };

const events = [];
const telegrams = [];

function installFakes() {
  send.__resetDeps();
  send.__setDeps({
    settings: fakeSettings,
    pricing: fakePricing,
    copy: fakeCopy,
    stock: fakeStock,
    markets: fakeMarkets,
    farmCapacity: fakeFarmCapacity,
    loop: fakeLoop,
    lock: fakeLock,
    proposals: { invalidate: () => {} },
    noclaimListings: fakeNoclaimListings,
    noclaimStock: { stockForListing: async () => nc.share },
    logEvent: async (e) => {
      events.push(e);
    },
    sendTelegram: async (t) => {
      telegrams.push(String(t));
    },
  });
  config.__setDeps({ settings: fakeSettings });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Follows a promise that may be blocked on a lock.
function track(p) {
  const t = { done: false, value: undefined };
  t.promise = Promise.resolve(p).then((v) => {
    t.done = true;
    t.value = v;
    return v;
  });
  return t;
}
// Gives a tracked promise a fair chance to finish; true if it did.
async function settleWithin(t, ms) {
  await Promise.race([t.promise, sleep(ms)]);
  return t.done;
}

function accounts(n, prefix = "acc") {
  return Array.from({ length: n }, (_, i) => ({
    accountId: new mongoose.Types.ObjectId().toString(),
    login: prefix + (i + 1),
  }));
}

async function makeSet(extra = {}) {
  const doc = await DropSet.create({
    name: "Rust Twitch Drops bundle",
    items: [{ itemKey: "rust:hoodie", name: "Hoodie", game: "Rust", qty: 1 }],
    price: 2,
    ...extra,
  });
  return doc.toObject();
}

function sendDropset(set, market, extra = {}) {
  return send.sendOffer({
    source: "dropset",
    setId: String(set._id),
    market,
    minQty: 5,
    actor: "admin:t",
    ...extra,
  });
}

function farm(days, minQty, extra = {}) {
  return send.sendOffer({
    source: "farm",
    game: "Rust",
    days,
    market: "eldorado",
    minQty,
    actor: "admin:t",
    ...extra,
  });
}

function entries(offer, state) {
  return (offer.reserved || []).filter((r) => !state || r.state === state);
}
const offerOf = (id) => BulkOffer.findById(id).lean();
const rowOf = (offerId) =>
  MarketplaceListing.findOne({ bulkOfferId: offerId }).lean();

// What a fulfiller stamps on a unit it hands to a buyer.
async function deliver(rowId, accountIds, orderId) {
  for (const id of accountIds) {
    await MarketplaceListing.updateOne(
      { _id: rowId, "units.accountId": id },
      {
        $set: { "units.$.deliveredAt": new Date(), "units.$.orderId": orderId },
      },
    );
  }
}

const isFree = (u) => !u.deliveredAt && !u.messagedAt && !u.orderId;

// The maintenance loop's per-offer pass as FIXES-1 L3 has it: inside the
// offer's lock, from a fresh read. `body(offer, row)` is the scripted work.
function loopPass(offerId, body, { useLock = true } = {}) {
  const run = async () => {
    const offer = await BulkOffer.findById(offerId).lean();
    const row = await MarketplaceListing.findOne({
      bulkOfferId: offer._id,
    }).lean();
    return body(offer, row);
  };
  return useLock ? fakeLock.withOfferLock(String(offerId), run) : run();
}

// reconcile's clobber heal: an on_offer entry missing from the active row of
// an open offer is $pushed back. Returns the account ids it pushed.
async function clobberHeal(offer, row) {
  const healed = [];
  if (!offer.open || !row || row.status !== "active") return healed;
  const onRow = new Set(row.units.map((u) => String(u.accountId)));
  for (const e of entries(offer, "on_offer")) {
    if (onRow.has(String(e.accountId))) continue;
    const r = await MarketplaceListing.updateOne(
      {
        _id: row._id,
        bulkOfferId: offer._id,
        "units.accountId": { $ne: e.accountId },
      },
      {
        $push: {
          units: {
            contentId: "",
            accountId: e.accountId,
            login: e.login,
            addedAt: new Date(),
            deliveredAt: null,
            orderId: "",
            messagedAt: null,
          },
        },
      },
    );
    if (r.modifiedCount === 1) healed.push(String(e.accountId));
  }
  return healed;
}

// The loop closing a sold-out offer: reconcile the sold units, then (free <
// minQty) markets.pause -> row delisted -> "sold_out". `insidePause` runs
// where the pass is inside markets.pause.
async function closeSoldOut(offer, row, insidePause) {
  for (const u of row.units.filter((x) => !isFree(x))) {
    await BulkOffer.updateOne(
      {
        _id: offer._id,
        reserved: { $elemMatch: { accountId: u.accountId, state: "on_offer" } },
      },
      {
        $set: {
          "reserved.$.state": "delivered",
          "reserved.$.orderId": u.orderId,
        },
      },
    );
  }
  // PACKS-2 §4: a partial pack can never sell.
  if (packsFor(row.units.filter(isFree).length, offer.minQty) >= 1) return;
  await insidePause();
  await fakeMarkets.pause(offer.market, offer.externalId);
  await MarketplaceListing.updateOne(
    { _id: row._id, status: "active" },
    { $set: { status: "delisted" } },
  );
  await BulkOffer.updateOne(
    { _id: offer._id, open: true },
    { $set: { state: "sold_out", open: false, closedAt: new Date() } },
  );
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("bulk-packs-send-races-test"));
  await BulkOffer.syncIndexes();
  // The farm knows Rust: what knownFarmGames() reads for the I5 round trip.
  await CampaignDrops.create({ campaignId: "camp-rust-1", game: "Rust" });
});

test.after(async () => {
  send.__resetDeps();
  config.__resetDeps();
  await mongoose.disconnect();
  await mongod.stop();
});

test.beforeEach(async () => {
  await Promise.all([
    BulkOffer.deleteMany({}),
    MarketplaceListing.deleteMany({}),
    DropSet.deleteMany({}),
  ]);
  resetSettings();
  resetStock();
  resetMarkets();
  resetCapacity();
  loopState.calls = [];
  loopState.resplits = [];
  loopState.resplitImpl = null;
  ncl.calls = [];
  nc.share = 10;
  events.length = 0;
  telegrams.length = 0;
  fakeLock.__reset();
  installFakes();
});

// ---------------------------------------------------------------------------
// S2/S5 — a publish whose outcome is unknown HOLDS
// ---------------------------------------------------------------------------

test("gameflipSendRelease: a Gameflip publish that may have gone on sale HOLDS the whole pack (S2/S5)", async () => {
  const set = await makeSet();
  st.pool = accounts(12, "gfp");
  // gameflipPublish threw after the listing went on sale with the code
  // attached; markets.js tried to delete L9 and could not.
  mk.fail.publishAccounts = {
    message:
      "Gameflip created L9 but could not put it on sale (draft discarded): Gameflip listing status: 429",
    outcome: "may_be_live",
    externalId: "L9",
  };
  const r = await sendDropset(set, "gameflip");
  assert.equal(r.status, 502);
  assert.equal(r.success, false);
  assert.match(
    r.message,
    /^publish outcome unknown — may be live on Gameflip \(L9\): check it, then Release held accounts/,
  );
  assert.equal(st.releaseCalls.length, 0, "nothing handed back");

  const offer = await offerOf(r.offer._id);
  assert.equal(offer.state, "error");
  assert.equal(offer.open, false);
  assert.ok(offer.closedAt);
  assert.equal(offer.externalId, "L9", "the id it may be live under is kept");
  assert.equal(
    offer.lastError,
    "publish outcome unknown — may be live on Gameflip (L9): check it, then Release held accounts",
  );
  assert.equal(entries(offer).length, 5);
  assert.equal(entries(offer, "on_offer").length, 5, "held on_offer");
  for (const e of entries(offer)) {
    assert.equal(st.held.get(e.accountId), "gameflip", "still reserved");
  }
  const free = (await fakeStock.freeDropsetAccounts(set)).map(
    (a) => a.accountId,
  );
  assert.equal(
    entries(offer).filter((e) => free.includes(e.accountId)).length,
    0,
    "no pack account is free stock for the next listing",
  );
  assert.equal(
    await MarketplaceListing.countDocuments({ bulkOfferId: offer._id }),
    0,
  );
  assert.ok(
    telegrams.some(
      (t) =>
        /outcome UNKNOWN/.test(t) &&
        /L9/.test(t) &&
        /5 reserved account\(s\) are HELD/.test(t),
    ),
  );
  assert.ok(events.some((e) => e.action === "send_held"));

  // When markets.js proved the listing is gone ("not_created"), the pack's
  // accounts go back exactly as before.
  mk.fail.publishAccounts = {
    message:
      "Gameflip created L10 but could not put it on sale (draft discarded): 429",
    outcome: "not_created",
  };
  const r2 = await sendDropset(set, "gameflip");
  assert.equal(r2.status, 502);
  assert.match(r2.message, /Gameflip refused the pack/);
  const o2 = await offerOf(r2.offer._id);
  assert.equal(o2.state, "error");
  assert.equal(entries(o2, "released").length, 5);
  assert.equal(entries(o2, "on_offer").length, 0);
  for (const e of entries(o2)) assert.equal(st.held.has(e.accountId), false);
});

test("g2gReadbackOrphan: a G2G offer that did not read back is HELD with its id recorded (S2/S5)", async () => {
  const set = await makeSet();
  st.pool = accounts(8, "gg");
  // g2gPublish's PUT set the offer live, then its read-back failed; the
  // delist markets.js tried failed too.
  mk.fail.publishAccounts = {
    message: "G2G publish: offer G2G-777 did not read back as a live offer",
    outcome: "may_be_live",
    externalId: "G2G-777",
  };
  const r = await sendDropset(set, "g2g", { units: 8 });
  assert.equal(r.status, 502);
  const offer = await offerOf(r.offer._id);
  assert.equal(offer.externalId, "G2G-777", "recorded: releaseHeld reaches it");
  assert.equal(offer.state, "error");
  assert.equal(offer.open, false);
  assert.match(offer.lastError, /may be live on G2G \(G2G-777\)/);
  assert.equal(entries(offer, "on_offer").length, 5, "8 accounts = one pack of 5");
  assert.equal(st.releaseCalls.length, 0);
  assert.equal(st.held.size, 5, "nothing is free stock while it may sell");
  assert.equal(
    called("withdraw").length,
    0,
    "send never guesses; the owner checks",
  );
});

test("an unclassified publish failure holds; markets' own refusal or 'not_created' releases (S2/S5)", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  mk.fail.publishAccounts = "socket hang up"; // no classification at all
  const r = await sendDropset(set, "eldorado", { units: 6 });
  assert.equal(r.status, 502);
  const o = await offerOf(r.offer._id);
  assert.equal(o.state, "error");
  assert.equal(o.externalId, "");
  assert.match(
    o.lastError,
    /^publish outcome unknown — may be live on Eldorado \(no id\)/,
  );
  assert.equal(entries(o, "on_offer").length, 5, "6 accounts = one pack of 5");
  assert.equal(st.releaseCalls.length, 0);

  mk.fail.publishAccounts = {
    message: "the pack would not fit Eldorado's title limit",
    code: "BULK_PACK_REFUSED",
  };
  const r2 = await sendDropset(set, "eldorado", { units: 6 });
  assert.equal(r2.status, 502);
  assert.match(r2.message, /Eldorado refused the offer/);
  const o2 = await offerOf(r2.offer._id);
  assert.equal(entries(o2, "released").length, 5);
  assert.equal(st.held.size, 5, "only the held offer's 5 stay reserved");
});

test("farm and no-claim publishes with an unknown outcome close with the id they may be live under (S2/S5)", async () => {
  mk.fail.publishFarm = {
    message: "Eldorado create: timeout",
    outcome: "may_be_live",
    externalId: "FARM-X",
  };
  const f = await farm(120, 5);
  assert.equal(f.status, 502);
  const fo = await offerOf(f.offer._id);
  assert.equal(fo.state, "error");
  assert.equal(fo.open, false);
  assert.equal(fo.externalId, "FARM-X");
  assert.match(
    fo.lastError,
    /^publish outcome unknown — may be live on Eldorado \(FARM-X\): check it and take it down by hand/,
  );
  assert.ok(telegrams.some((t) => /UNKNOWN/.test(t) && /FARM-X/.test(t)));

  const nset = await makeSet({
    name: "OW no-claim",
    stockSource: "noclaim",
    items: [{ itemKey: "ow:1", name: "Skin", game: "Overwatch" }],
  });
  st.noclaim = { free: 30, share: { eldorado: 12, g2g: 12 } };
  mk.fail.publishNoclaim = {
    message: "G2G publish: offer NC-9 did not read back as a live offer",
    outcome: "may_be_live",
    externalId: "NC-9",
  };
  const n = await send.sendOffer({
    source: "noclaim",
    setId: String(nset._id),
    market: "g2g",
    minQty: 5,
  });
  assert.equal(n.status, 502);
  const no = await offerOf(n.offer._id);
  assert.equal(no.state, "error");
  assert.equal(no.externalId, "NC-9");
  assert.match(no.lastError, /Listings → Shop listings/);
});

// ---------------------------------------------------------------------------
// releaseHeld
// ---------------------------------------------------------------------------

test("releaseHeld: typed RELEASE, off the market first, then the held entries retire for the loop", async () => {
  const set = await makeSet();
  st.pool = accounts(14);
  mk.fail.publishAccounts = {
    message: "G2G publish: offer G2G-777 did not read back as a live offer",
    outcome: "may_be_live",
    externalId: "G2G-777",
  };
  const r = await sendDropset(set, "g2g", { units: 8 });
  mk.fail = {};
  const id = String(r.offer._id);

  for (const confirm of [undefined, "", "release", "yes", true]) {
    const bad = await send.releaseHeld({ offerId: id, confirm, actor: "o" });
    assert.equal(bad.status, 400, String(confirm));
    assert.equal(bad.success, false);
  }
  assert.equal(
    (await send.releaseHeld({ offerId: "nope", confirm: "RELEASE" })).status,
    404,
  );
  assert.equal(called("withdraw").length, 0);

  // The market will not take it down: nothing is released.
  mk.fail.withdraw = "G2G delist: HTTP 503";
  const refused = await send.releaseHeld({
    offerId: id,
    confirm: "RELEASE",
    actor: "owner",
  });
  assert.equal(refused.status, 409);
  assert.match(refused.message, /Nothing released/);
  assert.deepEqual(
    called("withdraw").map((c) => [c[1], c[2]]),
    [["g2g", "G2G-777"]],
  );
  let o = await offerOf(id);
  assert.equal(entries(o, "on_offer").length, 5, "8 accounts = one pack of 5");

  mk.fail = {};
  const t0 = Date.now();
  const ok = await send.releaseHeld({
    offerId: id,
    confirm: "RELEASE",
    actor: "owner",
  });
  assert.equal(ok.status, 200, ok.message);
  assert.equal(ok.success, true);
  o = await offerOf(id);
  assert.equal(entries(o, "retiring").length, 5);
  assert.ok(
    entries(o, "retiring").every(
      (e) => e.changedAt && e.changedAt.getTime() >= t0,
    ),
    "changedAt now: the loop's grace starts here",
  );
  assert.equal(entries(o, "on_offer").length, 0);
  assert.equal(
    st.releaseCalls.length,
    0,
    "the loop's phase 2 hands them back after the grace, not the click",
  );
  assert.equal(st.held.size, 5);
  assert.equal(o.state, "error");
  assert.equal(o.open, false);
  assert.ok(o.history.some((h) => h.action === "release_held"));
  assert.ok(events.some((e) => e.action === "release_held"));

  const again = await send.releaseHeld({ offerId: id, confirm: "RELEASE" });
  assert.equal(again.status, 409, "nothing held any more");

  const live = await sendDropset(set, "eldorado", { units: 5 });
  assert.equal(live.status, 200, live.message);
  const open = await send.releaseHeld({
    offerId: String(live.offer._id),
    confirm: "RELEASE",
  });
  assert.equal(open.status, 409);
  assert.match(open.message, /still open/);
});

test("releaseHeld: a withdraw answering 'no such offer' (404) proceeds; a failure that proves nothing releases nothing", async () => {
  const set = await makeSet();
  st.pool = accounts(24);
  const hold = async (market, externalId) => {
    mk.fail = {
      publishAccounts: {
        message: market + " publish failed mid-way",
        outcome: "may_be_live",
        externalId,
      },
    };
    const r = await sendDropset(set, market, { units: 5 });
    mk.fail = {};
    assert.equal(r.status, 502, r.message);
    return String(r.offer._id);
  };
  const release = (offerId) =>
    send.releaseHeld({ offerId, confirm: "RELEASE", actor: "owner" });
  const stillHeld = async (offerId) =>
    entries(await offerOf(offerId), "on_offer").length;

  // Gameflip: any failure but "no such listing" leaves the pack held.
  const gid = await hold("gameflip", "L9");
  for (const fail of [
    "Gameflip delist: HTTP 503",
    { message: "Gameflip delist: Too many requests", status: 429 },
    "Gameflip delist: timeout of 30000ms exceeded",
  ]) {
    mk.fail = { withdraw: fail };
    const r = await release(gid);
    assert.equal(r.status, 409, JSON.stringify(fail));
    assert.match(r.message, /Nothing released/);
    assert.equal(await stillHeld(gid), 5);
  }
  mk.fail = { withdraw: "Gameflip delist: listing already sold" };
  const sold = await release(gid);
  assert.equal(sold.status, 409);
  assert.match(sold.message, /SOLD/);
  assert.equal(await stillHeld(gid), 5);
  // Its own draft discard deleted the listing: a 404 means "not live".
  mk.fail = {
    withdraw: {
      message: "Gameflip delist: Request failed with status code 404",
      status: 404,
    },
  };
  const gone = await release(gid);
  assert.equal(gone.status, 200, gone.message);
  assert.match(gone.message, /no such offer on Gameflip/);
  assert.equal(entries(await offerOf(gid), "retiring").length, 5);
  assert.equal(st.releaseCalls.length, 0, "the loop releases, after its grace");

  // Eldorado: a 5xx proves nothing; "not found" says it does not exist.
  // ("must be active" and the other already-off-sale answers: FIXES-2 V5,
  // tested below.)
  const eid = await hold("eldorado", "E-5");
  mk.fail = { withdraw: "Eldorado pause: HTTP 500 upstream" };
  assert.equal((await release(eid)).status, 409);
  assert.equal(await stillHeld(eid), 5);
  mk.fail = { withdraw: 'Eldorado delist: {"message":"Offer not found"}' };
  const eok = await release(eid);
  assert.equal(eok.status, 200, eok.message);
  assert.match(eok.message, /no such offer on Eldorado/);
  assert.equal(entries(await offerOf(eid), "retiring").length, 5);

  // G2G: a 404 status on the error proceeds as well.
  const g2 = await hold("g2g", "G-7");
  mk.fail = { withdraw: { message: "G2G delist failed", status: 404 } };
  const g2ok = await release(g2);
  assert.equal(g2ok.status, 200, g2ok.message);
  assert.equal(entries(await offerOf(g2), "retiring").length, 5);

  // A hold with no id: nothing to take down, the entries just retire.
  mk.fail = { publishAccounts: "socket hang up" };
  const n = await sendDropset(set, "g2g", { units: 5 });
  mk.fail = {};
  const before = called("withdraw").length;
  const ok3 = await send.releaseHeld({
    offerId: String(n.offer._id),
    confirm: "RELEASE",
  });
  assert.equal(ok3.status, 200, ok3.message);
  assert.equal(called("withdraw").length, before, "no id, no market call");
  assert.equal(entries(await offerOf(n.offer._id), "retiring").length, 5);
});

test("releaseHeld never hands back a kept (keepReserved) account or one a buyer received", async () => {
  const set = await makeSet();
  const [a, b, c] = accounts(3);
  for (const x of [a, b, c]) st.held.set(x.accountId, "eldorado");
  const offer = await BulkOffer.create({
    kind: "accounts",
    source: "dropset",
    market: "eldorado",
    set: set._id,
    minQty: 5,
    title: "Rust pack",
    state: "error",
    externalId: "E-1",
    slotKey: "accounts|dropset|" + set._id + "|eldorado|5",
    reserved: [
      { accountId: a.accountId, login: a.login, keepReserved: true },
      { accountId: b.accountId, login: b.login },
      { accountId: c.accountId, login: c.login },
    ],
  });
  const row = await MarketplaceListing.create({
    set: set._id,
    marketplace: "eldorado",
    externalId: "E-1",
    title: "Rust pack",
    price: 1.9,
    status: "delisted",
    origin: "manual",
    bulkOfferId: offer._id,
    units: [
      {
        accountId: b.accountId,
        login: b.login,
        deliveredAt: new Date(),
        orderId: "ORD-B",
      },
      { accountId: c.accountId, login: c.login },
    ],
  });
  await BulkOffer.updateOne({ _id: offer._id }, { $set: { listing: row._id } });

  const r = await send.releaseHeld({
    offerId: String(offer._id),
    confirm: "RELEASE",
    actor: "owner",
  });
  assert.equal(r.status, 200, r.message);
  const o = await offerOf(offer._id);
  const by = (id) => o.reserved.find((e) => e.accountId === id);
  assert.equal(by(a.accountId).state, "on_offer", "kept: left exactly as is");
  assert.equal(by(a.accountId).keepReserved, true);
  assert.equal(by(b.accountId).state, "delivered", "the buyer's");
  assert.equal(by(b.accountId).orderId, "ORD-B");
  assert.equal(by(c.accountId).state, "retiring");
  assert.equal(st.releaseCalls.length, 0);
  assert.equal(st.held.size, 3);

  const again = await send.releaseHeld({
    offerId: String(offer._id),
    confirm: "RELEASE",
  });
  assert.equal(again.status, 409);
  assert.match(again.message, /taken out of the pack/);
});

// FIXES-2 V5: marketplaces.delistOutcome decides. "gone" (not found / 404,
// "must be active", already paused / inactive / delisted…) is what the
// take-down was for; "sold" refuses and says so; anything else refuses.
test("V5 releaseHeld: a take-down that says the offer is already not live proceeds; 'sold' refuses and says so; anything else refuses as before", async () => {
  const set = await makeSet();
  st.pool = accounts(80);
  let n = 0;
  const hold = async (market) => {
    const externalId = market.toUpperCase() + "-V5-" + ++n;
    mk.fail = {
      publishAccounts: {
        message: market + " publish failed mid-way",
        outcome: "may_be_live",
        externalId,
      },
    };
    const r = await sendDropset(set, market, { units: 5 });
    mk.fail = {};
    assert.equal(r.status, 502, r.message);
    return String(r.offer._id);
  };
  const releaseWith = async (offerId, fail) => {
    mk.fail = { withdraw: fail };
    try {
      return await send.releaseHeld({
        offerId,
        confirm: "RELEASE",
        actor: "owner",
      });
    } finally {
      mk.fail = {};
    }
  };

  // Already not live: the held entries retire for the loop, as after a
  // successful take-down.
  for (const [market, fail, note] of [
    [
      "eldorado",
      'Eldorado pause: {"message":"To pause an offer it must be active"}',
      /already off sale on Eldorado/,
    ],
    [
      "eldorado",
      "Eldorado delist failed (HTTP 400): To pause an offer it must be active.",
      /already off sale on Eldorado/,
    ],
    [
      "eldorado",
      "Eldorado delist: offer already paused",
      /already off sale on Eldorado/,
    ],
    [
      "g2g",
      "G2G update offer: offer already delisted",
      /already off sale on G2G/,
    ],
    // The verdict markets.js attaches (the same classifier) counts too.
    [
      "g2g",
      { message: "G2G update offer failed (HTTP 400)", outcome: "gone" },
      /already off sale on G2G/,
    ],
    [
      "gameflip",
      "Gameflip delist: listing already inactive",
      /already off sale on Gameflip/,
    ],
  ]) {
    const id = await hold(market);
    const r = await releaseWith(id, fail);
    assert.equal(r.status, 200, JSON.stringify(fail) + " -> " + r.message);
    assert.equal(r.success, true);
    assert.match(r.message, note);
    const o = await offerOf(id);
    assert.equal(entries(o, "on_offer").length, 0, JSON.stringify(fail));
    assert.equal(entries(o, "retiring").length, 5, "the loop hands them back");
    assert.ok(o.history.some((h) => h.action === "release_held"));
  }
  assert.equal(st.releaseCalls.length, 0, "never released by the click itself");

  // Sold: refused, and the answer says so. Nothing moves.
  for (const [market, fail] of [
    ["gameflip", "Gameflip delist: listing already sold"],
    [
      "gameflip",
      { message: "Gameflip delist failed (HTTP 409)", outcome: "sold" },
    ],
    ["eldorado", "Eldorado delist: offer (sold)"],
  ]) {
    const id = await hold(market);
    const r = await releaseWith(id, fail);
    assert.equal(r.status, 409, JSON.stringify(fail));
    assert.equal(r.success, false);
    assert.match(r.message, /^Nothing released — .* already SOLD/);
    const o = await offerOf(id);
    assert.equal(entries(o, "on_offer").length, 5, "still held");
    assert.equal(entries(o, "retiring").length, 0);
    assert.match(o.lastError, /SOLD/);
    assert.ok(o.history.some((h) => h.action === "release_held_refused"));
  }

  // Anything else proves nothing: refused exactly as before.
  for (const [market, fail] of [
    ["eldorado", "Eldorado pause: HTTP 500 upstream"],
    ["g2g", { message: "G2G update offer: Too many requests", status: 429 }],
    ["gameflip", "Gameflip delist: timeout of 20000ms exceeded"],
    // A dead session says nothing about the offer.
    ["eldorado", "Eldorado delist: session expired — log in again"],
  ]) {
    const id = await hold(market);
    const r = await releaseWith(id, fail);
    assert.equal(r.status, 409, JSON.stringify(fail));
    assert.match(r.message, /^Nothing released — .* did not take .* down/);
    assert.doesNotMatch(r.message, /SOLD/);
    assert.equal(entries(await offerOf(id), "on_offer").length, 5);
  }
  assert.equal(st.releaseCalls.length, 0);
});

// ---------------------------------------------------------------------------
// S3 — no pointer is not "no row"
// ---------------------------------------------------------------------------

test("stuckSendingWithdraw: withdrawing an offer stuck in 'sending' finds its row by bulkOfferId and never releases a delivered account (S3)", async () => {
  const set = await makeSet();
  st.pool = accounts(12, "stuck");
  // One failed write: the "live" update at the end of the send.
  let failed = false;
  const flaky = new Proxy(BulkOffer, {
    get(t, k) {
      if (k === "updateOne") {
        return async (filter, update, ...rest) => {
          if (
            !failed &&
            update &&
            update.$set &&
            update.$set.state === "live"
          ) {
            failed = true;
            throw new Error("MongoNetworkError: connection reset");
          }
          return t.updateOne(filter, update, ...rest);
        };
      }
      const v = t[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  send.__setDeps({ BulkOffer: flaky });
  const r = await sendDropset(set, "eldorado", { units: 10 });
  send.__setDeps({ BulkOffer });
  assert.ok(failed, "the interleaving happened");
  assert.equal(r.status, 500);
  const offer0 = await BulkOffer.findOne({}).lean();
  assert.equal(offer0.state, "sending");
  assert.equal(offer0.listing, null);
  assert.equal(offer0.externalId, "EXT-1");
  const row0 = await rowOf(offer0._id);
  assert.equal(row0.status, "active");
  assert.equal(row0.units.length, 10);

  // The row sells normally: one order takes 6.
  const soldIds = row0.units.slice(0, 6).map((u) => u.accountId);
  await deliver(row0._id, soldIds, "stuck-order-1");

  // 20 minutes later the owner withdraws (what the loop's "stuck in
  // sending" flag asks for).
  const old = new Date(Date.now() - 20 * 60e3);
  await BulkOffer.collection.updateOne(
    { _id: offer0._id },
    { $set: { updatedAt: old, createdAt: old } },
  );
  const w = await send.withdrawOffer({
    offerId: String(offer0._id),
    actor: "owner",
  });
  assert.equal(w.status, 200, w.message);
  assert.deepEqual(
    called("withdraw").map((c) => [c[1], c[2]]),
    [["eldorado", "EXT-1"]],
  );
  assert.equal(
    (await MarketplaceListing.findById(row0._id).lean()).status,
    "delisted",
  );
  const o = await offerOf(offer0._id);
  assert.equal(o.state, "withdrawn");
  assert.equal(String(o.listing), String(row0._id), "the pointer is repaired");
  const delivered = entries(o, "delivered");
  assert.deepEqual(
    delivered.map((e) => e.accountId).sort(),
    [...soldIds].sort(),
  );
  assert.ok(delivered.every((e) => e.orderId === "stuck-order-1"));
  assert.equal(entries(o, "retiring").length, 4, "the free 4 retire (I10)");
  assert.equal(entries(o, "on_offer").length, 0);
  assert.equal(entries(o, "released").length, 0);
  for (const id of soldIds) {
    assert.equal(st.held.get(id), "eldorado", "a sold account stays reserved");
  }
  assert.equal(st.releaseCalls.length, 0, "nothing released directly");
  assert.equal(loopState.calls.length, 1);
  assert.ok(loopState.calls[0].accountIds.every((id) => !soldIds.includes(id)));
});

test("an interrupted send whose row exists but whose id was never recorded is taken down through the row, not abandoned (S3)", async () => {
  const set = await makeSet();
  const list = accounts(6);
  for (const a of list) st.held.set(a.accountId, "eldorado");
  const offer = await BulkOffer.create({
    kind: "accounts",
    source: "dropset",
    market: "eldorado",
    set: set._id,
    minQty: 5,
    title: "Rust pack",
    state: "sending",
    slotKey: "accounts|dropset|" + set._id + "|eldorado|5",
    reserved: list.map((a) => ({ accountId: a.accountId, login: a.login })),
  });
  const row = await MarketplaceListing.create({
    set: set._id,
    marketplace: "eldorado",
    externalId: "EXT-9",
    title: "Rust pack",
    price: 1.9,
    status: "active",
    origin: "manual",
    bulkOfferId: offer._id,
    qtyTarget: 6,
    units: list.map((a) => ({ accountId: a.accountId, login: a.login })),
  });
  await deliver(row._id, [list[0].accountId, list[1].accountId], "ORD-9");
  const old = new Date(Date.now() - send.SENDING_STALE_MS - 60000);
  await BulkOffer.collection.updateOne(
    { _id: offer._id },
    { $set: { updatedAt: old } },
  );

  const w = await send.withdrawOffer({
    offerId: String(offer._id),
    actor: "owner",
  });
  assert.equal(w.status, 200, w.message);
  assert.deepEqual(
    called("withdraw").map((c) => [c[1], c[2]]),
    [["eldorado", "EXT-9"]],
  );
  const o = await offerOf(offer._id);
  assert.equal(o.state, "withdrawn");
  assert.equal(o.externalId, "EXT-9");
  assert.equal(String(o.listing), String(row._id));
  assert.equal(entries(o, "delivered").length, 2);
  assert.equal(entries(o, "retiring").length, 4);
  assert.equal(st.releaseCalls.length, 0);
  assert.equal(st.held.size, 6);
  assert.ok(!telegrams.some((t) => /interrupted/.test(t)));
});

// ---------------------------------------------------------------------------
// S4/S6 — one lock per offer, shared with the loop; fresh reads inside it
// ---------------------------------------------------------------------------

test("refillRace: a loop pass waits for a refill, so its accounts are never released while on the row (S4/S6)", async () => {
  const set = await makeSet();
  st.pool = accounts(20, "race");
  const sent = await sendDropset(set, "eldorado", { units: 5 });
  assert.equal(sent.status, 200, sent.message);
  const offerId = String(sent.offer._id);

  // A maintenance pass comes due right between refill's reserved[] write and
  // its first row $push (the reviewer's interleaving).
  let pass = null;
  let passFinishedMidRefill = null;
  const racing = new Proxy(MarketplaceListing, {
    get(t, k) {
      if (k === "updateOne") {
        return async (filter, update, ...rest) => {
          if (!pass && update && update.$push && update.$push.units) {
            pass = track(loopPass(offerId, clobberHeal));
            passFinishedMidRefill = await settleWithin(pass, 250);
          }
          return t.updateOne(filter, update, ...rest);
        };
      }
      const v = t[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  send.__setDeps({ MarketplaceListing: racing });
  const r1 = await send.refillOffer({ offerId, add: 5, actor: "t" });
  send.__setDeps({ MarketplaceListing });
  assert.ok(pass, "the pass came due mid-refill");
  assert.equal(passFinishedMidRefill, false, "it waited for the offer's lock");
  assert.deepEqual(await pass.promise, [], "nothing to heal after the refill");
  assert.equal(r1.status, 200, r1.message);
  assert.match(r1.message, /\+5 account/);

  const offer = await offerOf(offerId);
  const row = await rowOf(offerId);
  assert.equal(entries(offer, "on_offer").length, 10);
  assert.equal(entries(offer, "released").length, 0);
  assert.equal(st.releaseCalls.length, 0);
  assert.equal(row.units.length, 10);
  assert.equal(new Set(row.units.map((u) => u.accountId)).size, 10);
  for (const e of entries(offer)) {
    assert.equal(st.held.get(e.accountId), "eldorado", "still reserved");
  }
  assert.deepEqual(
    called("setQuantity").map((c) => c[3]),
    [2],
    "10 free accounts = 2 packs of 5",
  );
  assert.equal(offer.advertisedQty, 2);
});

test("refillRace backstop: even a pass that slips in without the lock cannot make a refill release accounts on the row", async () => {
  const set = await makeSet();
  st.pool = accounts(20, "race");
  const sent = await sendDropset(set, "eldorado", { units: 5 });
  const offerId = String(sent.offer._id);
  let healed = null;
  const racing = new Proxy(MarketplaceListing, {
    get(t, k) {
      if (k === "updateOne") {
        return async (filter, update, ...rest) => {
          if (!healed && update && update.$push && update.$push.units) {
            healed = await loopPass(offerId, clobberHeal, { useLock: false });
          }
          return t.updateOne(filter, update, ...rest);
        };
      }
      const v = t[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  send.__setDeps({ MarketplaceListing: racing });
  const r1 = await send.refillOffer({ offerId, add: 5, actor: "t" });
  send.__setDeps({ MarketplaceListing });
  assert.equal(
    healed.length,
    5,
    "the pass put the 5 new units on the row first",
  );
  assert.equal(r1.status, 200, r1.message);
  assert.match(r1.message, /\+5 account/);
  const offer = await offerOf(offerId);
  const row = await rowOf(offerId);
  assert.equal(entries(offer, "on_offer").length, 10);
  assert.equal(entries(offer, "released").length, 0, "none released");
  assert.equal(st.releaseCalls.length, 0);
  assert.equal(row.units.length, 10);
  assert.equal(new Set(row.units.map((u) => u.accountId)).size, 10);
  assert.deepEqual(
    called("setQuantity").map((c) => c[3]),
    [2],
  );
});

test("refillSoldOutStrand: a refill clicked while the loop closes the offer sold-out is refused and strands nothing (S4/S6)", async () => {
  const set = await makeSet();
  st.pool = accounts(12, "strand");
  const sent = await sendDropset(set, "eldorado", { units: 5 });
  assert.equal(sent.status, 200, sent.message);
  const offerId = String(sent.offer._id);
  const row = await rowOf(offerId);
  // One sale takes all 5: 0 left < minimum 5, the next pass closes it.
  await deliver(
    row._id,
    row.units.map((u) => u.accountId),
    "strand-1",
  );

  // The owner clicks Refill while that pass is inside markets.pause.
  let refill = null;
  let refillFinishedMidPass = null;
  await loopPass(offerId, (offer, r) =>
    closeSoldOut(offer, r, async () => {
      refill = track(send.refillOffer({ offerId, add: 5, actor: "owner" }));
      refillFinishedMidPass = await settleWithin(refill, 250);
    }),
  );
  assert.ok(refill, "the pass reached markets.pause");
  const res = await refill.promise;
  assert.equal(refillFinishedMidPass, false, "the refill waited for the pass");
  assert.equal(res.status, 409);
  assert.match(res.message, /sold_out/);
  assert.equal(st.reserveCalls.length, 1, "only the send ever reserved");
  const offer = await offerOf(offerId);
  assert.equal(offer.open, false);
  assert.equal(offer.state, "sold_out");
  assert.equal(entries(offer).length, 5);
  assert.equal(entries(offer, "delivered").length, 5);
  assert.equal(entries(offer, "on_offer").length, 0, "nothing stranded");
  assert.equal((await rowOf(offerId)).status, "delisted");
});

test("withdraw, pause and resume wait for the offer's lock and act on what they re-read inside it (S4/S6)", async () => {
  const set = await makeSet();
  st.pool = accounts(12);
  const sent = await sendDropset(set, "eldorado", { units: 6 });
  const offerId = String(sent.offer._id);
  await BulkOffer.updateOne(
    { _id: sent.offer._id },
    { $set: { state: "paused" } },
  );
  const clicks = {};
  await loopPass(offerId, async (offer, row) => {
    // The router may hand the id over in capitals: same offer, same lock.
    clicks.withdraw = track(
      send.withdrawOffer({ offerId: offerId.toUpperCase(), actor: "owner" }),
    );
    clicks.pause = track(send.pauseOffer({ offerId, actor: "owner" }));
    clicks.resume = track(send.resumeOffer({ offerId, actor: "owner" }));
    assert.equal(await settleWithin(clicks.withdraw, 150), false);
    assert.equal(clicks.pause.done, false);
    assert.equal(clicks.resume.done, false);
    // Meanwhile the pass finds it expired on Eldorado and closes it.
    await MarketplaceListing.updateOne(
      { _id: row._id, status: "active" },
      { $set: { status: "removed" } },
    );
    await BulkOffer.updateOne(
      { _id: offer._id, open: true },
      { $set: { state: "expired", open: false, closedAt: new Date() } },
    );
  });
  const [w, p, rs] = await Promise.all([
    clicks.withdraw.promise,
    clicks.pause.promise,
    clicks.resume.promise,
  ]);
  assert.equal(w.status, 409);
  assert.match(w.message, /already closed \(expired\)/);
  assert.equal(p.status, 409);
  assert.equal(rs.status, 409);
  assert.equal(called("withdraw").length, 0);
  assert.equal(called("pause").length, 0);
  assert.equal(called("resume").length, 0);
  assert.equal(called("setQuantity").length, 0);
  assert.equal(loopState.calls.length, 0);
});

test("sendOffer holds the new offer's lock from its creation: a withdraw clicked mid-publish waits for the send", async () => {
  const set = await makeSet();
  st.pool = accounts(12);
  let click = null;
  let finishedMidPublish = null;
  mk.onPublish = async () => {
    const o = await BulkOffer.findOne({ state: "sending" }).lean();
    // Even an offer that looks long stuck is never abandoned under its send.
    await BulkOffer.collection.updateOne(
      { _id: o._id },
      {
        $set: {
          updatedAt: new Date(Date.now() - send.SENDING_STALE_MS - 60000),
        },
      },
    );
    click = track(send.withdrawOffer({ offerId: String(o._id), actor: "o" }));
    finishedMidPublish = await settleWithin(click, 150);
  };
  const r = await sendDropset(set, "eldorado", { units: 6 });
  assert.equal(r.status, 200, r.message);
  assert.equal(finishedMidPublish, false, "the withdraw waited for the send");
  const w = await click.promise;
  assert.equal(w.status, 200, w.message);
  assert.match(w.message, /^Withdrawn/);
  assert.deepEqual(
    called("withdraw").map((c) => [c[1], c[2]]),
    [["eldorado", "EXT-1"]],
  );
  const o = await offerOf(r.offer._id);
  assert.equal(o.state, "withdrawn");
  assert.equal(entries(o, "retiring").length, 5, "6 accounts = one pack of 5");
  assert.equal(st.releaseCalls.length, 0);
});

test("a no-claim send whose shelf shrank below one pack mid-publish takes itself down inside its own lock (no deadlock)", async () => {
  const set = await makeSet({
    name: "OW no-claim",
    stockSource: "noclaim",
    items: [{ itemKey: "ow:1", name: "Skin", game: "Overwatch" }],
  });
  st.noclaim = { free: 30, share: { eldorado: 12, g2g: 12 } };
  // 2 packs asked for; the layer capped it to 1, and this row's own share
  // (3 accounts) is not one whole pack of 5.
  mk.noclaimLanded = 1;
  nc.share = 3;
  const r = await Promise.race([
    send.sendOffer({
      source: "noclaim",
      setId: String(set._id),
      market: "eldorado",
      minQty: 5,
      actor: "t",
    }),
    sleep(3000).then(() => ({ status: "timeout" })),
  ]);
  assert.notEqual(r.status, "timeout", "the send never waits on its own lock");
  assert.equal(r.status, 409);
  assert.match(r.message, /shrank while publishing/);
  const o = await BulkOffer.findOne({}).lean();
  assert.equal(o.state, "withdrawn");
  assert.deepEqual(
    called("withdraw").map((c) => c[1]),
    ["eldorado"],
  );
  assert.deepEqual(
    ncl.calls.map((c) => c[0]),
    ["beforeDelist", "afterDelist"],
  );
});

test("withdrawing a Gameflip pack never hands back an account the owner took out of it (keepReserved)", async () => {
  const set = await makeSet();
  st.pool = accounts(12);
  const g = await sendDropset(set, "gameflip");
  assert.equal(g.status, 200, g.message);
  const offer0 = await offerOf(g.offer._id);
  const kept = offer0.reserved[0].accountId;
  await BulkOffer.updateOne(
    { _id: offer0._id, "reserved.accountId": kept },
    { $set: { "reserved.$.keepReserved": true } },
  );
  const w = await send.withdrawOffer({
    offerId: String(offer0._id),
    actor: "owner",
  });
  assert.equal(w.status, 200, w.message);
  assert.match(w.message, /1 kept reserved/);
  const o = await offerOf(offer0._id);
  const k = o.reserved.find((e) => e.accountId === kept);
  assert.equal(k.state, "on_offer");
  assert.equal(k.keepReserved, true);
  assert.equal(entries(o, "released").length, 4);
  assert.equal(st.held.get(kept), "gameflip", "its reservation is kept");
  assert.ok(!st.releaseCalls.some((c) => c.accountIds.includes(kept)));
});

// ---------------------------------------------------------------------------
// S1 — farm capacity is shared; S8 — quantity before resume
// ---------------------------------------------------------------------------

test("farmOvercommit: farm offers split one capacity; a send whose share is below its minimum is refused (S1)", async () => {
  // advertisable = min(farmMaxQty 20, room 30, 60 - 20, 45 - 20) = 20: the
  // reviewer saw three offers advertise 20 each (60 > 45 pristine).
  cap.value = {
    bestStackRoom: 30,
    totalFree: 60,
    pristine: 45,
    at: new Date(),
    error: "",
  };
  const a = await farm(120, 5, { units: 7 });
  assert.equal(a.status, 200, a.message);
  assert.equal(
    a.offer.advertisedQty,
    1,
    "alone: its share is 20, the owner's 7 caps it: one pack of 5",
  );
  const b = await farm(180, 5);
  assert.equal(b.status, 200, b.message);
  assert.equal(b.offer.advertisedQty, 2, "20 shared by 2 open farm offers: 10 = 2 packs");
  const c = await farm(365, 10);
  assert.equal(c.status, 409);
  assert.match(
    c.message,
    /capacity is already advertised by 2 other farm offer\(s\)/,
  );
  assert.equal((await offerOf(c.offer._id)).state, "error");
  assert.deepEqual(
    called("publishFarm").map((x) => x[1].quantity),
    [1, 2],
    "the third was never published",
  );
  const d = await farm(365, 5);
  assert.equal(d.status, 200, d.message);
  const ids = [a, b, d].map((x) => String(x.offer._id)).sort();
  const dShare = shareOfShelf(20, String(d.offer._id), ids);
  assert.ok(dShare < 20 / 2, "a third sharer gets a third");
  assert.equal(d.offer.advertisedQty, packsFor(dShare, 5));
  assert.equal(called("publishFarm")[2][1].quantity, packsFor(dShare, 5));
});

test("a farm offer resumes at its share of the capacity, quantity first; too small a share is refused (S1, S8)", async () => {
  cap.value = {
    bestStackRoom: 30,
    totalFree: 60,
    pristine: 45,
    at: new Date(),
    error: "",
  };
  const a = await farm(120, 5);
  const b = await farm(180, 5);
  assert.equal(b.status, 200, b.message);
  const bid = String(b.offer._id);
  const p = await send.pauseOffer({ offerId: bid, actor: "owner" });
  assert.equal(p.status, 200, p.message);

  // Capacity shrinks to 8: B's share (4) is below its minimum of 5.
  cap.value = { ...cap.value, pristine: 28 };
  mk.calls = [];
  const short = await send.resumeOffer({ offerId: bid, actor: "owner" });
  assert.equal(short.status, 409);
  assert.match(
    short.message,
    /capacity is already advertised by 1 other farm offer\(s\)/,
  );
  assert.equal(mk.calls.length, 0, "no quantity change, no resume");

  cap.value = { ...cap.value, pristine: 45 };
  const ok = await send.resumeOffer({ offerId: bid, actor: "owner" });
  assert.equal(ok.status, 200, ok.message);
  const share = shareOfShelf(20, bid, [String(a.offer._id), bid]);
  assert.deepEqual(
    mk.calls.map((c) => c[0]),
    ["setQuantity", "resume"],
    "the quantity first",
  );
  assert.equal(mk.calls[0][3], packsFor(share, 5), "in packs");
  assert.equal(ok.offer.advertisedQty, packsFor(share, 5));
  assert.equal(ok.offer.state, "live");
});

test("S8: resume sets the quantity first — a quantity the market refused never goes live", async () => {
  const set = await makeSet();
  st.pool = accounts(12);
  const r = await sendDropset(set, "eldorado", { units: 10 });
  const id = String(r.offer._id);
  assert.equal(r.offer.advertisedQty, 2);
  assert.equal((await send.pauseOffer({ offerId: id })).status, 200);
  const row = await rowOf(id);
  await deliver(row._id, [row.units[0].accountId], "ORD-1"); // 9 left = 1 pack

  mk.calls = [];
  mk.fail.setQuantity = "Eldorado set quantity: HTTP 500";
  const bad = await send.resumeOffer({ offerId: id, actor: "owner" });
  assert.equal(bad.status, 502);
  assert.match(bad.message, /NOT resumed/);
  assert.deepEqual(
    mk.calls.map((c) => c[0]),
    ["setQuantity"],
    "never resumed",
  );
  let o = await offerOf(id);
  assert.equal(o.state, "paused");
  assert.equal(o.advertisedQty, 2, "still what the market last accepted");
  assert.match(o.lastError, /quantity update failed/);

  mk.fail = {};
  mk.calls = [];
  const ok = await send.resumeOffer({ offerId: id, actor: "owner" });
  assert.equal(ok.status, 200, ok.message);
  assert.deepEqual(
    mk.calls.map((c) => [c[0], c[3]]),
    [
      ["setQuantity", 1],
      ["resume", undefined],
    ],
  );
  assert.equal(ok.offer.advertisedQty, 1);
  assert.equal(ok.offer.state, "live");
});

// ---------------------------------------------------------------------------
// FIXES-2 V1 (send side) — a farm offer going live re-splits the capacity now
// ---------------------------------------------------------------------------

// What loop.resplitFarm does (FIXES-2 V1, loop side), as far as send.js is
// concerned: every open farm offer (sending | live | paused), each under its
// own lock, is synced NOW to its share of the capacity — shrinking first.
async function simulatedResplit() {
  const available = fakeFarmCapacity.advertisable(
    await fakeFarmCapacity.read(),
    fakeSettings.getBulkPacks(),
  );
  const ids = (
    await BulkOffer.find(
      {
        source: "farm",
        open: true,
        state: { $in: ["sending", "live", "paused"] },
      },
      { _id: 1 },
    ).lean()
  )
    .map((o) => String(o._id))
    .sort();
  for (const growing of [false, true]) {
    for (const id of ids) {
      await fakeLock.withOfferLock(id, async () => {
        const o = await offerOf(id);
        if (!o || o.state !== "live") return;
        // PACKS-2 §4: each offer's share (accounts) -> whole packs.
        const packs = packsFor(shareOfShelf(available, id, ids), o.minQty);
        const had = Number(o.advertisedQty) || 0;
        if (growing ? packs <= had : packs >= had) return;
        await fakeMarkets.setQuantity(o.market, o.externalId, packs);
        await BulkOffer.updateOne(
          { _id: o._id },
          { $set: { advertisedQty: packs } },
        );
      });
    }
  }
}

// A call that deadlocks (a re-split waiting on the caller's own lock) fails
// the test instead of hanging it.
function inTime(p, ms = 3000) {
  return Promise.race([p, sleep(ms).then(() => ({ status: "timeout" }))]);
}

async function quietErrors(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.map(String).join(" "));
  try {
    return { value: await fn(), lines };
  } finally {
    console.error = orig;
  }
}

test("V1: a farm send re-splits the capacity once its own lock is released — the older offer is cut to its share at once", async () => {
  loopState.resplitImpl = simulatedResplit;
  // advertisable = min(farmMaxQty 20, room 30, 60 - 20, 60 - 20) = 20.
  const a = await inTime(farm(120, 5));
  assert.equal(a.status, 200, a.message);
  assert.equal((await offerOf(a.offer._id)).advertisedQty, 4, "alone: 20 accounts = 4 packs");
  mk.calls = [];
  // The reviewer's repro: with no re-split, A keeps advertising all 20 until
  // its own farm sync while B advertises its share of [A, B] — 30 for 20.
  const b = await inTime(farm(180, 5));
  assert.notEqual(
    b.status,
    "timeout",
    "the re-split never waits on the send's own lock",
  );
  assert.equal(b.status, 200, b.message);
  const ids = [String(a.offer._id), String(b.offer._id)].sort();
  const aNow = await offerOf(a.offer._id);
  const bNow = await offerOf(b.offer._id);
  assert.equal(bNow.advertisedQty, packsFor(shareOfShelf(20, String(bNow._id), ids), 5));
  assert.equal(
    aNow.advertisedQty,
    packsFor(shareOfShelf(20, String(aNow._id), ids), 5),
    "A is cut to its share when B goes live, not at its next farm sync",
  );
  assert.equal((aNow.advertisedQty + bNow.advertisedQty) * 5, 20, "packs x 5 = the 20 farmable accounts");
  assert.deepEqual(
    mk.calls.filter((c) => c[0] === "setQuantity").map((c) => [c[2], c[3]]),
    [[aNow.externalId, aNow.advertisedQty]],
  );
  // One re-split per farm send, each called with no offer lock held.
  assert.equal(loopState.resplits.length, 2);
  for (const r of loopState.resplits) {
    assert.deepEqual(r.locked, [], "called after the send's lock was released");
    assert.ok(r.opts && r.opts.now instanceof Date, "with {now}");
  }
});

test("V1: a farm resume re-splits too; a re-split that throws or is missing never fails the action; nothing else re-splits", async () => {
  const a = await farm(120, 5);
  const b = await farm(180, 5);
  assert.equal(b.status, 200, b.message);
  assert.equal(loopState.resplits.length, 2);
  const aid = String(a.offer._id);
  const bid = String(b.offer._id);
  // The recorder alone changed nothing: A still shows the whole pool (the
  // state the reviewer's repro starts from), B its share.
  assert.equal((await offerOf(aid)).advertisedQty, 4, "20 accounts = 4 packs");

  // A pause changes no share (a paused offer keeps its part).
  assert.equal((await send.pauseOffer({ offerId: bid })).status, 200);
  assert.equal(loopState.resplits.length, 2);

  // The owner resumes B: B at its share first, then the re-split cuts A —
  // before the resume answers.
  loopState.resplitImpl = simulatedResplit;
  const r = await inTime(send.resumeOffer({ offerId: bid, actor: "owner" }));
  assert.notEqual(r.status, "timeout");
  assert.equal(r.status, 200, r.message);
  assert.equal(loopState.resplits.length, 3);
  assert.deepEqual(loopState.resplits[2].locked, []);
  assert.ok(loopState.resplits[2].opts.now instanceof Date);
  const ids = [aid, bid].sort();
  assert.equal((await offerOf(bid)).advertisedQty, packsFor(shareOfShelf(20, bid, ids), 5));
  assert.equal(
    (await offerOf(aid)).advertisedQty,
    packsFor(shareOfShelf(20, aid, ids), 5),
    "A cut to its share by the resume's re-split",
  );

  // A re-split that throws is logged and audited; the send stands.
  loopState.resplitImpl = async () => {
    throw new Error("capacity read exploded");
  };
  const c = await quietErrors(() => farm(365, 5));
  assert.equal(c.value.status, 200, c.value.message);
  assert.equal(c.value.success, true);
  const cid = String(c.value.offer._id);
  assert.equal((await offerOf(cid)).state, "live");
  assert.equal(loopState.resplits.length, 4);
  assert.ok(
    c.lines.some((l) =>
      /re-split after the farm send failed \(capacity read exploded\)/.test(l),
    ),
    c.lines.join("\n"),
  );
  assert.ok(
    events.some(
      (e) =>
        e.action === "resplit_failed" &&
        /capacity read exploded/.test(e.message),
    ),
  );

  // A loop without resplitFarm: the resume stands, the gap is logged.
  loopState.resplitImpl = null;
  assert.equal((await send.pauseOffer({ offerId: cid })).status, 200);
  send.__setDeps({ loop: { retireUnits: fakeLoop.retireUnits } });
  const d = await quietErrors(() =>
    send.resumeOffer({ offerId: cid, actor: "owner" }),
  );
  send.__setDeps({ loop: fakeLoop });
  assert.equal(d.value.status, 200, d.value.message);
  assert.equal((await offerOf(cid)).state, "live");
  assert.ok(
    d.lines.some((l) =>
      /re-split after the farm resume failed \(loop\.resplitFarm is not available\)/.test(
        l,
      ),
    ),
  );
  assert.equal(loopState.resplits.length, 4);

  // Nothing but a farm offer going live re-splits: a refused farm send, a
  // failed farm publish, a refused resume, an account pack.
  const before = loopState.resplits.length;
  const short = await farm(365, 10); // a quarter of 20 < its minimum of 10
  assert.equal(short.status, 409, short.message);
  // Room enough for a share of 10, so this one gets as far as its publish.
  af.bulkFarmMaxQty = 100;
  cap.value = {
    ...cap.value,
    bestStackRoom: 100,
    totalFree: 200,
    pristine: 200,
  };
  mk.fail.publishFarm = {
    message: "Eldorado create: HTTP 400",
    outcome: "not_created",
  };
  const refused = await farm(120, 10);
  mk.fail = {};
  assert.equal(refused.status, 502, refused.message);
  assert.equal((await send.resumeOffer({ offerId: aid })).status, 409);
  const set = await makeSet();
  st.pool = accounts(8);
  const pack = await sendDropset(set, "eldorado", { units: 5 });
  assert.equal(pack.status, 200, pack.message);
  assert.equal(loopState.resplits.length, before);
});
