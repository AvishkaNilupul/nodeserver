// Code shop — slot identity (docs/code-shop/02-ENGINE.md, "slots.js"). Pure:
// every value here is made up (no real codes, campaigns or logins).
process.env.CRED_SECRET ||= "code-shop-slots-test";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const normalize = require("../utils/soop/normalize");
const {
  parseKst,
  hashCode,
  codeShape,
  groupKeyOf,
  slotKeyOf,
  assignOrdinals,
  slotSetHash,
  useByOf,
  isAsciiText,
} = require("../utils/codeShop/slots");

const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
// The definition from docs/code-shop/05-REVIEW-FIXES.md (R8), written out once
// here so the test pins it; every other test uses slots.hashCode itself.
const hmacOf = (s, secret = process.env.CRED_SECRET) =>
  crypto.createHmac("sha256", crypto.createHash("sha256").update("code-shop:" + secret).digest()).update(s).digest("hex");
const iso = (d) => (d ? d.toISOString() : null);

/* -------------------------------- parseKst -------------------------------- */

test("parseKst is the farm's own Korea-time parser", () => {
  assert.equal(parseKst, normalize.parseKst);
});

test("parseKst reads YYYY-MM-DD HH:mm:ss as Korea time (UTC+9)", () => {
  assert.equal(iso(parseKst("2026-10-21 23:59:59")), "2026-10-21T14:59:59.000Z");
  // Before 09:00 KST the UTC instant falls on the previous day (and year).
  assert.equal(iso(parseKst("2026-01-01 05:00:00")), "2025-12-31T20:00:00.000Z");
  assert.equal(parseKst("2026-10-21 23:59:59").getTime(), Date.UTC(2026, 9, 21, 14, 59, 59));
  assert.equal(parseKst("0000-00-00 00:00:00"), null);
  assert.equal(parseKst("not a date"), null);
  assert.equal(parseKst(null), null);
});

/* -------------------------------- hashCode -------------------------------- */

test("hashCode is the HMAC-SHA256 of the trimmed code, keyed by sha256(\"code-shop:\" + CRED_SECRET)", () => {
  assert.equal(hashCode("ABCD-EFGH-1234"), hmacOf("ABCD-EFGH-1234"));
  assert.equal(hashCode("  ABCD-EFGH-1234 \n"), hmacOf("ABCD-EFGH-1234"));
  assert.equal(hashCode("\tABCD-EFGH-1234"), hashCode("ABCD-EFGH-1234"));
  assert.match(hashCode("X"), /^[0-9a-f]{64}$/);
  assert.notEqual(hashCode("ABCD-EFGH-1234"), hashCode("ABCD-EFGH-1235"));
  // Case matters: some games' codes are case-sensitive.
  assert.notEqual(hashCode("abcd"), hashCode("ABCD"));
});

test("hashCode is never a bare sha256 of the code", () => {
  assert.notEqual(hashCode("ABCD-EFGH-1234"), sha256("ABCD-EFGH-1234"));
  assert.notEqual(hashCode(""), sha256(""));
});

test("hashCode reads a number as text and never returns an empty hash", () => {
  assert.equal(hashCode(12345), hmacOf("12345"));
  assert.equal(hashCode(null), hmacOf(""));
  assert.equal(hashCode(undefined), hmacOf(""));
  assert.match(hashCode(null), /^[0-9a-f]{64}$/);
  assert.notEqual(hashCode(null), hmacOf("null"));
});

test("hashCode follows CRED_SECRET and throws without it", (t) => {
  const saved = process.env.CRED_SECRET;
  t.after(() => {
    process.env.CRED_SECRET = saved;
  });
  const before = hashCode("ABCD-EFGH-1234");
  process.env.CRED_SECRET = "another-secret";
  assert.equal(hashCode("ABCD-EFGH-1234"), hmacOf("ABCD-EFGH-1234", "another-secret"));
  assert.notEqual(hashCode("ABCD-EFGH-1234"), before, "another key, another fingerprint");
  delete process.env.CRED_SECRET;
  assert.throws(() => hashCode("ABCD-EFGH-1234"), /CRED_SECRET must be set/);
  process.env.CRED_SECRET = "";
  assert.throws(() => hashCode("ABCD-EFGH-1234"), /CRED_SECRET must be set/);
  process.env.CRED_SECRET = saved;
  assert.equal(hashCode("ABCD-EFGH-1234"), before);
});

/* -------------------------------- codeShape ------------------------------- */

test("codeShape gives the length, then the dash-group sizes", () => {
  assert.equal(codeShape("ABCD-EFGH-IJKLM-NOPQ-RSTU"), "25:4-4-5-4-4");
  assert.equal(codeShape("AB12-CD34-EF56"), "14:4-4-4");
  assert.equal(codeShape("  ABCD-EFGH-IJKLM-NOPQ-RSTU \n"), "25:4-4-5-4-4");
});

test("codeShape of an undashed code is one group", () => {
  assert.equal(codeShape("ABCDEFGHIJKLMNOP"), "16:16");
  assert.equal(codeShape("X"), "1:1");
  assert.equal(codeShape(""), "0:0");
  assert.equal(codeShape(null), "0:0");
});

test("codeShape shows odd dashes as empty groups", () => {
  assert.equal(codeShape("AB--CD"), "6:2-0-2");
  assert.equal(codeShape("-ABC-"), "5:0-3-0");
});

/* -------------------------------- groupKeyOf ------------------------------ */

test("groupKeyOf uses the campaign id when there is one", () => {
  assert.equal(groupKeyOf({ gameNo: "12", campaignIdx: "90001", campaignName: "Any Title" }), "12:90001");
  assert.equal(groupKeyOf({ gameNo: "200", campaignIdx: "7" }), "200:7");
});

test("groupKeyOf falls back to a hash of the campaign name", () => {
  const name = "Made Up Watch Event";
  assert.equal(groupKeyOf({ gameNo: "12", campaignIdx: "", campaignName: name }), `12:n${sha1(name).slice(0, 10)}`);
  assert.match(groupKeyOf({ gameNo: "12", campaignName: name }), /^12:n[0-9a-f]{10}$/);
  assert.notEqual(
    groupKeyOf({ gameNo: "12", campaignName: name }),
    groupKeyOf({ gameNo: "12", campaignName: name + " 2" }),
  );
  // Same name in another game is another group.
  assert.notEqual(groupKeyOf({ gameNo: "12", campaignName: name }), groupKeyOf({ gameNo: "200", campaignName: name }));
});

test("groupKeyOf without id or name is the game's 'none' group", () => {
  assert.equal(groupKeyOf({ gameNo: "12", campaignIdx: "", campaignName: "" }), "12:none");
  assert.equal(groupKeyOf({ gameNo: "12" }), "12:none");
  assert.equal(groupKeyOf({ gameNo: "12", campaignIdx: null, campaignName: null }), "12:none");
  assert.equal(groupKeyOf({}), ":none");
});

/* -------------------------------- slotKeyOf ------------------------------- */

test("slotKeyOf = group : sha1(nameRaw) first 10 : ordinal", () => {
  const nameRaw = "Made Up Spray";
  assert.equal(slotKeyOf("12:90001", nameRaw, 1), `12:90001:${sha1(nameRaw).slice(0, 10)}:1`);
  assert.match(slotKeyOf("12:none", nameRaw, 2), /^12:none:[0-9a-f]{10}:2$/);
});

test("slotKeyOf is stable and tells slots apart", () => {
  const a = slotKeyOf("12:90001", "Made Up Spray", 1);
  assert.equal(slotKeyOf("12:90001", "Made Up Spray", 1), a);
  assert.notEqual(slotKeyOf("12:90001", "Made Up Spray", 2), a);
  assert.notEqual(slotKeyOf("12:90001", "Made Up Icon", 1), a);
  assert.notEqual(slotKeyOf("12:90002", "Made Up Spray", 1), a);
  // The raw name is hashed as sent: a different spelling is a different slot.
  assert.notEqual(slotKeyOf("12:90001", "made up spray", 1), a);
});

/* ------------------------------ assignOrdinals ---------------------------- */

const row = (loginId, itemKey, nameRaw, earnedAt, groupKey = "12:90001") => ({
  loginId,
  itemKey,
  groupKey,
  nameRaw,
  earnedAt,
});

test("assignOrdinals: one reward name twice in a campaign -> 1 and 2 by earnedAt", () => {
  const m = assignOrdinals([
    row("L1", "k-late", "Spray", new Date("2026-10-03T00:00:00Z")),
    row("L1", "k-early", "Spray", new Date("2026-10-02T00:00:00Z")),
  ]);
  assert.ok(m instanceof Map);
  assert.equal(m.get("L1|k-early"), 1);
  assert.equal(m.get("L1|k-late"), 2);
  assert.equal(m.size, 2);
});

test("assignOrdinals: a single reward is ordinal 1", () => {
  const m = assignOrdinals([row("L1", "k1", "Icon", new Date("2026-10-02T00:00:00Z"))]);
  assert.equal(m.get("L1|k1"), 1);
});

test("assignOrdinals: equal earnedAt ties break by itemKey", () => {
  const at = new Date("2026-10-02T00:00:00Z");
  const m = assignOrdinals([row("L1", "kb", "Spray", at), row("L1", "ka", "Spray", new Date(at)), row("L1", "kc", "Spray", at)]);
  assert.equal(m.get("L1|ka"), 1);
  assert.equal(m.get("L1|kb"), 2);
  assert.equal(m.get("L1|kc"), 3);
});

test("assignOrdinals: a row without earnedAt comes last", () => {
  const m = assignOrdinals([
    row("L1", "a-undated", "Spray", null),
    row("L1", "z-dated", "Spray", new Date("2026-10-05T00:00:00Z")),
    row("L1", "b-undated", "Spray", undefined),
  ]);
  assert.equal(m.get("L1|z-dated"), 1);
  // Undated rows keep their itemKey order among themselves.
  assert.equal(m.get("L1|a-undated"), 2);
  assert.equal(m.get("L1|b-undated"), 3);
});

test("assignOrdinals: different logins are counted independently", () => {
  const m = assignOrdinals([
    row("L1", "k1", "Spray", new Date("2026-10-02T00:00:00Z")),
    row("L1", "k2", "Spray", new Date("2026-10-03T00:00:00Z")),
    row("L2", "k3", "Spray", new Date("2026-10-01T00:00:00Z")),
    row("L2", "k4", "Spray", new Date("2026-10-04T00:00:00Z")),
  ]);
  assert.equal(m.get("L1|k1"), 1);
  assert.equal(m.get("L1|k2"), 2);
  assert.equal(m.get("L2|k3"), 1);
  assert.equal(m.get("L2|k4"), 2);
});

test("assignOrdinals: other names and other campaigns are counted independently", () => {
  const m = assignOrdinals([
    row("L1", "k1", "Spray", new Date("2026-10-02T00:00:00Z")),
    row("L1", "k2", "Icon", new Date("2026-10-01T00:00:00Z")),
    row("L1", "k3", "Spray", new Date("2026-10-01T00:00:00Z"), "12:90002"),
  ]);
  assert.equal(m.get("L1|k1"), 1);
  assert.equal(m.get("L1|k2"), 1);
  assert.equal(m.get("L1|k3"), 1);
});

test("assignOrdinals accepts ms and ISO strings for earnedAt and ignores input order", () => {
  const rows = [
    row("L1", "k3", "Spray", "2026-10-03T00:00:00Z"),
    row("L1", "k1", "Spray", Date.UTC(2026, 9, 1)),
    row("L1", "k2", "Spray", new Date("2026-10-02T00:00:00Z")),
  ];
  const a = assignOrdinals(rows);
  const b = assignOrdinals([...rows].reverse());
  assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort());
  assert.equal(a.get("L1|k1"), 1);
  assert.equal(a.get("L1|k2"), 2);
  assert.equal(a.get("L1|k3"), 3);
});

test("assignOrdinals keeps the first row of a repeated identity and survives empty input", () => {
  const m = assignOrdinals([
    row("L1", "k1", "Spray", new Date("2026-10-05T00:00:00Z")),
    row("L1", "k1", "Spray", new Date("2026-10-01T00:00:00Z")),
    row("L1", "k2", "Spray", new Date("2026-10-03T00:00:00Z")),
  ]);
  assert.equal(m.size, 2);
  assert.equal(m.get("L1|k2"), 1);
  assert.equal(m.get("L1|k1"), 2);
  assert.equal(assignOrdinals([]).size, 0);
  assert.equal(assignOrdinals(null).size, 0);
});

/* ------------------------------- slotSetHash ------------------------------ */

test("slotSetHash = sha1 of the sorted unique keys joined by newline, first 16 hex", () => {
  const keys = ["12:90001:bbbbbbbbbb:1", "12:90001:aaaaaaaaaa:1"];
  assert.equal(slotSetHash(keys), sha1([...keys].sort().join("\n")).slice(0, 16));
  assert.match(slotSetHash(keys), /^[0-9a-f]{16}$/);
});

test("slotSetHash ignores order and duplicates", () => {
  const a = ["s:1", "s:2", "s:3"];
  assert.equal(slotSetHash(["s:3", "s:1", "s:2"]), slotSetHash(a));
  assert.equal(slotSetHash(["s:2", "s:1", "s:3", "s:1", "s:2"]), slotSetHash(a));
  assert.notEqual(slotSetHash(["s:1", "s:2"]), slotSetHash(a));
  assert.notEqual(slotSetHash(["s:1", "s:2", "s:4"]), slotSetHash(a));
});

/* --------------------------------- useByOf -------------------------------- */

test("useByOf: raw.useExpDate (Korea time) wins over expiresAt", () => {
  const d = useByOf({
    division: "acquired",
    expiresAt: new Date("2030-01-01T00:00:00Z"),
    raw: { useExpDate: "2026-10-21 23:59:59", expDate: "2026-10-10 23:59:59" },
  });
  assert.ok(d instanceof Date);
  assert.equal(iso(d), "2026-10-21T14:59:59.000Z");
});

test("useByOf: a claimed row without useExpDate falls back to expiresAt", () => {
  const at = new Date("2026-10-21T14:59:59Z");
  assert.equal(iso(useByOf({ division: "acquired", expiresAt: at, raw: {} })), at.toISOString());
  assert.equal(iso(useByOf({ division: "acquired", expiresAt: at, raw: null })), at.toISOString());
  assert.equal(iso(useByOf({ division: "acquired", expiresAt: at.toISOString() })), at.toISOString());
  // An unreadable useExpDate is treated as missing.
  assert.equal(iso(useByOf({ division: "acquired", expiresAt: at, raw: { useExpDate: "0000-00-00 00:00:00" } })), at.toISOString());
  assert.equal(useByOf({ division: "acquired", expiresAt: null, raw: {} }), null);
});

test("useByOf: an unclaimed row's expiresAt is its claim-by date, not a use-by", () => {
  const at = new Date("2026-10-21T14:59:59Z");
  assert.equal(useByOf({ division: "available", expiresAt: at, raw: { expDate: "2026-10-21 23:59:59" } }), null);
  assert.equal(useByOf({ division: "expired", expiresAt: at, raw: {} }), null);
  assert.equal(useByOf({ expiresAt: at }), null);
  // ...but a useExpDate on it still counts.
  assert.equal(
    iso(useByOf({ division: "available", expiresAt: at, raw: { useExpDate: "2026-11-01 00:00:00" } })),
    "2026-10-31T15:00:00.000Z",
  );
});

test("useByOf of nothing is null", () => {
  assert.equal(useByOf(null), null);
  assert.equal(useByOf(undefined), null);
  assert.equal(useByOf({}), null);
});

/* ------------------------------- isAsciiText ------------------------------ */

test("isAsciiText allows tab, newline, carriage return and printable ASCII", () => {
  assert.equal(isAsciiText("Overwatch 2 | 3 Codes Bundle | A + B"), true);
  assert.equal(isAsciiText("line 1\nline 2\r\n\tindented ~!@#$%^&*()_+{}|:\"<>?`-=[]\\;',./"), true);
  assert.equal(isAsciiText(""), true);
  assert.equal(isAsciiText(null), true);
  assert.equal(isAsciiText(undefined), true);
});

test("isAsciiText refuses anything else", () => {
  assert.equal(isAsciiText("Skål"), false);
  assert.equal(isAsciiText("smart ’quote’"), false);
  assert.equal(isAsciiText("em — dash"), false);
  assert.equal(isAsciiText("no break space"), false);
  assert.equal(isAsciiText("emoji \u{1F381}"), false);
  assert.equal(isAsciiText("아이템"), false); // Hangul
  assert.equal(isAsciiText("nul \u0000"), false);
  assert.equal(isAsciiText("del \u007f"), false);
  assert.equal(isAsciiText("vertical tab \u000b"), false);
});
