const MarketplaceEvent = require("../models/MarketplaceEvent");
const { sanitize } = require("./systemLog");

// The writer for the marketplace money trail (models/MarketplaceEvent.js).
//
// Two jobs, and both of them are about NOT causing harm:
//
//  1. A logging failure must never reach the caller. Every one of these calls
//     sits inside a delivery path — g2gFulfiller sending a SendBird message,
//     playerauctionsFulfiller handing over credentials, eldoradoFarmService
//     provisioning a rent-farm order. Money has already been taken by the time
//     we get here. If a write to this collection could throw, a Mongo hiccup or
//     a single bad field would turn a paid order into an undelivered one, and
//     we would have made the exact class of bug this console was built to
//     catch. So the whole body is wrapped and every failure returns falsy.
//     Same contract as utils/systemLog.js.
//
//  2. NO PASSWORDS. The console renders `message` verbatim in a <pre> in a
//     browser, so a delivery body stored raw is a credential dump one
//     screenshot from leaving the machine — every fulfiller's delivery text is
//     literally "Username: <login>\nPassword: <password>". Redaction happens
//     HERE, before the value reaches the model; the model is not a second
//     chance to catch one.
//
// Logins are kept on purpose. They are printed on the listing (not secret) and
// they are half the debugging value — they are what tells you WHICH account
// went to WHICH buyer. That is the only reason PlayerAuctions order 16474028 is
// legible at all: eleven logins against a $5 sale. The full password stays
// recoverable from the account record, so nothing is lost by masking the copy.

const MASK = "••••••••";

// Mirrors the caps in models/MarketplaceEvent.js, deliberately duplicated.
// The model truncates in a setter today, but the moment someone leaves only
// `maxlength` in place a long body becomes a REJECTED save — and a rejected
// save in a best-effort logger is a silently lost row, which is the one failure
// this collection cannot tolerate. Truncating here means an oversized message
// costs us its tail, never the whole audit record.
const MAX_TITLE = 160;
const MAX_MESSAGE = 2000;
const MAX_ERROR = 400;
// One login is ~25 chars. A 120-cap keeps a caller who accidentally passes a
// whole delivery body as an "account" from parking 2KB in an array the model
// deliberately leaves uncapped in LENGTH (all eleven logins must stay visible).
const MAX_ACCOUNT = 120;
// game / actor / channel are short labels the model leaves uncapped. They are
// capped here anyway because the collection is written on the delivery path onto
// a bytes-bound Atlas shared tier, and the realistic way one of them becomes
// 4KB is a call site passing an Error or a response body where a label belongs.
// orderId and externalId are deliberately NOT capped: they are looked up by
// exact string, and a truncated id silently stops matching its own trail.
const MAX_SHORT = 120;

// The schema's severity IS an enum, and an enum rejects the save. Anything not
// in this set is coerced rather than sent, for the lost-row reason above.
const SEVERITIES = ["info", "warn", "error"];

// Below this a "secret" is not a credential, it is a fragment: masking a
// two-character string GLOBALLY shreds the connect guide the buyer needs (a
// secret of "T" would blank every T in "TWITCH DROP ACCOUNT"), and the point of
// storing the message is to see what was sent. Twitch's own minimum is 8, so
// nothing real is skipped — and a short one that is actually LABELLED
// ("Password: ab") is still masked by the credential-shape pass below, which
// works off the label instead of the value.
const MIN_SECRET_LEN = 3;
// Case-insensitive matching is the safer default — a password re-typed by a
// fulfiller with different casing must still be caught — but only once a secret
// is long enough that colliding with the message's own prose is implausible.
// Below this, match exactly: a 3-letter case-insensitive pass would eat words
// out of "TWITCH DROP ACCOUNT" and the numbered claim steps.
const MIN_CASE_INSENSITIVE_LEN = 6;

function cap(value, max) {
  if (typeof value !== "string") return "";
  // Same shape as the model's setter (including the ellipsis) so truncating
  // twice is idempotent and a reader can tell a cut message from a short one.
  return value.length <= max ? value : value.slice(0, max - 1) + "…";
}

// A password is not a pattern. Real ones contain . * + ? ( ) [ ] $ ^ | \ — and
// dropped unescaped into a RegExp those either throw (an unbalanced "(" alone
// is a SyntaxError) or, far worse, quietly match something that is not the
// password and leave the real one sitting in the row. Both failures are silent,
// which is why this escape is the difference between redaction and theatre.
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Belt and braces for when a caller forgets to pass a secret at all.
//
// Each pattern captures the LABEL AND SEPARATOR as group 1 and masks only the
// value token, so "Password: hunter2" becomes "Password: ••••••••" — the
// structure of the message survives, which is the whole reason we store it.
//
// Two deliberate narrownesses, both of them rule 5 (never mask so hard that the
// message stops being readable):
//
//  - the whitespace around the separator is horizontal only ([ \t]), never \s.
//    With \s a bare "Password:" at the end of a line would swallow the newline
//    and mask the first word of the NEXT line — in the Eldorado delivery text
//    that is the "HOW TO CLAIM" heading, and the buyer's own instructions would
//    come back from the console shredded.
//  - a bare hyphen only counts as a separator when it has spaces around it, so
//    the contract's "pass — X" is caught while "password-protected" and
//    "pass-through" are left alone. ":" and "=" are unambiguous and stay tight.
const SEP = "[ \\t]*(?::|=|[ \\t][—–-][ \\t])[ \\t]*";
const CREDENTIAL_SHAPES = [
  // password / passwd / pass / pwd / pw. "login" is deliberately absent: logins
  // are kept, they are printed on the listing and they are the debugging value.
  new RegExp("(\\b(?:pass(?:word|wd)?|pwd|pw)\\b" + SEP + ")(\\S+)", "gi"),
  // Cyrillic gets its own pattern because \b is ASCII-only in JS: between a
  // space and "П" there is no word boundary, so a leading \b would make this
  // never match. GGSel/Plati/FunPay buyers are largely Russian-speaking and
  // hand-written replies to them say "Пароль:".
  new RegExp("((?:пароль|пароля|парол)" + SEP + ")(\\S+)", "gi"),
  // models/MarketplaceEvent.js forbids tokens and ClientSecrets here too, and a
  // pasted support reply is exactly where one would turn up.
  new RegExp(
    "(\\b(?:client[ \\t]*secret|secret|token|api[_ \\t-]?key)\\b" + SEP + ")(\\S+)",
    "gi",
  ),
];

function maskCredentialShapes(text) {
  let out = text;
  for (const re of CREDENTIAL_SHAPES) {
    // Fresh lastIndex each pass: these literals are module-level and /g regexes
    // are stateful, so a shared object would skip matches on the second call.
    re.lastIndex = 0;
    out = out.replace(re, (m, head) => head + MASK);
  }
  return out;
}

// Every string in `secrets` masked, then the shape sweep.
//
// Order matters more than anything else in this file: LONGEST FIRST. With
// passwords "abc" and "abc123" both live, masking "abc" first leaves
// "••••••••123" — a partial leak that hands over the remainder AND tells the
// reader exactly how long the rest is. Sorting by length descending means the
// long one is consumed before its own prefix can be applied.
function redactSecrets(text, secrets) {
  if (text == null) return "";
  let out = typeof text === "string" ? text : String(text);
  if (!out) return out;

  const raw = Array.isArray(secrets) ? secrets : secrets == null ? [] : [secrets];
  const candidates = new Set();
  for (const s of raw) {
    const v = typeof s === "string" ? s : typeof s === "number" ? String(s) : "";
    if (v.length >= MIN_SECRET_LEN) candidates.add(v);
    // Also the trimmed form: credentials read out of a pasted stock file arrive
    // with a trailing \r often enough that the untrimmed match alone would miss
    // the very password we were handed.
    const t = v.trim();
    if (t.length >= MIN_SECRET_LEN) candidates.add(t);
  }

  const ordered = [...candidates].sort((a, b) => b.length - a.length);
  for (const secret of ordered) {
    const flags = secret.length >= MIN_CASE_INSENSITIVE_LEN ? "gi" : "g";
    out = out.replace(new RegExp(escapeRe(secret), flags), MASK);
  }

  return maskCredentialShapes(out);
}

function maskStrings(value, secrets, depth) {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (!value || typeof value !== "object" || depth > 4) return value;
  if (Array.isArray(value))
    return value.map((v) => maskStrings(v, secrets, depth + 1));
  const out = {};
  for (const k of Object.keys(value)) out[k] = maskStrings(value[k], secrets, depth + 1);
  return out;
}

// `meta` is Mixed, which makes it the easiest place to leak one by accident.
// systemLog.sanitize already redacts secret-LOOKING KEYS and caps size/depth;
// this then sweeps the VALUES, because a password stored under a harmless key
// ("line", "sent", "body") passes a key-based filter untouched.
function redactMeta(meta, secrets) {
  if (meta == null) return undefined;
  try {
    return maskStrings(sanitize(meta), secrets, 0);
  } catch {
    // Meta is context, never evidence. Losing it must not lose the row.
    return undefined;
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function accountList(value, secrets) {
  const arr = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = [];
  for (const a of arr) {
    if (typeof a !== "string" && typeof a !== "number") continue;
    // Redacted as well, even though the field is documented as logins only: the
    // FunPay deliverable is the single line "login:password" (funpayFulfiller),
    // so a caller pushing "the thing I sent" in here is a plausible mistake and
    // it must not be the one that leaks.
    const s = cap(redactSecrets(String(a), secrets), MAX_ACCOUNT).trim();
    if (s) out.push(s);
  }
  return out;
}

// Write one marketplace event. Best-effort: returns true when the row was
// written, and a falsy value for every other outcome — including failure.
//
// NOTHING IN HERE MAY THROW. Callers are delivery paths that have already taken
// a buyer's money; a throw escaping this function means a paid buyer gets
// nothing because an audit row could not be written. Call sites may still write
// `await logMarketEvent({...}).catch(() => {})` as a second belt, but they are
// not required to, and none of them should have to think about it.
async function logMarketEvent(evt = {}) {
  try {
    if (!evt || typeof evt !== "object") return false;

    const market = String(evt.market || "").trim().toLowerCase();
    if (!market) {
      // Not silent: a row with no market can never be rendered on any tab, and
      // the only way to get here is a miswired call site. pm2 logs are where
      // that gets noticed.
      console.error("logMarketEvent: dropped an event with no market", evt.kind || "");
      return false;
    }
    // Contract rule 6: Z2U is excluded — no capture, no tab. Silently, because
    // the Z2U bridge runs its own maintenance sweep and an error line per pass
    // would be a permanent false alarm in the logs.
    if (market === "z2u") return false;

    // The passwords the caller is about to send. Used to redact, NEVER stored:
    // this is the one field of `evt` that must not survive into the document.
    const secrets = evt.secrets;

    const kind = String(evt.kind || "").trim();
    const wanted = String(evt.severity || "").trim().toLowerCase();
    const doc = {
      at: evt.at instanceof Date ? evt.at : new Date(),
      market,
      kind,
      severity: SEVERITIES.includes(wanted)
        ? wanted
        : kind === "error" || evt.error
          ? "error"
          : "info",
      actor: cap(String(evt.actor || "system"), MAX_SHORT),

      // Byte for byte as the marketplace writes it — G2G's "1788892037419NTQU",
      // PlayerAuctions' "16474028". Never lowercased or trimmed into a
      // different string: this is what the owner pastes out of a buyer's
      // complaint into the order-trail view, and a normalised copy would not
      // match the row that matters.
      orderId: evt.orderId == null ? "" : String(evt.orderId),
      externalId: evt.externalId == null ? "" : String(evt.externalId),
      game: cap(String(evt.game || ""), MAX_SHORT),
      title: cap(redactSecrets(evt.title, secrets), MAX_TITLE),

      // ACCOUNTS, never an item count, and never inferred from accounts.length
      // either — passing it through untouched is the point. PlayerAuctions
      // order 16474028 shipped eleven accounts for a $5 sale precisely because
      // a count from one place was reused as a count of another; a log that
      // recomputed qty from what it was handed could not show that mismatch.
      qty: num(evt.qty),
      priceUsd: num(evt.priceUsd),
      paidUsd: num(evt.paidUsd),
      netUsd: num(evt.netUsd),

      accounts: accountList(evt.accounts, secrets),
      channel: cap(String(evt.channel || ""), MAX_SHORT),
      message: cap(redactSecrets(evt.message, secrets), MAX_MESSAGE),
      error: cap(redactSecrets(evt.error, secrets), MAX_ERROR),
    };

    // Only when it is genuinely an ObjectId. An unparseable value raises a
    // CastError inside create(), which would reject the whole row over a field
    // nothing needs — the trail is worth more than the listing link.
    if (evt.listing && /^[0-9a-fA-F]{24}$/.test(String(evt.listing)))
      doc.listing = String(evt.listing);

    // Left undefined unless the caller actually asserts an outcome. The model
    // has no default for the same reason: an unverified send rendering as
    // ok:true on the page built to catch unverified sends is how G2G chat went
    // a year without working. For a send, ok means the read-back passed.
    if (typeof evt.ok === "boolean") doc.ok = evt.ok;

    const meta = redactMeta(evt.meta, secrets);
    if (meta !== undefined) doc.meta = meta;

    await MarketplaceEvent.create(doc);
    return true;
  } catch (e) {
    // The whole point: a failed audit write is harmless to the delivery. It is
    // not harmless to us, so it lands in the pm2 log, which is the fallback
    // record when this collection is the thing that is broken.
    console.error("logMarketEvent failed:", e && e.message);
    return false;
  }
}

// Everything the trail view renders. `listing` is left out (the UI links by
// externalId), and this is deliberately not a bare find() — 200 rows carrying a
// 2000-char message each is ~400KB on a bytes-bound Atlas shared tier, so the
// field list and the cap are both load-bearing.
const TRAIL_FIELDS = {
  at: 1,
  market: 1,
  kind: 1,
  severity: 1,
  actor: 1,
  orderId: 1,
  externalId: 1,
  game: 1,
  title: 1,
  qty: 1,
  priceUsd: 1,
  paidUsd: 1,
  netUsd: 1,
  accounts: 1,
  channel: 1,
  message: 1,
  ok: 1,
  error: 1,
  meta: 1,
};
const TRAIL_LIMIT = 200;

// Every event for ONE order, oldest first: order_seen → sold → message_sent →
// delivered, or wherever it stopped. This is the view the console exists for.
//
// Deliberately NOT wrapped in a try/catch like the writer is. An empty array on
// a failed read would render as "nothing ever happened to this order", which is
// the most dangerous lie this page could tell — let it throw so the route
// answers 500 and the owner knows the trail is unavailable rather than empty.
async function orderTrail(orderId, { limit = TRAIL_LIMIT } = {}) {
  const id = orderId == null ? "" : String(orderId);
  // An empty orderId would match every row that never carried one — an
  // unbounded scan of the collection dressed up as a lookup.
  if (!id) return [];
  const n = Math.min(Math.max(parseInt(limit, 10) || TRAIL_LIMIT, 1), TRAIL_LIMIT);
  // {orderId: 1, at: -1} serves the match and the ordering. The _id tiebreaker
  // is the one sort key not in that index, and it is safe here only because the
  // equality on orderId bounds the rows to a single order — never copy this
  // sort onto a market-wide query, where it becomes a blocking in-memory sort
  // on a tier with allowDiskUse disabled.
  return MarketplaceEvent.find({ orderId: id }, TRAIL_FIELDS)
    .sort({ at: 1, _id: 1 })
    .limit(n)
    .lean();
}

module.exports = {
  logMarketEvent,
  redactSecrets,
  orderTrail,
  MASK,
  MAX_TITLE,
  MAX_MESSAGE,
  MAX_ERROR,
  TRAIL_LIMIT,
};
