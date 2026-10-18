// PlayerAuctions delivery of a code-shop unit (docs/code-shop/06-PLAYERAUCTIONS-PLAN.md, C8).
//
// A unit's "password" is one code per line ("1) Label = CODE"). PlayerAuctions
// caps one order message at 300 characters, and a six-code unit alone is about
// that long, so the offer's template no longer fits in one message. Before
// this, the fulfiller then fell back to the Twitch-account house copy
// ("Login: … / Password: …" and a Twitch claim guide) — or threw when one
// unit's text alone was over 300, leaving a paid order undelivered. Now the
// template is rendered around {password}, every message fits, and every code
// reaches the buyer once, in order.
//
// The REAL suppliedMessages and the REAL suppliedStock.deliveryText run here
// (plaintext passwords pass through decrypt unchanged). All codes are made up.
const test = require("node:test");
const assert = require("node:assert/strict");

const { suppliedMessages } = require("../utils/playerauctionsFulfiller");
const stock = require("../utils/suppliedStock");
const copy = require("../utils/playerauctionsCopy");

const HELP =
  "Redeem each code at https://example.test/redeem (sign in, enter the code with the dashes, confirm). " +
  "Each code works once, on one game account. Any problem? Reply here and we will help.";
const offer = (template) => ({ title: "Space Game | 6 Codes Bundle", game: "Space Game", deliveryTemplate: template });
const SHOP_TEMPLATE = "Thank you for your order! Your Space Game code bundle:\n{password}\n\n" + HELP;

const code = (n) => `AB${n}C-DE${n}F-GHI${n}J-KL${n}M-NO${n}P`;
const unit = (id, labels) => ({
  ledgerId: "ledger-" + id,
  login: "cs-000000-" + id,
  password: labels.map((l, i) => `${i + 1}) ${l} = ${code(id * 10 + i)}`).join("\n"),
});
const SIX = ["Purrfect Afternoon Spray", "Prost Spray", "Skal Spray", "Banana Cat Spray", "Banana Cat Icon", "Esports Loot Box"];

function assertDelivers(messages, units) {
  assert.ok(messages.length >= 2, "split into several messages");
  for (const m of messages) assert.ok(m.length <= copy.LIMIT, `a message of ${m.length} characters: ${m.slice(0, 60)}`);
  const all = messages.join("\n");
  for (const u of units) {
    const lines = u.password.split("\n");
    let from = -1;
    for (const line of lines) {
      const at = all.indexOf(line);
      assert.ok(at > from, `code line delivered, in order: ${line}`);
      assert.equal(all.indexOf(line, at + 1), -1, `code line delivered once: ${line}`);
      from = at;
    }
  }
  assert.doesNotMatch(all, /Login:|Password:|Twitch|cs-000000/, "never the account copy, never the internal label");
}

test("a six-code unit goes out as several messages of at most 300 characters, every code once and in order", () => {
  const u = unit(1, SIX);
  assert.ok(stock.deliveryText(u, offer(SHOP_TEMPLATE)).length > copy.LIMIT, "the precondition: the template does not fit");
  const messages = suppliedMessages(stock, [u], offer(SHOP_TEMPLATE));
  assertDelivers(messages, [u]);
  assert.match(messages[0], /^Thank you for your order! Your Space Game code bundle:\n1\) Purrfect Afternoon Spray = /);
  assert.equal(messages[messages.length - 1], HELP, "the redeem help comes last, on its own");
});

test("two units in one order are numbered, and the help is sent once, after the last", () => {
  const units = [unit(1, SIX), unit(2, SIX)];
  const messages = suppliedMessages(stock, units, offer(SHOP_TEMPLATE));
  assertDelivers(messages, units);
  const all = messages.join("\n");
  assert.ok(all.indexOf("Bundle 1 of 2") < all.indexOf("Bundle 2 of 2"));
  assert.equal(all.split(HELP).length - 1, 1, "help once");
  assert.equal(messages[messages.length - 1], HELP);
});

test("a ten-code unit, longer than one message on its own, is delivered instead of throwing", () => {
  const ten = Array.from({ length: 10 }, (_, i) => `Fireworks Craftwork Lucky Pack Number ${i + 1}`);
  const u = unit(3, ten);
  assert.ok(u.password.length > copy.LIMIT, "the unit alone is over the limit");
  assertDelivers(suppliedMessages(stock, [u], offer(SHOP_TEMPLATE)), [u]);
});

test("a template that fits is still sent as it is, in one message per unit", () => {
  const u = unit(4, ["Prost Spray", "Skal Spray"]);
  const short = "Your codes:\n{password}\nEnjoy!";
  assert.deepEqual(suppliedMessages(stock, [u], offer(short)), [stock.deliveryText(u, offer(short))]);
});

test("an ordinary account unit keeps the house copy: only code lines are split this way", () => {
  const acct = { ledgerId: "l9", login: "spacefan123", password: "hunter2-but-longer" };
  const long = "Thank you! " + "x".repeat(320) + "\n{password}";
  assert.deepEqual(suppliedMessages(stock, [acct], offer(long)), copy.deliveryMessages([acct], { kind: "bundle" }));
  // A code unit whose template has no {password} cannot be split either.
  const u = unit(5, ["Prost Spray", "Skal Spray"]);
  const noSlot = offer("Thank you! " + "y".repeat(320));
  assert.deepEqual(suppliedMessages(stock, [u], noSlot), copy.deliveryMessages([u], { kind: "bundle" }));
});

test("a password with one line that is not a code line is not treated as a code unit", () => {
  const mixed = { ledgerId: "l8", login: "cs-000000-8", password: "1) Prost Spray = AB1C-DE1F\nsome other text\n3) Skal Spray = AB3C-DE3F" };
  const tpl = offer(SHOP_TEMPLATE.replace("Thank you", "Thank you " + "z".repeat(300)));
  assert.deepEqual(suppliedMessages(stock, [mixed], tpl), copy.deliveryMessages([mixed], { kind: "bundle" }));
});

// The review of 2026-10-18: deliverOrder hands suppliedMessages a Mongoose
// document, whose fields a spread does not carry, so {title} and {game}
// came out blank in a code unit's messages.
test("a Mongoose-document offer still fills {title} and {game}", () => {
  const plain = offer("Hi {title} ({game}):\n{password}\n\n" + HELP);
  const doc = { toObject: () => ({ ...plain }) }; // a spread of this carries nothing
  const messages = suppliedMessages(stock, [unit(6, SIX)], doc);
  assert.match(messages[0], /^Hi Space Game \| 6 Codes Bundle \(Space Game\):\n1\) /);
});

// The review of 2026-10-18: the stock sync read its rows once, then a quantity
// update (which REPLACES the offer, back on sale) could rebuild an offer the
// code shop had just hidden and marked delisted.
test("syncStock pushes nothing to a row that is no longer active", async () => {
  const ful = require("../utils/playerauctionsFulfiller");
  const mp = require("../utils/marketplaces");
  const ML = require("../models/MarketplaceListing");
  const calls = [];
  const saved = { set: mp.playerauctionsSetQuantity, exists: ML.exists };
  mp.playerauctionsSetQuantity = async (...a) => {
    calls.push(a);
    return {};
  };
  const row = { _id: "6ad000000000000000000aa1", accountOffer: "6ad000000000000000000bb1", externalId: "9001", save: async () => {} };
  const supplied = () => ({ stock: { stockFor: async () => 5 } });
  try {
    ML.exists = async () => null; // delisted since it was read
    assert.equal(await ful.syncStock(row, supplied), null);
    assert.equal(calls.length, 0);
    ML.exists = async () => {
      throw new Error("db down");
    };
    assert.equal(await ful.syncStock(row, supplied), null, "a row that cannot be re-read is not pushed");
    assert.equal(calls.length, 0);
    ML.exists = async () => ({ _id: row._id });
    assert.equal(await ful.syncStock(row, supplied), 5);
    assert.deepEqual(calls, [["9001", 5]]);
  } finally {
    mp.playerauctionsSetQuantity = saved.set;
    ML.exists = saved.exists;
  }
});
