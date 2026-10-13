// utils/g2gEvergreen.js — one long-lived G2G bundle offer per game, rewritten
// in place. The mistakes that cost money here: a buyer paying for one text and
// being handed another bundle, an offer left on sale that nothing can deliver,
// a selling offer touched when it did not need to be, a price made up, and an
// offer of somebody else's (a reserved share, a no-claim copy, a hand-made one)
// rewritten or taken down.
//
// No Mongo and no network: the engine takes its world as `deps`.
const test = require("node:test");
const assert = require("node:assert/strict");

const eg = require("../utils/g2gEvergreen");
const { parseArgs, describe } = require("../scripts/g2g-evergreen");

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 13, 6, 0, 0);

/* ------------------------------- builders -------------------------------- */

const item = (name, qty = 1, game = "Halo Infinite") => ({ itemKey: name.toLowerCase() + "|" + game.toLowerCase(), name, game, qty });
// items(5) = i1..i5, so items(34) holds everything items(22) does.
const items = (n, prefix = "i", game = "Halo Infinite") => Array.from({ length: n }, (_, k) => item(prefix + (k + 1), 1, game));
const setOf = (id, list, fields = {}) => ({ _id: id, name: "set " + id, items: list, price: 2, coverGame: (list[0] || {}).game || "", ...fields });

const soldUnit = (n) => ({ accountId: "acc" + n, login: "l" + n, orderId: "o" + n, messagedAt: new Date(NOW - 5 * HOUR), deliveredAt: null });
const midUnit = () => ({ accountId: "accM", login: "lM", orderId: "oM", messagedAt: null, deliveredAt: null });
const freeUnit = (n) => ({ accountId: "free" + n, login: "f" + n, orderId: "", messagedAt: null, deliveredAt: null });

let seq = 0;
// A G2G listing row. `sold` adds that many receipts; `shape` picks the stock source.
function listing(offerId, setId, { sold = 0, paused = false, shape = "archive", price = 2, title, mid = false, origin = "auto", pausedFor = 2 * HOUR, free = 0, status = "active" } = {}) {
  const units = Array.from({ length: sold }, (_, k) => soldUnit(k + 1));
  if (mid) units.push(midUnit());
  for (let k = 0; k < free; k++) units.push(freeUnit(k + 1));
  return {
    _id: "row" + ++seq,
    marketplace: "g2g",
    externalId: offerId,
    set: setId,
    status,
    origin,
    title: title || "title of " + offerId,
    description: "description of " + offerId,
    price,
    autoPaused: paused,
    updatedAt: new Date(NOW - pausedFor),
    note: "",
    units,
    autoClaimSet: shape === "archive",
    noclaimStock: shape === "noclaim",
    bulkOfferId: shape === "bulk" ? "B1" : null,
    accountOffer: shape === "accountOffer" ? "A1" : null,
  };
}
// The plan's view of a row; `stock` is what a paused row's own bundle can still deliver.
const fact = (row, set, stock = null) => ({ ...eg.rowFacts(row, set, NOW), stock });
const cand = (set, stock, price = set.price) => {
  const list = set.items;
  return { setId: String(set._id), set, sig: eg.itemsSignature(list), items: list, name: set.name, size: list.length, total: list.reduce((a, i) => a + (i.qty || 1), 0), stock, price };
};
const ALL = { rescue: true, upgrade: true, keepBest: true, retire: true };
const brief = (plan) =>
  plan.actions.map((a) =>
    a.type === "rewrite"
      ? a.kind + " " + a.offerId + " -> " + a.toSet + " $" + a.price + (a.absorb ? " (takes over " + a.absorb + ")" : "")
      : a.type === "publish"
        ? "publish " + a.toSet + " $" + a.price
        : "retire " + a.offerId,
  );

/* --------------------------------- pure ---------------------------------- */

test("a bundle is the same bundle whatever the order, and a different one when a count differs", () => {
  const a = [item("Visor"), item("Charm", 2)];
  assert.equal(eg.itemsSignature(a), eg.itemsSignature([item("Charm", 2), item("Visor")]));
  assert.notEqual(eg.itemsSignature(a), eg.itemsSignature([item("Charm"), item("Visor")]));
  // an item with no stored key is known by its name and game
  assert.equal(eg.itemsSignature([{ name: "Visor", game: "Halo Infinite" }]), eg.itemsSignature([{ name: "visor ", game: "halo infinite" }]));
  assert.equal(eg.itemsSignature([]), "");
});

test("a bigger bundle contains a smaller one only when it holds every item in the same number", () => {
  assert.equal(eg.containsAll(items(34), items(22)), true);
  assert.equal(eg.containsAll(items(22), items(34)), false);
  assert.equal(eg.containsAll([item("a"), item("b")], [item("a", 2)]), false);
  assert.equal(eg.containsAll(items(3), []), false);
});

test("only an archive offer this system made is managed; every other shape is somebody else's", () => {
  const set = setOf("S1", items(3));
  const shapes = ["archive", "units", "noclaim", "bulk", "accountOffer"].map((shape) => {
    const f = fact(listing("G-" + shape, "S1", { shape, free: shape === "units" ? 2 : 0 }), set);
    return [f.shape, f.managed];
  });
  assert.deepEqual(shapes, [["archive", true], ["units", false], ["noclaim", false], ["bulk", false], ["accountOffer", false]]);
  assert.equal(fact(listing("G-hand", "S1", { origin: "manual" }), set).managed, false);
  assert.equal(fact(listing("G-off", "S1", { status: "delisted" }), set).managed, false);
});

test("a row's sales are the accounts a buyer was sent; one an order holds unsent is mid hand-over", () => {
  const f = fact(listing("G1", "S1", { sold: 3, mid: true }), setOf("S1", items(4)));
  assert.deepEqual([f.sold, f.mid, f.size], [3, true, 4]);
  assert.equal(f.lastSoldAt, NOW - 5 * HOUR);
  const delivered = eg.rowFacts({ ...listing("G2", "S1"), units: [{ accountId: "a", orderId: "", deliveredAt: new Date(NOW) }] }, null, NOW);
  assert.equal(delivered.sold, 1);
});

test("a bundle keeps the price it already has, and a rewritten offer never costs more than it did", () => {
  const offer = { price: 2.33, size: 33 };
  // the offer it is taken over from wins over the set
  assert.equal(eg.priceFor(offer, { price: 1.5, size: 5 }, { price: 1 }, 1), 1);
  assert.equal(eg.priceFor(offer, { price: 1.5, size: 5 }, null, 1), 1.5);
  // priced higher than the offer was: capped at the offer's price
  assert.equal(eg.priceFor(offer, { price: 3, size: 21 }, null, 1), 2.33);
  // ...a bigger bundle too. One 38-item Halo set carries $6; the offer it
  // would have replaced sells 22 items at $2.11.
  assert.equal(eg.priceFor({ price: 2.11, size: 22 }, { price: 6, size: 38 }, null, 1), 2.11);
  assert.equal(eg.priceFor({ price: 2.11, size: 22 }, { price: 2.49, size: 34 }, { price: 2.49 }, 1), 2.11);
  // G2G's floor, and no price at all
  assert.equal(eg.priceFor(offer, { price: 0.75, size: 4 }, null, 1), 1);
  assert.equal(eg.priceFor(offer, { price: 0, size: 4 }, null, 1), 0);
});

/* ------------------------------- the plan -------------------------------- */

test("an offer that has sold and ran out moves to the biggest bundle we can still deliver", () => {
  const s33 = setOf("S33", items(33));
  const s12 = setOf("S12", items(12, "n"), { price: 1.84 });
  const s5 = setOf("S5", items(5, "m"), { price: 1 });
  const rows = [fact(listing("G33", "S33", { sold: 14, paused: true, price: 2.33 }), s33, 0)];
  const plan = eg.planGame(rows, [cand(s5, 16), cand(s12, 6)], { rescue: true, floor: 1 });
  assert.deepEqual(brief(plan), ["rescue G33 -> S12 $1.84"]);
  assert.deepEqual([plan.actions[0].fromSet, plan.actions[0].size, plan.actions[0].stock, plan.actions[0].title], ["S33", 12, 6, ""]);
});

test("the rescue leaves alone everything that does not need it", () => {
  const set = setOf("S9", items(9));
  const other = cand(setOf("S5", items(5, "m")), 10);
  const plan = (row, stock) => eg.planGame([fact(row, set, stock)], [other], { rescue: true, floor: 1 });
  const why = (p) => (p.notes[0] || {}).why || "";
  // on sale; paused but its own bundle has stock again (the sync relists it)
  assert.deepEqual(brief(plan(listing("G1", "S9", { sold: 2 }), null)), []);
  assert.deepEqual(brief(plan(listing("G1", "S9", { sold: 2, paused: true }), 4)), []);
  // could not be counted; an order mid hand-over; only just paused
  assert.match(why(plan(listing("G1", "S9", { sold: 2, paused: true }), null)), /could not be counted/);
  assert.match(why(plan(listing("G1", "S9", { sold: 2, paused: true, mid: true }), 0)), /mid hand-over/);
  assert.match(why(plan(listing("G1", "S9", { sold: 2, paused: true, pausedFor: 10 * 60 * 1000 }), 0)), /under 30 min/);
  // never sold: nothing to keep alive
  assert.deepEqual(brief(plan(listing("G1", "S9", { paused: true }), 0)), []);
  // and the one case it is for
  assert.deepEqual(brief(plan(listing("G1", "S9", { sold: 2, paused: true }), 0)), ["rescue G1 -> S5 $2"]);
});

test("a never-sold offer that already sells that bundle is taken over: its text, its price, and it comes down", () => {
  const s33 = setOf("S33", items(33));
  const s5 = setOf("S5", items(5, "m"), { price: 1.75 });
  const rows = [
    fact(listing("G33", "S33", { sold: 14, paused: true, price: 2.33 }), s33, 0),
    fact(listing("G5", "S5", { price: 1, title: "Brawlhalla Twitch Drops (5 Items) — Artemis" }), s5),
  ];
  const plan = eg.planGame(rows, [cand(s5, 16)], { rescue: true, floor: 1 });
  assert.deepEqual(brief(plan), ["rescue G33 -> S5 $1 (takes over G5)"]);
  assert.equal(plan.actions[0].title, "Brawlhalla Twitch Drops (5 Items) — Artemis");
  assert.equal(plan.actions[0].description, "description of G5");
});

test("a bundle that is on the shelf already is never given to a second offer", () => {
  const s33 = setOf("S33", items(33));
  const s9 = setOf("S9", items(9, "a"));
  const s7 = setOf("S7", items(7, "b"));
  const s6 = setOf("S6", items(6, "c"));
  const s5 = setOf("S5", items(5, "d"));
  const rows = [
    fact(listing("G33", "S33", { sold: 14, paused: true }), s33, 0),
    fact(listing("G9", "S9", { sold: 3 }), s9), // a selling offer of ours
    fact(listing("G7", "S7", { shape: "units", free: 3 }), s7), // the auto-lister's reserved share
    fact(listing("G6", "S6", { shape: "noclaim" }), s6), // a no-claim copy
  ];
  const plan = eg.planGame(rows, [cand(s33, 9), cand(s9, 9), cand(s7, 9), cand(s6, 9), cand(s5, 9)], { rescue: true, floor: 1 });
  assert.deepEqual(brief(plan), ["rescue G33 -> S5 $2"]);
  // a paused offer whose own bundle is back in stock is coming back: its bundle is taken too
  const back = [fact(listing("G33", "S33", { sold: 14, paused: true }), s33, 0), fact(listing("G9", "S9", { sold: 3, paused: true }), s9, 5)];
  assert.deepEqual(brief(eg.planGame(back, [cand(s9, 9)], { rescue: true, floor: 1 })), []);
});

test("several sold-out offers: the best seller first, each a different bundle, the rest wait", () => {
  const sets = [33, 27, 24, 9].map((n) => setOf("S" + n, items(n)));
  const rows = [
    fact(listing("G24", "S24", { sold: 1, paused: true }), sets[2], 0),
    fact(listing("G9", "S9", { sold: 5, paused: true }), sets[3], 0),
    fact(listing("G33", "S33", { sold: 14, paused: true }), sets[0], 0),
    fact(listing("G27", "S27", { sold: 1, paused: true }), sets[1], 0),
  ];
  rows[3].lastSoldAt = NOW - HOUR; // of the two with one sale, the later sale goes first
  const a = setOf("SA", items(6, "a"));
  const b = setOf("SB", items(4, "b"));
  const plan = eg.planGame(rows, [cand(b, 12), cand(a, 16)], { rescue: true, floor: 1 });
  assert.deepEqual(brief(plan), ["rescue G33 -> SA $2", "rescue G9 -> SB $2"]);
  assert.deepEqual(plan.notes.map((n) => n.offerId), ["G27", "G24"]);
  assert.match(plan.notes[0].why, /no other bundle of this game has 5\+ accounts/);
});

test("a bundle with too few accounts behind it, or no price, is not moved to", () => {
  const s33 = setOf("S33", items(33));
  const rows = () => [fact(listing("G33", "S33", { sold: 14, paused: true }), s33, 0)];
  const thin = cand(setOf("S20", items(20, "a")), 4);
  const free = cand(setOf("S10", items(10, "b"), { price: 0 }), 50, 0);
  const ok = cand(setOf("S4", items(4, "c")), 5);
  assert.deepEqual(brief(eg.planGame(rows(), [thin, free, ok], { rescue: true, floor: 1 })), ["rescue G33 -> S4 $2"]);
  assert.deepEqual(brief(eg.planGame(rows(), [thin, free, ok], { rescue: true, floor: 1, minStock: 2 })), ["rescue G33 -> S20 $2"]);
});

test("only the best seller moves up, and only to a bigger bundle that holds everything it sells", () => {
  const s22 = setOf("S22", items(22), { price: 2.11 });
  const s14 = setOf("S14", items(14), { price: 1.95 });
  const s34 = setOf("S34", items(34), { price: 2.49 });
  const other = setOf("SX", items(40, "x"), { price: 3 }); // bigger, but another set of items
  // G22 has 10 accounts behind it now.
  const rows = (stock = 10) => [fact(listing("G22", "S22", { sold: 3, price: 2.11 }), s22, stock), fact(listing("G14", "S14", { sold: 2, price: 1.95 }), s14), fact(listing("G34", "S34", { price: 2.49 }), s34)];
  const plan = eg.planGame(rows(), [cand(other, 30), cand(s34, 18), cand(s22, 10), cand(s14, 4)], { upgrade: true, floor: 1 });
  assert.deepEqual(brief(plan), ["upgrade G22 -> S34 $2.11 (takes over G34)"], "more items, at the price it had");
  // never onto a thinner shelf, and not when its own stock is unknown
  assert.deepEqual(brief(eg.planGame(rows(), [cand(s34, 9)], { upgrade: true, floor: 1 })), []);
  assert.deepEqual(brief(eg.planGame(rows(null), [cand(s34, 18)], { upgrade: true, floor: 1 })), []);
  // nothing bigger that contains it: left as it is
  assert.deepEqual(brief(eg.planGame(rows(), [cand(other, 30), cand(s22, 10)], { upgrade: true, floor: 1 })), []);
  // off sale, or with an order mid hand-over: not this step's
  const paused = rows();
  paused[0] = fact(listing("G22", "S22", { sold: 3, paused: true }), s22, 5);
  assert.deepEqual(brief(eg.planGame(paused, [cand(s34, 18)], { upgrade: true, floor: 1 })), []);
  const mid = rows();
  mid[0] = fact(listing("G22", "S22", { sold: 3, mid: true }), s22, 10);
  assert.deepEqual(brief(eg.planGame(mid, [cand(s34, 18)], { upgrade: true, floor: 1 })), []);
});

test("the full plan for a game with selling offers: they stay, the biggest bundle stays, the rest come down", () => {
  // Halo on 2026-10-13: two offers with sales, 24 without.
  const s = Object.fromEntries([34, 33, 22, 21, 14, 10, 1].map((n) => ["S" + n, setOf("S" + n, n === 21 ? items(21, "z") : items(n), { price: 1 + n / 20 })]));
  const rows = [
    fact(listing("G22", "S22", { sold: 3 }), s.S22, 10),
    fact(listing("G14", "S14", { sold: 2 }), s.S14),
    fact(listing("G34", "S34", { price: 2.7 }), s.S34),
    fact(listing("G33", "S33"), s.S33),
    fact(listing("G21", "S21"), s.S21),
    fact(listing("G10", "S10"), s.S10),
    fact(listing("G1p", "S1", { paused: true }), s.S1),
    fact(listing("G1u", "S1", { shape: "units", free: 1 }), s.S1),
  ];
  const cands = [cand(s.S34, 18), cand(s.S33, 16), cand(s.S22, 10), cand(s.S21, 24), cand(s.S14, 4), cand(s.S10, 44)];
  // without the upgrade step: 34 is kept as the biggest bundle
  const plain = eg.planGame(rows, cands, { rescue: true, keepBest: true, retire: true, floor: 1 });
  assert.deepEqual(brief(plain), ["retire G33", "retire G21", "retire G10", "retire G1p"]);
  assert.match(plain.notes.find((n) => n.offerId === "G34").why, /kept: the biggest bundle we can deliver \(34 items\)/);
  // with it: the best seller becomes the 34, whose own offer comes down with the rest
  const full = eg.planGame(rows, cands, { ...ALL, floor: 1 });
  assert.deepEqual(brief(full), ["upgrade G22 -> S34 $2 (takes over G34)", "retire G33", "retire G21", "retire G10", "retire G1p"]);
  // the reserved share is nobody's to retire here
  assert.equal(full.actions.some((a) => a.offerId === "G1u"), false);
});

test("a game where nothing ever sold keeps its one biggest deliverable bundle", () => {
  const s15 = setOf("S15", items(15));
  const s10 = setOf("S10", items(10, "a"));
  const s1 = setOf("S1", items(1, "b"));
  const s20 = setOf("S20", items(20, "c")); // bigger, but only two accounts hold it
  const rows = [fact(listing("G10", "S10"), s10), fact(listing("G15", "S15"), s15), fact(listing("G1", "S1", { paused: true }), s1), fact(listing("G20", "S20"), s20)];
  const plan = eg.planGame(rows, [cand(s10, 43), cand(s15, 10), cand(s1, 87), cand(s20, 2)], { ...ALL, floor: 1 });
  assert.deepEqual(brief(plan), ["retire G10", "retire G1", "retire G20"]);
  assert.deepEqual(plan.actions.map((a) => a.why), ["never sold", "never sold, and nothing left to deliver", "never sold"]);
});

test("a game is never left with nothing because its biggest bundle has no offer yet", () => {
  // Albion on 2026-10-13: three one-item offers, and a four-item bundle that
  // was never listed. Without publishing, the best offer there IS stays.
  const s4 = setOf("S4", items(4, "c"));
  const a = setOf("SA", items(1, "a"));
  const b = setOf("SB", items(1, "b"));
  const rows = [fact(listing("GA", "SA"), a), fact(listing("GB", "SB"), b)];
  const cands = [cand(s4, 8), cand(a, 223), cand(b, 9)];
  const plan = eg.planGame(rows, cands, { ...ALL, floor: 1 });
  assert.deepEqual(brief(plan), ["retire GB"]);
  assert.match(plan.notes[0].why, /the biggest bundle we can deliver \(4 items, 8 accounts\) has no offer/);
  assert.match(plan.notes.find((n) => n.offerId === "GA").why, /kept: the biggest bundle we can deliver \(1 items\)/);
  // told to publish, the bigger bundle gets its offer and both small ones come down
  assert.deepEqual(brief(eg.planGame(rows, cands, { ...ALL, publish: true, floor: 1 })), ["publish S4 $2", "retire GA", "retire GB"]);
});

test("when a kept offer already carries a bundle that big, no never-sold offer is kept", () => {
  const s35 = setOf("S35", items(35));
  const s14 = setOf("S14", items(14, "a"));
  const s11 = setOf("S11", items(11, "b"));
  const rows = [fact(listing("G35", "S35", { sold: 1 }), s35), fact(listing("G14", "S14", { sold: 6 }), s14), fact(listing("G11", "S11"), s11), fact(listing("G14b", "S14"), s14)];
  const plan = eg.planGame(rows, [cand(s35, 3), cand(s14, 64), cand(s11, 57)], { ...ALL, floor: 1 });
  assert.deepEqual(brief(plan), ["retire G11", "retire G14b"]);
  assert.deepEqual(plan.actions.map((a) => a.why), ["never sold", "another offer already sells this bundle"]);
});

test("an offer with an order mid hand-over is never retired, and steps not asked for are not run", () => {
  const s3 = setOf("S3", items(3));
  const s2 = setOf("S2", items(2, "a"));
  const rows = [fact(listing("G3", "S3"), s3), fact(listing("G2", "S2", { mid: true }), s2)];
  const plan = eg.planGame(rows, [cand(s3, 9), cand(s2, 9)], { ...ALL, floor: 1 });
  assert.deepEqual(brief(plan), []);
  assert.match(plan.notes.find((n) => n.offerId === "G2").why, /mid hand-over/);
  assert.deepEqual(brief(eg.planGame(rows, [cand(s3, 9), cand(s2, 9)], { rescue: true, floor: 1 })), []);
  assert.deepEqual(brief(eg.planGame(rows, [cand(s3, 9), cand(s2, 9)], {})), []);
});

test("a game with no offer at all gets its biggest bundle only when publishing is asked for", () => {
  const s36 = setOf("S36", items(36, "r", "Rust"), { price: 1.42, name: "Rust Drops — Complete Bundle" });
  const s31 = setOf("S31", items(31, "r", "Rust"), { price: 1.37 });
  const cands = [cand(s31, 36), cand(s36, 22)];
  const quiet = eg.planGame([], cands, { ...ALL, floor: 1 });
  assert.deepEqual(brief(quiet), []);
  assert.match(quiet.notes[0].why, /the biggest bundle we can deliver \(36 items, 22 accounts\) has no offer/);
  assert.deepEqual(brief(eg.planGame([], cands, { ...ALL, publish: true, floor: 1 })), ["publish S36 $1.42"]);
  // the operator's price, and never under the market's floor
  assert.deepEqual(brief(eg.planGame([], cands, { publish: true, floor: 1, publishPrice: 1 })), ["publish S36 $1"]);
  assert.deepEqual(brief(eg.planGame([], cands, { publish: true, floor: 1, publishPrice: 0.5 })), ["publish S36 $1"]);
  // a bundle that big is on the shelf already: nothing to publish
  const has = [fact(listing("G36", "S36", { shape: "units", free: 4 }), s36)];
  assert.deepEqual(brief(eg.planGame(has, cands, { publish: true, floor: 1 })), []);
});

/* ------------------------------ a fake world ----------------------------- */

// rows / sets by id, the stock each set can deliver, and G2G's own view of each
// offer ({ status, title, price, qty }). `hooks` break one call at a time.
function world({ rows = [], sets = [], stock = {}, af = {}, paid = [], hooks = {} } = {}) {
  const calls = [];
  const g2g = new Map(rows.map((r) => [r.externalId, { status: r.status === "active" && !r.autoPaused ? "live" : "delisted", title: r.title, description: r.description, price: r.price, qty: 5 }]));
  const byId = (id) => rows.find((r) => String(r._id) === String(id));
  const match = (r, q) =>
    Object.entries(q).every(([k, v]) => (v && typeof v === "object" && v.$in ? v.$in.map(String).includes(String(r[k])) : String(r[k] ?? "") === String(v ?? "")));
  const lean = (v) => ({ lean: async () => (v == null ? v : JSON.parse(JSON.stringify(v))) });
  const MarketplaceListing = {
    find: (q) => lean(rows.filter((r) => match(r, q))),
    findOne: (q) => lean(rows.find((r) => match(r, q)) || null),
    findById: (id) => lean(byId(id) || null),
    updateOne: async (q, u) => {
      if (hooks.updateOne) {
        const forced = await hooks.updateOne(q, u, rows);
        if (forced) return forced;
      }
      const r = rows.find((x) => match(x, q));
      if (!r) return { modifiedCount: 0 };
      Object.assign(r, u.$set || {});
      calls.push("row " + r.externalId + " " + JSON.stringify(Object.fromEntries(Object.entries(u.$set || {}).filter(([k]) => ["set", "status", "autoPaused", "price", "qtyTarget"].includes(k)))));
      return { modifiedCount: 1 };
    },
    create: async (doc) => {
      if (hooks.create) await hooks.create(doc);
      rows.push({ _id: "row" + ++seq, units: [], autoPaused: false, ...doc });
      calls.push("row created " + doc.externalId);
    },
  };
  const DropSet = {
    find: (q) => lean(q._id ? sets.filter((s) => q._id.$in.map(String).includes(String(s._id))) : sets),
    findById: (id) => lean(sets.find((s) => String(s._id) === String(id)) || null),
  };
  const notFound = () => Object.assign(new Error("G2G get offer failed (HTTP 404): Data was not found"), { status: 404 });
  const mp = {
    G2G_STATUS: { LIVE: "live", DELISTED: "delisted" },
    G2G_ITEMS_SERVICE: "svc",
    G2G_MIN_PRICE: 1,
    g2gGetOffer: async (id) => {
      const o = g2g.get(id);
      if (!o || o.status !== "live") throw notFound();
      return { status: "live", title: o.title, description: o.description, unit_price: o.price, actual_qty: o.qty };
    },
    g2gListOffers: async ({ status } = {}) =>
      [...g2g.entries()].filter(([, o]) => o.status === (status || "live")).map(([offerId, o]) => ({ offerId, title: o.title, unitPrice: o.price, status: o.status })),
    g2gUpdateOffer: async (id, f) => {
      calls.push("update " + id + " " + JSON.stringify(f));
      if (hooks.update) await hooks.update(id, f, g2g);
      const o = g2g.get(id);
      if (hooks.dropUpdate && hooks.dropUpdate(id, f)) return;
      if (f.title != null) o.title = f.title;
      if (f.description != null) o.description = f.description;
      if (f.unitPrice != null) o.price = f.unitPrice;
    },
    g2gSetQuantity: async (id, n) => {
      if (hooks.setQuantity) await hooks.setQuantity(id, n);
      calls.push("quantity " + id + " " + n);
      g2g.get(id).qty = n;
    },
    g2gDelist: async (id) => {
      calls.push("delist " + id);
      if (!(hooks.stayLive && hooks.stayLive(id))) g2g.get(id).status = "delisted";
    },
    g2gRelist: async (id) => {
      if (hooks.relist) await hooks.relist(id);
      calls.push("relist " + id);
      g2g.get(id).status = "live";
      if (hooks.afterRelist) hooks.afterRelist(id, g2g);
    },
    g2gPendingOrders: async () => {
      if (hooks.pending) return hooks.pending();
      return paid.map((offerId) => ({ offerId }));
    },
    g2gPublish: async (o) => {
      const id = "GNEW" + (g2g.size + 1);
      g2g.set(id, { status: "live", title: o.title, description: o.description, price: o.priceUsd, qty: o.qty });
      calls.push("publish " + id + " $" + o.priceUsd + " x" + o.qty + " " + o.brandId);
      return { externalId: id, url: "https://g2g/" + id };
    },
  };
  const counted = [];
  const d = {
    settings: { getAutoFarm: () => ({ g2gEvergreen: true, g2gAutoDeliver: true, g2gDeliverDryRun: false, g2gSyncStock: true, ...af }) },
    MarketplaceListing,
    DropSet,
    mp,
    floor: 1,
    brandForGame: (game) => (game ? { brandId: "brand:" + String(game).toLowerCase() } : null),
    stockForSets: async (list) => new Map(list.map((s) => [String(s._id), { stock: stock[String(s._id)] || 0 }])),
    availableAccountsForSet: async (set) => {
      counted.push(String(set._id));
      return Array.from({ length: stock[String(set._id)] || 0 }, (_, k) => ({ login: "acc" + k }));
    },
    listedLogins: async () => new Set(),
    notListed: (avail, listed) => avail.filter((a) => !listed.has(a.login)),
    realStockFor: async (row) => (row.autoClaimSet && row.set ? stock[String(row.set)] || 0 : null),
    text: (set, game) => ({ title: game + " Twitch Drops (" + set.items.length + " Items)", description: "house copy for " + set._id }),
    logEvent: (f) => {
      d.events.push(f);
      return Promise.resolve();
    },
    sendTelegram: async (t) => {
      d.telegrams.push(t);
    },
    sleep: async (ms) => {
      d.slept.push(ms);
    },
    events: [],
    telegrams: [],
    slept: [],
  };
  return { d, rows, sets, g2g, calls, counted, row: (offerId) => rows.find((r) => r.externalId === offerId) };
}
const B = "Brawlhalla";
const bItems = (n, p) => items(n, p, B);
// The Brawlhalla shelf of 2026-10-13, in small: a sold-out offer with 14
// sales, and a never-sold offer of a 5-item bundle 16 accounts can deliver.
function brawlhalla(extra = {}) {
  const s33 = setOf("S33", bItems(33, "x"), { price: 2.33 });
  const s5 = setOf("S5", bItems(5, "m"), { price: 1.25 });
  const rows = [
    listing("G33", "S33", { sold: 14, paused: true, price: 2.33, title: "Brawlhalla Twitch Drops (33 Items)" }),
    listing("G5", "S5", { price: 1, title: "Brawlhalla Twitch Drops (5 Items) — Artemis" }),
  ];
  return world({ rows, sets: [s33, s5], stock: { S33: 0, S5: 16 }, ...extra });
}
const rescue = (over = {}) => ({ type: "rewrite", kind: "rescue", offerId: "G33", rowId: "", fromSet: "S33", fromTitle: "Brawlhalla Twitch Drops (33 Items)", fromPrice: 2.33, toSet: "S5", title: "", description: "", price: 1.25, size: 5, stock: 16, absorb: "", ...over });

/* ------------------------------ the rewrite ------------------------------ */

test("a rescue rewrites the offer while it is off sale, reads it back, moves the row, and only then relists", async () => {
  const w = brawlhalla();
  const r = await eg.rewriteOffer(w.d, rescue(), w.sets[1], { paid: new Set(), listed: new Set(), now: NOW });
  assert.deepEqual(w.calls, [
    'update G33 {"title":"Brawlhalla Twitch Drops (5 Items)","description":"house copy for S5","unitPrice":1.25}',
    'row G33 {"set":"S5","price":1.25,"autoPaused":true}',
    "quantity G33 16",
    "relist G33",
    'row G33 {"autoPaused":false,"qtyTarget":16}',
  ]);
  assert.deepEqual([r.rewritten, r.relisted, r.stock, r.price, r.title], [true, true, 16, 1.25, "Brawlhalla Twitch Drops (5 Items)"]);
  const row = w.row("G33");
  assert.deepEqual([row.set, row.title, row.price, row.autoPaused, row.status], ["S5", "Brawlhalla Twitch Drops (5 Items)", 1.25, false, "active"]);
  assert.equal(row.units.length, 14, "the receipts of its 14 sales stay on the row");
  assert.match(row.note, /evergreen 2026-10-13 06:00Z: rescue from set S33 \(\$2\.33\)/);
  assert.deepEqual(w.g2g.get("G33"), { status: "live", title: "Brawlhalla Twitch Drops (5 Items)", description: "house copy for S5", price: 1.25, qty: 16 });
});

test("a rescue touches nothing when the offer is not what the plan saw", async () => {
  const go = async (change, ctx = {}) => {
    const w = brawlhalla();
    change(w);
    const r = await eg.rewriteOffer(w.d, rescue(), w.sets[1], { paid: new Set(), listed: new Set(), now: NOW, ...ctx });
    assert.deepEqual(w.calls, [], "no write for: " + (r.skipped || r.error));
    return r.skipped || r.error;
  };
  assert.match(await go((w) => (w.g2g.get("G33").status = "live")), /G2G shows it live — left for the stock sync/);
  assert.match(await go(() => {}, { paid: new Set(["G33"]) }), /a paid order is waiting/);
  assert.match(await go((w) => w.row("G33").units.push(midUnit())), /mid hand-over/);
  assert.match(await go((w) => (w.row("G33").set = "S9")), /moved to another set since the plan/);
  assert.match(await go((w) => (w.row("G33").autoPaused = false)), /back on sale since the plan/);
  assert.match(await go((w) => (w.row("G33").status = "delisted")), /row is delisted/);
  assert.match(await go((w) => (w.row("G33").origin = "manual")), /not an offer this file may rewrite/);
  assert.match(await go((w) => Object.assign(w.row("G33"), { autoClaimSet: false, noclaimStock: true })), /may rewrite \(noclaim\)/);
});

test("an offer that is on sale is taken down before a word of it changes", async () => {
  const s22 = setOf("S22", items(22), { price: 2.11 });
  const s34 = setOf("S34", items(34), { price: 2.49 });
  const w = world({ rows: [listing("G22", "S22", { sold: 3, price: 2.11 })], sets: [s22, s34], stock: { S22: 10, S34: 18 } });
  const action = { type: "rewrite", kind: "upgrade", offerId: "G22", fromSet: "S22", toSet: "S34", title: "", description: "", price: 2.49, size: 34, stock: 18 };
  const r = await eg.rewriteOffer(w.d, action, s34, { paid: new Set(), listed: new Set(), now: NOW });
  assert.deepEqual(w.calls.slice(0, 2), ["delist G22", 'update G22 {"title":"Halo Infinite Twitch Drops (34 Items)","description":"house copy for S34","unitPrice":2.49}']);
  assert.deepEqual([r.rewritten, r.relisted, r.stock], [true, true, 18]);
  assert.deepEqual([w.row("G22").set, w.g2g.get("G22").status], ["S34", "live"]);
  assert.match(w.row("G22").note, /evergreen .*: upgrade from set S22/);
  // G2G keeps showing it live: nothing is rewritten
  const w2 = world({ rows: [listing("G22", "S22", { sold: 3 })], sets: [s22, s34], stock: { S34: 18 }, hooks: { stayLive: () => true } });
  const r2 = await eg.rewriteOffer(w2.d, action, s34, { paid: new Set(), listed: new Set() });
  assert.match(r2.error, /could not take it off sale first/);
  assert.deepEqual(w2.calls, ["delist G22"]);
  assert.equal(w2.row("G22").set, "S22");
});

test("a rewrite G2G refuses leaves the offer off sale on its old bundle, old text confirmed", async () => {
  let first = true;
  const w = brawlhalla({
    hooks: {
      update: () => {
        if (first) {
          first = false;
          throw new Error("G2G update offer failed (HTTP 400): bad title");
        }
      },
    },
  });
  const r = await eg.rewriteOffer(w.d, rescue(), w.sets[1], { paid: new Set(), listed: new Set() });
  assert.match(r.error, /G2G refused the rewrite \(G2G update offer failed \(HTTP 400\): bad title\) — the old text was put back/);
  const row = w.row("G33");
  assert.deepEqual([row.set, row.status, row.autoPaused, w.g2g.get("G33").status, w.g2g.get("G33").title], ["S33", "active", true, "delisted", "Brawlhalla Twitch Drops (33 Items)"]);
  assert.equal(w.calls.some((c) => c.startsWith("relist") || c.startsWith("quantity")), false);
});

test("a rewrite that does not show on G2G is undone; when even that cannot be confirmed the row is closed", async () => {
  // G2G answers 200 and keeps the old text (it does that to fields it does not take).
  const w = brawlhalla({ hooks: { dropUpdate: () => true } });
  const r = await eg.rewriteOffer(w.d, rescue(), w.sets[1], { paid: new Set(), listed: new Set() });
  assert.match(r.error, /the new title and price did not show on G2G — the old text was put back/);
  assert.deepEqual([w.row("G33").set, w.row("G33").status], ["S33", "active"]);
  assert.equal(w.d.slept.length, 5, "it asked G2G six times before giving up");
  // The new text landed half-way and the old one cannot be put back: nothing may relist it.
  let n = 0;
  const w2 = brawlhalla({
    hooks: {
      update: (id, f, g2g) => {
        if (++n === 1) g2g.get(id).title = f.title; // the title took, the price did not
        else throw new Error("G2G update offer failed (HTTP 500)");
      },
      dropUpdate: () => true,
    },
  });
  const r2 = await eg.rewriteOffer(w2.d, rescue(), w2.sets[1], { paid: new Set(), listed: new Set() });
  assert.match(r2.error, /could NOT be confirmed back: the row is closed/);
  assert.deepEqual([w2.row("G33").status, w2.row("G33").set, w2.g2g.get("G33").status], ["delisted", "S33", "delisted"]);
  assert.match(w2.row("G33").lastError, /check the offer's text on G2G before relisting/);
});

test("a row that changed under the rewrite is not moved, and the offer gets its old text back", async () => {
  const w = brawlhalla({
    hooks: {
      updateOne: (q) => (q.set === "S33" && !("autoPaused" in q) ? { modifiedCount: 0 } : null),
    },
  });
  const r = await eg.rewriteOffer(w.d, rescue(), w.sets[1], { paid: new Set(), listed: new Set() });
  assert.match(r.error, /the row changed while rewriting — the old text was put back/);
  assert.deepEqual([w.row("G33").set, w.g2g.get("G33").title, w.g2g.get("G33").price, w.g2g.get("G33").status], ["S33", "Brawlhalla Twitch Drops (33 Items)", 2.33, "delisted"]);
});

test("a relist that fails leaves text, price and row in step for the stock sync to finish", async () => {
  const w = brawlhalla({
    hooks: {
      relist: () => {
        throw new Error("G2G update offer failed (HTTP 502)");
      },
    },
  });
  const r = await eg.rewriteOffer(w.d, rescue(), w.sets[1], { paid: new Set(), listed: new Set() });
  assert.deepEqual([r.rewritten, r.relisted], [true, false]);
  assert.match(r.note, /the relist failed .* the stock sync brings it back/);
  const row = w.row("G33");
  assert.deepEqual([row.set, row.autoPaused, row.status, w.g2g.get("G33").status, w.g2g.get("G33").title], ["S5", true, "active", "delisted", "Brawlhalla Twitch Drops (5 Items)"]);
  // and a bundle nobody can deliver at this second is not put on sale at all
  const w2 = brawlhalla();
  w2.d.realStockFor = async () => 0;
  const r2 = await eg.rewriteOffer(w2.d, rescue(), w2.sets[1], { paid: new Set(), listed: new Set() });
  assert.deepEqual([r2.rewritten, r2.relisted, w2.g2g.get("G33").status, w2.row("G33").autoPaused], [true, false, "delisted", true]);
});

test("a live offer that does not show the new text after the relist comes down and is closed", async () => {
  const w = brawlhalla({ hooks: { afterRelist: (id, g2g) => (g2g.get(id).title = "Brawlhalla Twitch Drops (33 Items)") } });
  const r = await eg.rewriteOffer(w.d, rescue(), w.sets[1], { paid: new Set(), listed: new Set() });
  assert.match(r.error, /the live title is not the new one after the relist — taken off sale and closed/);
  assert.deepEqual([w.g2g.get("G33").status, w.row("G33").status], ["delisted", "delisted"]);
});

test("the text of an offer that is taken over is used word for word", async () => {
  const w = brawlhalla();
  const a = rescue({ title: "Brawlhalla Twitch Drops (5 Items) — Artemis", description: "description of G5", price: 1 });
  await eg.rewriteOffer(w.d, a, w.sets[1], { paid: new Set(), listed: new Set() });
  assert.equal(w.calls[0], 'update G33 {"title":"Brawlhalla Twitch Drops (5 Items) — Artemis","description":"description of G5","unitPrice":1}');
  // a price under the market's floor, or none, is refused before anything is sent
  for (const price of [0.5, 0]) {
    const w2 = brawlhalla();
    const r = await eg.rewriteOffer(w2.d, rescue({ price }), w2.sets[1], { paid: new Set(), listed: new Set() });
    assert.match(r.error, /no usable price/);
    assert.deepEqual(w2.calls, []);
  }
});

/* ---------------------------- retire / publish --------------------------- */

test("a never-sold offer is delisted, read back, and only then is its row closed", async () => {
  const w = brawlhalla();
  const r = await eg.retireOffer(w.d, "G5", "never sold", { paid: new Set(), now: NOW });
  assert.deepEqual(r, { retired: true });
  assert.deepEqual(w.calls, ["delist G5", 'row G5 {"status":"delisted","autoPaused":false}']);
  assert.match(w.row("G5").note, / — retired 2026-10-13: never sold$/);
  // G2G still shows it on sale: the row stays active, so the stock sync keeps watching it
  const w2 = brawlhalla({ hooks: { stayLive: () => true } });
  const r2 = await eg.retireOffer(w2.d, "G5", "never sold", { paid: new Set() });
  assert.match(r2.error, /G2G still shows it "live" after the delist/);
  assert.equal(w2.row("G5").status, "active");
});

test("what must not be retired is refused before G2G is asked anything", async () => {
  const go = async (offerId, change, ctx = {}) => {
    const w = brawlhalla();
    change(w);
    const r = await eg.retireOffer(w.d, offerId, "never sold", { paid: new Set(), ...ctx });
    assert.deepEqual(w.calls, []);
    return r.skipped || r.error;
  };
  assert.match(await go("G33", () => {}), /it has sold 14 — kept/);
  assert.match(await go("G5", (w) => Object.assign(w.row("G5"), { autoClaimSet: false, units: [freeUnit(1)] })), /may retire \(units\)/);
  assert.match(await go("G5", (w) => (w.row("G5").origin = "manual")), /may retire/);
  assert.match(await go("G5", (w) => w.row("G5").units.push(midUnit())), /mid hand-over/);
  assert.match(await go("G5", () => {}, { paid: new Set(["G5"]) }), /paid order/);
  assert.match(await go("G5", (w) => (w.row("G5").status = "delisted")), /already delisted/);
  assert.match(await go("GX", () => {}), /no listing row/);
});

test("a published bundle gets the row that lets it be stock-checked and delivered", async () => {
  const s36 = setOf("S36", items(36, "r", "Rust"), { price: 1.42 });
  const w = world({ sets: [s36], stock: { S36: 22 } });
  const r = await eg.publishOffer(w.d, { type: "publish", toSet: "S36", price: 1 }, s36, { listed: new Set() });
  assert.deepEqual([r.published, r.price, r.stock, r.title], [true, 1, 22, "Rust Twitch Drops (36 Items)"]);
  assert.deepEqual(w.calls, ["publish GNEW1 $1 x22 brand:rust", "row created GNEW1"]);
  const row = w.row("GNEW1");
  assert.deepEqual([row.set, row.autoClaimSet, row.origin, row.status, row.price, row.qtyTarget, row.marketplace], ["S36", true, "auto", "active", 1, 22, "g2g"]);
  // too few accounts by the time it is counted: nothing is published
  const thin = world({ sets: [s36], stock: { S36: 2 } });
  assert.match((await eg.publishOffer(thin.d, { price: 1 }, s36, { listed: new Set() })).skipped, /only 2 account\(s\)/);
  assert.deepEqual(thin.calls, []);
  // a row that cannot be saved: the offer comes straight down
  const bad = world({ sets: [s36], stock: { S36: 22 }, hooks: { create: () => { throw new Error("E11000"); } } });
  const rb = await eg.publishOffer(bad.d, { price: 1 }, s36, { listed: new Set() });
  assert.match(rb.error, /published as GNEW1 but its row could not be saved \(E11000\) — taken off sale/);
  assert.equal(bad.g2g.get("GNEW1").status, "delisted");
});

test("the offer a rewrite takes over comes down only once the rewritten one is selling", async () => {
  const w = brawlhalla();
  const a = rescue({ title: "Brawlhalla Twitch Drops (5 Items) — Artemis", description: "description of G5", price: 1, absorb: "G5" });
  const lines = [];
  const out = await eg.runActions(w.d, [a], new Map([["S5", w.sets[1]]]), { paid: new Set(), listed: new Set(), now: NOW }, { log: (l) => lines.push(l) });
  assert.deepEqual([out.rewritten.length, out.retired.map((r) => r.offerId), out.errors.length], [1, ["G5"], 0]);
  assert.deepEqual([w.g2g.get("G33").status, w.g2g.get("G5").status, w.row("G5").status], ["live", "delisted", "delisted"]);
  assert.ok(w.calls.indexOf("relist G33") < w.calls.indexOf("delist G5"));
  assert.match(lines[0], /^rewrote G33 \(rescue\): Brawlhalla Twitch Drops \(33 Items\) \$2\.33 -> Brawlhalla Twitch Drops \(5 Items\) — Artemis \$1, on sale x16$/);
  assert.match(w.row("G5").note, /its bundle moved to offer G33/);
  // not relisted: the taken-over offer is the bundle's only one, and stays
  const w2 = brawlhalla({ hooks: { relist: () => { throw new Error("502"); } } });
  const out2 = await eg.runActions(w2.d, [a], new Map([["S5", w2.sets[1]]]), { paid: new Set(), listed: new Set() });
  assert.deepEqual([out2.rewritten.length, out2.retired.length, w2.g2g.get("G5").status], [1, 0, "live"]);
  assert.match(out2.skipped[0].why, /left on sale until G33 is back/);
});

/* ----------------------------- the server pass --------------------------- */

test("the pass is off until switched on, and off while G2G orders are not really delivered", async () => {
  const off = async (af) => {
    const w = brawlhalla({ af });
    const out = await eg.evergreenPass({ deps: w.d, now: NOW });
    assert.deepEqual(w.calls, []);
    return out.skipped;
  };
  assert.match(await off({ g2gEvergreen: false }), /switched off \(autoFarm\.g2gEvergreen\)/);
  assert.match(await off({ g2gEvergreen: undefined }), /switched off/);
  assert.match(await off({ g2gDeliverDryRun: true }), /delivery or its stock sync is not live/);
  assert.match(await off({ g2gAutoDeliver: false }), /not live/);
  assert.match(await off({ g2gSyncStock: false }), /not live/);
});

test("the pass brings a sold-out offer back on the bundle we can deliver, and says so once", async () => {
  eg._state.rested.clear();
  const w = brawlhalla();
  const out = await eg.evergreenPass({ deps: w.d, now: NOW });
  assert.deepEqual(w.calls, [
    'update G33 {"title":"Brawlhalla Twitch Drops (5 Items) — Artemis","description":"description of G5","unitPrice":1}',
    'row G33 {"set":"S5","price":1,"autoPaused":true}',
    "quantity G33 16",
    "relist G33",
    'row G33 {"autoPaused":false,"qtyTarget":16}',
    "delist G5",
    'row G5 {"status":"delisted","autoPaused":false}',
  ]);
  assert.deepEqual([out.rewritten.length, out.retired.length, out.errors.length], [1, 1, 0]);
  assert.equal(out.log.length, 2);
  assert.equal(w.d.telegrams.length, 1);
  assert.match(w.d.telegrams[0], /G2G offer back on sale with another bundle[\s\S]*Brawlhalla Twitch Drops \(5 Items\) — Artemis\n\$1 · 16 in stock · offer G33\n\(was: Brawlhalla Twitch Drops \(33 Items\) — sold out\)/);
  assert.deepEqual([w.d.events[0].action, w.d.events[0].meta.fromSet, w.d.events[0].meta.toSet, w.d.events[0].meta.absorbed], ["g2g_offer_rewritten", "S33", "S5", "G5"]);
  // the next pass finds a selling offer and does nothing
  w.calls.length = 0;
  const again = await eg.evergreenPass({ deps: w.d, now: NOW + 15 * 60 * 1000 });
  assert.deepEqual([w.calls, again.rewritten.length, again.log], [[], 0, []]);
});

test("a game with nothing to move to is counted once, then left alone for six hours", async () => {
  eg._state.rested.clear();
  eg._state.lastSummary = "";
  const s33 = setOf("S33", bItems(33, "x"));
  const s2 = setOf("S2", bItems(2, "m"));
  const w = world({ rows: [listing("G33", "S33", { sold: 14, paused: true })], sets: [s33, s2], stock: { S33: 0, S2: 2 } });
  const first = await eg.evergreenPass({ deps: w.d, now: NOW });
  assert.deepEqual(w.calls, []);
  assert.match(first.log[0], /skip Brawlhalla G33: no other bundle of this game has 5\+ accounts/);
  const stockReads = w.d.slept.length;
  let asked = 0;
  w.d.stockForSets = async () => (asked++, new Map());
  const second = await eg.evergreenPass({ deps: w.d, now: NOW + 15 * 60 * 1000 });
  assert.deepEqual([asked, second.log, w.d.slept.length], [0, [], stockReads]);
  await eg.evergreenPass({ deps: w.d, now: NOW + 6 * HOUR + 1 });
  assert.equal(asked, 1);
});

test("a pass rewrites at most two offers, and none when G2G's paid orders cannot be read", async () => {
  eg._state.rested.clear();
  const sets = [setOf("S30", bItems(30, "x")), setOf("S20", bItems(20, "y")), setOf("S10", bItems(10, "z")), setOf("SA", bItems(6, "a")), setOf("SB", bItems(5, "b")), setOf("SC", bItems(4, "c"))];
  const mk = (hooks) =>
    world({
      rows: [listing("G30", "S30", { sold: 9, paused: true }), listing("G20", "S20", { sold: 5, paused: true }), listing("G10", "S10", { sold: 2, paused: true })],
      sets,
      stock: { SA: 9, SB: 9, SC: 9 },
      hooks,
    });
  const w = mk();
  const out = await eg.evergreenPass({ deps: w.d, now: NOW });
  assert.deepEqual(out.rewritten.map((x) => [x.offerId, x.toSet]), [["G30", "SA"], ["G20", "SB"]]);
  assert.equal(w.row("G10").set, "S10");
  eg._state.rested.clear();
  const blind = mk({ pending: () => { throw new Error("G2G orders failed (HTTP 503)"); } });
  const none = await eg.evergreenPass({ deps: blind.d, now: NOW });
  assert.deepEqual(blind.calls, []);
  assert.match(none.errors[0].why, /could not read G2G's paid orders: G2G orders failed \(HTTP 503\)/);
});

test("the pass never moves an offer onto a bundle that a paid order's offer is waiting on, and skips other games' bundles", async () => {
  eg._state.rested.clear();
  // a Halo bundle with plenty of stock is not a Brawlhalla bundle
  const s33 = setOf("S33", bItems(33, "x"));
  const halo = setOf("SH", items(40), { price: 2 });
  const mixed = setOf("SM", [...bItems(8, "q"), ...items(2)]);
  const noclaim = setOf("SN", bItems(10, "n"), { stockSource: "noclaim" });
  const unpriced = setOf("SU", bItems(9, "u"), { price: 0, minPriceUsd: 0 });
  const w = world({ rows: [listing("G33", "S33", { sold: 14, paused: true })], sets: [s33, halo, mixed, noclaim, unpriced], stock: { SH: 50, SM: 50, SN: 50, SU: 50 }, paid: [] });
  const out = await eg.evergreenPass({ deps: w.d, now: NOW });
  assert.deepEqual([w.calls, out.rewritten.length], [[], 0]);
  // a paid order on the offer itself: left for the fulfiller
  eg._state.rested.clear();
  const w2 = brawlhalla({ paid: ["G33"] });
  const out2 = await eg.evergreenPass({ deps: w2.d, now: NOW });
  assert.deepEqual(w2.calls, []);
  assert.match(out2.skipped.find((s) => s.offerId === "G33").why, /a paid order is waiting on this offer/);
});

test("the exact count leaves out accounts that are on a live listing elsewhere", async () => {
  const s33 = setOf("S33", bItems(33, "x"));
  const s9 = setOf("S9", bItems(9, "a"));
  const s5 = setOf("S5", bItems(5, "m"));
  const w = world({ rows: [listing("G33", "S33", { sold: 14, paused: true })], sets: [s33, s9, s5], stock: { S9: 6, S5: 16 } });
  // three of the six accounts that hold the 9-item bundle are listed elsewhere
  const listed = new Set(["acc0", "acc1", "acc2"]);
  const cands = await eg.candidateSets(w.d, B, { labels: [B], onG2g: new Set(), listed, want: 5, minStock: 5 });
  assert.deepEqual(cands.map((c) => [c.setId, c.stock]), [["S5", 13]]);
  assert.deepEqual(w.counted, ["S9", "S5"], "the biggest is counted first");
});

test("a bundle written down as several sets is one bundle: the set most accounts can deliver", async () => {
  // The catalog ties its set to the accounts it was built from; a campaign's
  // set of the same items is open to every holder. Both are the same bundle —
  // and a scoped set is no reason to skip a bundle (the first cut of this did,
  // and planned to retire our biggest offers as "not deliverable").
  const scoped = setOf("SC", bItems(34, "x"), { accountScopeIds: ["a", "b"], createdAt: new Date(NOW - 40 * 24 * HOUR) });
  const open = setOf("SO", bItems(34, "x"), { createdAt: new Date(NOW - 50 * 24 * HOUR) });
  const onlyScoped = setOf("S9", bItems(9, "a"), { accountScopeLogins: ["x"] });
  const w = world({ sets: [scoped, open, onlyScoped], stock: { SC: 18, SO: 25, S9: 7 } });
  const cands = await eg.candidateSets(w.d, B, { labels: [B], onG2g: new Set(["SC"]), listed: new Set(), want: 5, minStock: 5 });
  assert.deepEqual(cands.map((c) => [c.setId, c.stock]), [["SO", 25], ["S9", 7]]);
  // equal stock: the one an offer of ours already carries, then the newest
  const w2 = world({ sets: [scoped, open], stock: { SC: 18, SO: 18 } });
  assert.deepEqual((await eg.candidateSets(w2.d, B, { labels: [B], onG2g: new Set(["SC"]), listed: new Set(), want: 5, minStock: 5 })).map((c) => c.setId), ["SC"]);
  assert.deepEqual((await eg.candidateSets(w2.d, B, { labels: [B], onG2g: new Set(), listed: new Set(), want: 5, minStock: 5 })).map((c) => c.setId), ["SC"]);
});

/* --------------------------------- the tool ------------------------------ */

test("the tool never changes a selling offer or makes a new one unless told to", () => {
  assert.deepEqual(parseArgs([]).steps, { rescue: true, keepBest: true, retire: true, upgrade: false, publish: false });
  assert.deepEqual(parseArgs(["--publish"]).steps, { rescue: true, keepBest: true, retire: true, upgrade: false, publish: true });
  assert.deepEqual(parseArgs(["--upgrade"]).steps.upgrade, true);
  assert.deepEqual(parseArgs(["--only=retire"]).steps, { rescue: false, keepBest: false, retire: true, upgrade: false, publish: false });
  assert.deepEqual(parseArgs(["--only=retire", "--publish", "--upgrade"]).steps, { rescue: false, keepBest: false, retire: true, upgrade: false, publish: false });
  assert.deepEqual(parseArgs(["--only=publish,keep"]).steps, { rescue: false, keepBest: true, retire: false, upgrade: false, publish: true });
  assert.throws(() => parseArgs(["--only=delete"]), /unknown step in --only: delete/);
  const o = parseArgs(["--games=Rust, Halo Infinite", "--price=Rust:1,Hunt: Showdown 1896:1.5", "--apply"]);
  assert.deepEqual([o.apply, o.games, [...o.prices]], [true, ["Rust", "Halo Infinite"], [["rust", 1], ["hunt: showdown 1896", 1.5]]]);
  assert.deepEqual([parseArgs(["--add=Rust,THE FINALS"]).add, parseArgs([]).add, parseArgs(["--add=Rust"]).games], [["Rust", "THE FINALS"], [], []]);
  assert.throws(() => parseArgs(["--price=Rust"]), /--price wants "Game:USD"/);
  assert.equal(parseArgs([]).minStock, undefined, "left out, the engine's own minimum applies");
  assert.equal(parseArgs(["--min-stock=5"]).minStock, 5);
});

test("a plan line names the offer, both bundles and both prices", () => {
  const line = describe({ type: "rewrite", kind: "rescue", offerId: "G33", fromTitle: "Brawlhalla (33 Items)", fromPrice: 2.33, title: "Brawlhalla (5 Items)", price: 1, size: 5, stock: 16, absorb: "G5" });
  assert.match(line, /^RESCUE  G33  Brawlhalla \(33 Items\) \$2\.33\n +-> Brawlhalla \(5 Items\) \$1  \(5 items, 16 accounts\)\n +takes over the bundle of G5, which comes down$/);
  assert.equal(describe({ type: "retire", offerId: "G1", title: "Halo (1 Item)", why: "never sold" }), "RETIRE   G1  Halo (1 Item) — never sold");
  assert.equal(describe({ type: "publish", toSet: "S36", price: 1, size: 36, stock: 22 }, () => "Rust (36 Items)"), "PUBLISH  Rust (36 Items) $1  (36 items, 22 accounts)");
});
