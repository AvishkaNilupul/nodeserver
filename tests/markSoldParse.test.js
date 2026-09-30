// The manual mark-sold price/marketplace parser in public/drops-archive.html.
//
// WHY THIS MATTERS
// 390 of the 553 sales on record (71%) came from the manual mark-sold path with
// priceUsd 0 and no marketplace. The endpoint had always accepted both fields —
// the form simply never sent them. Realised price is what utils/pricing.js
// anchors on and what utils/autoFarmer.js weights demand by (priceFactor), so
// every blank sale taught the system that a game sells but not that it sells
// well.
//
// The parser is defined inside the page, so this test EXTRACTS it from the HTML
// and evaluates it rather than re-implementing the logic — a copy here could
// drift from the shipped code and still pass, which would defeat the point.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadParser() {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "public", "drops-archive.html"),
    "utf8",
  );
  const start = html.indexOf("function parseSaleEntry(");
  assert.ok(start > -1, "parseSaleEntry not found in drops-archive.html");
  // Walk braces from the function's opening brace to its matching close.
  const open = html.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > -1, "could not find the end of parseSaleEntry");
  const src = html.slice(start, end);
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src + "\nthis.parseSaleEntry = parseSaleEntry;", ctx);
  return ctx.parseSaleEntry;
}

const parse = loadParser();

test("a plain price is read", () => {
  assert.deepEqual(parse("1.75"), { priceUsd: 1.75, marketplace: "", bad: false });
});

test("price plus marketplace is read", () => {
  assert.deepEqual(parse("2.50 digiseller"), {
    priceUsd: 2.5,
    marketplace: "digiseller",
    bad: false,
  });
});

test("blank means skip, not an error — it must never block a sale", () => {
  for (const input of ["", "   ", null, undefined]) {
    const out = parse(input);
    assert.equal(out.bad, false, "blank input reported bad: " + JSON.stringify(input));
    assert.equal(out.priceUsd, 0);
  }
});

test("REGRESSION: currency symbols do not silently zero the price", () => {
  // The first draft dropped "$2.50" to 0 — reintroducing the exact blank this
  // change exists to remove.
  assert.equal(parse("$2.50").priceUsd, 2.5);
  assert.equal(parse("€3").priceUsd, 3);
  assert.equal(parse("2.50 USD").priceUsd, 2.5);
});

test("REGRESSION: a comma decimal is read as money", () => {
  assert.equal(parse("2,50").priceUsd, 2.5);
  assert.equal(parse("2,5 gameflip").priceUsd, 2.5);
  assert.equal(parse("2,50 ggsel").marketplace, "ggsel");
});

test("a marketplace with no price is valid", () => {
  assert.deepEqual(parse("digiseller"), {
    priceUsd: 0,
    marketplace: "digiseller",
    bad: false,
  });
});

test("the marketplace is normalised to lower case and trimmed", () => {
  assert.equal(parse("2.50  Digiseller  ").marketplace, "digiseller");
});

test("an absurd price is rejected rather than recorded", () => {
  assert.equal(parse("99999").bad, true);
  assert.equal(parse("-5").bad, true);
});

test("unreadable input carrying digits is rejected, not guessed at", () => {
  // Leftover digits mean we misread the entry; recording a wrong price is
  // worse than recording none.
  assert.equal(parse("2.50 for 3 units").bad, true);
});

test("a price is never invented from text", () => {
  assert.equal(parse("sold to a friend").priceUsd, 0);
  assert.equal(parse("sold to a friend").bad, false);
});
