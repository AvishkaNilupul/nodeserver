// Code shop ingest (utils/codeShop/ingest.js, docs/code-shop/02-ENGINE.md):
// stored reward codes in the farm's inventory -> one ledger row each.
//
// What must hold, because everything after it sells from this ledger:
// - one row per { loginId, itemKey }, and a second run writes nothing;
// - a reward's slot = campaign + name + its order within that login, so the
//   same reward from two logins shares a slot and two copies of one reward
//   name in one campaign do not;
// - a code already in a unit keeps its group/slot, and ingest never changes
//   state, unit or codeHash of an existing row (the one exception: a farm login
//   that was sold has its free codes held — a buyer can see them now);
// - the same code stored twice sells once: the later copy is held;
// - no plaintext code in anything ingest returns, logs or writes.
//
// Real Mongo via mongodb-memory-server: the unique indexes ARE the duplicate
// guards. Codes, logins and campaign names are made up.
process.env.CRED_SECRET ||= "codeshop-test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const CodeStock = require("../models/CodeStock");
const SoopInventoryItem = require("../models/SoopInventoryItem");
const SoopCampaign = require("../models/SoopCampaign");
const SoopAccount = require("../models/SoopAccount");
const secretBox = require("../utils/secretBox");
const slots = require("../utils/codeShop/slots");
const { createIngest } = require("../utils/codeShop/ingest");

const NOW = Date.parse("2026-10-15T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

// Campaign names as the farm stores them: the raw one is what claim.dropsName carries.
const OW_RAW = "오버워치 가을 드롭스 이벤트";
const OW_EN = "Overwatch Autumn Drops";
const DF_RAW = "델타포스 시즌 드롭스";
const DF_EN = "Delta Force Season Drops";

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshopingest"));
  // The duplicate guards are indexes: they must be built, not just declared.
  await Promise.all([CodeStock.init(), SoopInventoryItem.init(), SoopCampaign.init(), SoopAccount.init()]);
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

async function reset() {
  await Promise.all([CodeStock, SoopInventoryItem, SoopCampaign, SoopAccount].map((m) => m.deleteMany({})));
}

// Every code handed out in this file, so the leak scan can look for each one.
const ALL_CODES = new Set();
let codeSeq = 0;
function newCode() {
  codeSeq += 1;
  const code = `QZ${String(codeSeq).padStart(2, "0")}-WXYV-KJHGF-RTPL-MNBV`;
  ALL_CODES.add(code);
  return code;
}

function fakeEvents() {
  const calls = [];
  return {
    calls,
    async log(e) {
      calls.push(e);
      return true;
    },
    async stamp() {
      return true;
    },
    async has() {
      return false;
    },
  };
}

function makeIngest(extra = {}) {
  const events = fakeEvents();
  const ingest = createIngest({ secret: secretBox, now: () => NOW, events, ...extra });
  return { ingest, events };
}

async function campaigns() {
  await SoopCampaign.create([
    {
      dropsIdx: "1001",
      title: OW_EN,
      titleRaw: OW_RAW,
      gameNo: "12",
      startDate: new Date(NOW - 10 * DAY),
      endDate: new Date(NOW + 3 * DAY),
    },
    {
      // Only its English title is what the claim carried.
      dropsIdx: "2002",
      title: DF_EN,
      titleRaw: DF_RAW,
      gameNo: "200",
      startDate: new Date(NOW - 8 * DAY),
      endDate: new Date(NOW + 5 * DAY),
    },
  ]);
}

let keySeq = 0;
// One stored code as utils/soop/inventory.js leaves it: code only in codeEnc.
async function invRow({
  loginId,
  key = "inv-" + ++keySeq,
  gameNo = "12",
  gameName = "Overwatch 2",
  nameRaw = "스프레이",
  name = "Spray",
  dropsName = OW_RAW,
  useExpDate = "2026-10-22 23:59:00",
  sentAt = new Date(NOW - 3 * DAY),
  code,
  codeEnc,
  image = "https://img.example.test/reward.png",
}) {
  const plain = code === undefined ? newCode() : code;
  const doc = await SoopInventoryItem.create({
    loginId,
    key,
    division: "acquired",
    kind: "code",
    hasCode: true,
    codeEnc: codeEnc !== undefined ? codeEnc : secretBox.encrypt(plain),
    gameNo,
    gameName,
    name,
    nameRaw,
    image,
    sentAt,
    expiresAt: slots.parseKst(useExpDate),
    used: true,
    raw: { itemCodeIdx: "idx-" + key, itemName: nameRaw, useExpDate, sendDate: "2026-10-12 10:00:00" },
    claim: { kind: "code", message: "", description: "", gameTitle: "", dropsName },
  });
  return { doc, code: plain };
}

const ledgerOf = (loginId, itemKey) => CodeStock.findOne({ loginId, itemKey }).lean();

// No plaintext code — whole or by its distinctive middle group — anywhere.
function assertNoPlaintext(...values) {
  for (const v of values) {
    const json = JSON.stringify(v);
    for (const code of ALL_CODES) {
      assert.ok(!json.includes(code), "a plaintext code leaked");
      assert.ok(!json.includes(code.replace(/-/g, "")), "a plaintext code leaked (no dashes)");
    }
    assert.ok(!json.includes("KJHGF"), "part of a plaintext code leaked");
  }
}

async function allLedger() {
  return CodeStock.find({}).sort({ loginId: 1, itemKey: 1 }).lean();
}

// ── first run, second run ───────────────────────────────────────────────────

test("first run: every stored code gets one ledger row with its campaign, slot and use-by", async () => {
  await reset();
  await campaigns();
  await SoopAccount.create({ loginId: "farm-a", sold: false });
  // farm-b is not in SoopAccount at all (a removed login): its codes still sell.

  const t1 = new Date(NOW - 4 * DAY);
  const t2 = new Date(NOW - 2 * DAY);
  // Two rewards with the same raw name in one campaign for one login (two steps).
  // Created second-first, so ordinals come from earnedAt, not insert order.
  const a2 = await invRow({ loginId: "farm-a", key: "a2", sentAt: t2 });
  const a1 = await invRow({ loginId: "farm-a", key: "a1", sentAt: t1 });
  await invRow({ loginId: "farm-a", key: "a3", nameRaw: "아이콘", name: "Player Icon", sentAt: t1 });
  // Delta Force: the claim carried the campaign's English title.
  const a4 = await invRow({
    loginId: "farm-a",
    key: "a4",
    gameNo: "200",
    gameName: "Delta Force",
    nameRaw: "무기 스킨",
    name: "Weapon Skin",
    dropsName: DF_EN,
  });
  // A campaign the farm never stored.
  const a5 = await invRow({ loginId: "farm-a", key: "a5", dropsName: "Some Unknown Event" });
  // The same reward on another login.
  const b1 = await invRow({ loginId: "farm-b", key: "b1", sentAt: t1 });

  const { ingest, events } = makeIngest();
  const res = await ingest.run();
  assert.deepEqual(res, { scanned: 6, added: 6, updated: 0, held: 0, skipped: 0 });

  const r1 = await ledgerOf("farm-a", "a1");
  const r2 = await ledgerOf("farm-a", "a2");
  const r3 = await ledgerOf("farm-a", "a3");
  const r4 = await ledgerOf("farm-a", "a4");
  const r5 = await ledgerOf("farm-a", "a5");
  const rb = await ledgerOf("farm-b", "b1");

  // Campaign by raw title.
  assert.equal(r1.campaignIdx, "1001");
  assert.equal(r1.campaignTitle, OW_EN);
  assert.equal(r1.campaignEndAt.toISOString(), new Date(NOW + 3 * DAY).toISOString());
  assert.equal(r1.groupKey, "12:1001");
  assert.equal(r1.gameNo, "12");
  assert.equal(r1.gameName, "Overwatch 2");
  assert.equal(r1.nameRaw, "스프레이");
  assert.equal(r1.name, "Spray");
  assert.equal(r1.image, "https://img.example.test/reward.png");
  assert.equal(String(r1.itemId), String(a1.doc._id));
  assert.equal(r1.earnedAt.toISOString(), t1.toISOString());
  // "2026-10-22 23:59:00" Korea time.
  assert.equal(r1.useBy.toISOString(), "2026-10-22T14:59:00.000Z");
  assert.equal(r1.state, "in_stock");
  assert.equal(r1.codeHash, slots.hashCode(a1.code));
  assert.equal(r1.codeShape, "25:4-4-5-4-4");
  assert.equal(r1.unit, null);
  assert.equal(r1.problem, "");
  assert.equal(r1.history.length, 1);
  assert.equal(r1.history[0].from, "");
  assert.equal(r1.history[0].to, "in_stock");
  assert.equal(r1.history[0].at.getTime(), NOW);

  // Same name twice in one campaign: ordinals 1 (earlier) and 2.
  assert.equal(r1.slotKey, slots.slotKeyOf("12:1001", "스프레이", 1));
  assert.equal(r2.slotKey, slots.slotKeyOf("12:1001", "스프레이", 2));
  assert.notEqual(r1.slotKey, r2.slotKey);
  assert.equal(r2.codeHash, slots.hashCode(a2.code));
  // Another name in the same campaign: its own slot, ordinal 1.
  assert.equal(r3.slotKey, slots.slotKeyOf("12:1001", "아이콘", 1));
  // The same reward on another login is the same slot.
  assert.equal(rb.slotKey, r1.slotKey);
  assert.equal(rb.state, "in_stock");

  // Campaign by English title only.
  assert.equal(r4.campaignIdx, "2002");
  assert.equal(r4.campaignTitle, DF_EN);
  assert.equal(r4.groupKey, "200:2002");
  assert.equal(r4.slotKey, slots.slotKeyOf("200:2002", "무기 스킨", 1));
  assert.equal(r4.codeHash, slots.hashCode(a4.code));

  // No campaign: grouped by the claim's campaign name.
  assert.equal(r5.campaignIdx, "");
  assert.equal(r5.campaignTitle, "Some Unknown Event");
  assert.equal(r5.campaignEndAt, null);
  assert.equal(r5.groupKey, slots.groupKeyOf({ gameNo: "12", campaignName: "Some Unknown Event" }));
  assert.ok(r5.groupKey.startsWith("12:n"));
  assert.equal(r5.slotKey, slots.slotKeyOf(r5.groupKey, "스프레이", 1));
  assert.equal(r5.codeHash, slots.hashCode(a5.code));
  assert.equal(rb.codeHash, slots.hashCode(b1.code));

  // One event, counts only.
  assert.equal(events.calls.length, 1);
  assert.equal(events.calls[0].kind, "ingest");
  assert.equal(events.calls[0].level, "info");
  assert.equal(events.calls[0].msg, "6 new codes in stock");
  assert.equal(events.calls[0].data.added, 6);
  assert.deepEqual(events.calls[0].data.byGame, { 12: 5, 200: 1 });

  // Second run: nothing to do, nothing written, no event.
  const before = await allLedger();
  const again = await ingest.run();
  assert.deepEqual(again, { scanned: 6, added: 0, updated: 0, held: 0, skipped: 0 });
  assert.deepEqual(await allLedger(), before);
  assert.equal(events.calls.length, 1);

  assertNoPlaintext(res, again, events.calls, before);
});

test("nothing stored: zero counts and no event", async () => {
  await reset();
  // A code-less row and a link reward are not code stock.
  await SoopInventoryItem.create({ loginId: "farm-a", key: "x1", kind: "code", hasCode: false });
  await SoopInventoryItem.create({ loginId: "farm-a", key: "x2", kind: "link", hasCode: true, codeEnc: secretBox.encrypt("https://example.test/redeem") });
  const { ingest, events } = makeIngest();
  assert.deepEqual(await ingest.run(), { scanned: 0, added: 0, updated: 0, held: 0, skipped: 0 });
  assert.equal(events.calls.length, 0);
  assert.equal(await CodeStock.countDocuments(), 0);
});

test("two callers at once share one run", async () => {
  await reset();
  await invRow({ loginId: "farm-a", key: "c1" });
  const { ingest, events } = makeIngest();
  const [x, y] = await Promise.all([ingest.run(), ingest.run()]);
  assert.equal(x, y);
  assert.equal(x.added, 1);
  assert.equal(events.calls.length, 1);
  assert.equal(await CodeStock.countDocuments(), 1);
});

// ── existing rows ───────────────────────────────────────────────────────────

test("refresh: metadata follows the inventory; state, unit and codeHash never move; group/slot only while in_stock", async () => {
  await reset();
  // No campaign stored yet: both rows group by the claim's name.
  const s = await invRow({ loginId: "farm-a", key: "s1", dropsName: "Late Event" });
  const u = await invRow({ loginId: "farm-a", key: "u1", dropsName: "Late Event", nameRaw: "칭호", name: "Title" });
  const { ingest } = makeIngest();
  assert.equal((await ingest.run()).added, 2);

  const s0 = await ledgerOf("farm-a", "s1");
  const u0 = await ledgerOf("farm-a", "u1");
  const nameGroup = slots.groupKeyOf({ gameNo: "12", campaignName: "Late Event" });
  assert.equal(s0.groupKey, nameGroup);
  assert.equal(u0.groupKey, nameGroup);

  // u1 goes into a unit (what units.build does).
  const unitId = new mongoose.Types.ObjectId();
  await CodeStock.updateOne({ _id: u0._id }, { $set: { state: "in_unit", unit: unitId, unitStatus: "available" } });

  // Now the campaign is known, the glossary improved, the use-by moved, and
  // SOOP re-listed s1 under a new id — and its stored code changed.
  await SoopCampaign.create({
    dropsIdx: "3003",
    title: "Late Event EN",
    titleRaw: "Late Event",
    gameNo: "12",
    startDate: new Date(NOW - 20 * DAY),
    endDate: new Date(NOW + 1 * DAY),
  });
  await SoopInventoryItem.deleteOne({ _id: s.doc._id });
  const s2 = await invRow({
    loginId: "farm-a",
    key: "s1",
    dropsName: "Late Event",
    name: "Spray (better)",
    image: "https://img.example.test/new.png",
    useExpDate: "2026-10-25 23:59:00",
  });
  await SoopInventoryItem.updateOne(
    { _id: u.doc._id },
    { $set: { name: "Title (better)", "raw.useExpDate": "2026-10-26 23:59:00" } },
  );

  const res = await ingest.run();
  assert.deepEqual(res, { scanned: 2, added: 0, updated: 2, held: 0, skipped: 0 });

  const s1 = await ledgerOf("farm-a", "s1");
  assert.equal(String(s1.itemId), String(s2.doc._id));
  assert.equal(s1.name, "Spray (better)");
  assert.equal(s1.image, "https://img.example.test/new.png");
  assert.equal(s1.useBy.toISOString(), "2026-10-25T14:59:00.000Z");
  assert.equal(s1.campaignIdx, "3003");
  assert.equal(s1.campaignTitle, "Late Event EN");
  assert.equal(s1.campaignEndAt.toISOString(), new Date(NOW + 1 * DAY).toISOString());
  // in_stock: it moves to the campaign's group and slot.
  assert.equal(s1.groupKey, "12:3003");
  assert.equal(s1.slotKey, slots.slotKeyOf("12:3003", "스프레이", 1));
  // ...but never its state or hash (the ledger keeps the code it first read).
  assert.equal(s1.state, "in_stock");
  assert.equal(s1.codeHash, s0.codeHash);
  assert.notEqual(s1.codeHash, slots.hashCode(s2.code));
  assert.equal(s1.codeShape, s0.codeShape);
  assert.deepEqual(s1.history, s0.history);

  const u1 = await ledgerOf("farm-a", "u1");
  assert.equal(u1.name, "Title (better)");
  assert.equal(u1.useBy.toISOString(), "2026-10-26T14:59:00.000Z");
  assert.equal(u1.campaignIdx, "3003");
  assert.equal(u1.campaignTitle, "Late Event EN");
  // In a unit: it keeps the group and slot it is on sale under.
  assert.equal(u1.groupKey, u0.groupKey);
  assert.equal(u1.slotKey, u0.slotKey);
  assert.equal(u1.state, "in_unit");
  assert.equal(String(u1.unit), String(unitId));
  assert.equal(u1.unitStatus, "available");
  assert.equal(u1.codeHash, u0.codeHash);

  // And settled again.
  const before = await allLedger();
  assert.deepEqual(await ingest.run(), { scanned: 2, added: 0, updated: 0, held: 0, skipped: 0 });
  assert.deepEqual(await allLedger(), before);
  assertNoPlaintext(res, before);
});

// ── codes that cannot go on sale ────────────────────────────────────────────

test("a code that reads as empty is skipped, every run, and never gets a row", async () => {
  await reset();
  await invRow({ loginId: "farm-a", key: "blank", code: "   " }); // decrypts to whitespace
  await invRow({ loginId: "farm-a", key: "nothing", codeEnc: "" }); // hasCode but no ciphertext
  await invRow({ loginId: "farm-a", key: "broken", codeEnc: "enc:v1:AAAA:BBBB:CCCC" }); // will not decrypt
  await invRow({ loginId: "farm-a", key: "good" });
  const { ingest, events } = makeIngest();

  assert.deepEqual(await ingest.run(), { scanned: 4, added: 1, updated: 0, held: 0, skipped: 3 });
  assert.deepEqual(await ingest.run(), { scanned: 4, added: 0, updated: 0, held: 0, skipped: 3 });
  const rows = await allLedger();
  assert.deepEqual(rows.map((r) => r.itemKey), ["good"]);
  assert.equal(events.calls.length, 1);
  assert.equal(events.calls[0].msg, "1 new code in stock");
});

test("a decrypt that throws is a skip, not a failed run", async () => {
  await reset();
  await invRow({ loginId: "farm-a", key: "t1" });
  const { ingest } = makeIngest({
    secret: {
      decrypt() {
        throw new Error("bad key");
      },
    },
  });
  assert.deepEqual(await ingest.run(), { scanned: 1, added: 0, updated: 0, held: 0, skipped: 1 });
  assert.equal(await CodeStock.countDocuments(), 0);
});

test("the same code on two rows: the earlier sells, the later is held without a hash", async () => {
  await reset();
  const code = newCode();
  await invRow({ loginId: "farm-b", key: "late", code, sentAt: new Date(NOW - 1 * DAY) });
  await invRow({ loginId: "farm-a", key: "early", code, sentAt: new Date(NOW - 2 * DAY) });
  const { ingest, events } = makeIngest();

  const res = await ingest.run();
  assert.deepEqual(res, { scanned: 2, added: 1, updated: 0, held: 1, skipped: 0 });

  const early = await ledgerOf("farm-a", "early");
  const late = await ledgerOf("farm-b", "late");
  assert.equal(early.state, "in_stock");
  assert.equal(early.codeHash, slots.hashCode(code));
  assert.equal(late.state, "held");
  assert.equal(late.codeHash, "");
  assert.equal(late.codeShape, "25:4-4-5-4-4");
  assert.equal(late.problem, "same code as another stored code");
  assert.equal(late.history.length, 1);
  assert.equal(late.history[0].to, "held");
  // Its slot is still known, for the panel.
  assert.equal(late.slotKey, early.slotKey);

  // A later copy against a code already in the ledger (the index catches it).
  await invRow({ loginId: "farm-c", key: "later", code, sentAt: new Date(NOW - 1000) });
  const res2 = await ingest.run();
  assert.deepEqual(res2, { scanned: 3, added: 0, updated: 0, held: 1, skipped: 0 });
  const later = await ledgerOf("farm-c", "later");
  assert.equal(later.state, "held");
  assert.equal(later.codeHash, "");
  assert.equal(later.problem, "same code as another stored code");

  // Held rows are existing rows from now on: nothing more happens.
  const before = await allLedger();
  assert.deepEqual(await ingest.run(), { scanned: 3, added: 0, updated: 0, held: 0, skipped: 0 });
  assert.deepEqual(await allLedger(), before);
  assert.equal(events.calls.length, 1); // only the run that added a code
  assertNoPlaintext(res, res2, events.calls, before);
});

test("a code past its use-by is stored as expired", async () => {
  await reset();
  // 2026-10-14 08:00 KST = 2026-10-13T23:00Z, before NOW.
  await invRow({ loginId: "farm-a", key: "old", useExpDate: "2026-10-14 08:00:00" });
  // Exactly NOW (2026-10-15 09:00 KST) is past too: useBy <= now.
  await invRow({ loginId: "farm-a", key: "edge", useExpDate: "2026-10-15 09:00:00" });
  // One second later is still good.
  await invRow({ loginId: "farm-a", key: "fresh", useExpDate: "2026-10-15 09:00:01" });
  const { ingest, events } = makeIngest();

  assert.deepEqual(await ingest.run(), { scanned: 3, added: 3, updated: 0, held: 0, skipped: 0 });
  assert.equal((await ledgerOf("farm-a", "old")).state, "expired");
  assert.equal((await ledgerOf("farm-a", "edge")).state, "expired");
  assert.equal((await ledgerOf("farm-a", "fresh")).state, "in_stock");
  const old = await ledgerOf("farm-a", "old");
  assert.equal(old.useBy.toISOString(), "2026-10-13T23:00:00.000Z");
  assert.ok(old.codeHash, "an expired row still guards its code");
  assert.equal(old.history[0].to, "expired");
  assert.equal(events.calls.length, 1);
  assert.equal(events.calls[0].msg, "3 new codes stored: 1 in stock, 2 already past their use-by");
  assert.equal(events.calls[0].data.expired, 2);
  assert.equal(events.calls[0].data.inStock, 1);
});

test("a sold farm login: its codes are not ingested and its free ones are held", async () => {
  await reset();
  await SoopAccount.create({ loginId: "farm-s", sold: false });
  await invRow({ loginId: "farm-s", key: "free" });
  await invRow({ loginId: "farm-s", key: "sold-in-unit", nameRaw: "칭호" });
  await invRow({ loginId: "farm-k", key: "keep" });
  const { ingest, events } = makeIngest();
  assert.equal((await ingest.run()).added, 3);

  const inUnit = await ledgerOf("farm-s", "sold-in-unit");
  const unitId = new mongoose.Types.ObjectId();
  await CodeStock.updateOne({ _id: inUnit._id }, { $set: { state: "in_unit", unit: unitId, unitStatus: "available" } });

  // The login goes to a buyer; its inventory gets one more code and a new name.
  await SoopAccount.updateOne({ loginId: "farm-s" }, { $set: { sold: true } });
  await invRow({ loginId: "farm-s", key: "after-sale" });
  await SoopInventoryItem.updateOne({ loginId: "farm-s", key: "free" }, { $set: { name: "Renamed" } });

  const res = await ingest.run();
  assert.deepEqual(res, { scanned: 4, added: 0, updated: 0, held: 1, skipped: 3 });

  const free = await ledgerOf("farm-s", "free");
  assert.equal(free.state, "held");
  assert.equal(free.problem, "its farm login was sold");
  assert.equal(free.name, "Spray", "a sold login's rows are skipped, not refreshed");
  assert.ok(free.codeHash, "the hash stays: the code must never be stored again");
  assert.equal(free.history.length, 2);
  assert.equal(free.history[1].from, "in_stock");
  assert.equal(free.history[1].to, "held");
  assert.equal(free.history[1].why, "its farm login was sold");

  const stillInUnit = await ledgerOf("farm-s", "sold-in-unit");
  assert.equal(stillInUnit.state, "in_unit");
  assert.equal(String(stillInUnit.unit), String(unitId));
  assert.equal(await ledgerOf("farm-s", "after-sale"), null);
  assert.equal((await ledgerOf("farm-k", "keep")).state, "in_stock");
  assert.equal(events.calls.length, 1, "no event without a new code");

  // Held stays held.
  assert.deepEqual(await ingest.run(), { scanned: 4, added: 0, updated: 0, held: 0, skipped: 3 });
  assert.equal((await ledgerOf("farm-s", "free")).state, "held");
});

// ── another writer at the same time ─────────────────────────────────────────

// The real model, with another writer slipping one row in right before our
// first insert.
function racingModel(intrude) {
  let done = false;
  return {
    find: (...a) => CodeStock.find(...a),
    updateMany: (...a) => CodeStock.updateMany(...a),
    bulkWrite: (...a) => CodeStock.bulkWrite(...a),
    insertMany: async (docs, opts) => {
      if (!done && docs.length) {
        done = true;
        await CodeStock.create(intrude(docs[0]));
      }
      return CodeStock.insertMany(docs, opts);
    },
  };
}

test("another writer stored the same identity first: that row is skipped, the rest go in", async () => {
  await reset();
  await invRow({ loginId: "farm-a", key: "r1", sentAt: new Date(NOW - 3 * DAY) });
  await invRow({ loginId: "farm-a", key: "r2", sentAt: new Date(NOW - 2 * DAY) });
  const model = racingModel((d) => ({ loginId: d.loginId, itemKey: d.itemKey, codeHash: d.codeHash }));
  const { ingest, events } = makeIngest({ models: { CodeStock: model } });

  const res = await ingest.run();
  assert.deepEqual(res, { scanned: 2, added: 1, updated: 0, held: 0, skipped: 1 });
  assert.equal(await CodeStock.countDocuments(), 2);
  assert.equal((await ledgerOf("farm-a", "r2")).state, "in_stock");
  assert.equal(events.calls[0].msg, "1 new code in stock");
});

test("another writer stored the same code under another identity first: ours is held", async () => {
  await reset();
  await invRow({ loginId: "farm-a", key: "h1", sentAt: new Date(NOW - 3 * DAY) });
  await invRow({ loginId: "farm-a", key: "h2", sentAt: new Date(NOW - 2 * DAY) });
  const model = racingModel((d) => ({ loginId: "farm-z", itemKey: "elsewhere", codeHash: d.codeHash }));
  const { ingest } = makeIngest({ models: { CodeStock: model } });

  const res = await ingest.run();
  assert.deepEqual(res, { scanned: 2, added: 1, updated: 0, held: 1, skipped: 0 });
  const h1 = await ledgerOf("farm-a", "h1");
  assert.equal(h1.state, "held");
  assert.equal(h1.codeHash, "");
  assert.equal(h1.problem, "same code as another stored code");
  assert.equal((await ledgerOf("farm-a", "h2")).state, "in_stock");
});
