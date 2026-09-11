/* global fetch */
// No-claim Shop listings — the route half (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md
// §7). A DropSet with stockSource "noclaim" sells no-claim FARM accounts. The
// archive branches of POST /marketplaces/publish would claim Drop Archive stock
// for it instead, and every archive account holds CLAIMED drops — worthless to
// a buyer who paid for unclaimed ones. So this file pins down:
//
//   * publish: every market the no-claim layer supports is handed to
//     noclaimListings.publishNoclaim with the context it needs, and its answer
//     is that market's result as-is. The route itself makes no marketplace
//     call, no fulfiller claim and no row write.
//   * publish: every other market is refused with ncs.unsupportedMessage BEFORE
//     category resolution, so a refused market never costs a live lookup.
//   * delist: a no-claim row is settled first (beforeDelist), delisted on the
//     platform, resolved, and only then handed to afterDelist with the verdict
//     the route read ("delisted", "gone" or "sold"). A failed settle moves
//     nothing; a failed hand-back still answers the delist that happened.
//   * a set or row that is NOT no-claim takes exactly the path it took before.
//
// Mongo- and network-free: the real router is mounted in a throwaway express
// app behind a stub session, and everything the tested paths reach — two
// models, the marketplace client, the fulfillers, the category resolver, the
// cover builder, sale learning, the system log and both no-claim modules — is
// stubbed at require time through Module._load (the pattern of
// tests/manualSoldRemoval.test.js). The no-claim modules are matched by path
// BEFORE resolution, so this file runs whether or not they exist yet.
process.env.CRED_SECRET ||= "test-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const express = require("express");

// Real, pure helpers the stubs and assertions lean on. Required before the
// hook goes in, so these stay the real modules for everything but the router.
const realMp = require("../utils/marketplaces");
const realCategory = require("../utils/listingCategory");
const { listingGame } = require("../utils/listingGame");

const ROOT = path.join(__dirname, "..");
const ROUTER = require.resolve("../routes/marketplaceRoutes");
const at = (rel) => path.join(ROOT, rel);

// A cover the stub "builds" but never writes: the route's closing unlink of it
// fails quietly, and ctx.gridImage can be checked against it.
const GRID = path.join(
  os.tmpdir(),
  "noclaim-publish-route-" + process.pid + "-grid.png",
);
// What coverImagePath() answers for a set with no locally cached item image.
const DEFAULT_COVER = (() => {
  const p = path.join(ROOT, "public", "listing-default-cover.png");
  return fs.existsSync(p) ? p : "";
})();

// ---------------------------------------------------------------------------
// Recorders, reset before every test
// ---------------------------------------------------------------------------

let calls;
let behaviour;
test.beforeEach(() => {
  calls = {
    order: [], // the delist sequence, in the order it happened
    publishNoclaim: [],
    beforeDelist: [],
    afterDelist: [],
    ncsTouched: 0,
    resolveCategory: [],
    mp: [],
    gfAuto: [],
    paStock: [],
    release: [],
    create: [],
    events: [],
    sales: [],
  };
  behaviour = {
    publish: {}, // market -> publishNoclaim's answer (default: a success)
    publishThrows: {}, // market -> Error publishNoclaim throws
    categoryFail: {}, // market -> the resolver's refusal reason
    delistErrors: {}, // mp delist function name -> Error it throws
    beforeDelistError: null,
    afterDelistError: null,
    afterDelist: { released: 0, sold: 0 },
    paStock: 0,
  };
});

// ---------------------------------------------------------------------------
// The no-claim layer (contract §3 constants, §4 hooks)
// ---------------------------------------------------------------------------

const VAULT = ["gameflip", "ggsel", "digiseller"];
const CLAIM_AT_SALE = ["eldorado", "playerauctions", "g2g"];
const LABELS = {
  gameflip: "Gameflip",
  digiseller: "Plati",
  ggsel: "GGSel",
  eldorado: "Eldorado",
  playerauctions: "PlayerAuctions",
  g2g: "G2G",
  funpay: "FunPay",
  zeusx: "ZeusX",
  epicnpc: "EpicNPC",
  z2u: "Z2U",
};
const unsupported = (m) =>
  (LABELS[m] || m) +
  " is not supported for no-claim listings yet — use Gameflip, GGSel, Plati, " +
  "Eldorado, PlayerAuctions or G2G";

const ncsStub = {
  VAULT_MARKETS: VAULT,
  CLAIM_AT_SALE_MARKETS: CLAIM_AT_SALE,
  MARKET_LABELS: LABELS,
  // Every consultation is counted, so an archive publish can prove it never
  // asked the no-claim layer anything.
  get SUPPORTED_MARKETS() {
    calls.ncsTouched += 1;
    return [...VAULT, ...CLAIM_AT_SALE];
  },
  unsupportedMessage(market) {
    calls.ncsTouched += 1;
    return unsupported(market);
  },
};

const noclaimListingsStub = {
  async publishNoclaim(name, ctx) {
    calls.publishNoclaim.push({ name, ctx });
    if (behaviour.publishThrows[name]) throw behaviour.publishThrows[name];
    return (
      behaviour.publish[name] || {
        success: true,
        id: "nc-row-" + name,
        externalId: "nc-" + name,
        url: "https://" + name + ".example/nc",
        note: "no-claim auto-delivery",
      }
    );
  },
  async beforeDelist(row) {
    calls.order.push("beforeDelist");
    calls.beforeDelist.push(row);
    if (behaviour.beforeDelistError) throw behaviour.beforeDelistError;
    return { sold: 0 };
  },
  async afterDelist(row, opts) {
    calls.order.push("afterDelist:" + (opts && opts.outcome));
    calls.afterDelist.push({ row, status: row.status, opts });
    if (behaviour.afterDelistError) throw behaviour.afterDelistError;
    return behaviour.afterDelist;
  },
};

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const sets = new Map();
const rows = new Map();
let listRows = [];

const DropSetStub = {
  findById: (id) => ({ lean: async () => sets.get(String(id)) || null }),
};

const MarketplaceListingStub = {
  findById: async (id) => rows.get(String(id)) || null,
  find: () => {
    const chain = {
      sort: () => chain,
      limit: () => chain,
      lean: async () => listRows,
    };
    return chain;
  },
  async create(doc) {
    calls.create.push(doc);
    return { _id: "created-" + calls.create.length, ...doc };
  },
};

let rowSeq = 0;
// A hydrated-document stand-in for the DELETE route: plain fields plus a
// save() that records the status it persisted, in sequence with the rest.
function fakeRow(fields) {
  rowSeq += 1;
  const row = {
    _id: "row-" + rowSeq,
    status: "active",
    note: "",
    lastError: "",
    price: 9,
    units: [],
    ...fields,
    async save() {
      calls.order.push("save:" + this.status);
    },
  };
  rows.set(row._id, row);
  return row;
}

// ---------------------------------------------------------------------------
// Marketplace client, fulfillers and the rest of what the router reaches
// ---------------------------------------------------------------------------

function publisher(fn, answer) {
  return async (args) => {
    calls.mp.push({ fn, args });
    return { ...answer };
  };
}

function delister(fn) {
  return async (...args) => {
    calls.mp.push({ fn, args });
    calls.order.push("mp." + fn);
    if (behaviour.delistErrors[fn]) throw behaviour.delistErrors[fn];
  };
}

const mpStub = {
  // Real: the delist verdict under test is the one delistOutcome computes.
  delistOutcome: realMp.delistOutcome,
  PA_MIN_PRICE: realMp.PA_MIN_PRICE,
  PA_DELIVERY: realMp.PA_DELIVERY,
  gameflipPublish: publisher("gameflipPublish", { externalId: "gf-1" }),
  ggselPublish: publisher("ggselPublish", { externalId: "gg-1" }),
  digisellerPublish: publisher("digisellerPublish", { externalId: "ds-1" }),
  eldoradoPublish: publisher("eldoradoPublish", { externalId: "el-1" }),
  playerauctionsPublish: publisher("playerauctionsPublish", {
    offerId: "pa-1",
  }),
  g2gPublish: publisher("g2gPublish", { externalId: "g2g-1" }),
  funpayPublish: publisher("funpayPublish", {
    externalId: "fp-1",
    externalNode: "1234",
  }),
  zeusxPublish: publisher("zeusxPublish", { externalId: "zx-1" }),
  gameflipDelist: delister("gameflipDelist"),
  ggselDelist: delister("ggselDelist"),
  digisellerDelist: delister("digisellerDelist"),
  eldoradoDelist: delister("eldoradoDelist"),
  playerauctionsDelist: delister("playerauctionsDelist"),
  g2gDelist: delister("g2gDelist"),
  funpayDelist: delister("funpayDelist"),
  zeusxDelist: delister("zeusxDelist"),
  z2uDelist: delister("z2uDelist"),
};

// An archive claim reached from a no-claim publish is the very failure this
// file exists for, so every archive claim refuses loudly.
const noArchiveClaim = async () => {
  throw new Error("archive claim reached");
};
function releaser(market) {
  return async (...args) => {
    calls.order.push("release:" + market);
    calls.release.push([market, ...args]);
  };
}

const gfStub = {
  async publishAutoDelivery(opts) {
    calls.gfAuto.push(opts);
    return { _id: "gf-row-1", externalId: "gf-auto-1", url: "", note: "" };
  },
  releaseAccount: releaser("gameflip"),
};
const ggStub = {
  claimAccountsForSet: noArchiveClaim,
  releaseAccounts: releaser("ggsel"),
};
const dsStub = {
  claimAccountsForSet: noArchiveClaim,
  releaseAccounts: releaser("digiseller"),
};
const fpStub = {
  claimAccountsForSet: noArchiveClaim,
  releaseAccounts: releaser("funpay"),
  funpayDeliveryLine: (login, pw) => login + ":" + pw,
  funpayPaymentGuide: () => "",
};
// Required lazily by the PlayerAuctions branch, mid-request.
const paStub = {
  async stockFor(listing) {
    calls.paStock.push(listing);
    return behaviour.paStock;
  },
};

// What the resolver "finds" when the body carries no category of its own.
const CATS = {
  ggsel: { categoryId: "gg-auto" },
  digiseller: { categories: [{ owner: 1, categoryId: "34187", attributes: [] }] },
  g2g: { serviceId: "svc-auto", brandId: "brand-auto" },
  funpay: { node: "fp-auto" },
};
const categoryStub = {
  MARKETS_NEEDING_CATEGORY: realCategory.MARKETS_NEEDING_CATEGORY,
  async resolveCategory(name, game) {
    calls.resolveCategory.push([name, game]);
    const reason = behaviour.categoryFail[name];
    if (reason) return { ok: false, reason };
    return { ok: true, value: CATS[name] || {} };
  },
};

// ---------------------------------------------------------------------------
// The require-time hook and the app
// ---------------------------------------------------------------------------

// Matched for ANY requirer: a half-written sibling must never be loaded here.
const GLOBAL_STUBS = new Map([
  [at("utils/noclaimListings"), noclaimListingsStub],
  [at("utils/noclaimStock"), ncsStub],
]);
// Matched only for the router's own requires, so the real modules it loads
// keep their real dependencies.
const ROUTER_STUBS = new Map([
  [at("models/DropSet"), DropSetStub],
  [at("models/MarketplaceListing"), MarketplaceListingStub],
  [at("utils/marketplaces"), mpStub],
  [at("utils/gameflipFulfiller"), gfStub],
  [at("utils/ggselFulfiller"), ggStub],
  [at("utils/digisellerFulfiller"), dsStub],
  [at("utils/funpayFulfiller"), fpStub],
  [at("utils/playerauctionsFulfiller"), paStub],
  [at("utils/listingCategory"), categoryStub],
  [
    at("utils/setImage"),
    { buildSetGridImage: async () => GRID, buildPromoCoverImage: async () => GRID },
  ],
  [
    at("utils/saleLearning"),
    {
      recordListingSale: async (x) => {
        calls.sales.push(x);
      },
    },
  ],
  [
    at("utils/systemLog"),
    {
      logEvent: (e) => {
        calls.events.push(e);
      },
      actorFromReq: () => "test",
    },
  ],
]);

const realLoad = Module._load;
Module._load = function (request, parent, _isMain) {
  if (parent && parent.filename && request.startsWith(".")) {
    const target = path
      .resolve(path.dirname(parent.filename), request)
      .replace(/\.js$/, "");
    if (GLOBAL_STUBS.has(target)) return GLOBAL_STUBS.get(target);
    if (parent.filename === ROUTER && ROUTER_STUBS.has(target)) {
      return ROUTER_STUBS.get(target);
    }
  }
  return realLoad.apply(this, arguments);
};

let server;
let baseUrl;

test.before(async () => {
  const app = express();
  app.use(express.json());
  // Stub session: exactly what requireSuperadmin reads.
  app.use((req, _res, next) => {
    req.session = { admin: { id: "root", username: "root", role: "superadmin" } };
    next();
  });
  app.use(require("../routes/marketplaceRoutes"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;
});

test.after(async () => {
  Module._load = realLoad;
  if (server) await new Promise((r) => server.close(r));
});

async function publish(body) {
  const res = await fetch(baseUrl + "/marketplaces/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.equal(json.success, true);
  return json.results;
}

async function delist(id) {
  const res = await fetch(baseUrl + "/marketplaces/listings/" + id, {
    method: "DELETE",
  });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  return json;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NC_SET = {
  _id: "ncset1",
  name: "Overwatch 2 no-claim bundle",
  stockSource: "noclaim",
  price: 9,
  listed: false,
  items: [
    {
      itemKey: "legendary skin|overwatch 2",
      name: "Legendary Skin",
      game: "Overwatch 2",
      qty: 1,
    },
  ],
};
const ARCHIVE_SET = {
  _id: "arch1",
  name: "Rocket League bundle",
  price: 12,
  items: [
    {
      itemKey: "octane decal|rocket league",
      name: "Octane Decal",
      game: "Rocket League",
      qty: 1,
    },
  ],
};
sets.set(NC_SET._id, NC_SET);
sets.set(ARCHIVE_SET._id, ARCHIVE_SET);

const ALL_SUPPORTED = [...VAULT, ...CLAIM_AT_SALE];

// ---------------------------------------------------------------------------
// Publish — a no-claim set
// ---------------------------------------------------------------------------

test("publish: every supported market of a no-claim set is handed to publishNoclaim, whose answer is the result", async () => {
  // Options that WOULD send each market down its archive branch (auto-delivery
  // claims, a relist chain) if the no-claim branch did not take it first.
  const body = {
    setId: NC_SET._id,
    marketplaces: ALL_SUPPORTED,
    title: "OW2 Legendary Skin — unclaimed",
    description: "Unclaimed Overwatch 2 drop, instant delivery",
    price: 11,
    game: "Overwatch 2",
    gameflip: { autoDeliver: true, qty: 3 },
    ggsel: { delivery: "auto", quantity: 2 },
    digiseller: { delivery: "auto", quantity: 2 },
    eldorado: { quantity: 4 },
    playerauctions: { quantity: 2 },
    g2g: { qty: 1 },
  };
  // A refusal from the layer is passed through as-is too.
  behaviour.publish.eldorado = {
    success: false,
    message:
      "Out of stock — no free no-claim account holds this whole bundle right now",
  };

  const results = await publish(body);

  assert.deepEqual(
    calls.publishNoclaim.map((c) => c.name),
    ALL_SUPPORTED,
    "one delegation per market, in the order asked",
  );
  for (const name of ALL_SUPPORTED) {
    const expected = behaviour.publish[name] || {
      success: true,
      id: "nc-row-" + name,
      externalId: "nc-" + name,
      url: "https://" + name + ".example/nc",
      note: "no-claim auto-delivery",
    };
    assert.deepEqual(results[name], expected, name + ": the layer's answer, verbatim");
  }

  const pubGame = listingGame({ set: NC_SET, offer: null, game: body.game });
  for (const { name, ctx } of calls.publishNoclaim) {
    assert.deepEqual(
      Object.keys(ctx).sort(),
      [
        "body",
        "cat",
        "coverPath",
        "description",
        "gridImage",
        "priceUsd",
        "pubGame",
        "set",
        "title",
      ],
      name + ": exactly the contract's context",
    );
    assert.equal(ctx.set, NC_SET, name + ": the loaded set itself");
    assert.deepEqual(ctx.body, body, name + ": the whole request body");
    assert.equal(ctx.title, body.title);
    assert.equal(ctx.description, body.description);
    assert.equal(ctx.priceUsd, 11);
    assert.equal(ctx.gridImage, GRID, name + ": the cover built for this publish");
    assert.equal(ctx.coverPath, DEFAULT_COVER);
    assert.equal(ctx.pubGame, pubGame);
    // `cat` is whatever category resolution answered for this market ({} when
    // the market needs none).
    assert.deepEqual(ctx.cat, CATS[name] || {}, name + ": the resolved category");
  }
  assert.deepEqual(
    calls.resolveCategory,
    [
      ["ggsel", pubGame],
      ["digiseller", pubGame],
      ["g2g", pubGame],
    ],
    "category resolution still runs first for the markets that need one",
  );

  // Nothing of the archive paths ran: no marketplace call from the route, no
  // Gameflip relist chain, no archive stock count, no row written here.
  assert.deepEqual(calls.mp, []);
  assert.deepEqual(calls.gfAuto, []);
  assert.deepEqual(calls.paStock, []);
  assert.deepEqual(calls.create, []);
});

test("publish: a hand-picked category reaches the layer in the body, and a failed resolution stays that market's failure", async () => {
  behaviour.categoryFail.digiseller = "No Plati category is mapped for Overwatch 2";

  const results = await publish({
    setId: NC_SET._id,
    marketplaces: ["ggsel", "digiseller"],
    price: 9,
    ggsel: { categoryId: "777", quantity: 1 },
  });

  assert.deepEqual(results.digiseller, {
    success: false,
    message: "No Plati category is mapped for Overwatch 2",
  });
  assert.equal(results.ggsel.success, true);
  // GGSel's pick is the owner's: no lookup, an empty resolved category, and the
  // pick itself in the body for the layer to use.
  assert.deepEqual(
    calls.resolveCategory.map(([name]) => name),
    ["digiseller"],
  );
  assert.deepEqual(
    calls.publishNoclaim.map((c) => c.name),
    ["ggsel"],
  );
  assert.deepEqual(calls.publishNoclaim[0].ctx.cat, {});
  assert.equal(calls.publishNoclaim[0].ctx.body.ggsel.categoryId, "777");
});

test("publish: markets the no-claim layer cannot deliver on are refused before any category lookup", async () => {
  const refused = ["funpay", "zeusx", "z2u", "epicnpc"];

  // FunPay carries no node id, so it WOULD cost a live category lookup if the
  // refusal did not come first.
  const results = await publish({
    setId: NC_SET._id,
    marketplaces: [...refused, "gameflip"],
    price: 9,
    funpay: { delivery: "auto", amount: 2 },
    zeusx: { quantity: 1 },
  });

  for (const name of refused) {
    assert.deepEqual(
      results[name],
      { success: false, message: unsupported(name) },
      name + ": refused with the layer's own message",
    );
  }
  assert.equal(
    results.funpay.message,
    "FunPay is not supported for no-claim listings yet — use Gameflip, GGSel, " +
      "Plati, Eldorado, PlayerAuctions or G2G",
  );
  assert.deepEqual(calls.resolveCategory, [], "no lookup for a refused market");
  assert.deepEqual(
    calls.publishNoclaim.map((c) => c.name),
    ["gameflip"],
    "a supported market in the same publish still goes out",
  );
  assert.equal(results.gameflip.success, true);
  assert.deepEqual(calls.mp, []);
  assert.deepEqual(calls.create, []);
  // Z2U's own refusal (and its warning event) belongs to archive publishes.
  assert.equal(
    calls.events.some((e) => e.action === "z2u-publish-refused"),
    false,
  );
});

test("publish: a layer that throws fails only its own market; the loop goes on", async () => {
  behaviour.publishThrows.ggsel = new Error("GGSel refused the offer");

  const results = await publish({
    setId: NC_SET._id,
    marketplaces: ["ggsel", "eldorado"],
    price: 9,
    ggsel: { categoryId: "777" },
  });

  assert.deepEqual(results.ggsel, {
    success: false,
    message: "GGSel refused the offer",
  });
  assert.equal(results.eldorado.success, true);
  assert.deepEqual(
    calls.publishNoclaim.map((c) => c.name),
    ["ggsel", "eldorado"],
  );
});

// ---------------------------------------------------------------------------
// Publish — a set that is NOT no-claim
// ---------------------------------------------------------------------------

test("publish: an archive set takes exactly the old paths and never consults the no-claim layer", async () => {
  behaviour.paStock = 5;
  const body = {
    setId: ARCHIVE_SET._id,
    marketplaces: [
      "gameflip",
      "ggsel",
      "digiseller",
      "eldorado",
      "playerauctions",
      "g2g",
      "funpay",
      "zeusx",
    ],
    title: "Rocket League bundle",
    description: "Instant delivery",
    price: 12,
    game: "Rocket League",
    gameflip: { autoDeliver: true, qty: 2 },
    // Every category by hand, so the resolver is never asked.
    ggsel: { categoryId: "999" },
    digiseller: { categories: [{ owner: 1, categoryId: "34187", attributes: [] }] },
    eldorado: { quantity: 3 },
    playerauctions: { quantity: 2, game: "Rocket League" },
    g2g: { serviceId: "svc", brandId: "brand", productId: "prod" },
    funpay: { nodeId: "1234" },
    zeusx: { quantity: 1 },
  };

  const results = await publish(body);

  for (const name of body.marketplaces) {
    assert.equal(results[name].success, true, name + ": " + results[name].message);
  }
  assert.equal(calls.ncsTouched, 0, "the no-claim layer is not even asked");
  assert.deepEqual(calls.publishNoclaim, []);
  assert.deepEqual(calls.resolveCategory, []);

  // Gameflip auto-delivery: the relist chain gets exactly the options it
  // always got — no `noclaim` flag.
  assert.equal(calls.gfAuto.length, 1);
  const gf = calls.gfAuto[0];
  assert.deepEqual(Object.keys(gf), [
    "set",
    "offer",
    "title",
    "description",
    "priceUsd",
    "imagePath",
    "qtyRemaining",
    "origin",
  ]);
  assert.equal(gf.set, ARCHIVE_SET);
  assert.equal(gf.offer, null);
  assert.equal(gf.qtyRemaining, 1);
  assert.equal(gf.origin, "manual");
  assert.equal(gf.imagePath, GRID);

  assert.deepEqual(
    calls.mp.map((c) => c.fn),
    [
      "ggselPublish",
      "digisellerPublish",
      "eldoradoPublish",
      "playerauctionsPublish",
      "g2gPublish",
      "funpayPublish",
      "zeusxPublish",
    ],
  );
  const byFn = Object.fromEntries(calls.mp.map((c) => [c.fn, c.args]));
  assert.equal(byFn.ggselPublish.categoryId, "999");
  assert.equal(byFn.eldoradoPublish.quantity, 3);
  assert.equal(byFn.playerauctionsPublish.totalUnit, 2);
  assert.equal(byFn.g2gPublish.brandId, "brand");
  assert.equal(byFn.funpayPublish.nodeId, "1234");
  assert.equal(byFn.funpayPublish.autoDelivery, false);

  // The archive's own stock count still gates PlayerAuctions.
  assert.deepEqual(calls.paStock, [{ autoClaimSet: true, set: ARCHIVE_SET._id }]);

  // Rows written by the route itself, none of them a no-claim row.
  assert.deepEqual(
    calls.create.map((d) => d.marketplace),
    ["ggsel", "digiseller", "eldorado", "playerauctions", "g2g", "funpay", "zeusx"],
  );
  for (const doc of calls.create) {
    assert.equal(doc.set, ARCHIVE_SET._id);
    assert.equal("noclaimStock" in doc, false, doc.marketplace);
  }
  assert.equal(
    calls.create.find((d) => d.marketplace === "playerauctions").autoClaimSet,
    true,
  );
});

// ---------------------------------------------------------------------------
// GET /marketplaces/listings
// ---------------------------------------------------------------------------

test("listings: each row says whether the no-claim farm stocks it, and nothing else changes", async () => {
  const createdAt = new Date("2026-09-11T00:00:00Z");
  listRows = [
    {
      _id: "r1",
      set: NC_SET._id,
      marketplace: "ggsel",
      externalId: "gg-nc",
      status: "active",
      origin: "manual",
      noclaimStock: true,
      createdAt,
    },
    // Every field filled: JSON drops undefined keys, and the key list below is
    // the row shape the page reads.
    {
      _id: "r2",
      set: ARCHIVE_SET._id,
      marketplace: "gameflip",
      externalId: "gf-arch",
      url: "https://gameflip.com/item/gf-arch",
      title: "Rocket League bundle",
      price: 12,
      currency: "USD",
      status: "active",
      note: "",
      lastError: "",
      autoDeliver: true,
      qtyRemaining: 1,
      origin: "auto",
      createdAt,
    },
    { _id: "r3", marketplace: "eldorado", noclaimStock: false, createdAt },
  ];

  const res = await fetch(baseUrl + "/marketplaces/listings");
  const json = await res.json();

  assert.equal(json.success, true);
  assert.deepEqual(
    json.listings.map((l) => l.noclaimStock),
    [true, false, false],
  );
  assert.deepEqual(Object.keys(json.listings[1]), [
    "id",
    "setId",
    "offerId",
    "marketplace",
    "externalId",
    "url",
    "title",
    "price",
    "currency",
    "status",
    "note",
    "lastError",
    "autoDeliver",
    "qtyRemaining",
    "origin",
    "noclaimStock",
    "createdAt",
  ]);
  assert.equal(json.listings[0].setId, NC_SET._id);
  assert.equal(json.listings[1].origin, "auto");
  listRows = [];
});

// ---------------------------------------------------------------------------
// DELETE /marketplaces/listings/:id — a no-claim row
// ---------------------------------------------------------------------------

function noclaimRow(fields) {
  return fakeRow({
    set: NC_SET._id,
    noclaimStock: true,
    origin: "manual",
    autoDeliver: false,
    accountId: "",
    accountLogin: "",
    ...fields,
  });
}

test("delist: a no-claim vault row is settled, delisted, resolved, then handed back — in that order", async () => {
  const row = noclaimRow({
    marketplace: "ggsel",
    externalId: "gg-nc-1",
    units: [
      { login: "nc_one", contentId: "", deliveredAt: null, orderId: "" },
      { login: "nc_two", contentId: "", deliveredAt: null, orderId: "" },
    ],
  });
  behaviour.afterDelist = { released: 2, sold: 1 };

  const json = await delist(row._id);

  assert.deepEqual(json, { success: true, noclaim: { released: 2, sold: 1 } });
  assert.deepEqual(calls.order, [
    "beforeDelist",
    "mp.ggselDelist",
    "save:delisted",
    "afterDelist:delisted",
  ]);
  assert.equal(calls.beforeDelist[0], row, "the loaded row itself");
  assert.equal(calls.afterDelist[0].row, row);
  assert.deepEqual(calls.afterDelist[0].opts, { outcome: "delisted" });
  assert.equal(calls.afterDelist[0].status, "delisted", "resolved before the hand-back");
  // Neither archive release can reach a no-claim row.
  assert.deepEqual(calls.release, []);
});

test("delist: a Gameflip unit that already sold is resolved as sold and handed over as sold, never released", async () => {
  const row = noclaimRow({
    marketplace: "gameflip",
    externalId: "gf-nc-1",
    autoDeliver: true,
    accountLogin: "nc_gf",
    units: [{ login: "nc_gf", contentId: "", deliveredAt: null, orderId: "" }],
  });
  behaviour.delistErrors.gameflipDelist = new Error(
    "Gameflip delist: listing is not editable (sold)",
  );
  behaviour.afterDelist = { released: 0, sold: 1 };

  const json = await delist(row._id);

  assert.deepEqual(json, {
    success: true,
    message: "Already sold on the marketplace — marked sold here",
    noclaim: { released: 0, sold: 1 },
  });
  assert.deepEqual(calls.order, [
    "beforeDelist",
    "mp.gameflipDelist",
    "save:sold",
    "afterDelist:sold",
  ]);
  assert.equal(row.status, "sold");
  assert.deepEqual(calls.release, [], "no Gameflip archive release either");
});

test("delist: an offer already gone is handed back with the verdict the route read", async () => {
  const row = noclaimRow({ marketplace: "eldorado", externalId: "el-nc-1" });
  behaviour.delistErrors.eldoradoDelist = new Error(
    "Eldorado delist: To pause an offer it must be active",
  );

  const json = await delist(row._id);

  assert.deepEqual(json, { success: true, noclaim: { released: 0, sold: 0 } });
  assert.deepEqual(calls.order, [
    "beforeDelist",
    "mp.eldoradoDelist",
    "save:delisted",
    "afterDelist:gone",
  ]);
  assert.match(row.note, /gone from the marketplace/);
});

test("delist: a delist the platform refused hands nothing back", async () => {
  const row = noclaimRow({ marketplace: "digiseller", externalId: "ds-nc-1" });
  behaviour.delistErrors.digisellerDelist = new Error(
    "Digiseller delist: Request failed with status code 500",
  );

  const json = await delist(row._id);

  assert.equal(json.success, false);
  assert.match(json.message, /status code 500/);
  assert.equal("noclaim" in json, false);
  assert.deepEqual(calls.order, [
    "beforeDelist",
    "mp.digisellerDelist",
    "save:active",
  ]);
  assert.deepEqual(calls.afterDelist, [], "still on sale, so its units stay");
  assert.equal(row.status, "active");
});

test("delist: a failed settle refuses the delist before the platform is touched", async () => {
  const row = noclaimRow({ marketplace: "ggsel", externalId: "gg-nc-2" });
  behaviour.beforeDelistError = new Error("stock read exploded");

  const json = await delist(row._id);

  assert.equal(json.success, false);
  assert.match(json.message, /^Not delisted/);
  assert.match(json.message, /stock read exploded/);
  assert.deepEqual(calls.order, ["beforeDelist"], "nothing moved at all");
  assert.deepEqual(calls.mp, []);
  assert.equal(row.status, "active");
});

test("delist: a failed hand-back still answers the delist that happened, and is logged", async () => {
  const row = noclaimRow({ marketplace: "ggsel", externalId: "gg-nc-3" });
  behaviour.afterDelistError = new Error("ledger write failed");

  const json = await delist(row._id);

  assert.deepEqual(json, {
    success: true,
    noclaim: { released: 0, sold: 0, error: "ledger write failed" },
  });
  assert.equal(row.status, "delisted");
  const ev = calls.events.find((e) => e.category === "noclaim_shop");
  assert.ok(ev, "a warning the owner can find later");
  assert.equal(ev.action, "delist-release-failed");
  assert.equal(ev.severity, "warn");
  assert.equal(ev.subject, row._id);
  assert.match(ev.detail, /ledger write failed/);
});

// ---------------------------------------------------------------------------
// DELETE — a row that is NOT no-claim
// ---------------------------------------------------------------------------

test("delist: an archive row is delisted exactly as before, and the no-claim hooks never run", async () => {
  const gg = fakeRow({
    set: ARCHIVE_SET._id,
    marketplace: "ggsel",
    externalId: "gg-arch-1",
    autoDeliver: true,
    accountId: "acct-1,acct-2",
  });
  let json = await delist(gg._id);
  assert.deepEqual(json, { success: true }, "byte-identical answer");
  assert.deepEqual(calls.order, [
    "mp.ggselDelist",
    "save:delisted",
    "release:ggsel",
  ]);
  assert.deepEqual(calls.release, [["ggsel", ["acct-1", "acct-2"]]]);

  // Sold on Gameflip: marked sold, the sale learned, nothing released.
  calls.order.length = 0;
  calls.release.length = 0;
  const gfSold = fakeRow({
    set: ARCHIVE_SET._id,
    marketplace: "gameflip",
    externalId: "gf-arch-1",
    autoDeliver: true,
    accountId: "acct-9",
  });
  behaviour.delistErrors.gameflipDelist = new Error("Gameflip: already sold");
  json = await delist(gfSold._id);
  assert.deepEqual(json, {
    success: true,
    message: "Already sold on the marketplace — marked sold here",
  });
  assert.deepEqual(calls.order, ["mp.gameflipDelist", "save:sold"]);
  assert.equal(calls.sales.length, 1);
  assert.equal(calls.sales[0].set, ARCHIVE_SET);

  // Gone from Gameflip: the reserved archive account comes back, set-scoped.
  calls.order.length = 0;
  const gfGone = fakeRow({
    set: ARCHIVE_SET._id,
    marketplace: "gameflip",
    externalId: "gf-arch-2",
    autoDeliver: true,
    accountId: "acct-7",
  });
  behaviour.delistErrors.gameflipDelist = new Error("Gameflip: not found");
  json = await delist(gfGone._id);
  assert.deepEqual(json, { success: true });
  assert.deepEqual(calls.order, [
    "mp.gameflipDelist",
    "save:delisted",
    "release:gameflip",
  ]);
  assert.deepEqual(calls.release, [["gameflip", "acct-7", ARCHIVE_SET._id]]);

  assert.deepEqual(calls.beforeDelist, []);
  assert.deepEqual(calls.afterDelist, []);
});
