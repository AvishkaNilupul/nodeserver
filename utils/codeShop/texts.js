// Code shop — default buyer texts (contract 02-ENGINE.md, texts.js).
//
// Pure: builds the title, description, delivery message and cover texts of a
// product from its slots and its game's guide (games.js). No database, no
// network, no logging. The owner may edit any of it before approving; the
// text guard checks the result at publish time.

const DAY_MS = 24 * 60 * 60 * 1000;
const TITLE_MAX = 160;
const DESCRIPTION_MAX = 2000;
// A use-by date further away than this is not worth a line in the listing.
const REDEEM_BY_WINDOW_MS = 60 * DAY_MS;
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// The default source words (01-DATA.md, config DEFAULTS.sourceWords). Used
// only when ./config cannot be loaded at call time.
const FALLBACK_SOURCE_WORDS = [
  "soop",
  "afreeca",
  "korea",
  "\\bkr\\b",
  "translated",
  "official [^.\\n]*event",
  "stage\\s*\\d",
  "kakao",
];

// A label is one line of the unit text ("1) Label = CODE"): printable ASCII only.
const LABEL_RE = /^[\x20-\x7E]+$/;

function toMs(v) {
  if (v == null || v === "") return null;
  const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

// The date a buyer is told to redeem by: the UTC calendar day of useBy - 24 h,
// so it is on or before the real last day in every time zone.
// e.g. 2026-10-22T14:59Z -> "21 October 2026". Unknown useBy -> "".
function redeemByText(useBy) {
  const ms = toMs(useBy);
  if (ms == null) return "";
  const d = new Date(ms - DAY_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function defaultSourceWords() {
  // Lazy: config.js may not exist yet (or fail to load); the label check must
  // still work, so fall back to the documented list.
  try {
    const cfg = require("./config");
    const list = cfg && cfg.DEFAULTS && cfg.DEFAULTS.sourceWords;
    if (Array.isArray(list)) return list;
  } catch (_) {
    // fall through
  }
  return FALLBACK_SOURCE_WORDS;
}

let compiled = { key: null, re: null };
function sourceWordRe(list) {
  const sources = (Array.isArray(list) ? list : []).filter((s) => {
    if (typeof s !== "string" || s === "") return false;
    try {
      new RegExp(s, "i");
      return true;
    } catch (_) {
      return false; // a bad source is skipped, as the text guard does
    }
  });
  const key = sources.join("\u0000");
  if (compiled.key !== key) {
    compiled = { key, re: sources.length ? new RegExp(sources.map((s) => `(?:${s})`).join("|"), "i") : null };
  }
  return compiled.re;
}

// The label a slot gets by default: the reward's English name when it is
// plain ASCII and says nothing about where it came from, else "" (the owner
// writes one). `sourceWords` overrides the default list (e.g. the config's).
// Latin letters with accents fold to plain ASCII ("Skål Spray" -> "Skal Spray",
// the spelling the hand-made bundles already used); other scripts stay empty.
function foldAccents(s) {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function defaultLabel(row, { sourceWords } = {}) {
  const name = row && typeof row.name === "string" ? foldAccents(row.name).trim() : "";
  if (!name || !LABEL_RE.test(name)) return "";
  const re = sourceWordRe(Array.isArray(sourceWords) ? sourceWords : defaultSourceWords());
  return re && re.test(name) ? "" : name;
}

function buildTitle(display, labels) {
  const n = labels.length;
  const parts = (seg) =>
    (n === 1
      ? [display, seg, "Redeem Code", "Instant Auto Delivery"]
      : [display, `${n} Codes Bundle`, seg, "Redeem Codes", "Instant Auto Delivery"]
    ).filter(Boolean).join(" | ");
  // Too long: drop labels from the end and say there is more.
  for (let k = n; k >= 1; k--) {
    const seg = labels.slice(0, k).join(" + ") + (k < n ? " + more" : "");
    const title = parts(seg);
    if (title.length <= TITLE_MAX) return title;
  }
  // Not even one label fits: leave them all out (the description lists them).
  const bare = parts("");
  return bare.length <= TITLE_MAX ? bare : bare.slice(0, TITLE_MAX).trimEnd();
}

function buildDescription({ display, labels, guide, redeemBy }) {
  const n = labels.length;
  const one = n === 1;
  const head = [`${display} - Code Bundle (${n} redeem ${one ? "code" : "codes"})`, ""];
  if (redeemBy) {
    head.push(`REDEEM BY ${redeemBy} - the ${one ? "code stops" : "codes stop"} working after that date.`, "");
  }
  head.push(one ? "YOU RECEIVE 1 UNUSED REDEEM CODE:" : `YOU RECEIVE ${n} UNUSED REDEEM CODES - ONE OF EACH:`);
  for (const label of labels) head.push(`- ${label}`);
  head.push(
    "",
    one ? "- 1 unit = 1 redeem code" : `- This is a bundle: 1 unit = all ${n} codes`,
    "- Instant automatic delivery in the order chat, 24/7",
    `- Redeem on your OWN ${guide.accountWord} account - no account sharing, no login details needed`,
    "",
    "HOW TO REDEEM",
    ...guide.howTo,
  );
  const good = [...guide.goodToKnow];
  const render = () => (good.length ? [...head, "", "GOOD TO KNOW", ...good] : head).join("\n");
  let text = render();
  // Over the limit: the good-to-know lines go first, from the end.
  while (text.length > DESCRIPTION_MAX && good.length) {
    good.pop();
    text = render();
  }
  return text;
}

// The default texts of a product. `now` (ms or Date, default the clock)
// decides whether the use-by date is close enough to print.
function defaultTexts({ slots, guide, useBy, now } = {}) {
  const g = guide || require("./games").GUIDES.default;
  const labels = (Array.isArray(slots) ? slots : []).map((s) => String((s && s.label) || "").trim());
  const n = labels.length;
  const display = String(g.displayName || "").trim();
  const nowMs = toMs(now) ?? Date.now();
  const useByMs = toMs(useBy);
  const redeemBy = useByMs != null && useByMs - nowMs <= REDEEM_BY_WINDOW_MS ? redeemByText(useByMs) : "";

  return {
    title: buildTitle(display, labels),
    description: buildDescription({ display, labels, guide: g, redeemBy }),
    deliveryTemplate:
      `Thank you for your order! Your ${display} code bundle` +
      (redeemBy ? ` (redeem by ${redeemBy})` : "") +
      `:\n{password}\n\n${g.deliveryHelp}`,
    coverTitle: `${display} Code Bundle`,
    coverServiceText: `${n} Redeem Code${n > 1 ? "s" : ""}`,
    coverBullets: [
      "Instant Automatic Delivery",
      n > 1 ? `${n} Codes - One of Each` : "1 Redeem Code",
      "Redeem on Your Own Account",
    ],
  };
}

module.exports = {
  defaultTexts,
  redeemByText,
  defaultLabel,
  TITLE_MAX,
  DESCRIPTION_MAX,
  REDEEM_BY_WINDOW_MS,
  FALLBACK_SOURCE_WORDS,
};
