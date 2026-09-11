/* global fetch */
// The failure this file exists to prevent: S1 of
// docs/ACCOUNT-LISTINGS-FIXES-3.md — DELISTING AN ACCOUNT LISTING DESTROYED ITS
// STOCK.
//
// DELETE /marketplaces/listings/:id handed reserved accounts back only under
// `if (row.autoDeliver && row.accountId)`, and an offer-backed row leaves
// accountId empty on purpose (contract B5, because marketplaceGuardian indexes
// duplicate findings off exactly that field). So the block was unreachable for
// owner-supplied stock: publish 20 accounts to GGSel, delist, and all 20 stayed
// "fed" forever — outside suppliedStock.stockFor, with no UI control to bring
// them back (the × renders only for "available") and no other path that ever
// would.
//
// Real router, real Mongo (mongodb-memory-server), real claim layer: only the
// outbound marketplace calls are stubbed, so the ledger transitions asserted
// here are the ones a live delist performs.
process.env.CRED_SECRET ||= "marketplace-delist-supplied-test-cred-secret";
process.env.SESSION_SECRET ||= "marketplace-delist-supplied-test-secret";

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
const calls = { ggsel: [], delist: [], released: [] };

const real = {
  ggselPublish: mp.ggselPublish,
  ggselDelist: mp.ggselDelist,
  ggRelease: ggFulfiller.releaseAccounts,
  zeusxPublish: mp.zeusxPublish,
  zeusxDelist: mp.zeusxDelist,
  zeusxOffer: mp.zeusxOffer,
};

// Per-test ZeusX answers: what the hide does, and what reading the offer back
// returns (an object, or an Error to throw).
const zx = { hide: null, offer: null, published: 0 };

const GG_AUTO = { categoryId: "999", delivery: "auto", quantity: 2 };

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("marketplace-delist-supplied"));

  mp.ggselPublish = async (args) => {
    calls.ggsel.push(args);
    return { externalId: "gg-" + calls.ggsel.length, url: "", note: "" };
  };
  mp.ggselDelist = async (id) => {
    calls.delist.push(id);
  };
  ggFulfiller.releaseAccounts = async (ids) => {
    calls.released.push(ids);
  };
  mp.zeusxPublish = async () => {
    zx.published += 1;
    return { externalId: "zx-del-" + zx.published, url: "", qty: 1, note: "" };
  };
  mp.zeusxDelist = async () => {
    if (zx.hide instanceof Error) throw zx.hide;
  };
  mp.zeusxOffer = async () => {
    if (zx.offer instanceof Error) throw zx.offer;
    return zx.offer;
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
    ggselDelist: real.ggselDelist,
    zeusxPublish: real.zeusxPublish,
    zeusxDelist: real.zeusxDelist,
    zeusxOffer: real.zeusxOffer,
  });
  ggFulfiller.releaseAccounts = real.ggRelease;
  if (server) await new Promise((r) => server.close(r));
  // The route logs through logEvent without awaiting it; let those writes land
  // before the connection goes away.
  await new Promise((r) => setTimeout(r, 50));
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

// Six accounts on the shelf keeps warnLowStock (lowStockWarnAt is 2) and its
// Telegram call out of every test here.
async function offerWithStock(n = 6) {
  const offer = await AccountOffer.create({
    title: "Twitch drops account",
    game: "Rocket League",
    priceUsd: 12,
    status: "active",
  });
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    lines.push("del_" + String(offer._id).slice(-4) + "_" + i + ":pw" + i);
  }
  const r = await supplied.addAccounts(String(offer._id), lines.join("\n"));
  assert.equal(r.added, n);
  return offer;
}

async function statuses(offer) {
  const rows = await SuppliedAccount.find({ offer: offer._id }, { status: 1 })
    .lean()
    .sort({ _id: 1 });
  const out = {};
  for (const r of rows) out[r.status] = (out[r.status] || 0) + 1;
  return out;
}

async function publishGgsel(offer) {
  const res = await fetch(baseUrl + "/marketplaces/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      offerId: String(offer._id),
      title: "Twitch drops account",
      description: "Instant delivery",
      price: 12,
      marketplaces: ["ggsel"],
      ggsel: GG_AUTO,
    }),
  });
  const json = await res.json();
  assert.equal(json.results.ggsel.success, true);
  return json.results.ggsel.id;
}

async function delist(id) {
  const res = await fetch(baseUrl + "/marketplaces/listings/" + id, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  return res.json();
}

test("S1: delisting an account listing hands its fed accounts back to the shelf", async () => {
  const offer = await offerWithStock();
  const id = await publishGgsel(offer);
  // Two accounts are inside GGSel's own vault at this point.
  assert.deepEqual(await statuses(offer), { available: 4, fed: 2 });

  const json = await delist(id);

  assert.equal(json.success, true);
  // The count is the owner's only signal that the stock survived.
  assert.equal(json.returned, 2);
  assert.match(json.message, /2 account\(s\) returned/);
  assert.deepEqual(await statuses(offer), { available: 6 });
  // And they are claimable again, not merely "available": a released row keeps
  // no market, listing or contentId pointing at the offer that is now gone.
  assert.equal(await supplied.stockFor(String(offer._id)), 6);
  const back = await SuppliedAccount.findOne({
    offer: offer._id,
    status: "available",
    market: "",
  }).lean();
  assert.ok(back);
  assert.equal(back.listing, null);
  assert.equal(back.contentId, "");
});

test("S1: a credential that already reached a buyer is never put back on sale", async () => {
  const offer = await offerWithStock();
  const id = await publishGgsel(offer);
  const row = await MarketplaceListing.findById(id);
  const ids = row.units.map((u) => String(u.contentId));
  assert.equal(ids.length, 2);
  // One was delivered, one is still sitting in the vault unsold.
  await supplied.markDelivered([ids[0]], { market: "ggsel" });
  await MarketplaceListing.updateOne(
    { _id: row._id, "units.contentId": ids[0] },
    { $set: { "units.$.deliveredAt": new Date() } },
  );

  const json = await delist(id);

  assert.equal(json.success, true);
  assert.equal(json.returned, 1);
  assert.deepEqual(await statuses(offer), { available: 5, sold: 1 });
  const delivered = await SuppliedAccount.findById(ids[0]).lean();
  assert.equal(delivered.status, "sold");
  assert.ok(delivered.deliveredAt);
});

test("S1: an account still committed to a paid order is left alone", async () => {
  const offer = await offerWithStock();
  const id = await publishGgsel(offer);
  const row = await MarketplaceListing.findById(id);
  const ids = row.units.map((u) => String(u.contentId));
  // A claim-at-sale fulfiller stamps the unit with the order it is mid-delivery
  // on; releasing that would leave the retry claiming a second account for an
  // order the buyer has already paid for.
  await MarketplaceListing.updateOne(
    { _id: row._id, "units.contentId": ids[1] },
    { $set: { "units.$.orderId": "order-77" } },
  );
  await SuppliedAccount.updateOne(
    { _id: ids[1] },
    { $set: { status: "sold", orderId: "order-77" } },
  );

  const json = await delist(id);

  assert.equal(json.returned, 1);
  const held = await SuppliedAccount.findById(ids[1]).lean();
  assert.equal(held.status, "sold");
  assert.equal(held.orderId, "order-77");
});

test("an ordinary DropSet-backed delist is untouched", async () => {
  const set = await DropSet.create({ name: "Drops bundle", price: 12 });
  const row = await MarketplaceListing.create({
    set: set._id,
    marketplace: "ggsel",
    externalId: "gg-archive-1",
    title: "Drops bundle",
    price: 12,
    status: "active",
    autoDeliver: true,
    accountId: "acct-1,acct-2",
    accountLogin: "archive_1, archive_2",
  });
  calls.released.length = 0;

  const json = await delist(String(row._id));

  // Byte-identical to what it always answered: no `returned`, no `message`.
  assert.deepEqual(json, { success: true });
  assert.deepEqual(calls.released, [["acct-1", "acct-2"]]);
  const after = await MarketplaceListing.findById(row._id).lean();
  assert.equal(after.status, "delisted");
});

// Delisting must hand back an account parked in a marketplace's VAULT even when
// its unit carries an orderId — because Gameflip's is synthetic.
//
// gameflipFulfiller stamps "gameflip-publish:<offer>:<ms>:<rand>" on the unit at
// publish (utils/gameflipFulfiller.js:384), unique per attempt so suppliedStock's
// resume path cannot hand unit 2 of a relist chain the account unit 1 is still
// selling. The delist release originally skipped any unit with an orderId,
// reading it as "a live sale owns this" — so on prod 2026-09-10 a real Gameflip
// test listing delisted with returned=0 and left its account stranded at "fed",
// which is exactly the S1 bug the branch exists to prevent.
//
// The ledger status is the authority: "fed" = parked in a vault that dies with
// the offer (return it), "sold" = committed to a buyer (leave it alone).
test("delist returns a vault-parked account whose unit carries a publish orderId", async () => {
  const offer = await offerWithStock(2);
  const pubOrder = "gameflip-publish:" + offer._id + ":1757500000000:ab12cd";

  const claimed = await supplied.claimForListing(String(offer._id), 1, {
    orderId: pubOrder,
    market: "gameflip",
  });
  assert.equal(claimed.length, 1);
  await supplied.markFed(
    claimed.map((c) => c.ledgerId),
    { market: "gameflip" },
  );

  const row = await MarketplaceListing.create({
    accountOffer: offer._id,
    // ggsel because it is the marketplace this file stubs; the delist release
    // branch is marketplace-agnostic and the orderId SHAPE is what matters.
    marketplace: "ggsel",
    externalId: "gf-synthetic-order-test",
    origin: "manual",
    status: "active",
    autoDeliver: true,
    units: [
      {
        contentId: String(claimed[0].ledgerId),
        accountId: "",
        login: claimed[0].login,
        orderId: pubOrder,
        deliveredAt: null,
      },
    ],
  });

  assert.equal((await statuses(offer)).fed, 1, "parked in Gameflip's vault");

  const body = await delist(String(row._id));
  assert.equal(body.success, true);
  assert.equal(body.returned, 1, "the vault-parked account must come back");

  const after = await statuses(offer);
  assert.equal(after.fed, undefined, "nothing left stranded at fed");
  assert.equal(after.available, 2, "the whole shelf is sellable again");
});

test("delist does NOT take back an account already committed to a buyer", async () => {
  const offer = await offerWithStock(1);

  // A claim-at-sale market mid-order: status "sold", a REAL order id, not yet
  // delivered. Delisting the offer does not cancel the order behind it.
  const claimed = await supplied.claimForListing(String(offer._id), 1, {
    orderId: "ELD-real-order-771",
    market: "eldorado",
  });
  const row = await MarketplaceListing.create({
    accountOffer: offer._id,
    marketplace: "ggsel",
    externalId: "eld-committed-test",
    origin: "manual",
    status: "active",
    units: [
      {
        contentId: String(claimed[0].ledgerId),
        accountId: "",
        login: claimed[0].login,
        orderId: "ELD-real-order-771",
        deliveredAt: null,
      },
    ],
  });

  const body = await delist(String(row._id));
  assert.equal(body.success, true);
  assert.equal(body.returned, 0, "a sale in flight keeps its account");
  assert.equal((await statuses(offer)).sold, 1, "still committed to the buyer");
});

// ---------------------------------------------------------------------------
// ZeusX account listings: an account comes back ONLY when ZeusX shows it unsold.
//
// ZeusX hands an automatic offer's credential to the buyer by itself and no
// poller of ours watches for that, so on ZeusX a "fed" ledger row cannot tell a
// parked account from one a buyer already holds. Handing it back blind — which
// is what every other market's delist does — would sell it a second time.
// ---------------------------------------------------------------------------

async function publishZeusxOne(offer) {
  const res = await fetch(baseUrl + "/marketplaces/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      offerId: String(offer._id),
      title: "Twitch drops account",
      description: "Instant delivery",
      price: 12,
      marketplaces: ["zeusx"],
      zeusx: { quantity: 1 },
    }),
  });
  const json = await res.json();
  assert.equal(json.results.zeusx.success, true, json.results.zeusx.message);
  const row = await MarketplaceListing.findById(json.results.zeusx.id).lean();
  assert.equal(row.units.length, 1);
  return { id: String(row._id), ledgerId: String(row.units[0].contentId) };
}

const UNSOLD = { offer_status: "CREATED", quantity: 1, is_hidden: true };

test("ZeusX: an offer ZeusX shows unsold hands its account back", async () => {
  const offer = await offerWithStock();
  const { id, ledgerId } = await publishZeusxOne(offer);
  assert.deepEqual(await statuses(offer), { available: 5, fed: 1 });
  zx.hide = null;
  zx.offer = { ...UNSOLD };

  const json = await delist(id);
  assert.equal(json.success, true);
  assert.equal(json.returned, 1);
  assert.deepEqual(await statuses(offer), { available: 6 });
  assert.equal((await SuppliedAccount.findById(ledgerId).lean()).market, "");
  assert.equal((await MarketplaceListing.findById(id).lean()).status, "delisted");
});

test("ZeusX: an offer that sold keeps its account with the buyer and records the sale", async () => {
  for (const soldOffer of [
    { offer_status: "CREATED", quantity: 0 },
    { offer_status: "CREATED", quantity: 1, offer_purchases: [{ id: "p1" }] },
  ]) {
    const offer = await offerWithStock();
    const { id, ledgerId } = await publishZeusxOne(offer);
    zx.hide = null;
    zx.offer = soldOffer;

    const json = await delist(id);
    assert.equal(json.success, true);
    assert.equal(json.returned, 0, "a sold account never goes back on sale");
    assert.match(json.message, /sold on ZeusX/i);
    const acct = await SuppliedAccount.findById(ledgerId).lean();
    assert.equal(acct.status, "sold");
    assert.ok(acct.deliveredAt, "the ledger records the delivery");
    assert.equal((await MarketplaceListing.findById(id).lean()).status, "sold");
  }
});

test("ZeusX: when ZeusX cannot confirm it unsold, the account stays out of stock", async () => {
  for (const unclear of [
    new Error("ZeusX offer: Request failed with status code 503"),
    { offer_status: "SOLD_OUT", quantity: 1 },
    { offer_status: "CREATED" },
    null,
  ]) {
    const offer = await offerWithStock();
    const { id, ledgerId } = await publishZeusxOne(offer);
    zx.hide = null;
    zx.offer = unclear;

    const json = await delist(id);
    assert.equal(json.success, true, "the delist itself still happened");
    assert.equal(json.returned, 0);
    assert.match(json.message, /kept out of stock/);
    assert.equal(
      (await SuppliedAccount.findById(ledgerId).lean()).status,
      "fed",
      "held, not handed back",
    );
    const row = await MarketplaceListing.findById(id).lean();
    assert.equal(row.status, "delisted");
    assert.match(row.note, /could not confirm it unsold/);
  }
});

test("ZeusX: a sold offer that refuses the hide is still resolved as sold", async () => {
  const offer = await offerWithStock();
  const { id, ledgerId } = await publishZeusxOne(offer);
  zx.hide = new Error("ZeusX delist: Offer cannot be modified");
  zx.offer = { offer_status: "CREATED", quantity: 0 };

  const json = await delist(id);
  assert.equal(json.success, true);
  assert.equal((await MarketplaceListing.findById(id).lean()).status, "sold");
  assert.equal((await SuppliedAccount.findById(ledgerId).lean()).status, "sold");
});

test("ZeusX: a refused hide on an unsold offer is a failed delist, and nothing moves", async () => {
  const offer = await offerWithStock();
  const { id, ledgerId } = await publishZeusxOne(offer);
  zx.hide = new Error("ZeusX delist: Unauthorized");
  zx.offer = { ...UNSOLD, is_hidden: false };

  const json = await delist(id);
  assert.equal(json.success, false);
  const row = await MarketplaceListing.findById(id).lean();
  assert.equal(row.status, "active", "still on sale, so still active");
  assert.match(row.lastError, /Unauthorized/);
  assert.equal((await SuppliedAccount.findById(ledgerId).lean()).status, "fed");
  zx.hide = null;
});
