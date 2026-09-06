// Guards the two derivations the Eldorado delivery bot depends on, both of
// which were recovered by reading TalkJS's minified SDK and then verified
// against the live chat iframe on a real order (2026-09-06).
//
// If TalkJS ever changes `internalId = sha1(externalId).hex[:20]`, delivery
// would start posting into a conversation that does not exist — silently, from
// the server's point of view. These fixtures are the real observed values, so
// this test is the canary for that.
const test = require("node:test");
const assert = require("node:assert");

const mp = require("../utils/marketplaces");

test("TalkJS internal id is sha1(externalId) truncated to 20 hex chars", () => {
  // Observed live: the seller's Eldorado userId maps to the TalkJS user id in
  // the chat iframe URL (.../user/daeee998718e66401013_n/chatbox/...).
  assert.strictEqual(
    mp.eldInternalId("c806ac96-3b93-48e3-859f-f4b2ed7deeb0"),
    "daeee998718e66401013",
  );
  assert.strictEqual(mp.eldInternalId("x").length, 20);
  assert.match(mp.eldInternalId("x"), /^[0-9a-f]{20}$/);
});

test('a TalkJS USER id carries the "_n" suffix a conversation id does not', () => {
  // Caught by a live send: without the suffix TalkJS answers
  // 404 {"error":"Sender does not exist"}. With it, the message posts (200).
  assert.strictEqual(
    mp.eldNymId("c806ac96-3b93-48e3-859f-f4b2ed7deeb0"),
    "daeee998718e66401013_n",
  );
  assert.strictEqual(mp.eldNymId("x"), mp.eldInternalId("x") + "_n");
});

test("internal id derivation is stable and collision-distinct", () => {
  const a = mp.eldInternalId("order-a");
  const b = mp.eldInternalId("order-b");
  assert.notStrictEqual(a, b);
  assert.strictEqual(a, mp.eldInternalId("order-a"));
});

test("eldorado is a registered marketplace with a cookie credential", () => {
  assert.ok(mp.MARKETPLACES.includes("eldorado"));
  assert.deepStrictEqual(mp.FIELDS.eldorado, ["cookie"]);
});

test("the delivery message carries the credential and the claim steps", () => {
  const { eldoradoDeliveryCode } = require("../utils/eldoradoFulfiller");
  const msg = eldoradoDeliveryCode("someLogin", "somePass");
  assert.match(msg, /someLogin/);
  assert.match(msg, /somePass/);
  assert.match(msg, /twitch\.tv\/drops\/inventory/);
});
