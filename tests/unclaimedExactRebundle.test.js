// Exact mode of the vault listing checker (utils/unclaimedListingAudit.js):
// a Gameflip / GGSel no-claim listing says what its units hold, up and down.
// Measured on prod 2026-10-06: 16 of 18 such listings under-advertised (the
// worst sold an account holding 12 items as "(1 Item)"), and two GGSel offers
// still listed a Rainbow Six wave that had expired off every unit.
const test = require("node:test");
const assert = require("node:assert");

const audit = require("../utils/unclaimedListingAudit");

const d = (name, campaign, qty = 1) => ({ name, game: "Rainbow Six Siege", campaign, itemKey: name.toLowerCase() + "|rainbow six siege", qty });

test("a listing that names one item is grown to everything its unit holds, across events", () => {
  const held = [d("OL' CLANKER", "R6S Wasteland circuit"), d("Esports Pack 26 Stage 2.1", "R6S S2 2026 11", 6), d("Esports Pack 26 Stage 2.1", "R6S S2 2026 12", 5)];
  const v = audit.exactVerdict([{ name: "OL' CLANKER", qty: 1 }], held);
  assert.strictEqual(v.verdict, "rebundle");
  assert.deepStrictEqual(v.target.map((t) => [t.name, t.qty]), [["OL' CLANKER", 1], ["Esports Pack 26 Stage 2.1", 11]]);
  assert.deepStrictEqual(v.added, [{ name: "Esports Pack 26 Stage 2.1", qty: 11 }]);
  // The campaign-scoped rule called the same listing fine.
  assert.strictEqual(audit.driftVerdict([{ name: "OL' CLANKER", qty: 1 }], held).verdict, "ok");
  assert.strictEqual(audit.driftVerdict([{ name: "OL' CLANKER", qty: 1 }], held, { exact: true }).verdict, "rebundle");
});

test("an advertised item no unit holds any more is a shrink to what they do hold", () => {
  // GGSel 103323374 on 2026-10-06.
  const adv = [{ name: "Esports Pack 26 stage 2", qty: 6 }, { name: "Esports Pack 26 Stage 2.1", qty: 6 }, { name: "OL' CLANKER", qty: 1 }];
  const held = [d("Esports Pack 26 Stage 2.1", "R6S S2 2026 12", 11), d("OL' CLANKER", "R6S Wasteland circuit")];
  const v = audit.exactVerdict(adv, held);
  assert.strictEqual(v.verdict, "relist");
  assert.strictEqual(v.exact, true);
  assert.deepStrictEqual(v.missing, [{ name: "esports pack 26 stage 2", need: 6, have: 0 }]);
  assert.deepStrictEqual(v.target.map((t) => [t.name, t.qty]), [["Esports Pack 26 Stage 2.1", 11], ["OL' CLANKER", 1]]);
});

test("what the listing already names keeps its place in the new bundle", () => {
  const held = [d("100 Comp Points", "Reign of Talon", 5), d("Sun Tea Icon", "OWCS"), d("Esports Loot Box", "OWCS")];
  const v = audit.exactVerdict([{ name: "Sun Tea Icon" }, { name: "Esports Loot Box" }], held);
  assert.deepStrictEqual(v.target.map((t) => t.name), ["Sun Tea Icon", "Esports Loot Box", "100 Comp Points"]);
});

test("fewer copies than advertised is a shrink too", () => {
  const v = audit.exactVerdict([{ name: "Esports Pack 26 Stage 2.1", qty: 12 }], [d("Esports Pack 26 Stage 2.1", "w", 9)]);
  assert.strictEqual(v.verdict, "relist");
  assert.deepStrictEqual(v.target.map((t) => t.qty), [9]);
});

test("a listing that already says what is held is ok; nothing held is no-stock; no list is unknown", () => {
  const held = [d("OL' CLANKER", "c"), d("Esports Pack 26 Stage 2.1", "a", 4), d("Esports Pack 26 Stage 2.1", "b", 5)];
  assert.strictEqual(audit.exactVerdict([{ name: "ol' clanker" }, { name: "Esports Pack 26 Stage 2.1", qty: 9 }], held).verdict, "ok");
  assert.strictEqual(audit.exactVerdict([{ name: "x" }], []).verdict, "no-stock");
  assert.strictEqual(audit.exactVerdict([], held).verdict, "unknown");
});

test("foldHeldByName sums an item's copies over its campaigns", () => {
  const out = audit.foldHeldByName([d("Pack", "a", 3), d("Pack", "b", 3), d("Spray", "a")]);
  assert.deepStrictEqual(out.map((x) => [x.name, x.qty]), [["Pack", 6], ["Spray", 1]]);
});

test("the automatic pass shrinks in place only where the row keeps its units", () => {
  assert.deepStrictEqual(audit.SHRINK_INPLACE_MARKETS, ["ggsel"], "a short Gameflip unit is the engine's to take off and relist");
  assert.ok(audit.REBUNDLE_AUTO_MARKETS.includes("gameflip"));
});
