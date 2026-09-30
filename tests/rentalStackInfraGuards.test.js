// Fix 14 (2026-10-01): the operator's bot tools never delete, move or repack a
// rental stack (its ledger would point at nothing), and a config slot number is
// never handed out twice.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const RenterBotStack = require("../models/RenterBotStack");
const RenterAccount = require("../models/RenterAccount");
const bc = require("../routes/botConfigRoutes");
const { findNextSlot } = require("../utils/botFactory");

let mongod;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("rental-infra-guards"));
});
test.after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test("a registered rental stack, or a file the ledger still farms in, is refused", async () => {
  await Promise.all([RenterBotStack.deleteMany({}), RenterAccount.deleteMany({})]);
  await RenterBotStack.create({ host: "contabo", file: "config_03.json", capacity: 50 });
  await RenterAccount.create({ renter: new mongoose.Types.ObjectId(), clientSecret: "s1", login: "b1", host: "local", configFile: "config_16.json" });
  assert.match(await bc.rentalStackRefusal("contabo", "config_03.json"), /config_03\.json on contabo is a rental stack/);
  assert.match(await bc.rentalStackRefusal("local", "config_16.json"), /holding 1 renter \/ rent-farm account/);
  assert.equal(await bc.rentalStackRefusal("contabo", "config_40.json"), "", "an operator bot is fine");
});

test("REGRESSION: a deleted (archived) slot's number is never handed out again", () => {
  const files = ["config.json", "config_58.json", "config_59.json.deleted-1759300000000", "config_60.json.bak", "docker-compose.yml"];
  assert.equal(findNextSlot(files).file, "config_61.json");
  assert.equal(findNextSlot(["config.json", "config_02.json"]).file, "config_03.json");
});
