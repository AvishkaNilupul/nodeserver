// utils/codeShop/planner.js (docs/code-shop/02-ENGINE.md, "planner.js").
//
// The planner only ever PROPOSES: it drafts products from free ledger stock
// once a campaign group is ready, and must never
// - draft a game that is not marked `sell`, or a group still earning codes;
// - draft a set a non-retired product already owns (that would be a second
//   listing for the same codes);
// - touch an active / paused / retired product, or a draft the owner edited
//   beyond flagging it `stale`;
// - announce a draft twice, or fail a run because Telegram did.
//
// Real Mongo via mongodb-memory-server: the guarded draft writes are the thing
// under test. Config, events and Telegram are small fakes. All values are made up.
process.env.CRED_SECRET ||= "code-shop-planner-test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const CodeStock = require("../models/CodeStock");
const CodeProduct = require("../models/CodeProduct");
const SoopCampaign = require("../models/SoopCampaign");
const { createPlanner } = require("../utils/codeShop/planner");
const { DEFAULTS, deepMerge } = require("../utils/codeShop/config");
const { slotKeyOf, slotSetHash } = require("../utils/codeShop/slots");
const { checkBuyerText } = require("../utils/codeShop/textGuard");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-15T12:00:00Z");

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshopplanner"));
  await Promise.all([CodeStock.init(), CodeProduct.init(), SoopCampaign.init()]);
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

async function reset() {
  await CodeStock.deleteMany({});
  await CodeProduct.deleteMany({});
}

let seq = 0;

// `count` ledger rows of one reward; returns its slotKey.
async function addSlot({
  gameNo = "12",
  groupKey = "12:100",
  nameRaw,
  name = nameRaw,
  count,
  state = "in_stock",
  earnedAt = NOW - 3 * DAY,
  useBy = NOW + 20 * DAY,
  campaignEndAt = NOW - 5 * HOUR,
  campaignTitle = "Autumn Cup",
  gameName = "Overwatch 2",
}) {
  const slotKey = slotKeyOf(groupKey, nameRaw, 1);
  const rows = [];
  for (let i = 0; i < count; i++) {
    seq += 1;
    rows.push({
      loginId: "login-" + seq,
      itemKey: "item-" + seq,
      gameNo,
      gameName,
      groupKey,
      campaignIdx: groupKey.split(":")[1],
      campaignTitle,
      campaignEndAt: campaignEndAt === null ? null : new Date(campaignEndAt),
      slotKey,
      nameRaw,
      name,
      image: "https://img.example/" + encodeURIComponent(nameRaw) + ".png",
      codeHash: "hash-" + seq,
      codeShape: "25:4-4-5-4-4",
      earnedAt: earnedAt === null ? null : new Date(earnedAt + i * 1000),
      useBy: useBy === null ? null : new Date(useBy),
      state,
    });
  }
  await CodeStock.insertMany(rows);
  return slotKey;
}

function fakeEvents() {
  const stamps = new Map(); // key -> did the draft exist when it was stamped
  const logs = [];
  return {
    stamps,
    logs,
    async log(entry) {
      logs.push(entry);
      return true;
    },
    async stamp(key) {
      if (stamps.has(key)) return false;
      const slotSetHash = String(key).replace(/^draft:/, "");
      stamps.set(key, !!(await CodeProduct.exists({ slotSetHash, status: "draft" })));
      return true;
    },
    async has(key) {
      return stamps.has(key);
    },
  };
}

function fakeTelegram({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    async send(text) {
      sent.push(text);
      if (fail) throw new Error("telegram is down");
    },
  };
}

function setup({ cfg = {}, telegram = fakeTelegram() } = {}) {
  const clock = { t: NOW };
  const config = { value: deepMerge(DEFAULTS, cfg), get: async () => config.value };
  const events = fakeEvents();
  const planner = createPlanner({
    models: { CodeStock, CodeProduct },
    now: () => clock.t,
    config,
    events,
    telegram,
  });
  return { planner, clock, config, events, telegram };
}

const noErrors = (events) =>
  assert.deepEqual(
    events.logs.filter((l) => l.level === "error"),
    [],
    "no group failed",
  );

const drafts = () => CodeProduct.find({}).sort({ "proposed.units": -1, _id: 1 }).lean();

test("autoDraft off: nothing is drafted", async () => {
  await reset();
  await addSlot({ nameRaw: "Prost Spray", count: 10 });
  await addSlot({ nameRaw: "Banana Cat Spray", count: 10 });
  const { planner, telegram, events } = setup({ cfg: { autoDraft: false } });

  const res = await planner.run();
  assert.equal(res.skipped, true);
  assert.equal(res.groups, 0);
  assert.equal(res.created, 0);
  assert.equal(await CodeProduct.countDocuments(), 0);
  assert.equal(telegram.sent.length, 0);
  assert.equal(events.stamps.size, 0);
});

test("a group still earning is not ready: no draft", async () => {
  await reset();
  // Campaign runs two more days, a code came an hour ago, use-by far away.
  const running = { groupKey: "12:100", campaignEndAt: NOW + 2 * DAY, earnedAt: NOW - HOUR, useBy: NOW + 30 * DAY };
  await addSlot({ ...running, nameRaw: "Prost Spray", count: 10 });
  await addSlot({ ...running, nameRaw: "Banana Cat Spray", count: 10 });
  // Ended two hours ago: still inside the 4 h grace, and codes are recent.
  const justEnded = { groupKey: "12:101", campaignEndAt: NOW - 2 * HOUR, earnedAt: NOW - HOUR, useBy: NOW + 30 * DAY };
  await addSlot({ ...justEnded, nameRaw: "Sun Tea Player Icon", count: 10 });

  const { planner, telegram, events } = setup();
  const res = await planner.run();
  noErrors(events);
  assert.deepEqual(res, { groups: 0, created: 0, updated: 0, staled: 0, deleted: 0 });
  assert.equal(await CodeProduct.countDocuments(), 0);
  assert.equal(telegram.sent.length, 0);
});

test("ended + grace: one full draft, slots in first-earned order, clean texts", async () => {
  await reset();
  const g = { groupKey: "12:200" };
  const banana = await addSlot({ ...g, nameRaw: "바나나 고양이 스프레이", name: "Banana Cat Spray", count: 8, earnedAt: NOW - 3 * DAY });
  const prost = await addSlot({ ...g, nameRaw: "건배 스프레이", name: "Prost Spray", count: 7, earnedAt: NOW - 4 * DAY });
  const autumn = await addSlot({ ...g, nameRaw: "가을 명함", name: "Autumn Vibes Name Card", count: 6, earnedAt: NOW - 2 * DAY });
  // Two of the autumn codes were earned first and are already sold: the slot's
  // order key is its first earnedAt over ALL its rows, so it leads.
  await addSlot({ ...g, nameRaw: "가을 명함", name: "Autumn Vibes Name Card", count: 2, earnedAt: NOW - 6 * DAY, state: "sold" });

  const { planner, telegram, events } = setup();
  const res = await planner.run();
  noErrors(events);
  assert.deepEqual(res, { groups: 1, created: 1, updated: 0, staled: 0, deleted: 0 });

  const [p] = await drafts();
  assert.equal(p.status, "draft");
  assert.equal(p.origin, "auto");
  assert.equal(p.kind, "full");
  assert.equal(p.edited, false);
  assert.equal(p.stale, false);
  assert.equal(p.gameNo, "12");
  assert.equal(p.gameName, "Overwatch 2");
  assert.equal(p.marketGame, "Overwatch");
  assert.deepEqual(p.groupKeys, ["12:200"]);
  assert.equal(p.name, "Overwatch 2 - Autumn Cup (3 codes)");
  assert.deepEqual(p.slots.map((s) => s.slotKey), [autumn, prost, banana]);
  assert.deepEqual(p.slots.map((s) => s.label), ["Autumn Vibes Name Card", "Prost Spray", "Banana Cat Spray"]);
  assert.deepEqual(p.slots.map((s) => s.nameRaw), ["가을 명함", "건배 스프레이", "바나나 고양이 스프레이"]);
  assert.ok(p.slots.every((s) => s.image.startsWith("https://img.example/")));
  assert.ok(p.slots.every((s) => s.campaignTitle === "Autumn Cup"));
  assert.equal(p.slotSetHash, slotSetHash([banana, prost, autumn]));
  assert.equal(p.proposed.units, 6);
  assert.equal(p.proposed.at.getTime(), NOW);
  assert.deepEqual(p.markets, ["eldorado"]);
  assert.deepEqual(
    { mode: p.pricing.mode, priceUsd: p.pricing.priceUsd, floorUsd: p.pricing.floorUsd, clearance: p.pricing.clearance, followCompetitors: p.pricing.followCompetitors },
    { mode: "fixed", priceUsd: 1, floorUsd: 0.5, clearance: false, followCompetitors: false },
  );

  // Texts: present, built for these labels, and they pass the buyer-text guard.
  // No campaign row: the event is dated by the group's first earned code, sold
  // ones included (NOW - 6 days = 9 October).
  assert.ok(p.texts.title.startsWith("Overwatch 2 | 3 Codes Bundle | Event 9 Oct 2026 | Autumn Vibes Name Card + Prost Spray + Banana Cat Spray"), p.texts.title);
  assert.match(p.texts.description, /^EVENT: 9 October 2026 - /m);
  assert.match(p.texts.description, /REDEEM BY /); // use-by is 20 days out
  assert.match(p.texts.deliveryTemplate, /\{password\}/);
  assert.equal(p.texts.coverTitle, "Overwatch 2 Code Bundle");
  assert.equal(p.texts.coverServiceText, "3 Redeem Codes");
  assert.deepEqual(checkBuyerText({ ...p.texts, labels: p.slots.map((s) => s.label) }), []);

  // Announced once, stamped only once the draft row existed.
  assert.deepEqual([...events.stamps], [["draft:" + p.slotSetHash, true]]);
  assert.equal(telegram.sent.length, 1);
  assert.match(telegram.sent[0], /Overwatch 2 - Autumn Cup \(3 codes\)/);
  assert.match(telegram.sent[0], /6 bundles/);
});

test("the event is dated by its campaign's start; the campaign title never reaches a buyer", async () => {
  await reset();
  await SoopCampaign.deleteMany({});
  await SoopCampaign.create({
    dropsIdx: "300",
    gameNo: "12",
    title: "Autumn Cup Stage 9 Item Drops (Part B)",
    titleRaw: "x",
    startDate: new Date("2026-10-11T08:00:00Z"),
    endDate: new Date(NOW - 5 * HOUR),
  });
  const g = { groupKey: "12:300", campaignTitle: "Autumn Cup Stage 9 Item Drops (Part B)" };
  await addSlot({ ...g, nameRaw: "a", name: "Prost Spray", count: 4, earnedAt: NOW - 3 * DAY });
  await addSlot({ ...g, nameRaw: "b", name: "Esports Loot Box", count: 4, earnedAt: NOW - 2 * DAY });

  const { planner, events } = setup();
  await planner.run();
  noErrors(events);
  const [p] = await drafts();
  assert.ok(p.texts.title.startsWith("Overwatch 2 | 2 Codes Bundle | Event 11 Oct 2026 | "), p.texts.title);
  assert.match(p.texts.description, /^EVENT: 11 October 2026 - /m);
  assert.match(p.texts.description, /that includes the Esports Loot Box\./);
  assert.match(p.texts.deliveryTemplate, /\(event 11 October 2026, redeem by /);
  for (const k of ["title", "description", "deliveryTemplate", "coverTitle", "coverServiceText"]) {
    assert.doesNotMatch(p.texts[k], /cup|stage|part b/i, k + " keeps the campaign title out");
  }
  assert.deepEqual(checkBuyerText({ ...p.texts, labels: p.slots.map((s) => s.label) }), []);
  await SoopCampaign.deleteMany({});
});

test("a v1 campaign row (no titleRaw, stored nine hours late) is dated by its real start", async () => {
  await reset();
  await SoopCampaign.deleteMany({});
  // Written the v1 way, straight to the collection: the model would add titleRaw "".
  // Stored 12 Oct 05:00 = really 11 Oct 20:00 UTC.
  await SoopCampaign.collection.insertOne({ dropsIdx: "301", gameNo: "12", title: "Cup", startDate: new Date("2026-10-12T05:00:00Z"), endDate: new Date(NOW - 5 * HOUR) });
  await addSlot({ groupKey: "12:301", nameRaw: "c", name: "Moon Spray", count: 4, earnedAt: NOW - 3 * DAY });
  const { planner, events } = setup();
  await planner.run();
  noErrors(events);
  const [p] = await drafts();
  assert.ok(p.texts.title.startsWith("Overwatch 2 | Event 11 Oct 2026 | Moon Spray | "), p.texts.title);
  await SoopCampaign.deleteMany({});
});

test("a reward with no clean English name gets an empty label; the draft is still made", async () => {
  await reset();
  const g = { gameNo: "200", groupKey: "200:300", gameName: "Delta Force", campaignTitle: "Season Drop" };
  const korean = await addSlot({ ...g, nameRaw: "한국어 보상", count: 5, earnedAt: NOW - 3 * DAY });
  const sourcey = await addSlot({ ...g, nameRaw: "spray-a", name: "SOOP Exclusive Spray", count: 5, earnedAt: NOW - 2 * DAY });
  const helmet = await addSlot({ ...g, nameRaw: "helmet", name: "Tactical Helmet", count: 5, earnedAt: NOW - DAY });

  const { planner, telegram, events } = setup();
  const res = await planner.run();
  noErrors(events);
  assert.equal(res.created, 1);

  const [p] = await drafts();
  assert.deepEqual(p.slots.map((s) => s.slotKey), [korean, sourcey, helmet]);
  assert.deepEqual(p.slots.map((s) => s.label), ["", "", "Tactical Helmet"]);
  assert.equal(p.marketGame, "Delta Force");
  assert.deepEqual(p.markets, ["eldorado"]);
  // Nothing buyer-facing carries the raw names.
  assert.doesNotMatch(JSON.stringify(p.texts), /한국어|SOOP/);
  assert.equal(telegram.sent.length, 1);
  assert.match(telegram.sent[0], /2 rewards need an English label first/);
});

test("markets: Eldorado when it is on; never GGSel, even from a stored setting (R1)", async () => {
  await reset();
  await addSlot({ nameRaw: "Prost Spray", count: 5 });
  const on = setup({ cfg: { markets: { eldorado: true, ggsel: true } } });
  await on.planner.run();
  assert.deepEqual((await drafts())[0].markets, ["eldorado"]);

  await reset();
  await addSlot({ nameRaw: "Prost Spray", count: 5 });
  const off = setup({ cfg: { markets: { eldorado: false, ggsel: true } } });
  await off.planner.run();
  assert.deepEqual((await drafts())[0].markets, []);
});

// "From now on make the auto-lister list there as well" (06 plan, C7).
test("markets: a new draft names PlayerAuctions too once it is switched on, in a fixed order", async () => {
  await reset();
  await addSlot({ nameRaw: "Prost Spray", count: 5 });
  const both = setup({ cfg: { markets: { eldorado: true, ggsel: true, playerauctions: true } } });
  await both.planner.run();
  assert.deepEqual((await drafts())[0].markets, ["eldorado", "playerauctions"]);

  await reset();
  await addSlot({ nameRaw: "Prost Spray", count: 5 });
  const paOnly = setup({ cfg: { markets: { eldorado: false, playerauctions: true } } });
  await paOnly.planner.run();
  assert.deepEqual((await drafts())[0].markets, ["playerauctions"]);

  // A game not on playerauctionsGames never gets it: Delta Force codes die in two weeks.
  await reset();
  await addSlot({ nameRaw: "Prost Spray", count: 5 });
  const notOw = setup({ cfg: { markets: { eldorado: true, playerauctions: true }, playerauctionsGames: ["200"] } });
  await notOw.planner.run();
  assert.deepEqual((await drafts())[0].markets, ["eldorado"]);
});

test("a draft deleted and proposed again is not announced twice: the stamp is its slot set", async () => {
  await reset();
  const a = await addSlot({ nameRaw: "Prost Spray", count: 10 });
  const b = await addSlot({ nameRaw: "Banana Cat Spray", count: 10 });
  const { planner, clock, telegram, events } = setup();
  assert.equal((await planner.run()).created, 1);
  const [first] = await drafts();
  assert.equal(first.slotSetHash, slotSetHash([a, b]));
  assert.deepEqual([...events.stamps.keys()], ["draft:" + slotSetHash([a, b])]);

  // The owner deletes the draft; the planner proposes the same set again.
  await CodeProduct.deleteOne({ _id: first._id });
  clock.t = NOW + HOUR;
  assert.equal((await planner.run()).created, 1);
  const [second] = await drafts();
  assert.notEqual(String(second._id), String(first._id), "a new draft row");
  assert.equal(second.slotSetHash, first.slotSetHash);
  assert.equal(telegram.sent.length, 1, "announced once for the set");
  assert.equal(events.stamps.size, 1);
});

test("leftovers: 5 slots x29 + F x20 + G x15 -> full x15 and a 5-slot leftover x14", async () => {
  await reset();
  const g = { groupKey: "12:400" };
  const five = [];
  for (const [i, n] of ["Alpha", "Bravo", "Charlie", "Delta", "Echo"].entries()) {
    five.push(await addSlot({ ...g, nameRaw: n, count: 29, earnedAt: NOW - (10 - i) * DAY }));
  }
  const f = await addSlot({ ...g, nameRaw: "Foxtrot", count: 20, earnedAt: NOW - 4 * DAY });
  const gg = await addSlot({ ...g, nameRaw: "Golf", count: 15, earnedAt: NOW - 3 * DAY });

  const { planner, telegram, events } = setup();
  const res = await planner.run();
  noErrors(events);
  assert.deepEqual(res, { groups: 1, created: 2, updated: 0, staled: 0, deleted: 0 });

  const [full, left] = await drafts();
  assert.equal(full.kind, "full");
  assert.equal(full.proposed.units, 15);
  assert.deepEqual(full.slots.map((s) => s.slotKey), [...five, f, gg]);
  assert.equal(left.kind, "leftover");
  assert.equal(left.proposed.units, 14);
  assert.deepEqual(left.slots.map((s) => s.slotKey), five);
  assert.equal(left.slotSetHash, slotSetHash(five));
  assert.equal(left.name, "Overwatch 2 - Autumn Cup (5 codes)");
  assert.equal(telegram.sent.length, 2);
  assert.equal(events.stamps.size, 2);

  // Leftovers off: only the full set.
  await reset();
  for (const [i, n] of ["Alpha", "Bravo", "Charlie", "Delta", "Echo"].entries()) {
    await addSlot({ ...g, nameRaw: n, count: 29, earnedAt: NOW - (10 - i) * DAY });
  }
  await addSlot({ ...g, nameRaw: "Foxtrot", count: 20, earnedAt: NOW - 4 * DAY });
  await addSlot({ ...g, nameRaw: "Golf", count: 15, earnedAt: NOW - 3 * DAY });
  const off = setup({ cfg: { drafts: { leftovers: false } } });
  const res2 = await off.planner.run();
  assert.equal(res2.created, 1);
  const only = await drafts();
  assert.equal(only.length, 1);
  assert.equal(only[0].kind, "full");
  assert.equal(only[0].proposed.units, 15);
});

test("a game not marked sell is never drafted", async () => {
  await reset();
  await addSlot({ gameNo: "999", groupKey: "999:1", nameRaw: "Mystery Box", count: 10 });
  await addSlot({ gameNo: "12", groupKey: "12:500", nameRaw: "Prost Spray", count: 10 });

  // sellNewGames off: the settings' list alone decides (the "on" case has its own tests below).
  const { planner, telegram } = setup({ cfg: { sellNewGames: false, games: { "12": { sell: false } } } });
  const res = await planner.run();
  assert.deepEqual(res, { groups: 0, created: 0, updated: 0, staled: 0, deleted: 0 });
  assert.equal(await CodeProduct.countDocuments(), 0);
  assert.equal(telegram.sent.length, 0);
});

test("ready by stalled codes or a near use-by; codes inside the expiry lead do not count", async () => {
  await reset();
  // No campaign end known, last code 25 h ago (stallHours 24).
  await addSlot({ groupKey: "12:600", nameRaw: "Stalled A", count: 4, campaignEndAt: null, earnedAt: NOW - 25 * HOUR });
  // Campaign still running, codes recent, but they stop working in 5 days (earlyListDays 7).
  const near = { groupKey: "12:601", campaignEndAt: NOW + 10 * DAY, earnedAt: NOW - HOUR, useBy: NOW + 5 * DAY };
  await addSlot({ ...near, nameRaw: "Near A", count: 10 });
  await addSlot({ ...near, nameRaw: "Near B", count: 12 });
  // 5 more of Near A that die inside the 36 h lead: not free.
  await addSlot({ ...near, nameRaw: "Near A", count: 5, useBy: NOW + 10 * HOUR });

  const { planner, events } = setup();
  const res = await planner.run();
  noErrors(events);
  assert.equal(res.groups, 2);
  assert.equal(res.created, 2);
  const byGroup = Object.fromEntries((await drafts()).map((p) => [p.groupKeys[0], p]));
  assert.equal(byGroup["12:600"].proposed.units, 4);
  assert.equal(byGroup["12:601"].proposed.units, 10);
  assert.equal(byGroup["12:601"].slots.length, 2);
});

test("rerun is idempotent: no duplicate, proposed refreshed, announced once", async () => {
  await reset();
  const a = await addSlot({ nameRaw: "Prost Spray", count: 10 });
  const b = await addSlot({ nameRaw: "Banana Cat Spray", count: 10 });

  const { planner, clock, telegram, events } = setup();
  const first = await planner.run();
  assert.equal(first.created, 1);

  // Two of one slot sold since: same set, fewer bundles (2 spare Prost < minUnits).
  const two = await CodeStock.find({ slotKey: b, state: "in_stock" }).limit(2).lean();
  await CodeStock.updateMany({ _id: { $in: two.map((r) => r._id) } }, { $set: { state: "sold" } });
  clock.t = NOW + HOUR;
  const second = await planner.run();
  noErrors(events);
  assert.deepEqual(second, { groups: 1, created: 0, updated: 1, staled: 0, deleted: 0 });

  const all = await drafts();
  assert.equal(all.length, 1);
  assert.equal(all[0].slotSetHash, slotSetHash([a, b]));
  assert.equal(all[0].proposed.units, 8);
  assert.equal(all[0].proposed.at.getTime(), NOW + HOUR);
  assert.equal(telegram.sent.length, 1);
  assert.equal(events.stamps.size, 1);

  // Two overlapping runs still make one pass at a time.
  await reset();
  await addSlot({ nameRaw: "Prost Spray", count: 10 });
  const fresh = setup();
  await Promise.all([fresh.planner.run(), fresh.planner.run()]);
  assert.equal(await CodeProduct.countDocuments(), 1);
});

test("a set owned by an active product gets no draft, and the product is not touched", async () => {
  await reset();
  const a = await addSlot({ groupKey: "12:700", nameRaw: "Prost Spray", count: 10 });
  const b = await addSlot({ groupKey: "12:700", nameRaw: "Banana Cat Spray", count: 10 });
  const active = await CodeProduct.create({
    name: "hand made",
    gameNo: "12",
    groupKeys: ["12:700"],
    slots: [{ slotKey: a, label: "Prost Spray" }, { slotKey: b, label: "Banana Cat Spray" }],
    slotSetHash: slotSetHash([a, b]),
    status: "active",
    origin: "manual",
    kind: "custom",
    proposed: { units: 99, at: new Date(NOW - 10 * DAY) },
  });
  const before = await CodeProduct.findById(active._id).lean();

  // Same set in another group, but its only product is retired: that one is drafted.
  const c = await addSlot({ groupKey: "12:701", nameRaw: "Sun Tea Player Icon", count: 10 });
  await CodeProduct.create({ name: "old", gameNo: "12", groupKeys: ["12:701"], slotSetHash: slotSetHash([c]), status: "retired" });

  const { planner, telegram, events } = setup();
  const res = await planner.run();
  noErrors(events);
  assert.deepEqual(res, { groups: 2, created: 1, updated: 0, staled: 0, deleted: 0 });

  assert.equal(await CodeProduct.countDocuments({ slotSetHash: slotSetHash([a, b]) }), 1);
  const after = await CodeProduct.findById(active._id).lean();
  assert.deepEqual(after, before);
  const made = await CodeProduct.findOne({ status: "draft" }).lean();
  assert.deepEqual(made.groupKeys, ["12:701"]);
  assert.equal(telegram.sent.length, 1);
});

test("a draft no longer proposed: deleted when untouched, kept as stale when edited", async () => {
  for (const edited of [false, true]) {
    await reset();
    const a = await addSlot({ nameRaw: "Prost Spray", count: 10, earnedAt: NOW - 3 * DAY });
    const b = await addSlot({ nameRaw: "Banana Cat Spray", count: 10, earnedAt: NOW - 2 * DAY });
    const c = await addSlot({ nameRaw: "Sun Tea Player Icon", count: 10, earnedAt: NOW - DAY });
    // A live product of the same group with another set: never deleted or flagged.
    const live = await CodeProduct.create({ name: "live", gameNo: "12", groupKeys: ["12:100"], slotSetHash: slotSetHash([a]), status: "paused" });

    const { planner, clock, events } = setup();
    assert.equal((await planner.run()).created, 1);
    const old = await CodeProduct.findOne({ status: "draft" }).lean();
    assert.equal(old.slotSetHash, slotSetHash([a, b, c]));
    if (edited) await CodeProduct.updateOne({ _id: old._id }, { $set: { edited: true, "texts.title": "Owner title" } });

    // Every free code of slot C is gone: the set is now A + B.
    await CodeStock.updateMany({ slotKey: c, state: "in_stock" }, { $set: { state: "sold" } });
    clock.t = NOW + HOUR;
    const res = await planner.run();
    noErrors(events);
    assert.equal(res.created, 1);
    assert.equal(res.deleted, edited ? 0 : 1);
    assert.equal(res.staled, edited ? 1 : 0);

    const kept = await CodeProduct.findById(old._id).lean();
    if (edited) {
      assert.ok(kept, "the edited draft is kept");
      assert.equal(kept.stale, true);
      assert.equal(kept.texts.title, "Owner title");
    } else {
      assert.equal(kept, null, "the untouched draft is deleted");
    }
    const replacement = await CodeProduct.findOne({ slotSetHash: slotSetHash([a, b]) }).lean();
    assert.equal(replacement.status, "draft");
    assert.equal(replacement.kind, "leftover"); // the group has three slots
    const liveAfter = await CodeProduct.findById(live._id).lean();
    assert.equal(liveAfter.status, "paused");
    assert.equal(liveAfter.stale, false);

    // Nothing changes on the next pass: staled once, not every run.
    clock.t = NOW + 2 * HOUR;
    const again = await planner.run();
    assert.deepEqual(again, { groups: 1, created: 0, updated: 1, staled: 0, deleted: 0 });
  }
});

test("a failed Telegram send never fails the run; the draft is still stamped", async () => {
  await reset();
  await addSlot({ nameRaw: "Prost Spray", count: 10 });
  await addSlot({ nameRaw: "Banana Cat Spray", count: 10 });
  const telegram = fakeTelegram({ fail: true });
  const { planner, clock, events } = setup({ telegram });

  const res = await planner.run();
  assert.equal(res.created, 1);
  const [p] = await drafts();
  assert.deepEqual([...events.stamps], [["draft:" + p.slotSetHash, true]]);
  assert.equal(telegram.sent.length, 1);
  assert.ok(events.logs.some((l) => l.level === "warn" && l.kind === "telegram"));
  noErrors(events);

  // The stamp, not the send, decides: no retry flood on the next pass.
  clock.t = NOW + HOUR;
  await planner.run();
  assert.equal(telegram.sent.length, 1);
});

// --- autopilot (2026-10-25): labels, label repair, CHZZK minimum, new games ----------------

function setupWith({ cfg = {}, fetch = null, telegram = fakeTelegram() } = {}) {
  const clock = { t: NOW };
  const sets = [];
  const config = {
    value: deepMerge(DEFAULTS, cfg),
    get: async () => config.value,
    set: async (patch, opts) => {
      sets.push({ patch, opts });
      config.value = deepMerge(config.value, patch);
      return config.value;
    },
  };
  const events = fakeEvents();
  const planner = createPlanner({
    models: { CodeStock, CodeProduct },
    now: () => clock.t,
    config,
    events,
    telegram,
    ...(fetch ? { fetch } : {}),
  });
  return { planner, clock, config, events, telegram, sets };
}

const mtFetch = (map) => async (url) => {
  const q = decodeURIComponent(String(url).split("&q=")[1] || "");
  return { ok: true, json: async () => ({ responseData: { translatedText: map[q] || "" } }) };
};

test("autoLabels: a half-translated name gets its label from the glossary; off = empty as before", async () => {
  await reset();
  const g = { gameNo: "200", groupKey: "200:400", gameName: "Delta Force", campaignTitle: "Week Drops" };
  await addSlot({ ...g, nameRaw: "가호 주머니 1개 (30분)", name: "Blessing Pouch x1 (30분)", count: 5 });
  await addSlot({ ...g, nameRaw: "helmet", name: "Tactical Helmet", count: 5 });

  const off = setupWith({ cfg: { autoLabels: false } });
  await off.planner.run();
  let [p] = await drafts();
  assert.deepEqual(p.slots.map((s) => s.label).sort(), ["", "Tactical Helmet"]);

  await reset();
  await addSlot({ ...g, nameRaw: "가호 주머니 1개 (30분)", name: "Blessing Pouch x1 (30분)", count: 5 });
  await addSlot({ ...g, nameRaw: "helmet", name: "Tactical Helmet", count: 5 });
  const on = setupWith();
  await on.planner.run();
  [p] = await drafts();
  assert.deepEqual(p.slots.map((s) => s.label).sort(), ["Blessing Pouch x1 (30 min)", "Tactical Helmet"]);
  assert.deepEqual(checkBuyerText({ ...p.texts, labels: p.slots.map((s) => s.label) }, { sourceWords: DEFAULTS.sourceWords }), []);
});

test("autoLabels: a machine translation fills a name the glossary cannot", async () => {
  await reset();
  const g = { gameNo: "200", groupKey: "200:401", gameName: "Delta Force", campaignTitle: "Week Drops" };
  await addSlot({ ...g, nameRaw: "시원한 여름 샌들", name: "시원한 여름 샌들", count: 4 });
  const { planner, events } = setupWith({ fetch: mtFetch({ "시원한 여름 샌들": "Cool summer sandals" }) });
  await planner.run();
  noErrors(events);
  const [p] = await drafts();
  assert.deepEqual(p.slots.map((s) => s.label), ["Cool summer sandals"]);
  assert.match(p.texts.title, /Cool summer sandals/);
  assert.ok(events.logs.some((l) => l.kind === "label"));
});

test("label repair: a draft made without a label gets it later and new texts; an edited draft is never touched", async () => {
  await reset();
  const g = { gameNo: "200", groupKey: "200:402", gameName: "Delta Force", campaignTitle: "Week Drops" };
  await addSlot({ ...g, nameRaw: "악몽의 밤 헤드웨어", name: "악몽의 밤 헤드웨어", count: 4 });
  // First pass: the translator has nothing yet.
  const first = setupWith({ fetch: mtFetch({}) });
  await first.planner.run();
  let [p] = await drafts();
  assert.deepEqual(p.slots.map((s) => s.label), [""]);

  // A later pass (new process, translator answers): the label and texts arrive.
  const later = setupWith({ fetch: mtFetch({ "악몽의 밤 헤드웨어": "Nightmare night headwear" }) });
  const res = await later.planner.run();
  [p] = await drafts();
  assert.equal(res.relabelled, 1);
  assert.deepEqual(p.slots.map((s) => s.label), ["Nightmare night headwear"]);
  assert.match(p.texts.title, /Nightmare night headwear/);
  assert.equal(p.edited, false);

  // The owner edits a blank-label draft: the planner leaves its slots alone.
  await reset();
  await addSlot({ ...g, nameRaw: "악몽의 밤 헤드웨어", name: "악몽의 밤 헤드웨어", count: 4 });
  await setupWith({ fetch: mtFetch({}) }).planner.run();
  await CodeProduct.updateOne({}, { $set: { edited: true, name: "mine" } });
  await setupWith({ fetch: mtFetch({ "악몽의 밤 헤드웨어": "Nightmare night headwear" }) }).planner.run();
  [p] = await drafts();
  assert.deepEqual(p.slots.map((s) => s.label), [""]);
  assert.equal(p.name, "mine");
});

test("CHZZK groups draft from one bundle; SOOP groups keep their minimum", async () => {
  await reset();
  await addSlot({ gameNo: "910004", groupKey: "910004:chzzk-1982", gameName: "Once Human", nameRaw: "Summer Sandals", count: 1 });
  await addSlot({ gameNo: "910004", groupKey: "910004:chzzk-1982", gameName: "Once Human", nameRaw: "Night Headwear", count: 1 });
  await addSlot({ gameNo: "12", groupKey: "12:500", nameRaw: "Lonely Spray", count: 1 });
  const { planner } = setupWith({ cfg: { games: { "910004": { sell: true } } } });
  const res = await planner.run();
  assert.equal(res.created, 1);
  const [p] = await drafts();
  assert.deepEqual(p.groupKeys, ["910004:chzzk-1982"]);
  assert.equal(p.proposed.units, 1);
  assert.equal(p.slots.length, 2);
});

test("sellNewGames: a new game with an English name is added and drafted; a Korean-named one is added switched off, told once", async () => {
  await reset();
  await addSlot({ gameNo: "777", groupKey: "777:1", gameName: "Brand New Game", nameRaw: "Gold Crate", count: 5 });
  await addSlot({ gameNo: "778", groupKey: "778:1", gameName: "새로운 게임", nameRaw: "Silver Crate", count: 5 });
  const { planner, sets, telegram, config } = setupWith();
  const res = await planner.run();
  assert.equal(res.created, 1);
  assert.equal(res.newGames, 2);
  const [p] = await drafts();
  assert.equal(p.gameNo, "777");
  assert.equal(p.marketGame, "Brand New Game");
  assert.match(p.texts.title, /^Brand New Game \|/);
  assert.deepEqual(config.value.games["777"], { sell: true, marketGame: "Brand New Game", displayName: "Brand New Game" });
  assert.equal(config.value.games["778"].sell, false);
  assert.equal(sets.length, 2);
  assert.equal(telegram.sent.filter((t) => /New game/.test(t)).length, 2);

  // Next pass: both are known now; nothing is added or told again, the off one is not read.
  const again = await planner.run();
  assert.equal(again.newGames, undefined);
  assert.equal(sets.length, 2);
});

test("sellNewGames off: a game the settings never named is not read; a game switched off by name never is", async () => {
  await reset();
  await addSlot({ gameNo: "777", groupKey: "777:1", gameName: "Brand New Game", nameRaw: "Gold Crate", count: 5 });
  await addSlot({ gameNo: "910001", groupKey: "910001:chzzk-1", gameName: "Call of Duty", nameRaw: "Ghost Helmet", count: 5 });
  const off = setupWith({ cfg: { sellNewGames: false } });
  assert.equal((await off.planner.run()).created, 0);
  const on = setupWith(); // 910001 is sell:false in DEFAULTS
  const res = await on.planner.run();
  const made = await drafts();
  assert.deepEqual(made.map((p) => p.gameNo), ["777"]);
  assert.equal(res.newGames, 1);
});

test("autoLabels: only rewards with a code still free to sell go to the translator", async () => {
  await reset();
  const g = { gameNo: "200", groupKey: "200:403", gameName: "Delta Force", campaignTitle: "Week Drops" };
  await addSlot({ ...g, nameRaw: "팔린 보상품", name: "팔린 보상품", count: 4, state: "sold" });
  await addSlot({ ...g, nameRaw: "남은 보상품", name: "남은 보상품", count: 4 });
  const asked = [];
  const fetch = async (url) => {
    asked.push(decodeURIComponent(String(url).split("&q=")[1] || ""));
    return { ok: true, json: async () => ({ responseData: { translatedText: "Spare Prize" } }) };
  };
  const { planner } = setupWith({ fetch });
  await planner.run();
  assert.deepEqual(asked, ["남은 보상품"]);
  const [p] = await drafts();
  assert.deepEqual(p.slots.map((s) => s.label), ["Spare Prize"]);
});
