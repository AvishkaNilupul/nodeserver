// Code shop — buyer-text guard (docs/code-shop/03-MARKETS.md, "textGuard.js").
//
// Buyer-facing text never says where the codes come from (no platform, no
// country, no "official ... event", no "translated") and is plain ASCII, since
// the markets mangle anything else. Nothing is published while this returns a
// problem. Pure: no database, no network, no logging.

const { NON_ASCII_RE } = require("./slots");

// Same list as utils/codeShop/config.js DEFAULTS.sourceWords; used when the
// caller passes no list at all. Keep the two in step.
const DEFAULT_SOURCE_WORDS = Object.freeze([
  "soop",
  "afreeca",
  "korea",
  "\\bkr\\b",
  "translated",
  "official [^.\\n]*event",
  "stage\\s*\\d",
  "kakao",
  "chzzk",
  "naver",
]);

const LIMITS = Object.freeze({ title: 160, description: 2000, coverBullets: 4, label: 80 });

// An empty cover text is not "no text": the promo generator and the offer's
// own cover fill the gap with the farming-service wording, which is the wrong
// product on a code bundle's picture.
const COVER_FALLBACK = "the cover would fall back to the farming-service text";

const NEVER = /(?!)/;
const text = (v) => (v === undefined || v === null ? "" : String(v));

// One case-insensitive RegExp from a list of regex sources. A source that does
// not compile, is blank, or matches the empty string (it would flag every
// text) is skipped, and so is one that breaks the joined pattern (e.g. a
// repeated named group). Nothing usable -> a RegExp that never matches.
function compileSourceWords(list) {
  const ok = [];
  for (const src of Array.isArray(list) ? list : []) {
    if (typeof src !== "string" || !src.trim()) continue;
    try {
      if (new RegExp(src, "i").test("")) continue;
      // Wrapped so a source's own "|" cannot leak into its neighbours.
      new RegExp([...ok, `(?:${src})`].join("|"), "i");
    } catch {
      continue;
    }
    ok.push(`(?:${src})`);
  }
  return ok.length ? new RegExp(ok.join("|"), "i") : new RegExp(NEVER.source, "i");
}

// The matched word (as written in the text) or null. `re` may also be a list
// of sources; a global/sticky RegExp is copied so its lastIndex never leaks.
function findSourceWord(s, re) {
  if (Array.isArray(re)) re = compileSourceWords(re);
  if (!(re instanceof RegExp)) return null;
  if (re.global || re.sticky) re = new RegExp(re.source, re.flags.replace(/[gy]/g, ""));
  const m = re.exec(text(s));
  return m && m[0] ? m[0] : null;
}

function firstNonAscii(s) {
  const m = NON_ASCII_RE.exec(text(s));
  if (!m) return null;
  const hex = m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
  return `${JSON.stringify(m[0])} (U+${hex})`;
}

// texts: { title, description, deliveryTemplate, coverTitle, coverServiceText, coverBullets, labels }
// opts.sourceWords: list of regex sources or a RegExp; omitted -> DEFAULT_SOURCE_WORDS.
// -> [String] problems, in field order; empty = OK.
function checkBuyerText(texts = {}, { sourceWords } = {}) {
  const t = texts || {};
  const re =
    sourceWords instanceof RegExp
      ? sourceWords
      : compileSourceWords(sourceWords === undefined || sourceWords === null ? DEFAULT_SOURCE_WORDS : sourceWords);
  const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map(text);
  const bullets = asList(t.coverBullets);
  const labels = asList(t.labels);

  const title = text(t.title);
  const description = text(t.description);
  const delivery = text(t.deliveryTemplate);

  const problems = [];
  if (!title.trim()) problems.push("title is empty");
  if (title.length > LIMITS.title) {
    problems.push(`title is ${title.length} characters (max ${LIMITS.title})`);
  }
  if (description.length > LIMITS.description) {
    problems.push(`description is ${description.length} characters (max ${LIMITS.description})`);
  }
  if (!delivery.includes("{password}")) {
    problems.push("delivery template has no {password} placeholder (the codes would never reach the buyer)");
  }
  if (!text(t.coverTitle).trim()) problems.push(`cover title is empty (${COVER_FALLBACK})`);
  if (!text(t.coverServiceText).trim()) problems.push(`cover service text is empty (${COVER_FALLBACK})`);
  // A unit's text is one "N) Label = CODE" line per code, and adopt / after-sale
  // read it back with that shape: a label may not span lines or hold an "=".
  labels.forEach((l, i) => {
    if (!l.trim()) problems.push(`label ${i + 1} is empty`);
    else if (/[\r\n]/.test(l)) problems.push(`label ${i + 1} has a line break`);
    else if (l.includes("=")) problems.push(`label ${i + 1} has an "=" (it would break the delivered code lines)`);
    else if (l.length > LIMITS.label) problems.push(`label ${i + 1} is ${l.length} characters (max ${LIMITS.label})`);
  });
  if (bullets.length > LIMITS.coverBullets) {
    problems.push(`cover has ${bullets.length} bullets (max ${LIMITS.coverBullets})`);
  }

  // Every buyer-facing field: [name, value]. All of them get both checks.
  const fields = [
    ["title", title],
    ["description", description],
    ["delivery template", delivery],
    ["cover title", text(t.coverTitle)],
    ["cover service text", text(t.coverServiceText)],
    ...bullets.map((b, i) => [`cover bullet ${i + 1}`, b]),
    ...labels.map((l, i) => [`label ${i + 1}`, l]),
  ];
  for (const [name, value] of fields) {
    const word = findSourceWord(value, re);
    if (word) problems.push(`${name} names where the codes come from: "${word}"`);
    const bad = firstNonAscii(value);
    if (bad) problems.push(`${name} has a non-ASCII character ${bad}`);
  }
  return problems;
}

module.exports = {
  DEFAULT_SOURCE_WORDS,
  LIMITS,
  COVER_FALLBACK,
  compileSourceWords,
  findSourceWord,
  checkBuyerText,
};
