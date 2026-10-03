#!/usr/bin/env node
/**
 * The listing brain's score tables, offline (docs/LISTING-BRAIN-PLAN.md §5, §9):
 *
 *   node scripts/listing-brain-backtest.js <bundle.json> [--weeks N] [--json]
 *
 * Reads one bundle (scripts/listing-brain-export.js writes a real one; scripts/listing-brain-fixture.js a
 * synthetic one), runs the model as of the bundle's `now` (the run summary and the largest disagreements
 * between today's code and the brain), then replays the last N weeks (default 6) and prints every score
 * table: sell-through calibration with its reliability table, discrimination, placement per policy,
 * agreement, sold-or-expired. `--json` prints the same numbers as one JSON document.
 *
 * Read-only and offline: no database, no network, no settings — the bundle carries the owner's settings
 * (`af.listingBrain`). Nothing runs on require; `main` runs only under `require.main === module`, and every
 * formatter is exported (the tests call `main` with a captured writer).
 */
const model = require("../utils/listingBrain/model");
const inputs = require("../utils/listingBrain/inputs");

const DEFAULT_WEEKS = 6;
const TOP_DISAGREEMENTS = 15;
const FARMS = ["claim", "noclaim"];
const FARM_LABEL = { claim: "auto-farm (claim)", noclaim: "no-claim" };
// The section headers, in print order (the tests look for each one).
const HEADERS = {
  run: "RUN SUMMARY (the model as of the bundle's now)",
  disagreements: "TOP DISAGREEMENTS (today's code vs the brain, largest $ at stake first)",
  weeks: "BACKTEST WEEKS",
  calibration: "SELL-THROUGH CALIBRATION",
  reliability: "RELIABILITY",
  discrimination: "DISCRIMINATION",
  placement: "PLACEMENT FORECAST",
  agreement: "AGREEMENT ANALYSIS (correlation, not cause)",
  soldOrExpired: "SOLD OR EXPIRED (no-claim)",
  notes: "NOTES",
};

/* --------------------------------- small format ---------------------------------- */

const isNum = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
const dash = "—";
const fix = (v, d = 2) => (isNum(v) ? Number(v).toFixed(d) : dash);
const int = (v) => (isNum(v) ? String(Math.round(Number(v))) : dash);
const pct = (v, d = 0) => (isNum(v) ? (Number(v) * 100).toFixed(d) + "%" : dash);
const usd = (v) => (isNum(v) ? "$" + Number(v).toFixed(2) : dash);
const signed = (v, d = 2) => (isNum(v) ? (Number(v) > 0 ? "+" : "") + Number(v).toFixed(d) : dash);
const day = (t) => (isNum(t) ? new Date(Number(t)).toISOString().slice(0, 10) : "?");

/**
 * A plain-text table: a header row, a rule, the rows; columns padded to their widest cell. Columns
 * whose cells are all numbers (or "—") are right-aligned.
 */
function table(headers, rows) {
  const all = [headers].concat(rows).map((r) => r.map((c) => (c === null || c === undefined ? dash : String(c))));
  const w = headers.map((_, i) => Math.max(...all.map((r) => (r[i] || "").length)));
  const numeric = headers.map((_, i) => rows.length > 0 && rows.every((r) => /^[-+$]?[\d.,]+%?$|^—$/.test(String(r[i] === null || r[i] === undefined ? dash : r[i]))));
  const line = (r) =>
    r
      .map((c, i) => (numeric[i] ? (c || "").padStart(w[i]) : (c || "").padEnd(w[i])))
      .join("  ")
      .replace(/\s+$/, "");
  return [line(all[0]), w.map((n) => "-".repeat(n)).join("  "), ...all.slice(1).map(line)].join("\n");
}

const section = (title) => "\n== " + title + " ==\n";

/* ------------------------------------ the run ------------------------------------ */

/** Counts by price class, shelf class, live action and regime per farm; shelf and weekly value old vs brain. */
function formatRunSummary(run) {
  const s = (run && run.summary) || model.summarize([]);
  const out = [section(HEADERS.run)];
  out.push("cells " + int(s.cells) + ", game × farm groups " + int(s.games) + ", per-listing forecasts " + int(s.fc));
  const block = (title, key, names) => {
    const rows = names.map((c) => [c, int(s[key].claim[c]), int(s[key].noclaim[c])]);
    return "\n" + title + "\n" + table(["", FARM_LABEL.claim, FARM_LABEL.noclaim], rows);
  };
  out.push(block("Price class (cells)", "byPrice", model.PRICE_CLASSES));
  out.push(block("Shelf class (cells)", "byShelf", model.SHELF_CLASSES));
  out.push(block("Live system-made rows: the brain's action", "actions", model.LIVE_ACTIONS));
  out.push(block("Regime (game × farm)", "regimes", model.REGIMES));
  const sh = s.shelf;
  out.push(
    "\nShelf, today's code vs the brain (units, on cells both sides can judge)\n" +
      table(
        ["", FARM_LABEL.claim, FARM_LABEL.noclaim],
        [
          ["cells compared", int(sh.claim.compared), int(sh.noclaim.compared)],
          ["today's shelf", int(sh.claim.old), int(sh.noclaim.old)],
          ["brain's shelf", int(sh.claim.brain), int(sh.noclaim.brain)],
          ["brain's reserve / pool", int(sh.claim.reserve), int(sh.noclaim.reserve)],
          ["bulk set aside", int(sh.claim.bulkTake), int(sh.noclaim.bulkTake)],
          ["cells the brain cannot judge", int(sh.claim.unknownCells), int(sh.noclaim.unknownCells)],
          ["  today's shelf there", int(sh.claim.oldUnknown), int(sh.noclaim.oldUnknown)],
        ],
      ),
  );
  const v = s.value;
  out.push(
    "\nWeekly value of the live stock, at today's asks vs at the brain's prices (expected net, on cells valued both ways)\n" +
      table(
        ["", FARM_LABEL.claim, FARM_LABEL.noclaim],
        [
          ["cells compared", int(v.claim.compared), int(v.noclaim.compared)],
          ["today's asks", usd(v.claim.old), usd(v.noclaim.old)],
          ["brain's prices", usd(v.claim.brain), usd(v.noclaim.brain)],
        ],
      ),
  );
  return out.join("\n");
}

/** The run's largest disagreements: price class brain-lower / brain-higher, shelf class brain-more / fewer / add / drop. */
function formatDisagreements(rows, limit = TOP_DISAGREEMENTS) {
  const top = model.topDisagreements(rows, limit);
  const out = [section(HEADERS.disagreements)];
  if (!top.length) return out.concat(["None: today's code and the brain agree on every cell they can both judge."]).join("\n");
  out.push(
    table(
      ["game", "farm", "market", "price class", "today", "brain", "shelf class", "today", "brain", "$ at stake", "regime", "confidence"],
      top.map(({ r, gap }) => {
        const o = r.old || {};
        const b = r.br || {};
        return [r.g || r.k, r.f, r.m, r.pc, usd(isNum(o.a) ? o.a : o.np), usd(b.p), r.sc, int(o.sh), int(b.sh), usd(gap.usd), b.rg || dash, b.cf || dash];
      }),
    ),
  );
  out.push("($ at stake = price gap × units listed (a new listing counts one) + shelf gap × the unit price.)");
  return out.join("\n");
}

/* ---------------------------------- the scores ----------------------------------- */

function formatWeeks(bt) {
  const out = [section(HEADERS.weeks)];
  out.push(
    table(
      ["cut", "live listings forecast", "scored", "sold within horizon", "cell-weeks admitted", "units sold there", "no-claim units scored"],
      (bt.weeks || []).map((w) => [w.day || day(w.cut), int(w.listings), int(w.scored), int(w.sold), int(w.cells), int(w.units), int(w.noclaimUnits)]),
    ),
  );
  const c = bt.counts || {};
  out.push(
    "forecasts " + int(c.forecasts) + ": scored " + int(c.scored) + ", horizon not over " + int(c.waiting) + ", listing missing from the bundle " + int(c.missing) +
      ", on ZeusX (records no sale) " + int(c.unmeasured) + "; without a sell chance (market never fitted) " + int(c.noP),
  );
  return out.join("\n");
}

function formatCalibration(cal) {
  const out = [section(HEADERS.calibration)];
  out.push("Each live system-made listing's chance to sell within its horizon at its own ask, against the baseline: every listing on a market sells at that market's base rate. Brier = mean squared miss (lower is better); skill = 1 − Brier ÷ baseline Brier.");
  out.push(
    table(
      ["farm", "listings", "sold", "mean forecast", "Brier (brain)", "Brier (baseline)", "skill", "verdict"],
      FARMS.map((f) => {
        const x = (cal && cal[f]) || {};
        return [FARM_LABEL[f], int(x.n), int(x.sold), pct(x.meanP, 1), fix(x.brier, 4), fix(x.brierBase, 4), signed(x.skill, 3), x.verdict || "not enough history yet"];
      }),
    ),
  );
  const byM = [];
  for (const f of FARMS) for (const [m, x] of Object.entries((cal && cal[f] && cal[f].byMarket) || {})) byM.push([FARM_LABEL[f], m, int(x.n), fix(x.brier, 4), fix(x.brierBase, 4), signed(x.skill, 3)]);
  if (byM.length) out.push("\nBy market\n" + table(["farm", "market", "listings", "Brier (brain)", "Brier (baseline)", "skill"], byM));
  for (const f of FARMS) {
    const bins = ((cal && cal[f] && cal[f].reliability) || []).filter((b) => b.n > 0);
    out.push("\n" + HEADERS.reliability + " — " + FARM_LABEL[f]);
    out.push(bins.length ? table(["forecast chance", "listings", "mean forecast", "really sold"], bins.map((b) => [pct(b.lo) + "–" + pct(b.hi), int(b.n), pct(b.meanP, 1), pct(b.rate, 1)])) : "not enough history yet");
  }
  return out.join("\n");
}

function formatDiscrimination(dis) {
  const out = [section(HEADERS.discrimination)];
  out.push("How often live listings sold within the horizon, grouped by what the brain told them. If it is informative, rows it would lower sell less often at today's price than rows it would hold.");
  const rows = [];
  for (const f of FARMS) {
    const d = (dis && dis[f]) || {};
    for (const a of model.SCORED_ACTIONS.concat(["ladder", "abstained"])) {
      const x = d[a];
      if (!x || (!x.n && !model.SCORED_ACTIONS.includes(a))) continue;
      rows.push([FARM_LABEL[f], a === "abstained" ? "(no advice: game unknown)" : a, int(x.n), int(x.sold), x.n ? pct(x.rate, 1) : "not enough history yet"]);
    }
  }
  out.push(table(["farm", "the brain said", "listings", "sold", "sell rate"], rows));
  return out.join("\n");
}

function formatPlacement(pl) {
  const out = [section(HEADERS.placement)];
  out.push("Units sold per game × market in the next 7 days by system-made rows, against each placement policy's forecast. A cell-week is scored when it sold or any policy forecast a sale; a policy with no number on a scored cell-week is missing there (never 0) and is not ranked; the best is picked by RMSE among policies scored on the very same cell-weeks.");
  for (const f of FARMS) {
    const x = (pl && pl[f]) || {};
    out.push("\n" + FARM_LABEL[f] + ": " + int(x.rows) + " cell-weeks scored, " + int(x.units) + " units sold there");
    const partial = new Set(x.partial || []);
    out.push(
      table(
        ["policy", "RMSE", "MAE", "bias", "cell-weeks", "forecast", "sold", ""],
        model.PLACE_POLICIES.map((p) => {
          const s = x[p] || {};
          const tag = !s.n ? "not enough history yet" : partial.has(p) || s.partial ? "not enough history yet (missing on some cell-weeks)" : x.best === p ? "✓ best" : "";
          return [p, fix(s.rmse, 3), fix(s.mae, 3), signed(s.bias, 3), int(s.n), fix(s.forecast, 1), int(s.actual), tag];
        }),
      ),
    );
    const notes = [];
    if (x.unforecast && x.unforecast.units) notes.push(int(x.unforecast.units) + " units on " + int(x.unforecast.cells) + " cells no policy forecast (an abstention or a managed cell)");
    if (x.unmeasured && x.unmeasured.cells) notes.push(int(x.unmeasured.cells) + " ZeusX cell-weeks not scored (ZeusX records no sale for an auto row)");
    if (x.outside) notes.push(int(x.outside) + " units on cells first listed after the forecast");
    if (notes.length) out.push("not scored: " + notes.join("; ") + ".");
  }
  return out.join("\n");
}

function formatAgreement(ag, note) {
  const out = [section(HEADERS.agreement)];
  out.push(note || model.AGREEMENT_NOTE);
  out.push("Realised net per listing-day (after the market's fee) of live listings whose ask was within 10 % of each policy's price, against listings further away, by market.");
  const rows = [];
  for (const m of model.MARKETS) {
    if (!ag || !ag[m]) continue;
    for (const p of model.PRICE_POLICIES) {
      const x = ag[m][p];
      if (!x) continue;
      rows.push([m, p, int(x.near.n), fix(x.near.days, 1), usd(x.near.netPerDay), int(x.far.n), fix(x.far.days, 1), usd(x.far.netPerDay)]);
    }
  }
  out.push(rows.length ? table(["market", "policy", "near: listings", "listing-days", "net/day", "far: listings", "listing-days", "net/day"], rows) : "not enough history yet");
  return out.join("\n");
}

function formatSoldOrExpired(se) {
  const out = [section(HEADERS.soldOrExpired)];
  if (!se) return out.concat(["No no-claim unit ledger in this bundle."]).join("\n");
  out.push("No-claim units live at a forecast whose stock expiry (wave end + the learned claim window) has passed: the share the brain expected to sell before expiry against the share that did.");
  out.push(
    table(
      ["units", "expected to sell", "really sold", "sold", "expired", "Brier per unit"],
      [[int(se.n), pct(se.expected, 1), pct(se.actual, 1), int(se.sold), int(se.expired), fix(se.brier, 4)]],
    ),
  );
  const games = Object.entries(se.byGame || {});
  if (games.length) out.push("\nBy game\n" + table(["game", "units", "expected", "really sold", "Brier"], games.map(([g, x]) => [g, int(x.n), pct(x.expected, 1), pct(x.actual, 1), fix(x.brier, 4)])));
  const k = se.skipped || {};
  out.push(
    "not scored: " + int(k.past) + " units past their estimated expiry at the forecast (the model ignores that estimate), " + int(k.open) + " whose expiry is still ahead, " +
      int(k.unresolved) + " the ledger has not closed, " + int(k.undated) + " with no dated wave, " + int(k.noEstimate) + " on a market without a no-claim estimate.",
  );
  return out.join("\n");
}

function formatNotes(bt) {
  const out = [section(HEADERS.notes)];
  out.push("- " + (bt.note || model.SCORE_NOTE));
  out.push("- " + (bt.cannotShow || model.CANNOT_SHOW));
  for (const l of bt.limits || []) out.push("- " + l);
  return out.join("\n");
}

/** Every score table of one backtest (or forward) result. */
function formatBacktest(bt) {
  return [formatWeeks(bt), formatCalibration(bt.calibration), formatDiscrimination(bt.discrimination), formatPlacement(bt.placement), formatAgreement(bt.agreement, bt.agreementNote), formatSoldOrExpired(bt.soldOrExpired), formatNotes(bt)].join("\n");
}

/** The whole report. */
function formatReport({ file, bundle, run, bt, ms = {} }) {
  const c = bundle.counts || {};
  const head =
    "Listing brain — offline score (test mode: nothing is changed)\n" +
    "bundle " + file + " | now " + day(bundle.now) + " | " + int(c.games) + " games, " + int((bundle.listings || []).length) + " listings, " + int((bundle.sales || []).length) + " unit sales" +
    (isNum(ms.run) ? "\nmodel run " + Math.round(ms.run) + " ms, backtest of " + (bt.weeks || []).length + " weeks " + Math.round(ms.backtest) + " ms" : "");
  return [head, formatRunSummary(run), formatDisagreements(run.rows), formatBacktest(bt)].join("\n") + "\n";
}

/* ------------------------------------- main -------------------------------------- */

const USAGE = "usage: node scripts/listing-brain-backtest.js <bundle.json> [--weeks N] [--json]\n";

function parseArgs(argv) {
  const out = { file: null, weeks: DEFAULT_WEEKS, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--weeks" || a.startsWith("--weeks=")) {
      const v = a === "--weeks" ? argv[++i] : a.slice(8);
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 52) throw new Error("--weeks takes a whole number from 1 to 52, not " + JSON.stringify(v));
      out.weeks = n;
    } else if (a.startsWith("-")) throw new Error("unknown option " + a);
    else if (!out.file) out.file = a;
    else throw new Error("one bundle file at a time (got " + a + ")");
  }
  return out;
}

/**
 * Run the script. Returns the exit code (0 ok, 1 failed, 2 usage); writes through `io` so a test can
 * capture it.
 * @param {string[]} argv
 * @param {object} [io] { write(text), error(text), clock() → ms }
 */
function main(argv, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const error = io.error || ((s) => process.stderr.write(s));
  const clock = io.clock || (() => Number(process.hrtime.bigint()) / 1e6);
  let args;
  try {
    args = parseArgs(argv || []);
  } catch (e) {
    error(e.message + "\n" + USAGE);
    return 2;
  }
  if (args.help) {
    write(USAGE);
    return 0;
  }
  if (!args.file) {
    error(USAGE);
    return 2;
  }
  try {
    const bundle = inputs.loadFromBundle(args.file);
    const cfg = model.readConfig({ listingBrain: (bundle.af && bundle.af.listingBrain) || {} });
    let t = clock();
    const run = model.buildRun(bundle, { cfg });
    const msRun = clock() - t;
    t = clock();
    const bt = model.backtest(bundle, { cfg, weeks: args.weeks });
    const msBt = clock() - t;
    if (args.json) {
      const top = model.topDisagreements(run.rows, TOP_DISAGREEMENTS).map(({ r, gap }) => ({ k: r.k, g: r.g, f: r.f, m: r.m, pc: r.pc, sc: r.sc, old: r.old, br: { p: r.br.p, sh: r.br.sh, cf: r.br.cf, rg: r.br.rg }, gap }));
      write(JSON.stringify({ file: args.file, now: bundle.now, ms: { run: Math.round(msRun), backtest: Math.round(msBt) }, summary: run.summary, disagreements: top, backtest: bt }, null, 2) + "\n");
    } else {
      write(formatReport({ file: args.file, bundle, run, bt, ms: { run: msRun, backtest: msBt } }));
    }
    return 0;
  } catch (e) {
    error("listing-brain-backtest: " + ((e && e.message) || e) + "\n");
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  HEADERS,
  DEFAULT_WEEKS,
  TOP_DISAGREEMENTS,
  table,
  parseArgs,
  formatRunSummary,
  formatDisagreements,
  formatWeeks,
  formatCalibration,
  formatDiscrimination,
  formatPlacement,
  formatAgreement,
  formatSoldOrExpired,
  formatNotes,
  formatBacktest,
  formatReport,
  main,
};
