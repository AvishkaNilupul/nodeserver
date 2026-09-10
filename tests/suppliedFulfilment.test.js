// The two ways an account listing (docs/ACCOUNT-LISTINGS-CONTRACT.md B5) loses
// real money once it is live, and the four fulfillers that decide which.
//
// 1. THE FALL-THROUGH. utils/z2uFulfiller had no supplied branch at all: its
//    claim read `if (row.unclaimedGame) … else if (row.set) { claimAccountsForSet }`
//    (contract ground truth #8). An offer-backed row that also carried a `set`
//    would therefore have claimed and shipped a COMPLETELY DIFFERENT account
//    out of the Drop Archive — the buyer gets stock that was promised to
//    someone else, the supplied ledger records nothing, and the account the
//    owner actually pasted in is still advertised. So the load-bearing
//    assertion in this file is a negative one: claimAccountsForSet must never
//    be reached for a row carrying an accountOffer.
//
// 2. THE SILENT UNLIST. Five stock counters exist and each answers 0/null for a
//    row it does not recognise (ground truth #9) — and 0 is what takes a live
//    offer off sale (Eldorado pause, PA hide, G2G delist, Z2U off_line). A
//    counter blind to supplied stock unlists a full shelf. Every counter below
//    is asserted to report the supplied count, and a ledger read that FAILS is
//    asserted to report "we cannot tell" rather than zero.
//
// No Mongo and no network: the models, the marketplace clients and the supplied
// stock layer are all replaced before each fulfiller is loaded, and the stubs
// stay installed while the code under test runs — three of the four require
// utils/suppliedStock lazily INSIDE the branch under test
// (g2gFulfiller.js:194, eldoradoFulfiller.js:361), and an un-stubbed Mongoose
// call does not fail, it stalls for ten seconds.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

/* ------------------------------- harness -------------------------------- */

function spy(impl = async () => undefined) {
  const fn = (...args) => {
    fn.calls.push(args);
    return impl(...args);
  };
  fn.calls = [];
  return fn;
}

// Load `target` with the given dependencies replaced, and keep them replaced
// for the whole of `fn` — the lazy requires above happen at CALL time, long
// after the require of the fulfiller itself has returned.
async function withStubbed(target, stubs, fn) {
  const targetFile = require.resolve(target);
  const map = new Map(
    Object.entries(stubs).map(([k, v]) => [require.resolve(k), v]),
  );
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    let file;
    try {
      file = Module._resolveFilename(request, parent, isMain);
    } catch {
      return origLoad.apply(this, arguments);
    }
    return map.has(file) ? map.get(file) : origLoad.apply(this, arguments);
  };
  delete require.cache[targetFile];
  try {
    return await fn(require(target));
  } finally {
    Module._load = origLoad;
    delete require.cache[targetFile];
  }
}

// A MarketplaceListing row. Plain object on purpose: a Mongoose sub-document
// must never be spread, and nothing here pretends to be one.
function row(fields) {
  const d = {
    units: [],
    status: "active",
    ...fields,
    saves: 0,
    modified: [],
    markModified(p) {
      d.modified.push(p);
    },
    async save() {
      d.saves++;
      return d;
    },
  };
  return d;
}

// find() is awaited directly in some fulfillers and chained (.limit/.lean) in
// others, so the stand-in answers to both.
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

// The supplied claim layer. Records every call so a test can prove what the
// fulfiller asked for, and what it never asked for.
function fakeSupplied({
  stock = 0,
  claim = [],
  offer = null,
  enabled = true,
  text = "Login: {login}",
  stockThrows = false,
} = {}) {
  const calls = {
    stockFor: [],
    claimForListing: [],
    releaseClaim: [],
    markDelivered: [],
    deliveryText: [],
    deliveryAccounts: [],
  };
  return {
    calls,
    isSuppliedRow: (r) => !!(r && r.accountOffer),
    async offerFor() {
      return offer;
    },
    deliveryEnabled: () => enabled,
    async stockFor(r) {
      calls.stockFor.push(r);
      if (stockThrows) throw new Error("atlas hiccup");
      return stock;
    },
    async claimForListing(listing, want, opts) {
      calls.claimForListing.push({ listing, want, opts });
      return claim.slice(0, want);
    },
    async releaseClaim(ids, opts) {
      calls.releaseClaim.push({ ids, opts });
      return ids.length;
    },
    async markDelivered(ids, opts) {
      calls.markDelivered.push({ ids, opts });
      return ids.length;
    },
    // Mirrors utils/suppliedStock.deliveryText closely enough to prove two
    // things a bare {login} substitution cannot: WHICH template was used (the
    // offer's own wins, as it does for real) and WHICH of the account's columns
    // survived the fulfiller's normaliser on the way here.
    deliveryText(account, off) {
      calls.deliveryText.push(account.login);
      calls.deliveryAccounts.push(account);
      const values = {
        login: account.login,
        password: account.password,
        token: account.clientSecret,
        email: account.email,
        extra: account.extra,
        title: (off && off.title) || "",
        game: (off && off.game) || "",
      };
      return String((off && off.deliveryTemplate) || text).replace(
        /\{(login|password|token|email|extra|title|game)\}/g,
        (_m, k) => values[k] || "",
      );
    },
  };
}

function fakeSettings({ enabled = true, autoDeliver = true, af = {} } = {}) {
  return {
    getAutoFarm: () => af,
    getAccountListingSettings: () => ({
      enabled,
      autoDeliver,
      lowStockWarnAt: 2,
    }),
  };
}

// The Drop Archive side of the world. Every one of these is a tripwire: a
// supplied row that touches any of them is selling somebody else's account.
function archiveSpies() {
  return {
    availableAccountsForSet: spy(async () => [
      { accountId: "ARCH1", login: "archive_account" },
    ]),
    reserveSetOnAccount: spy(async () => true),
    claimAccountsForSet: spy(async () => [
      { accountId: "ARCH1", login: "archive_account", password: "arch-pw" },
    ]),
    releaseAccounts: spy(async () => 0),
  };
}

// How many times a supplied sale reached for Drop Archive stock. Always 0.
function archiveTouches(arch) {
  return (
    arch.reserveSetOnAccount.calls.length +
    arch.availableAccountsForSet.calls.length +
    arch.claimAccountsForSet.calls.length
  );
}

const SUPPLIED = [{ ledgerId: "LED1", login: "supplied_one", password: "pw1" }];

/* ------------------------------ Z2U ------------------------------------- */

function z2uEnv({
  rows = [],
  orders = [],
  stock,
  set = null,
  throwOnDeliver,
  settings = fakeSettings(),
}) {
  const arch = archiveSpies();
  const Listing = fakeListingModel(rows);
  const DropSet = fakeById(set);
  const mp = {
    // deliverTick gates on this before it reads anything.
    keyStatus: () => ({ z2u: { configured: true } }),
    z2uOrders: spy(async () => orders),
    z2uDeliveryForm: spy(async () => ({ form: true })),
    z2uDeliver: spy(async () => {
      if (throwOnDeliver) throw new Error("z2u 500");
    }),
  };
  const stubs = {
    "../models/MarketplaceListing": Listing,
    "../models/DropSet": DropSet,
    "../models/UnclaimedAccount": {},
    "../routes/shopRoutes": {
      availableAccountsForSet: arch.availableAccountsForSet,
    },
    "../utils/listedLogins": {
      loginsOnActiveListings: async () => new Set(),
      notListed: (a) => a,
    },
    "../utils/settings": settings,
    "../utils/marketplaces": mp,
    "../utils/eldoradoFulfiller": {
      claimAccountsForSet: arch.claimAccountsForSet,
      claimUnclaimedForGame: spy(async () => []),
      releaseAccounts: arch.releaseAccounts,
      eldoradoDeliveryCode: (login) => "ARCHIVE COPY for " + login,
    },
    "../utils/suppliedStock": stock,
    "../utils/telegram": { sendTelegram: async () => {} },
  };
  return { stubs, arch, mp, Listing, DropSet };
}

test("LOAD-BEARING: an offer-backed Z2U row never reaches the archive claim", async () => {
  // The dangerous shape: a row that carries BOTH an accountOffer and a stale
  // `set`. Before the supplied branch went in above `row.set`, this shipped an
  // account out of the Drop Archive and told the ledger nothing.
  const listing = row({
    _id: "L1",
    marketplace: "z2u",
    title: "Twitch Drops account",
    externalId: "z-9",
    accountOffer: "OFFER1",
    set: "SET1",
  });
  const stock = fakeSupplied({
    claim: SUPPLIED,
    offer: { title: "Fresh drops", autoDeliver: true },
    text: "Login: {login}",
  });
  const env = z2uEnv({
    rows: [listing],
    orders: [{ orderId: "o-1", title: "Twitch Drops account" }],
    stock,
    set: { _id: "SET1", name: "Overwatch 2" },
  });

  const out = await withStubbed("../utils/z2uFulfiller", env.stubs, (z2u) =>
    z2u.deliverPendingOrders({ dryRun: false }),
  );

  assert.strictEqual(
    env.arch.claimAccountsForSet.calls.length,
    0,
    "an offer-backed row must NEVER claim off the Drop Archive",
  );
  assert.strictEqual(env.DropSet.calls.length, 0, "the set must not be read");
  assert.deepStrictEqual(out.skipped, []);
  assert.strictEqual(out.delivered.length, 1);

  // It claimed from the supplied ledger instead, one account for this order.
  assert.strictEqual(stock.calls.claimForListing.length, 1);
  const claim = stock.calls.claimForListing[0];
  assert.strictEqual(claim.want, 1);
  assert.strictEqual(claim.opts.orderId, "o-1");
  assert.strictEqual(claim.opts.market, "z2u");

  // The buyer got the owner's own account, rendered by the offer's template.
  assert.deepStrictEqual(env.mp.z2uDeliver.calls[0], [
    "o-1",
    "Login: supplied_one",
  ]);

  // The receipt: contentId is the ledger row, accountId stays empty so
  // marketplaceGuardian does not raise a duplicate finding every pass.
  assert.strictEqual(listing.units.length, 1);
  assert.strictEqual(listing.units[0].contentId, "LED1");
  assert.strictEqual(listing.units[0].accountId, "");
  assert.strictEqual(listing.units[0].login, "supplied_one");
  assert.deepStrictEqual(stock.calls.markDelivered[0].ids, ["LED1"]);
});

test("Z2U: a set-backed row with no offer still claims off the archive", async () => {
  // The other half of the guarantee. The new branch is additive: with no
  // accountOffer the row takes byte-for-byte the path it took before.
  const listing = row({
    _id: "L2",
    marketplace: "z2u",
    title: "Overwatch 2 drops",
    externalId: "z-8",
    set: "SET1",
  });
  const stock = fakeSupplied({ claim: SUPPLIED });
  const env = z2uEnv({
    rows: [listing],
    orders: [{ orderId: "o-2", title: "Overwatch 2 drops" }],
    stock,
    set: { _id: "SET1", name: "Overwatch 2" },
  });

  await withStubbed("../utils/z2uFulfiller", env.stubs, (z2u) =>
    z2u.deliverPendingOrders({ dryRun: false }),
  );

  assert.strictEqual(env.arch.claimAccountsForSet.calls.length, 1);
  assert.strictEqual(stock.calls.claimForListing.length, 0);
  assert.deepStrictEqual(env.mp.z2uDeliver.calls[0], [
    "o-2",
    "ARCHIVE COPY for archive_account",
  ]);
  assert.strictEqual(listing.units[0].accountId, "ARCH1");
});

test("Z2U: realStockFor reports the supplied count, and null when it cannot read", async () => {
  const listing = row({ accountOffer: "OFFER1", externalId: "z-9" });

  const good = fakeSupplied({ stock: 5 });
  const n = await withStubbed(
    "../utils/z2uFulfiller",
    z2uEnv({ stock: good }).stubs,
    (z2u) => z2u.realStockFor(listing, new Set()),
  );
  assert.strictEqual(n, 5, "0 here would take a live offer off sale");
  assert.strictEqual(good.calls.stockFor.length, 1);

  const broken = fakeSupplied({ stockThrows: true });
  const unknown = await withStubbed(
    "../utils/z2uFulfiller",
    z2uEnv({ stock: broken }).stubs,
    (z2u) => z2u.realStockFor(listing, new Set()),
  );
  assert.strictEqual(unknown, null, "a failed read is not an empty shelf");
});

test("Z2U: a failed hand-over gives the supplied ledger row back", async () => {
  const listing = row({
    _id: "L3",
    marketplace: "z2u",
    title: "Twitch Drops account",
    externalId: "z-9",
    accountOffer: "OFFER1",
  });
  const stock = fakeSupplied({
    claim: SUPPLIED,
    offer: { title: "Fresh drops", autoDeliver: true },
  });
  const env = z2uEnv({
    rows: [listing],
    orders: [{ orderId: "o-3", title: "Twitch Drops account" }],
    stock,
    throwOnDeliver: true,
  });

  const out = await withStubbed("../utils/z2uFulfiller", env.stubs, (z2u) =>
    z2u.deliverPendingOrders({ dryRun: false }),
  );

  assert.match(out.skipped[0][1], /deliver failed/);
  assert.deepStrictEqual(stock.calls.releaseClaim[0].ids, ["LED1"]);
  assert.strictEqual(stock.calls.releaseClaim[0].opts.orderId, "o-3");
  assert.strictEqual(
    env.arch.releaseAccounts.calls.length,
    0,
    "a ledger row released by accountId would be released nowhere",
  );
  assert.strictEqual(listing.units.length, 0, "nothing was handed over");
});

/* ---------------------------- Eldorado ---------------------------------- */

function eldEnv({ rows = [], stock, offer = null, settings = fakeSettings() }) {
  const arch = archiveSpies();
  const Listing = fakeListingModel(rows);
  const mp = {
    eldoradoSendOrderMessage: spy(async () => ({})),
    eldoradoMarkDelivered: spy(async () => ({})),
    eldoradoSetQuantity: spy(async () => ({})),
    eldoradoDelist: spy(async () => ({})),
    eldoradoRelist: spy(async () => ({})),
    eldoradoOffer: spy(async () => ({ offerState: "Active", quantity: 1 })),
  };
  const stubs = {
    "../models/MarketplaceListing": Listing,
    "../models/BotAccount": fakeById(null),
    "../models/UnclaimedAccount": fakeById(null),
    "../models/DropSet": fakeById(null),
    "../models/DropLog": fakeById(null),
    "../models/AccountOffer": fakeById(offer),
    "../routes/shopRoutes": {
      availableAccountsForSet: arch.availableAccountsForSet,
    },
    "../utils/listedLogins": {
      loginsOnActiveListings: async () => new Set(),
      notListed: (a) => a,
    },
    "../utils/secretBox": { decrypt: (v) => String(v || "") },
    "../utils/dropReservation": {
      reserveSetOnAccount: arch.reserveSetOnAccount,
      releaseAccountsForTag: spy(async () => 0),
    },
    "../utils/settings": settings,
    "../utils/marketplaces": mp,
    "../utils/eldoradoFarmService": {},
    "../utils/unclaimedCoverage": {},
    "../utils/unclaimedAutoList": {},
    "../utils/operatorFarm": {},
    "../utils/telegram": { sendTelegram: async () => {} },
    "../utils/suppliedStock": stock,
  };
  return { stubs, arch, mp, Listing };
}

test("Eldorado: an offer-backed order ships the owner's own account", async () => {
  const listing = row({
    marketplace: "eldorado",
    externalId: "e-9",
    accountOffer: "OFFER1",
  });
  const stock = fakeSupplied({ claim: SUPPLIED, stock: 4 });
  const env = eldEnv({
    rows: [listing],
    stock,
    offer: { title: "Fresh drops", autoDeliver: true },
  });

  const out = await withStubbed("../utils/eldoradoFulfiller", env.stubs, (e) =>
    e.deliverOrder({ id: "eo-1", offerId: "e-9", purchaseQuantity: 1 }, {
      dryRun: false,
    }),
  );

  assert.strictEqual(out.delivered, 1);
  assert.strictEqual(
    archiveTouches(env.arch),
    0,
    "no Drop Archive account may be reserved for a supplied sale",
  );
  assert.strictEqual(
    env.mp.eldoradoSendOrderMessage.calls[0][1],
    "Login: supplied_one",
  );
  assert.deepStrictEqual(env.mp.eldoradoMarkDelivered.calls[0], ["eo-1"]);
  assert.deepStrictEqual(stock.calls.markDelivered[0].ids, ["LED1"]);
  assert.strictEqual(listing.units[0].contentId, "LED1");
  assert.strictEqual(listing.units[0].accountId, "");
  // The remaining count is pushed straight away: an offer still advertising a
  // unit the ledger no longer holds is a paid order the bot cannot ship.
  assert.deepStrictEqual(env.mp.eldoradoSetQuantity.calls[0], ["e-9", 4]);
  assert.strictEqual(env.mp.eldoradoDelist.calls.length, 0);
});

test("Eldorado: the kill switch refuses BEFORE anything is claimed", async () => {
  const listing = row({
    marketplace: "eldorado",
    externalId: "e-9",
    accountOffer: "OFFER1",
  });
  const stock = fakeSupplied({ claim: SUPPLIED });
  const env = eldEnv({
    rows: [listing],
    stock,
    offer: { title: "Fresh drops", autoDeliver: true },
    settings: fakeSettings({ autoDeliver: false }),
  });

  const out = await withStubbed("../utils/eldoradoFulfiller", env.stubs, (e) =>
    e.deliverOrder({ id: "eo-2", offerId: "e-9", purchaseQuantity: 1 }, {
      dryRun: false,
    }),
  );

  assert.match(out.skipped, /auto-delivery is off/);
  assert.strictEqual(
    stock.calls.claimForListing.length,
    0,
    "an account claimed for an order we then refuse to send is stock spent on nothing",
  );
  assert.strictEqual(env.mp.eldoradoSendOrderMessage.calls.length, 0);
});

test("Eldorado: syncBundleStock takes an offer-backed quantity from the ledger", async () => {
  const listing = row({
    marketplace: "eldorado",
    externalId: "e-9",
    title: "Fresh drops",
    accountOffer: "OFFER1",
  });
  const stock = fakeSupplied({ stock: 5 });
  const env = eldEnv({ rows: [listing], stock });

  const changes = await withStubbed(
    "../utils/eldoradoFulfiller",
    env.stubs,
    (e) => e.syncBundleStock({ dryRun: false }),
  );

  // The row has to be SELECTED before it can be counted; without the clause an
  // offer-backed row is invisible to the only pass that can pause it.
  const or = env.Listing.calls.find[0].$or || [];
  assert.ok(
    or.some((c) => Object.prototype.hasOwnProperty.call(c, "accountOffer")),
    "the sweep must select offer-backed rows",
  );
  assert.deepStrictEqual(env.mp.eldoradoSetQuantity.calls[0], ["e-9", 5]);
  assert.strictEqual(env.mp.eldoradoDelist.calls.length, 0);
  assert.strictEqual(changes.length, 1);
});

test("Eldorado: a ledger read that FAILS never pauses a live offer", async () => {
  const listing = row({
    marketplace: "eldorado",
    externalId: "e-9",
    title: "Fresh drops",
    accountOffer: "OFFER1",
  });
  const env = eldEnv({
    rows: [listing],
    stock: fakeSupplied({ stockThrows: true }),
  });

  const changes = await withStubbed(
    "../utils/eldoradoFulfiller",
    env.stubs,
    (e) => e.syncBundleStock({ dryRun: false }),
  );

  assert.deepStrictEqual(changes, []);
  assert.strictEqual(env.mp.eldoradoDelist.calls.length, 0);
  assert.strictEqual(env.mp.eldoradoSetQuantity.calls.length, 0);
  assert.strictEqual(listing.saves, 0, "an Atlas hiccup is not an empty shelf");
});

/* -------------------------------- G2G ----------------------------------- */

function g2gEnv({
  rows = [],
  stock,
  settings = fakeSettings(),
  canSend = false,
  orders = [],
}) {
  const arch = archiveSpies();
  const Listing = fakeListingModel(rows);
  const mp = {
    // The tick's cheap poll, then the order list. Empty by default, so a test
    // that only drives deliverOrder/pickStock is untouched by them.
    g2gOrderCounts: spy(async () => ({
      preparing: orders.length,
      delivering: 0,
    })),
    g2gPendingOrders: spy(async () => orders),
    g2gDelist: spy(async () => ({})),
    g2gRelist: spy(async () => ({})),
    g2gSetQuantity: spy(async () => ({})),
    // The delivery half of the state machine, so deliverOrder can be driven
    // end to end and the text that actually reached the buyer inspected.
    g2gStartDeliver: spy(async () => ({})),
    g2gMarkDelivering: spy(async () => ({})),
    g2gSetDeliveredQty: spy(async () => ({})),
  };
  const chat = {
    canSend: () => canSend,
    sendToBuyer: spy(async () => ({})),
  };
  const stubs = {
    "../models/MarketplaceListing": Listing,
    "../models/BotAccount": fakeById(null),
    "../models/DropSet": fakeById({ _id: "SET1", name: "Overwatch 2" }),
    "../routes/shopRoutes": {
      availableAccountsForSet: arch.availableAccountsForSet,
    },
    "../utils/listedLogins": {
      loginsOnActiveListings: async () => new Set(),
      notListed: (a) => a,
    },
    "../utils/secretBox": { decrypt: (v) => String(v || "") },
    "../utils/settings": settings,
    "../utils/marketplaces": mp,
    "../utils/g2gChat": chat,
    // null routes every order to the bundle path, which is what a non-rent-farm
    // order really does.
    "../utils/g2gFarmService": { deliverFarmOrder: async () => null },
    "../utils/eldoradoFulfiller": {
      claimAccountsForSet: arch.claimAccountsForSet,
      claimUnclaimedForGame: spy(async () => []),
      releaseAccounts: arch.releaseAccounts,
      eldoradoDeliveryCode: (login) => "ARCHIVE COPY for " + login,
    },
    "../utils/telegram": { sendTelegram: async () => {} },
    "../utils/suppliedStock": stock,
  };
  return { stubs, arch, mp, Listing, chat };
}

test("G2G: pickStock claims supplied stock and never the archive", async () => {
  // The listing also carries a free-looking unit. The units fallback sits
  // BELOW the supplied branch precisely so a receipt is never mistaken for
  // stock — and a stale `set` must not tempt the archive claim either.
  const listing = row({
    accountOffer: "OFFER1",
    set: "SET1",
    units: [{ login: "stale_unit", accountId: "ARCH9", orderId: "", deliveredAt: null }],
  });
  const stock = fakeSupplied({ claim: SUPPLIED });
  const env = g2gEnv({ rows: [listing], stock });

  const out = await withStubbed("../utils/g2gFulfiller", env.stubs, (g) =>
    g.pickStock(listing, { orderItemId: "g-1", purchasedQty: 1 }, {
      dryRun: false,
    }),
  );

  assert.strictEqual(out.source, "supplied");
  assert.strictEqual(out.picked.length, 1);
  assert.strictEqual(out.picked[0].login, "supplied_one");
  assert.strictEqual(env.arch.claimAccountsForSet.calls.length, 0);
  assert.strictEqual(stock.calls.claimForListing[0].opts.market, "g2g");
  assert.strictEqual(stock.calls.claimForListing[0].opts.orderId, "g-1");
});

test("G2G: the kill switch says why, and claims nothing", async () => {
  const listing = row({ accountOffer: "OFFER1" });
  const stock = fakeSupplied({ claim: SUPPLIED });
  const env = g2gEnv({
    rows: [listing],
    stock,
    settings: fakeSettings({ enabled: false }),
  });

  const out = await withStubbed("../utils/g2gFulfiller", env.stubs, (g) =>
    g.pickStock(listing, { orderItemId: "g-2", purchasedQty: 1 }, {
      dryRun: false,
    }),
  );

  assert.match(out.error, /switched off in settings/);
  assert.strictEqual(stock.calls.claimForListing.length, 0);
});

test("G2G: realStockFor counts the ledger, not the spent units", async () => {
  // Every hand-over leaves a units[] receipt on an offer-backed row. The units
  // branch would read those as "nothing free" and delist a listing that still
  // has four accounts behind it.
  const listing = row({
    accountOffer: "OFFER1",
    externalId: "g-9",
    units: [{ login: "gone", orderId: "g-1", deliveredAt: new Date() }],
  });
  const stock = fakeSupplied({ stock: 4 });
  const env = g2gEnv({ rows: [listing], stock });

  const n = await withStubbed("../utils/g2gFulfiller", env.stubs, (g) =>
    g.realStockFor(listing, new Set()),
  );

  assert.strictEqual(n, 4);
  assert.strictEqual(stock.calls.stockFor.length, 1);
});

/* -------------------- G2G: whose words the buyer reads ------------------- */

// 3. THE WRONG WORDS. G2G was the one fulfiller that never called
//    suppliedStock.deliveryText: every block was g2gDeliveryCode(login,
//    password), the shared Twitch-drops copy. So an account listing sold on the
//    owner's own description — the only thing that can name the account's
//    {token}, {email} or {extra} — handed the buyer boilerplate with two of the
//    five columns in it, while g2gSetDeliveredQty still ran and the ledger row
//    was still stamped sold. The buyer has paid, the stock is burned and the
//    shortfall is unrecoverable (review finding F2a).
const SUPPLIED_FULL = [
  {
    ledgerId: "LED1",
    login: "supplied_one",
    password: "pw1",
    clientSecret: "tok-1",
    email: "mail@one.test",
    extra: "recovery-code",
  },
];

const OWNER_OFFER = {
  title: "5 fresh Rocket League accounts",
  autoDeliver: true,
  deliveryTemplate:
    "{title}\n{login}:{password}\ntoken={token}\nmail={email}\nnote={extra}",
};

function g2gOrder(fields) {
  return {
    orderItemId: "g-order-1",
    offerId: "g-7",
    purchasedQty: 1,
    buyerId: "BUYER1",
    deliveredQty: 0,
    currency: "USD",
    amount: 4.2,
    title: "Rocket League account",
    ...fields,
  };
}

test("G2G: an offer-backed hand-over ships the OFFER's template", async () => {
  const listing = row({ accountOffer: "OFFER1", externalId: "g-7", units: [] });
  const stock = fakeSupplied({ claim: SUPPLIED_FULL, offer: OWNER_OFFER });
  const env = g2gEnv({ rows: [listing], stock });

  const out = await withStubbed("../utils/g2gFulfiller", env.stubs, (g) =>
    g.deliverOrder(g2gOrder({}), { dryRun: false }),
  );

  assert.strictEqual(out.delivered, 1, out.error || out.detail);
  assert.strictEqual(out.source, "supplied");

  const sent = env.chat.sendToBuyer.calls[0][1];
  // The owner's words, with the two columns the boilerplate could never carry.
  assert.match(sent, /token=tok-1/, "the offer's {token} must reach the buyer");
  assert.match(sent, /mail=mail@one\.test/);
  assert.match(sent, /note=recovery-code/);
  assert.match(sent, /5 fresh Rocket League accounts/);
  assert.match(sent, /supplied_one:pw1/);
  assert.doesNotMatch(
    sent,
    /ARCHIVE COPY/,
    "the shared Twitch-drops copy must not be sent for an account listing",
  );
  // And it really went through the shared renderer, holding every column: the
  // fulfiller's own normaliser used to keep only login + password.
  assert.strictEqual(stock.calls.deliveryText.length, 1);
  const rendered = stock.calls.deliveryAccounts[0];
  assert.strictEqual(rendered.clientSecret, "tok-1");
  assert.strictEqual(rendered.email, "mail@one.test");
  assert.strictEqual(rendered.extra, "recovery-code");
  // Delivery is only confirmed after the send, and the ledger row is stamped.
  assert.deepStrictEqual(env.mp.g2gSetDeliveredQty.calls[0], ["g-order-1", 1]);
  assert.deepStrictEqual(stock.calls.markDelivered[0].ids, ["LED1"]);
});

test("G2G: the RETRY path renders the offer's template too", async () => {
  // The path every real G2G order took while chat was broken, and the one that
  // arrives holding nothing but the reserved units — the sellable columns have
  // to be read back off the ledger row the resume hands over.
  const listing = row({
    accountOffer: "OFFER1",
    externalId: "g-7",
    units: [
      {
        login: "supplied_one",
        accountId: "",
        contentId: "LED1",
        orderId: "g-order-1",
        messagedAt: null,
        deliveredAt: null,
      },
    ],
  });
  const stock = fakeSupplied({ claim: SUPPLIED_FULL, offer: OWNER_OFFER });
  const env = g2gEnv({ rows: [listing], stock, canSend: true });

  const out = await withStubbed("../utils/g2gFulfiller", env.stubs, (g) =>
    g.deliverOrder(g2gOrder({}), { dryRun: false }),
  );

  assert.strictEqual(out.source, "retry-send", out.error || out.detail);
  const sent = env.chat.sendToBuyer.calls[0][1];
  assert.match(sent, /token=tok-1/);
  assert.match(sent, /mail=mail@one\.test/);
  assert.doesNotMatch(sent, /ARCHIVE COPY/);
  // The resume claimed the SAME row rather than spending a second account.
  assert.strictEqual(stock.calls.claimForListing.length, 1);
  assert.strictEqual(stock.calls.releaseClaim.length, 0);
});

test("G2G: an archive-backed hand-over still ships the shared copy", async () => {
  // The other half of the guarantee: with no accountOffer the row takes
  // byte-for-byte the path it took before, and the offer renderer is never
  // even asked.
  const listing = row({ autoClaimSet: true, set: "SET1", externalId: "g-8" });
  const stock = fakeSupplied({ claim: SUPPLIED_FULL, offer: OWNER_OFFER });
  const env = g2gEnv({ rows: [listing], stock });

  const out = await withStubbed("../utils/g2gFulfiller", env.stubs, (g) =>
    g.deliverOrder(g2gOrder({ orderItemId: "g-order-2", offerId: "g-8" }), {
      dryRun: false,
    }),
  );

  assert.strictEqual(out.delivered, 1, out.error || out.detail);
  assert.strictEqual(
    env.chat.sendToBuyer.calls[0][1],
    "Order g-order-2\n\nARCHIVE COPY for archive_account",
  );
  assert.strictEqual(
    stock.calls.deliveryText.length,
    0,
    "an archive row must never render an account offer's template",
  );
});

/* --------------------------- PlayerAuctions ------------------------------ */

function paEnv({ rows = [], sharers = 1, settings = fakeSettings() }) {
  const arch = archiveSpies();
  const Listing = fakeListingModel(rows, { count: sharers });
  const mp = {
    playerauctionsOfferIdFromUrl: spy(() => ""),
    playerauctionsSendOrderMessage: spy(async () => ({})),
    playerauctionsMarkDelivered: spy(async () => ({})),
    playerauctionsSetQuantity: spy(async () => ({})),
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
    "../models/UnclaimedAccount": fakeById(null),
    "../models/DropSet": fakeById(null),
    "../models/DropLog": fakeById(null),
    "../routes/shopRoutes": {
      availableAccountsForSet: arch.availableAccountsForSet,
    },
    "../utils/listedLogins": {
      loginsOnActiveListings: async () => new Set(),
      notListed: (a) => a,
    },
    "../utils/secretBox": { decrypt: (v) => String(v || "") },
    "../utils/dropReservation": {
      reserveSetOnAccount: arch.reserveSetOnAccount,
      releaseAccountsForTag: spy(async () => 0),
    },
    "../utils/settings": settings,
    "../utils/marketplaces": mp,
    "../utils/unclaimedCoverage": {},
    "../utils/unclaimedAutoList": {},
    "../utils/playerauctionsProof": proof,
    "../utils/playerauctionsFarmService": {},
    "../utils/farmServiceAlert": { alertFarmFailure: async () => {} },
    "../utils/operatorFarm": {},
    "../utils/telegram": { sendTelegram: async () => {} },
  };
  return { stubs, arch, mp, proof, Listing };
}

// This test used to assert the OPPOSITE of its second half: it pinned
// playerauctionsFulfiller dividing the ledger count by the number of active
// PlayerAuctions rows on the offer (sharersOfAccountOffer). S4 moved that split
// into utils/suppliedStock.stockFor, which counts the active rows on EVERY
// market — so the local division became a SECOND one and 6 accounts shared with
// one other listing would have been advertised as 1, or as 0 once a third
// market joined, taking a fully stocked offer off sale. The rule under test is
// now "report what the claim layer says, undivided".
test("PlayerAuctions: stockFor reports the claim layer's share, and never re-divides it", async () => {
  const listing = row({
    accountOffer: "OFFER1",
    externalId: "pa-9",
    units: [{ login: "gone", orderId: "pa-0", deliveredAt: new Date() }],
  });
  // 3 is what suppliedStock.stockFor hands back for a shelf of 6 split with one
  // other listing — the share, already divided.
  const stock = fakeSupplied({ stock: 3 });
  const deps = () => ({ stock, AccountOffer: fakeById(null) });

  const alone = await withStubbed(
    "../utils/playerauctionsFulfiller",
    paEnv({ rows: [listing], sharers: 1 }).stubs,
    (pa) => pa.stockFor(listing, undefined, deps),
  );
  assert.strictEqual(alone, 3, "0 here hides a live offer with a full shelf");

  // The number of PA rows on the offer must make NO difference here any more:
  // the claim layer has already counted every market's rows and taken its cut.
  const shared = await withStubbed(
    "../utils/playerauctionsFulfiller",
    paEnv({ rows: [listing], sharers: 2 }).stubs,
    (pa) => pa.stockFor(listing, undefined, deps),
  );
  assert.strictEqual(shared, 3, "the shelf must not be divided twice");
});

test("PlayerAuctions: an offer-backed order hands over supplied stock", async () => {
  const listing = row({
    marketplace: "playerauctions",
    externalId: "pa-9",
    title: "Twitch drops",
    price: 5,
    accountOffer: "OFFER1",
  });
  const stock = fakeSupplied({ claim: SUPPLIED, stock: 3 });
  const deps = () => ({
    stock,
    AccountOffer: fakeById({ title: "Fresh drops", autoDeliver: true }),
  });
  const env = paEnv({ rows: [listing] });

  const out = await withStubbed(
    "../utils/playerauctionsFulfiller",
    env.stubs,
    (pa) =>
      pa.deliverOrder(
        {
          orderId: "pa-1",
          offerId: "pa-9",
          orderTitle: "Twitch drops",
          purchaseQuantity: 1,
        },
        { dryRun: false, supplied: deps },
      ),
  );

  assert.strictEqual(out.delivered, 1);
  assert.strictEqual(out.source, "supplied:Fresh drops");
  assert.strictEqual(
    archiveTouches(env.arch),
    0,
    "no Drop Archive account may be reserved for a supplied sale",
  );
  // The offer's own template reached the buyer, inside PA's 300-char budget.
  assert.deepStrictEqual(env.mp.playerauctionsSendOrderMessage.calls[0], [
    "pa-1",
    "Login: supplied_one",
  ]);
  assert.strictEqual(env.mp.playerauctionsMarkDelivered.calls.length, 1);
  assert.deepStrictEqual(stock.calls.markDelivered[0].ids, ["LED1"]);
  // Reserved BEFORE the send (the resume anchor) and stamped after it.
  assert.strictEqual(listing.units.length, 1);
  assert.strictEqual(listing.units[0].contentId, "LED1");
  assert.ok(listing.units[0].deliveredAt, "the unit must end up delivered");
  // And the shelf is re-counted from the ledger, never from the units.
  assert.deepStrictEqual(env.mp.playerauctionsSetQuantity.calls[0], ["pa-9", 3]);
});

/* ----------- PlayerAuctions: a switched-off listing says so -------------- */

// 4. THE SILENT PARK (review finding F7). All three kill switches (contract B8)
//    refuse a hand-over with a reason string, and that string used to go
//    nowhere: ALERT_SKIPS did not match any of them and the tick's log chain
//    prints only errors, dry runs and deliveries. So a PAID order on a
//    switched-off listing parked in complete silence -- the buyer waiting, the
//    delivery guarantee running down, and nothing anywhere naming the switch
//    that did it. The refusal itself is correct; the silence was the defect.

test("PlayerAuctions: every kill-switch refusal is one the operator hears about", async () => {
  // Driven through the REAL suppliedDeliveryBlockedBy rather than three copied
  // strings: the wording and the matcher have to stay in step, and a copy here
  // would keep passing after a reword while the alert quietly stopped firing.
  const cases = [
    [fakeSettings({ enabled: false }), { autoDeliver: true }],
    [fakeSettings({ autoDeliver: false }), { autoDeliver: true }],
    [fakeSettings(), { autoDeliver: false }],
  ];
  for (const [settings, offer] of cases) {
    await withStubbed(
      "../utils/playerauctionsFulfiller",
      paEnv({ settings }).stubs,
      (pa) => {
        const why = pa.suppliedDeliveryBlockedBy(offer);
        assert.ok(why, "the switch must refuse the hand-over");
        assert.ok(
          pa.alertsOperator(why),
          "a paid order would park in silence: " + JSON.stringify(why),
        );
      },
    );
  }
  // The routine states must stay quiet, or the alert is worth nothing. The
  // second one is the whole TICK being off, which is not a parked order.
  await withStubbed(
    "../utils/playerauctionsFulfiller",
    paEnv({}).stubs,
    (pa) => {
      assert.ok(!pa.alertsOperator("already delivered"));
      assert.ok(!pa.alertsOperator("playerauctionsAutoDeliver off"));
    },
  );
});

test("PlayerAuctions: the tick names the switch once per order, not once a tick", async () => {
  const listing = row({
    marketplace: "playerauctions",
    externalId: "pa-9",
    title: "Twitch drops",
    price: 5,
    accountOffer: "OFFER1",
  });
  const stock = fakeSupplied({ claim: SUPPLIED, stock: 3 });
  const env = paEnv({
    rows: [listing],
    settings: fakeSettings({
      autoDeliver: false,
      af: {
        playerauctionsAutoDeliver: true,
        playerauctionsDeliverDryRun: false,
      },
    }),
  });
  const order = {
    orderId: "pa-77",
    offerId: "pa-9",
    orderTitle: "Twitch drops",
    purchaseQuantity: 1,
    name: "someBuyer",
    price: "$5.00",
  };
  env.mp.keyStatus = () => ({ playerauctions: { configured: true } });
  env.mp.playerauctionsPendingOrders = async () => [order];

  const sent = [];
  const logged = [];
  const realError = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  let out;
  try {
    out = await withStubbed(
      "../utils/playerauctionsFulfiller",
      {
        ...env.stubs,
        "../utils/telegram": { sendTelegram: async (t) => sent.push(t) },
        "../utils/playerauctionsFarmService": {
          deliverFarmOrder: async () => null,
        },
        // deliverPendingOrders does not inject the supplied deps, so the tick
        // resolves them for real -- which is the path the defect lived on.
        "../utils/suppliedStock": stock,
        "../models/AccountOffer": fakeById({
          title: "Fresh drops",
          autoDeliver: true,
        }),
      },
      async (pa) => {
        await pa.deliverPendingOrders(); // the tick that meets the paid order
        return pa.deliverPendingOrders(); // and the next one, 60 seconds later
      },
    );
  } finally {
    console.error = realError;
  }

  assert.match(out.results[0].skipped, /auto-delivery is off/);
  assert.strictEqual(
    stock.calls.claimForListing.length,
    0,
    "a refused hand-over must not spend stock",
  );
  const said = logged.filter((l) => /NOT delivered/.test(l));
  assert.strictEqual(said.length, 1, "one log line per order, not one a tick");
  assert.match(said[0], /pa-77/);
  assert.match(said[0], /auto-delivery is off/);
  assert.strictEqual(sent.length, 1, "one alert per order, not one a tick");
  assert.match(sent[0], /PAID/);
  assert.match(sent[0], /auto-delivery is off/);
  // The remedy has to match the reason: this stock is on the shelf, so the
  // standing "no listing row" postscript would send the owner hunting for it.
  assert.match(sent[0], /on the shelf/);
});

/* ------- The same silence on Eldorado, Z2U and G2G (finding S3) ---------- */

// F7 made a switched-off account listing's refusal VISIBLE on PlayerAuctions
// and only there. The other three fulfillers share the shape and had the same
// hole: the offer stays live at its full quantity while delivery is off, so
// more buyers keep paying, and nothing anywhere said why nothing shipped — no
// Telegram, no console line, no SystemEvent, no lastError, no guardian finding.
// The refusal itself is correct on all four; the silence was the defect.
//
// Each test drives the REAL tick twice, because "once per order" and "once per
// 60s tick" are the two outcomes that look identical on a single pass.

test("Eldorado: the tick names the switch once per order, not once a tick", async () => {
  const listing = row({
    marketplace: "eldorado",
    externalId: "e-9",
    accountOffer: "OFFER1",
  });
  const stock = fakeSupplied({ claim: SUPPLIED, stock: 3 });
  const env = eldEnv({
    rows: [listing],
    stock,
    offer: { title: "Fresh drops", autoDeliver: false },
    settings: fakeSettings({
      af: { eldoradoAutoDeliver: true, eldoradoDeliverDryRun: false },
    }),
  });
  const order = {
    id: "eo-77",
    offerId: "e-9",
    purchaseQuantity: 1,
    buyerName: "someBuyer",
    orderOfferDetails: { offerTitle: "Twitch drops" },
  };
  env.mp.keyStatus = () => ({ eldorado: { configured: true } });
  env.mp.eldoradoEnsureFreshSession = async () => ({});
  env.mp.eldoradoPaidOrders = async () => [order];

  const sent = [];
  const logged = [];
  const realError = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  let out;
  try {
    out = await withStubbed(
      "../utils/eldoradoFulfiller",
      {
        ...env.stubs,
        "../utils/telegram": { sendTelegram: async (t) => sent.push(t) },
        "../utils/eldoradoFarmService": { deliverFarmOrder: async () => null },
      },
      async (e) => {
        await e.deliverPaidOrders(); // the tick that meets the paid order
        return e.deliverPaidOrders(); // and the next one, 60 seconds later
      },
    );
  } finally {
    console.error = realError;
  }

  assert.match(out.results[0].skipped, /auto-delivery is off/);
  assert.strictEqual(
    stock.calls.claimForListing.length,
    0,
    "a refused hand-over must not spend stock",
  );
  const said = logged.filter((l) => /NOT delivered/.test(l));
  assert.strictEqual(said.length, 1, "one log line per order, not one a tick");
  assert.match(said[0], /eo-77/);
  assert.match(said[0], /auto-delivery is off/);
  assert.strictEqual(sent.length, 1, "one alert per order, not one a tick");
  assert.match(sent[0], /PAID/);
  assert.match(sent[0], /auto-delivery is off/);
  // The remedy has to match the reason: this stock is on the shelf, so the
  // standing "deliver it by hand" postscript would send the owner hunting for
  // accounts that are not missing.
  assert.match(sent[0], /on the shelf/);
});

test("Eldorado: a kill-switch refusal alerts, and the routine skips still do not", async () => {
  await withStubbed(
    "../utils/eldoradoFulfiller",
    eldEnv({}).stubs,
    (e) => {
      // Both wordings deliverOrder can refuse with (the settings gate and the
      // offer's own toggle). Spelled out here rather than derived, because the
      // point of the assertion is that the PREDICATE and the reasons stay in
      // step — a reworded reason falling out of the alert would look exactly
      // like no problem at all.
      assert.ok(e.alertsOperator("account-listing auto-delivery is off"));
      assert.ok(
        e.alertsOperator('auto-delivery is off for offer "Fresh drops"'),
      );
      assert.ok(!e.alertsOperator("already delivered"));
      assert.ok(!e.alertsOperator("eldoradoAutoDeliver off"));
      assert.ok(!e.alertsOperator(""));
    },
  );
});

test("Z2U: a switched-off account listing pages the operator once, not every tick", async () => {
  const listing = row({
    marketplace: "z2u",
    externalId: "z-9",
    title: "Twitch drops",
    accountOffer: "OFFER1",
  });
  const stock = fakeSupplied({
    claim: SUPPLIED,
    offer: { title: "Fresh drops" },
    enabled: false,
  });
  const env = z2uEnv({
    rows: [listing],
    orders: [{ orderId: "z-77", title: "Twitch drops" }],
    stock,
    settings: fakeSettings({
      af: { z2uAutoDeliver: true, z2uDeliverDryRun: false },
    }),
  });

  const sent = [];
  const logged = [];
  const realLog = console.log;
  console.log = (...a) => logged.push(a.join(" "));
  try {
    await withStubbed(
      "../utils/z2uFulfiller",
      {
        ...env.stubs,
        "../utils/telegram": { sendTelegram: async (t) => sent.push(t) },
      },
      async (z) => {
        await z.deliverTick();
        return z.deliverTick();
      },
    );
  } finally {
    console.log = realLog;
  }

  assert.strictEqual(
    stock.calls.claimForListing.length,
    0,
    "a refused hand-over must not spend stock",
  );
  assert.strictEqual(sent.length, 1, "one alert per order, not one a tick");
  assert.match(sent[0], /PAID/);
  assert.match(sent[0], /z-77/);
  assert.match(sent[0], /auto-delivery is off/);
  assert.match(sent[0], /on the shelf/);
  // The per-tick console line is this file's own long-standing habit and is
  // deliberately left alone — it is cheap, and it is the only trace an
  // ORDINARY skip leaves. The page is the thing that had to be once per order.
  assert.strictEqual(
    logged.filter((l) => /auto-delivery is off/.test(l)).length,
    2,
  );
});

test("G2G: a switched-off account listing leaves a log line and one page", async () => {
  const listing = row({
    marketplace: "g2g",
    externalId: "g-9",
    title: "Twitch drops",
    accountOffer: "OFFER1",
  });
  const stock = fakeSupplied({ claim: SUPPLIED });
  const env = g2gEnv({
    rows: [listing],
    stock,
    orders: [g2gOrder({ orderItemId: "g-77", offerId: "g-9" })],
    settings: fakeSettings({
      enabled: false,
      af: { g2gAutoDeliver: true, g2gDeliverDryRun: false },
    }),
  });

  const sent = [];
  const logged = [];
  const realError = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  try {
    await withStubbed(
      "../utils/g2gFulfiller",
      {
        ...env.stubs,
        "../utils/telegram": { sendTelegram: async (t) => sent.push(t) },
      },
      async (g) => {
        await g.deliverPendingOrders();
        return g.deliverPendingOrders();
      },
    );
  } finally {
    console.error = realError;
  }

  assert.strictEqual(
    stock.calls.claimForListing.length,
    0,
    "a refused hand-over must not spend stock",
  );
  const said = logged.filter((l) => /NOT delivered/.test(l));
  assert.strictEqual(said.length, 1, "one log line per order, not one a tick");
  assert.match(said[0], /g-77/);
  assert.match(said[0], /switched off in settings/);
  assert.strictEqual(sent.length, 1, "one alert per order, not one a tick");
  assert.match(sent[0], /PAID/);
  assert.match(sent[0], /switched off in settings/);
  assert.match(sent[0], /on the shelf/);
});
