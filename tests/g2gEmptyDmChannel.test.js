// G2G order 1789095953271SGMG (Sea of Thieves Twitch Drops, $2.36, buyer
// 1000423179) sat paid and "delivering" while the fulfiller reported, every 60s,
// "no existing conversation with buyer 1000423179".
//
// The conversation existed: `g2g_dm_5700688_1000423179`, customType "dm", 2
// members — just EMPTY. SendBird's channel-list query leaves out channels with
// no messages unless `includeEmpty` is set, and a fresh order's DM has none.
// G2G's own chat client sets includeEmpty (and filters by customType "dm").
//
// Two more things were fixed alongside:
// - the channel was taken as `channels[0]` of "every channel the buyer is in",
//   while our seller account also sits in G2G's ~10,000-member seller
//   SUPERGROUPS. Only a private 2-member DM may ever receive a credential.
// - after a verified send, G2G's delivered_qty (still HTTP 500 to this client)
//   threw, and the order paged "the bot cannot ship it — deliver by hand" about
//   a buyer who already had the account.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const chat = require("../utils/g2gChat");
const CHAT = fs.readFileSync(path.join(__dirname, "..", "utils", "g2gChat.js"), "utf8");
const MP = fs.readFileSync(path.join(__dirname, "..", "utils", "marketplaces.js"), "utf8");
const FULFILLER = fs.readFileSync(
  path.join(__dirname, "..", "utils", "g2gFulfiller.js"),
  "utf8",
);

const SELLER = "5700688";
const BUYER = "1000423179";

// The exact channel prod had for the stuck order.
const emptyDm = () => ({
  url: "g2g_dm_5700688_1000423179",
  customType: "dm",
  memberCount: 2,
  isSuper: false,
  lastMessage: null,
  members: [{ userId: SELLER }, { userId: BUYER }],
});

const supergroup = () => ({
  url: "g2g_sg_seller_game_items-2",
  customType: "sg_seller",
  memberCount: 9610,
  isSuper: true,
  members: [{ userId: SELLER }, { userId: BUYER }],
});

/* --------------------------- choosing the channel -------------------------- */

test("REGRESSION: an empty DM with the buyer is the hand-over channel", () => {
  const c = chat.pickDmChannel([emptyDm()], SELLER, BUYER);
  assert.ok(c, "the empty DM must be picked");
  assert.strictEqual(c.url, "g2g_dm_5700688_1000423179");
});

test("the list query asks for empty channels", () => {
  const block = CHAT.slice(CHAT.indexOf("createMyGroupChannelListQuery({"));
  assert.match(block.slice(0, 300), /includeEmpty: true/);
  assert.match(block.slice(0, 300), /customTypesFilter: \["dm"\]/);
});

test("a supergroup is never picked, even when it comes first", () => {
  const c = chat.pickDmChannel([supergroup(), emptyDm()], SELLER, BUYER);
  assert.strictEqual(c.url, "g2g_dm_5700688_1000423179");
  assert.strictEqual(chat.pickDmChannel([supergroup()], SELLER, BUYER), null);
});

test("a 'dm' with a third member is not private", () => {
  const three = Object.assign(emptyDm(), {
    memberCount: 3,
    members: [{ userId: SELLER }, { userId: BUYER }, { userId: "999" }],
  });
  assert.strictEqual(chat.pickDmChannel([three], SELLER, BUYER), null);
});

test("a DM with somebody else is not this buyer's", () => {
  const other = Object.assign(emptyDm(), {
    url: "g2g_dm_5700688_42",
    members: [{ userId: SELLER }, { userId: "42" }],
  });
  assert.strictEqual(chat.pickDmChannel([other], SELLER, BUYER), null);
});

test("with no member list, only G2G's own DM url shape is trusted", () => {
  const bare = (url) => ({ url, customType: "dm", memberCount: 2 });
  assert.ok(chat.pickDmChannel([bare("g2g_dm_5700688_1000423179")], SELLER, BUYER));
  // Either member can have opened it.
  assert.ok(chat.pickDmChannel([bare("g2g_dm_1000423179_5700688")], SELLER, BUYER));
  assert.strictEqual(chat.pickDmChannel([bare("g2g_dm_5700688_42")], SELLER, BUYER), null);
});

test("nothing qualifying means null, so the caller opens a DM", () => {
  assert.strictEqual(chat.pickDmChannel([], SELLER, BUYER), null);
  assert.strictEqual(chat.pickDmChannel(null, SELLER, BUYER), null);
});

/* ----------------------------- opening a DM ------------------------------ */

test("a missing DM is opened, not reported as 'no existing conversation'", () => {
  assert.doesNotMatch(CHAT, /new Error\(\s*"G2G chat: no existing conversation/);
  const send = CHAT.slice(CHAT.indexOf("async function sendToBuyer("));
  assert.match(send, /mp\.g2gOpenDmChannel\(buyer\)/);
  // What G2G hands back is re-checked before a credential goes into it.
  assert.match(send, /pickDmChannel\(\[await sb\.groupChannel\.getChannel\(url\)\]/);
});

test("the DM is opened with the body G2G's own chat client sends", () => {
  const fn = MP.slice(MP.indexOf("async function g2gOpenDmChannel("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /"\/chat\/channel"/);
  assert.match(body, /channel_id: me \+ "_" \+ other/);
  assert.match(body, /"Direct Message Channel Between " \+ me \+ " and " \+ other/);
  assert.match(body, /inviter_id: me/);
  assert.match(body, /user_ids: \[me, other\]/);
  assert.match(body, /channel_type: "dm"/);
  assert.match(body, /channel_details\.channel_url/);
});

test("the read-back checks the exact channel we sent into", () => {
  const block = CHAT.slice(CHAT.indexOf("const verifier = SendbirdChat.init("));
  assert.match(block.slice(0, 900), /verifier\.groupChannel\.getChannel\(channel\.url\)/);
});

/* -------------------- the send is awaited for real ----------------------- */

// SendBird v4's sendUserMessage returns a MessageRequestHandler, not a promise.
function fakeChannel(outcome) {
  return {
    sendUserMessage(params) {
      const handlers = {};
      const h = {
        onPending(cb) { handlers.pending = cb; return h; },
        onSucceeded(cb) { handlers.ok = cb; return h; },
        onFailed(cb) { handlers.fail = cb; return h; },
      };
      setTimeout(() => {
        if (outcome === "ok") handlers.ok({ messageId: 77, message: params.message });
        else handlers.fail(new Error("SendbirdError 900020"), null);
      }, 5);
      return h;
    },
  };
}

test("REGRESSION: the send waits for SendBird's acknowledgement", async () => {
  const m = await chat.sendAndWait(fakeChannel("ok"), { message: "hi" });
  assert.strictEqual(m.messageId, 77, "must resolve with the SENT message, not the handler");
  assert.match(CHAT, /const sent = await sendAndWait\(channel, \{ message: body \}\);/);
  assert.doesNotMatch(CHAT, /=\s*await channel\.sendUserMessage\(/);
});

test("a failed send rejects instead of passing for sent", async () => {
  await assert.rejects(chat.sendAndWait(fakeChannel("fail"), { message: "hi" }), /900020/);
});

/* ------------- a retry never puts the credential in chat twice ------------ */

test("a message already in the channel is not sent again", () => {
  const send = CHAT.slice(CHAT.indexOf("async function sendToBuyer("));
  const check = send.indexOf("await alreadyInChannel(channel, sellerId, body)");
  const post = send.indexOf("await sendAndWait(channel");
  assert.ok(check > 0 && post > 0 && check < post, "look before sending");
  assert.match(send.slice(check, post), /alreadySent: true/);
});

test("only OUR exact message counts as already there", () => {
  const { ourMessageIn } = chat.__test;
  const body = "Order X-1\n\nlogin / pass";
  assert.ok(ourMessageIn([{ sender: { userId: SELLER }, message: body }], SELLER, body));
  assert.ok(!ourMessageIn([{ sender: { userId: BUYER }, message: body }], SELLER, body));
  assert.ok(!ourMessageIn([{ sender: { userId: SELLER }, message: "Order X-1" }], SELLER, body));
  assert.ok(!ourMessageIn(null, SELLER, body));
});

test("an acknowledged-but-invisible send is never auto-repeated", () => {
  const send = CHAT.slice(CHAT.indexOf("async function sendToBuyer("));
  assert.ok(
    send.indexOf("droppedSends.has(dropKey)") < send.indexOf("await sendAndWait(channel"),
    "the dropped guard must run before sending",
  );
  const miss = send.slice(send.indexOf("if (!confirmed) {"));
  assert.match(miss.slice(0, 200), /droppedSends\.add\(dropKey\)/);
});

/* ------------------- a refused count is not a failed send ----------------- */

function fakeListing(orderId) {
  return {
    units: [{ orderId, login: "a", messagedAt: new Date(), deliveredAt: null }],
    saves: 0,
    markModified() {},
    async save() {
      this.saves += 1;
    },
  };
}

test("REGRESSION: a 500 from delivered_qty after a verified send is 'sent, confirm it'", async () => {
  const mp = require("../utils/marketplaces");
  const { confirmOnG2g } = require("../utils/g2gFulfiller");
  const real = mp.g2gSetDeliveredQty;
  mp.g2gSetDeliveredQty = async () => {
    throw new Error("G2G delivered qty failed: HTTP 500");
  };
  try {
    const listing = fakeListing("X-1");
    const r = await confirmOnG2g(listing, "X-1", 1, "retry-send");
    assert.strictEqual(r.awaitingConfirm, true);
    assert.strictEqual(r.sent, 1);
    assert.strictEqual(r.error, undefined, "must not read as a failed delivery");
    assert.strictEqual(listing.units[0].deliveredAt, null, "G2G has not counted it");
  } finally {
    mp.g2gSetDeliveredQty = real;
  }
});

test("an accepted count stamps the units delivered", async () => {
  const mp = require("../utils/marketplaces");
  const { confirmOnG2g } = require("../utils/g2gFulfiller");
  const real = mp.g2gSetDeliveredQty;
  mp.g2gSetDeliveredQty = async () => ({});
  try {
    const listing = fakeListing("X-2");
    const r = await confirmOnG2g(listing, "X-2", 1, "retry-send");
    assert.strictEqual(r.delivered, 1);
    assert.ok(listing.units[0].deliveredAt instanceof Date);
    assert.ok(listing.saves >= 1);
  } finally {
    mp.g2gSetDeliveredQty = real;
  }
});

test("every delivered_qty call goes through confirmOnG2g", () => {
  const calls = FULFILLER.match(/mp\.g2gSetDeliveredQty\(/g) || [];
  assert.strictEqual(calls.length, 1, "only confirmOnG2g may call it directly");
  const fn = FULFILLER.slice(FULFILLER.indexOf("async function confirmOnG2g("));
  assert.ok(fn.indexOf("mp.g2gSetDeliveredQty(") < fn.indexOf("\n}\n"));
  for (const src of ['"confirm-only"', '"retry-send"', "stock.source"]) {
    assert.match(FULFILLER, new RegExp("confirmOnG2g\\(listing, orderId, [^)]*" +
      src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("a sent order pages 'confirm it', on its own dedupe", () => {
  assert.match(FULFILLER, /r\.pending \|\| r\.awaitingConfirm/);
  assert.match(FULFILLER, /if \(r\.awaitingConfirm && !r\.error\) \{\s*await alertSentAwaitingConfirm/);
  const fn = FULFILLER.slice(FULFILLER.indexOf("async function alertSentAwaitingConfirm("));
  assert.match(fn, /confirmAsked\.has\(id\)/);
  assert.doesNotMatch(fn.slice(0, fn.indexOf("\n}\n")), /alerted\./);
  assert.match(fn, /Do NOT send another account/);
});
