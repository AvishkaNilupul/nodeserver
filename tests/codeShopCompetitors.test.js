// Code shop — Eldorado same-set competitor scan (utils/codeShop/competitors.js,
// docs/code-shop/03-MARKETS.md).
//
// What the pricing engine trusts from here is ONE number, lowestSameSetUsd.
// It must come only from offers that really sell the same set, never from one
// of our own offers (undercutting ourselves walks the price to the floor one
// cent per run), and never from a half-read market: a failed request keeps the
// previous scan as it was. And only from offers that have stock and ask at
// least 30 % of our base price (05-REVIEW-FIXES.md, R8): an empty or
// bait-priced listing must not drag our price down.
//
// The pure parts run plain. scan() runs against real Mongo (mongodb-memory-
// server) with an injected fetch and sleep, so nothing here reaches the
// internet. All ids, titles and prices are made up.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const CodeProduct = require("../models/CodeProduct");
const MarketplaceListing = require("../models/MarketplaceListing");
const {
  createCompetitors,
  queriesFor,
  scoreOffer,
  parseSearch,
  countsForLowest,
  MIN_PRICE_SHARE,
} = require("../utils/codeShop/competitors");

const slots = (...labels) => labels.map((label, i) => ({ slotKey: "s" + i, label }));

// --- queriesFor ---------------------------------------------------------------

test("queriesFor: the two longest labels and the game's name", () => {
  const product = { slots: slots("Moon Spray", "Sun Tea Player Icon", "Star Banner", "Ana") };
  assert.deepEqual(queriesFor(product, { displayName: "Overwatch 2" }), [
    "Sun Tea Player Icon",
    "Star Banner",
    "Overwatch 2",
  ]);
});

test("queriesFor: equal lengths keep slot order; blanks and duplicates are dropped", () => {
  const product = { slots: slots("", "Aaaa Bbbb", "aaaa-bbbb", "Cccc Dddd") };
  assert.deepEqual(queriesFor(product, { displayName: "Delta Force" }), [
    "Aaaa Bbbb",
    "Cccc Dddd",
    "Delta Force",
  ]);
  assert.deepEqual(queriesFor({ slots: slots("One Label") }, null), ["One Label"]);
  assert.deepEqual(queriesFor({ slots: [] }, { displayName: "" }), []);
  assert.deepEqual(queriesFor({}, { displayName: "Overwatch 2" }), ["Overwatch 2"]);
});

test("queriesFor: saved queries win over the defaults", () => {
  const product = {
    slots: slots("Sun Tea Player Icon", "Star Banner"),
    competitors: { queries: [" spring icons ", "", "Spring Icons", "banner"] },
  };
  assert.deepEqual(queriesFor(product, { displayName: "Overwatch 2" }), ["spring icons", "banner"]);
  // An empty saved list is "not set".
  product.competitors.queries = [];
  assert.equal(queriesFor(product, { displayName: "Overwatch 2" }).length, 3);
});

// --- scoreOffer ---------------------------------------------------------------

test("scoreOffer: a label matches as a substring of the title", () => {
  assert.deepEqual(scoreOffer("Overwatch 2 Sun Tea Player Icon code", ["Sun Tea Player Icon"]), {
    score: 1,
    sameSet: true,
    matches: 1,
  });
});

test("scoreOffer: or when the title holds every >=4-letter word of the label", () => {
  // "Sun" and "Tea" are short and may be missing or moved; "player" and "icon" must be there.
  assert.equal(scoreOffer("Player icon bundle", ["Sun Tea Player Icon"]).score, 1);
  assert.equal(scoreOffer("Icon of the player", ["Sun Tea Player Icon"]).score, 1);
  assert.equal(scoreOffer("Player card bundle", ["Sun Tea Player Icon"]).score, 0, "'icon' missing");
});

test("scoreOffer: case and punctuation do not matter", () => {
  assert.equal(scoreOffer("SUN-TEA_player.icon!!", ["Sun Tea: Player Icon"]).score, 1);
  assert.equal(scoreOffer("sun tea player icon", ["SUN/TEA PLAYER-ICON"]).score, 1);
});

test("scoreOffer: a label with no >=4-letter word matches only as a substring", () => {
  assert.equal(scoreOffer("Ana Mei spray", ["Ana"]).score, 1);
  assert.equal(scoreOffer("Mei spray", ["Ana Mei"]).score, 0, "no long word to fall back on");
  assert.equal(scoreOffer("Mei and Ana spray", ["Ana Mei"]).score, 0);
});

test("scoreOffer: score is the fraction of labels matched; sameSet needs 0.8", () => {
  const labels = ["Moon Spray", "Star Banner", "Comet Charm", "Nova Title", "Sun Icon"];
  const r4 = scoreOffer("Moon Spray + Star Banner + Comet Charm + Nova Title", labels);
  assert.equal(r4.score, 0.8);
  assert.equal(r4.matches, 4);
  assert.equal(r4.sameSet, true);
  const r3 = scoreOffer("Moon Spray + Star Banner + Comet Charm", labels);
  assert.equal(r3.score, 0.6);
  assert.equal(r3.sameSet, false);
  const third = scoreOffer("Moon Spray", ["Moon Spray", "Star Banner", "Comet Charm"]);
  assert.equal(third.score, 1 / 3);
  assert.equal(third.sameSet, false);
  assert.deepEqual(scoreOffer("anything", []), { score: 0, sameSet: false, matches: 0 });
  assert.deepEqual(scoreOffer("anything", ["", "--"]), { score: 0, sameSet: false, matches: 0 });
  assert.equal(scoreOffer(null, ["Moon Spray"]).score, 0);
});

// --- parseSearch --------------------------------------------------------------

test("parseSearch: USD price first, else a USD pricePerUnit, else null", () => {
  const json = {
    results: [
      {
        offer: {
          id: "o-1",
          offerTitle: "First",
          userId: "u-1",
          pricePerUnitInUSD: { amount: 1.25 },
          pricePerUnit: { amount: 99, currency: "EUR" },
          quantity: 7,
        },
      },
      { offer: { id: "o-2", offerTitle: "Second", userId: "u-2", pricePerUnit: { amount: 2.5, currency: "USD" }, quantity: 1 } },
      { offer: { id: "o-3", offerTitle: "Third", userId: "u-3", pricePerUnit: { amount: 3, currency: "EUR" }, quantity: 2 } },
      { offer: { id: 4 } },
      { offer: { offerTitle: "no id" } },
      { notAnOffer: true },
      null,
    ],
  };
  assert.deepEqual(parseSearch(json), [
    { id: "o-1", title: "First", userId: "u-1", priceUsd: 1.25, qty: 7 },
    { id: "o-2", title: "Second", userId: "u-2", priceUsd: 2.5, qty: 1 },
    { id: "o-3", title: "Third", userId: "u-3", priceUsd: null, qty: 2 },
    { id: "4", title: "", userId: "", priceUsd: null, qty: 0 },
  ]);
});

test("parseSearch: anything that is not a results list is an empty list", () => {
  assert.deepEqual(parseSearch(null), []);
  assert.deepEqual(parseSearch({}), []);
  assert.deepEqual(parseSearch({ results: "nope" }), []);
  assert.deepEqual(parseSearch("text"), []);
});

// --- scan (real Mongo, fake market) -------------------------------------------

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshopcompetitors"));
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

const NOW = Date.parse("2026-10-15T12:00:00Z");
const LABELS = ["Moon Spray", "Star Banner", "Comet Charm", "Nova Title", "Sun Icon"];
const FULL = LABELS.join(" + ");

function offer(id, title, price, extra = {}) {
  return {
    offer: {
      id,
      offerTitle: title,
      userId: extra.userId || "seller-" + id,
      pricePerUnitInUSD: price === null ? undefined : { amount: price },
      quantity: extra.qty === undefined ? 3 : extra.qty,
    },
  };
}

// Filler that matches no label, to make a page exactly 50 long.
function filler(prefix, n) {
  return Array.from({ length: n }, (_, i) => offer(prefix + "-" + i, "Unrelated gold coins " + i, 0.1));
}

const reply = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

// pages: { [query]: [page1Results, page2Results, ...] }; anything else is empty.
function fakeMarket(pages, { fail } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const q = u.searchParams.get("searchQuery");
    const page = Number(u.searchParams.get("pageIndex"));
    if (fail) {
      const f = fail(q, page);
      if (f) return f();
    }
    const list = (pages[q] || [])[page - 1] || [];
    return reply({ results: list });
  };
  return { fetch, calls };
}

function harness(market, cfg = {}) {
  const sleeps = [];
  const logged = [];
  const order = [];
  const fetch = async (...a) => {
    order.push("fetch");
    return market.fetch(...a);
  };
  const competitors = createCompetitors({
    models: { CodeProduct, MarketplaceListing },
    fetch,
    sleep: async (ms) => {
      order.push("sleep");
      sleeps.push(ms);
    },
    now: () => NOW,
    config: { get: async () => ({ ownEldoradoUserIds: [], games: {}, ...cfg }) },
    events: { log: async (e) => (logged.push(e), true) },
  });
  return { competitors, sleeps, logged, order };
}

let seq = 0;
async function product(extra = {}) {
  seq += 1;
  return CodeProduct.create({
    name: "Test bundle " + seq,
    gameNo: "12",
    status: "active",
    slots: slots(...LABELS),
    ...extra,
  });
}

test("scan: pages until a short page (max 3), paced between every request", async () => {
  const p = await product({ competitors: { queries: ["alpha", "beta", "gamma"] } });
  const market = fakeMarket({
    alpha: [filler("a1", 50), filler("a2", 50), filler("a3", 50), filler("a4", 50)],
    beta: [filler("b1", 50), [offer("b-hit", FULL, 2)]],
    gamma: [],
  });
  const h = harness(market);
  await h.competitors.scan(p);

  const seen = market.calls.map((c) => {
    const u = new URL(c.url);
    return u.searchParams.get("searchQuery") + "#" + u.searchParams.get("pageIndex");
  });
  assert.deepEqual(seen, ["alpha#1", "alpha#2", "alpha#3", "beta#1", "beta#2", "gamma#1"]);
  assert.deepEqual(h.sleeps, [1500, 1500, 1500, 1500, 1500]);
  assert.deepEqual(h.order, ["fetch", "sleep", "fetch", "sleep", "fetch", "sleep", "fetch", "sleep", "fetch", "sleep", "fetch"]);

  const first = new URL(market.calls[0].url);
  assert.equal(first.origin + first.pathname, "https://www.eldorado.gg/api/v1/item-management/offers");
  assert.equal(first.searchParams.get("gameId"), "235");
  assert.equal(first.searchParams.get("category"), "CustomItem");
  assert.equal(first.searchParams.get("pageSize"), "50");
  const headers = market.calls[0].init.headers;
  assert.equal(headers.accept, "application/json");
  assert.match(headers["user-agent"], /Mozilla\/5\.0/);
});

test("scan: default queries are used and encoded, and not stored as pinned", async () => {
  const p = await product();
  const market = fakeMarket({});
  const h = harness(market);
  const res = await h.competitors.scan(p);
  // Worked-out queries are used but not stored: only pinned ones are kept.
  assert.match(market.calls[0].url, /searchQuery=Star%20Banner$/);
  assert.equal(market.calls.length, 3);
  assert.deepEqual(res.queries, []);
  const saved = await CodeProduct.findById(p._id).lean();
  assert.deepEqual(saved.competitors.queries, []);
  assert.equal(saved.competitors.lowestSameSetUsd, null);
  assert.deepEqual(saved.competitors.offers, []);
  assert.equal(saved.competitors.scannedAt.getTime(), NOW);
});

test("scan: our own offers (seller id or a listing we hold) are not competitors", async () => {
  const p = await product({ competitors: { queries: ["set"] } });
  // insertMany: no save hook, so no audit-log write racing the disconnect.
  await MarketplaceListing.insertMany([
    {
      accountOffer: new mongoose.Types.ObjectId(),
      marketplace: "eldorado",
      externalId: "ours-listed",
      status: "delisted",
      price: 1,
    },
  ]);
  const market = fakeMarket({
    set: [
      [
        offer("ours-listed", FULL, 0.6),
        offer("ours-by-seller", FULL, 0.7, { userId: "me-1" }),
        offer("theirs", FULL, 1.8),
      ],
    ],
  });
  const h = harness(market, { ownEldoradoUserIds: ["me-1"] });
  const res = await h.competitors.scan(p);
  assert.deepEqual(res.offers.map((o) => o.id), ["theirs"]);
  assert.equal(res.lowestSameSetUsd, 1.8);
});

test("scan: top 15 by score then price; lowest same-set price only from same-set offers", async () => {
  const p = await product({ competitors: { queries: ["set"] } });
  const fullSet = Array.from({ length: 12 }, (_, i) => offer("full-" + i, FULL, 3 + i * 0.1));
  const fourOfFive = [offer("four-a", "Moon Spray Star Banner Comet Charm Nova Title", 2.4), offer("four-b", "Moon Spray Star Banner Comet Charm Sun Icon", 2.2)];
  const threeOfFive = Array.from({ length: 4 }, (_, i) => offer("three-" + i, "Moon Spray Star Banner Comet Charm", 0.9 + i * 0.01));
  const unpriced = [offer("full-no-price", FULL, null)];
  const noMatch = [offer("junk", "Gold coins", 0.05)];
  // Same offer found twice (another page / query) counts once.
  const market = fakeMarket({
    set: [[...fullSet, ...fourOfFive, ...threeOfFive, ...unpriced, ...noMatch, offer("full-0", FULL, 3)]],
  });
  const h = harness(market);
  const res = await h.competitors.scan(p);

  assert.equal(res.offers.length, 15);
  const ids = res.offers.map((o) => o.id);
  assert.deepEqual(ids.slice(0, 12), fullSet.map((o) => o.offer.id), "full sets first, cheapest first");
  assert.deepEqual(ids.slice(12), ["four-b", "four-a", "three-0"]);
  assert.ok(!ids.includes("junk"), "no-match offers are not competitors");
  assert.ok(!ids.includes("full-no-price"), "an offer without a dollar price is skipped");
  assert.equal(res.offers[12].score, 0.8);
  assert.equal(res.offers[12].sameSet, true);
  assert.equal(res.offers[14].sameSet, false);
  // The 3-of-5 offers are far cheaper, but they are not the same set.
  assert.equal(res.lowestSameSetUsd, 2.2);

  const saved = await CodeProduct.findById(p._id).lean();
  assert.equal(saved.competitors.offers.length, 15);
  assert.equal(saved.competitors.lowestSameSetUsd, 2.2);
  assert.equal(saved.competitors.offers[0].id, "full-0");
  assert.equal(saved.competitors.offers[0].qty, 3);
});

test("scan: no same-set offer means lowestSameSetUsd is null", async () => {
  const p = await product({ competitors: { queries: ["set"] } });
  const market = fakeMarket({ set: [[offer("partial", "Moon Spray Star Banner", 0.9)]] });
  const res = await harness(market).competitors.scan(p);
  assert.deepEqual(res.offers.map((o) => o.id), ["partial"]);
  assert.equal(res.lowestSameSetUsd, null);
});

test("scan: a failed request keeps the old scan and logs a warning", async () => {
  const old = {
    scannedAt: new Date(NOW - 86400000),
    queries: ["set"],
    lowestSameSetUsd: 1.5,
    offers: [{ id: "prev", title: FULL, priceUsd: 1.5, qty: 1, score: 1, sameSet: true }],
  };
  const failures = {
    "HTTP 500": () => reply({ error: "boom" }, 500),
    "network error": () => {
      throw new Error("socket hang up");
    },
    "bad JSON": () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    }),
    "no results list": () => reply({ message: "maintenance" }),
  };
  for (const [what, fail] of Object.entries(failures)) {
    const p = await product({ competitors: old });
    // Page 1 is fine and full; page 2 fails: nothing from page 1 may be saved.
    const market = fakeMarket(
      { set: [[offer("cheap", FULL, 0.7), ...filler("f", 49)]] },
      { fail: (q, page) => (page === 2 ? fail : null) },
    );
    const h = harness(market);
    const res = await h.competitors.scan(p);
    assert.equal(market.calls.length, 2, what);
    assert.equal(res.lowestSameSetUsd, 1.5, what);
    const saved = await CodeProduct.findById(p._id).lean();
    assert.equal(saved.competitors.lowestSameSetUsd, 1.5, what);
    assert.equal(saved.competitors.scannedAt.getTime(), old.scannedAt.getTime(), what);
    assert.deepEqual(saved.competitors.offers.map((o) => o.id), ["prev"], what);
    assert.equal(h.logged.length, 1, what);
    assert.equal(h.logged[0].level, "warn", what);
    assert.equal(h.logged[0].kind, "competitors", what);
    assert.equal(String(h.logged[0].product), String(p._id), what);
  }
});

test("scan: loads the product by id too", async () => {
  const p = await product({ competitors: { queries: ["set"] } });
  const market = fakeMarket({ set: [[offer("x", FULL, 1.1)]] });
  const res = await harness(market).competitors.scan(String(p._id));
  assert.equal(res.lowestSameSetUsd, 1.1);
});

// ── R8: which same-set offers set the lowest price ─────────────────────────

test("countsForLowest: same set, at least one in stock, at least 30 % of our base price", () => {
  const o = (fields) => ({ sameSet: true, qty: 2, priceUsd: 1, ...fields });
  assert.equal(MIN_PRICE_SHARE, 0.3);
  assert.equal(countsForLowest(o({}), 2), true);
  assert.equal(countsForLowest(o({ sameSet: false }), 2), false);
  assert.equal(countsForLowest(o({ qty: 0 }), 2), false);
  assert.equal(countsForLowest(o({ priceUsd: 0.6 }), 2), true, "exactly 30 % counts");
  assert.equal(countsForLowest(o({ priceUsd: 0.59 }), 2), false);
  assert.equal(countsForLowest(o({ priceUsd: null }), 2), false);
  // No usable base price: only the stock rule applies.
  assert.equal(countsForLowest(o({ priceUsd: 0.01 }), 0), true);
  assert.equal(countsForLowest(o({ priceUsd: 0.01 }), null), true);
});

test("scan: an out-of-stock or bait-priced same-set offer is listed but does not set the lowest price", async () => {
  const p = await product({ competitors: { queries: ["set"] }, pricing: { priceUsd: 4 } });
  const market = fakeMarket({
    set: [
      [
        offer("empty", FULL, 1.5, { qty: 0 }),
        offer("bait", FULL, 1.19),
        offer("floor", FULL, 1.2),
        offer("real", FULL, 3.5),
      ],
    ],
  });
  const res = await harness(market).competitors.scan(p);
  assert.deepEqual(res.offers.map((o) => o.id), ["bait", "floor", "empty", "real"]);
  assert.equal(res.lowestSameSetUsd, 1.2, "30 % of $4 is $1.20: the first offer that counts");
  const saved = await CodeProduct.findById(p._id).lean();
  assert.equal(saved.competitors.lowestSameSetUsd, 1.2);

  // Nothing that counts: no lowest price at all.
  const q = await product({ competitors: { queries: ["set"] }, pricing: { priceUsd: 10 } });
  const none = await harness(fakeMarket({ set: [[offer("cheap", FULL, 2.5), offer("gone", FULL, 4, { qty: 0 })]] })).competitors.scan(q);
  assert.equal(none.offers.length, 2);
  assert.equal(none.lowestSameSetUsd, null);
});

test("scan: a product passed without its pricing has its base price read", async () => {
  const p = await product({ competitors: { queries: ["set"] }, pricing: { priceUsd: 5 } });
  const partial = { _id: p._id, name: p.name, gameNo: p.gameNo, slots: p.slots, competitors: p.competitors };
  const res = await harness(fakeMarket({ set: [[offer("bait", FULL, 1), offer("real", FULL, 2)]] })).competitors.scan(partial);
  assert.equal(res.lowestSameSetUsd, 2);
});
