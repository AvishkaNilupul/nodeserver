/* global fetch */
// The Market radar API (routes/priceTrackerRoutes.js, mountMarketRadar): served from a report
// built out of the REAL captured rows by the radar's own planner, through the real router.
//   - every endpoint answers with the shape the page reads; filters and paging work;
//   - the window (days) reaches the report; an unknown game is a 404;
//   - the router's guards sit in front of EVERY market route;
//   - raw seller ids never leave the API (labels only), our own rows are flagged.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const createRouter = require("../routes/priceTrackerRoutes");
const plan = require("../utils/marketData/plan");
const { buildMarketReport } = require("../utils/marketData/analyze");
const marvel = require("./fixtures/marketRadar/marvel-rivals.json");
const rocket = require("./fixtures/marketRadar/rocket-league.json");

// What the radar would hold after two scans six hours apart (GGSel/Plati counters rose by 2 on every third product).
function radarInput() {
  const own = { gameflipOwner: "ga-seller-1", ids: { ggsel: new Set(), plati: new Set() }, sellers: { ggsel: new Set(), plati: new Set() } };
  const sales = [];
  const rivals = new Map();
  const t1 = new Date(Date.now() - 6 * 3600000);
  const t2 = new Date();
  for (const fx of [marvel, rocket]) {
    const scan = (at, bump) => {
      const job = plan.buildJob({ game: fx.game, gfSold: fx.gfSold, gfActive: fx.gfActive, gfActiveComplete: true, gg: bump(fx.gg), pl: bump(fx.pl) }, own, at);
      sales.push(...plan.planSold(job, new Set(sales.map((x) => x.dedupeKey))));
      for (const m of ["gameflip", "ggsel", "plati"]) {
        // per game for Gameflip, by id for the others — exactly what the store reads
        const existing = new Map([...rivals.values()].filter((r) => r.market === m && (m !== "gameflip" || r.gameKey === job.gameKey)).map((r) => [r.listingId, r]));
        const rp = plan.planRivals(m, job, existing);
        sales.push(...rp.sales);
        for (const op of rp.ops) {
          const u = op.updateOne;
          const k = m + ":" + u.filter.listingId;
          if (u.update.$setOnInsert) rivals.set(k, { ...u.update.$setOnInsert });
          else if (rivals.has(k)) Object.assign(rivals.get(k), u.update.$set || {});
        }
      }
    };
    scan(t1, (rows) => rows);
    scan(t2, (rows) => rows.map((r, i) => (i % 3 === 0 ? { ...r, sold: (Number(r.sold) || 0) + 2 } : r)));
  }
  const ownListings = [
    // 8 items at $1.50: the captured rivals sell 7-8 item Marvel Rivals bundles at $0.75
    { marketplace: "gameflip", externalId: "OUR-MR-1", title: "Marvel Rivals Twitch Drops (8 Items) — Spray + Nameplate + Token", price: 1.5, origin: "auto" },
    // states no size, so every GGSel Rocket League rival is comparable; $25 is above them all
    { marketplace: "ggsel", externalId: "OUR-RL-1", title: "Rocket League Twitch Drops — Decal bundle", price: 25, origin: "manual" },
  ];
  return { sales, rivals: [...rivals.values()], ownListings, research: [{ game: "Marvel Rivals", scannedAt: new Date() }], truncated: {} };
}

let server;
let base;
const asked = [];
const input = radarInput();
test.before(async () => {
  const app = express();
  app.use(
    createRouter({
      getReport: async () => ({}),
      getMarketReport: async (o) => {
        asked.push(o);
        return buildMarketReport(input, { windowDays: Number(o.days) === 7 ? 7 : 30 });
      },
      marketStatus: () => ({ config: { enabled: true }, status: { jobsDone: 3, totals: {} } }),
    }),
  );
  const guarded = express.Router();
  const deny = (req, res) => res.status(401).json({ success: false, message: "Not signed in" });
  app.use("/guarded", createRouter({ guards: [deny], getReport: async () => ({}), getMarketReport: async () => buildMarketReport(input), marketStatus: () => ({}) }));
  void guarded;
  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());
const get = async (p) => {
  const r = await fetch(base + p);
  return { status: r.status, body: await r.json() };
};

test("overview: markets, coverage, the radar's switch and the top lists", async () => {
  const { status, body } = await get("/api/price-tracker/market/overview");
  assert.strictEqual(status, 200);
  assert.ok(body.success);
  assert.ok(body.markets.gameflip.sold.n > 0, "Gameflip sold-feed sales are counted");
  assert.ok(body.markets.ggsel.units > 0, "the GGSel counter rises are counted");
  assert.ok(body.coverage.gamesWithData >= 2);
  assert.deepStrictEqual(body.radar, { config: { enabled: true }, status: { jobsDone: 3, totals: {} } });
  assert.ok(body.topGames.length >= 2 && body.topGames.length <= 8);
  assert.ok(Array.isArray(body.topUndercuts) && Array.isArray(body.topSellers) && Array.isArray(body.recentMoves));
  assert.strictEqual(typeof body.counts.games, "number");
  assert.strictEqual(body.windowDays, 30);
});

test("the window reaches the report, and an unknown window falls back to 30 days", async () => {
  asked.length = 0;
  assert.strictEqual((await get("/api/price-tracker/market/overview?days=7")).body.windowDays, 7);
  assert.strictEqual(asked[0].days, "7");
  assert.strictEqual(asked[0].force, false);
});

test("games: sorted, filtered, paged, with per-market and size-band detail", async () => {
  const all = (await get("/api/price-tracker/market/games")).body;
  assert.ok(all.total >= 2);
  for (let i = 1; i < all.rows.length; i++) assert.ok(all.rows[i - 1].units >= all.rows[i].units, "sorted by units");
  const mr = all.rows.find((g) => g.key === "marvel rivals");
  assert.ok(mr, "Marvel Rivals is there");
  assert.ok(mr.bands.some((b) => b.band === "100+"), "the 148-item collections are their own band");
  assert.ok(mr.byMarket.gameflip.soldN > 0);
  const q = (await get("/api/price-tracker/market/games?q=rocket")).body;
  assert.deepStrictEqual(q.rows.map((g) => g.key), ["rocket league"]);
  const paged = (await get("/api/price-tracker/market/games?limit=1&offset=1")).body;
  assert.strictEqual(paged.rows.length, 1);
  assert.strictEqual(paged.rows[0].key, all.rows[1].key);
  for (const s of ["perWeek", "price", "fast", "rivals", "undercut", "nonsense"]) assert.strictEqual((await get("/api/price-tracker/market/games?sort=" + s)).status, 200);
  const none = (await get("/api/price-tracker/market/games?flag=no-such-flag")).body;
  assert.strictEqual(none.total, 0);
});

test("one game: its markets, live listings with public links, sales, rivals and our undercut listings; unknown is 404", async () => {
  const { status, body } = await get("/api/price-tracker/market/game/" + encodeURIComponent("marvel rivals"));
  assert.strictEqual(status, 200);
  assert.strictEqual(body.game.key, "marvel rivals");
  assert.ok(body.live.length > 0);
  assert.ok(body.live.every((l) => /^https:\/\/(gameflip\.com\/item\/|ggsel\.net\/en\/catalog\/product\/|plati\.market\/itm\/)/.test(l.url)), "only the three public hosts");
  assert.ok(body.live.some((l) => l.ours), "our own Gameflip rows (owner ga-seller-1) are flagged ours");
  assert.ok(body.sales.length > 0);
  assert.ok(body.sellers.length > 0);
  const u = body.undercuts.find((x) => x.externalId === "OUR-MR-1");
  assert.ok(u, "our $1.50 8-item listing has cheaper comparable rivals");
  assert.strictEqual(u.cheapest.price, 0.75);
  assert.strictEqual(u.cheaper, 4, "the four 7-8 item rows, not the 146/148-item collections or the rent-farm windows");
  assert.strictEqual((await get("/api/price-tracker/market/game/nope")).status, 404);
});

test("rivals, sales and undercuts filter by market / ours / kind / origin", async () => {
  const rivals = (await get("/api/price-tracker/market/rivals?market=ggsel")).body;
  assert.ok(rivals.total > 0 && rivals.rows.every((r) => r.market === "ggsel"));
  const ours = (await get("/api/price-tracker/market/sales?ours=1")).body;
  assert.ok(ours.rows.every((x) => x.ours));
  const theirs = (await get("/api/price-tracker/market/sales?ours=0&market=gameflip")).body;
  assert.ok(theirs.total > 0 && theirs.rows.every((x) => !x.ours && x.market === "gameflip"));
  const farm = (await get("/api/price-tracker/market/sales?kind=farm")).body;
  assert.ok(farm.rows.every((x) => x.kind === "farm"));
  const manual = (await get("/api/price-tracker/market/undercuts?origin=manual")).body;
  assert.ok(manual.rows.length >= 1 && manual.rows.every((u) => u.origin === "manual" && u.market === "ggsel"));
  const auto = (await get("/api/price-tracker/market/undercuts?origin=auto&market=gameflip")).body;
  assert.ok(auto.rows.length >= 1 && auto.rows.every((u) => u.origin === "auto" && u.market === "gameflip"));
});

test("the radar's status route answers without building a report", async () => {
  asked.length = 0;
  const { status, body } = await get("/api/price-tracker/market/status");
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body.config, { enabled: true });
  assert.strictEqual(asked.length, 0);
});

test("raw seller ids never leave the API: only labels (Gameflip ids shortened)", async () => {
  const bodies = [];
  for (const p of ["/api/price-tracker/market/overview", "/api/price-tracker/market/games?limit=200", "/api/price-tracker/market/game/" + encodeURIComponent("rocket league"), "/api/price-tracker/market/rivals?limit=200", "/api/price-tracker/market/sales?limit=200&ours=", "/api/price-tracker/market/undercuts?limit=200"]) {
    bodies.push(JSON.stringify((await get(p)).body));
  }
  const all = bodies.join("\n");
  assert.ok(!/"seller":"ga-seller-\d+"/.test(all), "the raw Gameflip owner id is not exposed as a seller");
  assert.ok(/seller …/.test(all), "Gameflip sellers appear as shortened labels");
  assert.ok(!/"listingId"/.test(all), "listing ids appear only inside the public link");
  assert.ok(!/"dedupeKey"/.test(all));
});

test("every market route is registered through a helper that spreads the guards (none can skip them)", () => {
  const src = require("fs").readFileSync(require.resolve("../routes/priceTrackerRoutes.js"), "utf8");
  const radar = src.slice(src.indexOf("function mountMarketRadar("));
  assert.match(radar, /const getM = \(path, fn\) => router\.get\(path, \.\.\.guards, wrapM\(fn\)\);/);
  assert.match(radar, /const getPlain = \(path, fn\) =>\s+router\.get\(path, \.\.\.guards, /);
  assert.ok(!/router\.(get|post|put|patch|delete)\("\/api/.test(radar), "no direct route registration");
  assert.ok(!/router\.(post|put|patch|delete)\(/.test(radar), "read-only");
});

test("a game's rival units count EVERY sale in the window, not only the 40 the sheet lists", async () => {
  const now = Date.now();
  const sales = Array.from({ length: 100 }, (_, i) => ({ market: "gameflip", listingId: "x" + i, game: "Alpha", gameKey: "alpha", title: "Alpha Twitch Drops (3 Items)", itemCount: 3, kind: "drops", priceUsd: 1, units: 1, seller: i < 60 ? "big" : "small", sellerName: "", soldAt: new Date(now - (i + 1) * 3600e3), ttsHours: 5, source: "sold-feed", ours: false, firstSeenAt: new Date(now - 3600e3) }));
  const app = express();
  app.use(createRouter({ getReport: async () => ({}), getMarketReport: async () => buildMarketReport({ sales, rivals: [], ownListings: [], research: [] }), marketStatus: () => ({}) }));
  const srv = await new Promise((r) => {
    const s2 = app.listen(0, "127.0.0.1", () => r(s2));
  });
  try {
    const j = await (await fetch("http://127.0.0.1:" + srv.address().port + "/api/price-tracker/market/game/alpha")).json();
    assert.strictEqual(j.sales.length, 40, "the sheet lists 40");
    const units = Object.fromEntries(j.sellers.map((x) => [x.seller, x.units]));
    assert.deepStrictEqual(units, { "seller …big": 60, "seller …small": 40 }, "but counts all 100");
  } finally {
    srv.close();
  }
});

test("the guards sit in front of EVERY market route", async () => {
  for (const p of ["overview", "games", "game/x", "rivals", "sales", "undercuts", "status"]) {
    const r = await fetch(base + "/guarded/api/price-tracker/market/" + p);
    assert.strictEqual(r.status, 401, p);
  }
});
