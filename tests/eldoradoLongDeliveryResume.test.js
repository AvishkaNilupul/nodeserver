// The retry of a long account-listing delivery, against the REAL claim layer.
//
// A long delivery is one chat message per unit (tests/eldoradoLongDelivery.test.js),
// so it can stop half way: message 1 is in the buyer's chat, message 2 failed,
// and the order is not marked delivered. What makes the next tick safe is not
// in the fulfiller — it is utils/suppliedStock.claimForListing re-reading the
// ledger rows it stamped with the order id and handing the SAME units back. A
// stubbed claim would only ever prove the stub, so this file runs the real
// layer and the real models on mongodb-memory-server, the way
// tests/suppliedClaim.test.js does, and stubs only the marketplace client.
//
// One fact about that layer the long delivery has to live with: a first claim
// comes back in (createdAt, _id) order and a resumed one in (soldAt, _id)
// order. Every shelf here is built so those two orders are OPPOSITE — rows
// minted later carry an earlier createdAt — which is the case that would
// renumber the units of a retry. Nothing below asserts which order the layer
// uses: that is its own business, and the long delivery must not care.
process.env.CRED_SECRET ||= "eldorado-long-delivery-test-cred-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AccountOffer = require("../models/AccountOffer");
const SuppliedAccount = require("../models/SuppliedAccount");
const MarketplaceListing = require("../models/MarketplaceListing");
const { encrypt } = require("../utils/secretBox");
const supplied = require("../utils/suppliedStock");

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("eldoradolongdelivery"));
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

/* ------------------------------- harness -------------------------------- */

function spy(impl = async () => undefined) {
  const fn = (...args) => {
    fn.calls.push(args);
    return impl(...args);
  };
  fn.calls = [];
  return fn;
}

const settings = {
  getAutoFarm: () => ({}),
  // lowStockWarnAt 0 keeps the low-stock Telegram out of the claim path.
  getAccountListingSettings: () => ({
    enabled: true,
    autoDeliver: true,
    lowStockWarnAt: 0,
  }),
};
const telegram = { sendTelegram: async () => {} };
// The listing model's post-save hook writes an audit row through
// utils/systemLog, fire-and-forget. Nothing here reads those rows, and left
// alone the last one races the disconnect at the end of the file.
const systemLog = require("../utils/systemLog");
systemLog.logEvent = () => {};
// For the claim layer called directly; inside the fulfiller the same three are
// swapped in through the module loader below.
const deps = { settings, telegram, systemLog };

// The real fulfiller over the real claim layer and the real models. Only what
// would leave the process is replaced: the marketplace client, and the Drop
// Archive modules an account listing never touches.
async function withFulfiller(mp, fn) {
  const target = require.resolve("../utils/eldoradoFulfiller");
  const stubs = {
    "../utils/marketplaces": mp,
    "../routes/shopRoutes": { availableAccountsForSet: async () => [] },
    "../utils/listedLogins": {
      loginsOnActiveListings: async () => new Set(),
      notListed: (a) => a,
    },
    "../utils/dropReservation": {},
    "../utils/eldoradoFarmService": {},
    "../utils/settings": settings,
    "../utils/telegram": telegram,
    "../utils/systemLog": systemLog,
  };
  const map = new Map(
    Object.entries(stubs).map(([k, v]) => [require.resolve(k), v]),
  );
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    let file;
    try {
      file = Module._resolveFilename(request, parent, isMain);
    } catch {
      return origLoad.apply(this, arguments);
    }
    return map.has(file) ? map.get(file) : origLoad.apply(this, arguments);
  };
  delete require.cache[target];
  try {
    return await fn(require(target));
  } finally {
    Module._load = origLoad;
    delete require.cache[target];
  }
}

function fakeMarket({ failSendOn = [] } = {}) {
  let n = 0;
  const failing = new Set(failSendOn);
  return {
    eldoradoSendOrderMessage: spy(async () => {
      n += 1;
      if (failing.has(n)) {
        throw new Error("Eldorado chat send failed (HTTP 400): Request failed with status code 400");
      }
      return { ok: "1" };
    }),
    eldoradoMarkDelivered: spy(async () => ({})),
    eldoradoSetQuantity: spy(async () => ({})),
    eldoradoDelist: spy(async () => ({})),
  };
}

const TEMPLATE = "Your codes for {title}:\n{password}\n\nRedeem them within 30 days.";
let seq = 0;

// An active offer, its Eldorado listing row, and a shelf of `count` units of
// about `chars` characters each. Rows are created one after another, so their
// ids ascend, while createdAt DESCENDS: the claim's two sort orders disagree.
async function shelfOf(count, chars = 600) {
  seq += 1;
  const offer = await AccountOffer.create({
    title: "Code bundle " + seq,
    game: "Overwatch 2",
    status: "active",
    deliveryTemplate: TEMPLATE,
  });
  const listing = await MarketplaceListing.create({
    marketplace: "eldorado",
    externalId: "eld-offer-" + seq,
    accountOffer: offer._id,
    status: "active",
    title: offer.title,
  });
  const base = Date.UTC(2026, 9, 11, 0, 0, 0);
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const login = "bundle" + seq + "-" + String(i + 1).padStart(2, "0");
    const code = "CODE-" + login + ":" + "x".repeat(chars);
    const createdAt = new Date(base - i * 60000);
    const row = await SuppliedAccount.create({
      offer: offer._id,
      login,
      password: encrypt(code),
      createdAt,
    });
    rows.push({ id: String(row._id), login, code, createdAt });
  }
  // The shelf is only the case it claims to be if Mongoose kept the dates.
  const stored = await SuppliedAccount.find({ offer: offer._id }, { createdAt: 1 }).lean();
  for (const r of rows) {
    const s = stored.find((x) => String(x._id) === r.id);
    assert.equal(new Date(s.createdAt).getTime(), r.createdAt.getTime());
  }
  assert.deepEqual(
    rows.map((r) => r.id),
    rows.map((r) => r.id).slice().sort(),
    "ids ascend in creation order",
  );
  return { offer, listing, rows };
}

const textFor = (offer, row) =>
  "Your codes for " + offer.title + ":\n" + row.code + "\n\nRedeem them within 30 days.";
const header = (i, n) => "=== ACCOUNT " + i + " of " + n + " ===\n\n";
const order = (id, listing, qty) => ({
  id,
  offerId: listing.externalId,
  purchaseQuantity: qty,
  sellerId: "seller-1",
  talkJsConversationId: "conv-" + id,
});
const texts = (mp) => mp.eldoradoSendOrderMessage.calls.map((c) => c[1]);

/* ------------------------- what the claim hands back ---------------------- */

test("the claim layer resumes the SAME units for an order, and nothing new", async (t) => {
  const { offer } = await shelfOf(10);

  const first = await supplied.claimForListing(offer._id, 8, {
    orderId: "ord-resume",
    market: "eldorado",
    deps,
  });
  const again = await supplied.claimForListing(offer._id, 8, {
    orderId: "ord-resume",
    market: "eldorado",
    deps,
  });

  const ids = (list) => list.map((a) => a.ledgerId);
  assert.equal(first.length, 8);
  assert.equal(new Set(ids(first)).size, 8);
  assert.deepEqual(ids(again).slice().sort(), ids(first).slice().sort(), "the same eight rows");
  assert.deepEqual(
    again.map((a) => a.password).sort(),
    first.map((a) => a.password).sort(),
    "with the same decrypted text",
  );
  assert.equal(await supplied.stockFor(offer._id, { deps }), 2, "the retry took nothing more");
  assert.equal(
    await SuppliedAccount.countDocuments({ offer: offer._id, orderId: "ord-resume" }),
    8,
  );
  // Reported, not asserted: on the day this was written the resume came back
  // in a different order from the first claim (false below).
  t.diagnostic(
    "resume returned the units in the first claim's order: " +
      (JSON.stringify(ids(again)) === JSON.stringify(ids(first))) +
      "; first claim was in ledger-id order: " +
      (JSON.stringify(ids(first)) === JSON.stringify(ids(first).slice().sort())),
  );
});

/* ------------------ a failed second message, then the retry ---------------- */

test("a failed second message, a restart, a retry: same units, same texts, shelf untouched", async () => {
  const { offer, listing, rows } = await shelfOf(10);
  const mp = fakeMarket({ failSendOn: [2] });
  const byId = (a, b) => (a.id < b.id ? -1 : 1);

  await withFulfiller(mp, async (e) => {
    const first = await e.deliverOrder(order("ord-long", listing, 8), {
      dryRun: false,
      unitGapMs: 0,
    });
    assert.match(
      first.error,
      /^long delivery interrupted at message 2 of 8 \(at least 1 of 8 are in the buyer's chat\)/,
    );

    // The ORDER is marked as nothing: not on Eldorado, not on the listing row.
    assert.equal(mp.eldoradoMarkDelivered.calls.length, 0);
    assert.equal((await MarketplaceListing.findById(listing._id).lean()).units.length, 0);
    // All eight units stay claimed under the order id, off the shelf.
    const held = await SuppliedAccount.find({ offer: offer._id, orderId: "ord-long" }).lean();
    assert.equal(held.length, 8, "the eight units stay claimed under the order id");
    assert.ok(held.every((r) => r.status === "sold" && r.market === "eldorado"));
    assert.equal(await supplied.stockFor(offer._id, { deps }), 2);
    // And the ledger says which of them the buyer already holds: the one unit
    // whose message the chat accepted, and only that one.
    const claimed = rows.filter((r) => held.some((h) => String(h._id) === r.id)).sort(byId);
    const expected = claimed.map((r, i) => header(i + 1, 8) + textFor(offer, r));
    const out = held.filter((r) => r.deliveredAt);
    assert.equal(out.length, 1, "one unit is with the buyer");
    assert.equal(String(out[0]._id), claimed[0].id, "the one that was message 1");
    // deliveredAt is the ledger's hard stop: a release of this order's rows —
    // the buyer cancelled, say — hands back the seven the buyer never saw and
    // not the one already disclosed.
    assert.equal(
      await SuppliedAccount.countDocuments({
        offer: offer._id,
        orderId: "ord-long",
        deliveredAt: null,
      }),
      7,
    );

    const attempt1 = texts(mp).slice();
    assert.deepEqual(attempt1, [expected[0], expected[1]]);

    // pm2 restart between the two ticks: the process no longer knows what the
    // chat accepted, so only the claim's resume ties the retry to the order.
    e.longDeliveryProgress.clear();

    const second = await e.deliverOrder(order("ord-long", listing, 8), {
      dryRun: false,
      unitGapMs: 0,
    });
    assert.deepEqual(second, {
      orderId: "ord-long",
      delivered: 8,
      source: "offer:" + offer.title,
    });

    // The same eight units, in ledger-id order, each under the number it had on
    // the first attempt — so message 1 goes out again word for word, which is
    // what lets the chat recognise it, and message 2 is the text that failed.
    assert.deepEqual(texts(mp).slice(2), expected);

    // Marked once, burned once, and the shelf is exactly where it was.
    assert.deepEqual(mp.eldoradoMarkDelivered.calls, [["ord-long"]]);
    const after = await SuppliedAccount.find({ offer: offer._id, orderId: "ord-long" }).lean();
    assert.equal(after.length, 8, "the retry claimed nothing new");
    assert.deepEqual(
      after.map((r) => String(r._id)).sort(),
      held.map((r) => String(r._id)).sort(),
    );
    assert.ok(after.every((r) => r.status === "sold" && r.deliveredAt instanceof Date));
    assert.deepEqual(
      after.map((r) => new Date(r.soldAt).getTime()),
      held.map((r) => new Date(r.soldAt).getTime()),
      "soldAt — the resume's sort key — is never restamped",
    );
    assert.equal(await supplied.stockFor(offer._id, { deps }), 2);
    const row = await MarketplaceListing.findById(listing._id).lean();
    assert.equal(row.units.length, 8);
    assert.deepEqual(
      row.units.map((u) => u.contentId).sort(),
      held.map((r) => String(r._id)).sort(),
    );
    assert.ok(row.units.every((u) => u.orderId === "ord-long" && u.accountId === ""));
    assert.deepEqual(mp.eldoradoSetQuantity.calls, [[listing.externalId, 2]]);

    // And if Eldorado shows the order once more, it is recognised as done.
    const third = await e.deliverOrder(order("ord-long", listing, 8), {
      dryRun: false,
      unitGapMs: 0,
    });
    assert.deepEqual(third, { orderId: "ord-long", skipped: "already delivered" });
    assert.equal(texts(mp).length, 10, "not one more message");
  });
});

test("three attempts that each get a little further end with every unit sent once", async () => {
  // The resume re-reads rows the earlier attempts already stamped delivered:
  // a stamped row must come back like any other, or the order would run short.
  const { offer, listing } = await shelfOf(9);
  const mp = fakeMarket({ failSendOn: [3, 6] });

  await withFulfiller(mp, async (e) => {
    const o = order("ord-steps", listing, 8);
    const a = await e.deliverOrder(o, { dryRun: false, unitGapMs: 0 });
    assert.match(a.error, /interrupted at message 3 of 8 \(at least 2 of 8/);
    const b = await e.deliverOrder(o, { dryRun: false, unitGapMs: 0 });
    assert.match(b.error, /interrupted at message 5 of 8 \(at least 4 of 8/);
    assert.equal(
      await SuppliedAccount.countDocuments({
        offer: offer._id,
        orderId: "ord-steps",
        deliveredAt: { $ne: null },
      }),
      4,
    );
    const c = await e.deliverOrder(o, { dryRun: false, unitGapMs: 0 });
    assert.equal(c.delivered, 8);
  });

  const accepted = texts(mp).filter((_t, i) => ![2, 5].includes(i));
  assert.equal(accepted.length, 8);
  assert.equal(new Set(accepted).size, 8, "eight different unit messages, none twice");
  assert.equal(await SuppliedAccount.countDocuments({ offer: offer._id, orderId: "ord-steps" }), 8);
  assert.equal(await supplied.stockFor(offer._id, { deps }), 1);
});

/* -------------------------- the short order, for real ---------------------- */

test("a short order through the real layers is one message, as it always was", async () => {
  const { offer, listing, rows } = await shelfOf(4, 120);
  const mp = fakeMarket();

  const out = await withFulfiller(mp, (e) =>
    e.deliverOrder(order("ord-short", listing, 3), { dryRun: false }),
  );

  assert.equal(out.delivered, 3);
  const sent = texts(mp);
  assert.equal(sent.length, 1);
  // Three headers in order, each followed by one claimed unit's own text. Which
  // unit comes first is the claim's order, and that is left to the claim.
  const held = await SuppliedAccount.find({ offer: offer._id, orderId: "ord-short" }).lean();
  assert.equal(held.length, 3);
  const blocks = sent[0].split(/(?:^|\n\n)=== ACCOUNT \d of 3 ===\n\n/).slice(1);
  assert.equal(blocks.length, 3);
  assert.deepEqual(
    blocks.slice().sort(),
    rows
      .filter((r) => held.some((h) => String(h._id) === r.id))
      .map((r) => textFor(offer, r))
      .sort(),
  );
  assert.equal(
    sent[0],
    blocks.map((b, i) => header(i + 1, 3) + b).join("\n\n"),
    "the single message is the headed blocks joined by a blank line, and nothing else",
  );
  assert.deepEqual(mp.eldoradoMarkDelivered.calls, [["ord-short"]]);
  assert.ok(held.every((r) => r.deliveredAt instanceof Date), "burned once, at the end");
  assert.equal(await supplied.stockFor(offer._id, { deps }), 1);
});
