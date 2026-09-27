// The health engine — the page that exists so nobody has to check by hand.
//
// It was built after 2026-09-08, when the rental stack sat at 10/10 for nine
// hours and two paid "Automatic Farming" orders landed inside that window: one
// the owner shipped by hand, one the buyer cancelled after 25 failed attempts.
// Every dial read fine throughout (554 eligible pool accounts, `willAdd: 1`).
//
// So the thing under test here is not "does it go green". It is:
//   - does every check hand back the NUMBER it measured and the THRESHOLD it
//     compared against, because a bare green tick is exactly what we already
//     had when the orders were lost;
//   - does a check that COULD NOT RUN say `unknown` rather than inventing a
//     verdict — an unreachable Pi is a read failure, and reading one as a
//     marketplace fault already produced one wrong diagnosis here;
//   - does one broken check leave the other nine answers intact;
//   - and does it stay quiet about the things that are FINE, because a monitor
//     that cries wolf is a monitor nobody opens twice.
//
// Everything runs against injected dependencies: no database, no network, no
// marketplace. That is a hard requirement, not a convenience — a previous
// mass-parallel session against prod is suspected of disturbing a live order.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const health = require("../utils/systemHealth");
const rentFarm = require("../utils/rentFarmCapacity");

/* ========================================================================== *
 * A model fake good enough to be honest
 * ========================================================================== */

// The checks push their filtering DOWN into the query — `listings.overpriced`
// only ever SEES rows already above the ceiling, `orders.undelivered` only rows
// already past their grace. A fake that ignored the query would therefore test a
// different function from the one that runs on prod, and would happily pass a
// check whose filter was wrong.
//
// So this matcher understands exactly the operators the checks use today and
// THROWS on anything else: if a query grows a `$regex` or an `$elemMatch`, this
// file fails loudly here instead of silently matching every row and turning a
// real assertion into decoration.
function fieldValue(row, key) {
  if (!key.includes(".")) return row[key];
  return key
    .split(".")
    .reduce((v, part) => (v == null ? undefined : v[part]), row);
}

// NaN means "not comparable", which is how Mongo treats a missing field in a
// range query: it does not match, rather than sorting before everything.
function cmp(a, b) {
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (av == null || bv == null) return NaN;
  if (av === bv) return 0;
  return av < bv ? -1 : 1;
}

function eq(value, want) {
  if (want instanceof RegExp) return want.test(String(value == null ? "" : value));
  if (value instanceof Date || want instanceof Date) return cmp(value, want) === 0;
  // A missing field and an explicit null are the same thing to Mongo, and the
  // checks rely on it: `deliveredAt: null` has to match an order that has never
  // carried the field at all.
  return (value === undefined ? null : value) === (want === undefined ? null : want);
}

function matchOne(value, cond) {
  const isOperatorDoc =
    cond !== null &&
    typeof cond === "object" &&
    !(cond instanceof RegExp) &&
    !(cond instanceof Date) &&
    !Array.isArray(cond) &&
    Object.keys(cond).every((k) => k.startsWith("$"));
  if (!isOperatorDoc) return eq(value, cond);
  for (const [op, want] of Object.entries(cond)) {
    switch (op) {
      case "$ne":
        if (eq(value, want)) return false;
        break;
      // `$nin` arrived with the "cancelled" order state: a cancelled order is
      // terminal like a delivered one, so orders.undelivered excludes both.
      case "$nin":
        if ((want || []).some((w) => eq(value, w))) return false;
        break;
      case "$gt":
        if (!(cmp(value, want) > 0)) return false;
        break;
      case "$gte":
        if (!(cmp(value, want) >= 0)) return false;
        break;
      case "$lt":
        if (!(cmp(value, want) < 0)) return false;
        break;
      case "$lte":
        if (!(cmp(value, want) <= 0)) return false;
        break;
      case "$in":
        if (!want.some((w) => eq(value, w))) return false;
        break;
      case "$exists":
        if ((value !== undefined) !== Boolean(want)) return false;
        break;
      default:
        throw new Error("model fake: unsupported operator " + op);
    }
  }
  return true;
}

function matches(row, query) {
  for (const [key, cond] of Object.entries(query || {})) {
    if (key === "$or") {
      if (!cond.some((q) => matches(row, q))) return false;
      continue;
    }
    if (key.startsWith("$")) {
      throw new Error("model fake: unsupported top-level " + key);
    }
    if (!matchOne(fieldValue(row, key), cond)) return false;
  }
  return true;
}

// Every read in the engine ends in `.lean()`, so only that resolves.
function cursor(rows, single) {
  let out = rows;
  const api = {
    sort(spec) {
      const [field, dir] = Object.entries(spec || {})[0] || ["_id", 1];
      out = out.slice().sort((a, b) => {
        const c = cmp(fieldValue(a, field), fieldValue(b, field));
        return (Number.isNaN(c) ? 0 : c) * (Number(dir) < 0 ? -1 : 1);
      });
      return api;
    },
    limit(n) {
      out = out.slice(0, n);
      return api;
    },
    async lean() {
      return single ? out[0] || null : out;
    },
  };
  return api;
}

function fakeModel(rows = []) {
  return {
    async countDocuments(query) {
      return rows.filter((r) => matches(r, query)).length;
    },
    find(query) {
      return cursor(rows.filter((r) => matches(r, query)), false);
    },
    findOne(query) {
      return cursor(rows.filter((r) => matches(r, query)), true);
    },
  };
}

// A dependency that blows up the moment a check touches it. Used to prove one
// broken check cannot take the hourly run down.
function explodingModel(message) {
  const boom = () => {
    throw new Error(message);
  };
  return { countDocuments: boom, find: boom, findOne: boom };
}

/* ========================================================================== *
 * Fixtures
 * ========================================================================== */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
// Pinned so age comparisons cannot go flaky on a slow machine.
const NOW = new Date("2026-09-09T12:00:00.000Z");
const now = () => NOW;
const ago = (ms) => new Date(NOW.getTime() - ms);

const listing = (over = {}) => ({
  status: "active",
  marketplace: "gameflip",
  externalId: "gf-" + Math.random().toString(36).slice(2, 8),
  title: "Overwatch Twitch Drops (6 Items)",
  price: 1.25,
  origin: "auto",
  units: [],
  ...over,
});

// The rent-farm stack shape utils/rentFarmCapacity.snapshot() returns. levelFor
// and LOW_WATER are the REAL ones on purpose: the check's whole design claim is
// that the page and the Telegram alert cannot disagree because they share one
// function, and a fake threshold here would quietly retire that claim.
function fakeCapacity({ stacks = [], offlineHosts = [] } = {}) {
  const rows = stacks.map((s) => ({
    host: s.host || "pi",
    file: s.file || "config_31.json",
    used: s.used || 0,
    capacity: s.capacity || 0,
    remaining: Math.max(0, s.remaining == null ? s.capacity - s.used : s.remaining),
  }));
  return {
    LOW_WATER: rentFarm.LOW_WATER,
    levelFor: rentFarm.levelFor,
    async snapshot() {
      return {
        stacks: rows,
        offlineHosts,
        totalFree: rows.reduce((n, s) => n + s.remaining, 0),
        totalCapacity: rows.reduce((n, s) => n + s.capacity, 0),
        readable: rows.length,
      };
    },
  };
}

// A whole-system fixture in which nothing is on fire, so a test can change one
// thing and be sure the verdict came from that thing.
// A connector group that answers instantly and touches nothing. Without this the
// engine reaches for the REAL utils/systemHealthConnectors, which makes live
// authentication calls to eight marketplaces — a unit test must never do that,
// and the 10s-per-check timeout made it look like a hang rather than a mistake.
function fakeConnectors(rows = []) {
  return { async connectorChecks() { return rows; } };
}

function healthyDeps(over = {}) {
  const pool = Array.from({ length: 768 }, (_, i) => ({
    status: "available",
    clientSecret: i < 100 ? "" : "sec" + i,
    hasPassword: true,
    lastCheckAt: ago(2 * HOUR),
  }));
  const ledger = [
    {
      source: "noclaim",
      game: "Overwatch 2",
      status: "released",
      soldAt: null,
      login: "ow-acct-1",
      drops: [{ name: "Esports Loot Box" }],
      lastCheckedAt: ago(12 * MIN),
    },
  ];
  const listings = [
    listing({ externalId: "gf-live-1" }),
    listing({
      marketplace: "eldorado",
      externalId: "eld-farm-1",
      title: "Rainbow Six Siege Twitch Drops Automatic Farming 180 days",
      price: 5.99,
    }),
    listing({
      marketplace: "eldorado",
      externalId: "eld-bundle-1",
      title: "Overwatch Twitch Drops (10 Items)",
      unclaimedGame: "Overwatch 2",
      requiredDrops: [{ name: "Esports Loot Box", qty: 1 }],
    }),
  ];
  return {
    connectors: fakeConnectors(),
    FarmServiceOrder: fakeModel([]),
    MarketplaceListing: fakeModel(listings),
    UnclaimedAccount: fakeModel(ledger),
    AvailableAccount: fakeModel(pool),
    FleetSnapshot: fakeModel([{ at: ago(15 * MIN) }]),
    AutoFarmSnapshot: fakeModel([{ key: "auto-farm", builtAt: ago(2 * MIN) }]),
    BotAccount: fakeModel([{ lastScanAt: ago(30 * MIN) }]),
    rentFarmCapacity: fakeCapacity({
      stacks: [{ host: "pi", capacity: 150, used: 13, remaining: 137 }],
    }),
    // accountCoverage reads DropLog, so the coverage gate is faked whole rather
    // than half-injected. tests/unclaimedCoverage.test.js owns its behaviour;
    // what matters here is that this check DELEGATES to it.
    unclaimedCoverage: {
      listingRequirements: (l) => new Map((l.requiredDrops || []).map((d) => [d.name, d.qty || 1])),
      partitionByCoverage: (rows) => ({ covering: rows, short: [] }),
      // liveCoverage is what the check MUST call: accountCoverage is the DB
      // union (ledger drops[] u DropLog) and both survive a wave's expiry, so
      // judging "is anything selling expired drops?" on them is blind by
      // construction. accountCoverage is left here deliberately returning a
      // PASS, so a regression back to it shows up as a green check rather than
      // an error — exactly how the defect originally hid.
      accountCoverage: async () => ({ ok: true, degraded: false }),
      liveCoverage: async () => ({ ok: true, degraded: false, source: "live" }),
      shortfallSummary: () => "",
    },
    unclaimedListingAudit: {
      gameFilter: (g) => new RegExp(String(g).split(" ")[0], "i"),
      SELLABLE_STATUSES: ["released", "skipped"],
    },
    unclaimedAutoList: { TICK_MS: 10 * MIN },
    marketplaces: {
      async gameflipListingIdsByStatus() {
        return new Set(["gf-live-1"]);
      },
      async gameflipListingStatus() {
        return "onsale";
      },
      // listings.untracked reads GGSel's OWN offer list. The healthy fixture
      // has no live GGSel offer beyond what the rows cover, so an empty list is
      // the honest "nothing untracked" — not a stand-in for an unread API.
      async ggselAllOffers() {
        return [];
      },
    },
    settings: {
      getAutoFarm: () => ({ unclaimedAutoList: true, unclaimedAutoListPaused: false }),
    },
    // listings.venuePrice builds one ceiling per marketplace from realised
    // sales. Gameflip's fixture rows sit under a $5.00 max, so the healthy
    // fixture must not trip it; ggsel is present but under MIN_VENUE_SALES, to
    // pin the rule that an unmeasured venue is skipped rather than judged.
    pricingEvidence: {
      async snapshot() {
        return {
          platform: new Map([
            ["gameflip", [0.75, 1.25, 1.25, 1.5, 2.0, 5.0]],
            ["ggsel", [0.75, 0.75]],
          ]),
        };
      },
    },
    gatherPoolEligibility: async () => ({
      eligible: Array.from({ length: 364 }, (_, i) => ({ username: "p" + i })),
    }),
    ...over,
  };
}

// Run one check and hand back just its row.
async function runCheck(id, deps, opts = {}) {
  const run = await health.runAll({ only: [id], deps, now, ...opts });
  assert.strictEqual(run.checks.length, 1, "expected exactly one check for " + id);
  return run.checks[0];
}

/* ========================================================================== *
 * Worst-of and the counts
 * ========================================================================== */

test("the worst status in a group is the one the card shows", () => {
  assert.strictEqual(health.worstStatus(["ok", "ok"]), "ok");
  assert.strictEqual(health.worstStatus(["ok", "warn"]), "warn");
  assert.strictEqual(health.worstStatus(["warn", "fail"]), "fail");
  assert.strictEqual(health.worstStatus(["fail", "ok", "unknown"]), "fail");
  // Checks, not just strings — the page colours a card from the check objects
  // it already has, and a second definition of "worst" is how two screens start
  // disagreeing about the same run.
  assert.strictEqual(
    health.worstStatus([{ status: "ok" }, { status: "warn" }]),
    "warn",
  );
});

test("`unknown` darkens a green card but never outranks a real problem", () => {
  // This is the rule the whole page turns on. "We could not measure this" must
  // not read as ok — that is the bare green tick that cost two orders — and it
  // must not read as worse than a fail sitting next to it either, or a Pi
  // hiccup would outrank a marketplace that is genuinely down.
  assert.strictEqual(health.worstStatus(["ok", "unknown"]), "unknown");
  assert.notStrictEqual(health.worstStatus(["ok", "unknown"]), "ok");
  assert.strictEqual(health.worstStatus(["unknown", "warn"]), "warn");
  assert.strictEqual(health.worstStatus(["unknown", "fail"]), "fail");
  assert.ok(health.STATUS_RANK.ok < health.STATUS_RANK.unknown);
  assert.ok(health.STATUS_RANK.unknown < health.STATUS_RANK.warn);
});

test("a status nobody recognises is unknown, never ok", () => {
  // A check returning a typo, `undefined`, or nothing at all must degrade to
  // "we do not know", because the alternative is a green tick over a check that
  // never actually answered.
  assert.strictEqual(health.normStatus("green"), "unknown");
  assert.strictEqual(health.normStatus(undefined), "unknown");
  assert.strictEqual(health.worstStatus([{ status: "green" }]), "unknown");
  assert.deepStrictEqual(health.rollup([{ status: "green" }, {}]), {
    ok: 0,
    warn: 0,
    fail: 0,
    unknown: 2,
  });
});

test("the counts add up to the checks, with unknown in its own bucket", () => {
  const counts = health.rollup([
    { status: "ok" },
    { status: "ok" },
    { status: "warn" },
    { status: "fail" },
    { status: "unknown" },
  ]);
  assert.deepStrictEqual(counts, { ok: 2, warn: 1, fail: 1, unknown: 1 });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.strictEqual(total, 5, "a check that lands in no bucket is a check nobody sees");
  assert.deepStrictEqual(health.rollup([]), { ok: 0, warn: 0, fail: 0, unknown: 0 });
});

/* ========================================================================== *
 * One broken check must not take the run down
 * ========================================================================== */

test("a check that throws becomes unknown, carries its message, and the run goes on", async () => {
  // The engine is worth having only if it is still worth having on a bad day.
  // A dead Atlas connection, a rotated marketplace key or a Pi that dropped off
  // must cost that ONE answer, never the other nine — and it must degrade to
  // `unknown`: nothing measured a fault, we failed to measure at all.
  const run = await health.runAll({
    only: ["listings.overpriced", "listings.ghost", "pool.health"],
    now,
    deps: healthyDeps({
      MarketplaceListing: explodingModel("Atlas connection closed"),
    }),
  });

  const broken = run.checks.filter((c) => c.status === "unknown");
  assert.strictEqual(broken.length, 2, "both listing checks read MarketplaceListing");
  for (const c of broken) {
    assert.match(c.summary, /Atlas connection closed/, c.id + " swallowed the cause");
    assert.notStrictEqual(c.status, "fail", c.id + " turned a read failure into a verdict");
  }
  const pool = run.checks.find((c) => c.id === "pool.health");
  assert.strictEqual(pool.status, "ok");
  assert.strictEqual(pool.measured, 364, "the surviving checks must still answer");
  assert.deepStrictEqual(run.counts, { ok: 1, warn: 0, fail: 0, unknown: 2 });
});

test("a check that hangs is abandoned at its deadline, not waited on", async () => {
  // Gameflip and the Pi link both stall for minutes at a time. An hourly run
  // that blocks on one of them is a run that never reports, which is
  // indistinguishable from no health page at all. Losing the race is safe
  // precisely because nothing in the engine mutates anything.
  const stuck = {
    countDocuments: () => new Promise(() => {}),
    find: () => ({
      sort: () => stuck.find(),
      limit: () => stuck.find(),
      lean: () => new Promise(() => {}),
    }),
    findOne: () => stuck.find(),
  };
  const check = await runCheck(
    "listings.overpriced",
    healthyDeps({ MarketplaceListing: stuck }),
    { timeoutMs: 50 },
  );
  assert.strictEqual(check.status, "unknown");
  assert.match(check.summary, /timed out/);
  assert.strictEqual(check.measured, null, "a timed-out check must not report a number");
});

/* ========================================================================== *
 * rentfarm.capacity — the number that actually ran out
 * ========================================================================== */

const capacityCases = [
  // The exact 2026-09-08 shape: one stack, 10 of 10 used, nine hours, two paid
  // orders, and not one dial that said so.
  { stacks: [{ capacity: 10, used: 10 }], free: 0, want: "fail" },
  { stacks: [{ capacity: 50, used: 49 }], free: 1, want: "warn" },
  { stacks: [{ capacity: 50, used: 40 }], free: rentFarm.LOW_WATER, want: "warn" },
  { stacks: [{ capacity: 50, used: 39 }], free: rentFarm.LOW_WATER + 1, want: "ok" },
];

test("capacity fails at zero, warns at the low-water mark, and is ok above it", async () => {
  // You sell 180-day and 1-year windows, so a slot taken today is gone for a
  // year: the low-water mark exists to buy lead time to register another bot
  // config, not to announce the shortage after it has bitten.
  for (const c of capacityCases) {
    const check = await runCheck(
      "rentfarm.capacity",
      healthyDeps({ rentFarmCapacity: fakeCapacity({ stacks: c.stacks }) }),
    );
    assert.strictEqual(
      check.status,
      c.want,
      c.free + " free slot(s) read as " + check.status + ", expected " + c.want,
    );
    assert.strictEqual(check.measured, c.free, "the page must show the slot count itself");
    assert.match(
      String(check.threshold),
      new RegExp(String(rentFarm.LOW_WATER)),
      "the threshold it compared against has to travel with the number",
    );
  }
});

test("an offline host withholds a bad verdict instead of inventing one", async () => {
  // The Pi's home link is seconds of RTT and an OFF host costs ~63s per read.
  // "0 free slots" computed off a partial read is not a capacity emergency, it
  // is a read failure — and calling one the other already produced a wrong
  // diagnosis here once.
  const check = await runCheck(
    "rentfarm.capacity",
    healthyDeps({
      rentFarmCapacity: fakeCapacity({
        stacks: [{ host: "local", capacity: 10, used: 10 }],
        offlineHosts: ["Pi 2"],
      }),
    }),
  );
  assert.strictEqual(check.status, "unknown");
  assert.notStrictEqual(check.status, "fail");
  assert.match(check.detail, /Pi 2/, "say WHICH host was not counted");
  assert.strictEqual(check.measured, 0, "still report what was actually read");
});

test("an offline host does not spoil a HEALTHY verdict", async () => {
  // A host we could not read can only ever ADD slots, never remove them, so a
  // green verdict survives a partial read. Downgrading it too would leave the
  // check permanently amber and therefore permanently ignored.
  const check = await runCheck(
    "rentfarm.capacity",
    healthyDeps({
      rentFarmCapacity: fakeCapacity({
        stacks: [{ host: "local", capacity: 150, used: 13 }],
        offlineHosts: ["Pi 2"],
      }),
    }),
  );
  assert.strictEqual(check.status, "ok");
  assert.strictEqual(check.measured, 137);
});

test("no readable stack at all is unknown with no number claimed", async () => {
  const check = await runCheck(
    "rentfarm.capacity",
    healthyDeps({ rentFarmCapacity: fakeCapacity({ stacks: [], offlineHosts: ["Pi"] }) }),
  );
  assert.strictEqual(check.status, "unknown");
  assert.strictEqual(check.measured, null, "zero read is not zero free");
});

/* ========================================================================== *
 * rentfarm.coverage — can a paid Automatic Farming order be delivered at all
 * ========================================================================== */

const farmOffer = (over = {}) =>
  listing({
    title: "Rainbow Six Siege Twitch Drops Automatic Farming 180 days",
    price: 5.99,
    ...over,
  });

test("the PART A exposure: 8 live rent-farm offers with no way to deliver", async () => {
  // Measured 2026-09-09: 5 on Gameflip, 3 on GGSel, DropSets of 12-44 items and
  // 0 accounts holding the full set. Neither marketplace exposes an order API,
  // so neither can provision after the sale — each one would take a payment and
  // then fail "Out of stock", which is order e69b19d3's ending with a different
  // cause. This check is what proves they stay down.
  const rows = [
    ...Array.from({ length: 5 }, (_, i) =>
      farmOffer({ marketplace: "gameflip", externalId: "gf-farm-" + i }),
    ),
    ...Array.from({ length: 3 }, (_, i) =>
      farmOffer({ marketplace: "ggsel", externalId: "gg-farm-" + i }),
    ),
  ];
  const check = await runCheck(
    "rentfarm.coverage",
    healthyDeps({ MarketplaceListing: fakeModel(rows) }),
  );
  assert.strictEqual(check.status, "fail");
  assert.strictEqual(check.measured, 8);
  assert.match(String(check.threshold), /0 of 8/);
  assert.deepStrictEqual(
    [...new Set(check.items.map((i) => i.marketplace))].sort(),
    ["gameflip", "ggsel"],
  );
});

test("a marketplace with a farm service is never flagged for having no stock", async () => {
  // Eldorado, PlayerAuctions and G2G expose an ORDER API, so they provision an
  // account AT SALE TIME (utils/*FarmService.js). An empty shelf there is the
  // design, not a fault — flagging it would bury the gameflip/ggsel rows that
  // genuinely cannot deliver.
  for (const marketplace of [...health.FARM_SERVICE_MARKETS]) {
    const check = await runCheck(
      "rentfarm.coverage",
      healthyDeps({
        MarketplaceListing: fakeModel([farmOffer({ marketplace, externalId: "x-1" })]),
      }),
    );
    assert.strictEqual(check.status, "ok", marketplace + " was flagged");
    assert.strictEqual(check.measured, 0);
  }
  assert.deepStrictEqual(
    [...health.FARM_SERVICE_MARKETS].sort(),
    ["eldorado", "g2g", "playerauctions"],
    "the farm-service list is the whole basis of this check",
  );
});

test("stock attached before the sale is what makes a gameflip/ggsel offer safe", async () => {
  // The three shapes that really are deliverable, and they are not
  // interchangeable: a reserved unit, a Gameflip auto-delivery account, and the
  // quantity GGSel itself last reported.
  const safe = [
    farmOffer({ externalId: "gf-unit", units: [{ login: "a", deliveredAt: null }] }),
    farmOffer({ externalId: "gf-auto", autoDeliver: true, accountLogin: "b" }),
    farmOffer({ marketplace: "ggsel", externalId: "gg-stock", lastStock: 3 }),
  ];
  const check = await runCheck(
    "rentfarm.coverage",
    healthyDeps({ MarketplaceListing: fakeModel(safe) }),
  );
  assert.strictEqual(check.status, "ok");
  assert.strictEqual(check.measured, 0);
  assert.match(String(check.threshold), /0 of 3/);
});

test("a unit already handed over is history, not stock", async () => {
  // units[] is a delivery LOG on these rows. Counting a delivered unit as stock
  // would mark a shelf full when it is empty — the precise mistake that makes
  // an offer sellable and undeliverable at the same time.
  const check = await runCheck(
    "rentfarm.coverage",
    healthyDeps({
      MarketplaceListing: fakeModel([
        farmOffer({ externalId: "gf-spent", units: [{ login: "a", deliveredAt: NOW }] }),
      ]),
    }),
  );
  assert.strictEqual(check.status, "fail");
  assert.strictEqual(check.measured, 1);
  assert.strictEqual(health.hasDeliverableStock({ units: [{ deliveredAt: NOW }] }), false);
});

test("an offer the stock sync already paused is not counted as broken", async () => {
  // Pausing at zero stock IS the handling this check would otherwise demand.
  // Flagging it would report the fix as the fault, hourly, forever.
  const check = await runCheck(
    "rentfarm.coverage",
    healthyDeps({
      MarketplaceListing: fakeModel([farmOffer({ externalId: "gf-paused", autoPaused: true })]),
    }),
  );
  assert.strictEqual(check.status, "ok");
  assert.strictEqual(check.measured, 0);
  assert.match(check.detail, /1 paused offer\(s\) not judged/);
});

test("a bundle listing with no stock is not a rent-farm problem", async () => {
  // Selling out of a drop bundle is ordinary. This check is only ever about
  // WINDOWS sold on a marketplace that cannot provision one.
  const check = await runCheck(
    "rentfarm.coverage",
    healthyDeps({
      MarketplaceListing: fakeModel([
        listing({ externalId: "gf-bundle", title: "Overwatch Twitch Drops (6 Items)" }),
      ]),
    }),
  );
  assert.strictEqual(check.status, "ok");
  assert.strictEqual(check.measured, 0);
});

test("every spelling of a farm title a human has actually typed is caught", () => {
  // A rent-farm offer this misses is a rent-farm offer nobody checks. Real
  // titles from the live shelves and from rivals:
  for (const t of [
    "Rainbow Six Siege Twitch Drops Automatic Farming 180 days",
    "R6 Twitch Drops Automatic farming 120 days",
    "MARVEL RIVALS | AUTOFARM 30-90-180 DAYS | TWITCH DROPS",
    "Call of Duty Twitch Drops auto-farm 90 days",
    "Overwatch AutoFarming service",
  ]) {
    assert.strictEqual(health.isRentFarmTitle(t), true, t);
  }
  for (const t of [
    "Overwatch Twitch Drops (6 Items)",
    "[Twitch Drops] Marvel Rivals | 44 Items | Instant Delivery",
    "",
  ]) {
    assert.strictEqual(health.isRentFarmTitle(t), false, t);
  }
});

/* ========================================================================== *
 * listings.overpriced — and the rows it must leave alone
 * ========================================================================== */

test("PlayerAuctions rows at exactly the platform floor are not overpricing", async () => {
  // PA refuses anything under $5, which is why every PA row sits at exactly
  // $5.00. There are 126 of them. A check that painted all 126 red every hour
  // would be muted within a day — and a muted check is worth less than no check,
  // because it still looks like coverage.
  const rows = [
    ...Array.from({ length: 126 }, (_, i) =>
      listing({ marketplace: "playerauctions", externalId: "pa-" + i, price: 5 }),
    ),
    listing({ marketplace: "ggsel", externalId: "gg-hot", price: 9.99 }),
  ];
  const check = await runCheck(
    "listings.overpriced",
    healthyDeps({ MarketplaceListing: fakeModel(rows) }),
  );
  assert.strictEqual(check.measured, 1, "126 floor-priced PA rows must not be offenders");
  assert.strictEqual(check.status, "fail");
  assert.deepStrictEqual(check.items.map((i) => i.externalId), ["gg-hot"]);
  assert.match(String(check.threshold), /4\.50/, "say what the ceiling actually is");
});

test("the exemption is the FLOOR, not the marketplace", async () => {
  // $5.01 on PlayerAuctions is a price somebody chose, and it is above every
  // price that has ever converted. Exempting the whole marketplace instead of
  // the floor would hide it.
  const check = await runCheck(
    "listings.overpriced",
    healthyDeps({
      MarketplaceListing: fakeModel([
        listing({ marketplace: "playerauctions", externalId: "pa-floor", price: 5 }),
        listing({ marketplace: "playerauctions", externalId: "pa-over", price: 5.01 }),
      ]),
    }),
  );
  assert.strictEqual(check.measured, 1);
  assert.deepStrictEqual(check.items.map((i) => i.externalId), ["pa-over"]);
  assert.strictEqual(health.PA_PLATFORM_FLOOR_USD, 5);
});

test("a rent-farm offer is a different product and is not judged by the bundle ceiling", async () => {
  // A farming window is not a farmed account: rivals ask $4.99-$6.00 for one and
  // under a dollar for the other. Pooling them would flag every rent-farm offer
  // we have as overpriced forever.
  const check = await runCheck(
    "listings.overpriced",
    healthyDeps({
      MarketplaceListing: fakeModel([
        farmOffer({ marketplace: "eldorado", externalId: "eld-farm", price: 5.99 }),
        farmOffer({ marketplace: "g2g", externalId: "g2g-farm", price: 6 }),
      ]),
    }),
  );
  assert.strictEqual(check.status, "ok");
  assert.strictEqual(check.measured, 0);
});

test("a row at the ceiling is not above it, and a paused row is not on sale", async () => {
  const check = await runCheck(
    "listings.overpriced",
    healthyDeps({
      MarketplaceListing: fakeModel([
        listing({ externalId: "gf-at-ceiling", price: health.REALISED_CEILING_USD }),
        listing({ externalId: "gf-paused", price: 20, autoPaused: true }),
        listing({ externalId: "gf-delisted", price: 20, status: "delisted" }),
      ]),
    }),
  );
  assert.strictEqual(check.status, "ok");
  assert.strictEqual(check.measured, 0);
});

test("the 20-row items cap trims the display, never the measurement", async () => {
  // The contract caps `items` at 20 so a run record cannot grow unbounded on a
  // bytes-bound Atlas tier. A count that got capped with it would understate the
  // problem, which is the one thing this page must never do.
  const rows = Array.from({ length: 30 }, (_, i) =>
    listing({ externalId: "gf-" + i, price: 10 + i }),
  );
  const check = await runCheck(
    "listings.overpriced",
    healthyDeps({ MarketplaceListing: fakeModel(rows) }),
  );
  assert.strictEqual(check.measured, 30);
  assert.strictEqual(check.items.length, health.ITEM_CAP);
  assert.strictEqual(health.ITEM_CAP, 20);
  // Worst first: with only 20 slots, the rows shown have to be the ones worth
  // acting on.
  assert.strictEqual(check.items[0].price, 39);
});

/* ========================================================================== *
 * listings.ghost — absence from a capped list is not evidence
 * ========================================================================== */

// A Gameflip id query that returns exactly 200 ids. A round number is the
// signature of a cap, not of a fleet — and 26 rows genuinely sold-but-active
// were once found here, worth $51.80 nothing had recorded. Both facts pull in
// opposite directions, which is why the check confirms before it concludes.
function gameflipApi({ onsale = [], status = {}, fallback = "onsale", throws = false } = {}) {
  const asked = [];
  let live = 0;
  let peak = 0;
  return {
    asked,
    peak: () => peak,
    async gameflipListingIdsByStatus() {
      return new Set(onsale);
    },
    async gameflipListingStatus(id) {
      asked.push(id);
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setImmediate(r));
      live -= 1;
      if (throws) throw new Error("429 Too Many Requests");
      return Object.prototype.hasOwnProperty.call(status, id) ? status[id] : fallback;
    },
  };
}

const CAPPED_200 = Array.from({ length: 200 }, (_, i) => "other-" + i);

test("a row missing from the capped id list is a suspect, never a verdict", async () => {
  // gameflipListingIdsByStatus("onsale") returned EXACTLY 200 ids on 2026-09-09.
  // If absence from that list counted as a sale, every listing past the cap
  // would be reported sold — a page full of red that is entirely wrong is worse
  // than no page, because it costs the owner an afternoon to disprove.
  const mp = gameflipApi({ onsale: CAPPED_200, fallback: "onsale" });
  const check = await runCheck(
    "listings.ghost",
    healthyDeps({
      MarketplaceListing: fakeModel([
        listing({ externalId: "gf-a" }),
        listing({ externalId: "gf-b" }),
      ]),
      marketplaces: mp,
    }),
  );
  assert.strictEqual(check.status, "ok");
  assert.strictEqual(check.measured, 0);
  assert.deepStrictEqual(mp.asked.sort(), ["gf-a", "gf-b"], "each suspect must be confirmed live");
  // gameflipListingIdsByStatus pages in 100s and BREAKS on the first short page,
  // so exactly 200 ids means the third page came back empty — a COMPLETE read,
  // not a truncated one. The page must not assert it was capped; it must say the
  // count is inconclusive, which is the honest claim.
  assert.match(
    check.detail,
    /whole number of pages|may or may not be complete/,
    "the id-list count is inconclusive at a page boundary, not proof of capping",
  );
  assert.match(check.detail, /never treated as proof/);
});

test("a ghost is only reported once a per-listing read confirms it", async () => {
  const mp = gameflipApi({
    onsale: CAPPED_200,
    status: { "gf-sold": "sold", "gf-live": "onsale" },
  });
  const check = await runCheck(
    "listings.ghost",
    healthyDeps({
      MarketplaceListing: fakeModel([
        listing({ externalId: "gf-sold", price: 1.99, accountLogin: "acct-1" }),
        listing({ externalId: "gf-live" }),
      ]),
      marketplaces: mp,
    }),
  );
  assert.strictEqual(check.status, "fail");
  assert.strictEqual(check.measured, 1);
  assert.strictEqual(check.items.length, 1);
  assert.strictEqual(check.items[0].externalId, "gf-sold");
  assert.strictEqual(check.items[0].marketplaceStatus, "sold");
  // The account it pins matters as much as the money: a ghost row holds its
  // account reserved forever and stops the relist chain behind it.
  assert.strictEqual(check.items[0].accountLogin, "acct-1");
});

test("a rate-limited confirm is unknown, not a ghost and not a clean bill", async () => {
  // A 429 reads exactly like "not sold yet" — that confusion is what let sales
  // go unnoticed in the first place. It must resolve to neither verdict.
  const mp = gameflipApi({ onsale: CAPPED_200, throws: true });
  const check = await runCheck(
    "listings.ghost",
    healthyDeps({
      MarketplaceListing: fakeModel([listing({ externalId: "gf-a" })]),
      marketplaces: mp,
    }),
  );
  assert.strictEqual(check.status, "unknown");
  assert.strictEqual(check.measured, 0);
  assert.match(check.detail, /1 unreadable/);
});

test("confirms are sequential, because the fan-out is the hazard", async () => {
  // Gameflip rate-limits, and a burst of parallel GETs earns 429s that look like
  // "not sold yet". An hourly health read must not generate the exact load it
  // exists to detect.
  const mp = gameflipApi({ onsale: CAPPED_200 });
  await runCheck(
    "listings.ghost",
    healthyDeps({
      MarketplaceListing: fakeModel(
        Array.from({ length: 6 }, (_, i) => listing({ externalId: "gf-" + i })),
      ),
      marketplaces: mp,
    }),
  );
  assert.strictEqual(mp.peak(), 1, "peak concurrency was " + mp.peak() + " live Gameflip calls");
});

test("suspects beyond the per-run budget are unknown, and the window moves", async () => {
  // Confirming costs one live call each, so a run confirms a WINDOW. Without
  // rotation the same first 20 would be re-confirmed hourly forever and the tail
  // would never be looked at once — a blind spot that never announces itself.
  const rows = Array.from({ length: 25 }, (_, i) =>
    listing({ externalId: "gf-" + String(i).padStart(2, "0") }),
  );
  const deps = () =>
    healthyDeps({
      MarketplaceListing: fakeModel(rows),
      marketplaces: gameflipApi({ onsale: CAPPED_200 }),
    });

  const first = gameflipApi({ onsale: CAPPED_200 });
  const a = await runCheck(
    "listings.ghost",
    healthyDeps({ MarketplaceListing: fakeModel(rows), marketplaces: first }),
    { now: () => NOW },
  );
  assert.strictEqual(a.status, "unknown", "5 unconfirmed suspects is not a clean bill");
  assert.strictEqual(a.measured, 0);
  assert.strictEqual(first.asked.length, health.GHOST_CONFIRM_CAP);
  assert.match(a.detail, /5 left for the next run/);

  const second = gameflipApi({ onsale: CAPPED_200 });
  await health.runAll({
    only: ["listings.ghost"],
    deps: { ...deps(), marketplaces: second },
    now: () => new Date(NOW.getTime() + 60 * 60 * 1000),
  });
  assert.notDeepStrictEqual(
    first.asked.slice().sort(),
    second.asked.slice().sort(),
    "the next hour re-checked the same 20 rows and would never reach the tail",
  );
});

test("with nothing to check the answer is a measured zero, not a shrug", async () => {
  const check = await runCheck(
    "listings.ghost",
    healthyDeps({ MarketplaceListing: fakeModel([]) }),
  );
  assert.strictEqual(check.status, "ok");
  assert.strictEqual(check.measured, 0);
  assert.ok(String(check.threshold).length, "even an empty run states its threshold");
});

/* ========================================================================== *
 * orders.undelivered — the check closest to the money
 * ========================================================================== */

test("a paid order past its grace is a failure; a failed one gets no grace at all", async () => {
  // The farm services retry every ~75s and re-alert every 10th attempt, so an
  // order still unshipped at 20 minutes has already exhausted them. An order
  // marked `failed` has given up entirely and waiting on it is pure delay —
  // Eldorado order 4b20765f failed four times inside that window and the owner
  // found out by looking.
  const orders = [
    { orderId: "just-landed", state: "pending", createdAt: ago(2 * MIN), deliveredAt: null },
    { orderId: "gave-up", state: "failed", createdAt: ago(1 * MIN), deliveredAt: null },
    { orderId: "waiting", state: "pending", createdAt: ago(90 * MIN), deliveredAt: null },
    { orderId: "shipped", state: "delivered", createdAt: ago(3 * HOUR), deliveredAt: ago(2 * HOUR) },
  ];
  const check = await runCheck(
    "orders.undelivered",
    healthyDeps({ FarmServiceOrder: fakeModel(orders) }),
  );
  assert.strictEqual(check.status, "fail");
  assert.strictEqual(check.measured, 2);
  assert.deepStrictEqual(
    check.items.map((i) => i.orderId),
    ["waiting", "gave-up"],
    "oldest first — the buyer who has waited longest is the one to act on",
  );
  assert.match(String(check.threshold), /20m/);
});

test("a cancelled order is closed, not owed", async () => {
  // The buyer walked away (Eldorado e69b19d3 after 25 failed attempts on a full
  // rental stack). Nobody is waiting, so alerting forever over it would train
  // the owner to ignore the one check that sits closest to the money.
  const orders = [
    { orderId: "walked-away", state: "cancelled", createdAt: ago(3 * HOUR), deliveredAt: null },
    { orderId: "still-owed", state: "failed", createdAt: ago(3 * HOUR), deliveredAt: null },
  ];
  const check = await runCheck(
    "orders.undelivered",
    healthyDeps({ FarmServiceOrder: fakeModel(orders) }),
  );
  assert.strictEqual(check.measured, 1, "only the failed order is still owed");
  assert.deepStrictEqual(check.items.map((i) => i.orderId), ["still-owed"]);
});

/* ========================================================================== *
 * The frozen result shape, on every check
 * ========================================================================== */

test("REGRESSION: listings.stale asks LIVE inventory, not the DB union", async () => {
  // The check exists to catch listings selling drops that have EXPIRED off the
  // account. Both DB sources — ledger `drops[]` and DropLog — are historical and
  // still remember an expired wave, so a verdict built on them cannot see the
  // one failure this check is for. On the CAH bundle both said "fine" while a
  // live read showed Week 1 gone from all 15 accounts, and a buyer hit it.
  // Delivery uses liveCoverage (eldoradoFulfiller.js, playerauctionsFulfiller.js);
  // anything else here would be checking a different question from the one the
  // buyer actually hits.
  const calls = [];
  const deps = healthyDeps();
  deps.unclaimedCoverage = {
    ...deps.unclaimedCoverage,
    accountCoverage: async () => { calls.push("accountCoverage"); return { ok: true }; },
    liveCoverage: async () => { calls.push("liveCoverage"); return { ok: true, source: "live" }; },
  };
  await runCheck("listings.stale", deps);
  assert.ok(calls.includes("liveCoverage"), "must consult live Twitch inventory");
  assert.ok(
    !calls.includes("accountCoverage"),
    "the DB union cannot see an expired wave — it must not be the verdict",
  );
});

test("REGRESSION: a degraded coverage verdict never counts as covered", async () => {
  // liveCoverage falls back to the DB union and flags `degraded` when the live
  // read fails. Treating that as a pass turned a DropLog outage into a clean
  // bill of health for the entire shop.
  const deps = healthyDeps();
  deps.unclaimedCoverage = {
    ...deps.unclaimedCoverage,
    liveCoverage: async () => ({ ok: true, degraded: true, source: "db" }),
  };
  const check = await runCheck("listings.stale", deps);
  assert.strictEqual(check.status, "unknown", "a fallback verdict is not evidence of coverage");
  assert.match(String(check.summary), /could not be resolved|not reached/i);
});

test("every check returns the number it measured and the threshold it used", async () => {
  // The non-negotiable. A bare green tick is what the dashboards already gave on
  // 2026-09-08 while the stack sat at 10/10, so a check that cannot show its
  // working is not a check.
  const run = await health.runAll({ deps: healthyDeps(), now });
  assert.strictEqual(run.checks.length, health.CHECKS.length);

  for (const c of run.checks) {
    assert.ok(c.id && c.title && c.group, "a check missing its identity: " + JSON.stringify(c));
    assert.ok(health.STATUSES.includes(c.status), c.id + " status " + c.status);
    assert.ok(
      ["critical", "warn", "info"].includes(c.severity),
      c.id + " severity " + c.severity,
    );
    assert.ok(c.summary.length, c.id + " has no one-line summary");
    assert.ok(
      typeof c.threshold === "string" && c.threshold.length,
      c.id + " reported no threshold",
    );
    // `measured` may only be null when the check is admitting it could not
    // measure. Anything else claiming a verdict without a number is the bare
    // green tick coming back in disguise.
    if (c.status !== "unknown") {
      assert.notStrictEqual(c.measured, null, c.id + " gave a verdict with no number");
    }
    assert.ok(Array.isArray(c.items) && c.items.length <= health.ITEM_CAP, c.id + " items");
    assert.ok(Number.isFinite(c.ms) && c.ms >= 0, c.id + " ms");
    assert.ok(c.checkedAt instanceof Date, c.id + " checkedAt");
  }

  assert.deepStrictEqual(run.counts, health.rollup(run.checks));
  const total = Object.values(run.counts).reduce((a, b) => a + b, 0);
  assert.strictEqual(total, run.checks.length);
  assert.strictEqual(run.startedAt.getTime(), NOW.getTime(), "the clock must be injectable");
  assert.ok(Number.isFinite(run.ms));
});

test("every check id the contract froze is present exactly once", () => {
  // The page, the stored run records and this file all key off these ids, so a
  // rename is a silent break in three places at once.
  const ids = health.CHECKS.map((c) => c.id);
  assert.strictEqual(new Set(ids).size, ids.length, "duplicate check id: " + ids.join(", "));
  for (const id of [
    "orders.undelivered",
    "rentfarm.capacity",
    "rentfarm.coverage",
    "listings.stale",
    "listings.overpriced",
    "listings.ghost",
    "autolist.running",
    "pool.health",
    "pool.tokens",
    "loops.alive",
  ]) {
    assert.ok(ids.includes(id), "the contract froze " + id + " and it is gone");
  }
});

/* ========================================================================== *
 * Read-only by construction
 * ========================================================================== */

test("the health engine cannot write anything, anywhere", async () => {
  // The owner's first rule, and the reason this file never touches prod: a
  // mass-parallel session is suspected of disturbing a live order once already.
  // A checker that can publish, delist, reprice or provision is a checker nobody
  // dares run at the moment they most need it.
  const src = fs.readFileSync(
    path.join(__dirname, "..", "utils", "systemHealth.js"),
    "utf8",
  );
  const forbidden = [
    /\.\s*save\s*\(/,
    /\b(updateOne|updateMany|deleteOne|deleteMany|insertMany|findOneAndUpdate|findOneAndDelete|bulkWrite)\s*\(/,
    /\b\w*(Publish|Delist|Reprice|Relist)\s*\(/,
    /\bfarmFreshAccounts\s*\(/,
    /\bsetAutoFarm\s*\(/,
    /\bsendTelegram\s*\(/,
  ];
  for (const re of forbidden) {
    const hit = src.match(re);
    assert.strictEqual(hit, null, "systemHealth.js contains a mutating call: " + (hit && hit[0]));
  }

  // And the seam enforces it at runtime: a check can only reach what it was
  // handed, so a dependency nobody declared is an error rather than a live
  // module quietly required behind the page's back.
  const ctx = health.makeCtx({ deps: {}, now });
  assert.throws(() => ctx.dep("MarketplaceListing2"), /unknown dependency/);
  assert.strictEqual(ctx.now().getTime(), NOW.getTime());
});


/* ------------------------------------------------------------------ *
 * listings.untracked — the direction every other check was blind to
 * ------------------------------------------------------------------ */

test("REGRESSION: an offer we recorded as delisted that GGSel still sells FAILS", async () => {
  // The 2026-09-09 finding. 16 rows read `delisted` while GGSel had them live
  // with 145 sellable units, and 24 of the accounts behind the two largest had
  // already been sold to someone else. Nothing could see it: every other check
  // starts from OUR rows and asks the marketplace about each one, which can only
  // find "we say live, they say dead".
  const check = health.CHECKS.find((c) => c.id === "listings.untracked");
  const out = await check.run(
    health.__ctxForTest
      ? health.__ctxForTest({ deps: {} })
      : {
          dep: (n) =>
            n === "marketplaces"
              ? {
                  async ggselAllOffers() {
                    return [
                      { id: "z1", status: "active", title_en: "Zombie" },
                      { id: "ok1", status: "active", title_en: "Fine" },
                    ];
                  },
                }
              : {
                  find: () => ({
                    lean: async () => [
                      { externalId: "z1", status: "delisted", title: "Zombie" },
                      { externalId: "ok1", status: "active", title: "Fine" },
                    ],
                  }),
                },
        },
  );
  assert.strictEqual(out.status, "fail", "a failed delist is money at risk, not a warning");
  assert.strictEqual(out.measured, 1);
  assert.match(out.summary, /still selling after we recorded them delisted/);
});

test("an offer with no row at all warns, but does not cry failure", async () => {
  // The owner's hand-made rent listings live here. They are not a fault — they
  // are simply invisible until something says they exist.
  const check = health.CHECKS.find((c) => c.id === "listings.untracked");
  const out = await check.run({
    dep: (n) =>
      n === "marketplaces"
        ? { async ggselAllOffers() { return [{ id: "hand1", status: "active", title_en: "Automatic farming 180 days" }]; } }
        : { find: () => ({ lean: async () => [] }) },
  });
  assert.strictEqual(out.status, "warn");
  assert.match(out.summary, /no row at all/);
});

test("a paused GGSel offer is not untracked — only `status: active` counts", async () => {
  // `is_active` is NOT a field on this payload. Code that tested for it read
  // undefined and classified every offer as not-active; the mirror mistake would
  // flag all 318 paused offers as live. GGSel's own word is `status`.
  const check = health.CHECKS.find((c) => c.id === "listings.untracked");
  const out = await check.run({
    dep: (n) =>
      n === "marketplaces"
        ? { async ggselAllOffers() { return [{ id: "p1", status: "paused" }, { id: "d1", status: "draft" }]; } }
        : { find: () => ({ lean: async () => [] }) },
  });
  assert.strictEqual(out.status, "ok");
  assert.strictEqual(out.measured, 0);
});

test("an unreadable offer list is unknown, never ok", async () => {
  const check = health.CHECKS.find((c) => c.id === "listings.untracked");
  const out = await check.run({
    dep: (n) =>
      n === "marketplaces"
        ? { async ggselAllOffers() { throw new Error("HTTP 502"); } }
        : { find: () => ({ lean: async () => [] }) },
  });
  assert.strictEqual(out.status, "unknown");
  assert.ok(out.threshold && out.threshold.length, "even an unknown states its threshold");
  assert.match(out.detail, /failure to measure/);
});
