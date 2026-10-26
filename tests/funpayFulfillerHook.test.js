// The one branch utils/eldoradoFulfiller.deliverOrder gained for FunPay resale:
// a row with `funpaySource` goes to utils/funpayResale, every other row does not.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

function spy(impl = async () => undefined) {
  const fn = (...args) => {
    fn.calls.push(args);
    return impl(...args);
  };
  fn.calls = [];
  return fn;
}

async function withStubbed(target, stubs, fn) {
  const targetFile = require.resolve(target);
  const map = new Map(Object.entries(stubs).map(([k, v]) => [require.resolve(k), v]));
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

function env(listing, engineResult = { orderId: "eo-1", delivered: 1, source: "funpay:x" }) {
  const engine = { deliverEldoradoOrder: spy(async () => engineResult) };
  const mp = {
    eldoradoSendOrderMessage: spy(async () => ({})),
    eldoradoMarkDelivered: spy(async () => ({})),
    eldoradoSetQuantity: spy(async () => ({})),
    eldoradoDelist: spy(async () => ({})),
  };
  const none = { findById: async () => null, findOne: async () => null, find: async () => [] };
  const stubs = {
    "../models/MarketplaceListing": { findOne: async () => listing },
    "../models/BotAccount": none,
    "../models/UnclaimedAccount": none,
    "../models/DropSet": none,
    "../models/DropLog": none,
    "../models/AccountOffer": none,
    "../routes/shopRoutes": { availableAccountsForSet: spy(async () => []) },
    "../utils/listedLogins": { loginsOnActiveListings: async () => new Set(), notListed: (a) => a },
    "../utils/secretBox": { decrypt: (v) => String(v || "") },
    "../utils/dropReservation": { reserveSetOnAccount: spy(async () => true), releaseAccountsForTag: spy(async () => 0), releaseSetForAccounts: spy(async () => 0) },
    "../utils/settings": { getAutoFarm: () => ({}), getAccountListingSettings: () => ({ enabled: true, autoDeliver: true }) },
    "../utils/marketplaces": mp,
    "../utils/eldoradoFarmService": {},
    "../utils/unclaimedAutoList": {},
    "../utils/operatorFarm": {},
    "../utils/telegram": { sendTelegram: async () => {} },
    "../utils/funpayResale": engine,
  };
  return { stubs, engine, mp };
}

const order = { id: "eo-1", offerId: "e-9", purchaseQuantity: 2 };

test("a FunPay-backed row is handed to the resale engine, result returned as is", async () => {
  const listing = { marketplace: "eldorado", externalId: "e-9", funpaySource: "SRC1", units: [] };
  const e = env(listing);
  const out = await withStubbed("../utils/eldoradoFulfiller", e.stubs, (f) => f.deliverOrder(order, { dryRun: false }));
  assert.deepEqual(out, { orderId: "eo-1", delivered: 1, source: "funpay:x" });
  assert.equal(e.engine.deliverEldoradoOrder.calls.length, 1);
  const arg = e.engine.deliverEldoradoOrder.calls[0][0];
  assert.equal(arg.order, order);
  assert.equal(arg.listing, listing);
  assert.equal(arg.qty, 2);
  assert.equal(arg.dryRun, false);
  assert.equal(e.mp.eldoradoSendOrderMessage.calls.length, 0, "the fulfiller itself sends nothing for this row");
});

test("the fulfiller's dry run is passed through", async () => {
  const listing = { marketplace: "eldorado", externalId: "e-9", funpaySource: "SRC1", units: [] };
  const e = env(listing, { orderId: "eo-1", dryRun: true, wouldSend: "x" });
  const out = await withStubbed("../utils/eldoradoFulfiller", e.stubs, (f) => f.deliverOrder(order, { dryRun: true }));
  assert.equal(out.dryRun, true);
  assert.equal(e.engine.deliverEldoradoOrder.calls[0][0].dryRun, true);
});

test("an order already on the row's units never reaches the engine", async () => {
  const listing = { marketplace: "eldorado", externalId: "e-9", funpaySource: "SRC1", units: [{ orderId: "eo-1", login: "a" }] };
  const e = env(listing);
  const out = await withStubbed("../utils/eldoradoFulfiller", e.stubs, (f) => f.deliverOrder(order, { dryRun: false }));
  assert.equal(out.skipped, "already delivered");
  assert.equal(e.engine.deliverEldoradoOrder.calls.length, 0);
});

test("a row without funpaySource never touches the engine", async () => {
  const listing = { marketplace: "eldorado", externalId: "e-9", units: [] };
  const e = env(listing);
  const out = await withStubbed("../utils/eldoradoFulfiller", e.stubs, (f) => f.deliverOrder(order, { dryRun: false }));
  assert.equal(e.engine.deliverEldoradoOrder.calls.length, 0);
  assert.ok(out.skipped || out.error, "falls through to the existing paths");
});
