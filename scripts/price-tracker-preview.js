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

const app = express();
app.get("/whoami", (_req, res) => res.json({ username: "preview", role: "superadmin", name: "Preview" }));
app.use(
  createRouter({
    // The preview is read-only too: the loader returns the same snapshot every time.
    getReport: ({ fees } = {}) => Promise.resolve(T.buildReport(snapshot, { fees })),
  }),
);
app.use(express.static(path.join(__dirname, "..", "public")));
app.listen(port, "127.0.0.1", () => console.log("price tracker preview on http://localhost:" + port + "/price-tracker.html"));
