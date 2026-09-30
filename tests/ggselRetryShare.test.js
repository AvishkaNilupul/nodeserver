// A GGSel share re-added by retryMissingSecondaries is a proper GGSel listing:
// its description names GGSel (it used to copy the Gameflip row's text, so a
// GGSel buyer was told to "message me here on Gameflip"), and its row records
// the accounts by id as well as login (the guardian's per-account checks read
// accountId; a share recorded by login alone was invisible to them).
// Memory Mongo, real lister/claim/reservation; only GGSel calls are stubbed.
process.env.CRED_SECRET ||= "ggsel-retry-share-test-cred-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AutoFarmTask = require("../models/AutoFarmTask");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const mp = require("../utils/marketplaces");
const settings = require("../utils/settings");
const { encrypt } = require("../utils/secretBox");

let mem;
const saved = {};
const published = [];

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("ggsel-retry-share"));
  saved.getAutoFarm = settings.getAutoFarm;
  saved.ggselResolveCategoryId = mp.ggselResolveCategoryId;
  saved.ggselPublish = mp.ggselPublish;
  const af = saved.getAutoFarm();
  settings.getAutoFarm = () => ({
    ...af,
    ggselEnabled: true,
    platiEnabled: false,
    platiCategoryId: "",
    zeusxAuto: false,
    g2gAuto: false,
    eldoradoAuto: false,
  });
  mp.ggselResolveCategoryId = async () => "4242";
  mp.ggselPublish = async (args) => {
    published.push(args);
    return { externalId: "777001", url: "https://ggsel.net/en/catalog/product/777001", note: "", qty: (args.products || []).length };
  };
});

test.after(async () => {
  settings.getAutoFarm = saved.getAutoFarm;
  mp.ggselResolveCategoryId = saved.ggselResolveCategoryId;
  mp.ggselPublish = saved.ggselPublish;
  await new Promise((r) => setTimeout(r, 50));
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

test("a re-added GGSel share says GGSel and records its accounts by id", async () => {
  const autoLister = require("../utils/autoLister");
  const set = await DropSet.create({
    name: "Rust Twitch Drops (2 Items) — Bed + Box",
    price: 1.5,
    items: [
      { itemKey: "bed|rust", name: "Bed", game: "Rust", qty: 1 },
      { itemKey: "box|rust", name: "Box", game: "Rust", qty: 1 },
    ],
  });
  const logins = ["retry_a", "retry_b", "retry_c", "retry_d"];
  for (const [i, login] of logins.entries()) {
    const acc = await BotAccount.create({
      login,
      clientSecret: "cs-retry-" + i,
      credPassword: encrypt("pw" + i),
      hasPassword: true,
      lastScanStatus: "ok",
    });
    for (const k of ["bed|rust", "box|rust"]) {
      await DropLog.create({ account: acc._id, login, benefitId: login + k, itemKey: k, game: "Rust" });
    }
  }
  await MarketplaceListing.create({
    set: set._id,
    marketplace: "gameflip",
    externalId: "gf-retry-1",
    title: set.name,
    description: "Includes: Bed, Box\n\nAny issue or question — message me here on Gameflip before opening a dispute.",
    price: 1.5,
    status: "active",
    origin: "auto",
  });
  const task = await AutoFarmTask.create({
    game: "Rust",
    campaignId: "camp-retry-1",
    decision: "farm",
    campaignName: "Rust Charity",
    status: "active",
    assignedAccounts: logins,
    listing: { setId: String(set._id), externalId: "gf-retry-1", title: set.name, price: 1.5 },
  });

  const retried = await autoLister.retryMissingSecondaries(task);
  assert.deepEqual(retried, ["ggsel"]);
  assert.equal(published.length, 1);
  assert.match(published[0].description, /message me here on GGSel/);
  assert.doesNotMatch(published[0].description, /on Gameflip/);
  assert.equal(published[0].categoryId, "4242");

  const row = await MarketplaceListing.findOne({ marketplace: "ggsel", externalId: "777001" }).lean();
  assert.ok(row, "the GGSel row was written");
  const ids = String(row.accountId || "").split(",").filter(Boolean);
  const loginsOnRow = String(row.accountLogin || "").split(/[,\s]+/).filter(Boolean);
  assert.equal(ids.length, loginsOnRow.length, "every account is recorded by id too");
  assert.ok(ids.length >= 1);
  // Each recorded account really is reserved to GGSel for this set.
  for (const id of ids) {
    const held = await DropLog.countDocuments({ account: id, soldToUsername: "ggsel", soldSetId: String(set._id) });
    assert.equal(held, 2);
  }
  const t = await AutoFarmTask.findById(task._id).lean();
  assert.equal(t.listing.ggsel.externalId, "777001");
});
