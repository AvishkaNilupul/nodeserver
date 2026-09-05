// One account sells once — across sets, across marketplaces, across the two
// fields that record an attachment (utils/listedLogins.js).
//
// Prod 2026-09-05: 113 logins sat on two or more ACTIVE listings, and new
// collisions were still being created (2026-09-03) by restocks through the
// GGSel/Digiseller claimers, which never excluded accounts already on another
// listing; the auto-lister's picker excluded accountLogin only, so every
// account fed later as a stock UNIT was invisible to it.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const { encrypt } = require("../utils/secretBox");
const { loginsOnActiveListings, notListed } = require("../utils/listedLogins");
const autoLister = require("../utils/autoLister");

let mem;
test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("listingcollisions"));
});
test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

async function set(name) {
  return DropSet.create({ name, items: [{ itemKey: "g|item a", name: "Item A", game: "G" }] });
}

test("loginsOnActiveListings reads accountLogin (csv) AND fed units, active rows only, case-folded", async () => {
  await MarketplaceListing.deleteMany({});
  const s1 = await set("S1");
  const s2 = await set("S2");
  await MarketplaceListing.create({ set: s1._id, marketplace: "gameflip", externalId: "gf1", status: "active", accountLogin: "Alpha" });
  await MarketplaceListing.create({ set: s2._id, marketplace: "ggsel", externalId: "gg1", status: "active", accountLogin: "bravo, charlie", units: [{ login: "delta" }, { login: "Echo" }] });
  await MarketplaceListing.create({ set: s2._id, marketplace: "digiseller", externalId: "ds1", status: "delisted", accountLogin: "foxtrot", units: [{ login: "golf" }] });
  const listed = await loginsOnActiveListings();
  assert.deepEqual([...listed].sort(), ["alpha", "bravo", "charlie", "delta", "echo"]);
  assert.deepEqual(
    notListed([{ login: "ALPHA" }, { login: "hotel" }, { login: "delta" }], listed).map((c) => c.login),
    ["hotel"],
  );
});

test("pickDeliveryAccounts never returns an account fed as a UNIT to another listing", async () => {
  await MarketplaceListing.deleteMany({});
  await BotAccount.deleteMany({});
  await DropLog.deleteMany({});
  const items = [{ itemKey: "g|item a", name: "Item A", qty: 1 }];
  const accounts = [];
  for (const login of ["free1", "unitfed", "csvlisted"]) {
    const a = await BotAccount.create({ login, clientSecret: "tok-" + login, credPassword: encrypt("pw"), lastScanStatus: "ok" });
    await DropLog.create({ account: a._id, login, benefitId: "b1", itemKey: "g|item a", game: "G", count: 1, connected: false, soldAt: null });
    accounts.push(a);
  }
  const s = await set("Other Set");
  await MarketplaceListing.create({ set: s._id, marketplace: "ggsel", externalId: "gg9", status: "active", accountLogin: "someone-else", units: [{ login: "UNITFED" }] });
  await MarketplaceListing.create({ set: s._id, marketplace: "gameflip", externalId: "gf9", status: "active", accountLogin: "csvlisted" });
  const task = { assignedAccounts: ["free1", "unitfed", "csvlisted"] };
  const picked = await autoLister.pickDeliveryAccounts(task, 10, items);
  assert.deepEqual(picked.map((p) => p.login), ["free1"], "unitfed (a fed unit) and csvlisted (accountLogin) are both excluded");
});
