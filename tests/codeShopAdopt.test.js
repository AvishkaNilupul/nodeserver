// Code shop adopt (utils/codeShop/adopt.js, docs/code-shop/02-ENGINE.md):
// take over a hand-made code offer that is already on sale.
//
// What must hold, because these offers are LIVE when they are adopted:
// - adopt never writes a SuppliedAccount: every unit is byte-identical before
//   and after (no password, status or login change);
// - the ledger learns which code sits in which unit: units on the shelf link
//   their codes (in_unit), sold units' codes end sold with their share of the
//   price, removed units' codes stay free stock;
// - line N of every unit is the same reward slot; anything the ledger cannot
//   vouch for (unreadable unit, unknown code, a code already elsewhere, units
//   that disagree) is a problem, and a problem means nothing is written;
// - a second apply changes nothing;
// - no code in anything adopt returns or logs.
//
// Real Mongo via mongodb-memory-server, real ingest and reconcile. Codes,
// logins, offers and prices are made up.
process.env.CRED_SECRET ||= "codeshop-adopt-test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const CodeStock = require("../models/CodeStock");
const CodeProduct = require("../models/CodeProduct");
const AccountOffer = require("../models/AccountOffer");
const SuppliedAccount = require("../models/SuppliedAccount");
const MarketplaceListing = require("../models/MarketplaceListing");
const SoopInventoryItem = require("../models/SoopInventoryItem");
const SoopCampaign = require("../models/SoopCampaign");
const SoopAccount = require("../models/SoopAccount");
const secretBox = require("../utils/secretBox");
const slots = require("../utils/codeShop/slots");
const { createIngest } = require("../utils/codeShop/ingest");
const { createAdopt } = require("../utils/codeShop/adopt");

const ObjectId = mongoose.Types.ObjectId;
const BSON = mongoose.mongo.BSON;
const NOW = Date.parse("2026-10-15T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ALL = [CodeStock, CodeProduct, AccountOffer, SuppliedAccount, MarketplaceListing, SoopInventoryItem, SoopCampaign, SoopAccount];

const CAMPAIGN_RAW = "오버워치 가을 드롭스";
const CAMPAIGN_EN = "Overwatch Autumn Drops";

// Rewards of one farm login, in the order a hand-made unit lists them. The
// ticket is handed out twice by the campaign (two steps).
const REWARDS = [
  { key: "icon", nameRaw: "선 티 아이콘", name: "Sun Tea Player Icon", label: "Sun Tea Player Icon", at: 5 },
  { key: "spray", nameRaw: "상쾌한 스프레이", name: "Refreshing Spray", label: "Refreshing Spray", at: 4 },
  { key: "ticket1", nameRaw: "표준 장비 티켓", name: "Standard Issue Gear Ticket x1", label: "Standard Issue Gear Ticket x1", at: 3 },
  { key: "ticket2", nameRaw: "표준 장비 티켓", name: "Standard Issue Gear Ticket x1", label: "Standard Issue Gear Ticket x1 (2nd code)", at: 2 },
];
const LABELS = REWARDS.map((r) => r.label);

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshopadopt"));
  await Promise.all(ALL.map((m) => m.init()));
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

test.beforeEach(async () => {
  await Promise.all(ALL.map((m) => m.deleteMany({})));
});

// ── fixtures ────────────────────────────────────────────────────────────────

const ALL_CODES = new Set();
let codeSeq = 0;
function newCode() {
  codeSeq += 1;
  const code = `AD${String(codeSeq).padStart(2, "0")}-QWER-TYUIO-PASD-FGHJ`;
  ALL_CODES.add(code);
  return code;
}

function fakeEvents() {
  const logs = [];
  return {
    logs,
    async log(e) {
      logs.push(e);
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

function makeAdopt(extra = {}) {
  const events = fakeEvents();
  const adopter = createAdopt({ secret: secretBox, now: () => NOW, events, ...extra });
  return { adopter, events };
}

async function campaign() {
  await SoopCampaign.create({
    dropsIdx: "1001",
    title: CAMPAIGN_EN,
    titleRaw: CAMPAIGN_RAW,
    gameNo: "12",
    startDate: new Date(NOW - 10 * DAY),
    endDate: new Date(NOW - DAY),
  });
}

let keySeq = 0;
// One farm login holding one code of every reward. -> { icon, spray, ticket1, ticket2 }
async function farmLogin(loginId) {
  await SoopAccount.create({ loginId, sold: false });
  const codes = {};
  for (const r of REWARDS) {
    keySeq += 1;
    const code = newCode();
    codes[r.key] = code;
    await SoopInventoryItem.create({
      loginId,
      key: "inv-" + keySeq,
      division: "acquired",
      kind: "code",
      hasCode: true,
      codeEnc: secretBox.encrypt(code),
      gameNo: "12",
      gameName: "Overwatch 2",
      name: r.name,
      nameRaw: r.nameRaw,
      image: "https://img.example.test/" + r.key + ".png",
      sentAt: new Date(NOW - r.at * DAY),
      expiresAt: slots.parseKst("2026-11-30 23:59:00"),
      used: true,
      raw: { itemCodeIdx: "idx-" + keySeq, itemName: r.nameRaw, useExpDate: "2026-11-30 23:59:00" },
      claim: { kind: "code", message: "", description: "", gameTitle: "", dropsName: CAMPAIGN_RAW },
    });
  }
  return codes;
}

// A hand-made unit's buyer text: one "N) Label = CODE" line per code.
function unitText(codes, labels = LABELS) {
  return codes.map((c, i) => `${i + 1}) ${labels[i]} = ${c}`).join("\n");
}
const lineCodes = (c) => [c.icon, c.spray, c.ticket1, c.ticket2];

async function offerOf(fields = {}) {
  return AccountOffer.create({
    title: "Overwatch 2 | 4 Codes Bundle | Instant Delivery",
    description: "Four redeem codes, one of each.",
    game: "Overwatch",
    priceUsd: 4,
    minPriceUsd: 0.3,
    status: "active",
    deliveryTemplate: "Thank you! Your codes:\n{password}",
    coverServiceText: "4 Redeem Codes",
    coverBullets: ["Instant Automatic Delivery", "4 Codes - One of Each"],
    ...fields,
  });
}

let unitSeq = 0;
async function unitOf(offer, body, fields = {}) {
  unitSeq += 1;
  return SuppliedAccount.create({
    offer: offer._id,
    login: "owbundle-test-" + unitSeq,
    password: secretBox.encrypt(body),
    status: "available",
    ...fields,
  });
}

async function listing(offer, marketplace, status, price = 4) {
  unitSeq += 1;
  await MarketplaceListing.insertMany([
    { accountOffer: offer._id, marketplace, externalId: "ext-" + unitSeq, status, price, origin: "manual" },
  ]);
}

// The ledger as ingest leaves it (adopt runs ingest again; it must add nothing).
async function ingestNow() {
  await createIngest({ secret: secretBox, now: () => NOW, events: fakeEvents() }).run();
}

// The standard live offer: farm-a / farm-b units on sale, farm-c sold on
// Eldorado, farm-d removed by hand.
async function liveOffer(offerFields = {}) {
  await campaign();
  const a = await farmLogin("farm-a");
  const b = await farmLogin("farm-b");
  const c = await farmLogin("farm-c");
  const d = await farmLogin("farm-d");
  const offer = await offerOf(offerFields);
  const ua = await unitOf(offer, unitText(lineCodes(a)));
  const ub = await unitOf(offer, unitText(lineCodes(b)));
  const uc = await unitOf(offer, unitText(lineCodes(c)), {
    status: "sold",
    market: "eldorado",
    orderId: "order-test-1",
    soldAt: new Date(NOW - 2 * DAY),
    deliveredAt: new Date(NOW - 2 * DAY + 60000),
  });
  const ud = await unitOf(offer, unitText(lineCodes(d)), { status: "removed", note: "taken down by hand" });
  await listing(offer, "eldorado", "active", 4);
  await listing(offer, "ggsel", "delisted", 4);
  await listing(offer, "gameflip", "active", 4);
  await ingestNow();
  return { offer, codes: { a, b, c, d }, units: { ua, ub, uc, ud } };
}

async function rowOf(code) {
  return CodeStock.findOne({ codeHash: slots.hashCode(code) }).lean();
}

// Every collection, as raw documents in _id order.
async function snapshot() {
  const db = mongoose.connection.db;
  const out = {};
  for (const name of ["codestocks", "codeproducts", "suppliedaccounts", "accountoffers", "marketplacelistings", "soopinventoryitems"]) {
    const docs = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
    out[name] = docs.map((d) => BSON.serialize(d).toString("base64"));
  }
  return out;
}

async function unitBytes() {
  const docs = await mongoose.connection.db.collection("suppliedaccounts").find({}).sort({ _id: 1 }).toArray();
  return docs.map((d) => BSON.serialize(d).toString("base64"));
}

// No plaintext code — whole, without dashes, or its distinctive group — anywhere.
function assertNoCode(...values) {
  for (const v of values) {
    const json = JSON.stringify(v);
    for (const code of ALL_CODES) {
      assert.ok(!json.includes(code), "a plaintext code leaked");
      assert.ok(!json.includes(code.replace(/-/g, "")), "a plaintext code leaked (no dashes)");
    }
    assert.ok(!json.includes("TYUIO"), "part of a plaintext code leaked");
  }
}

const kinds = (res) => res.details.map((p) => p.kind).sort();

// ── candidates ──────────────────────────────────────────────────────────────

test("candidates: only active offers with no product whose first unit on the shelf parses", async () => {
  const codes = () => [newCode(), newCode()];
  const two = ["Reward One", "Reward Two"];

  const adoptable = await offerOf({ title: "Adoptable", priceUsd: 3.5 });
  await unitOf(adoptable, unitText(codes(), two));
  await unitOf(adoptable, unitText(codes(), two));
  await unitOf(adoptable, unitText(codes(), two), { status: "sold", market: "eldorado", deliveredAt: new Date(NOW) });
  await unitOf(adoptable, unitText(codes(), two), { status: "removed" });

  const owned = await offerOf({ title: "Owned" });
  await unitOf(owned, unitText(codes(), two));
  await CodeProduct.create({ name: "Owner", status: "active", offer: owned._id });

  const archived = await offerOf({ title: "Archived", status: "archived" });
  await unitOf(archived, unitText(codes(), two));

  const accounts = await offerOf({ title: "Plain accounts" });
  await unitOf(accounts, "hunter2-not-a-code");

  // Its first unit is removed and unreadable: the first one ON THE SHELF counts.
  const later = await offerOf({ title: "Later unit parses", game: "Delta Force", priceUsd: 2 });
  await unitOf(later, "garbage", { status: "removed" });
  await unitOf(later, unitText(codes(), two), { status: "fed", market: "ggsel", fedAt: new Date(NOW) });

  const gone = await offerOf({ title: "Only removed units" });
  await unitOf(gone, unitText(codes(), two), { status: "removed" });

  const { adopter } = makeAdopt();
  const list = await adopter.candidates();
  assert.deepEqual(list, [
    {
      offerId: String(adoptable._id),
      title: "Adoptable",
      game: "Overwatch",
      priceUsd: 3.5,
      units: { available: 2, fed: 0, sold: 1, removed: 1 },
    },
    {
      offerId: String(later._id),
      title: "Later unit parses",
      game: "Delta Force",
      priceUsd: 2,
      units: { available: 0, fed: 1, sold: 0, removed: 1 },
    },
  ]);
  assertNoCode(list);
});

// ── dry run ─────────────────────────────────────────────────────────────────

test("dry run: a correct report, and nothing at all is written", async () => {
  const { offer, codes } = await liveOffer();
  const before = await snapshot();
  const { adopter, events } = makeAdopt();

  const res = await adopter.adopt(offer._id, { actor: "owner" });

  assert.equal(res.ok, true);
  assert.equal(res.applied, false);
  assert.deepEqual(res.problems, []);
  const want = [];
  for (const k of ["icon", "spray", "ticket1", "ticket2"]) want.push((await rowOf(codes.a[k])).slotKey);
  assert.equal(new Set(want).size, 4, "four distinct slots, the two tickets included");
  assert.deepEqual(res.report, {
    offerId: String(offer._id),
    title: offer.title,
    units: 3,
    codes: 12,
    slots: LABELS.map((label, i) => ({ label, slotKey: want[i] })),
    byStatus: { available: 2, fed: 0, sold: 1, removed: 1 },
    toLink: 12,
    alreadyLinked: 0,
    removedToHold: 0,
    productId: null,
  });
  assert.deepEqual(await snapshot(), before, "a dry run writes nothing");
  // Only a real `true` applies: a query-string "true" / "false" stays a dry run.
  for (const apply of ["true", "false", 1]) {
    const stray = await adopter.adopt(offer._id, { apply });
    assert.equal(stray.applied, false);
  }
  assert.deepEqual(await snapshot(), before);
  assert.equal(events.logs.length, 0);
  assertNoCode(res, events.logs);
});

// ── apply ───────────────────────────────────────────────────────────────────

test("apply: links every code to its unit, settles the sold one, creates the product, never touches a unit", async () => {
  const { offer, codes, units } = await liveOffer();
  const unitsBefore = await unitBytes();
  const { adopter, events } = makeAdopt();

  const res = await adopter.adopt(String(offer._id), { apply: true, actor: "owner" });

  assert.equal(res.ok, true, JSON.stringify(res.problems));
  assert.equal(res.applied, true);
  assert.equal(res.created, true);
  assert.equal(res.linked, 12);
  assert.equal(res.alreadyLinked, 0);
  assert.deepEqual(res.shortfall, []);
  assert.equal(res.reconcileError, "");
  assert.deepEqual(await unitBytes(), unitsBefore, "every SuppliedAccount is byte-identical");

  const product = await CodeProduct.findById(res.productId).lean();
  assert.ok(product);
  assert.equal(String(product.offer), String(offer._id));
  assert.equal(product.origin, "adopted");
  assert.equal(product.kind, "custom");
  assert.equal(product.status, "active");
  assert.equal(product.name, offer.title);
  assert.equal(product.marketGame, "Overwatch");
  assert.equal(product.gameNo, "12");
  assert.equal(product.gameName, "Overwatch 2");
  assert.equal(product.pricing.mode, "fixed");
  assert.equal(product.pricing.priceUsd, 4);
  assert.equal(product.pricing.floorUsd, 0.5, "floor is never under 0.5");
  assert.deepEqual(product.markets, ["eldorado"], "active eldorado/ggsel listings only");
  assert.equal(product.approvedBy, "owner");
  assert.equal(product.approvedAt.getTime(), NOW);
  assert.deepEqual(
    {
      title: product.texts.title,
      description: product.texts.description,
      deliveryTemplate: product.texts.deliveryTemplate,
      coverServiceText: product.texts.coverServiceText,
      coverBullets: product.texts.coverBullets,
    },
    {
      title: offer.title,
      description: offer.description,
      deliveryTemplate: offer.deliveryTemplate,
      coverServiceText: offer.coverServiceText,
      coverBullets: offer.coverBullets,
    },
  );
  const keys = ["icon", "spray", "ticket1", "ticket2"];
  const ledgerA = await Promise.all(keys.map((k) => rowOf(codes.a[k])));
  assert.deepEqual(
    product.slots.map((s) => ({ slotKey: s.slotKey, label: s.label, nameRaw: s.nameRaw, image: s.image, campaignTitle: s.campaignTitle })),
    ledgerA.map((r, i) => ({ slotKey: r.slotKey, label: LABELS[i], nameRaw: r.nameRaw, image: r.image, campaignTitle: CAMPAIGN_EN })),
  );
  assert.equal(product.slotSetHash, slots.slotSetHash(ledgerA.map((r) => r.slotKey)));
  assert.deepEqual(product.groupKeys, [ledgerA[0].groupKey]);

  for (const [login, unit] of [["a", units.ua], ["b", units.ub]]) {
    for (const k of keys) {
      const row = await rowOf(codes[login][k]);
      assert.equal(row.state, "in_unit", `${login}.${k}`);
      assert.equal(String(row.unit), String(unit._id));
      assert.equal(String(row.product), res.productId);
      assert.equal(String(row.offer), String(offer._id));
      assert.equal(row.unitStatus, "available");
      assert.deepEqual(
        { from: row.history.at(-1).from, to: row.history.at(-1).to, why: row.history.at(-1).why },
        { from: "in_stock", to: "in_unit", why: "adopted" },
      );
    }
  }
  for (const k of keys) {
    const row = await rowOf(codes.c[k]);
    assert.equal(row.state, "sold", `c.${k}`);
    assert.equal(String(row.unit), String(units.uc._id));
    assert.equal(row.saleUsd, 1, "listing price / 4 slots");
    assert.equal(row.market, "eldorado");
    assert.equal(row.orderId, "order-test-1");
    assert.equal(row.soldAt.getTime(), units.uc.deliveredAt.getTime());
    assert.ok(row.history.some((h) => h.why === "adopted"));
  }
  for (const k of keys) {
    const row = await rowOf(codes.d[k]);
    assert.equal(row.state, "in_stock", "a removed unit's codes stay free stock");
    assert.equal(row.unit, null);
  }
  // reconcile set the product's use-by from the codes on sale.
  assert.equal(product.useBy.getTime(), slots.parseKst("2026-11-30 23:59:00").getTime());

  const adoptLogs = events.logs.filter((e) => e.kind === "adopt");
  assert.equal(adoptLogs.length, 1);
  assert.equal(String(adoptLogs[0].product), res.productId);
  assert.deepEqual(await adopter.candidates(), [], "an adopted offer is no longer a candidate");

  const ledger = await CodeStock.find({}).lean();
  const productDocs = await CodeProduct.find({}).lean();
  assertNoCode(res, events.logs, ledger, productDocs);
});

test("apply: fed units keep the vault mark; a removed unit that went out through a market has its codes held", async () => {
  await campaign();
  const a = await farmLogin("farm-a");
  const e = await farmLogin("farm-e");
  const f = await farmLogin("farm-f");
  const offer = await offerOf({ minPriceUsd: 1.25 });
  const ua = await unitOf(offer, unitText(lineCodes(a)));
  const ue = await unitOf(offer, unitText(lineCodes(e)), { status: "fed", market: "ggsel", fedAt: new Date(NOW - DAY), contentId: "content-1" });
  await unitOf(offer, unitText(lineCodes(f)), { status: "removed", market: "ggsel", fedAt: new Date(NOW - 3 * DAY) });
  await listing(offer, "eldorado", "active");
  await listing(offer, "ggsel", "active");
  await listing(offer, "digiseller", "active");
  await ingestNow();
  const unitsBefore = await unitBytes();
  const { adopter, events } = makeAdopt();

  const dry = await adopter.adopt(offer._id);
  assert.equal(dry.ok, true, JSON.stringify(dry.problems));
  assert.equal(dry.report.removedToHold, 4);
  assert.deepEqual(dry.report.byStatus, { available: 1, fed: 1, sold: 0, removed: 1 });

  const res = await adopter.adopt(offer._id, { apply: true, actor: "owner" });
  assert.equal(res.ok, true, JSON.stringify(res.problems));
  assert.equal(res.linked, 8);
  assert.equal(res.held, 4);
  assert.deepEqual(await unitBytes(), unitsBefore);

  const product = await CodeProduct.findById(res.productId).lean();
  assert.deepEqual(product.markets, ["eldorado", "ggsel"]);
  assert.equal(product.pricing.floorUsd, 1.25);

  for (const code of lineCodes(e)) {
    const row = await rowOf(code);
    assert.equal(row.state, "in_unit");
    assert.equal(String(row.unit), String(ue._id));
    assert.equal(row.unitStatus, "fed");
    assert.equal(row.wasFed, true);
  }
  for (const code of lineCodes(a)) {
    const row = await rowOf(code);
    assert.equal(String(row.unit), String(ua._id));
    assert.equal(row.unitStatus, "available");
  }
  for (const code of lineCodes(f)) {
    const row = await rowOf(code);
    assert.equal(row.state, "held");
    assert.equal(row.unit, null);
    assert.match(row.problem, /may already be sold/);
  }
  assertNoCode(dry, res, events.logs);
});

test("apply twice: the second run reuses the product and changes nothing", async () => {
  const { offer } = await liveOffer();
  const { adopter, events } = makeAdopt();
  const first = await adopter.adopt(offer._id, { apply: true, actor: "owner" });
  assert.equal(first.ok, true, JSON.stringify(first.problems));
  const before = await snapshot();
  const logsBefore = events.logs.filter((e) => e.kind === "adopt").length;

  const again = await adopter.adopt(offer._id, { apply: true, actor: "owner" });
  assert.equal(again.ok, true, JSON.stringify(again.problems));
  assert.equal(again.created, false);
  assert.equal(again.productId, first.productId);
  assert.equal(again.linked, 0);
  assert.equal(again.alreadyLinked, 12);
  assert.equal(again.report.productId, first.productId);
  assert.equal(await CodeProduct.countDocuments({ offer: offer._id }), 1);
  assert.deepEqual(await snapshot(), before, "a second apply writes nothing");
  assert.equal(events.logs.filter((e) => e.kind === "adopt").length, logsBefore);

  const dry = await adopter.adopt(offer._id);
  assert.equal(dry.ok, true);
  assert.equal(dry.report.toLink, 0);
  assert.equal(dry.report.alreadyLinked, 12);
  assertNoCode(first, again, dry, events.logs);
});

test("a product whose links were written before it was created is repaired on the next apply", async () => {
  const { offer } = await liveOffer();
  // The first apply dies right after linking: the product is never created.
  let failCreate = true;
  const RealProduct = CodeProduct;
  const FlakyProduct = new Proxy(RealProduct, {
    get(target, prop) {
      if (prop === "create" && failCreate) {
        return async () => {
          failCreate = false;
          throw new Error("simulated crash");
        };
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const { adopter } = makeAdopt({ models: { CodeProduct: FlakyProduct } });
  await assert.rejects(adopter.adopt(offer._id, { apply: true }), /simulated crash/);
  assert.equal(await CodeProduct.countDocuments({}), 0);
  const orphan = await CodeStock.distinct("product", { unit: { $ne: null } });
  assert.equal(orphan.length, 1, "rows point at a product id that does not exist");

  const res = await adopter.adopt(offer._id, { apply: true });
  assert.equal(res.ok, true, JSON.stringify(res.problems));
  assert.equal(res.created, true);
  assert.equal(res.alreadyLinked, 12);
  const linkedTo = await CodeStock.distinct("product", { unit: { $ne: null } });
  assert.deepEqual(linkedTo.map(String), [res.productId]);
});

test("a code taken out of stock between the check and the write: the rest stays linked and the owner is told", async () => {
  const { offer, codes, units } = await liveOffer();
  const stolen = await rowOf(codes.b.spray);
  const other = new ObjectId();
  let raced = false;
  const RacyStock = new Proxy(CodeStock, {
    get(target, prop) {
      if (prop === "updateMany") {
        return async (filter, update, ...rest) => {
          const why = update && update.$push && update.$push.history && update.$push.history.$each[0].why;
          if (why === "adopted" && !raced) {
            raced = true;
            // Another writer claims one of unit b's codes first.
            await target.updateOne({ _id: stolen._id }, { $set: { state: "in_unit", unit: other } });
          }
          return target.updateMany(filter, update, ...rest);
        };
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const { adopter, events } = makeAdopt({ models: { CodeStock: RacyStock } });
  const unitsBefore = await unitBytes();

  const res = await adopter.adopt(offer._id, { apply: true });
  assert.equal(res.ok, true);
  assert.equal(res.linked, 11);
  assert.deepEqual(res.shortfall, [{ unitId: String(units.ub._id), login: units.ub.login, missed: 1 }]);
  assert.equal(String((await rowOf(codes.b.spray)).unit), String(other), "the other writer's claim is never overwritten");
  assert.equal(String((await rowOf(codes.b.icon)).unit), String(units.ub._id));
  assert.deepEqual(await unitBytes(), unitsBefore);
  assert.ok(events.logs.some((e) => e.kind === "adopt" && e.level === "error"));
  assertNoCode(res, events.logs);
});

// ── problems: nothing is written ────────────────────────────────────────────

async function assertRefused(offer, wantKinds) {
  const before = await snapshot();
  const { adopter, events } = makeAdopt();
  const dry = await adopter.adopt(offer._id);
  const res = await adopter.adopt(offer._id, { apply: true, actor: "owner" });
  for (const r of [dry, res]) {
    assert.equal(r.ok, false);
    assert.equal(r.applied, false);
    assert.deepEqual(kinds(r), wantKinds.slice().sort());
    // The panel shows `problems` as sentences; `details` says where.
    assert.deepEqual(r.problems, r.details.map((d) => d.msg));
    assert.ok(r.problems.every((m) => typeof m === "string" && m.length > 0));
  }
  assert.deepEqual(await snapshot(), before, "a refused adopt writes nothing");
  assert.equal(events.logs.length, 0);
  assertNoCode(dry, res, events.logs);
  return res;
}

test("problem: a unit whose text does not read as code lines", async () => {
  await campaign();
  const a = await farmLogin("farm-a");
  const b = await farmLogin("farm-b");
  const offer = await offerOf();
  await unitOf(offer, unitText(lineCodes(a)));
  const bad = await unitOf(offer, "Thanks for buying!\n" + unitText(lineCodes(b)));
  await ingestNow();
  const res = await assertRefused(offer, ["unparsable"]);
  assert.equal(res.details[0].unitId, String(bad._id));
  assert.equal(res.details[0].login, bad.login);
  assert.ok(res.report, "the report still comes back");
});

test("problem: a code the ledger does not know", async () => {
  await campaign();
  const a = await farmLogin("farm-a");
  const offer = await offerOf();
  const stranger = newCode();
  await unitOf(offer, unitText([a.icon, a.spray, a.ticket1, stranger]));
  await ingestNow();
  const res = await assertRefused(offer, ["unknown_code"]);
  assert.equal(res.details[0].line, 4);
  assert.equal(res.details[0].label, LABELS[3]);
  assert.equal(res.details[0].codeShape, slots.codeShape(stranger));
});

test("problem: a code already in another unit, or no longer in stock", async () => {
  await campaign();
  const a = await farmLogin("farm-a");
  const b = await farmLogin("farm-b");
  const c = await farmLogin("farm-c");
  const offer = await offerOf();
  await unitOf(offer, unitText(lineCodes(a)));
  await unitOf(offer, unitText(lineCodes(b)));
  await unitOf(offer, unitText(lineCodes(c)));
  await ingestNow();
  await CodeStock.updateOne({ codeHash: slots.hashCode(b.spray) }, { $set: { state: "in_unit", unit: new ObjectId() } });
  // farm-c was sold: ingest holds its free codes (its buyer can see them).
  await SoopAccount.updateOne({ loginId: "farm-c" }, { $set: { sold: true } });
  await ingestNow();
  const res = await assertRefused(offer, ["in_other_unit", "not_in_stock", "not_in_stock", "not_in_stock", "not_in_stock"]);
  const other = res.details.find((p) => p.kind === "in_other_unit");
  assert.equal(other.line, 2);
  assert.equal(other.state, "in_unit");
  assert.ok(res.details.filter((p) => p.kind === "not_in_stock").every((p) => p.state === "held"));
});

test("problem: units that disagree on line N's slot (another reward, or the same reward's other step)", async () => {
  await campaign();
  const a = await farmLogin("farm-a");
  const b = await farmLogin("farm-b");
  const c = await farmLogin("farm-c");
  const offer = await offerOf();
  await unitOf(offer, unitText(lineCodes(a)));
  // Spray code on the icon line and the other way round.
  await unitOf(offer, unitText([b.spray, b.icon, b.ticket1, b.ticket2]));
  // The two ticket steps swapped.
  await unitOf(offer, unitText([c.icon, c.spray, c.ticket2, c.ticket1]));
  await ingestNow();
  const res = await assertRefused(offer, ["slot_mismatch", "slot_mismatch", "slot_mismatch", "slot_mismatch"]);
  const byLine = (login) => res.details.filter((p) => p.login === login).map((p) => [p.line, p.sameReward]);
  const units = await SuppliedAccount.find({ offer: offer._id }).sort({ _id: 1 }).lean();
  assert.deepEqual(byLine(units[1].login), [[1, false], [2, false]]);
  assert.deepEqual(byLine(units[2].login), [[3, true], [4, true]]);
});

test("problem: units with a different number of codes, and the same code in two units", async () => {
  await campaign();
  const a = await farmLogin("farm-a");
  const b = await farmLogin("farm-b");
  const offer = await offerOf();
  await unitOf(offer, unitText(lineCodes(a)));
  await unitOf(offer, unitText(lineCodes(b)));
  await unitOf(offer, unitText([a.icon, a.spray, a.ticket1]));
  await ingestNow();
  const res = await assertRefused(offer, ["duplicate_code", "duplicate_code", "duplicate_code", "line_count"]);
  assert.ok(res.details.every((p) => p.kind !== "duplicate_code" || p.codeShape === slots.codeShape(a.icon)));
});

test("duplicate labels: two lines with the same label are two slots; two codes of ONE slot in a unit are a problem", async () => {
  await campaign();
  const a = await farmLogin("farm-a");
  const b = await farmLogin("farm-b");
  const same = [LABELS[0], LABELS[1], LABELS[2], LABELS[2]];
  const offer = await offerOf();
  await unitOf(offer, unitText(lineCodes(a), same));
  await unitOf(offer, unitText(lineCodes(b), same));
  await ingestNow();
  const { adopter } = makeAdopt();
  const res = await adopter.adopt(offer._id, { apply: true });
  assert.equal(res.ok, true, JSON.stringify(res.problems));
  const product = await CodeProduct.findById(res.productId).lean();
  assert.deepEqual(product.slots.map((s) => s.label), same);
  assert.equal(new Set(product.slots.map((s) => s.slotKey)).size, 4);
  assert.equal(product.slots[2].slotKey, (await rowOf(a.ticket1)).slotKey);
  assert.equal(product.slots[3].slotKey, (await rowOf(a.ticket2)).slotKey);

  // Both "x1" lines filled with step-1 codes of two logins: one slot twice.
  const c = await farmLogin("farm-c");
  const d = await farmLogin("farm-d");
  const twice = await offerOf({ title: "Ticket twice" });
  await unitOf(twice, unitText([c.icon, c.spray, c.ticket1, d.ticket1], same));
  await ingestNow();
  const refused = await assertRefused(twice, ["duplicate_slot"]);
  assert.equal(refused.details[0].line, 4);
});

test("problem: a unit on sale that carries delivery marks (the shop would have to take it off sale)", async () => {
  await campaign();
  const a = await farmLogin("farm-a");
  const b = await farmLogin("farm-b");
  const offer = await offerOf();
  await unitOf(offer, unitText(lineCodes(a)));
  await unitOf(offer, unitText(lineCodes(b)), { deliveredAt: new Date(NOW - DAY) });
  await ingestNow();
  await assertRefused(offer, ["unit_marked"]);
});

test("problem: no such offer, an offer that is not active, an offer with nothing on the shelf", async () => {
  const { adopter } = makeAdopt();
  assert.deepEqual(kinds(await adopter.adopt("not-an-id")), ["offer_missing"]);
  assert.deepEqual(kinds(await adopter.adopt(new ObjectId())), ["offer_missing"]);
  const draft = await offerOf({ status: "draft" });
  assert.deepEqual(kinds(await adopter.adopt(draft._id, { apply: true })), ["offer_not_active"]);
  const empty = await offerOf();
  await unitOf(empty, unitText([newCode()], ["Reward"]), { status: "removed" });
  const before = await snapshot();
  assert.deepEqual(kinds(await adopter.adopt(empty._id, { apply: true })), ["no_units"]);
  assert.deepEqual(await snapshot(), before);
});
