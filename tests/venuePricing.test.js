// Pricing a cheap venue with an expensive venue's money.
//
// Found on prod 2026-09-09 while auditing GGSel: `scripts/reprice-listings.js
// --market=ggsel` proposed raising 62 of 64 live rows, one of them from $0.75 to
// $10.00, on a marketplace where our realised median is $0.75 (n=13) and our
// highest sale ever is $3.00. Nothing was broken in the arithmetic — the inputs
// were another marketplace's.
//
// Two independent defects produced it, and both are asserted here:
//   1. utils/pricingEvidence handed `markets.gameflip` to EVERY caller, so a
//      Gameflip competitor's asking price anchored a GGSel listing.
//   2. utils/pricing's anchor ladder reaches `game` (this game, ANY venue) long
//      before `platform` (this venue), and for a thin venue the top rung never
//      fires at all — 0 of GGSel's 10 game-buckets hold 3 samples.
const test = require("node:test");
const assert = require("node:assert");

const pricing = require("../utils/pricing");

// The measured prod shape, 2026-09-09. Keep these numbers: they are the whole
// reason the code says what it says.
const GGSEL = {
  platformGame: [], // 0 of 10 ggsel game-buckets ever reach minSamples
  game: [2.0, 2.2, 2.4, 2.6], // this game, earned mostly on gameflip
  platform: [0.75, 0.75, 0.75, 0.75, 1.0, 1.25, 3.0], // ggsel, realised
  global: [1.28, 1.25, 1.5, 0.75, 1.0, 2.0, 5.0], // the business
  marketplace: "ggsel",
};

/* ============ 1. the rival signal belongs to one venue ================= */

test("REGRESSION: a non-Gameflip venue is given no Gameflip rival", async () => {
  // evidenceFor is DB-backed, so assert on the source: the guard must exist and
  // must gate BOTH signals, not just the one that was noticed first.
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "utils/pricingEvidence.js"),
    "utf8",
  );
  assert.match(src, /const onGameflip = !mkt \|\| mkt === "gameflip";/);
  assert.match(
    src,
    /rivalLowest\s*=\s*\n?\s*onGameflip && Number\(gf\.lowestOther\)/,
    "rivalLowest must be gated on the venue",
  );
  assert.match(
    src,
    /researchMedian:\s*\n?\s*onGameflip && Number\(gf\.median\)/,
    "researchMedian is the same Gameflip order book and needs the same gate",
  );
});

test("the evidence says which venue it was built for", () => {
  // Without this the pricer cannot tell a venue bucket from a cross-market one,
  // and the reason string cannot name the venue it scaled to.
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "utils/pricingEvidence.js"),
    "utf8",
  );
  assert.match(src, /marketplace: mkt,/);
});

/* ============ 2. cross-market anchors are rescaled to the venue ========= */

test("venueFactor is the ratio of the venue's median to the business median", () => {
  const f = pricing.venueFactor(GGSEL);
  const expected = 0.75 / 1.28; // ggsel median / global median
  assert.ok(Math.abs(f - expected) < 0.02, "expected ~" + expected + ", got " + f);
});

test("a venue with too few sales is not rescaled at all", () => {
  // Two sales is an anecdote. The factor must be exactly 1 — no adjustment,
  // which is the behaviour every unproven venue had before this existed.
  const thin = { ...GGSEL, platform: [0.75, 0.75] };
  assert.strictEqual(pricing.venueFactor(thin), 1);
});

test("the factor is clamped, so a thin sample cannot halve the business", () => {
  const brutal = { ...GGSEL, platform: [0.75, 0.75, 0.75], global: [10, 12, 14, 16] };
  assert.strictEqual(pricing.venueFactor(brutal), pricing.VENUE_FACTOR_MIN);
  const giddy = { ...GGSEL, platform: [40, 44, 48], global: [1, 1.2, 1.4, 1.6] };
  assert.strictEqual(pricing.venueFactor(giddy), pricing.VENUE_FACTOR_MAX);
});

test("REGRESSION: a cross-market anchor is scaled down to the cheap venue", () => {
  const out = pricing.priceListing({
    evidence: GGSEL,
    itemCount: 1,
    marketplace: "ggsel",
  });
  assert.strictEqual(out.basis, "game", "the ladder still falls through to `game`");
  assert.ok(out.venueFactor < 1, "and it must be rescaled, got " + out.venueFactor);
  const unscaled = 2.3; // median of GGSEL.game
  assert.ok(
    out.anchor < unscaled,
    "anchor " + out.anchor + " should sit below the cross-market median " + unscaled,
  );
  assert.match(out.reason, /scaled x0\.\d+ to ggsel's own price level/);
});

test("a venue-specific anchor is NOT rescaled — it is already this venue's money", () => {
  const own = { ...GGSEL, platformGame: [0.75, 0.8, 0.9, 1.0] };
  const out = pricing.priceListing({ evidence: own, marketplace: "ggsel" });
  assert.strictEqual(out.basis, "platformGame");
  assert.strictEqual(out.venueFactor, 1, "rescaling this would double-count the venue");
});

test("Gameflip is left where it is — this is a GGSel fix, not a repricing of the business", () => {
  // gameflip median $1.25 against a global median of $1.28: the factor is ~0.98,
  // which must not move a Gameflip price by anything a buyer would notice.
  const gf = {
    platformGame: [],
    game: [1.2, 1.25, 1.3, 1.4],
    platform: [0.75, 1.0, 1.25, 1.25, 1.5, 2.0, 5.0],
    global: [0.75, 1.0, 1.28, 1.28, 1.5, 2.0, 5.0],
    marketplace: "gameflip",
  };
  const out = pricing.priceListing({ evidence: gf, marketplace: "gameflip" });
  assert.ok(
    out.venueFactor >= 0.9 && out.venueFactor <= 1.1,
    "gameflip must barely move, got x" + out.venueFactor,
  );
});

/* ============ 3. the ceiling is the venue's own, once it can speak ====== */

test("REGRESSION: the ceiling is built from this venue's takings, not the business's", () => {
  // $10.00 cleared a ceiling made of Gameflip money. GGSel's own maximum is
  // $3.00; with headroom 2 that is $6.00, and $10.00 no longer fits.
  const out = pricing.priceListing({ evidence: GGSEL, marketplace: "ggsel" });
  assert.strictEqual(out.observedMax, 3, "ggsel's own max, not the global $5.00");
});

test("an unproven venue still gets the business-wide ceiling", () => {
  // zeusx/eldorado/g2g have never recorded a priced sale. Giving them a ceiling
  // of 0 would pin every listing to the floor forever.
  const unproven = { ...GGSEL, platform: [], marketplace: "zeusx" };
  const out = pricing.priceListing({ evidence: unproven, marketplace: "zeusx" });
  assert.ok(out.observedMax >= 5, "expected the global max, got " + out.observedMax);
});

/* ============ 4. the rent-farm rule ==================================== */

test("a rent-farm listing is never repriced by the sweep", () => {
  // The owner's rule, 2026-09-09: "ggsell market is so cheap so we have to be as
  // well BUT renter listings are same price". A farming window is a different
  // product from a drop bundle and its price is set by hand.
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "scripts/reprice-listings.js"),
    "utf8",
  );
  assert.match(src, /classifyKind/, "the sweep must classify the product kind");
  assert.match(
    src,
    /=== "farm"/,
    "and skip farm rows explicitly, not merely by origin",
  );
});

/* ============ 5. the publisher, not just the sweep ===================== */
//
// Repricing the 204 live rows fixes today. `derivePrice` publishing a Gameflip
// price to GGSel is what put them there, and would do it again tomorrow.

test("REGRESSION: the GGSel publisher translates the price to GGSel", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "utils/autoLister.js"),
    "utf8",
  );
  const fn = src.slice(src.indexOf("async function publishGgselShare("));
  const head = fn.slice(0, fn.indexOf("reserveAccountsForPublish"));
  assert.match(
    head,
    /price = await venuePrice\("ggsel", price, \{ title \}\)/,
    "the published price must be adapted before it is used",
  );
});

test("the adapted price is what the row records, not the Gameflip one", () => {
  // If the venue price were applied at the marketplace call only, the
  // MarketplaceListing row would keep the Gameflip number and every later
  // drift check would compare against a price that was never live.
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "utils/autoLister.js"),
    "utf8",
  );
  const fn = src.slice(src.indexOf("async function publishGgselShare("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  const adaptAt = body.indexOf("venuePrice(");
  const createAt = body.indexOf("MarketplaceListing.create(");
  assert.ok(adaptAt > 0 && createAt > adaptAt, "adapt before the row is written");
});

test("Gameflip and rent-farm rows come back untouched", async () => {
  const autoLister = require("../utils/autoLister");
  assert.strictEqual(
    await autoLister.venuePrice("gameflip", 2.5, { title: "Rust Twitch Drops (2 Items)" }),
    2.5,
    "the base price IS the Gameflip price",
  );
  assert.strictEqual(
    await autoLister.venuePrice("ggsel", 4, {
      title: "Rust Twitch Drops Automatic Farming 180 days",
    }),
    4,
    "a farming window is priced by hand — the owner's rule",
  );
  assert.strictEqual(
    await autoLister.venuePrice("ggsel", 0, { title: "x" }),
    0,
    "no price in, no price out",
  );
});
