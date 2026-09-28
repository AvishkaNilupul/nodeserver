// The report-only drift rules — no Mongo, no network.
//
// A no-claim account keeps farming after it is listed, so an event's later waves
// land on accounts already on sale under the earlier, smaller bundle; and when a
// wave expires its drops leave the inventory while the listing text does not
// change. The auto-lister's scan only re-groups RELEASED accounts, so a LISTED
// one neither grows into the fuller bundle nor shrinks out of a stale one on its
// own. These are the two pure functions that spot both, so the operator can
// relist by hand (this system never touches a live marketplace by itself).
//   1. richerBundle  — held is a strict, count-aware superset of advertised.
//   2. classifyDrift — ok / rebundle / relist / no-stock / unknown.
// See utils/unclaimedListingAudit.js.
const test = require("node:test");
const assert = require("node:assert");

const {
  richerBundle,
  classifyDrift,
  rebundleWithinScope,
  driftVerdict,
} = require("../utils/unclaimedListingAudit");

// A held drop carries its campaign (the no-claim scan populates it 100%).
const hd = (name, campaign, qty = 1) => ({ name, campaign, qty, game: "g", itemKey: name.toLowerCase() });

// A dominantOffer result carries `items` as a name array with copies expanded.
const held = (...names) => ({ items: names, count: names.length ? 1 : 0 });

// --- 1. richerBundle ---------------------------------------------------------

test("richerBundle: identical advertised and held is not richer", () => {
  assert.equal(richerBundle([{ name: "A" }, { name: "B" }], ["A", "B"]), null);
});

test("richerBundle: a NEW item name makes it richer", () => {
  const r = richerBundle([{ name: "A" }], ["A", "B"]);
  assert.ok(r);
  assert.deepEqual(r.added, [{ name: "b", qty: 1 }]);
});

test("richerBundle: a SECOND copy of a held name is richer (count-aware)", () => {
  // advertised one Esports Loot Box, accounts now hold two.
  const r = richerBundle([{ name: "Esports Loot Box", qty: 1 }], [
    "Esports Loot Box",
    "Esports Loot Box",
  ]);
  assert.ok(r, "gaining a second copy is a richer bundle");
  assert.deepEqual(r.added, [{ name: "esports loot box", qty: 1 }]);
});

test("richerBundle: dropping an advertised item is NOT richer (that is stale)", () => {
  assert.equal(richerBundle([{ name: "A" }, { name: "B" }], ["A"]), null);
});

test("richerBundle: fewer copies than advertised is not richer", () => {
  assert.equal(
    richerBundle([{ name: "Loot Box", qty: 2 }], ["Loot Box"]),
    null,
  );
});

test("richerBundle: empty held or empty advertised is null", () => {
  assert.equal(richerBundle([{ name: "A" }], []), null);
  assert.equal(richerBundle([], ["A"]), null);
});

test("richerBundle: names compare case/space-insensitively", () => {
  // advertised as typed, held as scanned — must not read as a new item.
  assert.equal(richerBundle([{ name: "Alpha  Pack" }], ["alpha pack"]), null);
});

// --- 2. classifyDrift --------------------------------------------------------

test("classifyDrift: no advertised list is unknown", () => {
  assert.equal(classifyDrift([], held("A")).verdict, "unknown");
});

test("classifyDrift: no listed stock at all is no-stock", () => {
  assert.equal(classifyDrift([{ name: "A" }], null).verdict, "no-stock");
  assert.equal(classifyDrift([{ name: "A" }], held()).verdict, "no-stock");
});

test("classifyDrift: held exactly matches advertised is ok", () => {
  assert.equal(classifyDrift([{ name: "A" }, { name: "B" }], held("A", "B")).verdict, "ok");
});

test("classifyDrift: held is missing an advertised item -> relist", () => {
  const d = classifyDrift([{ name: "A" }, { name: "B" }], held("A"));
  assert.equal(d.verdict, "relist");
  assert.deepEqual(d.missing.map((m) => m.name), ["b"]);
});

test("classifyDrift: held is a strict superset -> rebundle", () => {
  const d = classifyDrift([{ name: "A" }], held("A", "B", "C"));
  assert.equal(d.verdict, "rebundle");
  assert.deepEqual(
    d.added.map((a) => a.name).sort(),
    ["b", "c"],
  );
});

test("classifyDrift: rebundle is count-aware (advertised 1, held 2)", () => {
  const d = classifyDrift([{ name: "Loot Box", qty: 1 }], held("Loot Box", "Loot Box"));
  assert.equal(d.verdict, "rebundle");
});

test("classifyDrift: relist is count-aware (advertised 2, held 1)", () => {
  const d = classifyDrift([{ name: "Loot Box", qty: 2 }], held("Loot Box"));
  assert.equal(d.verdict, "relist");
});

// --- 3. rebundleWithinScope (campaign-scoped) --------------------------------

test("rebundleWithinScope: completes the events it advertises (Day 1 + Day 2)", () => {
  const advertised = [{ name: "D1a" }, { name: "D1b" }, { name: "D2a" }];
  const heldUnique = [hd("D1a", "Day1"), hd("D1b", "Day1"), hd("D2a", "Day2"), hd("D2b", "Day2")];
  const t = rebundleWithinScope(advertised, heldUnique);
  assert.ok(t, "should rebundle when accounts hold more of the same events");
  assert.deepEqual(t.map((x) => x.name).sort(), ["D1a", "D1b", "D2a", "D2b"]);
});

test("rebundleWithinScope: NEVER adds a new event — a Day-1-only bundle stays Day 1", () => {
  const advertised = [{ name: "D1a" }, { name: "D1b" }]; // only Day 1
  const heldUnique = [hd("D1a", "Day1"), hd("D1b", "Day1"), hd("D1c", "Day1"), hd("D2a", "Day2")];
  const t = rebundleWithinScope(advertised, heldUnique);
  assert.ok(t, "completes Day 1");
  assert.deepEqual(t.map((x) => x.name).sort(), ["D1a", "D1b", "D1c"], "must not pull in the Day 2 drop");
});

test("rebundleWithinScope: count-aware within one event (1x -> 9x Esports Pack)", () => {
  const t = rebundleWithinScope([{ name: "Esports Pack", qty: 1 }], [hd("Esports Pack", "R6 Wave", 9)]);
  assert.ok(t);
  assert.equal(t[0].qty, 9);
});

test("rebundleWithinScope: no growth within scope -> null", () => {
  const advertised = [{ name: "D1a" }, { name: "D1b" }];
  const heldUnique = [hd("D1a", "Day1"), hd("D1b", "Day1"), hd("D2a", "Day2")];
  assert.equal(rebundleWithinScope(advertised, heldUnique), null);
});

test("rebundleWithinScope: an advertised item the accounts lost -> null (stale, not rebundle)", () => {
  assert.equal(rebundleWithinScope([{ name: "D1a" }, { name: "GONE" }], [hd("D1a", "Day1"), hd("D1b", "Day1")]), null);
});

test("rebundleWithinScope: empty inputs -> null", () => {
  assert.equal(rebundleWithinScope([], [hd("x", "c")]), null);
  assert.equal(rebundleWithinScope([{ name: "x" }], []), null);
});

// --- 4. driftVerdict ---------------------------------------------------------

test("driftVerdict: rebundle within scope reports what was added", () => {
  const v = driftVerdict([{ name: "D1a" }], [hd("D1a", "Day1"), hd("D1b", "Day1")]);
  assert.equal(v.verdict, "rebundle");
  assert.deepEqual(v.added.map((a) => a.name), ["D1b"]);
});

test("driftVerdict: a Day-1-only listing whose accounts also hold Day 2 is OK (not rebundle)", () => {
  const v = driftVerdict([{ name: "D1a" }, { name: "D1b" }], [hd("D1a", "Day1"), hd("D1b", "Day1"), hd("D2a", "Day2")]);
  assert.equal(v.verdict, "ok");
});

test("driftVerdict: relist when an advertised item is gone", () => {
  assert.equal(driftVerdict([{ name: "GONE" }, { name: "D1a" }], [hd("D1a", "Day1")]).verdict, "relist");
});

test("driftVerdict: no-stock and unknown", () => {
  assert.equal(driftVerdict([{ name: "x" }], []).verdict, "no-stock");
  assert.equal(driftVerdict([], [hd("x", "c")]).verdict, "unknown");
});
