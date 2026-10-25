/* global fetch */
// Code shop — the Listings board (utils/codeShop/board.js, GET /api/code-shop/board,
// docs/code-shop/08-LISTINGS-BOARD.md). What these pin:
//   - the numbers: per game, campaign, reward, product, market and farm, the
//     same counts the Sales tab uses (onSale = in a bundle on a shelf);
//   - where it is listed: one entry per live listing (else the newest one per
//     market) with its link and a plain state (live / paused / error / down);
//   - where it sold: per product and market, the newest sales first, bundles per
//     day in the viewer's time zone, with the farm each sale came from;
//   - the pictures: Twitch box art by game name (with the alias list), campaign
//     banners from both farms, reward pictures; only http(s) URLs pass;
//   - what never leaves: no code, hash, code shape, unit login or password, no
//     farm login id;
//   - the route: answers the board, clamps its query, and is superadmin-only
//     (the table test in codeShopRoutes.test.js covers anonymous and sellers).
// Real Mongo via mongodb-memory-server. Every value is made up.
process.env.CRED_SECRET ||= "code-shop-board-test";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const CodeStock = require("../models/CodeStock");
const CodeProduct = require("../models/CodeProduct");
const SuppliedAccount = require("../models/SuppliedAccount");
const MarketplaceListing = require("../models/MarketplaceListing");
const SoopCampaign = require("../models/SoopCampaign");
const ChzzkCampaign = require("../models/ChzzkCampaign");
const TwitchCampaign = require("../models/TwitchCampaign");
const { DEFAULTS, deepMerge } = require("../utils/codeShop/config");
const board = require("../utils/codeShop/board");
const codeShopRoutes = require("../routes/codeShopRoutes");

const ObjectId = mongoose.Types.ObjectId;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
// 20:00 UTC = 05:00 the next day in Tokyo, so the two zones disagree on "today".
const NOW = Date.UTC(2026, 9, 25, 20, 0, 0);
const ALL = [CodeStock, CodeProduct, SuppliedAccount, MarketplaceListing, SoopCampaign, ChzzkCampaign, TwitchCampaign];
const MODELS = { CodeStock, CodeProduct, SuppliedAccount, MarketplaceListing, SoopCampaign, ChzzkCampaign, TwitchCampaign };

const SOOP_LOGIN = "soop-login-sentinel";
const CHZ_A = "chzzk:" + new ObjectId();
const CHZ_B = "chzzk:" + new ObjectId();
const SLOT_A = "12:13787:aaaaaaaaaa:1";
const SLOT_B = "12:chzzk-1954:bbbbbbbbbb:1";
const SLOT_C = "910003:chzzk-1962:cccccccccc:1";
const SLOT_D = "9217747:chzzk-1992:dddddddddd:1";

const cfgData = {
  markets: { eldorado: true, playerauctions: true },
  autoPublish: true,
  games: {
    12: { sell: true, displayName: "Overwatch 2", marketGame: "Overwatch" },
    910003: { sell: true },
  },
};
const staticConfig = (data = cfgData) => ({ get: async () => deepMerge(DEFAULTS, data) });

let mem;
test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshopboard"));
  await Promise.all(ALL.map((m) => m.init()));
});
test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

// ---- seed ------------------------------------------------------------------------

const ids = {};
let seq = 0;
function code(over) {
  seq += 1;
  return {
    _id: new ObjectId(),
    loginId: SOOP_LOGIN,
    itemKey: "k" + seq,
    gameNo: "12",
    gameName: "Overwatch",
    groupKey: "12:13787",
    campaignIdx: "13787",
    campaignTitle: "OW league",
    campaignEndAt: new Date(NOW - DAY),
    slotKey: SLOT_A,
    nameRaw: "Spray",
    name: "Spray",
    image: "https://img.test/spray.png",
    codeHash: "hash-sentinel-" + seq,
    codeShape: "99:9-9-9",
    earnedAt: new Date(NOW - 5 * DAY),
    useBy: new Date(NOW + 30 * DAY),
    state: "in_stock",
    unit: null,
    product: null,
    offer: null,
    unitStatus: "",
    soldAt: null,
    market: "",
    orderId: "",
    saleUsd: 0,
    problem: "",
    history: [],
    createdAt: new Date(NOW - 5 * DAY),
    updatedAt: new Date(NOW - 5 * DAY),
    ...over,
  };
}
const sold = (unit, product, market, usd, at, over = {}) =>
  code({ state: "sold", unit, product, market, saleUsd: usd, soldAt: new Date(at), orderId: "order-" + market + "-" + at, ...over });

async function seed() {
  await Promise.all(ALL.map((m) => m.deleteMany({})));
  seq = 0;
  for (const k of ["P1", "P2", "P3", "P4", "P5", "P6", "O1", "O2", "O3", "O4", "O6", "UA1", "UA2", "UA3", "US1", "US2", "UC1", "UC2", "UR1", "UM1"]) ids[k] = new ObjectId();

  await SoopCampaign.collection.insertOne({
    dropsIdx: "13787", title: "OW league", image: "https://img.test/soop-ow.png", gameNo: "12",
    startDate: new Date(NOW - 10 * DAY), endDate: new Date(NOW - DAY),
  });
  await ChzzkCampaign.collection.insertMany([
    { campaignNo: 1954, title: "Runner league", categoryId: "OVERWATCH", imageUrl: "https://img.test/chzzk-ow.png", startAt: new Date(NOW - 5 * DAY), endAt: new Date(NOW + 2 * DAY), rewards: [] },
    { campaignNo: 1962, title: "Stella event", categoryId: "stellasora", imageUrl: "javascript:alert(1)", startAt: new Date(NOW - 2 * DAY), endAt: new Date(NOW + DAY), rewards: [] },
  ]);
  await TwitchCampaign.collection.insertMany([
    { campaignId: "t1", game: "Overwatch", boxArt: "https://static.test/ttv-boxart/515025-{width}x{height}.jpg" },
    { campaignId: "t2", game: "Stella Sora", boxArt: "javascript:alert(1)" },
    { campaignId: "t3", game: "Eternal Return", boxArt: "https://static.test/er-{width}x{height}.jpg" },
  ]);

  const product = (over) => ({
    gameName: "Overwatch",
    marketGame: "Overwatch",
    origin: "auto",
    kind: "full",
    edited: false,
    stale: false,
    texts: { title: "Overwatch 2 | Redeem Code", description: "made up" },
    pricing: { mode: "fixed", priceUsd: 1, floorUsd: 0.5 },
    useBy: new Date(NOW + 30 * DAY),
    createdAt: new Date(NOW - 6 * DAY),
    ...over,
  });
  await CodeProduct.collection.insertMany([
    product({ _id: ids.P1, name: "OW Spray", gameNo: "12", groupKeys: ["12:13787"], status: "active", offer: ids.O1,
      slots: [{ slotKey: SLOT_A, label: "Spray", image: "https://img.test/spray.png", nameRaw: "Spray" }],
      markets: ["eldorado", "playerauctions"], texts: { title: "Overwatch 2 | Spray | Redeem Code" }, updatedAt: new Date(NOW - HOUR) }),
    product({ _id: ids.P2, name: "OW Epic", gameNo: "12", groupKeys: ["12:chzzk-1954"], status: "active", offer: ids.O2,
      slots: [{ slotKey: SLOT_B, label: "Epic Loot Box", image: "https://img.test/epic.png", nameRaw: "특급 전리품 상자" }],
      markets: ["eldorado"], updatedAt: new Date(NOW - HOUR) }),
    product({ _id: ids.P3, name: "OW old", gameNo: "12", groupKeys: ["12:13787"], status: "retired", offer: ids.O3,
      slots: [{ slotKey: SLOT_A, label: "Old Spray", image: "https://img.test/old-spray-gone.png", nameRaw: "Spray" }], markets: ["eldorado"], updatedAt: new Date(NOW) }),
    product({ _id: ids.P4, name: "OW never sold", gameNo: "12", groupKeys: ["12:13787"], status: "retired", offer: ids.O4,
      slots: [{ slotKey: SLOT_A, label: "Spray", image: "", nameRaw: "Spray" }], markets: ["eldorado"], updatedAt: new Date(NOW) }),
    product({ _id: ids.P5, name: "Stella draft", gameNo: "910003", gameName: "Stella Sora", marketGame: "", groupKeys: ["910003:chzzk-1962"],
      status: "draft", offer: null, slots: [{ slotKey: SLOT_C, label: "Gems", image: "https://img.test/gems.png", nameRaw: "Gems" }],
      markets: ["eldorado"], updatedAt: new Date(NOW - HOUR) }),
    product({ _id: ids.P6, name: "OW mix", gameNo: "12", groupKeys: ["12:13787", "12:chzzk-1954"], status: "active", kind: "custom", origin: "manual",
      offer: ids.O6, markets: ["playerauctions"], updatedAt: new Date(NOW - 2 * HOUR),
      slots: [{ slotKey: SLOT_A, label: "Spray Mix", image: "", nameRaw: "Spray" }, { slotKey: SLOT_B, label: "Epic Box", image: "", nameRaw: "특급 전리품 상자" }] }),
  ]);

  const unit = (_id, offer, status) => ({ _id, offer, login: "unit-login-sentinel-" + String(_id), loginLower: "unit-login-sentinel-" + String(_id), password: "pw-sentinel", status });
  await SuppliedAccount.collection.insertMany([
    unit(ids.UA1, ids.O1, "available"), unit(ids.UA2, ids.O1, "available"), unit(ids.UA3, ids.O1, "available"),
    unit(ids.US1, ids.O1, "sold"), unit(ids.US2, ids.O1, "sold"),
    unit(ids.UC1, ids.O2, "available"), unit(ids.UC2, ids.O2, "sold"),
    unit(ids.UR1, ids.O3, "sold"),
    unit(ids.UM1, ids.O6, "sold"),
    unit(new ObjectId(), ids.O4, "removed"),
  ]);

  const listing = (offer, marketplace, externalId, status, over = {}) => ({
    accountOffer: offer, marketplace, externalId, status, price: marketplace === "eldorado" ? 1 : 5, origin: "manual",
    url: marketplace === "eldorado" ? "https://www.eldorado.test/i?offerId=" + externalId : "https://www.playerauctions.test/i/" + externalId + "/",
    autoPaused: false, lastError: "", createdAt: new Date(NOW - 5 * DAY), ...over,
  });
  await MarketplaceListing.collection.insertMany([
    listing(ids.O1, "eldorado", "E-1", "active"),
    listing(ids.O1, "playerauctions", "PA-OLD", "delisted", { createdAt: new Date(NOW - 6 * DAY) }),
    listing(ids.O1, "playerauctions", "PA-1", "active", { createdAt: new Date(NOW - 4 * DAY) }),
    listing(ids.O2, "eldorado", "E-2", "active", { autoPaused: true }),
    listing(ids.O3, "eldorado", "E-3", "delisted"),
    listing(ids.O6, "playerauctions", "PA-6", "error", { lastError: "PA said no" }),
  ]);

  await CodeStock.collection.insertMany([
    // SOOP Overwatch, slot A
    code({ useBy: new Date(NOW + 5 * DAY) }),
    code({ useBy: new Date(NOW + 3 * DAY) }),
    code({ state: "in_unit", unit: ids.UA1, product: ids.P1, unitStatus: "available" }),
    code({ state: "in_unit", unit: ids.UA2, product: ids.P1, unitStatus: "available" }),
    code({ state: "in_unit", unit: ids.UA3, product: ids.P1, unitStatus: "available", useBy: new Date(NOW + 2 * DAY) }),
    sold(ids.US1, ids.P1, "eldorado", 1, NOW - 2 * HOUR),
    sold(ids.US2, ids.P1, "playerauctions", 5, NOW - 3 * DAY, { state: "dead" }),
    sold(ids.UR1, ids.P3, "eldorado", 2, NOW - 40 * DAY),
    sold(ids.UM1, ids.P6, "playerauctions", 1.5, NOW - HOUR),
    code({ state: "expiring" }),
    code({ state: "expired" }),
    code({ state: "held", problem: "its code was shown in the farm panel" }),
    // CHZZK Overwatch, slot B
    code({ loginId: CHZ_A, gameName: "Overwatch 2", groupKey: "12:chzzk-1954", campaignIdx: "chzzk-1954", campaignTitle: "Runner league",
      slotKey: SLOT_B, nameRaw: "특급 전리품 상자", name: "특급 전리품 상자", image: "https://img.test/epic.png",
      state: "in_unit", unit: ids.UC1, product: ids.P2, unitStatus: "available", updatedAt: new Date(NOW - DAY) }),
    sold(ids.UC2, ids.P2, "eldorado", 1, NOW - 10 * DAY, { loginId: CHZ_A, gameName: "Overwatch 2", groupKey: "12:chzzk-1954",
      campaignIdx: "chzzk-1954", slotKey: SLOT_B, nameRaw: "특급 전리품 상자", name: "특급 전리품 상자", image: "https://img.test/epic.png" }),
    sold(ids.UM1, ids.P6, "playerauctions", 1.5, NOW - HOUR, { loginId: CHZ_A, gameName: "Overwatch 2", groupKey: "12:chzzk-1954",
      campaignIdx: "chzzk-1954", slotKey: SLOT_B, nameRaw: "특급 전리품 상자", name: "특급 전리품 상자", image: "https://img.test/epic.png" }),
    // CHZZK Stella Sora, slot C (no product of its own but the draft)
    code({ loginId: CHZ_A, gameNo: "910003", gameName: "Stella Sora", groupKey: "910003:chzzk-1962", campaignIdx: "chzzk-1962",
      campaignTitle: "Stella event", slotKey: SLOT_C, nameRaw: "Gems", name: "Gems", image: "https://img.test/gems.png", useBy: new Date(NOW + 20 * HOUR) }),
    code({ loginId: CHZ_A, gameNo: "910003", gameName: "Stella Sora", groupKey: "910003:chzzk-1962", campaignIdx: "chzzk-1962",
      campaignTitle: "Stella event", slotKey: SLOT_C, nameRaw: "Gems", name: "Gems", image: "https://img.test/gems.png" }),
    // CHZZK Black Survival ER, slot D (expired, a picture that is not http)
    code({ loginId: CHZ_B, gameNo: "9217747", gameName: "Black Survival Eternal Return", groupKey: "9217747:chzzk-1992",
      campaignIdx: "chzzk-1992", campaignTitle: "Road to masters", slotKey: SLOT_D, nameRaw: "Drops Token", name: "Drops Token",
      image: "data:image/png;base64,AAAA", state: "expired" }),
  ]);
}

const makeBoard = (over = {}) => board.createBoard({ models: MODELS, now: () => NOW, config: staticConfig(), ...over });
const iso = (ms) => new Date(ms).toISOString();
const plain = (v) => JSON.parse(JSON.stringify(v));

// ---- the read model ------------------------------------------------------------------

test("games: one card per game, both farms under one Overwatch, names, covers, banners", async () => {
  await seed();
  const b = plain(await makeBoard().build());
  assert.deepEqual(b.games.map((g) => g.gameNo), ["9217747", "12", "910003"], "sorted by name");

  const ow = b.games.find((g) => g.gameNo === "12");
  assert.equal(ow.name, "Overwatch 2", "the settings' display name wins");
  assert.equal(ow.cover, "https://static.test/ttv-boxart/515025-285x380.jpg", "box art by marketGame, sized");
  assert.equal(ow.banner, "https://img.test/chzzk-ow.png", "the campaign that ends last");
  assert.equal(ow.sell, true);
  assert.deepEqual(ow.sources, ["soop", "chzzk"]);
  assert.deepEqual(ow.codes, { inStock: 2, onSale: 4, inVault: 0, sold: 5, expiring: 1, expired: 1, held: 1, dead: 1 });
  assert.deepEqual(ow.revenue, { d1: 4, d7: 9, d30: 10, all: 12 });
  assert.equal(ow.lastSoldAt, iso(NOW - HOUR));
  assert.equal(ow.nextUseBy, iso(NOW + 2 * DAY), "earliest use-by of a code not sold yet");
  assert.deepEqual([...ow.products].sort(), [ids.P1, ids.P2, ids.P3, ids.P6].map(String).sort());

  assert.deepEqual(ow.campaigns.map((c) => [c.groupKey, c.source]), [["12:chzzk-1954", "chzzk"], ["12:13787", "soop"]]);
  const soopCamp = ow.campaigns[1];
  assert.equal(soopCamp.title, "OW league");
  assert.equal(soopCamp.banner, "https://img.test/soop-ow.png");
  assert.equal(soopCamp.startAt, iso(NOW - 10 * DAY));
  assert.equal(soopCamp.endAt, iso(NOW - DAY));
  assert.deepEqual(soopCamp.codes, { inStock: 2, onSale: 3, inVault: 0, sold: 3, expiring: 1, expired: 1, held: 1, dead: 1 });
  assert.deepEqual(soopCamp.revenue, { d1: 2.5, d7: 7.5, d30: 7.5, all: 9.5 });
  assert.equal(soopCamp.rewards.length, 1);
  assert.equal(soopCamp.rewards[0].label, "Spray", "an active product's label, newest first; a retired one never");
  assert.equal(soopCamp.rewards[0].image, "https://img.test/spray.png");
  const chzCamp = ow.campaigns[0];
  assert.equal(chzCamp.rewards[0].label, "Epic Loot Box", "the newer of two active products");
  assert.equal(chzCamp.rewards[0].nameRaw, "특급 전리품 상자");

  const stella = b.games.find((g) => g.gameNo === "910003");
  assert.equal(stella.name, "Stella Sora", "no display name: the ledger's");
  assert.equal(stella.cover, "", "a javascript: box art never passes");
  assert.equal(stella.banner, "", "nor a javascript: banner");
  assert.equal(stella.campaigns[0].rewards[0].label, "Gems");
  assert.equal(stella.nextUseBy, iso(NOW + 20 * HOUR));

  const er = b.games.find((g) => g.gameNo === "9217747");
  assert.equal(er.name, "Black Survival Eternal Return");
  assert.equal(er.cover, "https://static.test/er-285x380.jpg", "the alias list");
  assert.deepEqual([er.sell, er.sellOff], [true, []], "never named, but new games sell by themselves (sellNewGames)");
  const strict = plain(await makeBoard({ config: staticConfig(deepMerge(cfgData, { sellNewGames: false })) }).build());
  const erOff = strict.games.find((g) => g.gameNo === "9217747");
  assert.deepEqual([erOff.sell, erOff.sellOff], [false, ["9217747"]], "with sellNewGames off it does not sell");
  assert.equal(er.campaigns[0].rewards[0].image, "", "a data: picture is not a URL the board passes");
  assert.equal(er.campaigns[0].rewards[0].label, "Drops Token", "no product: the default label");
});

test("one card per game name: two farms' numbers for the same game merge", async () => {
  await seed();
  await CodeStock.collection.insertMany([
    code({ gameNo: "18", gameName: "Eternal Return", groupKey: "18:14197", campaignIdx: "14197", campaignTitle: "ER finals",
      slotKey: "18:14197:eeeeeeeeee:1", nameRaw: "Drops Token", name: "Drops Token", state: "in_stock", useBy: new Date(NOW + 9 * DAY) }),
    code({ gameNo: "18", gameName: "Eternal Return", groupKey: "18:14197", campaignIdx: "14197", campaignTitle: "ER finals",
      slotKey: "18:14197:eeeeeeeeee:1", nameRaw: "Drops Token", name: "Drops Token", state: "expired" }),
  ]);
  const cfg = deepMerge(cfgData, { games: { 9217747: { displayName: "Eternal Return", sell: false }, 18: { sell: true } } });
  const b = plain(await makeBoard({ config: staticConfig(cfg) }).build());
  const er = b.games.filter((g) => /eternal/i.test(g.name));
  assert.equal(er.length, 1, "one card");
  const [g] = er;
  assert.equal(g.key, "eternalreturn");
  assert.deepEqual(g.gameNos, ["18", "9217747"]);
  assert.equal(g.gameNo, "18", "the number holding the most codes");
  assert.deepEqual(g.sources, ["soop", "chzzk"]);
  assert.deepEqual(g.codes, { inStock: 1, onSale: 0, inVault: 0, sold: 0, expiring: 0, expired: 2, held: 0, dead: 0 });
  assert.deepEqual(g.campaigns.map((c) => c.groupKey).sort(), ["18:14197", "9217747:chzzk-1992"]);
  assert.deepEqual([g.sell, g.sellOff], [false, ["9217747"]], "one part is switched off");
  assert.equal(g.cover, "https://static.test/er-285x380.jpg");
  assert.equal(b.games.find((x) => x.gameNo === "12").key, "overwatch2");
});

test("products: live ones plus retired ones that sold; listings with links and states; units and sales by market", async () => {
  await seed();
  const b = plain(await makeBoard().build());
  assert.deepEqual(b.products.map((p) => p.name), ["OW Epic", "OW Spray", "OW mix", "Stella draft", "OW old"],
    "active by name, then the draft, then the retired one that sold; the retired one that never sold is left out");

  const p1 = b.products.find((p) => p.id === String(ids.P1));
  assert.equal(p1.title, "Overwatch 2 | Spray | Redeem Code");
  assert.equal(p1.priceUsd, 1);
  assert.deepEqual(p1.sources, ["soop"]);
  assert.deepEqual(p1.units, { available: 3, fed: 0, sold: 2, removed: 0 });
  assert.deepEqual(p1.listings.map((l) => [l.market, l.externalId, l.state]), [["eldorado", "E-1", "live"], ["playerauctions", "PA-1", "live"]],
    "a market with a live row shows only its live rows");
  assert.match(p1.listings[0].url, /^https:\/\/www\.eldorado\.test\//);
  const soopOnly = (units, usd) => ({ soop: { units, usd }, chzzk: { units: 0, usd: 0 } });
  assert.deepEqual(p1.sold, {
    units: 2, codes: 2, usd: 6, lastAt: iso(NOW - 2 * HOUR), bySource: soopOnly(2, 6),
    byMarket: {
      eldorado: { units: 1, usd: 1, lastAt: iso(NOW - 2 * HOUR), bySource: soopOnly(1, 1) },
      playerauctions: { units: 1, usd: 5, lastAt: iso(NOW - 3 * DAY), bySource: soopOnly(1, 5) },
    },
  });
  assert.deepEqual(p1.rewards, [{ slotKey: SLOT_A, label: "Spray", image: "https://img.test/spray.png" }]);

  const p2 = b.products.find((p) => p.id === String(ids.P2));
  assert.deepEqual(p2.sources, ["chzzk"]);
  assert.deepEqual(p2.listings.map((l) => l.state), ["paused"], "auto-paused");
  const p6 = b.products.find((p) => p.id === String(ids.P6));
  assert.deepEqual(p6.sources, ["soop", "chzzk"], "a custom mix names both farms");
  assert.deepEqual(p6.listings.map((l) => [l.state, l.lastError]), [["error", "PA said no"]]);
  assert.deepEqual(p6.rewards.map((r) => r.image), ["https://img.test/spray.png", "https://img.test/epic.png"],
    "a slot saved without a picture shows the ledger's");
  const p3 = b.products.find((p) => p.id === String(ids.P3));
  assert.equal(p3.rewards[0].image, "https://img.test/spray.png", "the ledger's newest picture wins over an old saved one");
  assert.deepEqual(p6.sold.byMarket, {
    playerauctions: { units: 1, usd: 3, lastAt: iso(NOW - HOUR), bySource: { soop: { units: 1, usd: 1.5 }, chzzk: { units: 1, usd: 1.5 } } },
  }, "one bundle of two codes: it counts as a bundle for each farm, each with its share of the money");
  assert.deepEqual(p6.sold.bySource, { soop: { units: 1, usd: 1.5 }, chzzk: { units: 1, usd: 1.5 } });
  const p3r = b.products.find((p) => p.id === String(ids.P3));
  assert.equal(p3r.status, "retired");
  assert.deepEqual(p3r.listings.map((l) => l.state), ["down"]);
  const p5 = b.products.find((p) => p.id === String(ids.P5));
  assert.deepEqual([p5.status, p5.listings.length, p5.units.available], ["draft", 0, 0]);

  assert.deepEqual(b.totals.units, { available: 4, fed: 0, sold: 5 });
  assert.deepEqual(b.totals.listings, { live: 2, paused: 1, down: 1, error: 1 });
  assert.deepEqual(b.totals.salesCount, { d1: 2, d7: 3, d30: 4, all: 5 });
  assert.deepEqual(b.totals.codes, { inStock: 4, onSale: 4, inVault: 0, sold: 5, expiring: 1, expired: 2, held: 1, dead: 1 });
  assert.deepEqual(b.totals.revenue, { d1: 4, d7: 9, d30: 10, all: 12 });
});

test("markets and farms: listings, bundles on sale, sales windows; logins per farm", async () => {
  await seed();
  const b = plain(await makeBoard().build());
  const [eld, pa] = b.markets;
  assert.deepEqual([eld.id, eld.name, eld.on, pa.id, pa.on], ["eldorado", "Eldorado", true, "playerauctions", true]);
  assert.deepEqual(eld.listings, { live: 1, paused: 1, down: 1, error: 0 });
  assert.equal(eld.unitsOnSale, 3, "bundles behind a live listing");
  assert.deepEqual(eld.sold, { units: 3, codes: 3, usd: 4, lastAt: iso(NOW - 2 * HOUR), d1: { units: 1, usd: 1 }, d7: { units: 1, usd: 1 }, d30: { units: 2, usd: 2 } });
  assert.deepEqual(pa.listings, { live: 1, paused: 0, down: 0, error: 1 });
  assert.equal(pa.unitsOnSale, 3);
  assert.deepEqual(pa.sold, { units: 2, codes: 3, usd: 8, lastAt: iso(NOW - HOUR), d1: { units: 1, usd: 3 }, d7: { units: 2, usd: 8 }, d30: { units: 2, usd: 8 } });

  const [soop, chz] = b.sources;
  assert.deepEqual([soop.id, soop.name, soop.logins], ["soop", "SOOP", 1]);
  assert.deepEqual(soop.codes, { inStock: 2, onSale: 3, inVault: 0, sold: 3, expiring: 1, expired: 1, held: 1, dead: 1 });
  assert.deepEqual(soop.revenue, { d1: 2.5, d7: 7.5, d30: 7.5, all: 9.5 });
  assert.deepEqual([chz.id, chz.logins], ["chzzk", 2]);
  assert.deepEqual(chz.codes, { inStock: 2, onSale: 1, inVault: 0, sold: 2, expiring: 0, expired: 1, held: 0, dead: 0 });
  assert.deepEqual(chz.revenue, { d1: 1.5, d7: 1.5, d30: 2.5, all: 2.5 });
  assert.deepEqual(b.config, { markets: { eldorado: true, playerauctions: true }, autoPublish: true, expiryLeadHours: 36 });
});

test("sales: newest first, one row per bundle, with the farm, the dead count and the limit", async () => {
  await seed();
  const b = plain(await makeBoard().build());
  assert.deepEqual(b.sales.map((s) => s.id), [ids.UM1, ids.US1, ids.US2, ids.UC2, ids.UR1].map(String));
  const [mix, , dead, chz, old] = b.sales;
  assert.deepEqual(
    { product: mix.product, productName: mix.productName, gameNo: mix.gameNo, market: mix.market, usd: mix.usd, codes: mix.codes, dead: mix.dead, sources: mix.sources },
    { product: String(ids.P6), productName: "OW mix", gameNo: "12", market: "playerauctions", usd: 3, codes: 2, dead: 0, sources: ["soop", "chzzk"] },
  );
  assert.equal(mix.soldAt, iso(NOW - HOUR));
  assert.deepEqual(mix.bySource, { soop: { usd: 1.5 }, chzzk: { usd: 1.5 } }, "each farm's share of the bundle");
  assert.equal(mix.orderId, "order-playerauctions-" + (NOW - HOUR));
  assert.deepEqual([dead.dead, dead.sources], [1, ["soop"]]);
  assert.deepEqual(chz.sources, ["chzzk"]);
  assert.equal(old.productName, "OW old", "a retired product keeps its sales");

  const short = plain(await makeBoard().build({ sales: 2 }));
  assert.deepEqual(short.sales.map((s) => s.id), [ids.UM1, ids.US1].map(String));
});

test("daily: bundles per day in the viewer's zone, by market and farm; an unknown zone counts in UTC", async () => {
  await seed();
  const utc = plain(await makeBoard().build({ days: 14 }));
  assert.equal(utc.tz, "UTC");
  assert.equal(utc.daily.length, 14);
  assert.equal(utc.daily[0].day, "2026-10-12");
  assert.equal(utc.daily[13].day, "2026-10-25");
  const farms = (su, sd, cu, cd) => ({ soop: { units: su, usd: sd }, chzzk: { units: cu, usd: cd } });
  assert.deepEqual(utc.daily[13].rows, [
    { market: "eldorado", units: 1, usd: 1, ...farms(1, 1, 0, 0) },
    { market: "playerauctions", units: 1, usd: 3, ...farms(1, 1.5, 1, 1.5) },
  ], "a two-farm bundle: one bundle in all, one for each farm with its share");
  const at = (b, day) => b.daily.find((d) => d.day === day).rows;
  assert.deepEqual(at(utc, "2026-10-22"), [{ market: "playerauctions", units: 1, usd: 5, ...farms(1, 5, 0, 0) }]);
  assert.deepEqual(at(utc, "2026-10-15"), [{ market: "eldorado", units: 1, usd: 1, ...farms(0, 0, 1, 1) }]);
  assert.equal(utc.daily.reduce((n, d) => n + d.rows.length, 0), 4, "the 40-day-old sale is outside the window");

  const tokyo = plain(await makeBoard().build({ days: 14, tz: "Asia/Tokyo" }));
  assert.equal(tokyo.tz, "Asia/Tokyo");
  assert.equal(tokyo.daily[13].day, "2026-10-26", "05:00 the next morning in Tokyo");
  assert.equal(tokyo.daily[13].rows.length, 2);
  assert.deepEqual(at(tokyo, "2026-10-23"), [{ market: "playerauctions", units: 1, usd: 5, ...farms(1, 5, 0, 0) }]);
  assert.deepEqual(at(tokyo, "2026-10-16"), [{ market: "eldorado", units: 1, usd: 1, ...farms(0, 0, 1, 1) }]);

  for (const bad of ["Mars/Base", "../../etc/passwd", "", "x".repeat(80), "Asia/Tokyo; DROP"]) {
    assert.equal(plain(await makeBoard().build({ tz: bad })).tz, "UTC", JSON.stringify(bad));
  }
  assert.equal(plain(await makeBoard().build({ days: 0 })).daily.length, 1, "clamped up to 1");
  assert.equal(plain(await makeBoard().build({ days: 9999 })).daily.length, board.DAYS_MAX, "clamped down");
  assert.equal(plain(await makeBoard().build({ days: "x" })).daily.length, board.DAYS_DEFAULT);
});

test("nothing secret leaves: no code, hash, code shape, unit login or password, farm login id", async () => {
  await seed();
  const text = JSON.stringify(await makeBoard().build());
  assert.doesNotMatch(text, /sentinel/i);
  assert.doesNotMatch(text, /99:9-9-9/);
  assert.doesNotMatch(text, /codeHash|codeEnc|codeShape|password/);
  assert.ok(!text.includes(CHZ_A) && !text.includes(CHZ_B), "no CHZZK login id");
});

test("the box art is read once an hour, and a failed read only blanks the covers", async () => {
  await seed();
  let clock = NOW;
  let reads = 0;
  const counting = {
    aggregate: (...a) => {
      reads += 1;
      return TwitchCampaign.aggregate(...a);
    },
  };
  const b1 = board.createBoard({ models: { ...MODELS, TwitchCampaign: counting }, now: () => clock, config: staticConfig() });
  await b1.build();
  await b1.build();
  assert.equal(reads, 1);
  clock += 61 * 60 * 1000;
  await b1.build();
  assert.equal(reads, 2);

  const failing = { aggregate: async () => { throw new Error("no twitch collection"); } };
  const b2 = plain(await board.createBoard({ models: { ...MODELS, TwitchCampaign: failing }, now: () => NOW, config: staticConfig() }).build());
  assert.ok(b2.games.every((g) => g.cover === ""));
  assert.equal(b2.games.find((g) => g.gameNo === "12").banner, "https://img.test/chzzk-ow.png", "everything else is there");
});

test("a replacement code is not a sale; a product live twice on one market counts its bundles once", async () => {
  await seed();
  // As afterSale.replace leaves it: sold, no bundle, market "replacement".
  await CodeStock.collection.insertOne(code({ state: "sold", soldAt: new Date(NOW - 10 * 60 * 1000), market: "replacement",
    after: { status: "replacement", note: "", at: new Date(NOW - 10 * 60 * 1000), by: "root", ref: null } }));
  await MarketplaceListing.collection.insertOne({ accountOffer: ids.O1, marketplace: "eldorado", externalId: "E-1b", status: "active",
    price: 1, origin: "manual", url: "https://www.eldorado.test/i?offerId=E-1b", autoPaused: false, lastError: "", createdAt: new Date(NOW - DAY) });
  const b = plain(await makeBoard().build());
  const ow = b.games.find((g) => g.gameNo === "12");
  assert.equal(ow.lastSoldAt, iso(NOW - HOUR), "the replacement handed out 10 min ago is not the last sale");
  assert.equal(ow.codes.sold, 6, "but its code left stock, as the Sales tab counts it");
  assert.equal(ow.revenue.all, 12, "and it earned nothing");
  assert.ok(b.sales.every((s) => s.market !== "replacement"), "nor is it in the feed");
  const eld = b.markets.find((m) => m.id === "eldorado");
  assert.equal(eld.unitsOnSale, 3, "3 bundles, even behind two live Eldorado rows");
  assert.equal(eld.listings.live, 2);
  assert.deepEqual(b.products.find((p) => p.id === String(ids.P1)).listings.map((l) => l.externalId).sort(), ["E-1", "E-1b", "PA-1"]);
});

test("a bundle whose rows disagree is counted once everywhere", async () => {
  await seed();
  // Half of US1's codes say playerauctions (a partial write): feed, chart and totals agree on one bundle.
  await CodeStock.collection.insertOne(code({ state: "sold", unit: ids.US1, product: ids.P1, market: "playerauctions", saleUsd: 0, soldAt: new Date(NOW - 2 * HOUR) }));
  const b = plain(await makeBoard().build());
  assert.equal(b.totals.salesCount.all, 5);
  assert.equal(b.markets.reduce((n, m) => n + m.sold.units, 0), 5);
  const p1 = b.products.find((p) => p.id === String(ids.P1));
  assert.equal(p1.sold.units, 2);
  assert.equal(b.sales.filter((s) => s.id === String(ids.US1)).length, 1);
});

test("a time zone Mongo refuses falls back to UTC instead of failing", async () => {
  await seed();
  const picky = {
    aggregate: (pipeline) => {
      if (JSON.stringify(pipeline).includes('"timezone":"Asia/Tokyo"')) throw new Error("unrecognized time zone identifier");
      return CodeStock.aggregate(pipeline);
    },
  };
  const b = plain(await board.createBoard({ models: { ...MODELS, CodeStock: picky }, now: () => NOW, config: staticConfig() }).build({ tz: "Asia/Tokyo" }));
  assert.equal(b.tz, "UTC");
  assert.equal(b.daily[b.daily.length - 1].day, "2026-10-25");
  assert.equal(b.daily[b.daily.length - 1].rows.length, 2);
});

test("merging: three numbers pick the biggest one alone; names in other scripts stay apart", async () => {
  await seed();
  const extra = [];
  const add = (gameNo, gameName, n) => {
    for (let i = 0; i < n; i++) {
      extra.push(code({ gameNo, gameName, groupKey: gameNo + ":500" + gameNo.length, campaignIdx: "500" + gameNo.length,
        slotKey: gameNo + ":500" + gameNo.length + ":ffffffffff:1", nameRaw: "Box", name: "Box" }));
    }
  };
  add("41", "Battle Game", 2);
  add("42", "Battle Game", 2);
  add("43", "Battle Game", 3);
  add("51", "오버워치 2", 1);
  add("52", "배틀그라운드 2", 1);
  add("61", "2", 1);
  add("62", "2", 1);
  await CodeStock.collection.insertMany(extra);
  const b = plain(await makeBoard().build());
  const battle = b.games.filter((g) => g.name === "Battle Game");
  assert.equal(battle.length, 1);
  assert.deepEqual([battle[0].gameNo, battle[0].gameNos], ["43", ["41", "42", "43"]], "43 holds the most codes on its own");
  assert.equal(b.games.filter((g) => g.gameNos.includes("51") || g.gameNos.includes("52")).length, 2, "Hangul names stay apart");
  assert.equal(b.games.filter((g) => g.gameNos.includes("61") || g.gameNos.includes("62")).length, 2, "a name with no letter never merges");
});

test("the query: an empty value means the default; limits and the lead hours follow views.js", async () => {
  await seed();
  assert.equal(plain(await makeBoard().build({ days: "" })).daily.length, board.DAYS_DEFAULT);
  assert.equal(board.intIn("999", board.SALES_DEFAULT, 1, board.SALES_MAX), board.SALES_MAX);
  assert.equal(board.intIn(null, 7, 1, 9), 7);
  assert.equal(plain(await makeBoard({ config: staticConfig(deepMerge(cfgData, { expiryLeadHours: null })) }).build()).config.expiryLeadHours, 36);
  assert.equal(plain(await makeBoard({ config: staticConfig(deepMerge(cfgData, { expiryLeadHours: 12 })) }).build()).config.expiryLeadHours, 12);
});

test("one answer serves callers for 15 s; a failed read is not kept", async () => {
  await seed();
  let clock = NOW;
  let reads = 0;
  let fail = false;
  const counting = {
    aggregate: (pipeline) => {
      reads += 1;
      if (fail) throw new Error("database is down");
      return CodeStock.aggregate(pipeline);
    },
  };
  const b = board.createBoard({ models: { ...MODELS, CodeStock: counting }, now: () => clock, config: staticConfig() });
  const [x, y] = await Promise.all([b.build(), b.build()]);
  assert.equal(x, y, "two callers at once share one read");
  const perBuild = reads;
  await b.build();
  assert.equal(reads, perBuild, "still fresh");
  await b.build({ days: 3 });
  assert.equal(reads, perBuild * 2, "another query is its own answer");
  clock += 16 * 1000;
  fail = true;
  await assert.rejects(b.build(), /database is down/);
  fail = false;
  const again = await b.build();
  assert.equal(again.games.length, 3, "the failure was not kept");
});

test("an empty shop answers an empty board, not an error", async () => {
  await Promise.all(ALL.map((m) => m.deleteMany({})));
  const b = plain(await makeBoard().build({ days: 3 }));
  assert.deepEqual([b.games, b.products, b.sales], [[], [], []]);
  assert.equal(b.daily.length, 3);
  assert.ok(b.daily.every((d) => d.rows.length === 0));
  assert.deepEqual(b.totals.listings, { live: 0, paused: 0, down: 0, error: 0 });
  assert.deepEqual(b.sources.map((s) => s.logins), [0, 0]);
});

test("helpers: names, campaign refs, listing states, image URLs", () => {
  assert.equal(board.normName("Overwatch® 2"), "overwatch2");
  assert.equal(board.mergeKey("Overwatch 2"), "overwatch2");
  assert.equal(board.mergeKey("Pokémon"), board.mergeKey("Pokemon"));
  assert.equal(board.mergeKey("오버워치 2"), "오버워치2");
  assert.equal(board.mergeKey("2"), "");
  assert.equal(board.normName("Pokémon UNITE"), "pokemonunite");
  assert.deepEqual(board.campaignRef("12:13787"), { source: "soop", dropsIdx: "13787" });
  assert.deepEqual(board.campaignRef("12:chzzk-1954"), { source: "chzzk", campaignNo: 1954 });
  assert.deepEqual(board.campaignRef("12:nabcdef0123"), { source: "soop" });
  assert.equal(board.listingState({ status: "active" }), "live");
  assert.equal(board.listingState({ status: "active", autoPaused: true }), "paused");
  assert.equal(board.listingState({ status: "error" }), "error");
  for (const s of ["delisted", "removed", "sold", ""]) assert.equal(board.listingState({ status: s }), "down");
  assert.equal(board.imageUrl(" https://a.test/x.png "), "https://a.test/x.png");
  for (const bad of ["javascript:alert(1)", "data:image/png;base64,AA", "//a.test/x.png", "https://" + "a".repeat(2100)]) assert.equal(board.imageUrl(bad), "");
});

// ---- the route ---------------------------------------------------------------------

test("GET /api/code-shop/board answers the board and passes the query through, clamped", async () => {
  await seed();
  const service = { deps: { models: MODELS, now: () => NOW }, modules: { config: staticConfig() } };
  const app = express();
  app.use((req, _res, next) => {
    req.session = { admin: { id: "root", username: "root", role: "superadmin" } };
    next();
  });
  app.use(codeShopRoutes({ service }));
  const server = app.listen(0);
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/code-shop/board`;
    const r = await fetch(url + "?days=3&sales=1&tz=Asia/Tokyo");
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.success, true);
    assert.equal(j.daily.length, 3);
    assert.equal(j.sales.length, 1);
    assert.equal(j.tz, "Asia/Tokyo");
    assert.equal(j.games.length, 3);
    const odd = await (await fetch(url + "?days=-5&sales=abc&tz=nope")).json();
    assert.deepEqual([odd.success, odd.daily.length, odd.sales.length, odd.tz], [true, 1, 5, "UTC"]);
  } finally {
    server.close();
  }
});
