// The price tracker: exact identity, an honest sale ledger, and advice that
// refuses to guess. Every test here pins a mistake this shop has already made
// (see the comments in utils/priceTracker/*.js) or a rule the owner stated.
/* global fetch */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { identify } = require("../utils/priceTracker/setIdentity");
const { buildLedger } = require("../utils/priceTracker/ledger");
const A = require("../utils/priceTracker/analyze");
const T = require("../utils/priceTracker");
const { median, wilson } = require("../utils/priceTracker/stats");

const NOW = Date.parse("2026-10-01T00:00:00Z");
const DAY = 86400000;
const oid = (n) => String(n).padStart(24, "0");
const items = (...xs) => xs.map(([itemKey, qty = 1, game = "G"]) => ({ itemKey, qty, game }));

/* ------------------------------ identity ----------------------------- */

test("the same items are the same product whatever the set id or item order", () => {
  const a = identify({ title: "G Twitch Drops (2 Items) — A + B" }, { items: items(["x"], ["y"]) });
  const b = identify({ title: "G Twitch Drops (2 Items) — B + A" }, { items: items(["y"], ["x"]) });
  assert.strictEqual(a.contentKey, b.contentKey);
  assert.ok(a.exact);
});

test("different quantities are different products", () => {
  const one = identify({ title: "G Twitch Drops (2 Items)" }, { items: items(["x", 1]) });
  const two = identify({ title: "G Twitch Drops (2 Items)" }, { items: items(["x", 2]) });
  assert.notStrictEqual(one.contentKey, two.contentKey);
});

test("a title that counts REWARDS (quantity included) is not a mismatch", () => {
  // "(7 Items) — 6x Esports Pack + 1 Clanker" is 7 rewards over 2 distinct items.
  const r = identify(
    { title: "R6 Twitch Drops (7 Items) — 6× Pack + Clanker" },
    { items: items(["pack", 6], ["clanker", 1]) },
  );
  assert.strictEqual(r.itemCount, 2);
  assert.strictEqual(r.rewardCount, 7);
  assert.strictEqual(r.titleMismatch, false);
  assert.ok(r.exact);
});

test("a title that matches neither count is drift, and is not an exact match", () => {
  const r = identify({ title: "G Twitch Drops (3 Items)" }, { items: items(["a"], ["b"], ["c"], ["d"], ["e"]) });
  assert.strictEqual(r.titleMismatch, true);
  assert.strictEqual(r.exact, false);
  assert.match(r.bandKey, /\|2-3$/, "banded by what the buyer was told");
});

test("rent-farm and bulk rows are not drop bundles", () => {
  assert.strictEqual(identify({ title: "G Automatic Farming 30 days" }, null).kind, "farm");
  assert.strictEqual(identify({ title: "G Twitch Drops (1 Item)", rentFarm: true }, null).kind, "farm");
  assert.strictEqual(identify({ title: "G Twitch Drops (1 Item)", bulkOfferId: oid(1) }, null).kind, "bulk");
});

test("a set-less row falls back to its title and is never exact", () => {
  const r = identify({ title: "Albion Online Twitch Drops (2 Items) — A + B" }, null);
  assert.strictEqual(r.basis, "title");
  assert.strictEqual(r.exact, false);
  assert.strictEqual(r.game, "Albion Online");
});

/* ------------------------------- ledger ------------------------------ */

function listing(n, o = {}) {
  return {
    _id: oid(n), marketplace: "gameflip", externalId: "ext" + n, origin: "auto",
    title: "G Twitch Drops (1 Item) — X", price: 1.25, status: "active", set: oid(900),
    createdAt: new Date(NOW - 10 * DAY), updatedAt: new Date(NOW - 1 * DAY), units: [], ...o,
  };
}
const SET = { _id: oid(900), items: items(["x"]) };
function sig(lid, game, seq, o = {}) {
  return {
    dedupeKey: `sold:${oid(lid)}:${game}:${seq}`, marketplace: "gameflip", game, gameKey: game,
    name: "n", priceUsd: 1.25, at: new Date(NOW - 5 * DAY), ...o,
  };
}

test("a sale written once per game is ONE sale", () => {
  const { sales, excluded } = buildLedger({
    listings: [listing(1)], sets: [SET],
    signals: [sig(1, "a", 0), sig(1, "b", 0), sig(1, "c", 0)],
  });
  assert.strictEqual(sales.length, 1);
  assert.strictEqual(excluded.duplicate, 2);
});

test("delivered units are sales with order ids, priced at the listing's price NOW", () => {
  const l = listing(2, { marketplace: "eldorado", units: [{ orderId: "O1", deliveredAt: new Date(NOW - DAY) }, { orderId: "", deliveredAt: null }] });
  const { sales } = buildLedger({ listings: [l], sets: [SET], signals: [] });
  assert.strictEqual(sales.length, 1);
  assert.strictEqual(sales[0].orderId, "O1");
  assert.strictEqual(sales[0].priceBasis, "listing-now");
});

test("a signal for a listing already counted from its units does not count twice", () => {
  const l = listing(3, { marketplace: "eldorado", units: [{ orderId: "O1", deliveredAt: new Date(NOW - DAY) }] });
  const { sales } = buildLedger({ listings: [l], sets: [SET], signals: [sig(3, "g", 0, { marketplace: "eldorado" })] });
  assert.strictEqual(sales.length, 1);
});

test("rent-farm windows and bulk packs never enter the ledger, and are counted", () => {
  const farm = listing(4, { title: "G Automatic Farming 30 days", price: 8 });
  const bulk = listing(5, { bulkOfferId: oid(77) });
  const { sales, excluded } = buildLedger({
    listings: [farm, bulk], sets: [SET],
    signals: [sig(4, "g", 0, { priceUsd: 8 }), sig(5, "g", 0)],
  });
  assert.strictEqual(sales.length, 0);
  assert.strictEqual(excluded.farm, 1);
  assert.strictEqual(excluded.bulk, 1);
});

test("a delist that closes out stock in a burst is NOT sales", () => {
  // 10 listings delisted within a second of their signals, same hour.
  const ls = [];
  const sg = [];
  for (let i = 10; i < 20; i += 1) {
    const at = new Date(NOW - 2 * DAY + i * 1000);
    ls.push(listing(i, { marketplace: "ggsel", status: "delisted", updatedAt: new Date(at.getTime() + 1000) }));
    sg.push(sig(i, "g", 0, { marketplace: "ggsel", at, priceUsd: 0.75 }));
  }
  const { sales, suspect, excluded } = buildLedger({ listings: ls, sets: [SET], signals: sg });
  assert.strictEqual(sales.length, 0);
  assert.strictEqual(suspect.length, 10);
  assert.strictEqual(excluded.massClose, 10);
});

test("one real sale on a listing delisted soon after still counts", () => {
  const at = new Date(NOW - 2 * DAY);
  const l = listing(30, { marketplace: "ggsel", status: "delisted", updatedAt: new Date(at.getTime() + 1000) });
  const { sales, suspect } = buildLedger({ listings: [l], sets: [SET], signals: [sig(30, "g", 0, { marketplace: "ggsel", at })] });
  assert.strictEqual(sales.length, 1);
  assert.strictEqual(suspect.length, 0);
});

test("a burst of sale signals within minutes is a bulk mark-sold, not purchases", () => {
  // Gameflip 2026-09-08: 25 signals ~1 second apart on manual rows.
  const ls = [];
  const sg = [];
  for (let i = 40; i < 55; i += 1) {
    ls.push(listing(i, { status: "sold" }));
    sg.push(sig(i, "g", 0, { at: new Date(NOW - 3 * DAY + i * 1000), priceUsd: 1 + (i % 4) * 0.25 }));
  }
  const { sales, suspect } = buildLedger({ listings: ls, sets: [SET], signals: sg });
  assert.strictEqual(sales.length, 0);
  assert.strictEqual(suspect.length, 15);
});

test("the same number of sales spread over hours is real", () => {
  const ls = [];
  const sg = [];
  for (let i = 40; i < 55; i += 1) {
    ls.push(listing(i, { status: "sold" }));
    sg.push(sig(i, "g", 0, { at: new Date(NOW - 3 * DAY + i * 3600 * 1000), priceUsd: 1.25 }));
  }
  const { sales, suspect } = buildLedger({ listings: ls, sets: [SET], signals: sg });
  assert.strictEqual(sales.length, 15);
  assert.strictEqual(suspect.length, 0);
});

test("several units of ONE order are one piece of price evidence", () => {
  const l = listing(60, { marketplace: "eldorado", units: [1, 2, 3, 4].map(() => ({ orderId: "ONE", deliveredAt: new Date(NOW - DAY) })) });
  const { sales } = buildLedger({ listings: [l], sets: [SET], signals: [] });
  assert.strictEqual(sales.length, 4, "four accounts were sold");
  assert.strictEqual(new Set(sales.map((x) => x.key)).size, 4, "each unit has its own key");
  assert.strictEqual(new Set(sales.map((x) => x.saleGroup)).size, 1, "but it is one order");
  const prepared = A.prepare({ listings: [l], sets: [SET], sales });
  const v = A.venueSummary({ sales, prepared, now: NOW, fees: {} }).find((x) => x.market === "eldorado");
  assert.strictEqual(v.sales.total, 4);
  assert.strictEqual(v.sales.orders, 1);
  assert.strictEqual(v.realised.n, 1);
});

test("one account sold in two games is two hand sales", () => {
  const mk = (game) => ({ dedupeKey: `manual-sold:${oid(8)}:${game}`, marketplace: "", game, gameKey: game, name: "m", priceUsd: 1, at: new Date(NOW - DAY) });
  const { sales } = buildLedger({ listings: [], sets: [], signals: [mk("overwatch"), mk("fortnite")] });
  assert.strictEqual(sales.length, 2);
});

test("a hand sale is kept as demand for a game with no market", () => {
  const { sales } = buildLedger({
    listings: [], sets: [],
    signals: [{ dedupeKey: `manual-sold:${oid(8)}:overwatch`, marketplace: "", game: "Overwatch", gameKey: "overwatch", name: "manual sale", priceUsd: 0, at: new Date(NOW - DAY) }],
  });
  assert.strictEqual(sales.length, 1);
  assert.strictEqual(sales[0].market, "unknown");
  assert.strictEqual(sales[0].priced, false);
});

/* ------------------------------ analysis ------------------------------ */

// Two markets selling the SAME three sets, ggsel at ~0.6x gameflip.
function twoMarketWorld() {
  const sets = [];
  const listings = [];
  const signals = [];
  let n = 100;
  for (let s = 0; s < 4; s += 1) {
    sets.push({ _id: oid(500 + s), items: items(["k" + s, 1, "Game" + s]) });
    for (const [mk, price] of [["gameflip", 2], ["ggsel", 1.2]]) {
      const id = ++n;
      listings.push(listing(id, { marketplace: mk, set: oid(500 + s), status: "sold", price, title: `Game${s} Twitch Drops (1 Item) — K${s}` }));
      signals.push(sig(id, "Game" + s, 0, { marketplace: mk, priceUsd: price, game: "Game" + s, gameKey: "game" + s, at: new Date(NOW - (3 + s) * DAY) }));
    }
  }
  return { listings, sets, signals };
}

test("translation between markets is measured on sets sold on BOTH", () => {
  const w = twoMarketWorld();
  const L = buildLedger(w);
  const tr = A.buildTranslator(L.sales, NOW);
  const t = tr.translate(2, "gameflip", "ggsel");
  assert.ok(Math.abs(t.price - 1.2) < 0.01, "got " + t.price);
  assert.match(t.basis, /paired on 4 sets/);
});

test("with too little evidence on either side there is NO translation, not a guess", () => {
  const w = twoMarketWorld();
  w.listings = w.listings.slice(0, 2);
  w.signals = w.signals.slice(0, 2);
  const L = buildLedger(w);
  const tr = A.buildTranslator(L.sales, NOW);
  assert.strictEqual(tr.translate(2, "gameflip", "ggsel").price, 0);
});

function recFor(world, q) {
  const L = buildLedger(world);
  const tr = A.buildTranslator(L.sales, NOW);
  return A.recommend({ sales: L.sales, now: NOW, tr, curves: {} }, q);
}

test("an exact set that sold HERE sets the price, to the cent", () => {
  const w = twoMarketWorld();
  const id = identify({ title: "Game0 Twitch Drops (1 Item) — K0" }, w.sets[0]);
  const one = recFor(w, { market: "ggsel", id, currentPrice: 2.4, ageDays: 3 });
  assert.strictEqual(one.price, 1.2);
  assert.strictEqual(one.basis, "exact set sold on this market");
  // One sale is low confidence: it informs, it never recommends a change — not
  // even after a long unsold wait.
  assert.strictEqual(one.confidence, "low");
  assert.strictEqual(one.action, "hold");
  assert.strictEqual(recFor(w, { market: "ggsel", id, currentPrice: 2.4, ageDays: 40 }).action, "hold");
  // Two distinct orders at that price is medium, and now it may say lower.
  const l2 = listing(950, { marketplace: "ggsel", set: oid(500), status: "sold", price: 1.2, title: "Game0 Twitch Drops (1 Item) — K0" });
  const w2 = { ...w, listings: [...w.listings, l2], signals: [...w.signals, sig(950, "Game0", 0, { marketplace: "ggsel", priceUsd: 1.2, game: "Game0", gameKey: "game0", at: new Date(NOW - 20 * DAY) })] };
  const two = recFor(w2, { market: "ggsel", id, currentPrice: 2.4, ageDays: 3 });
  assert.strictEqual(two.confidence, "medium");
  assert.strictEqual(two.action, "lower");
});

test("a blocked market never teaches another market's price", () => {
  const w = twoMarketWorld();
  // Re-home gameflip's evidence for set 0 onto the blocked market only.
  for (const l of w.listings) if (l.marketplace === "gameflip") l.marketplace = "digiseller";
  for (const g of w.signals) g.marketplace = g.marketplace === "gameflip" ? "digiseller" : g.marketplace;
  const id = identify({ title: "Game0 Twitch Drops (1 Item) — K0" }, w.sets[0]);
  const drop = w.listings.find((l) => l.marketplace === "ggsel" && String(l.set) === oid(500));
  w.listings = w.listings.filter((l) => l !== drop);
  w.signals = w.signals.filter((x) => !x.dedupeKey.includes(String(drop._id)));
  const r = recFor(w, { market: "eldorado", id, currentPrice: 0 });
  assert.ok(!/other markets/.test(r.basis), "digiseller must not be a source: " + r.basis);
});

test("an exact set sold elsewhere is translated to THIS market's level", () => {
  const w = twoMarketWorld();
  // Remove ggsel's own sale of set 0 so only gameflip evidence remains for it.
  const drop = w.listings.find((l) => l.marketplace === "ggsel" && String(l.set) === oid(500));
  w.listings = w.listings.filter((l) => l !== drop);
  w.signals = w.signals.filter((s) => !s.dedupeKey.includes(String(drop._id)));
  const id = identify({ title: "Game0 Twitch Drops (1 Item) — K0" }, w.sets[0]);
  const r = recFor(w, { market: "ggsel", id, currentPrice: 0, ageDays: 0 });
  assert.match(r.basis, /other markets, translated/);
  assert.ok(r.price < 2, "must not copy the gameflip price: " + r.price);
});

test("the platform floor beats the evidence (PlayerAuctions sits at $5)", () => {
  const w = twoMarketWorld();
  const id = identify({ title: "Game0 Twitch Drops (1 Item) — K0" }, w.sets[0]);
  const r = recFor(w, { market: "playerauctions", id, currentPrice: 0 });
  assert.ok(r.price === 0 || r.price >= 5, "price " + r.price);
});

test("the engine fallback never says RAISE", () => {
  const w = twoMarketWorld();
  const id = identify({ title: "Unseen Twitch Drops (2 Items)" }, null);
  const r = recFor(w, { market: "gameflip", id, currentPrice: 0.75, ageDays: 30 });
  assert.ok(String(r.basis).startsWith("engine") || r.action === "insufficient");
  assert.notStrictEqual(r.action, "raise");
});

test("only auto rows on an open market are applicable; the rest are advisory", () => {
  const w = twoMarketWorld();
  const act = [
    listing(700, { marketplace: "gameflip", set: oid(500), origin: "auto", price: 0.75, title: "Game0 Twitch Drops (1 Item) — K0" }),
    listing(701, { marketplace: "gameflip", set: oid(500), origin: "manual", price: 0.75, title: "Game0 Twitch Drops (1 Item) — K0" }),
    listing(702, { marketplace: "digiseller", set: oid(500), origin: "auto", price: 1.28, title: "Game0 Twitch Drops (1 Item) — K0" }),
  ];
  // A second distinct gameflip order of set 0 makes the evidence medium.
  const extra = listing(703, { marketplace: "gameflip", set: oid(500), status: "sold", price: 2, title: "Game0 Twitch Drops (1 Item) — K0" });
  const extraSig = sig(703, "Game0", 0, { priceUsd: 2, game: "Game0", gameKey: "game0", at: new Date(NOW - 9 * DAY) });
  const world = { ...w, listings: [...w.listings, ...act, extra], signals: [...w.signals, extraSig] };
  const L = buildLedger(world);
  const prepared = A.prepare({ listings: world.listings, sets: world.sets, sales: L.sales });
  const adv = A.advise({ sales: L.sales, prepared, now: NOW, fees: {} }).rows;
  const by = (id) => adv.find((r) => r.listingId === oid(id));
  assert.strictEqual(by(700).action, "raise");
  assert.strictEqual(by(700).applicable, true);
  assert.strictEqual(by(701).applicable, false, "manual is the owner's price");
  assert.strictEqual(by(702).applicable, false, "digiseller is blocked by the owner");
  // And nothing that is not a change is ever applicable.
  for (const r of adv) if (r.applicable) assert.ok(r.action === "raise" || r.action === "lower");
});

test("a market with no recorded sale has no curve and no 'best' price", () => {
  const w = twoMarketWorld();
  const act = Array.from({ length: 15 }, (_, i) => listing(1200 + i, { marketplace: "zeusx", price: 0.75, set: oid(500), title: "Game0 Twitch Drops (1 Item) — K0" }));
  const L = buildLedger(w);
  const prepared = A.prepare({ listings: [...w.listings, ...act], sets: w.sets, sales: L.sales });
  const c = A.priceCurve({ market: "zeusx", prepared, now: NOW });
  assert.strictEqual(c.best, null);
  assert.strictEqual(c.noEvidence, true);
});

test("a deliberate hand-made ladder of one set is not 'corrected'", () => {
  const w = twoMarketWorld();
  const mk = (n, price, origin) => listing(n, { marketplace: "eldorado", set: oid(500), origin, price, title: "Game0 Twitch Drops (1 Item) — K0" });
  const world = { ...w, listings: [...w.listings, mk(800, 1, "manual"), mk(801, 4, "manual")] };
  const L = buildLedger(world);
  const prepared = A.prepare({ listings: world.listings, sets: world.sets, sales: L.sales });
  const adv = A.advise({ sales: L.sales, prepared, now: NOW, fees: {} }).rows;
  assert.strictEqual(adv.find((r) => r.listingId === oid(801)).action, "ladder");
});

test("junk prices ($999 placeholder) never become a price point", () => {
  const w = twoMarketWorld();
  w.listings.push(listing(900, { price: 999 }));
  const L = buildLedger(w);
  const prepared = A.prepare({ listings: w.listings, sets: w.sets, sales: L.sales });
  assert.strictEqual(prepared.skipped.junkPrice, 1);
});

test("a thin curve cell is flagged and cannot be the 'best' price", () => {
  const ls = [];
  const sg = [];
  // 12 resolved listings at $1 (6 sold) and 2 resolved at $3 (both sold).
  for (let i = 0; i < 12; i += 1) {
    const sold = i < 6;
    ls.push(listing(1000 + i, { status: sold ? "sold" : "delisted", price: 1, createdAt: new Date(NOW - 20 * DAY), updatedAt: new Date(NOW - 10 * DAY) }));
    if (sold) sg.push(sig(1000 + i, "g", 0, { priceUsd: 1, at: new Date(NOW - 12 * DAY) }));
  }
  for (let i = 0; i < 2; i += 1) {
    ls.push(listing(1100 + i, { status: "sold", price: 3, createdAt: new Date(NOW - 20 * DAY), updatedAt: new Date(NOW - 10 * DAY) }));
    sg.push(sig(1100 + i, "g", 0, { priceUsd: 3, at: new Date(NOW - 12 * DAY) }));
  }
  const L = buildLedger({ listings: ls, sets: [SET], signals: sg });
  const prepared = A.prepare({ listings: ls, sets: [SET], sales: L.sales });
  const c = A.priceCurve({ market: "gameflip", prepared, now: NOW });
  const three = c.bins.find((b) => b.label.includes("2.41"));
  assert.ok(three.thin);
  assert.notStrictEqual(c.best, three.label);
});

test("stats: wilson widens a thin sample and median ignores junk", () => {
  assert.ok(wilson(2, 3).hi - wilson(2, 3).lo > wilson(200, 300).hi - wilson(200, 300).lo);
  assert.strictEqual(median([0, -1, NaN, 1, 3]), 2);
});

/* ------------------------------ read-only ------------------------------ */

const FILES = ["setIdentity", "ledger", "analyze", "stats", "venues", "index"].map((f) => path.join(__dirname, "..", "utils", "priceTracker", f + ".js"));
FILES.push(path.join(__dirname, "..", "routes", "priceTrackerRoutes.js"));

test("the tracker never writes and never calls a marketplace", () => {
  for (const f of FILES) {
    const src = fs.readFileSync(f, "utf8").replace(/\/\/.*$/gm, "");
    for (const bad of [/\.save\(/, /\.create\(/, /updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate/, /insertMany|deleteOne|deleteMany|bulkWrite/, /require\([^)]*marketplaces[^)]*\)/, /axios/, /saveSettings/]) {
      assert.ok(!bad.test(src), path.basename(f) + " matches " + bad);
    }
  }
});

test("every Mongo read in the loader is bounded and projected", () => {
  const src = fs.readFileSync(FILES[5], "utf8");
  const finds = src.match(/\.find\(/g) || [];
  assert.ok(finds.length >= 3);
  assert.ok(!/\.skip\(/.test(src));
  assert.ok((src.match(/\.limit\(/g) || []).length >= 2);
  assert.ok(!/allowDiskUse/.test(src));
});

test("the real router is superadmin + 2FA on every route", () => {
  const src = fs.readFileSync(FILES[6], "utf8");
  assert.match(src, /guards: \[requireSuperadmin, enforce2fa\]/);
  // Every route is registered through get(), which spreads the guards.
  assert.ok(/router\.get\(path, \.\.\.guards, wrap\(fn\)\)/.test(src));
  assert.ok(!/router\.(get|post|put|delete)\("\/api/.test(src), "no route may bypass get()");
  assert.ok(!/router\.(post|put|patch|delete)/.test(src), "the API is read-only");
});

test("the router answers from a report and refuses an unknown market", async () => {
  const express = require("express");
  const createRouter = require("../routes/priceTrackerRoutes");
  const w = twoMarketWorld();
  const report = T.buildReport({ ...w, at: new Date(NOW) });
  const app = express();
  app.use(createRouter({ getReport: async () => report }));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const ov = await (await fetch(base + "/api/price-tracker/overview")).json();
    assert.strictEqual(ov.success, true);
    assert.ok(ov.venues.length >= 7);
    const bad = await fetch(base + "/api/price-tracker/curve/nope");
    assert.strictEqual(bad.status, 400);
    const sets = await (await fetch(base + "/api/price-tracker/sets?evidence=cross")).json();
    assert.strictEqual(sets.total, 4);
    const sug = await (await fetch(base + "/api/price-tracker/suggest?market=digiseller&game=Game0")).json();
    assert.strictEqual(sug.suggestion.action, "blocked", "blocked markets are never advised on");
  } finally {
    server.close();
  }
});

test("the page escapes everything it renders", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "price-tracker.html"), "utf8");
  assert.match(html, /function esc\(/);
  // No template concatenates a raw field: every ".title", ".externalId", ".orderId" goes through esc().
  for (const field of ["title", "externalId", "orderId", "basis", "game"]) {
    const re = new RegExp("\\+\\s*[a-z]+\\." + field + "\\s*\\+", "g");
    for (const m of html.match(re) || []) assert.fail("unescaped " + m);
  }
});
