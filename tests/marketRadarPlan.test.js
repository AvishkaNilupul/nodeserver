// The market radar's pure rules (utils/marketData/plan.js), pinned against REAL rows captured
// from the three public markets (tests/fixtures/marketRadar, sellers anonymised) and hand-built
// edge cases. Every rule here is a live-market rule or a mistake this shop already made:
//   - our own rows are never rivals (the scanner once undercut itself);
//   - a counter's first sight is a baseline, a decrease is a reset, a huge jump is a glitch;
//   - absence is not proof of sale: gone needs a COMPLETE page and two misses, Gameflip only;
//   - a sold-feed row for a listing we saw live means it SOLD, and a live row is not sold.
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../utils/marketData/plan");

const marvel = require("./fixtures/marketRadar/marvel-rivals.json");
const rocket = require("./fixtures/marketRadar/rocket-league.json");

const T0 = new Date("2026-10-02T00:00:00.000Z");
const T1 = new Date("2026-10-02T06:00:00.000Z");
const T2 = new Date("2026-10-02T12:00:00.000Z");
const job = (over = {}) => ({
  game: "Marvel Rivals",
  gameKey: "marvel rivals",
  at: T0,
  own: { gameflipOwner: "", ids: { ggsel: new Set(), plati: new Set() }, sellers: { ggsel: new Set(), plati: new Set() } },
  gameflip: { sold: [], active: [], activeComplete: false },
  ggsel: { rows: [] },
  plati: { rows: [] },
  ...over,
});
const gf = (id, price, over = {}) => ({ id, title: "Alpha Twitch Drops (3 Items) — X", price, url: "https://gameflip.com/item/" + id, seller: "s1", sellerName: "", onsale: "2026-09-30T00:00:00Z", created: "2026-09-30T00:00:00Z", updated: "2026-10-01T00:00:00Z", sellerScore: 0.9, sellerRatings: 100, ...over });
const gg = (id, price, sold, over = {}) => ({ id, title: "Alpha Twitch Drops 3 items", price, url: "https://ggsel.net/en/catalog/product/x-" + id, seller: "g1", sellerName: "G", sold, rating: 4.9, ...over });

/* ------------------------------ normalisation (real rows) ------------------------------ */

test("every real row from all three markets normalises: no NaN, a listing id, a USD price, a parsed size", () => {
  let n = 0;
  for (const fx of [marvel, rocket]) {
    const lists = { gameflip: [...fx.gfSold, ...fx.gfActive], ggsel: fx.gg, plati: fx.pl };
    for (const [market, rows] of Object.entries(lists)) {
      for (const r of rows) {
        const nr = P.normRow(market, r);
        assert.ok(nr, market + " row must normalise: " + JSON.stringify(r).slice(0, 80));
        assert.ok(nr.listingId.length > 3, "listing id");
        assert.ok(nr.priceUsd > 0 && Number.isFinite(nr.priceUsd), "price");
        assert.ok(nr.itemCount === null || (nr.itemCount >= 1 && nr.itemCount <= 200), "size is null or sane");
        assert.ok(["drops", "farm"].includes(nr.kind));
        if (market === "gameflip") {
          assert.ok(nr.onsaleAt instanceof Date && nr.updatedAt instanceof Date, "gameflip carries dates");
          assert.strictEqual(nr.counter, null);
          assert.ok(typeof nr.sellerScore === "number", "gameflip seller score");
        } else {
          assert.ok(typeof nr.counter === "number" && nr.counter >= 0, market + " carries a lifetime counter");
          assert.strictEqual(nr.onsaleAt, null);
        }
        n++;
      }
    }
  }
  assert.ok(n >= 90, "a meaningful number of real rows were checked: " + n);
});

test("size parsing on real titles: a 148-item collection is 148, a bare title states no size", () => {
  const big = P.normRow("gameflip", marvel.gfSold[0]);
  assert.strictEqual(big.itemCount, 148);
  assert.strictEqual(P.radarBand(big.itemCount), "100+");
  const none = P.normRow("ggsel", gg("1", 1, 0, { title: "KPDH | Fortnite Twitch Drops" }));
  assert.strictEqual(none.itemCount, null);
});

test("a row with no price or no id is unusable, and a zero counter is a real zero (not 'unknown')", () => {
  assert.strictEqual(P.normRow("gameflip", gf("a", 0)), null);
  assert.strictEqual(P.normRow("gameflip", { ...gf("a", 1), id: "", url: "" }), null);
  assert.strictEqual(P.normRow("ggsel", gg("9", -1, 0)), null);
  assert.strictEqual(P.normRow("ggsel", gg("9", 1.5, 0)).counter, 0);
  assert.strictEqual(P.normRow("ggsel", gg("9", 1.5, undefined, { sold: undefined })).counter, null);
});

test("idOf falls back to the url when a scout row has no id: uuid, slug-id and itm/<id>", () => {
  assert.strictEqual(P.idOf("gameflip", { url: "https://gameflip.com/item/abc-123" }), "abc-123");
  assert.strictEqual(P.idOf("ggsel", { url: "https://ggsel.net/en/catalog/product/marvel-rivals-143-items-5367595" }), "5367595");
  assert.strictEqual(P.idOf("ggsel", { url: "https://ggsel.net/en/catalog/product/103300035" }), "103300035");
  assert.strictEqual(P.idOf("plati", { url: "https://plati.market/itm/4773868" }), "4773868");
  assert.strictEqual(P.idOf("plati", { id: 77, url: "https://plati.market/itm/4773868" }), "77", "an explicit id wins");
  assert.strictEqual(P.idOf("gameflip", null), "");
});

test("radar bands: the tracker's edges up to 30, and the top split so a collection is not a bundle", () => {
  const cases = [[1, "1"], [2, "2-3"], [3, "2-3"], [4, "4-6"], [6, "4-6"], [7, "7-12"], [12, "7-12"], [13, "13-30"], [30, "13-30"], [31, "31-99"], [99, "31-99"], [100, "100+"], [148, "100+"], [0, "?"], [null, "?"], [NaN, "?"], ["x", "?"]];
  for (const [n, b] of cases) assert.strictEqual(P.radarBand(n), b, String(n));
});

/* --------------------------------- whose row is it? --------------------------------- */

test("our rows are recognised on every market and never anywhere else", () => {
  const own = { gameflipOwner: "OWNER", ids: { ggsel: new Set(["500"]), plati: new Set(["700"]) }, sellers: { ggsel: new Set(["OURSELLER"]), plati: new Set() } };
  assert.ok(P.isOwn("gameflip", P.normRow("gameflip", gf("a", 1, { seller: "OWNER" })), own));
  assert.ok(!P.isOwn("gameflip", P.normRow("gameflip", gf("a", 1, { seller: "OTHER" })), own));
  assert.ok(P.isOwn("ggsel", P.normRow("ggsel", gg("500", 1, 0, { seller: "x" })), own), "by our listing id");
  assert.ok(P.isOwn("ggsel", P.normRow("ggsel", gg("501", 1, 0, { seller: "OURSELLER" })), own), "by our learned seller id");
  assert.ok(!P.isOwn("ggsel", P.normRow("ggsel", gg("501", 1, 0, { seller: "RIVAL" })), own));
  assert.ok(P.isOwn("plati", P.normRow("plati", gg("700", 1, 0)), own));
  assert.ok(!P.isOwn("gameflip", P.normRow("gameflip", gf("a", 1)), { gameflipOwner: "" }), "an unknown owner id flags nothing");
  assert.ok(!P.isOwn("ggsel", P.normRow("ggsel", gg("1", 1, 0)), null));
});

test("a seller is learned as ours only from a row whose id is one of our listings", () => {
  const own = { gameflipOwner: "", ids: { ggsel: new Set(["500"]), plati: new Set() }, sellers: { ggsel: new Set(["KNOWN"]), plati: new Set() } };
  const rows = [gg("500", 1, 0, { seller: "NEW" }), gg("501", 1, 0, { seller: "RIVAL" }), gg("500", 1, 0, { seller: "KNOWN" })];
  assert.deepStrictEqual([...P.learnOwnSellers("ggsel", rows, own)], ["NEW"]);
  assert.strictEqual(P.learnOwnSellers("gameflip", rows, own).size, 0);
});

/* ------------------------------------ counters ------------------------------------ */

test("a counter move against the high-water mark: baseline, same, dip, jump, sale — exactly at the edges", () => {
  assert.deepStrictEqual(P.counterMove(null, 5), { kind: "baseline", units: 0 });
  assert.deepStrictEqual(P.counterMove(5, null), { kind: "baseline", units: 0 });
  assert.deepStrictEqual(P.counterMove(5, 5), { kind: "same", units: 0 });
  assert.deepStrictEqual(P.counterMove(5, 4), { kind: "dip", units: 0 });
  assert.deepStrictEqual(P.counterMove(5, 6), { kind: "sale", units: 1 });
  assert.deepStrictEqual(P.counterMove(0, P.MAX_COUNTER_JUMP), { kind: "sale", units: P.MAX_COUNTER_JUMP });
  assert.deepStrictEqual(P.counterMove(0, P.MAX_COUNTER_JUMP + 1), { kind: "jump", units: 0 });
  // the high-water mark is the highest of the stored mark, the last reading, and the last counted sale
  assert.strictEqual(P.highWater({ counter: 7, counterMax: 9, lastSaleCounter: 10 }), 10);
  assert.strictEqual(P.highWater({ counter: 12, counterMax: 9 }), 12);
  assert.strictEqual(P.highWater({ counter: null, counterMax: null }), null);
  assert.strictEqual(P.highWater(null), null);
});

/* ------------------------------ the Gameflip sold feed ------------------------------ */

test("the sold feed becomes dated sales with a time-to-sell (real row: 47.7 hours)", () => {
  const sales = P.planSold(job({ gameflip: { sold: marvel.gfSold, active: [], activeComplete: false } }));
  assert.strictEqual(sales.length, marvel.gfSold.length);
  const first = sales[0];
  assert.strictEqual(first.dedupeKey, "gf:a061b5b3-7436-401b-b041-ffd6f84f0131");
  assert.strictEqual(first.priceUsd, 6);
  assert.strictEqual(first.itemCount, 148);
  assert.strictEqual(first.source, "sold-feed");
  assert.strictEqual(first.ttsHours, 47.7);
  assert.strictEqual(first.soldAt.toISOString(), "2026-09-14T08:38:44.971Z");
  assert.strictEqual(first.units, 1);
  assert.ok(sales.every((s) => s.gameKey === "marvel rivals" && s.market === "gameflip" && s.ours === false));
});

test("a sale already stored is not written again, and a duplicate inside one feed counts once", () => {
  const have = new Set(["gf:a061b5b3-7436-401b-b041-ffd6f84f0131"]);
  const sales = P.planSold(job({ gameflip: { sold: [...marvel.gfSold, marvel.gfSold[1]], active: [], activeComplete: false } }), have);
  assert.strictEqual(sales.length, marvel.gfSold.length - 1);
  assert.ok(!sales.some((s) => have.has(s.dedupeKey)));
  assert.strictEqual(new Set(sales.map((s) => s.dedupeKey)).size, sales.length);
});

test("time-to-sell is null, not wrong, when the dates are missing, reversed or absurd", () => {
  const mk = (over) => P.planSold(job({ gameflip: { sold: [gf("z1", 2, over)], active: [], activeComplete: false } }))[0];
  assert.strictEqual(mk({ onsale: null }).ttsHours, null);
  assert.strictEqual(mk({ updated: null }).ttsHours, null);
  assert.strictEqual(mk({ updated: null }).soldAt.getTime(), T0.getTime(), "no `updated`: the scan time stands in");
  assert.strictEqual(mk({ onsale: "2026-10-05T00:00:00Z", updated: "2026-10-01T00:00:00Z" }).ttsHours, null, "negative");
  assert.strictEqual(mk({ onsale: "2020-01-01T00:00:00Z", updated: "2026-10-01T00:00:00Z" }).ttsHours, null, "older than the plausible window");
  assert.strictEqual(mk({}).ttsHours, 24);
});

test("our own sold listings are kept and flagged, and a rent-farm window is kept but classed as farm", () => {
  const own = { gameflipOwner: "OWNER", ids: { ggsel: new Set(), plati: new Set() }, sellers: { ggsel: new Set(), plati: new Set() } };
  const sales = P.planSold(job({ own, gameflip: { sold: [gf("o1", 1, { seller: "OWNER" }), gf("f1", 5, { title: "Rust Automatic farming 180 days" })], active: [], activeComplete: false } }));
  assert.strictEqual(sales.find((s) => s.listingId === "o1").ours, true);
  assert.strictEqual(sales.find((s) => s.listingId === "f1").kind, "farm");
  assert.strictEqual(sales.find((s) => s.listingId === "f1").ours, false);
});

/* ---------------------------------- rival listings ---------------------------------- */

test("a new rival is inserted once with its first price and counter points", () => {
  const p = P.planRivals("ggsel", job({ ggsel: { rows: [gg("10", 2.5, 7)] } }));
  assert.strictEqual(p.ops.length, 1);
  const op = p.ops[0].updateOne;
  assert.deepStrictEqual(op.filter, { market: "ggsel", listingId: "10" });
  assert.strictEqual(op.upsert, true);
  const d = op.update.$setOnInsert;
  assert.strictEqual(d.priceUsd, 2.5);
  assert.deepStrictEqual(d.priceHistory, [{ at: T0, price: 2.5, native: null }]);
  assert.strictEqual(d.counter, 7);
  assert.strictEqual(d.counterMax, 7, "the first reading is the first high-water mark");
  assert.deepStrictEqual(d.counterHistory, [{ at: T0, n: 7 }]);
  assert.strictEqual(d.currency, "USD", "no rouble price on this row");
  assert.strictEqual(d.goneAt, null);
  assert.strictEqual(p.stats.inserted, 1);
  assert.deepStrictEqual(p.sales, [], "the first sight of a counter records no sale");
});

test("a counter rise is a sale of exactly that many units, keyed so a retry cannot double it", () => {
  const existing = new Map([["10", { listingId: "10", priceUsd: 2.5, counter: 7, lastSeenAt: T0, missed: 0, goneAt: null, outcome: "" }]]);
  const p = P.planRivals("ggsel", job({ at: T1, ggsel: { rows: [gg("10", 2.5, 10)] } }), existing);
  assert.strictEqual(p.sales.length, 1);
  const s = p.sales[0];
  assert.strictEqual(s.dedupeKey, "ggsel:10:10");
  assert.strictEqual(s.units, 3);
  assert.strictEqual(s.source, "counter");
  assert.strictEqual(s.soldAt.getTime(), T1.getTime());
  assert.strictEqual(s.prevObservedAt.getTime(), T0.getTime(), "the window starts at the previous observation");
  assert.strictEqual(s.priceUsd, 2.5);
  assert.strictEqual(p.stats.units, 3);
  const up = p.ops[0].updateOne.update;
  assert.strictEqual(up.$set.counter, 10);
  assert.strictEqual(up.$set.counterMax, 10);
  assert.strictEqual(s.counterAfter, 10, "the sale says which count it brought the listing to");
  assert.deepStrictEqual(up.$push.counterHistory.$each, [{ at: T1, n: 10 }]);
  assert.strictEqual(up.$push.counterHistory.$slice, -P.COUNTER_HISTORY_MAX);
  assert.strictEqual(up.$push.priceHistory, undefined, "price did not move");
});

test("same counter: nothing recorded; a dip: shown, but the high-water mark stays; a jump: ignored and re-baselined", () => {
  const ex = (counter, counterMax = counter) => new Map([["10", { listingId: "10", priceUsd: 2.5, counter, counterMax, lastSeenAt: T0, missed: 0, goneAt: null }]]);
  const same = P.planRivals("plati", job({ at: T1, plati: { rows: [gg("10", 2.5, 7)] } }), ex(7));
  assert.deepStrictEqual(same.sales, []);
  assert.strictEqual(same.ops[0].updateOne.update.$push, undefined);
  const dip = P.planRivals("plati", job({ at: T1, plati: { rows: [gg("10", 2.5, 3)] } }), ex(7));
  assert.deepStrictEqual(dip.sales, []);
  assert.strictEqual(dip.stats.dips, 1);
  assert.strictEqual(dip.ops[0].updateOne.update.$set.counter, 3, "the reading is stored as read");
  assert.strictEqual(dip.ops[0].updateOne.update.$set.counterMax, undefined, "the high-water mark is NOT lowered");
  const jump = P.planRivals("plati", job({ at: T1, plati: { rows: [gg("10", 2.5, 7 + P.MAX_COUNTER_JUMP + 1)] } }), ex(7));
  assert.deepStrictEqual(jump.sales, []);
  assert.strictEqual(jump.stats.jumps, 1);
  assert.strictEqual(jump.ops[0].updateOne.update.$set.counter, 7 + P.MAX_COUNTER_JUMP + 1);
  assert.strictEqual(jump.ops[0].updateOne.update.$set.counterMax, 7 + P.MAX_COUNTER_JUMP + 1);
});

test("a counter that dips and comes back is NOT a sale (57 -> 0 -> 57, and a stale 120 -> 118 -> 120)", () => {
  // the reviewer's two cases, run as three scans each against the state the previous scan left
  const run = (readings) => {
    let doc = null;
    const sales = [];
    readings.forEach((n, i) => {
      const at = new Date(T0.getTime() + i * 6 * 3600e3);
      const p = P.planRivals("ggsel", job({ at, ggsel: { rows: [gg("10", 2.5, n)] } }), doc ? new Map([["10", doc]]) : new Map());
      sales.push(...p.sales);
      const u = p.ops[0].updateOne.update;
      doc = u.$setOnInsert ? { ...u.$setOnInsert } : { ...doc, ...u.$set };
    });
    return { sales, doc };
  };
  const a = run([57, 0, 57]);
  assert.deepStrictEqual(a.sales, [], "a one-off 0 read and its return are not 57 units sold");
  assert.strictEqual(a.doc.counterMax, 57);
  const b = run([120, 118, 120]);
  assert.deepStrictEqual(b.sales, []);
  // a REAL rise after a dip counts only what is above the old high
  const c = run([120, 118, 123]);
  assert.deepStrictEqual(c.sales.map((x) => x.units), [3]);
});

test("an unreadable counter is skipped, never read as 0 (the scouts' `sold` turns a missing counter into 0)", () => {
  const ex = new Map([["10", { listingId: "10", priceUsd: 2.5, counter: 57, counterMax: 57, lastSeenAt: T0, missed: 0, goneAt: null }]]);
  const p = P.planRivals("ggsel", job({ at: T1, ggsel: { rows: [gg("10", 2.5, 0, { soldRaw: null })] } }), ex);
  assert.deepStrictEqual(p.sales, []);
  const set = p.ops[0].updateOne.update.$set;
  assert.strictEqual(set.counter, undefined, "the stored counter is left alone");
  assert.strictEqual(set.lastSeenAt, T1, "the listing itself is still seen");
  assert.strictEqual(P.normRow("ggsel", gg("1", 1, 0, { soldRaw: 5 })).counter, 5, "soldRaw wins when the scout carries it");
  assert.strictEqual(P.normRow("ggsel", gg("1", 1, 4)).counter, 4, "older scout rows (no soldRaw) still read `sold`");
});

test("a sale already recorded is the baseline: a rival update that failed cannot make the next rise count twice", () => {
  // stored counter 7 (the update after the 7 -> 10 sale failed), but the 10 was recorded as sold
  const ex = new Map([["10", { listingId: "10", priceUsd: 2.5, counter: 7, counterMax: 7, lastSaleCounter: 10, lastSeenAt: T0, missed: 0, goneAt: null }]]);
  const next = P.planRivals("ggsel", job({ at: T1, ggsel: { rows: [gg("10", 2.5, 11)] } }), ex);
  assert.deepStrictEqual(next.sales.map((x) => [x.units, x.dedupeKey]), [[1, "ggsel:10:11"]], "1 unit, not 4");
  const same = P.planRivals("ggsel", job({ at: T1, ggsel: { rows: [gg("10", 2.5, 10)] } }), ex);
  assert.deepStrictEqual(same.sales, []);
  assert.strictEqual(same.ops[0].updateOne.update.$set.counter, 10, "the stored state catches up");
  assert.strictEqual(same.ops[0].updateOne.update.$set.counterMax, 10);
});

test("a price move adds ONE history point, no move adds none, and a tiny wobble is not a move", () => {
  const ex = new Map([["g1", { listingId: "g1", priceUsd: 2, lastSeenAt: T0, missed: 0, goneAt: null }]]);
  const moved = P.planRivals("gameflip", job({ at: T1, gameflip: { sold: [], active: [gf("g1", 1.5)], activeComplete: false } }), ex);
  assert.deepStrictEqual(moved.ops[0].updateOne.update.$push.priceHistory.$each, [{ at: T1, price: 1.5, native: null }]);
  assert.strictEqual(moved.ops[0].updateOne.update.$push.priceHistory.$slice, -P.PRICE_HISTORY_MAX);
  const still = P.planRivals("gameflip", job({ at: T1, gameflip: { sold: [], active: [gf("g1", 2)], activeComplete: false } }), ex);
  assert.strictEqual(still.ops[0].updateOne.update.$push, undefined);
  const wobble = P.planRivals("gameflip", job({ at: T1, gameflip: { sold: [], active: [gf("g1", 2.004)], activeComplete: false } }), ex);
  assert.strictEqual(wobble.ops[0].updateOne.update.$push, undefined);
});

test("on a rouble market a seller's move is judged in roubles: the exchange rate alone is not a move", () => {
  const ex = (native) => new Map([["10", { listingId: "10", priceUsd: 2.39, priceNative: native, counter: 1, counterMax: 1, lastSeenAt: T0, missed: 0, goneAt: null }]]);
  const rub = (price, priceRub) => gg("10", price, 1, { priceRub });
  // 199 RUB both times; the USD figure moved 2% with the rate: NOT a move
  const fx = P.planRivals("ggsel", job({ at: T1, ggsel: { rows: [rub(2.44, 199)] } }), ex(199));
  assert.strictEqual(fx.ops[0].updateOne.update.$push, undefined);
  assert.strictEqual(fx.ops[0].updateOne.update.$set.currency, "RUB");
  // the seller cut 199 -> 149 RUB: a move, recorded with both prices
  const cut = P.planRivals("ggsel", job({ at: T1, ggsel: { rows: [rub(1.79, 149)] } }), ex(199));
  assert.deepStrictEqual(cut.ops[0].updateOne.update.$push.priceHistory.$each, [{ at: T1, price: 1.79, native: 149 }]);
  // no rouble price known: only a move larger than an FX wobble counts
  const noNative = (price) => P.planRivals("plati", job({ at: T1, plati: { rows: [gg("10", price, 1)] } }), new Map([["10", { listingId: "10", priceUsd: 2, lastSeenAt: T0, missed: 0, goneAt: null }]]));
  assert.strictEqual((noNative(2.05).ops[0].updateOne.update.$push || {}).priceHistory, undefined, "2.5%: FX");
  assert.ok(noNative(2.1).ops[0].updateOne.update.$push.priceHistory, "5%: a move");
  // Gameflip prices in USD: any cent counts
  assert.ok(P.priceMoved("gameflip", { priceUsd: 2 }, { priceUsd: 2.01, priceNative: null }));
});

test("our own Gameflip rows are recognised by our listing ids and by ANY owner id we have known", () => {
  const own = { gameflipOwner: "", gameflipOwners: new Set(["OLD", "NEW"]), ids: { gameflip: new Set(["mine-1"]), ggsel: new Set(), plati: new Set() }, sellers: { ggsel: new Set(), plati: new Set() } };
  const flag = (row) => P.isOwn("gameflip", P.normRow("gameflip", row), own);
  assert.ok(flag(gf("mine-1", 1, { seller: "" })), "by our own listing id, whatever the owner field says");
  assert.ok(flag(gf("x", 1, { seller: "OLD" })));
  assert.ok(flag(gf("y", 1, { seller: "NEW" })));
  assert.ok(!flag(gf("z", 1, { seller: "RIVAL" })));
  assert.ok(!flag(gf("z", 1, { seller: "" })), "an empty owner is not ours");
  const sold = P.planSold(job({ own, gameflip: { sold: [gf("mine-1", 1, { seller: "" }), gf("r", 1, { seller: "RIVAL" })], active: [], activeComplete: false } }));
  assert.deepStrictEqual(sold.map((x) => x.ours), [true, false]);
});

test("a listing keeps the game that first saw it (overlapping names must not flip it every scan)", () => {
  const ex = new Map([["10", { listingId: "10", game: "Overwatch", gameKey: "overwatch", priceUsd: 2.5, counter: 1, counterMax: 1, lastSeenAt: T0, missed: 0, goneAt: null }]]);
  const p = P.planRivals("ggsel", job({ game: "Overwatch 2", gameKey: "overwatch 2", at: T1, ggsel: { rows: [gg("10", 2.5, 3)] } }), ex);
  const set = p.ops[0].updateOne.update.$set;
  assert.strictEqual(set.gameKey, undefined, "not moved to the other game");
  assert.strictEqual(set.game, undefined);
  assert.strictEqual(set.lastSeenAt, T1, "but it is still seen");
  assert.strictEqual(p.sales[0].gameKey, "overwatch", "its sale is credited to the game it belongs to");
  // same game: the name is refreshed
  const same = P.planRivals("ggsel", job({ game: "Overwatch", gameKey: "overwatch", at: T1, ggsel: { rows: [gg("10", 2.5, 1)] } }), ex);
  assert.strictEqual(same.ops[0].updateOne.update.$set.gameKey, "overwatch");
});

test("an EMPTY page never counts a miss, even when it claims to be complete (an error body is an empty page)", () => {
  const ex = new Map([["g1", { listingId: "g1", gameKey: "marvel rivals", priceUsd: 2, lastSeenAt: T0, missed: 1, goneAt: null }]]);
  const p = P.planRivals("gameflip", job({ at: T1, gameflip: { sold: [], active: [], activeComplete: true } }), ex);
  assert.deepStrictEqual(p.ops, []);
  assert.strictEqual(p.stats.goneMarked, 0);
  // rows that are all unusable count as empty too
  const junk = P.planRivals("gameflip", job({ at: T1, gameflip: { sold: [], active: [{ id: "", price: 0 }], activeComplete: true } }), ex);
  assert.ok(!junk.ops.some((o) => o.updateOne.filter.listingId === "g1"));
});

test("Gameflip: a rival is gone only after TWO misses on a COMPLETE page", () => {
  const st = (missed, goneAt = null) => new Map([["g1", { listingId: "g1", priceUsd: 2, lastSeenAt: T0, missed, goneAt }], ["g2", { listingId: "g2", priceUsd: 2, lastSeenAt: T0, missed: 0, goneAt: null }]]);
  const seenG2 = [gf("g2", 2)];
  // incomplete page (Rocket League's 100-row cap): absence proves nothing
  const partial = P.planRivals("gameflip", job({ at: T1, gameflip: { sold: [], active: seenG2, activeComplete: false } }), st(0));
  assert.ok(!partial.ops.some((o) => o.updateOne.filter.listingId === "g1"));
  // complete page, first miss
  const first = P.planRivals("gameflip", job({ at: T1, gameflip: { sold: [], active: seenG2, activeComplete: true } }), st(0));
  const m1 = first.ops.find((o) => o.updateOne.filter.listingId === "g1").updateOne.update.$set;
  assert.deepStrictEqual(m1, { missed: 1 });
  // complete page, second miss
  const second = P.planRivals("gameflip", job({ at: T2, gameflip: { sold: [], active: seenG2, activeComplete: true } }), st(1));
  const m2 = second.ops.find((o) => o.updateOne.filter.listingId === "g1").updateOne.update.$set;
  assert.deepStrictEqual(m2, { missed: 2, goneAt: T2 });
  assert.strictEqual(second.stats.goneMarked, 1);
  // already gone: left alone
  const done = P.planRivals("gameflip", job({ at: T2, gameflip: { sold: [], active: seenG2, activeComplete: true } }), st(2, T1));
  assert.ok(!done.ops.some((o) => o.updateOne.filter.listingId === "g1"));
});

test("a complete page of ONE game never counts another game's rivals as missing", () => {
  const ex = new Map([
    ["mine", { listingId: "mine", gameKey: "marvel rivals", priceUsd: 2, lastSeenAt: T0, missed: 0, goneAt: null }],
    ["other", { listingId: "other", gameKey: "rocket league", priceUsd: 2, lastSeenAt: T0, missed: 1, goneAt: null }],
  ]);
  const p = P.planRivals("gameflip", job({ at: T1, gameflip: { sold: [], active: [gf("x", 1)], activeComplete: true } }), ex);
  const touched = p.ops.map((o) => o.updateOne.filter.listingId);
  assert.ok(touched.includes("mine"), "this game's missing rival gets a miss");
  assert.ok(!touched.includes("other"), "the other game's rival is left alone");
  assert.strictEqual(p.stats.goneMarked, 0);
});

test("GGSel / Plati rows are never marked gone: their page-one ranking moves rows in and out", () => {
  const ex = new Map([["10", { listingId: "10", priceUsd: 2, counter: 1, lastSeenAt: T0, missed: 0, goneAt: null }]]);
  const p = P.planRivals("ggsel", job({ at: T1, ggsel: { rows: [gg("11", 2, 1)] } }), ex);
  assert.ok(!p.ops.some((o) => o.updateOne.filter.listingId === "10"));
  assert.strictEqual(p.stats.goneMarked, 0);
});

test("a sold-feed row for a listing we saw live means it SOLD — and that document gets no other update", () => {
  const ex = new Map([["g1", { listingId: "g1", priceUsd: 2, lastSeenAt: T0, missed: 1, goneAt: null, outcome: "" }]]);
  const p = P.planRivals("gameflip", job({ at: T1, gameflip: { sold: [gf("g1", 2, { updated: "2026-10-02T03:00:00Z" })], active: [gf("g1", 2)], activeComplete: true } }), ex);
  const ops = p.ops.filter((o) => o.updateOne.filter.listingId === "g1");
  assert.strictEqual(ops.length, 1, "one update only");
  assert.deepStrictEqual(ops[0].updateOne.update.$set, { goneAt: new Date("2026-10-02T03:00:00Z"), outcome: "sold", missed: 0 });
  assert.strictEqual(p.stats.soldLinked, 1);
  // already marked sold: not marked again
  const again = P.planRivals("gameflip", job({ at: T2, gameflip: { sold: [gf("g1", 2)], active: [], activeComplete: true } }), new Map([["g1", { ...ex.get("g1"), outcome: "sold", goneAt: T1 }]]));
  assert.strictEqual(again.stats.soldLinked, 0);
});

test("a rival that is live again clears 'gone' and any stale 'sold'", () => {
  const ex = new Map([["g1", { listingId: "g1", priceUsd: 2, lastSeenAt: T0, missed: 2, goneAt: T0, outcome: "sold" }]]);
  const p = P.planRivals("gameflip", job({ at: T1, gameflip: { sold: [], active: [gf("g1", 2)], activeComplete: true } }), ex);
  const set = p.ops[0].updateOne.update.$set;
  assert.strictEqual(set.goneAt, null);
  assert.strictEqual(set.missed, 0);
  assert.strictEqual(set.outcome, "");
});

test("our own rival rows are flagged (and still tracked, so our position can be measured)", () => {
  const own = { gameflipOwner: "OWNER", ids: { ggsel: new Set(["500"]), plati: new Set() }, sellers: { ggsel: new Set(), plati: new Set() } };
  const g = P.planRivals("gameflip", job({ own, gameflip: { sold: [], active: [gf("a", 1, { seller: "OWNER" }), gf("b", 1)], activeComplete: false } }));
  const flags = Object.fromEntries(g.ops.map((o) => [o.updateOne.filter.listingId, o.updateOne.update.$setOnInsert.ours]));
  assert.deepStrictEqual(flags, { a: true, b: false });
  const q = P.planRivals("ggsel", job({ own, ggsel: { rows: [gg("500", 1, 0), gg("501", 1, 0)] } }));
  assert.deepStrictEqual(q.ops.map((o) => o.updateOne.update.$setOnInsert.ours), [true, false]);
});

test("a batch is deduped, unusable rows are counted not written, and nothing is written for an empty batch", () => {
  const p = P.planRivals("ggsel", job({ ggsel: { rows: [gg("10", 2, 1), gg("10", 2, 1), gg("11", 0, 1), null] } }));
  assert.strictEqual(p.ops.length, 1);
  assert.strictEqual(p.stats.skippedInvalid, 2);
  assert.deepStrictEqual(P.planRivals("plati", job()).ops, []);
  assert.deepStrictEqual(P.planSold(job()), []);
});

test("planning is deterministic and never mutates what it is given", () => {
  const input = job({ at: T1, gameflip: { sold: marvel.gfSold, active: marvel.gfActive, activeComplete: true }, ggsel: { rows: marvel.gg } });
  const snapshot = JSON.stringify(input);
  const a = JSON.stringify([P.planSold(input), P.planRivals("gameflip", input), P.planRivals("ggsel", input)]);
  const b = JSON.stringify([P.planSold(input), P.planRivals("gameflip", input), P.planRivals("ggsel", input)]);
  assert.strictEqual(a, b);
  assert.strictEqual(JSON.stringify(input), snapshot);
});

/* ------------------------------------- the job ------------------------------------- */

test("buildJob needs a game, keys it like the tracker does, and tolerates missing lists", () => {
  assert.strictEqual(P.buildJob({}, null), null);
  assert.strictEqual(P.buildJob({ game: "   " }, null), null);
  const j = P.buildJob({ game: "Rainbow Six Siege", gfSold: undefined, gfActive: [gf("a", 1), null], gg: null }, "OWN", T1);
  assert.strictEqual(j.gameKey, "rainbow six siege");
  assert.strictEqual(j.at, T1);
  assert.strictEqual(j.own, "OWN");
  assert.deepStrictEqual(j.gameflip.sold, []);
  assert.strictEqual(j.gameflip.active.length, 1);
  assert.deepStrictEqual(j.ggsel.rows, []);
  assert.strictEqual(j.gameflip.activeComplete, false);
  assert.strictEqual(P.buildJob({ game: "X", gfActiveComplete: 1 }, null).gameflip.activeComplete, true);
  assert.strictEqual(P.buildJob({ game: "Dota 2: Auto-Chess!" }, null).gameKey, "dota 2 auto chess");
});
