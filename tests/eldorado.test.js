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

// --- rent-farm service orders --------------------------------------------
// These listings sell a WINDOW ("farm Apex for me for 180 days"), not a farmed
// account. The term and the game are parsed out of the offer title, because the
// title is the contract the buyer actually agreed to — so a parse that silently
// guesses would sell a term we never promised.
const farm = require("../utils/eldoradoFarmService");

test("the farming term is read from every title form we have shipped", () => {
  assert.strictEqual(
    farm.termToDays("Overwatch Twitch Drops Automatic Farming 120 Days"),
    120,
  );
  // legacy lowercase titles predate the generator
  assert.strictEqual(
    farm.termToDays("Apex Legends Twitch Drops Automatic farming 180 days"),
    180,
  );
  assert.strictEqual(
    farm.termToDays("Rust Twitch Drops Automatic Farming 1 Year"),
    365,
  );
  // a title with no term must read as 0 so the caller refuses rather than guesses
  assert.strictEqual(farm.termToDays("Rust Twitch Drops Automatic Farming"), 0);
});

test("rent-farm listings are told apart from drops-bundle listings", () => {
  assert.ok(farm.FARM_TITLE.test("Rust Twitch Drops Automatic Farming 1 Year"));
  assert.ok(
    farm.FARM_TITLE.test("Apex Twitch Drops Automatic farming 180 days"),
  );
  // a bundle listing must NOT be routed to the farm path
  assert.ok(
    !farm.FARM_TITLE.test(
      "Overwatch 2 Calling All Heroes 2026 Drops | CAH 2026 Esports Rewards ALL Items",
    ),
  );
  assert.ok(
    !farm.FARM_TITLE.test("Rainbow Six Siege bundle (4 items) — Alpha Packs"),
  );
});

test("storefront game spellings resolve onto names the farm knows", async () => {
  const known = ["Rainbow Six Siege", "Overwatch", "Apex Legends"];
  assert.strictEqual(
    await farm.canonicalGame("Tom Clancy's Rainbow Six Siege X", known),
    "Rainbow Six Siege",
  );
  assert.strictEqual(await farm.canonicalGame("Overwatch 2", known), "Overwatch");
  assert.strictEqual(await farm.canonicalGame("apex legends", known), "Apex Legends");
  // unknown must resolve to "" so the caller refuses to pin a bot to a bad game
  assert.strictEqual(await farm.canonicalGame("Some Game We Never Farm", known), "");
});

test("the hand-over message carries the credential, the term and the rules", () => {
  const msg = farm.farmDeliveryMessage(
    [{ login: "someLogin", password: "somePass" }],
    365,
  );
  assert.match(msg, /someLogin/);
  assert.match(msg, /somePass/);
  assert.match(msg, /1 year/);
  assert.match(msg, /KEEP IT LINKED/);
  assert.match(msg, /do not change the account's password/i);
});
