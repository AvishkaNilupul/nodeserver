// Code shop — slot identity (docs/code-shop/02-ENGINE.md, "slots.js").
//
// A slot is one reward of one campaign: the same reward name can be handed
// out twice by a campaign (two steps), so a reward = campaign group + name +
// its order within that login's rewards. Products are sets of slots, and two
// codes are interchangeable only when they share a slot key. Pure functions:
// no database, no network, no logging — and never a plaintext code out.

const crypto = require("node:crypto");
const { parseKst } = require("../soop/normalize");

// Allowed buyer-text characters: tab, newline, carriage return, printable ASCII.
// The `u` flag makes a non-ASCII match a whole code point (an emoji, not half of it).
const NON_ASCII_RE = /[^\t\n\r\x20-\x7E]/u;

const sha1 = (s) => crypto.createHash("sha1").update(s, "utf8").digest("hex");
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
// null/undefined read as "" so a missing value never hashes as the word "null".
const text = (v) => (v === undefined || v === null ? "" : String(v));

// A date-ish value as ms, or null (Date, ms number, ISO string).
function toMs(v) {
  if (v === undefined || v === null || v === "") return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}

// Always a 64-hex digest, even for an empty code, so a missing code can never
// equal a ledger row's empty codeHash.
function hashCode(code) {
  return sha256(text(code).trim());
}

// "25:4-4-5-4-4": total length (dashes included), then each dash group's size.
// Safe to log: it says what a code looks like, not what it is.
function codeShape(code) {
  const s = text(code).trim();
  return `${s.length}:${s.split("-").map((g) => g.length).join("-")}`;
}

function groupKeyOf({ gameNo, campaignIdx, campaignName } = {}) {
  const game = text(gameNo);
  const idx = text(campaignIdx);
  if (idx) return `${game}:${idx}`;
  const name = text(campaignName);
  if (name) return `${game}:n${sha1(name).slice(0, 10)}`;
  return `${game}:none`;
}

function slotKeyOf(groupKey, nameRaw, ordinal) {
  return `${text(groupKey)}:${sha1(text(nameRaw)).slice(0, 10)}:${ordinal}`;
}

// rows: [{ loginId, itemKey, groupKey, nameRaw, earnedAt }]
// -> Map(`${loginId}|${itemKey}` -> ordinal), 1-based within one
// (loginId, groupKey, nameRaw): earliest earnedAt first (no date last), then itemKey.
// A repeated identity keeps its first row (the ledger allows one per identity).
function assignOrdinals(rows) {
  const groups = new Map();
  const seen = new Set();
  for (const r of rows || []) {
    if (!r) continue;
    const id = `${text(r.loginId)}|${text(r.itemKey)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    // JSON keeps ("a|b", "c") and ("a", "b|c") apart.
    const g = JSON.stringify([text(r.loginId), text(r.groupKey), text(r.nameRaw)]);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ id, itemKey: text(r.itemKey), at: toMs(r.earnedAt) });
  }
  const out = new Map();
  for (const list of groups.values()) {
    list.sort((a, b) => {
      if (a.at !== b.at) {
        if (a.at === null) return 1;
        if (b.at === null) return -1;
        return a.at - b.at;
      }
      // Plain code-unit order, not locale order: the same input must give the
      // same ordinals on every server.
      return a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0;
    });
    list.forEach((e, i) => out.set(e.id, i + 1));
  }
  return out;
}

function slotSetHash(slotKeys) {
  const keys = [...new Set((slotKeys || []).filter((k) => k !== undefined && k !== null).map(String))].sort();
  return sha1(keys.join("\n")).slice(0, 16);
}

// The last instant a stored code can be redeemed, as a Date, or null.
// raw.useExpDate is the use-by; on a claimed ("acquired") row expiresAt is the
// same instant. On an unclaimed row expiresAt is the claim-by date, not a use-by.
function useByOf(invRow) {
  const row = invRow || {};
  const raw = row.raw && typeof row.raw === "object" ? row.raw : {};
  const fromRaw = parseKst(raw.useExpDate);
  if (fromRaw) return fromRaw;
  if (row.division !== "acquired") return null;
  const ms = toMs(row.expiresAt);
  return ms === null ? null : new Date(ms);
}

// Nothing (null/undefined) is trivially ASCII; anything else is read as text.
function isAsciiText(s) {
  return !NON_ASCII_RE.test(text(s));
}

module.exports = {
  parseKst,
  hashCode,
  codeShape,
  groupKeyOf,
  slotKeyOf,
  assignOrdinals,
  slotSetHash,
  useByOf,
  isAsciiText,
  NON_ASCII_RE,
};
