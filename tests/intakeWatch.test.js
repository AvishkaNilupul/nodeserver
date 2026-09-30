// A marketplace whose paid-order read keeps failing must page (2026-10-01).
// Before: one console line per tick and a silent return — a paid order that is
// never READ creates no FarmServiceOrder row, so no other alarm could see it.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

const sent = [];
const events = [];
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /utils[\\/]intakeWatch\.js$/.test(parent.filename || "")) {
    if (request === "./telegram") return { sendTelegram: async (m) => sent.push(m) };
    if (request === "./systemLog") return { logEvent: (e) => events.push(e) };
  }
  return realLoad.call(this, request, parent, isMain);
};
const w = require("../utils/intakeWatch");
test.after(() => { Module._load = realLoad; });

function reset() {
  sent.length = 0;
  events.length = 0;
  w._state.clear();
}

test("a single failed read (a blip) never pages, and its recovery says nothing", async () => {
  reset();
  const t0 = 1_000_000;
  assert.equal(await w.failed("Eldorado", new Error("ETIMEDOUT"), t0), false);
  assert.equal(await w.ok("Eldorado", t0 + 60000), false);
  assert.deepEqual(sent, []);
});

test("REGRESSION: reads failing for 5+ minutes page ONCE, then again only after 6 h", async () => {
  reset();
  const t0 = 1_000_000;
  const e = new Error("401 session expired");
  for (let i = 0; i < 5; i++) await w.failed("Eldorado", e, t0 + i * 60000); // 0..4 min
  assert.equal(sent.length, 0, "not yet 5 minutes");
  assert.equal(await w.failed("Eldorado", e, t0 + 5 * 60000), true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Eldorado paid orders cannot be read — failing for 5 min \(6 reads\)/);
  assert.match(sent[0], /401 session expired/);
  for (let i = 6; i < 60; i++) await w.failed("Eldorado", e, t0 + i * 60000);
  assert.equal(sent.length, 1, "no page every minute");
  await w.failed("Eldorado", e, t0 + 5 * 60000 + w.REALERT_MS);
  assert.equal(sent.length, 2, "re-paged after 6 h");
  assert.equal(events[0].action, "order_intake_failing");
});

test("recovery after a page is announced once", async () => {
  reset();
  const t0 = 1_000_000;
  for (let i = 0; i <= 6; i++) await w.failed("G2G", new Error("502"), t0 + i * 60000);
  assert.equal(await w.ok("G2G", t0 + 10 * 60000), true);
  assert.match(sent[sent.length - 1], /G2G paid-order reads are working again \(were failing for 10 min\)/);
  assert.equal(await w.ok("G2G", t0 + 11 * 60000), false);
});

test("markets are tracked independently", async () => {
  reset();
  const t0 = 1_000_000;
  for (let i = 0; i <= 6; i++) await w.failed("PlayerAuctions", new Error("x"), t0 + i * 60000);
  await w.ok("Eldorado", t0 + 7 * 60000);
  assert.equal(sent.length, 1);
  assert.ok(w._state.has("PlayerAuctions"));
});

test("all three order-API fulfillers report every intake read to the watchdog", () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", "utils", f), "utf8");
  const eld = read("eldoradoFulfiller.js");
  assert.match(eld, /intakeWatch\("failed", "Eldorado", e\)/);
  assert.match(eld, /intakeWatch\("ok", "Eldorado"\)/);
  const pa = read("playerauctionsFulfiller.js");
  assert.match(pa, /intakeWatch\("failed", "PlayerAuctions", e\)/);
  assert.match(pa, /intakeWatch\("ok", "PlayerAuctions"\)/);
  const g2g = read("g2gFulfiller.js");
  assert.equal((g2g.match(/intakeWatch\("failed", "G2G", e\)/g) || []).length, 2, "both G2G reads");
  // The watch can never break a tick — not even by failing to load.
  for (const src of [eld, pa, g2g]) {
    assert.match(src, /function intakeWatch\(fn, \.\.\.args\) \{\n  try \{\n    return Promise\.resolve\(require\("\.\/intakeWatch"\)\[fn\]\(\.\.\.args\)\)\.catch\(\(\) => \{\}\);\n  \} catch \{/);
  }
  assert.match(g2g, /orders = await mp\.g2gPendingOrders\(\{\}\);\n  \} catch \(e\) \{/, "the second G2G read is guarded");
});
