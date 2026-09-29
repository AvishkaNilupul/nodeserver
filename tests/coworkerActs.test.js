// Safety coverage for the AI coworker's ACT layer (utils/coworkerActs.js).
//
// This is the module that lets a small, occasionally-confused model act on
// production by itself, so its guardrails are the most safety-critical code in
// the coworker. These tests pin the four properties that make autonomy safe:
//   1. OFF by default — deploying it changes nothing until explicitly enabled.
//   2. Unknown actions are refused, never improvised.
//   3. Blast radius is capped per action.
//   4. An absurd farming window is refused, not applied.
const test = require("node:test");
const assert = require("node:assert");

const { runAct, listActs, resolveDays, checkCount, ACTS } = require("../utils/coworkerActs");
const settings = require("../utils/settings");

test("autonomy ships OFF, so nothing executes until it is enabled", () => {
  // Guards the deploy-safety property: shipping this module must not change
  // behaviour. If this ever fails, a deploy silently grants the model write
  // access to production.
  assert.strictEqual(settings.getCoworkerAutonomy().enabled, false);
});

test("with autonomy off, a real action is blocked and does nothing", async () => {
  const r = await runAct("farm_fresh_account", { game: "Apex Legends", days: 30 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.blocked, "autonomy_off");
  assert.match(r.error, /switched OFF/i);
  assert.match(r.error, /coworkerAutonomy/); // tells the operator how to enable
});

test("an unknown action is refused, never improvised", async () => {
  const r = await runAct("delete_everything", {});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /unknown action/i);
});

test("runAct never throws — every outcome is data the model can read", async () => {
  for (const args of [undefined, null, {}, { game: 123 }, { days: "abc" }]) {
    const r = await runAct("farm_fresh_account", args);
    assert.strictEqual(typeof r, "object");
    assert.strictEqual(r.ok, false);
  }
});

test("every registered capability declares a tier, and auto-tier ones are bounded", () => {
  // An "auto" capability without a cap would be unbounded write access.
  for (const a of listActs()) {
    assert.ok(["auto", "confirm"].includes(a.tier), `${a.name} has an invalid tier`);
    if (a.tier === "auto") {
      assert.ok(a.maxCount > 0, `${a.name} is auto-tier but has no maxCount cap`);
      assert.ok(a.undo, `${a.name} is auto-tier but documents no undo path`);
    }
  }
});

test("checkCount caps the blast radius", () => {
  const act = ACTS.farm_fresh_account;
  assert.strictEqual(checkCount(act, 1).count, 1);
  assert.strictEqual(checkCount(act, act.maxCount).count, act.maxCount);
  // One past the cap is refused.
  const over = checkCount(act, act.maxCount + 1);
  assert.strictEqual(over.ok, false);
  assert.match(over.error, /at most/);
  // A confused model asking for the whole pool gets nothing.
  assert.strictEqual(checkCount(act, 5000).ok, false);
  // Defaults to 1 when omitted.
  assert.strictEqual(checkCount(act, undefined).count, 1);
  // Non-positive is refused.
  assert.strictEqual(checkCount(act, 0).ok, false);
  assert.strictEqual(checkCount(act, -3).ok, false);
});

test("resolveDays accepts an explicit day count", () => {
  assert.deepStrictEqual(resolveDays({ days: 180 }), { ok: true, days: 180 });
  assert.strictEqual(resolveDays({ days: 0 }).ok, false);
  assert.strictEqual(resolveDays({}).ok, false);
});

test("resolveDays parses a natural duration", () => {
  assert.strictEqual(resolveDays({ duration: "3 months" }).days, 90);
  assert.strictEqual(resolveDays({ duration: "2 weeks" }).days, 14);
  assert.strictEqual(resolveDays({ duration: "180 days" }).days, 180);
});

test("an absurd window is REFUSED and explicitly reports that nothing was done", () => {
  // The operator's own phrasing: "farm apex legends for 180 months".
  const r = resolveDays({ duration: "180 months" });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /NOT done anything/);
  assert.match(r.error, /180 days/); // suggests the likely intent
});

test("watch-time phrasing is refused rather than becoming a lease", () => {
  const r = resolveDays({ duration: "180 minutes" });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /watch-time/);
});
