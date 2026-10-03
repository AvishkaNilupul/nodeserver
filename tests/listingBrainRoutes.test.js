/* global fetch */
// The listing brain's API (routes/listingBrainRoutes.js) and its page tab (public/listing-brain.js):
// guarded, read-only, whitelisted (no identifying field in any response), filters / sort / paging,
// the cell sheet and the accuracy cooldown — against a FAKE brain, no database. Plus the three small
// edits to shared files (the mount and start lines, the page's script tag / tab / dispatch) and the
// page script's escaping, both by source scan and by running it over hostile data.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const express = require("express");
const LBR = require("../routes/listingBrainRoutes");

const ROOT = path.join(__dirname, "..");
const BASE = "/api/price-tracker/listing-brain";
const PATHS = [BASE + "/status", BASE + "/latest", BASE + "/cell/" + encodeURIComponent("alpha|claim|gameflip"), BASE + "/accuracy"];
const XSS = "<img src=x onerror=alert(1)>";

// Keys that must never leave the API, at any depth.
const FORBIDDEN = ["id", "_id", "run", "l", "lid", "lids", "listingId", "listingIds", "externalId", "orderId", "dedupeKey", "grp", "login", "logins", "account", "accountId", "seller", "sellerName", "fc", "ctx", "bundle", "ck", "bk"];
function forbiddenPaths(v, at = "$", out = []) {
  if (Array.isArray(v)) v.forEach((x, i) => forbiddenPaths(x, at + "[" + i + "]", out));
  else if (v && typeof v === "object") {
    for (const k of Object.keys(v)) {
      if (FORBIDDEN.includes(k)) out.push(at + "." + k);
      forbiddenPaths(v[k], at + "." + k, out);
    }
  }
  return out;
}

// Every identifying field the model or the log might carry is planted here, at every level.
function row(k, f, m, o = {}) {
  return {
    _id: "ROWOBJECTID",
    run: "RUNOBJECTID",
    k,
    g: k.toUpperCase(),
    f,
    m,
    live: false,
    hl: null,
    pc: "agree",
    sc: "agree",
    old: { a: 2, n: 3, np: 2, sh: 3, cur: 3, listingId: "LEAK-L1" },
    br: { p: 2, ref: 2, cf: "high", b: "exact-here", rg: "balanced", p7: 0.5, p7a: 0.5, wv: 1, wva: 1, sh: 3, a: { hold: 1 }, login: "LEAK-LOGIN" },
    pol: { old: 2, tracker: 2, curve: 2, clear: 2 },
    pf: { flat: 1, share30: 1, instock: 1, newsvendor: 1 },
    ev: { o: 5, s: 3, d: 40, thin: false, el: "open", fee: 0.1, blind: false, lids: ["LEAK-LIDS"] },
    fl: [],
    why: ["because"],
    // never whitelisted
    id: "LEAK-ID",
    fc: [{ l: "LEAK-FC" }],
    ctx: { secret: 1 },
    seller: "LEAK-SELLER",
    ...o,
  };
}

function offer(k, f, m, o = {}) {
  return {
    k,
    f,
    m,
    ck: "LEAK-CK",
    bk: "LEAK-BK",
    n: 3,
    ref: 2,
    conf: "high",
    basis: "exact-here",
    regime: "balanced",
    p: 1.8,
    raw: 1.7,
    pH: 0.6,
    pHask: 0.5,
    value: 0.9,
    valueAsk: 0.8,
    tier: 1,
    action: "lower",
    gates: ["step"],
    thin: false,
    stale: true,
    packs: [{ minQty: 5, discountPct: 10, unitPrice: 1.35, packPrice: 6.75 }],
    why: ["offer reason"],
    live: [{ id: "LEAK-LIVE-ID", ask: 2, ageDays: 12.5, a: "lower", p7a: 0.4, account: "LEAK-ACC" }],
    ...o,
  };
}

const SUMMARY = {
  cells: 6,
  games: 4,
  byPrice: { claim: { agree: 2, "brain-lower": 1, "brain-higher": 1 }, noclaim: { agree: 1 } },
  byShelf: { claim: { agree: 2, "brain-more": 1, "brain-add": 1 }, noclaim: { managed: 1 } },
  actions: { claim: { hold: 3, lower: 1 }, noclaim: { hold: 1 } },
  regimes: { claim: { balanced: 3, scarce: 1 }, noclaim: { overstock: 1 } },
  shelf: { claim: { old: 9, brain: 11, reserve: 2, bulkTake: 1, compared: 4, unknownCells: 1, oldUnknown: 2 }, noclaim: { old: 5, brain: 5, reserve: 0, bulkTake: 0, compared: 1, unknownCells: 0, oldUnknown: 0 } },
  value: { claim: { old: 10.5, brain: 12.25, compared: 4 }, noclaim: { old: 3, brain: 3, compared: 1 } },
  flags: { "fee-assumed": 3, "<i>bad</i>": 1 },
  fc: 12,
};

function makeRun(o = {}) {
  return {
    _id: "RUNOBJECTID",
    at: new Date("2026-10-03T12:00:00Z"),
    v: 1,
    ms: 420,
    cfg: { enabled: true, intervalMin: 180, horizonDaysClaim: 7, horizonDaysNoclaim: 2, policyPrice: "curve", policyPlace: "newsvendor" },
    summary: SUMMARY,
    counts: { listings: 30, sellerName: "LEAK-COUNTS" },
    notes: ["a note"],
    persisted: true,
    logged: true,
    fcN: 12,
    fc: [{ l: "LEAK-RUN-FC" }],
    bundle: { listings: [{ id: "LEAK-BUNDLE" }] },
    ctx: { ev: {} },
    rows: [
      // a: live, price disagreement with a $0.50 gap; b: not live, shelf disagreement of 2 units
      row("alpha", "claim", "gameflip", { live: true, hl: 30, pc: "brain-lower", old: { a: 2, n: 3, np: 2, sh: 3, cur: 3 }, br: { p: 1.5, sh: 3, wv: 4, p7: 0.7, p7a: 0.5 } }),
      row("alpha", "claim", "ggsel", { live: true, hl: 30, pc: "agree", sc: "agree", br: { p: 2, sh: 3, wv: 9 } }),
      row("bravo", "claim", "eldorado", { sc: "brain-more", old: { a: 3, sh: 1 }, br: { p: 3, sh: 3, wv: 2 } }),
      row("charlie", "claim", "g2g", { pc: "no-evidence", sc: "unknown", br: { p: null, sh: 0, wv: 0 } }),
      row("delta", "noclaim", "gameflip", { pc: "agree", sc: "managed", br: { p: 1, sh: 5, wv: 1 } }),
      row("alpha", "claim", "all", { live: true, hl: 30, pc: "", sc: "", old: { sh: 6, cur: 6 }, br: { sh: 6, rsv: 1, bt: 0, ex: null, rg: "balanced", w: 4, on: 7, cov: 1.5 } }),
    ],
    offers: [offer("alpha", "claim", "gameflip"), offer("alpha", "claim", "ggsel", { action: "hold" }), offer("bravo", "claim", "eldorado")],
    ...o,
  };
}

const ACCURACY = {
  at: new Date("2026-10-03T12:00:00Z"),
  evidenceAt: new Date("2026-10-03T11:00:00Z"),
  model: 1,
  samples: 0,
  backtest: {
    weeks: 6,
    calibration: {
      claim: { n: 40, brier: 0.18, brierBase: 0.22, skill: 0.18, reliability: [{ lo: 0, hi: 0.1, n: 5, meanP: 0.05, rate: 0 }, { lo: 0.5, hi: 0.6, n: 7, meanP: 0.55, rate: 0.57 }] },
      noclaim: { n: 0, brier: null, brierBase: null, skill: null, reliability: [] },
    },
    discrimination: { claim: { hold: { n: 10, sold: 4, rate: 0.4 }, lower: { n: 5, sold: 1, rate: 0.2 } } },
    placement: {
      claim: { flat: { n: 12, rmse: 1.2, bias: 0.3, mae: 0.9 }, newsvendor: { n: 12, rmse: 0.8, bias: -0.1, mae: 0.6 }, instock: { n: 3, rmse: 0.2, bias: 0, mae: 0.2 }, best: { id: "newsvendor", rmse: 0.8 }, partial: ["instock"] },
    },
    agreement: { gameflip: { curve: { near: { n: 5, netPerDay: 0.12 }, far: { n: 9, netPerDay: 0.05 } } } },
    soldOrExpired: { n: 20, expected: 0.6, actual: 0.55, brier: 0.2 },
    note: "synthetic",
  },
  forward: { runsScored: 0, runsWaiting: 2 },
  review: [{ at: new Date("2026-09-25T12:00:00Z"), k: "alpha", g: "Alpha", f: "claim", m: "gameflip", pc: "brain-lower", sc: "agree", old: { a: 2, sh: 3 }, br: { p: 1.5, sh: 3 }, next: { units: 2, net: 2.6 }, l: "LEAK-REVIEW" }],
};

function fakeBrain(run, o = {}) {
  const calls = { accuracy: [], history: [] };
  return {
    calls,
    status: () => ({ config: { enabled: true, intervalMin: 180 }, runs: 3, lastPersisted: true, summary: { fc: 4 }, lastError: "" }),
    latest: async () => run,
    cellHistory: async (key, limit) => {
      calls.history.push({ key, limit });
      if (key === "alpha|claim|gameflip" || key === "echo|claim|gameflip") return [{ _id: "H1", run: "RUNOBJECTID", at: new Date("2026-10-03T09:00:00Z"), ...row(key.split("|")[0], "claim", "gameflip"), why: undefined }];
      return [];
    },
    accuracy: async (a) => {
      calls.accuracy.push(a);
      return ACCURACY;
    },
    ...o,
  };
}

async function listen(app) {
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  return { base: "http://127.0.0.1:" + server.address().port, close: () => server.close() };
}

async function serve(brain, guards) {
  const app = express();
  const r = express.Router();
  if (guards === undefined) LBR.mount(r, { brain });
  else LBR.mount(r, { brain, guards });
  app.use(r);
  return listen(app);
}

const getJson = async (base, p) => {
  const r = await fetch(base + p);
  return { status: r.status, body: await r.json() };
};

/* ---------------------------------- routes ---------------------------------- */

test("every listing-brain route refuses an anonymous caller when the guard says so", async () => {
  const deny = (req, res, next) => (req.query.deny === "1" ? res.status(401).json({ success: false, message: "Unauthorized" }) : next());
  const b = fakeBrain(makeRun());
  let touched = 0;
  for (const k of ["status", "latest", "cellHistory", "accuracy"]) {
    const f = b[k];
    b[k] = (...a) => {
      touched++;
      return f(...a);
    };
  }
  const s = await serve(b, [deny]);
  try {
    for (const p of PATHS) {
      const r = await fetch(s.base + p + "?deny=1");
      assert.equal(r.status, 401, p);
      assert.equal((await r.json()).success, false);
    }
    assert.equal(touched, 0, "a refused caller never reaches the brain");
    for (const p of PATHS) assert.equal((await fetch(s.base + p)).status, 200, p);
    assert.ok(touched > 0);
  } finally {
    s.close();
  }
});

test("mount works with no guards at all (the tests' and the preview's default)", async () => {
  const s = await serve(fakeBrain(makeRun()));
  try {
    for (const p of PATHS) assert.equal((await fetch(s.base + p)).status, 200, p);
  } finally {
    s.close();
  }
  const s2 = await serve(fakeBrain(makeRun()), []);
  try {
    assert.equal((await fetch(s2.base + PATHS[0])).status, 200);
  } finally {
    s2.close();
  }
});

test("no identifying field leaves the API, at any depth, on any route", async () => {
  const run = makeRun();
  run.rows[0].why = ["reason"];
  const s = await serve(fakeBrain(run));
  try {
    const bodies = [];
    for (const p of [
      BASE + "/status",
      BASE + "/latest?limit=200",
      BASE + "/latest?farm=noclaim",
      BASE + "/cell/" + encodeURIComponent("alpha|claim|gameflip"),
      BASE + "/cell/" + encodeURIComponent("alpha|claim|all"),
      BASE + "/cell/" + encodeURIComponent("echo|claim|gameflip"),
      BASE + "/accuracy",
    ]) {
      const { status, body } = await getJson(s.base, p);
      assert.equal(status, 200, p);
      assert.deepEqual(forbiddenPaths(body), [], p);
      bodies.push(JSON.stringify(body));
    }
    const all = bodies.join("\n");
    assert.ok(!/LEAK|OBJECTID/.test(all), "a planted identifier leaked: " + (all.match(/.{40}(LEAK|OBJECTID)[^"]*/) || [""])[0]);
  } finally {
    s.close();
  }
});

test("rows and offers carry exactly the whitelisted fields", async () => {
  const s = await serve(fakeBrain(makeRun()));
  try {
    const { body } = await getJson(s.base, BASE + "/latest?limit=200");
    for (const r of body.rows) for (const k of Object.keys(r)) assert.ok(LBR.ROW_FIELDS.includes(k), "row field " + k);
    assert.deepEqual(Object.keys(body.rows.find((r) => r.k === "alpha" && r.m === "gameflip")).sort(), [...LBR.ROW_FIELDS].sort());
    const cell = (await getJson(s.base, BASE + "/cell/" + encodeURIComponent("alpha|claim|gameflip"))).body;
    assert.equal(cell.offers.length, 1, "only this cell's offers");
    const o = cell.offers[0];
    assert.deepEqual(Object.keys(o).sort(), [...LBR.OFFER_FIELDS].sort());
    assert.deepEqual(o.live, [{ ask: 2, ageDays: 12.5, a: "lower", p7a: 0.4 }]);
    assert.equal(o.valueAsk, undefined, "not whitelisted");
    // the exported helpers are the same whitelist
    assert.deepEqual(Object.keys(LBR.publicOffer(offer("x", "claim", "gameflip"))).sort(), [...LBR.OFFER_FIELDS].sort());
    assert.deepEqual(LBR.publicRow({ k: "x", secret: 1, id: 2 }), { k: "x" });
    assert.deepEqual(LBR.publicOffer({ k: "x" }).live, []);
  } finally {
    s.close();
  }
});

test("latest: live campaigns first, disagreements first, filters, search and paging", async () => {
  const s = await serve(fakeBrain(makeRun()));
  try {
    const key = (r) => r.k + "|" + r.m;
    const all = (await getJson(s.base, BASE + "/latest")).body;
    assert.equal(all.total, 6);
    assert.equal(all.offset, 0);
    assert.equal(all.limit, 50);
    // live first (alpha ×3); within them the price disagreement leads; then bravo's shelf disagreement
    assert.deepEqual(all.rows.map(key), ["alpha|gameflip", "alpha|all", "alpha|ggsel", "bravo|eldorado", "charlie|g2g", "delta|gameflip"]);
    assert.deepEqual(all.rows[0].why, ["because"], "reasons of the newest run");
    assert.equal(all.persisted, true);
    assert.equal(all.logged, true);
    assert.equal(all.fcN, 12, "a count of forecasts, never the list");
    assert.equal(all.summary.byPrice.claim["brain-lower"], 1);
    assert.equal(all.summary.fc, undefined);
    assert.equal(all.counts.listings, 30);
    assert.equal(all.status.runs, 3);

    const f = async (qs) => (await getJson(s.base, BASE + "/latest?" + qs)).body.rows.map(key);
    assert.deepEqual(await f("farm=noclaim"), ["delta|gameflip"]);
    assert.deepEqual(await f("m=gameflip"), ["alpha|gameflip", "delta|gameflip"]);
    assert.deepEqual(await f("m=all"), ["alpha|all"]);
    assert.deepEqual(await f("pc=brain-lower"), ["alpha|gameflip"]);
    assert.deepEqual(await f("sc=brain-more"), ["bravo|eldorado"]);
    assert.deepEqual((await f("live=1")).sort(), ["alpha|all", "alpha|gameflip", "alpha|ggsel"]);
    assert.deepEqual(await f("q=CHAR"), ["charlie|g2g"]);
    assert.deepEqual(await f("q=bravo&farm=claim&m=eldorado"), ["bravo|eldorado"]);
    // sorts: still live first, then the key
    assert.deepEqual(await f("sort=value"), ["alpha|ggsel", "alpha|gameflip", "alpha|all", "bravo|eldorado", "delta|gameflip", "charlie|g2g"]);
    // price gap: delta $1 > bravo, charlie $0 (charlie has no brain price: no gap, not a $2 gap)
    assert.deepEqual(await f("sort=price"), ["alpha|gameflip", "alpha|all", "alpha|ggsel", "delta|gameflip", "bravo|eldorado", "charlie|g2g"]);
    // shelf gap: charlie 3 > bravo 2 = delta 2 (ties by name)
    assert.deepEqual(await f("sort=shelf"), ["alpha|all", "alpha|gameflip", "alpha|ggsel", "charlie|g2g", "bravo|eldorado", "delta|gameflip"]);
    assert.deepEqual(await f("sort=market"), ["alpha|all", "alpha|gameflip", "alpha|ggsel", "bravo|eldorado", "charlie|g2g", "delta|gameflip"]);
    const weird = (await getJson(s.base, BASE + "/latest?sort=__proto__")).body;
    assert.equal(weird.success, true, "an unknown sort falls back to the gap");
    assert.deepEqual(weird.rows.map(key), all.rows.map(key));

    const pg = (await getJson(s.base, BASE + "/latest?limit=2&offset=2")).body;
    assert.deepEqual(pg.rows.map(key), ["alpha|ggsel", "bravo|eldorado"]);
    assert.equal(pg.total, 6);
    assert.equal(pg.offset, 2);
    assert.equal(pg.limit, 2);
    const big = (await getJson(s.base, BASE + "/latest?limit=5000&offset=-4")).body;
    assert.equal(big.limit, 200, "limit clamped to 200");
    assert.equal(big.offset, 0);
    assert.equal((await getJson(s.base, BASE + "/latest?limit=0")).body.limit, 1);
  } finally {
    s.close();
  }
});

test("latest before any run: an empty answer with the status, not an error", async () => {
  const s = await serve(fakeBrain(null));
  try {
    const { status, body } = await getJson(s.base, BASE + "/latest");
    assert.equal(status, 200);
    assert.equal(body.empty, true);
    assert.equal(body.status.runs, 3);
    assert.equal(body.status.summary.fc, undefined, "the status is scrubbed too");
  } finally {
    s.close();
  }
});

test("cell: the newest row with reasons, its offers and its history; 404 when never logged", async () => {
  const b = fakeBrain(makeRun());
  const s = await serve(b);
  try {
    const j = (await getJson(s.base, BASE + "/cell/" + encodeURIComponent("alpha|claim|gameflip") + "?limit=9999")).body;
    assert.equal(j.key, "alpha|claim|gameflip");
    assert.deepEqual([j.g, j.f, j.m], ["alpha", "claim", "gameflip"]);
    assert.equal(j.row.k, "alpha");
    assert.deepEqual(j.row.why, ["because"]);
    assert.equal(j.offers.length, 1);
    assert.equal(j.offers[0].action, "lower");
    assert.equal(j.history.length, 1);
    assert.equal(j.history[0].at, "2026-10-03T09:00:00.000Z");
    assert.deepEqual(b.calls.history[0], { key: "alpha|claim|gameflip", limit: 288 }, "limit clamped");
    await fetch(s.base + BASE + "/cell/" + encodeURIComponent("alpha|claim|ggsel"));
    assert.deepEqual(b.calls.history[1], { key: "alpha|claim|ggsel", limit: 72 }, "default limit");
    // the placement row has no offers
    const all = (await getJson(s.base, BASE + "/cell/" + encodeURIComponent("alpha|claim|all"))).body;
    assert.equal(all.row.m, "all");
    assert.deepEqual(all.offers, []);
    // logged before, not in the newest run: history only
    const echo = await getJson(s.base, BASE + "/cell/" + encodeURIComponent("echo|claim|gameflip"));
    assert.equal(echo.status, 200);
    assert.equal(echo.body.row, null);
    assert.equal(echo.body.history.length, 1);
    // a game key holding the separator is read from the right
    assert.equal((await fetch(s.base + BASE + "/cell/" + encodeURIComponent("a|b|claim|gameflip"))).status, 404);
    assert.equal((await fetch(s.base + BASE + "/cell/" + encodeURIComponent("zulu|claim|gameflip"))).status, 404);
    const nf = (await getJson(s.base, BASE + "/cell/" + encodeURIComponent("zulu|noclaim|gameflip"))).body;
    assert.match(nf.message, /has not logged this cell/);
    assert.equal((await fetch(s.base + BASE + "/cell/" + encodeURIComponent("alpha|gameflip"))).status, 400);
    assert.equal((await fetch(s.base + BASE + "/cell/" + encodeURIComponent("alpha|other|gameflip"))).status, 400);
  } finally {
    s.close();
  }
});

test("cell after a restart: the logged row, no offers (they live in memory only)", async () => {
  const run = makeRun();
  delete run.offers;
  for (const r of run.rows) delete r.why;
  const s = await serve(fakeBrain(run));
  try {
    const j = (await getJson(s.base, BASE + "/cell/" + encodeURIComponent("alpha|claim|gameflip"))).body;
    assert.equal(j.row.k, "alpha");
    assert.deepEqual(j.offers, []);
    const none = await getJson(s.base, BASE + "/cell/" + encodeURIComponent("zulu|claim|gameflip"));
    assert.equal(none.status, 404);
  } finally {
    s.close();
  }
  const s2 = await serve(fakeBrain(null));
  try {
    assert.equal((await fetch(s2.base + BASE + "/cell/" + encodeURIComponent("zulu|claim|gameflip"))).status, 404);
    assert.equal((await fetch(s2.base + BASE + "/cell/" + encodeURIComponent("alpha|claim|gameflip"))).status, 200, "history alone answers");
  } finally {
    s2.close();
  }
});

test("accuracy: force=1 is honoured at most once a minute; the winner is a name", async () => {
  const b = fakeBrain(makeRun());
  const s = await serve(b);
  try {
    const first = (await getJson(s.base, BASE + "/accuracy?force=1")).body;
    await fetch(s.base + BASE + "/accuracy?force=1");
    await fetch(s.base + BASE + "/accuracy");
    assert.deepEqual(b.calls.accuracy, [{ force: true }, { force: false }, { force: false }]);
    assert.equal(first.backtest.placement.claim.best, "newsvendor", "{id} becomes the name, so the id scrub cannot drop it");
    assert.deepEqual(first.backtest.placement.claim.partial, ["instock"]);
    assert.equal(first.review[0].l, undefined);
    assert.equal(first.review[0].g, "Alpha");
  } finally {
    s.close();
  }
  // the cooldown belongs to one mount: a fresh router honours its first force
  const b2 = fakeBrain(makeRun());
  const s2 = await serve(b2);
  try {
    await fetch(s2.base + BASE + "/accuracy?force=1");
    assert.deepEqual(b2.calls.accuracy, [{ force: true }]);
  } finally {
    s2.close();
  }
});

test("a brain error is a 500 with its message, never a crash", async () => {
  const b = fakeBrain(makeRun(), {
    latest: async () => {
      throw new Error("log unreadable");
    },
    status: () => {
      throw new Error("status broke");
    },
  });
  const s = await serve(b);
  try {
    const r = await fetch(s.base + BASE + "/latest");
    assert.equal(r.status, 500);
    assert.match((await r.json()).message, /log unreadable/);
    const st = await fetch(s.base + BASE + "/status");
    assert.equal(st.status, 500);
    assert.match((await st.json()).message, /status broke/);
  } finally {
    s.close();
  }
});

/* ------------------------------ source scans ------------------------------ */

test("the route file is read-only, guarded on every route and loads the runner lazily", () => {
  const src = fs.readFileSync(path.join(ROOT, "routes", "listingBrainRoutes.js"), "utf8");
  assert.match(src, /const getLB = \(path, fn\) =>\s*router\.get\(path, \.\.\.guards,/);
  assert.ok(!/router\.(get|post|put|patch|delete)\("\/api/.test(src), "every route goes through getLB");
  assert.ok(!/router\.(post|put|patch|delete)/.test(src), "read-only");
  assert.equal((src.match(/getLB\("\/api\/price-tracker\/listing-brain\//g) || []).length, 4);
  const code = src.replace(/\/\/.*$/gm, "");
  for (const bad of [/\.save\(/, /\.create\(/, /updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate/, /insertMany|deleteOne|deleteMany|bulkWrite/, /require\([^)]*marketplaces[^)]*\)/, /axios/, /saveSettings/, /\.start\(\)/, /\.find\(\{/]) {
    assert.ok(!bad.test(code), "listingBrainRoutes.js matches " + bad);
  }
  // the runner is required only inside the lazy accessor; the loader's cleaner (crypto and fs only)
  // only inside its own lazy accessor, for error text
  const reqs = code.match(/require\([^)]*\)/g) || [];
  assert.deepEqual(reqs, ['require("../utils/listingBrain/inputs")', 'require("../utils/listingBrain")']);
  assert.match(code, /const B = \(\) => brain \|\| require\("\.\.\/utils\/listingBrain"\);/);
  assert.match(code, /const cleanMsg = \(e\) => require\("\.\.\/utils\/listingBrain\/inputs"\)\.cleanMsg\(e\);/);
});

test("the tracker router mounts the listing-brain routes, guarded, without loading the runner", async () => {
  const before = Object.keys(require.cache).filter((k) => k.includes(path.join("utils", "listingBrain"))).length;
  const createRouter = require("../routes/priceTrackerRoutes").createRouter;
  const router = createRouter({ getReport: async () => ({}) });
  const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
  for (const p of ["/status", "/latest", "/cell/:key", "/accuracy"]) assert.ok(paths.includes(BASE + p), "mounted: " + p);
  const after = Object.keys(require.cache).filter((k) => k.includes(path.join("utils", "listingBrain"))).length;
  assert.equal(after, before, "building the router requires no listing-brain module");
  // through createRouter with the guards: anonymous is refused before the (real, lazy) runner is touched
  const deny = (req, res) => res.status(401).json({ success: false, message: "Unauthorized" });
  const app = express();
  app.use(createRouter({ getReport: async () => ({}), guards: [deny] }));
  const s = await listen(app);
  try {
    for (const p of PATHS) assert.equal((await fetch(s.base + p)).status, 401, p);
  } finally {
    s.close();
  }
});

test("the shared files carry exactly the agreed lines", () => {
  const src = fs.readFileSync(path.join(ROOT, "routes", "priceTrackerRoutes.js"), "utf8");
  const head = src.slice(0, src.indexOf("module.exports.real"));
  const real = src.slice(src.indexOf("module.exports.real"));
  // the mount: one guarded line in createRouter, so a missing file can never stop the tracker routes
  assert.match(head, /mountBrain\(router, \{ guards, brain \}\);\n {2}try \{ require\("\.\/listingBrainRoutes"\)\.mount\(router, \{ guards \}\); \} catch \(e\) \{ console\.error\("listingBrain routes: not mounted —", e && e\.message \? e\.message : e\); \}\n {2}return router;/);
  assert.ok(!/\.start\(\)/.test(head.replace(/\/\/.*$/gm, "")), "createRouter never starts a runner");
  // the start: in real(), after the farm brain's, in its own try/catch
  assert.match(real, /require\("\.\.\/utils\/demandBrain"\)\.start\(\);[\s\S]*\}\n {2}try \{ require\("\.\.\/utils\/listingBrain"\)\.start\(\); \} catch \(e\) \{ console\.error\("listingBrain: could not start —", e && e\.message \? e\.message : e\); \}\n/);
  assert.ok(real.indexOf("listingBrain\").start()") < real.indexOf("return createRouter("));

  const html = fs.readFileSync(path.join(ROOT, "public", "price-tracker.html"), "utf8");
  const tag = '<script src="/listing-brain.js"></script>';
  assert.equal(html.split(tag).length - 1, 1, "one script tag");
  const inline = html.indexOf("<script>\n  (function () {");
  assert.ok(inline > 0 && html.indexOf(tag) < inline, "the tab script loads before the page's inline script (no defer/async)");
  assert.match(html, /\["brain", "Farm brain \(test\)"\], \["listing", "Listing brain \(test\)"\],/);
  const dispatch = html.match(/else if \(state\.tab === "listing"\) .*window\.ListingBrainTab\.render\(\{([^}]*)\}\)/);
  assert.ok(dispatch, "one dispatch line");
  assert.equal(html.split('state.tab === "listing"').length - 1, 1);
  const passed = dispatch[1].split(",").map((x) => x.split(":")[0].trim());
  assert.deepEqual(passed, ["api", "shell", "stale", "esc", "money", "pct", "ago", "day", "hrs", "openSheet", "page", "state"]);
  // every helper it passes exists in the page's scope
  for (const h of passed) assert.ok(new RegExp("(function " + h + "\\(|var " + h + " = )").test(html), "page defines " + h);
});

/* --------------------------------- the page --------------------------------- */

const PAGE_JS = fs.readFileSync(path.join(ROOT, "public", "listing-brain.js"), "utf8");
// The rules: no raw property read is concatenated into a string — values go through esc() (or a
// formatter built on it); text escaped later is wrapped in String(). Comments are not code.
const RAW_AFTER = /\+\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]*\])+\s*(?=[+;,):\]?]|$)/gm;
const RAW_BEFORE = /(?:^|[=(,:?]|return)\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]*\])+\s*\+\s*["']/gm;
function rawConcats(src) {
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  return (code.match(RAW_AFTER) || []).concat(code.match(RAW_BEFORE) || []);
}

test("the page script escapes everything it renders (source scan)", () => {
  assert.match(PAGE_JS, /function esc\(v\) \{ return C\.esc\(v\); \}/);
  // the tracker page's own rule (tests/priceTracker.test.js), with the short keys this tab uses
  for (const field of ["title", "externalId", "orderId", "basis", "game", "g", "k", "m", "f", "why", "notes", "note", "lastError", "message", "label"]) {
    const re = new RegExp("\\+\\s*[a-z]+\\." + field + "\\s*\\+", "g");
    for (const m of PAGE_JS.match(re) || []) assert.fail("unescaped " + m);
  }
  assert.deepEqual(rawConcats(PAGE_JS), [], "a raw field concatenated into a string");
  // the scan itself catches what it is for
  assert.equal(rawConcats('x = "<td>" + r.g + "</td>";').length, 1);
  assert.equal(rawConcats("h = a + r.why[0];").length, 1);
  assert.equal(rawConcats('h = r.g + "</td>";').length, 1);
  assert.equal(rawConcats('h = "<td>" + esc(r.g) + "</td>" + rows.map(f).join("");').length, 0);
  // code only, never data; every request goes through the page's api()
  assert.ok(!/\bfetch\(/.test(PAGE_JS), "requests go through c.api");
  assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(PAGE_JS));
  assert.ok(!/\$\d+\.\d\d/.test(PAGE_JS.replace(/^\s*\/\/.*$/gm, "")), "no prices written into the script");
  assert.match(PAGE_JS, /window\.ListingBrainTab = \{ render: render \};/);
});

// A minimal DOM: enough for shell(), querySelector("#id") and the clickable rows.
function fakePage() {
  const els = new Map();
  const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const page = {
    innerHTML: "",
    querySelector(sel) {
      const html = page.allHtml();
      if (sel.startsWith("#") && !html.includes('id="' + sel.slice(1) + '"')) return null;
      if (!els.has(sel)) els.set(sel, { value: "", innerHTML: "", onchange: null, onclick: null, oninput: null });
      return els.get(sel);
    },
    querySelectorAll(sel) {
      const attr = sel.replace(/^\[|\]$/g, "");
      const out = [];
      const re = new RegExp(attr + '="([^"]*)"', "g");
      let m;
      while ((m = re.exec(page.allHtml()))) {
        const v = unesc(m[1]);
        out.push({ onclick: null, getAttribute: () => v });
      }
      page.clickables = out;
      return out;
    },
    allHtml() {
      return page.innerHTML + [...els.values()].map((e) => e.innerHTML).join("");
    },
    reset() {
      els.clear();
    },
  };
  return page;
}

function pageHelpers(base, page) {
  const html = fs.readFileSync(path.join(ROOT, "public", "price-tracker.html"), "utf8");
  // the page's real esc(), not a copy
  const escSrc = html.match(/function esc\(v\) \{[\s\S]*?\n {4}\}/)[0];
  const esc = new Function(escSrc + "; return esc;")();
  const state = { tab: "listing" };
  const sheet = { title: null, html: null, n: 0 };
  return {
    sheet,
    ctx: {
      esc,
      money: (n) => "$" + (Number(n) || 0).toFixed(2),
      pct: (n) => Math.round((Number(n) || 0) * 100) + "%",
      ago: () => "5 min ago",
      day: (d) => (d ? String(d).slice(0, 10) : "—"),
      hrs: (h) => (h == null ? "—" : Math.round(h) + " h"),
      api: async (p) => {
        const r = await fetch(base + p);
        const j = await r.json();
        if (!r.ok || j.success === false) throw new Error(j.message || "HTTP " + r.status);
        return j;
      },
      shell: (inner) => {
        state.gen = (state.gen || 0) + 1;
        page.reset();
        page.innerHTML = inner;
        return state.gen;
      },
      stale: (g) => g !== state.gen,
      openSheet: (title, h) => {
        sheet.title = title;
        sheet.html = h;
        sheet.n++;
      },
      page,
      state,
    },
  };
}

function loadTab() {
  const ctx = { window: {}, setTimeout, clearTimeout };
  vm.createContext(ctx);
  vm.runInContext(PAGE_JS, ctx, { filename: "listing-brain.js" });
  assert.equal(typeof ctx.window.ListingBrainTab.render, "function");
  return ctx.window.ListingBrainTab;
}

async function waitFor(fn, ms = 2000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("the tab renders every view and the cell sheet, escaping hostile data", async () => {
  const run = makeRun();
  run.rows[0].g = XSS + "Alpha";
  run.rows[0].why = ["<script>alert(1)</script> reason"];
  run.rows[0].fl = ["fee-assumed", "<i>bad</i>"];
  run.notes = ["<svg onload=alert(1)> note"];
  run.cfg.policyPrice = "<u>curve</u>";
  run.offers[0].why = ["<script>offer</script>"];
  run.offers[0].gates = ["<b onclick=x>gate</b>"];
  const acc = JSON.parse(JSON.stringify(ACCURACY));
  acc.review[0].g = XSS + "Rev";
  acc.backtest.note = "<script>note</script>";
  const brain = fakeBrain(run, {
    status: () => ({ config: { enabled: true, intervalMin: 180 }, runs: 3, lastPersisted: false, lastError: "<svg onload=1>err", lastRunAt: new Date() }),
    accuracy: async () => acc,
  });
  const s = await serve(brain);
  const page = fakePage();
  const { ctx, sheet } = pageHelpers(s.base, page);
  const tab = loadTab();
  const hostile = (h) => {
    for (const bad of ["<img src=x", "<script>", "<svg onload", "<i>bad</i>", "<u>curve</u>", "<b onclick"]) assert.ok(!h.includes(bad), "raw " + bad + " in the output");
  };
  try {
    // Overview
    await tab.render(ctx);
    let out = page.allHtml();
    hostile(out);
    assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;Alpha/);
    assert.match(out, /Auto-farm \(claim farm\)/);
    assert.match(out, /No-claim farm/);
    assert.match(out, /NOT LOGGED/);
    assert.match(out, /Biggest disagreements on live campaigns/);
    assert.match(out, /\$10\.50/);
    assert.match(out, /\$12\.25/);
    assert.match(out, /fee assumed/);
    assert.match(out, /&lt;svg onload=alert\(1\)&gt; note/);
    assert.match(out, /Test mode: it writes down what it would decide and changes nothing/);

    // the cell sheet, opened by clicking the first row
    const click = page.clickables.find((c) => c.getAttribute("data-lbkey") === "alpha|claim|gameflip");
    assert.ok(click, "rows carry their cell key (unescaped by the DOM)");
    click.onclick();
    await waitFor(() => sheet.title && sheet.title !== "Loading…");
    hostile(sheet.html);
    assert.equal(sheet.title, XSS + "Alpha · Gameflip", "the title is set as text (textContent), not HTML");
    assert.match(sheet.html, /lower one step/);
    assert.match(sheet.html, /&lt;script&gt;offer&lt;\/script&gt;/);
    assert.match(sheet.html, /History \(newest first\)/);
    assert.match(sheet.html, /10-03 09:00/);

    // Cells
    ctx.state.lb.view = "cells";
    await tab.render(ctx);
    out = page.allHtml();
    hostile(out);
    assert.match(out, /<table class="pm">/);
    assert.match(out, /6 cells/);
    assert.ok(out.indexOf("Alpha") < out.indexOf("BRAVO"), "live campaigns first");
    ctx.state.lb.pc = "brain-lower";
    await tab.render(ctx);
    assert.match(page.allHtml(), /1 cells/);
    ctx.state.lb.pc = "";

    // Accuracy
    ctx.state.lb.view = "accuracy";
    await tab.render(ctx);
    out = page.allHtml();
    hostile(out);
    assert.match(out, /brain \(newsvendor\) ✓ best/);
    assert.ok(!/in-stock sell rate ✓ best/.test(out));
    assert.match(out, /in-stock sell rate — not enough history yet/);
    assert.match(out, /correlation, not cause/i);
    assert.match(out, /Brier/);
    assert.match(out, /beats the baseline/);
    assert.match(out, /Sold or expired/);
    assert.match(out, /Not enough history yet: the first live scores appear/);
    assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;Rev/);
  } finally {
    s.close();
  }
});

test("the tab says so plainly before the first run", async () => {
  const s = await serve(fakeBrain(null, { status: () => ({ config: { enabled: false, intervalMin: 180 }, runs: 0 }) }));
  const page = fakePage();
  const { ctx } = pageHelpers(s.base, page);
  try {
    await loadTab().render(ctx);
    const out = page.allHtml();
    assert.match(out, /No run logged yet/);
    assert.match(out, /test log OFF/);
    assert.match(out, /autoFarm\.listingBrain\.enabled = true/);
  } finally {
    s.close();
  }
});

/* ------------------------- review findings: error text and scrubbing (P4, P8) ------------------------- */

test("P4 a route error is a 500 with a cleaned message", async () => {
  const b = fakeBrain(makeRun(), {
    status: () => {
      throw new Error("connect ECONNREFUSED 10.9.8.7:27017 db01.prod.myshop.lk");
    },
    latest: async () => {
      throw new Error("pool for db01.prod.myshop.lk:27017 cleared; getaddrinfo ENOTFOUND mongo-primary-7 at /var/www/app/x.js");
    },
  });
  const s = await serve(b);
  try {
    const st = await fetch(s.base + BASE + "/status");
    assert.equal(st.status, 500);
    const m1 = (await st.json()).message;
    assert.match(m1, /ECONNREFUSED/);
    assert.ok(!/10\.9\.8\.7|myshop/.test(m1), m1);
    const lt = await fetch(s.base + BASE + "/latest");
    assert.equal(lt.status, 500);
    const m2 = (await lt.json()).message;
    assert.match(m2, /ENOTFOUND/);
    assert.ok(!/myshop|mongo-primary-7|\/var\/www/.test(m2), m2);
  } finally {
    s.close();
  }
});

test("P8 status, summary, counts, cfg, notes and accuracy drop free-text keys at any depth; rows keep their game label; lastError is shown cleaned", async () => {
  const run = makeRun({
    summary: { ...SUMMARY, note: "LEAK-NOTE", deep: { title: "LEAK-TITLE", url: "LEAK-URL" } },
    counts: { listings: 30, description: "LEAK-DESC" },
    cfg: { enabled: true, intervalMin: 180, name: "LEAK-NAME" },
  });
  const acc = { ...ACCURACY, forward: { runsScored: 0, runsWaiting: 2, x: { lastError: "LEAK-LASTERR" } }, backtest: { ...ACCURACY.backtest, extra: { description: "LEAK-D2", note: "LEAK-NOTE2" } } };
  const b = fakeBrain(run, {
    status: () => ({ config: { enabled: true, note: "LEAK-STATUS-NOTE" }, runs: 1, lastError: "log write failed: getaddrinfo ENOTFOUND mongo-primary-7", summary: { title: "LEAK-ST-TITLE" } }),
    accuracy: async () => acc,
  });
  const s = await serve(b);
  try {
    const st = (await getJson(s.base, BASE + "/status")).body;
    const lt = (await getJson(s.base, BASE + "/latest")).body;
    const ac = (await getJson(s.base, BASE + "/accuracy")).body;
    const text = JSON.stringify([st, lt, ac]);
    for (const leak of ["LEAK-NOTE", "LEAK-TITLE", "LEAK-URL", "LEAK-DESC", "LEAK-NAME", "LEAK-LASTERR", "LEAK-D2", "LEAK-NOTE2", "LEAK-STATUS-NOTE", "LEAK-ST-TITLE", "mongo-primary-7"]) {
      assert.ok(!text.includes(leak), leak + " leaked");
    }
    assert.match(st.lastError, /log write failed: getaddrinfo ENOTFOUND/, "the page still shows the last error, cleaned");
    assert.match(lt.status.lastError, /log write failed/);
    assert.equal(lt.rows.find((r) => r.k === "alpha" && r.m === "gameflip").g, "ALPHA", "a row's game label stays");
    assert.equal(ac.backtest.note, "synthetic", "the scorer's own explanation at its known place stays");
  } finally {
    s.close();
  }
  const src = fs.readFileSync(path.join(ROOT, "routes", "listingBrainRoutes.js"), "utf8");
  assert.ok(!/Responses are WHITELISTED, field by field/.test(src), "the header no longer claims every response is whitelisted");
  assert.match(src, /scrubbed/i);
});
