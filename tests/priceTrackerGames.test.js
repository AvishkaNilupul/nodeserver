/* global fetch */
// The per-game board and the auto-farm attach seam.
//
// Every test here pins either a defect measured on production data on 2026-10-01
// (twin accounts counted twice, delist bursts counted as demand, a lot's login list
// read as several accounts, no-claim games given a conflicting instruction) or a
// safety rule of the attach seam (off by default, base price on every failure,
// guarded when applying).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const G = require("../utils/priceTracker/games");
const A = require("../utils/priceTracker/analyze");
const T = require("../utils/priceTracker");
const attach = require("../utils/priceTracker/attach");
const farmSizing = require("../utils/farmSizing");
const { buildLedger } = require("../utils/priceTracker/ledger");

const NOW = Date.parse("2026-10-01T00:00:00Z");
const DAY = 86400000;
const oid = (n) => String(n).padStart(24, "0");
const at = (daysAgo) => new Date(NOW - daysAgo * DAY);

// A ledger-shaped sale.
function sale(o) {
  return {
    key: o.key || "k" + Math.random(), saleGroup: o.saleGroup || o.key || "g" + Math.random(), market: "gameflip",
    gameKey: "g", game: "G", at: at(5), priceUsd: 1.25, priced: true, source: "signal", login: "", logins: [], account: "", ...o,
  };
}

/* ------------------------------ demand union ------------------------------ */

test("one Twitch login is one sold account, whatever the record ids", () => {
  // Brawlhalla on prod: 82 account ids but 45 distinct logins (re-minted tokens).
  const connected = [
    { game: "G", account: oid(1), login: "marol1", at: at(3), dedupeKey: "a" },
    { game: "G", account: oid(2), login: "marol1", at: at(3), dedupeKey: "b" },
    { game: "G", account: oid(1), login: "marol1", at: at(3), dedupeKey: "c" }, // one row per drop
    { game: "G", account: oid(3), login: "other", at: at(2), dedupeKey: "d" },
  ];
  const u = G.soldUnion({ sales: [], connected, now: NOW });
  assert.strictEqual(u.get("g").size, 2);
  // The engine's own count keys on `account`, so it sees the twin twice.
  const e = G.engineCounts({ signals: [], connected: connected.map((c) => ({ ...c, gameKey: "g" })), now: NOW });
  assert.strictEqual(e.get("g").count, 3);
});

test("a sale the marketplace reported and the scanner later saw is one sale", () => {
  const sales = [sale({ key: "s1", login: "alice", at: at(10) })];
  const connected = [{ game: "G", account: oid(9), login: "alice", at: at(8), dedupeKey: "x" }];
  const u = G.soldUnion({ sales, connected, now: NOW });
  assert.strictEqual(u.get("g").size, 1);
  assert.deepStrictEqual([...[...u.get("g").values()][0].sources].sort(), ["connected", "signal"]);
});

test("a login LIST on a quantity unit is the delivery pool, not several accounts", () => {
  // saleLearning copies listing.accountLogin ("a, b, c") onto every unit sold.
  const sales = [
    sale({ key: "u0", login: "", logins: ["a", "b", "c"], at: at(10) }),
    sale({ key: "u1", login: "", logins: ["a", "b", "c"], at: at(9) }),
  ];
  const u = G.soldUnion({ sales, connected: [], now: NOW });
  assert.strictEqual(u.get("g").size, 2, "two units sold, not six accounts");
});

test("an anonymous unit merges with the buyer connection of an account from its pool", () => {
  const sales = [sale({ key: "u0", logins: ["a", "b", "c"], at: at(10) })];
  const connected = [{ game: "G", account: oid(1), login: "b", at: at(7), dedupeKey: "x" }];
  const u = G.soldUnion({ sales, connected, now: NOW });
  assert.strictEqual(u.get("g").size, 1, "one sale, seen twice");
});

test("a named sale claims its login first; the anonymous unit cannot reuse it", () => {
  const sales = [
    sale({ key: "named", login: "b", at: at(10) }),
    sale({ key: "anon", logins: ["a", "b"], at: at(9) }),
  ];
  const connected = [{ game: "G", account: oid(1), login: "b", at: at(7), dedupeKey: "x" }];
  const u = G.soldUnion({ sales, connected, now: NOW });
  assert.strictEqual(u.get("g").size, 2, "b was already sold by name; the anonymous unit is a different sale");
});

test("delivered units with no signal are demand the engine cannot see", () => {
  const sales = [1, 2, 3].map((i) => sale({ key: "unit" + i, source: "unit", market: "eldorado", login: "u" + i, at: at(i) }));
  const u = G.soldUnion({ sales, connected: [], now: NOW });
  assert.strictEqual(u.get("g").size, 3);
  const e = G.engineCounts({ signals: [], connected: [], now: NOW });
  assert.strictEqual(e.size, 0);
});

/* ------------------------------ engine replay ------------------------------ */

test("the engine replay drops the rows of a set-aside sale in EVERY game it was written for", () => {
  const lid = oid(77);
  const mk = (game) => ({ source: "listing_sold", gameKey: game, dedupeKey: `sold:${lid}:${game}:0`, priceUsd: 0.75, at: at(3), account: null });
  const signals = [mk("a"), mk("b"), { source: "listing_sold", gameKey: "a", dedupeKey: `sold:${oid(5)}:a:0`, priceUsd: 1, at: at(2), account: null }];
  const all = G.engineCounts({ signals, connected: [], now: NOW });
  const clean = G.engineCounts({ signals, connected: [], now: NOW, dropSaleKeys: new Set([lid + ":0"]) });
  assert.strictEqual(all.get("a").count, 2);
  assert.strictEqual(clean.get("a").count, 1);
  assert.strictEqual(clean.has("b"), false);
});

test("the engine replay matches the engine's window: older than 45 days is out", () => {
  const e = G.engineCounts({
    signals: [{ source: "listing_sold", gameKey: "a", dedupeKey: "d1", at: at(44) }, { source: "listing_sold", gameKey: "a", dedupeKey: "d2", at: at(46) }],
    connected: [], now: NOW,
  });
  assert.strictEqual(e.get("a").count, 1);
});

/* -------------------------------- farm advice ------------------------------ */

const SZ = { coverageDays: 28, safetyStock: 6, maxAccounts: 250 };

test("the farm target is the engine's own stock-cover arithmetic", () => {
  const f = G.farmAdvice({ perWeek: 7, listed: 10, sizing: SZ, valuePerAccount: 1.25, farmable: true });
  assert.strictEqual(f.target, farmSizing.coverageTarget({ salesPerWeek: 7, coverageDays: 28, safetyStock: 6, max: 250 }));
  assert.strictEqual(f.need, f.target - 10);
  assert.strictEqual(f.direction, "more");
});

test("accounts being farmed count against the shortfall, but only those not already holding the drops", () => {
  const without = G.farmAdvice({ perWeek: 7, listed: 10, sizing: SZ, valuePerAccount: 1, farmable: true });
  const withFlight = G.farmAdvice({ perWeek: 7, listed: 10, assignedActive: 20, sizing: SZ, valuePerAccount: 1, farmable: true });
  assert.ok(withFlight.need < without.need);
  // The assigned roster is the same pool that is later listed: 32 assigned of which 29
  // already hold the drops is 3 in flight, not 32 (Predecessor on prod).
  const f = G.farmAdvice({ perWeek: 7, listed: 4, archiveHolders: 29, assignedActive: 32, sizing: SZ, valuePerAccount: 1, farmable: true });
  assert.strictEqual(f.inFlight, 3);
  assert.strictEqual(f.onHand, 29);
});

test("stock on hand is the larger of listed and held unsold, never the sum", () => {
  assert.strictEqual(G.farmAdvice({ perWeek: 1, listed: 1, archiveHolders: 57, sizing: SZ, valuePerAccount: 1 }).onHand, 57);
  assert.strictEqual(G.farmAdvice({ perWeek: 1, listed: 127, archiveHolders: 0, sizing: SZ, valuePerAccount: 1 }).onHand, 127);
});

test("'farm more' needs a campaign to farm, a real rate and a real shortfall", () => {
  const base = { listed: 2, sizing: SZ, valuePerAccount: 1 };
  // Short, but nothing is running: wait, do not farm.
  assert.strictEqual(G.farmAdvice({ ...base, perWeek: 7, farmable: false }).direction, "wait");
  // Short and a campaign is running: more.
  assert.strictEqual(G.farmAdvice({ ...base, perWeek: 7, farmable: true }).direction, "more");
  // Short because of the safety stock alone on a tiny game: not worth a decision.
  const small = G.farmAdvice({ ...base, perWeek: 1.1, farmable: true });
  assert.strictEqual(small.direction, "hold");
  assert.ok(small.reasons.some((r) => /small game/.test(r)));
  // The engine just skipped it because the campaign ends soon: wait.
  const engineEntry = { latest: { decision: "skip_ends_soon", decidedAt: new Date(NOW - DAY), campaignName: "c" }, counts14d: { skip_ends_soon: 1 } };
  assert.strictEqual(G.farmAdvice({ ...base, perWeek: 7, farmable: true, engineEntry, now: NOW }).direction, "wait");
});

test("a game that never sold is not worth farming for sale, not even the safety stock", () => {
  const f = G.farmAdvice({ perWeek: 0, listed: 5, sizing: SZ, valuePerAccount: 0 });
  assert.strictEqual(f.target, 0);
  assert.strictEqual(f.direction, "none");
});

test("your own per-game cap beats the model, as it does in the engine", () => {
  const f = G.farmAdvice({ perWeek: 40, listed: 0, sizing: SZ, valuePerAccount: 1, gameCap: 50, farmable: true });
  assert.strictEqual(f.target, 50);
  assert.ok(f.reasons.some((r) => /Your cap/.test(r)));
});

test("a no-claim or reuse-only game gets information, never a farm instruction", () => {
  const f = G.farmAdvice({ perWeek: 60, listed: 29, sizing: SZ, valuePerAccount: 1, managed: true, managedBy: "no-claim allocator", shelfCap: 50, farmable: true });
  assert.strictEqual(f.direction, "managed");
  assert.ok(f.reasons.some((r) => /no-claim allocator/.test(r)));
  assert.ok(f.reasons.some((r) => /Shelf cap 50/.test(r)));
  const r = G.farmAdvice({ perWeek: 3, listed: 0, sizing: SZ, valuePerAccount: 1, managed: true, managedBy: "reuse-only rule", farmable: true });
  assert.strictEqual(r.direction, "managed");
  assert.ok(r.reasons.some((x) => /never spends fresh accounts/.test(x)));
});

test("an over-stocked game says so, with days of cover", () => {
  const f = G.farmAdvice({ perWeek: 1.4, listed: 127, assignedActive: 57, sizing: SZ, valuePerAccount: 1.2 });
  assert.strictEqual(f.direction, "less");
  assert.ok(f.daysCover > 500);
});

/* -------------------------------- game price -------------------------------- */

function ctxFor(sales) {
  return { sales, now: NOW, tr: A.buildTranslator(sales, NOW), curves: {} };
}
const orders = (market, prices, extra = {}) => prices.map((p, i) => sale({ key: market + i, market, priceUsd: p, at: at(3 + i), ...extra }));
const ordersMap = (...groups) => {
  const m = new Map();
  for (const arr of groups) for (const s of arr) { if (!m.has(s.market)) m.set(s.market, []); m.get(s.market).push(s); }
  return m;
};

test("a game that sold here three times is priced at what buyers paid, to the cent", () => {
  const os = orders("eldorado", [1, 1.1, 1.2]);
  const r = G.gamePrice(ctxFor(os), { gameKey: "g", market: "eldorado", orders: os, ordersByMarket: ordersMap(os), research: null, liveAsks: [] });
  assert.strictEqual(r.price, 1.1);
  assert.strictEqual(r.confidence, "medium");
  assert.match(r.basis, /sold on this market/);
});

test("with no sale here, other markets are TRANSLATED, never copied", () => {
  // gameflip pays 2.0 and ggsel 1.2 for the same 4 sets: a ratio of 0.6.
  const sales = [];
  for (let s = 0; s < 4; s += 1) {
    sales.push(sale({ key: "gf" + s, market: "gameflip", priceUsd: 2, gameKey: "g" + s, source: "signal", exact: true, contentKey: "c" + s, at: at(3 + s) }));
    sales.push(sale({ key: "gg" + s, market: "ggsel", priceUsd: 1.2, gameKey: "g" + s, source: "signal", exact: true, contentKey: "c" + s, at: at(3 + s) }));
  }
  const gf = sales.filter((x) => x.market === "gameflip").map((x) => ({ ...x, gameKey: "x" }));
  const ctx = ctxFor(sales);
  const r = G.gamePrice(ctx, { gameKey: "x", market: "ggsel", orders: [], ordersByMarket: ordersMap(gf, gf.slice(0, 1).map((x) => ({ ...x, key: "extra", saleGroup: "extra" }))), research: null, liveAsks: [] });
  assert.match(r.basis, /other markets, translated/);
  assert.ok(r.price < 1.5, "must be scaled down, not 2.00: " + r.price);
});

test("a blocked market (Digiseller) is never a price source", () => {
  const sales = orders("digiseller", [1.28, 1.28, 1.28]);
  const ctx = ctxFor(sales);
  const r = G.gamePrice(ctx, { gameKey: "g", market: "eldorado", orders: [], ordersByMarket: ordersMap(sales), research: null, liveAsks: [] });
  assert.ok(!/translated/.test(r.basis), r.basis);
});

test("other sellers are a ceiling, not a target: our proven price survives a low page", () => {
  const os = orders("gameflip", [2.5, 2.5, 2.6, 2.5]);
  const research = { markets: { gameflip: { median: 1, lowestOther: 0.75, sellers: 3, offers: 5, active: 5 } }, scannedAt: at(1) };
  const r = G.gamePrice(ctxFor(os), { gameKey: "g", market: "gameflip", orders: os, ordersByMarket: ordersMap(os), research, liveAsks: [2.5] });
  assert.ok(r.price >= 2.5, "buyers paid it four times: " + r.price);
});

test("on thin evidence the other sellers' median caps the price", () => {
  // Two sales here at $4 (low confidence, not "proven"); several sellers' page median is $1.
  const os = orders("ggsel", [4, 4]);
  const research = { markets: { ggsel: { median: 1, sellers: 4, offers: 8, active: 8, lowest: 0.5 } }, scannedAt: at(1) };
  const r = G.gamePrice(ctxFor(os), { gameKey: "g", market: "ggsel", orders: os, ordersByMarket: ordersMap(os), research, liveAsks: [] });
  assert.strictEqual(r.confidence, "low");
  assert.strictEqual(r.price, 1.5, "capped at 1.5x the page median");
  assert.strictEqual(r.clamped, "rivals");
  assert.strictEqual(r.rivalCeiling, 1.5);
});

test("the same $4 proven by three sales is NOT capped by the page median", () => {
  const os = orders("ggsel", [4, 4, 4]);
  const research = { markets: { ggsel: { median: 1, sellers: 4, offers: 8, active: 8, lowest: 0.5 } }, scannedAt: at(1) };
  const r = G.gamePrice(ctxFor(os), { gameKey: "g", market: "ggsel", orders: os, ordersByMarket: ordersMap(os), research, liveAsks: [] });
  assert.strictEqual(r.price, 4);
  assert.strictEqual(r.clamped, "");
});

test("every research page includes our own rows; only Gameflip's lowestOther excludes them", () => {
  const r = G.rivalOf({ markets: { ggsel: { median: 3.55, lowest: 0.36, sellers: 6, offers: 16, active: 16 } } }, "ggsel");
  assert.strictEqual(r.pageWide, true);
  assert.strictEqual(r.lowestOther, 0, "their `lowest` includes our rows and must never act as a rival");
  const g = G.rivalOf({ markets: { gameflip: { median: 2.99, lowestOther: 0.75, sellers: 2, offers: 26, active: 100 } } }, "gameflip");
  // Gameflip's median / sellers / offers / active still count us (Brawlhalla on prod:
  // 6 rows on the page, 4 of them ours); only lowestOther excludes our owner id.
  assert.strictEqual(g.pageWide, true);
  assert.strictEqual(g.lowestOther, 0.75);
});

test("a page that is mostly OUR rows is neither a ceiling, a test reason nor a position", () => {
  const os = orders("gameflip", [0.9, 0.9, 0.9, 0.9, 0.9, 0.9]);
  // 6 rows on the page, 4 of them ours (our live asks on this market for this game).
  const research = { markets: { gameflip: { median: 2.99, lowestOther: 0.75, sellers: 3, offers: 6, active: 6 } }, scannedAt: at(1) };
  const r = G.gamePrice(ctxFor(os), { gameKey: "g", market: "gameflip", orders: os, ordersByMarket: ordersMap(os), research, liveAsks: [1, 1, 1.25, 1.5] });
  assert.strictEqual(r.test, null);
  assert.strictEqual(r.rivalCeiling, 0);
  assert.strictEqual(r.position, "page is mostly our own rows");
  // The same page with only one of our rows on it is real evidence again.
  const r2 = G.gamePrice(ctxFor(os), { gameKey: "g", market: "gameflip", orders: os, ordersByMarket: ordersMap(os), research, liveAsks: [1.25] });
  assert.ok(r2.test && r2.test.price > r2.price);
});

test("a test rung appears only when buyers pay our price and rivals ask much more", () => {
  const os = orders("gameflip", [0.9, 0.9, 0.9, 0.9, 0.9, 0.9]);
  const research = { markets: { gameflip: { median: 2.99, lowestOther: 0.75, sellers: 3, offers: 20, active: 20 } }, scannedAt: at(1) };
  const r = G.gamePrice(ctxFor(os), { gameKey: "g", market: "gameflip", orders: os, ordersByMarket: ordersMap(os), research, liveAsks: [1.25] });
  assert.ok(r.test && r.test.price > r.price);
  assert.ok(r.test.price <= 2.99 * 0.9 + 0.01);
  const few = orders("gameflip", [0.9, 0.9]);
  const r2 = G.gamePrice(ctxFor(few), { gameKey: "g", market: "gameflip", orders: few, ordersByMarket: ordersMap(few), research, liveAsks: [1.25] });
  assert.strictEqual(r2.test, null, "two sales are not enough to test a higher price");
});

test("position against other sellers", () => {
  const os = orders("gameflip", [1, 1, 1]);
  const mk = (median, lowestOther) => ({ markets: { gameflip: { median, lowestOther, sellers: 3, offers: 9, active: 9 } }, scannedAt: at(1) });
  const pos = (research, ask) => G.gamePrice(ctxFor(os), { gameKey: "g", market: "gameflip", orders: os, ordersByMarket: ordersMap(os), research, liveAsks: [ask] }).position;
  assert.strictEqual(pos(mk(2, 0.75), 0.75), "cheapest");
  assert.strictEqual(pos(mk(2, 0.5), 1), "below the page");
  assert.strictEqual(pos(mk(1, 0.5), 1.1), "at the page");
  assert.strictEqual(pos(mk(1, 0.5), 2), "above the page");
});

/* ---------------------------------- stock ---------------------------------- */

test("listed units per market", () => {
  assert.strictEqual(G.listedUnits({ marketplace: "gameflip" }), 1);
  assert.strictEqual(G.listedUnits({ marketplace: "zeusx" }), 1);
  assert.strictEqual(G.listedUnits({ marketplace: "ggsel", lastStock: 7 }), 7);
  assert.strictEqual(G.listedUnits({ marketplace: "ggsel", lastStock: 0, qtyTarget: 3 }), 0, "a sold-out offer holds nothing");
  assert.strictEqual(G.listedUnits({ marketplace: "eldorado", units: [{ deliveredAt: null }, { deliveredAt: null }, { deliveredAt: new Date() }] }), 2);
});

/* ----------------------------------- board --------------------------------- */

function miniWorld() {
  const sets = [{ _id: oid(900), items: [{ itemKey: "k1", game: "Alpha", qty: 1 }] }];
  const mk = (n, o = {}) => ({
    _id: oid(n), marketplace: "gameflip", externalId: "e" + n, origin: "auto", title: "Alpha Twitch Drops (1 Item) — X", price: 1.25,
    status: "active", set: oid(900), createdAt: at(10), updatedAt: at(1), units: [], ...o,
  });
  const listings = [mk(1), mk(2), mk(3, { status: "sold" })];
  const sig = (lid, seq, o = {}) => ({ dedupeKey: `sold:${oid(lid)}:alpha:${seq}`, marketplace: "gameflip", game: "Alpha", gameKey: "alpha", priceUsd: 1.25, at: at(4), source: "listing_sold", ...o });
  return { sets, listings, signals: [sig(3, 0)], mk, sig };
}

test("the board joins demand, price, stock, other sellers and the engine's stance", () => {
  const w = miniWorld();
  const research = [{ game: "Alpha", scannedAt: at(1), salesPerWeek: 80, demandScore: 50, competitionScore: 30, opportunityScore: 40, sellers: 5, offers: 9, markets: { gameflip: { median: 2, lowestOther: 0.75, sellers: 3, offers: 8, active: 8 } } }];
  const tasks = [{ game: "Alpha", decision: "skip_low_demand", reason: "low", createdAt: at(2), decidedAt: at(2), assignedN: 0, campaignName: "C", campaignEndAt: at(-3), targetAccounts: 0, plannedAccounts: 0, coverage: { archiveHolders: 4 } }];
  const r = T.buildReport({ listings: w.listings, signals: w.signals, sets: w.sets, connected: [], research, tasks, at: new Date(NOW) });
  const g = r.games.find((x) => x.key === "alpha");
  assert.ok(g && g.own);
  assert.strictEqual(g.stock.listedUnits, 2, "two live gameflip rows");
  assert.strictEqual(g.demand.market.perWeek, 80);
  assert.strictEqual(g.farm.engine.decision, "skip_low_demand");
  assert.strictEqual(g.price.markets.gameflip.rival.lowestOther, 0.75);
  assert.ok(g.price.markets.gameflip.suggested.price > 0);
});

test("a mass-close burst shows as engine over-count, and the clean figure leaves it out", () => {
  const w = miniWorld();
  // 10 delisted ggsel listings, each closed out within a second of its signal.
  for (let i = 10; i < 20; i += 1) {
    w.listings.push(w.mk(i, { marketplace: "ggsel", status: "delisted", updatedAt: new Date(at(2).getTime() + i * 1000 + 500) }));
    w.signals.push(w.sig(i, 0, { marketplace: "ggsel", at: new Date(at(2).getTime() + i * 1000), priceUsd: 0.75 }));
  }
  const r = T.buildReport({ listings: w.listings, signals: w.signals, sets: w.sets, connected: [], research: [], tasks: [], at: new Date(NOW) });
  const g = r.games.find((x) => x.key === "alpha");
  assert.strictEqual(g.demand.engine.count45, 11, "the engine counts all of them");
  assert.strictEqual(g.demand.engineClean.count45, 1);
  assert.strictEqual(g.demand.units45, 1);
  assert.ok(g.flags.some((f) => f.id === "inflated-demand"));
});

test("no assigned account login ever leaves the board", () => {
  const w = miniWorld();
  const tasks = [{ game: "Alpha", decision: "farm", createdAt: at(1), assignedN: 3, assignedAccounts: ["secretlogin1", "secretlogin2"], campaignEndAt: at(-2), campaignName: "C" }];
  const r = T.buildReport({ listings: w.listings, signals: w.signals, sets: w.sets, connected: [], research: [], tasks, at: new Date(NOW) });
  const blob = JSON.stringify(r.games) + JSON.stringify([...r.taskHistory.entries()]);
  assert.ok(!/secretlogin/.test(blob));
});

test("no-claim games are marked managed from settings or from the research flag", () => {
  const w = miniWorld();
  const base = { listings: w.listings, signals: w.signals, sets: w.sets, connected: [], research: [{ game: "Alpha", scannedAt: at(1), markets: {}, noClaim: true }], tasks: [], at: new Date(NOW) };
  assert.strictEqual(T.buildReport(base).games.find((x) => x.key === "alpha").farm.direction, "managed");
  const b2 = { ...base, research: [] };
  assert.strictEqual(T.buildReport(b2, { noClaimGames: ["alph"] }).games.find((x) => x.key === "alpha").farm.direction, "managed");
});

test("farmFor hands an engine the advice for one game, and null for an unknown one", () => {
  const w = miniWorld();
  const r = T.buildReport({ listings: w.listings, signals: w.signals, sets: w.sets, connected: [], research: [], tasks: [], at: new Date(NOW) });
  assert.ok(T.farmFor(r, "Alpha"));
  assert.strictEqual(T.farmFor(r, "No Such Game"), null);
});

test("suggestForNew prefers the better-evidenced of set-level and game-level", () => {
  const w = miniWorld();
  const r = T.buildReport({ listings: w.listings, signals: w.signals, sets: w.sets, connected: [], research: [], tasks: [], at: new Date(NOW) });
  const s = T.suggestForNew(r, { market: "gameflip", game: "Alpha", itemCount: 1 });
  assert.ok(s.price > 0);
  assert.ok(["set", "game"].includes(s.source));
  assert.strictEqual(T.suggestForNew(r, { market: "digiseller", game: "Alpha" }).action, "blocked");
});

/* --------------------------------- the seam --------------------------------- */

const reportFixture = () => {
  const w = miniWorld();
  return T.buildReport({ listings: w.listings, signals: w.signals, sets: w.sets, connected: [], research: [], tasks: [], at: new Date(NOW) });
};
const Q = { marketplace: "eldorado", basePriceUsd: 1.5, title: "Alpha Twitch Drops (1 Item) — X", game: "Alpha", itemCount: 1 };

test("mode off (the default) returns the base price and never asks for a report", async () => {
  attach.reset();
  let asked = false;
  const r = await attach.priceForNew(Q, { getConfig: () => attach.normalise({}), getReport: async () => { asked = true; return null; } });
  assert.strictEqual(r.price, 1.5);
  assert.strictEqual(r.applied, false);
  assert.strictEqual(asked, false);
  assert.strictEqual(attach.shadowSnapshot().stats.total, 0);
});

test("settings garbage falls back to off", () => {
  assert.strictEqual(attach.normalise({ mode: "yolo" }).mode, "off");
  assert.strictEqual(attach.normalise(null).mode, "off");
  assert.deepStrictEqual(attach.normalise({ mode: "apply", markets: ["nope", "eldorado", "Eldorado"] }).markets, ["eldorado"]);
  assert.strictEqual(attach.normalise({ maxDeviationPct: 5000 }).maxDeviationPct, 35);
  assert.strictEqual(attach.normalise({ minConfidence: "low" }).minConfidence, "medium", "low confidence can never be the bar");
});

test("shadow mode logs the comparison and still returns the BASE price", async () => {
  attach.reset();
  const logs = [];
  const r = await attach.priceForNew(Q, { getConfig: () => attach.normalise({ mode: "shadow" }), getReport: async () => reportFixture(), log: (m) => logs.push(m) });
  assert.strictEqual(r.price, 1.5);
  assert.strictEqual(r.applied, false);
  assert.strictEqual(attach.shadowSnapshot().stats.total, 1);
  assert.strictEqual(attach.shadowSnapshot().recent[0].market, "eldorado");
  assert.ok(logs[0].startsWith("[priceTracker:shadow]"));
});

test("apply mode changes nothing on a market that is not allowlisted", async () => {
  attach.reset();
  const r = await attach.priceForNew(Q, { getConfig: () => attach.normalise({ mode: "apply", markets: ["ggsel"] }), getReport: async () => reportFixture(), log: () => {} });
  assert.strictEqual(r.price, 1.5);
  assert.strictEqual(r.applied, false);
  assert.match(r.reason, /allowlist/);
});

test("apply mode needs medium confidence and never applies the engine fallback", async () => {
  attach.reset();
  const lowReport = { games: [], ctx: reportFixture().ctx, board: [], advice: [] };
  const r = await attach.priceForNew(Q, { getConfig: () => attach.normalise({ mode: "apply", markets: ["eldorado"] }), getReport: async () => lowReport, log: () => {} });
  assert.strictEqual(r.price, 1.5);
  assert.strictEqual(r.applied, false);
});

test("apply mode moves a price within the guard and clamps a bigger move to the step", async () => {
  attach.reset();
  // Three sales of this game on eldorado at $0.75 against a $1.50 base: the tracker
  // says $0.75 (medium), a 50% cut, which the 35% guard clamps to $0.98.
  const w = miniWorld();
  const sales = [1, 2, 3].map((i) => ({ ...w.signals[0], dedupeKey: `sold:${oid(40 + i)}:alpha:0`, marketplace: "eldorado", priceUsd: 0.75, at: at(i + 1) }));
  const listings = [...w.listings, ...[1, 2, 3].map((i) => w.mk(40 + i, { marketplace: "eldorado", status: "sold", price: 0.75 }))];
  const report = T.buildReport({ listings, signals: sales, sets: w.sets, connected: [], research: [], tasks: [], at: new Date(NOW) });
  const r = await attach.priceForNew(Q, { getConfig: () => attach.normalise({ mode: "apply", markets: ["eldorado"], maxDeviationPct: 35 }), getReport: async () => report, log: () => {} });
  assert.strictEqual(r.applied, true, r.reason);
  assert.strictEqual(r.price, 0.98);
  // A wider guard lets the full move through.
  attach.reset();
  const wide = await attach.priceForNew(Q, { getConfig: () => attach.normalise({ mode: "apply", markets: ["eldorado"], maxDeviationPct: 60 }), getReport: async () => report, log: () => {} });
  assert.strictEqual(wide.price, 0.75);
});

test("apply never goes below the market floor or the set's own minimum", async () => {
  attach.reset();
  const report = reportFixture();
  const r = await attach.priceForNew({ ...Q, marketplace: "playerauctions", basePriceUsd: 5, minPriceUsd: 5 }, { getConfig: () => attach.normalise({ mode: "apply", markets: ["playerauctions"] }), getReport: async () => report, log: () => {} });
  assert.ok(r.price >= 5);
});

test("rent-farm titles and blocked markets are never touched, in any mode", async () => {
  attach.reset();
  const cfg = () => attach.normalise({ mode: "apply", markets: ["eldorado", "digiseller"] });
  const farm = await attach.priceForNew({ ...Q, title: "Alpha Automatic Farming 30 days", basePriceUsd: 6 }, { getConfig: cfg, getReport: async () => reportFixture(), log: () => {} });
  assert.strictEqual(farm.price, 6);
  assert.match(farm.reason, /rent-farm/);
  const blocked = await attach.priceForNew({ ...Q, marketplace: "digiseller" }, { getConfig: cfg, getReport: async () => reportFixture(), log: () => {} });
  assert.strictEqual(blocked.price, 1.5);
  assert.match(blocked.reason, /blocked/);
});

test("every failure returns the base price: no report, a throw, a malformed answer", async () => {
  attach.reset();
  const cfg = () => attach.normalise({ mode: "apply", markets: ["eldorado"] });
  const none = await attach.priceForNew(Q, { getConfig: cfg, getReport: async () => null, log: () => {} });
  assert.strictEqual(none.price, 1.5);
  const boom = await attach.priceForNew(Q, { getConfig: cfg, getReport: async () => { throw new Error("db down"); }, log: () => {} });
  assert.strictEqual(boom.price, 1.5);
  assert.match(boom.reason, /tracker error/);
  const junk = await attach.priceForNew(Q, { getConfig: cfg, getReport: async () => ({ ctx: null }), log: () => {} });
  assert.strictEqual(junk.price, 1.5);
  const noBase = await attach.priceForNew({ ...Q, basePriceUsd: 0 }, { getConfig: cfg, getReport: async () => reportFixture() });
  assert.strictEqual(noBase.price, 0);
  const noCfg = await attach.priceForNew(Q, { getConfig: () => { throw new Error("settings unreadable"); } });
  assert.strictEqual(noCfg.price, 1.5);
});

/* ---------------------------------- read-only ------------------------------- */

test("games.js and attach.js never write and never call a marketplace", () => {
  for (const f of ["games", "attach"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "utils", "priceTracker", f + ".js"), "utf8").replace(/\/\/.*$/gm, "");
    for (const bad of [/\.save\(/, /\.create\(/, /updateOne|updateMany|findOneAndUpdate/, /insertMany|deleteOne|deleteMany|bulkWrite/, /require\([^)]*marketplaces[^)]*\)/, /axios/, /saveSettings|setAutoFarm/]) {
      assert.ok(!bad.test(src), f + ".js matches " + bad);
    }
  }
});

test("the loader reads the research and the engine's tasks with bounds, and never the logins", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "priceTracker", "index.js"), "utf8");
  assert.match(src, /\$size: \{ \$ifNull: \["\$assignedAccounts", \[\]\] \}/);
  assert.ok(!/assignedAccounts: 1/.test(src), "assignedAccounts itself must not be projected out of the database");
  assert.ok(!/allowDiskUse/.test(src));
  assert.match(src, /\$limit: 4000/);
});

test("buildLedger exposes the keys the engine replay needs", () => {
  const w = miniWorld();
  const L = buildLedger({ listings: w.listings, signals: w.signals, sets: w.sets });
  assert.ok(L.suspectSaleKeys instanceof Set);
});

test("the auto-farm hook script still anchors on utils/autoLister.js, applies once, and leaves valid code", () => {
  const cp = require("child_process");
  const os = require("os");
  const tmp = path.join(os.tmpdir(), "autoLister_hook_test_" + process.pid + ".js");
  fs.copyFileSync(path.join(__dirname, "..", "utils", "autoLister.js"), tmp);
  const script = path.join(__dirname, "..", "scripts", "apply-price-tracker-hook.js");
  try {
    const dry = cp.spawnSync(process.execPath, [script, tmp], { encoding: "utf8" });
    assert.strictEqual(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /every anchor matched exactly once/);
    assert.strictEqual(fs.readFileSync(tmp, "utf8").includes("async function trackerPrice("), false, "a dry run writes nothing");
    const w = cp.spawnSync(process.execPath, [script, tmp, "--write"], { encoding: "utf8" });
    assert.strictEqual(w.status, 0, w.stderr);
    const out = fs.readFileSync(tmp, "utf8");
    assert.strictEqual((out.match(/trackerPrice\("/g) || []).length, 5, "ggsel, zeusx, eldorado, g2g, playerauctions");
    assert.ok(!/trackerPrice\("(gameflip|digiseller)"/.test(out), "gameflip is the base price and digiseller is blocked");
    assert.strictEqual(cp.spawnSync(process.execPath, ["--check", tmp]).status, 0, "patched file is valid JavaScript");
    const again = cp.spawnSync(process.execPath, [script, tmp, "--write"], { encoding: "utf8" });
    assert.match(again.stdout, /already applied/);
    assert.strictEqual(fs.readFileSync(tmp, "utf8"), out, "idempotent");
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test("a patched publisher can never be stopped by the tracker", async () => {
  // The helper as the script writes it: every path returns the base price.
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "apply-price-tracker-hook.js"), "utf8");
  const m = /const HELPER = `([\s\S]*?)`;/.exec(src);
  assert.ok(m, "helper text found");
  const body = m[1].replace(/\\`/g, "`");
  const mod = { require: (p) => { if (p === "./priceTracker/attach") throw new Error("module missing"); return require(p); } };
  const fn = new Function("require", body + "; return trackerPrice;")(mod.require);
  assert.strictEqual(await fn("eldorado", 1.5, { title: "t", game: "g", set: { items: [{ itemKey: "a", game: "g", qty: 1 }] } }), 1.5, "module absent -> base price");
  const fn2 = new Function("require", body + "; return trackerPrice;")(() => ({ priceForNew: async () => { throw new Error("boom"); } }));
  assert.strictEqual(await fn2("eldorado", 1.5, {}), 1.5, "a throw -> base price");
  const fn3 = new Function("require", body + "; return trackerPrice;")(() => ({ priceForNew: async () => ({ price: 0 }) }));
  assert.strictEqual(await fn3("eldorado", 1.5, {}), 1.5, "a zero price -> base price");
  const fn4 = new Function("require", body + "; return trackerPrice;")(() => ({ priceForNew: async () => ({ price: 1.1 }) }));
  assert.strictEqual(await fn4("eldorado", 1.5, {}), 1.1);
});

/* ------------------------- fixes from the second review ------------------------ */

test("the platform floor is applied last: a rival ceiling can never push a price below it", () => {
  // Several sellers' page median is $0.23, so a 1.5x ceiling is $0.35: below GGSel's $0.75 floor.
  const os = orders("ggsel", [1, 1]);
  const research = { markets: { ggsel: { median: 0.23, sellers: 4, offers: 8, active: 40, lowest: 0.2 } }, scannedAt: at(1) };
  const r = G.gamePrice(ctxFor(os), { gameKey: "g", market: "ggsel", orders: os, ordersByMarket: ordersMap(os), research, liveAsks: [] });
  assert.ok(r.price >= r.floor, "price " + r.price + " floor " + r.floor);
  assert.strictEqual(r.price, 0.75);
});

test("a cap is rounded DOWN, never to a nickel above itself", () => {
  // rival median 1.49 -> ceiling 2.2350 -> $2.20 (not $2.25)
  const os = orders("ggsel", [4, 4]);
  const research = { markets: { ggsel: { median: 1.49, sellers: 4, offers: 8, active: 40, lowest: 0.5 } }, scannedAt: at(1) };
  const r = G.gamePrice(ctxFor(os), { gameKey: "g", market: "ggsel", orders: os, ordersByMarket: ordersMap(os), research, liveAsks: [] });
  assert.ok(r.price <= r.rivalCeiling + 1e-9, r.price + " vs " + r.rivalCeiling);
});

test("evidence that is only the listing's price NOW is medium at best and never waives the caps", () => {
  // Eldorado stores no price at delivery. Ten units "sold" at $2.33 on a venue whose p75 is far lower.
  const approx = orders("eldorado", [2.33, 2.33, 2.33, 2.33, 2.33, 2.33, 2.33, 2.33, 2.33, 2.33], { priceBasis: "listing-now" });
  const reported = orders("gameflip", [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], { priceBasis: "reported" });
  const r = G.gamePrice(ctxFor([...approx, ...reported]), { gameKey: "g", market: "eldorado", orders: approx, ordersByMarket: ordersMap(approx), research: null, liveAsks: [] });
  assert.strictEqual(r.confidence, "medium", "never high on listing-now prices");
  assert.ok(r.reasons.some((x) => /listing's price now/.test(x)));
  const rep = orders("gameflip", [2.33, 2.33, 2.33, 2.33, 2.33, 2.33, 2.33, 2.33], { priceBasis: "reported" });
  const r2 = G.gamePrice(ctxFor(rep), { gameKey: "g", market: "gameflip", orders: rep, ordersByMarket: ordersMap(rep), research: null, liveAsks: [] });
  assert.strictEqual(r2.confidence, "high", "the same evidence recorded AT the sale is high");
});

test("a unit with a login pool is anonymous even when it also carries an account id", () => {
  // A quantity listing's `accountId` is one of its accounts, copied onto every unit it sells.
  const sales = [0, 1, 2, 3].map((i) => sale({ key: "u" + i, account: oid(5), logins: ["a", "b", "c"], login: "", at: at(10 - i) }));
  const u = G.soldUnion({ sales, connected: [], now: NOW });
  assert.strictEqual(u.get("g").size, 4, "four units sold, not one account");
});

test("bulk-pack deliveries are demand (accounts consumed) and never price evidence", () => {
  const sets = [{ _id: oid(900), items: [{ itemKey: "k1", game: "Alpha", qty: 1 }] }];
  const bulk = {
    _id: oid(1), marketplace: "eldorado", externalId: "e1", origin: "auto", title: "Alpha Twitch Drops — PACK OF 5 ACCOUNTS", price: 4, status: "active",
    set: oid(900), bulkOfferId: oid(77), createdAt: at(10), updatedAt: at(1),
    units: [1, 2, 3].map((i) => ({ orderId: "O" + i, deliveredAt: at(i), login: "pk" + i })),
  };
  const L = buildLedger({ listings: [bulk], signals: [], sets });
  assert.strictEqual(L.sales.length, 0, "no price evidence");
  assert.strictEqual(L.demandOnly.length, 3);
  assert.ok(L.demandOnly.every((x) => x.priced === false && x.priceUsd === 0));
  const prepared = A.prepare({ listings: [bulk], sets, sales: [] });
  const r = G.gameBoard({ ledger: L, prepared, research: [], tasks: [], signals: [], connected: [], now: NOW, fees: {}, ctx: { sales: [], now: NOW, tr: A.buildTranslator([], NOW), curves: {} } });
  const g = r.find((x) => x.key === "alpha");
  assert.strictEqual(g.demand.units45, 3);
  assert.strictEqual(g.price.realised.n, 0, "and no realised price");
});

test("per-game caps match by substring, like the engine's gameMapLookup", () => {
  const w = miniWorld();
  const r = T.buildReport({ listings: w.listings, signals: w.signals, sets: w.sets, connected: [], research: [], tasks: [], at: new Date(NOW) }, { gameCaps: { alp: 2 } });
  assert.strictEqual(r.games.find((x) => x.key === "alpha").farm.gameCap, 2);
});

test("a game on the reuse-only list is managed, not instructed", () => {
  const w = miniWorld();
  const r = T.buildReport({ listings: w.listings, signals: w.signals, sets: w.sets, connected: [], research: [], tasks: [], at: new Date(NOW) }, { reuseOnlyGames: ["Alpha"] });
  const g = r.games.find((x) => x.key === "alpha");
  assert.strictEqual(g.farm.direction, "managed");
  assert.strictEqual(g.farm.managedBy, "reuse-only rule");
});

test("a campaign that is running makes a game farmable; research whose campaign already ended does not", () => {
  const w = miniWorld();
  const mkRs = (endAt, active) => [{ game: "Alpha", scannedAt: at(1), markets: {}, campaign: { active, upcoming: false, endAt } }];
  const run = (research) => T.buildReport({ listings: w.listings, signals: w.signals, sets: w.sets, connected: [], research, tasks: [], at: new Date(NOW) }).games.find((x) => x.key === "alpha").farm.farmable;
  assert.strictEqual(run(mkRs(at(-3), true)), true);
  assert.strictEqual(run(mkRs(at(1), true)), false, "stale research: the campaign ended yesterday");
  assert.strictEqual(run([]), false);
});

test("a background refresh rebuilds with the SAME settings as the page, never defaults", async () => {
  T.invalidate();
  T.setSettingsProvider(() => ({ gameCaps: { alpha: 2 }, fees: { gameflip: 0 }, noClaimGames: [] }));
  const w = miniWorld();
  const fixture = { listings: w.listings, signals: w.signals, sets: w.sets, connected: [], research: [], tasks: [], at: new Date(NOW) };
  const loader = async () => fixture;
  try {
    const first = await T.getReport({ force: true, loader });
    assert.strictEqual(first.games.find((x) => x.key === "alpha").farm.gameCap, 2);
    // Age the cache past its lifetime, then ask the way a publisher does.
    const realNow = Date.now;
    Date.now = () => realNow() + T.CACHE_MS + 1000;
    try {
      const stale = await T.getReportSWR({ loader });
      assert.strictEqual(stale, first, "the stale report is served at once");
      await new Promise((r) => setTimeout(r, 80));
      const refreshed = await T.getReport({ loader });
      assert.notStrictEqual(refreshed, first, "and it was refreshed in the background");
      assert.strictEqual(refreshed.games.find((x) => x.key === "alpha").farm.gameCap, 2, "with the same settings");
    } finally {
      Date.now = realNow;
    }
  } finally {
    T.setSettingsProvider(null);
    T.invalidate();
  }
});

test("the report builder yields between phases, and the async and sync results agree", async () => {
  const w = miniWorld();
  const input = { listings: w.listings, signals: w.signals, sets: w.sets, connected: [], research: [], tasks: [], at: new Date(NOW) };
  let yields = 0;
  const it = T._reportSteps(input, {});
  let r = it.next();
  while (!r.done) {
    yields += 1;
    r = it.next();
  }
  assert.ok(yields >= 4, "phases: " + yields);
  const sync = T.buildReport(input);
  const asyncR = await T.buildReportAsync(input);
  assert.deepStrictEqual(asyncR.games.map((g) => [g.key, g.demand.units45, g.farm.target]), sync.games.map((g) => [g.key, g.demand.units45, g.farm.target]));
});

test("GGSel prices are only ever raised, never lowered, in apply mode", async () => {
  attach.reset();
  const w = miniWorld();
  const sales = [1, 2, 3].map((i) => ({ ...w.signals[0], dedupeKey: `sold:${oid(40 + i)}:alpha:0`, marketplace: "ggsel", priceUsd: 0.75, at: at(i + 1) }));
  const listings = [...w.listings, ...[1, 2, 3].map((i) => w.mk(40 + i, { marketplace: "ggsel", status: "sold", price: 0.75 }))];
  const report = T.buildReport({ listings, signals: sales, sets: w.sets, connected: [], research: [], tasks: [], at: new Date(NOW) });
  const cfg = () => attach.normalise({ mode: "apply", markets: ["ggsel"], maxDeviationPct: 60 });
  const lower = await attach.priceForNew({ ...Q, marketplace: "ggsel", basePriceUsd: 1.5 }, { getConfig: cfg, getReport: async () => report, log: () => {} });
  assert.strictEqual(lower.price, 1.5, "the tracker says lower; GGSel's undisclosed category minimum makes that unsafe");
  assert.strictEqual(lower.applied, false);
  assert.match(lower.reason, /never lowered/);
  const higher = await attach.priceForNew({ ...Q, marketplace: "ggsel", basePriceUsd: 0.75 }, { getConfig: () => attach.normalise({ mode: "apply", markets: ["ggsel"], maxDeviationPct: 60, minConfidence: "medium" }), getReport: async () => ({ ...report, games: [] }), log: () => {} });
  assert.ok(higher.price >= 0.75);
});

/* --------------------------------- the routes -------------------------------- */

async function withRouter(report, fn) {
  const express = require("express");
  const createRouter = require("../routes/priceTrackerRoutes");
  const app = express();
  app.use(createRouter({ getReport: async () => report }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    return await fn("http://127.0.0.1:" + server.address().port);
  } finally {
    server.close();
  }
}

test("routes: an odd sort key falls back instead of crashing, and 'cover' is least-cover-first with unknowns last", async () => {
  const w = miniWorld();
  const report = T.buildReport({ listings: w.listings, signals: w.signals, sets: w.sets, connected: [], research: [], tasks: [], at: new Date(NOW) });
  await withRouter(report, async (base) => {
    for (const sort of ["__proto__", "constructor", "toString", "nope"]) {
      const r = await fetch(base + "/api/price-tracker/games?scope=all&sort=" + sort);
      assert.strictEqual(r.status, 200, sort);
    }
    const j = await (await fetch(base + "/api/price-tracker/games?scope=all&sort=cover")).json();
    const covers = j.rows.map((x) => x.daysCover);
    const known = covers.filter((c) => c != null);
    assert.deepStrictEqual(known, [...known].sort((a, b) => a - b), "least cover first");
    const firstNull = covers.indexOf(null);
    if (firstNull >= 0) assert.ok(covers.slice(firstNull).every((c) => c == null), "games with no known cover come last");
  });
});

test("routes: managed games never lead the shortfall ranking", async () => {
  const w = miniWorld();
  const report = T.buildReport({ listings: w.listings, signals: w.signals, sets: w.sets, connected: [], research: [], tasks: [], at: new Date(NOW) }, { reuseOnlyGames: ["Alpha"] });
  await withRouter(report, async (base) => {
    const j = await (await fetch(base + "/api/price-tracker/games?scope=all&sort=need")).json();
    const alpha = j.rows.find((x) => x.key === "alpha");
    assert.strictEqual(alpha.direction, "managed");
  });
});

test("routes: no login, login pool, account id or dedupe key ever reaches the browser", async () => {
  const w = miniWorld();
  w.signals[0].login = "secretlogin1, secretlogin2";
  w.signals[0].account = oid(33);
  const hand = { dedupeKey: `manual-sold:${oid(8)}:alpha`, marketplace: "", game: "Alpha", gameKey: "alpha", name: "m", priceUsd: 1, at: at(2), login: "handlogin", account: oid(34), source: "listing_sold" };
  const report = T.buildReport({ listings: w.listings, signals: [...w.signals, hand], sets: w.sets, connected: [{ game: "Alpha", gameKey: "alpha", account: oid(35), login: "connlogin", at: at(2), dedupeKey: "c1" }], research: [], tasks: [], at: new Date(NOW) });
  await withRouter(report, async (base) => {
    const bodies = [];
    for (const p of ["/api/price-tracker/sales?limit=200", "/api/price-tracker/game/alpha", "/api/price-tracker/games?scope=all", "/api/price-tracker/overview", "/api/price-tracker/advice?action=hold&limit=200", "/api/price-tracker/sets?evidence=all&limit=200"]) {
      bodies.push(await (await fetch(base + p)).text());
    }
    const blob = bodies.join("\n");
    for (const needle of ["secretlogin", "handlogin", "connlogin", oid(33), oid(34), oid(35), "dedupeKey", "\"logins\"", "\"login\""]) {
      assert.ok(!blob.includes(needle), "leaked: " + needle);
    }
  });
});
