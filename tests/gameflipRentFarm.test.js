// The Gameflip buffered rent-farm service, and the six defects an adversarial
// review found in it before it ever ran.
//
// This is new code that publishes real listings against real pristine pool
// accounts and hands them to buyers, so the tests are written around the ways it
// can take money it cannot honour rather than around its happy path.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const SVC = read("utils/gameflipFarmService.js");
const FULFILLER = read("utils/gameflipFulfiller.js");
const HEALTH = read("utils/systemHealth.js");
const MODEL = read("models/MarketplaceListing.js");

const svc = require("../utils/gameflipFarmService");

/* ================= 1. the window starts at the SALE ==================== */
//
// The one correctness rule of the whole feature. An offer can sit in the buffer
// for weeks; if the window started at publish, a buyer of a 1 Year term whose
// offer had waited 30 days would receive 335 days for a 365-day purchase.

test("REGRESSION: the sale claim does NOT destroy the pool id", () => {
  // It used to claim by clearing rentFarmPoolId — erasing the only pointer to
  // the account BEFORE the work. A transient Atlas rejection on either of the
  // two awaits that follow then left farmUntil at publish + 365, unretryable
  // (the $nin filter misses on a second pass) and unfixable by hand (the pool id
  // was gone).
  const fn = SVC.slice(SVC.indexOf("async function onBufferedSale("));
  const claim = fn.slice(0, fn.indexOf("const poolId ="));
  assert.match(claim, /rentFarmSaleClaimedAt: new Date\(\)/, "the claim must be a lease");
  assert.doesNotMatch(
    claim,
    /\$set: \{ status: "sold", rentFarmPoolId: "" \}/,
    "the claim must not erase the recovery key",
  );
});

test("the pool id is released only AFTER the window is stamped", () => {
  const fn = SVC.slice(SVC.indexOf("async function onBufferedSale("));
  const stamp = fn.indexOf("restampWindow(creds.clientSecret, days)");
  const clear = fn.indexOf('rentFarmPoolId: ""');
  assert.ok(stamp > 0 && clear > 0, "both should be present");
  assert.ok(clear > stamp, "clearing the pointer before stamping makes the sale unrecoverable");
});

test("both awaits between claim and stamp are caught", () => {
  // An escape propagates into the fulfiller's sold lane, which catches it into a
  // bare console.error: no Telegram, no lastError, and a buyer short of the term
  // they paid for.
  const fn = SVC.slice(SVC.indexOf("async function onBufferedSale("));
  const seg = fn.slice(0, fn.indexOf("// 2. The record"));
  assert.match(seg, /try \{\s*\n\s*creds = await poolCredentials\(poolId\);/);
  assert.match(seg, /try \{\s*\n\s*stamped = await restampWindow\(/);
  // Both catch blocks must route into fail(), which records AND alerts AND
  // leaves the row retryable — not just swallow.
  const catches = seg.match(/\} catch \(e\) \{[\s\S]{0,400}?return fail\(/g) || [];
  assert.ok(catches.length >= 2, "expected both awaits to route into fail(), got " + catches.length);
});

test("a failed sale stays retryable — the lease is never cleared by fail()", () => {
  const fn = SVC.slice(SVC.indexOf("async function onBufferedSale("));
  const failFn = fn.slice(fn.indexOf("const fail = async (reason)"), fn.indexOf("if (!days)"));
  assert.match(failFn, /lastError/, "a failure must be recorded on the row");
  assert.doesNotMatch(
    failFn,
    /rentFarmSaleClaimedAt: null/,
    "clearing the lease on failure would let a second pass race the first",
  );
  assert.doesNotMatch(failFn, /rentFarmPoolId: ""/, "the recovery key must survive a failure");
});

test("the window is written as an absolute date, never an adjustment", () => {
  // now + days. An adjustment ("subtract the buffered time") would compound
  // across a retry and is unrecoverable if it runs twice.
  const fn = SVC.slice(SVC.indexOf("async function restampWindow("));
  assert.match(fn.slice(0, 900), /Date\.now\(\) \+ /);
});

/* ============ 2. a failed publish must not strand an account =========== */

test("REGRESSION: a RETURNED hand-back failure is as loud as a thrown one", () => {
  // handBackToPool reports its likeliest failures by RETURNING {ok:false} —
  // pool row gone, renter re-homed, host unknown, Pi mid-link-timeout. Every
  // call site used `.catch(() => {})`, which catches only a throw. The account
  // then stayed claimed, on a bot, holding a rental slot, with NO listing row
  // naming it — unfindable, and lost for good at day 365.
  assert.match(SVC, /async function handBackOrAlert\(poolId, note, ctx = \{\}\)/);
  assert.match(SVC, /if \(out && out\.ok\) return out;/);
  const fn = SVC.slice(SVC.indexOf("async function handBackOrAlert("));
  assert.match(fn.slice(0, 1800), /alertFarmFailure\(/, "a stranded account must page a human");
});

test("no call site fires hand-back and forgets the answer", () => {
  // Strip comments first: this file DOCUMENTS the old broken form at length, and
  // an assertion that cannot tell prose from code fails on its own explanation.
  const code = SVC.split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  const bad = code.match(/handBackToPool\([^)]*\)\.catch\(\(\) => \{\}\)/g) || [];
  assert.strictEqual(
    bad.length,
    0,
    "found " + bad.length + " fire-and-forget hand-back(s): " + bad.join(" | "),
  );
  // The one direct caller that remains must USE the answer, not just hold it.
  assert.match(code, /if \(!back\.ok\) \{/, "releaseBuffered must act on a failed hand-back");
  assert.match(code, /rentFarmPoolId: poolId,/, "and restore the pointer so nothing is stranded");
});

test("the orphan-listing message does not claim the account came back", () => {
  // `delisted` is a fact about the LISTING. The message asserted the ACCOUNT had
  // returned on the strength of it, and skipped the alert on the same basis.
  const at = SVC.indexOf("const accountBack =");
  assert.ok(at > 0, "the account fact must be derived from the hand-back result");
  const seg = SVC.slice(at, at + 1600);
  assert.match(seg, /accountBack\n?\s*\? "The account is back in the pool\."/);
  assert.match(seg, /if \(!delisted \|\| !accountBack\)/, "either failure must alert");
});

/* ================= 3. the buffer must actually run ===================== */

test("REGRESSION: something calls topUpBuffer", () => {
  // Nothing did. The service was inert, defaulted to dry run, and the health
  // check reported ok over a permanently empty shelf.
  assert.match(FULFILLER, /await gfFarm\.topUpBuffer\(\)/, "the buffer must be scheduled");
  assert.match(FULFILLER, /const BUFFER_TICK_MS = /);
});

test("the buffer runs on a slower clock than sale detection", () => {
  // Both share one rate limiter. A buyer who has already paid is time-critical;
  // restocking a shelf is not.
  const tick = Number((FULFILLER.match(/const TICK_MS = (\d+) \* 1000;/) || [])[1]);
  const buf = FULFILLER.match(/const BUFFER_TICK_MS = (\d+) \* (\d+) \* 1000;/);
  assert.ok(tick > 0 && buf, "both clocks should be declared");
  assert.ok(Number(buf[1]) * Number(buf[2]) > tick, "the buffer must tick slower");
});

test("dryRun is exposed, so the tracker cannot show green while nothing publishes", () => {
  assert.match(SVC, /dryRun:\s*\n?\s*cfg\.af && cfg\.af\.gfBufferDryRun !== undefined/);
});

test("the service is OFF and dry-run by default", () => {
  // A new subsystem that publishes real listings against real pool accounts does
  // not turn itself on because it was deployed.
  const cfg = svc.config();
  assert.strictEqual(cfg.enabled, false, "gameflipRentFarm must default off");
  assert.match(SVC, /gfBufferDryRun !== false/, "dry run must be the default");
});

/* ============ 4. a verdict needs a measurement ========================= */

test("REGRESSION: bufferState records which joins it could not read", () => {
  // It swallowed failures into [] so the tracker still rendered — and the health
  // check then reported a critical failure over data nobody had measured: one
  // Atlas timeout on the pool read makes EVERY live offer look like a dead
  // account.
  assert.match(SVC, /unreadable: \[\],/, "the state must carry the failures");
  const pushes = SVC.match(/state\.unreadable\.push\(/g) || [];
  assert.ok(pushes.length >= 3, "expected all three joins to report, got " + pushes.length);
});

test("the health check goes unknown when a join it depends on failed", () => {
  const chk = HEALTH.slice(HEALTH.indexOf('id: "gameflip.rentfarm"'));
  assert.match(chk.slice(0, 6000), /const unreadable = Array\.isArray\(state\.unreadable\)/);
  const at = chk.indexOf("if (unreadable.length) {");
  assert.ok(at > 0, "the guard must exist");
  assert.match(chk.slice(at, at + 400), /status: "unknown"/);
});

test("the check reports a shelf that is short and not filling", () => {
  // floorHit and shortUnexplained were the only short-buffer findings, so dry
  // run, never-ran, a stopped pass and an empty pool were all invisible — and
  // the check answered ok over 0 live of 100.
  const chk = HEALTH.slice(HEALTH.indexOf('id: "gameflip.rentfarm"'));
  assert.match(chk, /const idleReasons = \[\];/);
  assert.match(chk, /DRY RUN/);
  assert.match(chk, /no top-up pass has run yet/);
  assert.match(chk, /idleUnexplained/);
});

/* ============ 5. the model carries what recovery needs ================= */

test("the lease field exists on the schema", () => {
  assert.match(MODEL, /rentFarmSaleClaimedAt: \{ type: Date, default: null \}/);
  assert.match(MODEL, /rentFarm: \{ type: Boolean, default: false, index: true \}/);
});

/* ============ 6. pure helpers, executed ================================ */

test("slotKey distinguishes game AND term", () => {
  const a = svc.slotKey("Rust", 120);
  const b = svc.slotKey("Rust", 180);
  const c = svc.slotKey("Fortnite", 120);
  assert.notStrictEqual(a, b, "the same game at two terms is two different slots");
  assert.notStrictEqual(a, c);
  assert.strictEqual(a, svc.slotKey("Rust", 120), "and it is stable");
});

test("the term ladder is priced above Eldorado", () => {
  // Eldorado runs $3/$4/$7. The only hard evidence of Gameflip rent-farm demand
  // is a 180-day offer that SOLD at $5 there while Eldorado's was $4, so
  // Gameflip bears a premium — our realised price is proof, a rival's asking
  // price is not.
  const byDays = Object.fromEntries(svc.TERMS.map((t) => [t.days, t.priceUsd]));
  assert.ok(byDays[120] > 3, "120d should beat Eldorado's $3, got " + byDays[120]);
  assert.ok(byDays[180] > 4, "180d should beat Eldorado's $4, got " + byDays[180]);
  assert.ok(byDays[365] > 7, "1y should beat Eldorado's $7, got " + byDays[365]);
});

test("every term has a positive window and a positive price", () => {
  for (const t of svc.TERMS) {
    assert.ok(t.days > 0, "a term with no days cannot start a window");
    assert.ok(t.priceUsd > 0, "a free listing is not a listing");
  }
});

test("the buffered placeholder window outlasts every sellable term", () => {
  // A buffered account must never be reclaimed by renterExpiry while its offer
  // is live — that would sell a dead account.
  const longest = Math.max(...svc.TERMS.map((t) => t.days));
  assert.ok(
    svc.BUFFER_WINDOW_DAYS >= longest,
    "placeholder " + svc.BUFFER_WINDOW_DAYS + "d must cover the longest term " + longest + "d",
  );
});
