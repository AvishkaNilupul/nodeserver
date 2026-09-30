// scripts/credit-farm-outage.js (2026-10-01): a dry run changes nothing; with
// --apply every LIVE bounded window on the stack moves later by the outage,
// the order's copy with it; ended / open-ended / other stacks are untouched;
// a credit over 14 days is refused.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const RenterAccount = require("../models/RenterAccount");
const FarmServiceOrder = require("../models/FarmServiceOrder");
const SCRIPT = path.join(__dirname, "..", "scripts", "credit-farm-outage.js");

let mongod;
let uri;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  uri = mongod.getUri("credit-outage");
  await mongoose.connect(uri);
});
test.after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

function run(args) {
  try {
    return { out: execFileSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, MONGO_URI: uri, MONGODB_URI: uri }, encoding: "utf8" }), code: 0 };
  } catch (e) {
    return { out: String(e.stdout || "") + String(e.stderr || ""), code: e.status };
  }
}

test("dry run changes nothing; --apply credits live windows on the stack only, orders in step", async () => {
  await Promise.all([RenterAccount.deleteMany({}), FarmServiceOrder.deleteMany({})]);
  const r = new mongoose.Types.ObjectId();
  const until = new Date(Date.now() + 20 * 86400000);
  await RenterAccount.create({ renter: r, clientSecret: "s1", login: "Live1", host: "contabo", configFile: "config_03.json", farmUntil: until });
  await RenterAccount.create({ renter: r, clientSecret: "s2", login: "ended2", host: "contabo", configFile: "", farmUntil: new Date(Date.now() - 86400000), farmEndedAt: new Date() });
  await RenterAccount.create({ renter: r, clientSecret: "s3", login: "open3", host: "contabo", configFile: "config_03.json", farmUntil: null });
  await RenterAccount.create({ renter: r, clientSecret: "s4", login: "other4", host: "contabo", configFile: "config_04.json", farmUntil: until });
  await FarmServiceOrder.create({ orderId: "o1", market: "eldorado", accounts: [{ login: "live1", farmUntil: until }] });

  let res = run(["--stack", "contabo/config_03.json", "--hours", "6"]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /DRY RUN/);
  assert.equal((await RenterAccount.findOne({ login: "Live1" }).lean()).farmUntil.getTime(), until.getTime());

  res = run(["--stack", "contabo/config_03.json", "--hours", "6", "--apply"]);
  assert.equal(res.code, 0, res.out);
  const moved = until.getTime() + 6 * 3600000;
  assert.equal((await RenterAccount.findOne({ login: "Live1" }).lean()).farmUntil.getTime(), moved);
  assert.equal((await FarmServiceOrder.findOne({ orderId: "o1" }).lean()).accounts[0].farmUntil.getTime(), moved, "order in step");
  assert.equal((await RenterAccount.findOne({ login: "open3" }).lean()).farmUntil, null, "open-ended untouched");
  assert.equal((await RenterAccount.findOne({ login: "other4" }).lean()).farmUntil.getTime(), until.getTime(), "other stack untouched");
});

test("a credit over 14 days is refused", () => {
  const res = run(["--stack", "contabo/config_03.json", "--hours", "400"]);
  assert.notEqual(res.code, 0);
  assert.match(res.out, /over 14 days is refused/);
});
