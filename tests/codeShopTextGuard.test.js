// Code shop — buyer-text guard (docs/code-shop/03-MARKETS.md, "textGuard.js").
// Pure: every text here is made up.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_SOURCE_WORDS,
  LIMITS,
  compileSourceWords,
  findSourceWord,
  checkBuyerText,
} = require("../utils/codeShop/textGuard");

// A text set shaped like texts.js defaults, free of every problem.
const clean = () => ({
  title: "Overwatch 2 | 2 Codes Bundle | Made Up Spray + Made Up Icon | Redeem Codes | Instant Auto Delivery",
  description: [
    "Overwatch 2 - Code Bundle (2 redeem codes)",
    "YOU RECEIVE 2 UNUSED REDEEM CODES - ONE OF EACH:",
    "- Made Up Spray",
    "- Made Up Icon",
    "HOW TO REDEEM",
    "Sign in on the redeem page and enter each code with the dashes.",
  ].join("\n"),
  deliveryTemplate: "Thank you for your order! Your Overwatch 2 code bundle:\n{password}\n\nMessage us first if anything is off.",
  coverTitle: "Overwatch 2 Code Bundle",
  coverServiceText: "2 Redeem Codes",
  coverBullets: ["Instant Automatic Delivery", "2 Codes - One of Each", "Redeem on Your Own Account"],
  labels: ["Made Up Spray", "Made Up Icon"],
});

const has = (problems, re) => problems.some((p) => re.test(p));

/* ------------------------------ clean text ------------------------------- */

test("clean buyer text has no problems", () => {
  assert.deepEqual(checkBuyerText(clean()), []);
  assert.deepEqual(checkBuyerText(clean(), { sourceWords: DEFAULT_SOURCE_WORDS }), []);
});

test("limits are exact: 160 title chars, 2000 description chars, 4 bullets pass", () => {
  const t = clean();
  t.title = "T".repeat(160);
  t.description = "D".repeat(2000);
  t.coverBullets = ["one", "two", "three", "four"];
  assert.deepEqual(checkBuyerText(t), []);
  assert.deepEqual(LIMITS, { title: 160, description: 2000, coverBullets: 4, label: 80 });
});

/* ----------------------------- problem kinds ----------------------------- */

test("an empty or blank title is a problem", () => {
  for (const title of ["", "   ", undefined, null]) {
    const p = checkBuyerText({ ...clean(), title });
    assert.ok(has(p, /^title is empty$/), JSON.stringify(title));
  }
});

test("a title over 160 characters is a problem", () => {
  const p = checkBuyerText({ ...clean(), title: "T".repeat(161) });
  assert.deepEqual(p, ["title is 161 characters (max 160)"]);
});

test("a description over 2000 characters is a problem", () => {
  const p = checkBuyerText({ ...clean(), description: "D".repeat(2001) });
  assert.deepEqual(p, ["description is 2001 characters (max 2000)"]);
});

test("an empty description is allowed", () => {
  assert.deepEqual(checkBuyerText({ ...clean(), description: "" }), []);
});

test("a delivery template without {password} is a problem", () => {
  for (const deliveryTemplate of ["Thank you! Here are your codes.", "{ password }", "{PASSWORD}", "", undefined]) {
    const p = checkBuyerText({ ...clean(), deliveryTemplate });
    assert.equal(p.length, 1, JSON.stringify(deliveryTemplate));
    assert.match(p[0], /^delivery template has no \{password\}/);
  }
  assert.deepEqual(checkBuyerText({ ...clean(), deliveryTemplate: "{password}" }), []);
});

test("an empty label is a problem, named by its position", () => {
  const p = checkBuyerText({ ...clean(), labels: ["Made Up Spray", "", "  ", "Made Up Icon"] });
  assert.deepEqual(p, ["label 2 is empty", "label 3 is empty"]);
  assert.deepEqual(checkBuyerText({ ...clean(), labels: [null] }), ["label 1 is empty"]);
});

test("no labels at all is not a label problem", () => {
  assert.deepEqual(checkBuyerText({ ...clean(), labels: [] }), []);
  assert.deepEqual(checkBuyerText({ ...clean(), labels: undefined }), []);
});

test("more than 4 cover bullets is a problem", () => {
  const p = checkBuyerText({ ...clean(), coverBullets: ["a", "b", "c", "d", "e"] });
  assert.deepEqual(p, ["cover has 5 bullets (max 4)"]);
});

test("every problem is reported at once, in field order", () => {
  const p = checkBuyerText({
    title: "",
    description: "D".repeat(2001),
    deliveryTemplate: "no placeholder",
    coverTitle: "",
    coverServiceText: "",
    coverBullets: ["a", "b", "c", "d", "e"],
    labels: [""],
  });
  assert.deepEqual(p, [
    "title is empty",
    "description is 2001 characters (max 2000)",
    "delivery template has no {password} placeholder (the codes would never reach the buyer)",
    "label 1 is empty",
    "cover has 5 bullets (max 4)",
  ]);
});

test("missing input reads as empty text", () => {
  const p = checkBuyerText();
  assert.ok(has(p, /^title is empty$/));
  assert.ok(has(p, /^delivery template has no \{password\}/));
  assert.equal(p.length, 2);
});

/* ------------------------------ source words ----------------------------- */

const FIELDS = [
  ["title", (t, s) => (t.title = `Overwatch 2 ${s} Codes`)],
  ["description", (t, s) => (t.description += `\nCodes from the ${s} side.`)],
  ["delivery template", (t, s) => (t.deliveryTemplate = `Your ${s} codes:\n{password}`)],
  ["cover title", (t, s) => (t.coverTitle = `${s} Code Bundle`)],
  ["cover service text", (t, s) => (t.coverServiceText = `2 ${s} Codes`)],
  ["cover bullet 2", (t, s) => (t.coverBullets[1] = `${s} codes`)],
  ["label 1", (t, s) => (t.labels[0] = `${s} Spray`)],
];

test("a source word is found in every field, labels and cover bullets included", () => {
  for (const [name, put] of FIELDS) {
    const t = clean();
    put(t, "Soop");
    assert.deepEqual(checkBuyerText(t), [`${name} names where the codes come from: "Soop"`], name);
  }
});

test("source words are found case-insensitively and named as written", () => {
  for (const word of ["SOOP", "soop", "AfreecaTV", "kOrEa", "Kakao", "TRANSLATED"]) {
    const t = clean();
    t.title = `Overwatch 2 ${word} Codes`;
    const p = checkBuyerText(t);
    assert.equal(p.length, 1, word);
    const found = word === "AfreecaTV" ? "Afreeca" : word;
    assert.equal(p[0], `title names where the codes come from: "${found}"`);
  }
});

test("one problem per field even when a field holds several source words", () => {
  const p = checkBuyerText({ ...clean(), title: "SOOP Korea codes, translated" });
  assert.deepEqual(p, ['title names where the codes come from: "SOOP"']);
});

test("the default word list is the contract's list", () => {
  assert.deepEqual(
    [...DEFAULT_SOURCE_WORDS],
    ["soop", "afreeca", "korea", "\\bkr\\b", "translated", "official [^.\\n]*event", "stage\\s*\\d", "kakao"],
  );
  assert.ok(Object.isFrozen(DEFAULT_SOURCE_WORDS));
});

test("the default word list catches region, event and translation wording", () => {
  const re = compileSourceWords(DEFAULT_SOURCE_WORDS);
  const caught = [
    ["Codes from Korea", "Korea"],
    ["Korean server codes", "Korea"],
    ["KR codes", "KR"],
    ["Region: KR ", "KR"],
    ["(kr)", "kr"],
    ["From the official Overwatch drops event", "official Overwatch drops event"],
    ["Official watch EVENT reward", "Official watch EVENT"],
    ["Stage 2 reward", "Stage 2"],
    ["stage3 reward", "stage3"],
    ["names translated by us", "translated"],
    ["sooplive drops", "soop"],
    ["kakao gift", "kakao"],
  ];
  for (const [s, word] of caught) assert.equal(findSourceWord(s, re), word, s);
});

test("the default word list leaves ordinary words alone", () => {
  const re = compileSourceWords(DEFAULT_SOURCE_WORDS);
  for (const s of [
    "Kraken Spray",
    "Krypton Icon",
    "Arkham Banner",
    "Official redeem page",
    "The event ends soon. Official codes.",
    "Backstage pass",
    "Redeem on your own account",
  ]) {
    assert.equal(findSourceWord(s, re), null, s);
  }
  assert.deepEqual(checkBuyerText({ ...clean(), labels: ["Kraken Spray", "Made Up Icon"] }), []);
});

test("a caller's word list replaces the default list", () => {
  const t = { ...clean(), title: "Overwatch 2 Korea Codes", coverTitle: "Pinecone Code Bundle" };
  assert.deepEqual(checkBuyerText(t, { sourceWords: ["pinecone"] }), [
    'cover title names where the codes come from: "Pinecone"',
  ]);
  assert.deepEqual(checkBuyerText(t, { sourceWords: /pine\w+/gi }), [
    'cover title names where the codes come from: "Pinecone"',
  ]);
  // An explicitly empty list checks no words; the other checks still run.
  assert.deepEqual(checkBuyerText(t, { sourceWords: [] }), []);
  assert.deepEqual(checkBuyerText({ ...t, title: "" }, { sourceWords: [] }), ["title is empty"]);
});

/* -------------------------------- non-ASCII ------------------------------- */

test("a non-ASCII character is a problem in every field", () => {
  for (const [name, put] of FIELDS) {
    const t = clean();
    put(t, "Skål");
    assert.deepEqual(checkBuyerText(t), [`${name} has a non-ASCII character "å" (U+00E5)`], name);
  }
});

test("non-ASCII problems name the first bad character", () => {
  const p = (title) => checkBuyerText({ ...clean(), title });
  assert.deepEqual(p("Overwatch — Codes ’"), ['title has a non-ASCII character "—" (U+2014)']);
  assert.deepEqual(p("Gift \u{1F381} Codes"), ['title has a non-ASCII character "\u{1F381}" (U+1F381)']);
  assert.deepEqual(p("Codes\u0000"), ['title has a non-ASCII character "\\u0000" (U+0000)']);
  assert.deepEqual(p("Codes Bundle"), ['title has a non-ASCII character " " (U+00A0)']);
});

test("a field can have both a source word and a non-ASCII character", () => {
  const p = checkBuyerText({ ...clean(), labels: ["Korea Skål Spray", "Made Up Icon"] });
  assert.deepEqual(p, [
    'label 1 names where the codes come from: "Korea"',
    'label 1 has a non-ASCII character "å" (U+00E5)',
  ]);
});

/* --------------------------- compileSourceWords --------------------------- */

test("compileSourceWords joins the sources into one case-insensitive RegExp", () => {
  const re = compileSourceWords(["alpha", "be+ta"]);
  assert.ok(re instanceof RegExp);
  assert.ok(re.flags.includes("i"));
  assert.equal(re.global, false);
  assert.equal(re.source, "(?:alpha)|(?:be+ta)");
  assert.ok(re.test("ALPHA"));
  assert.ok(re.test("beeeta"));
  assert.ok(!re.test("gamma"));
});

test("compileSourceWords keeps a source's own alternation to itself", () => {
  const re = compileSourceWords(["^x|y$", "zed"]);
  assert.ok(re.test("x at the start"));
  assert.ok(re.test("ends with y"));
  assert.ok(re.test("the zed in the middle"));
});

test("compileSourceWords skips bad sources and keeps the good ones", () => {
  const re = compileSourceWords(["(", "korea", "[a-", "*oops", "\\bkr\\b", "(?<n>a)", "(?<n>b)"]);
  assert.equal(findSourceWord("Korea", re), "Korea");
  assert.equal(findSourceWord("KR codes", re), "KR");
  assert.equal(findSourceWord("a", re), "a");
  // The repeated group name could not be joined, so "b" is not a word.
  assert.equal(findSourceWord("b", re), null);
  assert.equal(findSourceWord("( [a- *oops", re), "a");
  assert.equal(findSourceWord("nothing here", re), null);
});

test("compileSourceWords skips blank, non-string and empty-matching sources", () => {
  const re = compileSourceWords(["", "   ", null, 42, {}, "x*", "(?:)", "kakao"]);
  assert.equal(findSourceWord("plain text", re), null);
  assert.equal(findSourceWord("Kakao", re), "Kakao");
});

test("compileSourceWords with nothing usable never matches", () => {
  for (const list of [[], ["("], undefined, null, "korea"]) {
    const re = compileSourceWords(list);
    assert.ok(re instanceof RegExp);
    assert.equal(findSourceWord("korea soop kakao", re), null, JSON.stringify(list));
    assert.equal(findSourceWord("", re), null);
  }
});

/* ----------------------------- findSourceWord ----------------------------- */

test("findSourceWord returns the matched text or null", () => {
  const re = compileSourceWords(DEFAULT_SOURCE_WORDS);
  assert.equal(findSourceWord("Codes from KOREA", re), "KOREA");
  assert.equal(findSourceWord("Plain codes", re), null);
  assert.equal(findSourceWord("", re), null);
  assert.equal(findSourceWord(null, re), null);
  assert.equal(findSourceWord(undefined, re), null);
});

test("findSourceWord accepts a word list and refuses a non-pattern", () => {
  assert.equal(findSourceWord("Soop codes", ["soop"]), "Soop");
  assert.equal(findSourceWord("Soop codes", "soop"), null);
  assert.equal(findSourceWord("Soop codes", null), null);
});

test("findSourceWord gives the same answer every call with a global RegExp", () => {
  const re = /korea/gi;
  for (let i = 0; i < 3; i++) assert.equal(findSourceWord("Korea", re), "Korea");
  assert.equal(re.lastIndex, 0);
});

test("a label must stay one short line without '=' (unit lines are parsed back)", () => {
  const base = { title: "T", description: "", deliveryTemplate: "{password}" };
  const p = (labels) => checkBuyerText({ ...base, labels }, { sourceWords: [] });
  assert.deepEqual(p(["Fine Label"]), []);
  assert.ok(p(["two\nlines"]).some((x) => /line break/.test(x)));
  assert.ok(p(["a = b"]).some((x) => /"="/.test(x)));
  assert.ok(p(["x".repeat(81)]).some((x) => /max 80/.test(x)));
});
