// Four Gameflip defects an adversarial audit confirmed on 2026-09-09.
//
// They share a shape worth naming: each one is a place where a SAFE primitive
// already existed in this codebase and this path used the unsafe sibling.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const FULFILLER = read("utils/gameflipFulfiller.js");
const LISTER = read("utils/autoLister.js");
const ROUTES = read("routes/marketplaceRoutes.js");

/* ============ 1. releasing one set must not free another ================= */
//
// releaseAccount called releaseAccountsForTag(id, "gameflip"), which clears
// EVERY DropLog row on the account tagged "gameflip". One account can hold two
// Gameflip reservations at once: an Overwatch bundle already delivered to a
// buyer (its row is "sold", so the account is out of loginsOnActiveListings and
// eligible again) and a Rainbow Six bundle just claimed for a relist. When
// gameflipPublish threw — a 429 from the silent rate limiter is the documented
// common case — the release wiped BOTH. The buyer's paid-for Overwatch drops
// went back in the sellable pool and were sold to a second buyer.

test("REGRESSION: a Gameflip release is scoped to ONE set", () => {
  const fn = FULFILLER.slice(
    FULFILLER.indexOf("async function releaseAccount("),
    FULFILLER.indexOf("function gameflipDeliveryCode("),
  );
  assert.match(
    fn,
    /releaseSetForAccounts\(\[String\(accountId\)\], String\(setId\), GF_CLAIM_TAG\)/,
    "must free only this set's drops",
  );
  assert.doesNotMatch(
    fn,
    /releaseAccountsForTag\(\[accountId\], GF_CLAIM_TAG\)/,
    "the tag-wide release overreaches into other sets on the same account",
  );
});

test("a release with no set REFUSES rather than guessing", () => {
  // A leaked reservation costs a sale and a human can undo it. A wrongly freed
  // reservation sells one account to two buyers and nobody can undo that.
  const fn = FULFILLER.slice(
    FULFILLER.indexOf("async function releaseAccount("),
    FULFILLER.indexOf("function gameflipDeliveryCode("),
  );
  assert.match(fn, /if \(!setId\) \{/);
  assert.match(fn, /refusing to release account/);
  const guard = fn.indexOf("if (!setId)");
  const release = fn.indexOf("releaseSetForAccounts");
  assert.ok(guard > 0 && release > guard, "the guard must come before the release");
});

test("every release call site passes a set", () => {
  const calls = FULFILLER.match(/releaseAccount\([^)]*\)/g) || [];
  const invocations = calls.filter((c) => !/^releaseAccount\(accountId, setId\)/.test(c));
  assert.ok(invocations.length >= 3, "expected the three release sites");
  for (const c of invocations) {
    assert.match(c, /,/, "call site " + c + " passes no set id");
  }
  // And the hand-delist route, which is a separate file and was missed first.
  assert.match(ROUTES, /gfFulfiller\.releaseAccount\(row\.accountId, row\.set\)/);
});

/* ============ 2. only "sold" and 404 used to retire a row =============== */
//
// Every Gameflip listing is created with expire_in_days: 30, and an expired
// listing answers 200 with status "expired" — no 404. It appears in neither bulk
// sweep, so it cost one rate-limited status call every 60 seconds forever, the
// answer was never "sold", and the row stayed "active": its account frozen out
// of the sellable pool, its owed units never relisted.

test("REGRESSION: an expired or cancelled listing is retired", () => {
  assert.match(
    FULFILLER,
    /if \(status === "expired" \|\| status === "cancelled"\) \{/,
    "expired is a terminal state, not 'still live'",
  );
  const block = FULFILLER.slice(FULFILLER.indexOf('if (status === "expired"'));
  assert.match(block.slice(0, 900), /status: "removed"/);
  assert.match(block.slice(0, 900), /releaseAccount\(row\.accountId, row\.set\)/,
    "retiring must hand the account back, scoped to the set");
});

test("a RECOVERABLE state is recorded, not retired", () => {
  // "ready"/"draft" mean the listing exists and is public but not purchasable —
  // usually a status patch a rate-limited API answered 200 and did not apply.
  // Retiring it throws away a listing one patch would revive, and releasing its
  // account hands back stock the listing still names.
  const block = FULFILLER.slice(FULFILLER.indexOf('if (status === "ready" || status === "draft")'));
  assert.ok(block.length > 0, "ready/draft must be handled");
  assert.match(block.slice(0, 800), /NOT purchasable/);
  assert.doesNotMatch(block.slice(0, 800), /releaseAccount/, "must NOT free the account");
  assert.doesNotMatch(block.slice(0, 800), /status: "removed"/, "must NOT retire it");
});

test('"removed" is a value the schema actually allows', () => {
  // findOneAndUpdate skips validation, so the value landed in the DB fine — 33
  // rows carry it — and then every later doc.save() on one of those rows threw.
  // Exactly the AvailableAccount "spent" enum bug, which made 172 accounts
  // unsaveable.
  const model = read("models/MarketplaceListing.js");
  assert.match(model, /enum: \["active", "sold", "delisted", "error", "removed"\]/);
});

/* ============ 3. the self-undercut ratchet ============================== */

test("REGRESSION: pricing anchors on lowestOther, never on lowest", () => {
  const fn = LISTER.slice(
    LISTER.indexOf("function derivePrice("),
    LISTER.indexOf("/* ------------------------------- publishing"),
  );
  assert.match(fn, /Number\(gf\.lowestOther\)/, "must exclude our own listings");
  const code = fn.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(
    code,
    /Number\(gf\.lowest\)/,
    "gf.lowest includes our own rows — undercutting it undercuts ourselves",
  );
});

test("the pricer has a ceiling, not only a floor", () => {
  const fn = LISTER.slice(
    LISTER.indexOf("function derivePrice("),
    LISTER.indexOf("/* ------------------------------- publishing"),
  );
  assert.match(
    fn,
    /return Math\.min\(MAX_ANCHOR_USD, Math\.max\(0\.75, priced\)\)/,
    "the anchor cap does not bind the rival branch or survive the post-event multiplier",
  );
});

/* ============ 4. the arithmetic itself, executed ======================== */

function derivePrice() {
  // Lift the real function out with the constants it closes over, so the
  // behaviour is tested rather than the source text.
  const consts = LISTER.match(/const MIN_SOLD_SAMPLES = \d+;[\s\S]*?const MAX_ANCHOR_USD = \d+;/);
  const fn = LISTER.match(/function derivePrice\(research, \{[\s\S]*?\n\}/);
  const round25 = LISTER.match(/function round25\([\s\S]*?\n\}/);
  assert.ok(consts && fn && round25, "derivePrice, round25 and the constants should all exist");
  // eslint-disable-next-line no-new-func
  return new Function(`${round25[0]}\n${consts[0]}\n${fn[0]}\nreturn derivePrice;`)();
}

const price = derivePrice();
const research = (gf) => ({ markets: { gameflip: gf } });

test("our own cheap listing no longer drags the next price down", () => {
  // lowest is OUR $0.75 row; lowestOther is the real rival at $2.00.
  // Anchoring on lowest would give $0.71 -> floor $0.75. The rival gives $1.90.
  const p = price(research({ lowest: 0.75, lowestOther: 2.0, soldRecent: 0 }));
  assert.ok(p > 0.75, "expected a price above the floor, got " + p);
  assert.ok(p < 2.0, "should still undercut the real rival, got " + p);
});

test("when every live row is ours there is NO rival to undercut", () => {
  // lowestOther is deliberately 0 in that case. With proven sales, the sold
  // price must stand on its own rather than collapsing to the floor.
  const p = price(research({ lowest: 0.75, lowestOther: 0, soldRecent: 5, avgSoldPrice: 3.0 }));
  assert.strictEqual(p, 3.0, "proven sold price should stand alone, got " + p);
});

test("no signal at all still yields a sane price", () => {
  const p = price(research({}));
  assert.ok(p >= 0.75 && p <= 10, "got " + p);
});

test("the output is bounded above, even with the post-event markup", () => {
  // A rival-polluted average used to publish in double figures: the anchor cap
  // is applied before the multiplier, so it never bound the result.
  const p = price(research({ soldRecent: 9, avgSoldPrice: 40, lowestOther: 0 }), {
    postEventMultiplier: 1.5,
  });
  assert.ok(p <= 10, "expected a ceiling, got " + p);
});

test("the floor still holds", () => {
  const p = price(research({ lowestOther: 0.3, soldRecent: 0 }));
  assert.ok(p >= 0.75, "got " + p);
});

test("a real rival is still undercut", () => {
  const p = price(research({ lowestOther: 1.5, soldRecent: 5, avgSoldPrice: 4 }));
  assert.ok(p < 1.5, "should be cheaper than the rival, got " + p);
});
