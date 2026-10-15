// Code shop allocation (utils/codeShop/allocate.js, docs/code-shop/02-ENGINE.md).
//
// This is the part that decides which stored code goes into which sellable
// unit, so the one thing it must never do is hand the same code out twice, or
// put a code on sale that stops working inside the lead time. All values here
// are made up (the repository is public).
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const { freeCounts, planUnits, bestDraftSets } = require("../utils/codeShop/allocate");

const ObjectId = mongoose.Types.ObjectId;
const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

// Small, readable fixtures: code(id, slot, useBy, earnedAt).
const code = (id, slotKey, useBy = null, earnedAt = null) => ({ id, slotKey, useBy, earnedAt });
const product = (id, slots, createdAt = 0) => ({ id, slots, createdAt });
const ids = (units) => units.map((u) => u.map(String));
const entries = (map) => [...map.entries()];

// ---------------------------------------------------------------- freeCounts

test("freeCounts: a code is usable only while useBy - lead is after now; null useBy is usable", () => {
  const lead = 24 * HOUR;
  const free = [
    code("a1", "A", NOW + lead),          // exactly at the lead: out
    code("a2", "A", NOW + lead + 1),      // 1 ms past it: in
    code("a3", "A", NOW + lead - 1),      // inside the lead: out
    code("a4", "A", null),                // unknown use-by: in
    code("a5", "A", NOW - HOUR),          // already dead: out
    code("b1", "B", new Date(NOW + 3 * lead)), // a Date from Mongo works too
    code("b2", "B", NOW + lead),
  ];
  assert.deepEqual(entries(freeCounts(free, { now: NOW, leadMs: lead })), [["A", 2], ["B", 1]]);
  // No lead: only the dead one (and the exact-now edge) drop out.
  const noLead = [code("x", "A", NOW), code("y", "A", NOW + 1), code("z", "A", null)];
  assert.deepEqual(entries(freeCounts(noLead, { now: NOW })), [["A", 2]]);
  assert.deepEqual(entries(freeCounts(noLead, { now: NOW, leadMs: 0 })), [["A", 2]]);
});

test("freeCounts: slots come back sorted, a slot with nothing usable is absent, bad rows are skipped", () => {
  const free = [
    code("z1", "zeta"),
    code("a1", "alpha"),
    code("d1", "dead", NOW - 1),
    code("n1", null),
    code("n2", ""),
    { slotKey: "alpha" },                 // no id
    code("u1", "alpha", "2026-12-01"),    // unreadable use-by: treated as dead
    code("u2", "alpha", NaN),
  ];
  assert.deepEqual(entries(freeCounts(free, { now: NOW })), [["alpha", 1], ["zeta", 1]]);
  assert.deepEqual(entries(freeCounts([], { now: NOW })), []);
  assert.deepEqual(entries(freeCounts(undefined, { now: NOW })), []);
});

test("freeCounts: the same id twice (string or ObjectId spelling) counts once", () => {
  const hex = "65aa00000000000000000001";
  const free = [code(new ObjectId(hex), "A"), code(hex, "A"), code(hex, "B"), code("other", "A")];
  assert.deepEqual(entries(freeCounts(free, { now: NOW })), [["A", 2]]);
});

test("a missing clock or a bad lead fails loudly instead of guessing", () => {
  assert.throws(() => freeCounts([], {}), TypeError);
  assert.throws(() => freeCounts([], { now: "soon" }), TypeError);
  assert.throws(() => freeCounts([], { now: NOW, leadMs: -1 }), TypeError);
  assert.throws(() => freeCounts([], { now: NOW, leadMs: Infinity }), TypeError);
  assert.throws(() => freeCounts([], { now: NOW, leadMs: "24h" }), TypeError);
  assert.throws(() => planUnits({ products: [], free: [] }), TypeError);
  assert.throws(() => planUnits({ products: [], free: [], now: NOW, leadMs: -HOUR }), TypeError);
  assert.throws(() => planUnits({ products: [], free: [], now: NOW, maxUnitsPerProduct: NaN }), TypeError);
  assert.doesNotThrow(() => freeCounts([], { now: new Date(NOW) }));
});

// ----------------------------------------------------------------- planUnits

test("planUnits: codes inside the lead time are never planned; null useBy is", () => {
  const lead = 48 * HOUR;
  const { plans, left } = planUnits({
    products: [product("p", ["A"])],
    free: [code("soon", "A", NOW + lead), code("never", "A", null), code("later", "A", NOW + lead + HOUR)],
    now: NOW,
    leadMs: lead,
  });
  assert.deepEqual(ids(plans[0].units), [["later"], ["never"]]);
  assert.deepEqual(entries(left), [["A", 0]]);
});

test("planUnits: products go more slots first, then older first, then by id", () => {
  // One B code only, so exactly one two-slot product can get a unit.
  const free = [code("a1", "A"), code("a2", "A"), code("a3", "A"), code("b1", "B")];
  const products = [
    product("solo", ["A"], 0),                              // oldest, but one slot
    product("new", ["A", "B"], 500),
    product(new ObjectId("65aa0000000000000000000c"), ["A", "B"], 200),
    product(new ObjectId("65aa0000000000000000000b"), ["A", "B"], 200), // same age, lower id
    product("undated", ["A", "B"], null),                   // unknown age sorts after dated
  ];
  const { plans } = planUnits({ products, free, now: NOW });
  assert.deepEqual(plans.map((p) => String(p.productId)), [
    "65aa0000000000000000000b", "65aa0000000000000000000c", "new", "undated", "solo",
  ]);
  assert.deepEqual(plans.map((p) => p.units.length), [1, 0, 0, 0, 2]);
  assert.deepEqual(ids(plans[0].units), [["a1", "b1"]]);
  assert.deepEqual(ids(plans[4].units), [["a2"], ["a3"]]);
  // The productId comes back as it went in (an ObjectId stays an ObjectId).
  assert.ok(plans[0].productId instanceof ObjectId);
});

test("planUnits: within a slot, earliest useBy first (null last), then earliest earnedAt (null last), then id", () => {
  const free = [
    code("n-null-null", "A", null, null),
    code("n-null-5", "A", null, 5),
    code("u300-null", "A", NOW + 300 * HOUR, null),
    code("u300-7-b", "A", NOW + 300 * HOUR, 7),
    code("u300-7-a", "A", NOW + 300 * HOUR, 7),
    code("u300-2", "A", NOW + 300 * HOUR, 2),
    code("u100-9", "A", NOW + 100 * HOUR, 9),
    code(new ObjectId("65aa00000000000000000002"), "A", null, 5),
  ];
  const { plans } = planUnits({ products: [product("p", ["A"])], free, now: NOW, leadMs: HOUR });
  assert.deepEqual(ids(plans[0].units).map((u) => u[0]), [
    "u100-9", "u300-2", "u300-7-a", "u300-7-b", "u300-null",
    "65aa00000000000000000002", "n-null-5", "n-null-null",
  ]);
});

test("planUnits: each unit holds one code per slot in the product's own slot order", () => {
  const free = [code("a1", "A", null, 1), code("a2", "A", null, 2), code("b1", "B", null, 1), code("b2", "B", null, 2), code("c1", "C")];
  const { plans } = planUnits({ products: [product("p", ["C", "A", "B"])], free, now: NOW });
  assert.deepEqual(ids(plans[0].units), [["c1", "a1", "b1"]]);
});

test("planUnits: codes taken by one product are gone for the next; the cap holds", () => {
  const free = [];
  for (let i = 0; i < 6; i++) free.push(code(`a${i}`, "A", null, i), code(`b${i}`, "B", null, i));
  const products = [product("big", ["A", "B"], 1), product("lonelyA", ["A"], 0), product("lonelyB", ["B"], 2)];
  const { plans, left } = planUnits({ products, free, now: NOW, maxUnitsPerProduct: 4 });
  assert.deepEqual(plans.map((p) => p.productId), ["big", "lonelyA", "lonelyB"]);
  assert.deepEqual(ids(plans[0].units), [["a0", "b0"], ["a1", "b1"], ["a2", "b2"], ["a3", "b3"]]);
  assert.deepEqual(ids(plans[1].units), [["a4"], ["a5"]]);
  assert.deepEqual(ids(plans[2].units), [["b4"], ["b5"]]);
  assert.deepEqual(entries(left), [["A", 0], ["B", 0]]);

  // Default cap is 200; a cap of 0 plans nothing and leaves everything.
  const many = Array.from({ length: 250 }, (_, i) => code(`m${String(i).padStart(3, "0")}`, "M"));
  assert.equal(planUnits({ products: [product("p", ["M"])], free: many, now: NOW }).plans[0].units.length, 200);
  const none = planUnits({ products: [product("p", ["M"])], free: many, now: NOW, maxUnitsPerProduct: 0 });
  assert.deepEqual(none.plans[0].units, []);
  assert.deepEqual(entries(none.left), [["M", 250]]);
});

test("planUnits: a product with no slots or an empty slot gets no units; every product is listed", () => {
  const { plans, left } = planUnits({
    products: [product("empty", []), product("missing", ["A", "nowhere"]), product("ok", ["A"])],
    free: [code("a1", "A"), code("x1", "X")],
    now: NOW,
  });
  assert.deepEqual(plans.map((p) => [p.productId, p.units.length]), [["missing", 0], ["ok", 1], ["empty", 0]]);
  assert.deepEqual(entries(left), [["A", 0], ["X", 1]]);
});

test("planUnits: a slot listed twice takes two different codes per unit", () => {
  const free = [code("a1", "A", null, 1), code("a2", "A", null, 2), code("a3", "A", null, 3), code("b1", "B"), code("b2", "B")];
  const { plans, left } = planUnits({ products: [product("p", ["A", "B", "A"])], free, now: NOW });
  assert.deepEqual(ids(plans[0].units), [["a1", "b1", "a2"]]);
  assert.deepEqual(entries(left), [["A", 1], ["B", 1]]);
});

test("planUnits: a repeated code row or a repeated product is used once", () => {
  const hex = "65aa00000000000000000009";
  const free = [code(hex, "A"), code(new ObjectId(hex), "A"), code("a2", "A")];
  const products = [product("p", ["A"], 1), product("p", ["A"], 2)];
  const { plans } = planUnits({ products, free, now: NOW });
  assert.equal(plans.length, 1);
  assert.deepEqual(ids(plans[0].units), [["65aa00000000000000000009"], ["a2"]]);
  // The id comes back exactly as the first row gave it.
  assert.equal(typeof plans[0].units[0][0], "string");
});

test("planUnits: the same input gives the same plan, whatever order the rows arrive in", () => {
  const free = [code("a2", "A", NOW + 90 * HOUR, 3), code("b1", "B", null, 1), code("a1", "A", NOW + 90 * HOUR, 1), code("b2", "B", null, 2), code("a3", "A")];
  const products = [product("p1", ["A"], 3), product("p2", ["A", "B"], 9)];
  const one = planUnits({ products, free, now: NOW, leadMs: HOUR });
  const two = planUnits({ products: [...products].reverse(), free: [...free].reverse(), now: NOW, leadMs: HOUR });
  assert.deepEqual(two, one);
  assert.deepEqual(one.plans.map((p) => [p.productId, ids(p.units)]), [
    ["p2", [["a1", "b1"], ["a2", "b2"]]],
    ["p1", [["a3"]]],
  ]);
});

// -------------------------------------------- randomized property (seeded PRNG)

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Reference model written from the contract, independently of the module.
function refQueues(free, now, lead) {
  const first = new Map();
  for (const r of free) if (!first.has(String(r.id))) first.set(String(r.id), r);
  const bySlot = new Map();
  for (const [key, r] of first) {
    const useBy = r.useBy instanceof Date ? r.useBy.getTime() : r.useBy;
    if (!(useBy === null || useBy - lead > now)) continue;
    if (!bySlot.has(r.slotKey)) bySlot.set(r.slotKey, []);
    bySlot.get(r.slotKey).push({ key, sort: [useBy === null ? 1 : 0, useBy ?? 0, r.earnedAt === null ? 1 : 0, r.earnedAt ?? 0, key] });
  }
  const cmp = (x, y) => {
    for (let i = 0; i < x.sort.length; i++) if (x.sort[i] !== y.sort[i]) return x.sort[i] < y.sort[i] ? -1 : 1;
    return 0;
  };
  for (const q of bySlot.values()) q.sort(cmp);
  return { first, bySlot };
}

function refProductOrder(products) {
  return [...products].sort((a, b) => {
    if (a.slots.length !== b.slots.length) return b.slots.length - a.slots.length;
    const ca = a.createdAt, cb = b.createdAt;
    if (ca !== cb) {
      if (ca === null) return 1;
      if (cb === null) return -1;
      return ca - cb;
    }
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  });
}

test("planUnits property: 300 random cases never reuse a code and match the contract's counts", () => {
  for (let c = 0; c < 300; c++) {
    const rnd = mulberry32(0xc0de + c);
    const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const hex = () => Array.from({ length: 24 }, () => "0123456789abcdef"[int(0, 15)]).join("");

    const now = NOW + int(0, 1000) * HOUR;
    const lead = pick([0, HOUR, 24 * HOUR, 72 * HOUR]);
    const slotKeys = Array.from({ length: int(1, 6) }, (_, i) => `12:${hex().slice(0, 6)}:${i}`);
    const allSlots = [...slotKeys, "12:orphan:1"]; // a slot no product asks for

    const free = [];
    let dupes = false;
    const nCodes = int(0, 45);
    for (let i = 0; i < nCodes; i++) {
      let id = rnd() < 0.5 ? `code-${hex()}` : new ObjectId(hex());
      if (free.length && rnd() < 0.08) {
        const prev = pick(free).id; // the same code again, maybe spelt the other way
        id = typeof prev === "string" || rnd() < 0.5 ? String(prev) : prev;
        dupes = true;
      }
      const useBy = pick([
        null, null,
        now - int(1, 50) * HOUR,
        now + lead, now + lead - 1, now + lead + 1,
        now + lead + int(1, 500) * HOUR,
        new Date(now + lead + int(1, 500) * HOUR),
        now + lead + 10 * HOUR, // shared value, so earnedAt / id break ties
      ]);
      const earnedAt = rnd() < 0.2 ? null : int(0, 4);
      free.push(code(id, pick(allSlots), useBy, earnedAt));
    }

    const products = [];
    const nProducts = int(0, 5);
    for (let j = 0; j < nProducts; j++) {
      const pool = [...slotKeys];
      const slots = [];
      const size = int(1, Math.min(4, pool.length));
      for (let k = 0; k < size; k++) slots.push(pool.splice(int(0, pool.length - 1), 1)[0]);
      if (rnd() < 0.1) slots.splice(int(0, slots.length), 0, pick(slots)); // a slot listed twice
      const id = rnd() < 0.5 ? `prod-${j}-${hex().slice(0, 4)}` : new ObjectId(hex());
      products.push(product(id, slots, rnd() < 0.15 ? null : int(0, 3)));
    }
    const cap = pick([undefined, 200, 0, 1, 2, 3]);
    const input = { products, free, now, leadMs: lead, maxUnitsPerProduct: cap };
    const out = planUnits(input);
    const tag = `case ${c}`;

    // Reference walk.
    const ref = refQueues(free, now, lead);
    const rem = new Map([...ref.bySlot].map(([s, q]) => [s, q.length]));
    assert.deepEqual(entries(freeCounts(free, { now, leadMs: lead })), [...rem].sort((a, b) => (a[0] < b[0] ? -1 : 1)), tag);
    const order = refProductOrder(products);
    assert.deepEqual(out.plans.map((p) => String(p.productId)), order.map((p) => String(p.id)), tag);

    const used = new Set();
    const consumed = new Map(); // slot -> ids in the order they were taken
    const limit = cap === undefined ? 200 : cap;
    out.plans.forEach((plan, pi) => {
      const slots = order[pi].slots;
      const need = new Map();
      for (const s of slots) need.set(s, (need.get(s) || 0) + 1);
      let expected = limit;
      for (const [s, per] of need) expected = Math.min(expected, Math.floor((rem.get(s) || 0) / per));
      assert.equal(plan.units.length, expected, `${tag}: unit count of product ${pi}`);
      for (const [s, per] of need) if (rem.has(s)) rem.set(s, rem.get(s) - expected * per);

      for (const unit of plan.units) {
        assert.equal(unit.length, slots.length, tag);
        unit.forEach((id, j) => {
          const key = String(id);
          assert.ok(!used.has(key), `${tag}: code ${key} used twice`);
          used.add(key);
          const row = ref.first.get(key);
          assert.ok(row, tag);
          assert.equal(row.slotKey, slots[j], `${tag}: code in the wrong slot position`);
          const useBy = row.useBy instanceof Date ? row.useBy.getTime() : row.useBy;
          assert.ok(useBy === null || useBy - lead > now, `${tag}: unusable code planned`);
          if (!consumed.has(row.slotKey)) consumed.set(row.slotKey, []);
          consumed.get(row.slotKey).push(key);
        });
      }
    });

    // Each slot was drawn oldest-first: what was taken is the head of its queue.
    for (const [slot, taken] of consumed) {
      assert.deepEqual(taken, ref.bySlot.get(slot).slice(0, taken.length).map((x) => x.key), `${tag}: slot ${slot} order`);
    }
    assert.deepEqual(entries(out.left), [...rem].sort((a, b) => (a[0] < b[0] ? -1 : 1)), `${tag}: left`);

    // Deterministic, and (with no repeated code rows) blind to input order.
    assert.deepEqual(planUnits(input), out, tag);
    if (!dupes) {
      const shuffled = (arr) => arr.map((x) => [rnd(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
      const again = planUnits({ ...input, products: shuffled(products), free: shuffled(free) });
      assert.deepEqual(again, out, `${tag}: order-dependent`);
    }
  }
});

// -------------------------------------------------------------- bestDraftSets

test("bestDraftSets: fullFirst takes every slot when the smallest count reaches minUnits", () => {
  const counts = new Map([["A", 10], ["B", 10], ["C", 2]]);
  // A+B x10 is worth more, but the first draft is the whole set.
  assert.deepEqual(bestDraftSets(counts, { minUnits: 2, maxSets: 1 }), [{ slotKeys: ["A", "B", "C"], units: 2 }]);
  // Without fullFirst the first pass is the units*k pick.
  assert.deepEqual(bestDraftSets(counts, { minUnits: 2, maxSets: 1, fullFirst: false }), [{ slotKeys: ["A", "B"], units: 10 }]);
  // Smallest below minUnits: pass 1 falls back to the units*k pick.
  assert.deepEqual(bestDraftSets(counts, { minUnits: 3, maxSets: 1 }), [{ slotKeys: ["A", "B"], units: 10 }]);
});

test("bestDraftSets: picks the largest units*k; a tie goes to the larger k", () => {
  // k=1: 10x1=10, k=2: 5x2=10 -> tie -> both slots.
  assert.deepEqual(bestDraftSets({ A: 10, B: 5 }, { minUnits: 1, maxSets: 1, fullFirst: false }), [{ slotKeys: ["A", "B"], units: 5 }]);
  // k=1: 9, k=2: 8x2=16, k=3: 3x3=9 -> k=2.
  assert.deepEqual(bestDraftSets({ C: 3, A: 9, B: 8 }, { minUnits: 1, maxSets: 1, fullFirst: false }), [{ slotKeys: ["A", "B"], units: 8 }]);
  // Equal counts sort by key; a tie in value still prefers more slots.
  assert.deepEqual(bestDraftSets({ b: 6, a: 6, c: 4 }, { minUnits: 1, maxSets: 1, fullFirst: false }), [{ slotKeys: ["a", "b", "c"], units: 4 }]);
  // k=1 6, k=2 12, k=3 12 -> tie -> k=3.
  assert.deepEqual(bestDraftSets({ x: 6, y: 6, z: 4 }, { minUnits: 1, maxSets: 1, fullFirst: false }), [{ slotKeys: ["x", "y", "z"], units: 4 }]);
});

test("bestDraftSets: a set below minUnits is never proposed", () => {
  // Values: k1=10, k2=8, k3=12, k4=16 — but only k=1 has units >= 5.
  const counts = { A: 10, B: 4, C: 4, D: 4 };
  assert.deepEqual(bestDraftSets(counts, { minUnits: 5, maxSets: 3 }), [{ slotKeys: ["A"], units: 10 }]);
  assert.deepEqual(bestDraftSets(counts, { minUnits: 11 }), []);
  // A fractional minimum rounds up (units are whole); a missing one means 1.
  assert.deepEqual(bestDraftSets({ A: 2 }, { minUnits: 2.5 }), []);
  assert.deepEqual(bestDraftSets({ A: 2 }, {}), [{ slotKeys: ["A"], units: 2 }]);
  assert.throws(() => bestDraftSets({ A: 2 }, { minUnits: "3" }), TypeError);
});

test("bestDraftSets: maxSets bounds the passes (default 2)", () => {
  const counts = { A: 30, B: 20, C: 10, D: 5 };
  // Pass 1 (full): all x5 -> A25 B15 C5. Pass 2: k1 25, k2 30, k3 15 -> A,B x15 -> A10 B0 C5.
  // Pass 3: A10, C5 -> k1 10, k2 10 -> tie -> A,C x5.
  const three = bestDraftSets(counts, { minUnits: 1, maxSets: 3 });
  assert.deepEqual(three, [
    { slotKeys: ["A", "B", "C", "D"], units: 5 },
    { slotKeys: ["A", "B"], units: 15 },
    { slotKeys: ["A", "C"], units: 5 },
  ]);
  assert.deepEqual(bestDraftSets(counts, { minUnits: 1 }), three.slice(0, 2));
  assert.deepEqual(bestDraftSets(counts, { minUnits: 1, maxSets: 1 }), three.slice(0, 1));
  assert.deepEqual(bestDraftSets(counts, { minUnits: 1, maxSets: 0 }), []);
  // Unbounded stops when nothing is left: pass 4 is A x5, then empty.
  assert.deepEqual(bestDraftSets(counts, { minUnits: 1, maxSets: Infinity }), [...three, { slotKeys: ["A"], units: 5 }]);
});

test("bestDraftSets: each pass works on what the earlier passes left; the caller's counts are untouched", () => {
  const counts = new Map([["A", 8], ["B", 8], ["C", 3]]);
  // Pass 1 full x3 -> A5 B5 C0; pass 2 sees only A, B (C is spent): A,B x5.
  assert.deepEqual(bestDraftSets(counts, { minUnits: 3 }), [
    { slotKeys: ["A", "B", "C"], units: 3 },
    { slotKeys: ["A", "B"], units: 5 },
  ]);
  assert.deepEqual(entries(counts), [["A", 8], ["B", 8], ["C", 3]]);
  // The remainder below minUnits ends the run early.
  assert.deepEqual(bestDraftSets(new Map([["A", 5], ["B", 3]]), { minUnits: 3, maxSets: 5 }), [
    { slotKeys: ["A", "B"], units: 3 },
  ]);
});

test("bestDraftSets: worked example (5 slots x29, F x20, G x15, minUnits 3, fullFirst)", () => {
  const counts = new Map([["s1", 29], ["s2", 29], ["s3", 29], ["s4", 29], ["s5", 29], ["sF", 20], ["sG", 15]]);
  const sets = bestDraftSets(counts, { minUnits: 3, maxSets: 2, fullFirst: true });
  // Pass 1: every slot x15. Left: five x14, F x5, G x0.
  // Pass 2: k=5 -> 14x5 = 70 beats k=6 -> 5x6 = 30.
  assert.deepEqual(sets, [
    { slotKeys: ["s1", "s2", "s3", "s4", "s5", "sF", "sG"], units: 15 },
    { slotKeys: ["s1", "s2", "s3", "s4", "s5"], units: 14 },
  ]);
});

test("bestDraftSets: plain objects and entry lists work; zero, negative and junk counts are ignored; output is stable", () => {
  assert.deepEqual(bestDraftSets({ A: 4, Z: 0, N: -3, J: "x", I: Infinity }, { minUnits: 1 }), [{ slotKeys: ["A"], units: 4 }]);
  assert.deepEqual(bestDraftSets([["B", 2], ["A", 2]], { minUnits: 1, maxSets: 1 }), [{ slotKeys: ["A", "B"], units: 2 }]);
  assert.deepEqual(bestDraftSets(new Map(), { minUnits: 1 }), []);
  assert.deepEqual(bestDraftSets(null, { minUnits: 1 }), []);
  const a = bestDraftSets(new Map([["q", 7], ["p", 7], ["r", 2]]), { minUnits: 2 });
  const b = bestDraftSets(new Map([["r", 2], ["p", 7], ["q", 7]]), { minUnits: 2 });
  assert.deepEqual(a, b);
});

test("freeCounts feeds bestDraftSets: lead-excluded codes never make a draft", () => {
  const lead = 24 * HOUR;
  const free = [
    ...Array.from({ length: 4 }, (_, i) => code(`a${i}`, "A", NOW + 10 * lead)),
    ...Array.from({ length: 4 }, (_, i) => code(`b${i}`, "B", i < 3 ? NOW + lead : null)), // 3 inside the lead
  ];
  const counts = freeCounts(free, { now: NOW, leadMs: lead });
  assert.deepEqual(bestDraftSets(counts, { minUnits: 2 }), [{ slotKeys: ["A"], units: 4 }]);
});
