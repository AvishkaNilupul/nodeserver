// Code shop — default buyer texts (contract 02-ENGINE.md, texts.js).
//
// Pure: builds the title, description, delivery message and cover texts of a
// product from its slots and its game's guide (games.js). No database, no
// network, no logging. The owner may edit any of it before approving; the
// text guard checks the result at publish time.
//
// Every text names the event the codes come from by its START DATE only
// (eventDates.js) and says how long the codes stay valid: a reward of one
// event redeems once per account, so a buyer must be able to tell which of
// our bundles share an event. Nothing says where the codes come from.

const DAY_MS = 24 * 60 * 60 * 1000;
const TITLE_MAX = 160;
const DESCRIPTION_MAX = 2000;
// A use-by date at most this far away reads as a warning ("REDEEM BY ...");
// a later one as a promise ("VALID UNTIL ...").
const REDEEM_BY_WINDOW_MS = 60 * DAY_MS;
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));
// More event dates than this print as a range ("8 to 20 October 2026").
const EVENT_LIST_MAX = 3;
// A reward a buyer may think stacks (a box, a pack): named in the
// once-per-account line so nobody buys two expecting two.
const STACKABLE_RE = /\b(?:loot\s*box(?:es)?|box(?:es)?|crates?|chests?|capsules?|packs?|packages?)\b/i;

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

// Event dates as buyer text. One UTC calendar day per event, oldest first;
// the month is printed after the last day of each month, the year after the
// last day of each year:
//   long:  "11 October 2026", "8, 9 and 10 October 2026", "30 September and 2 October 2026"
//   short: "11 Oct 2026",     "8, 9, 10 Oct 2026",        "30 Sep, 2 Oct 2026"
// More than EVENT_LIST_MAX days: the first and last ("8 to 20 October 2026" /
// "8-20 Oct 2026"). Nothing known -> "".
// Unique UTC calendar days of `dates`, oldest first: [{ y, m, d }].
function eventDays(dates) {
  const seen = new Set();
  const days = [];
  for (const v of Array.isArray(dates) ? dates : dates == null ? [] : [dates]) {
    const ms = toMs(v);
    if (ms == null) continue;
    const t = new Date(ms);
    const day = { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
    const key = `${day.y}-${day.m}-${day.d}`;
    if (seen.has(key)) continue;
    seen.add(key);
    days.push(day);
  }
  return days.sort((a, b) => a.y - b.y || a.m - b.m || a.d - b.d);
}

function eventDatesText(dates, { short = false } = {}) {
  const days = eventDays(dates);
  if (!days.length) return "";
  const names = short ? MONTHS_SHORT : MONTHS;
  const render = (list) =>
    list.map((x, i) => {
      const next = list[i + 1];
      let out = String(x.d);
      if (!next || next.m !== x.m || next.y !== x.y) out += " " + names[x.m];
      if (!next || next.y !== x.y) out += " " + x.y;
      return out;
    });
  if (days.length > EVENT_LIST_MAX) {
    const [a, b] = render([days[0], days[days.length - 1]]);
    return short ? `${a}-${b}` : `${a} to ${b}`;
  }
  const parts = render(days);
  if (parts.length === 1 || short) return parts.join(", ");
  return parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
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

// The event part sits right after the game and the count: a market with a
// shorter title (fitTitle) drops parts from the END, so it keeps this one.
function buildTitle(display, labels, eventPart = "") {
  const n = labels.length;
  const parts = (seg) =>
    (n === 1
      ? [display, eventPart, seg, "Redeem Code", "Instant Auto Delivery"]
      : [display, `${n} Codes Bundle`, eventPart, seg, "Redeem Codes", "Instant Auto Delivery"]
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

// The once-per-account line names a box or pack reward when there is one, and
// a second line says what a buyer sees when the account already got it: the
// redeem page answers "not eligible" (a buyer's own words, 2026-10-19).
function stackableNote(labels) {
  const hits = labels.filter((l) => STACKABLE_RE.test(l));
  if (!hits.length) return "";
  return hits.length === 1 ? ` - that includes the ${hits[0]}` : " - that includes boxes and packs";
}

function stackableLine(labels, accountWord) {
  const hits = labels.filter((l) => STACKABLE_RE.test(l));
  if (!hits.length) return "";
  const what = hits.length === 1 ? `this event's ${hits[0]}` : "one of this event's boxes or packs";
  return `- If this ${accountWord} account already got ${what} (from another bundle or any other way), that code will be refused as not eligible.`;
}

// Lines that may go, in this order, when the description is still over the
// limit after every good-to-know line went (a very large bundle). The
// once-per-account rule itself always stays.
const OPTIONAL_LINES = ["already", "more", "delivery", "own"];

function buildDescription({ display, labels, guide, redeemBy, validUntil, eventLong, eventCount }) {
  const n = labels.length;
  const one = n === 1;
  const many = eventCount > 1;
  const facts = [];
  if (eventLong) {
    facts.push(
      many
        ? `EVENTS: ${eventLong} - each code is from one of these events.`
        : `EVENT: ${eventLong} - ${one ? "the code is" : "every code in this bundle is"} from this event.`,
    );
  }
  const stops = `the ${one ? "code stops" : "codes stop"} working after that date.`;
  if (redeemBy) facts.push(`REDEEM BY ${redeemBy} - ${stops}`);
  else if (validUntil) facts.push(`VALID UNTIL ${validUntil} - ${stops}`);
  const optional = {
    already: !eventLong
      ? "- Already have one of these rewards? A reward the account already has will not be added again."
      : many
        ? "- Already have a bundle from any of these events? Compare the reward lists: a reward the account already has will not be added again."
        : `- Already have a bundle from the event of ${eventLong}? Compare the reward lists: a reward the account already has will not be added again.`,
    more: one
      ? "- Want this reward on more than one account? Buy one code per account."
      : "- Want these rewards on more than one account? Buy one bundle per account.",
    delivery: "- Instant automatic delivery in the order chat, 24/7",
    own: `- Redeem on your OWN ${guide.accountWord} account - no account sharing, no login details needed`,
  };
  const dropped = new Set();
  const opt = (k) => (dropped.has(k) ? [] : [optional[k]]);
  const headLines = () => [
    `${display} - Code Bundle (${n} redeem ${one ? "code" : "codes"})`,
    "",
    ...(facts.length ? [...facts, ""] : []),
    one ? "YOU RECEIVE 1 UNUSED REDEEM CODE:" : `YOU RECEIVE ${n} UNUSED REDEEM CODES - ONE OF EACH:`,
    ...labels.map((label) => `- ${label}`),
    "",
    "ONE OF EACH REWARD PER ACCOUNT",
    `- A reward from one event can be redeemed only once per ${guide.accountWord} account${stackableNote(labels)}. ` +
      "Two codes for the same reward will not both work on one account.",
    ...[stackableLine(labels, guide.accountWord)].filter(Boolean),
    ...opt("already"),
    ...opt("more"),
    "",
    one ? "- 1 unit = 1 redeem code" : `- This is a bundle: 1 unit = all ${n} codes`,
    ...opt("delivery"),
    ...opt("own"),
    "",
    "HOW TO REDEEM",
    ...guide.howTo,
  ];
  const good = [...guide.goodToKnow];
  const render = () => {
    const head = headLines();
    return (good.length ? [...head, "", "GOOD TO KNOW", ...good] : head).join("\n");
  };
  let text = render();
  // Over the limit: the good-to-know lines go first, from the end; then the
  // optional lines above. Still over -> returned as is (the text guard refuses it).
  while (text.length > DESCRIPTION_MAX && good.length) {
    good.pop();
    text = render();
  }
  for (const k of OPTIONAL_LINES) {
    if (text.length <= DESCRIPTION_MAX) break;
    dropped.add(k);
    text = render();
  }
  return text;
}

// The default texts of a product. `now` (ms or Date, default the clock)
// decides whether the use-by date reads as a warning or a promise.
// `eventStarts`: one entry per event its codes come from (eventDates.eventStarts:
// a Date, or null when unknown); no date at all -> no event is named.
function defaultTexts({ slots, guide, useBy, now, eventStarts } = {}) {
  const g = guide || require("./games").GUIDES.default;
  const labels = (Array.isArray(slots) ? slots : []).map((s) => String((s && s.label) || "").trim());
  const n = labels.length;
  const display = String(g.displayName || "").trim();
  const nowMs = toMs(now) ?? Date.now();
  const useByMs = toMs(useBy);
  const useByText = useByMs != null ? redeemByText(useByMs) : "";
  const near = useByMs != null && useByMs - nowMs <= REDEEM_BY_WINDOW_MS;
  const redeemBy = near ? useByText : "";
  const validUntil = near ? "" : useByText;
  // One entry per event (eventDates.eventStarts): a Date, or null when that
  // event has none. Two events on one day are still two events.
  const events = Array.isArray(eventStarts) ? eventStarts : eventStarts == null ? [] : [eventStarts];
  const eventLong = eventDatesText(events);
  const eventShort = eventDatesText(events, { short: true });
  const eventCount = eventLong ? Math.max(events.length, eventDays(events).length) : 0;
  const eventPart = eventShort ? `${eventCount > 1 ? "Events" : "Event"} ${eventShort}` : "";
  const notes = [
    eventLong ? `${eventCount > 1 ? "events" : "event"} ${eventLong}` : "",
    useByText ? `redeem by ${useByText}` : "",
  ].filter(Boolean);

  return {
    title: buildTitle(display, labels, eventPart),
    description: buildDescription({ display, labels, guide: g, redeemBy, validUntil, eventLong, eventCount }),
    deliveryTemplate:
      `Thank you for your order! Your ${display} code bundle` +
      (notes.length ? ` (${notes.join(", ")})` : "") +
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

// A title for a market that allows fewer characters than ours (PlayerAuctions:
// 150). Parts separated by " | " are dropped from the end while at least two
// are left; only then is it cut, at a word.
function fitTitle(title, max) {
  let t = String(title || "").trim();
  if (t.length <= max) return t;
  const parts = t.split(" | ");
  while (parts.length > 2 && parts.join(" | ").length > max) parts.pop();
  t = parts.join(" | ");
  if (t.length <= max) return t;
  const cut = t.lastIndexOf(" ", max);
  return t.slice(0, cut > 0 ? cut : max).replace(/[\s|+-]+$/, "");
}

// The redeem guide for a market's offer-instruction field (PlayerAuctions:
// 500 characters, shown beside the order): the how-to lines, then good-to-know
// lines while they fit. Plain lines from games.js, so nothing new to guard.
function marketInstruction(guide, max) {
  const g = guide || {};
  const how = Array.isArray(g.howTo) ? g.howTo : [];
  const good = Array.isArray(g.goodToKnow) ? g.goodToKnow : [];
  const lines = ["HOW TO REDEEM", ...how];
  let text = lines.join("\n");
  if (text.length > max) return text.slice(0, max).replace(/\s+\S*$/, "");
  for (const line of good) {
    const next = text + "\n" + line;
    if (next.length > max) break;
    text = next;
  }
  return text;
}

module.exports = {
  defaultTexts,
  eventDatesText,
  fitTitle,
  marketInstruction,
  redeemByText,
  defaultLabel,
  TITLE_MAX,
  DESCRIPTION_MAX,
  REDEEM_BY_WINDOW_MS,
  FALLBACK_SOURCE_WORDS,
};
