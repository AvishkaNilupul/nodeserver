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

/* ============ 5. a 200 from a rate-limited API is not a live listing ===== */
//
// Under its rate limiter Gameflip answers 200 to a status patch and leaves the
// listing in "ready" — complete, public, NOT purchasable. Every status restore
// in utils/marketplaces.js already refuses to trust that 200 and reads back.
// gameflipPublish was the one path that did not, so a rate-limited publish
// returned success, the caller wrote an "active" row with an account attached,
// the chain counted a unit discharged, and nobody could buy it.

const MP = read("utils/marketplaces.js");

test("REGRESSION: publish verifies the onsale patch by reading it back", () => {
  const fn = MP.slice(
    MP.indexOf("async function gameflipPublish("),
    MP.indexOf("// Current status of a listing"),
  );
  assert.match(fn, /gameflipListingStatus\(listingId\)\) === "onsale"/,
    "must confirm the listing is really on sale");
  assert.match(fn, /status settled on "ready" instead of "onsale"/);
});

test("publish backs off in TENS OF SECONDS, not milliseconds", () => {
  // The limiter's window is minutes wide (429 "Too many attempts"), so a
  // millisecond retry just burns the budget it is waiting on.
  const fn = MP.slice(
    MP.indexOf("async function gameflipPublish("),
    MP.indexOf("// Current status of a listing"),
  );
  assert.match(fn, /for \(const w of \[0, 20000, 60000\]\)/);
});

test("a publish that never goes on sale discards the draft", () => {
  // The credentials are already attached, so leaving it behind is invisible
  // stock AND makes the next attempt fail with "code for digital goods already
  // exists" — the same reason the digital-goods failure path bins its draft.
  const fn = MP.slice(
    MP.indexOf("async function gameflipPublish("),
    MP.indexOf("// Current status of a listing"),
  );
  const at = fn.indexOf("if (!onsale)");
  assert.ok(at > 0, "the failure branch should exist");
  assert.match(fn.slice(at, at + 700), /\.delete\(GF_API \+ "\/listing\/" \+ listingId/);
  assert.match(fn.slice(at, at + 900), /draft discarded/);
});

/* ============ 6. "ready" is a stuck state, not a parked one ============= */

test("REGRESSION: the reprice fast path puts a READY listing back on sale", () => {
  const fn = MP.slice(
    MP.indexOf('const live = await gfReadStatusOrThrow(listingId, "Gameflip reprice");'),
    MP.indexOf('await gfTakeOffSale(listingId, setStatus, "Gameflip reprice");'),
  );
  assert.match(fn, /if \(live === "ready"\)/, "ready must be restored");
  assert.match(fn, /gameflipListingStatus\(listingId\)\) === "onsale"/, "and verified");
  assert.match(fn, /NOT purchasable/);
});

test("a DRAFT listing is still left alone", () => {
  // Somebody parked it deliberately. Putting it on sale would override them —
  // the opposite mistake to the one above, and just as bad.
  const fn = MP.slice(
    MP.indexOf('const live = await gfReadStatusOrThrow(listingId, "Gameflip reprice");'),
    MP.indexOf('await gfTakeOffSale(listingId, setStatus, "Gameflip reprice");'),
  );
  assert.doesNotMatch(fn, /if \(live === "draft"\)[\s\S]{0,200}setStatus\("onsale"\)/);
  assert.match(fn, /deliberately parked/);
});

/* ============ 7. the post-event markup is not lost mid-relist =========== */

test("REGRESSION: postEvent waits while a relist is genuinely pending", () => {
  const at = LISTER.indexOf("let relistPending = false;");
  assert.ok(at > 0, "the deferral should exist");
  const block = LISTER.slice(at, at + 900);
  assert.match(block, /status: "sold"/);
  assert.match(block, /qtyRemaining: \{ \$gt: 0 \}/, "a chain still owing units");
  assert.match(block, /POST_EVENT_RELIST_GRACE_MS/, "bounded, so the queue still drains");
  assert.match(LISTER, /task\.listing\.postEvent = !relistPending;/);
});

test("the deferral is bounded, so a dead chain cannot hold the queue", () => {
  // autoFarmer.repriceEndedTasks filters on this flag and its own comment says
  // the unconditional set exists "so this queue always drains rather than
  // spinning on dead listings". The recency bound is what keeps that true.
  assert.match(LISTER, /const POST_EVENT_RELIST_GRACE_MS = 24 \* 60 \* 60 \* 1000;/);
  const farmer = read("utils/autoFarmer.js");
  assert.match(farmer, /"listing\.postEvent": \{ \$ne: true \}/,
    "the queue still filters on the flag this protects");
});

/* ============ 8. the degraded lane must not starve the same tail ======== */

test("REGRESSION: the fallback window rotates instead of always taking the front", () => {
  // `rows` is an unsorted find, so natural order is stable — slicing the first N
  // every pass means the tail beyond N is polled on NO pass at all, for as long
  // as the bulk sweep is down. That is the same `.limit(100)` bug the file
  // documents at length for the bulk path, moved into the degraded one.
  assert.match(FULFILLER, /let fallbackCursor = 0;/);
  assert.match(FULFILLER, /fallbackCursor = \(start \+ FALLBACK_POLL_LIMIT\) % rows\.length;/);
  const block = FULFILLER.slice(FULFILLER.indexOf("let due = rows;"));
  assert.match(block.slice(0, 700), /rows\.slice\(start, start \+ FALLBACK_POLL_LIMIT\)/);
  assert.doesNotMatch(
    block.slice(0, 700),
    /rows\.slice\(0, FALLBACK_POLL_LIMIT\)(?!\s*-)/,
    "must not slice from the front",
  );
});

test("the rotating window covers the whole fleet, with no gaps or repeats", () => {
  // Executed, not read: the wrap-around is the part that is easy to get wrong.
  const LIMIT = 100;
  const rows = Array.from({ length: 238 }, (_, i) => i);
  let cursor = 0;
  const seen = new Set();
  for (let pass = 0; pass < 3; pass += 1) {
    const start = cursor % rows.length;
    let due = rows.slice(start, start + LIMIT);
    if (due.length < LIMIT) due = due.concat(rows.slice(0, LIMIT - due.length));
    assert.strictEqual(due.length, LIMIT, "every pass polls a full window");
    for (const r of due) seen.add(r);
    cursor = (start + LIMIT) % rows.length;
  }
  assert.strictEqual(seen.size, rows.length, "3 passes of 100 should cover all 238");
});

/* ============ 9. one debt must not be relisted twice =================== */

test("REGRESSION: the stalled-relist lane claims its row atomically", () => {
  const lane = FULFILLER.slice(FULFILLER.indexOf("const stalled = await MarketplaceListing.find("));
  assert.match(lane, /const claimed = await MarketplaceListing\.findOneAndUpdate\(/);
  assert.match(lane, /if \(!claimed\) continue;/);
  // The claim must be on the very field the `stalled` query filters on, or a
  // concurrent pass would still see the row.
  assert.match(lane, /relistRetryAt: new Date\(Date\.now\(\) \+ RELIST_LEASE_MS\)/);
});

test("the claim comes BEFORE the publish, not after", () => {
  const lane = FULFILLER.slice(FULFILLER.indexOf("const stalled = await MarketplaceListing.find("));
  const claim = lane.indexOf("const claimed = await MarketplaceListing.findOneAndUpdate(");
  const publish = lane.indexOf("await publishAutoDelivery({");
  assert.ok(claim > 0 && publish > 0, "both should be present");
  assert.ok(claim < publish, "claiming after publishing protects nothing");
});

test("the lease outlasts a rate-limited publish", () => {
  // gameflipPublish now backs off 0/20s/60s before giving up, on a 60s tick.
  assert.match(FULFILLER, /const RELIST_LEASE_MS = 10 \* 60 \* 1000;/);
});
