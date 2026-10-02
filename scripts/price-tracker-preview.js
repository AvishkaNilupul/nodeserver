/**
 * Price tracker preview — serves the real page and the real API router from a
 * saved snapshot, with NO database, NO auth and NO marketplace calls.
 *
 * This is how the tracker is verified before it is anywhere near production.
 * The router is the same one server.js would mount; only its guards and its data
 * source are swapped (a stub session, and a JSON snapshot instead of Mongo).
 *
 *   node scripts/price-tracker-preview.js <snapshot.json> [port]
 *   open http://localhost:4130/price-tracker.html
 *
 * The "Market radar" tab is fed from the captured public-market rows in
 * tests/fixtures/marketRadar (MARKET_FIXTURES=<dir> to use others), run through the
 * radar's own planner as two scans six hours apart, against our listings from the
 * snapshot. Demo data only: nothing is written anywhere.
 *
 * Producing a snapshot: a read-only bounded export of MarketplaceListing,
 * SaleSignal(listing_sold) and the referenced DropSets (see
 * utils/priceTracker/index.js loadFromDb for the exact projections).
 */
const path = require("path");
const express = require("express");
const T = require("../utils/priceTracker");
const createRouter = require("../routes/priceTrackerRoutes");

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/price-tracker-preview.js <snapshot.json> [port]");
  process.exit(1);
}
const port = Number(process.argv[3]) || 4130;
const snapshot = T.loadFromSnapshot(path.resolve(file));

// A market report from captured public rows: what the radar would hold after two scans.
function previewMarketInput() {
  const fs = require("fs");
  const plan = require("../utils/marketData/plan");
  const dir = process.env.MARKET_FIXTURES || path.join(__dirname, "..", "tests", "fixtures", "marketRadar");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  const own = { gameflipOwner: "", ids: { ggsel: new Set(), plati: new Set() }, sellers: { ggsel: new Set(), plati: new Set() } };
  const t1 = new Date(Date.now() - 6 * 3600000);
  const t2 = new Date();
  const sales = [];
  const rivals = new Map();
  for (const f of files) {
    const fx = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const scan = (at, bump) => {
      const job = plan.buildJob({ game: fx.game, gfSold: fx.gfSold, gfActive: fx.gfActive, gfActiveComplete: true, gg: bump(fx.gg), pl: bump(fx.pl) }, own, at);
      sales.push(...plan.planSold(job, new Set(sales.map((x) => x.dedupeKey))));
      for (const m of ["gameflip", "ggsel", "plati"]) {
        const existing = new Map([...rivals.values()].filter((r) => r.market === m).map((r) => [r.listingId, r]));
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
    // six hours later every third product sold two more units
    scan(t2, (rows) => rows.map((r, i) => (i % 3 === 0 ? { ...r, sold: (Number(r.sold) || 0) + 2 } : r)));
  }
  const ownListings = (snapshot.listings || [])
    .filter((l) => l.status === "active" && (l.marketplace === "gameflip" || l.marketplace === "ggsel"))
    .map((l) => ({ marketplace: l.marketplace, externalId: l.externalId, title: l.title, price: l.price, origin: l.origin }));
  return { sales, rivals: [...rivals.values()], ownListings, research: [], truncated: {} };
}

const PREVIEW_SETTINGS = {
  noClaimGames: ["overwatch", "rainbow six", "call of duty"],
  shelfCaps: { overwatch: 50, "rainbow six": 50 },
  reuseOnlyGames: ["world of tanks", "ufl"],
  sizing: { coverageDays: 28, safetyStock: 6, maxAccounts: 250 },
};

function previewMarketReport(days) {
  const { buildMarketReport } = require("../utils/marketData/analyze");
  const { windowOf } = require("../utils/marketData/report");
  return buildMarketReport(previewMarketInput(), { windowDays: windowOf(days) });
}

// The "Farm brain (test)" tab: one run of the brain's REAL model over the snapshot, the preview
// market report and the auto-farm's REAL demandAllocation (fed the snapshot's research and the
// tracker's replay of the engine's sale count). Live campaigns are the research rows' campaigns;
// the no-claim rows use the feeder's rule on the snapshot's sales, so today and the brain agree
// there by construction. Demo data, computed in memory: nothing is read live or written.
function previewBrain() {
  const BM = require("../utils/demandBrain/model");
  const BI = require("../utils/demandBrain/inputs");
  const G = require("../utils/priceTracker/games");
  const farmSizing = require("../utils/farmSizing");
  const { normGame } = require("../utils/priceTracker/setIdentity");
  const now = new Date(snapshot.at).getTime();
  const report = T.buildReport(snapshot, PREVIEW_SETTINGS);
  // The live brain reads 135 days of connection flips; a snapshot holds what it holds.
  report.saleLog = BI.saleLogFrom(G, { sales: report.ledger.sales.concat(report.ledger.demandOnly || []), connected: snapshot.connected || [], now, days: BM.HISTORY_DAYS });
  const radar = previewMarketReport(30);
  const radarByKey = new Map(radar.games.map((r) => [r.key, r]));
  const gameRows = new Map(report.games.map((g) => [g.key, g]));
  const spans = BM.listingSpans(report.prepared.rows, now);
  const ncKeys = PREVIEW_SETTINGS.noClaimGames;
  const isNc = (k) => ncKeys.some((n) => k.includes(n));
  const af = { maxPerGame: 30, probeSize: 15, probeColdStart: true, probeMaxSellers: 1, coverageSizing: true, coverageDays: 28, coverageSafetyStock: 6, coverageMaxPerGame: 250 };
  let demandAllocation = null;
  try {
    demandAllocation = require("../utils/autoFarmer").demandAllocation;
  } catch {
    demandAllocation = null;
  }
  const live = new Map();
  for (const r of snapshot.research || []) {
    const c = r.campaign;
    if (!c || !(c.active || c.upcoming)) continue;
    const end = c.endAt ? new Date(c.endAt).getTime() : null;
    if (end != null && end <= now) continue;
    live.set(normGame(r.game), { label: r.game, hoursLeft: end == null ? null : (end - now) / 3600000 });
  }
  const keys = new Set();
  for (const k of live.keys()) keys.add(k);
  for (const [k, e] of report.saleLog) if (e.some((x) => x.t > now - 45 * 86400000)) keys.add(k);
  for (const r of radar.games) if (r.perWeek > 0) keys.add(r.key);
  const researchByKey = new Map((snapshot.research || []).map((r) => [normGame(r.game), r]));
  const claim = [...keys]
    .filter((k) => k && !isNc(k))
    .map((key) => {
      const g = gameRows.get(key) || null;
      const rr = radarByKey.get(key) || null;
      const label = (live.get(key) && live.get(key).label) || (g && g.game) || (rr && rr.game) || key;
      const sales = g ? { count: g.demand.engine.count45, revenue: 0, avgPrice: g.demand.engine.avgPrice } : { count: 0, revenue: 0, avgPrice: 0 };
      let old;
      try {
        old = demandAllocation ? { alloc: demandAllocation(researchByKey.get(key) || null, af, sales, { probeAllowed: true, game: label }), sales } : { error: "engine not loadable in the preview" };
      } catch (e) {
        old = { error: e.message };
      }
      const value = g && g.price.valuePerAccount > 0 ? g.price.valuePerAccount : rr && rr.realised && rr.realised.median ? Math.round(rr.realised.median * 0.85 * 100) / 100 : 0;
      return {
        key,
        label,
        live: live.has(key),
        hoursLeft: live.has(key) ? live.get(key).hoursLeft : null,
        reuseOnly: PREVIEW_SETTINGS.reuseOnlyGames.includes(key),
        entries: report.saleLog.get(key) || [],
        spans: spans.get(key) || [],
        radar: rr,
        value,
        valueBasis: g && g.price.valuePerAccount > 0 ? "our sales" : "rivals' sold price",
        gameCap: 0,
        stock: g ? { onHand: g.farm.onHand, inFlight: g.farm.inFlight } : null,
        act: g && g.farm.engine ? { d: g.farm.engine.decision, at: g.farm.engine.decidedAt, t: g.farm.engine.target } : null,
        old,
      };
    });
  const noclaim = ncKeys.map((bucket) => {
    const entries = [];
    for (const [k, e] of report.saleLog) if (k.includes(bucket)) entries.push(...e);
    entries.sort((a, b) => a.t - b.t);
    const r = BM.v2Rates(entries, now, null);
    const t = farmSizing.shelfAwareTarget({ shelfHeld: 50, shelfPerWeek: r.shelf, otherPerWeek: r.other, coverageDays: 28, safetyStock: 6 }).target;
    const label = bucket.replace(/\b\w/g, (c) => c.toUpperCase());
    return {
      snapRow: { key: bucket, label, target: t, onHand: 50, sales: { perWeek: r.total, shelfPerWeek: r.shelf, otherPerWeek: r.other }, stock: { listed: 50, inFlight: 0 }, policy: { coverageDays: 28, safetyStock: 6, min: 0, max: 600 } },
      entries,
      spans: [],
      radarRows: radar.games,
      keywords: ncKeys,
      live: bucket !== "call of duty",
    };
  });
  const engine = { floor: 18, maxPerGame: 30 };
  const cfg = { ...BM.readConfig({ demandBrain: { enabled: true } }), sizing: { coverageDays: 28, safetyStock: 6, maxPerGame: 250 }, probeSize: 15, engine, v2: "brain" };
  const run = BM.buildRun({ now, cfg, sizing: cfg.sizing, probeSize: 15, engine, claim, noclaim });
  const doc = { at: new Date(now), v: BM.MODEL_VERSION, ms: 1200, cfg, summary: run.summary, counts: { claimGames: claim.length, noclaim: noclaim.length }, notes: ["Preview: one run over a saved snapshot. Nothing is read live or written."], rows: run.rows, persisted: true };
  const games = [];
  for (const [key, entries] of report.saleLog) if (!isNc(key)) games.push({ key, farm: "claim", entries, spans: spans.get(key) || [] });
  for (const n of noclaim) games.push({ key: n.snapRow.key, farm: "noclaim", entries: n.entries, spans: [] });
  return {
    status: () => ({ config: cfg, model: BM.MODEL_VERSION, started: false, running: false, runs: 1, lastRunAt: doc.at, lastMs: doc.ms, lastError: "", nextRunAt: null, summary: run.summary }),
    latest: async () => doc,
    gameHistory: async (key, farm) => run.rows.filter((r) => r.k === key && r.f === farm).map((r) => ({ at: doc.at, v: doc.v, ...r })),
    accuracy: async () => ({
      at: new Date(now),
      evidenceAt: new Date(now),
      model: BM.MODEL_VERSION,
      estimators: BM.ESTIMATORS,
      samples: 0,
      backtest: BM.backtest({ games, now, weeks: 6 }),
      forward: { runsScored: 0, runsWaiting: 1, scores: {}, best: {} },
      review: [],
    }),
  };
}

const app = express();
app.get("/whoami", (_req, res) => res.json({ username: "preview", role: "superadmin", name: "Preview" }));
app.use(
  createRouter({
    // The preview is read-only too: the loader returns the same snapshot every time.
    // The settings the live router reads (cover days, per-game caps, no-claim games,
    // shelf caps) are fixed here to production's values at the time of writing.
    getReport: (opts = {}) => Promise.resolve(T.buildReport(snapshot, { ...PREVIEW_SETTINGS, ...opts })),
    getMarketReport: (opts = {}) => Promise.resolve(previewMarketReport(opts.days)),
    marketStatus: () => ({ config: { enabled: false }, status: require("../utils/marketData").status() }),
    brain: previewBrain(),
  }),
);
app.use(express.static(path.join(__dirname, "..", "public")));
app.listen(port, "127.0.0.1", () => console.log("price tracker preview on http://localhost:" + port + "/price-tracker.html"));
