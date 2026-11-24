process.env.SESSION_SECRET = "skin-service-test-session";
process.env.CRED_SECRET = "skin-service-test-encryption";
process.env.PUBLIC_BASE_URL = "https://skin.example.test";
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const express = require("express");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { encrypt } = require("../utils/secretBox");
const Skin = require("../models/SkinAccount");
const Epic = require("../models/EpicAccount");
const Bot = require("../models/BotAccount");
const Pool = require("../models/AvailableAccount");
const Drop = require("../models/DropLog");
const Listing = require("../models/EpicListing");
const Session = require("../models/BuyerMailSession");
const farm = require("../utils/skinAccountFarm");
const inventory = require("../utils/twitchInventory");
const hosts = require("../utils/botHosts");
const eld = require("../utils/eldoradoAccountOffers");
const sales = require("../utils/epicSales");
const service = require("../utils/skinAccounts");
const outlook = require("../utils/outlookGraphReader");
const link = require("../utils/skinAccountLink");

const copy = (value) => structuredClone(value);
let memory,
  server,
  base,
  sequence = 0;
let ownershipError = "",
  unreadableHomes = false,
  scanError = null,
  scanOverride = null,
  linkError = null,
  farmError = "";
const calls = [];
const remotes = new Map();
const inventoryByToken = new Map();
const profile = {
  region: "JP",
  level: 9,
  rank: "Unranked",
  credits: 0,
  platform: "PC",
};

farm.validateOwnership = async (skin, options) => {
  calls.push({ event: "ownership", skinId: String(skin._id), options });
  return ownershipError
    ? { ok: false, reason: ownershipError, unreadableHomes }
    : { ok: true, homes: [] };
};
farm.reconcileFarm = async (skin) => {
  calls.push({ event: "farm", skinId: String(skin._id) });
  if (farmError) {
    await Skin.updateOne(
      { _id: skin._id },
      { $set: { "farm.status": "attention", "farm.lastError": farmError } },
    );
    return { ok: false, status: "attention", reason: farmError };
  }
  const status = skin.farm.enabled && skin.farm.allowed ? "farming" : "stopped";
  await Skin.updateOne(
    { _id: skin._id },
    { $set: { "farm.status": status, "farm.lastCheckedAt": new Date() } },
  );
  return { ok: true, status };
};
farm.stopFarm = async (skin, reason) => {
  calls.push({ event: "stop", skinId: String(skin._id), reason });
  await Skin.updateOne(
    { _id: skin._id },
    { $set: { "farm.status": "stopped", "farm.lastCheckedAt": new Date() } },
  );
  return { ok: true, stopped: true, status: "stopped" };
};
hosts.resolveHost = (hostId) => ({
  id: hostId,
  transport: hostId === "local" ? "local" : "ssh",
});
inventory.fetchInventory = async (token, { host }) => {
  assert.equal(
    typeof host,
    "object",
    "Twitch transport requires a resolved host object",
  );
  calls.push({ event: "scan", host: host.id });
  if (scanError) throw scanError;
  return copy(scanOverride || inventoryByToken.get(token));
};
outlook.checkInbox = async () => ({
  status: "live",
  sharedWith: [],
  sellable: true,
});
link.verify = async (skin, account) => {
  calls.push({ event: "link-check", skinId: String(skin._id) });
  if (linkError) throw linkError;
  return {
    checkedAt: new Date(),
    epicAccountId: account.accountId,
    twitchId: skin.twitchId,
  };
};
eld.getAccountOffer = async (offerId) => {
  calls.push({ event: "read-offer", offerId });
  assert.ok(remotes.has(offerId), "Tests never contact a real offer");
  return copy(remotes.get(offerId).offer);
};
eld.getAccountEntries = async (offerId) => copy(remotes.get(offerId).entries);
eld.pauseAccountOffer = async (offerId) => {
  calls.push({ event: "pause", offerId });
  remotes.get(offerId).offer.offerState = "Paused";
};
eld.resumeAccountOffer = async (offerId) => {
  calls.push({ event: "resume", offerId });
  remotes.get(offerId).offer.offerState = "Active";
};
eld.changeAccountOfferPrice = async (offerId, price) => {
  calls.push({ event: "price", offerId, price });
  remotes.get(offerId).offer.pricePerUnit.amount = price;
};
eld.updateAccountOffer = async (offerId, input) => {
  calls.push({ event: "edit", offerId, input: copy(input) });
  const remote = remotes.get(offerId);
  assert.equal(
    remote.offer.offerState,
    "Paused",
    "Public-content edits pause the offer before sending stock",
  );
  assert.deepEqual(
    input.entries.map((entry) => entry.id),
    remote.entries.map((entry) => entry.id),
  );
  remote.offer.offerTitle = input.title;
  remote.offer.description = input.description;
  remote.offer.pricePerUnit.amount = input.priceUsd;
  remote.entries = copy(input.entries);
};
eld.createAccountOffer = async () => {
  throw new Error("Unexpected live publish path in service integration tests");
};

async function pair({ adopting = false, connected = false } = {}) {
  const n = ++sequence;
  const email = `skin-${n}@example.invalid`;
  const epicPassword = `fixture-epic-password-${n}`;
  const twitchPassword = `fixture-twitch-password-${n}`;
  const epic = await Epic.create({
    accountId: `external-epic-${n}`,
    displayName: `TestPlayer${n}`,
    email: encrypt(email),
    password: encrypt(epicPassword),
    accountDetails: encrypt(JSON.stringify({ country: "JP" })),
    library: [{ title: "Rocket League" }],
  });
  const holdTag = adopting
    ? `owner:rl-epic-link-test:TestPlayer${n}:2026-11-14`
    : "";
  const stamp = adopting
    ? {
        soldAt: new Date(),
        soldToUsername: holdTag,
        soldSetId: "previous-test-hold",
      }
    : {};
  const bot = await Bot.create({
    login: `skintest${n}`,
    twitchId: String(100000 + n),
    clientSecret: `fixture-token-${n}`,
    hasPassword: true,
    credPassword: encrypt(twitchPassword),
    lastScanStatus: "ok",
    ...stamp,
  });
  const pool = await Pool.create({
    username: bot.login,
    usernameLower: bot.login,
    clientSecret: bot.clientSecret,
    twitchId: bot.twitchId,
    status: adopting ? "claimed" : "available",
    manualSold: adopting,
    claimedNote: holdTag,
    hasPassword: true,
    password: encrypt(twitchPassword),
  });
  const drops = await Drop.create([
    {
      account: bot._id,
      login: bot.login,
      benefitId: "sport",
      name: "Sport Drop",
      itemKey: "sport drop|rocket league",
      game: "Rocket League",
      gameId: "30921",
      count: 2,
      connected,
      ...stamp,
    },
    {
      account: bot._id,
      login: bot.login,
      benefitId: "other-game",
      name: "Other reward",
      itemKey: "other reward|other",
      game: "Other",
      count: 1,
      connected: false,
      ...stamp,
    },
  ]);
  const snapshot = {
    twitchId: bot.twitchId,
    login: bot.login,
    inProgress: [],
    drops: [
      {
        benefitId: "sport",
        name: "Sport Drop",
        game: "Rocket League",
        gameId: "30921",
        count: 2,
        connected: true,
        source: "gameEventDrop",
      },
    ],
  };
  inventoryByToken.set(bot.clientSecret, snapshot);
  return {
    epic,
    bot,
    pool,
    drops,
    holdTag,
    email,
    epicPassword,
    twitchPassword,
    snapshot,
  };
}

async function listedPair(options = {}) {
  const p = await pair({ adopting: true, connected: true, ...options });
  const offerId = `fixture-offer-${sequence}`;
  const entry = {
    id: `fixture-entry-${sequence}`,
    accountLogin: p.email,
    accountPassword: p.epicPassword,
    emailProviderUrl: sales.providerUrl(),
    emailLogin: p.email,
    emailPassword: `fixture-mail-password-${sequence}`,
    additionalInfo: `Linked Twitch login: ${p.bot.login}\nTwitch password: ${p.twitchPassword}`,
  };
  const listing = await Listing.create({
    section: "rocket-league",
    status: "active",
    externalId: offerId,
    url: `https://www.eldorado.gg/rocket-league-accounts-for-sale/oa/${offerId}`,
    priceUsd: 4.99,
    title: "Original inventory title",
    description: "Original inventory description",
    region: "JP",
    mainOfferImage: {
      largeImage: "fixture-large",
      originalSizeImage: "fixture-original",
      smallImage: "fixture-small",
    },
    accounts: [
      {
        epicAccountId: p.epic._id,
        entryId: entry.id,
        login: p.email,
        state: "listed",
      },
    ],
  });
  const session = await Session.create({
    epicAccountId: p.epic._id,
    listingId: listing._id,
    inboxAddress: p.email,
    passwordHash: "fixture-unused-hash",
    passwordEnc: encrypt(entry.emailPassword),
    stage: "listed",
    expiresAt: new Date(Date.now() + 86400000),
  });
  listing.accounts[0].sessionId = session._id;
  await listing.save();
  const offer = {
    id: offerId,
    offerState: "Active",
    quantity: 1,
    offerTitle: listing.title,
    description: listing.description,
    pricePerUnit: { amount: 4.99, currency: "USD" },
    hasOriginalEmail: false,
    mainOfferImage: listing.mainOfferImage.toObject(),
    offerImages: [],
    attributes: [
      { id: "rocket-league-level-numeric", type: "Numeric", value: 9 },
    ],
  };
  remotes.set(offerId, { offer, entries: [entry] });
  return { ...p, listing, session, offerId, entry };
}

async function verifiedAdoption() {
  const p = await listedPair();
  const adopted = await service.adopt({
    listingId: String(p.listing._id),
    twitchLogin: p.bot.login,
  });
  await service.verifyLink(adopted.id, {
    confirm: true,
    epicAccountId: p.epic.accountId,
    twitchId: p.bot.twitchId,
    evidence: "Exact Epic Connections IDs inspected in the account settings.",
  });
  await service.confirmInventory(adopted.id, {
    confirm: true,
    items: [{ name: "Sport Drop", count: 2, kind: "reward" }],
    profile,
    evidence: "The full inventory was inspected after playing and restarting.",
  });
  return { ...p, skinId: adopted.id };
}

async function verifiedEnrollment() {
  const p = await pair();
  const row = await service.enroll({
    epicAccountId: String(p.epic._id),
    twitchLogin: p.bot.login,
  });
  await service.verifyLink(row.id, {
    confirm: true,
    epicAccountId: p.epic.accountId,
    twitchId: p.bot.twitchId,
    evidence: "Exact Epic and Twitch numeric IDs verified in Connections.",
  });
  await service.confirmInventory(row.id, {
    confirm: true,
    items: [{ name: "Sport Drop", count: 2, kind: "reward" }],
    profile,
    evidence: "Full inventory observed after restart and entering the game.",
  });
  return { ...p, skinId: row.id };
}

test.before(async () => {
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  await Promise.all([
    Skin.init(),
    Epic.init(),
    Bot.init(),
    Pool.init(),
    Drop.init(),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.get("x-test-role"))
      req.session = {
        admin: { _id: "fixture-admin", role: req.get("x-test-role") },
      };
    next();
  });
  app.use("/api/skin-accounts", require("../routes/skinAccountRoutes"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections))
    await collection.deleteMany({});
  calls.length = 0;
  remotes.clear();
  inventoryByToken.clear();
  ownershipError = "";
  unreadableHomes = false;
  scanError = null;
  scanOverride = null;
  linkError = null;
  farmError = "";
});
test.after(async () => {
  service.stop();
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (memory) await memory.stop();
});

test("adopts only one exact unsold Epic+Twitch unit and preserves private delivery and owner hold", async () => {
  const p = await listedPair();
  const before = copy(remotes.get(p.offerId));
  const response = await service.adopt({
    listingId: String(p.listing._id),
    twitchLogin: p.bot.login,
  });
  const skin = await Skin.findById(response.id).lean();
  assert.equal(skin.state, "listed");
  assert.equal(skin.holdTag, p.holdTag);
  assert.equal(skin.link.status, "pending");
  assert.equal(skin.farm.enabled, false);
  assert.equal(
    (await Listing.findById(p.listing._id)).managedBy,
    "skin-account",
  );
  assert.deepEqual(remotes.get(p.offerId), before);
  assert.equal(
    await Session.countDocuments(),
    1,
    "Adoption preserves the existing buyer-mail session",
  );
  assert.equal(
    await Drop.countDocuments({
      account: p.bot._id,
      soldToUsername: p.holdTag,
    }),
    2,
  );
  const serialized = JSON.stringify(response);
  for (const secret of [
    p.email,
    p.epicPassword,
    p.twitchPassword,
    p.entry.emailPassword,
    p.bot.clientSecret,
  ]) {
    assert.equal(
      serialized.includes(secret),
      false,
      "Public response must contain no delivery secrets",
    );
  }
});

test("wrong remote Epic identity or linked Twitch password is rejected before a lifetime fence exists", async () => {
  for (const change of [
    (p) => {
      remotes.get(p.offerId).entries[0].accountLogin =
        "someone-else@example.invalid";
    },
    (p) => {
      remotes.get(p.offerId).entries[0].additionalInfo =
        `Linked Twitch login: ${p.bot.login}\nTwitch password: different`;
    },
    (p) => {
      remotes.get(p.offerId).offer.quantity = 0;
    },
  ]) {
    const p = await listedPair();
    change(p);
    await assert.rejects(
      service.adopt({
        listingId: String(p.listing._id),
        twitchLogin: p.bot.login,
      }),
    );
    assert.equal(await Skin.countDocuments({ epicAccountId: p.epic._id }), 0);
    assert.equal((await Listing.findById(p.listing._id)).managedBy, "");
  }
});

test("adoption rejects changed mail credentials or revoked delivery before reserving either account", async () => {
  for (const change of [
    async (p) => {
      remotes.get(p.offerId).entries[0].emailLogin =
        "someone-else@example.invalid";
    },
    async (p) => {
      remotes.get(p.offerId).entries[0].emailPassword =
        "different-mail-password";
    },
    async (p) => {
      remotes.get(p.offerId).entries[0].emailProviderUrl =
        "https://other.example.test/mail/";
    },
    async (p) => {
      await Session.updateOne(
        { _id: p.session._id },
        { $set: { revokedAt: new Date() } },
      );
    },
  ]) {
    const p = await listedPair();
    await change(p);
    await assert.rejects(
      service.adopt({
        listingId: String(p.listing._id),
        twitchLogin: p.bot.login,
      }),
      /mail delivery identity changed/,
    );
    assert.equal(await Skin.countDocuments({ epicAccountId: p.epic._id }), 0);
    assert.equal((await Listing.findById(p.listing._id)).managedBy, "");
    assert.equal((await Bot.findById(p.bot._id)).soldToUsername, p.holdTag);
  }
});

test("changed private mail delivery after adoption stops farming and is never republished", async () => {
  const p = await verifiedAdoption();
  remotes.get(p.offerId).entries[0].emailPassword = "different-mail-password";
  calls.length = 0;
  await assert.rejects(
    service.refresh(p.skinId),
    /mail delivery identity changed/,
  );
  const skin = await Skin.findById(p.skinId).lean();
  assert.equal(skin.ownershipStatus, "quarantined");
  assert.equal(skin.farm.allowed, false);
  assert.ok(calls.some((call) => call.event === "stop"));
  assert.equal(
    calls.some((call) => ["edit", "resume", "farm"].includes(call.event)),
    false,
  );
});

test("adoption rejects cross-linked mail sessions even when the listed password matches", async () => {
  for (const fields of [
    { kind: "steam" },
    { epicAccountId: new mongoose.Types.ObjectId() },
    { inboxAddress: "another-account@example.invalid" },
  ]) {
    const p = await listedPair();
    await Session.updateOne({ _id: p.session._id }, { $set: fields });
    calls.length = 0;
    await assert.rejects(
      service.adopt({
        listingId: String(p.listing._id),
        twitchLogin: p.bot.login,
      }),
      /mail delivery identity changed/,
    );
    assert.equal(await Skin.countDocuments({ epicAccountId: p.epic._id }), 0);
    assert.equal((await Listing.findById(p.listing._id)).managedBy, "");
    assert.equal((await Bot.findById(p.bot._id)).soldToUsername, p.holdTag);
    assert.equal(
      calls.some((call) => call.event === "pause"),
      false,
    );
  }
});

test("new enrollment reserves all games and lifetime identities without pretending the link is verified", async () => {
  const p = await pair();
  const response = await service.enroll({
    epicAccountId: String(p.epic._id),
    twitchLogin: p.bot.login,
  });
  const skin = await Skin.findById(response.id).lean();
  assert.equal(skin.state, "preparing");
  assert.equal(skin.link.status, "pending");
  assert.equal((await Bot.findById(p.bot._id)).soldToUsername, skin.holdTag);
  const pool = await Pool.findById(p.pool._id);
  assert.equal(pool.manualSold, true);
  assert.equal(pool.status, "claimed");
  assert.equal(pool.claimedNote, skin.holdTag);
  assert.equal(
    await Drop.countDocuments({
      account: p.bot._id,
      soldToUsername: skin.holdTag,
    }),
    2,
  );
  const ctx = await sales.stockContext({ accountIds: [p.epic._id] });
  assert.equal(sales.readinessOf(ctx.accounts[0], ctx).state, "listed");
  await Skin.updateOne(
    { _id: skin._id },
    { $set: { state: "sold", ownershipStatus: "sold", soldAt: new Date() } },
  );
  await assert.rejects(
    service.enroll({
      epicAccountId: String(p.epic._id),
      twitchLogin: p.bot.login,
    }),
    /already enrolled/,
  );
});

test("a partial reservation failure leaves a quarantined lifetime fence and never releases consumed stock", async () => {
  const p = await pair();
  const original = Pool.updateOne;
  Pool.updateOne = (...args) => {
    if (args[1]?.$set?.claimedNote?.startsWith("skin-account:"))
      return Promise.resolve({ matchedCount: 0 });
    return original.apply(Pool, args);
  };
  try {
    await assert.rejects(
      service.enroll({
        epicAccountId: String(p.epic._id),
        twitchLogin: p.bot.login,
      }),
      /pool ownership changed/,
    );
  } finally {
    Pool.updateOne = original;
  }
  const skin = await Skin.findOne({ epicAccountId: p.epic._id }).lean();
  assert.ok(skin);
  assert.equal(skin.ownershipStatus, "quarantined");
  assert.equal(skin.state, "attention");
  assert.equal((await Bot.findById(p.bot._id)).soldToUsername, skin.holdTag);
  assert.ok(calls.some((call) => call.event === "stop"));
  const ctx = await sales.stockContext({ accountIds: [p.epic._id] });
  assert.equal(sales.readinessOf(ctx.accounts[0], ctx).state, "listed");
});

test("physical ownership preflight blocks enrollment before any reservation write", async () => {
  const p = await pair();
  ownershipError = "This Twitch identity is assigned to a renter";
  await assert.rejects(
    service.enroll({
      epicAccountId: String(p.epic._id),
      twitchLogin: p.bot.login,
    }),
    /renter/,
  );
  assert.equal(await Skin.countDocuments(), 0);
  assert.equal((await Bot.findById(p.bot._id)).soldAt, null);
  assert.equal((await Pool.findById(p.pool._id)).manualSold, false);
});

test("link verification requires the exact external IDs and inventory confirmation anchors both reward baselines", async () => {
  const p = await pair();
  const row = await service.enroll({
    epicAccountId: String(p.epic._id),
    twitchLogin: p.bot.login,
  });
  await assert.rejects(
    service.verifyLink(row.id, {
      confirm: true,
      epicAccountId: "wrong",
      twitchId: p.bot.twitchId,
      evidence: "Account links checked",
    }),
    /exact external/,
  );
  await service.verifyLink(row.id, {
    confirm: true,
    epicAccountId: p.epic.accountId,
    twitchId: p.bot.twitchId,
    evidence: "Exact identities verified in Epic Connections",
  });
  let skin = await Skin.findById(row.id).lean();
  assert.equal(skin.link.status, "verified");
  assert.ok(skin.inventory.baselineAt);
  assert.equal(skin.inventory.pending.length, 0);
  await service.confirmInventory(row.id, {
    confirm: true,
    items: [{ name: "Sport Drop", kind: "reward", count: 2 }],
    profile,
    evidence: "Full game inventory checked after restart",
  });
  skin = await Skin.findById(row.id).lean();
  assert.equal(skin.state, "ready");
  assert.ok(skin.inventory.verifiedAt);
  assert.ok(skin.pricing.growthBaselineAt);
  assert.deepEqual(skin.pricing.growthBaseline, skin.inventory.highWater);
});

test("fresh claims become pending, public content and price update, and exact delivery survives", async () => {
  const p = await verifiedAdoption();
  await Skin.updateOne({ _id: p.skinId }, { $set: { "farm.enabled": true } });
  inventoryByToken.get(p.bot.clientSecret).drops[0].count = 3;
  const row = await service.refresh(p.skinId);
  assert.equal(row.inventory.pending.length, 1);
  assert.equal(row.inventory.pending[0].count, 1);
  assert.equal(
    row.inventory.verified[0].count,
    2,
    "Claiming does not falsely verify an in-game receipt",
  );
  assert.equal(row.listing.priceUsd, 5.09);
  assert.equal(row.farm.status, "farming");
  const remote = remotes.get(p.offerId);
  assert.equal(remote.offer.offerState, "Active");
  assert.match(remote.offer.description, /AWAITING GAME CHECK/);
  assert.deepEqual(remote.entries, [p.entry]);
  assert.equal(remote.offer.pricePerUnit.amount, 5.09);
  assert.ok(calls.some((call) => call.event === "edit"));
});

test("product scans atomically reserve new rewards and refresh real farm progress without sale signals", async () => {
  const p = await verifiedAdoption();
  const snapshot = inventoryByToken.get(p.bot.clientSecret);
  snapshot.drops.push({
    benefitId: "fresh-reward",
    name: "Fresh Reward",
    game: "Rocket League",
    gameId: "30921",
    count: 1,
    connected: true,
    source: "gameEventDrop",
  });
  const current = {
    name: "Next Sport Drop",
    game: "Rocket League",
    campaign: "Live Campaign",
    required: 60,
    current: 30,
    percent: 50,
    connected: true,
  };
  snapshot.inProgress = [
    current,
    { ...current, name: "Expired", campaignStatus: "EXPIRED" },
    { ...current, name: "Claimed", claimed: true },
    { ...current, name: "Finished", current: 60, percent: 100 },
  ];
  await Drop.updateOne(
    { account: p.bot._id, benefitId: "sport" },
    { $set: { connected: false } },
  );
  await Bot.updateOne(
    { _id: p.bot._id },
    { $set: { farmingCompleteAt: new Date(), lastScanStatus: "error" } },
  );
  const originalUpdate = Drop.updateOne;
  let heldInsertObserved = false;
  Drop.updateOne = function (filter, update, options) {
    if (filter.benefitId === "fresh-reward") {
      assert.equal(options.upsert, true);
      assert.equal(update.$setOnInsert.soldToUsername, p.holdTag);
      assert.equal(update.$setOnInsert.soldSetId, `skin-account:${p.skinId}`);
      assert.ok(update.$setOnInsert.soldAt instanceof Date);
      heldInsertObserved = true;
    }
    return originalUpdate.call(this, filter, update, options);
  };
  const before = Date.now();
  try {
    await service.refresh(p.skinId);
  } finally {
    Drop.updateOne = originalUpdate;
  }
  assert.equal(heldInsertObserved, true);
  const fresh = await Drop.findOne({
    account: p.bot._id,
    benefitId: "fresh-reward",
  }).lean();
  assert.equal(fresh.soldToUsername, p.holdTag);
  assert.equal(fresh.soldSetId, `skin-account:${p.skinId}`);
  assert.ok(fresh.soldAt);
  const bot = await Bot.findById(p.bot._id).lean();
  assert.equal(bot.lastScanStatus, "ok");
  assert.ok(+bot.lastScanAt >= before);
  assert.ok(+bot.farmingSnapshotAt >= before);
  assert.equal(bot.dropCount, 3);
  assert.equal(bot.inProgressCount, 1);
  assert.deepEqual(bot.inProgressGames, ["Rocket League"]);
  assert.equal(bot.farmingCompleteAt, null);
  assert.equal(bot.farmingProgress.length, 1);
  assert.equal(bot.farmingProgress[0].name, current.name);
  assert.equal(bot.farmingProgress[0].percent, 50);
  assert.equal(
    await require("../models/SaleSignal").countDocuments({
      account: p.bot._id,
      source: "connected",
    }),
    0,
  );
});

test("a recorded listing sale permanently stops the paired farm before any edit or resume", async () => {
  const p = await verifiedAdoption();
  await Listing.updateOne(
    { _id: p.listing._id },
    { $set: { "accounts.0.state": "sold", "accounts.0.soldAt": new Date() } },
  );
  calls.length = 0;
  const row = await service.refresh(p.skinId);
  assert.equal(row.state, "sold");
  assert.equal(row.ownershipStatus, "sold");
  assert.equal(row.farm.allowed, false);
  assert.ok(calls.some((call) => call.event === "stop"));
  assert.equal(
    calls.some((call) =>
      ["scan", "link-check", "edit", "resume", "farm"].includes(call.event),
    ),
    false,
  );
});

test("an Epic sale whose callback was interrupted is recovered as sold before any live account read", async () => {
  const p = await verifiedAdoption();
  await Epic.updateOne({ _id: p.epic._id }, { $set: { sold: true } });
  calls.length = 0;
  const row = await service.refresh(p.skinId);
  assert.equal(row.state, "sold");
  assert.equal(row.ownershipStatus, "sold");
  assert.ok(calls.some((call) => call.event === "stop"));
  assert.equal(
    calls.some((call) =>
      ["scan", "link-check", "edit", "resume", "farm"].includes(call.event),
    ),
    false,
  );
});

test("changed Epic-to-Twitch link blocks farming and retains the pair in quarantine", async () => {
  const p = await verifiedAdoption();
  linkError = Object.assign(
    new Error(
      "Epic’s connected Twitch identity is different or disconnected; verify the account link",
    ),
    { user: true, status: 409 },
  );
  calls.length = 0;
  await assert.rejects(service.refresh(p.skinId), /different or disconnected/);
  const skin = await Skin.findById(p.skinId).lean();
  assert.equal(skin.ownershipStatus, "quarantined");
  assert.equal(skin.farm.allowed, false);
  assert.ok(calls.some((call) => call.event === "stop"));
  assert.equal(
    calls.some((call) =>
      ["scan", "edit", "resume", "farm"].includes(call.event),
    ),
    false,
  );
});

test("missing remote stock stops and quarantines the product without recreating a stock entry", async () => {
  const p = await verifiedAdoption();
  remotes.get(p.offerId).entries = [];
  remotes.get(p.offerId).offer.quantity = 0;
  calls.length = 0;
  await assert.rejects(service.refresh(p.skinId), /no longer proven unsold/);
  const skin = await Skin.findById(p.skinId).lean();
  assert.equal(skin.ownershipStatus, "quarantined");
  assert.equal(skin.farm.allowed, false);
  assert.ok(calls.some((call) => call.event === "stop"));
  assert.equal(
    calls.some((call) => ["edit", "resume", "farm"].includes(call.event)),
    false,
  );
});

test("wrong Twitch scan identity never confirms a link and refresh stops farming on inventory failure", async () => {
  const p = await verifiedAdoption();
  scanOverride = { ...p.snapshot, twitchId: "wrong" };
  await assert.rejects(service.refresh(p.skinId), /different identity/);
  const skin = await Skin.findById(p.skinId).lean();
  assert.equal(skin.farm.allowed, false);
  assert.equal(skin.ownershipStatus, "quarantined");
  assert.equal(skin.twitchId, p.bot.twitchId);
});

async function interruptFarmRead(p) {
  ownershipError =
    "Cannot verify ownership while a farm location is unreadable";
  unreadableHomes = true;
  return service._internals.refreshUnlocked(p.skinId);
}

test("scheduled checks pause through an outage and resume the same unsold offer once", async () => {
  const p = await verifiedAdoption();
  const remote = remotes.get(p.offerId);
  await Skin.updateOne({ _id: p.skinId }, { $set: { "farm.enabled": true } });
  const before = copy(remote.entries);
  const held = await interruptFarmRead(p);
  assert.equal(held.ownershipStatus, "quarantined");
  assert.equal(held.farm.allowed, false);
  assert.equal(remote.offer.offerState, "Paused");
  calls.length = 0;
  await service.tick();
  assert.ok(!calls.some((c) => ["resume", "farm"].includes(c.event)));
  ownershipError = "";
  farmError = "Farm reload pending";
  await service.tick();
  assert.equal(remote.offer.offerState, "Paused");
  await assert.rejects(service.resume(p.skinId), /outstanding account check/);
  farmError = "";
  await service.tick();
  await service.tick();
  const s = await Skin.findById(p.skinId).lean();
  assert.equal(s.state, "listed");
  assert.equal(s.ownershipStatus, "owned");
  assert.equal(s.farm.status, "farming");
  assert.equal(s.farmReadRecovery, "");
  assert.equal(calls.filter((c) => c.event === "resume").length, 1);
  assert.deepEqual(remote.entries, before);
  assert.equal(remote.offer.offerState, "Active");
});

test("pre-existing and operator pauses survive recovery", async () => {
  for (const alreadyPaused of [true, false]) {
    const p = await verifiedAdoption();
    if (alreadyPaused) await service.pause(p.skinId);
    await interruptFarmRead(p);
    if (!alreadyPaused) await service.pause(p.skinId);
    ownershipError = "";
    calls.length = 0;
    const row = await service._internals.refreshUnlocked(p.skinId);
    assert.equal(row.state, "paused");
    assert.equal(remotes.get(p.offerId).offer.offerState, "Paused");
    assert.ok(!calls.some((c) => c.event === "resume"));
  }
});

test("a sale, missing stock, changed delivery or confirmed conflict cancels outage recovery", async () => {
  for (const kind of ["sold", "stock", "delivery", "renter"]) {
    const p = await verifiedAdoption();
    await interruptFarmRead(p);
    ownershipError = "";
    unreadableHomes = false;
    if (kind === "sold")
      await Epic.updateOne({ _id: p.epic._id }, { $set: { sold: true } });
    if (kind === "stock") remotes.get(p.offerId).entries = [];
    if (kind === "delivery")
      remotes.get(p.offerId).entries[0].emailPassword = "changed";
    if (kind === "renter")
      ownershipError = "This Twitch identity is assigned to a renter";
    calls.length = 0;
    const row = await service._internals.refreshUnlocked(p.skinId);
    assert.equal(row.ownershipStatus, kind === "sold" ? "sold" : "quarantined");
    assert.equal((await Skin.findById(p.skinId)).farmReadRecovery, "");
    ownershipError = "";
    await service._internals.refreshUnlocked(p.skinId);
    assert.ok(!calls.some((c) => ["resume", "farm"].includes(c.event)));
  }
});

test("a failed marketplace pause is retried before ownership recovery", async () => {
  const p = await verifiedAdoption();
  const pause = eld.pauseAccountOffer;
  try {
    eld.pauseAccountOffer = async () => {
      throw new Error("Temporary marketplace outage");
    };
    await assert.rejects(interruptFarmRead(p), /Temporary marketplace outage/);
    assert.equal(
      (await Skin.findById(p.skinId)).pendingPauseOfferId,
      p.offerId,
    );
  } finally {
    eld.pauseAccountOffer = pause;
  }
  await service.tick();
  assert.equal(remotes.get(p.offerId).offer.offerState, "Paused");
  assert.equal((await Skin.findById(p.skinId)).pendingPauseOfferId, "");
});

test("failed farm reconciliation is surfaced as product attention and clears its farming exemption", async () => {
  const p = await verifiedAdoption();
  farmError = "The previous farm has not reloaded";
  const row = await service.refresh(p.skinId);
  assert.equal(row.state, "attention");
  assert.equal(row.farm.allowed, false);
  assert.equal(row.lastError, farmError);
});

test("a manual price applies through the stock-free price endpoint after content has been verified", async () => {
  const p = await verifiedAdoption();
  await service.refresh(p.skinId);
  await service.setPricing(p.skinId, {
    mode: "manual",
    floorUsd: 4.99,
    ceilingUsd: 10,
    basePriceUsd: 6.25,
  });
  calls.length = 0;
  const row = await service.refresh(p.skinId);
  assert.equal(row.listing.priceUsd, 6.25);
  assert.equal(calls.filter((call) => call.event === "price").length, 1);
  assert.equal(
    calls.some((call) => call.event === "edit"),
    false,
  );
  assert.deepEqual(remotes.get(p.offerId).entries, [p.entry]);
});

test("unlisted pricing is persisted into the eventual publish preview", async () => {
  const p = await verifiedEnrollment();
  await service.setPricing(p.skinId, {
    mode: "manual",
    floorUsd: 4.99,
    ceilingUsd: 10,
    basePriceUsd: 7.5,
  });
  const row = await service.refresh(p.skinId);
  assert.equal(row.listing.priceUsd, 7.5);
  assert.equal((await service.preview(p.skinId)).priceUsd, 7.5);
});

test("a non-USD remote price cannot silently become the product's USD price", async () => {
  const p = await verifiedAdoption();
  remotes.get(p.offerId).offer.pricePerUnit = { amount: 800, currency: "JPY" };
  await assert.rejects(service.refresh(p.skinId));
  const row = await Skin.findById(p.skinId).lean();
  assert.equal(row.listingPriceUsd, 4.99);
  assert.equal(row.farm.allowed, false);
  assert.equal(
    calls.some((call) => call.event === "edit"),
    false,
  );
});

async function fakePublish(fn, { uncertain = false } = {}) {
  const axios = require("axios");
  const saved = {
    get: axios.get,
    upload: eld.uploadImage,
    create: eld.createAccountOffer,
    permission: sales._internals.eldoradoPermission,
    config: sales.getConfig,
  };
  let creates = 0;
  axios.get = async () => ({
    headers: { "content-type": "image/png" },
    data: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6p0sAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  eld.uploadImage = async () => ({
    smallImage: "fixture-small",
    largeImage: "fixture-large",
    originalSizeImage: "fixture-full",
  });
  sales._internals.eldoradoPermission = async () => ({ canSell: true });
  sales.getConfig = async () => ({ sessionDays: 14 });
  eld.createAccountOffer = async (input) => {
    creates++;
    const offerId = require("node:crypto").randomUUID();
    sequence++;
    remotes.set(offerId, {
      offer: {
        id: offerId,
        gameId: "1",
        category: "Account",
        offerState: "Active",
        quantity: 1,
        offerTitle: input.title,
        description: input.description,
        pricePerUnit: { amount: input.priceUsd, currency: "USD" },
        mainOfferImage: input.mainOfferImage,
        offerImages: [],
        hasOriginalEmail: false,
      },
      entries: input.entries.map((entry) => ({
        ...entry,
        id: `new-fixture-entry-${sequence}`,
      })),
    });
    if (uncertain) throw new Error("Network response lost after create");
    return { id: offerId };
  };
  try {
    return await fn(() => creates);
  } finally {
    axios.get = saved.get;
    eld.uploadImage = saved.upload;
    eld.createAccountOffer = saved.create;
    sales._internals.eldoradoPermission = saved.permission;
    sales.getConfig = saved.config;
  }
}

test("fresh publish completes one verified offer, one mail session and complete linked Twitch delivery", async () => {
  const p = await verifiedEnrollment();
  await service.setPricing(p.skinId, {
    mode: "manual",
    floorUsd: 4.99,
    ceilingUsd: 10,
    basePriceUsd: 7.5,
  });
  await fakePublish(async (creates) => {
    const row = await service.publish(p.skinId, {
      confirm: true,
      coverUrl: "https://images.example.test/observed-inventory.png",
    });
    assert.equal(row.state, "listed");
    assert.equal(row.listing.priceUsd, 7.5);
    assert.equal(creates(), 1);
    const skin = await Skin.findById(p.skinId).lean();
    assert.equal(skin.mutation?.kind, undefined);
    assert.ok(skin.listingId);
    assert.ok(skin.remoteOfferId);
    assert.equal(
      await Session.countDocuments({ epicAccountId: p.epic._id }),
      1,
    );
    const listing = await Listing.findById(skin.listingId).lean();
    assert.ok(listing.accounts[0].entryId);
    assert.equal(listing.managedBy, "skin-account");
    const entry = remotes.get(skin.remoteOfferId).entries[0];
    assert.equal(entry.accountLogin, p.email);
    assert.equal(entry.accountPassword, p.epicPassword);
    assert.ok(entry.additionalInfo.includes(p.bot.login));
    assert.ok(entry.additionalInfo.includes(p.twitchPassword));
    assert.ok(entry.emailPassword);
    assert.ok(entry.emailProviderUrl.startsWith("https://skin.example.test/"));
    await assert.rejects(
      service.publish(p.skinId, {
        confirm: true,
        coverUrl: "https://images.example.test/observed-inventory.png",
      }),
      /already has a listing/,
    );
    assert.equal(creates(), 1);
  });
});

test("an uncertain create retains its durable intent and can never be automatically published twice", async () => {
  const p = await verifiedEnrollment();
  await fakePublish(
    async (creates) => {
      await assert.rejects(
        service.publish(p.skinId, {
          confirm: true,
          coverUrl: "https://images.example.test/observed-inventory.png",
        }),
        /response lost/,
      );
      const skin = await Skin.findById(p.skinId).lean();
      assert.equal(skin.mutation.kind, "create");
      assert.equal(skin.state, "attention");
      assert.equal(skin.farm.allowed, false);
      await assert.rejects(
        service.publish(p.skinId, {
          confirm: true,
          coverUrl: "https://images.example.test/observed-inventory.png",
        }),
        /already has a listing|unresolved/,
      );
      assert.equal(creates(), 1);
      assert.equal(await Skin.countDocuments({ epicAccountId: p.epic._id }), 1);
    },
    { uncertain: true },
  );
});

test("explicit recovery attaches the exact ambiguous offer paused, then resumes without adding stock", async () => {
  const p = await verifiedEnrollment();
  await fakePublish(
    async (creates) => {
      await assert.rejects(
        service.publish(p.skinId, {
          confirm: true,
          coverUrl: "https://images.example.test/observed-inventory.png",
        }),
        /response lost/,
      );
      const offerId = [...remotes.keys()][0];
      const originalEntry = copy(remotes.get(offerId).entries[0]);
      const recovered = await service.recover(p.skinId, {
        confirm: true,
        offerId,
      });
      assert.equal(recovered.state, "paused");
      const skin = await Skin.findById(p.skinId).lean();
      assert.equal(skin.remoteOfferId, offerId);
      assert.equal(skin.mutation?.kind, undefined);
      assert.equal(remotes.get(offerId).offer.offerState, "Paused");
      assert.deepEqual(remotes.get(offerId).entries, [originalEntry]);
      const resumed = await service.resume(p.skinId);
      assert.equal(resumed.state, "listed");
      assert.equal(remotes.get(offerId).offer.offerState, "Active");
      assert.equal(remotes.get(offerId).offer.quantity, 1);
      assert.deepEqual(remotes.get(offerId).entries, [originalEntry]);
      assert.equal(creates(), 1);
    },
    { uncertain: true },
  );
});

test("recovery rejects wrong private delivery before it pauses or attaches another offer", async () => {
  const p = await verifiedEnrollment();
  await fakePublish(
    async () => {
      await assert.rejects(
        service.publish(p.skinId, {
          confirm: true,
          coverUrl: "https://images.example.test/observed-inventory.png",
        }),
        /response lost/,
      );
      const offerId = [...remotes.keys()][0];
      remotes.get(offerId).entries[0].emailPassword = "different-mail-password";
      calls.length = 0;
      await assert.rejects(
        service.recover(p.skinId, { confirm: true, offerId }),
        /does not exactly match/,
      );
      assert.equal(
        calls.some((call) => call.event === "pause"),
        false,
      );
      assert.equal(remotes.get(offerId).offer.offerState, "Active");
      const skin = await Skin.findById(p.skinId).lean();
      assert.equal(skin.remoteOfferId, "");
      assert.equal(skin.mutation.kind, "create");
    },
    { uncertain: true },
  );
});

test("recovery cannot attach an offer already belonging to another listing", async () => {
  const p = await verifiedEnrollment();
  await fakePublish(
    async () => {
      await assert.rejects(
        service.publish(p.skinId, {
          confirm: true,
          coverUrl: "https://images.example.test/observed-inventory.png",
        }),
        /response lost/,
      );
      const offerId = [...remotes.keys()][0];
      await Listing.create({
        externalId: offerId,
        status: "active",
        title: "Another listing",
      });
      calls.length = 0;
      await assert.rejects(
        service.recover(p.skinId, { confirm: true, offerId }),
        /belongs to another listing/,
      );
      assert.equal(
        calls.some((call) =>
          ["pause", "read-offer", "resume"].includes(call.event),
        ),
        false,
      );
      assert.equal((await Skin.findById(p.skinId)).remoteOfferId, "");
    },
    { uncertain: true },
  );
});

async function request(method, path, body, headers = {}) {
  return fetch(base + "/api/skin-accounts" + path, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("API requires superadmin and rejects cross-origin mutations before calling the service", async () => {
  assert.equal((await request("GET", "/overview")).status, 401);
  assert.equal(
    (await request("GET", "/overview", undefined, { "x-test-role": "admin" }))
      .status,
    403,
  );
  const read = await request("GET", "/overview", undefined, {
    "x-test-role": "superadmin",
  });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("cache-control"), "no-store");
  calls.length = 0;
  assert.equal(
    (
      await request(
        "POST",
        "/enroll",
        {},
        { "x-test-role": "superadmin", Origin: "https://other.example.test" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/enroll",
        {},
        { "x-test-role": "superadmin", "Sec-Fetch-Site": "cross-site" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/enroll",
        {},
        { "x-test-role": "superadmin", "Content-Type": "text/plain" },
      )
    ).status,
    415,
  );
  assert.equal(calls.length, 0);
  const valid = await request(
    "POST",
    "/enroll",
    {},
    { "x-test-role": "superadmin", Origin: "https://skin.example.test" },
  );
  assert.equal(
    valid.status,
    400,
    "Same-origin reaches normal input validation",
  );
});

test("API dependency errors stop farming without exposing the underlying credential-bearing error", async () => {
  const p = await verifiedAdoption();
  scanError = new Error(`Network failure using ${p.bot.clientSecret}`);
  const response = await request(
    "POST",
    `/${p.skinId}/refresh`,
    {},
    {
      "x-test-role": "superadmin",
      Origin: "https://skin.example.test",
    },
  );
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(JSON.stringify(body).includes(p.bot.clientSecret), false);
  const skin = await Skin.findById(p.skinId).lean();
  assert.equal(skin.farm.allowed, false);
  assert.equal(skin.farm.status, "stopped");
  assert.equal(skin.lastError.includes(p.bot.clientSecret), false);
});
