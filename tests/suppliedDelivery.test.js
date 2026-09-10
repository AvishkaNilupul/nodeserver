// "Username: undefined" — the failure this file exists to stop reaching a
// second paying buyer.
//
// utils/g2gFulfiller.credentialsFor ended with `out.push({ ...p, password })`.
// On the pre-reserved-units path `p` is a Mongoose SUB-DOCUMENT, whose schema
// paths live on the PROTOTYPE — a spread copies only own enumerable properties,
// so login/accountId/contentId all vanished. The delivery text rendered
// "Username: undefined" beside the buyer's real password, the send SUCCEEDED,
// the order was stamped fully delivered, and the stock was burned for good.
// (tests/g2gCredentialShape.test.js holds the post-mortem.)
//
// utils/suppliedStock.deliveryText is the same job for account listings
// (docs/ACCOUNT-LISTINGS-CONTRACT.md §B4): it turns one SuppliedAccount row
// into the message a buyer receives. It reads every field through its getter
// and decrypts through utils/secretBox. So the invariants asserted here are:
//
//   1. every documented placeholder renders,
//   2. credentials come out DECRYPTED — never the "enc:v1:" ciphertext,
//   3. an offer with no template of its own gets DEFAULT_TEMPLATE,
//   4. the output NEVER contains the string "undefined", for ANY combination
//      of missing fields, missing offer, or a caller who spread the document.
//
// Pure and stubbed: no Mongo connection, no network. Mongoose documents are
// constructed but never saved, which is exactly the shape that made the
// original bug invisible to a POJO-only test.
process.env.CRED_SECRET ||= "supplied-delivery-test-cred-secret";

const test = require("node:test");
const assert = require("node:assert");

const secretBox = require("../utils/secretBox");
const SuppliedAccount = require("../models/SuppliedAccount");
const AccountOffer = require("../models/AccountOffer");
const {
  DEFAULT_TEMPLATE,
  PLACEHOLDERS,
  deliveryText,
  parseSuppliedAccounts,
} = require("../utils/suppliedStock");

// A template naming every placeholder the contract documents, each on its own
// labelled line so a swapped pair is visible in the assertion diff.
const ALL_PLACEHOLDERS = PLACEHOLDERS.map(
  (p) => p + "=" + "{" + p + "}",
).join("\n");

const PLAIN = {
  login: "marolkapong",
  password: "hunter2-P4ss",
  clientSecret: "abcdef0123456789abcdef0123456789",
  email: "buyer.box@mail.tm",
  extra: "recovery-code 8842",
};

// An unsaved ledger row in exactly the shape addAccounts writes: credentials
// encrypted at rest, read back through the document's getters.
function ledgerRow(over = {}) {
  return new SuppliedAccount({
    offer: "aaaaaaaaaaaaaaaaaaaaaaaa",
    login: PLAIN.login,
    password: secretBox.encrypt(PLAIN.password),
    clientSecret: secretBox.encrypt(PLAIN.clientSecret),
    email: secretBox.encrypt(PLAIN.email),
    extra: PLAIN.extra,
    ...over,
  });
}

function offerDoc(over = {}) {
  return new AccountOffer({
    title: "Overwatch 2 drops account",
    game: "Overwatch 2",
    ...over,
  });
}

/* --------------------------- placeholders render -------------------------- */

test("every documented placeholder renders its value", () => {
  const out = deliveryText(
    ledgerRow(),
    offerDoc({ deliveryTemplate: ALL_PLACEHOLDERS }),
  );
  const seen = Object.fromEntries(
    out.split("\n").map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
  );

  assert.strictEqual(seen.login, PLAIN.login);
  assert.strictEqual(seen.password, PLAIN.password);
  assert.strictEqual(seen.token, PLAIN.clientSecret);
  assert.strictEqual(seen.email, PLAIN.email);
  assert.strictEqual(seen.extra, PLAIN.extra);
  assert.strictEqual(seen.title, "Overwatch 2 drops account");
  assert.strictEqual(seen.game, "Overwatch 2");
  assert.strictEqual(
    seen.line,
    [
      PLAIN.login,
      PLAIN.password,
      PLAIN.clientSecret,
      PLAIN.email,
      PLAIN.extra,
    ].join(":"),
    "{line} is the one-liner the buyer pastes; it must carry every field",
  );
  assert.ok(
    !/\{[a-z]+\}/.test(out),
    "no documented placeholder may survive unrendered: " + out,
  );
});

test("{line} round-trips back through the parser to the same fields", () => {
  // The buyer is handed {line} verbatim on some markets, and the owner may
  // paste it back in. If it does not re-parse to the same columns, the token
  // and the email swap places and the credential is unusable.
  const line = deliveryText(
    ledgerRow(),
    offerDoc({ deliveryTemplate: "{line}" }),
  );
  const { accounts, badLines } = parseSuppliedAccounts(line);
  assert.deepStrictEqual(badLines, []);
  assert.strictEqual(accounts.length, 1);
  assert.strictEqual(accounts[0].login, PLAIN.login);
  assert.strictEqual(accounts[0].password, PLAIN.password);
  assert.strictEqual(accounts[0].clientSecret, PLAIN.clientSecret);
  assert.strictEqual(accounts[0].email, PLAIN.email);
  assert.strictEqual(accounts[0].extra, PLAIN.extra);
});

test("an interior empty column still round-trips (no silent column shift)", () => {
  const row = ledgerRow({ clientSecret: "" });
  const line = deliveryText(row, offerDoc({ deliveryTemplate: "{line}" }));
  assert.ok(line.includes("::"), "the empty token column must be held open");
  const { accounts } = parseSuppliedAccounts(line);
  assert.strictEqual(
    accounts[0].email,
    PLAIN.email,
    "the email must not slide into the token slot",
  );
  assert.strictEqual(accounts[0].clientSecret, "");
});

/* ------------------------------ decryption -------------------------------- */

test("credentials are decrypted through secretBox, never shipped as ciphertext", () => {
  const row = ledgerRow();
  // The premise: what is stored really is unreadable.
  assert.ok(secretBox.isEncrypted(row.password), "the row stores ciphertext");
  assert.notStrictEqual(row.password, PLAIN.password);

  const out = deliveryText(row, offerDoc({ deliveryTemplate: ALL_PLACEHOLDERS }));
  assert.ok(out.includes(PLAIN.password), "the buyer needs the plaintext");
  assert.ok(out.includes(PLAIN.clientSecret));
  assert.ok(out.includes(PLAIN.email));
  assert.ok(
    !out.includes("enc:v1:"),
    "shipping the ciphertext is as broken as shipping undefined: " + out,
  );
});

test("an already-decrypted claim payload renders the same (idempotent)", () => {
  // claimForListing returns decrypted credentials; a caller that hands that
  // payload straight to deliveryText must not get double-decrypted mush.
  const claimed = {
    ledgerId: "bbbbbbbbbbbbbbbbbbbbbbbb",
    login: PLAIN.login,
    password: PLAIN.password,
    clientSecret: PLAIN.clientSecret,
    email: PLAIN.email,
    extra: PLAIN.extra,
  };
  const offer = offerDoc({ deliveryTemplate: ALL_PLACEHOLDERS });
  assert.strictEqual(
    deliveryText(claimed, offer),
    deliveryText(ledgerRow(), offer),
    "a claimed payload and its ledger row must render the same message",
  );
});

test("a credential that cannot be decrypted renders empty, not garbage", () => {
  // A rotated CRED_SECRET makes decrypt() return "". Better an obviously blank
  // field the owner notices than a line of base64 a buyer tries to log in with.
  const row = ledgerRow({ password: "enc:v1:AAAA:BBBB:CCCC" });
  const out = deliveryText(row, offerDoc({ deliveryTemplate: "p={password}" }));
  assert.strictEqual(out, "p=");
});

test("a pasted line survives ingest and comes back out identical", () => {
  // The whole chain, pure: parse -> encrypt-at-rest -> decrypt-at-delivery.
  // addAccounts encrypts password/clientSecret/email and stores `extra`
  // verbatim; deliveryText must decrypt exactly those three and no others. If
  // either side ever gains or loses a field, the buyer receives base64.
  const pasted =
    PLAIN.login +
    ":" +
    PLAIN.password +
    ":" +
    PLAIN.clientSecret +
    ":" +
    PLAIN.email +
    ":" +
    PLAIN.extra;
  const parsed = parseSuppliedAccounts(pasted).accounts[0];
  const stored = new SuppliedAccount({
    offer: "aaaaaaaaaaaaaaaaaaaaaaaa",
    login: parsed.login,
    password: secretBox.encrypt(parsed.password),
    clientSecret: secretBox.encrypt(parsed.clientSecret),
    email: secretBox.encrypt(parsed.email),
    extra: parsed.extra,
  });
  assert.strictEqual(
    deliveryText(stored, offerDoc({ deliveryTemplate: "{line}" })),
    pasted,
    "what the owner pasted is what the buyer must receive",
  );
});

/* --------------------------- the default template ------------------------- */

test("the default template is used when the offer has none", () => {
  const expected = DEFAULT_TEMPLATE.replace("{login}", PLAIN.login).replace(
    "{password}",
    PLAIN.password,
  );
  for (const offer of [
    offerDoc(),
    offerDoc({ deliveryTemplate: "" }),
    offerDoc({ deliveryTemplate: "   \n  " }),
    {},
    null,
    undefined,
  ]) {
    const out = deliveryText(ledgerRow(), offer);
    assert.strictEqual(
      out,
      expected,
      "an offer with no template of its own must fall back to DEFAULT_TEMPLATE",
    );
    assert.ok(out.includes(PLAIN.login) && out.includes(PLAIN.password));
    assert.ok(!out.includes("{"), "the default's placeholders must be filled");
  }
});

test("a custom template wins over the default", () => {
  const out = deliveryText(
    ledgerRow(),
    offerDoc({ deliveryTemplate: "Twitch: {login} / {password}" }),
  );
  assert.strictEqual(out, "Twitch: " + PLAIN.login + " / " + PLAIN.password);
  assert.ok(!out.includes("Do not change"), "the default must not be appended");
});

/* ------------- REGRESSION: the output never contains "undefined" ---------- */

test("REGRESSION: spreading the ledger row still loses every field", () => {
  // The premise behind the whole file, asserted rather than assumed. If a
  // future Mongoose makes schema paths own properties, this test says so.
  const row = ledgerRow();
  assert.strictEqual(
    row.login,
    PLAIN.login,
    "the getter works — that is what made the original bug subtle",
  );
  const spread = { ...row };
  assert.strictEqual(spread.login, undefined, "the spread does NOT carry login");
  assert.strictEqual(spread.password, undefined);
});

test("REGRESSION: a spread sub-document cannot yield 'Username: undefined'", () => {
  // deliveryText reads through getters, so it never sees this shape — but the
  // buyer-facing guarantee is that no caller mistake can put the word
  // "undefined" in front of a paying buyer.
  const offer = offerDoc({
    deliveryTemplate: "Username: {login}\nPassword: {password}",
  });
  const out = deliveryText({ ...ledgerRow() }, offer);
  assert.ok(!out.includes("undefined"), out);
  assert.strictEqual(out, "Username: \nPassword: ");
});

test("REGRESSION: no combination of missing fields renders 'undefined'", () => {
  const fields = ["login", "password", "clientSecret", "email", "extra"];
  const offers = [
    offerDoc({ deliveryTemplate: ALL_PLACEHOLDERS }),
    offerDoc({ deliveryTemplate: ALL_PLACEHOLDERS, title: "", game: "" }),
    { deliveryTemplate: ALL_PLACEHOLDERS },
    undefined,
  ];
  // Every subset of "this column was never supplied", against every shape of
  // offer a route could hand in.
  for (let mask = 0; mask < 1 << fields.length; mask += 1) {
    const over = {};
    fields.forEach((f, i) => {
      if (mask & (1 << i)) over[f] = undefined;
    });
    for (const offer of offers) {
      const out = deliveryText(ledgerRow(over), offer);
      assert.ok(
        !out.includes("undefined"),
        "mask " + mask + " rendered: " + out,
      );
    }
  }
});

test("REGRESSION: a bare, empty or hostile account object renders no 'undefined'", () => {
  const offer = offerDoc({ deliveryTemplate: ALL_PLACEHOLDERS });
  const shapes = [{}, null, undefined, new SuppliedAccount({}), { login: null }];
  for (const account of shapes) {
    const out = deliveryText(account, offer);
    assert.ok(!out.includes("undefined"), "rendered: " + out);
    assert.strictEqual(typeof out, "string");
  }
});

/* ---------------------- substitution can't be subverted ------------------- */

test("a typo'd placeholder stays literal instead of vanishing", () => {
  // A silent empty gap is what nobody notices until a buyer complains; a
  // visible "{lgoin}" is caught in the preview.
  const out = deliveryText(
    ledgerRow(),
    offerDoc({ deliveryTemplate: "{lgoin} {LOGIN} {}" }),
  );
  assert.strictEqual(out, "{lgoin} {LOGIN} {}");
});

test("a credential containing $& or $1 is not mangled by the substitution", () => {
  // String.replace treats "$&" in a replacement STRING as the whole match. A
  // function replacer is what stops a password like "a$&b" arriving as
  // "a{password}b" — a wrong password on a paid order.
  const row = ledgerRow({ password: secretBox.encrypt("a$&b$1c$$d") });
  const out = deliveryText(row, offerDoc({ deliveryTemplate: "p={password}" }));
  assert.strictEqual(out, "p=a$&b$1c$$d");
});

test("a value that looks like a placeholder is not substituted again", () => {
  const row = ledgerRow({ login: "{password}" });
  const out = deliveryText(row, offerDoc({ deliveryTemplate: "l={login}" }));
  assert.strictEqual(out, "l={password}", "one pass only — no recursion");
});
