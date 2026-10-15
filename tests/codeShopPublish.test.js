// Code shop publisher (docs/code-shop/03-MARKETS.md, publish.js).
//
// This module creates REAL marketplace offers in production, so the tests pin
// the failure paths as hard as the happy ones: a live offer must never be left
// without its listing row, a GGSel vault that may hold our codes must leave
// those codes held, and nothing may ever reach Gameflip or Plati/Digiseller.
//
// Real Mongo (mongodb-memory-server) for the models; every marketplace, the
// stock layer, the category resolver, the cover, units, fill and Telegram are
// fakes. The marketplace fake is a Proxy that records every member read, so a
// test can prove no blocked market was even looked up. All values are made up.
process.env.CRED_SECRET ||= "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const CodeProduct = require("../models/CodeProduct");
const CodeStock = require("../models/CodeStock");
const AccountOffer = require("../models/AccountOffer");
const MarketplaceListing = require("../models/MarketplaceListing");

const { createPublisher, ALLOWED_MARKETS, ELDORADO_MIN_USD, OFFER_LIMIT_MSG, HELD_IN_VAULT } = require("../utils/codeShop/publish");
const { DEFAULTS, deepMerge } = require("../utils/codeShop/config");
const { guideFor } = require("../utils/codeShop/games");
const { defaultTexts } = require("../utils/codeShop/texts");

const NOW = Date.parse("2026-10-15T12:00:00Z");
const BLOCKED = /gameflip|digiseller|plati/i;

let mem;
let tmpDir;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshoppublish"));
  await Promise.all([CodeProduct, CodeStock, AccountOffer, MarketplaceListing].map((m) => m.init()));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeshop-publish-"));
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test.beforeEach(async () => {
  await Promise.all([CodeProduct, CodeStock, AccountOffer, MarketplaceListing].map((m) => m.deleteMany({})));
});

// --- fakes ---------------------------------------------------------------------

let seq = 0;

function harness(opts = {}) {
  const calls = [];
  const sent = [];
  const events = [];
  const touched = new Set();
  const covers = [];
  const state = {
    shelf: opts.shelf ?? 4,
    takesNewStock: opts.takesNewStock ?? true,
    category: opts.category || { ok: true, value: { categoryId: 4242 }, reason: "" },
    claimed: opts.claimed || null,
  };

  const mpImpl = {
    async eldoradoPublish(args) {
      calls.push(["eldoradoPublish", args]);
      assert.ok(fs.existsSync(args.coverImagePath), "the cover exists while Eldorado reads it");
      if (opts.eldoradoGate) await opts.eldoradoGate(args);
      if (opts.eldoradoPublishError) throw opts.eldoradoPublishError;
      return { externalId: "eld-" + ++seq, url: "https://eldorado.example.test/o/" + seq };
    },
    async eldoradoDelist(id) {
      calls.push(["eldoradoDelist", id]);
      if (opts.eldoradoDelistError) throw opts.eldoradoDelistError;
    },
    async ggselPublish(args) {
      calls.push(["ggselPublish", args]);
      if (opts.ggselPublishError) throw opts.ggselPublishError;
      return { externalId: String(900000 + ++seq), url: "https://ggsel.example.test/" + seq };
    },
    async ggselDelist(id) {
      calls.push(["ggselDelist", id]);
    },
    ggselTakesNewStock() {
      calls.push(["ggselTakesNewStock"]);
      return state.takesNewStock;
    },
    delistOutcome(message) {
      const m = String(message || "").toLowerCase();
      if (/already sold/.test(m)) return "sold";
      if (/not found|must be active/.test(m)) return "gone";
      return "";
    },
  };
  const mp = new Proxy(mpImpl, {
    get(target, key) {
      if (typeof key === "string") touched.add(key);
      if (typeof key === "string" && BLOCKED.test(key)) {
        return () => {
          throw new Error("blocked market touched: " + key);
        };
      }
      return target[key];
    },
  });

  const stock = {
    async shelfFor(offer) {
      calls.push(["shelfFor", String(offer)]);
      return state.shelf;
    },
    async claimForListing(offer, want, o) {
      calls.push(["claimForListing", String(offer), want, o]);
      const pool = state.claimed || [];
      return pool.slice(0, want);
    },
    async releaseClaim(ids) {
      calls.push(["releaseClaim", ids.map(String)]);
      return ids.length;
    },
    async markFed(ids, o) {
      calls.push(["markFed", ids.map(String), o]);
      if (opts.markFedError) throw opts.markFedError;
      return ids.length;
    },
    deliveryText(c, offer) {
      return String(offer.deliveryTemplate || "").replace("{password}", c.password);
    },
  };

  const category = {
    async resolveCategory(market, game) {
      calls.push(["resolveCategory", market, game]);
      return state.category;
    },
  };

  const cover = {
    async build(product) {
      calls.push(["coverBuild", String(product._id)]);
      if (opts.coverError) throw opts.coverError;
      const file = path.join(tmpDir, "cover-" + ++seq + ".png");
      fs.writeFileSync(file, "png");
      covers.push(file);
      return file;
    },
  };

  const units = {
    async dissolve(product, o) {
      calls.push(["dissolve", String(product._id), o]);
      return { dissolved: 2 };
    },
  };

  const fill = {
    async run(o) {
      calls.push(["fillRun", o]);
      return { built: 3, failed: 0, byProduct: opts.byProduct || {} };
    },
  };

  const cfg = deepMerge(DEFAULTS, { markets: { eldorado: true, ggsel: true }, ...(opts.config || {}) });

  const deps = {
    models: { CodeProduct, CodeStock, AccountOffer, MarketplaceListing: opts.MarketplaceListing || MarketplaceListing },
    mp: () => mp,
    stock: () => stock,
    category: () => category,
    setImage: () => {
      throw new Error("setImage must not be used: the cover is faked");
    },
    cover,
    units,
    fill,
    config: { get: async () => cfg },
    events: { log: async (e) => events.push(e) },
    telegram: { send: async (t) => sent.push(t) },
    now: () => NOW,
    guideFor,
  };
  return {
    deps,
    pub: createPublisher(deps),
    calls,
    sent,
    events,
    touched,
    covers,
    state,
    named: (name) => calls.filter((c) => c[0] === name),
  };
}

// Every test ends here: no blocked market looked up, no cover left on disk.
function assertClean(h) {
  for (const k of h.touched) assert.ok(!BLOCKED.test(k), "blocked market touched: " + k);
  for (const f of h.covers) assert.ok(!fs.existsSync(f), "cover file deleted: " + f);
}

// A MarketplaceListing whose create() throws; everything else is the real model.
function failingCreate(message = "listing write refused") {
  return new Proxy(MarketplaceListing, {
    get(target, key) {
      if (key === "create") {
        return async () => {
          throw new Error(message);
        };
      }
      const v = target[key];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

// --- fixtures ------------------------------------------------------------------

const SLOTS = [
  { slotKey: "12:c1:aaaa:1", label: "Sun Tea Player Icon", image: "https://cdn.example.test/1.png", nameRaw: "x1", campaignTitle: "Camp" },
  { slotKey: "12:c1:bbbb:1", label: "Moon Spray", image: "https://cdn.example.test/2.png", nameRaw: "x2", campaignTitle: "Camp" },
];

function productDoc(over = {}) {
  const guide = guideFor("12", DEFAULTS);
  const slots = over.slots || SLOTS;
  return {
    name: "Overwatch - Camp (2 codes)",
    gameNo: "12",
    gameName: "Overwatch 2",
    marketGame: "Overwatch",
    groupKeys: ["12:c1"],
    slots,
    slotSetHash: "hash-" + ++seq,
    status: "draft",
    texts: defaultTexts({ slots, guide, now: NOW }),
    pricing: { mode: "fixed", priceUsd: 2.5, floorUsd: 1 },
    markets: ["eldorado"],
    ...over,
  };
}

async function makeProduct(over = {}) {
  return CodeProduct.create(productDoc(over));
}

// An approved product: active, with its AccountOffer.
async function activeProduct(over = {}) {
  const p = await makeProduct({ status: "active", ...over });
  const offer = await AccountOffer.create({
    title: p.texts.title,
    description: p.texts.description,
    game: p.marketGame,
    priceUsd: p.pricing.priceUsd,
    status: "active",
    deliveryTemplate: p.texts.deliveryTemplate,
  });
  await CodeProduct.updateOne({ _id: p._id }, { $set: { offer: offer._id } });
  return CodeProduct.findById(p._id).lean();
}

function claimedUnits(n) {
  return Array.from({ length: n }, (_, i) => ({
    ledgerId: String(new mongoose.Types.ObjectId()),
    login: "cs-abcdef-" + (i + 1),
    password: "1) Sun Tea Player Icon = TEST-" + i + "\n2) Moon Spray = TEST-" + i + "B",
  }));
}

// --- problems ----------------------------------------------------------------------

test("exports the contract constants", () => {
  assert.deepEqual([...ALLOWED_MARKETS], ["eldorado", "ggsel"]);
  assert.equal(ELDORADO_MIN_USD, 0.5);
});

test("problems: a good product has none", async () => {
  const h = harness();
  assert.deepEqual(await h.pub.problems(productDoc()), []);
  assertClean(h);
});

test("problems: each rule", async () => {
  const h = harness();
  const has = async (doc, re) => {
    const found = await h.pub.problems(doc);
    assert.ok(found.some((p) => re.test(p)), "expected " + re + " in " + JSON.stringify(found));
  };
  await has(productDoc({ slots: [] }), /no slots/);
  await has(productDoc({ slots: [SLOTS[0], { ...SLOTS[1], slotKey: SLOTS[0].slotKey }] }), /same slot is in the bundle twice/);
  const sourced = productDoc();
  sourced.texts = { ...sourced.texts, title: "Overwatch 2 | Korea event codes" };
  await has(sourced, /title names where the codes come from/);
  await has(productDoc({ slots: [SLOTS[0], { ...SLOTS[1], label: "" }] }), /label 2 is empty/);
  await has(productDoc({ pricing: { priceUsd: 0.3, floorUsd: 0 } }), /below the \$0\.50 market minimum/);
  await has(productDoc({ pricing: { priceUsd: 2, floorUsd: 3 } }), /below its floor/);
  await has(productDoc({ markets: ["eldorado", "gameflip"] }), /market not allowed: gameflip/);
  await has(productDoc({ markets: ["digiseller"] }), /market not allowed: digiseller/);
  await has(productDoc({ markets: [] }), /no market chosen/);
  await has(productDoc({ marketGame: "" }), /no marketplace game name/);
  await has(productDoc({ marketGame: "   " }), /no marketplace game name/);

  const off = harness({ config: { markets: { eldorado: false, ggsel: false } } });
  const found = await off.pub.problems(productDoc({ markets: ["eldorado", "ggsel"] }));
  assert.ok(found.some((p) => /none of its markets is switched on/.test(p)), JSON.stringify(found));
  // One enabled market is enough.
  const half = harness({ config: { markets: { eldorado: true, ggsel: false } } });
  assert.deepEqual(await half.pub.problems(productDoc({ markets: ["eldorado", "ggsel"] })), []);
  assertClean(h);
});

// --- approve ------------------------------------------------------------------------

test("approve: creates the active AccountOffer, activates the product, fills, publishes", async () => {
  const p = await makeProduct();
  const h = harness({ byProduct: { [String(p._id)]: 3 } });
  const res = await h.pub.approve(p._id, { actor: "owner@example.test" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.built, 3);

  const offers = await AccountOffer.find({}).lean();
  assert.equal(offers.length, 1);
  const o = offers[0];
  assert.equal(o.title, p.texts.title);
  assert.equal(o.description, p.texts.description);
  assert.equal(o.game, "Overwatch");
  assert.equal(o.note, "code shop product " + String(p._id));
  assert.equal(o.priceUsd, 2.5);
  assert.equal(o.minPriceUsd, 1);
  assert.equal(o.status, "active");
  assert.equal(o.autoDeliver, true);
  assert.equal(o.deliveryTemplate, p.texts.deliveryTemplate);
  assert.equal(o.coverStyle, "promo");
  assert.equal(o.coverServiceText, p.texts.coverServiceText);
  assert.deepEqual(o.coverBullets, p.texts.coverBullets);
  assert.deepEqual(o.coverImages, SLOTS.map((s) => s.image));
  assert.equal(o.createdBy, "owner@example.test");

  const after = await CodeProduct.findById(p._id).lean();
  assert.equal(after.status, "active");
  assert.equal(String(after.offer), String(o._id));
  assert.equal(after.approvedAt.getTime(), NOW);
  assert.equal(after.approvedBy, "owner@example.test");
  assert.equal(after.edited, true);

  assert.deepEqual(h.named("fillRun"), [["fillRun", { force: true }]]);
  // publish defaults on: the Eldorado offer went up from the shelf.
  assert.equal(h.named("eldoradoPublish").length, 1);
  assert.equal(res.publish.results[0].ok, true);
  assert.equal(await MarketplaceListing.countDocuments({ accountOffer: o._id, status: "active" }), 1);
  assertClean(h);
});

test("approve: publish:false publishes nothing; a paused product with no offer can be approved", async () => {
  const p = await makeProduct({ status: "paused" });
  const h = harness();
  const res = await h.pub.approve(p._id, { publish: false });
  assert.equal(res.ok, true);
  assert.equal(res.publish, null);
  assert.equal(h.named("eldoradoPublish").length, 0);
  assert.equal((await CodeProduct.findById(p._id).lean()).status, "active");
  assertClean(h);
});

test("approve: refuses a product with problems and writes nothing", async () => {
  const p = await makeProduct({ marketGame: "" });
  const h = harness();
  const res = await h.pub.approve(p._id, { actor: "owner" });
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((x) => /no marketplace game name/.test(x)));
  assert.equal(await AccountOffer.countDocuments({}), 0);
  assert.equal((await CodeProduct.findById(p._id).lean()).status, "draft");
  assert.equal(h.named("fillRun").length, 0);
  assertClean(h);
});

test("approve: refuses an active product, a missing one and a bad id", async () => {
  const p = await activeProduct();
  const h = harness();
  const res = await h.pub.approve(p._id);
  assert.equal(res.ok, false);
  assert.ok(/only a draft can be approved/.test(res.problems[0]));
  assert.equal(await AccountOffer.countDocuments({}), 1);
  assert.equal((await h.pub.approve(new mongoose.Types.ObjectId())).ok, false);
  assert.equal((await h.pub.approve("not-an-id")).ok, false);
  assertClean(h);
});

test("approve: rebalance dissolves only overlapping, same-game, active products", async () => {
  const p = await makeProduct();
  const overlap = await activeProduct({ name: "overlap", slots: [SLOTS[0]] });
  await activeProduct({ name: "disjoint", slots: [{ ...SLOTS[0], slotKey: "12:c9:zzzz:1" }] });
  await activeProduct({ name: "other game", gameNo: "200", marketGame: "Delta Force", slots: [SLOTS[1]] });
  await makeProduct({ name: "paused twin", status: "paused", slots: [SLOTS[1]] });
  await makeProduct({ name: "draft twin", slots: [SLOTS[0]] });

  const h = harness();
  const res = await h.pub.approve(p._id, { rebalance: true, publish: false });
  assert.equal(res.ok, true);
  const dissolved = h.named("dissolve");
  assert.equal(dissolved.length, 1, JSON.stringify(dissolved));
  assert.equal(dissolved[0][1], String(overlap._id));
  assert.deepEqual(dissolved[0][2], { reason: "moved to " + p.name });
  assert.equal(res.dissolved, 2);
  // Rebalance runs before the fill, so the freed codes can be rebuilt.
  const order = h.calls.map((c) => c[0]).filter((n) => n === "dissolve" || n === "fillRun");
  assert.deepEqual(order, ["dissolve", "fillRun"]);

  const h2 = harness();
  const q = await makeProduct();
  await h2.pub.approve(q._id, { publish: false });
  assert.equal(h2.named("dissolve").length, 0, "no rebalance unless asked");
  assertClean(h);
});

// --- publishProduct: Eldorado -------------------------------------------------------------

test("publish eldorado: offer from the shelf, then a row with exactly the contract's fields", async () => {
  const p = await activeProduct({ pricing: { priceUsd: 1.239, floorUsd: 1 } });
  const h = harness({ shelf: 7 });
  const out = await h.pub.publishProduct(p._id, { actor: "owner" });
  assert.equal(out.results.length, 1);
  const r = out.results[0];
  assert.equal(r.market, "eldorado");
  assert.equal(r.ok, true);
  assert.match(r.externalId, /^eld-/);

  const [[, args]] = h.named("eldoradoPublish");
  assert.equal(args.game, "Overwatch");
  assert.equal(args.title, p.texts.title);
  assert.equal(args.description, p.texts.description);
  assert.equal(args.priceUsd, 1.24);
  assert.equal(args.quantity, 7);
  assert.equal(args.minQuantity, 1);
  assert.equal(args.coverImagePath, h.covers[0]);

  const rows = await MarketplaceListing.find({}).lean();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.set, null);
  assert.equal(String(row.accountOffer), String(p.offer));
  assert.equal(row.origin, "manual");
  assert.equal(row.accountId, "");
  assert.equal(row.accountLogin, "");
  assert.deepEqual(row.units, []);
  assert.equal(row.marketplace, "eldorado");
  assert.equal(row.externalId, r.externalId);
  assert.equal(row.externalNode, "");
  assert.equal(row.url, r.url);
  assert.equal(row.title, p.texts.title);
  assert.equal(row.description, p.texts.description);
  assert.equal(row.price, 1.24);
  assert.equal(row.status, "active");
  assert.equal(row.note, "code shop");
  assert.equal(row.autoDeliver, false);

  const after = await CodeProduct.findById(p._id).lean();
  assert.equal(after.publish.lastError, "");
  assert.equal(after.publish.lastAttemptAt.getTime(), NOW);
  assert.equal(h.sent.length, 0);
  assert.ok(h.events.some((e) => e.kind === "publish" && /Published/.test(e.msg)));
  assertClean(h);
});

test("publish: the price is never below the floor or the market minimum", async () => {
  const { priceOf } = require("../utils/codeShop/publish");
  assert.equal(priceOf({ pricing: { priceUsd: 0.2, floorUsd: 0 } }), 0.5);
  assert.equal(priceOf({ pricing: { priceUsd: 1, floorUsd: 1.5 } }), 1.5);
  assert.equal(priceOf({ pricing: { priceUsd: 3.456, floorUsd: 1 } }), 3.46);
});

test("publish: skips a market that is already live, and one with no stock", async () => {
  const p = await activeProduct();
  await MarketplaceListing.create({
    accountOffer: p.offer,
    marketplace: "eldorado",
    externalId: "eld-existing",
    status: "active",
  });
  const h = harness();
  const out = await h.pub.publishProduct(p._id);
  assert.deepEqual(out.results, [{ market: "eldorado", ok: false, skipped: "already live" }]);
  assert.equal(h.named("eldoradoPublish").length, 0);
  assert.equal(h.named("coverBuild").length, 0);

  await MarketplaceListing.deleteMany({});
  const empty = harness({ shelf: 0 });
  const out2 = await empty.pub.publishProduct(p._id);
  assert.deepEqual(out2.results, [{ market: "eldorado", ok: false, skipped: "no stock yet" }]);
  assert.equal(empty.named("eldoradoPublish").length, 0);
  assert.equal(await MarketplaceListing.countDocuments({}), 0);
  assertClean(h);
  assertClean(empty);
});

test("publish: a market switched off in the settings is skipped without a call", async () => {
  const p = await activeProduct({ markets: ["eldorado", "ggsel"] });
  const h = harness({ config: { markets: { eldorado: true, ggsel: false } }, claimed: claimedUnits(2) });
  const out = await h.pub.publishProduct(p._id);
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].ok, true);
  assert.deepEqual(out.results[1], { market: "ggsel", ok: false, skipped: "switched off in the code shop settings" });
  for (const name of ["ggselTakesNewStock", "resolveCategory", "claimForListing", "ggselPublish"]) {
    assert.equal(h.named(name).length, 0, name + " must not run");
  }
  assertClean(h);
});

test("publish: a product naming a blocked market publishes nowhere, and never looks it up", async () => {
  const p = await activeProduct();
  // The schema refuses these markets; write past it to prove publish refuses too.
  await CodeProduct.collection.updateOne({ _id: p._id }, { $set: { markets: ["gameflip", "digiseller", "eldorado"] } });
  const h = harness();
  const out = await h.pub.publishProduct(p._id);
  assert.deepEqual(out.results, []);
  assert.match(out.error, /market not allowed: gameflip, digiseller/);
  assert.equal(h.calls.filter((c) => /Publish|Delist/.test(c[0])).length, 0);
  assert.equal(h.sent.length, 1, "the refusal is reported");
  const after = await CodeProduct.findById(p._id).lean();
  assert.match(after.publish.lastError, /market not allowed/);
  assertClean(h);
});

test("publish: refuses a product that is not active, or whose texts fail the guard", async () => {
  const draft = await makeProduct();
  const h = harness();
  const out = await h.pub.publishProduct(draft._id);
  assert.deepEqual(out.results, []);
  assert.match(out.error, /only an approved, active product/);

  const p = await activeProduct();
  await CodeProduct.updateOne({ _id: p._id }, { $set: { "texts.description": "Codes from the official spring event" } });
  const out2 = await h.pub.publishProduct(p._id);
  assert.match(out2.error, /description names where the codes come from/);
  assert.equal(h.named("eldoradoPublish").length, 0);
  assertClean(h);
});

test("publish eldorado: a failed row write takes the new offer straight back down", async () => {
  const p = await activeProduct();
  const h = harness({ MarketplaceListing: failingCreate("disk full") });
  const out = await h.pub.publishProduct(p._id);
  const r = out.results[0];
  assert.equal(r.ok, false);
  assert.match(r.error, /listing row not saved \(disk full\); the new Eldorado offer was paused/);
  const [[, made]] = h.named("eldoradoPublish");
  assert.ok(made);
  const delists = h.named("eldoradoDelist");
  assert.equal(delists.length, 1);
  assert.equal(delists[0][1], r.externalId);
  assert.match(r.externalId, /^eld-/);
  assert.equal(await MarketplaceListing.countDocuments({}), 0);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /failed/);
  const after = await CodeProduct.findById(p._id).lean();
  assert.match(after.publish.lastError, /^eldorado: listing row not saved/);
  assertClean(h);
});

test("publish eldorado: a failed row write whose take-down fails says so loudly", async () => {
  const p = await activeProduct();
  const h = harness({ MarketplaceListing: failingCreate("disk full"), eldoradoDelistError: new Error("timeout") });
  const out = await h.pub.publishProduct(p._id);
  assert.match(out.results[0].error, /could NOT be paused \(timeout\): pause it on Eldorado by hand/);
  assert.equal(h.sent.length, 1);
  assertClean(h);
});

test("publish eldorado: the offer-limit refusal is told in plain words", async () => {
  const p = await activeProduct();
  const h = harness({
    eldoradoPublishError: new Error('Eldorado publish: {"message":"You can have a maximum of 50 active offers in this category"}'),
  });
  const out = await h.pub.publishProduct(p._id);
  assert.deepEqual(out.results, [{ market: "eldorado", ok: false, error: OFFER_LIMIT_MSG }]);
  assert.equal(await MarketplaceListing.countDocuments({}), 0);
  assert.equal(h.named("eldoradoDelist").length, 0);

  const h2 = harness({ eldoradoPublishError: new Error("Offer creation limits reached") });
  const out2 = await h2.pub.publishProduct(p._id);
  assert.equal(out2.results[0].error, OFFER_LIMIT_MSG);
  assertClean(h);
  assertClean(h2);
});

test("publish: a cover that cannot be built fails the market, with nothing published", async () => {
  const p = await activeProduct({ markets: ["eldorado", "ggsel"] });
  const h = harness({ coverError: new Error("no item images for the cover"), claimed: claimedUnits(2) });
  const out = await h.pub.publishProduct(p._id);
  assert.equal(out.results.length, 2);
  for (const r of out.results) assert.match(r.error, /no item images/);
  assert.equal(h.named("eldoradoPublish").length, 0);
  assert.equal(h.named("claimForListing").length, 0, "no claim before the cover exists");
  assert.equal(h.named("coverBuild").length, 1, "built once per publish");
  assertClean(h);
});

// --- publishProduct: GGSel --------------------------------------------------------------

async function ggselProduct(over = {}) {
  return activeProduct({ markets: ["ggsel"], ...over });
}

test("publish ggsel: GGSel taking no new stock skips it", async () => {
  const p = await ggselProduct();
  const h = harness({ takesNewStock: false, claimed: claimedUnits(2) });
  const out = await h.pub.publishProduct(p._id);
  assert.deepEqual(out.results, [{ market: "ggsel", ok: false, skipped: "GGSel takes no new stock" }]);
  assert.equal(h.named("claimForListing").length, 0);
  assert.equal(h.named("ggselPublish").length, 0);
  assertClean(h);
});

test("publish ggsel: no category for the game is an error, nothing claimed", async () => {
  const p = await ggselProduct();
  const h = harness({ category: { ok: false, value: {}, reason: "no shelf for this game" }, claimed: claimedUnits(2) });
  const out = await h.pub.publishProduct(p._id);
  assert.equal(out.results[0].ok, false);
  assert.match(out.results[0].error, /no GGSel category for Overwatch: no shelf for this game/);
  assert.deepEqual(h.named("resolveCategory"), [["resolveCategory", "ggsel", "Overwatch"]]);
  assert.equal(h.named("claimForListing").length, 0);
  assert.equal(h.sent.length, 1);
  assertClean(h);
});

test("publish ggsel: claim, publish with the texts, row with units, then markFed", async () => {
  const p = await ggselProduct({ ggsel: { vaultSize: 5 } });
  const claimed = claimedUnits(3);
  const h = harness({ shelf: 3, claimed });
  const out = await h.pub.publishProduct(p._id);
  const r = out.results[0];
  assert.equal(r.ok, true, JSON.stringify(r));

  const [[, offerArg, want, claimOpts]] = h.named("claimForListing");
  assert.equal(offerArg, String(p.offer));
  assert.equal(want, 3, "min(vaultSize, shelf)");
  assert.deepEqual(claimOpts, { market: "ggsel" });

  const [[, args]] = h.named("ggselPublish");
  assert.equal(args.title, p.texts.title);
  assert.equal(args.description, p.texts.description);
  assert.equal(args.priceUsd, 2.5);
  assert.equal(args.categoryId, 4242);
  assert.equal(args.quantity, 3);
  assert.equal(args.delivery, "auto");
  assert.equal(args.instructions, guideFor("12", DEFAULTS).deliveryHelp);
  assert.equal(args.coverImagePath, h.covers[0]);
  assert.equal(args.products.length, 3);
  assert.ok(args.products[0].includes(claimed[0].password));
  assert.ok(args.products[0].startsWith("Thank you for your order!"));

  const row = await MarketplaceListing.findOne({}).lean();
  assert.equal(row.marketplace, "ggsel");
  assert.equal(row.externalId, r.externalId);
  assert.equal(row.set, null);
  assert.equal(row.origin, "manual");
  assert.equal(row.accountId, "");
  assert.equal(row.accountLogin, "");
  assert.equal(row.autoDeliver, true);
  assert.equal(row.qtyTarget, 3);
  assert.equal(row.price, 2.5);
  assert.equal(row.note, "code shop");
  assert.equal(row.units.length, 3);
  row.units.forEach((u, i) => {
    assert.equal(u.contentId, claimed[i].ledgerId);
    assert.equal(u.accountId, "");
    assert.equal(u.login, claimed[i].login);
    assert.equal(u.addedAt.getTime(), NOW);
    assert.equal(u.deliveredAt, null);
    assert.equal(u.orderId, "");
  });

  const fed = h.named("markFed");
  assert.equal(fed.length, 1);
  assert.deepEqual(fed[0][1], claimed.map((c) => c.ledgerId));
  assert.equal(String(fed[0][2].listing), String(row._id));
  assert.equal(fed[0][2].market, "ggsel");
  assert.equal(h.named("releaseClaim").length, 0);
  // Ordering: claim -> publish -> (row) -> markFed.
  const order = h.calls.map((c) => c[0]).filter((n) => ["claimForListing", "ggselPublish", "markFed"].includes(n));
  assert.deepEqual(order, ["claimForListing", "ggselPublish", "markFed"]);
  assertClean(h);
});

test("publish ggsel: the ledger learns at once that the codes are in the vault", async () => {
  const p = await ggselProduct();
  const claimed = claimedUnits(2);
  const other = new mongoose.Types.ObjectId();
  const base = { product: p._id, offer: p.offer, unitStatus: "available" };
  await CodeStock.insertMany([
    { ...base, loginId: "l1", itemKey: "i1", state: "in_unit", unit: claimed[0].ledgerId },
    { ...base, loginId: "l2", itemKey: "i2", state: "in_unit", unit: claimed[0].ledgerId, unitStatus: "sold" },
    { ...base, loginId: "l3", itemKey: "i3", state: "in_unit", unit: claimed[1].ledgerId },
    { ...base, loginId: "l4", itemKey: "i4", state: "held", unit: claimed[1].ledgerId, problem: "same code as another stored code" },
    { ...base, loginId: "l5", itemKey: "i5", state: "in_unit", unit: other },
  ]);
  const h = harness({ claimed });
  const out = await h.pub.publishProduct(p._id);
  assert.equal(out.results[0].ok, true);

  const rows = await CodeStock.find({}).lean();
  const by = Object.fromEntries(rows.map((r) => [r.loginId, r]));
  for (const k of ["l1", "l2", "l3"]) {
    assert.equal(by[k].state, "in_unit", k + " keeps its state");
    assert.equal(by[k].unitStatus, "fed", k);
    assert.equal(by[k].wasFed, true, k);
    assert.deepEqual(by[k].history, [], k + " gets no history entry");
  }
  assert.equal(by.l4.state, "held");
  assert.equal(by.l4.unitStatus, "available", "only in_unit rows are touched");
  assert.equal(by.l4.wasFed, false);
  assert.equal(by.l5.unitStatus, "available", "another unit is untouched");
  assert.equal(by.l5.wasFed, false);
  assertClean(h);
});

test("publish ggsel: the ledger is marked fed even when markFed fails", async () => {
  const p = await ggselProduct();
  const claimed = claimedUnits(1);
  await CodeStock.create({ loginId: "l1", itemKey: "i1", state: "in_unit", unit: claimed[0].ledgerId, product: p._id, unitStatus: "sold" });
  const h = harness({ claimed, markFedError: new Error("ledger busy") });
  const out = await h.pub.publishProduct(p._id);
  assert.equal(out.results[0].ok, true, "the listing is up and has its row");
  const row = await CodeStock.findOne({ loginId: "l1" }).lean();
  assert.equal(row.unitStatus, "fed");
  assert.equal(row.wasFed, true);
  assert.ok(h.events.some((e) => e.level === "warn" && /not marked as in the vault/.test(e.msg)));
  assertClean(h);
});

test("publish ggsel: the vault size caps the claim", async () => {
  const p = await ggselProduct({ ggsel: { vaultSize: 2 } });
  const h = harness({ shelf: 9, claimed: claimedUnits(9) });
  await h.pub.publishProduct(p._id);
  assert.equal(h.named("claimForListing")[0][2], 2);
  assert.equal(h.named("ggselPublish")[0][1].quantity, 2);
  assertClean(h);
});

test("publish ggsel: nothing claimed is a skip, not a publish", async () => {
  const p = await ggselProduct();
  const h = harness({ claimed: [] });
  const out = await h.pub.publishProduct(p._id);
  assert.equal(out.results[0].ok, false);
  assert.ok(out.results[0].skipped);
  assert.equal(h.named("ggselPublish").length, 0);
  assertClean(h);
});

test("publish ggsel: an empty delivery text hands the claim back and publishes nothing", async () => {
  const p = await ggselProduct();
  const claimed = claimedUnits(2);
  claimed[1].password = "";
  const h = harness({ claimed });
  const out = await h.pub.publishProduct(p._id);
  assert.match(out.results[0].error, /no delivery text/);
  assert.equal(h.named("ggselPublish").length, 0);
  assert.deepEqual(h.named("releaseClaim"), [["releaseClaim", claimed.map((c) => c.ledgerId)]]);
  assertClean(h);
});

test("publish ggsel: a throw while rendering the texts hands the claim back", async () => {
  const p = await ggselProduct();
  const claimed = claimedUnits(2);
  const h = harness({ claimed });
  h.deps.stock = () => ({
    shelfFor: async () => 2,
    claimForListing: async () => claimed,
    releaseClaim: async (ids) => {
      h.calls.push(["releaseClaim", ids.map(String)]);
      return ids.length;
    },
    deliveryText: () => {
      throw new Error("decrypt failed");
    },
  });
  const pub = createPublisher(h.deps);
  const out = await pub.publishProduct(p._id);
  assert.match(out.results[0].error, /decrypt failed/);
  assert.equal(h.named("ggselPublish").length, 0);
  assert.deepEqual(h.named("releaseClaim"), [["releaseClaim", claimed.map((c) => c.ledgerId)]]);
  assertClean(h);
});

test("publish ggsel: a publish that throws hands the claim back", async () => {
  const p = await ggselProduct();
  const claimed = claimedUnits(2);
  const h = harness({ claimed, ggselPublishError: new Error("GGSel publish: 502") });
  const out = await h.pub.publishProduct(p._id);
  assert.equal(out.results[0].ok, false);
  assert.match(out.results[0].error, /502/);
  assert.deepEqual(h.named("releaseClaim"), [["releaseClaim", claimed.map((c) => c.ledgerId)]]);
  assert.equal(h.named("markFed").length, 0);
  assert.equal(await MarketplaceListing.countDocuments({}), 0);
  assertClean(h);
});

test("publish ggsel: a failed row write pauses the offer, keeps the claim, holds the codes", async () => {
  const p = await ggselProduct();
  const claimed = claimedUnits(2);
  // Ledger rows of the two claimed units, plus one of an unrelated unit.
  const rows = [];
  let k = 0;
  for (const c of claimed) {
    for (const s of SLOTS) {
      rows.push({
        loginId: "login-" + ++k,
        itemKey: "item-" + k,
        slotKey: s.slotKey,
        state: "in_unit",
        unit: c.ledgerId,
        product: p._id,
        offer: p.offer,
        unitStatus: "sold",
      });
    }
  }
  const other = new mongoose.Types.ObjectId();
  rows.push({ loginId: "login-x", itemKey: "item-x", state: "in_unit", unit: other, product: p._id });
  await CodeStock.insertMany(rows);

  const h = harness({ claimed, MarketplaceListing: failingCreate("write conflict") });
  const out = await h.pub.publishProduct(p._id);
  const r = out.results[0];
  assert.equal(r.ok, false);
  assert.match(r.error, /listing row not saved \(write conflict\); the GGSel offer was paused; 4 codes held/);

  const [[, delistId]] = h.named("ggselDelist");
  assert.equal(delistId, r.externalId);
  assert.equal(h.named("releaseClaim").length, 0, "the claim is kept: the codes are in GGSel's vault");
  assert.equal(h.named("markFed").length, 0);

  const held = await CodeStock.find({ unit: { $in: claimed.map((c) => c.ledgerId) } }).lean();
  assert.equal(held.length, 4);
  for (const row of held) {
    assert.equal(row.state, "held");
    assert.equal(row.problem, HELD_IN_VAULT);
    assert.equal(row.wasFed, true);
    assert.equal(row.history.at(-1).from, "in_unit");
    assert.equal(row.history.at(-1).to, "held");
  }
  const untouched = await CodeStock.findOne({ unit: other }).lean();
  assert.equal(untouched.state, "in_unit");
  assert.equal(h.sent.length, 1);
  assertClean(h);
});

test("publish: lastError is set by a failure and cleared by the next clean run", async () => {
  const p = await activeProduct();
  const bad = harness({ eldoradoPublishError: new Error("Eldorado: upstream 500") });
  await bad.pub.publishProduct(p._id);
  let after = await CodeProduct.findById(p._id).lean();
  assert.equal(after.publish.lastError, "eldorado: Eldorado: upstream 500");
  assert.equal(after.publish.lastAttemptAt.getTime(), NOW);
  assert.ok(bad.events.some((e) => e.level === "error" && e.kind === "publish"));

  const good = harness();
  await good.pub.publishProduct(p._id);
  after = await CodeProduct.findById(p._id).lean();
  assert.equal(after.publish.lastError, "");
  assertClean(bad);
  assertClean(good);
});

// --- pause / resume / retire ---------------------------------------------------------------

async function liveRows(p) {
  const base = { accountOffer: p.offer, status: "active", origin: "manual", note: "code shop" };
  const e1 = await MarketplaceListing.create({ ...base, marketplace: "eldorado", externalId: "eld-a" });
  const e2 = await MarketplaceListing.create({ ...base, marketplace: "eldorado", externalId: "eld-b" });
  const g = await MarketplaceListing.create({ ...base, marketplace: "ggsel", externalId: "12345", autoDeliver: true });
  return { e1, e2, g };
}

test("pause: Eldorado rows are delisted and marked; GGSel rows are left to the Listings page", async () => {
  const p = await activeProduct({ markets: ["eldorado", "ggsel"] });
  const { e1, e2, g } = await liveRows(p);
  const h = harness();
  const res = await h.pub.pause(p._id, { actor: "owner" });
  assert.equal(res.ok, true);
  assert.equal(res.delisted, 2);
  assert.equal(res.ggselLive, 1);
  assert.match(res.note, /Listings page/);
  assert.deepEqual(
    h.named("eldoradoDelist").map((c) => c[1]).sort(),
    ["eld-a", "eld-b"],
  );
  assert.equal(h.named("ggselDelist").length, 0);
  assert.equal((await MarketplaceListing.findById(e1._id).lean()).status, "delisted");
  assert.equal((await MarketplaceListing.findById(e2._id).lean()).status, "delisted");
  assert.equal((await MarketplaceListing.findById(g._id).lean()).status, "active");
  assert.equal((await CodeProduct.findById(p._id).lean()).status, "paused");
  assertClean(h);
});

test("pause: an offer already off sale counts as delisted; a real failure keeps the row and reports", async () => {
  const p = await activeProduct();
  const gone = await MarketplaceListing.create({ accountOffer: p.offer, marketplace: "eldorado", externalId: "eld-gone", status: "active" });
  const h = harness({ eldoradoDelistError: new Error("To pause an offer it must be active") });
  const res = await h.pub.pause(p._id);
  assert.equal(res.ok, true);
  assert.equal((await MarketplaceListing.findById(gone._id).lean()).status, "delisted");

  await CodeProduct.updateOne({ _id: p._id }, { $set: { status: "active" } });
  const stuck = await MarketplaceListing.create({ accountOffer: p.offer, marketplace: "eldorado", externalId: "eld-stuck", status: "active" });
  const h2 = harness({ eldoradoDelistError: new Error("Eldorado delist: 503") });
  const res2 = await h2.pub.pause(p._id);
  assert.equal(res2.ok, false);
  assert.match(res2.errors[0], /eld-stuck: Eldorado delist: 503/);
  const row = await MarketplaceListing.findById(stuck._id).lean();
  assert.equal(row.status, "active");
  assert.match(row.lastError, /503/);
  assert.equal((await CodeProduct.findById(p._id).lean()).status, "paused");
  assert.equal(h2.sent.length, 1);
  assertClean(h);
  assertClean(h2);
});

test("pause: refuses a draft or a retired product", async () => {
  const d = await makeProduct();
  const h = harness();
  assert.equal((await h.pub.pause(d._id)).ok, false);
  const r = await makeProduct({ status: "retired" });
  assert.equal((await h.pub.pause(r._id)).ok, false);
  assert.equal((await CodeProduct.findById(r._id).lean()).status, "retired");
  assertClean(h);
});

test("resume: back to active, then published", async () => {
  const p = await activeProduct();
  await CodeProduct.updateOne({ _id: p._id }, { $set: { status: "paused" } });
  const h = harness();
  const res = await h.pub.resume(p._id, { actor: "owner" });
  assert.equal(res.ok, true);
  assert.equal(res.product.status, "active");
  assert.equal(h.named("eldoradoPublish").length, 1);
  assert.equal(res.publish.results[0].ok, true);
  assert.equal(await MarketplaceListing.countDocuments({ accountOffer: p.offer, status: "active" }), 1);

  // Only a paused product resumes.
  const again = await h.pub.resume(p._id);
  assert.equal(again.ok, false);
  assertClean(h);
});

test("retire: refused while a GGSel row is live; nothing changes", async () => {
  const p = await activeProduct({ markets: ["eldorado", "ggsel"] });
  const { e1 } = await liveRows(p);
  const h = harness();
  const res = await h.pub.retire(p._id);
  assert.equal(res.ok, false);
  assert.match(res.error, /GGSel listing of this product is still live/);
  assert.equal(h.named("eldoradoDelist").length, 0);
  assert.equal(h.named("dissolve").length, 0);
  assert.equal((await CodeProduct.findById(p._id).lean()).status, "active");
  assert.equal((await MarketplaceListing.findById(e1._id).lean()).status, "active");
  assertClean(h);
});

test("retire: pauses, takes the bundles apart, retires", async () => {
  const p = await activeProduct();
  const e = await MarketplaceListing.create({ accountOffer: p.offer, marketplace: "eldorado", externalId: "eld-r", status: "active" });
  // A delisted GGSel row does not block.
  await MarketplaceListing.create({ accountOffer: p.offer, marketplace: "ggsel", externalId: "777", status: "delisted" });
  const h = harness();
  const res = await h.pub.retire(p._id, { actor: "owner" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.dissolved, 2);
  assert.deepEqual(h.named("eldoradoDelist").map((c) => c[1]), ["eld-r"]);
  assert.equal((await MarketplaceListing.findById(e._id).lean()).status, "delisted");
  const d = h.named("dissolve");
  assert.equal(d.length, 1);
  assert.equal(d[0][1], String(p._id));
  assert.deepEqual(d[0][2], { reason: "retired" });
  // Taken down before the bundles are taken apart.
  const order = h.calls.map((c) => c[0]).filter((n) => n === "eldoradoDelist" || n === "dissolve");
  assert.deepEqual(order, ["eldoradoDelist", "dissolve"]);
  const after = await CodeProduct.findById(p._id).lean();
  assert.equal(after.status, "retired");
  assert.equal(after.retiredAt.getTime(), NOW);

  const again = await h.pub.retire(p._id);
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
  assertClean(h);
});

test("retire: a failed Eldorado take-down stops the retire before any bundle is touched", async () => {
  const p = await activeProduct();
  await MarketplaceListing.create({ accountOffer: p.offer, marketplace: "eldorado", externalId: "eld-x", status: "active" });
  const h = harness({ eldoradoDelistError: new Error("Eldorado delist: 503") });
  const res = await h.pub.retire(p._id);
  assert.equal(res.ok, false);
  assert.match(res.error, /not retired/);
  assert.equal(h.named("dissolve").length, 0);
  assert.equal((await CodeProduct.findById(p._id).lean()).status, "paused");
  assertClean(h);
});

test("retire: a draft retires without touching any market", async () => {
  const d = await makeProduct();
  const h = harness();
  const res = await h.pub.retire(d._id);
  assert.equal(res.ok, true);
  assert.equal(res.product.status, "retired");
  assert.equal(h.calls.length, 0);
  assertClean(h);
});

// --- one product at a time ---------------------------------------------------------------

async function waitFor(cond, what) {
  for (let i = 0; i < 500; i += 1) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail("timed out waiting for " + what);
}

const settle = () => new Promise((r) => setImmediate(r));

test("serial: two concurrent publishes of one product put up exactly one Eldorado offer", async () => {
  const p = await activeProduct();
  let release;
  const gate = new Promise((r) => (release = r));
  const h = harness({ eldoradoGate: () => gate });
  // One caller holds the ObjectId, the other its string: the same product.
  const a = h.pub.publishProduct(p._id);
  const b = h.pub.publishProduct(String(p._id));
  await waitFor(() => h.named("eldoradoPublish").length === 1, "the first publish to reach Eldorado");
  await settle();
  assert.equal(h.named("shelfFor").length, 1, "the second publish waits for the first");
  assert.equal(h.pub.busy(), 1);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.results[0].ok, true);
  assert.deepEqual(rb.results, [{ market: "eldorado", ok: false, skipped: "already live" }]);
  assert.equal(h.named("eldoradoPublish").length, 1);
  assert.equal(await MarketplaceListing.countDocuments({ marketplace: "eldorado", status: "active" }), 1);
  await settle();
  assert.equal(h.pub.busy(), 0, "a finished chain is forgotten");
  assertClean(h);
});

test("serial: different products publish in parallel", async () => {
  const p1 = await activeProduct({ name: "one" });
  const p2 = await activeProduct({ name: "two" });
  let arrived = 0;
  let open;
  const both = new Promise((r) => (open = r));
  const h = harness({
    // Each publish waits until BOTH are inside Eldorado's call: only possible
    // if the two products are not queued behind each other.
    eldoradoGate: async () => {
      arrived += 1;
      if (arrived === 2) open();
      let timer;
      const late = new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("products were serialised")), 2000)));
      try {
        await Promise.race([both, late]);
      } finally {
        clearTimeout(timer);
      }
    },
  });
  const [r1, r2] = await Promise.all([h.pub.publishProduct(p1._id), h.pub.publishProduct(p2._id)]);
  assert.equal(r1.results[0].ok, true, JSON.stringify(r1));
  assert.equal(r2.results[0].ok, true, JSON.stringify(r2));
  assert.equal(h.named("eldoradoPublish").length, 2);
  assertClean(h);
});

test("serial: a failed action does not jam the product's chain", async () => {
  const p = await activeProduct();
  const h = harness();
  const real = h.deps.config.get;
  let reads = 0;
  h.deps.config.get = async () => {
    reads += 1;
    if (reads === 1) throw new Error("config down");
    return real();
  };
  const a = h.pub.publishProduct(p._id);
  const b = h.pub.publishProduct(p._id);
  await assert.rejects(a, /config down/);
  const rb = await b;
  assert.equal(rb.results[0].ok, true, JSON.stringify(rb));
  await settle();
  assert.equal(h.pub.busy(), 0);
  assertClean(h);
});

test("serial: a pause queued behind a publish takes down the offer that publish put up", async () => {
  const p = await activeProduct();
  let release;
  const gate = new Promise((r) => (release = r));
  const h = harness({ eldoradoGate: () => gate });
  const a = h.pub.publishProduct(p._id);
  const b = h.pub.pause(p._id);
  await waitFor(() => h.named("eldoradoPublish").length === 1, "the publish to reach Eldorado");
  await settle();
  assert.equal(h.named("eldoradoDelist").length, 0, "the pause waits");
  release();
  const ra = await a;
  const rb = await b;
  assert.equal(ra.results[0].ok, true);
  assert.equal(rb.ok, true);
  assert.equal(rb.delisted, 1);
  assert.deepEqual(h.named("eldoradoDelist").map((c) => c[1]), [ra.results[0].externalId]);
  assert.equal(await MarketplaceListing.countDocuments({ status: "active" }), 0);
  assert.equal((await CodeProduct.findById(p._id).lean()).status, "paused");
  assertClean(h);
});
