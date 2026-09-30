/* global fetch */
// GGSel reservations are released ONE SET at a time, and a delisted GGSel
// offer hands back only the accounts GGSel itself proves never sold.
//
// Why (found 2026-10-01, re-opening GGSel after the seller block): every GGSel
// release was tag-wide — releaseAccountsForTag(ids, "ggsel") cleared EVERY
// "ggsel" drop on the account. One account is sold once per game, so the same
// account routinely carries several "ggsel" sets, and GGSel never tells us about
// a sale except through its product states: the "ggsel" tag on a sold set IS the
// record that a buyer holds those drops. A failed publish, a failed feed or a
// Delist click therefore put already-SOLD drops back on sale. The Delist route
// was worse still: it released every account the row had ever fed, including
// the ones whose codes GGSel had delivered to buyers.
//
// Real router, real Mongo (mongodb-memory-server), real reservation layer;
// only the outbound GGSel calls are stubbed.
process.env.CRED_SECRET ||= "ggsel-release-scope-test-cred-secret";
process.env.SESSION_SECRET ||= "ggsel-release-scope-test-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const mp = require("../utils/marketplaces");
const ggFulfiller = require("../utils/ggselFulfiller");
const { encrypt } = require("../utils/secretBox");

let mem;
let server;
let baseUrl;
let cookie;

const real = {
  ggselDelist: mp.ggselDelist,
  ggselEmptyVault: mp.ggselEmptyVault,
};
// What the stubbed GGSel says for the next delist.
const gg = { vault: null, delisted: [] };

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("ggsel-release-scope"));
  mp.ggselDelist = async (id) => {
    gg.delisted.push(String(id));
  };
  mp.ggselEmptyVault = async () => {
    if (gg.vault instanceof Error) throw gg.vault;
    return gg.vault;
  };
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
    }),
  );
  app.get("/test/session", (req, res) => {
    req.session.admin = { id: "root", username: "root", role: "superadmin", tfa: true };
    res.json({ success: true });
  });
  app.use(require("../routes/marketplaceRoutes"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;
  cookie = (await fetch(baseUrl + "/test/session")).headers.get("set-cookie").split(";")[0];
});

test.after(async () => {
  mp.ggselDelist = real.ggselDelist;
  mp.ggselEmptyVault = real.ggselEmptyVault;
  if (server) await new Promise((r) => server.close(r));
  await new Promise((r) => setTimeout(r, 50));
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

let seq = 0;
async function account(login) {
  return BotAccount.create({
    login,
    clientSecret: "cs-" + login + "-" + ++seq,
    credPassword: encrypt("pw-" + login),
    hasPassword: true,
  });
}

async function set(name, keys) {
  return DropSet.create({
    name,
    price: 1,
    items: keys.map((k) => ({ itemKey: k, name: k, game: "Rust" })),
  });
}

// One DropLog per key on the account, reserved to `tag` for `setDoc`.
async function reserved(acc, setDoc, tag) {
  for (const it of setDoc.items) {
    await DropLog.create({
      account: acc._id,
      login: acc.login,
      benefitId: "b-" + acc.login + "-" + it.itemKey + "-" + ++seq,
      itemKey: it.itemKey,
      game: "Rust",
      soldAt: new Date(),
      soldToUsername: tag,
      soldSetId: String(setDoc._id),
    });
  }
}

async function heldFor(acc, setDoc) {
  return DropLog.countDocuments({
    account: acc._id,
    soldSetId: String(setDoc._id),
    soldAt: { $ne: null },
  });
}

test("releaseAccounts frees only the named set, and nothing without one", async () => {
  const a = await account("scope_a");
  const s1 = await set("S1", ["k1|rust", "k2|rust"]);
  const s2 = await set("S2", ["k3|rust"]);
  await reserved(a, s1, "ggsel");
  await reserved(a, s2, "ggsel"); // another set this account SOLD on GGSel

  await ggFulfiller.releaseAccounts([String(a._id)]);
  assert.equal(await heldFor(a, s1), 2, "no set id: fail closed, nothing freed");
  assert.equal(await heldFor(a, s2), 1);

  await ggFulfiller.releaseAccounts([String(a._id)], s1._id);
  assert.equal(await heldFor(a, s1), 0, "the named set is freed");
  assert.equal(await heldFor(a, s2), 1, "the account's other GGSel sale stays reserved");
});

test("releaseAccounts never touches another marketplace's reservation of the set", async () => {
  const a = await account("scope_b");
  const s = await set("S3", ["k4|rust"]);
  await reserved(a, s, "gameflip");
  await ggFulfiller.releaseAccounts([String(a._id)], s._id);
  assert.equal(await heldFor(a, s), 1);
});

test("releaseProvenUnsold hands back only archived codes of accounts on the row", async () => {
  const a = await account("prove_a"); // archived -> free
  const b = await account("prove_b"); // sold -> kept
  const c = await account("prove_c"); // still in stock -> kept
  const x = await account("prove_x"); // archived but never on this row -> kept
  const s = await set("S4", ["k5|rust"]);
  for (const acc of [a, b, c, x]) await reserved(acc, s, "ggsel");
  const row = {
    set: s._id,
    accountLogin: "prove_a, Prove_B, prove_c",
    units: [],
  };
  const out = await ggFulfiller.releaseProvenUnsold(row, {
    archived: [{ id: 1, login: "prove_a" }, { id: 2, login: "prove_b" }, { id: 4, login: "prove_x" }],
    sold: [{ id: 3, login: "prove_b" }],
    left: [{ id: 5, login: "prove_c" }],
  });
  assert.deepEqual(out.released, ["prove_a"]);
  assert.deepEqual(out.keptSold, ["prove_b"]);
  assert.deepEqual(out.notOnRow, ["prove_x"]);
  assert.equal(await heldFor(a, s), 0);
  assert.equal(await heldFor(b, s), 1, "a buyer holds prove_b");
  assert.equal(await heldFor(c, s), 1, "prove_c can still sell from the vault");
  assert.equal(await heldFor(x, s), 1);
});

test("releaseProvenUnsold frees every record of a twin login", async () => {
  const t1 = await account("twin_login");
  const t2 = await account("TWIN_LOGIN");
  const s = await set("S5", ["k6|rust"]);
  await reserved(t1, s, "ggsel");
  await reserved(t2, s, "ggsel");
  const out = await ggFulfiller.releaseProvenUnsold(
    { set: s._id, accountLogin: "twin_login" },
    { archived: [{ id: 1, login: "twin_login" }], sold: [], left: [] },
  );
  assert.deepEqual(out.released, ["twin_login"]);
  assert.equal(await heldFor(t1, s), 0);
  assert.equal(await heldFor(t2, s), 0);
});

async function ggRow(setDoc, accounts, over = {}) {
  return MarketplaceListing.create({
    set: setDoc._id,
    marketplace: "ggsel",
    externalId: "gg-" + ++seq,
    title: "Rust bundle",
    price: 1,
    status: "active",
    origin: "manual",
    autoDeliver: true,
    accountId: accounts.map((a) => String(a._id)).join(","),
    accountLogin: accounts.map((a) => a.login).join(", "),
    qtyTarget: accounts.length,
    ...over,
  });
}

async function del(id) {
  const r = await fetch(baseUrl + "/marketplaces/listings/" + id, {
    method: "DELETE",
    headers: { cookie },
  });
  return r.json();
}

test("Delist: a sold code's account stays reserved; other GGSel sets are never freed", async () => {
  const a = await account("del_a"); // code archived at delist -> back in stock
  const b = await account("del_b"); // code SOLD -> the buyer's
  const s = await set("S6", ["k7|rust", "k8|rust"]);
  const other = await set("S7", ["k9|rust"]);
  await reserved(a, s, "ggsel");
  await reserved(b, s, "ggsel");
  await reserved(a, other, "ggsel"); // del_a's earlier GGSel sale of another game
  const row = await ggRow(s, [a, b]);
  gg.vault = {
    archived: [{ id: 11, login: "del_a" }],
    sold: [{ id: 12, login: "del_b" }],
    left: [],
  };
  const j = await del(row._id);
  assert.equal(j.success, true);
  assert.match(j.ggsel, /1 code\(s\) archived, 1 sold; 1 account\(s\) back in stock/);
  assert.equal(await heldFor(a, s), 0, "del_a never sold: released");
  assert.equal(await heldFor(b, s), 2, "del_b was bought: kept");
  assert.equal(await heldFor(a, other), 1, "del_a's other GGSel sale untouched");
  const after = await MarketplaceListing.findById(row._id).lean();
  assert.equal(after.status, "delisted");
  assert.match(after.note, /GGSel vault emptied/);
});

test("Delist: codes that cannot be read release nothing", async () => {
  const a = await account("unread_a");
  const s = await set("S8", ["k10|rust"]);
  await reserved(a, s, "ggsel");
  const row = await ggRow(s, [a]);
  gg.vault = new Error("GGSel products: HTTP 504");
  const j = await del(row._id);
  assert.equal(j.success, true, "the offer is paused: the delist itself stands");
  assert.match(j.ggsel, /could not be read .* kept reserved/);
  assert.equal(await heldFor(a, s), 1);
  const after = await MarketplaceListing.findById(row._id).lean();
  assert.equal(after.status, "delisted");
});

test("Delist: a no-claim engine row has its vault emptied but no archive release", async () => {
  const a = await account("engine_a");
  const s = await set("S9", ["k11|rust"]);
  await reserved(a, s, "ggsel");
  const row = await ggRow(s, [a], { origin: "unclaimed", autoDeliver: false });
  gg.vault = { archived: [{ id: 21, login: "engine_a" }], sold: [], left: [] };
  const j = await del(row._id);
  assert.equal(j.success, true);
  assert.match(j.ggsel, /1 code\(s\) archived/);
  assert.doesNotMatch(j.ggsel, /back in stock/);
  assert.equal(await heldFor(a, s), 1);
});
