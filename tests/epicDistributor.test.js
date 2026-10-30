process.env.SESSION_SECRET ||= "epic-dist-test-session";
process.env.CRED_SECRET ||= "epic-dist-test-credentials";
process.env.PUBLIC_BASE_URL = "https://mail.example.test";
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { encrypt } = require("../utils/secretBox");
const Account = require("../models/EpicAccount");
const PaUnit = require("../models/EpicPaUnit");
const G2gUnit = require("../models/EpicG2gUnit");
const Freebie = require("../models/EpicFreebie");
const State = require("../models/EpicDistributorState");
const sales = require("../utils/epicSales");
const epicPa = require("../utils/epicPa");
const g2g = require("../utils/epicG2g");
const mp = require("../utils/marketplaces");
const outlook = require("../utils/outlookGraphReader");
const dist = require("../utils/epicDistributor");

const OWNER = { phone: "090 1234 5678", city: "Osaka" };
const sent = [];
require("../utils/telegram").sendTelegram = async (text) => sent.push(text);
outlook.checkInbox = async () => ({ sellable: true, sharedWith: [], status: "live" });
let paAlive = true;
mp.playerauctionsTokenExpiry = () => ({ refresh: paAlive ? new Date(Date.now() + 3600e3) : new Date(Date.now() - 1000) });

// Fake markets: record calls and write the same rows the real paths write.
let published = [];
let publishFails = false;
epicPa.publish = async (accountId, opts, actor) => {
  if (publishFails) throw new Error("PlayerAuctions rejected the account offer (code 400).");
  published.push({ accountId, opts, actor });
  await PaUnit.create({ epicAccountId: accountId, offerId: String(9000 + published.length), priceUsd: opts.priceUsd, state: "listed" });
  return {};
};
let links = [];
let loads = [];
g2g.instantLinks = async () => links;
g2g.loadStock = async (offerId, opts) => {
  loads.push({ offerId, only: [...(opts.only || [])] });
  for (const id of opts.only || []) {
    await G2gUnit.create({ offerId, epicAccountId: id, login: id + "@x.test", state: "loading" });
  }
  return { loaded: (opts.only || new Set()).size };
};
sales._internals.eldoradoPermission = async () => ({ canSell: false });

let db;
let seq = 0;
function details(extra = {}) {
  return encrypt(
    JSON.stringify({
      firstName: "Reg",
      lastName: "Istered",
      country: "JP",
      dateOfBirth: "1990-01-01",
      // What the generator really stores: a made-up sample, never for a market.
      contactSource: "synthetic-internal",
      phone: "0000000000",
      address: "1 Sample Street",
      ...extra,
    }),
  );
}
async function account(games, extra = {}) {
  const n = ++seq;
  return Account.create({
    accountId: "epic" + n,
    displayName: "Player" + n,
    label: "acc" + n,
    source: "generated",
    email: encrypt("epic" + n + "@example.test"),
    password: encrypt("Epic-Test-Password"),
    accountDetails: details(),
    library: games.map((t) => ({ title: t, priceUsd: 10 })),
    createdAt: new Date(Date.now() - (100 - n) * 60000),
    ...extra,
  });
}
const rowOf = (plan, acc) => plan.find((r) => r.accountId === String(acc._id));

test.before(async () => {
  db = await MongoMemoryServer.create();
  await mongoose.connect(db.getUri());
  await PaUnit.init();
  await G2gUnit.init();
});
test.after(async () => {
  dist.stop();
  await mongoose.disconnect();
  await db.stop();
});
test.beforeEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
  published = [];
  loads = [];
  links = [{ offerId: "G1", mode: "instant", enabled: true, games: ["Sker Ritual"], title: "Sker" }];
  publishFails = false;
  paAlive = true;
  sent.length = 0;
  dist._internals.failures.clear();
});

test("plan mode lists nothing and gives every account a reason", async () => {
  await dist.setOwner(OWNER, "test");
  const sellable = await account(["Sker Ritual", "Home"]);
  const empty = await account([]);
  const manual = await account(["Sker Ritual"], { source: "manual" });
  const free = await account(["Freebie Game"]);
  await Freebie.create({ offerId: "free1", title: "Freebie Game", endDate: new Date(Date.now() + 86400e3), active: true, upcoming: false });

  const r = await dist.run({ execute: true });
  assert.equal(r.executed, false);
  assert.equal(published.length, 0);
  assert.equal(loads.length, 0);
  assert.equal(rowOf(r.rows, sellable).decision, "pa");
  assert.equal(rowOf(r.rows, empty).decision, "hold");
  assert.match(rowOf(r.rows, empty).reason, /No games yet/);
  assert.equal(rowOf(r.rows, manual).decision, "skip");
  assert.equal(rowOf(r.rows, free).decision, "hold");
  assert.match(rowOf(r.rows, free).reason, /still free on Epic/);
  const v = await dist.view();
  assert.equal(v.config.mode, "plan");
  assert.equal(v.plan.length, 4);
  assert.match(v.lastRun.note, /Plan only/);
});

test("PlayerAuctions takes the richest, G2G the leanest, the rest waits in reserve", async () => {
  await dist.setOwner(OWNER, "test");
  await dist.setConfig({ pa: { maxLive: 1 }, g2g: { maxStock: 2 } }, "test");
  const rich = await account(["Sker Ritual", "Home", "Sorry We're Closed"]);
  const lean = [await account(["Sker Ritual"]), await account(["Sker Ritual"]), await account(["Sker Ritual"])];
  const noFit = await account(["Other Game"]);

  const { rows } = await dist.run({ execute: false });
  assert.equal(rowOf(rows, rich).decision, "pa");
  assert.equal(rowOf(rows, lean[0]).decision, "g2g");
  assert.equal(rowOf(rows, lean[0]).target, "G1");
  assert.equal(rowOf(rows, lean[1]).decision, "g2g");
  assert.equal(rowOf(rows, lean[2]).decision, "reserve");
  assert.match(rowOf(rows, lean[2]).reason, /PlayerAuctions: full \(1\/1\)/);
  assert.match(rowOf(rows, lean[2]).reason, /G2G: full \(2\/2\)/);
  assert.equal(rowOf(rows, noFit).decision, "reserve");
  assert.match(rowOf(rows, noFit).reason, /G2G: no offer for these games/);
});

test("without the owner's phone and city PlayerAuctions is skipped; the made-up phone is never used", async () => {
  const a = await account(["Sker Ritual"]);
  const { rows, markets } = await dist.run({ execute: false });
  assert.equal(markets.pa.ok, false);
  assert.match(markets.pa.status, /phone and city/);
  assert.equal(rowOf(rows, a).decision, "g2g");

  // The manual PA form no longer pre-fills the generator's sample contact.
  const d0 = epicPa._internals.defaults(await Account.findById(a._id).lean());
  assert.equal(d0.phone, "");
  assert.equal(d0.city, "");
  assert.equal(d0.firstName, "Reg");
  const d1 = epicPa._internals.defaults(await Account.findById(a._id).lean(), OWNER);
  assert.equal(d1.phone, OWNER.phone);
  assert.equal(d1.city, OWNER.city);
});

test("on: one PlayerAuctions publish per run with the owner's contact; G2G gets exactly its planned accounts", async () => {
  await dist.setOwner(OWNER, "test");
  await dist.setConfig({ mode: "on", confirm: true, pa: { maxLive: 2, priceUsd: 6.5 }, g2g: { maxStock: 1 } }, "test");
  const p1 = await account(["Sker Ritual", "Home", "Sorry We're Closed"]);
  const p2 = await account(["Sker Ritual", "Home"]);
  const g = await account(["Sker Ritual"]);

  const r = await dist.run({ execute: true });
  assert.equal(r.executed, true);
  assert.equal(published.length, 1);
  assert.equal(published[0].accountId, String(p1._id));
  assert.equal(published[0].actor, "auto-distributor");
  assert.equal(published[0].opts.priceUsd, 6.5);
  assert.deepEqual(published[0].opts.original, {
    firstName: "Reg",
    lastName: "Istered",
    email: "epic" + (seq - 2) + "@example.test",
    country: "JP",
    phone: OWNER.phone,
    city: OWNER.city,
  });
  assert.equal(rowOf(r.rows, p1).outcome, "placed");
  assert.equal(rowOf(r.rows, p2).outcome, "queued");
  assert.deepEqual(loads, [{ offerId: "G1", only: [String(g._id)] }]);
  assert.equal(rowOf(r.rows, g).outcome, "placed");
  assert.equal(sent.length, 1);
  assert.match(sent[0], /1 on PlayerAuctions, 1 into G2G stock/);

  // Next run: the queued account goes out, the listed ones are not re-planned.
  const r2 = await dist.run({ execute: true });
  assert.equal(published.length, 2);
  assert.equal(published[1].accountId, String(p2._id));
  assert.equal(rowOf(r2.rows, p1), undefined);
  assert.equal(rowOf(r2.rows, g), undefined);
});

test("a PlayerAuctions offer that needs checking, or an expired session, stops PlayerAuctions", async () => {
  await dist.setOwner(OWNER, "test");
  const stuckAcc = await account(["Other"]);
  await PaUnit.create({ epicAccountId: stuckAcc._id, priceUsd: 5, state: "error" });
  await account(["Sker Ritual"]);
  let { markets } = await dist.run({ execute: false });
  assert.equal(markets.pa.ok, false);
  assert.match(markets.pa.status, /need checking/);

  await PaUnit.deleteMany({});
  paAlive = false;
  ({ markets } = await dist.run({ execute: false }));
  assert.equal(markets.pa.ok, false);
  assert.match(markets.pa.status, /session expired/);
});

test("a failed listing backs the account off instead of retrying every run", async () => {
  await dist.setOwner(OWNER, "test");
  await dist.setConfig({ mode: "on", confirm: true }, "test");
  links = [];
  const a = await account(["Sker Ritual"]);
  publishFails = true;
  const r = await dist.run({ execute: true });
  assert.equal(rowOf(r.rows, a).outcome, "failed");
  assert.match(rowOf(r.rows, a).reason, /rejected/);
  assert.equal((await dist.view()).lastRun.ok, false);
  const r2 = await dist.run({ execute: false });
  assert.equal(rowOf(r2.rows, a).decision, "hold");
  assert.match(rowOf(r2.rows, a).reason, /attempt failed/);
});

test("switching on needs confirm; the G2G sweep stops self-loading only while on", async () => {
  await assert.rejects(dist.setConfig({ mode: "on" }, "test"), /confirm/);
  assert.equal(await dist.g2gSweepOnly(), null);
  await dist.setConfig({ mode: "on", confirm: true }, "test");
  const only = await dist.g2gSweepOnly();
  assert.ok(only instanceof Set);
  assert.equal(only.size, 0);
  await dist.setConfig({ mode: "off" }, "test");
  assert.equal(await dist.g2gSweepOnly(), null);
  const r = await dist.run({ execute: true });
  assert.match(r.skipped, /off/);
});

test("owner details are validated, stored encrypted and shown masked", async () => {
  await assert.rejects(dist.setOwner({ phone: "+81 90 1234 5678", city: "Osaka" }, "t"), /Phone/);
  await assert.rejects(dist.setOwner({ phone: "09012345678", city: "" }, "t"), /city/);
  await assert.rejects(dist.setConfig({ pa: { priceUsd: 4.99 } }, "t"), /\$5/);
  const v = await dist.setOwner(OWNER, "t");
  assert.deepEqual(v.owner.saved, true);
  assert.equal(v.owner.phone, "•••• 5678");
  assert.equal(v.owner.city, "Osaka");
  const raw = await State.findById("main").lean();
  assert.ok(raw.ownerEnc && !raw.ownerEnc.includes("5678"));
  assert.equal(JSON.stringify(v).includes("1234"), false);
  const cleared = await dist.setOwner({ clear: true }, "t");
  assert.equal(cleared.owner.saved, false);
});

test("accounts already on a market, sold, or with 2FA never go to PlayerAuctions", async () => {
  await dist.setOwner(OWNER, "test");
  const inG2g = await account(["Sker Ritual"]);
  await G2gUnit.create({ offerId: "G1", epicAccountId: inG2g._id, login: "x@x.test", state: "listed" });
  const sold = await account(["Sker Ritual"], { sold: true });
  const twoFa = await account(["Sker Ritual", "Home"], { totpSecret: encrypt("JBSWY3DPEHPK3PXP") });
  const { rows } = await dist.run({ execute: false });
  assert.equal(rowOf(rows, inG2g), undefined);
  assert.equal(rowOf(rows, sold), undefined);
  assert.equal(rowOf(rows, twoFa).decision, "g2g");
});
