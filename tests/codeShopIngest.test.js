// Code shop ingest (utils/codeShop/ingest.js, docs/code-shop/02-ENGINE.md):
// stored reward codes in the farm's inventory -> one ledger row each.
//
// What must hold, because everything after it sells from this ledger:
// - one row per { loginId, itemKey }, and a second run writes nothing;
// - a reward's slot = campaign + name + its order within that login, so the
//   same reward from two logins shares a slot and two copies of one reward
//   name in one campaign do not;
// - a code already in a unit keeps its group/slot, and ingest changes state,
//   unit or codeHash of an existing row only for the documented reasons: a farm
//   login that was sold has its free codes held (a buyer can see them now), and
//   R9 (05-REVIEW-FIXES.md) — a stored code that changed re-keys a free row or
//   pulls the unit on sale that holds the old one, a use-by that moved beyond
//   the lead brings an expiring/expired row back, and a code shown in the farm
//   panel is held;
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
const SoopActivity = require("../models/SoopActivity");
const SuppliedAccount = require("../models/SuppliedAccount");
const secretBox = require("../utils/secretBox");
const slots = require("../utils/codeShop/slots");
const { createIngest } = require("../utils/codeShop/ingest");
const { releasedWhy } = require("../utils/codeShop/held");

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
  await Promise.all([CodeStock.init(), SoopInventoryItem.init(), SoopCampaign.init(), SoopAccount.init(), SuppliedAccount.init()]);
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

async function reset() {
  await Promise.all([CodeStock, SoopInventoryItem, SoopCampaign, SoopAccount, SoopActivity, SuppliedAccount].map((m) => m.deleteMany({})));
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
  assert.deepEqual(res, { scanned: 6, added: 6, updated: 0, held: 0, skipped: 0, rehashed: 0, revived: 0 });

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
  assert.deepEqual(again, { scanned: 6, added: 0, updated: 0, held: 0, skipped: 0, rehashed: 0, revived: 0 });
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
  assert.deepEqual(await ingest.run(), { scanned: 0, added: 0, updated: 0, held: 0, skipped: 0, rehashed: 0, revived: 0 });
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
  // SOOP re-listed s1 under a new id — and its stored code changed (R9).
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
  assert.deepEqual(res, { scanned: 2, added: 0, updated: 2, held: 0, skipped: 0, rehashed: 1, revived: 0 });

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
  // Free stock follows the code the farm holds now (R9); the state stays.
  assert.equal(s1.state, "in_stock");
  assert.equal(s1.codeHash, slots.hashCode(s2.code));
  assert.notEqual(s1.codeHash, s0.codeHash);
  assert.equal(s1.codeShape, slots.codeShape(s2.code));
  assert.equal(s1.history.length, 2);
  assert.deepEqual(
    { from: s1.history[1].from, to: s1.history[1].to, why: s1.history[1].why },
    { from: "in_stock", to: "in_stock", why: "its stored code changed (the reward was re-issued)" },
  );

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
  assert.deepEqual(await ingest.run(), { scanned: 2, added: 0, updated: 0, held: 0, skipped: 0, rehashed: 0, revived: 0 });
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

  assert.deepEqual(await ingest.run(), { scanned: 4, added: 1, updated: 0, held: 0, skipped: 3, rehashed: 0, revived: 0 });
  assert.deepEqual(await ingest.run(), { scanned: 4, added: 0, updated: 0, held: 0, skipped: 3, rehashed: 0, revived: 0 });
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
  assert.deepEqual(await ingest.run(), { scanned: 1, added: 0, updated: 0, held: 0, skipped: 1, rehashed: 0, revived: 0 });
  assert.equal(await CodeStock.countDocuments(), 0);
});

test("the same code on two rows: the earlier sells, the later is held without a hash", async () => {
  await reset();
  const code = newCode();
  await invRow({ loginId: "farm-b", key: "late", code, sentAt: new Date(NOW - 1 * DAY) });
  await invRow({ loginId: "farm-a", key: "early", code, sentAt: new Date(NOW - 2 * DAY) });
  const { ingest, events } = makeIngest();

  const res = await ingest.run();
  assert.deepEqual(res, { scanned: 2, added: 1, updated: 0, held: 1, skipped: 0, rehashed: 0, revived: 0 });

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
  assert.deepEqual(res2, { scanned: 3, added: 0, updated: 0, held: 1, skipped: 0, rehashed: 0, revived: 0 });
  const later = await ledgerOf("farm-c", "later");
  assert.equal(later.state, "held");
  assert.equal(later.codeHash, "");
  assert.equal(later.problem, "same code as another stored code");

  // Held rows are existing rows from now on: nothing more happens.
  const before = await allLedger();
  assert.deepEqual(await ingest.run(), { scanned: 3, added: 0, updated: 0, held: 0, skipped: 0, rehashed: 0, revived: 0 });
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

  assert.deepEqual(await ingest.run(), { scanned: 3, added: 3, updated: 0, held: 0, skipped: 0, rehashed: 0, revived: 0 });
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
  assert.deepEqual(res, { scanned: 4, added: 0, updated: 0, held: 1, skipped: 3, rehashed: 0, revived: 0 });

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
  assert.deepEqual(await ingest.run(), { scanned: 4, added: 0, updated: 0, held: 0, skipped: 3, rehashed: 0, revived: 0 });
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
  assert.deepEqual(res, { scanned: 2, added: 1, updated: 0, held: 0, skipped: 1, rehashed: 0, revived: 0 });
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
  assert.deepEqual(res, { scanned: 2, added: 1, updated: 0, held: 1, skipped: 0, rehashed: 0, revived: 0 });
  const h1 = await ledgerOf("farm-a", "h1");
  assert.equal(h1.state, "held");
  assert.equal(h1.codeHash, "");
  assert.equal(h1.problem, "same code as another stored code");
  assert.equal((await ledgerOf("farm-a", "h2")).state, "in_stock");
});

// ── R9: a stored code that changed ──────────────────────────────────────────

// Events that stamp like the real ones (once per key).
function stampingEvents() {
  const calls = [];
  const stamps = new Set();
  return {
    calls,
    stamps,
    async log(e) {
      calls.push(e);
      return true;
    },
    async stamp(key) {
      if (stamps.has(key)) return false;
      stamps.add(key);
      return true;
    },
    async has(key) {
      return stamps.has(key);
    },
  };
}

// The farm re-claimed the reward: the same inventory row now holds another code.
async function reissue(loginId, key) {
  const code = newCode();
  await SoopInventoryItem.updateOne({ loginId, key }, { $set: { codeEnc: secretBox.encrypt(code) } });
  return code;
}

async function unitDoc(fields = {}) {
  return SuppliedAccount.create({
    offer: new mongoose.Types.ObjectId(),
    login: "cs-unit-" + ++keySeq,
    password: secretBox.encrypt("1) A = X"),
    status: "available",
    ...fields,
  });
}

async function intoUnit(loginId, itemKey, unit, extra = {}) {
  await CodeStock.updateOne(
    { loginId, itemKey },
    { $set: { state: "in_unit", unit: unit._id, product: new mongoose.Types.ObjectId(), offer: unit.offer, unitStatus: unit.status, ...extra } },
  );
}

test("changed code: free rows (in_stock, expiring, expired, held for a failed code check) follow the new code", async () => {
  await reset();
  // f2 stops working within the lead (36 h), f3 has stopped: they stay where they are.
  const useBy = { f2: "2026-10-15 20:00:00", f3: "2026-10-14 08:00:00" };
  for (const k of ["f1", "f2", "f3", "f4", "f5"]) await invRow({ loginId: "farm-a", key: k, nameRaw: "n-" + k, useExpDate: useBy[k] });
  const { ingest } = makeIngest();
  assert.equal((await ingest.run()).added, 5);
  await CodeStock.updateOne({ itemKey: "f2" }, { $set: { state: "expiring" } });
  await CodeStock.updateOne({ itemKey: "f3" }, { $set: { state: "expired" } });
  await CodeStock.updateOne({ itemKey: "f4" }, { $set: { state: "held", problem: "stored code is missing or changed" } });
  await CodeStock.updateOne({ itemKey: "f5" }, { $set: { state: "held", problem: "same code as another stored code" } });
  const old5 = await ledgerOf("farm-a", "f5");
  const fresh = {};
  for (const k of ["f1", "f2", "f3", "f4", "f5"]) fresh[k] = await reissue("farm-a", k);

  const res = await ingest.run();
  assert.equal(res.rehashed, 4);
  for (const k of ["f1", "f2", "f3", "f4"]) {
    const r = await ledgerOf("farm-a", k);
    assert.equal(r.codeHash, slots.hashCode(fresh[k]), k);
    assert.equal(r.history.at(-1).why, "its stored code changed (the reward was re-issued)", k);
  }
  assert.equal((await ledgerOf("farm-a", "f1")).state, "in_stock");
  assert.equal((await ledgerOf("farm-a", "f2")).state, "expiring");
  assert.equal((await ledgerOf("farm-a", "f3")).state, "expired");
  assert.equal((await ledgerOf("farm-a", "f4")).state, "held", "still held: the owner releases it");
  const f5 = await ledgerOf("farm-a", "f5");
  assert.equal(f5.codeHash, old5.codeHash, "held for another reason: unchanged");
  assert.equal(f5.state, "held");

  // Settled: the next run rehashes nothing (and decrypts nothing new).
  const again = await ingest.run();
  assert.equal(again.rehashed, 0);
  assertNoPlaintext(res, again, await allLedger());
});

test("changed code: an in_unit row of a unit on sale pulls the unit; its other codes go back to stock", async () => {
  await reset();
  for (const k of ["u1", "u2", "u3"]) await invRow({ loginId: "farm-a", key: k, nameRaw: "n-" + k });
  const events = stampingEvents();
  const ingest = createIngest({ secret: secretBox, now: () => NOW, events });
  await ingest.run();
  const unit = await unitDoc();
  for (const k of ["u1", "u2", "u3"]) await intoUnit("farm-a", k, unit);
  const fresh = await reissue("farm-a", "u2");
  const before = await ledgerOf("farm-a", "u1");

  const res = await ingest.run();
  assert.equal(res.rehashed, 1);
  const u = await SuppliedAccount.findById(unit._id).lean();
  assert.equal(u.status, "removed");
  assert.equal(u.note, "code unit — a stored code in it changed");
  assert.equal(u.password, unit.password, "the unit's text is never rewritten");

  const changed = await ledgerOf("farm-a", "u2");
  assert.equal(changed.state, "in_stock");
  assert.equal(changed.unit, null);
  assert.equal(changed.product, null);
  assert.equal(changed.codeHash, slots.hashCode(fresh));
  assert.deepEqual([changed.history.at(-1).from, changed.history.at(-1).to], ["in_unit", "in_stock"]);
  for (const k of ["u1", "u3"]) {
    const r = await ledgerOf("farm-a", k);
    assert.equal(r.state, "in_stock", k);
    assert.equal(r.unit, null, k);
    assert.equal(r.unitStatus, "", k);
    assert.equal(r.history.at(-1).why, "its unit was pulled: another code in it changed", k);
  }
  assert.equal((await ledgerOf("farm-a", "u1")).codeHash, before.codeHash, "an unchanged code keeps its fingerprint");
  assert.ok(events.calls.some((e) => e.kind === "code-changed" && e.level === "warn"));
  assertNoPlaintext(res, events.calls);
});

test("changed code: a unit in a vault, delivered, sold or already pulled is not touched; told once", async () => {
  await reset();
  for (const k of ["v1", "d1", "s1", "x1", "g1"]) await invRow({ loginId: "farm-a", key: k, nameRaw: "n-" + k });
  const events = stampingEvents();
  const ingest = createIngest({ secret: secretBox, now: () => NOW, events });
  await ingest.run();
  const vault = await unitDoc({ status: "fed", market: "ggsel", fedAt: new Date(NOW - DAY) });
  const delivered = await unitDoc({ deliveredAt: new Date(NOW - DAY) });
  const soldUnit = await unitDoc({ status: "sold" });
  const wasFed = await unitDoc();
  await intoUnit("farm-a", "v1", vault, { wasFed: true });
  await intoUnit("farm-a", "d1", delivered);
  await intoUnit("farm-a", "x1", wasFed, { wasFed: true });
  await CodeStock.updateOne({ itemKey: "s1" }, { $set: { state: "sold", unit: soldUnit._id, unitStatus: "sold" } });
  // A unit that is gone.
  await intoUnit("farm-a", "g1", { _id: new mongoose.Types.ObjectId(), offer: null, status: "available" });
  for (const k of ["v1", "d1", "s1", "x1", "g1"]) await reissue("farm-a", k);
  const ledgerBefore = await allLedger();
  const unitsBefore = await SuppliedAccount.find({}).sort({ _id: 1 }).lean();

  const res = await ingest.run();
  assert.equal(res.rehashed, 0);
  assert.deepEqual(await allLedger(), ledgerBefore, "no ledger row moves");
  assert.deepEqual(await SuppliedAccount.find({}).sort({ _id: 1 }).lean(), unitsBefore, "no unit is pulled");
  const told = events.calls.filter((e) => e.kind === "code-changed");
  assert.equal(told.length, 5);
  assert.ok(told.some((e) => /its buyer has the old code/.test(e.msg)));
  assert.ok(told.filter((e) => /the bundle still holds the old code/.test(e.msg)).length === 4);

  await ingest.run();
  assert.equal(events.calls.filter((e) => e.kind === "code-changed").length, 5, "told once per row and new code");
  assertNoPlaintext(res, events.calls);
});

test("changed code: a new code already in the ledger makes the row a held duplicate", async () => {
  await reset();
  const shared = newCode();
  await invRow({ loginId: "farm-a", key: "k1", nameRaw: "n1" });
  await invRow({ loginId: "farm-b", key: "k2", nameRaw: "n2", code: shared });
  const { ingest } = makeIngest();
  await ingest.run();
  await SoopInventoryItem.updateOne({ loginId: "farm-a", key: "k1" }, { $set: { codeEnc: secretBox.encrypt(shared) } });

  const res = await ingest.run();
  assert.equal(res.held, 1);
  assert.equal(res.rehashed, 0);
  const k1 = await ledgerOf("farm-a", "k1");
  assert.equal(k1.state, "held");
  assert.equal(k1.problem, "same code as another stored code");
  assert.equal(k1.codeHash, "");
  assert.equal((await ledgerOf("farm-b", "k2")).codeHash, slots.hashCode(shared));
});

test("an unchanged stored code is decrypted once per process, a changed one again", async () => {
  await reset();
  for (const k of ["c1", "c2"]) await invRow({ loginId: "farm-a", key: k, nameRaw: "n-" + k });
  let calls = 0;
  const counting = {
    decrypt(v) {
      calls += 1;
      return secretBox.decrypt(v);
    },
  };
  const { ingest } = makeIngest({ secret: counting });
  await ingest.run();
  assert.equal(calls, 2, "new rows");
  await ingest.run();
  assert.equal(calls, 4, "first look at the existing rows in this process");
  await ingest.run();
  assert.equal(calls, 4, "unchanged ciphertext: no decrypt");
  await reissue("farm-a", "c1");
  assert.equal((await ingest.run()).rehashed, 1);
  assert.equal(calls, 5);
});

// ── R9: use-by moved beyond the lead ────────────────────────────────────────

test("expiring / expired rows whose use-by moved beyond the lead go back to stock; never a vault row or a sold login's", async () => {
  await reset();
  // Lead is 36 h (default). NOW = 2026-10-15T00:00Z.
  for (const k of ["e1", "e2", "e3", "e4", "e5", "e6"]) await invRow({ loginId: k === "e5" ? "farm-s" : "farm-a", key: k, nameRaw: "n-" + k });
  await SoopAccount.create({ loginId: "farm-s", sold: false });
  const { ingest, events } = makeIngest();
  await ingest.run();
  const unit = new mongoose.Types.ObjectId();
  await CodeStock.updateOne({ itemKey: "e1" }, { $set: { state: "expiring" } });
  await CodeStock.updateOne({ itemKey: "e2" }, { $set: { state: "expired", unit, unitStatus: "removed", product: new mongoose.Types.ObjectId() } });
  await CodeStock.updateOne({ itemKey: "e3" }, { $set: { state: "expiring", wasFed: true } });
  await CodeStock.updateOne({ itemKey: "e4" }, { $set: { state: "expiring" } });
  await CodeStock.updateOne({ itemKey: "e5" }, { $set: { state: "expiring" } });
  await CodeStock.updateOne({ itemKey: "e6" }, { $set: { state: "expiring" } });
  // e1, e2, e3, e5: the farm says the code is good for weeks; e4: within the lead.
  for (const k of ["e1", "e2", "e3", "e5"]) await SoopInventoryItem.updateOne({ key: k }, { $set: { "raw.useExpDate": "2026-11-30 23:59:00" } });
  await SoopInventoryItem.updateOne({ key: "e4" }, { $set: { "raw.useExpDate": "2026-10-16 09:00:00" } });
  // e6 keeps its use-by (2026-10-22): already beyond the lead.
  // farm-s is sold now: its rows never come back on sale.
  await SoopAccount.updateOne({ loginId: "farm-s" }, { $set: { sold: true } });

  const res = await ingest.run();
  assert.equal(res.revived, 3);
  for (const k of ["e1", "e2", "e6"]) {
    const r = await ledgerOf("farm-a", k);
    assert.equal(r.state, "in_stock", k);
    assert.equal(r.unit, null, k);
    assert.equal(r.product, null, k);
    assert.equal(r.unitStatus, "", k);
    assert.equal(r.history.at(-1).why, "its use-by moved beyond the lead time", k);
  }
  assert.equal((await ledgerOf("farm-a", "e3")).state, "expiring", "was in a vault: never back");
  assert.equal((await ledgerOf("farm-a", "e4")).state, "expiring", "still within the lead");
  assert.equal((await ledgerOf("farm-s", "e5")).state, "expiring", "a sold login's row is never revived");
  assert.ok(events.calls.some((e) => /back in stock: their use-by moved/.test(e.msg)));
  assert.equal((await ingest.run()).revived, 0, "once");
});

test("revival uses the configured lead", async () => {
  await reset();
  await invRow({ loginId: "farm-a", key: "l1", useExpDate: "2026-10-20 09:00:00" }); // 5 days out
  const config = { get: async () => ({ expiryLeadHours: 24 * 7 }) };
  const { ingest } = makeIngest({ config });
  await ingest.run();
  await CodeStock.updateOne({ itemKey: "l1" }, { $set: { state: "expiring" } });
  assert.equal((await ingest.run()).revived, 0, "5 days is inside a 7-day lead");
  const short = makeIngest({ config: { get: async () => ({ expiryLeadHours: 24 }) } });
  assert.equal((await short.ingest.run()).revived, 1);
});

// ── R9: a code shown in the farm panel ──────────────────────────────────────

async function revealed(itemId, at) {
  await SoopActivity.create({ at: new Date(at), kind: "reveal", msg: "owner revealed the code of inventory item " + itemId, data: { itemId: String(itemId), admin: "owner" } });
}

test("a free code revealed in the farm panel is held; a code in a unit is left to its bundle", async () => {
  await reset();
  const a = await invRow({ loginId: "farm-a", key: "r1", nameRaw: "n1" });
  const b = await invRow({ loginId: "farm-a", key: "r2", nameRaw: "n2" });
  const c = await invRow({ loginId: "farm-a", key: "r3", nameRaw: "n3" });
  const { ingest, events } = makeIngest();
  await ingest.run();
  const unit = await unitDoc();
  await intoUnit("farm-a", "r2", unit);
  await revealed(a.doc._id, NOW - 1000);
  await revealed(b.doc._id, NOW - 1000);
  // Other activity and a malformed id are ignored.
  await SoopActivity.create({ at: new Date(NOW), kind: "claim", data: { itemId: String(c.doc._id) } });
  await SoopActivity.create({ at: new Date(NOW), kind: "reveal", data: { itemId: "not-an-id" } });

  const res = await ingest.run();
  assert.equal(res.held, 1);
  const r1 = await ledgerOf("farm-a", "r1");
  assert.equal(r1.state, "held");
  assert.equal(r1.problem, "its code was shown in the farm panel");
  assert.deepEqual([r1.history.at(-1).from, r1.history.at(-1).to], ["in_stock", "held"]);
  assert.equal((await ledgerOf("farm-a", "r2")).state, "in_unit");
  assert.equal((await ledgerOf("farm-a", "r3")).state, "in_stock");
  assert.ok(events.calls.some((e) => e.kind === "code-held" && e.level === "warn"));
  assert.equal((await ingest.run()).held, 0, "held once");
});

test("a code the owner released after its reveal stays in stock; a newer reveal holds it again", async () => {
  await reset();
  const a = await invRow({ loginId: "farm-a", key: "v1" });
  const { ingest } = makeIngest();
  await ingest.run();
  await revealed(a.doc._id, NOW - 5000);
  // As held.js leaves it: released for exactly this, after the reveal.
  await CodeStock.updateOne(
    { itemKey: "v1" },
    { $push: { history: { at: new Date(NOW - 1000), from: "held", to: "in_stock", why: releasedWhy("its code was shown in the farm panel") } } },
  );
  assert.equal((await ingest.run()).held, 0);
  assert.equal((await ledgerOf("farm-a", "v1")).state, "in_stock");

  // A release for another problem vouches for nothing about a reveal.
  const b = await invRow({ loginId: "farm-a", key: "v2", nameRaw: "other" });
  await ingest.run();
  await revealed(b.doc._id, NOW - 5000);
  await CodeStock.updateOne(
    { itemKey: "v2" },
    { $push: { history: { at: new Date(NOW - 1000), from: "held", to: "in_stock", why: releasedWhy("its stock row is gone") } } },
  );
  assert.equal((await ingest.run()).held, 1);
  assert.equal((await ledgerOf("farm-a", "v2")).problem, "its code was shown in the farm panel");

  // Shown again after the release: held again.
  await revealed(a.doc._id, NOW);
  assert.equal((await ingest.run()).held, 1);
  assert.equal((await ledgerOf("farm-a", "v1")).state, "held");
});
