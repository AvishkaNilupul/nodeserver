// SOOP farm — normalised shapes (contract §6). No network: every row here is a
// literal, shaped like the rows in _soop-probe/events.json and the inventory
// rows v1 routes/soopRoutes.js mapped.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const i18n = require("../utils/soop/i18n");
const {
  parseKst,
  stepsOf,
  normalizeCampaign,
  normalizeMission,
  normalizeInventoryItem,
} = require("../utils/soop/normalize");

const pick = (o, keys) => Object.fromEntries(keys.split(" ").map((k) => [k, o[k]]));
const iso = (d) => (d ? d.toISOString() : null);

const rawCampaign = () => ({
  image: "https://event.img.sooplive.com/drops/content/2026/10/02/banner.png",
  dropsIdx: "13631", title: "오버워치 드롭스 이벤트", dropsType: "C", dupFlag: "N", url: null, guideStr: null,
  giveCon: "term", ingameGiveYn: "Y", typeNm: "riot", gameNo: "12", filter: "progress", live: true,
  startDate: "2026-10-02 17:00:00", endDate: "2026-10-09 17:00:00",
  loginPath: null, acctConn: false, acctLinkPath: null, acctLinkImage: null,
  broadIdList: [
    { userId: "owcs_kr", userNick: "OWCS 코리아", broadNo: "291", stationNo: "7", broadCateNo: "00040019", onAir: true },
    { userId: "owcs_jp", userNick: "OWCS Japan", broadNo: null, stationNo: null, broadCateNo: null, onAir: false },
  ],
  cateNo: "00040019",
  cateName: "오버워치",
  // Deliberately out of order, with a repeated threshold.
  itemList: [
    { itemType: "4", itemName: "스킨 B", itemImage: "https://img/b.png", giveCon: null, giveTerm: "120", giveEndDate: null, ongoingTerm: "0" },
    { itemType: "1", itemName: "Spray A", itemImage: null, giveCon: null, giveTerm: "30", giveEndDate: null, ongoingTerm: "0" },
    { itemType: "4", itemName: "스킨 C", itemImage: "https://img/c.png", giveCon: null, giveTerm: "60", giveEndDate: null, ongoingTerm: "0" },
    { itemType: "4", itemName: "스킨 D", itemImage: "https://img/d.png", giveCon: null, giveTerm: "120", giveEndDate: null, ongoingTerm: "0" },
  ],
});

const rawInventory = () => ({
  itemType: "1", itemName: "1000 골드", itemImage: "https://img/gold.png",
  gameNo: "433", cateName: "히어로즈 오브 더 스톰", typeNm: null,
  expDate: "2026-10-30 23:59:59", sendDate: "2026-10-06 12:00:00", receiveDate: "0000-00-00 00:00:00",
  ingameGiveYn: "N", acctConn: false, acctLinkPath: null, loginPath: null, useFlag: "N",
});

/* -------------------------------- parseKst -------------------------------- */

test("parseKst reads SOOP timestamps as Korea time", () => {
  assert.equal(parseKst("2026-10-11 05:00:00").toISOString(), "2026-10-10T20:00:00.000Z");
  assert.equal(parseKst("2026-01-01 00:00:00").toISOString(), "2025-12-31T15:00:00.000Z");
  assert.equal(parseKst("2026-10-11T05:00:00").toISOString(), "2026-10-10T20:00:00.000Z");
  assert.equal(parseKst(" 2026-10-11 05:00 ").toISOString(), "2026-10-10T20:00:00.000Z");
  assert.equal(parseKst("2026-10-11").toISOString(), "2026-10-10T15:00:00.000Z");
});

test("parseKst does not depend on the server's time zone", () => {
  const before = process.env.TZ;
  try {
    for (const tz of ["America/New_York", "Asia/Seoul", "UTC"]) {
      process.env.TZ = tz;
      assert.equal(parseKst("2026-10-11 05:00:00").getTime(), Date.UTC(2026, 9, 10, 20, 0, 0), tz);
    }
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});

test("parseKst returns null for empty, zero and junk input", () => {
  for (const bad of [
    "", null, undefined, "0000-00-00 00:00:00", "2026-00-00 00:00:00", "not a date", "11/10/2026",
    "2026-13-01 00:00:00", "2026-02-31 00:00:00", "2026-10-11 25:00:00", "2026-10-11 05:61:00",
    1791042942821, {}, new Date(NaN),
  ]) {
    assert.equal(parseKst(bad), null, `expected null for ${String(bad)}`);
  }
});

test("parseKst passes a valid Date through as a copy", () => {
  const d = new Date("2026-10-10T20:00:00.000Z");
  const out = parseKst(d);
  assert.equal(out.getTime(), d.getTime());
  assert.notEqual(out, d);
});

/* -------------------------------- stepsOf --------------------------------- */

test("stepsOf: raw rows give unique positive giveTerm, ascending", () => {
  assert.deepEqual(stepsOf(rawCampaign()), [30, 60, 120]);
  assert.deepEqual(
    stepsOf({ itemList: [{ giveTerm: "90" }, { giveTerm: null }, { giveTerm: "0" }, { giveTerm: "15" }, { giveTerm: "x" }, null] }),
    [15, 90],
  );
});

test("stepsOf: normalised campaigns give items[].minutes", () => {
  assert.deepEqual(stepsOf({ items: [{ minutes: 240 }, { minutes: 60 }, { minutes: 60 }, { minutes: 0 }] }), [60, 240]);
  assert.deepEqual(stepsOf(normalizeCampaign(rawCampaign())), [30, 60, 120]);
});

test("stepsOf: nothing to read is an empty list, never a throw", () => {
  for (const v of [null, undefined, {}, { itemList: null }, { items: [] }, "x", 5]) {
    assert.deepEqual(stepsOf(v), []);
  }
});

/* ---------------------------- normalizeCampaign --------------------------- */

test("normalizeCampaign: a realistic raw row", () => {
  const c = normalizeCampaign(rawCampaign());

  assert.equal(c.titleRaw, "오버워치 드롭스 이벤트", "the untouched title is kept");
  assert.deepEqual(pick(c, "dropsIdx title image gameNo gameName cateNo cateName"), {
    dropsIdx: "13631",
    title: i18n.translate("오버워치 드롭스 이벤트"),
    image: "https://event.img.sooplive.com/drops/content/2026/10/02/banner.png",
    gameNo: "12",
    gameName: i18n.gameName("12", { cateName: "오버워치", typeNm: "riot" }),
    cateNo: "00040019",
    cateName: i18n.translate("오버워치"),
  });
  assert.deepEqual(pick(c, "giveCon guaranteed live filter needsLink provider"), {
    giveCon: "term", guaranteed: true, live: true, filter: "progress", needsLink: true, provider: "riot",
  });
  assert.equal(iso(c.startAt), "2026-10-02T08:00:00.000Z");
  assert.equal(iso(c.endAt), "2026-10-09T08:00:00.000Z");

  assert.deepEqual(c.channels, [
    { id: "owcs_kr", nick: "OWCS 코리아", onAir: true },
    { id: "owcs_jp", nick: "OWCS Japan", onAir: false },
  ]);
  assert.equal(c.categoryWide, false, "a channel list means it is not category-wide");

  assert.deepEqual(c.items.map((i) => i.minutes), [30, 60, 120, 120], "items ascend by minutes");
  assert.deepEqual(c.items.map((i) => i.nameRaw), ["Spray A", "스킨 C", "스킨 B", "스킨 D"], "equal steps keep SOOP's order");
  assert.deepEqual(c.items.map((i) => i.kind), ["code", "ingame", "ingame", "ingame"]);
  assert.equal(c.items[0].name, "Spray A");
  assert.equal(c.items[0].image, null);
  assert.equal(c.items[1].image, "https://img/c.png");
  assert.deepEqual(c.steps, [30, 60, 120]);
  assert.equal(c.rewardKind, "ingame", "the kind of the majority of items");

  assert.deepEqual(Object.keys(c).sort(), [
    "cateName", "cateNo", "categoryWide", "channels", "dropsIdx", "endAt", "filter", "gameName",
    "gameNo", "giveCon", "guaranteed", "image", "items", "live", "needsLink", "provider",
    "rewardKind", "startAt", "steps", "title", "titleRaw",
  ]);
});

test("normalizeCampaign: does not mutate the raw row", () => {
  const raw = rawCampaign();
  const before = JSON.stringify(raw);
  normalizeCampaign(raw, { overrides: { "스킨 B": "Skin B" }, filter: "scheduled" });
  assert.equal(JSON.stringify(raw), before);
});

test("normalizeCampaign: overrides, gameOverrides and filter are applied", () => {
  const c = normalizeCampaign(rawCampaign(), {
    overrides: new Map([
      ["오버워치 드롭스 이벤트", "Overwatch drops event (fixed)"],
      ["스킨 B", "Skin B"],
      ["오버워치", "Overwatch category"],
    ]),
    gameOverrides: { 12: "Overwatch 2 (renamed)" },
    filter: "scheduled",
  });
  assert.equal(c.title, "Overwatch drops event (fixed)");
  assert.equal(c.titleRaw, "오버워치 드롭스 이벤트");
  assert.equal(c.cateName, "Overwatch category");
  assert.equal(c.gameName, "Overwatch 2 (renamed)");
  assert.equal(c.filter, "scheduled", "the caller's filter wins over the row's");
  const b = c.items.find((i) => i.nameRaw === "스킨 B");
  assert.equal(b.name, "Skin B");

  const plain = normalizeCampaign(rawCampaign(), { overrides: { "스킨 B": "Skin B (object)" } });
  assert.equal(plain.items.find((i) => i.nameRaw === "스킨 B").name, "Skin B (object)");
});

test("normalizeCampaign: category-wide, raffle and sparse rows", () => {
  const raw = {
    ...rawCampaign(),
    broadIdList: [], giveCon: "draw", ingameGiveYn: "N", typeNm: null, live: false, endDate: "0000-00-00 00:00:00",
    itemList: [
      { itemType: "2", itemName: "문화상품권", itemImage: null, giveTerm: null },
      { itemType: "1", itemName: "Code", itemImage: null, giveTerm: "60" },
    ],
  };
  delete raw.filter;
  const c = normalizeCampaign(raw);
  assert.deepEqual(pick(c, "categoryWide channels guaranteed needsLink provider live endAt"), {
    categoryWide: true, channels: [], guaranteed: false, needsLink: false, provider: null, live: false, endAt: null,
  });
  assert.equal(c.filter, "unlisted", "a row with no usable filter is unlisted");
  assert.deepEqual(c.items.map((i) => i.minutes), [0, 60]);
  assert.deepEqual(c.steps, [60]);
  assert.equal(c.rewardKind, "link", "a tie goes to the kind seen first");

  const noCate = normalizeCampaign({ ...raw, cateNo: null, cateName: null });
  assert.equal(noCate.categoryWide, false, "category-wide needs a cateNo");
  assert.equal(noCate.cateNo, null);
  assert.equal(noCate.cateName, "");

  const bogus = normalizeCampaign({ ...raw, filter: "whatever" });
  assert.equal(bogus.filter, "unlisted");
});

test("normalizeCampaign: an empty or missing row still has the full shape", () => {
  for (const v of [{}, null, undefined]) {
    const c = normalizeCampaign(v);
    assert.equal(typeof c.gameName, "string");
    assert.deepEqual(pick(c, "dropsIdx title gameNo channels items steps rewardKind categoryWide startAt live"), {
      dropsIdx: "", title: "", gameNo: null, channels: [], items: [], steps: [], rewardKind: "other",
      categoryWide: false, startAt: null, live: false,
    });
  }
});

/* ---------------------------- normalizeMission ---------------------------- */

test("normalizeMission: minutes is the highest viewTime; numbers are numbers", () => {
  const m = normalizeMission({
    dropsIdx: 13631,
    itemList: [
      { itemName: "Spray A", giveTerm: "30", viewTime: "42" },
      { itemName: "Skin B", giveTerm: "120", viewTime: "45" },
      { itemName: "Skin C", giveTerm: "60", viewTime: null },
    ],
  });
  assert.deepEqual(m, {
    dropsIdx: "13631",
    minutes: 45,
    items: [
      { name: "Spray A", minutes: 30, viewTime: 42 },
      { name: "Skin B", minutes: 120, viewTime: 45 },
      { name: "Skin C", minutes: 60, viewTime: 0 },
    ],
  });
});

test("normalizeMission: rows with nothing in them", () => {
  assert.deepEqual(normalizeMission({ dropsIdx: "7" }), { dropsIdx: "7", minutes: 0, items: [] });
  assert.deepEqual(normalizeMission(null), { dropsIdx: "", minutes: 0, items: [] });
  assert.equal(normalizeMission({ dropsIdx: "7", itemList: [{ itemName: "x", giveTerm: "junk", viewTime: "-3" }] }).minutes, 0);
});

/* -------------------------- normalizeInventoryItem ------------------------ */

test("normalizeInventoryItem: a realistic row", () => {
  const item = normalizeInventoryItem({ ...rawInventory(), idx: 9981, itemCode: "ABCD-1234-EFGH" }, "available");
  assert.deepEqual(pick(item, "key division nameRaw name kind gameNo gameName image"), {
    key: "9981", division: "available", nameRaw: "1000 골드", name: i18n.translate("1000 골드"), kind: "code",
    gameNo: "433",
    gameName: i18n.gameName("433", { cateName: "히어로즈 오브 더 스톰", typeNm: null }),
    image: "https://img/gold.png",
  });
  assert.equal(iso(item.expiresAt), "2026-10-30T14:59:59.000Z");
  assert.equal(iso(item.sentAt), "2026-10-06T03:00:00.000Z");
  assert.equal(item.receivedAt, null, "the zero date is not a date");
  assert.deepEqual(pick(item, "needsLink linkPath used code"), {
    needsLink: false, linkPath: null, used: false, code: "ABCD-1234-EFGH",
  });
  assert.deepEqual(Object.keys(item).sort(), [
    "code", "division", "expiresAt", "gameName", "gameNo", "image", "key", "kind", "linkPath",
    "name", "nameRaw", "needsLink", "raw", "receivedAt", "sentAt", "used",
  ]);
});

test("normalizeInventoryItem: key takes the first present id field, in order", () => {
  const ids = { idx: "a1", itemIdx: "b2", dropsItemIdx: "c3", giveIdx: "d4", seq: "e5", no: "f6" };
  const order = ["idx", "itemIdx", "dropsItemIdx", "giveIdx", "seq", "no"];
  for (let i = 0; i < order.length; i++) {
    const row = { ...rawInventory() };
    for (const f of order.slice(i)) row[f] = ids[f];
    assert.equal(normalizeInventoryItem(row, "available").key, ids[order[i]], `expected ${order[i]} to win`);
  }
  // Empty and null ids are not "present"; a numeric 0 is.
  assert.equal(normalizeInventoryItem({ ...rawInventory(), idx: "", itemIdx: null, giveIdx: 77 }, "available").key, "77");
  assert.equal(normalizeInventoryItem({ ...rawInventory(), idx: 0, seq: 5 }, "available").key, "0");
});

test("normalizeInventoryItem: the sha1 fallback is stable and tells items apart", () => {
  const a = normalizeInventoryItem(rawInventory(), "available");
  assert.match(a.key, /^[0-9a-f]{16}$/);
  // Pinned so a refactor cannot silently re-key every stored inventory row.
  const basis = "1000 골드|2026-10-06 12:00:00|2026-10-30 23:59:59|433";
  const expected = require("crypto").createHash("sha1").update(basis).digest("hex").slice(0, 16);
  assert.equal(a.key, expected);

  assert.equal(normalizeInventoryItem(rawInventory(), "available").key, a.key, "same row, same key");
  assert.equal(normalizeInventoryItem(rawInventory(), "acquired").key, a.key, "claiming does not re-key the item");
  assert.equal(
    normalizeInventoryItem({ ...rawInventory(), itemCode: "ZZZ", useFlag: "Y", receiveDate: "2026-10-07 00:00:00" }, "acquired").key,
    a.key,
    "fields outside name|sendDate|expiry|gameNo do not move the key",
  );
  const viaUseExp = { ...rawInventory(), useExpDate: "2026-10-30 23:59:59" };
  delete viaUseExp.expDate;
  assert.equal(normalizeInventoryItem(viaUseExp, "available").key, a.key, "expiry may come from useExpDate");

  for (const change of [{ itemName: "2000 골드" }, { sendDate: "2026-10-06 12:00:01" }, { expDate: "2026-10-31 23:59:59" }, { gameNo: "12" }]) {
    assert.notEqual(normalizeInventoryItem({ ...rawInventory(), ...change }, "available").key, a.key, JSON.stringify(change));
  }
});

test("normalizeInventoryItem: the code is extracted and REMOVED from raw", () => {
  const secret = "SECRET-CODE-0001";
  for (const field of ["itemCode", "code", "pinNo", "couponNo"]) {
    const row = { ...rawInventory(), idx: "1", [field]: secret };
    const item = normalizeInventoryItem(row, "acquired");
    assert.equal(item.code, secret, `code read from ${field}`);
    assert.equal(field in item.raw, false);
    assert.equal(JSON.stringify(item.raw).includes(secret), false, "raw must not carry the code");
    assert.equal(row[field], secret, "the caller's row is not mutated");
  }

  const all = normalizeInventoryItem(
    { ...rawInventory(), itemCode: "", code: "second", pinNo: "third", couponNo: "fourth" },
    "acquired",
  );
  assert.equal(all.code, "second", "itemCode, then code, then pinNo, then couponNo");
  for (const f of ["itemCode", "code", "pinNo", "couponNo"]) assert.equal(f in all.raw, false);
  assert.equal(all.raw.itemName, "1000 골드", "everything else stays in raw");
  assert.equal(all.raw.sendDate, "2026-10-06 12:00:00");

  assert.equal(normalizeInventoryItem(rawInventory(), "available").code, null);
});

test("normalizeInventoryItem: needsLink, linkPath, used, kind and dates", () => {
  const linked = { ...rawInventory(), itemType: "4", ingameGiveYn: "Y", acctConn: false, acctLinkPath: "/link/kuro", loginPath: "/login/kuro", typeNm: "kuro" };
  const a = normalizeInventoryItem(linked, "available");
  assert.equal(a.needsLink, true);
  assert.equal(a.linkPath, "/link/kuro", "acctLinkPath before loginPath");
  assert.equal(a.kind, "ingame");

  assert.equal(normalizeInventoryItem({ ...linked, acctConn: true }, "available").needsLink, false, "already linked");
  assert.equal(normalizeInventoryItem({ ...linked, ingameGiveYn: "N" }, "available").needsLink, false);
  const noConn = { ...linked };
  delete noConn.acctConn;
  assert.equal(normalizeInventoryItem(noConn, "available").needsLink, false, "acctConn must be exactly false");
  assert.equal(normalizeInventoryItem({ ...linked, acctLinkPath: null }, "available").linkPath, "/login/kuro");

  const used = normalizeInventoryItem({ ...rawInventory(), useFlag: "Y", receiveDate: "2026-10-07 09:30:00" }, "acquired");
  assert.equal(used.used, true);
  assert.equal(used.receivedAt.toISOString(), "2026-10-07T00:30:00.000Z");

  const useExp = { ...rawInventory(), expDate: "", useExpDate: "2026-11-01 00:00:00" };
  assert.equal(normalizeInventoryItem(useExp, "expired").expiresAt.toISOString(), "2026-10-31T15:00:00.000Z");
  assert.deepEqual(pick(normalizeInventoryItem({ itemName: "x" }, "expired"), "expiresAt sentAt receivedAt gameNo image"), {
    expiresAt: null, sentAt: null, receivedAt: null, gameNo: null, image: null,
  });
});

test("normalizeInventoryItem: division is one of the three", () => {
  for (const d of ["available", "acquired", "expired"]) {
    assert.equal(normalizeInventoryItem(rawInventory(), d).division, d);
  }
  assert.equal(normalizeInventoryItem({ ...rawInventory(), division: "expired" }).division, "expired", "falls back to the row's tag");
  assert.equal(normalizeInventoryItem({ ...rawInventory(), division: "expired" }, "acquired").division, "acquired");
  assert.equal(normalizeInventoryItem(rawInventory(), "nonsense").division, "available");
  const empty = normalizeInventoryItem(null, "available");
  assert.match(empty.key, /^[0-9a-f]{16}$/, "a missing row still gets a key");
  assert.deepEqual(empty.raw, {});
});

/* ------------------------------ recorded rows ----------------------------- */

const PROBE = path.join(__dirname, "..", "_soop-probe", "events.json");

test("every recorded campaign row normalises", { skip: !fs.existsSync(PROBE) && "no _soop-probe/events.json here" }, () => {
  const rows = JSON.parse(fs.readFileSync(PROBE, "utf8"));
  assert.ok(Array.isArray(rows) && rows.length > 0);
  for (const raw of rows) {
    const c = normalizeCampaign(raw);
    const where = `dropsIdx ${raw.dropsIdx}`;
    assert.equal(c.dropsIdx, String(raw.dropsIdx), where);
    assert.equal(c.titleRaw, raw.title, where);
    assert.equal(typeof c.title, "string", where);
    assert.ok(c.gameName.length > 0, where);
    assert.ok(["progress", "scheduled", "completed", "unlisted"].includes(c.filter), where);
    assert.ok(["code", "link", "ingame", "other"].includes(c.rewardKind), where);
    assert.ok(c.startAt instanceof Date && c.endAt instanceof Date, where);
    assert.ok(c.startAt <= c.endAt, where);
    assert.equal(c.items.length, raw.itemList.length, where);
    assert.equal(c.channels.length, raw.broadIdList.length, where);
    assert.equal(c.categoryWide, raw.broadIdList.length === 0 && !!raw.cateNo, where);
    assert.equal(c.guaranteed, raw.giveCon === "term", where);
    for (let i = 1; i < c.items.length; i++) assert.ok(c.items[i - 1].minutes <= c.items[i].minutes, where);
    assert.deepEqual(c.steps, stepsOf(raw), where);
    assert.deepEqual(stepsOf(c), c.steps, where);
  }
});
