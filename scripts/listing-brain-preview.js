/**
 * Listing brain preview — serves the price tracker page's "Listing brain (test)" tab from a saved
 * bundle, with NO database, NO auth and NO marketplace calls.
 *
 * The bundle is what utils/listingBrain/inputs.load() hands the model (docs/LISTING-BRAIN-PLAN.md
 * §2.1): plain JSON, already stripped of anything identifying. Make a synthetic one with
 * scripts/listing-brain-fixture.js, or export a real one with scripts/listing-brain-export.js.
 *
 *   node scripts/listing-brain-preview.js <bundle.json> [--port N]
 *   open http://localhost:4131/price-tracker.html#listing
 *
 * One run of the brain's REAL model over the bundle, held in memory; the tab's routes are the real
 * routes/listingBrainRoutes.js fed a brain-like object instead of the runner. That router is mounted
 * AHEAD of createRouter (Express answers the first match), so createRouter's own listing-brain routes
 * — which would load the live runner — are never reached. The other tabs are not fed here (use
 * scripts/price-tracker-preview.js for them): they answer with a plain message. Listens on 127.0.0.1
 * only. Nothing is written anywhere.
 */
const path = require("path");
const express = require("express");
const createRouter = require("../routes/priceTrackerRoutes");
const listingBrainRoutes = require("../routes/listingBrainRoutes");

function args(argv) {
  let file = "";
  let port = 4131;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") port = Number(argv[++i]) || port;
    else if (a.startsWith("--port=")) port = Number(a.slice(7)) || port;
    else if (!file) file = a;
  }
  return { file, port };
}

// The model and the loader are separate files built in their own milestone; say plainly which one is
// missing instead of a bare stack trace.
function need(mod, what) {
  try {
    return require(mod);
  } catch (e) {
    console.error("listing-brain-preview: cannot load " + what + " (" + mod + "): " + (e && e.message ? e.message.split("\n")[0] : e));
    console.error("The preview runs the listing brain's own model; it needs utils/listingBrain/model.js and utils/listingBrain/inputs.js.");
    process.exit(1);
  }
  return null;
}

const NOT_HERE = "This preview serves the Listing brain (test) tab only — run scripts/price-tracker-preview.js for the other tabs.";

// A brain-like object with the runner's read API (status, latest, cellHistory, accuracy), built from
// one in-memory run of the real model over the bundle. The clock is the bundle's own `now`.
function previewBrain(bundle, model) {
  const cfg = { ...model.readConfig(bundle.af || {}), enabled: true };
  const t0 = Date.now();
  const run = model.buildRun(bundle, { cfg, prior: new Map() });
  const ms = Date.now() - t0;
  const at = new Date(bundle.now);
  const doc = {
    at,
    v: model.MODEL_VERSION,
    ms,
    cfg,
    summary: run.summary,
    counts: bundle.counts || {},
    notes: ["Preview: one run over a saved bundle (" + ms + " ms). Nothing is read live or written."].concat(run.notes || []),
    // computed in memory with the log switched off, like runOnce({ persist: false })
    persisted: false,
    logged: false,
    rows: run.rows || [],
    offers: run.offers || [],
    fcN: (run.fc || []).length,
  };
  let acc = null;
  return {
    status: () => ({ config: cfg, model: model.MODEL_VERSION, started: false, running: false, runs: 1, lastRunAt: at, lastMs: ms, lastError: "", lastPersisted: null, nextRunAt: null, summary: run.summary }),
    latest: async () => doc,
    // One run is all the preview has: a cell's history is its row in it.
    cellHistory: async (key) => {
      const parts = String(key || "").split("|");
      if (parts.length < 3) return [];
      const m = parts.pop();
      const f = parts.pop();
      const k = parts.join("|");
      return doc.rows.filter((r) => r.k === k && r.f === f && r.m === m).map((r) => ({ at, v: doc.v, ...r, why: undefined }));
    },
    accuracy: async ({ force = false } = {}) => {
      if (acc && !force) return acc;
      const backtest = model.backtestAsync ? await model.backtestAsync(bundle, { cfg, weeks: 6 }) : model.backtest(bundle, { cfg, weeks: 6 });
      // No logged forecasts in a preview: the live test has nothing to score yet.
      let forward = { runsScored: 0, runsWaiting: 0 };
      try {
        if (model.forwardScores) forward = { runsScored: 0, runsWaiting: 0, ...model.forwardScores({ samples: [], bundle, cfg, now: bundle.now }) };
      } catch {
        // the empty answer above
      }
      acc = { at, evidenceAt: at, model: model.MODEL_VERSION, samples: 0, backtest, forward, review: [] };
      return acc;
    },
  };
}

function main() {
  const { file, port } = args(process.argv.slice(2));
  if (!file) {
    console.error("usage: node scripts/listing-brain-preview.js <bundle.json> [--port N]");
    process.exit(1);
  }
  const inputs = need("../utils/listingBrain/inputs", "the listing brain's loader");
  const model = need("../utils/listingBrain/model", "the listing brain's model");
  let bundle;
  try {
    bundle = inputs.loadFromBundle(path.resolve(file));
  } catch (e) {
    console.error("listing-brain-preview: " + (e && e.message ? e.message : e));
    process.exit(1);
  }
  const brain = previewBrain(bundle, model);

  const app = express();
  app.get("/whoami", (_req, res) => res.json({ username: "preview", role: "superadmin", name: "Preview" }));
  // First: the listing-brain routes fed from the bundle (no guards — localhost only, demo data).
  const lb = express.Router();
  listingBrainRoutes.mount(lb, { brain });
  app.use(lb);
  // Then the rest of the tracker's API, with every data source answering "not in this preview" so
  // nothing reaches for a database.
  const refuse = () => Promise.reject(new Error(NOT_HERE));
  const notHere = () => {
    throw new Error(NOT_HERE);
  };
  app.use(
    createRouter({
      getReport: refuse,
      getMarketReport: refuse,
      marketStatus: notHere,
      brain: { status: notHere, latest: refuse, gameHistory: refuse, accuracy: refuse },
    }),
  );
  app.use(express.static(path.join(__dirname, "..", "public")));
  app.listen(port, "127.0.0.1", () => console.log("listing brain preview on http://localhost:" + port + "/price-tracker.html#listing"));
}

if (require.main === module) main();

module.exports = { previewBrain, args };
