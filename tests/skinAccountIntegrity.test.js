process.env.SESSION_SECRET ||= "skin-integrity-test-session";
process.env.CRED_SECRET ||= "skin-integrity-test-credentials";
process.env.PUBLIC_BASE_URL = "https://shop.example.test";
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const express = require("express");
const { MongoMemoryServer } = require("mongodb-memory-server");
const EpicAccount = require("../models/EpicAccount");
const EpicListing = require("../models/EpicListing");
const Skin = require("../models/SkinAccount");
const Bot = require("../models/BotAccount");
const Pool = require("../models/AvailableAccount");
const Drop = require("../models/DropLog");
const BuyerSession = require("../models/BuyerMailSession");
const { encrypt } = require("../utils/secretBox");
const sales = require("../utils/epicSales");
const reservations = require("../utils/dropReservation");
const outlook = require("../utils/outlookGraphReader");
let db,
  server,
  base,
  sequence = 0;
const oid = () => new mongoose.Types.ObjectId();

async function pair(options = {}) {
  const n = ++sequence;
  const epic = await EpicAccount.create({
    accountId: `epic-${n}`,
    displayName: `Epic ${n}`,
    email: encrypt(`account-${n}@example.invalid`),
    password: encrypt("fixture-password"),
    status: "ok",
  });
  const bot = await Bot.create({
    clientSecret: `fixture-token-${n}`,
    login: `twitch${n}`,
    twitchId: String(n),
  });
  const row = await Skin.create({
    epicAccountId: epic._id,
    botAccountId: bot._id,
    twitchLogin: bot.login,
    twitchId: bot.twitchId,
    holdTag: `skin:${n}`,
    ...options,
  });
  return { epic, bot, row };
}
async function drops(bot, stamp = {}) {
  return Drop.create(
    ["rocket-league:drop", "other-game:drop"].map((key, i) => ({
      account: bot._id,
      login: bot.login,
      benefitId: `benefit-${++sequence}`,
      itemKey: key,
      game: i ? "Other Game" : "Rocket League",
      count: 1,
      ...stamp,
    })),
  );
}
const set = {
  _id: "fixture-set",
  items: [{ itemKey: "rocket-league:drop", game: "Rocket League" }],
};
function call(method, path, body) {
  return fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test.before(async () => {
  db = await MongoMemoryServer.create();
  await mongoose.connect(db.getUri());
  outlook.checkInbox = async () => ({ status: "live", sharedWith: [] });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { admin: { id: "fixture-admin", role: "superadmin" } };
    next();
  });
  app.use(require("../routes/epicAccountRoutes"));
  app.use(require("../routes/epicAccountDetailsRoutes"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections))
    await collection.deleteMany({});
});
test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (db) await db.stop();
});

test("a whole Epic account stays unavailable in generic stock for every lifecycle state", async () => {
  const { epic, row } = await pair();
  for (const state of [
    "preparing",
    "ready",
    "listed",
    "paused",
    "attention",
    "sold",
  ]) {
    await Skin.updateOne({ _id: row._id }, { $set: { state } });
    const ctx = await sales.stockContext({ accountIds: [epic._id] });
    assert.equal(
      sales.readinessOf(ctx.accounts[0], ctx).state,
      "listed",
      state,
    );
    assert.equal(
      (await sales.listingForAccount(epic._id)).market,
      "skin-account",
    );
    await assert.rejects(
      sales.previewListing({ accountIds: [epic._id] }),
      /Skin Accounts/,
    );
  }
});

test("all generic listing mutations reject an adopted skin listing before contacting Eldorado", async () => {
  const { epic, row } = await pair();
  const listing = await EpicListing.create({
    status: "active",
    externalId: "fixture-offer",
    title: "Exact game inventory",
    accounts: [{ epicAccountId: epic._id }],
  });
  await Skin.updateOne({ _id: row._id }, { $set: { listingId: listing._id } });
  for (const fn of [
    () => sales.addAccounts(listing._id, [oid()]),
    () => sales.removeAccount(listing._id, epic._id),
    () => sales.updateText(listing._id, { title: "overwrite" }),
    () => sales.setPrice(listing._id, 1),
    () => sales.pauseListing(listing._id),
    () => sales.resumeListing(listing._id),
    () => sales.deleteListing(listing._id),
    () => sales.linkOffer(listing._id, "other-offer"),
  ])
    await assert.rejects(
      fn(),
      (error) => error.status === 409 && /Skin Accounts/.test(error.message),
    );
  assert.equal(
    (await EpicListing.findById(listing._id)).title,
    "Exact game inventory",
  );
  await Skin.deleteOne({ _id: row._id });
  await EpicListing.updateOne(
    { _id: listing._id },
    { $set: { managedBy: "skin-account" } },
  );
  await assert.rejects(
    sales.updateText(listing._id, { title: "overwrite" }),
    /Skin Accounts/,
  );
});

test("manual sold toggles, deletion and buyer delivery cannot free or sell a skin account", async () => {
  const { epic } = await pair({ state: "paused" });
  for (const [method, suffix, body] of [
    ["PATCH", "", { sold: true }],
    ["PATCH", "", { sold: false }],
    ["DELETE", ""],
    ["POST", "/buyer-session", {}],
  ]) {
    const response = await call(
      method,
      `/api/epic/accounts/${epic._id}${suffix}`,
      body,
    );
    assert.equal(response.status, 409, await response.text());
  }
  assert.ok(await EpicAccount.exists({ _id: epic._id }));
  assert.equal(await BuyerSession.countDocuments(), 0);
  const response = await call("PATCH", `/api/epic/accounts/${epic._id}`, {
    label: "Inventory checked",
  });
  assert.equal(response.status, 200, await response.text());
});

test("generic reserve refuses every game of an enrolled Twitch, including duplicate bot and pool identities", async () => {
  const { bot } = await pair();
  const duplicate = await Bot.create({
    clientSecret: "duplicate-fixture",
    login: bot.login.toUpperCase(),
    twitchId: bot.twitchId,
  });
  const pool = await Pool.create({
    username: bot.login,
    usernameLower: bot.login,
    twitchId: bot.twitchId,
  });
  for (const identity of [
    bot,
    duplicate,
    { _id: pool._id, login: pool.username },
  ]) {
    await drops(identity);
    assert.equal(
      await reservations.reserveSetOnAccount(identity._id, set),
      false,
    );
  }
  assert.equal(await Drop.countDocuments({ soldAt: { $ne: null } }), 0);
});

test("every generic release keeps the permanent hold while releasing unrelated stock", async () => {
  const { bot } = await pair({ state: "sold", ownershipStatus: "sold" });
  const free = await Bot.create({
    clientSecret: "free-fixture",
    login: "free-account",
    twitchId: "free-id",
  });
  const stamp = {
    soldAt: new Date(),
    soldToUsername: "old-market",
    soldSetId: "fixture-set",
    soldBulkOrderId: "fixture-bulk",
  };
  await Bot.updateOne({ _id: bot._id }, { $set: stamp });
  for (const release of [
    () => reservations.releaseAccountsForTag([bot._id, free._id], "old-market"),
    () =>
      reservations.releaseSetForAccounts(
        [bot._id, free._id],
        "fixture-set",
        "old-market",
      ),
    () => reservations.releaseBySet("fixture-set", "old-market"),
    () => reservations.releaseByBulkOrder("fixture-bulk"),
  ]) {
    await Drop.deleteMany({});
    await drops(bot, stamp);
    await drops(free, stamp);
    await release();
    assert.equal(
      await Drop.countDocuments({ account: bot._id, soldAt: { $ne: null } }),
      2,
    );
    assert.equal(
      await Drop.countDocuments({ account: free._id, soldAt: null }),
      2,
    );
    assert.ok((await Bot.findById(bot._id)).soldAt);
  }
});

test("post-reservation enrollment recheck rolls back only the just-written batch", async () => {
  const bot = await Bot.create({
    clientSecret: "racing-fixture",
    login: "racing",
    twitchId: "racing-id",
  });
  await drops(bot);
  await Drop.updateOne(
    { account: bot._id, itemKey: "other-game:drop" },
    { $set: { soldAt: new Date(1), soldToUsername: "prior-buyer" } },
  );
  const original = Drop.updateMany;
  let inserted = false;
  Drop.updateMany = async function (filter, update, ...rest) {
    const result = await original.call(this, filter, update, ...rest);
    if (!inserted && update.$set?.soldAt) {
      inserted = true;
      await Skin.create({
        epicAccountId: oid(),
        botAccountId: bot._id,
        twitchLogin: bot.login,
        twitchId: bot.twitchId,
        holdTag: "racing-hold",
      });
    }
    return result;
  };
  try {
    assert.equal(
      await reservations.reserveSetOnAccount(bot._id, set, {
        soldToUsername: "new-market",
      }),
      false,
    );
    assert.equal(
      (await Drop.findOne({ itemKey: "rocket-league:drop" })).soldAt,
      null,
    );
    assert.equal(
      (await Drop.findOne({ itemKey: "other-game:drop" })).soldToUsername,
      "prior-buyer",
    );
  } finally {
    Drop.updateMany = original;
  }
});

test("enrollment and drop release share a lock so release observes the new lifetime fence", async () => {
  const bot = await Bot.create({
    clientSecret: "locked-fixture",
    login: "locked",
    twitchId: "locked-id",
  });
  await drops(bot, { soldAt: new Date(), soldToUsername: "held-tag" });
  let unlock;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    unlock = resolve;
  });
  const enrollment = sales._internals.withLock(async () => {
    entered();
    await gate;
    await Skin.create({
      epicAccountId: oid(),
      botAccountId: bot._id,
      twitchLogin: bot.login,
      twitchId: bot.twitchId,
      holdTag: "held-tag",
    });
  });
  await started;
  const releasing = reservations.releaseAccountsForTag([bot._id], "held-tag");
  unlock();
  await enrollment;
  await releasing;
  assert.equal(
    await Drop.countDocuments({ account: bot._id, soldAt: { $ne: null } }),
    2,
  );
});

test("sale ownership hook completes before mail activation and a failed ledger write remains retryable", async () => {
  const { epic } = await pair({ state: "listed" });
  const session = await BuyerSession.create({
    epicAccountId: epic._id,
    inboxAddress: "sale@example.invalid",
    passwordHash: "fixture-hash",
    expiresAt: new Date(Date.now() + 86400000),
    stage: "listed",
  });
  const skinService = require("../utils/skinAccounts");
  const original = skinService.markSkinSold;
  let attempts = 0;
  skinService.markSkinSold = async (id, details) => {
    attempts++;
    assert.equal(String(id), String(epic._id));
    assert.equal(details.orderId, "sale-order");
    assert.equal((await BuyerSession.findById(session._id)).stage, "listed");
    if (attempts === 1) throw new Error("Lifetime sale ledger needs retry");
  };
  const unit = {
    epicAccountId: epic._id,
    sessionId: session._id,
    state: "listed",
  };
  try {
    await assert.rejects(
      sales._internals.markUnitSold(unit, "sale-order", new Date(), {
        sessionDays: 14,
      }),
      /needs retry/,
    );
    assert.equal(unit.state, "listed");
    assert.equal((await EpicAccount.findById(epic._id)).sold, false);
    const soldAt = new Date();
    await sales._internals.markUnitSold(unit, "sale-order", soldAt, {
      sessionDays: 7,
    });
    const activated = await BuyerSession.findById(session._id);
    assert.equal(activated.stage, "sold");
    assert.equal(
      activated.expiresAt.getTime() - soldAt.getTime(),
      14 * 86400000,
      "skin products retain their promised 14 days even when generic Epic access is 7 days",
    );
    assert.equal(unit.state, "sold");
  } finally {
    skinService.markSkinSold = original;
  }
});

test("ordinary per-game stock still reserves and releases normally", async () => {
  const bot = await Bot.create({
    clientSecret: "ordinary-fixture",
    login: "ordinary",
    twitchId: "ordinary-id",
  });
  await drops(bot);
  assert.equal(
    await reservations.reserveSetOnAccount(bot._id, set, {
      soldToUsername: "test-market",
    }),
    true,
  );
  assert.equal(
    await Drop.countDocuments({ account: bot._id, soldAt: { $ne: null } }),
    1,
  );
  await reservations.releaseSetForAccounts(
    [bot._id],
    "fixture-set",
    "test-market",
  );
  assert.equal(
    await Drop.countDocuments({ account: bot._id, soldAt: null }),
    2,
  );
  assert.equal((await Bot.findById(bot._id)).soldAt, null);
});

test("profile routes preserve delivery credentials and account region for lifetime-held accounts", async () => {
  const { epic } = await pair({ state: "paused" });
  const details = encrypt(
    JSON.stringify({
      country: "JP",
      notes: "Kept evidence",
      firstName: "Existing",
      lastName: "Owner",
    }),
  );
  await EpicAccount.updateOne(
    { _id: epic._id },
    { $set: { accountDetails: details } },
  );
  for (const body of [
    { email: "different@example.invalid" },
    { password: "replacement" },
    { totpSecret: "replacement" },
    { country: "US" },
    { notes: "overwritten" },
  ]) {
    const response = await call(
      "PATCH",
      `/api/epic/accounts/${epic._id}/details`,
      body,
    );
    assert.equal(response.status, 409, await response.text());
  }
  let response = await call(
    "POST",
    `/api/epic/accounts/${epic._id}/details/sample-contact`,
    {},
  );
  assert.equal(response.status, 409, await response.text());
  response = await call(
    "POST",
    "/api/epic/accounts/details/backfill-location",
    { generateSamples: true },
  );
  assert.equal(response.status, 200, await response.text());
  assert.equal((await EpicAccount.findById(epic._id)).accountDetails, details);
  response = await call("PATCH", `/api/epic/accounts/${epic._id}/details`, {
    label: "Kept label edit",
    country: "JP",
    password: "",
  });
  assert.equal(response.status, 200, await response.text());
  const after = await EpicAccount.findById(epic._id);
  assert.equal(after.label, "Kept label edit");
  assert.equal(after.accountDetails, details);
  assert.equal(after.password, epic.password);
});

test("strict account publication never guesses an ambiguous create ID from another offer title", async () => {
  const mp = require("../utils/marketplaces");
  const eld = require("../utils/eldoradoAccountOffers");
  const original = mp.eldRequest;
  const calls = [];
  const opts = {
    recoverByTitle: false,
    title: "Rocket League whole account",
    description: "Fixture only",
    priceUsd: 4.99,
    section: "rocket-league",
    mainOfferImage: { largeImage: "fixture-image.png" },
    entries: [
      {
        accountLogin: "fixture@example.invalid",
        accountPassword: "fixture-password",
      },
    ],
  };
  mp.eldRequest = async (method, path) => {
    calls.push({ method, path });
    if (method !== "POST")
      throw new Error("Title-based recovery must not query another offer");
    return {};
  };
  try {
    const result = await eld.createAccountOffer(opts);
    assert.equal(result.id, "");
    assert.deepEqual(calls, [
      { method: "POST", path: "/api/flexibleOffers/account" },
    ]);
    mp.eldRequest = async () => ({
      id: "33333333-3333-4333-8333-333333333333",
    });
    assert.equal(
      (await eld.createAccountOffer(opts)).id,
      "33333333-3333-4333-8333-333333333333",
    );
  } finally {
    mp.eldRequest = original;
  }
});
