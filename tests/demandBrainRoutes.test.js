/* global fetch */
// The farm brain's API (routes/priceTrackerRoutes.js mountBrain): guarded, read-only, filters and
// paging, and the boot hook that starts the brain from the real router only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const createRouter = require("../routes/priceTrackerRoutes");

function row(k, f, o = {}) {
  return { k, g: k.toUpperCase(), f, live: false, d: "agree", old: { c: "farm", t: 10, w: 1 }, br: { c: "farm", t: 10, w: 1, u: 2 }, mk: null, why: ["because"], ...o };
}

function fakeBrain(run) {
  const calls = { accuracy: [], history: [] };
  return {
    calls,
    status: () => ({ config: { enabled: true, intervalMin: 60 }, runs: 3 }),
    latest: async () => run,
    gameHistory: async (key, farm, limit) => {
      calls.history.push({ key, farm, limit });
      return key === "a" ? [{ at: new Date(), ...row("a", farm) }] : [];
    },
    accuracy: async (o) => {
      calls.accuracy.push(o);
      return { backtest: { scores: {} }, forward: { runsScored: 0 }, review: [] };
    },
  };
}

async function serve(brain, guards = []) {
  const app = express();
  app.use(createRouter({ getReport: async () => ({}), brain, guards }));
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  return { base: "http://127.0.0.1:" + server.address().port, close: () => server.close() };
}

const RUN = {
  at: new Date(),
  v: 1,
  ms: 900,
  cfg: { enabled: true },
  summary: { claim: {}, noclaim: {} },
  counts: {},
  notes: [],
  rows: [
    row("a", "claim", { live: true, d: "brain-more", old: { c: "farm", t: 10, w: 1 }, br: { c: "farm", t: 40, w: 9 } }),
    row("b", "claim", { d: "agree" }),
    row("c", "claim", { live: true, d: "agree" }),
    row("rainbow six", "noclaim", { d: "agree", live: true }),
    row("dd", "claim", { d: "brain-less", old: { c: "farm", t: 30 }, br: { c: "farm", t: 5 } }),
  ],
};

test("every brain route is behind the guards", async () => {
  const guard = (req, res, next) => (req.query.deny === "1" ? res.status(401).json({ success: false }) : next());
  const s = await serve(fakeBrain(RUN), [guard]);
  try {
    for (const p of ["/api/price-tracker/brain/status", "/api/price-tracker/brain/latest", "/api/price-tracker/brain/game/a", "/api/price-tracker/brain/accuracy"]) {
      assert.equal((await fetch(s.base + p + "?deny=1")).status, 401, p);
      assert.equal((await fetch(s.base + p)).status, 200, p);
    }
  } finally {
    s.close();
  }
});

test("latest: live first, disagreements first, filters and paging", async () => {
  const s = await serve(fakeBrain(RUN));
  try {
    const all = await (await fetch(s.base + "/api/price-tracker/brain/latest")).json();
    assert.equal(all.total, 5);
    // live first; within each, disagreements first by the size of the gap; ties by name
    assert.deepEqual(all.rows.map((r) => r.k), ["a", "c", "rainbow six", "dd", "b"]);
    assert.deepEqual(all.rows[0].why, ["because"]);
    const nc = await (await fetch(s.base + "/api/price-tracker/brain/latest?farm=noclaim")).json();
    assert.deepEqual(nc.rows.map((r) => r.k), ["rainbow six"]);
    const less = await (await fetch(s.base + "/api/price-tracker/brain/latest?d=brain-less")).json();
    assert.deepEqual(less.rows.map((r) => r.k), ["dd"]);
    const live = await (await fetch(s.base + "/api/price-tracker/brain/latest?live=1&farm=claim")).json();
    assert.deepEqual(live.rows.map((r) => r.k).sort(), ["a", "c"]);
    const q = await (await fetch(s.base + "/api/price-tracker/brain/latest?q=DD")).json();
    assert.deepEqual(q.rows.map((r) => r.k), ["dd"]);
    const pg = await (await fetch(s.base + "/api/price-tracker/brain/latest?limit=2&offset=2")).json();
    assert.equal(pg.rows.length, 2);
    assert.equal(pg.total, 5);
    assert.equal(pg.offset, 2);
    const weird = await (await fetch(s.base + "/api/price-tracker/brain/latest?sort=__proto__")).json();
    assert.equal(weird.success, true, "an unknown sort falls back");
  } finally {
    s.close();
  }
});

test("latest before any run: an empty answer with the status, not an error", async () => {
  const s = await serve(fakeBrain(null));
  try {
    const j = await (await fetch(s.base + "/api/price-tracker/brain/latest")).json();
    assert.equal(j.success, true);
    assert.equal(j.empty, true);
    assert.equal(j.status.runs, 3);
  } finally {
    s.close();
  }
});

test("game: the newest row with its reasons plus history; 404 when never logged", async () => {
  const b = fakeBrain(RUN);
  const s = await serve(b);
  try {
    const j = await (await fetch(s.base + "/api/price-tracker/brain/game/a?limit=9999")).json();
    assert.equal(j.row.k, "a");
    assert.deepEqual(j.row.why, ["because"]);
    assert.equal(j.history.length, 1);
    assert.deepEqual(b.calls.history[0], { key: "a", farm: "claim", limit: 288 }, "limit clamped");
    const nc = await fetch(s.base + "/api/price-tracker/brain/game/rainbow%20six?farm=noclaim");
    assert.equal(nc.status, 200);
    assert.equal((await fetch(s.base + "/api/price-tracker/brain/game/zzz")).status, 404);
  } finally {
    s.close();
  }
});

test("accuracy: force=1 is honoured at most once a minute", async () => {
  const b = fakeBrain(RUN);
  const s = await serve(b);
  try {
    await fetch(s.base + "/api/price-tracker/brain/accuracy?force=1");
    await fetch(s.base + "/api/price-tracker/brain/accuracy?force=1");
    assert.deepEqual(b.calls.accuracy, [{ force: true }, { force: false }]);
  } finally {
    s.close();
  }
});

test("a brain error is a 500 with its message, never a crash", async () => {
  const b = fakeBrain(RUN);
  b.latest = async () => {
    throw new Error("log unreadable");
  };
  const s = await serve(b);
  try {
    const r = await fetch(s.base + "/api/price-tracker/brain/latest");
    assert.equal(r.status, 500);
    assert.match((await r.json()).message, /log unreadable/);
  } finally {
    s.close();
  }
});

test("the real router starts the brain at boot, and only the real router does", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "routes", "priceTrackerRoutes.js"), "utf8");
  const real = src.slice(src.indexOf("module.exports.real"));
  assert.match(real, /require\("\.\.\/utils\/demandBrain"\)\.start\(\)/);
  assert.match(real, /try \{[\s\S]*\.start\(\);[\s\S]*\} catch/, "a failure to start never stops the page mounting");
  const head = src.slice(0, src.indexOf("module.exports.real"));
  assert.ok(!/\.start\(\)/.test(head.replace(/\/\/.*$/gm, "")), "createRouter never starts it (tests and the preview use createRouter)");
  assert.match(head, /const getB = \(path, fn\) =>\s*router\.get\(path, \.\.\.guards,/);
});
