// The rent-farm hand-over (2026-10-01): the term in the buyer's words, the
// window counted from the hand-over (a delayed one no longer costs the buyer
// hours), the end date in the message, and a failure AFTER the login reached
// the buyer kept "sent" — never paged as "NOT delivered", never re-sent.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.CRED_SECRET ||= "farm-handover-test-secret";

const pages = [];
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const from = (parent && parent.filename) || "";
  if (/utils[\\/]farmServiceAlert\.js$/.test(from)) {
    if (request === "./telegram") return { sendTelegram: async (m) => { pages.push(m); } };
    if (request === "./systemLog") return { logEvent: async () => {} };
  }
  return realLoad.call(this, request, parent, isMain);
};

const Renter = require("../models/Renter");
const RenterAccount = require("../models/RenterAccount");
const AvailableAccount = require("../models/AvailableAccount");
const FarmServiceOrder = require("../models/FarmServiceOrder");
const AutoFarmTask = require("../models/AutoFarmTask");
const { encrypt } = require("../utils/secretBox");
const mp = require("../utils/marketplaces");
const operatorFarm = require("../utils/operatorFarm");
const handover = require("../utils/farmHandover");
const farmAlert = require("../utils/farmServiceAlert");
const eld = require("../utils/eldoradoFarmService");

let mongod;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("farm-handover"));
});
test.after(async () => {
  Module._load = realLoad;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

const DAY = 86400000;

test("the term reads the way the buyer bought it", () => {
  assert.equal(handover.termWords(365), "1 year");
  assert.equal(handover.termWords(730), "2 years");
  assert.equal(handover.termWords(180), "180 days");
  assert.equal(handover.termWords(1), "1 day");
});

test("stampFromHandover moves a window LATER only, and only the holder's live, bounded rows", async () => {
  await Promise.all([Renter.deleteMany({}), RenterAccount.deleteMany({})]);
  const holder = await Renter.create({ username: "operator-selffarm", usernameLower: "operator-selffarm", passwordHash: "x" });
  const other = await Renter.create({ username: "wasd", usernameLower: "wasd", passwordHash: "x" });
  const now = Date.now();
  await RenterAccount.create({ renter: holder._id, clientSecret: "s1", login: "Early1", farmUntil: new Date(now + 10 * DAY) });
  await RenterAccount.create({ renter: holder._id, clientSecret: "s2", login: "late2", farmUntil: new Date(now + 90 * DAY) });
  await RenterAccount.create({ renter: holder._id, clientSecret: "s3", login: "open3", farmUntil: null });
  await RenterAccount.create({ renter: other._id, clientSecret: "s4", login: "early1", farmUntil: new Date(now + 10 * DAY) });
  const until = new Date(now + 30 * DAY);
  const row = { accounts: [{ login: "early1", farmUntil: new Date(now + 10 * DAY) }, { login: "late2" }, { login: "open3" }] };
  const moved = await handover.stampFromHandover(row, until);
  assert.equal(moved, 1);
  const byLogin = async (l, r) => RenterAccount.findOne({ login: l, renter: r }).lean();
  assert.equal((await byLogin("Early1", holder._id)).farmUntil.getTime(), until.getTime(), "moved later (case-insensitive login)");
  assert.equal((await byLogin("late2", holder._id)).farmUntil.getTime(), now + 90 * DAY, "never earlier");
  assert.equal((await byLogin("open3", holder._id)).farmUntil, null, "open-ended stays open");
  assert.equal((await byLogin("early1", other._id)).farmUntil.getTime(), now + 10 * DAY, "another renter's row untouched");
  assert.equal(row.accounts[0].farmUntil.getTime(), until.getTime(), "the order's copy too");
});

test("a failure after the hand-over keeps 'sent' and says the buyer HAS the login", () => {
  const row = { messageSentAt: new Date("2026-10-01T03:04:00Z"), state: "sent" };
  handover.sentButUnconfirmed(row, "Eldorado", new Error("HTTP 502"));
  assert.equal(row.state, "sent");
  assert.match(row.lastError, /the login WAS delivered to the buyer \(2026-10-01 03:04Z\); only confirming it on Eldorado failed: HTTP 502/);
});

test("'sent' is throttled like 'failed', and the page names the accounts and forbids a second hand-over", async () => {
  assert.equal(farmAlert.shouldAlert({ state: "sent", attempts: 3 }), false);
  assert.equal(farmAlert.shouldAlert({ state: "sent", attempts: farmAlert.REALERT_EVERY }), true);
  pages.length = 0;
  await farmAlert.alertFarmFailure({
    market: "Eldorado", orderId: "o1", game: "Overwatch", days: 30, qty: 1,
    reason: "the login WAS delivered…", logins: ["buyer1"], sent: true,
  });
  assert.match(pages[0], /DELIVERED to the buyer but not yet confirmed on Eldorado/);
  assert.match(pages[0], /accounts: buyer1/);
  assert.match(pages[0], /Do NOT send the login again/);
});

// ---- the Eldorado flow end to end (every outward call stubbed) -------------
async function withStubs(stubs, body) {
  const saved = [];
  for (const [obj, key, fn] of stubs) {
    saved.push([obj, key, obj[key]]);
    obj[key] = fn;
  }
  try {
    return await body();
  } finally {
    for (const [obj, key, fn] of saved) obj[key] = fn;
  }
}

async function seedFlow() {
  await Promise.all([
    Renter.deleteMany({}), RenterAccount.deleteMany({}), AvailableAccount.deleteMany({}),
    FarmServiceOrder.deleteMany({}), AutoFarmTask.deleteMany({}),
  ]);
  await new AutoFarmTask({ game: "Overwatch" }).save({ validateBeforeSave: false }); // a game the farm knows
  const holder = await Renter.create({ username: "operator-selffarm", usernameLower: "operator-selffarm", passwordHash: "x" });
  const pool = await AvailableAccount.create({
    username: "buyer1", usernameLower: "buyer1", password: encrypt("Secr3t!pw"), hasPassword: true, clientSecret: "cs1",
  });
  return { holder, pool };
}

const ORDER = {
  id: "ord-handover-1",
  offerId: "offer-1",
  purchaseQuantity: 1,
  buyerUsername: "JumpyPage",
  // The buyer's chat exists (eldoradoFarmService.orderChatReady).
  talkJsConversationId: "conv-handover-1",
  sellerId: "seller-1",
  orderOfferDetails: { offerTitle: "Overwatch Twitch Drops Automatic Farming 30 Days" },
};

test("REGRESSION: a hand-over that happens hours after provisioning re-stamps the window from the hand-over, and says until when", async () => {
  const { holder, pool } = await seedFlow();
  const sent = [];
  let sendFails = true;
  const provisioned = async ({ days }) => {
    const farmUntil = new Date(Date.now() + days * DAY);
    await RenterAccount.create({ renter: holder._id, clientSecret: "cs1", login: "buyer1", host: "contabo", configFile: "config_54.json", farmUntil });
    return { added: [{ login: "buyer1", poolId: String(pool._id) }], farmUntil };
  };
  await withStubs(
    [
      [operatorFarm, "farmFreshAccounts", provisioned],
      [mp, "eldoradoSendOrderMessage", async (o, m) => { if (sendFails) throw new Error("chat 503"); sent.push(m); }],
      [mp, "eldoradoMarkDelivered", async () => ({})],
    ],
    async () => {
      const r1 = await eld.deliverFarmOrder(ORDER);
      assert.match(String(r1.error), /chat 503/);
      // Pretend the provisioning was 6 hours ago.
      const earlier = new Date(Date.now() - 6 * 3600e3 + 30 * DAY);
      await RenterAccount.updateOne({ login: "buyer1" }, { $set: { farmUntil: earlier } });
      await FarmServiceOrder.updateOne({ orderId: ORDER.id }, { $set: { "accounts.0.farmUntil": earlier } });
      sendFails = false;
      const r2 = await eld.deliverFarmOrder(ORDER);
      assert.equal(r2.delivered, 1, JSON.stringify(r2));
    },
  );
  assert.equal(sent.length, 1);
  const acc = await RenterAccount.findOne({ login: "buyer1" }).lean();
  assert.ok(acc.farmUntil.getTime() > Date.now() + 30 * DAY - 60e3, "the buyer gets the whole 30 days from the hand-over");
  assert.match(sent[0], new RegExp("runs until " + acc.farmUntil.toISOString().slice(0, 10) + " \\(UTC\\)"));
  const row = await FarmServiceOrder.findOne({ orderId: ORDER.id }).lean();
  assert.equal(row.accounts[0].farmUntil.getTime(), acc.farmUntil.getTime(), "the order agrees with the ledger");
});

test("REGRESSION: when only confirming the delivery fails, the row stays 'sent' and the login is never sent twice", async () => {
  const { holder, pool } = await seedFlow();
  const sent = [];
  let markFails = true;
  await withStubs(
    [
      [operatorFarm, "farmFreshAccounts", async ({ days }) => {
        const farmUntil = new Date(Date.now() + days * DAY);
        await RenterAccount.create({ renter: holder._id, clientSecret: "cs1", login: "buyer1", host: "contabo", configFile: "config_54.json", farmUntil });
        return { added: [{ login: "buyer1", poolId: String(pool._id) }], farmUntil };
      }],
      [mp, "eldoradoSendOrderMessage", async (o, m) => { sent.push(m); }],
      [mp, "eldoradoMarkDelivered", async () => { if (markFails) throw new Error("HTTP 502 from Eldorado"); return {}; }],
    ],
    async () => {
      const r1 = await eld.deliverFarmOrder(ORDER);
      assert.equal(r1.sent, true);
      let row = await FarmServiceOrder.findOne({ orderId: ORDER.id }).lean();
      assert.equal(row.state, "sent", "not 'failed' — the buyer has the login");
      assert.match(row.lastError, /the login WAS delivered to the buyer/);
      markFails = false;
      const r2 = await eld.deliverFarmOrder(ORDER);
      assert.equal(r2.delivered, 1);
      row = await FarmServiceOrder.findOne({ orderId: ORDER.id }).lean();
      assert.equal(row.state, "delivered");
    },
  );
  assert.equal(sent.length, 1, "handed over exactly once");
});
