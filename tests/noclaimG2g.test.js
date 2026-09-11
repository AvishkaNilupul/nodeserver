// G2G delivers a No-claim Shop listing (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md
// §8c) — and nothing else changes.
//
// A no-claim row keeps its `set`, so every one of these is a way to sell the
// wrong thing:
//
// 1. BRANCH ORDER. Below the no-claim branch sit the Drop Archive claims. The
//    archive holds only CLAIMED drops, so an account from it is worthless to a
//    no-claim buyer — and a stock count from it advertises accounts that do not
//    exist. The no-claim branch must come first in pickStock, and before the
//    generic `set` branch in realStockFor.
// 2. CREDENTIALS SOURCE. The claim hands back the credential it committed to
//    the order. credentialsFor's BotAccount lookups must never see a no-claim
//    unit: a pool login that also exists in the archive would resolve SOMEONE
//    ELSE's password and ship it to a paying buyer.
// 3. THE SALE. markSold runs once the credential has verifiably reached the
//    buyer, not before, not on a failed send, and not twice.
// 4. THE RETRY. A "sold" claim cannot be handed back, so a retry of the same
//    order must RESUME the same ledgers (keyed on listing + order) rather than
//    burn new accounts — and must never ship an account it did not reserve.
// 5. STOCK SYNC. No-claim rows are origin "manual"; the sync must still select
//    them, count them through noclaimStock, and leave an offer alone when the
//    count cannot be read.
//
// No Mongo and no network: every dependency is replaced before the fulfiller is
// loaded and stays replaced while it runs, because most of them are required
// lazily inside the branch under test.
process.env.CRED_SECRET ||= "test-secret";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
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

// The file the fulfiller will ask for. utils/noclaimStock.js is written by a
// sibling agent and may not exist yet, so a key that cannot be resolved maps to
// its would-be path instead.
function stubPath(k) {
  try {
    return require.resolve(k);
  } catch {
    return path.resolve(__dirname, k) + ".js";
  }
}

// Load the fulfiller with `stubs` in place and keep them in place for the whole
// of `fn`. `loaded` records which stubbed modules were actually required, so a
// test can prove a module was never even reached.
async function withStubbed(stubs, fn) {
  const target = require.resolve("../utils/g2gFulfiller");
  const map = new Map(
    Object.entries(stubs).map(([k, v]) => [stubPath(k), v]),
  );
  const loaded = new Set();
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    let file;
    try {
      file = Module._resolveFilename(request, parent, isMain);
    } catch {
      if (!parent || !parent.filename || !request.startsWith(".")) {
        return origLoad.apply(this, arguments);
      }
      file = path.resolve(path.dirname(parent.filename), request);
      if (!file.endsWith(".js")) file += ".js";
    }
    if (map.has(file)) {
      loaded.add(file);
      return map.get(file);
    }
    return origLoad.apply(this, arguments);
  };
  delete require.cache[target];
  try {
    return await fn(require(target), loaded);
  } finally {
    Module._load = origLoad;
    delete require.cache[target];
  }
}

// A MarketplaceListing row. Plain object on purpose, as in
// tests/suppliedFulfilment.test.js.
function row(fields) {
  const d = {
    _id: "ROW1",
    marketplace: "g2g",
    externalId: "g-7",
    status: "active",
    origin: "manual",
    units: [],
    ...fields,
    saves: 0,
    markModified() {},
    async save() {
      d.saves++;
      return d;
    },
  };
  return d;
}

// The shape rowFields (§3) gives a no-claim row.
function noclaimRow(fields = {}) {
  return row({
    noclaimStock: true,
    set: "SET1",
    accountId: "",
    price: 3.5,
    requiredDrops: [
      { name: "Tracer skin", qty: 1 },
      { name: "Loot box", qty: 2 },
    ],
    ...fields,
  });
}

function reservedUnit(fields = {}) {
  return {
    login: "nc_one",
    accountId: "",
    contentId: "LED1",
    orderId: "g-order-1",
    messagedAt: null,
    deliveredAt: null,
    ...fields,
  };
}

function g2gOrder(fields = {}) {
  return {
    orderItemId: "g-order-1",
    offerId: "g-7",
    purchasedQty: 1,
    buyerId: "BUYER1",
    deliveredQty: 0,
    currency: "USD",
    amount: 4.2,
    title: "Overwatch 2 drops",
    ...fields,
  };
}

const NC_ONE = { ledgerId: "LED1", login: "nc_one", password: "pw-one", email: "", poolAccountId: "P1" };
const NC_TWO = { ledgerId: "LED2", login: "nc_two", password: "pw-two", email: "", poolAccountId: "P2" };

// The no-claim claim layer, modelled on its contract (§3): a "sold" claim is
// keyed on listing + order, asking again for the same order RESUMES what it
// already took before topping up from the free pool, and a dry run only peeks.
function fakeNcs(events, { enabled = true, free = [NC_ONE, NC_TWO], claimImpl = null, stock = 3, stockThrows = false } = {}) {
  const pool = free.map((a) => ({ ...a }));
  const sold = new Map();
  const calls = { claimForSet: [], markSold: [], stockForListing: [] };
  return {
    calls,
    pool,
    deliveryEnabled: () => enabled,
    async claimForSet(set, want, opts = {}) {
      calls.claimForSet.push({ set, want, opts });
      events.push("claim");
      if (claimImpl) return claimImpl(set, want, opts);
      if (!enabled && !opts.dryRun) return [];
      const key = opts.listingId + "|" + opts.orderId;
      const out = (opts.orderId && sold.get(key) ? sold.get(key) : []).slice(0, want);
      if (opts.dryRun) return out.concat(pool.slice(0, want - out.length));
      while (out.length < want && pool.length) out.push(pool.shift());
      sold.set(key, out.slice());
      return out.map((a) => ({ ...a }));
    },
    async markSold(ids, opts) {
      calls.markSold.push({ ids, opts });
      events.push("markSold");
      return ids.length;
    },
    async stockForListing(r) {
      calls.stockForListing.push(r);
      if (stockThrows) throw new Error("noclaim stock read failed");
      return stock;
    },
  };
}

function makeEnv({ rows = [], orders = [], ncs = {}, af = {}, canSend = true } = {}) {
  const events = [];
  const env = { events, canSend, sendError: null, confirmError: null };
  env.ncs = fakeNcs(events, ncs);
  const queries = [];
  env.queries = queries;
  env.Listing = {
    find(q) {
      queries.push(q);
      const p = Promise.resolve(rows);
      p.limit = () => p;
      return p;
    },
    async findOne() {
      return rows[0] || null;
    },
  };
  const set = { _id: "SET1", name: "Overwatch 2 bundle", stockSource: "noclaim", items: [{}, {}] };
  env.DropSet = {
    calls: [],
    findById(id) {
      env.DropSet.calls.push(String(id));
      const p = Promise.resolve(set);
      p.lean = () => Promise.resolve(set);
      return p;
    },
  };
  env.mp = {
    g2gOrderCounts: spy(async () => ({ preparing: orders.length, delivering: 0 })),
    g2gPendingOrders: spy(async () => orders),
    g2gDelist: spy(async () => ({})),
    g2gRelist: spy(async () => ({})),
    g2gSetQuantity: spy(async () => ({})),
    g2gStartDeliver: spy(async () => ({})),
    g2gMarkDelivering: spy(async () => ({})),
    g2gSetDeliveredQty: spy(async () => {
      if (env.confirmError) throw env.confirmError;
      events.push("confirm");
      return {};
    }),
  };
  env.chat = {
    canSend: () => env.canSend,
    sendToBuyer: spy(async () => {
      if (env.sendError) throw env.sendError;
      events.push("send");
      return { confirmed: true };
    }),
  };
  // Tripwires: a no-claim row that touches any of these is selling somebody
  // else's account, or reading somebody else's password.
  env.eld = {
    claimAccountsForSet: spy(async () => [
      { accountId: "ARCH1", login: "archive_account", password: "arch-pw" },
    ]),
    claimUnclaimedForGame: spy(async () => []),
    releaseAccounts: spy(async () => {}),
    eldoradoDeliveryCode: (login, password) => "Login: " + login + "\nPassword: " + password,
  };
  env.shop = { availableAccountsForSet: spy(async () => [{ accountId: "ARCH1", login: "archive_account" }]) };
  env.BotAccount = { findById: spy(() => ({ lean: async () => null })), findOne: spy(() => ({ lean: async () => null })) };
  env.secretBox = { decrypt: spy((v) => String(v || "")) };
  env.supplied = {
    claimForListing: spy(async () => []),
    stockFor: spy(async () => 0),
    offerFor: spy(async () => null),
    releaseClaim: spy(async () => 0),
    markDelivered: spy(async () => 0),
    deliveryText: spy(() => ""),
  };
  env.telegram = { sendTelegram: spy(async () => {}) };
  env.stubs = {
    "../models/MarketplaceListing": env.Listing,
    "../models/DropSet": env.DropSet,
    "../models/BotAccount": env.BotAccount,
    "../utils/secretBox": env.secretBox,
    "../utils/settings": {
      getAutoFarm: () => af,
      getAccountListingSettings: () => ({ enabled: true, autoDeliver: true }),
    },
    "../utils/marketplaces": env.mp,
    "../utils/g2gChat": env.chat,
    "../utils/g2gFarmService": {
      deliverFarmOrder: async () => null,
      closeConfirmedFarmOrders: async () => ({}),
    },
    "../utils/eldoradoFulfiller": env.eld,
    "../routes/shopRoutes": env.shop,
    "../utils/listedLogins": {
      loginsOnActiveListings: async () => new Set(),
      notListed: (a) => a,
    },
    "../utils/suppliedStock": env.supplied,
    "../utils/telegram": env.telegram,
    "../utils/noclaimStock": env.ncs,
  };
  return env;
}

// Nothing on the archive / unclaimed / supplied side was touched, and no
// password was looked up anywhere but the no-claim claim.
function assertNeverTheArchive(env, loaded) {
  assert.strictEqual(env.eld.claimAccountsForSet.calls.length, 0, "Drop Archive claim");
  assert.strictEqual(env.eld.claimUnclaimedForGame.calls.length, 0, "unclaimed-game claim");
  assert.strictEqual(env.shop.availableAccountsForSet.calls.length, 0, "archive availability");
  assert.strictEqual(env.supplied.claimForListing.calls.length, 0, "account-listing claim");
  assert.ok(!loaded.has(stubPath("../models/BotAccount")), "credentialsFor's BotAccount must never load");
  assert.ok(!loaded.has(stubPath("../utils/secretBox")), "no password is decrypted outside the claim");
}

function quietly(fn) {
  const real = console.error;
  console.error = () => {};
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.error = real;
    });
}

/* ---------------------------- 1. branch order ---------------------------- */

test("pickStock: a no-claim row claims through noclaimStock FIRST, never the archive", async () => {
  // Every other stock source's marker is present too — the no-claim flag must
  // win over all of them, and a free-looking unit must not be taken as stock.
  const listing = noclaimRow({
    unclaimedGame: "Overwatch",
    autoClaimSet: true,
    accountOffer: "OFFER1",
    units: [{ login: "stale_unit", accountId: "ARCH9", orderId: "", deliveredAt: null }],
  });
  const env = makeEnv({ rows: [listing] });

  const out = await withStubbed(env.stubs, async (g, loaded) => {
    const r = await g.pickStock(listing, { orderItemId: "g-1", purchasedQty: 1 }, { dryRun: false });
    assertNeverTheArchive(env, loaded);
    return r;
  });

  assert.strictEqual(out.error, undefined);
  assert.strictEqual(out.source, "noclaim-set:SET1");
  assert.deepStrictEqual(out.picked.map((p) => p.login), ["nc_one"]);
  assert.strictEqual(env.ncs.calls.claimForSet.length, 1);
  const call = env.ncs.calls.claimForSet[0];
  assert.strictEqual(call.set._id, "SET1", "the claim gets the row's DropSet");
  assert.strictEqual(call.want, 1);
  assert.deepStrictEqual(call.opts, {
    market: "g2g",
    listingId: "ROW1",
    orderId: "g-1",
    mode: "sold",
    dryRun: false,
  });
  assert.strictEqual(env.supplied.offerFor.calls.length, 0);
});

test("source order: no-claim leads pickStock and precedes realStockFor's set branch", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "g2gFulfiller.js"), "utf8");
  const pick = src.slice(src.indexOf("async function pickStock("), src.indexOf("async function deliverOrder("));
  const nc = pick.indexOf("if (listing.noclaimStock)");
  assert.ok(nc > 0, "pickStock should have a no-claim branch");
  for (const other of [
    "if (listing.unclaimedGame)",
    "if (listing.autoClaimSet && listing.set)",
    "if (listing.accountOffer)",
    "undeliveredUnits(listing)",
  ]) {
    assert.ok(nc < pick.indexOf(other), "the no-claim branch must precede " + other);
  }
  const real = src.slice(src.indexOf("async function realStockFor("), src.indexOf("async function syncStock("));
  const rnc = real.indexOf("if (row.noclaimStock)");
  assert.ok(rnc > 0, "realStockFor should have a no-claim branch");
  assert.ok(rnc < real.indexOf("if (row.set)"), "before the generic set branch");
  assert.ok(rnc < real.indexOf("(row.units || []).length"), "before the units fallback");
});

test("pickStock: the kill switch says why and claims nothing", async () => {
  const listing = noclaimRow();
  const env = makeEnv({ rows: [listing], ncs: { enabled: false } });

  const out = await withStubbed(env.stubs, (g) =>
    g.deliverOrder(g2gOrder(), { dryRun: false }),
  );

  assert.strictEqual(out.error, "no-claim listing auto-delivery is off");
  assert.strictEqual(env.ncs.calls.claimForSet.length, 0);
  assert.strictEqual(env.chat.sendToBuyer.calls.length, 0);
  assert.strictEqual(listing.units.length, 0);
});

test("a dry run rehearses the claim without committing or sending", async () => {
  const listing = noclaimRow();
  const env = makeEnv({ rows: [listing] });

  const out = await withStubbed(env.stubs, (g) =>
    g.deliverOrder(g2gOrder(), { dryRun: true }),
  );

  assert.strictEqual(out.dryRun, true);
  assert.strictEqual(out.source, "noclaim-set:SET1");
  assert.match(out.wouldSend, /\[nc_one\]/, "names the account it would send");
  assert.strictEqual(env.ncs.calls.claimForSet[0].opts.dryRun, true);
  assert.strictEqual(env.ncs.pool.length, 2, "a rehearsal claims nothing");
  assert.strictEqual(env.chat.sendToBuyer.calls.length, 0);
  assert.strictEqual(env.ncs.calls.markSold.length, 0);
  assert.strictEqual(listing.units.length, 0);
});

test("a short claim is never a partial shipment, and the next tick resumes it", async () => {
  const listing = noclaimRow();
  const env = makeEnv({ rows: [listing], ncs: { free: [NC_ONE] } });
  const order = g2gOrder({ purchasedQty: 2, amount: 8.4 });

  const [first, second] = await withStubbed(env.stubs, async (g) => {
    const a = await g.deliverOrder(order, { dryRun: false });
    env.ncs.pool.push({ ...NC_TWO }); // stock arrives before the next tick
    const b = await g.deliverOrder(order, { dryRun: false });
    return [a, b];
  });

  assert.strictEqual(
    first.error,
    "only 1 of 2 no-claim account(s) claimed — no free no-claim account holds all 2 advertised item(s)",
  );
  // The second tick got the account the first one already held, plus ONE more.
  assert.strictEqual(second.delivered, 2, second.error || second.detail);
  const sent = env.chat.sendToBuyer.calls.map((c) => c[1]);
  assert.strictEqual(sent.length, 1, "only the full order was ever sent");
  assert.match(sent[0], /=== ACCOUNT 1 of 2 ===/);
  assert.match(sent[0], /nc_one[\s\S]*nc_two/);
  assert.strictEqual(env.ncs.pool.length, 0);
  assert.deepStrictEqual(env.ncs.calls.markSold.map((c) => c.ids), [["LED1", "LED2"]]);
  assert.strictEqual(env.ncs.calls.markSold[0].opts.priceUsd, 4.2, "per-account share of the total");
});

/* ------------------------- 2. credentials source ------------------------- */

test("deliverOrder ships exactly the claimed credentials — never BotAccount, never the archive", async () => {
  const listing = noclaimRow();
  const env = makeEnv({ rows: [listing] });

  const out = await withStubbed(env.stubs, async (g, loaded) => {
    const r = await g.deliverOrder(g2gOrder(), { dryRun: false });
    assertNeverTheArchive(env, loaded);
    return r;
  });

  assert.strictEqual(out.delivered, 1, out.error || out.detail);
  assert.strictEqual(out.source, "noclaim-set:SET1");
  assert.strictEqual(
    env.chat.sendToBuyer.calls[0][1],
    "Order g-order-1\n\nLogin: nc_one\nPassword: pw-one",
  );
  assert.strictEqual(env.chat.sendToBuyer.calls[0][0], "BUYER1");
  // The receipt: the ledger id where a unit keeps it, and no BotAccount id.
  assert.strictEqual(listing.units.length, 1);
  const u = listing.units[0];
  assert.strictEqual(u.contentId, "LED1");
  assert.strictEqual(u.accountId, "");
  assert.strictEqual(u.login, "nc_one");
  assert.strictEqual(u.orderId, "g-order-1");
  assert.ok(u.messagedAt instanceof Date && u.deliveredAt instanceof Date);
});

/* ------------------------------ 3. the sale ------------------------------ */

test("markSold runs once, AFTER the verified send, with the order's price and the claim's note", async () => {
  const listing = noclaimRow();
  const env = makeEnv({ rows: [listing] });

  await withStubbed(env.stubs, (g) => g.deliverOrder(g2gOrder(), { dryRun: false }));

  assert.deepStrictEqual(env.events, ["claim", "send", "markSold", "confirm"]);
  assert.deepStrictEqual(env.ncs.calls.markSold, [
    {
      ids: ["LED1"],
      opts: {
        market: "g2g",
        priceUsd: 4.2,
        orderId: "g-order-1",
        // The claim's own note, so a resume of this order still finds it.
        reason: "g2g order g-order-1",
      },
    },
  ]);
});

test("a refused G2G count still records the sale — the buyer has the account", async () => {
  // delivered_qty answers HTTP 500 to this client today. The hand-over is the
  // sale; the count is bookkeeping on G2G's side.
  const listing = noclaimRow();
  const env = makeEnv({ rows: [listing] });
  env.confirmError = new Error("G2G delivered qty failed: HTTP 500");

  const out = await withStubbed(env.stubs, (g) =>
    g.deliverOrder(g2gOrder({ currency: "EUR", amount: 3.9 }), { dryRun: false }),
  );

  assert.strictEqual(out.awaitingConfirm, true);
  assert.strictEqual(env.ncs.calls.markSold.length, 1);
  assert.strictEqual(env.ncs.calls.markSold[0].opts.priceUsd, 3.5, "not USD: the row's own price");
});

test("a failed send records no sale; chat being unavailable records none either", async () => {
  const listing = noclaimRow();
  const env = makeEnv({ rows: [listing] });
  env.sendError = new Error("socket hang up");

  const failed = await withStubbed(env.stubs, (g) =>
    g.deliverOrder(g2gOrder(), { dryRun: false }),
  );
  assert.strictEqual(failed.error, "chat send failed: socket hang up");
  assert.strictEqual(env.ncs.calls.markSold.length, 0);
  assert.strictEqual(listing.units.length, 1, "the unit stays reserved to THIS order");
  assert.strictEqual(listing.units[0].messagedAt, null);

  const listing2 = noclaimRow();
  const env2 = makeEnv({ rows: [listing2] });
  const unavailable = new Error("no SendBird SDK");
  unavailable.__g2gChatUnavailable = true;
  env2.sendError = unavailable;
  const parked = await withStubbed(env2.stubs, (g) =>
    g.deliverOrder(g2gOrder(), { dryRun: false }),
  );
  assert.strictEqual(parked.pending, 1);
  assert.strictEqual(env2.ncs.calls.markSold.length, 0, "the operator has not pasted it yet");
});

test("an operator hand-over confirmed on G2G records the sale — once", async () => {
  // Handed over by hand (no messagedAt): this is the first the ledger hears.
  const byHand = noclaimRow({ units: [reservedUnit()] });
  const env = makeEnv({ rows: [byHand] });
  const out = await withStubbed(env.stubs, (g) =>
    g.deliverOrder(g2gOrder({ deliveredQty: 1 }), { dryRun: false }),
  );
  assert.strictEqual(out.source, "confirmed-on-g2g");
  assert.deepStrictEqual(env.ncs.calls.markSold.map((c) => c.ids), [["LED1"]]);
  assert.strictEqual(env.ncs.calls.claimForSet.length, 0);

  // Sent by the bot earlier: that send already recorded it.
  const bySend = noclaimRow({ units: [reservedUnit({ messagedAt: new Date() })] });
  const env2 = makeEnv({ rows: [bySend] });
  await withStubbed(env2.stubs, (g) =>
    g.deliverOrder(g2gOrder({ deliveredQty: 1 }), { dryRun: false }),
  );
  assert.strictEqual(env2.ncs.calls.markSold.length, 0);
});

/* ------------------------------ 4. the retry ----------------------------- */

test("a retry RESUMES the same ledger, burns nothing new, and records the sale after the re-send", async () => {
  const listing = noclaimRow();
  const env = makeEnv({ rows: [listing], canSend: true });
  env.sendError = new Error("socket hang up");

  const second = await withStubbed(env.stubs, async (g, loaded) => {
    const first = await g.deliverOrder(g2gOrder(), { dryRun: false });
    assert.match(first.error, /chat send failed/);
    env.sendError = null; // chat recovers before the next tick
    const r = await g.deliverOrder(g2gOrder(), { dryRun: false });
    assertNeverTheArchive(env, loaded);
    return r;
  });

  assert.strictEqual(second.delivered, 1, second.error || second.detail);
  assert.strictEqual(second.source, "retry-send");
  // Both reads name the same listing + order, so the second is a resume.
  const [claim, resume] = env.ncs.calls.claimForSet;
  for (const k of ["market", "listingId", "orderId", "mode"]) {
    assert.strictEqual(resume.opts[k], claim.opts[k], k);
  }
  assert.strictEqual(resume.opts.mode, "sold");
  assert.ok(!resume.opts.dryRun);
  assert.strictEqual(resume.want, 1, "asks for exactly the reserved units");
  assert.deepStrictEqual(env.ncs.pool.map((a) => a.login), ["nc_two"], "no second account burned");
  assert.strictEqual(
    env.chat.sendToBuyer.calls[1][1],
    "Order g-order-1\n\nLogin: nc_one\nPassword: pw-one",
  );
  assert.deepStrictEqual(env.events, ["claim", "claim", "send", "markSold", "confirm"]);
  assert.deepStrictEqual(env.ncs.calls.markSold.map((c) => c.ids), [["LED1"]]);
});

test("a retry never ships an account the resume did not reserve", async () => {
  // The resume came back with a DIFFERENT ledger: the reserved one is gone, and
  // the operator may already have pasted its credential by hand.
  const listing = noclaimRow({ units: [reservedUnit()] });
  const env = makeEnv({
    rows: [listing],
    canSend: true,
    ncs: { claimImpl: async () => [{ ledgerId: "LED9", login: "stranger", password: "pw-9" }] },
  });

  const out = await withStubbed(env.stubs, async (g, loaded) => {
    const r = await g.deliverOrder(g2gOrder(), { dryRun: false });
    assertNeverTheArchive(env, loaded);
    return r;
  });

  assert.match(out.error, /1 reserved account\(s\) have no readable password/);
  assert.strictEqual(env.chat.sendToBuyer.calls.length, 0);
  assert.strictEqual(env.ncs.calls.markSold.length, 0);
});

test("a retry with delivery switched off says why, claims nothing and sends nothing", async () => {
  const listing = noclaimRow({ units: [reservedUnit()] });
  const order = g2gOrder();
  const env = makeEnv({
    rows: [listing],
    orders: [order],
    canSend: true,
    ncs: { enabled: false },
    af: { g2gAutoDeliver: true, g2gDeliverDryRun: false },
  });

  const out = await quietly(() =>
    withStubbed(env.stubs, (g) => g.deliverPendingOrders()),
  );

  assert.strictEqual(out.results[0].error, "no-claim listing auto-delivery is off");
  assert.strictEqual(env.ncs.calls.claimForSet.length, 0);
  assert.strictEqual(env.chat.sendToBuyer.calls.length, 0);
  assert.strictEqual(env.telegram.sendTelegram.calls.length, 1, "the owner is told, once");
});

/* ----------------------------- 5. stock sync ----------------------------- */

test("realStockFor counts a no-claim row through noclaimStock, never the archive", async () => {
  // The receipts of earlier sales sit in units[]; the units fallback would read
  // them as "nothing free", and the set branch would count archive stock.
  const listing = noclaimRow({ units: [reservedUnit({ deliveredAt: new Date() })] });
  const env = makeEnv({ rows: [listing], ncs: { stock: 3 } });

  const n = await withStubbed(env.stubs, (g) => g.realStockFor(listing, new Set()));

  assert.strictEqual(n, 3);
  assert.deepStrictEqual(env.ncs.calls.stockForListing, [listing]);
  assert.strictEqual(env.shop.availableAccountsForSet.calls.length, 0);
});

test("syncStock selects no-claim rows, pushes their count, and delists at zero", async () => {
  const live = noclaimRow({ externalId: "g-7" });
  const env = makeEnv({ rows: [live], ncs: { stock: 3 }, af: { g2gAuto: true, g2gDeliverDryRun: false } });

  const out = await withStubbed(env.stubs, (g) => g.syncStock());

  // The existing selection is byte-identical; no-claim rows come from their
  // own query, so they can never push existing rows past the shared limit.
  const q = env.queries[0];
  assert.deepStrictEqual(q.$or, [
    { origin: { $ne: "manual" } },
    { accountOffer: { $ne: null } },
  ], "every other row is selected exactly as before");
  assert.deepStrictEqual(env.queries[1], {
    marketplace: "g2g",
    status: "active",
    noclaimStock: true,
  }, "no-claim rows are ADDED by a separate query");
  assert.deepStrictEqual(env.mp.g2gSetQuantity.calls, [["g-7", 3]]);
  assert.deepStrictEqual(out.changes, [{ offer: "g-7", set: 3 }]);

  const empty = noclaimRow({ externalId: "g-8" });
  const env2 = makeEnv({ rows: [empty], ncs: { stock: 0 }, af: { g2gAuto: true, g2gDeliverDryRun: false } });
  await withStubbed(env2.stubs, (g) => g.syncStock());
  assert.deepStrictEqual(env2.mp.g2gDelist.calls, [["g-8"]]);
  assert.strictEqual(empty.autoPaused, true);
});

test("a failed no-claim count leaves the offer alone", async () => {
  // stockForListing throws on a DB error; pushing 0 would take a working
  // listing off sale.
  const listing = noclaimRow();
  const env = makeEnv({ rows: [listing], ncs: { stockThrows: true }, af: { g2gAuto: true, g2gDeliverDryRun: false } });

  const out = await withStubbed(env.stubs, async (g) => {
    await assert.rejects(g.realStockFor(listing, new Set()), /noclaim stock read failed/);
    return g.syncStock();
  });

  assert.deepStrictEqual(out.changes, []);
  assert.strictEqual(env.mp.g2gSetQuantity.calls.length, 0);
  assert.strictEqual(env.mp.g2gDelist.calls.length, 0);
});

/* --------------------------- everything else ----------------------------- */

test("an archive row never loads noclaimStock and ships as it did before", async () => {
  const listing = row({ autoClaimSet: true, set: "SET1", externalId: "g-8" });
  const env = makeEnv({ rows: [listing] });

  const out = await withStubbed(env.stubs, async (g, loaded) => {
    const r = await g.deliverOrder(g2gOrder({ orderItemId: "g-order-2", offerId: "g-8" }), {
      dryRun: false,
    });
    assert.ok(!loaded.has(stubPath("../utils/noclaimStock")), "noclaimStock must not load");
    return r;
  });

  assert.strictEqual(out.delivered, 1, out.error || out.detail);
  assert.strictEqual(
    env.chat.sendToBuyer.calls[0][1],
    "Order g-order-2\n\nLogin: archive_account\nPassword: arch-pw",
  );
  assert.strictEqual(env.eld.claimAccountsForSet.calls.length, 1);
  assert.strictEqual(env.ncs.calls.claimForSet.length, 0);
  assert.strictEqual(env.ncs.calls.markSold.length, 0);
});
