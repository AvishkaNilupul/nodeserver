const test = require("node:test");
const assert = require("node:assert/strict");

const watch = require("../utils/funpayWatch");
const engine = require("../utils/funpayResale");

// No Mongo, no network: in-memory models, a fake clock, a fake web and a fake
// Eldorado seller API (also handed to the engine's keepOfferStocked). Fixtures are
// hand-written in FunPay's markup (see tests/funpayPages.test.js) and Eldorado's JSON
// shape; every name, id and price here is made up.

const PAUSED = "paused: FunPay source down — ";
// The engine's shared rule for a deal that is healthy except for `over`.
const OK_DEAL = { missingSince: null, autoDelivery: true, maxBuyPriceUsd: 2, priceUsd: 1.2, sellerRating: 4.9 };
const reasonFor = (over) => engine.sourceDownReason({ ...OK_DEAL, ...over });

const T0 = Date.UTC(2030, 0, 15, 12, 0, 0);
const HOUR = 3600 * 1000;
const C1 = "0000c001-0000-4000-8000-000000000001";
const C2 = "0000c002-0000-4000-8000-000000000002";
const C3 = "0000c003-0000-4000-8000-000000000003";
const EXT = "0000e001-0000-4000-8000-000000000001";
const E2 = "0000e002-0000-4000-8000-000000000002";
const E3 = "0000e003-0000-4000-8000-000000000003";

const U = {
  offer: (id) => `https://funpay.com/en/lots/offer?id=${id}`,
  lots: (node) => `https://funpay.com/en/lots/${node}/`,
  user: (uid) => `https://funpay.com/en/users/${uid}/`,
  eld: (id) => `https://www.eldorado.gg/api/v1/item-management/offers/${id}`,
};

// ------------------------------------------------------------------ fixtures

const ok = (text) => ({ status: 200, text });
const appData = () =>
  `<body class="x" data-app-data="{&quot;locale&quot;:&quot;en&quot;,&quot;csrf-token&quot;:&quot;tok000&quot;,&quot;userId&quot;:0}">`;

function lotRow(id, { uid = 501, name = "AlphaSeller", price = 1.2, online = 1, auto = 1, reviews = 640, desc = "50 TEST DROPS" } = {}) {
  return `
<a href="https://funpay.com/en/lots/offer?id=${id}" class="tc-item" data-online="${online}" data-user="${uid}" data-auto="${auto}">
<div class="tc-desc"><div class="tc-desc-text">${desc}</div></div>
<div class="tc-user"><div class="media media-user online style-circle"><div class="media-left">
<div class="avatar-photo" tabindex="0" data-href="https://funpay.com/en/users/${uid}/" style=""></div></div>
<div class="media-body"><div class="media-user-name">
${name}</div><div class="media-user-reviews"><div class="rating-stars rating-5"></div><span class="rating-mini-count">${reviews}</span></div>
<div class="media-user-info">3 years</div></div></div></div>
<div class="tc-price" data-s="${price}"><div>${price} <span class="unit">$</span></div></div>
</a>`;
}

const lotsPage = (...rows) => `${appData()}<div class="tc table-hover">${rows.join("")}</div></body>`;

function offerPage({ node = 7001, short = "50 TEST DROPS", uid = 501, name = "AlphaSeller" } = {}) {
  return `${appData()}
<a href="https://funpay.com/en/lots/${node}/" class="js-back-link"><i class="fa fa-chevron-left"></i> <span class="inside">Made-Up Game Drops</span></a>
<div class="param-list"><div class="param-item"><h5>Short description</h5><div>${short}</div></div>
<div class="param-item"><h5>Detailed description</h5><div>Made-up details<br>line two</div></div></div>
<div class="media-user-name"><a href="https://funpay.com/en/users/${uid}/">${name}</a></div></body>`;
}

function userPage({ rating = 4.9, count = 640, stars = [5, 5, 5] } = {}) {
  const reviews = stars
    .map(
      (s, i) => `<div class="review-item"><div class="review-item-row"><div class="review-compiled-review"><div class="review-item-user">
<div class="review-item-rating pull-right hidden-xs"><div class="rating"><div class="rating${s}"></div></div></div>
<div class="review-item-date">This month</div><div class="review-item-detail">Made-Up Game, 1 $</div></div>
<div class="review-item-text"> made-up review ${i} </div></div></div></div>`,
    )
    .join("");
  return `${appData()}
<div class="rating-value text-nowrap inline-block-vat mr10"><span class="big">${rating}</span> <span>out of 5</span></div>
<div class="rating-full-count"><a href="#">${count} reviews</a></div>
<div class="review-container">${reviews}</div></body>`;
}

function eld({ price = 3, qty = 10, state = "Active", title = "Made-Up Drops Set", seller = "RivalOne" } = {}) {
  return ok(
    JSON.stringify({
      offer: { id: "made-up", offerTitle: title, offerState: state, quantity: qty, pricePerUnitInUSD: { amount: price, currency: "USD" } },
      user: { username: seller },
    }),
  );
}

const source = (over = {}) => ({
  _id: "src1",
  label: "Deal A",
  offerId: "880001",
  node: "7001",
  game: "Made-Up Game",
  itemsText: "",
  maxBuyPriceUsd: 2,
  autoBuy: false,
  listingQuantity: 5,
  title: "",
  sellerId: "",
  sellerName: "",
  sellerRating: null,
  sellerReviews: 0,
  sellerRecentLow: 0,
  sellerCheckedAt: null,
  online: false,
  autoDelivery: false,
  priceUsd: null,
  seenAt: null,
  missingSince: null,
  competitorOfferIds: [],
  competitors: [],
  competitorHistory: [],
  lowestCompetitorUsd: null,
  suggestedPriceUsd: null,
  estProfitUsd: null,
  watchedAt: null,
  lastError: "",
  ...over,
});

// Healthy as stored: seen, auto-delivery on, under the max buy, good seller,
// profile due for its daily re-read.
const healthySource = (over = {}) =>
  source({
    priceUsd: 1.2,
    autoDelivery: true,
    online: true,
    sellerId: "501",
    sellerName: "AlphaSeller",
    sellerRating: 4.9,
    sellerCheckedAt: new Date(T0 - 48 * HOUR),
    seenAt: new Date(T0 - HOUR),
    ...over,
  });

const healthyWeb = (over = {}) => ({
  [U.lots(7001)]: ok(lotsPage(lotRow("880001", { price: 1.2 }), lotRow("880099", { uid: 777, name: "SomeoneElse", price: 0.5 }))),
  [U.user(501)]: ok(userPage({ rating: 4.9 })),
  ...over,
});

const listing = (over = {}) => ({
  _id: "lst1",
  marketplace: "eldorado",
  externalId: EXT,
  title: "Made-Up Listing",
  status: "active",
  funpaySource: "src1",
  autoPaused: false,
  lastError: "",
  ...over,
});

// ------------------------------------------------------------------ fakes

function matches(doc, filter) {
  return Object.entries(filter || {}).every(([k, v]) => {
    const have = doc[k] === undefined ? null : doc[k];
    if (v && typeof v === "object" && !(v instanceof Date) && Object.prototype.hasOwnProperty.call(v, "$ne")) {
      return v.$ne === null ? have !== null : String(have) !== String(v.$ne);
    }
    if (v && typeof v === "object" && Array.isArray(v.$in)) {
      return v.$in.some((x) => (x === null ? have === null : have !== null && String(have) === String(x)));
    }
    return String(have) === String(v);
  });
}

// Just the mongoose calls the watcher makes: find(filter).lean() and updateOne($set).
function fakeModel(rows) {
  const docs = rows.map((r) => structuredClone(r));
  const m = {
    docs,
    finds: [],
    updates: [],
    find(filter = {}) {
      m.finds.push(structuredClone(filter));
      const out = docs.filter((d) => matches(d, filter)).map((d) => structuredClone(d));
      return { lean: async () => out };
    },
    async updateOne(filter, update) {
      m.updates.push(structuredClone({ filter, update }));
      const d = docs.find((x) => matches(x, filter));
      if (d && update && update.$set) Object.assign(d, structuredClone(update.$set));
      return { acknowledged: true, matchedCount: d ? 1 : 0 };
    },
    get: (id) => docs.find((d) => String(d._id) === String(id)),
  };
  return m;
}

function fakeMp(offers = {}) {
  const m = {
    offers,
    calls: [],
    fail: {},
    onOffer: null, // hook: runs on every offer read (simulates another writer)
    async eldoradoOffer(id) {
      m.calls.push(["offer", id]);
      if (m.onOffer) m.onOffer(id);
      if (m.fail.offer) throw new Error(m.fail.offer);
      return m.offers[id] ? { ...m.offers[id] } : null;
    },
    async eldoradoUpdateOffer(id, patch) {
      m.calls.push(["update", id, patch]);
      if (m.offers[id] && patch && patch.quantity != null) m.offers[id].quantity = patch.quantity;
      return m.offers[id] ? { ...m.offers[id] } : null;
    },
    async eldoradoDelist(id) {
      m.calls.push(["delist", id]);
      if (m.fail.delist) throw new Error(m.fail.delist);
      if (m.offers[id]) m.offers[id].offerState = "Paused";
    },
    async eldoradoRelist(id) {
      m.calls.push(["relist", id]);
      if (m.fail.relist) throw new Error(m.fail.relist);
      if (m.offers[id]) m.offers[id].offerState = "Active";
    },
    async eldoradoSetQuantity(id, q) {
      m.calls.push(["quantity", id, q]);
      if (m.fail.quantity) throw new Error(m.fail.quantity);
      if (m.offers[id]) m.offers[id].quantity = q;
      return q;
    },
    writes: () => m.calls.filter((c) => c[0] !== "offer"),
  };
  return m;
}

// The watcher's deps (downReason / keepOfferStocked stay the engine's real ones) and
// the engine's mp, so keepOfferStocked talks to the same fake Eldorado.
const KEYS = ["Source", "Listing", "Purchase", "settings", "mp", "notify", "fetchText", "now", "sleep", "ops"];
async function withDeps(over, fn) {
  const saved = {};
  for (const k of KEYS) saved[k] = watch.deps[k];
  const savedEngineMp = engine.deps.mp;
  Object.assign(watch.deps, over);
  engine.deps.mp = () => over.mp;
  try {
    return await fn();
  } finally {
    Object.assign(watch.deps, saved);
    engine.deps.mp = savedEngineMp;
  }
}

const CFG = { watchEnabled: true, watchMinutes: 30, eldoradoFeePct: 10, pauseListingWhenSourceDown: true, sessionOk: true };

function harness({ sources = [], listings = [], purchases = [], web = {}, offers = {}, cfg = {} } = {}) {
  const h = {
    clock: { t: T0 },
    Source: fakeModel(sources),
    Listing: fakeModel(listings),
    Purchase: fakeModel(purchases),
    mp: fakeMp(offers),
    web: new Map(Object.entries(web)),
    cfg: { ...CFG, ...cfg },
    notes: [],
    fetched: [],
    sleeps: [],
    rechecks: [],
  };
  // ops.recheckPurchase; set h.recheck = null for an ops module without it.
  h.recheck = async (id) => {
    h.rechecks.push(String(id));
    return { ok: false, state: "bought", reason: "the seller has not delivered yet" };
  };
  h.deps = {
    Source: h.Source,
    Listing: h.Listing,
    Purchase: h.Purchase,
    ops: () => (h.recheck ? { recheckPurchase: (id) => h.recheck(id) } : {}),
    settings: { getFunpayResale: () => ({ ...h.cfg }) },
    mp: h.mp,
    notify: async (text) => {
      h.notes.push(text);
    },
    fetchText: async (url) => {
      h.fetched.push({ url, at: h.clock.t });
      const r = h.web.get(url);
      if (typeof r === "function") return r(url);
      if (r instanceof Error) throw r;
      return r || { status: 404, text: "not found" };
    },
    now: () => h.clock.t,
    sleep: async (ms) => {
      h.sleeps.push(ms);
      h.clock.t += ms;
    },
  };
  h.run = (opts) => withDeps(h.deps, () => watch.runOnce(opts));
  h.src = (id = "src1") => h.Source.get(id);
  h.lst = (id = "lst1") => h.Listing.get(id);
  h.urls = () => h.fetched.map((f) => f.url);
  return h;
}

// ------------------------------------------------------------------ FunPay reads

test("a source without a node learns it (and title, seller) from its offer page; a 404 offer is missing", async () => {
  const h = harness({
    sources: [source({ _id: "src1", node: "", offerId: "880001" }), source({ _id: "src2", node: "", offerId: "880404" })],
    web: {
      [U.offer("880001")]: ok(offerPage({ node: 7001, short: "50 TEST DROPS", uid: 501, name: "AlphaSeller" })),
      [U.offer("880404")]: { status: 404, text: "gone" },
      [U.lots(7001)]: { status: 500, text: "oops" },
      [U.user(501)]: ok(userPage()),
    },
  });
  const r = await h.run();
  assert.equal(r.ok, true);
  const a = h.src("src1");
  assert.equal(a.node, "7001");
  assert.equal(a.title, "50 TEST DROPS");
  assert.equal(a.sellerId, "501");
  assert.equal(a.sellerName, "AlphaSeller");
  assert.match(a.lastError, /FunPay category page: HTTP 500/);
  assert.deepEqual(h.urls(), [U.offer("880001"), U.offer("880404"), U.lots(7001), U.user(501)], "the learned node is read in the same run");
  const b = h.src("src2");
  assert.equal(b.node, "");
  assert.ok(b.missingSince instanceof Date);
  assert.match(b.lastError, /offer page: not found/);

  // Next run: src1's node is known, so its offer page is not read again.
  h.fetched.length = 0;
  h.web.set(U.lots(7001), ok(lotsPage(lotRow("880001"))));
  await h.run();
  assert.equal(h.urls().includes(U.offer("880001")), false);
  assert.equal(h.src("src1").lastError, "");
  assert.ok(h.src("src1").watchedAt instanceof Date);
});

test("the category page updates price, online, auto-delivery, seller and title — one read per node", async () => {
  const h = harness({
    sources: [
      source({ _id: "src1", offerId: "880001", sellerCheckedAt: new Date(T0) }),
      source({ _id: "src2", offerId: "880002", sellerCheckedAt: new Date(T0) }),
    ],
    web: {
      [U.lots(7001)]: ok(
        lotsPage(
          lotRow("880001", { uid: 502, name: "BetaSeller", price: 1.15, online: 0, auto: 1, reviews: 77, desc: "77 TEST DROPS" }),
          lotRow("880002", { uid: 503, name: "GammaSeller", price: 0.4, online: 1, auto: 0, reviews: 12, desc: "12 TEST DROPS" }),
        ),
      ),
    },
  });
  await h.run();
  assert.deepEqual(h.urls(), [U.lots(7001)], "two sources, one node, one read");
  const a = h.src("src1");
  assert.equal(a.priceUsd, 1.15);
  assert.equal(a.online, false);
  assert.equal(a.autoDelivery, true);
  assert.equal(a.sellerId, "502");
  assert.equal(a.sellerName, "BetaSeller");
  assert.equal(a.sellerReviews, 77);
  assert.equal(a.title, "77 TEST DROPS");
  assert.ok(a.seenAt instanceof Date);
  assert.equal(a.missingSince, null);
  const b = h.src("src2");
  assert.equal(b.priceUsd, 0.4);
  assert.equal(b.online, true);
  assert.equal(b.autoDelivery, false);
  assert.equal(b.sellerName, "GammaSeller");
});

test("missingSince is set when the offer is gone from its category page and cleared when it is back", async () => {
  const h = harness({
    sources: [source({ priceUsd: 1.2, autoDelivery: true, sellerCheckedAt: new Date(T0) })],
    web: { [U.lots(7001)]: ok(lotsPage(lotRow("880099", { uid: 777 }))) },
  });
  await h.run();
  const first = h.src().missingSince;
  assert.ok(first instanceof Date);
  assert.ok(Math.abs(first.getTime() - T0) < 5000);
  assert.equal(h.src().priceUsd, 1.2, "the last known values stay");

  h.clock.t = T0 + HOUR;
  await h.run();
  assert.equal(h.src().missingSince.getTime(), first.getTime(), "kept from the first run that missed it");

  h.web.set(U.lots(7001), ok(lotsPage(lotRow("880001"), lotRow("880099", { uid: 777 }))));
  h.clock.t = T0 + 2 * HOUR;
  await h.run();
  assert.equal(h.src().missingSince, null);
  assert.ok(h.src().seenAt.getTime() >= T0 + 2 * HOUR);
});

test("a block page instead of the category is an error, not a missing offer", async () => {
  const h = harness({
    sources: [source({ sellerCheckedAt: new Date(T0) })],
    web: { [U.lots(7001)]: ok("<html><title>Just a moment...</title></html>") },
  });
  await h.run();
  assert.equal(h.src().missingSince, null);
  assert.match(h.src().lastError, /not a FunPay page/);
  // A real FunPay category page without our offer does mark it missing.
  h.web.set(U.lots(7001), ok(lotsPage()));
  await h.run();
  assert.ok(h.src().missingSince instanceof Date);
});

test("the seller profile is read at most once per 24 h (and once per seller per run)", async () => {
  const h = harness({
    sources: [source({ _id: "src1", offerId: "880001" }), source({ _id: "src2", offerId: "880002" })],
    web: {
      [U.lots(7001)]: ok(lotsPage(lotRow("880001", { uid: 501 }), lotRow("880002", { uid: 501 }))),
      [U.user(501)]: ok(userPage({ rating: 4.8, count: 640, stars: [5, 2, 3, 5, 4] })),
    },
  });
  const profileReads = () => h.urls().filter((u) => u === U.user(501)).length;
  await h.run();
  assert.equal(profileReads(), 1);
  for (const id of ["src1", "src2"]) {
    const s = h.src(id);
    assert.equal(s.sellerRating, 4.8);
    assert.equal(s.sellerReviews, 640);
    assert.equal(s.sellerRecentLow, 2, "two reviews of 3 stars or less");
    assert.ok(s.sellerCheckedAt instanceof Date);
  }

  h.clock.t = T0 + 23 * HOUR;
  await h.run();
  assert.equal(profileReads(), 1, "not again within 24 h");

  h.web.set(U.user(501), ok(userPage({ rating: 4.6, count: 650, stars: [5] })));
  h.clock.t = T0 + 25 * HOUR;
  await h.run();
  assert.equal(profileReads(), 2);
  assert.equal(h.src("src1").sellerRating, 4.6);
  assert.equal(h.src("src1").sellerReviews, 650);
  assert.equal(h.src("src1").sellerRecentLow, 0);
});

// ------------------------------------------------------------------ Eldorado competitors

test("competitors: price, stock history, sold in 24 h, lowest, suggested and profit", async () => {
  const h = harness({
    sources: [source({ sellerCheckedAt: new Date(T0), competitorOfferIds: [C1, C2, C3] })],
    web: {
      [U.lots(7001)]: ok(lotsPage(lotRow("880001", { price: 1.2 }))),
      [U.eld(C1)]: eld({ price: 3, qty: 10, seller: "RivalOne", title: "Made-Up 50 Drops" }),
      [U.eld(C2)]: eld({ price: 2.89, qty: 4, seller: "RivalTwo" }),
      [U.eld(C3)]: eld({ price: 1.5, qty: 9, state: "Paused", seller: "RivalThree" }),
    },
  });
  await h.run();
  let s = h.src();
  assert.deepEqual(
    s.competitors.map((c) => [c.offerId, c.seller, c.priceUsd, c.quantity, c.state, c.sold24h]),
    [
      [C1, "RivalOne", 3, 10, "Active", 0],
      [C2, "RivalTwo", 2.89, 4, "Active", 0],
      [C3, "RivalThree", 1.5, 9, "Paused", 0],
    ],
  );
  assert.equal(s.competitors[0].title, "Made-Up 50 Drops");
  assert.ok(s.competitors[0].seenAt instanceof Date);
  assert.equal(s.competitorHistory.length, 3);
  assert.equal(s.lowestCompetitorUsd, 2.89, "a paused offer is not the lowest");
  assert.equal(s.suggestedPriceUsd, 2.88);
  assert.equal(s.estProfitUsd, 1.39, "2.88 × (1 − 10 %) − 1.20");

  // +30 min: C1 sold 3; C2 restocked, which is not a sale.
  h.clock.t = T0 + 0.5 * HOUR;
  h.web.set(U.eld(C1), eld({ price: 3, qty: 7 }));
  h.web.set(U.eld(C2), eld({ price: 2.89, qty: 6 }));
  await h.run();
  assert.deepEqual(h.src().competitors.map((c) => c.sold24h), [3, 0, 0]);

  // +60 min: C1 sold 2 more, C2 sold 3.
  h.clock.t = T0 + HOUR;
  h.web.set(U.eld(C1), eld({ price: 3, qty: 5 }));
  h.web.set(U.eld(C2), eld({ price: 2.89, qty: 3 }));
  await h.run();
  assert.deepEqual(h.src().competitors.map((c) => c.sold24h), [5, 3, 0]);

  // A day later only the drops between readings inside the last 24 h count.
  h.clock.t = T0 + 24.75 * HOUR;
  h.web.set(U.eld(C1), eld({ price: 3, qty: 4 }));
  await h.run();
  s = h.src();
  assert.deepEqual(s.competitors.map((c) => c.sold24h), [1, 0, 0]);
  assert.equal(s.competitorHistory.length, 12);
});

test("a competitor that disappears from Eldorado drops out of the lowest price", async () => {
  const h = harness({
    sources: [source({ sellerCheckedAt: new Date(T0), competitorOfferIds: [C1, C2] })],
    web: {
      [U.lots(7001)]: ok(lotsPage(lotRow("880001", { price: 1 }))),
      [U.eld(C1)]: eld({ price: 2, qty: 3, seller: "RivalOne" }),
      [U.eld(C2)]: eld({ price: 3, qty: 3, seller: "RivalTwo" }),
    },
  });
  await h.run();
  assert.equal(h.src().lowestCompetitorUsd, 2);
  h.web.set(U.eld(C1), { status: 404, text: "" });
  h.clock.t = T0 + HOUR;
  await h.run();
  const s = h.src();
  assert.deepEqual(
    s.competitors.map((c) => [c.offerId, c.seller, c.priceUsd, c.state]),
    [
      [C1, "RivalOne", 2, "NotFound"],
      [C2, "RivalTwo", 3, "Active"],
    ],
  );
  assert.equal(s.lowestCompetitorUsd, 3);
  assert.equal(s.suggestedPriceUsd, 2.99);
  assert.match(s.lastError, /0000c001: not found on Eldorado/);
});

test("competitor history keeps the newest 300 points, of watched offers only", async () => {
  const old = [];
  for (let i = 0; i < 350; i++) old.push({ offerId: C1, quantity: 100 - (i % 3), at: new Date(T0 - (350 - i) * 60000) });
  for (let i = 0; i < 5; i++) old.push({ offerId: C3, quantity: 1, at: new Date(T0 - i * 60000) });
  const h = harness({
    sources: [source({ sellerCheckedAt: new Date(T0), competitorOfferIds: [C1], competitorHistory: old })],
    web: { [U.lots(7001)]: ok(lotsPage(lotRow("880001"))), [U.eld(C1)]: eld({ qty: 42 }) },
  });
  await h.run();
  const hist = h.src().competitorHistory;
  assert.equal(hist.length, 300);
  assert.ok(hist.every((p) => p.offerId === C1), "points of an offer no longer watched are dropped");
  assert.equal(hist[hist.length - 1].quantity, 42, "the new point is the newest");
  assert.equal(hist[0].at.getTime(), old[51].at.getTime(), "the oldest 51 went");
});

test("derived prices: null when an input is missing, never below one cent", () => {
  assert.deepEqual(watch.derive({ competitors: [], priceUsd: 1 }, 10), {
    lowestCompetitorUsd: null,
    suggestedPriceUsd: null,
    estProfitUsd: null,
  });
  assert.deepEqual(watch.derive({ competitors: [{ state: "Active", priceUsd: 2 }], priceUsd: null }, 10), {
    lowestCompetitorUsd: 2,
    suggestedPriceUsd: 1.99,
    estProfitUsd: null,
  });
  assert.equal(watch.derive({ competitors: [{ state: "Active", priceUsd: 0.01 }], priceUsd: 0 }, 10).suggestedPriceUsd, 0.01);
  assert.equal(watch.derive({ competitors: [{ state: "Active", priceUsd: 2 }], priceUsd: 2.5 }, 10).estProfitUsd, -0.71);
  assert.equal(watch.derive({ competitors: [{ state: "Active", priceUsd: 2 }], priceUsd: 1 }, 20).estProfitUsd, 0.59);
});

// ------------------------------------------------------------------ linked listings

// Each case breaks exactly one thing the shared rule looks at; the expected reason
// is the engine's own wording for that one thing.
const DOWN_CASES = [
  ["offer gone from FunPay", {}, { lots: ok(lotsPage(lotRow("880099", { uid: 777 }))) }, reasonFor({ missingSince: new Date(T0) })],
  ["auto-delivery off", {}, { lots: ok(lotsPage(lotRow("880001", { auto: 0 }))) }, reasonFor({ autoDelivery: false })],
  ["price above the max buy", {}, { lots: ok(lotsPage(lotRow("880001", { price: 2.5 }))) }, reasonFor({ priceUsd: 2.5 })],
  ["seller rating below 4.5", {}, { user: ok(userPage({ rating: 4.3 })) }, reasonFor({ sellerRating: 4.3 })],
  ["no max buy price", { maxBuyPriceUsd: 0 }, {}, reasonFor({ maxBuyPriceUsd: 0 })],
];

test("the down cases are distinct reasons of the shared rule", () => {
  assert.equal(reasonFor({}), "", "the baseline deal is healthy");
  const reasons = DOWN_CASES.map((c) => c[3]);
  assert.ok(reasons.every(Boolean));
  assert.equal(new Set(reasons).size, reasons.length);
});

for (const [label, srcOver, webOver, reason] of DOWN_CASES) {
  test(`a linked listing is paused when its source is down: ${label}`, async () => {
    const h = harness({
      sources: [healthySource(srcOver)],
      listings: [listing()],
      web: healthyWeb({ ...(webOver.lots ? { [U.lots(7001)]: webOver.lots } : {}), ...(webOver.user ? { [U.user(501)]: webOver.user } : {}) }),
      offers: { [EXT]: { offerState: "Active", quantity: 5 } },
    });
    const r = await h.run();
    assert.deepEqual(h.mp.writes(), [["delist", EXT]]);
    const l = h.lst();
    assert.equal(l.autoPaused, true);
    assert.equal(l.lastError, PAUSED + reason);
    assert.equal(r.paused.length, 1);
    assert.equal(h.notes.length, 1);
    assert.match(h.notes[0], /paused the Eldorado listing "Made-Up Listing"/);

    // Still down on the next run: no second pause, no second message, no rewrite,
    // and not even a read of the offer it already paused.
    h.clock.t = T0 + HOUR;
    await h.run();
    assert.deepEqual(h.mp.calls, [
      ["offer", EXT],
      ["delist", EXT],
    ]);
    assert.equal(h.notes.length, 1);
    assert.equal(h.Listing.updates.length, 1);
  });
}

test("a listing whose source no longer exists is paused", async () => {
  const h = harness({ sources: [], listings: [listing({ funpaySource: "gone1" })], offers: { [EXT]: { offerState: "Active", quantity: 3 } } });
  const r = await h.run();
  assert.equal(r.ok, true);
  assert.deepEqual(h.mp.writes(), [["delist", EXT]]);
  assert.equal(h.lst().autoPaused, true);
  assert.equal(h.lst().lastError, PAUSED + engine.sourceDownReason(null));
});

test("no pause while pauseListingWhenSourceDown is off, and an offer the owner paused is never claimed", async () => {
  const down = { [U.lots(7001)]: ok(lotsPage(lotRow("880001", { auto: 0 }))) };
  let h = harness({
    sources: [healthySource()],
    listings: [listing()],
    web: healthyWeb(down),
    offers: { [EXT]: { offerState: "Active", quantity: 1 } },
    cfg: { pauseListingWhenSourceDown: false },
  });
  await h.run();
  assert.deepEqual(h.mp.calls, [], "no pause and no top-up for a down source");
  assert.equal(h.lst().autoPaused, false);
  assert.equal(h.notes.length, 0);

  h = harness({ sources: [healthySource()], listings: [listing()], web: healthyWeb(down), offers: { [EXT]: { offerState: "Paused", quantity: 5 } } });
  await h.run();
  assert.deepEqual(h.mp.writes(), []);
  assert.equal(h.lst().autoPaused, false, "the owner's pause stays the owner's (never resumed by us later)");
  assert.equal(h.lst().lastError, "");
  assert.equal(h.notes.length, 0);
});

test("only a listing this watcher paused is resumed", async () => {
  const E4 = "0000e004-0000-4000-8000-000000000004";
  const E5 = "0000e005-0000-4000-8000-000000000005";
  const E6 = "0000e006-0000-4000-8000-000000000006";
  const ours = PAUSED + reasonFor({ autoDelivery: false });
  const h = harness({
    sources: [healthySource()],
    listings: [
      listing({ _id: "lst1", externalId: EXT, autoPaused: true, lastError: ours }),
      listing({ _id: "lst2", externalId: E2, autoPaused: true, lastError: "paused: no claimable stock" }),
      listing({ _id: "lst3", externalId: E3 }),
      listing({ _id: "lst4", externalId: E4, autoPaused: true, lastError: ours }),
      listing({ _id: "lst5", externalId: E5, autoPaused: true, lastError: ours }),
      listing({ _id: "lst6", externalId: E6, autoPaused: true, lastError: "paused: FunPay login expired" }),
    ],
    web: healthyWeb(),
    offers: {
      [EXT]: { offerState: "Paused", quantity: 5 },
      [E2]: { offerState: "Paused", quantity: 5 },
      [E3]: { offerState: "Active", quantity: 5 },
      [E4]: { offerState: "Closed", quantity: 0 },
      [E5]: { offerState: "Active", quantity: 5 },
      [E6]: { offerState: "Paused", quantity: 5 },
    },
  });
  const r = await h.run();
  assert.deepEqual(h.mp.writes(), [["relist", EXT]]);
  assert.equal(h.lst("lst1").autoPaused, false);
  assert.equal(h.lst("lst1").lastError, "");
  assert.equal(h.lst("lst2").autoPaused, true);
  assert.equal(h.lst("lst2").lastError, "paused: no claimable stock");
  assert.equal(h.lst("lst6").lastError, "paused: FunPay login expired", "the login watch's pause is the login watch's");
  assert.equal(h.mp.calls.some((c) => c[1] === E2 || c[1] === E6), false, "someone else's pause is not even read");
  assert.equal(h.lst("lst4").autoPaused, true, "a closed offer is not brought back");
  assert.match(h.src().lastError, /0000e004: the offer is Closed on Eldorado — not resumed/);
  assert.equal(h.lst("lst5").autoPaused, false, "already back on sale by hand: only our flag goes");
  assert.equal(h.lst("lst5").lastError, "");
  assert.deepEqual(r.resumed.map((x) => x.externalId), [EXT]);
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0], /resumed the Eldorado listing "Made-Up Listing"/);
});

test("a listing this watcher paused stays paused while the FunPay login is not working", async () => {
  const h = harness({
    sources: [healthySource()],
    listings: [listing({ autoPaused: true, lastError: PAUSED + reasonFor({ autoDelivery: false }) })],
    web: healthyWeb(),
    offers: { [EXT]: { offerState: "Paused", quantity: 5 } },
    cfg: { sessionOk: false },
  });
  await h.run();
  assert.deepEqual(h.mp.calls, []);
  assert.equal(h.lst().autoPaused, true);
  assert.match(h.src().lastError, /stays paused — the FunPay login is not working/);

  h.cfg.sessionOk = true;
  await h.run();
  assert.deepEqual(h.mp.writes(), [["relist", EXT]]);
  assert.equal(h.lst().autoPaused, false);
});

test("a 'pause failed' note on a listing clears once its source is healthy again", async () => {
  const h = harness({
    sources: [healthySource()],
    listings: [listing({ lastError: "pause failed: FunPay source down — " + reasonFor({ autoDelivery: false }) + " — HTTP 502" })],
    web: healthyWeb(),
    offers: { [EXT]: { offerState: "Active", quantity: 5 } },
  });
  await h.run();
  assert.equal(h.lst().lastError, "");
  assert.equal(h.lst().autoPaused, false);
  assert.deepEqual(h.mp.writes(), []);
});

test("a healthy deal's offer is kept stocked through the engine (top up Active, reopen Closed)", async () => {
  const E4 = "0000e004-0000-4000-8000-000000000004";
  const E8 = "0000e008-0000-4000-8000-000000000008";
  const E9 = "0000e009-0000-4000-8000-000000000009";
  const h = harness({
    sources: [healthySource({ listingQuantity: 5 })],
    listings: [
      listing({ _id: "lst1", externalId: EXT }),
      listing({ _id: "lst2", externalId: E2 }),
      listing({ _id: "lst3", externalId: E3 }),
      listing({ _id: "lst4", externalId: E4 }),
      listing({ _id: "lst8", externalId: E8, status: "delisted" }),
      listing({ _id: "lst9", externalId: E9, funpaySource: null }),
    ],
    web: healthyWeb(),
    offers: {
      [EXT]: { offerState: "Active", quantity: 2 },
      [E2]: { offerState: "Active", quantity: 6 },
      [E3]: { offerState: "Paused", quantity: 0 },
      [E4]: { offerState: "Closed", quantity: 0 },
      [E8]: { offerState: "Active", quantity: 0 },
      [E9]: { offerState: "Active", quantity: 0 },
    },
  });
  const r = await h.run();
  assert.deepEqual(h.mp.writes(), [
    ["quantity", EXT, 5],
    ["update", E4, { quantity: 5 }],
    ["relist", E4],
  ]);
  assert.deepEqual(r.restocked.map((x) => [x.externalId, x.toppedUp || null, x.reopened || null]), [
    [EXT, 5, null],
    [E4, null, 5],
  ]);
  assert.equal(h.mp.calls.some((c) => c[1] === E8 || c[1] === E9), false, "unlinked or inactive rows are not touched");
  assert.equal(h.notes.length, 0);
  assert.equal(h.src().lastError, "");
});

test("a row that stops being active during the run is not touched", async () => {
  const h = harness({
    sources: [healthySource()],
    listings: [listing({ _id: "lst1", externalId: EXT }), listing({ _id: "lst2", externalId: E2 })],
    web: healthyWeb(),
    offers: { [EXT]: { offerState: "Active", quantity: 5 }, [E2]: { offerState: "Active", quantity: 1 } },
  });
  // While lst1 is handled, the owner delists lst2.
  h.mp.onOffer = (id) => {
    if (id === EXT) h.Listing.get("lst2").status = "delisted";
  };
  await h.run();
  assert.equal(h.mp.calls.some((c) => c[1] === E2), false);
});

test("a pause someone else made meanwhile is never written over", async () => {
  const h = harness({
    sources: [healthySource()],
    listings: [listing()],
    web: healthyWeb({ [U.lots(7001)]: ok(lotsPage(lotRow("880001", { auto: 0 }))) }),
    offers: { [EXT]: { offerState: "Active", quantity: 5 } },
  });
  // The login watch pauses the row between this watcher's read and its write.
  h.mp.onOffer = () => {
    Object.assign(h.Listing.get("lst1"), { autoPaused: true, lastError: "paused: FunPay login expired" });
  };
  const r = await h.run();
  assert.equal(h.lst().autoPaused, true);
  assert.equal(h.lst().lastError, "paused: FunPay login expired");
  assert.equal(r.paused.length, 0);
  assert.equal(h.notes.length, 0);
  assert.match(h.src().lastError, /changed while the watcher ran — left as it is/);
});

test("a failed pause pages once, is retried every run, and clears once it works", async () => {
  const h = harness({
    sources: [healthySource()],
    listings: [listing()],
    web: healthyWeb({ [U.lots(7001)]: ok(lotsPage(lotRow("880001", { auto: 0 }))) }),
    offers: { [EXT]: { offerState: "Active", quantity: 5 } },
  });
  const reason = reasonFor({ autoDelivery: false });
  h.mp.fail.delist = "HTTP 502";
  await h.run();
  assert.equal(h.lst().autoPaused, false);
  assert.equal(h.lst().lastError, "pause failed: FunPay source down — " + reason + " — HTTP 502");
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0], /could not pause/);
  assert.match(h.src().lastError, /pause failed — HTTP 502/);

  h.clock.t += HOUR;
  await h.run();
  assert.equal(h.mp.writes().filter((c) => c[0] === "delist").length, 2, "tried again");
  assert.equal(h.notes.length, 1, "not paged twice");

  h.mp.fail.delist = null;
  h.clock.t += HOUR;
  await h.run();
  assert.equal(h.lst().autoPaused, true);
  assert.equal(h.lst().lastError, PAUSED + reason);
  assert.equal(h.notes.length, 2);
  assert.match(h.notes[1], /paused the Eldorado listing/);
});

// ------------------------------------------------------------------ manual purchases

test("each run re-checks the manual purchases still waiting for the seller", async () => {
  const h = harness({
    sources: [healthySource({ _id: "src1" }), healthySource({ _id: "src2", offerId: "880002" })],
    web: healthyWeb(),
    purchases: [
      { _id: "p1", source: "src1", kind: "manual", state: "bought" },
      { _id: "p2", source: "src1", kind: "manual", state: "received" },
      { _id: "p3", source: "src1", kind: "order", state: "bought" },
      { _id: "p4", source: "src2", kind: "manual", state: "bought" },
    ],
  });
  const r = await h.run();
  assert.deepEqual(h.rechecks, ["p1", "p4"]);
  assert.deepEqual(
    r.rechecked.map((x) => [x.purchaseId, x.state]),
    [
      ["p1", "bought"],
      ["p4", "bought"],
    ],
  );

  h.rechecks.length = 0;
  await h.run({ onlySourceId: "src2" });
  assert.deepEqual(h.rechecks, ["p4"], "a single-deal refresh re-checks that deal's purchases only");

  h.recheck = async () => {
    throw new Error("boom");
  };
  const r2 = await h.run();
  assert.equal(r2.ok, true, "a recheck that throws does not stop the run");
  assert.match(r2.problems.join(" "), /manual buy p1: boom/);

  h.recheck = null; // an ops module without recheckPurchase
  const reads = h.Purchase.finds.length;
  const r3 = await h.run();
  assert.equal(r3.ok, true);
  assert.equal(h.Purchase.finds.length, reads, "skipped without even reading the purchases");
});

// ------------------------------------------------------------------ run control

test("watchEnabled=false: a full run does nothing; the owner's single-source refresh still runs", async () => {
  const h = harness({
    sources: [healthySource({ _id: "src1" }), healthySource({ _id: "src2", offerId: "880002" })],
    listings: [listing()],
    purchases: [{ _id: "p1", source: "src1", kind: "manual", state: "bought" }],
    web: healthyWeb(),
    offers: { [EXT]: { offerState: "Active", quantity: 1 } },
    cfg: { watchEnabled: false },
  });
  assert.deepEqual(await h.run(), { skipped: "watcher is off" });
  assert.equal(h.fetched.length, 0);
  assert.equal(h.Source.finds.length, 0);
  assert.equal(h.Listing.finds.length, 0);
  assert.equal(h.Purchase.finds.length, 0);
  assert.equal(h.Source.updates.length, 0);
  assert.deepEqual(h.mp.calls, []);
  assert.deepEqual(h.rechecks, []);
  assert.equal(h.notes.length, 0);

  const one = await h.run({ onlySourceId: "src2" });
  assert.equal(one.ok, true);
  assert.equal(one.sources, 1);
  assert.notEqual(watch.state.lastResult, one, "a single-source refresh is not the watcher's last run");
  assert.deepEqual(h.Source.updates.map((u) => u.filter._id), ["src2"]);
  assert.equal(h.mp.calls.some((c) => c[1] === EXT), false, "src1's listing is not src2's refresh");

  assert.deepEqual(await h.run({ onlySourceId: "nope" }), { ok: false, error: "source not found" });
});

test("start(): first run after 2 min, then every watchMinutes, timers unref'd, idle while the watcher is off", async () => {
  const h = harness({ sources: [healthySource()], web: healthyWeb(), cfg: { watchEnabled: false, watchMinutes: 45 } });
  const timers = [];
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  global.setTimeout = (fn, ms) => {
    const t = {
      fn,
      ms,
      unrefed: false,
      unref() {
        this.unrefed = true;
        return this;
      },
    };
    timers.push(t);
    return t;
  };
  global.clearTimeout = () => {};
  try {
    await withDeps(h.deps, async () => {
      watch.start();
      watch.start();
      assert.equal(timers.length, 1, "start() twice schedules once");
      assert.equal(timers[0].ms, 2 * 60 * 1000);
      assert.equal(timers[0].unrefed, true);

      await timers[0].fn();
      assert.equal(h.fetched.length, 0, "watcher off: the tick reads nothing");
      assert.equal(h.Source.finds.length, 0);
      assert.equal(timers.length, 2, "and still reschedules");
      assert.equal(timers[1].ms, 45 * 60 * 1000);
      assert.equal(timers[1].unrefed, true);

      h.cfg.watchEnabled = true;
      await timers[1].fn();
      assert.ok(h.fetched.length > 0, "switched on: the next tick runs");
      assert.equal(timers.length, 3);
      assert.ok(watch.state.lastRunAt instanceof Date);
    });
  } finally {
    watch.stop();
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

test("runOnce is single-flight", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  let entered;
  const inside = new Promise((r) => (entered = r));
  const h = harness({ sources: [healthySource()], web: healthyWeb() });
  h.web.set(U.lots(7001), async () => {
    entered();
    await gate;
    return ok(lotsPage(lotRow("880001")));
  });
  await withDeps(h.deps, async () => {
    const first = watch.runOnce();
    await inside;
    assert.equal(watch.state.running, true);
    assert.deepEqual(await watch.runOnce(), { skipped: "already running" });
    assert.deepEqual(await watch.runOnce({ onlySourceId: "src1" }), { skipped: "already running" });
    release();
    const r = await first;
    assert.equal(r.ok, true);
    assert.equal(watch.state.running, false);
    assert.equal(watch.state.lastResult, r);
    assert.ok(watch.state.lastRunAt instanceof Date);
  });
});

test("one failing read does not stop the run", async () => {
  const h = harness({
    sources: [
      healthySource({ _id: "src1", offerId: "880001", node: "7001" }),
      healthySource({ _id: "src2", offerId: "880002", node: "7002", competitorOfferIds: [C1, C2], sellerCheckedAt: new Date(T0) }),
    ],
    listings: [listing({ _id: "lst2", funpaySource: "src2", externalId: EXT })],
    web: {
      [U.lots(7001)]: new Error("socket hang up"),
      [U.lots(7002)]: ok(lotsPage(lotRow("880002", { price: 0.9 }))),
      [U.user(501)]: ok(userPage()),
      [U.eld(C1)]: { status: 500, text: "upstream error" },
      [U.eld(C2)]: eld({ price: 2.5, qty: 3 }),
    },
    offers: { [EXT]: { offerState: "Active", quantity: 1 } },
  });
  const r = await h.run();
  assert.equal(r.ok, true);
  const a = h.src("src1");
  assert.match(a.lastError, /FunPay category page: socket hang up/);
  assert.equal(a.priceUsd, 1.2, "last known price kept");
  assert.equal(a.missingSince, null, "a failed read is not a missing offer");
  const b = h.src("src2");
  assert.equal(b.priceUsd, 0.9);
  assert.match(b.lastError, /Eldorado offer 0000c001: HTTP 500/);
  assert.deepEqual(b.competitors.map((c) => [c.offerId, c.state]), [
    [C1, ""],
    [C2, "Active"],
  ]);
  assert.equal(b.lowestCompetitorUsd, 2.5);
  assert.deepEqual(h.mp.writes(), [["quantity", EXT, 5]], "the linked listing is still looked after");
});

test("network reads are at least 700 ms apart", async () => {
  const h = harness({
    sources: [source({ node: "", competitorOfferIds: [C1, C2] })],
    web: {
      [U.offer("880001")]: ok(offerPage()),
      [U.lots(7001)]: ok(lotsPage(lotRow("880001"))),
      [U.user(501)]: ok(userPage()),
      [U.eld(C1)]: eld(),
      [U.eld(C2)]: eld(),
    },
  });
  await h.run();
  assert.equal(h.fetched.length, 5);
  for (let i = 1; i < h.fetched.length; i++) {
    assert.ok(h.fetched[i].at - h.fetched[i - 1].at >= 700, `read ${i} came too soon`);
  }
  assert.ok(h.sleeps.every((ms) => ms > 0 && ms <= 700));
});

test("an HTTP 429 stops further reads on that host for the rest of the run", async () => {
  const h = harness({
    sources: [healthySource({ sellerCheckedAt: new Date(T0), competitorOfferIds: [C1, C2, C3] })],
    web: {
      [U.lots(7001)]: ok(lotsPage(lotRow("880001"))),
      [U.eld(C1)]: { status: 429, text: "" },
      [U.eld(C2)]: eld(),
      [U.eld(C3)]: eld(),
    },
  });
  const r = await h.run();
  assert.equal(r.ok, true);
  assert.deepEqual(h.urls(), [U.lots(7001), U.eld(C1)]);
  assert.match(r.problems.join(" "), /Eldorado answered HTTP 429/);
  assert.match(h.src().lastError, /0000c002: skipped/);
});
