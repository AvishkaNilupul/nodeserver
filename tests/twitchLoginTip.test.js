// Every Twitch account hand-over sent in a chat tells the buyer to skip
// Twitch's code prompt with "Remind me later". Buyers kept getting stuck on
// that prompt (owner, 2026-11-03); the line lives in utils/twitchLoginTip.js.
const test = require("node:test");
const assert = require("node:assert");

const TIP = /Remind me later/;
const L = "someLogin";
const P = "somePass";

test("the Eldorado / G2G chat hand-over carries the tip in the log-in step", () => {
  const e = require("../utils/eldoradoFulfiller");
  for (const opts of [{}, { unclaimed: true }]) {
    const msg = e.eldoradoDeliveryCode(L, P, opts);
    assert.match(msg, TIP);
    assert.ok(msg.indexOf("Remind me later") < msg.indexOf("drops/inventory"));
  }
  const { g2gDeliveryCode } = require("../utils/g2gFulfiller");
  assert.match(g2gDeliveryCode(L, P), TIP);
});

test("a multi-account Eldorado order says it once, with the guide", () => {
  const e = require("../utils/eldoradoFulfiller");
  const creds = [{ login: "a", password: "b" }, { login: "c", password: "d" }];
  for (const opts of [{}, { unclaimed: true }]) {
    const msg = e.eldoradoAccountsMessage(creds, 2, opts);
    assert.strictEqual((msg.match(/Remind me later/g) || []).length, 1);
  }
});

test("PlayerAuctions keeps the tip inside its 300-character message", () => {
  const copy = require("../utils/playerauctionsCopy");
  const one = [{ login: "someLongerLogin_2026", password: "Abcdefgh1234!xyz" }];
  for (const kind of ["bundle", "unclaimed"]) {
    const msgs = copy.deliveryMessages(one, { kind });
    assert.strictEqual(msgs.length, 1);
    assert.ok(msgs[0].length <= copy.LIMIT);
    assert.match(msgs[0], TIP, kind + " message lost the tip");
  }
  // unclaimed: "connect first" and "claim today" still come first
  const u = copy.deliveryMessages(one, { kind: "unclaimed" })[0];
  assert.ok(u.indexOf("FIRST press Connect") < u.indexOf("Claim today"));
  assert.ok(u.indexOf("Claim today") < u.indexOf("Remind me later"));
  // a split order puts it in the closing note, whole
  const many = Array.from({ length: 30 }, (_, i) => ({ login: "login" + i, password: "pass" + i }));
  for (const kind of ["bundle", "unclaimed"]) {
    const msgs = copy.deliveryMessages(many, { kind });
    const last = msgs[msgs.length - 1];
    assert.match(last, TIP);
    assert.match(last, /delivery instructions\.$/);
    assert.ok(msgs.every((m) => m.length <= copy.LIMIT));
  }
});
