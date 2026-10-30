process.env.SESSION_SECRET ||= "epic-pa-test-session";
process.env.CRED_SECRET ||= "epic-pa-test-credentials";
process.env.PUBLIC_BASE_URL = "https://mail.example.test";
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { encrypt, decrypt } = require("../utils/secretBox");
const Account = require("../models/EpicAccount");
const Unit = require("../models/EpicPaUnit");
const Sale = require("../models/EpicSale");
const Session = require("../models/BuyerMailSession");
const sales = require("../utils/epicSales");
const pa = require("../utils/playerauctionsAccountOffers");
const epic = require("../utils/epicPa");
const mp = require("../utils/marketplaces");
const outlook = require("../utils/outlookGraphReader");
const owner = {
  firstName: "Test",
  lastName: "Owner",
  phone: "1234567890",
  email: "owner@example.test",
  city: "Tokyo",
  country: "JP",
};
const sent = [];
require("../utils/telegram").sendTelegram = async (text) => sent.push(text);
outlook.checkInbox = async () => ({
  sellable: true,
  sharedWith: [],
  status: "live",
});
let db,
  seq = 0,
  creates = 0,
  timeout = false;
let rejectCreate = false,
  rejectRead = false;
const offers = new Map();
pa.create = async (input) => {
  creates++;
  if (rejectCreate)
    throw Object.assign(new Error("throttled SECRET"), {
      __pa: true,
      paCode: rejectCreate === true ? 1 : rejectCreate,
    });
  const id = String(1000 + ++seq);
  offers.set(id, {
    gameId: 9310,
    isAuto: true,
    autoDelivery: { loginName: input.login, instruction: input.instruction },
  });
  if (timeout) throw new Error("timeout with password SECRET");
  return id;
};
pa.read = async (id) => {
  if (rejectRead)
    throw Object.assign(new Error("read failed"), { __pa: true, paCode: 400 });
  return offers.get(String(id));
};
const native = new Map();
pa.orderAccount = async (id) => native.get(String(id));
let hides = 0,
  displays = 0;
mp.playerauctionsHide = async () => hides++;
mp.playerauctionsDisplay = async () => displays++;
async function account(extra = {}) {
  const n = ++seq;
  return Account.create({
    accountId: "epic" + n,
    displayName: "Player" + n,
    email: encrypt("epic" + n + "@example.test"),
    password: encrypt("Epic-Test-Password"),
    accountDetails: encrypt(JSON.stringify(owner)),
    library: [{ title: "Test Game", priceUsd: 20 }],
    ...extra,
  });
}
function order(id, unit, login) {
  native.set(String(id), { loginName: login });
  return {
    orderId: String(id),
    orderTitle: unit.title,
    detail: {
      orderInfo: {
        offerInfo: {
          link:
            "https://www.playerauctions.com/epic-games-account/" +
            unit.offerId +
            "i!test/",
        },
      },
      status: { orderStatus: "Delivery Pending Buyer Confirmation" },
      eventLogs: [
        {
          content: "Payment settlement completed",
          dateTime: "2026-10-30T02:00:00",
        },
        {
          content: "Account delivery claimed by seller",
          dateTime: "2026-10-30T02:00:01",
        },
      ],
    },
  };
}
test.before(async () => {
  db = await MongoMemoryServer.create();
  await mongoose.connect(db.getUri());
  await Unit.init();
  await Sale.init();
});
test.after(async () => {
  epic.stop();
  await mongoose.disconnect();
  await db.stop();
});
test.beforeEach(async () => {
  for (const c of Object.values(mongoose.connection.collections))
    await c.deleteMany({});
  rejectCreate = rejectRead = false;
  offers.clear();
  native.clear();
  timeout = false;
  creates = 0;
  sent.length = 0;
  hides = displays = 0;
});
test("native Account DTO encrypts passwords and rejects incomplete recovery data", () => {
  const opts = {
    priceUsd: 5.1,
    title: "Test Game - Epic Games Account",
    original: owner,
    login: "a@example.test",
    password: "secret",
    characterName: "Player",
    description: "description",
  };
  const body = pa.body(opts);
  assert.equal(body.gameId, 9310);
  assert.equal(body.isAuto, true);
  assert.equal(body.sellerAftersaleProtection, 14);
  assert.equal(Buffer.from(body.autoDelivery.password, "base64").length, 128);
  assert.notEqual(body.autoDelivery.password, "secret");
  assert.equal(body.autoDelivery.current.email, owner.email);
  assert.throws(
    () => pa.body({ ...opts, original: { ...owner, phone: "" } }),
    /phone/,
  );
  assert.throws(() => pa.body({ ...opts, priceUsd: 4.99 }), /at least/);
  assert.throws(() => pa.body({ ...opts, priceUsd: 5.001 }), /decimal/);
});
test("empty libraries and accounts already held by G2G cannot publish", async () => {
  const empty = await account({ library: [] });
  await assert.rejects(epic.publish(String(empty._id), {}, "test"), /empty/);
  const a = await account();
  await require("../models/EpicG2gUnit").create({
    epicAccountId: a._id,
    offerId: "G1",
    login: "test",
    state: "listed",
  });
  await assert.rejects(
    epic.publish(String(a._id), { original: owner }, "test"),
    /listed/,
  );
  assert.equal(creates, 0);
});
test("missing contact details creates no reservation and no mail session", async () => {
  const a = await account({ accountDetails: "" });
  await assert.rejects(
    epic.publish(String(a._id), {}, "test"),
    /original owner/,
  );
  assert.equal(await Unit.countDocuments(), 0);
  assert.equal(await Session.countDocuments(), 0);
});
test("publish reserves stock, verifies the native delivery entry and keeps secrets out of overview", async () => {
  const a = await account();
  const u = await epic.publish(String(a._id), { original: owner }, "test");
  assert.equal(u.state, "listed");
  assert.equal(
    (await sales.listingForAccount(String(a._id))).market,
    "playerauctions",
  );
  const ctx = await sales.stockContext();
  assert.equal(sales.readinessOf(ctx.accounts[0], ctx).state, "listed");
  const session = await Session.findOne().lean();
  assert.equal(session.stage, "listed");
  assert.ok(session.passwordEnc);
  assert.equal(session.marketplace, "playerauctions");
  const json = JSON.stringify(await epic.overview());
  assert.ok(!json.includes(decrypt(session.passwordEnc)));
  assert.ok(!json.includes("Epic-Test-Password"));
});
test("concurrent publish attempts cannot create two offers for one account", async () => {
  const a = await account();
  const run = () => epic.publish(String(a._id), { original: owner }, "test");
  const results = await Promise.allSettled([run(), run()]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(creates, 1);
});
test("a timeout keeps credentials reserved and reconciliation requires the original mail entry", async () => {
  const a = await account();
  timeout = true;
  await assert.rejects(
    epic.publish(String(a._id), { original: owner }, "test"),
    /could not be confirmed/,
  );
  const u = await Unit.findOne().lean();
  assert.equal(u.state, "error");
  assert.ok(!u.note.includes("SECRET"));
  await assert.rejects(
    epic.publish(String(a._id), { original: owner }, "test"),
    /listed/,
  );
  const id = [...offers.keys()][0];
  const remote = offers.get(id);
  const instruction = remote.autoDelivery.instruction;
  remote.autoDelivery.instruction = "different mail password";
  await assert.rejects(epic.reconcile(String(u._id), id), /does not match/);
  remote.autoDelivery.instruction = instruction;
  assert.equal((await epic.reconcile(String(u._id), id)).state, "listed");
  assert.equal(creates, 1);
});
test("paid native sale is idempotent and begins the 14-day mail clock at payment", async () => {
  const a = await account();
  const u = await epic.publish(String(a._id), { original: owner }, "test");
  const o = order(123, u, decrypt(a.email));
  assert.equal(await epic.ownsOrder(o), true);
  await epic.ownsOrder(o);
  assert.equal(await Sale.countDocuments(), 1);
  assert.equal((await Account.findById(a._id)).sold, true);
  const session = await Session.findOne().lean();
  assert.equal(session.stage, "sold");
  assert.equal(session.passwordEnc, "");
  assert.equal(session.soldAt.toISOString(), "2026-10-30T02:00:00.000Z");
  assert.equal(session.expiresAt.toISOString(), "2026-11-13T02:00:00.000Z");
  const sale = await Sale.findOne().lean();
  assert.equal(sale.orderId, "pa:123");
  assert.equal(sale.quantity, 1);
  assert.ok(sale.deliveredAt);
  assert.equal(sent.filter((x) => x.includes("sold Epic account")).length, 1);
});
test("unknown native login and unpaid orders never consume the reserved account", async () => {
  const a = await account();
  const u = await epic.publish(String(a._id), { original: owner }, "test");
  const o = order(124, u, "wrong@example.test");
  await epic.ownsOrder(o);
  assert.equal(await Sale.countDocuments(), 0);
  assert.equal((await Account.findById(a._id)).sold, false);
  const unpaid = order(125, u, decrypt(a.email));
  unpaid.detail.eventLogs = [];
  await epic.ownsOrder(unpaid);
  assert.equal(await Sale.countDocuments(), 0);
});
test("refunds never recycle disclosed accounts and never reset the buyer clock", async () => {
  const a = await account();
  const u = await epic.publish(String(a._id), { original: owner }, "test");
  const o = order(126, u, decrypt(a.email));
  await epic.ownsOrder(o);
  o.detail.status.orderStatus = "Refunded";
  await epic.ownsOrder(o);
  assert.equal((await Account.findById(a._id)).sold, true);
  assert.equal((await Sale.findOne()).needsAttention, true);
  assert.equal((await Unit.findById(u.id)).state, "sold");
  assert.equal(
    (await Session.findOne()).expiresAt.toISOString(),
    "2026-11-13T02:00:00.000Z",
  );
});
test("pause and resume use Account-safe actions and preserve reservations", async () => {
  const a = await account();
  const u = await epic.publish(String(a._id), { original: owner }, "test");
  assert.equal((await epic.setPaused(u.id, true)).state, "paused");
  assert.equal(hides, 1);
  assert.equal(
    (await sales.listingForAccount(String(a._id))).market,
    "playerauctions",
  );
  assert.equal((await epic.setPaused(u.id, false)).state, "listed");
  assert.equal(displays, 1);
});
test("PA order scan matches offer IDs and does not use duplicate titles as a delivery match", async () => {
  const a = await account();
  const u = await epic.publish(String(a._id), { original: owner }, "test");
  const o = order(127, u, decrypt(a.email));
  mp.playerauctionsOrders = async () => ({
    count: 1,
    items: [{ orderId: o.orderId, orderTitle: o.orderTitle }],
  });
  mp.playerauctionsOrderDetail = async () => o.detail;
  assert.equal((await epic.tick()).checked, 1);
  assert.equal(await Sale.countDocuments(), 1);
});

test("a definite publish rejection frees the reservation and revokes its mail login", async () => {
  const a = await account();
  rejectCreate = true;
  await assert.rejects(
    epic.publish(String(a._id), { original: owner }, "test"),
    /26 seconds/,
  );
  assert.equal(await Unit.countDocuments(), 0);
  const session = await Session.findOne();
  assert.ok(session.revokedAt);
  assert.equal(session.passwordEnc, "");
  rejectCreate = false;
  assert.equal(
    (await epic.publish(String(a._id), { original: owner }, "test")).state,
    "listed",
  );
});
test("a rejected read after a successful create never frees live credentials", async () => {
  const a = await account();
  rejectRead = true;
  await assert.rejects(
    epic.publish(String(a._id), { original: owner }, "test"),
    /could not be confirmed/,
  );
  assert.equal((await Unit.findOne()).state, "error");
  assert.equal((await Session.findOne()).revokedAt, null);
  assert.equal(await Unit.countDocuments(), 1);
});

test("an unknown redirect response stays reserved for seller-offer reconciliation", async () => {
  const a = await account();
  rejectCreate = 301;
  await assert.rejects(
    epic.publish(String(a._id), { original: owner }, "test"),
    /could not be confirmed/,
  );
  assert.equal((await Unit.findOne()).state, "error");
  assert.equal((await Session.findOne()).revokedAt, null);
});
