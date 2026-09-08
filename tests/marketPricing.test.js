// Per-marketplace pricing, and above all the comparison that feeds it.
//
// The owner's rule: "make sure you do not mess up when you compare with others'
// pricing, because it cannot be changed from what drops they're selling, the
// amount and stuff." So most of this file is about REFUSING bad comparisons —
// a rival's price is meaningless until you know what it is a price for.
//
// Calibrated against 107 live rival rows scraped 2026-09-08 (see the header of
// utils/marketPricing.js for the full measured bands).
const test = require("node:test");
const assert = require("node:assert");

const mpx = require("../utils/marketPricing");

/* ------------------------- reading a rival's title ------------------------ */

test("item counts are parsed out of every shape rivals actually use", () => {
  const real = [
    ["Overwatch Twitch Drops (3 Items) — Pachimonarch Icon + Battle Pass Tier Skip", 3],
    ["Fortnite Twitch Drop (2 item) — The Helm Guitar + KATS Turntable Back Bling", 2],
    ["💜 Rainbow Six Siege Twitch Drops 💎 R6S S2 2026 2 [Total 3 Items]", 3],
    ["Overwatch Twitch Drops — OWWC Groups 2026 Day 1 &2 6/6 ALL items", 6],
    ["Overwatch Twitch Drops 16/16 — S4 Heroes of Busan Launch ALL Items", 16],
    ["[Twitch Drops] Marvel Rivals | 44 Items | Instant Delivery", 44],
    ["[Twitch Drops] Rainbow Six Siege | 6 REWARDS | R6S S2 2026 2 | AUTO-DELIVERY", 6],
    ["RAINBOW SIX SIEGE • 10 rewards • EWC 2026 DAY 1+2+3 • TWITCH DROP/ •", 10],
    ["CALL OF DUTY: WARZONE【TWITCH DROPS】• EWC - COD WRS • 12 наград • АВТО-ВЫДАЧА", 12],
    ["Marvel Rivals〖TWITCH DROPS〗44+ REWARDS • ITEMS • SKINS", 44],
    ["🏅Marvel Rivals🎈Twitch Drops🧨23 items + 🎁", 23],
    ["Twitch Drops | Marvel Rivals | 60 SUBJECTS", 60],
  ];
  for (const [title, want] of real) {
    assert.strictEqual(mpx.parseAdvertisedCount(title), want, title);
  }
});

test("a title with no count stays null rather than being guessed", () => {
  // Guessing puts a row in the wrong size band, which is precisely the
  // mis-comparison the owner warned about.
  for (const t of [
    "KPDH | Fortnite Twitch Drops",
    "Go Goated | Fortnite Twitch Drops",
    "BLUE OPERATOR SKIN | Monster Energy | KEY | COD6",
    "MARVEL RIVALS | AUTOFARM 30-90-180 DAYS | TWITCH DROPS",
  ]) {
    assert.strictEqual(mpx.parseAdvertisedCount(t), null, t);
  }
});

test("numbers that are not item counts are not read as item counts", () => {
  // "1000 Tokens" is a token amount; "180 days" is a farming window; a bare
  // year is a year. All of them would wreck a size band.
  assert.strictEqual(mpx.parseAdvertisedCount("Twitch Drops | 1000 Tokens"), null);
  assert.strictEqual(
    mpx.parseAdvertisedCount("Call of Duty: Black Ops 7 Twitch Drops Automatic farming 180 days"),
    null,
  );
  // "6/6" must agree on both sides to be a completeness claim; "1/2" is not.
  assert.strictEqual(mpx.parseAdvertisedCount("Overwatch Day 1/2 drops"), null);
});

test("a rent-farm window is a different product from a drop bundle", () => {
  // Rivals ask $4.99-$6.00 for a farming window and under $1 for drops. Pooling
  // them corrupts both medians.
  assert.strictEqual(mpx.classifyKind("Rainbow Six Siege X Twitch Drops Automatic farming 120 days"), "farm");
  assert.strictEqual(mpx.classifyKind("MARVEL RIVALS | AUTOFARM 30-90-180 DAYS"), "farm");
  assert.strictEqual(mpx.classifyKind("Overwatch Twitch Drops (6 Items)"), "drops");
});

/* --------------------------- the comparison set --------------------------- */

const OWNER = "us-east-1:fa9dc7a8";

test("our own listings are never counted as competitors", () => {
  // With gameflipOwnerId() broken this filter did nothing, `lowestOther`
  // collapsed onto `lowest`, and the pricer undercut its own row scan after
  // scan. 20 of 107 live rows were ours.
  const rows = [
    { price: 0.75, title: "Overwatch Twitch Drops (3 Items)", owner: OWNER },
    { price: 2.0, title: "Overwatch Twitch Drops (3 Items)", owner: "someone-else" },
  ];
  const rivals = mpx.comparableRivals(rows, { ownerId: OWNER });
  assert.strictEqual(rivals.length, 1);
  assert.strictEqual(rivals[0].owner, "someone-else");
});

test("a rent-farm rival never lands in a drop bundle's comparison", () => {
  const rows = [
    { price: 6.0, title: "R6 Twitch Drops Automatic farming 120 days", owner: "x" },
    { price: 0.75, title: "R6 Twitch Drops (3 Items)", owner: "x" },
  ];
  assert.deepStrictEqual(
    mpx.comparableRivals(rows, { kind: "drops" }).map((r) => r.price),
    [0.75],
  );
  assert.deepStrictEqual(
    mpx.comparableRivals(rows, { kind: "farm" }).map((r) => r.price),
    [6.0],
  );
});

test("a wildly different bundle size is excluded, a similar one is kept", () => {
  const rows = [
    { price: 0.57, title: "[Twitch Drops] Marvel Rivals | 44 Items", owner: "x" },
    { price: 0.75, title: "Overwatch Twitch Drops (4 Items)", owner: "x" },
    { price: 0.9, title: "Overwatch Twitch Drops (6 Items)", owner: "x" },
    { price: 1.1, title: "Overwatch Twitch Drops (12 Items)", owner: "x" },
  ];
  const got = mpx.comparableRivals(rows, { itemCount: 3 }).map((r) => r.price);
  assert.ok(!got.includes(0.57), "a 44-item row must not price a 3-item bundle");
  assert.ok(got.includes(0.75), "4 items is comparable with 3");
  assert.ok(got.includes(0.9), "6 items is exactly double 3, still comparable");
  assert.ok(!got.includes(1.1), "12 items is four times 3 and must be excluded");
});

test("a rival that states no size still competes and is kept", () => {
  // It is chasing the same buyer. Only a STATED, clearly different size is out.
  const rows = [{ price: 0.75, title: "KPDH | Fortnite Twitch Drops", owner: "x" }];
  assert.strictEqual(mpx.comparableRivals(rows, { itemCount: 3 }).length, 1);
});

/* ------------------------------ the verdict ------------------------------- */

// The measured GGSel rival band, drops only.
const GGSEL_RIVALS = [0.29, 0.33, 0.36, 0.45, 0.5, 0.56, 0.57, 0.57, 0.59, 0.6, 0.75, 1.21, 2.32]
  .map((p, i) => ({ price: p, title: "Rival drops bundle (3 Items) #" + i, owner: "rival" }));
const GGSEL_OWN = [0.75, 0.75, 0.75, 0.75, 0.9, 1.0, 1.5, 3.0];

test("REGRESSION: the $4.75 Rainbow Six row on GGSel is called overpriced", () => {
  // The owner's exact complaint: "$4.75 for 3 items is too much, there are
  // competitors". Rival p75 on GGSel is $1.21; this asked 3.9x that.
  const r = mpx.recommend({
    marketplace: "ggsel",
    currentPrice: 4.75,
    itemCount: 3,
    title: "Rainbow Six Siege Twitch Drops (3 Items) — 2× Esports Pack 26 stage 2",
    rivalRows: GGSEL_RIVALS,
    ownerId: OWNER,
    ownSales: GGSEL_OWN,
    floorUsd: 0.3,
  });
  assert.strictEqual(r.verdict, "overpriced");
  assert.ok(r.price < 2, "recommended $" + r.price + " should be near the market, not $4.75");
  assert.ok(r.price >= 0.3, "never below the platform floor");
});

test("our realised price is the anchor even when it beats every rival", () => {
  // Gameflip: rivals median $0.75, we realise $1.25 and still sell. Undercutting
  // to the rival median would throw away a third of the revenue on our best
  // market, so own-realised wins.
  const r = mpx.recommend({
    marketplace: "gameflip",
    currentPrice: 1.25,
    itemCount: 3,
    title: "Overwatch Twitch Drops (3 Items)",
    rivalRows: [0.75, 0.75, 0.75, 2.0].map((p, i) => ({ price: p, title: "rival (3 Items) " + i, owner: "r" })),
    ownerId: OWNER,
    ownSales: [0.75, 1.0, 1.25, 1.25, 1.25, 1.5, 1.75, 2.75],
    floorUsd: 0.75,
  });
  assert.strictEqual(r.basis, "own-realised");
  assert.strictEqual(r.verdict, "ok");
  assert.ok(r.price >= 1.0, "our proven price should survive a cheap rival median");
});

test("bundle size is NOT a price multiplier", () => {
  // Measured: bigger bundles sell for LESS (ggsel <=5 items $0.75, >=10 $0.595).
  // A 40-item bundle must not be priced above a 3-item one on size alone.
  const common = {
    marketplace: "ggsel",
    currentPrice: 0.75,
    title: "Overwatch Twitch Drops",
    rivalRows: GGSEL_RIVALS,
    ownerId: OWNER,
    ownSales: GGSEL_OWN,
    floorUsd: 0.3,
  };
  const small = mpx.recommend({ ...common, itemCount: 3 });
  const large = mpx.recommend({ ...common, itemCount: 40 });
  assert.ok(
    large.price <= small.price + 0.01,
    "a 40-item bundle was priced at $" + large.price + " vs $" + small.price + " for 3",
  );
});

test("a market with no sales and no rivals is left alone, not guessed at", () => {
  // zeusx, playerauctions, g2g, eldorado, epicnpc and funpay have never
  // recorded a priced sale. Inventing a number there is worse than abstaining.
  const r = mpx.recommend({
    marketplace: "zeusx",
    currentPrice: 1.35,
    itemCount: 5,
    title: "Overwatch Twitch Drops (5 Items)",
    rivalRows: [],
    ownSales: [],
    floorUsd: 1,
  });
  assert.strictEqual(r.basis, "unpriceable");
  assert.strictEqual(r.confidence, "none");
  assert.strictEqual(r.price, 1.35, "an unpriceable row keeps its current price");
  assert.strictEqual(r.verdict, "ok", "no evidence must never produce a reprice verdict");
});

test("the platform floor is never breached", () => {
  // Publishing under Digiseller's $1.28 once got the whole seller account
  // blocked, and PlayerAuctions simply refuses anything under $5.
  const cheapRivals = [0.3, 0.35, 0.4, 0.45].map((p, i) => ({ price: p, title: "rival (3 Items) " + i, owner: "r" }));
  for (const [market, floor] of [["digiseller", 1.28], ["playerauctions", 5]]) {
    const r = mpx.recommend({
      marketplace: market,
      currentPrice: floor,
      itemCount: 3,
      title: "Overwatch Twitch Drops (3 Items)",
      rivalRows: cheapRivals,
      ownSales: [],
      floorUsd: floor,
    });
    assert.ok(r.price >= floor, market + " recommended $" + r.price + " under its $" + floor + " floor");
  }
});

test("a thin rival sample cannot trigger a reprice on its own", () => {
  // Two rows is an anecdote. MIN_SAMPLES is 3.
  const r = mpx.recommend({
    marketplace: "ggsel",
    currentPrice: 3.0,
    itemCount: 3,
    title: "Overwatch Twitch Drops (3 Items)",
    rivalRows: [{ price: 0.3, title: "rival (3 Items)", owner: "r" }, { price: 0.4, title: "rival2 (3 Items)", owner: "r" }],
    ownSales: [],
    floorUsd: 0.3,
  });
  assert.strictEqual(r.basis, "unpriceable");
  assert.strictEqual(r.verdict, "ok");
});

test("bands report the shape of the evidence, not just an average", () => {
  const b = mpx.band([0.29, 0.33, 0.36, 0.45, 0.5, 0.56, 0.57, 0.57, 0.59, 0.6, 0.75, 1.21, 2.32]);
  assert.strictEqual(b.n, 13);
  assert.strictEqual(b.min, 0.29);
  assert.strictEqual(b.max, 2.32);
  assert.strictEqual(b.median, 0.57);
  assert.strictEqual(mpx.band([]).n, 0);
});
