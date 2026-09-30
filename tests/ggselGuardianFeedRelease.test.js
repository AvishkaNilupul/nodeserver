// A failed GGSel auto-feed hands back ONLY the set it was feeding.
//
// The guardian's feed claims accounts for a listing's set, and when the GGSel
// add fails (a 500, a timeout) it puts them back. That put-back was tag-wide —
// every "ggsel" drop on the account — so an account that had already SOLD
// another game on GGSel got that sale's drops re-opened for the next buyer.
// Real guardian (feedOne), real claim and reservation layers, memory Mongo;
// only the GGSel calls are stubbed.
process.env.CRED_SECRET ||= "ggsel-guardian-feed-test-cred-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const mp = require("../utils/marketplaces");
const { encrypt } = require("../utils/secretBox");

let mem;
const saved = {};
const STUBS = {
  ggselTakesNewStock: () => true,
  ggselOfferStockDetailed: async () => ({ stock: 0, reason: "" }),
  ggselOfferStock: async () => 0,
  ggselEnableAutoselling: async () => ({ changed: false }),
  ggselAddProducts: async () => {
    throw new Error("GGSel add products: HTTP 500");
  },
  ggselFinalizeStock: async () => ({ stock: 0, pending: true }),
};

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("ggsel-guardian-feed"));
  for (const [k, v] of Object.entries(STUBS)) {
    saved[k] = mp[k];
    mp[k] = v;
  }
});

test.after(async () => {
  Object.assign(mp, saved);
  await new Promise((r) => setTimeout(r, 50));
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

test("a failed feed releases the fed set only — the account's earlier GGSel sale stays reserved", async () => {
  const guardian = require("../utils/marketplaceGuardian");
  const acc = await BotAccount.create({
    login: "feedfail_a",
    clientSecret: "cs-feedfail-a",
    credPassword: encrypt("pw"),
    hasPassword: true,
    lastScanStatus: "ok",
  });
  const fed = await DropSet.create({ name: "Rust bundle", price: 1, items: [{ itemKey: "bed|rust", name: "Bed", game: "Rust" }] });
  const sold = await DropSet.create({ name: "Halo bundle", price: 1, items: [{ itemKey: "visor|halo", name: "Visor", game: "Halo" }] });
  await DropLog.create({ account: acc._id, login: acc.login, benefitId: "b1", itemKey: "bed|rust", game: "Rust" });
  // The Halo set was sold on GGSel earlier: its "ggsel" tag is the only record.
  await DropLog.create({
    account: acc._id,
    login: acc.login,
    benefitId: "b2",
    itemKey: "visor|halo",
    game: "Halo",
    soldAt: new Date(),
    soldToUsername: "ggsel",
    soldSetId: String(sold._id),
  });
  const row = await MarketplaceListing.create({
    set: fed._id,
    marketplace: "ggsel",
    externalId: "900001",
    title: "Rust bundle",
    price: 1,
    status: "active",
    origin: "auto",
    autoDeliver: true,
    qtyTarget: 1,
  });

  const n = await guardian.feedOne(String(row._id));
  assert.equal(n, 0, "the add failed, nothing was fed");
  const halo = await DropLog.findOne({ itemKey: "visor|halo" }).lean();
  assert.equal(halo.soldToUsername, "ggsel", "the earlier GGSel sale is still reserved");
  assert.ok(halo.soldAt);
  const rust = await DropLog.findOne({ itemKey: "bed|rust" }).lean();
  assert.equal(rust.soldAt, null, "the claim made for this feed was put back");
});
