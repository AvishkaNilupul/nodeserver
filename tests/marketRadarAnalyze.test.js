// The market radar's read side (utils/marketData/analyze.js): every number on the "Market radar"
// tab comes from buildMarketReport, so each rule is pinned with hand-computed inputs.
//   - our rows are never rivals; they are counted as ours;
//   - prices are over sale EVENTS, units are summed;
//   - a rate is over the days each market was actually observed;
//   - comparable = same market + same kind + half-to-double size (the pricer's own rule);
//   - the flags only fire on enough evidence (3+ samples).
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../utils/marketData/analyze");

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const ago = (d) => new Date(NOW - d * DAY);
let seq = 0;
const sale = (o = {}) => ({
  market: "gameflip",
  listingId: "s" + seq++,
  game: "Alpha",
  gameKey: "alpha",
  title: "Alpha Twitch Drops (3 Items) — X",
  itemCount: 3,
  kind: "drops",
  priceUsd: 1,
  units: 1,
  seller: "r1",
  sellerName: "",
  soldAt: ago(1),
  prevObservedAt: null,
  ttsHours: 10,
  source: "sold-feed",
  ours: false,
  firstSeenAt: ago(1),
  ...o,
});
const rival = (o = {}) => ({
  market: "gameflip",
  listingId: "r" + seq++,
  game: "Alpha",
  gameKey: "alpha",
  title: "Alpha Twitch Drops (3 Items) — Y",
  itemCount: 3,
  kind: "drops",
  seller: "r1",
  sellerName: "",
  priceUsd: 1.5,
  priceHistory: [],
  counter: null,
  ours: false,
  firstSeenAt: ago(5),
  lastSeenAt: ago(0.5),
  goneAt: null,
  outcome: "",
  ...o,
});
const build = (input, opts = {}) => A.buildMarketReport(input, { now: NOW, windowDays: 30, ...opts });
const game = (r, key = "alpha") => r.games.find((g) => g.key === key);

test("our own sales and listings are never rivals: they are counted as ours", () => {
  const r = build({
    sales: [sale({ priceUsd: 1 }), sale({ priceUsd: 9, ours: true, seller: "ME" })],
    rivals: [rival(), rival({ ours: true, seller: "ME", priceUsd: 0.5 })],
  });
  const g = game(r);
  assert.strictEqual(g.units, 1);
  assert.strictEqual(g.realised.median, 1, "our $9 sale is not market evidence");
  assert.strictEqual(g.oursSold, 1);
  assert.strictEqual(g.rivalsLive, 1);
  assert.strictEqual(g.oursLive, 1);
  assert.strictEqual(g.gameflipShare, 50);
  assert.ok(!r.sellers.some((s) => s.label.includes("ME")), "we are not on the rival board");
});

test("prices are over sale EVENTS and units are summed (a counter rise of 3 at one price is one observation)", () => {
  const r = build({
    sales: [sale({ market: "ggsel", source: "counter", units: 3, priceUsd: 2, ttsHours: null, prevObservedAt: ago(2) }), sale({ market: "ggsel", source: "counter", units: 1, priceUsd: 1, ttsHours: null, prevObservedAt: ago(2) })],
    rivals: [rival({ market: "ggsel", firstSeenAt: ago(2) })],
  });
  const g = game(r);
  assert.strictEqual(g.units, 4);
  assert.strictEqual(g.orders, 2);
  assert.strictEqual(g.realised.n, 2);
  assert.strictEqual(g.realised.median, 1.5);
});

test("a rate is units over the days EACH market was observed, never one shared window", () => {
  const r = build({
    sales: [
      // Gameflip, first recorded today: its sold feed reached ~3 weeks back, so 21+ days were watched
      sale({ soldAt: ago(20), firstSeenAt: ago(1) }),
      sale({ soldAt: ago(10), firstSeenAt: ago(1) }),
      sale({ soldAt: ago(1), firstSeenAt: ago(1) }),
      // GGSel only watched for 1 day: 7 units in that day
      sale({ market: "ggsel", source: "counter", units: 7, ttsHours: null, prevObservedAt: ago(1), soldAt: ago(0.1), firstSeenAt: ago(0.1) }),
    ],
    rivals: [rival({ market: "ggsel", firstSeenAt: ago(1) })],
  });
  const g = game(r);
  assert.strictEqual(g.byMarket.gameflip.observedDays, 22, "first recorded a day ago + the feed's 21-day reach");
  assert.strictEqual(g.byMarket.gameflip.perWeek, 1, "3 over 22 days");
  assert.strictEqual(g.byMarket.ggsel.observedDays, 1);
  assert.strictEqual(g.byMarket.ggsel.perWeek, null, "one day of counter rises is not a weekly rate (it would read 49/wk)");
  assert.strictEqual(g.perWeek, 1, "the total holds only the markets watched long enough");
  assert.strictEqual(g.ratePartial, true, "and says a market was left out");
  // three days of watching: now it is a rate, and it adds up
  const r3 = build({
    sales: [sale({ soldAt: ago(20), firstSeenAt: ago(1) }), sale({ soldAt: ago(10), firstSeenAt: ago(1) }), sale({ soldAt: ago(1), firstSeenAt: ago(1) }), sale({ market: "ggsel", source: "counter", units: 7, ttsHours: null, prevObservedAt: ago(3), soldAt: ago(0.1) })],
    rivals: [rival({ market: "ggsel", firstSeenAt: ago(3) })],
  });
  const g3 = game(r3);
  assert.strictEqual(g3.byMarket.ggsel.perWeek, 16.3);
  assert.strictEqual(g3.perWeek, 17.3);
  assert.strictEqual(g3.ratePartial, false);
  // nothing watched long enough at all: unknown, not zero
  const fresh = game(build({ sales: [sale({ market: "ggsel", source: "counter", units: 4, ttsHours: null, prevObservedAt: ago(0.5), soldAt: ago(0.1) })], rivals: [rival({ market: "ggsel", firstSeenAt: ago(0.5) })] }));
  assert.strictEqual(fresh.perWeek, null);
});

test("day one on Gameflip: two sales in the last two days are about 0.7 a week (the feed showed three weeks), not 7", () => {
  const r = build({ sales: [sale({ soldAt: ago(2.1), firstSeenAt: ago(0) }), sale({ soldAt: ago(0.5), firstSeenAt: ago(0) })], rivals: [rival({ firstSeenAt: ago(0) })] });
  const g = game(r);
  assert.strictEqual(g.byMarket.gameflip.observedDays, 21);
  assert.strictEqual(g.byMarket.gameflip.perWeek, 0.7);
});

test("the exchange rate is not a price war: rouble prices unchanged means no move; a rouble cut is a cut", () => {
  const pts = (a, b) => [{ at: ago(1.5), price: a[0], native: a[1] }, { at: ago(0.5), price: b[0], native: b[1] }];
  // five GGSel rivals: every USD price slipped 1% with the rouble, roubles unchanged
  const fx = build({ rivals: [1, 2, 3, 4, 5].map((i) => rival({ market: "ggsel", seller: "s" + i, priceHistory: pts([2.39, 199], [2.37, 199]) })) });
  assert.strictEqual(fx.priceMoves.length, 0);
  assert.ok(!game(fx).flags.some((f) => f.id === "price-war"));
  // three sellers really cut (roubles): a price war, shown in roubles too
  const war = build({ rivals: [1, 2, 3].map((i) => rival({ market: "ggsel", seller: "s" + i, priceHistory: pts([2.39, 199], [1.79, 149]) })) });
  assert.strictEqual(war.priceMoves.length, 3);
  assert.deepStrictEqual([war.priceMoves[0].fromNative, war.priceMoves[0].toNative, war.priceMoves[0].cut], [199, 149, true]);
  assert.ok(game(war).flags.some((f) => f.id === "price-war"));
  // a rouble RAISE whose USD figure fell with the rate is a raise, not a cut
  const up = build({ rivals: [rival({ market: "ggsel", priceHistory: pts([2.39, 199], [2.3, 205]) })] });
  assert.strictEqual(up.priceMoves[0].cut, false);
});

test("on GGSel our listing is compared at the price the market shows NOW (both sides drift with the rouble)", () => {
  // stored when we published: $1.50; the market now shows our offer at $1.20, the rival at $1.25
  const ourRow = rival({ market: "ggsel", ours: true, listingId: "OUR1", priceUsd: 1.2, title: "Alpha Twitch Drops (3 Items) — Pack" });
  const rivalRow = rival({ market: "ggsel", priceUsd: 1.25 });
  const listing = { marketplace: "ggsel", externalId: "OUR1", title: "Alpha Twitch Drops (3 Items) — Pack", price: 1.5, origin: "auto" };
  const r = build({ rivals: [ourRow, rivalRow], ownListings: [listing] });
  assert.strictEqual(r.undercuts.length, 0, "at today's rate we are the cheaper one");
  // not seen by the radar: our stored price is the fallback, and the page says so
  const r2 = build({ rivals: [rivalRow], ownListings: [listing] });
  assert.strictEqual(r2.undercuts[0].ourPrice, 1.5);
  assert.strictEqual(r2.undercuts[0].ourPriceBasis, "our stored price");
  const r3 = build({ rivals: [rival({ market: "ggsel", ours: true, listingId: "OUR1", priceUsd: 1.4 }), rivalRow], ownListings: [listing] });
  assert.deepStrictEqual([r3.undercuts[0].ourPrice, r3.undercuts[0].ourPriceBasis], [1.4, "as the market shows it"]);
});

test("our bulk packs (priced per pack) and rent-farm rows are never 'undercut' by single bundles", () => {
  const live = [rival({ priceUsd: 1 })];
  const base = { marketplace: "gameflip", externalId: "P", title: "Alpha Twitch Drops (3 Items) — PACK OF 5 ACCOUNTS", price: 4.5, origin: "auto" };
  assert.strictEqual(build({ rivals: live, ownListings: [{ ...base, bulkOfferId: "b1" }] }).undercuts.length, 0);
  assert.strictEqual(build({ rivals: live, ownListings: [{ ...base, rentFarm: true }] }).undercuts.length, 0);
  assert.strictEqual(build({ rivals: live, ownListings: [base] }).undercuts.length, 1, "the same row without those marks would be flagged");
  assert.strictEqual(game(build({ rivals: live, ownListings: [{ ...base, bulkOfferId: "b1" }] })).oursListed, 1, "a pack still counts as us listing the game");
});

test("a game whose market was not re-read for days says so (its live counts are out of date)", () => {
  const stale = build({ rivals: [rival()], research: [{ game: "Alpha", scannedAt: ago(5) }] });
  const f = game(stale).flags.find((x) => x.id === "stale-scan");
  assert.ok(f && /5 days ago/.test(f.text));
  assert.ok(!game(build({ rivals: [rival()], research: [{ game: "Alpha", scannedAt: ago(1) }] })).flags.some((x) => x.id === "stale-scan"));
  assert.ok(!game(build({ rivals: [rival()], research: [] })).flags.some((x) => x.id === "stale-scan"), "no research doc: nothing claimed");
});

test("a rent-farm window is listed but is never a drops rival, and our own farm offers are never 'undercut'", () => {
  const farmTitle = "Alpha Automatic Farming 1 Year";
  const r = build({
    rivals: [rival({ title: farmTitle, kind: "farm", priceUsd: 4 }), rival({ title: "Alpha Automatic Farming 120 Days", kind: "farm", priceUsd: 3 }), rival({ priceUsd: 1 })],
    ownListings: [{ marketplace: "gameflip", externalId: "FARM", title: farmTitle, price: 8, origin: "manual" }],
  });
  const g = game(r);
  assert.strictEqual(g.byMarket.gameflip.live, 1, "only the drops rival counts");
  assert.strictEqual(g.byMarket.gameflip.farmLive, 2);
  assert.strictEqual(g.rivalsLive, 1);
  assert.strictEqual(r.undercuts.length, 0, "an $8 one-year window is not 'undercut' by a 120-day one");
  assert.strictEqual(r.liveByGame.get("alpha").filter((l) => l.kind === "farm").length, 2, "but both are listed, labelled");
});

test("'we do not list it' is read from our real live listings, not from the rows a search page happened to show", () => {
  const sold = [1, 2, 3, 4, 5].map(() => sale());
  const withOurs = build({ sales: sold, rivals: [rival()], ownListings: [{ marketplace: "ggsel", externalId: "X", title: "Alpha Twitch Drops (3 Items)", price: 1 }] });
  assert.ok(!game(withOurs).flags.some((f) => f.id === "not-selling"), "we have a GGSel listing even though no scan showed it");
  assert.strictEqual(game(withOurs).oursListed, 1);
  const without = build({ sales: sold, rivals: [rival()] });
  assert.ok(game(without).flags.some((f) => f.id === "not-selling"));
});

test("the window: a sale older than it does not count, and a stale or gone rival is not live", () => {
  const r = build({
    sales: [sale({ soldAt: ago(31) }), sale({ soldAt: ago(29) })],
    rivals: [rival({ lastSeenAt: ago(4) }), rival({ goneAt: ago(1) }), rival(), rival({ market: "ggsel", lastSeenAt: ago(6) }), rival({ market: "ggsel", lastSeenAt: ago(8) })],
  });
  const g = game(r);
  assert.strictEqual(g.units, 1);
  assert.strictEqual(g.byMarket.gameflip.live, 1, "Gameflip rivals older than 3 days or gone are not live");
  assert.strictEqual(g.byMarket.ggsel.live, 1, "GGSel rivals are live for 7 days");
  assert.strictEqual(build({ sales: [sale({ soldAt: ago(6) })] }, { windowDays: 7 }).games[0].units, 1);
  assert.strictEqual(build({ sales: [sale({ soldAt: ago(8) })] }, { windowDays: 7 }).games.length, 0);
});

test("size bands: a 148-item collection is its own band, and the collector flag needs 3+ sales on each side", () => {
  const big = (p) => sale({ itemCount: 148, title: "Alpha 148 Items", priceUsd: p });
  const small = (p) => sale({ itemCount: 3, priceUsd: p });
  const r = build({ sales: [big(6), big(5.5), big(9), small(1), small(1.2), small(0.9)] });
  const g = game(r);
  const b100 = g.bands.find((b) => b.band === "100+");
  assert.deepStrictEqual([b100.n, b100.median], [3, 6]);
  assert.strictEqual(g.bands.find((b) => b.band === "2-3").median, 1);
  const flag = g.flags.find((f) => f.id === "collector-niche");
  assert.ok(flag, "6 >= 2 x 1");
  assert.match(flag.text, /\$6 \(3 sales\) vs \$1 for small bundles/);
  // two big sales are an anecdote
  assert.ok(!game(build({ sales: [big(6), big(7), small(1), small(1), small(1)] })).flags.some((f) => f.id === "collector-niche"));
  // big but not 2x the small median
  assert.ok(!game(build({ sales: [big(1.5), big(1.5), big(1.5), small(1), small(1), small(1)] })).flags.some((f) => f.id === "collector-niche"));
  // no small evidence: needs $4+
  assert.ok(game(build({ sales: [big(4), big(5), big(6)] })).flags.some((f) => f.id === "collector-niche"));
  assert.ok(!game(build({ sales: [big(2), big(3), big(3)] })).flags.some((f) => f.id === "collector-niche"));
});

test("time-to-sell flags: fast at a day or less, slow at a week or more, nothing on fewer than 3 sales", () => {
  const tts = (hs) => game(build({ sales: hs.map((h) => sale({ ttsHours: h })) })).flags.map((f) => f.id);
  assert.ok(tts([5, 10, 24]).includes("fast"));
  assert.ok(tts([200, 170, 168]).includes("slow"));
  assert.ok(!tts([5, 10]).includes("fast"));
  assert.deepStrictEqual(tts([30, 40, 50]).filter((f) => f === "fast" || f === "slow"), []);
  assert.strictEqual(game(build({ sales: [sale({ ttsHours: null }), sale({ ttsHours: 4 })] })).medianTtsHours, 4, "unknown time-to-sell is left out, not zero");
});

test("undercuts: only comparable LIVE rivals on the SAME market and game, cheaper than our price", () => {
  const ours = { marketplace: "gameflip", externalId: "OUR1", title: "Alpha Twitch Drops (3 Items) — Pack", price: 2, origin: "auto" };
  const r = build({
    sales: [sale({ priceUsd: 1.7 }), sale({ priceUsd: 1.9 }), sale({ priceUsd: 1.8 }), sale({ priceUsd: 5, itemCount: 40, title: "Alpha (40 Items)" })],
    rivals: [
      rival({ priceUsd: 1.5, title: "Alpha Twitch Drops (3 Items)" }), // comparable, cheaper
      rival({ priceUsd: 1.8, title: "Alpha Twitch Drops (4 Items)" }), // comparable (half-to-double), cheaper
      rival({ priceUsd: 2.5, title: "Alpha Twitch Drops (2 Items)" }), // comparable, dearer
      rival({ priceUsd: 0.9, title: "Alpha Twitch Drops (40 Items)", itemCount: 40 }), // different size
      rival({ priceUsd: 0.5, title: "Alpha Automatic farming 30 days" }), // different product
      rival({ priceUsd: 0.6, market: "ggsel", title: "Alpha Twitch Drops (3 Items)" }), // other market
      rival({ priceUsd: 0.7, lastSeenAt: ago(5) }), // stale
      rival({ priceUsd: 0.4, ours: true }), // ours
    ],
    ownListings: [ours, { ...ours, externalId: "NOPRICE", price: 0 }, { ...ours, externalId: "NOGAME", title: "Some bundle" }, { ...ours, externalId: "Z", marketplace: "eldorado" }],
  });
  assert.strictEqual(r.undercuts.length, 1);
  const u = r.undercuts[0];
  assert.strictEqual(u.externalId, "OUR1");
  assert.strictEqual(u.comparable, 3);
  assert.strictEqual(u.cheaper, 2);
  assert.strictEqual(u.cheapest.price, 1.5);
  assert.strictEqual(u.gapPct, 25);
  assert.strictEqual(u.rivalMedian, 1.8);
  assert.strictEqual(u.soldMedian, 1.8, "what rivals' buyers paid for this size (3 sales, the 40-item one excluded)");
  assert.strictEqual(u.soldN, 3);
  assert.strictEqual(u.origin, "auto");
  assert.ok(game(r).flags.some((f) => f.id === "undercut"));
});

test("an undercut needs a truly cheaper rival (a cent of rounding is not one), and a manual row is reported, labelled", () => {
  const ours = { marketplace: "ggsel", externalId: "G1", title: "Alpha Twitch Drops (3 Items) — Pack", price: 1.5, origin: "manual" };
  const same = build({ rivals: [rival({ market: "ggsel", priceUsd: 1.496 })], ownListings: [ours] });
  assert.strictEqual(same.undercuts.length, 0);
  const r = build({ rivals: [rival({ market: "ggsel", priceUsd: 1.2 })], ownListings: [ours] });
  assert.strictEqual(r.undercuts[0].origin, "manual");
  assert.strictEqual(r.undercuts[0].soldMedian, null, "fewer than 3 sales: no sold median");
});

test("the rival board: everyone with a sale or a live listing, ranked by units, Gameflip ids shortened", () => {
  const r = build({
    sales: [sale({ seller: "us-east-1:aaaaaaaa-1111", priceUsd: 2 }), sale({ seller: "us-east-1:aaaaaaaa-1111", priceUsd: 4, units: 1 }), sale({ market: "ggsel", seller: "77", sellerName: "ShopX", source: "counter", units: 5, ttsHours: null, prevObservedAt: ago(2) })],
    rivals: [rival({ seller: "LIVEONLY", sellerName: "", sellerScore: 0.8, sellerRatings: 40 }), rival({ seller: "us-east-1:aaaaaaaa-1111" })],
  });
  assert.deepStrictEqual(r.sellers.map((s) => [s.market, s.label, s.units, s.live]), [
    ["ggsel", "ShopX", 5, 0],
    ["gameflip", "seller …a-1111", 2, 1],
    ["gameflip", "seller …VEONLY", 0, 1],
  ]);
  const gfSeller = r.sellers[1];
  assert.strictEqual(gfSeller.medianPrice, 3);
  assert.strictEqual(gfSeller.revenueUsd, 6);
  assert.strictEqual(r.sellers[2].score, 0.8, "a live-only seller still shows its reputation");
  assert.strictEqual(r.sellers[2].medianPrice, null);
});

test("price moves: the last two price points within a week; three cuts make a price war", () => {
  const moved = (from, to, d) => rival({ priceHistory: [{ at: ago(d + 1), price: from }, { at: ago(d), price: to }] });
  const r = build({ rivals: [moved(2, 1.5, 1), moved(2, 1.8, 2), moved(1.5, 1.2, 3), moved(1, 1.5, 1), moved(3, 2, 9), moved(1, 1.004, 1)] });
  assert.strictEqual(r.priceMoves.length, 4, "older than a week and sub-cent moves are not moves");
  assert.deepStrictEqual(r.priceMoves.map((p) => [p.from, p.to]), [[2, 1.5], [1, 1.5], [2, 1.8], [1.5, 1.2]]);
  assert.ok(game(r).flags.some((f) => f.id === "price-war" && /3 rival price cuts/.test(f.text)));
});

test("flags for a market we are absent from, and for a market where we have no rival", () => {
  const absent = build({ sales: [1, 2, 3, 4, 5].map(() => sale()), rivals: [rival()] });
  assert.ok(game(absent).flags.some((f) => f.id === "not-selling"));
  const alone = build({ rivals: [rival({ ours: true })] });
  assert.ok(game(alone).flags.some((f) => f.id === "alone"));
  const crowded = build({ rivals: Array.from({ length: 8 }, (_, i) => rival({ seller: "s" + i })) });
  assert.ok(game(crowded).flags.some((f) => f.id === "crowded"));
});

test("the detail view's live listings carry a public link and our own flag, cheapest first per market", () => {
  const r = build({ rivals: [rival({ priceUsd: 2, listingId: "B" }), rival({ priceUsd: 1, listingId: "A" }), rival({ market: "ggsel", priceUsd: 0.5, listingId: "5367595" }), rival({ ours: true, listingId: "OURS", priceUsd: 3 })] });
  const live = r.liveByGame.get("alpha");
  assert.deepStrictEqual(live.map((l) => [l.market, l.priceUsd]), [["gameflip", 1], ["gameflip", 2], ["gameflip", 3], ["ggsel", 0.5]]);
  assert.strictEqual(live[0].url, "https://gameflip.com/item/A");
  assert.strictEqual(live[3].url, "https://ggsel.net/en/catalog/product/5367595");
  assert.strictEqual(live.find((l) => l.ours).priceUsd, 3);
  assert.strictEqual(A.listingUrl("plati", "4773868"), "https://plati.market/itm/4773868");
  assert.strictEqual(A.listingUrl("eldorado", "x"), "");
});

test("the overview adds the markets up and states its coverage", () => {
  const r = build({
    sales: [sale({ priceUsd: 1, firstSeenAt: ago(3) }), sale({ market: "ggsel", source: "counter", units: 2, priceUsd: 2, ttsHours: null, prevObservedAt: ago(2) })],
    rivals: [rival({ firstSeenAt: ago(9), lastSeenAt: ago(0.2) }), rival({ market: "plati", seller: "p1" })],
    research: [{ game: "Alpha", scannedAt: ago(0.5) }, { game: "Beta", scannedAt: ago(3) }],
  });
  assert.deepStrictEqual([r.markets.gameflip.units, r.markets.ggsel.units, r.markets.plati.liveRivals], [1, 2, 1]);
  assert.strictEqual(r.coverage.researchGames, 2);
  assert.strictEqual(r.coverage.researchFresh24h, 1);
  assert.strictEqual(r.coverage.firstRecordAt.getTime(), ago(9).getTime());
  assert.strictEqual(r.coverage.lastRecordAt.getTime(), ago(0.2).getTime());
  assert.strictEqual(game(r).researchScannedAt.getTime(), ago(0.5).getTime());
  const empty = build({});
  assert.deepStrictEqual([empty.games.length, empty.coverage.firstRecordAt, empty.coverage.lastRecordAt], [0, null, null]);
});

test("60,000 rows build in well under two seconds and never hit the argument-spread limit", () => {
  const sales = Array.from({ length: 30000 }, (_, i) => sale({ gameKey: "g" + (i % 300), game: "G" + (i % 300), soldAt: ago((i % 29) + 0.1), seller: "s" + (i % 500) }));
  const rivals = Array.from({ length: 30000 }, (_, i) => rival({ gameKey: "g" + (i % 300), game: "G" + (i % 300), seller: "s" + (i % 700) }));
  const t0 = Date.now();
  const r = build({ sales, rivals });
  assert.ok(Date.now() - t0 < 2000, "took " + (Date.now() - t0) + " ms");
  assert.strictEqual(r.games.length, 300);
  assert.strictEqual(r.coverage.salesStored, 30000);
});

test("deterministic, and never mutates its input", () => {
  const input = { sales: [sale(), sale({ market: "ggsel", units: 2, ttsHours: null, prevObservedAt: ago(1) })], rivals: [rival({ priceHistory: [{ at: ago(2), price: 2 }, { at: ago(1), price: 1 }] })], ownListings: [{ marketplace: "gameflip", externalId: "x", title: "Alpha Twitch Drops (3 Items)", price: 3 }], research: [] };
  const deepFreeze = (o) => {
    if (o && typeof o === "object" && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const v of Object.values(o)) deepFreeze(v);
    }
    return o;
  };
  deepFreeze(input);
  const strip = (r) => JSON.stringify({ ...r, liveByGame: [...r.liveByGame.entries()] });
  assert.strictEqual(strip(build(input)), strip(build(input)));
});
