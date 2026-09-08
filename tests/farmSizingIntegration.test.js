// Where coverage sizing meets the two engines. These are the tests that stop a
// sizing change breaking live farming.
//
// The load-bearing property throughout: WITH THE SWITCH OFF, NOTHING CHANGES.
// Coverage sizing ships off, so every one of these paths has to produce the
// number it produced before the feature existed.
const test = require("node:test");
const assert = require("node:assert/strict");

const autoFarmer = require("../utils/autoFarmer");
const settings = require("../utils/settings");
const farmSizing = require("../utils/farmSizing");
const budget = require("../utils/farm2/budget");
const fleet = require("../utils/noclaimFleet");
const allocator = require("../utils/unclaimedAllocator");
const routes = require("../routes/farmSizingRoutes");

const AF = { maxPerGame: 30, probeSize: 5 };
const sales = (count, avgPrice = 1.25) => ({ count, revenue: count * avgPrice, avgPrice });

// The sizing policy is read out of the auto-farm settings object the caller
// already holds, so a test builds one instead of writing to the live
// settings.json. That is the whole reason getFarmSizing takes an optional `af`.
const af = (overrides = {}) => ({ ...AF, ...overrides });
const COVERAGE_ON = {
  coverageSizing: true,
  coverageDays: 28,
  coverageSafetyStock: 6,
  coverageMaxPerGame: 250,
  gameAccountCaps: {},
};

// isNoClaimGame is the one accessor that genuinely has to read the live list,
// so the no-claim test swaps the exported reader.
function withNoClaimGames(list, fn) {
  const real = settings.getAutoFarm;
  const merged = { ...real(), noClaimGames: list };
  settings.getAutoFarm = () => merged;
  try {
    return fn();
  } finally {
    settings.getAutoFarm = real;
  }
}

// ---------------------------------------------------------------------------
// capForGame — the auto-farm ceiling
// ---------------------------------------------------------------------------

test("OFF: capForGame is byte-for-byte the old flat clamp", () => {
  const settingsOff = af({ coverageSizing: false, gameAccountCaps: {} });
  const legacy = (n) => Math.min(30 + Math.floor(n * 2), 60);
  for (const n of [0, 1, 5, 14, 15, 16, 50, 202]) {
    assert.equal(autoFarmer.capForGame(settingsOff, sales(n)), legacy(n), `sales=${n}`);
    // ...and passing a game changes nothing while the switch is off.
    assert.equal(
      autoFarmer.capForGame(settingsOff, sales(n), "Rocket League"),
      legacy(n),
      `sales=${n}`,
    );
  }
});

test("OFF: the flat clamp is exactly the bug — 15 sales and 202 sales both get 60", () => {
  const off = af({ coverageSizing: false, gameAccountCaps: {} });
  assert.equal(autoFarmer.capForGame(off, sales(15)), 60);
  assert.equal(autoFarmer.capForGame(off, sales(202)), 60);
});

test("ON: a proven seller's ceiling rises with what it actually sells", () => {
  const on = af(COVERAGE_ON);
  const mid = autoFarmer.capForGame(on, sales(15), "Some Game");
  const big = autoFarmer.capForGame(on, sales(202), "Overwatch");
  assert.ok(big > mid, `${big} should beat ${mid}`);
  assert.ok(big > 60, "the point is to clear the old flat ceiling");
  assert.ok(big <= 250, "and to stay under the configured maximum");
});

test("ON: the legacy cap is a FLOOR — switching on never shrinks a game", () => {
  const on = af(COVERAGE_ON);
  for (const n of [0, 1, 3, 15, 40, 202]) {
    const legacy = Math.min(30 + Math.floor(n * 2), 60);
    assert.ok(
      autoFarmer.capForGame(on, sales(n), "G") >= legacy,
      `sales=${n} went below the legacy cap`,
    );
  }
});

test("ON: coverageMaxPerGame is respected even for an absurd sell rate", () => {
  const on = af({
    coverageSizing: true,
    coverageDays: 365,
    coverageSafetyStock: 0,
    coverageMaxPerGame: 90,
    gameAccountCaps: {},
  });
  assert.equal(autoFarmer.capForGame(on, sales(99999), "G"), 90);
});

test("an explicit per-game cap overrides BOTH the legacy clamp and the model", () => {
  // The operator naming a number is the operator naming a number. It has to win
  // in both directions or the override is only half an override.
  assert.equal(
    autoFarmer.capForGame(
      af({ coverageSizing: false, gameAccountCaps: { "rocket league": 120 } }),
      sales(0),
      "Rocket League",
    ),
    120,
  );
  assert.equal(
    autoFarmer.capForGame(
      af({ ...COVERAGE_ON, gameAccountCaps: { "rocket league": 12 } }),
      sales(202),
      "Rocket League",
    ),
    12,
  );
});

test("a per-game cap is matched by substring, like every other per-game map", () => {
  const on = af({ coverageSizing: false, gameAccountCaps: { overwatch: 111 } });
  assert.equal(autoFarmer.capForGame(on, sales(0), "Overwatch 2"), 111);
  assert.equal(autoFarmer.capForGame(on, sales(0), "Overwatch"), 111);
  // ...and does not leak onto an unrelated game.
  assert.notEqual(autoFarmer.capForGame(on, sales(0), "Rocket League"), 111);
});

test("demandAllocation reaches the per-game ceiling through opts.game", () => {
  // The thread that makes any of this apply: without opts.game the allocation
  // silently falls back to the flat cap, which is what every caller got before.
  const on = af({ coverageSizing: false, gameAccountCaps: { overwatch: 200 } });
  const research = { scannedAt: new Date(), demandScore: 60 };
  const withGame = autoFarmer.demandAllocation(research, on, sales(5), { game: "Overwatch" });
  const without = autoFarmer.demandAllocation(research, on, sales(5));
  assert.equal(withGame.cap, 200);
  assert.equal(without.cap, 40);
});

test("a game with no sales is never handed headroom by the coverage model", () => {
  // 0 sales -> legacy cap of exactly maxPerGame, unchanged.
  assert.equal(autoFarmer.capForGame(af(COVERAGE_ON), sales(0), "Brand New Game"), 30);
});

// ---------------------------------------------------------------------------
// farm2's arbiter
// ---------------------------------------------------------------------------

test("the arbiter's per-game guard sits ABOVE the sales-boosted cap", () => {
  // The bug this pins: budget.js used the flat af.maxPerGame (30) as its
  // per-game draw cap while capForGame already allowed a proven seller 60, so a
  // lane that legitimately decided 60 was silently clamped to 30 and the sales
  // headroom was unreachable in the engine that now does all the deciding.
  const cycle = new budget.BudgetCycle({
    accounts: 500,
    seats: 500,
    containers: 10,
    perGameCap: 30,
  });
  assert.equal(cycle.remainingAccounts("clamped"), 30);

  const fixed = new budget.BudgetCycle({
    accounts: 500,
    seats: 500,
    containers: 10,
    perGameCap: 60,
  });
  assert.equal(fixed.remainingAccounts("free"), 60);
});

test("the arbiter's total invariant still holds with the raised per-game guard", () => {
  // Raising the per-game guard must not let the lanes collectively outspend the
  // cycle budget — that invariant is the only thing standing between concurrent
  // lanes and an over-drained pool.
  const cycle = new budget.BudgetCycle({
    accounts: 50,
    seats: 500,
    containers: 10,
    perGameCap: 250,
  });
  let spent = 0;
  for (const key of ["a", "b", "c", "d"]) spent += cycle.spendAccounts(key, 40);
  assert.equal(spent, 50);
});

// ---------------------------------------------------------------------------
// The settings whitelist
// ---------------------------------------------------------------------------

test("the settings validator reports unknown keys instead of dropping them", () => {
  const { patch, ignored, errors } = routes.validateSizingPatch({
    coverageDays: 21,
    somethingElse: 1,
  });
  assert.equal(patch.coverageDays, 21);
  assert.deepEqual(ignored, ["somethingElse"]);
  assert.equal(errors.length, 0);
});

test("out-of-range sizing values are refused, not clamped silently", () => {
  const { errors } = routes.validateSizingPatch({ coverageDays: 9999 });
  assert.equal(errors.length, 1);
  const bad = routes.validateSizingPatch({ coverageMaxPerGame: farmSizing.HARD_MAX_ACCOUNTS + 1 });
  assert.equal(bad.errors.length, 1);
});

test("per-game caps are normalised on the way in so two spellings cannot collide", () => {
  const { patch } = routes.validateSizingPatch({
    gameAccountCaps: { "Overwatch 2": 100, "  ROCKET league ": 50 },
  });
  assert.deepEqual(patch.gameAccountCaps, { "overwatch 2": 100, "rocket league": 50 });
});

test("a per-game cap of 0 is dropped, never stored as 'farm nothing'", () => {
  const { patch } = routes.validateSizingPatch({ gameAccountCaps: { overwatch: 0 } });
  assert.deepEqual(patch.gameAccountCaps, {});
});

test("a bogus field inside a per-game sizing override is reported by name", () => {
  const { errors } = routes.validateSizingPatch({
    noclaimGameSizing: { overwatch: { coverageDays: 21, nonsense: 3 } },
  });
  assert.ok(errors.some((e) => e.includes("nonsense")));
});

test("aliases resolve to their raw autoFarm keys", () => {
  const { patch } = routes.validateSizingPatch({ autoSize: true, enabled: true });
  assert.equal(patch.noclaimAutoSize, true);
  assert.equal(patch.coverageSizing, true);
});

// ---------------------------------------------------------------------------
// The no-claim fleet service
// ---------------------------------------------------------------------------

test("a no-claim bot can only be built for a game on the no-claim list", () => {
  // Without this, a typo built a container farming a game the AUTO-FARMER also
  // farms, and the two systems fight over the same campaign — the single thing
  // the no-claim split exists to prevent.
  withNoClaimGames(["overwatch", "rainbow six"], () => {
    assert.equal(fleet.assertNoClaimGame("Overwatch 2"), "Overwatch 2");
    assert.throws(() => fleet.assertNoClaimGame("Rocket League"), /not a no-claim game/);
    assert.throws(() => fleet.assertNoClaimGame(""), /Pick a game/);
  });
});

test("the config a top-up writes keeps ClaimDrops off and one entry per account", () => {
  const cfg = JSON.parse(
    fleet.buildConfig(
      [
        { username: "a", twitchId: "1", clientSecret: "s1" },
        { username: "b", twitchId: "2", clientSecret: "s2" },
      ],
      "Overwatch",
    ),
  );
  // ClaimDrops:false IS the no-claim farm. A true here silently converts the
  // whole fleet into ordinary farming and the stock stops being sellable.
  assert.equal(cfg.TwitchSettings.ClaimDrops, false);
  assert.equal(cfg.TwitchSettings.TwitchUsers.length, 2);
  assert.deepEqual(cfg.FavouriteGames, ["Overwatch"]);
  // Id must be the real numeric Twitch id — WatchRequest.GetPayload parses it as
  // an int, so a blank or placeholder makes the container watch nothing forever.
  assert.equal(cfg.TwitchSettings.TwitchUsers[0].Id, "1");
});

test("the ready-pool query never offers a hand-sold or tokenless account", () => {
  const q = fleet.readyPoolQuery("Overwatch");
  assert.equal(q.status, "available");
  assert.deepEqual(q.manualSold, { $ne: true });
  assert.deepEqual(q.clientSecret, { $gt: "" });
  // An account already spent on this game must never come back to farm it again.
  assert.ok(q.soldGames, "soldGames exclusion missing");
});

// ---------------------------------------------------------------------------
// The allocator's shelf-vs-fleet split
// ---------------------------------------------------------------------------

test("the allocator mirrors the unclaimed engine's default listing cap", () => {
  // The two are deliberately not imported across (that engine is 4,000 lines and
  // pulling it in to read one constant loads the whole listing stack), so this
  // test is what keeps them equal.
  const engineSource = require("fs").readFileSync(
    require.resolve("../utils/unclaimedAutoList.js"),
    "utf8",
  );
  const m = engineSource.match(/const GAME_CAP = (\d+)/);
  assert.ok(m, "GAME_CAP not found in the unclaimed engine");
  assert.equal(allocator.UNCLAIMED_DEFAULT_CAP, Number(m[1]));
});

test("the arbiter mirrors autoFarmer's SALES_CAP_MULT_MAX", () => {
  // Same reasoning: budget.js cannot require autoFarmer at module scope without
  // closing a require cycle, so it mirrors the constant and this pins the pair.
  const src = require("fs").readFileSync(require.resolve("../utils/autoFarmer.js"), "utf8");
  const m = src.match(/const SALES_CAP_MULT_MAX = (\d+)/);
  assert.ok(m, "SALES_CAP_MULT_MAX not found");
  const budgetSrc = require("fs").readFileSync(
    require.resolve("../utils/farm2/budget.js"),
    "utf8",
  );
  const m2 = budgetSrc.match(/const SALES_CAP_MULT_MAX_MIRROR = (\d+)/);
  assert.ok(m2, "mirror not found");
  assert.equal(m2[1], m[1]);
});

test("both sizing switches ship OFF", () => {
  // Asserted against the SHIPPED DEFAULT, not the live settings file. The first
  // version of this test read allocator.status(), which reflects whatever the
  // operator has configured — so it passed locally and failed the moment the
  // feature was enabled on prod. A test must not depend on operator config.
  const shipped = settings.getFarmSizing({});
  assert.equal(shipped.enabled, false, "coverageSizing must ship off");
  assert.equal(shipped.autoSize, false, "noclaimAutoSize must ship off");
  // And the defaults are still the ones the contract documents.
  assert.equal(shipped.coverageDays, 28);
  assert.equal(shipped.safetyStock, 6);
});

// ---------------------------------------------------------------------------
// The shelf lever
// ---------------------------------------------------------------------------

test("an operator's hand-set shelf cap is reported but never raised automatically", async () => {
  // `unclaimedGameCaps` is how the operator says "hold this game back".
  // Overwatch's cap of 28 exists because they hand-sell Overwatch in bulk from
  // the held pile — and the coverage model only sees AUTOMATED sales, so it
  // reads that deliberate hold as a shortage. Acting on it would have put ~170
  // accounts they wanted in hand onto Gameflip.
  const plan = {
    fleetKnown: true,
    games: [
      {
        key: "overwatch",
        label: "Overwatch",
        grant: 0,
        fleetNeed: 0,
        sales: { perWeek: 48 },
        shelf: { cap: 28, explicit: true, need: 171, suggested: 199 },
        fleet: { roomBots: [] },
      },
      {
        key: "rainbow six",
        label: "Rainbow Six",
        grant: 0,
        fleetNeed: 0,
        sales: { perWeek: 19 },
        shelf: { cap: 70, explicit: false, need: 13, suggested: 83 },
        fleet: { roomBots: [] },
      },
    ],
  };
  const out = await allocator.apply({ plan, dryRun: true });
  const ow = out.results.find((r) => r.key === "overwatch");
  const r6 = out.results.find((r) => r.key === "rainbow six");
  assert.equal(ow.shelf.applied, false);
  assert.ok(ow.shelf.blocked, "an explicit cap must say why it was left alone");
  // The un-set one is a plain default and is safe to raise.
  assert.equal(r6.shelf.applied, false); // dry run
  assert.equal(r6.shelf.blocked, undefined);
});

test("raiseExplicit is what unlocks a hand-set cap, and only in a real run", async () => {
  const plan = {
    fleetKnown: true,
    games: [
      {
        key: "overwatch",
        label: "Overwatch",
        grant: 0,
        fleetNeed: 0,
        sales: { perWeek: 48 },
        shelf: { cap: 28, explicit: true, need: 171, suggested: 199 },
        fleet: { roomBots: [] },
      },
    ],
  };
  const out = await allocator.apply({ plan, dryRun: true, raiseExplicit: true });
  assert.equal(out.results[0].shelf.blocked, undefined);
  assert.equal(out.results[0].shelf.to, 199);
});

test("a plan with an unknown fleet spends nothing at all", async () => {
  // Not knowing how many accounts a game already has is precisely the condition
  // under which "farm more" is dangerous, so the whole apply is refused.
  const out = await allocator.apply({
    plan: { fleetKnown: false, games: [{ key: "overwatch", grant: 50, fleetNeed: 50 }] },
    dryRun: false,
  });
  assert.ok(out.skipped);
  assert.deepEqual(out.results, []);
});

// ---------------------------------------------------------------------------
// The two defects a critical re-read of today's change found
// ---------------------------------------------------------------------------

test("backfill's ceiling is the game's own cap, not the flat fleet maximum", () => {
  // Backfill is where most of the pool actually goes (measured on prod: 140 of
  // 174 claims in a day). It used to clamp every task to
  // `maxPerGame * SALES_CAP_MULT_MAX` regardless of the game, which silently
  // overrode every per-game decision made upstream — so coverage sizing and the
  // operator's own gameAccountCaps could raise a DECISION and never move a
  // realised account count. Pinned by reading the source: the clamp must call
  // capForGame, not the flat product.
  const src = require("fs").readFileSync(require.resolve("../utils/autoFarmer.js"), "utf8");
  const backfill = src.slice(src.indexOf("async function backfillActiveTasks"));
  // Strip line comments first — this file EXPLAINS the old ceiling in prose
  // right above the new one, and a naive source scan matches the explanation.
  const body = backfill
    .slice(0, backfill.indexOf("\n}\n"))
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  assert.ok(
    /capForGame\(af, gameSales, task\.game\)/.test(body),
    "backfill must clamp to the per-game cap",
  );
  assert.ok(
    !/af\.maxPerGame \* SALES_CAP_MULT_MAX/.test(body),
    "backfill must not re-introduce the flat fleet ceiling",
  );
});

test("an anonymous unit sale is not collapsed by a login that defaults to empty-string", async () => {
  // SaleSignal.login is declared `default: ""` — an empty STRING, never null.
  // The first version of the demand union grouped on
  // `$ifNull: ["$login", <dedupeKey>]`, which passes "" straight through, so
  // every login-less quantity-listing unit sale on a game grouped under "" and
  // a hundred unit sales read as ONE. Digiseller and GGSel sell exactly that
  // way, so this under-counted the games that sell in bulk.
  const SaleSignal = require("../models/SaleSignal");
  assert.equal(
    SaleSignal.schema.path("login").defaultValue,
    "",
    "if this default ever becomes null, the $gt test below can go back to $ifNull",
  );
  const src = require("fs").readFileSync(require.resolve("../utils/farmDemand.js"), "utf8");
  assert.ok(
    /\$gt: \["\$login", ""\]/.test(src),
    "the grouping key must test for a non-empty login, not for null",
  );
  assert.ok(
    !/who: \{ \$ifNull: \["\$login"/.test(src),
    "the $ifNull grouping key must not come back",
  );
});

// ---------------------------------------------------------------------------
// The Albion trap: an empty reuse row must never become a reuse source
// ---------------------------------------------------------------------------

test("BOTH reuse-source selectors require the source to hold accounts", () => {
  // The trap, measured on prod 2026-09-08: a task written with bots and
  // assignedAccounts:[] became the next campaign's reuse source, that campaign
  // inherited zero and wrote another empty row with the same bots. Albion ran
  // at 60 accounts through 08-31 and then sat at 0 for 15 consecutive tasks
  // while three containers kept farming it — 450 drops in the last week, none
  // of it listable, because a task with no assigned accounts can never produce
  // a listing.
  //
  // There are TWO selectors and processCampaign prefers the MAP, so fixing only
  // the function would have left the live path broken. Both are pinned here.
  const src = require("fs").readFileSync(require.resolve("../utils/autoFarmer.js"), "utf8");

  const fn = src.slice(src.indexOf("async function reusableTaskForGame"));
  const fnBody = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(
    /"assignedAccounts\.0": \{ \$exists: true \}/.test(fnBody),
    "reusableTaskForGame must require the source to hold accounts",
  );

  const mapStart = src.indexOf("const reusableMap = new Map();");
  assert.ok(mapStart > 0, "the tick-level reusable map moved");
  const mapBody = src.slice(mapStart, mapStart + 900);
  assert.ok(
    /\(task\.assignedAccounts \|\| \[\]\)\.length > 0/.test(mapBody),
    "the tick-level reusableMap must apply the same rule as reusableTaskForGame",
  );
});

test("every allocator pass leaves a trace, including the passes that do nothing", () => {
  // The observability hole this closes: an idle pass writes no SystemEvent,
  // sends no Telegram and touches no row, so "running fine and finding nothing
  // to do" and "never started" were indistinguishable from outside the process
  // — `status().lastRun` only helps a caller inside the same one. That is the
  // same failure mode as the misleading "0 accounts" Telegram line.
  const src = require("fs").readFileSync(
    require.resolve("../utils/unclaimedAllocator.js"),
    "utf8",
  );
  const fn = src.slice(src.indexOf("async function runOnce"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  // The heartbeat must be emitted BEFORE the autoSize early-return, or advisory
  // mode — the shipped default — would stay silent.
  const beat = body.indexOf('console.log(\n      "unclaimedAllocator: "');
  const earlyReturn = body.indexOf("if (!cfg.autoSize && !force) return");
  assert.ok(beat > 0, "runOnce must log a heartbeat");
  assert.ok(
    beat < earlyReturn,
    "the heartbeat must come before the advisory-mode early return",
  );
});
