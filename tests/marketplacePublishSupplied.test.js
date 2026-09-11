/* global fetch */
// The two failures this file exists to prevent, both in the account-listing
// half of POST /marketplaces/publish (G1 and G7 of
// docs/ACCOUNT-LISTINGS-FIXES-2.md).
//
// G1 — AN EMPTY DELIVERY TEMPLATE BURNS THE WHOLE CLAIM. The GGSel and
// Digiseller auto-delivery branches rendered suppliedStock.deliveryText straight
// into the publish call with no empty-render guard. A template of only
// placeholders the pasted accounts have none of ("{token}" against a
// login:password paste) renders empty, and both downstream helpers
// .filter(Boolean) the unit list (utils/marketplaces.js:1401, :1793/:1864). By
// then claimForListing has taken the accounts and markFed has moved them to
// "fed", out of sellable stock — so the offer goes live advertising N units with
// fewer, or zero, behind it, and the accounts are gone. On GGSel it is worse
// than a shortfall: with every unit empty `autoselling` goes false
// (marketplaces.js:1868) while the quantity stays at what was asked for, so a
// plain manual offer sits live where an auto-delivery one was intended.
//
// G7 — A PAUSED OFFER REPORTED "OUT OF STOCK". F1d moved the delivery kill
// switch inside claimForListing, which now answers [] when delivery is off. The
// publish sites read that as an empty shelf and told the owner to go find
// accounts they had already added.
//
// Real router, real Mongo (mongodb-memory-server), real claim layer: only the
// outbound marketplace calls are stubbed, so what is asserted is exactly what a
// live publish would have sent — and, more to the point, what it must NOT send.
process.env.CRED_SECRET ||= "marketplace-publish-supplied-test-cred-secret";
process.env.SESSION_SECRET ||= "marketplace-publish-supplied-test-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AccountOffer = require("../models/AccountOffer");
const SuppliedAccount = require("../models/SuppliedAccount");
const MarketplaceListing = require("../models/MarketplaceListing");
const DropSet = require("../models/DropSet");
const supplied = require("../utils/suppliedStock");
const mp = require("../utils/marketplaces");
const ggFulfiller = require("../utils/ggselFulfiller");

let mem;
let server;
let baseUrl;
let cookie;
const calls = { ggsel: [], digiseller: [], dsContent: [], funpay: [], zeusx: [] };

const real = {
  ggselPublish: mp.ggselPublish,
  digisellerPublish: mp.digisellerPublish,
  digisellerAddContent: mp.digisellerAddContent,
  digisellerDelist: mp.digisellerDelist,
  funpayPublish: mp.funpayPublish,
  zeusxPublish: mp.zeusxPublish,
  ggClaim: ggFulfiller.claimAccountsForSet,
};

// Per-test ZeusX behaviour: `zeusxPlan[i]` decides what the i-th create does
// ("ok", or an Error to throw). Empty = every create succeeds.
let zeusxPlan = [];

// A template made only of a placeholder a login:password paste cannot fill.
// This is the real-world shape of the bug, not a contrived empty string.
const EMPTY_TEMPLATE = "{token}";

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("marketplace-publish-supplied"));

  mp.ggselPublish = async (args) => {
    calls.ggsel.push(args);
    return { externalId: "gg-1", url: "https://ggsel.net/1", note: "" };
  };
  mp.digisellerPublish = async (args) => {
    calls.digiseller.push(args);
    return { externalId: "ds-1", url: "https://plati.market/1", price: 12 };
  };
  mp.digisellerAddContent = async (id, lines) => {
    calls.dsContent.push({ id, lines });
    return { contentIds: lines.map((_l, i) => "c" + i) };
  };
  mp.digisellerDelist = async () => ({});
  mp.funpayPublish = async (args) => {
    calls.funpay.push(args);
    return { externalId: "fp-1", externalNode: "1234", url: "", note: "" };
  };
  mp.zeusxPublish = async (args) => {
    const i = calls.zeusx.length;
    calls.zeusx.push(args);
    const step = zeusxPlan[i];
    if (step instanceof Error) throw step;
    return {
      externalId: "zx-" + (i + 1),
      url: "https://zeusx.com/offer/zx-" + (i + 1),
      qty: 1,
      note: "",
    };
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
    req.session.admin = {
      id: "root",
      username: "root",
      role: "superadmin",
      tfa: true,
    };
    res.json({ success: true });
  });
  app.use(require("../routes/marketplaceRoutes"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;
  cookie = (await fetch(baseUrl + "/test/session")).headers
    .get("set-cookie")
    .split(";")[0];
});

test.after(async () => {
  Object.assign(mp, {
    ggselPublish: real.ggselPublish,
    digisellerPublish: real.digisellerPublish,
    digisellerAddContent: real.digisellerAddContent,
    digisellerDelist: real.digisellerDelist,
    funpayPublish: real.funpayPublish,
    zeusxPublish: real.zeusxPublish,
  });
  ggFulfiller.claimAccountsForSet = real.ggClaim;
  if (server) await new Promise((r) => server.close(r));
  // The route logs through logEvent without awaiting it; let those writes land
  // before the connection goes away.
  await new Promise((r) => setTimeout(r, 50));
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

// Six accounts, claiming two: settings.accountListings.lowStockWarnAt is 2 by
// default, so a bigger shelf keeps warnLowStock (and its Telegram call) out of
// every test here.
async function makeOffer(fields = {}) {
  const offer = await AccountOffer.create({
    title: "Twitch drops account",
    game: "Rocket League",
    priceUsd: 12,
    status: "active",
    ...fields,
  });
  return offer;
}

async function stock(offer, n = 6) {
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    lines.push("supplied_" + String(offer._id).slice(-4) + "_" + i + ":pw" + i);
  }
  const r = await supplied.addAccounts(String(offer._id), lines.join("\n"));
  assert.equal(r.added, n);
}

async function publish(body) {
  const res = await fetch(baseUrl + "/marketplaces/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      title: "Twitch drops account",
      description: "Instant delivery",
      price: 12,
      // Every category is supplied by hand so bodyCategoryGiven() short-circuits
      // the server-side resolver: no live GGSel/Plati lookup from a test.
      ...body,
    }),
  });
  const json = await res.json();
  assert.equal(json.success, true);
  return json.results;
}

const GG_AUTO = { categoryId: "999", delivery: "auto", quantity: 2 };
const DS_AUTO = {
  categories: [{ owner: 1, categoryId: "34187", attributes: [] }],
  delivery: "auto",
  quantity: 2,
};

async function statuses(offer) {
  const rows = await SuppliedAccount.find({ offer: offer._id }, { status: 1 })
    .lean()
    .sort({ _id: 1 });
  const out = {};
  for (const r of rows) out[r.status] = (out[r.status] || 0) + 1;
  return out;
}

test("G1: GGSel refuses an empty render instead of publishing an offer with no products behind it", async () => {
  const offer = await makeOffer({ deliveryTemplate: EMPTY_TEMPLATE });
  await stock(offer);
  calls.ggsel.length = 0;

  const results = await publish({
    offerId: String(offer._id),
    marketplaces: ["ggsel"],
    ggsel: GG_AUTO,
  });

  assert.equal(results.ggsel.success, false);
  assert.match(results.ggsel.message, /rendered empty/i);
  // Nothing reached GGSel: an offer created with autoselling silently off is
  // exactly the live-but-empty listing this guard exists to stop.
  assert.equal(calls.ggsel.length, 0);
  assert.equal(await MarketplaceListing.countDocuments({}), 0);
  // And the claim was handed back — not left "sold"/"fed" and unsellable.
  assert.deepEqual(await statuses(offer), { available: 6 });
});

test("G1: Digiseller refuses an empty render before a product is created", async () => {
  const offer = await makeOffer({ deliveryTemplate: EMPTY_TEMPLATE });
  await stock(offer);
  calls.digiseller.length = 0;
  calls.dsContent.length = 0;

  const results = await publish({
    offerId: String(offer._id),
    marketplaces: ["digiseller"],
    digiseller: DS_AUTO,
  });

  assert.equal(results.digiseller.success, false);
  assert.match(results.digiseller.message, /rendered empty/i);
  // The all-empty case used to die downstream on "No content lines given",
  // which left a created-then-delisted junk product on Plati. Refusing up front
  // means the product is never created at all.
  assert.equal(calls.digiseller.length, 0);
  assert.equal(calls.dsContent.length, 0);
  assert.deepEqual(await statuses(offer), { available: 6 });
});

test("G1: a PARTIAL empty render is refused too — the shortfall Digiseller's own filter would have hidden", async () => {
  // "{token}" renders for the account pasted with one and empty for the account
  // pasted without: digisellerAddContent .filter(Boolean)s the empty away, so
  // the product would go live with one content unit for two claimed accounts.
  const offer = await makeOffer({ deliveryTemplate: EMPTY_TEMPLATE });
  await supplied.addAccounts(
    String(offer._id),
    ["partial_a:pw:tok_a", "partial_b:pw"].join("\n"),
  );
  calls.digiseller.length = 0;

  const results = await publish({
    offerId: String(offer._id),
    marketplaces: ["digiseller"],
    digiseller: DS_AUTO,
  });

  assert.equal(results.digiseller.success, false);
  assert.match(results.digiseller.message, /1 of 2/);
  assert.equal(calls.digiseller.length, 0);
  assert.deepEqual(await statuses(offer), { available: 2 });
});

test("G1: the refusal is scoped to its own marketplace — the rest of the loop still publishes", async () => {
  const offer = await makeOffer({ deliveryTemplate: EMPTY_TEMPLATE });
  await stock(offer);
  calls.ggsel.length = 0;
  calls.funpay.length = 0;

  const results = await publish({
    offerId: String(offer._id),
    marketplaces: ["ggsel", "funpay"],
    ggsel: GG_AUTO,
    // FunPay is fed funpayDeliveryLine(), never the offer's template, so it is
    // unaffected by the empty template and must go live as it always did.
    funpay: { nodeId: "1234", delivery: "auto", amount: 1 },
  });

  assert.equal(results.ggsel.success, false);
  assert.equal(results.funpay.success, true);
  assert.equal(calls.ggsel.length, 0);
  assert.equal(calls.funpay.length, 1);
  assert.equal(calls.funpay[0].secrets.length, 1);
  // GGSel's two are back on the shelf; FunPay's one is in FunPay's vault.
  assert.deepEqual(await statuses(offer), { available: 5, fed: 1 });
});

test("G7: a switched-off offer says so instead of reporting an empty shelf", async () => {
  const offer = await makeOffer({ autoDeliver: false });
  await stock(offer);
  calls.ggsel.length = 0;

  const results = await publish({
    offerId: String(offer._id),
    marketplaces: ["ggsel"],
    ggsel: GG_AUTO,
  });

  assert.equal(results.ggsel.success, false);
  assert.match(results.ggsel.message, /switched off/i);
  assert.doesNotMatch(results.ggsel.message, /Out of stock/i);
  // The dryRun probe that told the two apart must not have taken anything.
  assert.deepEqual(await statuses(offer), { available: 6 });
  assert.equal(calls.ggsel.length, 0);
});

test("G7: a genuinely empty shelf still says out of stock", async () => {
  const offer = await makeOffer();
  const results = await publish({
    offerId: String(offer._id),
    marketplaces: ["digiseller"],
    digiseller: DS_AUTO,
  });

  assert.equal(results.digiseller.success, false);
  assert.match(results.digiseller.message, /Out of stock/i);
  assert.doesNotMatch(results.digiseller.message, /switched off/i);
});

test("an ordinary DropSet-backed publish is untouched by both fixes", async () => {
  const set = await DropSet.create({ name: "Drops bundle", price: 12 });
  calls.ggsel.length = 0;

  // Out of stock: the archive wording must be byte-identical to what it was.
  ggFulfiller.claimAccountsForSet = async () => [];
  let results = await publish({
    setId: String(set._id),
    marketplaces: ["ggsel"],
    ggsel: GG_AUTO,
  });
  assert.equal(results.ggsel.success, false);
  assert.equal(
    results.ggsel.message,
    "Out of stock — no unsold account holds this whole bundle, so there is " +
      "nothing to auto-deliver",
  );

  // In stock: the archive's own `code` still goes out verbatim, with no
  // deliveryText and no empty-render check anywhere near it.
  ggFulfiller.claimAccountsForSet = async () => [
    { accountId: "acct-1", login: "archive_1", code: "archive_1:pw" },
  ];
  results = await publish({
    setId: String(set._id),
    marketplaces: ["ggsel"],
    ggsel: GG_AUTO,
  });
  assert.equal(results.ggsel.success, true);
  assert.equal(calls.ggsel.length, 1);
  assert.deepEqual(calls.ggsel[0].products, ["archive_1:pw"]);
  ggFulfiller.claimAccountsForSet = real.ggClaim;
});

// ---------------------------------------------------------------------------
// ZeusX — an account listing is one AUTOMATIC offer per pasted account.
//
// What must never happen: an account listing going out as a plain Coordinated
// offer that claims nothing (a ZeusX sale then leaves the same account on sale
// everywhere else), several accounts packed into one offer (ZeusX takes one
// credential per offer), an account handed back to the shelf when ZeusX may
// hold it (its create is known to answer 500 and still create the offer), or an
// account stranded out of stock when ZeusX provably never received it.
// ---------------------------------------------------------------------------

function zxErr(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

async function publishZeusx(offer, quantity) {
  calls.zeusx.length = 0;
  return publish({
    offerId: String(offer._id),
    marketplaces: ["zeusx"],
    zeusx: { quantity },
  });
}

test("ZeusX: one automatic offer per account, and those accounts leave the shelf", async () => {
  const offer = await makeOffer();
  await stock(offer);
  zeusxPlan = [];

  const results = await publishZeusx(offer, 3);
  assert.equal(results.zeusx.success, true, results.zeusx.message);
  assert.match(results.zeusx.note, /3 automatic ZeusX offer/);

  assert.equal(calls.zeusx.length, 3);
  const logins = new Set();
  for (const c of calls.zeusx) {
    assert.equal(c.autoDeliverAccounts.length, 1, "one credential per offer");
    const a = c.autoDeliverAccounts[0];
    assert.ok(a.login && a.password, "a real login and password reach ZeusX");
    assert.equal(a.email, "", "the account's recovery mail is not handed over");
    logins.add(a.login);
  }
  assert.equal(logins.size, 3, "three different accounts, never one twice");

  const rows = await MarketplaceListing.find({
    accountOffer: offer._id,
    marketplace: "zeusx",
  }).lean();
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.set, null);
    assert.equal(r.origin, "manual", "owner stock is never auto-repriced");
    assert.equal(r.autoDeliver, true);
    assert.equal(r.accountId, "");
    assert.equal(r.accountLogin, "");
    assert.equal(r.units.length, 1);
    assert.ok(logins.has(r.units[0].login));
  }
  assert.deepEqual(await statuses(offer), { available: 3, fed: 3 });
  const fed = await SuppliedAccount.find({ offer: offer._id, status: "fed" }).lean();
  assert.ok(fed.every((f) => f.market === "zeusx"));
  assert.deepEqual(
    new Set(fed.map((f) => String(f.listing))),
    new Set(rows.map((r) => String(r._id))),
    "each account points at its own ZeusX listing",
  );
});

test("ZeusX: a failure before the create hands every account back and stops", async () => {
  const offer = await makeOffer();
  await stock(offer);
  zeusxPlan = [
    zxErr('ZeusX has no game called "Rocket League" in its Accounts catalog'),
  ];

  const results = await publishZeusx(offer, 3);
  assert.equal(results.zeusx.success, false);
  assert.match(results.zeusx.message, /no game called/);
  assert.equal(calls.zeusx.length, 1, "the same error would hit every account");
  assert.deepEqual(await statuses(offer), { available: 6 });
  assert.equal(
    await MarketplaceListing.countDocuments({ accountOffer: offer._id }),
    0,
  );
});

test("ZeusX: a create that may have gone through holds that ONE account out of stock", async () => {
  const offer = await makeOffer();
  await stock(offer);
  zeusxPlan = [
    "ok",
    zxErr("ZeusX create: Request failed with status code 500", { status: 500 }),
  ];

  const results = await publishZeusx(offer, 3);
  // The first account is live, the second may be live on ZeusX, the third was
  // never sent.
  assert.equal(results.zeusx.success, true);
  assert.equal(calls.zeusx.length, 2, "the run stops at the first failure");
  const heldLogin = calls.zeusx[1].autoDeliverAccounts[0].login;
  assert.match(results.zeusx.note, /Held out of stock/);
  assert.ok(results.zeusx.note.includes(heldLogin), "the held account is named");

  assert.deepEqual(await statuses(offer), { available: 4, fed: 2 });
  const held = await SuppliedAccount.findOne({
    offer: offer._id,
    loginLower: heldLogin.toLowerCase(),
  }).lean();
  assert.equal(held.status, "fed", "never back on the shelf while ZeusX may sell it");
  assert.equal(held.market, "zeusx");
  assert.equal(held.listing, null);
  assert.equal(
    await MarketplaceListing.countDocuments({ accountOffer: offer._id }),
    1,
  );
});

test("ZeusX: a create ZeusX refused outright hands the account back", async () => {
  for (const refusal of [
    zxErr("ZeusX create: Listed price is too low", { __zeusx: true }),
    zxErr("ZeusX create: Too Many Requests", { status: 429 }),
  ]) {
    const offer = await makeOffer();
    await stock(offer);
    zeusxPlan = [refusal];
    const results = await publishZeusx(offer, 2);
    assert.equal(results.zeusx.success, false);
    assert.equal(results.zeusx.message.includes("Held out of stock"), false);
    assert.deepEqual(
      await statuses(offer),
      { available: 6 },
      "a refused create made nothing, so nothing is held: " + refusal.message,
    );
  }
});

test("ZeusX: an empty shelf is refused before anything reaches ZeusX", async () => {
  const offer = await makeOffer();
  zeusxPlan = [];
  const results = await publishZeusx(offer, 2);
  assert.equal(results.zeusx.success, false);
  assert.match(results.zeusx.message, /Out of stock/i);
  assert.equal(calls.zeusx.length, 0);
});

test("ZeusX: a set-backed publish is still the one Coordinated offer it always was", async () => {
  const set = await DropSet.create({ name: "Drops bundle", price: 12 });
  zeusxPlan = [];
  calls.zeusx.length = 0;
  const results = await publish({
    setId: String(set._id),
    marketplaces: ["zeusx"],
    zeusx: { quantity: 2 },
  });
  assert.equal(results.zeusx.success, true);
  assert.equal(calls.zeusx.length, 1);
  assert.equal(calls.zeusx[0].quantity, 2);
  assert.equal(calls.zeusx[0].autoDeliverAccounts, undefined);
  const row = await MarketplaceListing.findOne({ set: set._id, marketplace: "zeusx" }).lean();
  assert.ok(row);
  assert.equal(row.accountOffer, null);
});

// ---------------------------------------------------------------------------
// EpicNPC — the browser bridge takes an account listing too.
// ---------------------------------------------------------------------------

async function prepareEpic(body) {
  const res = await fetch(baseUrl + "/marketplaces/epicnpc/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function epicPayload(url) {
  const enc = String(url).split("#epfill=")[1] || "";
  const b64 = enc.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

test("EpicNPC: an account listing copied from a set posts with that set's drops", async () => {
  const set = await DropSet.create({
    name: "RL bundle",
    items: [
      { itemKey: "octane decal|rocket league", name: "Octane Decal", game: "Rocket League" },
      { itemKey: "wheels|rocket league", name: "Wheels", game: "Rocket League", qty: 2 },
    ],
    price: 12,
  });
  const offer = await makeOffer({
    sourceSet: set._id,
    description: "Line one\nLine two",
  });

  const { status, json } = await prepareEpic({
    offerId: String(offer._id),
    game: "Rocket League",
    price: 15,
    record: true,
  });
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.success, true);
  assert.match(json.url, /epicnpc\.com\/forums\/x\.913\//);

  const payload = epicPayload(json.url);
  assert.equal(payload.title, "Rocket League Twitch Drops Account | 2+ Unclaimed Rewards");
  assert.match(payload.descHtml, /Line one<br>Line two/, "line breaks survive");
  assert.match(payload.descHtml, /2× Wheels/, "the source set's drops are listed");

  const row = await MarketplaceListing.findById(json.listingId).lean();
  assert.equal(row.marketplace, "epicnpc");
  assert.equal(String(row.accountOffer), String(offer._id));
  assert.equal(row.set, null);
  assert.equal(row.origin, "manual");
  assert.deepEqual(row.units, [], "nothing is claimed for a hand-delivered post");
  assert.match(row.note, /hand the account over yourself/);
});

test("EpicNPC: a hand-made account listing keeps its own title and its floor", async () => {
  const offer = await makeOffer({
    title: "Rocket League account, 40 drops",
    minPriceUsd: 9,
  });
  const { status, json } = await prepareEpic({
    offerId: String(offer._id),
    game: "Rocket League",
    price: 5,
    record: true,
  });
  assert.equal(status, 200, JSON.stringify(json));
  const payload = epicPayload(json.url);
  assert.equal(payload.title, "Rocket League account, 40 drops", "no \"0+ Unclaimed Rewards\"");
  assert.doesNotMatch(payload.descHtml, /Full Reward List/);
  assert.equal(payload.priceUsd, 9, "the offer's own floor applies here too");
  const row = await MarketplaceListing.findById(json.listingId).lean();
  assert.equal(row.price, 9);
});

test("EpicNPC: an unknown account listing is a 404, and nothing is recorded", async () => {
  const before = await MarketplaceListing.countDocuments({ marketplace: "epicnpc" });
  const { status } = await prepareEpic({
    offerId: new mongoose.Types.ObjectId().toString(),
    game: "Rocket League",
    record: true,
  });
  assert.equal(status, 404);
  const bad = await prepareEpic({ offerId: "nope", game: "Rocket League", record: true });
  assert.equal(bad.status, 404);
  assert.equal(await MarketplaceListing.countDocuments({ marketplace: "epicnpc" }), before);
});
