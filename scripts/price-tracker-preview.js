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

const app = express();
app.get("/whoami", (_req, res) => res.json({ username: "preview", role: "superadmin", name: "Preview" }));
app.use(
  createRouter({
    // The preview is read-only too: the loader returns the same snapshot every time.
    // The settings the live router reads (cover days, per-game caps, no-claim games,
    // shelf caps) are fixed here to production's values at the time of writing.
    getReport: (opts = {}) =>
      Promise.resolve(
        T.buildReport(snapshot, {
          noClaimGames: ["overwatch", "rainbow six", "call of duty"],
          shelfCaps: { overwatch: 50, "rainbow six": 50 },
          reuseOnlyGames: ["world of tanks", "ufl"],
          sizing: { coverageDays: 28, safetyStock: 6, maxAccounts: 250 },
          ...opts,
        }),
      ),
    getMarketReport: (opts = {}) => {
      const { buildMarketReport } = require("../utils/marketData/analyze");
      const { windowOf } = require("../utils/marketData/report");
      return Promise.resolve(buildMarketReport(previewMarketInput(), { windowDays: windowOf(opts.days) }));
    },
    marketStatus: () => ({ config: { enabled: false }, status: require("../utils/marketData").status() }),
  }),
);
app.use(express.static(path.join(__dirname, "..", "public")));
app.listen(port, "127.0.0.1", () => console.log("price tracker preview on http://localhost:" + port + "/price-tracker.html"));
