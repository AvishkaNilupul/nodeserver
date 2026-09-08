// What a rent-farm order says, and who it tells, when it cannot be filled.
//
// The case this is built from: Eldorado order
// 4b20765f-206b-411f-698d-08df0d9a5d3a (2026-09-08 15:20Z, Rainbow Six Siege,
// 180 days, qty 1) failed four times and recorded one sentence —
//   "only 0 of 1 pristine pool accounts could be provisioned"
// — while operatorFarm.farmFreshAccounts had handed back the real reason in
// `skipped`. Nothing alerted either: the owner noticed by looking, and delivered
// it by hand. Measured afterwards the pool was fine (363 eligible, quota 193
// free, Pi reachable), so the discarded reason was the only evidence there was.
const test = require("node:test");
const assert = require("node:assert");

const alert = require("../utils/farmServiceAlert");

/* ------------------------------ the reason ------------------------------- */

test("REGRESSION: the skip reason survives into lastError", () => {
  const msg = alert.shortfallMessage(
    {
      added: [],
      skipped: [{ username: "abi888jrbpd", reason: "connect ETIMEDOUT 100.126.112.7:22" }],
    },
    1,
  );
  assert.match(msg, /only 0 of 1/);
  assert.match(msg, /abi888jrbpd/);
  assert.match(msg, /ETIMEDOUT/, "the actual cause must reach the operator");
});

test("no skips at all is a different failure from a failed move, and says so", () => {
  // Nothing was even picked: the pool filter came back empty. "Buy more
  // accounts" and "the Pi write is broken" have nothing in common, so the two
  // must never read the same.
  const msg = alert.shortfallMessage({ added: [], skipped: [] }, 1);
  assert.match(msg, /no candidate was picked/);
  assert.doesNotMatch(msg, /undefined/);
});

test("a partial provision reports what it DID get", () => {
  const msg = alert.shortfallMessage(
    { added: [{ login: "a" }, { login: "b" }], skipped: [{ username: "c", reason: "was claimed by someone else" }] },
    3,
  );
  assert.match(msg, /only 2 of 3/);
});

test("many skips are capped by whole reasons, never truncated mid-message", () => {
  const skipped = Array.from({ length: 9 }, (_, i) => ({
    username: "acct" + i,
    reason: "a reason that is fairly long so the cap actually matters " + i,
  }));
  const msg = alert.shortfallMessage({ added: [], skipped }, 9);
  assert.ok(msg.length <= 400, "lastError is capped at 400 chars, got " + msg.length);
  assert.match(msg, /\(\+5 more\)/, "the ones that did not fit must still be counted");
  // The last reason shown is whole: the cap dropped entries, not characters.
  assert.match(msg, /acct3: a reason that is fairly long/);
});

test("a hostile reason cannot blow the 400-char cap on its own", () => {
  const msg = alert.shortfallMessage(
    { added: [], skipped: [{ username: "x", reason: "E".repeat(5000) }] },
    1,
  );
  assert.ok(msg.length <= 400);
});

/* ------------------------------ who is told ------------------------------ */

test("the first failure always pages, a retry storm does not", () => {
  // The fulfiller re-attempts roughly every 75s while the order is still
  // pending on the platform. One alert per attempt would be a flood; none
  // after the first would let a stuck order go quiet.
  assert.strictEqual(alert.shouldAlert({ state: "pending", attempts: 1 }), true);
  assert.strictEqual(alert.shouldAlert(null), true);
  for (const n of [1, 2, 3, 9, 11]) {
    assert.strictEqual(
      alert.shouldAlert({ state: "failed", attempts: n }),
      false,
      "attempt " + n + " should stay quiet",
    );
  }
});

test("a failure that persists re-pings, so it cannot be forgotten", () => {
  for (const n of [10, 20, 30]) {
    assert.strictEqual(alert.shouldAlert({ state: "failed", attempts: n }), true);
  }
});

test("recovering and failing again pages immediately", () => {
  // state moved off "failed" (provisioned/sent) and came back — that is new
  // information, not a repeat of the same stuck attempt.
  assert.strictEqual(alert.shouldAlert({ state: "provisioned", attempts: 7 }), true);
});

/* --------------------- every farm service is wired up -------------------- */

test("all three farm services alert on every way an order can fail", () => {
  const fs = require("node:fs");
  for (const f of [
    "utils/eldoradoFarmService.js",
    "utils/playerauctionsFarmService.js",
    "utils/g2gFarmService.js",
  ]) {
    const src = fs.readFileSync(require("node:path").join(__dirname, "..", f), "utf8");
    const failures = (src.match(/row\.state = "failed"/g) || []).length;
    const alerts = (src.match(/alertFarmFailure\(/g) || []).length;
    assert.strictEqual(
      alerts,
      failures,
      f + ": " + failures + " failure branches but " + alerts + " alerts — a paid " +
        "order must never fail silently",
    );
    assert.match(src, /const MARKET = "/, f + " has no MARKET constant for its alerts");
  }
});
