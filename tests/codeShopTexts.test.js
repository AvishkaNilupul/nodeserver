// utils/codeShop/texts.js + games.js: default buyer texts of a code product.
// Titles fit 160 chars (labels dropped from the end, " + more"), descriptions
// fit 2000 (good-to-know lines dropped first), the redeem-by date shows only
// when it is near, and nothing generated is non-ASCII or names a code source.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const { defaultTexts, redeemByText, defaultLabel } = require("../utils/codeShop/texts");
const { GUIDES, guideFor } = require("../utils/codeShop/games");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-15T00:00:00Z");

// The default source-word check, replicated here (01-DATA.md sourceWords),
// plus event brands that must never reach a buyer either.
const SOURCE_WORDS = [
  "soop", "afreeca", "korea", "\\bkr\\b", "translated",
  "official [^.\\n]*event", "stage\\s*\\d", "kakao",
  "owcs", "rise series", "twitch",
];
const SOURCE_RE = new RegExp(SOURCE_WORDS.map((s) => `(?:${s})`).join("|"), "i");
const ASCII_RE = /^[\t\n\r\x20-\x7E]*$/;

function assertClean(text, where) {
  assert.equal(typeof text, "string", `${where} is a string`);
  assert.ok(ASCII_RE.test(text), `${where} is plain ASCII: ${JSON.stringify(text)}`);
  const hit = text.match(SOURCE_RE);
  assert.equal(hit, null, `${where} names a source word: ${hit && hit[0]}`);
}

function assertTextsClean(t, where) {
  for (const k of ["title", "description", "deliveryTemplate", "coverTitle", "coverServiceText"]) {
    assertClean(t[k], `${where}.${k}`);
  }
  assert.ok(Array.isArray(t.coverBullets) && t.coverBullets.length <= 4, `${where}.coverBullets at most 4`);
  t.coverBullets.forEach((b, i) => assertClean(b, `${where}.coverBullets[${i}]`));
}

const slots = (...labels) => labels.map((label, i) => ({ slotKey: `12:x:${i}:1`, label }));
const ow = () => guideFor("12", {});
const df = () => guideFor("200", {});

// --- title -------------------------------------------------------------

test("title: one code", () => {
  const t = defaultTexts({ slots: slots("Sun Tea Player Icon"), guide: ow(), now: NOW });
  assert.equal(t.title, "Overwatch 2 | Sun Tea Player Icon | Redeem Code | Instant Auto Delivery");
});

test("title: a bundle lists every label when it fits", () => {
  const t = defaultTexts({ slots: slots("Prost Spray", "Banana Cat Spray", "Autumn Vibes Name Card"), guide: ow(), now: NOW });
  assert.equal(
    t.title,
    "Overwatch 2 | 3 Codes Bundle | Prost Spray + Banana Cat Spray + Autumn Vibes Name Card | Redeem Codes | Instant Auto Delivery",
  );
});

test("title: over 160 chars drops labels from the end and adds ' + more'", () => {
  const labels = [
    "Sun Tea Player Icon", "Protein Drink Player Icon", "Refreshing Spray",
    "Summer Sandcastle Spray", "Talon Strong Spray", "Esports Loot Box",
  ];
  const full = `Overwatch 2 | 6 Codes Bundle | ${labels.join(" + ")} | Redeem Codes | Instant Auto Delivery`;
  assert.ok(full.length > 160, "the untrimmed title is too long");

  const { title } = defaultTexts({ slots: slots(...labels), guide: ow(), now: NOW });
  assert.ok(title.length <= 160, `fits: ${title.length}`);
  assert.ok(title.startsWith("Overwatch 2 | 6 Codes Bundle | Sun Tea Player Icon + "));
  assert.ok(title.endsWith(" + more | Redeem Codes | Instant Auto Delivery"));
  assert.ok(!title.includes("Esports Loot Box"), "the last label is dropped first");
  // As many labels as fit: one more would not.
  const kept = title.split(" | ")[2].replace(/ \+ more$/, "").split(" + ");
  assert.deepEqual(kept, labels.slice(0, kept.length));
  const oneMore = `Overwatch 2 | 6 Codes Bundle | ${labels.slice(0, kept.length + 1).join(" + ")} + more | Redeem Codes | Instant Auto Delivery`;
  assert.ok(oneMore.length > 160);
});

test("title: when not even one label fits, the labels are left out", () => {
  const huge = "Very Long Reward Name ".repeat(8).trim();
  const many = defaultTexts({ slots: slots(huge, "Second Spray"), guide: df(), now: NOW });
  assert.equal(many.title, "Delta Force | 2 Codes Bundle | Redeem Codes | Instant Auto Delivery");
  const single = defaultTexts({ slots: slots(huge), guide: df(), now: NOW });
  assert.equal(single.title, "Delta Force | Redeem Code | Instant Auto Delivery");
});

// --- description ---------------------------------------------------------

test("description: layout of a bundle, guide lines in order", () => {
  const g = ow();
  const t = defaultTexts({ slots: slots("Prost Spray", "Skal Spray"), guide: g, now: NOW });
  const lines = t.description.split("\n");
  assert.equal(lines[0], "Overwatch 2 - Code Bundle (2 redeem codes)");
  assert.ok(lines.includes("YOU RECEIVE 2 UNUSED REDEEM CODES - ONE OF EACH:"));
  assert.ok(lines.includes("- Prost Spray") && lines.includes("- Skal Spray"));
  assert.ok(lines.includes("- This is a bundle: 1 unit = all 2 codes"));
  assert.ok(lines.includes("- Redeem on your OWN Battle.net account - no account sharing, no login details needed"));
  const how = lines.indexOf("HOW TO REDEEM");
  assert.deepEqual(lines.slice(how + 1, how + 1 + g.howTo.length), g.howTo);
  const good = lines.indexOf("GOOD TO KNOW");
  assert.ok(good > how);
  assert.deepEqual(lines.slice(good + 1), g.goodToKnow);
  assert.ok(t.description.length <= 2000);
});

test("description: one code reads in the singular", () => {
  const t = defaultTexts({ slots: slots("Sun Tea Player Icon"), guide: ow(), useBy: NOW + 5 * DAY, now: NOW });
  const lines = t.description.split("\n");
  assert.equal(lines[0], "Overwatch 2 - Code Bundle (1 redeem code)");
  assert.ok(lines.includes("YOU RECEIVE 1 UNUSED REDEEM CODE:"));
  assert.ok(lines.includes("- 1 unit = 1 redeem code"));
  assert.ok(lines.some((l) => /^REDEEM BY .* - the code stops working after that date\.$/.test(l)));
});

test("description: over 2000 drops good-to-know lines from the end first", () => {
  const g = {
    ...df(),
    goodToKnow: [1, 2, 3, 4, 5, 6].map((i) => `- Good line ${i} ` + "x".repeat(280)),
  };
  const labels = Array.from({ length: 12 }, (_, i) => `Reward number ${i + 1} with a long name`);
  const t = defaultTexts({ slots: slots(...labels), guide: g, useBy: NOW + 3 * DAY, now: NOW });
  assert.ok(t.description.length <= 2000, `fits: ${t.description.length}`);

  const lines = t.description.split("\n");
  for (const l of g.howTo) assert.ok(lines.includes(l), "how-to lines are kept");
  for (const l of labels) assert.ok(lines.includes(`- ${l}`), "every label is kept");
  const kept = lines.slice(lines.indexOf("GOOD TO KNOW") + 1);
  assert.ok(kept.length >= 1 && kept.length < g.goodToKnow.length, `some dropped: kept ${kept.length}`);
  assert.deepEqual(kept, g.goodToKnow.slice(0, kept.length), "the first lines stay, the last go");
  // Only as many dropped as needed: one more line would not fit.
  const withOneMore = t.description + "\n" + g.goodToKnow[kept.length];
  assert.ok(withOneMore.length > 2000);
});

test("description: when every good-to-know line goes, so does its header", () => {
  const g = { ...ow(), goodToKnow: ["- " + "y".repeat(1990)] };
  const t = defaultTexts({ slots: slots("Prost Spray", "Skal Spray"), guide: g, now: NOW });
  assert.ok(t.description.length <= 2000);
  assert.ok(!t.description.includes("GOOD TO KNOW"));
  assert.ok(t.description.endsWith(g.howTo[g.howTo.length - 1]));
});

// --- redeem-by -------------------------------------------------------------

test("redeemByText: the UTC date of useBy minus 24 hours", () => {
  assert.equal(redeemByText("2026-10-22T14:59:00Z"), "21 October 2026");
  assert.equal(redeemByText(new Date("2026-10-22T14:59:00Z")), "21 October 2026");
  assert.equal(redeemByText(Date.parse("2026-10-22T14:59:00Z")), "21 October 2026");
  assert.equal(redeemByText("2026-11-01T00:30:00Z"), "31 October 2026");
  assert.equal(redeemByText("2027-01-01T23:59:59Z"), "31 December 2026");
  assert.equal(redeemByText(null), "");
  assert.equal(redeemByText(""), "");
  assert.equal(redeemByText("not a date"), "");
});

test("REDEEM BY line only when useBy is within 60 days", () => {
  const two = slots("Prost Spray", "Skal Spray");
  const near = defaultTexts({ slots: two, guide: ow(), useBy: "2026-10-22T14:59:00Z", now: NOW });
  assert.ok(near.description.split("\n").includes(
    "REDEEM BY 21 October 2026 - the codes stop working after that date.",
  ));
  const edge = defaultTexts({ slots: two, guide: ow(), useBy: NOW + 60 * DAY, now: NOW });
  assert.ok(edge.description.includes("REDEEM BY "), "exactly 60 days is within");

  const far = defaultTexts({ slots: two, guide: ow(), useBy: NOW + 61 * DAY, now: NOW });
  assert.ok(!far.description.includes("REDEEM BY"));
  assert.ok(!far.deliveryTemplate.includes("redeem by"));
  const none = defaultTexts({ slots: two, guide: ow(), useBy: null, now: NOW });
  assert.ok(!none.description.includes("REDEEM BY"));
  assert.ok(!none.deliveryTemplate.includes("redeem by"));
});

// --- delivery + cover ------------------------------------------------------

test("delivery template: {password}, the redeem-by note and the guide's help", () => {
  const g = df();
  const t = defaultTexts({ slots: slots("Logistics Voucher x3", "Full Firepower x1"), guide: g, useBy: "2026-10-22T14:59:00Z", now: NOW });
  assert.equal(
    t.deliveryTemplate,
    "Thank you for your order! Your Delta Force code bundle (redeem by 21 October 2026):\n{password}\n\n" + g.deliveryHelp,
  );
  assert.ok(t.deliveryTemplate.includes("{password}"));

  const plain = defaultTexts({ slots: slots("Prost Spray"), guide: ow(), now: NOW });
  assert.equal(plain.deliveryTemplate, "Thank you for your order! Your Overwatch 2 code bundle:\n{password}\n\n" + ow().deliveryHelp);
});

test("cover texts for a bundle and for one code", () => {
  const many = defaultTexts({ slots: slots("A Spray", "B Spray", "C Icon"), guide: ow(), now: NOW });
  assert.equal(many.coverTitle, "Overwatch 2 Code Bundle");
  assert.equal(many.coverServiceText, "3 Redeem Codes");
  assert.deepEqual(many.coverBullets, ["Instant Automatic Delivery", "3 Codes - One of Each", "Redeem on Your Own Account"]);

  const one = defaultTexts({ slots: slots("A Spray"), guide: df(), now: NOW });
  assert.equal(one.coverTitle, "Delta Force Code Bundle");
  assert.equal(one.coverServiceText, "1 Redeem Code");
  assert.deepEqual(one.coverBullets, ["Instant Automatic Delivery", "1 Redeem Code", "Redeem on Your Own Account"]);
});

// --- clean text ------------------------------------------------------------

test("every guide line is ASCII and free of source words", () => {
  for (const key of ["12", "200", "default"]) {
    const g = GUIDES[key];
    for (const f of ["displayName", "marketGame", "accountWord", "deliveryHelp"]) assertClean(g[f], `${key}.${f}`);
    assert.ok(g.howTo.length > 0 && g.goodToKnow.length > 0);
    g.howTo.forEach((l, i) => assertClean(l, `${key}.howTo[${i}]`));
    g.goodToKnow.forEach((l, i) => assertClean(l, `${key}.goodToKnow[${i}]`));
    assert.ok(g.displayName && g.accountWord && g.deliveryHelp, `${key} has its words`);
  }
});

test("every generated text is ASCII and free of source words (all guides)", () => {
  const sets = [
    slots("Sun Tea Player Icon"),
    slots("Prost Spray", "Purrfect Afternoon Spray", "Skal Spray", "Banana Cat Spray", "Autumn Vibes Name Card"),
    slots(...Array.from({ length: 18 }, (_, i) => `Reward ${i + 1} Spray Paint`)),
  ];
  for (const key of ["12", "200", "default", "999"]) {
    const g = key === "default" ? GUIDES.default : guideFor(key, {});
    for (const s of sets) {
      for (const useBy of [null, NOW + 2 * DAY, NOW + 90 * DAY]) {
        assertTextsClean(defaultTexts({ slots: s, guide: g, useBy, now: NOW }), `${key}/${s.length}/${useBy}`);
      }
    }
  }
});

test("no guide given falls back to the default guide", () => {
  const t = defaultTexts({ slots: slots("A Spray", "B Spray"), now: NOW });
  assert.ok(t.title.startsWith("Game | 2 Codes Bundle | "));
  assert.ok(t.deliveryTemplate.endsWith(GUIDES.default.deliveryHelp));
  assertTextsClean(t, "no-guide");
});

// --- defaultLabel ------------------------------------------------------------

test("defaultLabel: ASCII names without source words, else empty", () => {
  assert.equal(defaultLabel({ name: "Banana Cat Spray" }), "Banana Cat Spray");
  assert.equal(defaultLabel({ name: "  Kraken Spray  " }), "Kraken Spray", "\\bkr\\b is a word, not a prefix");
  assert.equal(defaultLabel({ name: "Skål Spray" }), "Skal Spray", "accents fold to ASCII");
  assert.equal(defaultLabel({ name: "Café Crème Icon" }), "Cafe Creme Icon");
  assert.equal(defaultLabel({ name: "Skål 물류" }), "", "a non-Latin letter still leaves it empty");
  assert.equal(defaultLabel({ name: "물류 증표*3" }), "");
  assert.equal(defaultLabel({ name: "SOOP Exclusive Icon" }), "");
  assert.equal(defaultLabel({ name: "KR Server Spray" }), "");
  assert.equal(defaultLabel({ name: "Stage 3 Icon" }), "");
  assert.equal(defaultLabel({ name: "Official Drops Event Spray" }), "");
  assert.equal(defaultLabel({ name: "Two\nLines" }), "");
  assert.equal(defaultLabel({ name: "" }), "");
  assert.equal(defaultLabel({}), "");
  assert.equal(defaultLabel(null), "");
  assert.equal(defaultLabel({ name: 42 }), "");
});

test("defaultLabel: a given source-word list replaces the default", () => {
  assert.equal(defaultLabel({ name: "Kraken Spray" }, { sourceWords: ["kraken"] }), "");
  assert.equal(defaultLabel({ name: "SOOP Icon" }, { sourceWords: ["kraken"] }), "SOOP Icon");
  assert.equal(defaultLabel({ name: "Kraken Spray" }, { sourceWords: ["(bad", "kraken"] }), "", "a bad source is skipped");
});

test("defaultLabel: reads config DEFAULTS.sourceWords when ./config loads, else the documented list", () => {
  const realLoad = Module._load;
  let mode = "config";
  Module._load = function (request, parent, isMain) {
    if (request === "./config" && parent && /codeShop[\\/]texts\.js$/.test(parent.filename || "")) {
      if (mode === "config") return { DEFAULTS: { sourceWords: ["banana"] } };
      const err = new Error("Cannot find module './config'");
      err.code = "MODULE_NOT_FOUND";
      throw err;
    }
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    assert.equal(defaultLabel({ name: "Banana Cat Spray" }), "", "config's list is used");
    assert.equal(defaultLabel({ name: "Korea Spray" }), "Korea Spray", "config's list replaces the fallback");
    mode = "missing";
    assert.equal(defaultLabel({ name: "Banana Cat Spray" }), "Banana Cat Spray");
    assert.equal(defaultLabel({ name: "Korea Spray" }), "", "fallback list when ./config is missing");
  } finally {
    Module._load = realLoad;
  }
});

// --- guideFor ----------------------------------------------------------------

test("guideFor merges config displayName / marketGame over the guide", () => {
  const config = { games: { "12": { sell: true, displayName: "OW 2", marketGame: "Overwatch X" }, "77": { displayName: "Some Game", marketGame: "Some Game" } } };
  const g = guideFor("12", config);
  assert.equal(g.displayName, "OW 2");
  assert.equal(g.marketGame, "Overwatch X");
  assert.equal(g.accountWord, "Battle.net");
  assert.deepEqual(g.howTo, [...GUIDES["12"].howTo]);
  assert.deepEqual(g.goodToKnow, [...GUIDES["12"].goodToKnow]);
  assert.equal(g.deliveryHelp, GUIDES["12"].deliveryHelp);
  assert.equal(g.sell, undefined, "only the two names are merged");

  assert.equal(guideFor(12, config).displayName, "OW 2", "a numeric gameNo works");

  const other = guideFor("77", config);
  assert.equal(other.displayName, "Some Game");
  assert.equal(other.marketGame, "Some Game");
  assert.deepEqual(other.howTo, [...GUIDES.default.howTo]);

  const blank = guideFor("200", { games: { "200": { displayName: "  ", marketGame: "" } } });
  assert.equal(blank.displayName, "Delta Force", "an empty override is ignored");
  assert.equal(blank.marketGame, "Delta Force");

  assert.equal(guideFor("12").displayName, "Overwatch 2");
  assert.equal(guideFor("12", null).marketGame, "Overwatch");
  assert.equal(guideFor("999", { games: {} }).accountWord, "game");
  assert.equal(guideFor("toString", {}).displayName, "Game", "no prototype keys");
});

test("guideFor returns a copy: editing it never changes the shared guides", () => {
  const g = guideFor("12", {});
  g.displayName = "changed";
  g.howTo.push("extra");
  g.goodToKnow.length = 0;
  const again = guideFor("12", {});
  assert.equal(again.displayName, "Overwatch 2");
  assert.equal(again.howTo.length, GUIDES["12"].howTo.length);
  assert.ok(again.goodToKnow.length > 0);
  assert.ok(Object.isFrozen(GUIDES) && Object.isFrozen(GUIDES["12"].howTo));
});
