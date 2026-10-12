// utils/soop/i18n.js — the Korean -> English clean-up for SOOP text.
//
// The corpus test reads _soop-probe/events.json (171 real campaigns recorded
// 2026-10-04). That folder is git-excluded, so the test skips where it is
// missing; every other test here is self-contained. Nothing touches the network.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const i18n = require("../utils/soop/i18n");
const { hasHangul, translate, GLOSSARY, GAMES, gameName, PROVIDERS, rewardKind } = i18n;

const PROBE = path.join(__dirname, "..", "_soop-probe", "events.json");

test("exports exactly the contract surface", () => {
  assert.deepEqual(Object.keys(i18n).sort(), [
    "GAMES",
    "GIVE_CON_LABEL",
    "GLOSSARY",
    "PROVIDERS",
    "REWARD_KIND_LABEL",
    "gameName",
    "hasHangul",
    "rewardKind",
    "translate",
  ]);
  assert.deepEqual(i18n.GIVE_CON_LABEL, { term: "Guaranteed", draw: "Raffle", none: "Random" });
  assert.deepEqual(i18n.REWARD_KIND_LABEL, {
    code: "Code",
    link: "Link / form",
    ingame: "In-game (linked account)",
    other: "Other",
  });
  assert.deepEqual(PROVIDERS, { kuro: "Kuro Games", krafton: "KRAFTON", riot: "Riot Games", nexon: "NEXON" });
});

test("hasHangul", () => {
  assert.equal(hasHangul("드롭스"), true);
  assert.equal(hasHangul("OWCS Korea 드롭스"), true);
  assert.equal(hasHangul("ㅋㅋ"), true); // bare jamo count too
  assert.equal(hasHangul("OWCS Korea Stage 3"), false);
  assert.equal(hasHangul("日本語 と 中文"), false);
  assert.equal(hasHangul(""), false);
  for (const v of [null, undefined, 42, {}, ["드롭스"]]) assert.equal(hasHangul(v), false);
});

test("glossary is well formed: 120+ unique phrases, English values, contract vocabulary", () => {
  assert.ok(GLOSSARY.length >= 120, `only ${GLOSSARY.length} entries`);
  const seen = new Set();
  for (const entry of GLOSSARY) {
    assert.equal(entry.length, 2);
    const [ko, en] = entry;
    assert.ok(hasHangul(ko), `key without Hangul: ${ko}`);
    assert.ok(en && !hasHangul(en), `value is not English: ${ko} -> ${en}`);
    assert.equal(ko, ko.trim());
    const key = ko.replace(/\s+/g, ""); // a space in a key is optional when matching
    assert.ok(!seen.has(key), `duplicate key: ${ko}`);
    seen.add(key);
  }
  const vocabulary = ["드롭스", "인게임 아이템", "시청 미션", "이벤트", "결승전", "예선", "시즌", "주차", "회차"]
    .concat(["생방송", "입중계", "상품권", "문화상품권", "기프티콘", "쿠폰", "코인"])
    .concat(["(일)", "(월)", "(화)", "(수)", "(목)", "(금)", "(토)"]);
  for (const word of vocabulary) assert.ok(seen.has(word.replace(/\s+/g, "")), `missing: ${word}`);
});

test("translate: non-strings become an empty string", () => {
  for (const v of [null, undefined, 0, 42, true, {}, [], () => "x", Symbol("s")]) {
    assert.equal(translate(v), "");
  }
  assert.equal(translate(""), "");
  assert.equal(translate("   "), "");
});

test("translate: whitespace is collapsed and trimmed, English is otherwise untouched", () => {
  assert.equal(translate("  OWWC   FINALS \t DAY 1\n"), "OWWC FINALS DAY 1");
  assert.equal(translate("OWWC FINALS  인게임 아이템 드롭스 DAY 1"), "OWWC FINALS In-game Item Drops DAY 1");
  assert.equal(translate("QBZ95-1 - Delta Force"), "QBZ95-1 - Delta Force");
  assert.equal(translate("Weekly#25 (W1&2) *5"), "Weekly#25 (W1&2) *5");
});

test("translate: the longest phrase wins", () => {
  // "문화상품권" must not be read as "문화" + "상품권", nor "결승 진출전" as "결승" + rest.
  assert.equal(translate("문화상품권"), "Culture Gift Voucher");
  assert.equal(translate("상품권"), "Gift Voucher");
  assert.equal(translate("인게임 아이템 드롭스"), "In-game Item Drops");
  assert.equal(translate("결승전&결승 진출전"), "Finals & Finals Qualifier");
  assert.equal(translate("전설의 사내"), "The Legendary Man");
  assert.equal(translate("전설 전리품 상자"), "Legendary Loot Box");
  assert.equal(translate("더 파이널스"), "THE FINALS");
  assert.equal(translate("스타크래프트 II"), "StarCraft II");
  // SOOP spells the same phrase with and without the space.
  assert.equal(translate("결승진출전"), translate("결승 진출전"));
  assert.equal(translate("명조:워더링 웨이브"), translate("명조: 워더링 웨이브"));
});

test("translate: phrases keep English word order and get spaces where Korean glues", () => {
  const cases = [
    ["OWCS Korea Stage 3 인게임 아이템 드롭스 (W1&2)", "OWCS Korea Stage 3 In-game Item Drops (W1&2)"],
    ["[10/03]이터널 리턴 마스터즈 시즌12 페이즈3 DAY 2", "[10/03] Eternal Return Masters Season 12 Phase 3 DAY 2"],
    ["명조:워더링 웨이브 라이브 드롭스 이벤트", "Wuthering Waves Live Drops Event"],
    ["10/4(일) 박신자컵 중계 이벤트", "10/4 (Sun) Park Shin-ja Cup Broadcast Event"],
    ["더 파이널스 TGM26 APAC 클로즈드 예선 생방송", "THE FINALS TGM26 APAC Closed Qualifier Live Broadcast"],
    ["SOOP키캡", "SOOP Keycap"],
    ["기영이숯불치킨 모바일 쿠폰(20,000원)", "Kiyoung-i Charcoal Chicken Mobile Coupon (20,000 KRW)"],
    ["[PO] 젠랑x꿈돌이 키캡 키링(로켓ver)", "[PO] Genrang x Kkumdori Keycap Keyring (Rocket ver)"],
  ];
  for (const [ko, en] of cases) assert.equal(translate(ko), en);
});

test("translate: counters move in front of their number", () => {
  const cases = [
    ["2026 DEMACIA CUP 1주차 시청 미션", "2026 DEMACIA CUP Week 1 Watch Mission"],
    ["[09/13] KEL 서킷 3 1주 차 승자조", "[09/13] KEL Circuit 3 Week 1 Winners' Bracket"],
    ["[JTBC] 날아올라라 나비 6회", "[JTBC] Fly High Butterfly Ep. 6"],
    ["꽃파당 13~14회", "꽃파당 Ep. 13-14"],
    ["본선 6회차", "Main Stage Round 6"],
    ["본선 4~5회차", "Main Stage Rounds 4-5"],
    ["제2회 천하제일 SOOP 단타대회", "2nd World's Best SOOP Day-Trading Contest"],
    ["[KTV] 제78주년 국군의 날_1001", "[KTV] 78th Anniversary of Armed Forces Day_1001"],
    ["프로젝트 제타 2차 글로벌 테스트", "Project ZETA 2nd Global Test"],
    ["2026 FCL 4강 LIVE", "2026 FCL Semifinals LIVE"],
    ["26년 9월 드롭스", "2026 September Drops"],
    ["72시간 드롭스", "72-Hour Drops"],
    ["컬쳐랜드 1만원", "Cultureland 10,000 KRW"],
    ["문화상품권 5천 원권", "Culture Gift Voucher 5,000 KRW"],
    ["컬처랜드 문화상품권 5000원권", "Cultureland Gift Voucher 5,000 KRW"],
    ["넥슨캐시 15,000원", "Nexon Cash 15,000 KRW"],
    ["1000젬 코드", "1000 Gems Code"],
    ["스타 드롭 2개 (DAY 1)", "Star Drop x2 (DAY 1)"],
    ["클램 코인*25,000", "Shell Credit x25,000"],
  ];
  for (const [ko, en] of cases) assert.equal(translate(ko), en);
});

test("translate: unknown Hangul is kept, never dropped", () => {
  assert.equal(translate("가나다라 드롭스 이벤트"), "가나다라 Drops Event");
  assert.equal(translate("꿻뷁"), "꿻뷁");
  // A counter glued to a longer word is not a counter.
  assert.equal(translate("3회전 진출"), "3회전 진출");
  assert.equal(translate("13월"), "13월");
  const out = translate("미지의게임 시즌3 결승전");
  assert.equal(out, "미지의게임 Season 3 Finals");
  assert.ok(hasHangul(out));
});

test("translate: overrides win, as a Map or a plain object, on the exact source only", () => {
  const source = "OWCS KOREA 문화상품권 드롭스";
  const english = "OWCS Korea gift card drops";
  assert.equal(translate(source, { overrides: new Map([[source, english]]) }), english);
  assert.equal(translate(source, { overrides: { [source]: english } }), english);
  // Surrounding whitespace on the input does not defeat an override.
  assert.equal(translate(`  ${source} `, { overrides: { [source]: english } }), english);
  // Not a substring match: other text still goes through the glossary.
  assert.equal(translate(`${source} DAY 2`, { overrides: { [source]: english } }), "OWCS KOREA Culture Gift Voucher Drops DAY 2");
  // An override also applies to text with no Hangul, and is tidied like any output.
  assert.equal(translate("FTB SUMMER", { overrides: { "FTB SUMMER": "  FTB  Summer " } }), "FTB Summer");
  // Empty / non-string overrides and odd containers are ignored.
  assert.equal(translate("드롭스", { overrides: { 드롭스: "" } }), "Drops");
  assert.equal(translate("드롭스", { overrides: { 드롭스: 5 } }), "Drops");
  assert.equal(translate("드롭스", { overrides: null }), "Drops");
  assert.equal(translate("드롭스", { overrides: "드롭스" }), "Drops");
  assert.equal(translate("드롭스", null), "Drops");
  // Inherited object keys are not overrides.
  assert.equal(translate("constructor", { overrides: {} }), "constructor");
  assert.equal(translate("toString", { overrides: {} }), "toString");
});

test("GAMES seed: shape and the names the contract fixes", () => {
  const kinds = new Set(["game", "tv", "sports", "platform"]);
  for (const [no, g] of Object.entries(GAMES)) {
    assert.match(no, /^\d+$/);
    assert.ok(g.name && !hasHangul(g.name), `bad name for ${no}`);
    assert.ok(kinds.has(g.kind), `bad kind for ${no}: ${g.kind}`);
  }
  const expected = {
    12: "Overwatch",
    18: "Eternal Return",
    200: "Delta Force",
    244: "Wuthering Waves",
    8: "PUBG",
    4: "League of Legends",
    6: "Teamfight Tactics",
    14: "VALORANT",
    16: "StarCraft II",
    10: "StarCraft",
    26: "THE FINALS",
    30: "FC Online",
  };
  for (const [no, name] of Object.entries(expected)) {
    assert.equal(GAMES[no].name, name);
    assert.equal(GAMES[no].kind, "game");
  }
  assert.equal(GAMES["269"].kind, "tv");
  assert.equal(GAMES["385"].kind, "sports");
  assert.equal(GAMES["170"].kind, "platform");
});

test("gameName: overrides > GAMES > category > provider > Game #n > Other", () => {
  const ctx = { cateName: "오버워치", typeNm: "riot" };
  assert.equal(gameName("12", { ...ctx, overrides: { 12: "OW2" } }), "OW2");
  assert.equal(gameName("12", { ...ctx, overrides: new Map([["12", "OW2"]]) }), "OW2");
  assert.equal(gameName(12, { ...ctx, overrides: { 12: "OW2" } }), "OW2"); // numeric gameNo
  assert.equal(gameName("12", { ...ctx, overrides: { 12: "  " } }), "Overwatch"); // blank override ignored
  assert.equal(gameName("12", ctx), "Overwatch");
  assert.equal(gameName("12"), "Overwatch");
  // An override can also name a game the seed does not know.
  assert.equal(gameName("99999", { overrides: { 99999: "New Game" } }), "New Game");
  // Unknown gameNo: the category name, translated.
  assert.equal(gameName("99999", { cateName: "히어로즈 오브 더 스톰", typeNm: "riot" }), "Heroes of the Storm");
  assert.equal(gameName("99999", { cateName: "LCK", typeNm: "riot" }), "LCK");
  // A category SOOP has no English for still beats a provider label.
  assert.equal(gameName("99999", { cateName: "꿻뷁", typeNm: "riot" }), "꿻뷁");
  // No category: the provider.
  assert.equal(gameName("99999", { cateName: "", typeNm: "kuro" }), "Kuro Games");
  assert.equal(gameName("99999", { cateName: null, typeNm: "KRAFTON" }), "KRAFTON");
  assert.equal(gameName(null, { typeNm: "nexon" }), "NEXON");
  // Nothing known.
  assert.equal(gameName("99999", { typeNm: "somebody" }), "Game #99999");
  assert.equal(gameName("99999"), "Game #99999");
  assert.equal(gameName("99999", null), "Game #99999");
  for (const no of [null, undefined, "", "  "]) assert.equal(gameName(no), "Other");
  // Object prototype keys are neither games nor providers.
  assert.equal(gameName("constructor"), "Game #constructor");
  assert.equal(gameName(null, { typeNm: "constructor" }), "Other");
});

test("rewardKind", () => {
  assert.equal(rewardKind("1"), "code");
  assert.equal(rewardKind("2"), "link");
  assert.equal(rewardKind("4"), "ingame");
  assert.equal(rewardKind(1), "code");
  assert.equal(rewardKind(4), "ingame");
  for (const v of ["3", "0", "", "14", "code", null, undefined, {}, []]) assert.equal(rewardKind(v), "other");
  for (const kind of ["code", "link", "ingame", "other"]) assert.ok(i18n.REWARD_KIND_LABEL[kind]);
});

test("real campaigns: guaranteed titles come out with no Hangul", { skip: !fs.existsSync(PROBE) }, () => {
  const events = JSON.parse(fs.readFileSync(PROBE, "utf8"));
  assert.ok(Array.isArray(events) && events.length > 0);
  const left = (texts) => [...new Set(texts)].filter((t) => hasHangul(translate(t)));
  const share = (texts) => texts.filter((t) => !hasHangul(translate(t))).length / texts.length;

  const guaranteed = events.filter((e) => e.giveCon === "term").map((e) => e.title);
  assert.ok(guaranteed.length > 0);
  assert.deepEqual(left(guaranteed), [], "guaranteed titles still carrying Hangul");

  // Measured 2026-10-06 on this file: 171/171 titles, 271/271 reward names and
  // every category name. The floors leave room for a re-recorded probe file.
  const titles = events.map((e) => e.title);
  assert.ok(share(titles) >= 0.97, `titles: ${JSON.stringify(left(titles))}`);
  const items = events.flatMap((e) => (e.itemList || []).map((i) => i.itemName));
  assert.ok(share(items) >= 0.97, `reward names: ${JSON.stringify(left(items))}`);
  const categories = events.map((e) => e.cateName).filter(Boolean);
  assert.deepEqual(left(categories), [], "category names still carrying Hangul");

  // Translating never loses text or leaves stray whitespace.
  for (const t of titles.concat(items)) {
    const out = translate(t);
    assert.ok(out.length > 0, `emptied: ${t}`);
    assert.equal(out, out.replace(/\s+/g, " ").trim());
    if (!hasHangul(t)) assert.equal(out, t.replace(/\s+/g, " ").trim());
  }

  // Every game in the file is seeded, so nothing shows up as "Game #n".
  for (const e of events) {
    assert.ok(GAMES[e.gameNo], `gameNo ${e.gameNo} is not seeded (${e.title})`);
    assert.ok(!hasHangul(gameName(e.gameNo, e)));
  }
});
