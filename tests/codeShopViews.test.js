// Code shop read models (utils/codeShop/views.js, docs/code-shop/04-OPS.md).
//
// The "Sales" panel is written against these exact shapes, so the tests pin
// them key for key on a realistic shop: two games, three products (one of
// them retired), units in every status, live and taken-down listings, codes in
// every ledger state. And the rule that matters most: no view ever carries a
// code, a codeHash, a codeEnc, a unit password or a login cookie — checked by
// scanning the JSON of every view for the keys AND for the actual values.
//
// Real Mongo via mongodb-memory-server (the views are aggregation pipelines).
// Every name, price and code here is made up.
process.env.CRED_SECRET ||= "code-shop-views-test-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const CodeStock = require("../models/CodeStock");
const CodeProduct = require("../models/CodeProduct");
const SuppliedAccount = require("../models/SuppliedAccount");
const MarketplaceListing = require("../models/MarketplaceListing");
const SoopAccount = require("../models/SoopAccount");
const { encrypt } = require("../utils/secretBox");
const { hashCode, codeShape } = require("../utils/codeShop/slots");
const { defaultTexts } = require("../utils/codeShop/texts");
const { guideFor } = require("../utils/codeShop/games");
const { DEFAULTS, deepMerge } = require("../utils/codeShop/config");
const { planUnits } = require("../utils/codeShop/allocate");
const { createViews, freeUnitsFor, defaultProblems } = require("../utils/codeShop/views");

const ObjectId = mongoose.Types.ObjectId;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const at = (ms) => new Date(NOW + ms);
const MODELS = [CodeStock, CodeProduct, SuppliedAccount, MarketplaceListing, SoopAccount];

const CFG = deepMerge(DEFAULTS, {});
const fakeConfig = (cfg = CFG) => ({ get: async () => cfg });
const viewsWith = (extra = {}) => createViews({ config: fakeConfig(), now: () => NOW, ...extra });

// Everything that must never reach a view, collected while seeding.
const secrets = new Set();

let mem;
let shop; // ids of the seeded shop

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshopviews"));
  await Promise.all(MODELS.map((m) => m.init()));
  shop = await seedShop();
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

// ------------------------------------------------------------------ seeding

const SLOT = {
  A: "12:501:aaaaaaaaaa:1",
  B: "12:501:bbbbbbbbbb:1",
  C: "12:501:cccccccccc:1",
  D: "200:77:dddddddddd:1",
  E: "200:77:eeeeeeeeee:1",
  F: "200:78:ffffffffff:1",
};
const SLOT_INFO = {
  [SLOT.A]: { gameNo: "12", gameName: "Overwatch 2", groupKey: "12:501", campaignTitle: "Tea Festival", campaignEndAt: at(5 * DAY), nameRaw: "Sun Tea Player Icon", name: "Sun Tea Player Icon", image: "https://img.example.test/a.png" },
  [SLOT.B]: { gameNo: "12", gameName: "Overwatch 2", groupKey: "12:501", campaignTitle: "Tea Festival", campaignEndAt: at(5 * DAY), nameRaw: "Tea Festival Spray", name: "Tea Festival Spray", image: "https://img.example.test/b.png" },
  [SLOT.C]: { gameNo: "12", gameName: "Overwatch 2", groupKey: "12:501", campaignTitle: "Tea Festival", campaignEndAt: at(5 * DAY), nameRaw: "Tea Name Card", name: "Tea Name Card", image: "" },
  [SLOT.D]: { gameNo: "200", gameName: "Delta Force", groupKey: "200:77", campaignTitle: "Camo Week", campaignEndAt: at(17 * DAY), nameRaw: "Camo Pack Bundle", name: "Camo Pack Bundle", image: "https://img.example.test/d.png" },
  [SLOT.E]: { gameNo: "200", gameName: "Delta Force", groupKey: "200:77", campaignTitle: "Camo Week", campaignEndAt: at(17 * DAY), nameRaw: "Exclusive Skin (raw)", name: "KR Exclusive Skin", image: "" },
  [SLOT.F]: { gameNo: "200", gameName: "Delta Force", groupKey: "200:78", campaignTitle: "Gold Rush", campaignEndAt: at(-44 * DAY), nameRaw: "Gold Ticket", name: "Gold Ticket", image: "" },
};
const LOGINS = ["login-1", "login-2", "login-3"];

let seq = 0;
const ledger = []; // what was seeded, test-side, for independent expectations

async function code(slotKey, state, opts = {}) {
  seq += 1;
  const plain = `FAKE-${String(seq).padStart(4, "0")}-VIEW-CODE`;
  const hash = opts.noHash ? "" : hashCode(plain);
  secrets.add(plain);
  if (hash) secrets.add(hash);
  const row = {
    loginId: opts.loginId || LOGINS[seq % LOGINS.length],
    itemKey: "item-" + seq,
    ...SLOT_INFO[slotKey],
    slotKey,
    codeHash: hash,
    codeShape: hash ? codeShape(plain) : "",
    earnedAt: opts.earnedAt === undefined ? at(-seq * HOUR) : opts.earnedAt,
    useBy: opts.useBy === undefined ? at(30 * DAY) : opts.useBy,
    state,
    unit: opts.unit || null,
    product: opts.product || null,
    unitStatus: opts.unitStatus || "",
    soldAt: opts.soldAt || null,
    saleUsd: opts.saleUsd || 0,
    problem: opts.problem || "",
  };
  await CodeStock.create(row);
  ledger.push(row);
  return row;
}

async function many(n, slotKey, state, opts) {
  for (let i = 0; i < n; i++) await code(slotKey, state, opts);
}

async function unit(offer, status, label) {
  const body = `1) Tea Player Icon = FAKE-UNIT-${label}-1\n2) Tea Spray = FAKE-UNIT-${label}-2`;
  const password = encrypt(body);
  secrets.add(`FAKE-UNIT-${label}-1`);
  secrets.add(password);
  return SuppliedAccount.create({ offer, login: "cs-unit-" + label, password, status, market: status === "fed" ? "ggsel" : "" });
}

async function seedShop() {
  const g12 = guideFor("12", CFG);
  const o1 = new ObjectId();
  const o3 = new ObjectId();

  const p1Slots = [
    { slotKey: SLOT.A, label: "Tea Player Icon", image: SLOT_INFO[SLOT.A].image, nameRaw: SLOT_INFO[SLOT.A].nameRaw, campaignTitle: "Tea Festival" },
    { slotKey: SLOT.B, label: "Tea Spray", image: SLOT_INFO[SLOT.B].image, nameRaw: SLOT_INFO[SLOT.B].nameRaw, campaignTitle: "Tea Festival" },
    { slotKey: SLOT.C, label: "Tea Name Card", image: "", nameRaw: SLOT_INFO[SLOT.C].nameRaw, campaignTitle: "Tea Festival" },
  ];
  const p1 = await CodeProduct.create({
    name: "OW tea full set",
    gameNo: "12",
    gameName: "Overwatch 2",
    marketGame: "Overwatch",
    groupKeys: ["12:501"],
    slots: p1Slots,
    status: "active",
    origin: "auto",
    kind: "full",
    offer: o1,
    texts: defaultTexts({ slots: p1Slots, guide: g12, useBy: at(30 * DAY), now: NOW }),
    pricing: { mode: "auto", priceUsd: 2.5, floorUsd: 1, clearance: true, followCompetitors: false, lastChangeAt: at(-2 * DAY), lastReason: "clearance 25%" },
    markets: ["eldorado", "ggsel"],
    publish: { lastError: "", lastAttemptAt: at(-HOUR) },
    competitors: {
      scannedAt: at(-3 * HOUR),
      queries: ["tea player icon", "Overwatch 2 codes"],
      lowestSameSetUsd: 1.99,
      offers: [
        { id: "off-1", title: "Tea set all codes", priceUsd: 1.99, qty: 4, score: 1, sameSet: true, matchedIn: "description", form: "codes" },
        { id: "off-2", title: "Tea spray code", priceUsd: 0.7, qty: 10, score: 0.34, sameSet: false, matchedIn: "title", form: "account" },
        { id: "off-3", title: "Tea bundle", priceUsd: 2.2, qty: 1, score: 0.67, sameSet: false },
      ],
    },
    useBy: at(20 * HOUR),
    proposed: { units: 3, at: at(-5 * DAY) },
  });

  const p2Slots = [
    { slotKey: SLOT.D, label: "Camo Pack", image: SLOT_INFO[SLOT.D].image, nameRaw: SLOT_INFO[SLOT.D].nameRaw },
    { slotKey: SLOT.E, label: "", image: "", nameRaw: SLOT_INFO[SLOT.E].nameRaw },
  ];
  const p2Texts = defaultTexts({ slots: p2Slots, guide: guideFor("200", CFG), useBy: null, now: NOW });
  p2Texts.description += "\nCodes from the official spring event.";
  const p2 = await CodeProduct.create({
    name: "Delta camo leftovers",
    gameNo: "200",
    gameName: "Delta Force",
    marketGame: "Delta Force",
    groupKeys: ["200:77"],
    slots: p2Slots,
    status: "draft",
    origin: "auto",
    kind: "leftover",
    edited: true,
    stale: true,
    texts: p2Texts,
    proposed: { units: 4, at: at(-HOUR) },
  });

  const p3 = await CodeProduct.create({
    name: "Old OW icon",
    gameNo: "12",
    gameName: "Overwatch 2",
    marketGame: "Overwatch",
    slots: [{ slotKey: SLOT.A, label: "Old Icon Label", image: "", nameRaw: SLOT_INFO[SLOT.A].nameRaw }],
    status: "retired",
    origin: "adopted",
    kind: "custom",
    offer: o3,
    texts: { title: "", description: "", deliveryTemplate: "" },
    pricing: { mode: "fixed", priceUsd: 0.9, floorUsd: 0.5 },
    retiredAt: at(-DAY),
  });

  // Units: P1 has every status; P3 only history.
  const units = [];
  for (const [i, status] of ["available", "available", "fed", "sold", "sold", "removed"].entries()) {
    units.push(await unit(o1, status, "p1-" + i));
  }
  for (const [i, status] of ["sold", "sold", "sold", "removed"].entries()) await unit(o3, status, "p3-" + i);
  const [avail1, avail2, fed1, sold1, sold2] = units;

  // Listings. insertMany: the save hook writes audit rows we do not want here.
  await MarketplaceListing.insertMany([
    { accountOffer: o1, marketplace: "eldorado", externalId: "eld-old-1", url: "https://eldorado.example.test/o/old", price: 3, status: "delisted", lastError: "stale error", note: "code shop", createdAt: at(-9 * DAY) },
    { accountOffer: o1, marketplace: "eldorado", externalId: "eld-live-1", url: "https://eldorado.example.test/o/live", price: 2.5, status: "active", autoPaused: false, note: "code shop", createdAt: at(-8 * DAY) },
    { accountOffer: o1, marketplace: "ggsel", externalId: "gg-live-1", url: "https://ggsel.example.test/p/1", price: 2.5, status: "active", autoPaused: true, lastError: "vault low", note: "code shop", createdAt: at(-7 * DAY), units: [{ contentId: "c1", login: "cs-unit-p1-2" }] },
    { accountOffer: o3, marketplace: "eldorado", externalId: "eld-p3-a", price: 0.9, status: "delisted", lastError: "older failure", createdAt: at(-30 * DAY) },
    { accountOffer: o3, marketplace: "eldorado", externalId: "eld-p3-b", price: 0.9, status: "delisted", lastError: "", createdAt: at(-2 * DAY) },
    { accountOffer: new ObjectId(), marketplace: "eldorado", externalId: "someone-else", price: 5, status: "active" },
  ]);

  // Ledger. Slot A: usable free = 2 far + 1 unknown use-by = 3 (one inside the
  // 36 h lead, one without a hash are not buildable).
  await many(2, SLOT.A, "in_stock", { useBy: at(10 * DAY) });
  await code(SLOT.A, "in_stock", { useBy: at(20 * HOUR) });
  await code(SLOT.A, "in_stock", { useBy: null });
  await code(SLOT.A, "in_stock", { useBy: at(5 * DAY), noHash: true });
  await many(5, SLOT.B, "in_stock", { useBy: at(15 * DAY) });
  await many(2, SLOT.C, "in_stock", { useBy: at(15 * DAY) });
  for (const u of [avail1, avail2]) {
    for (const s of [SLOT.A, SLOT.B, SLOT.C]) await code(s, "in_unit", { unit: u._id, product: p1._id, unitStatus: "available" });
  }
  for (const s of [SLOT.A, SLOT.B, SLOT.C]) await code(s, "in_unit", { unit: fed1._id, product: p1._id, unitStatus: "fed" });
  const price = { [SLOT.A]: 0.8, [SLOT.B]: 0.85, [SLOT.C]: 0.85 };
  for (const [u, when] of [[sold1, at(-2 * HOUR)], [sold2, at(-3 * DAY)]]) {
    for (const s of [SLOT.A, SLOT.B, SLOT.C]) {
      await code(s, "sold", { unit: u._id, product: p1._id, unitStatus: "sold", soldAt: when, saleUsd: price[s] });
    }
  }
  await code(SLOT.A, "dead", { product: p3._id, unitStatus: "sold", soldAt: at(-10 * DAY), saleUsd: 0.8 });
  await code(SLOT.A, "held", { problem: "left in a GGSel vault by a failed publish" });
  await code(SLOT.B, "expiring", { useBy: at(10 * HOUR) });
  await many(2, SLOT.C, "expired", { useBy: at(-DAY) });
  await many(6, SLOT.D, "in_stock", { useBy: at(40 * DAY) });
  await code(SLOT.D, "sold", { soldAt: at(-40 * DAY), saleUsd: 1.5, loginId: "login-1" });
  await code(SLOT.D, "sold", { soldAt: null, saleUsd: 0.5, loginId: "login-1" });
  await many(4, SLOT.E, "in_stock", { useBy: null });
  await code(SLOT.E, "held", { problem: "duplicate code" });
  await code(SLOT.F, "in_stock", { useBy: null, earnedAt: null, loginId: "login-4" });

  const cookies = encrypt(JSON.stringify([{ name: "AuthTicket", value: "FAKE-COOKIE-TICKET" }]));
  secrets.add(cookies);
  secrets.add("FAKE-COOKIE-TICKET");
  await SoopAccount.create({ loginId: "login-1", nickname: "TeaFarmer", cookies });
  await SoopAccount.create({ loginId: "login-2", nickname: "", cookies });

  return { p1, p2, p3, o1, o3 };
}

const byId = (list, id) => list.find((p) => p.id === String(id));

// ------------------------------------------------------------------ state()

const PRODUCT_KEYS = [
  "id", "name", "status", "origin", "kind", "stale", "edited", "gameNo", "gameName", "marketGame", "slots", "units",
  "freeUnits", "proposed", "useBy", "pricing", "markets", "listings", "competitors", "publish", "problems",
].sort();

test("state(): top-level shape, config, adoptable/lastTick defaults and extras", async () => {
  const st = await viewsWith().state();
  assert.deepEqual(Object.keys(st).sort(), ["adoptable", "config", "lastTick", "products", "summary"]);
  assert.deepEqual(st.config, CFG);
  assert.equal(st.adoptable, 0);
  assert.equal(st.lastTick, null);

  const tick = { at: at(-60 * 1000), ms: 812, steps: { ingest: { added: 1 }, fill: { error: "boom" } } };
  const withExtras = await viewsWith({ extras: async () => ({ adoptable: 2, lastTick: tick }) }).state();
  assert.equal(withExtras.adoptable, 2);
  assert.deepEqual(withExtras.lastTick, tick);

  const broken = await viewsWith({ extras: () => { throw new Error("nope"); } }).state();
  assert.equal(broken.adoptable, 0);
  assert.equal(broken.lastTick, null);
});

test("state(): summary counts every ledger state and the revenue windows", async () => {
  const { summary } = await viewsWith().state();
  assert.deepEqual(summary, {
    inStock: 23, // A 5 (one without a hash still counts), B 5, C 2, D 6, E 4, F 1
    onSale: 6,
    inVault: 3,
    sold: 8,
    expiring: 1,
    expired: 2,
    held: 2,
    dead: 1,
    drafts: 1,
    // d1: unit sold 2 h ago (0.80 + 0.85 + 0.85); d7: + the one 3 days ago;
    // d30: + the dead code 10 days ago; all: + 1.50 forty days ago + 0.50 with no soldAt.
    revenue: { d1: 2.5, d7: 5, d30: 5.8, all: 7.8 },
  });

  // Independently from what was seeded.
  const n = (pred) => ledger.filter(pred).length;
  assert.equal(summary.inStock, n((r) => r.state === "in_stock"));
  assert.equal(summary.sold, n((r) => r.state === "sold"));
  assert.equal(summary.onSale + summary.inVault, n((r) => r.state === "in_unit"));
});

test("state(): products, retired included, exact view shape and values", async () => {
  const { products } = await viewsWith().state();
  assert.equal(products.length, 3);
  assert.deepEqual(products.map((p) => p.status), ["draft", "active", "retired"]);
  for (const p of products) assert.deepEqual(Object.keys(p).sort(), PRODUCT_KEYS);

  const p1 = byId(products, shop.p1._id);
  assert.deepEqual(p1, {
    id: String(shop.p1._id),
    name: "OW tea full set",
    status: "active",
    origin: "auto",
    kind: "full",
    stale: false,
    edited: false,
    gameNo: "12",
    gameName: "Overwatch 2",
    marketGame: "Overwatch",
    slots: [
      { slotKey: SLOT.A, label: "Tea Player Icon", image: "https://img.example.test/a.png", nameRaw: "Sun Tea Player Icon" },
      { slotKey: SLOT.B, label: "Tea Spray", image: "https://img.example.test/b.png", nameRaw: "Tea Festival Spray" },
      { slotKey: SLOT.C, label: "Tea Name Card", image: "", nameRaw: "Tea Name Card" },
    ],
    units: { available: 2, fed: 1, sold: 2, removed: 1 },
    freeUnits: 2, // min(A 3, B 5, C 2)
    proposed: { units: 3, at: at(-5 * DAY) },
    useBy: at(20 * HOUR),
    pricing: { mode: "auto", priceUsd: 2.5, floorUsd: 1, clearance: true, followCompetitors: false, lastChangeAt: at(-2 * DAY), lastReason: "clearance 25%" },
    markets: ["eldorado", "ggsel"],
    listings: [
      // The older delisted Eldorado row is hidden: Eldorado has a live one.
      { market: "eldorado", externalId: "eld-live-1", url: "https://eldorado.example.test/o/live", price: 2.5, status: "active", autoPaused: false, lastError: "" },
      { market: "ggsel", externalId: "gg-live-1", url: "https://ggsel.example.test/p/1", price: 2.5, status: "active", autoPaused: true, lastError: "vault low" },
    ],
    competitors: { scannedAt: at(-3 * HOUR), lowestSameSetUsd: 1.99, count: 3 },
    publish: { lastError: "", lastAttemptAt: at(-HOUR) },
    problems: [],
  });

  const p2 = byId(products, shop.p2._id);
  assert.equal(p2.status, "draft");
  assert.equal(p2.stale, true);
  assert.equal(p2.edited, true);
  assert.equal(p2.kind, "leftover");
  assert.deepEqual(p2.units, { available: 0, fed: 0, sold: 0, removed: 0 });
  assert.equal(p2.freeUnits, 4); // min(D 6, E 4)
  assert.deepEqual(p2.listings, []);
  assert.deepEqual(p2.proposed, { units: 4, at: at(-HOUR) });
  assert.equal(p2.useBy, null);
  assert.deepEqual(p2.competitors, { scannedAt: null, lowestSameSetUsd: null, count: 0 });
  assert.deepEqual(p2.pricing, { mode: "fixed", priceUsd: 1, floorUsd: 0.5, clearance: false, followCompetitors: false, lastChangeAt: null, lastReason: "" });
  assert.ok(p2.problems.includes("label 2 is empty"), p2.problems.join(" | "));
  assert.ok(p2.problems.some((x) => /description names where the codes come from/.test(x)), p2.problems.join(" | "));

  const p3 = byId(products, shop.p3._id);
  assert.equal(p3.status, "retired");
  assert.equal(p3.origin, "adopted");
  assert.deepEqual(p3.units, { available: 0, fed: 0, sold: 3, removed: 1 });
  assert.equal(p3.freeUnits, 3); // slot A alone
  // Only the newest of the taken-down Eldorado rows: an old error is not news.
  assert.deepEqual(p3.listings, [
    { market: "eldorado", externalId: "eld-p3-b", url: "", price: 0.9, status: "delisted", autoPaused: false, lastError: "" },
  ]);
  assert.ok(p3.problems.includes("title is empty"));
});

test("state(): freeUnits is what planUnits builds for the product alone (lead respected)", async () => {
  const { products } = await viewsWith().state();
  const free = await CodeStock.find({ state: "in_stock", codeHash: { $gt: "" } }, { slotKey: 1, useBy: 1, earnedAt: 1 }).lean();
  for (const p of products) {
    const { plans } = planUnits({
      products: [{ id: p.id, slots: p.slots.map((s) => s.slotKey) }],
      free: free.map((r) => ({ id: r._id, slotKey: r.slotKey, useBy: r.useBy, earnedAt: r.earnedAt })),
      now: NOW,
      leadMs: CFG.expiryLeadHours * HOUR,
    });
    assert.equal(p.freeUnits, plans[0].units.length, p.name);
  }

  // A longer lead takes the slot-A code that is 10 days out off the count too.
  const longLead = deepMerge(CFG, { expiryLeadHours: 24 * 11 });
  const st = await createViews({ config: fakeConfig(longLead), now: () => NOW }).state();
  assert.equal(byId(st.products, shop.p1._id).freeUnits, 1); // A: only the unknown use-by is left
});

test("state(): freeUnits skips codes of a sold farm login, as fill does", async () => {
  const before = await viewsWith().state();
  await SoopAccount.updateOne({ loginId: "login-2" }, { $set: { sold: true } });
  try {
    const { products } = await viewsWith().state();
    const free = await CodeStock.find(
      { state: "in_stock", codeHash: { $gt: "" }, loginId: { $ne: "login-2" } },
      { slotKey: 1, useBy: 1, earnedAt: 1 },
    ).lean();
    let dropped = 0;
    for (const p of products) {
      const { plans } = planUnits({
        products: [{ id: p.id, slots: p.slots.map((s) => s.slotKey) }],
        free: free.map((r) => ({ id: r._id, slotKey: r.slotKey, useBy: r.useBy, earnedAt: r.earnedAt })),
        now: NOW,
        leadMs: CFG.expiryLeadHours * HOUR,
      });
      assert.equal(p.freeUnits, plans[0].units.length, p.name);
      dropped += byId(before.products, p.id).freeUnits - p.freeUnits;
    }
    assert.ok(dropped > 0, "the sold login's codes really were counted before");
  } finally {
    await SoopAccount.updateOne({ loginId: "login-2" }, { $set: { sold: false } });
  }
});

test("freeUnitsFor: repeated slots, blank keys, no slots and the per-run cap match planUnits", () => {
  const counts = new Map([["x", 7], ["y", 3], ["big", 1000]]);
  assert.equal(freeUnitsFor([{ slotKey: "x" }, { slotKey: "x" }], counts), 3);
  assert.equal(freeUnitsFor([{ slotKey: "x" }, { slotKey: "y" }], counts), 3);
  assert.equal(freeUnitsFor([{ slotKey: "x" }, { slotKey: "" }], counts), 0);
  assert.equal(freeUnitsFor([], counts), 0);
  assert.equal(freeUnitsFor([{ slotKey: "missing" }], counts), 0);
  const capped = freeUnitsFor([{ slotKey: "big" }], counts);
  const rows = Array.from({ length: 1000 }, (_, i) => ({ id: "r" + i, slotKey: "big", useBy: null }));
  const { plans } = planUnits({ products: [{ id: "p", slots: ["big"] }], free: rows, now: NOW });
  assert.equal(capped, plans[0].units.length);
  assert.equal(capped, 200);
});

test("state(): problems come from the injected publisher check when given", async () => {
  const seen = [];
  const views = viewsWith({
    problems: async (p) => {
      seen.push(String(p._id));
      assert.ok(p.texts && Array.isArray(p.slots) && p.pricing, "the check gets the product's texts, slots and pricing");
      return p.status === "draft" ? ["price below the floor"] : [];
    },
  });
  const { products } = await views.state();
  assert.equal(seen.length, 3);
  assert.deepEqual(byId(products, shop.p2._id).problems, ["price below the floor"]);
  assert.deepEqual(byId(products, shop.p1._id).problems, []);

  const failing = await viewsWith({ problems: () => { throw new Error("config down"); } }).state();
  for (const p of failing.products) assert.deepEqual(p.problems, ["could not check this product: config down"]);
});

test("defaultProblems: no slots, then the buyer-text guard on texts and labels", () => {
  const out = defaultProblems({ slots: [], texts: { title: "Fine title", deliveryTemplate: "{password}", coverTitle: "C", coverServiceText: "S" } }, CFG);
  assert.deepEqual(out, ["no slots: the bundle holds no codes"]);
  const kr = defaultProblems({ slots: [{ slotKey: "s", label: "KR skin" }], texts: { title: "T", deliveryTemplate: "{password}", coverTitle: "C", coverServiceText: "S" } }, CFG);
  assert.ok(kr.some((x) => /label 1 names where the codes come from/.test(x)), kr.join(" | "));
});

// ------------------------------------------------------------------ product()

test("product(id): the list view plus texts, competitor offers and queries", async () => {
  const views = viewsWith();
  const { products } = await views.state();
  const res = await views.product(String(shop.p1._id));
  assert.deepEqual(Object.keys(res), ["product"]);
  const d = res.product;
  assert.deepEqual(Object.keys(d).sort(), [...PRODUCT_KEYS, "texts"].sort());

  const listView = byId(products, shop.p1._id);
  const { texts, competitors, ...rest } = d;
  const { competitors: listComp, ...listRest } = listView;
  assert.deepEqual(rest, listRest);

  const t = shop.p1.texts;
  assert.deepEqual(texts, {
    title: t.title,
    description: t.description,
    deliveryTemplate: t.deliveryTemplate,
    coverTitle: t.coverTitle,
    coverServiceText: t.coverServiceText,
    coverBullets: [...t.coverBullets],
  });
  assert.deepEqual(competitors, {
    ...listComp,
    queries: ["tea player icon", "Overwatch 2 codes"],
    offers: [
      { id: "off-1", title: "Tea set all codes", priceUsd: 1.99, qty: 4, score: 1, sameSet: true, matchedIn: "description", form: "codes" },
      { id: "off-2", title: "Tea spray code", priceUsd: 0.7, qty: 10, score: 0.34, sameSet: false, matchedIn: "title", form: "account" },
      // A row stored before the fields existed reads them as "".
      { id: "off-3", title: "Tea bundle", priceUsd: 2.2, qty: 1, score: 0.67, sameSet: false, matchedIn: "", form: "" },
    ],
  });

  // An ObjectId works as well as its hex string; a retired product is readable.
  const retired = await views.product(shop.p3._id);
  assert.equal(retired.product.status, "retired");
  assert.deepEqual(retired.product.competitors.offers, []);
});

test("product(id): an unknown or malformed id is a 404", async () => {
  const views = viewsWith();
  for (const id of [String(new ObjectId()), "not-an-id", "", null, undefined]) {
    await assert.rejects(views.product(id), (err) => {
      assert.equal(err.status, 404, String(id));
      return true;
    });
  }
});

// ------------------------------------------------------------------ stock()

test("stock(): games -> campaign groups -> slots, counts, labels and next use-by", async () => {
  const st = await viewsWith().stock();
  assert.deepEqual(Object.keys(st).sort(), ["games", "held"]);
  assert.deepEqual(st.games.map((g) => [g.gameNo, g.gameName]), [["12", "Overwatch 2"], ["200", "Delta Force"]]);

  const ow = st.games[0];
  assert.deepEqual(Object.keys(ow).sort(), ["gameName", "gameNo", "groups"]);
  assert.equal(ow.groups.length, 1);
  const tea = ow.groups[0];
  assert.deepEqual(Object.keys(tea).sort(), ["campaignEndAt", "campaignTitle", "groupKey", "slots"]);
  assert.equal(tea.groupKey, "12:501");
  assert.equal(tea.campaignTitle, "Tea Festival");
  assert.deepEqual(tea.campaignEndAt, at(5 * DAY));
  assert.deepEqual(tea.slots.map((s) => s.slotKey), [SLOT.A, SLOT.B, SLOT.C]);
  for (const s of tea.slots) assert.deepEqual(Object.keys(s).sort(), ["counts", "image", "label", "nameRaw", "nextUseBy", "slotKey"]);

  const [a, b, c] = tea.slots;
  assert.deepEqual(a, {
    slotKey: SLOT.A,
    // The active product's label, not the retired one's ("Old Icon Label") nor the raw name.
    label: "Tea Player Icon",
    nameRaw: "Sun Tea Player Icon",
    image: "https://img.example.test/a.png",
    counts: { in_stock: 5, in_unit: 3, sold: 2, expiring: 0, expired: 0, held: 1, dead: 1 },
    // Earliest in-stock use-by, even inside the lead.
    nextUseBy: at(20 * HOUR),
  });
  assert.deepEqual(b.counts, { in_stock: 5, in_unit: 3, sold: 2, expiring: 1, expired: 0, held: 0, dead: 0 });
  // The expiring row (10 h) is not in stock: only in-stock rows set next use-by.
  assert.deepEqual(b.nextUseBy, at(15 * DAY));
  assert.deepEqual(c.counts, { in_stock: 2, in_unit: 3, sold: 2, expiring: 0, expired: 2, held: 0, dead: 0 });

  const df = st.games[1];
  // Newest campaign first.
  assert.deepEqual(df.groups.map((g) => [g.groupKey, g.campaignTitle]), [["200:77", "Camo Week"], ["200:78", "Gold Rush"]]);
  const [d, e] = df.groups[0].slots;
  assert.equal(d.slotKey, SLOT.D);
  assert.equal(d.label, "Camo Pack"); // a draft's label counts
  assert.deepEqual(d.counts, { in_stock: 6, in_unit: 0, sold: 2, expiring: 0, expired: 0, held: 0, dead: 0 });
  assert.equal(e.slotKey, SLOT.E);
  // The draft has no label for it and the default label refuses a source word: the row's name.
  assert.equal(e.label, "KR Exclusive Skin");
  assert.equal(e.nameRaw, "Exclusive Skin (raw)");
  assert.equal(e.nextUseBy, null);
  const [f] = df.groups[1].slots;
  assert.equal(f.label, "Gold Ticket"); // no product at all: the default label
  assert.equal(f.nextUseBy, null);

  // Every ledger row is counted exactly once.
  let total = 0;
  for (const g of st.games) for (const gr of g.groups) for (const s of gr.slots) total += Object.values(s.counts).reduce((x, y) => x + y, 0);
  assert.equal(total, ledger.length);
});

test("stock(): the held list names the login, the slot label and the problem", async () => {
  const { held } = await viewsWith().stock();
  for (const h of held) {
    assert.deepEqual(Object.keys(h).sort(), ["id", "label", "loginId", "problem", "releasable"]);
    assert.match(h.id, /^[0-9a-f]{24}$/);
    assert.equal(h.releasable, /stored code is missing or changed|its stock row is gone|its code was shown in the farm panel/.test(h.problem));
  }
  const want = ledger
    .filter((r) => r.state === "held")
    .map((r) => ({ loginId: r.loginId, label: r.slotKey === SLOT.A ? "Tea Player Icon" : "KR Exclusive Skin", problem: r.problem }));
  const key = (h) => h.loginId + "|" + h.label + "|" + h.problem;
  assert.deepEqual(held.map(key).sort(), want.map(key).sort());
});

// ------------------------------------------------------------------ logins()

test("logins(): per-login counts, sales, last earned time and nickname", async () => {
  const { logins } = await viewsWith().logins();
  for (const l of logins) {
    assert.deepEqual(Object.keys(l).sort(), ["codes", "inStock", "lastEarnedAt", "loginId", "nick", "onSale", "sold", "usd"]);
  }
  const ids = [...new Set(ledger.map((r) => r.loginId))].sort();
  assert.deepEqual(logins.map((l) => l.loginId).sort(), ids);
  // Most codes first.
  for (let i = 1; i < logins.length; i++) assert.ok(logins[i - 1].codes >= logins[i].codes);

  for (const id of ids) {
    const rows = ledger.filter((r) => r.loginId === id);
    const soldRows = rows.filter((r) => r.state === "sold" || r.state === "dead");
    const earned = rows.map((r) => r.earnedAt).filter(Boolean).map((d) => d.getTime());
    const got = logins.find((l) => l.loginId === id);
    assert.deepEqual(got, {
      loginId: id,
      nick: id === "login-1" ? "TeaFarmer" : "",
      codes: rows.length,
      inStock: rows.filter((r) => r.state === "in_stock").length,
      onSale: rows.filter((r) => r.state === "in_unit").length,
      sold: soldRows.length,
      usd: Math.round(soldRows.reduce((s, r) => s + r.saleUsd, 0) * 100) / 100,
      lastEarnedAt: earned.length ? new Date(Math.max(...earned)) : null,
    });
  }
  // login-4 earned its only code at an unknown time and has no farm account.
  assert.deepEqual(logins.find((l) => l.loginId === "login-4"), {
    loginId: "login-4", nick: "", codes: 1, inStock: 1, onSale: 0, sold: 0, usd: 0, lastEarnedAt: null,
  });
});

// ------------------------------------------------------------------ secrets

test("no view carries a code, codeHash, codeEnc, unit password or cookie", async () => {
  const views = viewsWith();
  const out = {
    state: await views.state(),
    p1: await views.product(String(shop.p1._id)),
    p2: await views.product(String(shop.p2._id)),
    p3: await views.product(String(shop.p3._id)),
    stock: await views.stock(),
    logins: await views.logins(),
  };
  for (const [name, view] of Object.entries(out)) {
    const json = JSON.stringify(view);
    const keys = json.match(/"(code|codeHash|codeEnc|codeShape|password|clientSecret|cookies|history|after)"\s*:/g);
    assert.equal(keys, null, `${name} has a forbidden key: ${keys}`);
    for (const s of secrets) assert.ok(!json.includes(s), `${name} leaks a secret value`);
    assert.ok(!/[0-9a-f]{64}/.test(json), `${name} holds something shaped like a code hash`);
    assert.ok(!json.includes("enc:v1:"), `${name} holds an encrypted value`);
  }
  assert.ok(secrets.size > 100, "the scan really had secrets to look for");
});

test("an empty shop: zeros everywhere, no products, no games, no logins", async () => {
  const empty = Object.fromEntries(MODELS.map((m) => [m.modelName, emptyModel(m)]));
  const views = createViews({ config: fakeConfig(), now: () => NOW, models: empty });
  const st = await views.state();
  assert.deepEqual(st.summary, {
    inStock: 0, onSale: 0, inVault: 0, sold: 0, expiring: 0, expired: 0, held: 0, dead: 0, drafts: 0,
    revenue: { d1: 0, d7: 0, d30: 0, all: 0 },
  });
  assert.deepEqual(st.products, []);
  assert.deepEqual(await views.stock(), { games: [], held: [] });
  assert.deepEqual(await views.logins(), { logins: [] });
});

// The same model on a collection nobody wrote to.
function emptyModel(m) {
  const name = "Empty" + m.modelName;
  return mongoose.models[name] || mongoose.model(name, m.schema, "empty_" + m.collection.collectionName);
}
