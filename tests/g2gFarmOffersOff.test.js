const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { FARM_TITLE, gameOf, buildPlan, runWrites, readBack, isRateLimited } = require("../scripts/g2g-farm-offers-off");

test("farm-offer test is the one delivery uses", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "g2gFarmService.js"), "utf8");
  const m = src.match(/const FARM_TITLE = (\/.*\/[a-z]*);/);
  assert.ok(m, "g2gFarmService declares FARM_TITLE");
  assert.strictEqual(String(FARM_TITLE), m[1]);
});

test("plan takes farming windows only, and the extra ids asked for", () => {
  const offers = [
    { offerId: "A", title: "Rust Twitch Drops Automatic Farming 120 Days", unitPrice: 3.99, actualQty: 20, status: "live" },
    { offerId: "B", title: "Rust Twitch Drops (36 Items) — Skin + Skin +34 more", unitPrice: 1, actualQty: 22 },
    { offerId: "C", title: "Brawlhalla Twitch Drops Automatic Farming 1 Year", unitPrice: 8.99, actualQty: 18 },
    { offerId: "D", title: "Custom order", unitPrice: 1, actualQty: 1 },
    { offerId: "", title: "Halo Infinite Twitch Drops Automatic Farming 30 Days" },
  ];
  const plan = buildPlan(offers, { also: new Set(["D"]) });
  assert.deepStrictEqual(plan.map((r) => r.id), ["A", "C", "D"]);
  assert.strictEqual(plan[0].game, "Rust");
  assert.strictEqual(plan[1].game, "Brawlhalla");
  assert.ok(plan.every((r) => r.action === "delist"));
});

test("gameOf reads the game in front of the farm title", () => {
  assert.strictEqual(gameOf("Arena Breakout: Infinite Twitch Drops Automatic Farming 2 Years"), "Arena Breakout: Infinite");
  assert.strictEqual(gameOf("Custom order"), "");
});

test("writes stop on a 429 and on three failures in a row", async () => {
  const r429 = await runWrites(["a", "b", "c"], async (id) => { if (id === "b") { const e = new Error("G2G update offer failed (HTTP 429)"); throw e; } }, { gapMs: 0 });
  assert.deepStrictEqual(r429.done, ["a"]);
  assert.strictEqual(r429.failed.length, 1);
  assert.match(r429.stopped, /429/);

  const r3 = await runWrites(["a", "b", "c", "d", "e"], async (id) => { if (id !== "a") throw new Error("boom"); }, { gapMs: 0 });
  assert.deepStrictEqual(r3.done, ["a"]);
  assert.strictEqual(r3.failed.length, 3);
  assert.match(r3.stopped, /3 failures/);

  const ok = await runWrites(["a", "b"], async () => {}, { gapMs: 0 });
  assert.deepStrictEqual(ok.done, ["a", "b"]);
  assert.strictEqual(ok.stopped, "");
  assert.ok(isRateLimited({ status: 429 }));
  assert.ok(!isRateLimited(new Error("HTTP 400")));
});

test("read-back asks again while the list trails the write", async () => {
  let calls = 0;
  const lists = [[{ offerId: "a" }], [{ offerId: "a" }, { offerId: "b" }]];
  const rb = await readBack(async () => lists[Math.min(calls++, 1)], ["a", "b"], { tries: 3, waitMs: 0 });
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(rb.missing, []);
  const never = await readBack(async () => [{ offerId: "a" }], ["a", "x"], { tries: 2, waitMs: 0 });
  assert.deepStrictEqual(never.missing, ["x"]);
});
