/* global fetch */
// Fresh Epic accounts listed in Eldorado's Rocket League › Accounts section
// (PC), with Eldorado, the Mac mail proxy and Telegram replaced by fakes.
//
// What must hold:
//   - the offer is filed under Rocket League (gameId 1, Device PC, fresh
//     attributes) on create AND on every later stock edit — an edit that
//     forgot the section would ask Eldorado to move the offer;
//   - the section needs no high-risk permission, while the Epic Games one
//     still does;
//   - only fresh accounts (no games) go in, on create and on top-up;
//   - the auto-distributor never adds to a Rocket League listing.
process.env.SESSION_SECRET ||= "epic-rl-test-secret";
process.env.CRED_SECRET ||= "epic-rl-test-cred";
process.env.PUBLIC_BASE_URL = "https://shop.example.test";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { encrypt } = require("../utils/secretBox");
const EpicAccount = require("../models/EpicAccount");
const EpicListing = require("../models/EpicListing");
const eld = require("../utils/eldoradoAccountOffers");
const outlook = require("../utils/outlookGraphReader");
const telegram = require("../utils/telegram");
const sales = require("../utils/epicSales");

// ---- pure ------------------------------------------------------------------
const ENTRY = [{ accountLogin: "a@outlook.com", accountPassword: "p" }];
const IMG = { largeImage: "l.png" };

test("the Rocket League section files the offer under RL › Accounts, PC, fresh", () => {
  const dto = eld.offerDto({ title: "Fresh RL account", priceUsd: 1, mainOfferImage: IMG, entries: ENTRY, section: "rocket-league" });
  assert.equal(dto.augmentedGame.gameId, "1");
  assert.equal(dto.augmentedGame.category, "Account");
  assert.equal(dto.augmentedGame.tradeEnvironmentId, "0");
  const byId = Object.fromEntries(dto.augmentedGame.offerAttributes.map((a) => [a.id, a]));
  assert.deepEqual(byId["rocket-league-current-rank"], { id: "rocket-league-current-rank", type: "Select", values: ["rank-unranked"] });
  assert.deepEqual(byId["rocket-league-level"].values, ["level-09"]);
  assert.deepEqual(byId["rl-credits"].values, ["credits-0299"]);
  assert.deepEqual(byId["rocket-league-tags-titles"].values, ["tag-other"]);
  // Eldorado requires the Numeric fields too ("Required attribute 'Credits' is not set").
  assert.deepEqual(byId["rocket-league-credits-numeric"], { id: "rocket-league-credits-numeric", type: "Numeric", value: 0 });
  assert.deepEqual(byId["rocket-league-level-numeric"], { id: "rocket-league-level-numeric", type: "Numeric", value: 0 });
  assert.equal(dto.augmentedGame.offerAttributes.length, 6);
  // A copy each time: a caller can't change the shared definition.
  dto.augmentedGame.offerAttributes[0].values.push("x");
  assert.equal(eld.SECTIONS["rocket-league"].offerAttributes[0].values.length, 1);
});

test("the Epic Games section is unchanged and stays the default", () => {
  const dto = eld.offerDto({ title: "Epic account", priceUsd: 1, mainOfferImage: IMG, entries: ENTRY });
  assert.equal(dto.augmentedGame.gameId, "108");
  assert.equal(dto.augmentedGame.tradeEnvironmentId, null);
  assert.deepEqual(dto.augmentedGame.offerAttributes, []);
  assert.equal(eld.offerUrl("abc"), "https://www.eldorado.gg/epic-games-accounts/oa/abc");
  assert.equal(eld.offerUrl("abc", "rocket-league"), "https://www.eldorado.gg/rocket-league-accounts-for-sale/oa/abc");
  assert.throws(() => eld.offerDto({ title: "Epic account", priceUsd: 1, mainOfferImage: IMG, entries: ENTRY, section: "fortnite" }), /Unknown Eldorado section/);
});

test("the suggested Rocket League text says what the buyer gets", () => {
  const title = sales.suggestTitle([], "rocket-league");
  assert.match(title, /Fresh Rocket League Account/);
  assert.ok(title.length <= 160);
  const desc = sales.suggestDescription([], 7, "rocket-league");
  assert.match(desc, /PC \(Epic Games\)/);
  assert.match(desc, /unranked/);
  assert.match(desc, /mailbox itself is not part of the sale/);
  assert.match(desc, /change the account email/);
});

// ---- flow ------------------------------------------------------------------
const sent = [];
telegram.sendTelegram = async (t) => {
  sent.push(t);
  return true;
};
outlook.checkInbox = async () => ({ sellable: true, sharedWith: ["soop"], status: "live" });
outlook.proxyHealth = async () => ({ ok: true, inboxes: 9 });

const ELD = { offers: new Map(), creates: [], updates: [], uploads: [], seq: 0 };
eld.epicPermission = async (gameId) =>
  String(gameId) === "108"
    ? { canSell: false, allowHighRiskOffers: false, epicIsHighRisk: true, error: "" }
    : { canSell: true, allowHighRiskOffers: false, epicIsHighRisk: false, error: "" };
eld.uploadImage = async (file) => {
  ELD.uploads.push(file);
  return { smallImage: "s.png", largeImage: "l.png", originalSizeImage: "o.png" };
};
const withIds = (list) => list.map((e) => ({ ...e, id: e.id || "e" + ++ELD.seq }));
eld.createAccountOffer = async (opts) => {
  // The real DTO builder runs, so a bad section would throw here.
  const dto = eld.offerDto(opts);
  ELD.creates.push(dto);
  const id = "00000000-0000-4000-8000-" + String(++ELD.seq).padStart(12, "0");
  ELD.offers.set(id, {
    id,
    offerState: "Active",
    offerTitle: opts.title,
    description: opts.description,
    pricePerUnit: { amount: opts.priceUsd, currency: "USD" },
    hasOriginalEmail: false,
    mainOfferImage: opts.mainOfferImage,
    expireDate: new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 19),
    entries: withIds(opts.entries),
  });
  return { id };
};
eld.getAccountOffer = async (id) => ({ ...ELD.offers.get(id), quantity: ELD.offers.get(id).entries.length });
eld.getAccountEntries = async (id) => ELD.offers.get(id).entries.map((e) => ({ ...e, legacy: false }));
eld.updateAccountOffer = async (id, opts) => {
  const dto = eld.offerDto(opts);
  ELD.updates.push(dto);
  const o = ELD.offers.get(id);
  o.entries = withIds(opts.entries);
  o.offerTitle = opts.title;
  o.description = opts.description;
  return true;
};

let mongod;
let server;
let base;
const acc = {};

async function mk(label, games) {
  const email = label + "@outlook.com";
  const a = await EpicAccount.create({
    accountId: "acc-" + label,
    displayName: label,
    label,
    email: encrypt(email),
    password: encrypt("EpicPw-" + label),
    source: "generated",
    status: "ok",
    library: games.map((t) => ({ title: t, namespace: "ns-" + t })),
    libraryCount: games.length,
  });
  acc[label] = String(a._id);
}

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("epic-rl"));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { admin: { id: "root", username: "root", role: "superadmin", tfa: true } };
    next();
  });
  app.use(require("../routes/epicSalesRoutes"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + server.address().port;
  await mk("fresh-1", []);
  await mk("fresh-2", []);
  await mk("fresh-3", []);
  await mk("rich", ["Sker Ritual", "Home - A Unique Horror Adventure"]);
  sales._internals.resetPermissionCache();
});

test.after(async () => {
  sales.stop();
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

async function post(p, body) {
  const r = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, j: await r.json() };
}

test("fresh accounts: the Epic Games section is refused, Rocket League is open", async () => {
  const ids = [acc["fresh-1"], acc["fresh-2"]];
  let r = await post("/api/epic/sales/preview", { accountIds: ids, priceUsd: 1 });
  assert.ok(r.j.preview.problems.some((p) => /high-risk/.test(p)), "Epic Games section still needs the permission");
  r = await post("/api/epic/sales/preview", { accountIds: ids, priceUsd: 1, section: "rocket-league" });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const p = r.j.preview;
  assert.deepEqual(p.problems, []);
  assert.equal(p.section, "rocket-league");
  assert.equal(p.permission.canSell, true);
  assert.equal(p.builtInCover, true, "our own cover is used when no link is pasted");
  assert.equal(p.coverPreview, "/img/epic-rocket-league-cover.png");
  assert.match(p.title, /Fresh Rocket League Account/);
});

test("an account with games can't go in the Rocket League section", async () => {
  const r = await post("/api/epic/sales/preview", { accountIds: [acc["fresh-1"], acc["rich"]], priceUsd: 1, section: "rocket-league" });
  assert.ok(r.j.preview.problems.some((x) => /fresh accounts only/.test(x) && /rich \(2\)/.test(x)), JSON.stringify(r.j.preview.problems));
  const c = await post("/api/epic/sales/listings", { accountIds: [acc["fresh-1"], acc["rich"]], priceUsd: 1, section: "rocket-league", confirm: true });
  assert.equal(c.status, 400);
  assert.equal(ELD.creates.length, 0, "nothing reached Eldorado");
});

let listingId;
let offerId;

test("create files the offer under Rocket League with our cover", async () => {
  const r = await post("/api/epic/sales/listings", {
    accountIds: [acc["fresh-1"], acc["fresh-2"]],
    priceUsd: 1,
    section: "rocket-league",
    confirm: true,
  });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  listingId = r.j.listing._id;
  assert.equal(r.j.listing.section, "rocket-league");
  assert.equal(r.j.listing.sectionName, "Rocket League accounts (PC)");
  assert.match(r.j.listing.url, /rocket-league-accounts-for-sale\/oa\//);
  assert.equal(ELD.creates.length, 1);
  const dto = ELD.creates[0];
  assert.equal(dto.augmentedGame.gameId, "1");
  assert.equal(dto.augmentedGame.tradeEnvironmentId, "0");
  assert.equal(dto.details.pricing.pricePerUnit.amount, 1);
  assert.equal(dto.details.pricing.quantity, 2);
  assert.equal(dto.details.hasOriginalEmail, false);
  assert.equal(ELD.uploads.length, 1);
  assert.equal(path.basename(ELD.uploads[0]), "epic-rocket-league-cover.png");
  const row = await EpicListing.findById(listingId).lean();
  assert.equal(row.section, "rocket-league");
  assert.equal(row.gameKey, "", "never matches a game set, so the distributor can't pick it");
  offerId = row.externalId;
  assert.ok(sent.some((t) => /Rocket League accounts \(PC\)/.test(t)), "the Telegram note names the section");
});

test("every stock edit keeps the offer in the Rocket League section", async () => {
  let r = await post("/api/epic/sales/listings/" + listingId + "/accounts", { accountIds: [acc["rich"]] });
  assert.equal(r.status, 400);
  assert.match(r.j.message, /fresh accounts only/);
  assert.equal(ELD.updates.length, 0);
  r = await post("/api/epic/sales/listings/" + listingId + "/accounts", { accountIds: [acc["fresh-3"]] });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  r = await post("/api/epic/sales/listings/" + listingId + "/text", { title: "Fresh Rocket League Account | PC | Instant" });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(ELD.updates.length, 2);
  for (const dto of ELD.updates) {
    assert.equal(dto.augmentedGame.gameId, "1");
    assert.equal(dto.augmentedGame.tradeEnvironmentId, "0");
    assert.equal(dto.augmentedGame.offerAttributes.length, 6);
  }
  assert.equal(ELD.offers.get(offerId).entries.length, 3);
});

test("the market check reads the Rocket League section", async () => {
  const axios = require("axios");
  const realGet = axios.get;
  let asked = "";
  axios.get = async (url) => {
    asked = url;
    return { data: { recordCount: 0, results: [] } };
  };
  try {
    const r = await fetch(base + "/api/epic/sales/market?q=fresh&section=rocket-league").then((x) => x.json());
    assert.equal(r.market.section, "rocket-league");
    assert.match(asked, /gameId=1&/);
  } finally {
    axios.get = realGet;
  }
});

test("the auto-distributor never tops up a Rocket League listing", async () => {
  const src = require("fs").readFileSync(path.join(__dirname, "..", "utils", "epicDistributor.js"), "utf8");
  assert.match(src, /\(l\.section \|\| "epic"\) === "epic"/);
});
