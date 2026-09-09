// How many PRISTINE POOL ACCOUNTS a PlayerAuctions rent-farm order spends.
//
// The bundle path shipped 11 accounts for $5 by reading an item count as a unit
// count (tests/paQuantity.test.js). The rent-farm path had the mirror-image
// defect, and it is the more expensive one: a bundle spends farmed stock, a
// rent-farm order spends PRISTINE pool accounts pinned into the farm for a year.
//
//   const qty = Math.max(1, parseInt(order && order.purchaseQuantity, 10) || 1);
//
// Measured against the live PlayerAuctions API on 2026-09-09: `purchaseQuantity`
// does not exist on a PA order — not in the orders list, not in the detail. So
// this was ALWAYS 1. Safe against over-provisioning, wrong the other way, and
// it has already been wrong once: order 16418573 ("Overwatch Twitch Drops
// Automatic farming", $16.00 paid, "200 Other Skins") is TWO units of an $8
// offer. It predates automation and was delivered by hand; under auto-delivery
// the buyer would have paid for two farming accounts and received one.
//
// The fix reads the OFFER the order links to and requires TWO independent
// derivations — money and item count — to agree before spending a second
// account. Anything else is one account plus an alert.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const mp = require("../utils/marketplaces");

// Our live offers, as PlayerAuctions really shapes them (captured from
// /Offer/Offers on 2026-09-09). `totalPrice` is the price of ONE unit;
// `currencyPerUnit` is how many ITEMS one unit contains.
const OFFERS = [
  { offerId: 294684983, title: 'Overwatch Twitch Drops (26 Items) OWWC', totalPrice: '$ 5.00', currencyPerUnit: 26, itemNameEn: ' Other Skins' },
  { offerId: 295640366, title: 'Pokmon GO Twitch Drops Automatic Farming 1 Year', totalPrice: '$ 9.00', currencyPerUnit: 1, itemNameEn: ' Bundles' },
  { offerId: 900000001, title: 'Overwatch Twitch Drops Automatic farming 180 days', totalPrice: '$ 8.00', currencyPerUnit: 100, itemNameEn: ' Other Skins' },
  { offerId: 295691875, title: 'Sea of Thieves Twitch Drops (14 Items)', totalPrice: '$ 5.00', currencyPerUnit: 14, itemNameEn: ' Ship Skins' },
];

// Stub the offers feed BEFORE the module's first call, so its cache fills from
// these rather than from the network. One stub serves every test below.
let listingCalls = 0;
mp.playerauctionsMyListings = async (pageIndex) => {
  listingCalls += 1;
  return { count: OFFERS.length, items: pageIndex === 1 ? OFFERS : [] };
};

const farm = require("../utils/playerauctionsFarmService");

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "utils", "playerauctionsFarmService.js"),
  "utf8",
);

// An order as utils/marketplaces.playerauctionsPendingOrders hands it over:
// the list row plus the attached `detail`.
const order = (paid, items, offerId, extra = {}) => ({
  orderId: "16418573",
  orderTitle: "Overwatch Twitch Drops Automatic farming 180 days",
  name: "somebuyer",
  ...extra,
  detail: {
    orderInfo: {
      price: paid,
      purchased: { amount: items, suffix: "Other Skins" },
      offerInfo: offerId
        ? { link: "https://www.playerauctions.com/overwatch-items/" + offerId + "i!slug/" }
        : {},
    },
  },
});

/* ------------------------- the regression itself ------------------------- */

test("REGRESSION: $16 of an $8 farm offer is TWO accounts, not one", async () => {
  // Order 16418573 exactly: 200 items of a 100-per-unit offer, $16.00 paid.
  const r = await farm.farmQuantity(order("16.00", 200, 900000001));
  assert.strictEqual(r.qty, 2);
  assert.ok(!r.suspect, "a proved count is not a suspicion");
});

test("a single unit stays a single unit", async () => {
  const r = await farm.farmQuantity(order("8.00", 100, 900000001));
  assert.strictEqual(r.qty, 1);
  assert.ok(!r.suspect);
});

test("the item count alone never decides — 200 items is not 200 accounts", async () => {
  // The bundle bug in one line: the raw item count must never become the qty.
  const r = await farm.farmQuantity(order("16.00", 200, 900000001));
  assert.notStrictEqual(r.qty, 200);
});

test("a rent-farm offer whose unit IS one item still works", async () => {
  // Pokémon GO: currencyPerUnit 1, so items and units coincide. Two units = $18.
  assert.strictEqual((await farm.farmQuantity(order("18.00", 2, 295640366))).qty, 2);
  assert.strictEqual((await farm.farmQuantity(order("9.00", 1, 295640366))).qty, 1);
});

/* --------------- both measures must agree, or it is one ---------------- */

test("money and items disagreeing yields ONE account and a flag", async () => {
  // $16 says two units; 100 items says one. Something is wrong, and a pristine
  // account is too expensive to spend on a coin flip.
  const r = await farm.farmQuantity(order("16.00", 100, 900000001));
  assert.strictEqual(r.qty, 1);
  assert.strictEqual(r.suspect, true, "the operator must be told");
});

test("a coupon or fee never reads as a bulk purchase", async () => {
  // $12.50 against an $8 unit divides to 1.5625 — not evidence of anything.
  const r = await farm.farmQuantity(order("12.50", 150, 900000001));
  assert.strictEqual(r.qty, 1);
});

test("an offer that is no longer live gives one account, flagged", async () => {
  // PlayerAuctions implements an update as cancel + create, so the offer a paid
  // order points at can genuinely be gone. That is a reason to ask, not to guess.
  const r = await farm.farmQuantity(order("16.00", 200, 777777777));
  assert.strictEqual(r.qty, 1);
  assert.strictEqual(r.suspect, true);
  assert.match(r.why, /no longer among our live offers/);
});

test("an order with no offer link gives one account", async () => {
  const r = await farm.farmQuantity(order("16.00", 200, null));
  assert.strictEqual(r.qty, 1);
  assert.match(r.why, /no offer link/);
});

test("a missing detail never throws and never over-provisions", async () => {
  for (const o of [{}, { detail: {} }, { detail: { orderInfo: {} } }, null]) {
    const r = await farm.farmQuantity(o);
    assert.strictEqual(r.qty, 1, "must default to one account");
  }
});

test("an explicit purchaseQuantity is believed if PA ever sends one", async () => {
  const r = await farm.farmQuantity(order("16.00", 200, 900000001, { purchaseQuantity: 3 }));
  assert.strictEqual(r.qty, 3);
});

/* ------------------------------ mechanics ------------------------------- */

test("the offer id is lifted out of the order's own link", () => {
  assert.strictEqual(
    farm.offerIdFromLink(
      "https://www.playerauctions.com/overwatch-items/294684983i!overwatch-twitch-drops-26-items/",
    ),
    "294684983",
  );
  assert.strictEqual(farm.offerIdFromLink(""), "");
  assert.strictEqual(farm.offerIdFromLink(null), "");
  // A digit run that is not the offer segment must not be picked up.
  assert.strictEqual(farm.offerIdFromLink("https://x/12345/no-bang/"), "");
});

test("prices parse out of PlayerAuctions' spaced currency strings", () => {
  assert.strictEqual(farm.money("$ 8.00"), 8);
  assert.strictEqual(farm.money("16.00"), 16);
  assert.strictEqual(farm.money(null), 0);
  assert.strictEqual(farm.money("free"), 0);
});

test("the offers feed is cached, not re-fetched per order", async () => {
  const before = listingCalls;
  await farm.farmQuantity(order("8.00", 100, 900000001));
  await farm.farmQuantity(order("8.00", 100, 900000001));
  assert.strictEqual(listingCalls, before, "a cached page-walk must not repeat");
});

/* ------------------------- guards against relapse ------------------------ */

test("purchaseQuantity is no longer the ONLY source of the count", () => {
  assert.doesNotMatch(
    SRC,
    /const qty = Math\.max\(1, parseInt\(order && order\.purchaseQuantity, 10\) \|\| 1\);/,
    "the always-1 line must be gone",
  );
  assert.match(SRC, /const units = await farmQuantity\(order\);/);
});

test("a suspected multi-unit order alerts, once", () => {
  // Delivering one account is the safe half. Saying nothing is not: the buyer
  // paid for something we are not shipping.
  assert.match(SRC, /if \(units\.suspect && row\.attempts === 1\)/);
  assert.match(SRC, /CHECK THE UNIT COUNT BY HAND/);
});

test("an empty page-walk is never cached", () => {
  // Caching a failed read would pin every later order to qty 1 for five minutes,
  // turning one transient API blip into a run of quiet under-deliveries.
  assert.match(SRC, /if \(byId\.size\) offerCache = \{ at: Date\.now\(\), byId \};/);
});
