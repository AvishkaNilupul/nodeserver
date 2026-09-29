// REGRESSION: a rent-farm order must WAIT for its chat, not fail and page.
//
// On 2026-09-20 two live rent-farm orders paged as
//   "⚠️ eldorado rent-farm order NOT delivered … reason: order has no
//    talkJsConversationId"
// and then delivered themselves minutes later, untouched. The cause: Eldorado
// creates the order's TalkJS conversation LAZILY, so a freshly-paid order has
// talkJsConversationId=null until the chat is first opened. The credential can
// only be posted into a conversation that exists, and the GUID is Eldorado's to
// mint (it links the buyer in as a participant) — so there is nothing to do but
// wait for it to appear. deliverFarmOrder used to reach the send, throw, mark the
// order failed and page. It must instead HOLD the order in "waiting_chat",
// provision nothing (a pristine pool account is scarce and must not be burned for
// an order that cannot be handed over yet), and let a later tick deliver the
// instant the conversation shows up — paging only once the wait drags on.
process.env.TG_TOKEN = "";
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const FarmServiceOrder = require("../models/FarmServiceOrder");
const AutoFarmTask = require("../models/AutoFarmTask");
const mp = require("../utils/marketplaces");
const operatorFarm = require("../utils/operatorFarm");
const farmAlert = require("../utils/farmServiceAlert");
const farm = require("../utils/eldoradoFarmService");

let mem;
const orig = {};
const calls = { provision: [], send: [], mark: [], alert: [] };

function resetCalls() {
  calls.provision.length = 0;
  calls.send.length = 0;
  calls.mark.length = 0;
  calls.alert.length = 0;
}

function baseOrder(over = {}) {
  return {
    id: "chat-wait-order",
    offerId: "offer-1",
    purchaseQuantity: 1,
    buyerUsername: "PinkDance-YGeh",
    sellerId: "c806ac96-3b93-48e3-859f-f4b2ed7deeb0",
    talkJsConversationId: null, // the chat has not been created yet
    orderOfferDetails: {
      offerTitle: "Overwatch Twitch Drops Automatic Farming 1 Year",
    },
    ...over,
  };
}

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  // knownFarmGames() reads distinct games from these collections; seed one so
  // the title's "Overwatch" resolves and the order is NOT refused as unreadable.
  await AutoFarmTask.collection.insertOne({ game: "Overwatch" });

  orig.provision = operatorFarm.farmFreshAccounts;
  orig.send = mp.eldoradoSendOrderMessage;
  orig.mark = mp.eldoradoMarkDelivered;
  orig.alert = farmAlert.alertFarmFailure;

  // Stub only the edges that touch the world. eldoradoOrderChatReady and
  // shouldAlert stay REAL — they are what this test is guarding.
  operatorFarm.farmFreshAccounts = async (opts) => {
    calls.provision.push(opts);
    return { added: [] };
  };
  mp.eldoradoSendOrderMessage = async (...a) => {
    calls.send.push(a);
    return { ok: true };
  };
  mp.eldoradoMarkDelivered = async (...a) => {
    calls.mark.push(a);
  };
  farmAlert.alertFarmFailure = async (info) => {
    calls.alert.push(info);
  };
});

test.after(async () => {
  operatorFarm.farmFreshAccounts = orig.provision;
  mp.eldoradoSendOrderMessage = orig.send;
  mp.eldoradoMarkDelivered = orig.mark;
  farmAlert.alertFarmFailure = orig.alert;
  await mongoose.disconnect();
  await mem.stop();
});

test.beforeEach(async () => {
  await FarmServiceOrder.deleteMany({});
  resetCalls();
});

test("a chat-less order is HELD, not failed: nothing provisioned, nothing sent, no page", async () => {
  const r = await farm.deliverFarmOrder(baseOrder(), { dryRun: false });

  assert.equal(r.waiting, "chat-not-open");
  assert.equal(r.error, undefined, "a wait is not an error");
  assert.equal(calls.provision.length, 0, "no pristine pool account is burned while waiting");
  assert.equal(calls.send.length, 0, "nothing is posted to a chat that does not exist");
  assert.equal(calls.mark.length, 0, "the order is never marked delivered");
  assert.equal(calls.alert.length, 0, "the first tick does not page the operator");

  const row = await FarmServiceOrder.findOne({ orderId: "chat-wait-order" }).lean();
  assert.equal(row.state, "waiting_chat");
  assert.equal(row.provisionedAt, null);
  assert.match(row.lastError, /chat is not open yet/i);
});

test("a chat that stays shut past the quiet window finally pages — once", async () => {
  // First tick creates the row and holds it quietly.
  await farm.deliverFarmOrder(baseOrder(), { dryRun: false });
  // Fast-forward the retry counter to just before the re-alert cadence, the way
  // ~10 minutes of 60s ticks would.
  await FarmServiceOrder.updateOne(
    { orderId: "chat-wait-order" },
    { $set: { attempts: 9 } },
  );
  resetCalls();

  const r = await farm.deliverFarmOrder(baseOrder(), { dryRun: false });

  assert.equal(r.waiting, "chat-not-open");
  assert.equal(calls.provision.length, 0, "still no pool account burned");
  assert.equal(calls.alert.length, 1, "a chat unopened this long must be surfaced");
  assert.match(calls.alert[0].reason, /has not opened the order chat/i);
  assert.equal(calls.alert[0].market, "eldorado");
});

test("once Eldorado has minted the conversation id, the order proceeds to fulfilment", async () => {
  const r = await farm.deliverFarmOrder(
    baseOrder({ id: "chat-ready-order", talkJsConversationId: "43a2c023-9dd3-4a2b" }),
    { dryRun: false },
  );

  // It did NOT hold on the chat: it passed the gate and reached provisioning
  // (which is stubbed to hand back nothing, so this attempt then reports a
  // shortfall — that later step is out of scope here; the point is the gate let
  // it through the moment the conversation existed).
  assert.notEqual(r.waiting, "chat-not-open");
  assert.equal(calls.provision.length, 1, "a ready order proceeds to provisioning");
  const row = await FarmServiceOrder.findOne({ orderId: "chat-ready-order" }).lean();
  assert.notEqual(row.state, "waiting_chat");
});
