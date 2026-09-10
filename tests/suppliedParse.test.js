// parseSuppliedAccounts — the ingest parser for account listings
// (docs/ACCOUNT-LISTINGS-CONTRACT.md §B4/§B9).
//
// WHY THIS FILE EXISTS
// This parser decides which pasted column is the password, which is the Twitch
// token and which is the email, and its output is handed STRAIGHT to a paying
// buyer by suppliedStock.deliveryText. Two ways it can go wrong, both of which
// the older utils/parseAccountList.js was written to stop:
//
//   1. An email pasted in slot 3 stored as a bogus `clientSecret`. That token
//      then fails its auto-check against Twitch, the account looks dead, and
//      the buyer gets a "Token:" line containing someone's mailbox.
//   2. A password containing ":" silently mangled into the wrong columns, so
//      the buyer is sent a TRUNCATED password for an account that is otherwise
//      perfectly good — a refund and a complaint thread, not an error anyone
//      sees on our side.
//
// Slot 3 is therefore disambiguated by "@", never by position, and a line that
// cannot be split into >= 2 non-empty leading fields is REPORTED rather than
// guessed at. The 3-5 field ambiguity that survives that rule is pinned below
// under "KNOWN GAP" so nobody mistakes it for coverage it does not have.
//
// Pure: no Mongo, no network, no clock. utils/suppliedStock.js requires only
// utils/secretBox (crypto) at load time — every model is behind a factory — so
// this file can require it directly without stalling on an un-stubbed Mongoose
// call.
const test = require("node:test");
const assert = require("node:assert");

const { parseSuppliedAccounts } = require("../utils/suppliedStock");

// Parse one line and assert it was accepted, so every test below reads as the
// shape it cares about rather than as index arithmetic.
function one(line) {
  const res = parseSuppliedAccounts(line);
  assert.deepStrictEqual(res.badLines, [], "line was rejected: " + line);
  assert.strictEqual(res.accounts.length, 1, "expected exactly one account");
  return res.accounts[0];
}

/* ------------------------------ 2 / 3 fields ----------------------------- */

test("two fields are login and password, nothing invented around them", () => {
  const a = one("shopper12:hunter2");
  assert.strictEqual(a.login, "shopper12");
  assert.strictEqual(a.password, "hunter2");
  assert.strictEqual(a.clientSecret, "");
  assert.strictEqual(a.email, "");
  assert.strictEqual(a.extra, "");
  assert.strictEqual(a.raw, "shopper12:hunter2");
});

test("three fields: a slot 3 without '@' is the Twitch token", () => {
  const a = one("shopper12:hunter2:kj4h5kj2h34kj5h234kj5h23");
  assert.strictEqual(a.clientSecret, "kj4h5kj2h34kj5h234kj5h23");
  assert.strictEqual(a.email, "");
  assert.strictEqual(a.extra, "");
});

test("REGRESSION: slot 3 with '@' is the email, never stored as a token", () => {
  const a = one("shopper12:hunter2:box@mail.ru");
  assert.strictEqual(a.email, "box@mail.ru");
  assert.strictEqual(
    a.clientSecret,
    "",
    "an address in the token column fails its Twitch auto-check and reaches " +
      "the buyer as a 'Token:' line",
  );
});

/* -------------------------------- 4 fields ------------------------------- */

test("four fields in the documented order: token then email", () => {
  const a = one("shopper12:hunter2:tok3n:box@mail.ru");
  assert.strictEqual(a.clientSecret, "tok3n");
  assert.strictEqual(a.email, "box@mail.ru");
  assert.strictEqual(a.extra, "");
});

test("four fields the other way round: '@' still wins over position", () => {
  const a = one("shopper12:hunter2:box@mail.ru:tok3n");
  assert.strictEqual(a.email, "box@mail.ru");
  assert.strictEqual(a.clientSecret, "tok3n");
  assert.strictEqual(a.extra, "");
});

test("two addresses: the first is the email, the second is NOT a token", () => {
  const a = one("shopper12:hunter2:one@mail.ru:two@mail.ru");
  assert.strictEqual(a.email, "one@mail.ru");
  assert.strictEqual(a.clientSecret, "");
  assert.strictEqual(a.extra, "two@mail.ru");
});

/* -------------------------------- 5 fields ------------------------------- */

test("five fields: everything past the email lands verbatim in extra", () => {
  const a = one("shopper12:hunter2:tok3n:box@mail.ru:recovery-code-9911");
  assert.strictEqual(a.login, "shopper12");
  assert.strictEqual(a.password, "hunter2");
  assert.strictEqual(a.clientSecret, "tok3n");
  assert.strictEqual(a.email, "box@mail.ru");
  assert.strictEqual(a.extra, "recovery-code-9911");
});

test("past five fields the tail keeps its own colons instead of splitting", () => {
  const a = one("shopper12:hunter2:tok3n:box@mail.ru:vpn=de:note here");
  assert.strictEqual(a.email, "box@mail.ru");
  assert.strictEqual(a.extra, "vpn=de:note here");
});

test("a 4th field that is not an address is kept verbatim, not filed as one", () => {
  const a = one("shopper12:hunter2:tok3n:region-eu");
  assert.strictEqual(a.clientSecret, "tok3n");
  assert.strictEqual(a.email, "", "region-eu is not an address");
  assert.strictEqual(a.extra, "region-eu");
});

/* ------------------------ the '@' rule as an invariant ------------------- */

test("across a whole mixed paste, no token column ever holds an address", () => {
  const { accounts, badLines } = parseSuppliedAccounts(
    [
      "a1:pw1",
      "a2:pw2:tok2",
      "a3:pw3:a3@mail.ru",
      "a4:pw4:tok4:a4@mail.ru",
      "a5:pw5:a5@mail.ru:tok5",
      "a6:pw6:a6@mail.ru:alt6@mail.ru",
      "a7:pw7:tok7:a7@mail.ru:extra7",
      // A login that is itself an address must not confuse the slot-3 rule.
      "a8@mail.ru:pw8:tok8",
    ].join("\n"),
  );
  assert.deepStrictEqual(badLines, []);
  assert.strictEqual(accounts.length, 8);
  for (const a of accounts) {
    assert.ok(
      !a.clientSecret.includes("@"),
      "address stored as a token: " + a.raw,
    );
  }
  assert.strictEqual(accounts[7].login, "a8@mail.ru");
  assert.strictEqual(accounts[7].clientSecret, "tok8");
  assert.strictEqual(accounts[7].email, "");
});

/* -------------------------------- bullets -------------------------------- */

test("leading '*' and '-' bullets are tolerated and stripped from raw too", () => {
  const { accounts, badLines } = parseSuppliedAccounts(
    "* shopper12:hunter2\n- shopper13:hunter3:box@mail.ru\n",
  );
  assert.deepStrictEqual(badLines, []);
  assert.strictEqual(accounts.length, 2);
  assert.strictEqual(accounts[0].login, "shopper12");
  assert.strictEqual(
    accounts[0].raw,
    "shopper12:hunter2",
    "raw is what {line} renders and what the ledger echoes back — a stray " +
      "bullet would ship to the buyer",
  );
  assert.strictEqual(accounts[1].login, "shopper13");
  assert.strictEqual(accounts[1].email, "box@mail.ru");
});

test("surrounding whitespace in a copied list is trimmed off every field", () => {
  const a = one("   shopper12 : hunter2 : box@mail.ru   ");
  assert.strictEqual(a.login, "shopper12");
  assert.strictEqual(a.password, "hunter2");
  assert.strictEqual(a.email, "box@mail.ru");
});

/* ----------------------------- bad lines --------------------------------- */

test("a line with fewer than two non-empty fields is reported, not guessed", () => {
  const { accounts, badLines } = parseSuppliedAccounts(
    ["justalogin", "shopper12:", ":hunter2", "shopper13:hunter3"].join("\n"),
  );
  assert.strictEqual(accounts.length, 1, "only the well-formed line parses");
  assert.strictEqual(accounts[0].login, "shopper13");
  assert.deepStrictEqual(badLines, ["justalogin", "shopper12:", ":hunter2"]);
});

test("REGRESSION: a password starting with ':' is a bad line, not a shift", () => {
  // "shopper12" / ":hunter2". Without the empty-field check this parses as
  // password "" and token "hunter2" — an account the buyer cannot log into,
  // delivered with a blank password line and no error anywhere.
  const { accounts, badLines } = parseSuppliedAccounts("shopper12::hunter2");
  assert.deepStrictEqual(accounts, []);
  assert.deepStrictEqual(badLines, ["shopper12::hunter2"]);
});

test("KNOWN GAP: a ':' password that still yields 3-5 fields is undetectable", () => {
  // Pinned, not endorsed. "shopper12" / "hun:ter2" is byte-identical to
  // login:password:token once it is on the clipboard, so the parser files it
  // as the documented 3-field shape. utils/suppliedStock.js:132-135 says so in
  // its own comment; the contract's §B9 line "a password containing ':'
  // reported as a bad line" is only achievable for the empty-field forms above.
  // If detection is ever added (e.g. a token-shape check), this test must
  // change — that is the point of pinning it.
  const a = one("shopper12:hun:ter2");
  assert.strictEqual(a.password, "hun");
  assert.strictEqual(a.clientSecret, "ter2");
});

test("a bad line is echoed back capped, so a pasted file cannot flood the UI", () => {
  const long = "x".repeat(500);
  const { accounts, badLines } = parseSuppliedAccounts(long);
  assert.deepStrictEqual(accounts, []);
  assert.strictEqual(badLines.length, 1);
  assert.strictEqual(badLines[0].length, 80);
});

/* ---------------------------- empty input -------------------------------- */

test("empty, whitespace-only and missing input yield nothing at all", () => {
  for (const input of ["", "   ", "\n\n\t \r\n", null, undefined]) {
    const res = parseSuppliedAccounts(input);
    assert.deepStrictEqual(
      res,
      { accounts: [], badLines: [] },
      "input " + JSON.stringify(input) + " should parse to nothing",
    );
  }
});

test("blank lines between entries are skipped, CRLF included", () => {
  const { accounts, badLines } = parseSuppliedAccounts(
    "shopper12:hunter2\r\n\r\n   \r\nshopper13:hunter3\r\n",
  );
  assert.deepStrictEqual(badLines, []);
  assert.strictEqual(accounts.length, 2);
  assert.strictEqual(accounts[1].password, "hunter3");
  assert.strictEqual(
    accounts[0].raw,
    "shopper12:hunter2",
    "a stray \\r would be carried into the delivered credential",
  );
});

test("every account carries all six keys, so no field renders as undefined", () => {
  // The "Username: undefined" incident was a spread Mongoose sub-document, but
  // a parser that omitted a key would reach the same buyer the same way.
  const keys = ["login", "password", "clientSecret", "email", "extra", "raw"];
  const { accounts } = parseSuppliedAccounts(
    "a1:pw1\na2:pw2:tok2\na3:pw3:tok3:a3@mail.ru:more\n",
  );
  assert.strictEqual(accounts.length, 3);
  for (const a of accounts) {
    for (const k of keys) {
      assert.strictEqual(typeof a[k], "string", k + " must always be a string");
    }
  }
});
