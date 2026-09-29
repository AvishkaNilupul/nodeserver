// claimAccountsForSet must hand back ONLY the reservation it just made. An
// account whose password turns out unreadable is released for THIS set — never
// tag-wide, which would also free drops of another set that the same marketplace
// tag holds (marketplace tags are not re-stamped on delivery, so those can be
// SOLD drops) and put them back on sale.
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.CRED_SECRET = "claim-scoped-release-test-secret-0123456789";

const mpPath = require.resolve("../utils/marketplaces");
require.cache[mpPath] = { id: mpPath, filename: mpPath, loaded: true, exports: {} };

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const { claimAccountsForSet } = require("../utils/eldoradoFulfiller");
const { encrypt, decrypt } = require("../utils/secretBox");

// A real ciphertext with its data corrupted: non-empty (so the shop counts the
// account as sellable) but it no longer decrypts (GCM auth fails -> "").
function unreadable() {
  const good = encrypt("pw-acc1");
  const parts = good.split(":");
  const data = parts[parts.length - 1];
  parts[parts.length - 1] = (data[0] === "A" ? "B" : "A") + data.slice(1);
  const bad = parts.join(":");
  assert.equal(decrypt(bad), "");
  return bad;
}

let mongod;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("claimScoped"));
});
test.after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test("an unreadable password releases only the set just reserved, not a sold one", async () => {
  const setA = await DropSet.create({ name: "A", items: [{ itemKey: "a|1", name: "A1", game: "Rust" }] });
  const setB = await DropSet.create({ name: "B", items: [{ itemKey: "b|1", name: "B1", game: "Rust" }] });
  // No readable password: claimAccountsForSet reserves it for B, then must back out.
  const acc = await BotAccount.create({
    clientSecret: "cs-1",
    login: "acc1",
    credPassword: unreadable(),
    hasPassword: true,
    lastScanStatus: "ok",
  });
  const soldA = new Date(Date.now() - 86400e3);
  // Bundle A was SOLD on Eldorado earlier: its drop still carries the tag.
  await DropLog.create({
    account: acc._id, benefitId: "ba", login: "acc1", game: "Rust", itemKey: "a|1",
    soldAt: soldA, soldToUsername: "eldorado", soldSetId: String(setA._id),
  });
  await DropLog.create({ account: acc._id, benefitId: "bb", login: "acc1", game: "Rust", itemKey: "b|1" });

  const got = await claimAccountsForSet(setB.toObject(), 1);
  assert.equal(got.length, 0, "an unreadable account is never handed out");

  const a = await DropLog.findOne({ account: acc._id, itemKey: "a|1" }).lean();
  assert.ok(a.soldAt, "bundle A's SOLD drop stays reserved");
  assert.equal(a.soldToUsername, "eldorado");
  assert.equal(a.soldSetId, String(setA._id));
  const b = await DropLog.findOne({ account: acc._id, itemKey: "b|1" }).lean();
  assert.equal(b.soldAt, null, "bundle B's reservation was backed out");
});
