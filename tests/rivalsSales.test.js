process.env.SESSION_SECRET = "rivals-test-session";
process.env.CRED_SECRET = "rivals-test-credentials";
process.env.PUBLIC_BASE_URL = "https://example.test";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const SteamAccount = require("../models/SteamAccount"),
  Listing = require("../models/SteamListing"),
  BuyerMailSession = require("../models/BuyerMailSession");
const { encrypt } = require("../utils/secretBox"),
  sales = require("../utils/steamSales"),
  { digest } = require("../utils/rivalsAccounts"),
  { createService } = require("../utils/rivalsSales");
let mongo,
  dir,
  service,
  db,
  offers,
  createCount,
  uploadFail,
  createFail,
  mismatch,
  orders = [];
const fakeOutlook = {
  checkInbox: async () => ({ status: "live", uses: ["steam"] }),
  readMailFor: async () => ({ messages: [] }),
};
const fakeEld = {
  epicPermission: async () => ({ canSell: true, error: "" }),
  uploadImage: async () => {
    if (uploadFail) throw Error("upload failed");
    return {
      smallImage: "s.png",
      largeImage: "l.png",
      originalSizeImage: "o.png",
    };
  },
  offerUrl: (id) => "https://www.eldorado.gg/marvel-rivals-accounts/oa/" + id,
  createAccountOffer: async (o) => {
    assert.ok(
      1 + o.offerImages.length <= 5,
      "Eldorado permits five account screenshots",
    );
    createCount++;
    if (createFail) throw Error("connection reset after send");
    const id = "test-offer-" + createCount;
    offers.set(id, {
      ...o,
      offerTitle: o.title,
      offerState: "Active",
      quantity: 1,
      pricePerUnit: { currency: "USD", amount: o.priceUsd },
    });
    return { id };
  },
  getAccountOffer: async (id) => offers.get(id),
  getAccountEntries: async (id) =>
    offers.get(id).entries.map((e, i) => ({
      ...e,
      id: "entry" + i,
      ...(mismatch ? { accountPassword: "wrong" } : {}),
    })),
  pauseAccountOffer: async (id) => {
    offers.get(id).offerState = "Paused";
  },
  deleteAccountOffer: async (id) => {
    offers.delete(id);
  },
};
test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  db = mongoose.connection.db;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "rivals-sales-"));
  sales._setDeps({
    eld: fakeEld,
    outlook: fakeOutlook,
    notify: async () => {},
  });
});
test.after(async () => {
  sales.stop();
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(dir, { recursive: true, force: true });
});
test.beforeEach(async () => {
  for (const name of [
    "steamaccounts",
    "steamlistings",
    "steamsales",
    "steamg2gunits",
    "steamboosts",
    "buyermailsessions",
    "rivalspreparations",
    "droplogs",
  ])
    await db.collection(name).deleteMany({});
  offers = new Map();
  orders = [];
  createCount = 0;
  uploadFail = createFail = mismatch = false;
  service = createService({
    db,
    sales,
    eld: fakeEld,
    outlook: fakeOutlook,
    Listing,
    proofDir: dir,
  });
});
async function seed() {
  const id = "rivals-test-preparation";
  const steam = await SteamAccount.create({
    localId: "local-test",
    accountName: "test_steam",
    password: encrypt("steam-password"),
    email: encrypt("inbox@example.test"),
    stage: "problem",
    notes: "Preparation " + id,
    signupCountry: "JP",
  });
  const twitchId = new mongoose.Types.ObjectId();
  await fs.mkdir(path.join(dir, id), { recursive: true });
  await fs.writeFile(path.join(dir, id, "rogue.png"), "image");
  await db.collection("rivalspreparations").insertOne({
    _id: id,
    holdId: "test-hold",
    steamId: steam._id,
    twitchId,
    status: "held",
    expectedRewards: [{ id: "reward1" }],
    reservedCount: 1,
    gameReport: {
      state: "ready",
      phase: "logged-out",
      rivalsUid: "123456789",
      verifiedAt: new Date(),
      completedAt: new Date(),
      proofs: [
        {
          rewardId: "reward1",
          file: "rogue.png",
          sha256: digest(Buffer.from("image")),
          hero: "Rogue",
          costume: "Will of Galacta",
        },
      ],
    },
  });
  await db.collection("droplogs").insertOne({
    account: twitchId,
    soldSetId: "test-hold",
    soldToUsername: "manual",
    soldAt: new Date(),
  });
  return { id, steam };
}
test("publishes exact game category with site-only email delivery and idempotent preparation", async () => {
  const { id, steam } = await seed();
  const l = await service.publish(id, "test");
  assert.equal(createCount, 1);
  const o = offers.values().next().value;
  assert.equal(o.section.gameId, "227");
  assert.equal(o.section.tradeEnvironmentId, "9-0");
  assert.equal(o.hasOriginalEmail, false);
  assert.equal(o.entries.length, 1);
  assert.equal(o.entries[0].emailProviderUrl, "https://example.test/mail/");
  assert.notEqual(o.entries[0].emailPassword, "steam-password");
  assert.match(o.description, /original Outlook inbox is not included/);
  assert.ok(o.description.length <= 2000);
  const sess = await BuyerMailSession.findOne({ steamAccountId: steam._id });
  assert.equal(sess.kind, "steam");
  assert.equal(sess.stage, "listed");
  assert.equal((await SteamAccount.findById(steam._id)).stage, "listed");
  assert.equal((await service.publish(id))._id, l._id);
  assert.equal(createCount, 1);
  assert.equal(
    await db.collection("droplogs").countDocuments({ soldSetId: "test-hold" }),
    1,
  );
});
test("concurrent independent publisher locks cannot create two offers", async () => {
  const { id } = await seed();
  const independent = {
    ...sales,
    _shared: { ...sales._shared, withLock: (fn) => fn() },
  };
  const a = createService({
    db,
    sales: independent,
    eld: fakeEld,
    outlook: fakeOutlook,
    Listing,
    proofDir: dir,
  });
  const b = createService({
    db,
    sales: independent,
    eld: fakeEld,
    outlook: fakeOutlook,
    Listing,
    proofDir: dir,
  });
  const results = await Promise.allSettled([a.publish(id), b.publish(id)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(createCount, 1);
});
test("pre-create failure restores original hold and revokes only newly minted email session", async () => {
  const { id, steam } = await seed();
  uploadFail = true;
  await assert.rejects(service.publish(id), /before offer creation/);
  assert.equal(createCount, 0);
  assert.equal((await SteamAccount.findById(steam._id)).stage, "problem");
  assert.ok(
    (await BuyerMailSession.findOne({ steamAccountId: steam._id })).revokedAt,
  );
  assert.equal(
    (await db.collection("rivalspreparations").findOne({ _id: id }))
      .publishState,
    "failed",
  );
});
test("uncertain create never releases credentials or retries publication", async () => {
  const { id, steam } = await seed();
  createFail = true;
  await assert.rejects(service.publish(id), /reconciliation/);
  assert.equal((await SteamAccount.findById(steam._id)).stage, "listed");
  assert.equal(
    (await BuyerMailSession.findOne({ steamAccountId: steam._id })).revokedAt,
    null,
  );
  await assert.rejects(service.publish(id), /unresolved publish/);
  assert.equal(createCount, 1);
});
test("remote delivery mismatch pauses known offer and retains reservation for reconciliation", async () => {
  const { id, steam } = await seed();
  mismatch = true;
  await assert.rejects(service.publish(id), /reconciliation/);
  assert.equal(offers.values().next().value.offerState, "Paused");
  assert.equal((await SteamAccount.findById(steam._id)).stage, "listed");
  assert.equal((await Listing.findOne({ preparationId: id })).status, "paused");
});
test("ordinary Steam add-stock is refused and delisting returns Rivals to its internal hold", async () => {
  const { id, steam } = await seed();
  const l = await service.publish(id);
  await assert.rejects(sales.addAccounts(l._id), /own verified costume/);
  const removed = await sales.deleteListing(l._id, "test");
  assert.equal(removed.status, "removed");
  assert.equal((await SteamAccount.findById(steam._id)).stage, "problem");
  assert.ok(
    (await BuyerMailSession.findOne({ steamAccountId: steam._id })).revokedAt,
  );
});
test("changed proof or Twitch reservation refuses before any account session or offer exists", async () => {
  const { id } = await seed();
  await fs.writeFile(path.join(dir, id, "rogue.png"), "changed");
  await assert.rejects(service.publish(id), /screenshot changed/);
  assert.equal(createCount, 0);
  assert.equal(await BuyerMailSession.countDocuments(), 0);
  await fs.writeFile(path.join(dir, id, "rogue.png"), "image");
  await db.collection("droplogs").deleteMany({});
  await assert.rejects(service.publish(id), /reservation changed/);
});
test("Rivals purchase uses existing sale sync exactly once and starts the seven-day mail window", async () => {
  const { id, steam } = await seed();
  const l = await service.publish(id);
  const offer = offers.values().next().value;
  const entries = offer.entries.splice(0);
  offer.quantity = 0;
  const offerId = l.url.split("/oa/")[1],
    soldAt = new Date();
  orders = [
    {
      id: "rivals-order-test",
      offerId,
      purchaseQuantity: 1,
      createdDate: soldAt.toISOString(),
      state: { state: "Paid" },
      totalPrice: { amount: 7.99, currency: "USD" },
      buyerUsername: "test-buyer",
    },
  ];
  fakeEld.ordersInStates = async () => orders;
  fakeEld.orderAccountDetails = async () => entries;
  await sales.tick({ force: true });
  await sales.tick({ force: true });
  assert.equal((await SteamAccount.findById(steam._id)).stage, "sold");
  assert.equal(
    await db
      .collection("steamsales")
      .countDocuments({ orderId: "rivals-order-test" }),
    1,
  );
  const session = await BuyerMailSession.findOne({ steamAccountId: steam._id });
  assert.equal(session.stage, "sold");
  assert.equal(+session.expiresAt - +session.soldAt, 7 * 86400000);
  assert.equal(await sales.isSteamOffer(offerId), true);
  assert.equal(
    await db.collection("droplogs").countDocuments({ soldSetId: "test-hold" }),
    1,
  );
});
test("seven verified costumes retain all evidence while the offer obeys the five-image limit", async () => {
  const { id } = await seed();
  const prep = await db.collection("rivalspreparations").findOne({ _id: id });
  const proofs = [];
  for (let i = 0; i < 7; i++) {
    const file = "costume-" + i + ".png";
    await fs.writeFile(path.join(dir, id, file), "image");
    proofs.push({
      rewardId: "reward-" + i,
      file,
      sha256: digest(Buffer.from("image")),
      hero: "Hero " + i,
      costume: i === 6 ? "IGNITE event costume" : "Will of Galacta",
    });
  }
  await db
    .collection("rivalspreparations")
    .updateOne(
      { _id: id },
      {
        $set: {
          expectedRewards: proofs.map((p) => ({ id: p.rewardId })),
          reservedCount: 7,
          "gameReport.proofs": proofs,
        },
      },
    );
  for (let i = 0; i < 6; i++)
    await db
      .collection("droplogs")
      .insertOne({
        account: prep.twitchId,
        soldSetId: "test-hold",
        soldToUsername: "manual",
        soldAt: new Date(),
      });
  await service.publish(id);
  assert.equal(offers.values().next().value.offerImages.length, 4);
  assert.equal(
    (await db.collection("rivalspreparations").findOne({ _id: id })).gameReport
      .proofs.length,
    7,
  );
});
test("another account using the same inbox cannot have its buyer session replaced", async () => {
  const { id } = await seed();
  await db
    .collection("buyermailsessions")
    .insertOne({
      steamAccountId: new mongoose.Types.ObjectId(),
      inboxAddress: "inbox@example.test",
      revokedAt: null,
    });
  await assert.rejects(
    service.publish(id),
    /another active buyer mail session/,
  );
  assert.equal(createCount, 0);
});
