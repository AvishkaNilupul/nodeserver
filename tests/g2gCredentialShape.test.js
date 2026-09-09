// "Username: undefined" — why a working G2G delivery shipped an unusable
// credential and then confirmed the order.
//
// utils/g2gFulfiller.credentialsFor ended with
//
//   out.push({ ...p, password });
//
// On the pre-reserved-units path `picked` holds Mongoose SUB-DOCUMENTS
// (models/MarketplaceListing.units is a typed sub-schema array, and the listing
// is loaded WITHOUT .lean()). A sub-document's schema paths are defined on the
// PROTOTYPE, so a spread — which copies only own enumerable properties — yields
//
//   { __parentArray, __index, $__parent, $__, _doc, password }
//
// login, accountId and contentId are all gone. g2gDeliveryCode then rendered
// "Username: undefined" next to the buyer's real password, chat.sendToBuyer
// SUCCEEDED, so g2gSetDeliveredQty ran and every unit was stamped delivered:
// a paid order marked fully delivered with a credential nobody can use, and the
// stock permanently burned.
//
// It stayed invisible for as long as G2G chat was broken. Every real order died
// on the missing WebSocket, came back on the next tick through the retry branch,
// and that branch hand-builds plain objects — so it was correct. Repairing the
// chat is what armed the bug.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const MarketplaceListing = require("../models/MarketplaceListing");

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "utils", "g2gFulfiller.js"),
  "utf8",
);

// A listing in exactly the shape publishG2gShare creates: pre-reserved units,
// no unclaimedGame, loaded as a real document rather than a POJO.
function listingWithUnits() {
  return new MarketplaceListing({
    marketplace: "g2g",
    externalId: "G2G-TEST",
    units: [
      { login: "marolkapong", accountId: "aaaaaaaaaaaaaaaaaaaaaaaa", contentId: "led-1" },
      { login: "secondaccount", accountId: "bbbbbbbbbbbbbbbbbbbbbbbb", contentId: "led-2" },
    ],
  });
}

/* ------------------- the language behaviour behind it ------------------- */

test("REGRESSION: spreading a unit sub-document really does lose every field", () => {
  // The premise, asserted rather than assumed — if a future Mongoose makes
  // schema paths own properties this test documents that the hazard is gone.
  const u = listingWithUnits().units[0];
  assert.strictEqual(u.login, "marolkapong", "the getter works, which is what made this subtle");
  const spread = { ...u };
  assert.strictEqual(spread.login, undefined, "the spread does NOT carry login");
  assert.strictEqual(spread.accountId, undefined);
  assert.strictEqual(spread.contentId, undefined);
});

/* ---------------------------- the fix itself ---------------------------- */

test("the normaliser carries login, accountId and ledgerId off a sub-document", () => {
  // credentialsFor is module-private, so lift the helper it now uses.
  const fn = SRC.match(/function unit\(p, password\) \{[\s\S]*?\n\}/);
  assert.ok(fn, "the unit() normaliser should exist");
  // eslint-disable-next-line no-new-func
  const unit = new Function(`${fn[0]}\nreturn unit;`)();

  const u = listingWithUnits().units[0];
  const got = unit(u, "hunter2");
  assert.strictEqual(got.login, "marolkapong", "login must survive");
  assert.strictEqual(got.accountId, "aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.strictEqual(got.ledgerId, "led-1", "contentId is the unit's ledger id");
  assert.strictEqual(got.password, "hunter2");
});

test("it also accepts the retry path's plain-object spelling", () => {
  // The retry branch passes {login, accountId, ledgerId}; the units path passes
  // sub-documents carrying `contentId`. One normaliser has to take both.
  const fn = SRC.match(/function unit\(p, password\) \{[\s\S]*?\n\}/)[0];
  // eslint-disable-next-line no-new-func
  const unit = new Function(`${fn}\nreturn unit;`)();
  const got = unit({ login: "x", accountId: "cccccccccccccccccccccccc", ledgerId: "led-9" }, "pw");
  assert.strictEqual(got.login, "x");
  assert.strictEqual(got.ledgerId, "led-9");
});

test("a missing field becomes an empty string, never the string 'undefined'", () => {
  // "Username: undefined" was the visible symptom; an empty login must fail the
  // readable-credential gate instead of being rendered to a buyer.
  const fn = SRC.match(/function unit\(p, password\) \{[\s\S]*?\n\}/)[0];
  // eslint-disable-next-line no-new-func
  const unit = new Function(`${fn}\nreturn unit;`)();
  const got = unit({}, "");
  assert.strictEqual(got.login, "");
  assert.strictEqual(got.accountId, "");
  assert.strictEqual(got.ledgerId, "");
  assert.strictEqual(got.password, "");
  for (const v of Object.values(got)) {
    assert.notStrictEqual(String(v), "undefined");
  }
});

/* ------------------------- guards against relapse ------------------------ */

test("credentialsFor never spreads its input again", () => {
  const fn = SRC.slice(
    SRC.indexOf("async function credentialsFor("),
    SRC.indexOf("// One pass over everything G2G says is waiting"),
  );
  assert.doesNotMatch(
    fn,
    /\{\s*\.\.\.p\s*,/,
    "spreading a possibly-Mongoose sub-document silently drops every schema path",
  );
  assert.match(fn, /out\.push\(unit\(p, password\)\)/);
});

test("the already-resolved branch is normalised too", () => {
  // It used to push `p` straight through. Getters made that work by accident for
  // a sub-document, but it returned two different shapes from one function —
  // and the next caller to spread the result would have hit this all over again.
  const fn = SRC.slice(
    SRC.indexOf("async function credentialsFor("),
    SRC.indexOf("// One pass over everything G2G says is waiting"),
  );
  assert.match(fn, /out\.push\(unit\(p, p\.password\)\)/);
  assert.doesNotMatch(fn, /out\.push\(p\);/, "the raw sub-document must not escape");
});

test("the delivery code is still built from login + password", () => {
  // If this ever stops reading c.login the test above stops protecting anything.
  assert.match(SRC, /g2gDeliveryCode\(c\.login, c\.password\)/);
});
