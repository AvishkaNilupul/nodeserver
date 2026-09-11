// No-claim Shop listings — the GUARDS (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md
// §6). A no-claim set (DropSet.stockSource "noclaim") and a no-claim row
// (MarketplaceListing.noclaimStock) are stocked by the no-claim farm's
// UNCLAIMED drops. The Drop Archive only ever holds CLAIMED copies, which are
// worthless to a no-claim buyer, so every archive-side path that could sell,
// reserve, feed, repair or count one must refuse it — while any other set or
// row takes exactly the path it always took. Each group below pins both halves:
// the refusal, and a control case proving the archive path is still reached.
//
// Mongo- and network-free: every module under test is loaded for real with its
// models, marketplace clients and sibling modules stubbed at require time
// (Module._load), in the style of tests/manualSoldRemoval.test.js.
process.env.CRED_SECRET ||= "test-secret";

const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------- harness --

// Stubs are keyed by repo-relative path without extension ("models/DropSet")
// and matched against where a RELATIVE request resolves from its parent. That
// covers a module that is not on disk yet (utils/noclaimStock.js is written by
// a sibling agent) and lazy requires made at call time — which is also why the
// hook stays installed until restore().
function load(target, stubs) {
  const table = new Map(
    Object.entries(stubs).map(([rel, value]) => [path.join(ROOT, rel), value]),
  );
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (
      typeof request === "string" &&
      request.startsWith(".") &&
      parent &&
      parent.filename
    ) {
      const abs = path
        .resolve(path.dirname(parent.filename), request)
        .replace(/\.js$/, "");
      if (table.has(abs)) return table.get(abs);
    }
    return origLoad.apply(this, arguments);
  };
  const file = require.resolve(path.join(ROOT, target));
  delete require.cache[file];
  let mod;
  try {
    mod = require(file);
  } catch (e) {
    Module._load = origLoad;
    throw e;
  }
  return {
    mod,
    restore() {
      Module._load = origLoad;
      delete require.cache[file];
    },
  };
}

// One function that records being reached and throws. Reaching it on a guarded
// path is exactly the failure under test, and throwing keeps it loud even where
// the caller would swallow a rejection and carry on.
function trip(name, hits) {
  return () => {
    hits.push(name);
    throw new Error("tripwire: " + name);
  };
}

// A whole module/model whose every method is a trip().
function tripwire(name, hits) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === "symbol" || prop === "then") return undefined;
        return trip(name + "." + String(prop), hits);
      },
    },
  );
}

const pass = (req, res, next) => next();

// The route's own handler (everything before it on the route is auth), called
// with a bare req/res — no express app, no socket.
async function call(router, method, routePath, req = {}) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method],
  );
  assert.ok(layer, method.toUpperCase() + " " + routePath + " is registered");
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  // Control cases end in a tripwire -> the route's own 500 + console.error.
  const origError = console.error;
  console.error = () => {};
  try {
    await handle({ params: {}, query: {}, body: {}, session: {}, ...req }, res);
  } finally {
    console.error = origError;
  }
  return res;
}

// ------------------------------------------------------------------ data ----

const NC_ID = "64b000000000000000000001";
const ARCH_ID = "64b000000000000000000002";

function items() {
  return [
    {
      itemKey: "golden gun|overwatch 2",
      name: "Golden Gun",
      game: "Overwatch 2",
      image: "https://img/gun.png",
      qty: 1,
    },
    {
      itemKey: "spray|overwatch 2",
      name: "Spray",
      game: "Overwatch 2",
      image: "https://img/spray.png",
      qty: 2,
    },
  ];
}

function noclaimSet(over = {}) {
  return {
    _id: NC_ID,
    name: "OW no-claim bundle",
    note: "",
    price: 9.5,
    listed: false,
    custom: false,
    publicCatalog: false,
    sourceType: "",
    stockSource: "noclaim",
    items: items(),
    ...over,
  };
}

// A set from before stockSource existed: the field is MISSING, not "".
function archiveSet(over = {}) {
  const s = noclaimSet({ _id: ARCH_ID, name: "OW archive bundle", ...over });
  if (!("stockSource" in over)) delete s.stockSource;
  return s;
}

// ------------------------------------------------- utils/dropReservation ----

test("reserveSetOnAccount refuses a no-claim set before touching DropLog", async () => {
  const hits = [];
  const { mod, restore } = load("utils/dropReservation", {
    "models/DropLog": tripwire("DropLog", hits),
    "models/BotAccount": tripwire("BotAccount", hits),
    "models/SaleSignal": tripwire("SaleSignal", hits),
  });
  let ok;
  try {
    ok = await mod.reserveSetOnAccount("acc1", noclaimSet(), {
      soldToUsername: "ggsel",
    });
  } finally {
    restore();
  }
  assert.strictEqual(ok, false);
  assert.deepStrictEqual(hits, [], "no reservation may be written or read");
});

test("reserveSetOnAccount still reserves an archive set (control)", async () => {
  const writes = [];
  const { mod, restore } = load("utils/dropReservation", {
    "models/DropLog": {
      async updateMany(q, u) {
        writes.push({ q, u });
        return {};
      },
      // Every key won: the batch tag matched all of them.
      async distinct(_field, q) {
        return q.itemKey.$in;
      },
    },
    "models/BotAccount": {
      async updateOne() {
        return {};
      },
    },
    "models/SaleSignal": {
      async updateOne() {
        return {};
      },
    },
  });
  let ok;
  try {
    ok = await mod.reserveSetOnAccount("acc1", archiveSet(), {
      soldToUsername: "ggsel",
    });
  } finally {
    restore();
  }
  assert.strictEqual(ok, true);
  assert.strictEqual(writes.length, 1);
  assert.deepStrictEqual(writes[0].q.itemKey.$in, [
    "golden gun|overwatch 2",
    "spray|overwatch 2",
  ]);
});

// ------------------------------------------------------ routes/shopRoutes ----

function shopWorld() {
  return { hits: [], findQueries: [], sets: [], byId: {} };
}

function loadShop(world) {
  const hits = world.hits;
  return load("routes/shopRoutes", {
    "middleware/auth": { requireAdmin: pass, requireSuperadmin: pass },
    "models/DropSet": {
      find(q) {
        world.findQueries.push(q);
        const chain = { sort: () => chain, lean: async () => world.sets };
        return chain;
      },
      findById(id) {
        return { lean: async () => world.byId[String(id)] || null };
      },
    },
    "models/DropLog": tripwire("DropLog", hits),
    "models/BotAccount": tripwire("BotAccount", hits),
    "models/Purchase": tripwire("Purchase", hits),
    "models/BalanceLog": tripwire("BalanceLog", hits),
    "utils/admins": tripwire("admins", hits),
    "utils/telegram": { sendTelegram: async () => {} },
    "utils/dropReservation": {
      AVAILABLE_DROP: { connected: { $ne: true }, soldAt: null },
      reserveSetOnAccount: trip("reserveSetOnAccount", hits),
      releaseAccountsForTag: trip("releaseAccountsForTag", hits),
      releaseSetForAccounts: trip("releaseSetForAccounts", hits),
    },
  });
}

test("availableAccountsForSet: no archive account can deliver a no-claim set", async () => {
  const world = shopWorld();
  const { mod, restore } = loadShop(world);
  try {
    assert.deepStrictEqual(await mod.availableAccountsForSet(noclaimSet()), []);
    assert.deepStrictEqual(world.hits, [], "DropLog is never asked");
    // Control: the same items as an archive set still go to DropLog.
    await assert.rejects(
      mod.availableAccountsForSet(archiveSet()),
      /tripwire: DropLog\.aggregate/,
    );
  } finally {
    restore();
  }
  assert.deepStrictEqual(world.hits, ["DropLog.aggregate"]);
});

test("stockForSetFromHoldings: archive holdings never stock a no-claim set", () => {
  const world = shopWorld();
  const { mod, restore } = loadShop(world);
  const holdings = [
    {
      accountId: "111111111111111111111111",
      login: "Holder",
      counts: new Map([
        ["golden gun|overwatch 2", 3],
        ["spray|overwatch 2", 5],
      ]),
    },
  ];
  try {
    assert.deepStrictEqual(mod.stockForSetFromHoldings(noclaimSet(), holdings), {
      stock: 0,
      topItems: [],
    });
    // Control: identical items + holdings on an archive set count as before.
    const ctrl = mod.stockForSetFromHoldings(archiveSet(), holdings);
    assert.strictEqual(ctrl.stock, 1);
    assert.deepStrictEqual(ctrl.topItems, [
      { k: "golden gun|overwatch 2", count: 3 },
      { k: "spray|overwatch 2", count: 5 },
    ]);
  } finally {
    restore();
  }
});

test("GET /shop/listings filters no-claim sets out of the query", async () => {
  const world = shopWorld();
  const { mod, restore } = loadShop(world);
  let res;
  try {
    res = await call(mod, "get", "/shop/listings");
  } finally {
    restore();
  }
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { success: true, listings: [] });
  assert.deepStrictEqual(world.findQueries, [
    { listed: true, price: { $gt: 0 }, stockSource: { $ne: "noclaim" } },
  ]);
});

test("GET /shop/listings/:id is 404 for a no-claim set, even one flagged listed", async () => {
  const world = shopWorld();
  // A no-claim set is always listed:false; the guard must not depend on it.
  world.byId[NC_ID] = noclaimSet({ listed: true });
  world.byId[ARCH_ID] = archiveSet({ listed: true });
  const { mod, restore } = loadShop(world);
  let res;
  let ctrl;
  try {
    res = await call(mod, "get", "/shop/listings/:id", { params: { id: NC_ID } });
    assert.deepStrictEqual(world.hits, [], "no stock lookup for it");
    ctrl = await call(mod, "get", "/shop/listings/:id", {
      params: { id: ARCH_ID },
    });
  } finally {
    restore();
  }
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(res.body, {
    success: false,
    message: "Listing not found",
  });
  // Control: a listed archive set goes on to its stock (tripwired -> 500).
  assert.strictEqual(ctrl.statusCode, 500);
  assert.deepStrictEqual(world.hits, ["DropLog.aggregate"]);
});

test("POST /shop/listings/:id/buy cannot buy a no-claim set", async () => {
  const world = shopWorld();
  world.byId[NC_ID] = noclaimSet({ listed: true });
  world.byId[ARCH_ID] = archiveSet({ listed: true });
  const { mod, restore } = loadShop(world);
  const session = { admin: { id: "admin1", username: "seller" } };
  let res;
  let ctrl;
  try {
    res = await call(mod, "post", "/shop/listings/:id/buy", {
      params: { id: NC_ID },
      session,
    });
    assert.deepStrictEqual(
      world.hits,
      [],
      "no balance read, no reservation, no DropLog",
    );
    ctrl = await call(mod, "post", "/shop/listings/:id/buy", {
      params: { id: ARCH_ID },
      session,
    });
  } finally {
    restore();
  }
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(res.body, {
    success: false,
    message: "Listing not found",
  });
  // Control: an archive set gets as far as the buyer's balance.
  assert.strictEqual(ctrl.statusCode, 500);
  assert.deepStrictEqual(world.hits, ["admins.getBalance"]);
});

// ------------------------------------------------ utils/marketplaceGuardian --

// No-claim rows never carry accountId; the accountLogin here is only there to
// give the duplicate check something it WOULD flag if the rows got through.
function ncRow(id) {
  return {
    _id: id,
    marketplace: "ggsel",
    externalId: "91000" + id.slice(-1),
    qtyTarget: 4,
    lastStock: 4,
    set: NC_ID,
    noclaimStock: true,
    origin: "manual",
    accountId: "",
    accountLogin: "alpha",
    units: [{ contentId: "c-" + id, accountId: "", login: "alpha" }],
    status: "active",
    autoDeliver: true,
  };
}

function archiveRow(id, over = {}) {
  return {
    _id: id,
    marketplace: "digiseller",
    externalId: "92000" + id.slice(-1),
    qtyTarget: 0,
    lastStock: 4,
    set: ARCH_ID,
    accountId: "",
    accountLogin: "alpha",
    units: [],
    status: "active",
    autoDeliver: true,
    ...over,
  };
}

function loadGuardian(rows) {
  const world = { stockReads: [], upserts: [], hits: [] };
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  const stock = async (externalId) => {
    world.stockReads.push(externalId);
    return { stock: 4, reason: "" };
  };
  const { mod, restore } = load("utils/marketplaceGuardian", {
    "utils/marketplaces": {
      ggselOfferStockDetailed: stock,
      digisellerProductStockDetailed: stock,
      async ggselFinalizeStock() {
        return { stock: 4, reactivated: false, pending: true };
      },
    },
    "utils/ggselFulfiller": {
      GG_CLAIM_TAG: "ggsel",
      claimAccountsForSet: trip("ggsel.claimAccountsForSet", world.hits),
    },
    "utils/digisellerFulfiller": {
      DS_CLAIM_TAG: "digiseller",
      claimAccountsForSet: trip("digiseller.claimAccountsForSet", world.hits),
    },
    "utils/funpayFulfiller": { FP_CLAIM_TAG: "funpay" },
    "utils/suppliedStock": tripwire("suppliedStock", world.hits),
    "utils/telegram": { sendTelegram: async () => {} },
    "utils/guardianAutoHeal": { healOpenFindings: async () => null },
    "models/AuditFinding": {
      async findOneAndUpdate(q, u) {
        world.upserts.push({ dedupeKey: q.dedupeKey, type: u.$set.type });
        return { lastErrorObject: { upserted: true }, value: null };
      },
      async updateMany() {
        return { modifiedCount: 0 };
      },
      async updateOne() {
        return { modifiedCount: 0 };
      },
      async countDocuments() {
        return 0;
      },
    },
    "models/MarketplaceListing": {
      find() {
        return { lean: async () => rows };
      },
      findOne(q) {
        return { lean: async () => byId.get(String(q._id)) || null };
      },
      async updateOne() {
        return { modifiedCount: 1 };
      },
    },
    "models/DropLog": {
      async distinct() {
        return [];
      },
      find() {
        return { lean: async () => [] };
      },
      async countDocuments() {
        return 0;
      },
    },
    "models/DropSet": {
      find() {
        return { lean: async () => [] };
      },
      findById() {
        return { lean: async () => null };
      },
    },
    "models/BotAccount": {
      find() {
        return { lean: async () => [] };
      },
    },
  });
  return { guardian: mod, world, restore };
}

test("guardian feed: a no-claim row is never stock-read or fed from the archive", async () => {
  const nc = ncRow("row-nc-1");
  const ctrl = archiveRow("row-ar-1", { qtyTarget: 4 });
  const { guardian, world, restore } = loadGuardian([nc, ctrl]);
  try {
    assert.strictEqual(await guardian.feedOne(nc._id), 0);
    assert.deepStrictEqual(world.stockReads, [], "no platform stock read");
    // Control: an archive row with a target is read (and, full, left alone).
    assert.strictEqual(await guardian.feedOne(ctrl._id), 0);
  } finally {
    restore();
  }
  assert.deepStrictEqual(world.stockReads, [ctrl.externalId]);
  assert.deepStrictEqual(world.hits, [], "no archive or supplied claim");
});

test("guardian checks: no-claim rows are dropped where account listings are", async () => {
  // Two no-claim rows, same set, same login: exactly what the duplicate check
  // flags on archive rows.
  const nc = loadGuardian([ncRow("row-nc-1"), ncRow("row-nc-2")]);
  let run;
  try {
    run = await nc.guardian.runOnce();
  } finally {
    nc.restore();
  }
  assert.strictEqual(run.listingsChecked, 2);
  assert.strictEqual(run.issuesDetected, 0);
  assert.strictEqual(run.accountsFed, 0);
  assert.deepStrictEqual(nc.world.upserts, [], "no finding raised");
  assert.deepStrictEqual(nc.world.stockReads, [], "feed skipped them too");
  assert.deepStrictEqual(nc.world.hits, []);

  // Control: the same pair as archive rows is still a duplicate.
  const ar = loadGuardian([archiveRow("row-ar-1"), archiveRow("row-ar-2")]);
  try {
    run = await ar.guardian.runOnce();
  } finally {
    ar.restore();
  }
  assert.strictEqual(run.issuesDetected, 1);
  assert.deepStrictEqual(ar.world.upserts, [
    { dedupeKey: "dup:login:alpha|" + ARCH_ID, type: "duplicate-account" },
  ]);
});

// ---------------------------------------------- routes/dropArchiveRoutes ----

function archiveWorld() {
  return {
    hits: [],
    byId: {},
    sets: [],
    lightRows: [],
    finds: [],
    aggregates: [],
    stockForSet: [],
    st: null,
  };
}

// A findById() result that works both awaited (the PUT route's mongoose doc)
// and through .lean() (every read route).
function query(doc) {
  return {
    lean: async () => doc,
    then: (ok, fail) => Promise.resolve(doc).then(ok, fail),
  };
}

// A mutable stand-in for a mongoose document, counting save() calls.
function asDoc(plain) {
  const d = { ...plain, items: plain.items.map((i) => ({ ...i })), saves: 0 };
  d.save = async function () {
    this.saves++;
    return this;
  };
  return d;
}

// utils/archiveSnapshot is deliberately NOT stubbed, so a checkout where it is
// missing fails here loudly instead of passing on a stand-in.
function loadArchive(world) {
  const hits = world.hits;
  return load("routes/dropArchiveRoutes", {
    "middleware/auth": { requireSuperadmin: pass, requireAdmin: pass },
    "models/DropSet": {
      findById(id) {
        return query(world.byId[String(id)] || null);
      },
      find(match) {
        world.finds.push(match);
        const chain = { sort: () => chain, lean: async () => world.sets };
        return chain;
      },
      async aggregate(pipeline) {
        world.aggregates.push(pipeline);
        return world.lightRows;
      },
    },
    "models/DropLog": {
      async aggregate() {
        hits.push("DropLog.aggregate");
        return [];
      },
    },
    "models/BotAccount": tripwire("BotAccount", hits),
    "models/AvailableAccount": tripwire("AvailableAccount", hits),
    "models/MarketplaceListing": tripwire("MarketplaceListing", hits),
    "models/SaleSignal": tripwire("SaleSignal", hits),
    "utils/noclaimStock": {
      async stockForSet(set) {
        world.stockForSet.push(set);
        return world.st;
      },
    },
    "utils/archiveExclusions": {
      BAD_STATUSES: [],
      excludedAccountIdsCached: trip("excludedAccountIdsCached", hits),
      invalidateExclusions() {
        hits.push("invalidateExclusions");
      },
    },
    // Not on any path under test; stubbed so a sibling agent's in-progress
    // edit of one of them cannot fail this file.
    "utils/unclaimedAutoList": {},
    "utils/listingDetach": tripwire("listingDetach", hits),
    "utils/dropScanner": {},
    "utils/botHosts": {},
    "utils/poolPasswords": {},
    "utils/imageCache": { cacheImage: trip("cacheImage", hits) },
  });
}

test("fulfillment: a no-claim set is answered by utils/noclaimStock, never DropLog", async () => {
  const world = archiveWorld();
  const set = noclaimSet();
  world.byId[NC_ID] = set;
  world.st = {
    free: 3,
    stale: 1,
    onAuto: 2,
    onManual: 1,
    covering: 7,
    snapshotAt: "2026-09-11T00:00:00.000Z",
  };
  const { mod, restore } = loadArchive(world);
  let res;
  try {
    res = await call(mod, "get", "/drops-archive/sets/:id/fulfillment", {
      params: { id: NC_ID },
    });
  } finally {
    restore();
  }
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, {
    success: true,
    set: {
      id: NC_ID,
      name: "OW no-claim bundle",
      note: "",
      price: 9.5,
      listed: false,
    },
    items: set.items,
    accounts: [],
    fullAccounts: 7,
    bundlesAvailable: 3,
    bundlesHeld: 3,
    bundlesMissingPassword: 0,
    noclaim: world.st,
  });
  assert.deepStrictEqual(world.stockForSet, [set]);
  assert.deepStrictEqual(world.hits, [], "no exclusions, no DropLog");
});

test("fulfillment: an empty no-claim set still asks noclaimStock; an archive set still aggregates (control)", async () => {
  const world = archiveWorld();
  world.byId[NC_ID] = noclaimSet({ items: [] });
  world.byId[ARCH_ID] = archiveSet();
  world.st = {
    free: 0,
    stale: 0,
    onAuto: 0,
    onManual: 0,
    covering: 0,
    snapshotAt: null,
  };
  const { mod, restore } = loadArchive(world);
  let empty;
  let ctrl;
  try {
    empty = await call(mod, "get", "/drops-archive/sets/:id/fulfillment", {
      params: { id: NC_ID },
    });
    ctrl = await call(mod, "get", "/drops-archive/sets/:id/fulfillment", {
      params: { id: ARCH_ID },
    });
  } finally {
    restore();
  }
  assert.strictEqual(empty.statusCode, 200);
  assert.deepStrictEqual(empty.body.noclaim, world.st);
  assert.strictEqual(empty.body.bundlesHeld, 0);
  assert.strictEqual(world.stockForSet.length, 1, "only the no-claim set");
  // The archive set went down the archive path (tripwired at its first read).
  assert.strictEqual(ctrl.statusCode, 500);
  assert.deepStrictEqual(world.hits, ["excludedAccountIdsCached"]);
});

test("PUT a no-claim set: Shop listing and item edits are refused, nothing saved", async () => {
  const world = archiveWorld();
  const doc = asDoc(noclaimSet());
  world.byId[NC_ID] = doc;
  const { mod, restore } = loadArchive(world);
  const LISTED = "A no-claim listing sells on marketplaces only — use Sell on…";
  const ITEMS = "Edit a no-claim listing's items from the No-claim picker";
  const cases = [
    [{ listed: true }, LISTED],
    [{ name: "Renamed", price: 3, listed: true }, LISTED],
    [{ itemKeys: ["other|overwatch 2"] }, ITEMS],
    [{ addItemKeys: ["other|overwatch 2"] }, ITEMS],
    [{ removeItemKeys: ["spray|overwatch 2"] }, ITEMS],
    [{ itemQuantities: { "spray|overwatch 2": 5 } }, ITEMS],
    [{ name: "Renamed", itemKeys: [] }, ITEMS],
  ];
  try {
    for (const [body, message] of cases) {
      const res = await call(mod, "put", "/drops-archive/sets/:id", {
        params: { id: NC_ID },
        body,
      });
      assert.strictEqual(res.statusCode, 400, JSON.stringify(body));
      assert.deepStrictEqual(res.body, { success: false, message });
    }
  } finally {
    restore();
  }
  assert.strictEqual(doc.saves, 0, "a refused edit saves nothing");
  assert.strictEqual(doc.name, "OW no-claim bundle", "and changes nothing");
  assert.strictEqual(doc.price, 9.5);
  assert.deepStrictEqual(doc.items, items());
  assert.deepStrictEqual(world.hits, []);
});

test("PUT a no-claim set: name, note and price still edit; items stay as picked", async () => {
  const world = archiveWorld();
  const doc = asDoc(noclaimSet());
  world.byId[NC_ID] = doc;
  const { mod, restore } = loadArchive(world);
  let res;
  try {
    res = await call(mod, "put", "/drops-archive/sets/:id", {
      params: { id: NC_ID },
      body: { name: "  Renamed  ", note: " a note ", price: 12.5, listed: false },
    });
  } finally {
    restore();
  }
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(doc.saves, 1);
  assert.strictEqual(doc.name, "Renamed");
  assert.strictEqual(doc.note, "a note");
  assert.strictEqual(doc.price, 12.5);
  assert.strictEqual(doc.listed, false);
  assert.deepStrictEqual(doc.items, items(), "items untouched");
  assert.strictEqual(res.body.set.stockSource, "noclaim");
  assert.strictEqual(res.body.set.price, 12.5);
  assert.deepStrictEqual(world.hits, [], "the archive item lookup never ran");
});

test("PUT an archive set: listing and item quantities work as before (control)", async () => {
  const world = archiveWorld();
  const doc = asDoc(archiveSet());
  world.byId[ARCH_ID] = doc;
  const { mod, restore } = loadArchive(world);
  let res;
  try {
    res = await call(mod, "put", "/drops-archive/sets/:id", {
      params: { id: ARCH_ID },
      body: { listed: true, itemQuantities: { "spray|overwatch 2": 3 } },
    });
  } finally {
    restore();
  }
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(doc.saves, 1);
  assert.strictEqual(doc.listed, true);
  assert.deepStrictEqual(
    doc.items.map((i) => [i.itemKey, i.qty]),
    [
      ["golden gun|overwatch 2", 1],
      ["spray|overwatch 2", 3],
    ],
  );
  assert.strictEqual(res.body.set.stockSource, "");
  assert.deepStrictEqual(world.hits, ["DropLog.aggregate"]);
});

test("sets list (light + full) and set detail carry stockSource", async () => {
  const world = archiveWorld();
  const legacy = archiveSet();
  world.lightRows = [
    { _id: NC_ID, name: "nc", stockSource: "noclaim", itemCount: 2, thumbs: [] },
    { _id: ARCH_ID, name: "legacy", itemCount: 2, thumbs: [] },
  ];
  world.sets = [noclaimSet(), legacy];
  world.byId[NC_ID] = noclaimSet();
  world.byId[ARCH_ID] = legacy;
  const { mod, restore } = loadArchive(world);
  let light;
  let full;
  let detail;
  let legacyDetail;
  try {
    light = await call(mod, "get", "/drops-archive/sets", {
      query: { light: "1" },
    });
    full = await call(mod, "get", "/drops-archive/sets");
    detail = await call(mod, "get", "/drops-archive/sets/:id", {
      params: { id: NC_ID },
    });
    legacyDetail = await call(mod, "get", "/drops-archive/sets/:id", {
      params: { id: ARCH_ID },
    });
  } finally {
    restore();
  }
  const project = world.aggregates[0].find((stage) => stage.$project).$project;
  assert.strictEqual(project.stockSource, 1, "projected on Atlas");
  assert.deepStrictEqual(
    light.body.sets.map((s) => s.stockSource),
    ["noclaim", ""],
  );
  assert.deepStrictEqual(
    full.body.sets.map((s) => s.stockSource),
    ["noclaim", ""],
  );
  assert.strictEqual(detail.body.set.stockSource, "noclaim");
  assert.strictEqual(legacyDetail.body.set.stockSource, "");
});

test("router.bustSetsCache drops the cached sets lists, and only those", async () => {
  const world = archiveWorld();
  world.sets = [noclaimSet()];
  const { mod, restore } = loadArchive(world);
  try {
    assert.strictEqual(typeof mod.bustSetsCache, "function");
    await call(mod, "get", "/drops-archive/sets");
    await call(mod, "get", "/drops-archive/sets");
    assert.strictEqual(world.finds.length, 1, "the second read is cached");
    mod.bustSetsCache();
    await call(mod, "get", "/drops-archive/sets");
    assert.strictEqual(world.finds.length, 2, "a bust forces a fresh read");
  } finally {
    restore();
  }
  // "sets:" is not an archive prefix, so the exclusion set — and the archive
  // rollup, which bustTargets ties to it — is left alone.
  assert.deepStrictEqual(world.hits, []);
});

// ------------------------------------------------ utils/suspendedAccounts ----

test("suspension sweep reports a no-claim listing and leaves it alone", async () => {
  const hits = [];
  const projections = [];
  const detachCalls = [];
  const live = [
    {
      _id: "row-nc-1",
      accountId: "",
      accountLogin: "",
      units: [{ contentId: "u1", accountId: "", login: "alpha" }],
      noclaimStock: true,
      status: "active",
    },
    {
      _id: "row-ar-1",
      accountId: "acc1",
      accountLogin: "Alpha",
      units: [],
      status: "active",
    },
  ];
  const byId = new Map(live.map((r) => [r._id, r]));
  const { mod, restore } = load("utils/suspendedAccounts", {
    "models/BotAccount": {
      find() {
        return { lean: async () => [{ _id: "acc1", login: "Alpha" }] };
      },
    },
    "models/MarketplaceListing": {
      find(_q, projection) {
        projections.push(projection);
        return { lean: async () => live };
      },
      findById(id) {
        return { lean: async () => byId.get(String(id)) || null };
      },
    },
    "utils/listingDetach": {
      async detachAccountFromListing(row, acc) {
        detachCalls.push({ row: row._id, login: acc.login });
        return { detached: ["digiseller x (unit removed)"], warnings: [] };
      },
    },
    "models/AutoFarmTask": tripwire("AutoFarmTask", hits),
    "models/AvailableAccount": tripwire("AvailableAccount", hits),
    "models/DropLog": tripwire("DropLog", hits),
    "utils/botHosts": tripwire("botHosts", hits),
    "utils/telegram": { sendTelegram: async () => {} },
    "utils/systemLog": { logEvent() {} },
  });
  const progress = [];
  let report;
  try {
    report = await mod.retireFromLiveListings({
      onProgress: (m) => progress.push(m),
    });
  } finally {
    restore();
  }
  assert.strictEqual(projections[0].noclaimStock, 1, "the flag is projected");
  const msg =
    "no-claim listing row-nc-1 carries Alpha, suspended in the Drop Archive " +
    "— the no-claim lifecycle re-checks it live; left untouched";
  assert.deepStrictEqual(report.warnings, [msg]);
  assert.ok(progress.includes("warning — " + msg));
  // Control: the archive listing with the same suspended login is repaired.
  assert.deepStrictEqual(detachCalls, [{ row: "row-ar-1", login: "Alpha" }]);
  assert.strictEqual(report.listings, 1, "the no-claim row is not counted");
  assert.strictEqual(report.detached, 1);
  assert.deepStrictEqual(hits, []);
});

// ---------------------------------------------------- utils/listingDetach ----

test("detachAccountFromListing leaves a no-claim listing to utils/noclaimListings", async () => {
  const hits = [];
  const { mod, restore } = load("utils/listingDetach", {
    "models/MarketplaceListing": tripwire("MarketplaceListing", hits),
    "models/DropSet": tripwire("DropSet", hits),
    "models/SuppliedAccount": tripwire("SuppliedAccount", hits),
    "utils/marketplaces": tripwire("marketplaces", hits),
    "utils/marketplaceGuardian": tripwire("marketplaceGuardian", hits),
    "utils/gameflipFulfiller": tripwire("gameflipFulfiller", hits),
    "utils/listingRepublish": tripwire("listingRepublish", hits),
    "utils/setImage": tripwire("setImage", hits),
  });
  const acc = { _id: "acc1", login: "alpha" };
  let ctrl;
  try {
    for (const marketplace of ["gameflip", "ggsel", "digiseller", "g2g"]) {
      const out = await mod.detachAccountFromListing(
        {
          _id: "row-nc-1",
          marketplace,
          externalId: "ext-1",
          autoDeliver: true,
          noclaimStock: true,
          accountId: "",
          accountLogin: "",
          units: [{ contentId: "u1", accountId: "", login: "alpha" }],
        },
        acc,
        { reason: "suspended on Twitch", republish: true, hardRepublish: true },
      );
      assert.deepStrictEqual(
        out,
        {
          detached: [],
          warnings: [
            "no-claim listing — units are managed by utils/noclaimListings",
          ],
        },
        marketplace,
      );
    }
    assert.deepStrictEqual(hits, [], "no platform call, no row write");
    // Control: an archive FunPay row goes straight to the platform.
    ctrl = await mod.detachAccountFromListing(
      {
        _id: "row-fp-1",
        marketplace: "funpay",
        externalId: "fp-1",
        accountId: "acc1",
        accountLogin: "alpha",
      },
      acc,
    );
  } finally {
    restore();
  }
  assert.deepStrictEqual(hits, ["marketplaces.funpayUpdateSecrets"]);
  assert.match(ctrl.warnings[0], /could not pull the FunPay delivery line/);
});
