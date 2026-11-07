// Every Twitch account hand-over sent in a chat tells the buyer to skip
// Twitch's code prompt with "Remind me later". Buyers kept getting stuck on
// that prompt (owner, 2026-11-03); the line lives in utils/twitchLoginTip.js.
const test = require("node:test");
const assert = require("node:assert");
const { TWITCH_LINK_TIP } = require("../utils/twitchLinkTip");

const TIP = /Remind me later/;
const L = "someLogin";
const P = "somePass";

test("the Eldorado / G2G chat hand-over carries the tip in the log-in step", () => {
  const e = require("../utils/eldoradoFulfiller");
  for (const opts of [{}, { unclaimed: true }]) {
    const msg = e.eldoradoDeliveryCode(L, P, opts);
    assert.match(msg, TIP);
    assert.ok(msg.includes(TWITCH_LINK_TIP));
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
    assert.strictEqual(msg.split(TWITCH_LINK_TIP).length - 1, 1);
  }
});

test("five unclaimed G2G cards still fit the 5000-character chat budget", () => {
  const { g2gDeliveryCode } = require("../utils/g2gFulfiller");
  const cards = Array.from({ length: 5 }, () =>
    g2gDeliveryCode("x".repeat(14), "y".repeat(18), { unclaimed: true }));
  assert.ok(cards.every((card) => card.includes(TWITCH_LINK_TIP)));
  assert.ok(cards.join("\n\n").length < 5000);
});

test("new GGSel vault guides preserve credential parsing for both stock types", () => {
  const { ggselDeliveryCode } = require("../utils/ggselFulfiller");
  const { ggselCodeLogin } = require("../utils/marketplaces");
  for (const opts of [{}, { unclaimed: true }]) {
    const code = ggselDeliveryCode("example_login", "example_password", opts);
    assert.ok(code.includes(TWITCH_LINK_TIP));
    assert.strictEqual(ggselCodeLogin(code), "example_login");
    assert.ok(code.includes("Password: example_password"));
  }
});

test("PlayerAuctions keeps the tip inside its 300-character message", () => {
  const copy = require("../utils/playerauctionsCopy");
  const one = [{ login: "someLongerLogin_2026", password: "Abcdefgh1234!xyz" }];
  for (const kind of ["bundle", "unclaimed"]) {
    const msgs = copy.deliveryMessages(one, { kind });
    assert.strictEqual(msgs.length, 2);
    assert.ok(msgs[1].length <= copy.LIMIT);
    assert.match(msgs[1], TIP, kind + " message lost the tip");
    assert.strictEqual(msgs[0], TWITCH_LINK_TIP);
  }
  // unclaimed: "connect first" and "claim today" still come first
  const u = copy.deliveryMessages(one, { kind: "unclaimed" })[1];
  assert.ok(u.indexOf("FIRST press Connect") < u.indexOf("Claim today"));
  assert.ok(u.indexOf("Claim today") < u.indexOf("Remind me later"));
  // A split order sends the linking tip first and keeps its old closing note.
  const many = Array.from({ length: 30 }, (_, i) => ({ login: "login" + i, password: "pass" + i }));
  for (const kind of ["bundle", "unclaimed"]) {
    const msgs = copy.deliveryMessages(many, { kind });
    const last = msgs[msgs.length - 1];
    assert.match(last, TIP);
    assert.match(last, /delivery instructions\.$/);
    assert.strictEqual(msgs[0], TWITCH_LINK_TIP);
    assert.ok(msgs.every((m) => m.length <= copy.LIMIT));
  }
});

test("PlayerAuctions never drops or truncates the linking fallback for large credentials or orders", () => {
  const copy = require("../utils/playerauctionsCopy");
  for (const count of [1, 2, 5, 30]) {
    const accounts = Array.from({ length: count }, (_, i) => ({
      login: "long_login_" + String(i).padStart(2, "0") + "x".repeat(15),
      password: "long_password_" + String(i).padStart(2, "0") + "y".repeat(12),
    }));
    for (const kind of ["bundle", "unclaimed"]) {
      const messages = copy.deliveryMessages(accounts, { kind });
      const text = messages.join("\n");
      assert.strictEqual(text.split(TWITCH_LINK_TIP).length - 1, 1);
      assert.strictEqual(messages[0], TWITCH_LINK_TIP);
      assert.ok(messages.every((message) => message.length <= copy.LIMIT));
      for (const account of accounts) {
        const credential = count === 1
          ? "Login: " + account.login + "\nPassword: " + account.password
          : account.login + " / " + account.password;
        assert.strictEqual(text.split(credential).length - 1, 1, "keep each credential whole and unique");
      }
    }
    const farmMessages = copy.deliveryMessages(accounts, { kind: "farm", days: 30 });
    assert.ok(farmMessages.every((message) => !message.includes(TWITCH_LINK_TIP)));
    if (count === 1) {
      assert.deepStrictEqual(farmMessages, [copy.farmDeliveryMessage(accounts, 30)]);
    }
  }
});
