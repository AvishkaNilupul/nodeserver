// Bulk packs — send.js (docs/bulk-packs/MODULES.md §send.js, API-UI.md Tests A5,
// PACKS-2.md §3: one listing = one pack of N accounts, priced whole).
//
// Memory Mongo with the REAL BulkOffer / MarketplaceListing / DropSet models,
// the REAL delivery gate (utils/bulkPacks/config.js, fed a fake settings
// object), the REAL pack maths (packMath / pricing) and buyer copy (copy.js —
// a test may override one of its functions), and the REAL farm-order parsers
// (eldoradoFarmService / g2gFarmService, fed a CampaignDrops row). Every other
// sibling module and every marketplace is a fake that records its calls: no
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
const packMath = require("../utils/bulkPacks/packMath");
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
    bulkPackReserveSingles: 5,
    bulkPackUnitsPerOffer: 20,
    ...patch,
  };
  shop = { enabled: true, autoDeliver: true };
}
const fakeSettings = {
  getAutoFarm: () => af,
  getNoclaimShopSettings: () => shop,
  // Pure when handed the object: never reads settings.json.
  getBulkPacks: (x) =>
    realSettings.getBulkPacks(x && typeof x === "object" ? x : af),
  isNoClaimGame: (g) =>
    /overwatch|rainbow six|call of duty/i.test(String(g || "")),
};

// The real pack maths (pure). Kept behind a name so a test can wrap one call.
const fakePricing = realPricing;

// The real buyer copy; a test may override one function with copyState.
const copyState = { accountsTitle: null, farmTitle: null };
const fakeCopy = {
  baseTitleForSet: (a) => realCopy.baseTitleForSet(a),
  accountsTitle: (a) =>
    copyState.accountsTitle
      ? copyState.accountsTitle(a)
      : realCopy.accountsTitle(a),
  accountsDescription: (a) => realCopy.accountsDescription(a),
  farmTitle: (a) =>
    copyState.farmTitle ? copyState.farmTitle(a) : realCopy.farmTitle(a),
  farmDescription: (a) => realCopy.farmDescription(a),
};

// The stock layer: `held` stands in for the DropLog reservations
// (accountId -> market tag).
const st = {};
function resetStock() {
  st.pool = [];
  st.held = new Map();
  st.reserveCalls = [];
  st.releaseCalls = [];
  st.reserveLimit = Infinity;
  st.releaseThrows = false;
  st.onReserve = null;
  st.freeThrows = false;
  st.noclaim = { free: 0, share: { eldorado: 0, g2g: 0 } };
}
const fakeStock = {
  freeDropsetAccounts: async () => {
    if (st.freeThrows) throw new Error("archive read failed");
    return st.pool
      .filter((a) => !st.held.has(a.accountId))
      .map((a) => ({ ...a }));
  },
  reserve: async ({ n, market }) => {
    st.reserveCalls.push({ n, market });
    if (st.onReserve) await st.onReserve();
    const out = [];
    for (const a of st.pool) {
      if (out.length >= Math.min(n, st.reserveLimit)) break;
      if (st.held.has(a.accountId)) continue;
      st.held.set(a.accountId, market);
      out.push({ ...a });
    }
    return out;
  },
  releaseUnits: async ({ market, accountIds }) => {
    st.releaseCalls.push({ market, accountIds: [...accountIds] });
    if (st.releaseThrows) throw new Error("DropLog write failed");
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

// Marketplaces: records every call; `fail[name]` makes that call throw.
const mk = {};
function resetMarkets() {
  mk.calls = [];
  mk.fail = {};
  mk.noId = false;
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
  // A string is a plain Error; an object also carries what markets.js puts
  // on a publish failure (FIXES-1 S2/S5: outcome, externalId, code).
  if (typeof f === "string") throw new Error(f);
  throw Object.assign(new Error(f.message), f);
}
// PACKS-2 §3: every publish is priced per PACK (packPrice) on every market.
const fakeMarkets = {
  gameOfSet: (set) =>
    set.coverGame || (set.items && set.items[0] && set.items[0].game) || "",
  coverForSet: async (set, pack) => {
    mk.calls.push(["coverForSet", String(set && set._id), pack]);
    return "";
  },
  publishAccounts: async (args) => {
    mk.calls.push(["publishAccounts", args]);
    if (mk.onPublish) await mk.onPublish(args);
    maybeFail("publishAccounts");
    return {
      externalId: mk.noId ? "" : "EXT-" + ++mk.seq,
      url: "https://market.test/offer/" + mk.seq,
      price: args.packPrice,
    };
  },
  publishNoclaim: async (args) => {
    mk.calls.push(["publishNoclaim", args]);
    maybeFail("publishNoclaim");
    // What noclaimListings.publishClaimAtSale writes: a claim-at-sale row,
    // origin manual, noclaimStock, no units, qtyTarget = what it advertises.
    const landed = mk.noclaimLanded != null ? mk.noclaimLanded : args.quantity;
    const row = await MarketplaceListing.create({
      set: args.set._id,
      marketplace: args.market,
      externalId: "NC-" + ++mk.seq,
      url: "https://market.test/nc/" + mk.seq,
      title: args.title,
      description: args.description,
      price: args.packPrice,
      status: "active",
      origin: "manual",
      noclaimStock: true,
      qtyTarget: landed,
      autoDeliver: false,
    });
    return {
      rowId: String(row._id),
      externalId: row.externalId,
      url: row.url,
      price: args.packPrice,
      quantity: landed,
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
  // FIXES-1 S1: an equal, deterministic split (utils/suppliedStock.js).
  shareFor: (selfId, ids, available) => shareOfShelf(available, selfId, ids),
};

// The shared per-offer lock (utils/bulkPacks/lock.js, FIXES-1): an in-process
// FIFO mutex keyed by String(offerId), not re-entrant.
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
    __reset: () => tails.clear(),
  };
})();

// Phase 1 of CONTRACT I10 as MODULES §loop describes it: conditional $pull of
// the FREE unit, then the reserved entry goes retiring.
const loopState = { calls: [] };
const fakeLoop = {
  retireUnits: async (offer, row, accountIds, reason) => {
    loopState.calls.push({
      offerId: String(offer._id),
      rowId: String(row._id),
      accountIds: [...accountIds],
      reason,
    });
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

const proposalsState = { invalidated: 0 };
const fakeProposals = { invalidate: () => proposalsState.invalidated++ };

const ncl = { calls: [], beforeThrows: false };
const fakeNoclaimListings = {
  beforeDelist: async (row) => {
    ncl.calls.push(["beforeDelist", String(row._id), row.status]);
    if (ncl.beforeThrows) throw new Error("vault stock unreadable");
    return { sold: 0 };
  },
  afterDelist: async (row, { outcome } = {}) => {
    const cur = await MarketplaceListing.findById(row._id).lean();
    ncl.calls.push([
      "afterDelist",
      String(row._id),
      outcome,
      cur && cur.status,
    ]);
    return { released: 0, sold: 0, held: 0 };
  },
};
const ncStock = { share: 10 };
const fakeNoclaimStock = { stockForListing: async () => ncStock.share };

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
    proposals: fakeProposals,
    noclaimListings: fakeNoclaimListings,
    noclaimStock: fakeNoclaimStock,
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

function accounts(n, prefix = "acc") {
  return Array.from({ length: n }, (_, i) => ({
    accountId: new mongoose.Types.ObjectId().toString(),
    login: prefix + (i + 1),
  }));
}

async function makeSet(extra = {}) {
  const doc = await DropSet.create({
    name: "Rust Twitch Drops bundle",
    items: [
      { itemKey: "rust:hoodie", name: "Hoodie", game: "Rust", qty: 1 },
      { itemKey: "rust:ak", name: "AK Skin", game: "Rust", qty: 1 },
    ],
    price: 2,
    ...extra,
  });
  return doc.toObject();
}

async function singleListing(set, market, price, extra = {}) {
  return MarketplaceListing.create({
    set: set._id,
    marketplace: market,
    externalId: "SINGLE-" + market + "-" + price,
    title: "Rust Twitch Drops — Hoodie + AK Skin",
    price,
    status: "active",
    origin: "auto",
    ...extra,
  });
}

async function sendDropset(set, market, extra = {}) {
  return send.sendOffer({
    source: "dropset",
    setId: String(set._id),
    market,
    minQty: 5,
    actor: "admin:t",
    ...extra,
  });
}

function entries(offer, state) {
  return (offer.reserved || []).filter((r) => !state || r.state === state);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("bulk-packs-send-test"));
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
  proposalsState.invalidated = 0;
  ncl.calls = [];
  ncl.beforeThrows = false;
  ncStock.share = 10;
  copyState.accountsTitle = null;
  copyState.farmTitle = null;
  events.length = 0;
  telegrams.length = 0;
  fakeLock.__reset();
  installFakes();
});

// ---------------------------------------------------------------------------
// Refusals before anything happens
// ---------------------------------------------------------------------------

test("switched off: send, refill and resume answer 409 and touch nothing", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  const live = await sendDropset(set, "eldorado");
  assert.equal(live.status, 200);
  const before = mk.calls.length;

  resetSettings({ bulkPacksEnabled: false });
  const r = await sendDropset(set, "g2g");
  assert.equal(r.status, 409);
  assert.equal(r.success, false);
  assert.equal(r.message, "Bulk packs are switched off");
  assert.equal(await BulkOffer.countDocuments({ market: "g2g" }), 0);
  assert.equal(
    st.reserveCalls.length,
    1,
    "only the first (enabled) send reserved",
  );

  const refill = await send.refillOffer({
    offerId: String(live.offer._id),
    add: 3,
    actor: "admin:t",
  });
  assert.equal(refill.status, 409);
  assert.equal(refill.message, "Bulk packs are switched off");
  await BulkOffer.updateOne(
    { _id: live.offer._id },
    { $set: { state: "paused" } },
  );
  const resume = await send.resumeOffer({
    offerId: String(live.offer._id),
    actor: "admin:t",
  });
  assert.equal(resume.status, 409);
  assert.equal(resume.message, "Bulk packs are switched off");
  assert.equal(
    mk.calls.length,
    before,
    "no marketplace call while switched off",
  );

  // Safety actions still work while off (CONTRACT I8).
  const w = await send.withdrawOffer({
    offerId: String(live.offer._id),
    actor: "admin:t",
  });
  assert.equal(w.status, 200);
});

test("closed delivery gate: 409 with the gate's own reason, no offer created", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  resetSettings({ eldoradoDeliverDryRun: true });
  const r = await sendDropset(set, "eldorado");
  assert.equal(r.status, 409);
  assert.match(r.message, /dry-run/);
  assert.equal(await BulkOffer.countDocuments({}), 0);
  assert.equal(st.reserveCalls.length, 0);

  // No-claim also needs the No-claim Shop's own switches.
  const nset = await makeSet({
    name: "OW no-claim",
    stockSource: "noclaim",
    items: [{ itemKey: "ow:1", name: "Skin", game: "Overwatch" }],
  });
  resetSettings();
  shop = { enabled: true, autoDeliver: false };
  const n = await send.sendOffer({
    source: "noclaim",
    setId: String(nset._id),
    market: "g2g",
    minQty: 5,
  });
  assert.equal(n.status, 409);
  assert.match(n.message, /No-claim Shop delivery is off/);
  assert.equal(called("publishNoclaim").length, 0);
});

test("blocked, unsupported and switched-off markets, unknown tiers and bad input are 400", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  for (const market of ["ggsel", "plati", "digiseller"]) {
    const r = await sendDropset(set, market);
    assert.equal(r.status, 400, market);
    assert.match(r.message, /blocked/, market);
  }
  assert.equal((await sendDropset(set, "playerauctions")).status, 400);
  const nset = await makeSet({ name: "nc", stockSource: "noclaim" });
  const gf = await send.sendOffer({
    source: "noclaim",
    setId: String(nset._id),
    market: "gameflip",
    minQty: 5,
  });
  assert.equal(
    gf.status,
    400,
    "no-claim packs are not offered on Gameflip in v1",
  );
  assert.equal(
    (await sendDropset(set, "eldorado", { minQty: 7 })).status,
    400,
    "no 7+ tier",
  );
  assert.equal(
    (await sendDropset(set, "eldorado", { units: 3 })).status,
    400,
    "fewer accounts than the minimum",
  );
  assert.equal(
    (await sendDropset(set, "eldorado", { units: "lots" })).status,
    400,
  );
  assert.equal(
    (await send.sendOffer({ source: "bogus", market: "eldorado", minQty: 5 }))
      .status,
    400,
  );
  resetSettings({ bulkPacksMarkets: ["g2g"] });
  assert.equal(
    (await sendDropset(set, "eldorado")).status,
    400,
    "unticked market",
  );
  assert.equal(await BulkOffer.countDocuments({}), 0);
  assert.equal(st.reserveCalls.length, 0);
});

test("product checks: missing set 404, custom / wrong stock source / no-claim game 409", async () => {
  st.pool = accounts(30);
  const missing = await send.sendOffer({
    source: "dropset",
    setId: new mongoose.Types.ObjectId().toString(),
    market: "eldorado",
    minQty: 5,
  });
  assert.equal(missing.status, 404);
  assert.equal(
    (
      await send.sendOffer({
        source: "dropset",
        setId: "nope",
        market: "eldorado",
        minQty: 5,
      })
    ).status,
    404,
  );
  const custom = await makeSet({ custom: true });
  assert.equal((await sendDropset(custom, "eldorado")).status, 409);
  const nc = await makeSet({ stockSource: "noclaim" });
  assert.equal(
    (await sendDropset(nc, "eldorado")).status,
    409,
    "a no-claim set is not a dropset pack",
  );
  const plain = await makeSet();
  assert.equal(
    (
      await send.sendOffer({
        source: "noclaim",
        setId: String(plain._id),
        market: "eldorado",
        minQty: 5,
      })
    ).status,
    409,
    "a farmed set is not a no-claim pack",
  );
  const ow = await makeSet({
    name: "OW",
    items: [{ itemKey: "ow:1", name: "Skin", game: "Overwatch 2" }],
  });
  const r = await sendDropset(ow, "eldorado");
  assert.equal(r.status, 409);
  assert.match(r.message, /no-claim game/);
  const noPrice = await makeSet({ price: 0 });
  const np = await sendDropset(noPrice, "eldorado");
  assert.equal(np.status, 409);
  assert.match(np.message, /No price reference/);
  assert.equal(await BulkOffer.countDocuments({}), 0);
  assert.equal(st.reserveCalls.length, 0);
});

test("an account title that reads as Automatic Farming is refused before anything is reserved", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  copyState.accountsTitle = (a) => a.baseTitle + " Automatic Farming";
  const r = await sendDropset(set, "eldorado");
  assert.equal(r.status, 409);
  assert.match(r.message, /Automatic Farming/);
  assert.equal(await BulkOffer.countDocuments({}), 0);
  assert.equal(st.reserveCalls.length, 0);
});

// ---------------------------------------------------------------------------
// dropset on Eldorado / G2G
// ---------------------------------------------------------------------------

test("eldorado dropset happy path: whole packs of reserved units ride on a manual row owned by the offer", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  await singleListing(set, "eldorado", 2.4);
  await singleListing(set, "eldorado", 2.0);
  // A bulk row (discounted) never anchors a bulk price.
  await singleListing(set, "eldorado", 0.9, {
    bulkOfferId: new mongoose.Types.ObjectId(),
  });
  const r = await sendDropset(set, "eldorado");
  assert.equal(r.status, 200, r.message);
  assert.equal(r.success, true);

  const offer = await BulkOffer.findById(r.offer._id).lean();
  assert.equal(offer.state, "live");
  assert.equal(offer.open, true);
  assert.equal(offer.kind, "accounts");
  assert.equal(offer.anchorPrice, 2);
  assert.equal(offer.anchorBasis, "listing");
  // PACKS-2 §3: the pack is priced whole — 5 x $2 x 0.95.
  assert.equal(offer.packPrice, 9.5);
  assert.equal(offer.unitPrice, 1.9, "its per-account equivalent");
  assert.equal(offer.customPrice, false);
  assert.equal(
    offer.advertisedQty,
    4,
    "packs: min(unitsPerOffer 20 / 5, surplus (30-5) / 5) = 4",
  );
  assert.equal(
    offer.slotKey,
    ["accounts", "dropset", String(set._id), "eldorado", 5].join("|"),
  );
  assert.equal(entries(offer, "on_offer").length, 20, "4 packs x 5 accounts");
  assert.equal(offer.externalId, "EXT-1");
  assert.equal(
    offer.title,
    "Rust Twitch Drops — Hoodie + AK Skin — PACK OF 5 ACCOUNTS (-5%)",
    "the anchor row's title, then the pack",
  );
  assert.match(offer.description, /^PACK OF 5 ACCOUNTS — each purchase is a pack of 5 separate accounts\./);

  const pub = called("publishAccounts")[0][1];
  assert.equal(pub.market, "eldorado");
  assert.equal(pub.minQty, 5);
  assert.equal(pub.packPrice, 9.5);
  assert.equal(pub.unitPrice, 1.9);
  assert.equal(pub.units.length, 20);
  assert.ok(pub.units.every((u) => !("password" in u)));
  assert.equal(st.reserveCalls[0].market, "eldorado");
  assert.equal(st.reserveCalls[0].n, 20);
  // The pack cover: pack size and the discount the title shows.
  assert.deepEqual(
    called("coverForSet").map((c) => c[2]),
    [{ packSize: 5, discountPct: 5 }],
  );

  const row = await MarketplaceListing.findOne({
    bulkOfferId: offer._id,
  }).lean();
  assert.ok(row);
  assert.equal(String(offer.listing), String(row._id));
  assert.equal(row.origin, "manual");
  assert.equal(row.marketplace, "eldorado");
  assert.equal(row.externalId, "EXT-1");
  assert.equal(row.status, "active");
  assert.equal(row.autoDeliver, false);
  assert.equal(row.qtyTarget, 20, "the accounts on the row");
  assert.equal(row.price, 9.5, "one unit sold = one pack");
  assert.equal(row.bulkPackSize, 5, "PACKS-2 §1: the fulfillers multiply by it");
  assert.equal(packMath.accountsForUnits(row, 2), 10, "2 units bought = 10 accounts");
  assert.equal(row.title, offer.title);
  assert.equal(
    row.note,
    "bulk pack: 4 pack(s) of 5 at $9.50 per pack (5% off), 20 reserved",
  );
  assert.equal(
    row.accountLogin,
    "",
    "logins live in units[] only, so a retired unit stops counting as listed",
  );
  assert.equal(row.units.length, 20);
  for (const u of row.units) {
    assert.equal(u.contentId, "");
    assert.ok(u.accountId);
    assert.ok(u.login);
    assert.equal(u.deliveredAt, null);
    assert.equal(u.messagedAt, null);
    assert.equal(u.orderId, "");
  }
  // None of the fulfillers' other stock sources.
  assert.equal(row.autoClaimSet, false);
  assert.equal(row.unclaimedGame, "");
  assert.equal(row.noclaimStock, false);
  assert.equal(row.accountOffer, null);

  assert.ok(
    telegrams.some((t) =>
      /Bulk offer live: .* — Eldorado, pack of 5 for \$9\.50 \(\$1\.90 each\)/.test(t),
    ),
    telegrams.join("\n"),
  );
  assert.ok(events.some((e) => e.category === "bulk" && e.action === "sent"));
  assert.equal(proposalsState.invalidated, 1);
});

test("g2g dropset honours the owner's account count in whole packs", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  const r = await sendDropset(set, "g2g", { units: 8, minQty: 10 });
  assert.equal(r.status, 400, "8 accounts cannot fill one pack of 10");
  assert.match(r.message, /at least one pack \(10 accounts\)/);
  const ok = await sendDropset(set, "g2g", { units: 8 });
  assert.equal(ok.status, 200, ok.message);
  assert.equal(st.reserveCalls[0].n, 5, "8 accounts fill ONE pack of 5 — the other 3 are never reserved");
  const row = await MarketplaceListing.findOne({
    bulkOfferId: ok.offer._id,
  }).lean();
  assert.equal(row.marketplace, "g2g");
  assert.equal(row.units.length, 5);
  assert.equal(row.qtyTarget, 5);
  assert.equal(row.bulkPackSize, 5);
  assert.equal(row.price, 9.5);
  assert.equal(ok.offer.advertisedQty, 1);
  assert.equal(ok.offer.unitPrice, 1.9);
  assert.equal(ok.offer.packPrice, 9.5);
  const pub = called("publishAccounts")[0][1];
  assert.equal(pub.units.length, 5);
  assert.match(pub.title, / — PACK OF 5 ACCOUNTS \(-5%\)$/);

  // Ten tier: 12 accounts fill one pack of 10.
  const ten = await sendDropset(set, "g2g", { units: 12, minQty: 10 });
  assert.equal(ten.status, 200, ten.message);
  assert.equal(st.reserveCalls[1].n, 10);
  assert.equal(ten.offer.advertisedQty, 1);
  assert.equal(ten.offer.packPrice, 18, "10 x $2 x 0.90");
  assert.equal((await MarketplaceListing.findOne({ bulkOfferId: ten.offer._id }).lean()).bulkPackSize, 10);
});

test("a second click on the same slot is a 409 and reserves nothing; a closed slot can be re-sent", async () => {
  const set = await makeSet();
  st.pool = accounts(60);
  const first = await sendDropset(set, "eldorado");
  assert.equal(first.status, 200);
  const again = await sendDropset(set, "eldorado");
  assert.equal(again.status, 409);
  assert.match(again.message, /already live/);
  assert.equal(await BulkOffer.countDocuments({ open: true }), 1);
  assert.equal(st.reserveCalls.length, 1);
  assert.equal(called("publishAccounts").length, 1);

  // Two clicks at once: one offer.
  const [a, b] = await Promise.all([
    sendDropset(set, "g2g"),
    sendDropset(set, "g2g"),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(
    await BulkOffer.countDocuments({ market: "g2g", open: true }),
    1,
  );

  const w = await send.withdrawOffer({
    offerId: String(first.offer._id),
    actor: "admin:t",
  });
  assert.equal(w.status, 200);
  // Its retiring units are still held (two-phase), so leave enough free stock.
  const resent = await sendDropset(set, "eldorado", { units: 5 });
  assert.equal(resent.status, 200, resent.message);
});

test("not enough surplus: 409 naming the free count, nothing reserved, offer closed as error", async () => {
  const set = await makeSet();
  st.pool = accounts(8); // 8 free - 5 kept for singles = 3 < 5
  const r = await sendDropset(set, "eldorado");
  assert.equal(r.status, 409);
  assert.match(
    r.message,
    /Only 8 free account\(s\).*keeping 5 for single listings/,
  );
  assert.equal(st.reserveCalls.length, 0);
  assert.equal(st.held.size, 0);
  assert.equal(called("publishAccounts").length, 0);
  const offer = await BulkOffer.findOne({}).lean();
  assert.equal(offer.state, "error");
  assert.equal(offer.open, false);
  assert.ok(offer.closedAt);
  assert.equal(entries(offer).length, 0);
  assert.equal(telegrams.length, 0, "a 409 does not page");
  // The slot is free again.
  st.pool = accounts(30);
  assert.equal((await sendDropset(set, "eldorado")).status, 200);
});

test("a short reservation is handed straight back and nothing is listed", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  st.reserveLimit = 3;
  const r = await sendDropset(set, "eldorado");
  assert.equal(r.status, 409);
  assert.equal(st.releaseCalls.length, 1);
  assert.equal(st.releaseCalls[0].accountIds.length, 3);
  assert.equal(st.releaseCalls[0].market, "eldorado");
  assert.equal(st.held.size, 0);
  assert.equal(called("publishAccounts").length, 0);
  const offer = await BulkOffer.findById(r.offer._id).lean();
  assert.equal(offer.state, "error");
  assert.equal(entries(offer, "released").length, 3);
});

test("publish failure: every reservation released, offer error, owner paged, no row", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  // FIXES-1 S2/S5: only a failure markets.js classified as "nothing was
  // created" releases; an unclassified one HOLDS (bulkPacksSendRaces.test.js).
  mk.fail.publishAccounts = {
    message: "Eldorado create: HTTP 500",
    outcome: "not_created",
  };
  const r = await sendDropset(set, "eldorado");
  assert.equal(r.status, 502);
  assert.match(r.message, /Eldorado refused the offer/);
  assert.equal(st.releaseCalls.length, 1);
  assert.equal(st.releaseCalls[0].accountIds.length, 20);
  assert.equal(st.held.size, 0, "nothing stays reserved");
  const offer = await BulkOffer.findById(r.offer._id).lean();
  assert.equal(offer.state, "error");
  assert.equal(offer.open, false);
  assert.match(offer.lastError, /HTTP 500/);
  assert.equal(entries(offer, "released").length, 20);
  assert.equal(entries(offer, "on_offer").length, 0);
  assert.equal(await MarketplaceListing.countDocuments({}), 0);
  assert.ok(telegrams.some((t) => /FAILED/.test(t)));
});

test("a release that fails is left to the loop as retiring, never forgotten", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  mk.fail.publishAccounts = { message: "HTTP 503", outcome: "not_created" };
  st.releaseThrows = true;
  const r = await sendDropset(set, "eldorado");
  assert.equal(r.status, 502);
  const offer = await BulkOffer.findById(r.offer._id).lean();
  assert.equal(offer.open, false);
  assert.equal(
    entries(offer, "retiring").length,
    20,
    "the loop reloads closed offers with retiring units",
  );
  assert.ok(entries(offer, "retiring").every((e) => e.changedAt));
});

test("row-create failure: the orphan offer is paused, its accounts released, the owner paged", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  send.__setDeps({
    MarketplaceListing: {
      find: (...a) => MarketplaceListing.find(...a),
      findOne: (...a) => MarketplaceListing.findOne(...a),
      updateOne: (...a) => MarketplaceListing.updateOne(...a),
      create: async () => {
        throw new Error("insert refused");
      },
    },
  });
  const r = await sendDropset(set, "eldorado");
  assert.equal(r.status, 500);
  assert.deepEqual(
    called("pause").map((c) => [c[1], c[2]]),
    [["eldorado", "EXT-1"]],
  );
  assert.equal(st.releaseCalls.length, 1);
  assert.equal(st.held.size, 0);
  const offer = await BulkOffer.findById(r.offer._id).lean();
  assert.equal(offer.state, "error");
  assert.equal(offer.open, false);
  assert.equal(
    offer.externalId,
    "EXT-1",
    "the orphan's id is kept for the owner",
  );
  assert.equal(entries(offer, "released").length, 20);
  assert.ok(telegrams.some((t) => /orphan paused/.test(t)));
  assert.equal(
    telegrams.filter((t) => /FAILED/.test(t)).length,
    0,
    "one page, not two",
  );
});

test("a row write that landed but answered with an error is recovered, never released", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  send.__setDeps({
    MarketplaceListing: {
      find: (...a) => MarketplaceListing.find(...a),
      findOne: (...a) => MarketplaceListing.findOne(...a),
      updateOne: (...a) => MarketplaceListing.updateOne(...a),
      create: async (doc) => {
        await MarketplaceListing.create(doc);
        throw new Error("connection reset after the insert");
      },
    },
  });
  const r = await sendDropset(set, "eldorado");
  assert.equal(r.status, 200, r.message);
  assert.equal(st.releaseCalls.length, 0);
  assert.equal(st.held.size, 20);
  assert.equal(called("pause").length, 0);
  const row = await MarketplaceListing.findOne({
    bulkOfferId: r.offer._id,
  }).lean();
  assert.equal(String(r.offer.listing), String(row._id));
  assert.equal(r.offer.state, "live");
});

test("a publish that answers without an id: eldorado accounts go back, a gameflip pack's stay", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  mk.noId = true;
  const r = await sendDropset(set, "eldorado");
  assert.equal(r.status, 500);
  assert.equal(st.held.size, 0, "no row can ever deliver them");
  assert.equal(await MarketplaceListing.countDocuments({}), 0);
  assert.ok(telegrams.some((t) => /STILL LIVE/.test(t)));

  telegrams.length = 0;
  const g = await sendDropset(set, "gameflip");
  assert.equal(g.status, 500);
  assert.equal(st.held.size, 5, "the code may be live on Gameflip: kept");
  assert.equal(called("withdraw").length, 0, "no id to delist");
  assert.ok(telegrams.some((t) => /KEPT reserved/.test(t)));
});

// A maintenance pass that runs while the offer is still "sending" (no row
// yet) and moves one of its reservations.
function loopReleasesOneMidPublish() {
  let moved = "";
  mk.onPublish = async () => {
    const o = await BulkOffer.findOne({ state: "sending" }).lean();
    moved = o.reserved[0].accountId;
    await BulkOffer.updateOne(
      {
        _id: o._id,
        reserved: { $elemMatch: { accountId: moved, state: "on_offer" } },
      },
      {
        $set: {
          "reserved.$.state": "released",
          "reserved.$.reason": "row missing",
        },
      },
    );
    st.held.delete(moved);
  };
  return () => moved;
}

test("a reservation moved mid-publish never rides on the new row (quantity market)", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  const movedId = loopReleasesOneMidPublish();
  const r = await sendDropset(set, "eldorado");
  assert.equal(r.status, 200, r.message);
  const row = await MarketplaceListing.findOne({
    bulkOfferId: r.offer._id,
  }).lean();
  assert.equal(row.units.length, 19);
  assert.ok(!row.units.some((u) => u.accountId === movedId()));
  assert.equal(row.qtyTarget, 19);
  // 19 accounts fill 3 whole packs of 5; the 4 left over never sell.
  assert.deepEqual(
    called("setQuantity").map((c) => [c[1], c[2], c[3]]),
    [["eldorado", "EXT-1", 3]],
  );
  assert.equal(r.offer.advertisedQty, 3);
  assert.ok(telegrams.some((t) => /integrity/.test(t) && /3 whole pack\(s\) of 5/.test(t)));
});

test("a reservation moved mid-publish that leaves no whole pack pauses the offer", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  loopReleasesOneMidPublish();
  const r = await sendDropset(set, "eldorado", { units: 5 });
  assert.equal(r.status, 200, r.message);
  assert.equal((await MarketplaceListing.findOne({ bulkOfferId: r.offer._id }).lean()).units.length, 4);
  assert.deepEqual(
    called("pause").map((c) => [c[1], c[2]]),
    [["eldorado", "EXT-1"]],
    "4 accounts are not a pack of 5: off sale, never a quantity of 0",
  );
  assert.equal(called("setQuantity").length, 0);
  assert.equal(r.offer.advertisedQty, 0);
});

test("a reservation moved mid-publish takes the whole Gameflip pack down", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  loopReleasesOneMidPublish();
  const r = await sendDropset(set, "gameflip");
  assert.equal(r.status, 500);
  assert.equal(called("withdraw").length, 1);
  assert.equal(
    (await MarketplaceListing.findOne({ bulkOfferId: r.offer._id }).lean())
      .status,
    "delisted",
  );
  assert.equal(
    st.held.size,
    0,
    "the other four were released after the delist",
  );
  const offer = await BulkOffer.findById(r.offer._id).lean();
  assert.equal(offer.state, "error");
  assert.equal(entries(offer, "released").length, 5);
});

// ---------------------------------------------------------------------------
// dropset on Gameflip — one pack, one listing
// ---------------------------------------------------------------------------

test("gameflip pack happy path: exactly minQty accounts in one never-relisted row", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  const r = await sendDropset(set, "gameflip", { units: 20 });
  assert.equal(r.status, 200, r.message);
  assert.equal(
    st.reserveCalls[0].n,
    5,
    "a pack is exactly minQty, whatever `units` says",
  );
  const pub = called("publishAccounts")[0][1];
  assert.equal(pub.market, "gameflip");
  assert.equal(pub.packPrice, 9.5); // roundQuarter(5 × 2 × 0.95)
  assert.equal(pub.unitPrice, 1.9);
  assert.equal(pub.units.length, 5);
  assert.equal(pub.title, "Rust Twitch Drops bundle — PACK OF 5 ACCOUNTS (-5%)");

  const row = await MarketplaceListing.findOne({
    bulkOfferId: r.offer._id,
  }).lean();
  assert.equal(row.marketplace, "gameflip");
  assert.equal(row.origin, "manual");
  assert.equal(row.autoDeliver, true);
  assert.equal(row.qtyRemaining, 0);
  assert.equal(row.qtyTarget, 0);
  assert.equal(row.accountId, "");
  assert.equal(row.accountLogin, "acc1, acc2, acc3, acc4, acc5");
  assert.equal(row.units.length, 5);
  assert.equal(row.price, 9.5);
  assert.equal(row.bulkPackSize, 5, "the one pack this listing is");
  assert.equal(row.lotSize, 0, "not an unclaimed lot row");
  assert.equal(
    row.note,
    "bulk pack: 1 pack(s) of 5 at $9.50 per pack (5% off), 5 reserved",
  );
  assert.equal(r.offer.packPrice, 9.5);
  assert.equal(r.offer.unitPrice, 1.9);
  assert.equal(r.offer.advertisedQty, 1, "one pack listing");
  assert.ok(telegrams.some((t) => /Gameflip, pack of 5 for \$9\.50/.test(t)));
});

test("gameflip needs surplus for the whole pack", async () => {
  const set = await makeSet();
  st.pool = accounts(9); // surplus 4 < 5
  const r = await sendDropset(set, "gameflip");
  assert.equal(r.status, 409);
  assert.equal(st.reserveCalls.length, 0);
});

test("gameflip row-create failure: withdrawn then released; a failed delist keeps them reserved", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  const failingCreate = {
    find: (...a) => MarketplaceListing.find(...a),
    findOne: (...a) => MarketplaceListing.findOne(...a),
    updateOne: (...a) => MarketplaceListing.updateOne(...a),
    create: async () => {
      throw new Error("insert refused");
    },
  };
  send.__setDeps({ MarketplaceListing: failingCreate });
  const r = await sendDropset(set, "gameflip");
  assert.equal(r.status, 500);
  assert.equal(called("withdraw").length, 1);
  assert.equal(
    st.held.size,
    0,
    "delist succeeded, so the pack's accounts went back",
  );
  assert.equal(
    entries(await BulkOffer.findById(r.offer._id).lean(), "released").length,
    5,
  );

  // Same failure, but Gameflip will not delist: the code may still sell.
  await BulkOffer.deleteMany({});
  resetStock();
  st.pool = accounts(30);
  resetMarkets();
  telegrams.length = 0;
  mk.fail.withdraw = "Gameflip delist: HTTP 503";
  const r2 = await sendDropset(set, "gameflip");
  assert.equal(r2.status, 500);
  assert.equal(
    st.releaseCalls.length,
    0,
    "never released while the code may be live",
  );
  assert.equal(st.held.size, 5);
  const offer = await BulkOffer.findById(r2.offer._id).lean();
  assert.equal(entries(offer, "on_offer").length, 5);
  assert.ok(
    telegrams.some((t) => /STILL LIVE/.test(t) && /KEPT reserved/.test(t)),
  );
});

// ---------------------------------------------------------------------------
// noclaim and farm
// ---------------------------------------------------------------------------

test("noclaim happy path: published through the no-claim layer, then linked to the offer", async () => {
  const set = await makeSet({
    name: "OW no-claim",
    stockSource: "noclaim",
    items: [{ itemKey: "ow:1", name: "Skin", game: "Overwatch" }],
  });
  st.noclaim = { free: 30, share: { eldorado: 12, g2g: 0 } };
  const r = await send.sendOffer({
    source: "noclaim",
    setId: String(set._id),
    market: "eldorado",
    minQty: 5,
  });
  assert.equal(r.status, 200, r.message);
  const pub = called("publishNoclaim")[0][1];
  assert.equal(
    pub.quantity,
    2,
    "packs: min(unitsPerOffer 20 / 5, share 12 / 5) = 2",
  );
  assert.equal(pub.minQty, 5);
  assert.equal(pub.packPrice, 9.5, "5 x the set's $2 x 0.95");
  assert.equal(pub.unitPrice, 1.9);
  assert.match(pub.title, / — PACK OF 5 ACCOUNTS \(-5%\)$/);
  assert.match(pub.description, /log in, link your own game account, then claim the rewards yourself/);
  assert.equal(
    st.reserveCalls.length,
    0,
    "no-claim stock is claimed at sale, not reserved",
  );
  const row = await MarketplaceListing.findById(r.offer.listing).lean();
  assert.equal(String(row.bulkOfferId), String(r.offer._id));
  assert.equal(row.bulkPackSize, 5, "set in the same update as the link");
  assert.equal(row.noclaimStock, true);
  assert.equal(row.origin, "manual");
  assert.equal(r.offer.state, "live");
  assert.equal(r.offer.advertisedQty, 2);
  assert.equal(r.offer.packPrice, 9.5);
  assert.equal(r.offer.externalId, row.externalId);

  const short = await send.sendOffer({
    source: "noclaim",
    setId: String(set._id),
    market: "g2g",
    minQty: 5,
  });
  assert.equal(short.status, 409);
  assert.match(short.message, /Only 0 of 30 free no-claim/);

  mk.fail.publishNoclaim = "G2G publish: HTTP 500";
  st.noclaim = { free: 30, share: { eldorado: 12, g2g: 8 } };
  const bad = await send.sendOffer({
    source: "noclaim",
    setId: String(set._id),
    market: "g2g",
    minQty: 5,
  });
  assert.equal(bad.status, 502);
  assert.equal((await BulkOffer.findById(bad.offer._id).lean()).state, "error");
});

test("farm happy path: no row, the title round-trips through the real Eldorado and G2G parsers", async () => {
  const r = await send.sendOffer({
    source: "farm",
    game: "rust",
    days: 120,
    market: "eldorado",
    minQty: 5,
    actor: "admin:t",
  });
  assert.equal(r.status, 200, r.message);
  const offer = r.offer;
  assert.equal(offer.kind, "farming");
  assert.equal(offer.game, "Rust", "resolved to the name the farm knows");
  assert.equal(offer.days, 120);
  assert.equal(offer.slotKey, "farming|farm|Rust@120|eldorado|5");
  assert.equal(offer.anchorBasis, "farm-table");
  assert.equal(offer.anchorPrice, 3);
  // PACKS-2 §3: N x the farm unit price after the discount.
  assert.equal(offer.packPrice, 14.25); // 5 × $3 × 0.95
  assert.equal(offer.unitPrice, 2.85);
  // 20 farmable accounts (min(farmMaxQty 20, room 30, 60-20, 60-20)) = 4 packs.
  assert.equal(offer.advertisedQty, 4);
  const pub = called("publishFarm")[0][1];
  assert.equal(pub.quantity, 4);
  assert.equal(pub.minQty, 5);
  assert.equal(pub.packPrice, 14.25);
  assert.equal(pub.discountPct, 5, "the pack cover's -D%");
  // The REAL copy, read back by the REAL farm parsers (farmTitleProblem).
  assert.equal(pub.title, "Rust Twitch Drops Automatic Farming 120 Days — PACK OF 5 ACCOUNTS");
  assert.match(pub.description, /Each purchase is a pack of 5 separate Twitch accounts/);
  assert.equal(await MarketplaceListing.countDocuments({}), 0);

  const g = await send.sendOffer({
    source: "farm",
    game: "Rust",
    days: 365,
    market: "g2g",
    minQty: 10,
    units: 12,
  });
  assert.equal(g.status, 200, g.message);
  // FIXES-1 S1: the 20 farmable accounts are shared with the open Rust 120
  // offer, so this one's share is 10 (below the owner's 12): one pack of 10.
  assert.equal(
    g.offer.advertisedQty,
    1,
    "its share of the shared farm capacity, in packs",
  );
  assert.equal(g.offer.packPrice, 63, "10 × $7 × 0.90");
  assert.equal(called("publishFarm")[1][1].quantity, 1);
  assert.equal(
    called("publishFarm")[1][1].title,
    "Rust Twitch Drops Automatic Farming 1 Year — PACK OF 10 ACCOUNTS",
  );
});

test("farm refusals: title that would not round-trip, unknown game, short capacity, bad term", async () => {
  copyState.farmTitle = (a) =>
    a.game +
    " Twitch Drops Automatic Farming 180 Days — Bulk " +
    a.minQty +
    "+ Accounts";
  const wrongTerm = await send.sendOffer({
    source: "farm",
    game: "Rust",
    days: 120,
    market: "eldorado",
    minQty: 5,
  });
  assert.equal(wrongTerm.status, 409);
  assert.match(wrongTerm.message, /180 day/);
  copyState.farmTitle = (a) =>
    "Rust Skins Twitch Drops Farming " + a.days + " Days";
  const notFarm = await send.sendOffer({
    source: "farm",
    game: "Rust",
    days: 120,
    market: "g2g",
    minQty: 5,
  });
  assert.equal(notFarm.status, 409);
  assert.match(notFarm.message, /Automatic Farming/);
  copyState.farmTitle = null;
  assert.equal(
    await BulkOffer.countDocuments({}),
    0,
    "I5 is checked before the offer exists",
  );

  const unknown = await send.sendOffer({
    source: "farm",
    game: "Nonexistent Game",
    days: 120,
    market: "eldorado",
    minQty: 5,
  });
  assert.equal(unknown.status, 409);
  assert.equal(
    (
      await send.sendOffer({
        source: "farm",
        game: "Rust",
        days: 90,
        market: "eldorado",
        minQty: 5,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await send.sendOffer({
        source: "farm",
        game: "",
        days: 120,
        market: "eldorado",
        minQty: 5,
      })
    ).status,
    400,
  );

  cap.value = {
    bestStackRoom: 3,
    totalFree: 25,
    pristine: 40,
    at: new Date(),
    error: "",
  };
  const short = await send.sendOffer({
    source: "farm",
    game: "Rust",
    days: 120,
    market: "eldorado",
    minQty: 5,
  });
  assert.equal(short.status, 409);
  assert.match(short.message, /best stack room 3/);
  assert.match(short.message, /25 free slot/);
  assert.match(short.message, /40 pristine/);
  assert.equal(called("publishFarm").length, 0);
});

// ---------------------------------------------------------------------------
// withdraw
// ---------------------------------------------------------------------------

test("withdraw eldorado dropset: paused, row delisted, only FREE units retired (two-phase), sold ones kept", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  const r = await sendDropset(set, "eldorado");
  const row = await MarketplaceListing.findOne({
    bulkOfferId: r.offer._id,
  }).lean();
  const [soldU, inFlight, clobbered] = row.units;
  // One delivered, one mid-hand-over on G2G-style (orderId only), one wiped by
  // a fulfiller's whole-array save.
  await MarketplaceListing.updateOne(
    { _id: row._id, "units.accountId": soldU.accountId },
    { $set: { "units.$.deliveredAt": new Date(), "units.$.orderId": "ORD-1" } },
  );
  await MarketplaceListing.updateOne(
    { _id: row._id, "units.accountId": inFlight.accountId },
    { $set: { "units.$.orderId": "ORD-2" } },
  );
  await MarketplaceListing.updateOne(
    { _id: row._id },
    { $pull: { units: { accountId: clobbered.accountId } } },
  );

  const w = await send.withdrawOffer({
    offerId: String(r.offer._id),
    actor: "admin:t",
  });
  assert.equal(w.status, 200, w.message);
  assert.deepEqual(
    called("withdraw").map((c) => [c[1], c[2]]),
    [["eldorado", "EXT-1"]],
  );
  const after = await MarketplaceListing.findById(row._id).lean();
  assert.equal(after.status, "delisted");
  assert.equal(loopState.calls.length, 1);
  const retired = loopState.calls[0].accountIds;
  assert.equal(
    retired.length,
    18,
    "20 minus the delivered and the in-flight unit",
  );
  assert.ok(!retired.includes(soldU.accountId));
  assert.ok(!retired.includes(inFlight.accountId));
  assert.ok(retired.includes(clobbered.accountId));
  assert.equal(
    st.releaseCalls.length,
    0,
    "released only by the loop's phase 2",
  );
  // The sold units never leave the row.
  assert.ok(after.units.some((u) => u.accountId === soldU.accountId));
  assert.ok(after.units.some((u) => u.accountId === inFlight.accountId));
  assert.equal(after.units.length, 2);

  const offer = await BulkOffer.findById(r.offer._id).lean();
  assert.equal(offer.state, "withdrawn");
  assert.equal(offer.open, false);
  assert.ok(offer.closedAt);
  assert.equal(entries(offer, "retiring").length, 18);
  const delivered = entries(offer, "delivered");
  assert.deepEqual(delivered.map((e) => e.orderId).sort(), ["ORD-1", "ORD-2"]);
  assert.equal(
    entries(offer, "on_offer").length,
    0,
    "nothing stranded on a closed offer",
  );
});

test("withdraw eldorado: an unexplained market error changes nothing; 'must be active' counts as off sale", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  const r = await sendDropset(set, "eldorado");
  mk.fail.withdraw = "Eldorado pause: HTTP 500 upstream";
  const w = await send.withdrawOffer({
    offerId: String(r.offer._id),
    actor: "admin:t",
  });
  assert.equal(w.status, 502);
  assert.equal(
    (await MarketplaceListing.findOne({ bulkOfferId: r.offer._id }).lean())
      .status,
    "active",
  );
  assert.equal((await BulkOffer.findById(r.offer._id).lean()).state, "live");
  assert.equal(loopState.calls.length, 0);

  mk.fail.withdraw =
    'Eldorado pause: {"message":"To pause an offer it must be active"}';
  const w2 = await send.withdrawOffer({
    offerId: String(r.offer._id),
    actor: "admin:t",
  });
  assert.equal(w2.status, 200, w2.message);
  assert.equal(w2.offer.state, "withdrawn");
  assert.equal(loopState.calls[0].accountIds.length, 20);
});

test("withdraw gameflip pack: delist first, then conditional delisted row, then release", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  const r = await sendDropset(set, "gameflip");
  const w = await send.withdrawOffer({
    offerId: String(r.offer._id),
    actor: "admin:t",
  });
  assert.equal(w.status, 200, w.message);
  assert.deepEqual(
    called("withdraw").map((c) => [c[1], c[2]]),
    [["gameflip", "EXT-1"]],
  );
  assert.equal(
    (await MarketplaceListing.findOne({ bulkOfferId: r.offer._id }).lean())
      .status,
    "delisted",
  );
  assert.equal(st.releaseCalls.length, 1);
  assert.equal(st.releaseCalls[0].market, "gameflip");
  assert.equal(st.held.size, 0);
  const offer = await BulkOffer.findById(r.offer._id).lean();
  assert.equal(offer.state, "withdrawn");
  assert.equal(entries(offer, "released").length, 5);
});

test("withdraw gameflip pack that already sold: nothing released, the sync owns it", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  const r = await sendDropset(set, "gameflip");
  mk.fail.withdraw = "Gameflip delist: listing already sold";
  const w = await send.withdrawOffer({
    offerId: String(r.offer._id),
    actor: "admin:t",
  });
  assert.equal(w.status, 409);
  assert.match(w.message, /already sold/);
  assert.equal(st.releaseCalls.length, 0);
  assert.equal(st.held.size, 5);
  assert.equal(
    (await MarketplaceListing.findOne({ bulkOfferId: r.offer._id }).lean())
      .status,
    "active",
  );
  const offer = await BulkOffer.findById(r.offer._id).lean();
  assert.equal(offer.state, "live");
  assert.equal(entries(offer, "on_offer").length, 5);

  // Any other delist failure: also nothing released.
  mk.fail.withdraw = "Gameflip delist: HTTP 429";
  const w2 = await send.withdrawOffer({
    offerId: String(r.offer._id),
    actor: "admin:t",
  });
  assert.equal(w2.status, 502);
  assert.equal(st.releaseCalls.length, 0);

  // A row the Gameflip sync already marked sold is not even delisted.
  mk.fail.withdraw = "";
  await MarketplaceListing.updateOne(
    { bulkOfferId: r.offer._id },
    { $set: { status: "sold" } },
  );
  const before = called("withdraw").length;
  const w3 = await send.withdrawOffer({
    offerId: String(r.offer._id),
    actor: "admin:t",
  });
  assert.equal(w3.status, 409);
  assert.equal(called("withdraw").length, before);
  assert.equal(st.held.size, 5);
});

test("withdraw noclaim: the Listings page's no-claim delist path, in its order", async () => {
  const set = await makeSet({
    stockSource: "noclaim",
    items: [{ itemKey: "ow:1", name: "Skin", game: "Overwatch" }],
  });
  st.noclaim = { free: 30, share: { eldorado: 12, g2g: 12 } };
  const r = await send.sendOffer({
    source: "noclaim",
    setId: String(set._id),
    market: "g2g",
    minQty: 5,
  });
  assert.equal(r.status, 200, r.message);
  const rowId = String(r.offer.listing);

  ncl.beforeThrows = true;
  const refused = await send.withdrawOffer({
    offerId: String(r.offer._id),
    actor: "admin:t",
  });
  assert.equal(refused.status, 502);
  assert.equal(
    called("withdraw").length,
    0,
    "a failed settle refuses before the platform is touched",
  );
  assert.equal(
    (await MarketplaceListing.findById(rowId).lean()).status,
    "active",
  );

  ncl.beforeThrows = false;
  ncl.calls = [];
  const w = await send.withdrawOffer({
    offerId: String(r.offer._id),
    actor: "admin:t",
  });
  assert.equal(w.status, 200, w.message);
  assert.deepEqual(ncl.calls, [
    ["beforeDelist", rowId, "active"],
    ["afterDelist", rowId, "delisted", "delisted"],
  ]);
  assert.deepEqual(
    called("withdraw").map((c) => c[1]),
    ["g2g"],
  );
  assert.equal(
    (await MarketplaceListing.findById(rowId).lean()).status,
    "delisted",
  );
  assert.equal(w.offer.state, "withdrawn");
  assert.equal(w.offer.open, false);
});

test("withdraw farm: taken off the market, withdrawn", async () => {
  const r = await send.sendOffer({
    source: "farm",
    game: "Rust",
    days: 180,
    market: "g2g",
    minQty: 5,
  });
  assert.equal(r.status, 200, r.message);
  const w = await send.withdrawOffer({
    offerId: String(r.offer._id),
    actor: "admin:t",
  });
  assert.equal(w.status, 200);
  assert.deepEqual(
    called("withdraw").map((c) => [c[1], c[2]]),
    [["g2g", r.offer.externalId]],
  );
  assert.equal(w.offer.state, "withdrawn");
  assert.equal(
    (await send.withdrawOffer({ offerId: String(r.offer._id) })).status,
    409,
    "already closed",
  );
  assert.equal((await send.withdrawOffer({ offerId: "zzz" })).status, 404);
});

test("withdrawAll withdraws every open offer one by one", async () => {
  const set = await makeSet();
  st.pool = accounts(40);
  assert.equal((await sendDropset(set, "eldorado")).status, 200);
  assert.equal(
    (
      await send.sendOffer({
        source: "farm",
        game: "Rust",
        days: 120,
        market: "eldorado",
        minQty: 5,
      })
    ).status,
    200,
  );
  const all = await send.withdrawAll({ actor: "admin:t" });
  assert.equal(all.status, 200, all.message);
  assert.equal(all.success, true);
  assert.equal(all.results.length, 2);
  assert.ok(all.results.every((x) => x.success));
  assert.equal(await BulkOffer.countDocuments({ open: true }), 0);
});

test("an interrupted send: refused while fresh; once stale, eldorado accounts go back, gameflip ones stay", async () => {
  const set = await makeSet();
  const ids = accounts(6);
  for (const a of ids) st.held.set(a.accountId, "eldorado");
  const mkOffer = (market, list) =>
    BulkOffer.create({
      kind: "accounts",
      source: "dropset",
      market,
      set: set._id,
      minQty: 5,
      title: "Rust pack",
      state: "sending",
      slotKey: "accounts|dropset|" + set._id + "|" + market + "|5",
      reserved: list.map((a) => ({ accountId: a.accountId, login: a.login })),
    });
  const eld = await mkOffer("eldorado", ids);
  const fresh = await send.withdrawOffer({ offerId: String(eld._id) });
  assert.equal(fresh.status, 409);
  assert.match(fresh.message, /still being sent/);

  const old = new Date(Date.now() - send.SENDING_STALE_MS - 60000);
  await BulkOffer.collection.updateOne(
    { _id: eld._id },
    { $set: { updatedAt: old } },
  );
  const w = await send.withdrawOffer({ offerId: String(eld._id) });
  assert.equal(w.status, 200, w.message);
  assert.equal(w.offer.state, "error");
  assert.equal(st.held.size, 0);
  assert.ok(telegrams.some((t) => /interrupted/.test(t)));

  const gfIds = accounts(5, "gf");
  for (const a of gfIds) st.held.set(a.accountId, "gameflip");
  const gf = await mkOffer("gameflip", gfIds);
  await BulkOffer.collection.updateOne(
    { _id: gf._id },
    { $set: { updatedAt: old } },
  );
  const w2 = await send.withdrawOffer({ offerId: String(gf._id) });
  assert.equal(w2.status, 200);
  assert.equal(st.held.size, 5, "a Gameflip code may be live: kept reserved");
  assert.equal(entries(w2.offer, "on_offer").length, 5);
});

// ---------------------------------------------------------------------------
// refill, pause, resume
// ---------------------------------------------------------------------------

test("refill: whole packs, atomic $push per unit, reserved[] authority, packs re-read from the row", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  const r = await sendDropset(set, "eldorado", { units: 6 });
  assert.equal(r.status, 200);
  assert.equal(r.offer.advertisedQty, 1, "6 accounts = one pack of 5");
  const row = await MarketplaceListing.findOne({
    bulkOfferId: r.offer._id,
  }).lean();
  // A fulfiller delivers one unit while the refill is reserving.
  st.onReserve = async () => {
    await MarketplaceListing.updateOne(
      { _id: row._id, "units.accountId": row.units[0].accountId },
      {
        $set: { "units.$.deliveredAt": new Date(), "units.$.orderId": "ORD-7" },
      },
    );
  };
  // Fewer accounts than one pack: refused before anything is reserved.
  const tiny = await send.refillOffer({
    offerId: String(r.offer._id),
    add: 4,
    actor: "admin:t",
  });
  assert.equal(tiny.status, 400);
  assert.match(tiny.message, /whole packs — add at least 5 accounts/);
  assert.equal(st.reserveCalls.length, 1, "only the send reserved");

  // 7 accounts are one whole pack of 5: 5 reserved, never 7.
  const f = await send.refillOffer({
    offerId: String(r.offer._id),
    add: 7,
    actor: "admin:t",
  });
  assert.equal(f.status, 200, f.message);
  assert.equal(st.reserveCalls[1].n, 5);
  const after = await MarketplaceListing.findById(row._id).lean();
  assert.equal(after.units.length, 10);
  assert.equal(after.qtyTarget, 10);
  const stamped = after.units.find(
    (u) => u.accountId === row.units[0].accountId,
  );
  assert.equal(
    stamped.orderId,
    "ORD-7",
    "the concurrent delivery stamp survives the refill",
  );
  assert.ok(stamped.deliveredAt);
  // 9 free units (one went to ORD-7) = 1 whole pack of 5.
  assert.deepEqual(
    called("setQuantity").map((c) => c[3]),
    [1],
  );
  const offer = await BulkOffer.findById(r.offer._id).lean();
  assert.equal(offer.advertisedQty, 1);
  assert.equal(entries(offer, "on_offer").length, 10);

  // Only dropset eldorado/g2g offers refill; and not past the singles reserve.
  st.pool = st.pool.slice(0, 12); // 12 held-or-free, 10 held -> 2 free, surplus -3
  const none = await send.refillOffer({ offerId: String(r.offer._id), add: 5 });
  assert.equal(none.status, 409);
  assert.match(none.message, /a refill adds whole packs of 5/);
  assert.equal(
    (await send.refillOffer({ offerId: String(r.offer._id), add: 0 })).status,
    400,
  );
});

test("refill refused for a closed gate, a gameflip pack and a farm offer", async () => {
  const set = await makeSet();
  st.pool = accounts(40);
  const e = await sendDropset(set, "eldorado", { units: 6 });
  resetSettings({ eldoradoAutoDeliver: false });
  assert.equal(
    (await send.refillOffer({ offerId: String(e.offer._id), add: 2 })).status,
    409,
  );
  resetSettings();
  const g = await sendDropset(set, "gameflip");
  assert.equal(
    (await send.refillOffer({ offerId: String(g.offer._id), add: 2 })).status,
    409,
  );
  const f = await send.sendOffer({
    source: "farm",
    game: "Rust",
    days: 120,
    market: "eldorado",
    minQty: 5,
  });
  assert.equal(
    (await send.refillOffer({ offerId: String(f.offer._id), add: 2 })).status,
    409,
  );
});

test("pause and resume: manual pause is not auto-resumable; resume needs stock and the gate", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  const r = await sendDropset(set, "eldorado", { units: 6 });
  const p = await send.pauseOffer({
    offerId: String(r.offer._id),
    actor: "admin:t",
  });
  assert.equal(p.status, 200, p.message);
  assert.equal(p.offer.state, "paused");
  assert.equal(p.offer.autoPaused, false);
  assert.deepEqual(
    called("pause").map((c) => [c[1], c[2]]),
    [["eldorado", "EXT-1"]],
  );
  assert.ok(telegrams.some((t) => /paused/.test(t)));

  // Two units sell while paused: 3 left — not one pack of 5.
  const row = await MarketplaceListing.findOne({
    bulkOfferId: r.offer._id,
  }).lean();
  for (const u of row.units.slice(0, 2)) {
    await MarketplaceListing.updateOne(
      { _id: row._id, "units.accountId": u.accountId },
      {
        $set: {
          "units.$.deliveredAt": new Date(),
          "units.$.orderId": "ORD-" + u.login,
        },
      },
    );
  }
  const short = await send.resumeOffer({
    offerId: String(r.offer._id),
    actor: "admin:t",
  });
  assert.equal(short.status, 409);
  assert.match(short.message, /refill it first/);
  assert.equal(called("resume").length, 0);

  const f = await send.refillOffer({ offerId: String(r.offer._id), add: 5 });
  assert.equal(f.status, 200, f.message);
  resetSettings({ eldoradoDeliverDryRun: true });
  assert.equal(
    (await send.resumeOffer({ offerId: String(r.offer._id) })).status,
    409,
    "gate closed",
  );
  resetSettings();
  const ok = await send.resumeOffer({
    offerId: String(r.offer._id),
    actor: "admin:t",
  });
  assert.equal(ok.status, 200, ok.message);
  assert.equal(ok.offer.state, "live");
  assert.equal(called("resume").length, 1);
  // 3 + 5 = 8 free = one whole pack, set before the resume (S8).
  assert.deepEqual(
    mk.calls.filter((c) => c[0] === "setQuantity" || c[0] === "resume").slice(-2).map((c) => [c[0], c[3]]),
    [
      ["setQuantity", 1],
      ["resume", undefined],
    ],
  );
  assert.equal(ok.offer.advertisedQty, 1);

  const g = await sendDropset(set, "gameflip");
  assert.equal(
    (await send.pauseOffer({ offerId: String(g.offer._id) })).status,
    409,
    "a pack is withdrawn, not paused",
  );
});

test("pause on a loop-paused farm offer only makes the pause the owner's", async () => {
  const r = await send.sendOffer({
    source: "farm",
    game: "Rust",
    days: 120,
    market: "eldorado",
    minQty: 5,
  });
  await BulkOffer.updateOne(
    { _id: r.offer._id },
    { $set: { state: "paused", autoPaused: true } },
  );
  const p = await send.pauseOffer({
    offerId: String(r.offer._id),
    actor: "admin:t",
  });
  assert.equal(p.status, 200);
  assert.equal(p.offer.autoPaused, false);
  assert.equal(called("pause").length, 0);

  cap.value = {
    bestStackRoom: 2,
    totalFree: 25,
    pristine: 40,
    at: new Date(),
    error: "",
  };
  assert.equal(
    (await send.resumeOffer({ offerId: String(r.offer._id) })).status,
    409,
    "no farm capacity",
  );
  resetCapacity();
  const ok = await send.resumeOffer({ offerId: String(r.offer._id) });
  assert.equal(ok.status, 200, ok.message);
  assert.equal(ok.offer.state, "live");
});

test("never throws: a failing dependency is a 500 and the offer is closed", async () => {
  const set = await makeSet();
  st.freeThrows = true;
  const r = await sendDropset(set, "eldorado");
  assert.equal(r.status, 500);
  assert.equal(r.success, false);
  const offer = await BulkOffer.findOne({}).lean();
  assert.equal(offer.state, "error");
  assert.equal(offer.open, false);
  send.__setDeps({
    BulkOffer: {
      findById: () => {
        throw new Error("db gone");
      },
    },
  });
  const w = await send.withdrawOffer({ offerId: String(offer._id) });
  assert.equal(w.status, 500);
  assert.equal(w.success, false);
});

// ---------------------------------------------------------------------------
// PACKS-2 §3 — custom prices
// ---------------------------------------------------------------------------

async function nothingHappened() {
  assert.equal(await BulkOffer.countDocuments({}), 0, "no offer created");
  assert.equal(st.reserveCalls.length, 0, "nothing reserved");
  assert.equal(
    mk.calls.filter((c) => /^publish/.test(c[0])).length,
    0,
    "nothing published",
  );
}

test("custom price: a pack below the market's floor per listing is a HARD 400 on every market, confirmed or not", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  // 5 x $0.09 = $0.45 < Eldorado's $0.50; 5 x $0.19 = $0.95 < G2G's $1;
  // 5 x $0.14 = $0.70 < Gameflip's $0.75.
  for (const [market, customUnitPrice, floor] of [
    ["eldorado", 0.09, "$0.50"],
    ["g2g", 0.19, "$1.00"],
    ["gameflip", 0.14, "$0.75"],
  ]) {
    for (const confirmPrice of [undefined, true]) {
      const r = await sendDropset(set, market, { customUnitPrice, confirmPrice });
      assert.equal(r.status, 400, market + " " + confirmPrice);
      assert.equal(r.success, false);
      assert.equal(r.code, "price_below_floor");
      assert.match(r.message, new RegExp("below .*'s \\" + floor + " minimum per listing"));
      assert.equal(r.price.floor, config.MARKET_FLOORS[market]);
    }
  }
  const f = await send.sendOffer({
    source: "farm",
    game: "Rust",
    days: 120,
    market: "eldorado",
    minQty: 5,
    customUnitPrice: 0.09,
    confirmPrice: true,
  });
  assert.equal(f.status, 400);
  assert.equal(f.code, "price_below_floor");
  await nothingHappened();
  // Exactly at the floor is a price.
  const at = await sendDropset(set, "eldorado", { customUnitPrice: 0.1, confirmPrice: true });
  assert.equal(at.status, 200, at.message);
  assert.equal(at.offer.packPrice, 0.5);
});

test("custom price under 70% of the single price: 409 price_confirm, then confirmPrice === true sends it", async () => {
  const set = await makeSet(); // set.price $2 is the anchor
  st.pool = accounts(30);
  const r = await sendDropset(set, "eldorado", { customUnitPrice: 1.2 });
  assert.equal(r.status, 409);
  assert.equal(r.success, false);
  assert.equal(r.code, "price_confirm");
  assert.match(r.message, /\$1\.20 per account is 40% below the single price of \$2\.00/);
  assert.match(r.message, /pack of 5 would sell for \$6\.00/);
  assert.deepEqual(
    {
      customUnitPrice: r.price.customUnitPrice,
      packPrice: r.price.packPrice,
      packSize: r.price.packSize,
      anchorPrice: r.price.anchorPrice,
      anchorBasis: r.price.anchorBasis,
      floor: r.price.floor,
      pctOfAnchor: r.price.pctOfAnchor,
    },
    {
      customUnitPrice: 1.2,
      packPrice: 6,
      packSize: 5,
      anchorPrice: 2,
      anchorBasis: "set",
      floor: 0.5,
      pctOfAnchor: 60,
    },
  );
  assert.equal(r.price.reasons.length, 1);
  // Only the boolean true confirms.
  for (const confirmPrice of ["true", 1, "yes", {}]) {
    const again = await sendDropset(set, "eldorado", { customUnitPrice: 1.2, confirmPrice });
    assert.equal(again.status, 409, JSON.stringify(confirmPrice));
    assert.equal(again.code, "price_confirm");
  }
  await nothingHappened();

  const ok = await sendDropset(set, "eldorado", { customUnitPrice: 1.2, confirmPrice: true });
  assert.equal(ok.status, 200, ok.message);
  const offer = await BulkOffer.findById(ok.offer._id).lean();
  assert.equal(offer.customPrice, true);
  assert.equal(offer.unitPrice, 1.2, "stored per account");
  assert.equal(offer.packPrice, 6, "stored per pack: round2(1.2 x 5)");
  assert.equal(offer.anchorPrice, 2);
  assert.equal(offer.discountPct, 40, "the discount the price really gives");
  assert.match(offer.title, / — PACK OF 5 ACCOUNTS \(-40%\)$/);
  const pub = called("publishAccounts")[0][1];
  assert.equal(pub.packPrice, 6);
  assert.equal(pub.unitPrice, 1.2);
  assert.deepEqual(called("coverForSet")[0][2], { packSize: 5, discountPct: 40 });
  const row = await MarketplaceListing.findOne({ bulkOfferId: offer._id }).lean();
  assert.equal(row.price, 6);
  assert.equal(row.bulkPackSize, 5);
  assert.match(row.note, /custom price \$1\.20 each/);
  assert.ok(telegrams.some((t) => /pack of 5 for \$6\.00 \(\$1\.20 each, custom price\)/.test(t)), telegrams.join("\n"));
});

test("custom price above the single price, or under the set's minPriceUsd, needs the confirm too", async () => {
  st.pool = accounts(60);
  const set = await makeSet();
  const high = await sendDropset(set, "g2g", { customUnitPrice: 2.5 });
  assert.equal(high.status, 409);
  assert.equal(high.code, "price_confirm");
  assert.match(high.message, /\$2\.50 per account is above the single price of \$2\.00/);
  const highOk = await sendDropset(set, "g2g", { customUnitPrice: 2.5, confirmPrice: true });
  assert.equal(highOk.status, 200, highOk.message);
  assert.equal(highOk.offer.packPrice, 12.5);
  assert.equal(highOk.offer.discountPct, 0);
  assert.match(highOk.offer.title, / — PACK OF 5 ACCOUNTS$/, "no discount tag on a markup");

  // minPriceUsd $1.80 on a $2 set: $1.50 is 75% of the anchor (fine) but
  // under the bundle's own minimum.
  const guarded = await makeSet({ name: "Rust guarded bundle", minPriceUsd: 1.8 });
  const low = await sendDropset(guarded, "eldorado", { customUnitPrice: 1.5 });
  assert.equal(low.status, 409);
  assert.equal(low.code, "price_confirm");
  assert.match(low.message, /below this bundle's minimum price of \$1\.80/);
  assert.equal(low.price.minPriceUsd, 1.8);
  const lowOk = await sendDropset(guarded, "eldorado", { customUnitPrice: 1.5, confirmPrice: true });
  assert.equal(lowOk.status, 200, lowOk.message);
  assert.equal(lowOk.offer.customPrice, true);
});

test("custom price within 70%..100% of the single price needs no confirm", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  const r = await sendDropset(set, "gameflip", { customUnitPrice: 1.6 });
  assert.equal(r.status, 200, r.message);
  assert.equal(r.offer.customPrice, true);
  assert.equal(r.offer.unitPrice, 1.6);
  assert.equal(r.offer.packPrice, 8, "round2(1.6 x 5), Gameflip included");
  assert.equal(r.offer.discountPct, 20);
  assert.equal(called("publishAccounts")[0][1].packPrice, 8);
  assert.match(r.offer.title, / — PACK OF 5 ACCOUNTS \(-20%\)$/);
  // A numeric string from a form is a price too.
  const s2 = await sendDropset(set, "eldorado", { customUnitPrice: "1.75" });
  assert.equal(s2.status, 200, s2.message);
  assert.equal(s2.offer.unitPrice, 1.75);
  assert.equal(s2.offer.packPrice, 8.75);
});

test("custom price input that is not a price is a 400 before anything happens", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  for (const customUnitPrice of ["abc", -1, 0, "0", {}, [1], true, NaN, Infinity, "1,5", " "]) {
    const r = await sendDropset(set, "eldorado", { customUnitPrice });
    if (customUnitPrice === " ") {
      // Blank is "no custom price".
      assert.equal(r.status, 200, r.message);
      assert.equal(r.offer.customPrice, false);
      continue;
    }
    assert.equal(r.status, 400, JSON.stringify(customUnitPrice));
    assert.equal(r.code, "price_invalid");
  }
});

test("custom price on a farming pack: the farm table is the anchor; N x the custom price", async () => {
  const r = await send.sendOffer({
    source: "farm",
    game: "Rust",
    days: 120,
    market: "g2g",
    minQty: 5,
    customUnitPrice: 2,
  });
  assert.equal(r.status, 409, "$2 is 67% of the $3 farm price");
  assert.equal(r.code, "price_confirm");
  assert.equal(r.price.anchorBasis, "farm-table");
  assert.equal(await BulkOffer.countDocuments({}), 0);
  const ok = await send.sendOffer({
    source: "farm",
    game: "Rust",
    days: 120,
    market: "g2g",
    minQty: 5,
    customUnitPrice: 2,
    confirmPrice: true,
  });
  assert.equal(ok.status, 200, ok.message);
  assert.equal(ok.offer.customPrice, true);
  assert.equal(ok.offer.unitPrice, 2);
  assert.equal(ok.offer.packPrice, 10);
  const pub = called("publishFarm")[0][1];
  assert.equal(pub.packPrice, 10);
  assert.equal(pub.discountPct, 33, "rounded down: never overstated");
});

// ---------------------------------------------------------------------------
// PACKS-2 §3 — packs reserved and advertised
// ---------------------------------------------------------------------------

test("packs reserved at send = min(units / N, unitsPerOffer / N, surplus / N), whole packs only", async () => {
  const set = await makeSet();
  // 17 free - 5 singles = 12 surplus = 2 packs of 5 (unitsPerOffer 20 = 4).
  st.pool = accounts(17);
  const a = await sendDropset(set, "eldorado");
  assert.equal(a.status, 200, a.message);
  assert.equal(st.reserveCalls[0].n, 10);
  assert.equal(a.offer.advertisedQty, 2);
  assert.equal(called("publishAccounts")[0][1].units.length, 10);

  // The owner's 14 accounts = 2 packs, whatever else is free.
  resetStock();
  st.pool = accounts(40);
  const b = await sendDropset(set, "g2g", { units: 14 });
  assert.equal(b.status, 200, b.message);
  assert.equal(st.reserveCalls[0].n, 10);
  assert.equal(b.offer.advertisedQty, 2);
  assert.equal(entries(await BulkOffer.findById(b.offer._id).lean(), "on_offer").length, 10);

  // Accounts per offer below one pack, and no count typed: refused, with why.
  resetSettings({ bulkPackUnitsPerOffer: 3 });
  const c = await sendDropset(set, "eldorado", { minQty: 10 });
  assert.equal(c.status, 409);
  assert.match(c.message, /Accounts per offer \(3\) is less than one pack of 10/);
});

test("a reservation short of whole packs keeps the whole packs and hands the rest straight back", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  st.reserveLimit = 13; // asked for 20 (4 packs), got 13
  const r = await sendDropset(set, "eldorado");
  assert.equal(r.status, 200, r.message);
  assert.equal(st.releaseCalls.length, 1, "the 3 beyond the last whole pack");
  assert.equal(st.releaseCalls[0].accountIds.length, 3);
  assert.equal(st.held.size, 10);
  const offer = await BulkOffer.findById(r.offer._id).lean();
  assert.equal(entries(offer, "on_offer").length, 10);
  assert.equal(entries(offer, "released").length, 3);
  assert.equal(offer.advertisedQty, 2);
  const pub = called("publishAccounts")[0][1];
  assert.equal(pub.units.length, 10, "never a partial pack on offer");
  const row = await MarketplaceListing.findOne({ bulkOfferId: offer._id }).lean();
  assert.equal(row.units.length, 10);
  assert.ok(
    entries(offer, "released").every((e) => !row.units.some((u) => u.accountId === e.accountId)),
  );
});

test("a title that does not say PACK OF N is refused before anything is reserved", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  copyState.accountsTitle = (a) => a.baseTitle + " — BULK " + a.minQty + "+ accounts";
  const r = await sendDropset(set, "eldorado");
  assert.equal(r.status, 409);
  assert.match(r.message, /does not say "PACK OF 5"/);
  copyState.accountsTitle = null;
  copyState.farmTitle = (a) =>
    a.game + " Twitch Drops Automatic Farming " + a.days + " Days — Bulk " + a.minQty + "+";
  const f = await send.sendOffer({ source: "farm", game: "Rust", days: 120, market: "g2g", minQty: 5 });
  assert.equal(f.status, 409);
  assert.match(f.message, /does not say "PACK OF 5"/);
  await nothingHappened();
});

test("titles on every market state the pack; the farm title round-trips through the real parsers", async () => {
  st.pool = accounts(60);
  const set = await makeSet();
  const eldFarm = require("../utils/eldoradoFarmService");
  const g2gFarm = require("../utils/g2gFarmService");
  for (const market of ["eldorado", "g2g", "gameflip"]) {
    const r = await sendDropset(set, market, { minQty: 10, units: 10 });
    assert.equal(r.status, 200, market + ": " + r.message);
    assert.equal(r.offer.title, "Rust Twitch Drops bundle — PACK OF 10 ACCOUNTS (-10%)", market);
    assert.equal(await eldFarm.parseFarmOrder({ orderOfferDetails: { offerTitle: r.offer.title } }), null);
  }
  for (const [market, days] of [
    ["eldorado", 180],
    ["g2g", 365],
  ]) {
    const r = await send.sendOffer({ source: "farm", game: "Rust", days, market, minQty: 5 });
    assert.equal(r.status, 200, r.message);
    assert.match(r.offer.title, / — PACK OF 5 ACCOUNTS$/);
    const eld = await eldFarm.parseFarmOrder({ orderOfferDetails: { offerTitle: r.offer.title } });
    const g2g = await g2gFarm.parseFarmOrder({ title: r.offer.title });
    for (const parsed of [eld, g2g]) {
      assert.equal(parsed.game, "Rust");
      assert.equal(parsed.days, days);
    }
  }
});

test("no-claim: packs capped by the owner's accounts; the pack price; bulkPackSize on the linked row", async () => {
  const set = await makeSet({
    name: "OW no-claim",
    stockSource: "noclaim",
    items: [{ itemKey: "ow:1", name: "Skin", game: "Overwatch" }],
  });
  st.noclaim = { free: 40, share: { eldorado: 30, g2g: 30 } };
  ncStock.share = 30;
  const r = await send.sendOffer({ source: "noclaim", setId: String(set._id), market: "g2g", minQty: 5, units: 7 });
  assert.equal(r.status, 200, r.message);
  assert.equal(called("publishNoclaim")[0][1].quantity, 1, "7 accounts = one pack");
  assert.equal(r.offer.advertisedQty, 1);
  const row = await MarketplaceListing.findById(r.offer.listing).lean();
  assert.equal(row.bulkPackSize, 5);
  assert.equal(row.price, 9.5);

  // One pack is more than this offer's share: refused before any publish.
  st.noclaim = { free: 40, share: { eldorado: 4, g2g: 30 } };
  const short = await send.sendOffer({ source: "noclaim", setId: String(set._id), market: "eldorado", minQty: 5 });
  assert.equal(short.status, 409);
  assert.match(short.message, /Only 4 of 40 .* one pack needs 5/);
  assert.equal(called("publishNoclaim").length, 1);
});

test("no-claim: a shelf that shrank mid-publish never leaves more packs advertised than its share fills", async () => {
  const set = await makeSet({
    name: "OW no-claim",
    stockSource: "noclaim",
    items: [{ itemKey: "ow:1", name: "Skin", game: "Overwatch" }],
  });
  const send1 = () => send.sendOffer({ source: "noclaim", setId: String(set._id), market: "eldorado", minQty: 5 });
  st.noclaim = { free: 30, share: { eldorado: 12, g2g: 0 } };

  // 2 packs asked and landed; the row's own share now fills only 1.
  ncStock.share = 7;
  const one = await send1();
  assert.equal(one.status, 200, one.message);
  assert.deepEqual(
    called("setQuantity").map((c) => [c[1], c[3]]),
    [["eldorado", 1]],
  );
  assert.equal(one.offer.advertisedQty, 1);
  assert.equal(one.offer.state, "live");
  assert.equal((await send.withdrawOffer({ offerId: String(one.offer._id) })).status, 200);

  // Not one whole pack left for it: taken straight back down.
  resetMarkets();
  ncStock.share = 3;
  const none = await send1();
  assert.equal(none.status, 409);
  assert.match(none.message, /shrank while publishing \(not one whole pack of 5 is left for this offer\)/);
  const o = await BulkOffer.findById(none.offer._id).lean();
  assert.equal(o.state, "withdrawn");
  assert.deepEqual(called("withdraw").map((c) => c[1]), ["eldorado"]);

  // The layer capped it (1 of 2) and the share cannot be re-counted: down too.
  resetMarkets();
  mk.noclaimLanded = 1;
  send.__setDeps({
    noclaimStock: {
      stockForListing: async () => {
        throw new Error("snapshot unreadable");
      },
    },
  });
  const unknown = await send1();
  assert.equal(unknown.status, 409);
  assert.match(unknown.message, /only 1 of 2 pack\(s\) landed and the shelf could not be re-counted \(snapshot unreadable\)/);
  send.__setDeps({ noclaimStock: fakeNoclaimStock });

  // Enough for what landed: left alone.
  resetMarkets();
  ncStock.share = 12;
  const fine = await send1();
  assert.equal(fine.status, 200, fine.message);
  assert.equal(called("setQuantity").length, 0);
  assert.equal(fine.offer.advertisedQty, 2);
});

test("farm: packs = packsFor(share, N), capped by the owner's accounts", async () => {
  const r = await send.sendOffer({ source: "farm", game: "Rust", days: 120, market: "eldorado", minQty: 5, units: 7 });
  assert.equal(r.status, 200, r.message);
  assert.equal(r.offer.advertisedQty, 1, "7 accounts = one pack of 5");
  assert.equal(called("publishFarm")[0][1].quantity, 1);
  const g = await send.sendOffer({ source: "farm", game: "Rust", days: 180, market: "eldorado", minQty: 5, units: 12 });
  assert.equal(g.status, 200, g.message);
  assert.equal(g.offer.advertisedQty, 2, "its share (10 of 20) caps the owner's 12: 2 packs");
});

test("resume sets the quantity in packs first: no-claim at its share, farm at its capacity share", async () => {
  const set = await makeSet({
    name: "OW no-claim",
    stockSource: "noclaim",
    items: [{ itemKey: "ow:1", name: "Skin", game: "Overwatch" }],
  });
  st.noclaim = { free: 30, share: { eldorado: 20, g2g: 0 } };
  ncStock.share = 20;
  const r = await send.sendOffer({ source: "noclaim", setId: String(set._id), market: "eldorado", minQty: 5 });
  assert.equal(r.status, 200, r.message);
  assert.equal((await send.pauseOffer({ offerId: String(r.offer._id) })).status, 200);
  ncStock.share = 12;
  mk.calls = [];
  const ok = await send.resumeOffer({ offerId: String(r.offer._id) });
  assert.equal(ok.status, 200, ok.message);
  assert.deepEqual(
    mk.calls.map((c) => [c[0], c[3]]),
    [
      ["setQuantity", 2],
      ["resume", undefined],
    ],
  );
  assert.equal(ok.offer.advertisedQty, 2);
  // Not one pack behind it: refused, nothing called.
  assert.equal((await send.pauseOffer({ offerId: String(r.offer._id) })).status, 200);
  ncStock.share = 4;
  mk.calls = [];
  const short = await send.resumeOffer({ offerId: String(r.offer._id) });
  assert.equal(short.status, 409);
  assert.match(short.message, /one pack is 5/);
  assert.equal(mk.calls.length, 0);
});
