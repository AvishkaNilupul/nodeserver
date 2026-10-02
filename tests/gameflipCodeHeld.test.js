// Gameflip refuses a delivery code one of our listings still holds — "code for
// digital goods already exists" — and the code is only the account's login and
// password. A SOLD listing keeps its code for good, so an account sold on
// Gameflip once (its other games still in stock, per game) can never be listed
// there again. Leanest-first put exactly those accounts first: on 2026-10-01
// the Hunt: Showdown renewal (187 units owed) picked one on every attempt and
// failed eight times in a row, with 119 accounts Gameflip would take behind it.
//
// Runs the real claim + publish against mongodb-memory-server with the stock
// query, the reservations and the Gameflip API faked.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.SESSION_SECRET ||= "gf-code-held-test";
process.env.CRED_SECRET ||= "gf-code-held-cred";

const world = {
  candidates: [], // [{ accountId, login }] in leanest-first order
  reserved: [],
  released: [],
  published: [], // the login inside each code Gameflip was asked to attach
  refuse: new Set(), // logins whose code Gameflip says already exists
};

const fakeMp = {
  async gameflipPublish({ autoDeliverCode }) {
    const login = (String(autoDeliverCode).match(/Login: (\S+)/) || [])[1];
    world.published.push(login);
    if (world.refuse.has(login)) {
      throw new Error(
        'Gameflip could not attach the delivery content (draft d-1 discarded): ' +
          '{"status":"FAILURE","data":null,"error":{"message":"code for digital goods already exists","code":400}}',
      );
    }
    return { externalId: "gf-new-" + world.published.length, url: "https://gameflip.com/item/x" };
  },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /utils[\\/]gameflipFulfiller\.js$/.test(parent.filename || "")) {
    if (request === "./marketplaces") return fakeMp;
    if (request === "../routes/shopRoutes") {
      return { availableAccountsForSet: async () => world.candidates.map((c) => ({ ...c })) };
    }
    if (request === "./dropReservation") {
      return {
        reserveSetOnAccount: async (id) => {
          world.reserved.push(String(id));
          return true;
        },
        releaseSetForAccounts: async (ids) => {
          world.released.push(...ids.map(String));
        },
        releaseAccountsForTag: async () => {},
      };
    }
    if (request === "./telegram") return { sendTelegram: async () => {} };
    if (request === "./gameflipFarmService") {
      return { renewsOnExpiry: () => false, onBufferedSale: async () => ({}) };
    }
    if (request === "./settings") {
      return { getAutoFarm: () => ({}), getAccountListingSettings: () => ({}) };
    }
    if (request === "./autoLister") return {};
  }
  return realLoad.call(this, request, parent, isMain);
};

const BotAccount = require("../models/BotAccount");
const MarketplaceListing = require("../models/MarketplaceListing");
const { encrypt } = require("../utils/secretBox");
const gf = require("../utils/gameflipFulfiller");

let mongod;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});
test.after(async () => {
  Module._load = realLoad;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});
test.beforeEach(async () => {
  await BotAccount.deleteMany({});
  await MarketplaceListing.deleteMany({});
  world.candidates = [];
  world.reserved = [];
  world.released = [];
  world.published = [];
  world.refuse = new Set();
  gf.resetCodeRefused();
});

const SET = { _id: new mongoose.Types.ObjectId(), name: "Hunt: Showdown 1896 Twitch Drops Bundle", items: [] };

// Accounts in leanest-first order, as availableAccountsForSet returns them.
async function holders(...logins) {
  for (const login of logins) {
    const a = await BotAccount.create({ clientSecret: "cs-" + login, login, credPassword: encrypt("pw-" + login) });
    world.candidates.push({ accountId: a._id, login });
  }
}

function listing(login, over = {}) {
  return MarketplaceListing.create({
    set: new mongoose.Types.ObjectId(),
    marketplace: "gameflip",
    externalId: "gf-" + login + "-" + (over.status || "sold"),
    title: "Fortnite Twitch Drop — The Helm Guitar",
    price: 1,
    status: "sold",
    autoDeliver: true,
    accountLogin: login,
    ...over,
  });
}

function publish() {
  return gf.publishAutoDelivery({
    set: SET,
    title: "Hunt: Showdown 1896 Twitch Drops (3 Items)",
    description: "the same text",
    priceUsd: 0.75,
    imagePath: "",
    qtyRemaining: 187,
    origin: "manual",
  });
}

test("REGRESSION 2026-10-01: an account already sold on Gameflip is skipped — its sold listing still holds the same code", async () => {
  await holders("sold-on-gf", "fresh");
  await listing("sold-on-gf");
  const row = await publish();
  assert.deepStrictEqual(world.published, ["fresh"], "Gameflip was never asked for the code it already holds");
  assert.strictEqual(world.reserved.length, 1, "only the account that can be listed was reserved");
  assert.strictEqual(row.accountLogin, "fresh");
  assert.strictEqual(row.qtyRemaining, 187);
});

test("a sale on another market, or a Gameflip listing since deleted, holds no Gameflip code — the account stays first", async () => {
  await holders("reused", "fresh");
  await listing("reused", { marketplace: "eldorado" });
  await listing("reused", { status: "removed" }); // ended on Gameflip: DELETE, read back 404
  await listing("reused", { status: "delisted" }); // the Listings Delist route deletes too
  await listing("reused", { autoDeliver: false }); // hand-made: no code at all
  const row = await publish();
  assert.deepStrictEqual(world.published, ["reused"]);
  assert.strictEqual(row.accountLogin, "reused");
});

test("matching is case-blind, like every other login check", async () => {
  await holders("mixedcase", "fresh");
  await listing("MixedCase");
  await publish();
  assert.deepStrictEqual(world.published, ["fresh"]);
});

test("when Gameflip holds the code of every holder it is out of stock — and says why", async () => {
  await holders("only-one");
  await listing("only-one");
  await assert.rejects(publish(), (e) => {
    assert.match(e.message, /^Out of stock — every account that holds this whole bundle \(1\) was already sold on Gameflip/);
    assert.ok(gf.isOutOfStockError(e.message), "still an out-of-stock error: same backoff, same single alert");
    return true;
  });
  assert.deepStrictEqual(world.published, []);
  assert.deepStrictEqual(world.reserved, []);
});

test("an empty bundle keeps its plain out-of-stock message", async () => {
  await assert.rejects(publish(), (e) => /^Out of stock — no unsold account holds this whole bundle/.test(e.message));
});

test("a refusal the database cannot explain is learned: the next attempt takes someone else, and the account comes back after a day", async () => {
  // E.g. a half-built draft whose discard Gameflip's limiter swallowed.
  await holders("zombie-held", "fresh");
  world.refuse.add("zombie-held");
  await assert.rejects(publish(), /code for digital goods already exists/);
  assert.deepStrictEqual(world.released, world.reserved, "the failed claim was handed back");

  const second = await publish();
  assert.deepStrictEqual(world.published, ["zombie-held", "fresh"], "not the same account twice");
  assert.strictEqual(second.accountLogin, "fresh");

  // A day on, the holder may be gone: the account is tried again.
  world.refuse.clear();
  const realNow = Date.now;
  Date.now = () => realNow() + gf.CODE_REFUSED_TTL_MS + 60000;
  try {
    const third = await publish();
    assert.strictEqual(third.accountLogin, "zombie-held");
  } finally {
    Date.now = realNow;
  }
});

test("a Gameflip failure of any other kind teaches nothing — the account stays first", async () => {
  await holders("busy", "fresh");
  fakeMp.gameflipPublish = (orig => async (args) => {
    fakeMp.gameflipPublish = orig;
    throw new Error('Gameflip create: {"message":"Too many attempts - Retry later","code":429}');
  })(fakeMp.gameflipPublish);
  await assert.rejects(publish(), /Too many attempts/);
  const row = await publish();
  assert.strictEqual(row.accountLogin, "busy");
});
