// No-claim Shop listings on the two CLAIM-AT-SALE fulfillers that hand over a
// farmed account in chat: Eldorado and PlayerAuctions
// (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §8b).
//
// These deliver PAID orders on live markets, so the rules under test are the
// ones that cost money when they break:
//
//  1. A no-claim row claims through utils/noclaimStock with mode "sold" and the
//     order's own id — never the Drop Archive (its accounts carry CLAIMED
//     drops, worthless to this buyer) and never the unclaimedGame ledger walk.
//  2. A retry after a failed hand-over RESUMES this order's accounts; it never
//     burns a second set (the e69b19d3 lesson, 25 retries, 25 sets).
//  3. The sale is stamped (ncs.markSold) only after the buyer has the account.
//  4. The stock sweeps count a no-claim row with ncs.stockForListing, and a
//     count that FAILS skips the row: 0 is what takes a live offer off sale.
//  5. A row without the flag takes exactly the path it took before, and never
//     even loads the no-claim layer.
//
// No Mongo, no network. utils/noclaimStock.js is being written alongside this
// file and may not exist yet, so the harness resolves a stub for it by hand.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");
const path = require("node:path");

process.env.CRED_SECRET ||= "test-secret";

/* ------------------------------- harness -------------------------------- */

function spy(impl = async () => undefined) {
  const fn = (...args) => {
    fn.calls.push(args);
    return impl(...args);
  };
  fn.calls = [];
  return fn;
}

// The file a test-relative request names — by hand when it is not on disk yet.
function keyFor(request) {
  try {
    return require.resolve(request);
  } catch {
    const file = path.resolve(__dirname, request);
    return file.endsWith(".js") ? file : file + ".js";
  }
}
const NCS_FILE = keyFor("../utils/noclaimStock");

// Load `target` with its dependencies replaced, and keep them replaced for the
// whole of `fn`: both fulfillers require ./noclaimStock and ../models/DropSet
// lazily INSIDE the branch under test, i.e. at call time. `ncsLoads()` counts
// how often the fulfiller reached for the no-claim layer at all.
async function withStubbed(target, stubs, fn) {
  const targetFile = require.resolve(target);
  const map = new Map(Object.entries(stubs).map(([k, v]) => [keyFor(k), v]));
  let ncsLoads = 0;
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    let file;
    try {
      file = Module._resolveFilename(request, parent, isMain);
    } catch {
      if (parent && parent.filename && /^\.\.?\//.test(request)) {
        file = path.resolve(path.dirname(parent.filename), request);
        if (!file.endsWith(".js")) file += ".js";
      }
      if (!file || !map.has(file)) return origLoad.apply(this, arguments);
    }
    if (file === NCS_FILE) ncsLoads++;
    return map.has(file) ? map.get(file) : origLoad.apply(this, arguments);
  };
  delete require.cache[targetFile];
  try {
    return await fn(require(target), { ncsLoads: () => ncsLoads });
  } finally {
    Module._load = origLoad;
    delete require.cache[targetFile];
  }
}

// A MarketplaceListing document. Plain object on purpose (a Mongoose
// sub-document must never be spread). `log` records the order of side effects.
function row(fields, log = []) {
  const d = {
    units: [],
    status: "active",
    ...fields,
    saves: 0,
    markModified() {},
    async save() {
      d.saves++;
      log.push("save");
      return d;
    },
  };
  return d;
}

function fakeListingModel(rows, { count = 1 } = {}) {
  const calls = { find: [], findOne: [], countDocuments: [] };
  const chain = () => {
    const p = Promise.resolve(rows);
    p.limit = () => p;
    p.lean = () => p;
    p.sort = () => p;
    return p;
  };
  return {
    calls,
    find(q) {
      calls.find.push(q);
      return chain();
    },
    async findOne(q) {
      calls.findOne.push(q);
      return rows[0] || null;
    },
    async countDocuments(q) {
      calls.countDocuments.push(q);
      return count;
    },
  };
}

function fakeById(value) {
  const calls = [];
  return {
    calls,
    findById(id) {
      calls.push(String(id));
      const p = Promise.resolve(value);
      p.lean = () => Promise.resolve(value);
      return p;
    },
  };
}

// The unclaimedGame ledger. `find` answers the resume query (status "sold")
// with nothing and the candidate scan with `candidates`.
function fakeUnclaimed({ candidates = [], byId = {} } = {}) {
  const calls = { find: [], findOneAndUpdate: [], findById: [] };
  const chain = (v) => {
    const p = Promise.resolve(v);
    p.sort = () => p;
    p.limit = () => p;
    p.lean = () => p;
    return p;
  };
  return {
    calls,
    find(q) {
      calls.find.push(q);
      return chain(q && q.status === "sold" ? [] : candidates);
    },
    async findOneAndUpdate(q, u) {
      calls.findOneAndUpdate.push({ q, u });
      return { _id: q._id };
    },
    findById(id) {
      calls.findById.push(String(id));
      const v = byId[String(id)] || null;
      const p = Promise.resolve(v);
      p.lean = () => Promise.resolve(v);
      return p;
    },
  };
}

const ualStub = {
  credentialForLedger: async (r) => ({ login: r.login, password: "pw-" + r.login }),
  manualSoldOwnerKeys: async () => new Set(),
  filterManualSoldLedgers: (rows) => rows,
  activeListingsForLogin: async () => [],
};

const coverageStub = {
  requiredCounts: (req) =>
    new Map((req || []).map((d) => [String(d.name).toLowerCase(), d.qty || 1])),
  partitionByCoverage: (cands) => ({ covering: cands, short: [] }),
  liveCoverage: async () => ({ ok: true, missing: [], claimed: [] }),
  summarizeMissing: () => "",
};

// utils/noclaimStock, modelled on the contract (§3) closely enough to catch a
// fulfiller that breaks the resume: an order's claim is keyed exactly like the
// real resume query — market, listingId and the "<market> order <id>" note —
// so a retry that passed a different key would take FRESH accounts, and
// `fresh` would show it.
function fakeNcs({
  enabled = true,
  free = [],
  stock = 0,
  stockThrows = false,
  markSoldThrows = false,
  log = [],
} = {}) {
  const calls = { claimForSet: [], markSold: [], stockForListing: [] };
  const soldTo = new Map();
  const pool = free.slice();
  const fresh = [];
  return {
    calls,
    fresh,
    deliveryEnabled: () => enabled,
    async claimForSet(set, want, opts = {}) {
      calls.claimForSet.push({ set, want, opts: { ...opts } });
      log.push("claim");
      if (opts.dryRun) return pool.slice(0, want);
      if (!enabled) return [];
      const key =
        opts.mode === "sold" && opts.orderId
          ? [opts.market, opts.listingId, opts.market + " order " + opts.orderId].join("|")
          : "";
      const out = key ? (soldTo.get(key) || []).slice(0, want) : [];
      while (out.length < want && pool.length) {
        const acc = pool.shift();
        fresh.push(acc);
        out.push(acc);
      }
      if (key) soldTo.set(key, out.slice());
      return out;
    },
    async markSold(ids, opts) {
      calls.markSold.push({ ids: ids.slice(), opts: { ...opts } });
      log.push("markSold");
      if (markSoldThrows) throw new Error("atlas hiccup");
      return ids.length;
    },
    async stockForListing(r) {
      calls.stockForListing.push(r);
      log.push("stock");
      if (stockThrows) throw new Error("atlas hiccup");
      return stock;
    },
  };
}

// The Drop Archive side of the world. A no-claim sale that touches any of
// these is shipping an account whose drops are already claimed.
function archiveSpies() {
  return {
    availableAccountsForSet: spy(async () => [
      { accountId: "ARCH1", login: "archive_account" },
    ]),
    reserveSetOnAccount: spy(async () => true),
  };
}
function archiveTouches(arch) {
  return arch.availableAccountsForSet.calls.length + arch.reserveSetOnAccount.calls.length;
}

const SET = {
  _id: "SET-NC",
  name: "Overwatch OWWC",
  stockSource: "noclaim",
  items: [
    { name: "Loot Box", qty: 1 },
    { name: "Spray", qty: 1 },
  ],
};
const REQUIRED = [
  { name: "Loot Box", qty: 1 },
  { name: "Spray", qty: 1 },
];
const NC1 = { ledgerId: "LED1", login: "nc_one", password: "pw1" };
const NC2 = { ledgerId: "LED2", login: "nc_two", password: "pw2" };

/* ------------------------------ Eldorado -------------------------------- */

function eldEnv({ rows = [], ncs, set = SET, unclaimed = fakeUnclaimed(), log = [] } = {}) {
  const arch = archiveSpies();
  const Listing = fakeListingModel(rows);
  const DropSet = fakeById(set);
  const mp = {
    eldoradoSendOrderMessage: spy(async () => {
      log.push("send");
      return {};
    }),
    eldoradoMarkDelivered: spy(async () => {
      log.push("delivered");
      return {};
    }),
    eldoradoSetQuantity: spy(async () => ({})),
    eldoradoDelist: spy(async () => ({})),
    eldoradoRelist: spy(async () => ({})),
    eldoradoOffer: spy(async () => ({ offerState: "Active", quantity: 1 })),
  };
  const stubs = {
    "../models/MarketplaceListing": Listing,
    "../models/BotAccount": fakeById(null),
    "../models/UnclaimedAccount": unclaimed,
    "../models/DropSet": DropSet,
    "../models/DropLog": fakeById(null),
    "../routes/shopRoutes": { availableAccountsForSet: arch.availableAccountsForSet },
    "../utils/listedLogins": {
      loginsOnActiveListings: async () => new Set(),
      notListed: (a) => a,
    },
    "../utils/secretBox": { decrypt: (v) => String(v || "") },
    "../utils/dropReservation": {
      reserveSetOnAccount: arch.reserveSetOnAccount,
      releaseAccountsForTag: spy(async () => 0),
    },
    "../utils/settings": {
      getAutoFarm: () => ({}),
      getAccountListingSettings: () => ({ enabled: true, autoDeliver: true }),
    },
    "../utils/marketplaces": mp,
    "../utils/eldoradoFarmService": { deliverFarmOrder: async () => null },
    "../utils/unclaimedCoverage": coverageStub,
    "../utils/unclaimedAutoList": ualStub,
    "../utils/operatorFarm": {},
    "../utils/telegram": { sendTelegram: async () => {} },
    "../utils/noclaimStock": ncs || fakeNcs(),
  };
  return { stubs, arch, mp, Listing, DropSet, unclaimed };
}

function eldNoclaimRow(log, extra = {}) {
  return row(
    {
      _id: "L-NC",
      marketplace: "eldorado",
      externalId: "e-1",
      title: "Overwatch Twitch Drops (2 Items)",
      price: 4,
      noclaimStock: true,
      set: "SET-NC",
      requiredDrops: REQUIRED,
      ...extra,
    },
    log,
  );
}

test("Eldorado: a no-claim order claims via noclaimStock (mode sold), ships it, then stamps the sale", async () => {
  const log = [];
  const listing = eldNoclaimRow(log);
  const ncs = fakeNcs({ free: [NC1], log });
  const env = eldEnv({ rows: [listing], ncs, log });

  const out = await withStubbed("../utils/eldoradoFulfiller", env.stubs, (e) =>
    e.deliverOrder(
      {
        id: "eo-1",
        offerId: "e-1",
        purchaseQuantity: 1,
        talkJsConversationId: "c-1",
        totalPrice: { amount: 6, currency: "USD" },
      },
      { dryRun: false },
    ),
  );

  assert.deepStrictEqual(out, { orderId: "eo-1", delivered: 1, source: "noclaim-set:SET-NC" });
  assert.strictEqual(ncs.calls.claimForSet.length, 1);
  const claim = ncs.calls.claimForSet[0];
  assert.strictEqual(claim.set, SET, "claims against the row's own no-claim set");
  assert.deepStrictEqual(env.DropSet.calls, ["SET-NC"]);
  assert.strictEqual(claim.want, 1);
  assert.deepStrictEqual(claim.opts, {
    market: "eldorado",
    listingId: "L-NC",
    orderId: "eo-1",
    mode: "sold",
    dryRun: false,
  });

  // The buyer got the claimed credential, in the house copy.
  const msg = env.mp.eldoradoSendOrderMessage.calls[0][1];
  assert.match(msg, /Username: nc_one/);
  assert.match(msg, /Password: pw1/);
  assert.deepStrictEqual(env.mp.eldoradoMarkDelivered.calls[0], ["eo-1"]);

  // The receipt: the ledger id where the unclaimed branch puts it.
  assert.strictEqual(listing.units.length, 1);
  assert.strictEqual(listing.units[0].contentId, "LED1");
  assert.strictEqual(listing.units[0].accountId, "");
  assert.strictEqual(listing.units[0].login, "nc_one");
  assert.strictEqual(listing.units[0].orderId, "eo-1");
  assert.ok(listing.units[0].deliveredAt);

  // The sale stamp, with the order's own unit price, AFTER the hand-over.
  assert.deepStrictEqual(ncs.calls.markSold, [
    {
      ids: ["LED1"],
      opts: { market: "eldorado", priceUsd: 6, orderId: "eo-1", reason: "eldorado order eo-1" },
    },
  ]);
  assert.deepStrictEqual(log, ["claim", "send", "delivered", "save", "markSold"]);

  // Neither of the other stock sources was touched.
  assert.strictEqual(archiveTouches(env.arch), 0, "no Drop Archive account for a no-claim sale");
  assert.strictEqual(env.unclaimed.calls.find.length, 0, "the unclaimedGame ledger walk never ran");
});

test("Eldorado: without an order total the sale is stamped at the listing's price", async () => {
  const listing = eldNoclaimRow([]);
  const ncs = fakeNcs({ free: [NC1, NC2] });
  const env = eldEnv({ rows: [listing], ncs });

  const out = await withStubbed("../utils/eldoradoFulfiller", env.stubs, (e) =>
    e.deliverOrder({ id: "eo-9", offerId: "e-1", purchaseQuantity: 2 }, { dryRun: false }),
  );

  assert.strictEqual(out.delivered, 2);
  assert.strictEqual(ncs.calls.claimForSet[0].want, 2);
  assert.match(env.mp.eldoradoSendOrderMessage.calls[0][1], /=== ACCOUNT 2 of 2 ===/);
  assert.deepStrictEqual(ncs.calls.markSold[0].ids, ["LED1", "LED2"]);
  assert.strictEqual(ncs.calls.markSold[0].opts.priceUsd, 4);
});

test("Eldorado: a failed send is retried with the SAME accounts, never a second claim", async () => {
  const listing = eldNoclaimRow([]);
  const ncs = fakeNcs({ free: [NC1, NC2] });
  const env = eldEnv({ rows: [listing], ncs });
  let failSend = true;
  env.mp.eldoradoSendOrderMessage = spy(async () => {
    if (failSend) throw new Error("TalkJS 503");
    return {};
  });
  const order = { id: "eo-2", offerId: "e-1", purchaseQuantity: 1 };

  await withStubbed("../utils/eldoradoFulfiller", env.stubs, async (e) => {
    // Tick 1: the claim lands, the send throws. Nothing is recorded as
    // delivered, nothing is released, nothing is stamped sold.
    await assert.rejects(e.deliverOrder(order, { dryRun: false }), /TalkJS 503/);
    assert.strictEqual(listing.units.length, 0);
    assert.strictEqual(ncs.calls.markSold.length, 0);

    // Tick 2: the same order, the same key — the claim layer hands back LED1.
    failSend = false;
    const out = await e.deliverOrder(order, { dryRun: false });
    assert.strictEqual(out.delivered, 1);

    // Tick 3: the receipt now stops it before any claim.
    const again = await e.deliverOrder(order, { dryRun: false });
    assert.strictEqual(again.skipped, "already delivered");
  });

  assert.deepStrictEqual(
    ncs.fresh.map((a) => a.ledgerId),
    ["LED1"],
    "a retry must never burn a second account",
  );
  assert.strictEqual(ncs.calls.claimForSet.length, 2);
  for (const c of ncs.calls.claimForSet) {
    assert.deepStrictEqual(
      { market: c.opts.market, listingId: c.opts.listingId, orderId: c.opts.orderId, mode: c.opts.mode },
      { market: "eldorado", listingId: "L-NC", orderId: "eo-2", mode: "sold" },
    );
  }
  assert.match(env.mp.eldoradoSendOrderMessage.calls[1][1], /Password: pw1/);
  assert.deepStrictEqual(listing.units.map((u) => u.contentId), ["LED1"]);
  assert.deepStrictEqual(ncs.calls.markSold.map((c) => c.ids), [["LED1"]]);
});

test("Eldorado: a failed sale stamp never turns a delivered order into a failure", async () => {
  const listing = eldNoclaimRow([]);
  const ncs = fakeNcs({ free: [NC1], markSoldThrows: true });
  const env = eldEnv({ rows: [listing], ncs });

  const realError = console.error;
  console.error = () => {};
  let out;
  try {
    out = await withStubbed("../utils/eldoradoFulfiller", env.stubs, (e) =>
      e.deliverOrder({ id: "eo-3", offerId: "e-1", purchaseQuantity: 1 }, { dryRun: false }),
    );
  } finally {
    console.error = realError;
  }
  assert.strictEqual(out.delivered, 1);
  assert.strictEqual(listing.units[0].orderId, "eo-3", "the receipt is already saved");
});

test("Eldorado: the kill switch and a shortfall hold the order and page the operator", async () => {
  // Kill switch: refused BEFORE anything is claimed.
  {
    const listing = eldNoclaimRow([]);
    const ncs = fakeNcs({ enabled: false, free: [NC1] });
    const env = eldEnv({ rows: [listing], ncs });
    const out = await withStubbed("../utils/eldoradoFulfiller", env.stubs, async (e) => {
      const r = await e.deliverOrder({ id: "eo-4", offerId: "e-1", purchaseQuantity: 1 }, { dryRun: false });
      assert.ok(e.alertsOperator(r.skipped), "a parked paid order must page");
      return r;
    });
    assert.deepStrictEqual(out, { orderId: "eo-4", skipped: "no-claim listing auto-delivery is off" });
    assert.strictEqual(ncs.calls.claimForSet.length, 0);
    assert.strictEqual(env.mp.eldoradoSendOrderMessage.calls.length, 0);
  }
  // Shortfall: held, nothing sent, nothing stamped — and the same page the
  // unclaimed branch's "free in the no-claim farm" shortfall gets.
  {
    const listing = eldNoclaimRow([]);
    const ncs = fakeNcs({ free: [] });
    const env = eldEnv({ rows: [listing], ncs });
    const out = await withStubbed("../utils/eldoradoFulfiller", env.stubs, async (e) => {
      const r = await e.deliverOrder({ id: "eo-5", offerId: "e-1", purchaseQuantity: 1 }, { dryRun: false });
      assert.ok(e.alertsOperator(r.error), "a short paid order must page: " + r.error);
      return r;
    });
    assert.match(out.error, /no free no-claim account holds all 2 advertised item\(s\)/);
    assert.strictEqual(env.mp.eldoradoSendOrderMessage.calls.length, 0);
    assert.strictEqual(listing.units.length, 0);
    assert.strictEqual(ncs.calls.markSold.length, 0);
  }
  // A missing set claims nothing and says so.
  {
    const listing = eldNoclaimRow([]);
    const ncs = fakeNcs({ free: [NC1] });
    const env = eldEnv({ rows: [listing], ncs, set: null });
    const out = await withStubbed("../utils/eldoradoFulfiller", env.stubs, (e) =>
      e.deliverOrder({ id: "eo-6", offerId: "e-1", purchaseQuantity: 1 }, { dryRun: false }),
    );
    assert.match(out.error, /no free no-claim account.*no-claim set is missing/);
    assert.strictEqual(ncs.calls.claimForSet.length, 0);
  }
});

test("Eldorado: a dry run previews through the claim layer without committing", async () => {
  const listing = eldNoclaimRow([]);
  const ncs = fakeNcs({ free: [NC1] });
  const env = eldEnv({ rows: [listing], ncs });

  const out = await withStubbed("../utils/eldoradoFulfiller", env.stubs, (e) =>
    e.deliverOrder({ id: "eo-7", offerId: "e-1", purchaseQuantity: 1 }, { dryRun: true }),
  );

  assert.strictEqual(out.dryRun, true);
  assert.strictEqual(out.source, "noclaim-set:SET-NC");
  assert.match(out.wouldSend, /nc_one/);
  assert.strictEqual(ncs.calls.claimForSet[0].opts.dryRun, true, "a dry run must never sell the ledger");
  assert.strictEqual(ncs.fresh.length, 0);
  assert.strictEqual(env.mp.eldoradoSendOrderMessage.calls.length, 0);
  assert.strictEqual(listing.units.length, 0);
  assert.strictEqual(ncs.calls.markSold.length, 0);
});

test("Eldorado: syncBundleStock counts a no-claim row with stockForListing, and skips it on a throw", async () => {
  // Counted from the claim layer — never from the archive, though the row has a set.
  {
    const listing = eldNoclaimRow([]);
    const ncs = fakeNcs({ stock: 3 });
    const env = eldEnv({ rows: [listing], ncs });
    const changes = await withStubbed("../utils/eldoradoFulfiller", env.stubs, (e) =>
      e.syncBundleStock({ dryRun: false }),
    );
    const or = env.Listing.calls.find[0].$or || [];
    assert.ok(
      or.some((c) => c.noclaimStock === true && c.status === "active"),
      "the sweep must select active no-claim rows",
    );
    assert.deepStrictEqual(ncs.calls.stockForListing, [listing]);
    assert.deepStrictEqual(env.mp.eldoradoSetQuantity.calls, [["e-1", 3]]);
    assert.strictEqual(env.DropSet.calls.length, 0, "the set branch must not count a no-claim row");
    assert.strictEqual(archiveTouches(env.arch), 0);
    assert.strictEqual(changes.length, 1);
  }
  // A count that FAILS is not an empty shelf: the row is left alone this pass.
  {
    const listing = eldNoclaimRow([]);
    const ncs = fakeNcs({ stockThrows: true });
    const env = eldEnv({ rows: [listing], ncs });
    const realError = console.error;
    console.error = () => {};
    let changes;
    try {
      changes = await withStubbed("../utils/eldoradoFulfiller", env.stubs, (e) =>
        e.syncBundleStock({ dryRun: false }),
      );
    } finally {
      console.error = realError;
    }
    assert.deepStrictEqual(changes, []);
    assert.strictEqual(env.mp.eldoradoOffer.calls.length, 0);
    assert.strictEqual(env.mp.eldoradoSetQuantity.calls.length, 0);
    assert.strictEqual(env.mp.eldoradoDelist.calls.length, 0);
    assert.strictEqual(listing.saves, 0);
  }
  // A REAL zero pauses the offer, exactly as for every other stock source.
  {
    const listing = eldNoclaimRow([]);
    const env = eldEnv({ rows: [listing], ncs: fakeNcs({ stock: 0 }) });
    await withStubbed("../utils/eldoradoFulfiller", env.stubs, (e) =>
      e.syncBundleStock({ dryRun: false }),
    );
    assert.deepStrictEqual(env.mp.eldoradoDelist.calls, [["e-1"]]);
    assert.strictEqual(listing.autoPaused, true);
  }
});

test("Eldorado: rows without the flag take their old path and never load the no-claim layer", async () => {
  const listing = row({
    _id: "L-UG",
    marketplace: "eldorado",
    externalId: "e-2",
    unclaimedGame: "Overwatch",
    set: "SET-OLD",
  });
  const unclaimed = fakeUnclaimed({ candidates: [{ _id: "U1", login: "ug_one" }] });
  const env = eldEnv({ rows: [listing], unclaimed });

  await withStubbed("../utils/eldoradoFulfiller", env.stubs, async (e, h) => {
    const out = await e.deliverOrder({ id: "eo-8", offerId: "e-2", purchaseQuantity: 1 }, { dryRun: false });
    assert.deepStrictEqual(out, { orderId: "eo-8", delivered: 1, source: "unclaimed:Overwatch" });
    assert.strictEqual(unclaimed.calls.findOneAndUpdate.length, 1, "claimed off the unclaimed ledger");
    assert.strictEqual(listing.units[0].contentId, "U1");

    const archiveRow = row({ marketplace: "eldorado", externalId: "e-3", autoClaimSet: true, set: "SET-OLD" });
    env.Listing.find = () => {
      const p = Promise.resolve([archiveRow]);
      p.lean = () => p;
      return p;
    };
    await e.syncBundleStock({ dryRun: true });
    assert.strictEqual(env.arch.availableAccountsForSet.calls.length, 1, "archive rows still count the archive");

    assert.strictEqual(h.ncsLoads(), 0, "a row without the flag must never load utils/noclaimStock");
  });
});

/* --------------------------- PlayerAuctions ------------------------------ */

function paEnv({ rows = [], ncs, set = SET, unclaimed = fakeUnclaimed(), log = [], sharers = 1 } = {}) {
  const arch = archiveSpies();
  const Listing = fakeListingModel(rows, { count: sharers });
  const DropSet = fakeById(set);
  const mp = {
    playerauctionsOfferIdFromUrl: () => "",
    playerauctionsSendOrderMessage: spy(async () => {
      log.push("send");
      return {};
    }),
    playerauctionsMarkDelivered: spy(async () => {
      log.push("delivered");
      return {};
    }),
    playerauctionsSetQuantity: spy(async () => {
      log.push("setQuantity");
      return {};
    }),
    playerauctionsOffer: spy(async () => ({ totalUnit: 1 })),
    playerauctionsHide: spy(async () => ({})),
    playerauctionsDisplay: spy(async () => ({})),
    playerauctionsOfferUrl: (id) => "https://pa/" + id,
    paSanitizeTitle: (t) => String(t || ""),
  };
  const proof = {
    buildDeliveryProof: spy(async () => "/tmp/proof.png"),
    cleanupProof: spy(async () => {}),
  };
  const stubs = {
    "../models/MarketplaceListing": Listing,
    "../models/BotAccount": fakeById(null),
    "../models/UnclaimedAccount": unclaimed,
    "../models/DropSet": DropSet,
    "../models/DropLog": fakeById(null),
    "../routes/shopRoutes": { availableAccountsForSet: arch.availableAccountsForSet },
    "../utils/listedLogins": {
      loginsOnActiveListings: async () => new Set(),
      notListed: (a) => a,
    },
    "../utils/secretBox": { decrypt: (v) => String(v || "") },
    "../utils/dropReservation": {
      reserveSetOnAccount: arch.reserveSetOnAccount,
      releaseAccountsForTag: spy(async () => 0),
    },
    "../utils/settings": {
      getAutoFarm: () => ({}),
      getAccountListingSettings: () => ({ enabled: true, autoDeliver: true }),
    },
    "../utils/marketplaces": mp,
    "../utils/unclaimedCoverage": coverageStub,
    "../utils/unclaimedAutoList": ualStub,
    "../utils/playerauctionsProof": proof,
    "../utils/playerauctionsFarmService": { deliverFarmOrder: async () => null },
    "../utils/farmServiceAlert": { alertFarmFailure: async () => {} },
    "../utils/operatorFarm": {},
    "../utils/telegram": { sendTelegram: async () => {} },
    "../utils/noclaimStock": ncs || fakeNcs(),
  };
  return { stubs, arch, mp, proof, Listing, DropSet, unclaimed };
}

function paNoclaimRow(log, extra = {}) {
  return row(
    {
      _id: "P-NC",
      marketplace: "playerauctions",
      externalId: "pa-1",
      title: "Overwatch Twitch Drops (2 Items)",
      price: 5,
      noclaimStock: true,
      set: "SET-NC",
      requiredDrops: REQUIRED,
      ...extra,
    },
    log,
  );
}

function paOrder(id, extra = {}) {
  return {
    orderId: id,
    offerId: "pa-1",
    orderTitle: "Overwatch Twitch Drops (2 Items)",
    purchaseQuantity: 1,
    ...extra,
  };
}

test("PlayerAuctions: a no-claim order claims via noclaimStock, reserves BEFORE sending, then stamps the sale", async () => {
  const log = [];
  const listing = paNoclaimRow(log);
  const ncs = fakeNcs({ free: [NC1], stock: 3, log });
  const env = paEnv({ rows: [listing], ncs, log });

  const out = await withStubbed("../utils/playerauctionsFulfiller", env.stubs, (pa) =>
    pa.deliverOrder(paOrder("po-1", { detail: { orderInfo: { price: "5.50" } } }), { dryRun: false }),
  );

  assert.strictEqual(out.delivered, 1);
  assert.strictEqual(out.source, "noclaim-set:SET-NC");
  assert.strictEqual(ncs.calls.claimForSet.length, 1);
  assert.strictEqual(ncs.calls.claimForSet[0].set, SET);
  assert.deepStrictEqual(ncs.calls.claimForSet[0].opts, {
    market: "playerauctions",
    listingId: "P-NC",
    orderId: "po-1",
    mode: "sold",
    dryRun: false,
  });

  // The resume anchor is written before the first message goes out.
  assert.ok(log.indexOf("save") > -1 && log.indexOf("save") < log.indexOf("send"), log.join(","));
  assert.strictEqual(listing.units.length, 1);
  assert.strictEqual(listing.units[0].contentId, "LED1");
  assert.strictEqual(listing.units[0].accountId, "");
  assert.strictEqual(listing.units[0].orderId, "po-1");
  assert.ok(listing.units[0].messagedAt && listing.units[0].deliveredAt);
  assert.ok(
    env.mp.playerauctionsSendOrderMessage.calls.some(([, m]) => /pw1/.test(m)),
    "the claimed credential must reach the buyer",
  );
  assert.strictEqual(env.mp.playerauctionsMarkDelivered.calls.length, 1);

  // Stamped after the hand-over at the unit price paid, and before the
  // re-sync, which counts the shelf from the claim layer.
  assert.deepStrictEqual(ncs.calls.markSold, [
    {
      ids: ["LED1"],
      opts: {
        market: "playerauctions",
        priceUsd: 5.5,
        orderId: "po-1",
        reason: "playerauctions order po-1",
      },
    },
  ]);
  assert.ok(log.indexOf("delivered") < log.indexOf("markSold"), log.join(","));
  assert.ok(log.indexOf("markSold") < log.indexOf("stock"), log.join(","));
  assert.deepStrictEqual(env.mp.playerauctionsSetQuantity.calls, [["pa-1", 3]]);

  assert.strictEqual(archiveTouches(env.arch), 0, "no Drop Archive account for a no-claim sale");
  assert.strictEqual(env.unclaimed.calls.find.length, 0, "the unclaimedGame ledger walk never ran");
  assert.strictEqual(env.Listing.calls.countDocuments.length, 0, "the claim layer's share is not re-divided");
});

test("PlayerAuctions: a hand-over that failed part-way resumes the reserved units, never a second claim", async () => {
  const listing = paNoclaimRow([]);
  const ncs = fakeNcs({ free: [NC1, NC2], stock: 1 });
  const unclaimed = fakeUnclaimed({ byId: { LED1: { _id: "LED1", login: "nc_one" } } });
  const env = paEnv({ rows: [listing], ncs, unclaimed });
  let failSend = true;
  env.mp.playerauctionsSendOrderMessage = spy(async () => {
    if (failSend) throw new Error("PA 502");
    return {};
  });
  const order = paOrder("po-2");

  await withStubbed("../utils/playerauctionsFulfiller", env.stubs, async (pa) => {
    // Tick 1: claimed and reserved onto the row, then the send throws.
    await assert.rejects(pa.deliverOrder(order, { dryRun: false }), /PA 502/);
    assert.strictEqual(listing.units.length, 1);
    assert.strictEqual(listing.units[0].orderId, "po-2");
    assert.strictEqual(listing.units[0].deliveredAt, null);
    assert.strictEqual(ncs.calls.markSold.length, 0);

    // Tick 2: the RESUME block re-sends the reserved unit's credential, read
    // back off its ledger row — it never reaches the claim.
    failSend = false;
    const out = await pa.deliverOrder(order, { dryRun: false });
    assert.strictEqual(out.resumed, true);
    assert.strictEqual(out.delivered, 1);

    // Tick 3: fully delivered.
    const again = await pa.deliverOrder(order, { dryRun: false });
    assert.strictEqual(again.skipped, "already delivered");
  });

  assert.strictEqual(ncs.calls.claimForSet.length, 1, "a retry must never claim again");
  assert.deepStrictEqual(ncs.fresh.map((a) => a.ledgerId), ["LED1"]);
  assert.deepStrictEqual(unclaimed.calls.findById, ["LED1"]);
  assert.ok(
    env.mp.playerauctionsSendOrderMessage.calls.slice(1).some(([, m]) => /pw-nc_one/.test(m)),
    "the resumed send carries the SAME account",
  );
  assert.strictEqual(listing.units.length, 1);
  assert.ok(listing.units[0].deliveredAt);
  // The resumed hand-over still owes the sale its stamp, once.
  assert.deepStrictEqual(ncs.calls.markSold, [
    {
      ids: ["LED1"],
      opts: {
        market: "playerauctions",
        priceUsd: 5,
        orderId: "po-2",
        reason: "playerauctions order po-2",
      },
    },
  ]);
});

test("PlayerAuctions: the kill switch pages, a shortfall holds, a dry run commits nothing", async () => {
  {
    const listing = paNoclaimRow([]);
    const ncs = fakeNcs({ enabled: false, free: [NC1] });
    const env = paEnv({ rows: [listing], ncs });
    const out = await withStubbed("../utils/playerauctionsFulfiller", env.stubs, async (pa) => {
      const r = await pa.deliverOrder(paOrder("po-3"), { dryRun: false });
      assert.ok(pa.alertsOperator(r.skipped), "a parked paid order must page");
      return r;
    });
    assert.deepStrictEqual(out, { orderId: "po-3", skipped: "no-claim listing auto-delivery is off" });
    assert.strictEqual(ncs.calls.claimForSet.length, 0);
    assert.strictEqual(listing.saves, 0);
  }
  {
    const listing = paNoclaimRow([]);
    const ncs = fakeNcs({ free: [] });
    const env = paEnv({ rows: [listing], ncs });
    const out = await withStubbed("../utils/playerauctionsFulfiller", env.stubs, (pa) =>
      pa.deliverOrder(paOrder("po-4"), { dryRun: false }),
    );
    assert.match(out.error, /no free no-claim account holds all 2 advertised item\(s\)/);
    assert.strictEqual(listing.units.length, 0);
    assert.strictEqual(env.mp.playerauctionsSendOrderMessage.calls.length, 0);
    assert.strictEqual(ncs.calls.markSold.length, 0);
  }
  {
    const listing = paNoclaimRow([]);
    const ncs = fakeNcs({ free: [NC1] });
    const env = paEnv({ rows: [listing], ncs });
    const out = await withStubbed("../utils/playerauctionsFulfiller", env.stubs, (pa) =>
      pa.deliverOrder(paOrder("po-5"), { dryRun: true }),
    );
    assert.strictEqual(out.dryRun, true);
    assert.strictEqual(out.source, "noclaim-set:SET-NC");
    assert.strictEqual(ncs.calls.claimForSet[0].opts.dryRun, true, "a dry run must never sell the ledger");
    assert.strictEqual(listing.saves, 0);
    assert.strictEqual(env.mp.playerauctionsSendOrderMessage.calls.length, 0);
    assert.strictEqual(ncs.calls.markSold.length, 0);
  }
});

test("PlayerAuctions: stockFor and the stock sweep take a no-claim row's number from stockForListing", async () => {
  // stockFor: the claim layer's share, undivided, never the archive.
  {
    const listing = paNoclaimRow([]);
    const ncs = fakeNcs({ stock: 3 });
    const env = paEnv({ rows: [listing], ncs, sharers: 2 });
    const claim = spy(async () => []);
    const n = await withStubbed("../utils/playerauctionsFulfiller", env.stubs, (pa) =>
      pa.stockFor(listing, claim),
    );
    assert.strictEqual(n, 3);
    assert.strictEqual(claim.calls.length, 0);
    assert.strictEqual(env.DropSet.calls.length, 0);
    assert.strictEqual(env.Listing.calls.countDocuments.length, 0);
  }
  // A failed or garbled count is an error, never a number to push.
  for (const ncs of [fakeNcs({ stockThrows: true }), { ...fakeNcs(), stockForListing: async () => undefined }]) {
    const listing = paNoclaimRow([]);
    const env = paEnv({ rows: [listing], ncs });
    await withStubbed("../utils/playerauctionsFulfiller", env.stubs, (pa) =>
      assert.rejects(pa.stockFor(listing)),
    );
  }
  // The sweep selects no-claim rows and pushes the real count.
  {
    const listing = paNoclaimRow([]);
    const ncs = fakeNcs({ stock: 3 });
    const env = paEnv({ rows: [listing], ncs });
    const changes = await withStubbed("../utils/playerauctionsFulfiller", env.stubs, (pa) =>
      pa.syncUnclaimedStock({ dryRun: false }),
    );
    const q = env.Listing.calls.find[0];
    assert.strictEqual(q.status, "active");
    assert.ok((q.$or || []).some((c) => c.noclaimStock === true), "the sweep must select no-claim rows");
    assert.strictEqual(changes.length, 1);
    assert.deepStrictEqual(env.mp.playerauctionsSetQuantity.calls, [["pa-1", 3]]);
  }
  // A count that FAILS skips the row: no read of the offer, no hide, no push.
  {
    const listing = paNoclaimRow([]);
    const env = paEnv({ rows: [listing], ncs: fakeNcs({ stockThrows: true }) });
    const realError = console.error;
    console.error = () => {};
    let changes;
    try {
      changes = await withStubbed("../utils/playerauctionsFulfiller", env.stubs, (pa) =>
        pa.syncUnclaimedStock({ dryRun: false }),
      );
    } finally {
      console.error = realError;
    }
    assert.deepStrictEqual(changes, []);
    assert.strictEqual(env.mp.playerauctionsOffer.calls.length, 0);
    assert.strictEqual(env.mp.playerauctionsHide.calls.length, 0);
    assert.strictEqual(env.mp.playerauctionsSetQuantity.calls.length, 0);
    assert.strictEqual(listing.saves, 0);
  }
  // A REAL zero hides the offer, with a reason that points at the no-claim farm.
  {
    const listing = paNoclaimRow([]);
    const env = paEnv({ rows: [listing], ncs: fakeNcs({ stock: 0 }) });
    await withStubbed("../utils/playerauctionsFulfiller", env.stubs, (pa) =>
      pa.syncUnclaimedStock({ dryRun: false }),
    );
    assert.deepStrictEqual(env.mp.playerauctionsHide.calls, [["pa-1"]]);
    assert.strictEqual(listing.autoPaused, true);
    assert.strictEqual(listing.lastError, "hidden: no free no-claim account holds this bundle");
  }
});

test("PlayerAuctions: rows without the flag take their old path and never load the no-claim layer", async () => {
  const listing = row({
    _id: "P-UG",
    marketplace: "playerauctions",
    externalId: "pa-1",
    title: "Overwatch Twitch Drops (2 Items)",
    price: 5,
    unclaimedGame: "Overwatch",
  });
  const unclaimed = fakeUnclaimed({ candidates: [{ _id: "U1", login: "ug_one" }] });
  const env = paEnv({ rows: [listing], unclaimed });

  await withStubbed("../utils/playerauctionsFulfiller", env.stubs, async (pa, h) => {
    const out = await pa.deliverOrder(paOrder("po-6"), { dryRun: false });
    assert.strictEqual(out.delivered, 1);
    assert.strictEqual(out.source, "unclaimed:Overwatch");
    assert.strictEqual(unclaimed.calls.findOneAndUpdate.length, 1, "claimed off the unclaimed ledger");
    assert.strictEqual(listing.units[0].contentId, "U1");

    const n = await pa.stockFor(
      { unclaimedGame: "Overwatch", externalId: "pa-1" },
      async () => [{ login: "a" }, { login: "b" }],
    );
    assert.strictEqual(n, 2);
    assert.strictEqual(await pa.stockFor({ externalId: "x", units: [{ deliveredAt: null }] }), 1);

    assert.strictEqual(h.ncsLoads(), 0, "a row without the flag must never load utils/noclaimStock");
  });
});
