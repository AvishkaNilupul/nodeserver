// utils/codeShop/labels.js — English labels for rewards whose name is Korean.
//
// What must hold:
// - a clean English name is used as it is, and a clean English name the
//   source-word rule refused is NEVER rewritten (that is the owner's call);
// - the glossary answers first, platform names never reach the buyer in any
//   spelling, and "<campaign reward> - <item>" keeps only the item + its tier;
// - the machine translation is asked once per name, a failure is retried only
//   after an hour, a used-up quota pauses it, and with no `fetch` it never runs;
// - nothing that is not clean printable ASCII comes out.
// The translator is a fake: no test here goes to the network.
const test = require("node:test");
const assert = require("node:assert/strict");

const { createLabeler, cleanLabel, stripName, glossaryLabel, tidyMachine, wantsTranslation } = require("../utils/codeShop/labels");

const HOUR = 60 * 60 * 1000;

function fakeFetch(answers) {
  const calls = [];
  const fn = async (url) => {
    const q = decodeURIComponent(String(url).split("&q=")[1] || "");
    calls.push(q);
    const a = typeof answers === "function" ? answers(q) : answers[q];
    if (a instanceof Error) throw a;
    return { ok: true, json: async () => a || { responseData: { translatedText: "" } } };
  };
  fn.calls = calls;
  return fn;
}

const said = (t) => ({ responseData: { translatedText: t }, quotaFinished: false });

test("cleanLabel: printable ASCII with a letter, no source word in any spelling, at most 80 characters", () => {
  assert.equal(cleanLabel("  Blessing Pouch x1 (30 min) "), "Blessing Pouch x1 (30 min)");
  assert.equal(cleanLabel("가호 주머니"), "");
  assert.equal(cleanLabel("Pouch – x1"), ""); // an en dash is not ASCII
  assert.equal(cleanLabel("1234"), "");
  assert.equal(cleanLabel("SOOP Spray"), "");
  assert.equal(cleanLabel("Korea Server Pack"), "");
  assert.equal(cleanLabel("Chijijik Drops Reward"), "", "a transliterated platform name is refused too");
  assert.equal(cleanLabel("x".repeat(81)), "");
});

test("stripName: platform names out; a campaign-reward prefix down to the item and its watch tier", () => {
  assert.equal(stripName("치지직 드롭스 3주차 달성 보상 (120분) - 가호 주머니 3개"), "가호 주머니 3개 (120분)");
  assert.equal(stripName("CHZZK Drops Reward - Golden Spray"), "Golden Spray");
  // A dash with no campaign words on its left is part of the name.
  assert.equal(stripName("Sun - Moon Spray"), "Sun - Moon Spray");
});

test("glossaryLabel: the SOOP glossary plus minutes, seconds and 'reward'", () => {
  assert.equal(glossaryLabel("가호 주머니 1개 (30분)"), "Blessing Pouch x1 (30 min)");
  assert.equal(glossaryLabel("15분 시청 리워드"), "15 min Watch Reward");
  assert.equal(glossaryLabel("Blessing Pouch x1 (60분)"), "Blessing Pouch x1 (60 min)");
});

test("tidyMachine: quotes, minutes, a final full stop and the first letter", () => {
  assert.equal(tidyMachine('"cool summer sandals."'), "Cool summer sandals");
  assert.equal(tidyMachine("1 Stash of Blessing (30 minutes)"), "1 Stash of Blessing (30 min)");
});

test("wantsTranslation: only a name that still carries non-ASCII text", () => {
  assert.equal(wantsTranslation({ name: "Blessing Pouch x1 (30분)" }), true);
  assert.equal(wantsTranslation({ name: "", nameRaw: "시원한 여름 샌들" }), true);
  assert.equal(wantsTranslation({ name: "SOOP Exclusive Spray", nameRaw: "spray-a" }), false);
});

test("labelOf: a clean name as it is; a refused clean English name is left for the owner, never translated", async () => {
  const fetch = fakeFetch({});
  const l = createLabeler({ fetch });
  assert.deepEqual(await l.labelOf({ name: "Gas Ready", nameRaw: "Gas Ready" }), { label: "Gas Ready", how: "name" });
  assert.deepEqual(await l.labelOf({ name: "SOOP Exclusive Spray", nameRaw: "spray-a" }), { label: "", how: "" });
  assert.equal(fetch.calls.length, 0);
});

test("labelOf: the glossary answers before any machine translation", async () => {
  const fetch = fakeFetch({});
  const l = createLabeler({ fetch });
  const r = await l.labelOf({ name: "Blessing Pouch x1 (30분)", nameRaw: "가호 주머니 1개 (30분)" });
  assert.deepEqual(r, { label: "Blessing Pouch x1 (30 min)", how: "glossary" });
  assert.equal(fetch.calls.length, 0);
});

test("labelOf: a machine translation when the glossary cannot finish; asked once per name, logged once", async () => {
  const fetch = fakeFetch({ "시원한 여름 샌들": said("Cool summer sandals") });
  const logs = [];
  const l = createLabeler({ fetch, log: async (e) => logs.push(e) });
  const row = { name: "시원한 여름 샌들", nameRaw: "시원한 여름 샌들" };
  assert.deepEqual(await l.labelOf(row), { label: "Cool summer sandals", how: "machine" });
  assert.deepEqual(await l.labelOf(row), { label: "Cool summer sandals", how: "machine" });
  assert.equal(fetch.calls.length, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0].msg, /Cool summer sandals/);
});

test("labelOf: platform names are cut before the translator sees them, and a translation naming one is refused", async () => {
  const fetch = fakeFetch((q) => (q.includes("샌들") ? said("Chijijik Sandals") : said("Sandals")));
  const l = createLabeler({ fetch });
  const r = await l.labelOf({ name: "", nameRaw: "치지직 여름 샌들" });
  assert.equal(fetch.calls[0].includes("치지직"), false, "the platform name never goes out");
  assert.deepEqual(r, { label: "", how: "" });
});

test("labelOf: a failed translation is retried only after an hour", async () => {
  let t = Date.parse("2026-10-25T00:00:00Z");
  let fail = true;
  const fetch = fakeFetch(() => (fail ? new Error("network down") : said("Nightmare night headwear")));
  const l = createLabeler({ fetch, now: () => t });
  const row = { name: "", nameRaw: "악몽의 밤 헤드웨어" };
  assert.equal((await l.labelOf(row)).label, "");
  fail = false;
  t += 10 * 60 * 1000;
  assert.equal((await l.labelOf(row)).label, "", "inside the hour: not asked again");
  assert.equal(fetch.calls.length, 1);
  t += HOUR;
  assert.equal((await l.labelOf(row)).label, "Nightmare night headwear");
  assert.equal(fetch.calls.length, 2);
});

test("labelOf: a used-up quota pauses machine translation", async () => {
  const t = Date.parse("2026-10-25T00:00:00Z");
  const fetch = fakeFetch(() => ({ responseData: { translatedText: "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS" } }));
  const l = createLabeler({ fetch, now: () => t });
  assert.equal((await l.labelOf({ nameRaw: "첫 번째 보상품" })).label, "");
  assert.equal((await l.labelOf({ nameRaw: "두 번째 보상품" })).label, "");
  assert.equal(fetch.calls.length, 1, "paused after the warning");
});

test("labelOf: no fetch = offline steps only", async () => {
  const l = createLabeler({});
  assert.deepEqual(await l.labelOf({ name: "", nameRaw: "시원한 여름 샌들" }), { label: "", how: "" });
  assert.deepEqual(await l.labelOf({ nameRaw: "가호 주머니 3개 (120분)" }), { label: "Blessing Pouch x3 (120 min)", how: "glossary" });
});
