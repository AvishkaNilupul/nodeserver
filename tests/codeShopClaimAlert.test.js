// Code shop claim alert (utils/codeShop/claimAlert.js, docs/code-shop/04-OPS.md).
//
// What matters:
// - the owner hears about a reward about to expire unclaimed exactly once:
//   rows already stamped are skipped, and a second run after a good send says
//   nothing;
// - a failed send stamps nothing, so the very same rows go out on the next
//   run — never "stamped but never told";
// - the window is (now, now + lead], every kind counts, and only rows still in
//   the "available" division are due;
// - it ships switchable: disabled means no read, no send, no stamp.
//
// Real Mongo via mongodb-memory-server with the real events module (its unique
// stampKey index is the "already told" record). Telegram is a fake. All names
// and logins are made up.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const SoopInventoryItem = require("../models/SoopInventoryItem");
const CodeShopEvent = require("../models/CodeShopEvent");
const { createEvents } = require("../utils/codeShop/events");
const { createClaimAlert, stampKey } = require("../utils/codeShop/claimAlert");

const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const CLOSING =
  "Code rewards are claimed by themselves while the login works; in-game and link rewards need a click in the farm panel.";

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshopclaimalert"));
  await Promise.all([SoopInventoryItem, CodeShopEvent].map((m) => m.init()));
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

test.beforeEach(async () => {
  await Promise.all([SoopInventoryItem, CodeShopEvent].map((m) => m.deleteMany({})));
});

function fakeTelegram({ failures = 0 } = {}) {
  const t = {
    sent: [],
    calls: 0,
    failures,
    async send(message) {
      t.calls += 1;
      if (t.failures > 0) {
        t.failures -= 1;
        throw new Error("nothing was sent");
      }
      t.sent.push(message);
    },
  };
  return t;
}

function fakeConfig(claimAlert = {}) {
  return { get: async () => ({ claimAlert: { enabled: true, leadHours: 24, ...claimAlert } }) };
}

function alertWith({ cfg, telegram = fakeTelegram(), now = () => NOW } = {}) {
  const events = createEvents({ model: CodeShopEvent, now });
  const alert = createClaimAlert({ models: { SoopInventoryItem }, config: fakeConfig(cfg), events, telegram, now });
  return { alert, events, telegram };
}

let seq = 0;
async function seedItem(expiresAt, opts = {}) {
  seq += 1;
  return SoopInventoryItem.create({
    loginId: opts.loginId || "login-" + seq,
    key: opts.key || "item-" + seq,
    division: opts.division || "available",
    kind: opts.kind || "code",
    gameNo: opts.gameNo || "12",
    gameName: opts.gameName === undefined ? "Overwatch 2" : opts.gameName,
    name: opts.name === undefined ? "Reward " + seq : opts.name,
    nameRaw: opts.nameRaw || "",
    expiresAt: expiresAt === null ? null : new Date(expiresAt),
  });
}

const stampCount = () => CodeShopEvent.countDocuments({ stampKey: { $gt: "" } });
const rewardLines = (message) => message.split("\n").filter((l) => l.startsWith("- "));

test("disabled: nothing is read, sent or stamped", async () => {
  await seedItem(NOW + HOUR);
  const { alert, telegram } = alertWith({ cfg: { enabled: false } });
  assert.deepEqual(await alert.run(), { due: 0, told: 0 });
  assert.equal(telegram.calls, 0);
  assert.equal(await stampCount(), 0);
});

test("the due window is (now, now + lead] and only available rows count", async () => {
  const lead = 24 * HOUR;
  await seedItem(NOW, { name: "At now" }); // not after now
  await seedItem(NOW - HOUR, { name: "Already gone" });
  await seedItem(NOW + 1, { name: "Just inside" });
  await seedItem(NOW + lead, { name: "At the edge" });
  await seedItem(NOW + lead + 1, { name: "Just outside" });
  await seedItem(null, { name: "No end date" });
  await seedItem(NOW + HOUR, { name: "Claimed already", division: "acquired" });
  await seedItem(NOW + HOUR, { name: "Expired row", division: "expired" });

  const { alert, telegram } = alertWith();
  assert.deepEqual(await alert.run(), { due: 2, told: 2 });
  assert.equal(telegram.sent.length, 1);
  const lines = rewardLines(telegram.sent[0]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Just inside/);
  assert.match(lines[1], /At the edge/);
  assert.equal(await stampCount(), 2);
});

test("leadHours from the config sets the window and the first line", async () => {
  await seedItem(NOW + 2 * HOUR, { name: "Two hours" });
  await seedItem(NOW + 5 * HOUR, { name: "Five hours" });
  const { alert, telegram } = alertWith({ cfg: { leadHours: 3 } });
  assert.deepEqual(await alert.run(), { due: 1, told: 1 });
  assert.equal(telegram.sent[0].split("\n")[0], "1 farm reward(s) expire unclaimed within 3 h");
});

test("message format: count line, one line per reward soonest first, closing line", async () => {
  await seedItem(NOW + 5 * HOUR + 30 * 60 * 1000, { loginId: "farmer-b", gameName: "Delta Force", name: "Weapon Skin" });
  await seedItem(NOW + 15 * HOUR, { loginId: "farmer-a", gameName: "Overwatch 2", name: "Sun Tea Player Icon" });
  const { alert, telegram } = alertWith();
  await alert.run();
  assert.deepEqual(telegram.sent[0].split("\n"), [
    "2 farm reward(s) expire unclaimed within 24 h",
    "- Delta Force: Weapon Skin on farmer-b (by 2026-10-15 17:30 UTC)",
    "- Overwatch 2: Sun Tea Player Icon on farmer-a (by 2026-10-16 03:00 UTC)",
    CLOSING,
  ]);
});

test("every kind is included", async () => {
  for (const kind of ["code", "link", "ingame", "other"]) {
    await seedItem(NOW + HOUR, { kind, name: "Kind " + kind });
  }
  const { alert, telegram } = alertWith();
  assert.deepEqual(await alert.run(), { due: 4, told: 4 });
  const message = telegram.sent[0];
  for (const kind of ["code", "link", "ingame", "other"]) assert.match(message, new RegExp("Kind " + kind));
});

test("missing names fall back: raw name, then a generic label", async () => {
  await seedItem(NOW + HOUR, { name: "", nameRaw: "Raw Name", gameName: "" });
  await seedItem(NOW + 2 * HOUR, { name: "", nameRaw: "" });
  const { alert, telegram } = alertWith();
  await alert.run();
  const lines = rewardLines(telegram.sent[0]);
  assert.match(lines[0], /^- Unknown game: Raw Name on /);
  assert.match(lines[1], /^- Overwatch 2: a reward on /);
});

test("rows already stamped are skipped", async () => {
  const old = await seedItem(NOW + HOUR, { name: "Told before" });
  await seedItem(NOW + 2 * HOUR, { name: "Brand new" });
  const { alert, events, telegram } = alertWith();
  assert.equal(await events.stamp(stampKey(old)), true);

  assert.deepEqual(await alert.run(), { due: 2, told: 1 });
  const message = telegram.sent[0];
  assert.equal(message.split("\n")[0], "1 farm reward(s) expire unclaimed within 24 h");
  assert.doesNotMatch(message, /Told before/);
  assert.match(message, /Brand new/);
});

test("nothing new: no message at all", async () => {
  const row = await seedItem(NOW + HOUR);
  const { alert, events, telegram } = alertWith();
  await events.stamp(stampKey(row));
  assert.deepEqual(await alert.run(), { due: 1, told: 0 });
  assert.equal(telegram.calls, 0);
});

test("more than 15 rows: 15 lines plus '+ N more', and every row is stamped", async () => {
  for (let i = 0; i < 18; i++) await seedItem(NOW + (i + 1) * 60 * 1000, { name: "Reward no " + (i + 1) });
  const { alert, telegram } = alertWith();
  assert.deepEqual(await alert.run(), { due: 18, told: 18 });
  const lines = telegram.sent[0].split("\n");
  assert.equal(lines[0], "18 farm reward(s) expire unclaimed within 24 h");
  assert.equal(rewardLines(telegram.sent[0]).length, 15);
  assert.match(lines[15], /Reward no 15 /); // the 15 soonest are listed
  assert.equal(lines[16], "+ 3 more");
  assert.equal(lines[17], CLOSING);
  assert.equal(lines.length, 18);
  assert.equal(await stampCount(), 18);
});

test("exactly 15 rows: no '+ N more' line", async () => {
  for (let i = 0; i < 15; i++) await seedItem(NOW + (i + 1) * 60 * 1000);
  const { alert, telegram } = alertWith();
  await alert.run();
  assert.doesNotMatch(telegram.sent[0], /more/);
});

test("a failed send stamps nothing, logs a warning, and the next run retries the same rows", async (t) => {
  t.mock.method(console, "log", () => {});
  await seedItem(NOW + HOUR, { name: "First" });
  await seedItem(NOW + 2 * HOUR, { name: "Second" });
  const telegram = fakeTelegram({ failures: 1 });
  const { alert } = alertWith({ telegram });

  assert.deepEqual(await alert.run(), { due: 2, told: 0 });
  assert.equal(telegram.calls, 1);
  assert.equal(telegram.sent.length, 0);
  assert.equal(await stampCount(), 0);
  const warns = await CodeShopEvent.find({ level: "warn", kind: "claim-alert" }).lean();
  assert.equal(warns.length, 1);
  assert.match(warns[0].msg, /not sent/);
  assert.match(warns[0].msg, /nothing was sent/);

  assert.deepEqual(await alert.run(), { due: 2, told: 2 });
  assert.equal(telegram.sent.length, 1);
  assert.match(telegram.sent[0], /First/);
  assert.match(telegram.sent[0], /Second/);
  assert.equal(await stampCount(), 2);
});

test("no Telegram sender counts as a failed send", async (t) => {
  t.mock.method(console, "log", () => {});
  await seedItem(NOW + HOUR);
  const events = createEvents({ model: CodeShopEvent, now: () => NOW });
  const alert = createClaimAlert({ models: { SoopInventoryItem }, config: fakeConfig(), events, now: () => NOW });
  assert.deepEqual(await alert.run(), { due: 1, told: 0 });
  assert.equal(await stampCount(), 0);
});

test("a second run after a good send says nothing; a new row later is told alone", async () => {
  await seedItem(NOW + HOUR, { name: "Old one" });
  let clock = NOW;
  const { alert, telegram } = alertWith({ now: () => clock });

  assert.deepEqual(await alert.run(), { due: 1, told: 1 });
  assert.deepEqual(await alert.run(), { due: 1, told: 0 });
  assert.equal(telegram.sent.length, 1);

  clock = NOW + 10 * 60 * 1000;
  await seedItem(NOW + 3 * HOUR, { name: "New one" });
  assert.deepEqual(await alert.run(), { due: 2, told: 1 });
  assert.equal(telegram.sent.length, 2);
  assert.doesNotMatch(telegram.sent[1], /Old one/);
  assert.match(telegram.sent[1], /New one/);
});

test("the stamp key is claim-due:<loginId>|<key>", async () => {
  const row = await seedItem(NOW + HOUR, { loginId: "farmer-z", key: "inv-77" });
  assert.equal(stampKey(row), "claim-due:farmer-z|inv-77");
  const { alert } = alertWith();
  await alert.run();
  assert.equal(await CodeShopEvent.countDocuments({ stampKey: "claim-due:farmer-z|inv-77" }), 1);
});
