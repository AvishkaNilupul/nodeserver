// Bulk packs — send.js (docs/bulk-packs/MODULES.md §send.js, API-UI.md Tests A5).
//
// Memory Mongo with the REAL BulkOffer / MarketplaceListing / DropSet models,
// the REAL delivery gate (utils/bulkPacks/config.js, fed a fake settings
// object) and the REAL farm-order parsers (eldoradoFarmService /
// g2gFarmService, fed a CampaignDrops row). Every sibling module and every
// marketplace is a fake that records its calls: no network, and the real
// utils/settings.json is never read.
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

const round2 = (x) => Math.round(x * 100) / 100;
const fakePricing = {
  unitPrice: ({ anchor, discountPct, market }) =>
    anchor > 0
      ? Math.max(
          config.MARKET_FLOORS[market],
          round2(anchor * (1 - discountPct / 100)),
        )
      : 0,
  packPrice: ({ anchor, discountPct, size }) =>
    anchor > 0 && size > 0
      ? Math.max(
          0.75,
          Math.round(size * anchor * (1 - discountPct / 100) * 4) / 4,
        )
      : 0,
  farmUnitPrice: ({ farmPrices, market, days, discountPct }) => {
    const a = Number(
      farmPrices && farmPrices[market] && farmPrices[market][String(days)],
    );
    return a > 0
      ? Math.max(
          config.MARKET_FLOORS[market],
          round2(a * (1 - discountPct / 100)),
        )
      : 0;
  },
  pickAnchor: ({ rows, set, market }) => {
    const c = (rows || [])
      .filter(
        (r) =>
          r.marketplace === market &&
          r.status === "active" &&
          !r.bulkOfferId &&
          String(r.set) === String(set._id) &&
          r.price > 0,
      )
      .sort((a, b) => a.price - b.price);
    if (c.length)
      return {
        anchor: c[0].price,
        basis: "listing",
        listingId: String(c[0]._id),
      };
    if (Number(set.price) > 0)
      return { anchor: Number(set.price), basis: "set", listingId: "" };
    return { anchor: 0, basis: "none", listingId: "" };
  },
};

const copyState = { accountsTitle: null, farmTitle: null };
const fakeCopy = {
  baseTitleForSet: ({ set, anchorRow }) =>
    anchorRow && anchorRow.title
      ? anchorRow.title
      : set.name || "Twitch Drops bundle",
  accountsTitle: (a) =>
    copyState.accountsTitle
      ? copyState.accountsTitle(a)
      : a.market === "gameflip"
        ? a.baseTitle + " — PACK OF " + a.minQty + " ACCOUNTS"
        : a.baseTitle +
          " — BULK " +
          a.minQty +
          "+ accounts (" +
          a.discountPct +
          "% off)",
  accountsDescription: ({ minQty }) =>
    "Each account holds the whole bundle. Minimum order " + minQty + ".",
  farmTitle: (a) =>
    copyState.farmTitle
      ? copyState.farmTitle(a)
      : a.game +
        " Twitch Drops Automatic Farming " +
        (a.days === 365 ? "1 Year" : a.days + " Days") +
        " — Bulk " +
        a.minQty +
        "+ Accounts",
  farmDescription: ({ game, days, minQty }) =>
    "Minimum order " +
    minQty +
    ". Each account farms " +
    game +
    " for " +
    days +
    " days.",
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
const fakeMarkets = {
  gameOfSet: (set) =>
    set.coverGame || (set.items && set.items[0] && set.items[0].game) || "",
  coverForSet: async () => "",
  publishAccounts: async (args) => {
    mk.calls.push(["publishAccounts", args]);
    if (mk.onPublish) await mk.onPublish(args);
    maybeFail("publishAccounts");
    return {
      externalId: mk.noId ? "" : "EXT-" + ++mk.seq,
      url: "https://market.test/offer/" + mk.seq,
      price: args.market === "gameflip" ? args.packPrice : args.unitPrice,
    };
  },
  publishNoclaim: async (args) => {
    mk.calls.push(["publishNoclaim", args]);
    maybeFail("publishNoclaim");
    // What noclaimListings.publishClaimAtSale writes: a claim-at-sale row,
    // origin manual, noclaimStock, no units.
    const row = await MarketplaceListing.create({
      set: args.set._id,
      marketplace: args.market,
      externalId: "NC-" + ++mk.seq,
      url: "https://market.test/nc/" + mk.seq,
      title: args.title,
      description: args.description,
      price: args.unitPrice,
      status: "active",
      origin: "manual",
      noclaimStock: true,
      qtyTarget: args.quantity,
      autoDeliver: false,
    });
    return {
      rowId: String(row._id),
      externalId: row.externalId,
      url: row.url,
      price: args.unitPrice,
    };
  },
  publishFarm: async (args) => {
    mk.calls.push(["publishFarm", args]);
    maybeFail("publishFarm");
    return {
      externalId: "FARM-" + ++mk.seq,
      url: "https://market.test/farm/" + mk.seq,
      price: args.unitPrice,
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

test("eldorado dropset happy path: reserved units ride on a manual row owned by the offer", async () => {
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
  assert.equal(offer.unitPrice, 1.9);
  assert.equal(offer.advertisedQty, 20, "min(unitsPerOffer 20, surplus 30-5)");
  assert.equal(
    offer.slotKey,
    ["accounts", "dropset", String(set._id), "eldorado", 5].join("|"),
  );
  assert.equal(entries(offer, "on_offer").length, 20);
  assert.equal(offer.externalId, "EXT-1");

  const pub = called("publishAccounts")[0][1];
  assert.equal(pub.market, "eldorado");
  assert.equal(pub.minQty, 5);
  assert.equal(pub.unitPrice, 1.9);
  assert.equal(pub.units.length, 20);
  assert.ok(pub.units.every((u) => !("password" in u)));
  assert.equal(st.reserveCalls[0].market, "eldorado");
  assert.equal(st.reserveCalls[0].n, 20);

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
  assert.equal(row.qtyTarget, 20);
  assert.equal(row.price, 1.9);
  assert.equal(row.note, "bulk pack: min 5 (5% off), 20 reserved");
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
      /Bulk offer live: .* — Eldorado, \$1\.90 each/.test(t),
    ),
  );
  assert.ok(events.some((e) => e.category === "bulk" && e.action === "sent"));
  assert.equal(proposalsState.invalidated, 1);
});

test("g2g dropset honours the owner's account count", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  const r = await sendDropset(set, "g2g", { units: 8, minQty: 10 });
  assert.equal(r.status, 400, "8 accounts cannot carry a 10+ minimum");
  const ok = await sendDropset(set, "g2g", { units: 8 });
  assert.equal(ok.status, 200, ok.message);
  const row = await MarketplaceListing.findOne({
    bulkOfferId: ok.offer._id,
  }).lean();
  assert.equal(row.marketplace, "g2g");
  assert.equal(row.units.length, 8);
  assert.equal(row.qtyTarget, 8);
  assert.equal(ok.offer.advertisedQty, 8);
  assert.equal(ok.offer.unitPrice, 1.9);
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
  assert.deepEqual(
    called("setQuantity").map((c) => [c[1], c[2], c[3]]),
    [["eldorado", "EXT-1", 19]],
  );
  assert.equal(r.offer.advertisedQty, 19);
  assert.ok(telegrams.some((t) => /integrity/.test(t)));
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
  assert.equal(pub.units.length, 5);

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
  assert.equal(row.lotSize, 0, "not an unclaimed lot row");
  assert.equal(row.note, "bulk pack: min 5 (5% off), 5 reserved");
  assert.equal(r.offer.packPrice, 9.5);
  assert.equal(r.offer.advertisedQty, 5);
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
  assert.equal(pub.quantity, 12, "min(unitsPerOffer 20, share 12)");
  assert.equal(pub.minQty, 5);
  assert.equal(
    st.reserveCalls.length,
    0,
    "no-claim stock is claimed at sale, not reserved",
  );
  const row = await MarketplaceListing.findById(r.offer.listing).lean();
  assert.equal(String(row.bulkOfferId), String(r.offer._id));
  assert.equal(row.noclaimStock, true);
  assert.equal(row.origin, "manual");
  assert.equal(r.offer.state, "live");
  assert.equal(r.offer.advertisedQty, 12);
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
  assert.equal(offer.unitPrice, 2.85); // $3 × 0.95
  assert.equal(offer.advertisedQty, 20); // min(farmMaxQty 20, room 30, 60-20, 60-20)
  const pub = called("publishFarm")[0][1];
  assert.equal(pub.quantity, 20);
  assert.equal(pub.minQty, 5);
  assert.match(pub.title, /^Rust Twitch Drops Automatic Farming 120 Days/);
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
  // offer, so this one advertises its share (10), below the owner's 12.
  assert.equal(
    g.offer.advertisedQty,
    10,
    "its share of the shared farm capacity",
  );
  assert.equal(called("publishFarm")[1][1].quantity, 10);
  assert.match(called("publishFarm")[1][1].title, /1 Year/);
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

test("refill: atomic $push per unit, reserved[] authority, quantity re-read from the row", async () => {
  const set = await makeSet();
  st.pool = accounts(30);
  const r = await sendDropset(set, "eldorado", { units: 6 });
  assert.equal(r.status, 200);
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
  const f = await send.refillOffer({
    offerId: String(r.offer._id),
    add: 4,
    actor: "admin:t",
  });
  assert.equal(f.status, 200, f.message);
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
  assert.deepEqual(
    called("setQuantity").map((c) => c[3]),
    [9],
  );
  const offer = await BulkOffer.findById(r.offer._id).lean();
  assert.equal(offer.advertisedQty, 9);
  assert.equal(entries(offer, "on_offer").length, 10);

  // Only dropset eldorado/g2g offers refill; and not past the singles reserve.
  st.pool = st.pool.slice(0, 12); // 12 held-or-free, 10 held -> 2 free, surplus -3
  const none = await send.refillOffer({ offerId: String(r.offer._id), add: 4 });
  assert.equal(none.status, 409);
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

  // Two units sell while paused: 4 left < minimum 5.
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

  const f = await send.refillOffer({ offerId: String(r.offer._id), add: 3 });
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
