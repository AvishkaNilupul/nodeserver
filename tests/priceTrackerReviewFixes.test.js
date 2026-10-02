// The price tracker's and the market radar's evidence, after the independent review of
// 2026-10-02 (docs/LIVE-FIXES-1003.md §A9). The farm brain reads its claim-farm sales from
// games.soldUnion (ledger `sales` + `demandOnly`) and its market view from the radar report,
// so each of these rules changes the brain's evidence; each test pins one, and each first
// test of a section fails on the pre-fix bytes:
//   1. a Shop or bulk-order purchase is demand, never price (it used to vanish);
//   2. a radar counter rise spanning a gap counts only the window's share of its units;
//   3. units one GGSel / Digiseller detection wrote are ONE order of price evidence;
//   4. a Gameflip bulk pack of N is N sales (its sold row is not one more, nor "unattributed");
//   5. a burst of the shape of one real guardian pass is demand (still never a price);
//   + the board's replica of the claim farm's sales count follows the engine's 2026-10-03
//     quantity-unit rule, pinned to the engine's own function and to internalSalesForGame.
// Pure: no database, no network.
const test = require("node:test");
const assert = require("node:assert/strict");

const { buildLedger, REAL_PASS_MAX_LISTINGS, REAL_PASS_MAX_UNITS } = require("../utils/priceTracker/ledger");
const G = require("../utils/priceTracker/games");
const A = require("../utils/priceTracker/analyze");
const T = require("../utils/priceTracker");
const { buildMarketReport } = require("../utils/marketData/analyze");

const NOW = Date.parse("2026-10-03T12:00:00Z");
const DAY = 86400000;
const MIN = 60000;
const ago = (d) => new Date(NOW - d * DAY);
const hex = (n) => String(n).padStart(24, "0");
const SET = { _id: hex(900), items: [{ itemKey: "k1", game: "Albion Online", qty: 1 }, { itemKey: "k2", game: "Albion Online", qty: 1 }] };
const union = (L, connected = []) => G.soldUnion({ sales: L.sales.concat(L.demandOnly), connected, now: NOW });

function listing(n, o = {}) {
  return {
    _id: hex(n), marketplace: "ggsel", externalId: "x" + n, origin: "auto", title: "Albion Online Twitch Drops (2 Items)",
    price: 0.75, status: "active", set: hex(900), createdAt: ago(30), updatedAt: ago(1), ...o,
  };
}
// One unit of a sold:<listing>:<game>:<seq> signal, as saleLearning.recordListingSale writes it.
function unitSig(n, seq, at, o = {}) {
  return {
    dedupeKey: "sold:" + hex(n) + ":albion online:" + seq, source: "listing_sold", marketplace: "ggsel",
    game: "Albion Online", gameKey: "albion online", login: "", priceUsd: 0.75, at, ...o,
  };
}

/* --------------------- 1. Shop and bulk orders are demand --------------------- */

// reserveSetOnAccount's real-sale signal: one per game of the set, no price.
function reserved(acct, game, o = {}) {
  return {
    dedupeKey: "reserved:" + hex(acct) + ":" + hex(o.set || 800) + ":" + game.toLowerCase(), source: "listing_sold",
    game, gameKey: game.toLowerCase(), account: hex(acct), login: "", priceUsd: 0, name: "Bundle", at: ago(2), ...o,
  };
}
// The loader's DropLog answer: the (account, set) reservations that still hold.
const held = (...pairs) => new Set(pairs.map(([acct, set = 800]) => hex(acct) + "|" + hex(set)));
const NO_RELEASE = { reservationReleased: 0, reservationUnchecked: 0 };

test("1. Shop and bulk-order purchases are demand, never price evidence, and every counter says why", () => {
  const promoted = reserved(3, "Albion Online"); // relabelled on 2026-08-14: no marketplace at all
  const L = buildLedger({
    listings: [], sets: [],
    signals: [reserved(1, "Albion Online", { marketplace: "shop" }), reserved(2, "Albion Online", { marketplace: "bulk" }), promoted],
    reservations: held([1], [2], [3]),
  });
  assert.equal(L.demandOnly.length, 3, "three buyers");
  assert.equal(L.sales.length, 0, "no price evidence");
  assert.deepEqual(
    L.demandOnly.map((x) => x.source + "/" + x.market).sort(),
    ["bulk-order/bulk", "shop/shop", "shop/unknown"],
  );
  assert.ok(L.demandOnly.every((x) => x.priced === false && x.priceUsd === 0));
  assert.equal(L.excluded.unpricedSignal, 2, "the two Shop sales had no price");
  assert.equal(L.excluded.bulk, 1, "the bulk order is a bulk purchase");
  assert.equal(L.excluded.duplicate, 0);
  assert.equal(L.quality.demandOnly, 3);
  assert.equal(L.quality.bulkDemandOnly, 0, "bulkDemandOnly still means bulk-pack units");
  assert.equal(L.quality.reservationCheck, "ok");
  assert.equal(union(L).get("albion online").size, 3, "the brain's union sees three sold accounts");
});

test("1. one account sold in one game is one sale whichever form it took; a three-game bundle is one sale in each", () => {
  const L = buildLedger({
    listings: [], sets: [],
    signals: [
      reserved(5, "Albion Online", { marketplace: "shop", priceUsd: 2, at: ago(3) }), // a priced Shop sale: price evidence, as before
      reserved(5, "Albion Online", { marketplace: "shop", set: 801 }),
      reserved(6, "Albion Online", { marketplace: "shop" }),
      reserved(6, "Rust", { marketplace: "shop" }),
      reserved(6, "Fortnite", { marketplace: "shop" }),
    ],
    reservations: held([5, 801], [6]),
  });
  assert.equal(L.sales.length, 1, "the priced Shop sale is still a sale");
  assert.equal(L.sales[0].source, "shop");
  assert.equal(L.excluded.duplicate, 1, "account 5 in Albion was counted already");
  assert.equal(L.demandOnly.length, 3);
  // The buyer of account 6 later connects it in Rust: one sale, seen twice.
  const u = union(L, [{ game: "Rust", gameKey: "rust", account: hex(6), login: "buyer6", at: ago(1), dedupeKey: "c1" }]);
  assert.equal(u.get("albion online").size, 2);
  assert.equal(u.get("rust").size, 1);
  assert.equal(u.get("fortnite").size, 1);
});

test("1. a reserved signal of a shape no writer produces, or a stock claim, stays out", () => {
  const L = buildLedger({
    listings: [], sets: [],
    signals: [
      reserved(7, "Albion Online", { marketplace: "gameflip" }),
      // A fulfiller or the auto-lister claiming stock for a shelf is never a buyer.
      reserved(8, "Albion Online", { source: "drop_reserved", marketplace: "" }),
    ],
    reservations: held([7], [8]),
  });
  assert.equal(L.sales.length + L.demandOnly.length, 0);
  assert.deepEqual(L.excluded, { farm: 0, bulk: 0, noListing: 0, unpricedSignal: 0, duplicate: 0, massClose: 0, burst: 0, ...NO_RELEASE });
});

test("1. the board counts a Shop sale as demand for its game", () => {
  const r = T.buildReport({ listings: [], signals: [reserved(1, "Albion Online", { marketplace: "shop" })], sets: [], connected: [], research: [], tasks: [], at: new Date(NOW), reservations: held([1]) });
  const g = r.games.find((x) => x.key === "albion online");
  assert.ok(g, "the game is on the board");
  assert.equal(g.demand.units45, 1);
  assert.equal(g.price.realised.n, 0, "and has no realised price from it");
});

// The review's p1: every rollback releases the reservation and leaves the signal.
test("1b. a Shop or bulk-order sale whose reservation was given back is not a sale", () => {
  const signals = [
    // a 20-unit bulk order, then cancelled (bulkOrderRoutes DELETE releases its drops)
    ...Array.from({ length: 20 }, (_, i) => reserved(100 + i, "Marvel Rivals", { marketplace: "bulk", set: 900, at: ago(3) })),
    reserved(200, "Rust", { marketplace: "shop", set: 901 }), // the buyer's debit failed
    reserved(201, "Rust", { marketplace: "shop", set: 901, at: ago(1) }), // a sale that stands
  ];
  const L = buildLedger({ listings: [], sets: [], signals, reservations: held([201, 901]) });
  assert.deepEqual([...union(L)].map(([g, m]) => [g, m.size]), [["rust", 1]], "one account was really sold (it read 22)");
  assert.equal(L.excluded.reservationReleased, 21);
  assert.equal(L.excluded.reservationUnchecked, 0);
  assert.equal(L.demandOnly.length, 1);
  // A released sale does not take its account+game key: the same account sold again counts.
  const again = buildLedger({
    listings: [], sets: [],
    signals: [reserved(7, "Rust", { marketplace: "shop", set: 901, at: ago(5) }), reserved(7, "Rust", { marketplace: "shop", set: 902, at: ago(2) })],
    reservations: held([7, 902]),
  });
  assert.equal(again.demandOnly.length, 1);
  assert.equal(again.excluded.reservationReleased, 1);
  assert.equal(again.excluded.duplicate, 0);
  // The Games board's clean view no longer takes the cancelled bulk order as 20 sales.
  const r = T.buildReport({ listings: [], signals, sets: [], connected: [], research: [], tasks: [], at: new Date(NOW), reservations: held([201, 901]) });
  const mr = r.games.find((x) => x.key === "marvel rivals");
  assert.equal(mr ? mr.demand.units45 : 0, 0);
  assert.ok(r.insights.some((i) => i.id === "reservations-released" && /21 Shop \/ bulk-order sales/.test(i.title)));
});

test("1b. without the reservation read no Shop or bulk-order sale counts, and the page says why", () => {
  const signals = [reserved(1, "Rust", { marketplace: "shop" }), reserved(2, "Rust", { marketplace: "bulk" })];
  const L = buildLedger({ listings: [], sets: [], signals });
  assert.equal(L.demandOnly.length, 0, "never a phantom sale");
  assert.equal(L.excluded.reservationUnchecked, 2);
  assert.equal(L.quality.reservationCheck, "unavailable");
  const r = T.buildReport({ listings: [], signals, sets: [], connected: [], research: [], tasks: [], at: new Date(NOW), reservations: null, reservationNote: "the reservation read failed: boom" });
  const ins = r.insights.find((i) => i.id === "reservations-unchecked");
  assert.ok(ins, "the page says so");
  assert.match(ins.detail, /boom/);
});

/* ---- 1c. the loader: one grouped DropLog read and one BotAccount read, bounded ---- */

function fakeModels({ dropLogRows = [], accounts = [], dropLogError = null } = {}) {
  const calls = { aggregate: [], botFind: [] };
  const chain = (rows) => {
    const q = { sort: () => q, limit: (n) => ((q.limitN = n), q), lean: () => Promise.resolve(rows), then: (a, b) => Promise.resolve(rows).then(a, b) };
    return q;
  };
  return {
    calls,
    DropLog: {
      aggregate: async (pipeline) => {
        calls.aggregate.push(pipeline);
        if (dropLogError) throw dropLogError;
        return dropLogRows;
      },
    },
    BotAccount: {
      find: (filter, proj) => {
        const q = chain(accounts.filter((a) => filter._id.$in.includes(String(a._id))));
        calls.botFind.push({ filter, proj, q });
        return q;
      },
    },
  };
}

test("1c. reservationEvidence: one grouped DropLog read (ObjectIds, held only) and one projected BotAccount read", async () => {
  const { Types } = require("mongoose");
  const signals = [
    reserved(1, "Rust", { marketplace: "shop" }),
    reserved(1, "Fortnite", { marketplace: "shop" }), // same reservation, another game
    reserved(2, "Rust", { marketplace: "bulk", set: 801 }),
    unitSig(9, 0, ago(1)), // not a reserved signal: never looked up
  ];
  const m = fakeModels({
    dropLogRows: [{ _id: { account: new Types.ObjectId(hex(1)), set: hex(800) } }],
    accounts: [{ _id: hex(1), login: "BuyerOne" }, { _id: hex(2), login: "" }],
  });
  const ev = await T.reservationEvidence(signals, m);
  assert.deepEqual([...ev.reservations], [hex(1) + "|" + hex(800)]);
  assert.deepEqual([...ev.accountLogins], [[hex(1), "buyerone"]]);
  assert.equal(ev.note, "");
  assert.equal(m.calls.aggregate.length, 1, "one batched read");
  const [match, group, limit] = m.calls.aggregate[0];
  assert.ok(match.$match.account.$in.every((id) => id instanceof Types.ObjectId), "aggregate() does not cast: ObjectIds");
  assert.deepEqual(match.$match.account.$in.map(String).sort(), [hex(1), hex(2)]);
  assert.deepEqual(match.$match.soldSetId.$in.sort(), [hex(800), hex(801)]);
  assert.deepEqual(match.$match.soldAt, { $ne: null }, "only a reservation that still holds");
  assert.deepEqual(group, { $group: { _id: { account: "$account", set: "$soldSetId" } } });
  assert.ok(limit.$limit > 0);
  assert.equal(m.calls.botFind.length, 1);
  assert.deepEqual(m.calls.botFind[0].proj, { login: 1 }, "only the login");
  assert.equal(m.calls.botFind[0].q.limitN, 2);
  // Nothing to look up: no read at all.
  const none = fakeModels();
  const ev0 = await T.reservationEvidence([unitSig(9, 0, ago(1))], none);
  assert.equal(none.calls.aggregate.length + none.calls.botFind.length, 0);
  assert.equal(ev0.reservations.size, 0);
});

test("1c. a failed reservation read counts none of them and says why", async () => {
  const m = fakeModels({ dropLogError: new Error("connection reset") });
  const ev = await T.reservationEvidence([reserved(1, "Rust", { marketplace: "shop" })], m);
  assert.equal(ev.reservations, null);
  assert.match(ev.note, /reservation read failed: connection reset/);
  const L = buildLedger({ listings: [], sets: [], signals: [reserved(1, "Rust", { marketplace: "shop" })], ...ev, reservationNote: ev.note });
  assert.equal(L.demandOnly.length, 0);
  assert.equal(L.excluded.reservationUnchecked, 1);
});

test("1c. loadFromDb hands the reservation evidence to the ledger", async () => {
  const { Types } = require("mongoose");
  const q = (rows) => {
    const c = { sort: () => c, limit: () => c, lean: () => Promise.resolve(rows) };
    return c;
  };
  const signals = [reserved(1, "Rust", { marketplace: "shop" }), reserved(2, "Rust", { marketplace: "shop" })];
  const m = fakeModels({ dropLogRows: [{ _id: { account: new Types.ObjectId(hex(1)), set: hex(800) } }], accounts: [{ _id: hex(1), login: "buyerone" }] });
  const models = {
    ...m,
    MarketplaceListing: { find: () => q([]) },
    SaleSignal: { find: (f) => q(f.source === "listing_sold" ? signals : []) },
    DropSet: { find: () => q([]) },
    MarketResearch: { find: () => q([]) },
    AutoFarmTask: { aggregate: async () => [] },
  };
  const input = await T.loadFromDb({ now: NOW, models });
  assert.ok(input.reservations instanceof Set);
  assert.equal(input.accountLogins.get(hex(1)), "buyerone");
  const r = T.buildReport(input);
  const g = r.games.find((x) => x.key === "rust");
  assert.equal(g.demand.units45, 1, "account 1's sale holds; account 2's was rolled back");
  assert.equal(r.ledger.excluded.reservationReleased, 1);
  assert.equal(signals[0].login, "", "the raw signals are not rewritten (the engine replay reads them as the engine does)");
});

/* --------- 1d. a Shop sale is named by its login: a twin record is the same buyer --------- */

test("1d. a Shop sale's buyer redeeming on a re-minted twin record of the login is one sale (it read two)", () => {
  // The same Twitch login imported twice is two BotAccount records; the drop scanner sees the
  // buyer's redeem on the other one.
  const signals = [reserved(1, "Rust", { marketplace: "shop", at: ago(5) })];
  const connected = [{ game: "Rust", gameKey: "rust", account: hex(2), login: "buyerlogin", at: ago(4), dedupeKey: "c2" }];
  const L = buildLedger({ listings: [], sets: [], signals, reservations: held([1]), accountLogins: new Map([[hex(1), "BuyerLogin"]]) });
  assert.equal(L.demandOnly[0].login, "buyerlogin");
  assert.equal(union(L, connected).get("rust").size, 1);
  // Without a known login it is still the account's own sale, and only that.
  const L2 = buildLedger({ listings: [], sets: [], signals, reservations: held([1]) });
  assert.equal(union(L2, [{ ...connected[0], account: hex(1) }]).get("rust").size, 1);
});

/* ------------------- 2. radar counter rises spanning a gap -------------------- */

// The review's case: a GGSel listing that dropped out of the scans for 40 days and came back 40
// units higher — about one a day, recorded as 40 the day it was re-read.
const gapSale = (o = {}) => ({
  market: "ggsel", listingId: "1", game: "Alpha", gameKey: "alpha", title: "Alpha Twitch Drops", itemCount: null, kind: "drops",
  priceUsd: 1, units: 40, seller: "s", sellerName: "S", soldAt: ago(1), prevObservedAt: ago(41), ttsHours: null,
  source: "counter", ours: false, firstSeenAt: ago(1), ...o,
});
const gapRival = { market: "ggsel", listingId: "1", game: "Alpha", gameKey: "alpha", title: "Alpha Twitch Drops", kind: "drops", seller: "s", sellerName: "S", priceUsd: 1, priceHistory: [], counter: 140, ours: false, firstSeenAt: ago(41), lastSeenAt: ago(1), goneAt: null };
const radar = (sales, windowDays) => buildMarketReport({ sales, rivals: [gapRival], ownListings: [], research: [] }, { now: NOW, windowDays });

test("2. a counter rise spanning a gap counts only the share of its span inside the window", () => {
  const w7 = radar([gapSale()], 7).games.find((g) => g.key === "alpha");
  assert.equal(w7.units, 6, "6 of the 40 days lie in the last week (it read 40)");
  assert.equal(w7.byMarket.ggsel.observedDays, 7, "and the market was watched the whole week");
  assert.equal(w7.perWeek, 6, "about one a day (it read 40 a week)");
  const w30 = radar([gapSale()], 30).games.find((g) => g.key === "alpha");
  assert.equal(w30.units, 29);
  assert.equal(w30.byMarket.ggsel.observedDays, 30);
  assert.equal(w30.perWeek, 6.8, "it read 9.3");
  const w90 = radar([gapSale()], 90).games.find((g) => g.key === "alpha");
  assert.equal(w90.units, 40, "a window holding the whole span counts it all");
  assert.equal(w90.byMarket.ggsel.observedDays, 41);
  assert.equal(w90.perWeek, 6.8);
});

test("2. the feed row, the seller board and the overview count the window's share; the row keeps the whole rise", () => {
  const r = radar([gapSale()], 7);
  assert.equal(r.feed[0].units, 6, "what the brain and the per-game seller table add up");
  assert.equal(r.feed[0].unitsSeen, 40, "what the counter rose by");
  assert.equal(new Date(r.feed[0].prevObservedAt).getTime(), ago(41).getTime());
  assert.equal(r.sellers[0].units, 6);
  assert.equal(r.markets.ggsel.units, 6);
  assert.equal(r.sellers[0].revenueUsd, 6);
  assert.equal(r.games[0].orders, 1, "still one sale event, one observation of its price");
  assert.equal(r.games[0].realised.n, 1);
});

test("2. a rise inside the window, a rise with no prevObservedAt and a Gameflip sale count whole, as before", () => {
  const sales = [
    gapSale({ listingId: "2", units: 5, prevObservedAt: ago(3), soldAt: ago(2) }),
    gapSale({ listingId: "3", units: 7, prevObservedAt: null, soldAt: ago(1) }),
    gapSale({ market: "gameflip", listingId: "g1", units: 1, prevObservedAt: null, source: "sold-feed", ttsHours: 5 }),
  ];
  const g = radar(sales, 7).games.find((x) => x.key === "alpha");
  assert.equal(g.byMarket.ggsel.units, 12);
  assert.equal(g.byMarket.gameflip.units, 1);
  // A partial share is kept to a tenth: 3 units over [10d, 4d] seen from a 7-day window.
  const part = radar([gapSale({ units: 3, prevObservedAt: ago(10), soldAt: ago(4) })], 7).games.find((x) => x.key === "alpha");
  assert.equal(part.units, 1.5);
});

/* ------------- 3. one GGSel / Digiseller detection is one order --------------- */

test("3. the units of one detection are one order of price evidence, and still three accounts sold", () => {
  const at = ago(1);
  const signals = [0, 1, 2].map((i) => unitSig(10, i, at, { login: "p1, p2, p3" }));
  const L = buildLedger({ listings: [listing(10)], signals, sets: [SET] });
  assert.equal(L.sales.length, 3, "three units");
  assert.equal(new Set(L.sales.map((x) => x.saleGroup)).size, 1, "one detection");
  assert.equal(A.perOrder(L.sales).length, 1, "one piece of price evidence (it was three)");
  const prepared = A.prepare({ listings: [listing(10)], sets: [SET], sales: L.sales });
  const v = A.venueSummary({ sales: L.sales, prepared, now: NOW, fees: {} }).find((x) => x.market === "ggsel");
  assert.equal(v.sales.total, 3);
  assert.equal(v.sales.orders, 1);
  assert.equal(v.realised.n, 1);
  assert.equal(union(L).get("albion online").size, 3, "demand still counts each unit");
});

test("3. two detections, or two listings at the same instant, are separate orders", () => {
  const twice = buildLedger({ listings: [listing(11)], sets: [SET], signals: [unitSig(11, 0, ago(3)), unitSig(11, 1, ago(1))] });
  assert.equal(A.perOrder(twice.sales).length, 2);
  const at = ago(1);
  const two = buildLedger({ listings: [listing(12), listing(13)], sets: [SET], signals: [unitSig(12, 0, at), unitSig(13, 0, at)] });
  assert.equal(A.perOrder(two.sales).length, 2);
});

test("3. a GGSel suggestion no longer rests on one detection read as three sales", () => {
  const at = ago(1);
  const signals = [0, 1, 2].map((i) => unitSig(14, i, at, { login: "p1, p2, p3", priceUsd: 1.5 }));
  const r = T.buildReport({ listings: [listing(14)], signals, sets: [SET], connected: [], research: [], tasks: [], at: new Date(NOW) });
  const s = r.games.find((x) => x.key === "albion online").price.markets.ggsel.suggested;
  assert.equal(s.evidenceN, 1, "it said 3");
  assert.equal(s.confidence, "low", "it said medium");
  const adv = r.advice.find((x) => x.market === "ggsel");
  assert.equal(adv.evidenceN, 1);
});

/* -------------------- 4. a Gameflip bulk pack of N is N --------------------- */

function pack(n, o = {}) {
  return listing(n, { marketplace: "gameflip", status: "sold", bulkOfferId: hex(77), price: 5, unitsSold: 5, title: "Albion Online Twitch Drops (2 Items) — PACK OF 5 ACCOUNTS", ...o });
}
const packSignals = (n) =>
  [0, 1, 2, 3, 4].map((i) => unitSig(n, i, ago(1), { marketplace: "gameflip", account: hex(100 + i), login: "acct" + i, priceUsd: 1, bulk: true }));

test("4. a Gameflip bulk pack of 5 is 5 sales: its sold row is not a sixth, and its units are not 'unattributed'", () => {
  const L = buildLedger({ listings: [pack(20)], signals: packSignals(20), sets: [SET] });
  assert.equal(L.demandOnly.length, 5, "it was 6");
  assert.equal(union(L).get("albion online").size, 5, "the brain saw 6");
  assert.equal(L.quality.unattributedUnits, 0, "it said 5 sold units had no record");
  assert.equal(L.excluded.bulk, 5, "one per unit, not one more for the row");
  assert.equal(L.sales.length, 0, "never price evidence");
});

test("4. a sold pack with no signal at all still counts once, from its row", () => {
  const L = buildLedger({ listings: [pack(21, { unitsSold: 0 })], signals: [], sets: [SET] });
  assert.equal(L.demandOnly.length, 1);
  assert.equal(L.demandOnly[0].key, "bulkrow:" + hex(21));
});

/* ----------- 5. a burst may only be dropped from DEMAND when it is a closeout ----------- */

// `listings` listings, `per` units each, written within seconds (one guardian flush) from `t`.
function pass(first, listings, per, t) {
  const ls = [];
  const sg = [];
  for (let i = 0; i < listings; i += 1) {
    ls.push(listing(first + i));
    for (let k = 0; k < per; k += 1) sg.push(unitSig(first + i, k, new Date(t.getTime() + i * 1000)));
  }
  return { ls, sg };
}

test("5. one real guardian pass that found 9 units is demand, though it is a burst and never a price", () => {
  const p = pass(30, 3, 3, ago(2));
  const L = buildLedger({ listings: p.ls, signals: p.sg, sets: [SET] });
  assert.equal(L.sales.length, 0, "price exclusion as before");
  assert.equal(L.suspect.length, 0, "not a closeout");
  assert.equal(L.demandOnly.length, 9, "it was dropped from demand");
  assert.ok(L.demandOnly.every((x) => x.burst === true && x.priced === false));
  assert.equal(L.excluded.burst, 9);
  assert.equal(L.excluded.massClose, 0);
  assert.equal(L.suspectSaleKeys.size, 0, "the engine replay's clean count keeps them");
  assert.equal(union(L).get("albion online").size, 9);
  assert.equal(L.quality.unattributedUnits, 0);
});

test("5. a burst bigger than a real pass is a closeout: out of price AND demand, as before", () => {
  const units = pass(40, 3, 4, ago(2)); // 12 units on 3 listings
  const L1 = buildLedger({ listings: units.ls, signals: units.sg, sets: [SET] });
  assert.equal(L1.suspect.length, 12);
  assert.equal(L1.demandOnly.length, 0);
  assert.equal(L1.excluded.massClose, 12);
  const rows = pass(50, 5, 2, ago(2)); // 10 units on 5 listings
  const L2 = buildLedger({ listings: rows.ls, signals: rows.sg, sets: [SET] });
  assert.equal(L2.suspect.length, 10);
  assert.equal(L2.demandOnly.length, 0);
});

test("5. two real passes more than five minutes apart are two passes, not one closeout", () => {
  const a = pass(60, 2, 4, ago(2));
  const b = pass(62, 2, 4, new Date(ago(2).getTime() + 7 * MIN));
  const L = buildLedger({ listings: a.ls.concat(b.ls), signals: a.sg.concat(b.sg), sets: [SET] });
  assert.equal(L.demandOnly.length, 16);
  assert.equal(L.suspect.length, 0);
  // The same 16 units inside five minutes are one burst on 4 listings: more than a pass.
  const c = pass(70, 2, 4, ago(2));
  const d = pass(72, 2, 4, new Date(ago(2).getTime() + 2 * MIN));
  const L2 = buildLedger({ listings: c.ls.concat(d.ls), signals: c.sg.concat(d.sg), sets: [SET] });
  assert.equal(L2.suspect.length, 16);
  assert.equal(L2.demandOnly.length, 0);
});

// The review's p2: Digiseller Black Desert listings, recorded the way the guardian writes them.
const bdoSet = { _id: hex(901), items: [{ itemKey: "b1", game: "Black Desert", qty: 1 }] };
const bdo = (n, o = {}) => listing(n, { marketplace: "digiseller", title: "Black Desert Twitch Drops", price: 1.75, set: hex(901), status: "delisted", createdAt: ago(60), updatedAt: ago(1), ...o });
const bdoUnit = (n, seq, at) => ({ dedupeKey: "sold:" + hex(n) + ":black desert:" + seq, source: "listing_sold", marketplace: "digiseller", game: "Black Desert", gameKey: "black desert", login: "", account: null, priceUsd: 1.75, at });

test("5b. a WIPE: a burst that emptied listings later taken down is set aside, whatever its size (it read 10 sales)", () => {
  // 2026-08-14 11:29 on the 10-01 snapshot: 7 + 2 + 1 units of listings holding 7 / 2 / 2,
  // all delisted weeks later (their rows written again since, so the 90-second rule missed them).
  const t = ago(20).getTime();
  const listings = [bdo(1, { qtyTarget: 7, unitsSold: 7 }), bdo(2, { qtyTarget: 2, unitsSold: 2 }), bdo(3, { qtyTarget: 2, unitsSold: 1 })];
  const signals = [...[0, 1, 2, 3, 4, 5, 6].map((s) => bdoUnit(1, s, new Date(t + 40000))), ...[0, 1].map((s) => bdoUnit(2, s, new Date(t))), bdoUnit(3, 0, new Date(t + 1000))];
  const L = buildLedger({ listings, signals, sets: [bdoSet] });
  assert.equal(L.demandOnly.length, 0);
  assert.equal(L.suspect.length, 10);
  assert.equal(L.excluded.burst, 0);
  assert.equal(L.excluded.massClose, 10);
  assert.equal(union(L).size, 0);
});

test("5c. the remnant of a closeout is measured with the delist rule's mass-close records of the same minutes (it read 9 sales)", () => {
  // 20 listings of 3 closed out over 10 minutes; 17 are caught by the 90-second delist rule, 3
  // slipped it (their rows were written again a day later) and alone look like a 9-unit pass.
  const t0 = ago(10).getTime();
  const listings = [];
  const signals = [];
  for (let i = 0; i < 20; i += 1) {
    const at = t0 + i * 30000;
    const slipped = i >= 8 && i < 11;
    // Leave stock on them (qtyTarget 4), so only the mass-close records can expose the closeout.
    listings.push(bdo(100 + i, { qtyTarget: 4, unitsSold: 3, updatedAt: new Date(slipped ? at + DAY : at + 5000) }));
    for (let s = 0; s < 3; s += 1) signals.push(bdoUnit(100 + i, s, new Date(at)));
  }
  const L = buildLedger({ listings, signals, sets: [bdoSet] });
  assert.equal(L.suspect.filter((x) => x.reason === "mass-close").length, 51);
  assert.equal(L.demandOnly.filter((x) => x.burst).length, 0);
  assert.equal(L.suspect.length, 60);
});

test("5d. a real pass that leaves stock on its listings stays demand, whatever happened to them later", () => {
  const t = ago(15).getTime();
  // 3 listings keeping 10 each, 3 units sold from each, all delisted much later.
  const listings = [bdo(201, { qtyTarget: 10 }), bdo(202, { qtyTarget: 10 }), bdo(203, { qtyTarget: 10 })];
  const signals = [];
  for (const n of [201, 202, 203]) for (let s = 0; s < 3; s += 1) signals.push(bdoUnit(n, s, new Date(t + (n - 201) * 1000)));
  const L = buildLedger({ listings, signals, sets: [bdoSet] });
  assert.equal(L.demandOnly.filter((x) => x.burst).length, 9);
  assert.equal(L.suspect.length, 0);
  // Buyers emptying a listing that is still on sale (refilled) is not a wipe either.
  const live = [bdo(301, { qtyTarget: 3, status: "active" }), bdo(302, { qtyTarget: 10, status: "active" })];
  const sg = [...[0, 1, 2].map((s) => bdoUnit(301, s, new Date(t))), ...[0, 1, 2, 3, 4].map((s) => bdoUnit(302, s, new Date(t + 2000)))];
  const L2 = buildLedger({ listings: live, signals: sg, sets: [bdoSet] });
  assert.equal(L2.demandOnly.filter((x) => x.burst).length, 8);
  // ... but the same pass on a listing emptied and later delisted is a wipe.
  const L3 = buildLedger({ listings: [bdo(301, { qtyTarget: 3 }), bdo(302, { qtyTarget: 10, status: "active" })], signals: sg, sets: [bdoSet] });
  assert.equal(L3.demandOnly.length, 0);
  assert.equal(L3.suspect.length, 8);
});

test("5. the real-pass shape is the guardian's own rule (MASS_DROP_DEFAULTS)", () => {
  const guardian = require("../utils/marketplaceGuardian");
  const cfg = guardian.MASS_DROP_DEFAULTS;
  assert.equal(REAL_PASS_MAX_LISTINGS, cfg.rows - 1);
  assert.equal(REAL_PASS_MAX_UNITS, cfg.units - 1);
  const items = (listings, units) =>
    Array.from({ length: listings }, (_, i) => ({ row: { _id: "r" + i }, units: Math.floor(units / listings) + (i < units % listings ? 1 : 0) }));
  const ledgerKeeps = (listings, units, first) => {
    const ls = [];
    const sg = [];
    let left = units;
    for (let i = 0; i < listings; i += 1) {
      ls.push(listing(first + i));
      const n = Math.floor(units / listings) + (i < units % listings ? 1 : 0);
      for (let k = 0; k < n && left > 0; k += 1, left -= 1) sg.push(unitSig(first + i, k, new Date(ago(2).getTime() + i * 1000)));
    }
    return buildLedger({ listings: ls, signals: sg, sets: [SET] }).demandOnly.length === units;
  };
  for (const [listings, units] of [[4, 11], [1, 11], [2, 8], [5, 11], [4, 12], [3, 12], [6, 8]]) {
    const real = !guardian.evaluateMassDrop(items(listings, units), cfg, []).tripped;
    assert.equal(ledgerKeeps(listings, units, 100 + listings * 20 + units), real, listings + " listings / " + units + " units");
  }
});

/* -------- + the board's replica of the engine's sales count, 2026-10-03 rule -------- */

test("+ a quantity unit and its buyer's later connection are one engine sale (it counted two)", () => {
  const t = ago(5);
  const e = G.engineCounts({
    signals: [{ source: "listing_sold", gameKey: "world of tanks", dedupeKey: "sold:" + hex(1) + ":world of tanks:0", login: "a, b, c", account: null, priceUsd: 1.5, at: t }],
    connected: [{ gameKey: "world of tanks", account: hex(2), login: "b", at: new Date(t.getTime() + 2 * 3600000), dedupeKey: "c1" }],
    now: NOW,
  });
  assert.deepEqual(e.get("world of tanks"), { count: 1, revenue: 1.5, priced: 1, avgPrice: 1.5, perWeek: 0.16 });
});

test("+ the units of one pool are separate sales even when the row carries one of its accounts (it counted one)", () => {
  const signals = [0, 1, 2, 3].map((i) => ({ source: "listing_sold", gameKey: "albion online", dedupeKey: "sold:" + hex(3) + ":albion online:" + i, login: "a, b, c", account: hex(5), priceUsd: 1, at: ago(10 - i) }));
  assert.equal(G.engineCounts({ signals, connected: [], now: NOW }).get("albion online").count, 4);
});

// Deterministic pseudo-random inputs.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRows(seed, games = ["world of tanks", "albion online", "rust"]) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const logins = ["a", "b", "c", "d", "e", "f", "g"];
  const acct = (l) => hex(1000 + logins.indexOf(l));
  const rows = [];
  let n = 0;
  for (const game of games) {
    const count = 4 + Math.floor(r() * 14);
    for (let i = 0; i < count; i += 1) {
      // Some outside the 45-day window; never ON its edge (the engine reads the clock itself).
      const at = new Date(NOW - (Math.floor(r() * 50 * 24) + 0.5) * 3600000);
      const kind = r();
      if (kind < 0.35) {
        const pool = [...new Set([pick(logins), pick(logins), pick(logins)])];
        if (pool.length < 2) pool.push(pool[0] === "a" ? "b" : "a");
        rows.push({ source: "listing_sold", gameKey: game, dedupeKey: "sold:" + hex(7000 + n) + ":" + game + ":" + i, login: pool.join(pick([", ", ",", " ; "])), account: r() < 0.3 ? acct(pool[0]) : null, priceUsd: pick([0, 0.75, 1.5, 2.25]), at });
      } else if (kind < 0.6) {
        // A named sale: a login (sometimes padded with separators), or none with or without an account.
        const l = r() < 0.75 ? pick(logins) : "";
        const shown = l ? pick([l, l, l.toUpperCase(), " " + l + " ", l + ";"]) : pick(["", "", " , "]);
        rows.push({ source: "listing_sold", gameKey: game, dedupeKey: "sold:" + hex(8000 + n) + ":" + game + ":0", login: shown, account: r() < 0.6 ? acct(l || pick(logins)) : null, priceUsd: pick([0, 1, 1.25]), at });
      } else {
        // A buyer connection: the login as the scanner wrote it, padded, or one in no pool at all.
        const l = pick(logins);
        rows.push({ source: "connected", gameKey: game, dedupeKey: "conn:" + n, login: pick([l, l, l.toUpperCase(), l + ",", " " + l, "", "x" + l]), account: acct(l), priceUsd: 0, at });
      }
      n += 1;
    }
  }
  return rows;
}

test("+ the board's port of pairQuantityUnits returns exactly what the engine's returns", () => {
  const engine = require("../utils/autoFarmer");
  assert.equal(typeof engine.pairQuantityUnits, "function", "the engine exports its pairing rule");
  for (let seed = 1; seed <= 200; seed += 1) {
    const rows = randomRows(seed, ["g"]);
    const units = rows.filter((x) => x.source === "listing_sold" && G.QUANTITY_POOL_RE.test(x.login)).map(({ login, at, priceUsd, dedupeKey }) => ({ login, at, priceUsd, dedupeKey }));
    const named = rows.filter((x) => x.source === "listing_sold" && !G.QUANTITY_POOL_RE.test(x.login)).map(({ login, account }) => ({ login, account }));
    const by = new Map();
    for (const c of rows.filter((x) => x.source === "connected" && x.login > "")) {
      const k = c.login.toLowerCase();
      const cur = by.get(k) || { _id: k, at: c.at, accounts: [] };
      if (c.at < cur.at) cur.at = c.at;
      if (!cur.accounts.includes(c.account)) cur.accounts.push(c.account);
      by.set(k, cur);
    }
    const conns = [...by.values()];
    assert.deepEqual(G.pairQuantityUnits(units, conns, named), engine.pairQuantityUnits(units, conns, named), "seed " + seed);
  }
});

test("+ a connection written 'B,' or ' b' is the pool login b to the engine, so it pairs (the engine trims and lowercases)", () => {
  const t = ago(5);
  const unit = { source: "listing_sold", gameKey: "world of tanks", dedupeKey: "sold:" + hex(1) + ":world of tanks:0", login: "a, b", account: null, priceUsd: 1, at: t };
  for (const login of ["B,", " b", "b;"]) {
    const e = G.engineCounts({ signals: [unit], connected: [{ gameKey: "world of tanks", account: hex(2), login, at: new Date(t.getTime() + 3600000), dedupeKey: "c" }], now: NOW });
    assert.equal(e.get("world of tanks").count, 1, JSON.stringify(login));
  }
  // A named sale of a pool login (written " B ") takes that login first: the unit cannot pair.
  const named = { source: "listing_sold", gameKey: "world of tanks", dedupeKey: "sold:" + hex(3) + ":world of tanks:0", login: " B ", account: null, priceUsd: 2, at: ago(6) };
  const e2 = G.engineCounts({ signals: [unit, named], connected: [{ gameKey: "world of tanks", account: hex(2), login: "b", at: new Date(t.getTime() + 3600000), dedupeKey: "c" }], now: NOW });
  assert.equal(e2.get("world of tanks").count, 3, "the named sale, its buyer's connection and the unpaired unit");
});

// The same rows through the engine's REAL internalSalesForGame on a real (local, in-memory)
// mongod, and through the board's replica: the engine's pairing read uses $trim / $expr, so a
// hand-written evaluator would be one more thing to trust. The mongod binary is the one the
// repo's other database tests use (mongodb-memory-server's cache); no network.
test("+ engineCounts equals the engine's own internalSalesForGame, run on a real mongod", async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongoose = require("mongoose");
  const engine = require("../utils/autoFarmer");
  const SaleSignal = require("../models/SaleSignal");
  const mem = await MongoMemoryServer.create();
  const realError = console.error;
  const pairingFailures = [];
  console.error = (...a) => {
    if (/pairing read failed/.test(a.join(" "))) pairingFailures.push(a.join(" "));
    else realError(...a);
  };
  // The count before 2026-10-03 (every row grouped by account, else dedupeKey), to show the
  // rows really exercise the quantity-unit rule.
  const oldCount = (rows, game, now) => {
    const groups = new Set();
    for (const x of rows) {
      if (x.gameKey !== game || x.at.getTime() < now - 45 * DAY) continue;
      groups.add(x.account ? "a:" + x.account : "d:" + x.dedupeKey);
    }
    return groups.size;
  };
  let total = 0;
  let differs = 0;
  try {
    await mongoose.connect(mem.getUri("pricetrackerenginepin"));
    for (let seed = 1; seed <= 60; seed += 1) {
      // Rows dated against the real clock: internalSalesForGame reads Date.now().
      const now = Date.now();
      const rows = randomRows(seed).map((x) => ({ ...x, at: new Date(x.at.getTime() - NOW + now) }));
      await SaleSignal.deleteMany({});
      await SaleSignal.insertMany(rows.map((x) => ({ ...x, game: x.gameKey })));
      const board = G.engineCounts({ signals: rows.filter((x) => x.source === "listing_sold"), connected: rows.filter((x) => x.source === "connected"), now });
      for (const game of ["world of tanks", "albion online", "rust"]) {
        const e = await engine.internalSalesForGame(game);
        const b = board.get(game) || { count: 0, revenue: 0, avgPrice: 0 };
        assert.deepEqual({ count: b.count, revenue: b.revenue, avgPrice: b.avgPrice }, e, "seed " + seed + " " + game);
        total += e.count;
        if (oldCount(rows, game, now) !== e.count) differs += 1;
      }
    }
  } finally {
    console.error = realError;
    await mongoose.disconnect();
    await mem.stop();
  }
  assert.deepEqual(pairingFailures, [], "the engine's pairing read ran (no fallback)");
  assert.ok(total > 300, "the engine really counted (" + total + ")");
  assert.ok(differs >= 20, "the rows exercise the quantity-unit rule (" + differs + " games differ from the old count)");
});
